# Add user-friendly stage prints to the generation pipeline

## Context

Today, `cliff-notes` runs through several non-trivial stages (config load → `git-cliff` → PR enrichment → LLM rewrite → LLM summary → render → write) with almost no user-visible output until it finishes. The only progress messages live behind `--verbose` and are token-count / JSON-payload debug logs, not stage descriptions.

The LLM steps in particular can take many seconds with no feedback, so a user can't tell whether the tool is hung, rate-limited, or just thinking. We want short, friendly, always-on status lines that describe _what stage is happening right now_, leaving `--verbose` for the existing detailed diagnostics.

## Stages to announce

From `src/pipeline.ts` and `src/extract.ts`, the user-meaningful stages are:

**Generation pipeline (`runPipeline`):**

1. Running `git-cliff` (collect commits)
2. Enriching PRs via `gh` (skip if 0 PRs)
3. Rewriting entries with the LLM (include provider/model)
4. Generating the release summary with the LLM
5. Writing output (CHANGELOG.md / `--out` file / stdout for `--dry-run`)

**Extract pipeline (`runExtract`):**

1. Reading existing CHANGELOG.md
2. Extracting section for tag
3. Writing output

Config load and markdown render are fast and synchronous — not worth a print.

## Format (chosen)

Stage prints go to **stderr** (keeps `--dry-run` markdown on stdout clean), with a 2-column layout: an arrow + a short stage label + the human description. Final success uses `✓`. Example for `cliff-notes --unreleased` against a release with 12 commits / 12 PRs using anthropic/claude-3-5-sonnet:

```
→ git-cliff   collecting commits
→ github      enriching 12 PRs
→ model       rewriting 12 entries · anthropic/claude-3-5-sonnet
→ model       generating summary
✓ wrote CHANGELOG.md
```

- `→` and the stage label render in **dim gray**, the description in default color.
- `✓` renders in **green**.
- Color is suppressed if `NO_COLOR` env var is set OR `process.stderr.isTTY` is false.
- Stage-label column is padded to a fixed width (10 chars) for alignment.

Implemented with **`picocolors`** (~3KB, zero deps).

## Behaviour

- **On by default** when stderr is a TTY.
- **Suppress** when `--quiet` (new flag) is passed, or when `process.stderr.isTTY` is false (CI, piping). Non-TTY behaviour can be debated — see open question below.
- `--verbose` keeps printing the existing token-count / per-PR-error lines _in addition_ to the stage prints.
- The existing terminal messages (`cliff-notes: wrote X`, `cliff-notes: aborted`, the preview block, the confirmation prompt) stay as-is; the new prints sit _before_ them.

## Implementation

### 1. New module: `src/progress.ts`

A tiny helper so call sites stay one-liners and so format/color is centralised.

```ts
export interface Progress {
  step(msg: string): void; // "running git-cliff…"
  done(msg: string): void; // "wrote CHANGELOG.md"
  // future: start(label) returning a handle whose .end() prints elapsed
}

export function makeProgress(opts: { quiet: boolean; isTTY: boolean }): Progress;
```

The module owns ANSI/color detection (if Option C is chosen) and the `cliff-notes:` / `→` prefix. No-op implementation when `quiet || !isTTY`.

### 2. Wire it through

- `src/cli.ts` — add `--quiet` option (line ~28), pass `quiet` into `PipelineOptions` / `ExtractOptions`. Build the `Progress` instance once and pass it down.
- `src/pipeline.ts` — accept `progress: Progress` in `PipelineOptions`, then call:
  - `progress.step("running git-cliff…")` before line 47
  - `progress.step("enriching N PRs from GitHub…")` before line 88 (skip if `prNumbers.length === 0`)
  - `progress.step("rewriting N entries with <provider>/<model>…")` before line 121 (replaces the verbose-only message at lines 109–113 with an always-on version; verbose can stay for the PR-enriched count)
  - `progress.step("generating release summary…")` before line 122
  - The existing `wrote …` messages at lines 141 and 171 become `progress.done(...)` calls
- `src/llm.ts` — to print the model name in the rewrite step we need to know it at call time. Cheapest path: extend `LLMClient` with a `describe(): string` (or just `model: string`) returned from `makeLLMClient`, so `pipeline.ts` can format `anthropic/claude-3-5-sonnet` for the print. Avoids leaking provider plumbing.
- `src/extract.ts` — three `progress.step` calls mirroring the stages above.

### 3. Critical files

- `src/cli.ts` — add `--quiet`, construct `Progress`
- `src/pipeline.ts` — insert 4 `progress.step` calls, swap final two writes for `progress.done`
- `src/llm.ts` — expose provider/model on the returned client
- `src/extract.ts` — insert 2–3 `progress.step` calls
- `src/progress.ts` — **new file**

### 4. Dependency

- `bun add picocolors` — tiny (~3KB, zero deps) color helper used inside `progress.ts`. `NO_COLOR` and non-TTY checks live in `progress.ts` so call sites stay clean.

## Verification

1. **Default run, TTY:** `bun run src/cli.ts --unreleased` against a repo with commits. Expect the chosen format on stderr, CHANGELOG.md written.
2. **Piped run:** `bun run src/cli.ts --unreleased 2> log.txt`. With Option C, `log.txt` should contain plain text (no ANSI codes). With Option D, no `\r` redraws.
3. **Quiet flag:** `bun run src/cli.ts --unreleased --quiet`. Stderr should be empty except for the existing `wrote X` / errors / confirmation prompt.
4. **Verbose still works:** `bun run src/cli.ts --unreleased --verbose`. Stage lines _and_ token-count lines both appear.
5. **Dry-run stdout clean:** `bun run src/cli.ts --unreleased --dry-run > out.md`. `out.md` must contain only markdown — no progress text.
6. **Extract mode:** `bun run src/cli.ts --extract v1.0.0 --out section.md`. Three stage lines plus the existing wrote-message.
7. **Zero-PR release:** Hand-craft a release with no PR references; the "enriching N PRs" step should be skipped, not print "enriching 0 PRs".

## Defaults applied

- **TTY-only.** Stage prints appear only when `process.stderr.isTTY` is true. CI / piped runs see no progress chatter (and no ANSI), only the existing `wrote X` / errors / confirmation prompt. Easy to revisit if you want CI progress later.
- **Flag name: `--quiet`.** More conventional than `--no-progress`. It only silences the new stage prints; `wrote X`, errors, the preview block, and the confirmation prompt still print.
