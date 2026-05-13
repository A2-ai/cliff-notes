# cliff-notes

A small internal CLI that produces release notes with **deterministic structure and constrained LLM creativity**:

- **Structure** (sections, ordering, PR links, version headers) — `git-cliff` + `gh` CLI. Fully deterministic.
- **Prose** (rewritten entries + release summary) — Vercel AI SDK call whose output is zod-validated. The LLM cannot invent PR numbers, drop entries, reorder, or change links.

One tool, multiple projects, multiple LLM providers (Anthropic / OpenAI / Bedrock).

## Prerequisites

- [bun](https://bun.sh) — runtime
- [git-cliff](https://git-cliff.org/docs/installation/) — conventional-commit parser
- [gh CLI](https://cli.github.com/), authenticated — for PR title/body enrichment
- An API key for one of the supported providers

## Install

cliff-notes is published as a raw source repo (no compiled binary yet). Two ways to use it:

```sh
# Ad-hoc, no install
bunx github:a2-ai/cliff-notes --help

# As a devDependency of the consuming project
bun add -d github:a2-ai/cliff-notes
```

## Configure

Drop a `cliff-notes.toml` at the root of the project that needs release notes. See `cliff-notes.example.toml` in this repo for the full schema. Minimum viable config:

```toml
[provider]
name = "anthropic"
model = "claude-sonnet-4-6"

[project]
name = "my-project"
audience = "internal-devs"
voice = "concise, technical, no marketing fluff"
```

Then export the relevant API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or AWS credentials for Bedrock).

If the project doesn't already have a `cliff.toml`, cliff-notes uses a bundled default. Override via `git_cliff.config = "path/to/cliff.toml"`.

## Use

```sh
# Preview release notes for everything since the last tag, no disk write
cliff-notes --unreleased --dry-run

# Same, but splice into CHANGELOG.md as an [Unreleased] section
cliff-notes --unreleased

# Tagged release — splice a new ## [v1.2.3] block before existing releases
cliff-notes --tag v1.2.3

# Write to a standalone file instead of CHANGELOG.md
cliff-notes --tag v1.2.3 --out release-notes.md

# Skip the confirmation prompt
cliff-notes --tag v1.2.3 --yes
```

Either `--tag <version>` or `--unreleased` is required — cliff-notes does not infer version numbers.

### Audit trail

Each generated section ends with an HTML comment containing the raw git-cliff entries:

```markdown
## [v1.2.3] - 2026-05-13

<summary prose>

### Features
- Added foo endpoint ([#123](https://github.com/...))

<!-- cliff-notes:raw v1
- Features(api): add foo endpoint (PR #123)
-->
```

The block makes drift between raw commits and LLM rewrites diffable in code review. The marker version (`v1`) lets future cliff-notes re-render from the raw input without re-querying git.

## Goreleaser integration (recipes)

cliff-notes does **not** configure goreleaser. Below are two opt-in patterns you can wire into your own `.goreleaser.yaml`.

### Recipe A — Per-section extract (recommended)

Keep cliff-notes out of CI entirely. Generate `CHANGELOG.md` locally, commit it, and let CI extract the relevant section at release time:

```sh
# Local, before tagging:
cliff-notes --tag v1.2.3
git add CHANGELOG.md && git commit -m "chore: release notes for v1.2.3"
git tag v1.2.3 && git push --follow-tags
```

```yaml
# .goreleaser.yaml
version: 2

changelog:
  disable: true   # turn off goreleaser's auto-changelog

before:
  hooks:
    - bunx github:a2-ai/cliff-notes --extract {{ .Tag }} --out .release-notes.md
```

Then invoke `goreleaser release --release-notes .release-notes.md`. The extracted file is the exact prose from your `CHANGELOG.md` section, with the audit comment block stripped.

### Recipe B — `--release-notes` flag at invocation time

If you'd rather not pre-hook in goreleaser, do the extract inline in your release workflow:

```yaml
# .github/workflows/release.yaml
- run: bunx github:a2-ai/cliff-notes --extract ${{ github.ref_name }} --out release-notes.md
- run: goreleaser release --clean --release-notes release-notes.md
```

## Providers & prompt caching

| Provider  | Config `name` | Default env var       | Notes |
|-----------|---------------|-----------------------|-------|
| Anthropic | `anthropic`   | `ANTHROPIC_API_KEY`   | System prompt is cached via `cacheControl: ephemeral` — re-runs during iteration only pay for the entries payload. |
| OpenAI    | `openai`      | `OPENAI_API_KEY`      | OpenAI applies prompt caching automatically when the prefix exceeds 1024 tokens. |
| Bedrock   | `bedrock`     | (AWS standard chain)  | Set `aws_profile` in `[provider]` and `AWS_REGION` in env. Cache control mirrors Anthropic. |

Override at the command line: `--provider openai --model gpt-4.1`.

## Verification

```sh
bun test
```

Unit tests cover render, merge, extract, and schema-validation logic. The LLM call is mocked at the SDK boundary; provider switching is exercised by running the same input with two configs and asserting structural parity (only prose differs).

## Out of scope (today)

- No GitHub Release creation — goreleaser owns that.
- No tag creation — dev does that manually after reviewing the diff.
- No semver bumping / version inference — `--tag` is required for tagged releases.
- No streaming output.
- No compiled-binary distribution yet (deferred follow-up).
