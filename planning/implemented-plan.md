# cliff-notes — controlled LLM changelog generator

> Working name: **cliff-notes** (git-**cliff** + Cliff**sNotes**). Rename trivially before publish.

## Context

a2-ai today writes changelogs manually or — in `llmdiff` — feeds raw `git diff` to an LLM and prompts for release notes. That second approach is "too loose": no structured input, no schema-constrained output, no determinism on grouping or what gets included. Result: unpredictable, not safe to automate.

`cliff-notes` is a cross-project internal CLI that produces release notes with **deterministic structure and constrained LLM creativity**:

- **Structure** (sections, ordering, PR links, version headers) comes from `git-cliff` + `gh` — fully deterministic.
- **Prose** (rewritten entries + release summary) comes from an LLM call whose output is schema-validated via zod. The LLM cannot invent PR numbers, drop entries, reorder, or change links.
- One tool, multiple projects, multiple LLM providers (Anthropic / OpenAI / Bedrock) via a single SDK.

End state: `CHANGELOG.md` becomes a structured, machine-parseable file. Consumer projects can opt-in to feeding it into goreleaser via their own config — cliff-notes itself is not in the CI hot path.

### Exploration findings that shaped this plan

- **llmdiff is Rust + AWS Bedrock + unstructured text generation.** No code reuse; cliff-notes is a clean rebuild in TS/bun with structured outputs. Keep Bedrock parity (with `aws_profile`) for org consistency.
- **spackle / spackle-ui don't maintain `CHANGELOG.md`** — both let goreleaser auto-generate from commits. cliff-notes introduces a new pattern (human-readable changelog file). It does **not** require any consumer to change their goreleaser config.
- **Distribution decision (confirmed by user)**: ship via raw `bun add github:a2-ai/cliff-notes` / `bunx github:a2-ai/cliff-notes` direct from the repo. **No `bun build --compile`, no goreleaser, no GH release tarballs for now.** Consumers need `bun` installed. Compiled-binary path is a deferred follow-up.
- **Goreleaser integration (confirmed by user)**: cliff-notes **documents** how to wire it into a consumer's goreleaser pipeline (via `--extract` + `--release-notes`). cliff-notes does **not** configure goreleaser itself or ship any `.goreleaser.yaml` snippets that get installed automatically. Recipes live in the README.

## Recommended approach

### Stack

| Concern        | Choice                                                          | Why                                                                                                                                             |
| -------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **bun**                                                         | Org default; user preference; `bunx` for zero-install cross-project use                                                                         |
| LLM SDK        | **[Vercel AI SDK](https://sdk.vercel.ai/) (`ai`)**              | Multi-provider in one API; `generateObject({ schema })` returns zod-validated structured output; Anthropic prompt caching via `providerOptions` |
| Providers      | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/amazon-bedrock` | Selected per-project via TOML config                                                                                                            |
| Data layer     | **`git-cliff`** (external binary)                               | Deterministic conventional-commit parsing, tag detection, range math, PR-link generation, JSON `--context` output                               |
| PR enrichment  | **`gh` CLI**                                                    | `gh pr view <n> --json title,body,labels,url,author` for real PR context                                                                        |
| Config         | **TOML** via `smol-toml` + zod                                  | Multiline prompt strings work cleanly; predictable                                                                                              |
| CLI args       | **`commander`**                                                 | Standard, well-typed                                                                                                                            |
| Markdown merge | Hand-rolled splice on `## [vX.Y.Z]` headings                    | Section boundaries are deterministic; avoids parser dependency                                                                                  |

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
2. **Release summary** — one call, 2–4 sentences. Input: rewritten entries + project voice/audience. Output: a single `summary: string`.

PR links, dates, version headers, section ordering: **never** LLM-generated.

### Prompt caching

Cache-control on the system prompt + project voice/audience block (long, stable). Per-invocation entries are uncached.

### Operating modes

| Flag                           | Behavior                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| (default)                      | Generate for range since last tag → **prepend** new `## [<next-tag>]` section to `CHANGELOG.md` |
| `--tag vX.Y.Z`                 | Force the version header                                                                        |
| `--unreleased`                 | Use `## [Unreleased]` header; replaces any existing `[Unreleased]` block                        |
| `--dry-run`                    | Print to stdout, **never touch disk**                                                           |
| `--out <file>`                 | Write to file instead of splicing into CHANGELOG.md                                             |
| `--extract <tag> --out <file>` | No LLM call — extract an existing section from CHANGELOG.md (for goreleaser to consume)         |
| `--provider <name>`            | Override config provider                                                                        |
| `--model <name>`               | Override config model                                                                           |
| `--verbose`                    | Show token counts, raw git-cliff JSON, intermediate LLM payloads                                |

`--dry-run` is the **default expectation** during iteration. Tool always prints a preview to stderr before touching disk; `--yes` skips confirm.

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

The audit block makes drift between raw commits and LLM rewrites diffable in code review. The marker `cliff-notes:raw v1` lets future versions re-render from raw input without re-querying git.

### Goreleaser / CI integration — documented only

cliff-notes ships **README recipes** for two integration paths. It does not modify the consumer's `.goreleaser.yaml`:

1. **Per-section extraction (recommended)**: CI runs `cliff-notes --extract v1.2.3 --out release-notes.md`, then `goreleaser release --release-notes release-notes.md`. No LLM call in CI.
2. **Disable goreleaser's auto-changelog**: consumer sets `changelog.disable: true` in their own `.goreleaser.yaml` and supplies the extracted file. Copy-paste snippet in README.

Both are opt-in. A project can adopt cliff-notes for the human-readable `CHANGELOG.md` only and never touch its goreleaser config.

### Config file: `cliff-notes.toml`

Lives at project root. Loaded relative to `cwd` (override with `--config <path>`).

```toml
[provider]
name = "anthropic"           # anthropic | openai | bedrock
model = "claude-sonnet-4-6"
# bedrock-only:
# aws_profile = "ai"
# api_key_env = "ANTHROPIC_API_KEY"  # default per-provider

[project]
name = "spackle-ui"
audience = "internal-devs"
voice = "concise, technical, no marketing fluff"

[prompt]
# Optional overrides. Defaults baked into the tool.
# system_extra = """..."""
# summary_style = """..."""

[git_cliff]
config = "cliff.toml"        # path to per-project cliff.toml; default is bundled baseline

[output]
changelog_file = "CHANGELOG.md"
date_format = "%Y-%m-%d"
```

Tool ships a default `cliff.toml` baseline so first-time projects can run with just `cliff-notes.toml`.

### Distribution

- **No goreleaser, no compile** (confirmed). Direct GitHub-source install.
- `package.json` `bin: { "cliff-notes": "./dist/cli.js" }`.
- Build: `bun build src/cli.ts --target node --outfile dist/cli.js` via `prepublish` script — so the built file is present when GitHub serves the repo to `bun add`.
- Consumers install via `bun add github:a2-ai/cliff-notes` (devDependency) or run ad-hoc via `bunx github:a2-ai/cliff-notes`.
- Compiled-binary path (`bun build --compile` + goreleaser tarball) is a deferred follow-up; document this as a future option in the README but do not ship it now.

## Repo layout

```
~/Projects/a2-ai/cliff-notes/
├── package.json             # bun, ai, @ai-sdk/*, smol-toml, zod, commander
├── tsconfig.json
├── README.md                # usage + goreleaser integration recipes
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

- `src/cli.ts` — commander wiring; `--dry-run` short-circuits any disk write
- `src/llm.ts` — Vercel AI SDK setup; `generateObject({ schema, providerOptions: { anthropic: { cacheControl: {...} } } })`
- `src/schemas.ts` — zod schemas; **entry-rewrite schema enforces array length parity and `pr_number` preservation** via custom refine
- `src/git-cliff.ts` — spawn `git-cliff --context`; on missing binary, exit with install instructions
- `src/github.ts` — `gh` presence check; per-PR fetch with small concurrency limit (e.g. 5)
- `src/merge.ts` — header-aware splice; replaces `[Unreleased]` cleanly; preserves footer references
- `cliff.toml` (default baseline) — conventional-commit grouping (feat/fix/perf/docs/refactor/test/chore), PR-link template targeting `gh` remote

## Implementation order

1. Skeleton: `package.json`, `tsconfig.json`, `commander` entry that prints `--help`.
2. Config loader + zod schema (`config.ts`).
3. git-cliff wrapper + bundled `cliff.toml` baseline (`git-cliff.ts`).
4. gh PR enrichment (`github.ts`).
5. LLM call (`llm.ts` + `schemas.ts`) with mock fixture to test schema parity.
6. Renderer (`render.ts`) with audit-comment block + golden-file tests.
7. Merge / extract (`merge.ts`, `extract.ts`) with fixture-based tests.
8. Pipeline orchestration (`pipeline.ts`) — wire `--dry-run`, `--unreleased`, `--tag`, `--extract`.
9. README with goreleaser recipes + `cliff-notes.example.toml`.
10. Smoke test against `spackle-ui` (see verification).
11. After implementation, copy this plan file to `~/Projects/a2-ai/cliff-notes/planning/implemented-plan.md`.

## Verification

1. **Smoke test against spackle-ui**:

   ```
   cd ~/Projects/a2-ai/spackle-ui && bunx ~/Projects/a2-ai/cliff-notes --unreleased --dry-run
   ```

   Expect: rendered markdown to stdout, summary + entries for commits since last tag, no disk write.

2. **Schema-violation handling**: Mock LLM returns wrong-length array / missing `pr_number`. Pipeline fails with clear error, **never** writes partial CHANGELOG.

3. **Provider switching**: Run with `provider.name = "anthropic"` then `"openai"`. Output structure identical; only prose differs.

4. **Round-trip extract**: Generate a section → extract with `--extract <tag>` → diff against the original. Byte-identical.

5. **Goreleaser handoff (docs-only)**: In a throwaway project, follow the README recipe (manually set `changelog.disable: true` + use extracted file). Confirm goreleaser picks up the body verbatim.

6. **Unit tests** (`bun test`):
   - `render.test.ts` — golden-file rendering with audit comment
   - `merge.test.ts` — splice into empty file, file with existing releases, file with `[Unreleased]` to replace
   - `pipeline.test.ts` — mock git-cliff + gh + LLM; assert end-to-end schema validation

## Out of scope (explicit non-goals)

- No GitHub Release creation — goreleaser owns that.
- No tag creation — dev does that manually after reviewing the changelog diff.
- No semver bumping / version inference — `--tag` required for tagged releases.
- No profile system (per llmdiff).
- No streaming output.
- No web UI / Studio integration.
- No automatic PR comment posting.
- **No compiled binary / goreleaser distribution** (deferred).
- **No automatic modification of consumer `.goreleaser.yaml`** — recipes are docs only.
