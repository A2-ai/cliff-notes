# cliff-notes — controlled LLM changelog generator

> Working name: **cliff-notes** (git-**cliff** + Cliff**sNotes**). Rename trivially before publish.

## Context

A2-ai today writes changelogs manually or — in one repo (`llmdiff`) — feeds raw `git diff` to an LLM and prompts for release notes. That second approach is "too loose": no structured input, no schema-constrained output, no determinism on grouping or what gets included. The result is unpredictable and not safe to automate.

`cliff-notes` is a small, cross-project internal CLI that produces release notes with **deterministic structure and constrained LLM creativity**:

- **Structure** (sections, ordering, PR links, version headers) comes from `git-cliff` + `gh` — fully deterministic.
- **Prose** (rewritten entries + release summary) comes from an LLM call whose output is schema-validated against zod. The LLM cannot invent PR numbers, drop entries, reorder, or change links.
- One tool, multiple projects, multiple LLM providers (Anthropic / OpenAI / Bedrock) via a single SDK.

End state: `CHANGELOG.md` becomes a structured, machine-parseable file that downstream tooling (goreleaser, GH releases) reads from — no LLM in the CI hot path.

## Recommended approach

### Stack

| Concern        | Choice                                                          | Why                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **bun**                                                         | Org default; user prefers it; `bunx` for zero-install cross-project use; `bun build --compile` available if a binary is ever needed                                   |
| LLM SDK        | **[Vercel AI SDK](https://sdk.vercel.ai/) (`ai`)**              | Multi-provider abstraction in one API; `generateObject({ schema })` returns zod-validated structured output; Anthropic prompt caching supported via `providerOptions` |
| Providers      | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock` | Selected per-project via TOML config                                                                                                                                  |
| Data layer     | **`git-cliff`** (external binary)                               | Deterministic conventional-commit parsing, tag detection, range math, PR-link generation, JSON `--context` output                                                     |
| PR enrichment  | **`gh` CLI**                                                    | `gh pr view <n> --json title,body,labels,url,author` to give LLM real PR context, not just commit subjects                                                            |
| Config         | **TOML** via `smol-toml` + zod schema                           | User pick; multiline prompt strings work cleanly; predictable vs YAML                                                                                                 |
| CLI args       | **`commander`**                                                 | Standard, well-typed                                                                                                                                                  |
| Markdown merge | Hand-rolled splice on `## [vX.Y.Z]` headings                    | Section boundaries are deterministic; avoids parser dependency                                                                                                        |

### Architecture

```
                ┌───────────────────────────────────────┐
                │ cliff-notes [--tag X|--unreleased]    │
                │            [--dry-run|--out file]     │
                │            [--extract tag --out file] │
                └───────────────┬───────────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        │                                               │
        ▼                                               ▼
 ┌──────────────┐                              ┌──────────────────┐
 │  git-cliff   │  --context (JSON)            │  cliff-notes.toml│
 │  binary      │ ─────────────────►           │  (project cfg)   │
 └──────────────┘     entries grouped          └──────────────────┘
                      by type, with PR #                   │
                                ▼                          │
                       ┌──────────────┐                    │
                       │  gh CLI      │                    │
                       │ pr view <n>  │                    │
                       └──────┬───────┘                    │
                              │  enriched entries          │
                              ▼                            │
                       ┌──────────────────┐                │
                       │  Vercel AI SDK   │◄───────────────┘
                       │  generateObject  │  cached system prompt
                       │  (zod schema)    │  + project voice
                       └──────┬───────────┘
                              │  validated structured output
                              ▼
                       ┌──────────────┐
                       │  Markdown    │
                       │  renderer    │
                       └──────┬───────┘
                              │
                ┌─────────────┼──────────────┐
                ▼             ▼              ▼
          CHANGELOG.md    stdout         <out>.md
          (default)      (--dry-run)     (--out / --extract)
```

### LLM calls — two per generation, both schema-constrained

1. **Batched entry rewrite** — one call with all entries in a single payload. Input: array of `{ raw_subject, pr_title, pr_body, type, scope, pr_number }`. Output schema enforces:
   - Same array length as input
   - Each output element keeps its `pr_number` verbatim
   - `rewritten: string` is the only LLM-generated field
   - Optional `highlight: boolean` for "include in summary"
2. **Release summary** — one call, 2–4 sentences. Input: the rewritten entries + project voice/audience from config. Output: a single `summary: string`.

PR links, dates, version headers, section ordering: **never** LLM-generated. Hand-rendered from git-cliff data.

### Prompt caching

Cache control on the system prompt + project voice/audience block (long, stable). Per-invocation user content (entries) is uncached. With repeat invocations during iteration (e.g. dry-run loop), only the entries portion costs full tokens.

### Operating modes

| Flag                           | Behavior                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| (default)                      | Generate for range since last tag → **prepend** new `## [<next-tag>]` section to `CHANGELOG.md`        |
| `--tag vX.Y.Z`                 | Force the version header                                                                               |
| `--unreleased`                 | Use `## [Unreleased]` header; replaces any existing `[Unreleased]` block                               |
| `--dry-run`                    | Print rendered markdown to stdout, **never touch disk**                                                |
| `--out <file>`                 | Write rendered markdown to file instead of splicing into CHANGELOG.md                                  |
| `--extract <tag> --out <file>` | Don't call LLM at all — extract an existing section from `CHANGELOG.md` (for CI/goreleaser to consume) |
| `--provider <name>`            | Override config provider                                                                               |
| `--model <name>`               | Override config model                                                                                  |
| `--verbose`                    | Show token counts, raw git-cliff JSON, intermediate LLM payloads                                       |

`--dry-run` is the **default expectation** during iteration. Tool always prints a preview to stderr before touching disk in write mode; `--yes` skips the confirm prompt.

### Audit trail

Each generated section ends with an HTML comment containing the raw git-cliff entries:

```markdown
## [v1.2.3] - 2026-05-13

<summary prose>

### Features

- Add foo bar baz ([#123](...))

<!-- cliff-notes:raw v1
- feat(api): add foo_bar_baz endpoint (PR #123, abc1234)
- ...
-->
```

The audit block makes drift between raw commits and LLM rewrites diffable in code review. The comment marker `cliff-notes:raw v1` lets future versions re-render from raw input without re-querying git.

### Goreleaser / CI integration

Two clean integration paths:

1. **Per-section extraction**: CI runs `cliff-notes --extract v1.2.3 --out release-notes.md`, then `goreleaser release --release-notes release-notes.md`. No LLM call in CI.
2. **Disable goreleaser's changelog**: `changelog.disable: true` in `.goreleaser.yaml` + use the extracted file as above. Documented in the project README.

Goreleaser config snippet provided as a copy-paste in the README.

### Config file: `cliff-notes.toml`

Lives at project root. Loaded relative to `cwd` (override with `--config <path>`). Example shape:

```toml
[provider]
name = "anthropic"           # anthropic | openai | bedrock
model = "claude-sonnet-4-6"
# bedrock-only:
# aws_profile = "ai"
# api_key_env = "ANTHROPIC_API_KEY"  # default per-provider

[project]
name = "spackle-ui"
audience = "internal-devs"   # arbitrary free-text fed into prompt
voice = "concise, technical, no marketing fluff"

[prompt]
# Optional overrides. Defaults baked into the tool.
# system_extra = """..."""
# summary_style = """..."""

[git_cliff]
# Path to per-project cliff.toml; default is bundled baseline
config = "cliff.toml"

[output]
changelog_file = "CHANGELOG.md"
date_format = "%Y-%m-%d"
```

Tool ships a default `cliff.toml` baseline so first-time projects can run with just `cliff-notes.toml`.

### Distribution

- Match the **spackle precedent**: publish GitHub release tarballs.
- `package.json` `bin: { "cliff-notes": "./dist/cli.js" }`.
- Build: `bun build src/cli.ts --target node --outfile dist/cli.js`.
- Consumers install via `bun add github:a2-ai/cliff-notes` or run ad-hoc via `bunx github:a2-ai/cliff-notes`.
- Compile to binary later via `bun build --compile` if non-bun users need to run it.

## Repo layout

```
~/Projects/a2-ai/cliff-notes/
├── package.json             # bun, ai, @ai-sdk/*, smol-toml, zod, commander
├── tsconfig.json
├── README.md                # usage + goreleaser integration recipe
├── cliff.toml               # default git-cliff baseline (override per project)
├── cliff-notes.example.toml # template for consumer projects
├── src/
│   ├── cli.ts               # commander entry, arg parsing, flag wiring
│   ├── config.ts            # TOML load + zod schema for cliff-notes.toml
│   ├── pipeline.ts          # orchestration: cliff → gh → llm → render → merge
│   ├── git-cliff.ts         # spawn git-cliff, parse --context JSON, type-check
│   ├── github.ts            # gh CLI wrapper for PR enrichment
│   ├── llm.ts               # ai-sdk provider selection + cached system prompt
│   ├── schemas.ts           # zod schemas for LLM I/O (entries, summary)
│   ├── render.ts            # JSON → markdown section (with audit comment)
│   ├── merge.ts             # splice section into existing CHANGELOG.md
│   ├── extract.ts           # pull a single section out by tag
│   └── prompts/
│       ├── system.ts        # base system prompt (cacheable)
│       ├── rewrite.ts       # entry-rewrite user prompt template
│       └── summary.ts       # release-summary user prompt template
└── tests/                   # bun test; mock ai-sdk + git-cliff outputs
    ├── pipeline.test.ts
    ├── render.test.ts
    ├── merge.test.ts
    └── fixtures/
```

## Critical files (to create)

- `src/cli.ts` — commander wiring; ensure `--dry-run` short-circuits any disk write
- `src/llm.ts` — Vercel AI SDK setup; `generateObject({ schema, providerOptions: { anthropic: { cacheControl: {...} } } })`
- `src/schemas.ts` — zod schemas; **entry-rewrite schema enforces array length parity and `pr_number` preservation** via a custom refine
- `src/git-cliff.ts` — spawn `git-cliff --context` and parse; on missing binary, exit with install instructions
- `src/github.ts` — `gh` CLI presence check; per-PR fetch with a small concurrency limit (e.g. 5)
- `src/merge.ts` — header-aware splice; replaces `[Unreleased]` cleanly; preserves footer references
- `cliff.toml` (default baseline) — conventional-commit grouping (feat/fix/perf/docs/refactor/test/chore), PR-link template targeting `gh` remote

## Verification

End-to-end checks:

1. **Smoke test against spackle-ui itself**:
   - `cd ~/Projects/a2-ai/spackle-ui && bunx ~/Projects/a2-ai/cliff-notes --unreleased --dry-run`
   - Expect: rendered markdown to stdout, summary + entries for commits since last tag, no disk write.

2. **Schema-violation handling**:
   - Mock the LLM to return an array of wrong length / missing `pr_number`. Pipeline must fail with a clear error, **never** write a partial CHANGELOG.

3. **Provider switching**:
   - Run once with `provider.name = "anthropic"`, once with `"openai"`. Output structure identical; only prose differs.

4. **Round-trip extract**:
   - Generate a section → extract it with `--extract <tag>` → diff against the original section. Should be byte-identical.

5. **Goreleaser handoff**:
   - In a throwaway project, configure `.goreleaser.yaml` with `changelog.disable: true` + `release-notes` pointing at extracted file. Confirm goreleaser picks up the body verbatim.

6. **Unit tests** (`bun test`):
   - `render.test.ts` — golden-file rendering with the audit comment block
   - `merge.test.ts` — splice into empty file, file with existing releases, file with `[Unreleased]` to replace
   - `pipeline.test.ts` — mock git-cliff + gh + LLM; assert end-to-end schema validation

## Out of scope (explicit non-goals)

- No GitHub Release creation — goreleaser owns that.
- No tag creation — dev does that manually after reviewing the changelog diff.
- No semver bumping or version inference — `--tag` is required for tagged releases.
- No profile system (per llmdiff).
- No streaming output (small payloads; not worth the complexity).
- No web UI / Studio integration.
- No automatic PR comment posting (could be a thin wrapper later).
