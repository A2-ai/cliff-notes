# Add commit-SHA fallback links for non-PR commits

## Context

Today, when a commit doesn't have an associated PR (e.g. pushed directly to `main`), its rendered changelog bullet is dead text — no link surface at all. PR-linked commits get `([#123](https://github.com/org/repo/pull/123))`, but a direct-to-main `feat: tweak retry logic` renders as just the rewritten prose with no way for a reader to inspect the actual change. This degrades the "audit trail" promise of the README.

This change adds a short-SHA fallback link (e.g. `([abc1234](https://github.com/org/repo/commit/abc1234...))`) for commits where no PR was detected, derived from the `origin` remote. PR-linked commits stay PR-only — one link per bullet, no redundancy.

## Robustness scope

- **`origin` remote, GitHub only.** Gate URL construction on host == `github.com`. For any other host (GitLab, Bitbucket, internal Gitea) we currently can't construct the right path anyway, so we fall back to no link — same as today. This matches the project's GitHub-only posture (already requires `gh` CLI).
- **URL form normalization.** Accept HTTPS (`https://github.com/o/r[.git]`), SSH (`git@github.com:o/r[.git]`), and SSH-protocol (`ssh://git@github.com/o/r[.git]`); strip `.git`.
- **Graceful fallback.** Missing `origin`, unparseable URL, or non-GitHub host → no SHA link, never an error.
- **Override field deferred.** Not adding `project.repo_url` config yet. If/when the fork case (`origin` = personal fork) bites someone, add it as a one-line override.

## Implementation

### 1. New helper: `src/git-remote.ts` (new file)

Single-purpose module so `pipeline.ts` stays tidy and the regex is unit-testable.

```ts
export interface RepoSlug {
  owner: string;
  repo: string;
}

export async function getOriginGitHubSlug(cwd: string): Promise<RepoSlug | null>;
// spawns `git remote get-url origin`; returns null on any failure
// (no origin, non-github.com host, parse miss).

export function parseGitHubRemote(url: string): RepoSlug | null;
// pure; handles the three URL forms above. Exported for tests.

export function buildCommitUrl(slug: RepoSlug, sha: string): string;
// returns `https://github.com/${owner}/${repo}/commit/${sha}`.

export function shortSha(sha: string): string;
// returns sha.slice(0, 7).
```

Reuse the `execCapture` pattern already in `src/git-cliff.ts:97` and `src/github.ts:88` — copy it locally (it's 25 lines) rather than extracting a shared helper, to avoid scope creep.

### 2. Wire it into the pipeline: `src/pipeline.ts`

- After `loadConfig` (~line 46), call `getOriginGitHubSlug(loaded.projectRoot)` **once** per run and stash the result in a `repoSlug` const. Single subprocess call, regardless of commit count.
- When building each entry around `src/pipeline.ts:98-112`, compute a `commit_sha` and (when PR is absent and `repoSlug` is non-null) a `commit_url`. Stuff both onto `EntryInput`.

### 3. Extend `EntryInput`: `src/schemas.ts`

Add two optional fields to the existing schema (`src/schemas.ts:4-12`):

- `commit_sha: string | null`
- `commit_url: string | null`

Both default null so the LLM-side payload (rewrite prompt at `src/prompts/rewrite.ts`) doesn't need to change — the prompt only forwards a subset of fields and never sees SHAs. (Good: keeps the LLM's "cannot invent links" guarantee intact.)

### 4. Render the link: `src/render.ts`

Update `RenderedEntry` (~line 16) to carry `commitSha` and `commitUrl` alongside `prNumber`/`prUrl`. In `renderPRSuffix` (`src/render.ts:52`), keep the PR branch unchanged; add a fallback branch:

```ts
function renderLinkSuffix(e: RenderedEntry): string {
  if (e.prNumber !== null) {
    return e.prUrl ? ` ([#${e.prNumber}](${e.prUrl}))` : ` (#${e.prNumber})`;
  }
  if (e.commitSha && e.commitUrl) {
    return ` ([${shortSha(e.commitSha)}](${e.commitUrl}))`;
  }
  return "";
}
```

Rename `renderPRSuffix` → `renderLinkSuffix` since it now handles both. Update `assembleRender` (`src/render.ts:59`) to pass through the new fields from `EntryInput`.

**Audit block**: leave alone. The raw block (`src/render.ts:42-46`) currently captures the conventional-commit summary line — adding the SHA there is a separable nicety; not in this change.

### 5. Tests: `tests/`

- Pure tests for `parseGitHubRemote` covering the three URL forms, `.git` suffix, non-github host returns null, malformed input returns null.
- Render test: bullet with `commitSha` + `commitUrl` and no PR renders `([abc1234](url))`; bullet with both PR and SHA renders only the PR link (no redundancy).
- Existing render tests with PR-only entries should keep passing unchanged.

## Files touched

- `src/git-remote.ts` (new)
- `src/schemas.ts` (add 2 optional fields)
- `src/pipeline.ts` (call helper once; populate new fields)
- `src/render.ts` (rename + extend suffix logic; thread new fields through `assembleRender`)
- `tests/git-remote.test.ts` (new)
- `tests/render.test.ts` (extend)

No changes to `cliff.toml`, `cliff-notes.example.toml`, `src/config.ts`, prompts, or LLM client.

## Verification

1. `bun test` — unit tests cover URL parsing, render branching, and (via existing tests) no regression for PR-linked entries.
2. End-to-end smoke on this repo: there's a direct-to-`main` commit (`e182c43 feat: add progress prints, oxlint/tsc checks`) with no PR — run `bun src/cli.ts --unreleased --dry-run` and confirm it renders with a `([e182c43](https://github.com/a2-ai/cliff-notes/commit/e182c43))` suffix.
3. Negative smoke: rename `origin` → `something-else` in a scratch clone, re-run, confirm no link rendered and no error.
4. `bunx oxlint` + `bunx tsc --noEmit` per `lefthook.yml`.

## Follow-ups (not in this change)

- Optional `project.repo_url` config override for fork-of-org workflows.
- Include the short SHA in the audit comment block (`src/render.ts:87`) so the raw record is independently traceable.
- Drop a SHA suffix on PR-linked entries too, if reviewers ever request it (currently judged redundant).
