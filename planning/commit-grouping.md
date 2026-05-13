# Plan: Curation pass for related commits (PR prefilter + LLM curation)

## Context

cliff-notes today renders **one bullet per commit** in a release. That's fine on squash-merge repos (each PR collapses to one commit carrying `(#N)`), but it breaks down for:

- **Merge-commit PRs**: each PR contributes N constituent commits ("1", "2", "wip", "fix typo") plus a `Merge pull request #N from foo/branch` commit → N+1 entries per PR.
- **Rebase-merge PRs**: GitHub rewrites each rebased commit to carry `(#N)`, so the commits share a PR number — but cliff-notes still emits them as N separate entries.
- **Direct-to-main related commits**: a feature landed across multiple non-adjacent commits without a PR (e.g. "add user model", "wire user model into auth", "fix typo in user model"). No PR signal binds them; no deterministic rule reliably groups them.
- **Plumbing noise**: dependency bumps, lint/format fixes, comment-only edits, internal renames, test-only churn. Mechanically valid commits, but rarely interesting in a release-notes context.

The first two are mechanical: same PR number → group. The third is semantic — only an LLM with subjects, bodies, and *what files each commit touched* can judge it. The fourth is editorial: only an LLM can sensibly decide "this commit shouldn't appear in the changelog."

The goal is a **curation pass** that handles all four — grouping, primary-selection, and omission — while preserving cliff-notes' core invariants:

- **Deterministic where deterministic suffices**, semantic only where it doesn't.
- **Strict Zod 1:1 input↔output contract** with the existing rewrite pass (src/schemas.ts:30–53) stays intact.
- **Audit block** (src/render.ts:42–46) still records every original commit, tagged with its curation disposition (grouped under X, omitted with reason, solo).

## Recommended approach: PR prefilter + LLM curation on the residual

### Two-stage pipeline

1. **Free PR prefilter (no LLM call).** Resolve a PR number per commit, then group commits sharing a PR number. Sources of PR number, in order:
   - `commit.remote.pr_number` from git-cliff's GitHub enrichment (most authoritative).
   - `extractPRNumber(commit)` from src/git-cliff.ts:129 (subject `(#N)` / links).
   
   This step handles merge-commit and rebase-merge PRs uniformly. For squash-merge repos every commit has a unique PR number — the prefilter is a no-op (no commit shares a PR with any other).
   
2. **Gate.** If fewer than 2 commits remain in the residual (commits not part of any multi-member PR group), skip the LLM curation call entirely. Most well-disciplined squash-merge releases exit here.

3. **LLM curation pass on the residual.** Ask the model to classify each residual commit into exactly one of three dispositions: group with N others, stand alone, or omit (with reason). Strict partition schema, type-homogeneity guard, content-hash cached for reproducibility.

The combined `groups[]` (prefilter + LLM) plus `omitted[]` is what flows forward. The existing **rewrite pass remains a separate, unchanged LLM call** consuming the surviving groups as `EntryInput[]`.

### Why keep curation and rewrite as separate LLM calls

- **Cache granularity.** Curation is the expensive call (full residual + file lists + diff stats in input). Rewrite is much smaller (just subjects/titles/types). Tweaks to the rewrite system prompt — `voice`, `audience`, `system_extra` — only invalidate the cheap cache, not the expensive curation one.
- **Independent retries.** Rewrite has strict 280-char length validation. Combined → re-pay curation cost on every rewrite-only retry. Separate → retry just rewrite.
- **Independent prompt tuning.** Curation needs "be conservative about merging and omission, justify every choice." Rewrite needs "be concise, technical, no marketing fluff." Each system prompt stays focused.
- **Lower-risk ship.** The existing rewrite pass works today and is tested. Curation lands as a new pre-stage that produces grouped `EntryInput[]` for the existing rewrite path. No churn in the working code path.
- **Reversibility.** If we later observe coherence problems (rewrite forgetting the group's narrative), combining is a small refactor. Going the other way is larger.

### Reuse `gh auth` credentials

cliff-notes already requires `gh` (src/github.ts:21, 76–86). Lift the existing OAuth token via `gh auth token` and pass it to git-cliff as `--github-token`. No new auth setup, no new env var, no new prompt. CI: GitHub Actions auto-sets `GITHUB_TOKEN` and `GITHUB_REPOSITORY`; git-cliff reads both via env. Token resolution falls back gracefully (env → `gh auth token` → `null`); if `null`, we degrade to subject-based PR extraction only.

### Diff signal for the LLM pass

Subjects alone are too thin to judge "are these the same feature." File overlap is the strongest practical signal you can feed without blowing the prompt budget. Per-commit:

- **Touched files** via `git show --no-patch --name-only --format= <sha>`. ~5–20 paths.
- **Line stat** via `git show --no-patch --shortstat --format= <sha>`. ~one line.

Batched into a single `git log --name-status --format=...` over the release range. No full diffs in v1 — file overlap alone resolves most calls correctly. If quality is insufficient after real-world use, a v2 fallback can send truncated diffs on a follow-up confirmation pass.

### Default

**`strategy = "auto"`** (PR prefilter + LLM curation on residual) is the default. `"by-pr-only"` skips the LLM pass (deterministic-only mode for users who want zero LLM curation cost). `"off"` keeps today's per-commit behavior.

`omit_plumbing = true` is the default for the curation pass — the prompt is conservative, every omission requires a reason, and every omitted commit stays visible in the audit block plus `--show-curation` output. Easy to set `false` if a team wants every commit represented as a bullet.

## File-by-file changes

### `src/exec.ts` (NEW)

Extract the duplicated `execCapture` from src/git-cliff.ts:97 and src/github.ts:88 into one shared helper, reused by curation + diff modules.

### `src/github.ts` (extend)

Add token/repo resolution helpers reused by the git-cliff invocation:

- `async function resolveGitHubToken(opts: { cwd: string; verbose?: boolean }): Promise<string | null>` — try `process.env.GITHUB_TOKEN`, then `process.env.GH_TOKEN`, then `gh auth token` (capture stdout, trim). Return `null` on failure (do not throw).
- `async function resolveGitHubRepo(opts: { cwd: string; configOverride?: string }): Promise<string | null>` — try `configOverride`, then `process.env.GITHUB_REPOSITORY`, then `gh repo view --json nameWithOwner -q .nameWithOwner`, then parse `git remote get-url origin`. Return `null` on failure.

### `src/git-cliff.ts` (extend `CommitSchema` + plumb token/repo)

1. Extend `CommitSchema` (lines 4–29) to parse the `remote` field:

   ```
   remote: z.object({
     pr_number: z.number().int().nullable().optional(),
     pr_title: z.string().nullable().optional(),
     pr_labels: z.array(z.string()).optional().default([]),
     username: z.string().nullable().optional(),
   }).passthrough().optional()
   ```

2. Extend `CliffOptions` (lines 46–51) with `githubToken?: string` and `githubRepo?: string`. In `runGitCliff`, append `--github-token <tok>` and `--github-repo <owner/name>` when both are present.

### `src/git-diff.ts` (NEW)

One `git log` invocation per release that yields per-commit file lists + line stats.

- `interface CommitDiffStat { sha: string; files: string[]; additions: number; deletions: number }`
- `async function getDiffStats(shas: string[], cwd: string): Promise<Map<string, CommitDiffStat>>` — internally runs `git log --no-walk --name-only --shortstat --format='%H' <sha1> <sha2> ...` (or `git show --shortstat --name-only` per SHA, batched). Parse into the map. Skip on error (return empty map; not fatal).

### `src/curation.ts` (NEW)

The orchestrator for the two-stage pipeline. Pure logic (no shell-outs of its own); consumes `commits[]`, the optional `diffStats` map, and an `llm.curate` callback.

**Exports:**

```
interface CuratedMember {
  sha: string;
  subject: string;
  body: string;
  type: string | null;
  scope: string | null;
  files: string[];      // from diff stats; may be empty if diff lookup failed
  additions: number;
  deletions: number;
}

interface CommitGroup {
  prNumber: number | null;
  prUrl: string | null;
  members: CuratedMember[];          // length >= 1
  type: string;                      // resolved for the group
  scope: string | null;
  author: string | null;
  curatedBy: "solo" | "pr" | "llm";  // for audit / verbose output
  llmReason?: string;                // populated when curatedBy === "llm"
}

interface OmittedCommit {
  member: CuratedMember;
  reason: string;
}

interface CurationOptions {
  strategy: "off" | "by-pr-only" | "auto";
  omitPlumbing: boolean;
  minGroupSize: number;
  cwd: string;
  llm?: LLMClient;
  diffStats?: Map<string, CommitDiffStat>;
  verbose?: boolean;
}

interface CurationResult {
  groups: CommitGroup[];
  omitted: OmittedCommit[];
}

async function curateCommits(
  commits: CliffCommit[],
  opts: CurationOptions,
): Promise<CurationResult>;
```

**Algorithm:**

1. If `strategy === "off"` → one `CommitGroup` per commit with `curatedBy: "solo"`; `omitted: []`. Pipeline shape is uniform regardless of strategy.
2. **PR prefilter.** For each commit, resolve a PR number via `commit.remote?.pr_number ?? extractPRNumber(commit)`. Group commits sharing a non-null PR number. For each group:
   - Pick `primary` = the commit whose subject best resembles a PR title (heuristic: longest non-terse subject in the group, ties broken by chronological order).
   - Resolve `type` from member types via majority + precedence (see below).
   - Tag `curatedBy: "pr"` when `members.length > 1`, else `"solo"`.
3. If `strategy === "by-pr-only"`, return `{ groups, omitted: [] }` now.
4. **LLM gate.** Collect the residual = commits not part of any multi-member PR group. If `residual.length < 2`, return `{ groups, omitted: [] }` now.
5. **LLM curation pass.** Call `llm.curate(residual, diffStats, { omitPlumbing, ... })`. The response is a partition: every residual index is either in exactly one `groups[].member_indices` or in `omitted[].index`. Apply:
   - For each multi-member proposed group, replace the corresponding solo groups with one multi-member `CommitGroup` tagged `curatedBy: "llm"` with `llmReason`.
   - For each omitted index, remove the corresponding solo group from `groups[]` and push an `OmittedCommit` with its reason.
6. If LLM validation fails at the schema level, log a stderr warning and keep the solo groups for the residual; `omitted` stays empty. Never block the changelog.
7. Apply `min_group_size` filter: any group with `< min_group_size` members → expand back to solos. (Defensive.)
8. Emit `groups[]` in source order (each group's first member's release index).

**Type/scope resolution** (deterministic, used for both PR and LLM groups):

- Any `Reverts` member → group type `Reverts`.
- Else most common member type, ties broken by precedence: `Features > Bug Fixes > Performance > Refactor > Security > Build > CI > Documentation > Tests > Chores > Other`.
- Scope: shared scope across all members, else `null`.
- Author: most-frequent member author.

### `src/schemas.ts` (extend)

Add `EntryMember` and three new fields to `EntryInput` (lines 4–13):

```
export interface EntryMember {
  sha: string;
  subject: string;
  body: string;
  type: string | null;
  scope: string | null;
  files: string[];
  additions: number;
  deletions: number;
}

export interface EntryInput {
  pr_number: number | null;
  raw_subject: string;
  pr_title: string | null;
  pr_body: string | null;
  type: string;
  scope: string | null;
  author: string | null;
  url: string | null;
  members: EntryMember[];               // NEW; length >= 1
  curated_by: "solo" | "pr" | "llm";    // NEW; for prompt + audit
  llm_reason?: string;                  // NEW; only when curated_by === "llm"
}
```

`RewriteResponseSchema` / `buildRewriteSchema` (lines 24–53) **unchanged**: still enforce `entries.length === inputs.length`. Because `inputs.length === groups.length`, the contract holds; existing tests pass once construction sites add `members`/`curated_by` placeholders.

Add a new partition schema for the LLM curation response:

```
const GroupSchema = z.object({
  member_indices: z.array(z.number().int().nonnegative()).min(1),
  primary_index: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
});

const OmittedSchema = z.object({
  index: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
});

export const CurationResponseSchema = z.object({
  groups: z.array(GroupSchema).default([]),
  omitted: z.array(OmittedSchema).default([]),
});

export function buildCurationSchema(residual: CurationInput[], opts: {
  maxPerGroup: number;
  maxIndexGap: number;
  requireSameType: boolean;
  allowOmissions: boolean;
}) { /* superRefine:
        - union of groups.member_indices ∪ omitted.index = {0..n-1}
        - no overlaps between groups, or between groups and omitted
        - primary_index ∈ member_indices
        - groups.member_indices.length ≤ maxPerGroup
        - max - min member index ≤ maxIndexGap
        - when requireSameType: all members in a group share the same type
        - when !allowOmissions: omitted.length === 0
     */ }
```

`CurationInput` is a light shape (subject/body/type/scope/author/files/stat) — what we hand the LLM, separate from `EntryInput`.

### `src/config.ts` (extend)

Add to `ConfigSchema` (around line 39):

```
curation = z.object({
  strategy: z.enum(["off", "by-pr-only", "auto"]).default("auto"),
  omit_plumbing: z.boolean().default(true),
  min_group_size: z.number().int().min(1).default(2),
  max_per_group: z.number().int().min(2).default(5),
  max_index_gap: z.number().int().min(1).default(15),
  require_same_type: z.boolean().default(true),
  cache: z.boolean().default(true),
}).default({})

github = z.object({
  enabled: z.boolean().default(true),
  repo: z.string().optional(),
}).default({})
```

Document in `cliff-notes.example.toml`:

```toml
[curation]
# strategy = "auto"        # default. PR prefilter + LLM curation on residual.
                           # "by-pr-only" runs only the deterministic prefilter.
                           # "off" reverts to one bullet per commit.
# omit_plumbing = true     # LLM may suppress obvious-noise commits (dep bumps,
                           # lint fixes, comment-only edits). Omissions always
                           # appear in the audit block with their reason.
# min_group_size = 2
# max_per_group = 5
# max_index_gap = 15       # LLM cannot group commits >15 positions apart
# cache = true             # content-hash cache of LLM curations for determinism

[github]
# enabled = true           # uses gh auth credentials for PR enrichment
# repo = "owner/name"      # optional; default autodetected
```

### `src/llm.ts` (extend `LLMClient`)

Add a method (keeps `rewriteEntries` and `summarize` unchanged):

```
curate(residual: CurationInput[], opts: {
  maxPerGroup: number;
  maxIndexGap: number;
  requireSameType: boolean;
  allowOmissions: boolean;
}): Promise<CurationResponse>
```

Implementation parallels `rewriteEntries` (lines 38–48): one `generateObject` call with `buildCurationPrompt(residual, opts)` and `buildCurationSchema(residual, opts)`. Temperature 0.

Wrap in a content-hash cache when `loaded.config.curation.cache`: hash `JSON.stringify(residual) + PROMPT_VERSION + opts`; key into `.cliff-notes/cache/curate-<hash>.json` under `projectRoot`. Same inputs → byte-identical curation across runs.

### `src/prompts/curate.ts` (NEW)

`buildCurationPrompt(residual: CurationInput[], opts): string`. Content:

- Opening: "**Default to one disposition per commit.** Most commits should stand alone as their own changelog entry. Group commits only when they describe one logical change. Omit commits only when they clearly don't belong in user-facing release notes."
- **Grouping criteria.** Strong-evidence heuristics: file overlap, sequential indices with terse subjects, `fixup!`/`squash!` prefixes, shared scope + author within a small window.
- **Grouping negatives.** Different conventional types → separate (schema also enforces this). Different non-null PR numbers → separate. When in doubt → solo.
- **Omission criteria** (only when `opts.allowOmissions`): dependency bumps without behavioral impact, lint/format/whitespace fixes, comment-only edits, internal renames, test-only churn, CI config touches that don't change behavior. **When in doubt, do NOT omit.** Every omission must include a one-line reason.
- **Omission negatives.** Anything user-facing, bug fixes, performance changes, API changes, removed/added features — never omit. Borderline cases default to including the commit, not omitting it.
- Payload: full residual JSON (`index`, `subject`, `body` (truncated to 1500), `type`, `scope`, `author`, `pr_number`, `files`, `additions`, `deletions`).
- Output schema reminder: `{groups: [{member_indices, primary_index, reason}], omitted: [{index, reason}]}`. Both `reason` fields show up in the audit block — they're for the human reviewer.
- Two worked examples:
  - Group: ["add user model", "wire user model into auth", "fix typo in user model"] (no PRs, overlapping `files`) → one group, `primary_index=0`, reason="all touch src/user.ts; describe initial user model rollout."
  - Omit: ["chore: bump @types/node from 20.4.1 to 20.4.2", "style: fix lint warnings"] → both in `omitted`, with reasons.

Include `PROMPT_VERSION` constant used in the cache key. Bump it whenever prompt or schema semantics change.

### `src/prompts/rewrite.ts` + `src/prompts/system.ts` (surface members to the rewrite pass)

Extend the rewrite payload to include `member_commits: [{subject, type, files}]` when `members.length > 1`. Add to the system prompt:

> "When `member_commits` is present, the entry represents a multi-commit change (multi-commit PR or a series of related commits identified by the curation pass). Write one sentence that captures the net change. Use `pr_title`/`pr_body` as primary signal; `member_commits` for supporting context. Do not enumerate individual commits."

### `src/pipeline.ts` (insert token/repo + diff stats + curation)

Reorder so `makeLLMClient` is constructed before curation runs. Three insertions in `runPipeline`:

1. **Before** `runGitCliff` (around line 50): resolve token + repo if `loaded.config.github.enabled`. Pass through to `runGitCliff`.
2. **After** `target.commits` is in hand (around line 80): fetch diff stats via `getDiffStats(target.commits.map(c => c.id), loaded.projectRoot)`.
3. **Replace** lines 80–112 with a curation-driven version:

   ```
   progress.step("curation", `strategy=${loaded.config.curation.strategy}`);
   const { groups, omitted } = await curateCommits(target.commits, {
     strategy: loaded.config.curation.strategy,
     omitPlumbing: loaded.config.curation.omit_plumbing,
     minGroupSize: loaded.config.curation.min_group_size,
     cwd: loaded.projectRoot,
     llm,                          // constructed earlier in the pipeline
     diffStats,
     verbose: opts.verbose,
   });

   const prNumbers = groups.flatMap(g => g.prNumber !== null ? [g.prNumber] : []);
   const prMap = await enrichPRs(prNumbers, { cwd: loaded.projectRoot, verbose: opts.verbose });

   const inputs: EntryInput[] = groups.map(g => {
     const pr = g.prNumber !== null ? (prMap.get(g.prNumber) ?? null) : null;
     const subject = pr?.title
       ?? g.members.find(m => m.subject.length > 8)?.subject
       ?? g.members[0]!.subject.replace(/\s*\(#\d+\)\s*$/, "");
     return {
       pr_number: g.prNumber,
       raw_subject: subject,
       pr_title: pr?.title ?? null,
       pr_body: pr?.body ?? null,
       type: g.type,
       scope: g.scope,
       author: pr?.author ?? g.author,
       url: pr?.url ?? g.prUrl,
       members: g.members,
       curated_by: g.curatedBy,
       llm_reason: g.llmReason,
     };
   });
   ```

   `omitted` is passed through to `assembleRender` so the audit block can list them.

If `opts.showCuration` (new CLI flag, default false) is set: emit the proposed groups + omissions to stderr in a small tree before `rewriteEntries` runs.

### `src/render.ts` (extend audit block)

`assembleRender` now takes `omitted: OmittedCommit[]` in addition to `inputs`/`rewritten`. Audit block emits:
- One rawLine per original commit in `inputs`, with a group anchor when grouped, tagged with curation source.
- A trailing section listing every omitted commit with its reason.

```
const isGrouped = inp.members.length > 1;
if (isGrouped) {
  const tag = inp.curated_by === "pr"
    ? `grouped by PR #${inp.pr_number}`
    : `grouped by model: ${inp.llm_reason ?? ""}`;
  rawLines.push(`- group (${tag}): ${inp.raw_subject}`);
  for (const m of inp.members) {
    const sc = m.scope ? `(${m.scope})` : "";
    rawLines.push(`  - ${m.sha.slice(0, 7)} ${m.type ?? "?"}${sc}: ${m.subject}`);
  }
} else {
  const m = inp.members[0]!;
  const sc = inp.scope ? `(${inp.scope})` : "";
  const prSuffix = inp.pr_number !== null ? ` (PR #${inp.pr_number})` : "";
  rawLines.push(`- ${m.sha.slice(0, 7)} ${inp.type}${sc}: ${inp.raw_subject}${prSuffix}`);
}
// ... after all inputs:
for (const o of omitted) {
  const sc = o.member.scope ? `(${o.member.scope})` : "";
  rawLines.push(
    `- omitted (${o.reason}): ${o.member.sha.slice(0, 7)} ${o.member.type ?? "?"}${sc}: ${o.member.subject}`
  );
}
```

Every original commit still appears in the audit block — re-renders detect drift commit-for-commit, and humans can see exactly why each group formed and why each omission happened.

`extract.ts`'s `stripAuditBlock` (line 63) regex matches anything between markers — no change needed. Keep marker `v1`.

### `src/cli.ts` (add `--show-curation`)

Add `--show-curation` flag forwarded into pipeline opts. Prints the proposed groups + omissions tree to stderr before rewrite kicks in. Useful for human eyeballing.

### Docs

- `cliff-notes.example.toml`: document `[curation]` and `[github]` sections.
- `README.md`: short paragraph on `gh auth token` reuse + CI envs + `--show-curation` flag + how omissions appear in the audit block but not the rendered bullets.

## Critical files

- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/curation.ts` (new)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/git-diff.ts` (new)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/prompts/curate.ts` (new)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/exec.ts` (new)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/pipeline.ts` (token/repo, diff stats, curation call, EntryInput build, omitted passthrough)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/github.ts` (token + repo resolution helpers)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/git-cliff.ts` (extend `CommitSchema.remote`; plumb token/repo flags)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/schemas.ts` (extend `EntryInput`; add curation partition schema)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/llm.ts` (add `curate`; cache layer; `rewriteEntries`/`summarize` unchanged)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/config.ts` (add `[curation]` + `[github]`)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/render.ts` (audit block per-member + curation source tag + omitted section)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/prompts/rewrite.ts` + `src/prompts/system.ts` (member context)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/src/cli.ts` (`--show-curation`)
- `/Users/andriymassimilla/Projects/a2-ai/cliff-notes/cliff-notes.example.toml` + `README.md` (docs)

## Step order (each step compiles)

1. `src/exec.ts` (new): extract shared `execCapture`; update call sites in git-cliff.ts + github.ts.
2. `src/config.ts` + `cliff-notes.example.toml`: add `[curation]` + `[github]` schemas and examples.
3. `src/schemas.ts`: add `EntryMember`, extend `EntryInput` with `members`/`curated_by`/`llm_reason`; add `GroupSchema`/`OmittedSchema`/`CurationResponseSchema`/`buildCurationSchema`. Update construction sites with placeholders.
4. `src/git-cliff.ts`: extend `CommitSchema.remote`; add token/repo to `CliffOptions`/`runGitCliff`.
5. `src/github.ts`: add `resolveGitHubToken`, `resolveGitHubRepo`.
6. `src/git-diff.ts` (new): `getDiffStats`.
7. `src/prompts/curate.ts` (new) + `src/llm.ts`: `curate` method + content-hash cache.
8. `src/curation.ts` (new): orchestrator combining prefilter, gate, LLM call, type resolution, omission passthrough.
9. `src/pipeline.ts`: hoist `makeLLMClient` earlier; insert token/repo + diff stats + curation; rewrite inputs block; pass `omitted` to `assembleRender`.
10. `src/render.ts`: extend audit block (per-member + omitted section).
11. `src/prompts/rewrite.ts` + `src/prompts/system.ts`: surface `member_commits`.
12. `src/cli.ts`: `--show-curation`.
13. Docs + tests.

## Verification

**Unit tests (`tests/curation.test.ts`, new)** — inject the LLM callback and diff-stats map for testability:

- `strategy: "off"` → one group per commit, all `curatedBy: "solo"`, `omitted: []`.
- `strategy: "by-pr-only"`: 3 commits sharing `pr_number = 42` → one PR group; LLM never invoked; `omitted: []`.
- `strategy: "by-pr-only"`: 3 commits all with `(#42)` in subject (rebase-merge), no `remote` enrichment → one PR group from subject fallback.
- `strategy: "auto"`, no PR-less residual → LLM never invoked (gate works).
- `strategy: "auto"`, 4 PR-less commits with overlapping `files` → LLM proposes a group; partition validates; combined groups returned with `curatedBy: "llm"` and `llmReason` populated.
- `strategy: "auto"`, `omit_plumbing: true`, residual contains a dep-bump commit → LLM proposes it in `omitted`; final result has it in `omitted[]`, not in `groups[]`.
- `strategy: "auto"`, `omit_plumbing: false` → schema rejects any non-empty `omitted` (`allowOmissions: false`); LLM has no omission option.
- `strategy: "auto"`, LLM proposes a group mixing `feat` + `chore` → schema rejects; fallback to solo with stderr warning.
- `strategy: "auto"`, LLM proposes indices spanning > `max_index_gap` → rejected.
- `strategy: "auto"`, LLM proposes oversized group (> `max_per_group`) → rejected.
- `strategy: "auto"`, LLM hallucinates an out-of-range index → rejected; solo fallback.
- `strategy: "auto"`, LLM omits an index that's also in a group → rejected (partition overlap).
- `min_group_size = 2`, LLM proposes a group of 1 → expanded to solo.

**Unit tests for token/repo resolution (`tests/github-resolve.test.ts`, new)** — mock `execCapture`:

- `GITHUB_TOKEN` env set → returned.
- No env, `gh auth token` succeeds → returned.
- No env, no `gh` → `null` (no throw).
- `[github] repo` config override → returned.
- `GITHUB_REPOSITORY` env → returned when no override.
- `gh repo view` succeeds when no env → returned.

**Unit tests for `buildCurationSchema` (`tests/schemas.test.ts`, extend)**:

- Solo-only partition (every index in its own group, `omitted: []`) → valid.
- Well-formed multi-member group with no omissions → valid.
- Well-formed mix of groups + omissions covering all indices → valid.
- Missing index, overlapping index, out-of-range index, empty `member_indices` → rejected.
- Same index in both a group and `omitted` → rejected (overlap).
- `primary_index` not in `member_indices` → rejected.
- Multi-member group with mixed types when `requireSameType: true` → rejected.
- Member span > `maxIndexGap` → rejected.
- Group size > `maxPerGroup` → rejected.
- Non-empty `omitted` when `allowOmissions: false` → rejected.

**Existing tests** (`tests/schemas.test.ts`, `tests/render.test.ts`): add `members`/`curated_by` placeholders at construction sites; refresh the render snapshot for the new audit-block format (per-member SHAs + omitted section).

**Manual end-to-end:**

1. On a repo with a known merge-commit PR + a few direct-to-main commits + a few plumbing commits (dep bumps, lint fixes):
   - `bun run dev -- --unreleased --dry-run --verbose --show-curation` (default config) → confirm: (a) PR group formed from merge-commit constituents, (b) LLM proposes a group for the related direct-to-main commits with a reason, (c) LLM proposes omissions for the plumbing commits with reasons, (d) audit block lists every constituent SHA tagged with curation source AND every omitted SHA with its reason, (e) rendered bullets do NOT include the omitted commits.
   - Set `strategy = "by-pr-only"` → same PR grouping; direct-to-main commits stay solo; plumbing commits get their own bullets (no omission). LLM not called.
   - Set `omit_plumbing = false` under `auto` → grouping still happens; omission disabled; plumbing commits get their own bullets.
   - Set `strategy = "off"` → pre-change behavior reachable.
   - Set `[github] enabled = false` → PR grouping degrades to subject-only `(#N)` matching; merge-commit-only constituents stay solo (no rev-list fallback in v1).
2. On a squash-merge repo: confirm output is byte-identical with and without curation enabled (gate skips LLM when there's no residual to curate).
3. Determinism: run `auto` mode twice in a row; with `cache = true`, byte-identical output (including the audit block).
4. `cliff-notes --extract <tag>`: confirm audit block strips cleanly on a section produced with curation enabled (including the omitted section between markers).
5. CI smoke: run inside a GitHub Actions workflow with default-issued `GITHUB_TOKEN` + `GITHUB_REPOSITORY` set; confirm git-cliff enrichment activates without any explicit secrets.
