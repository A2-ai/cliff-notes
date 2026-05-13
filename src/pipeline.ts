import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  resolveChangelogPath,
  resolveGitCliffConfig,
  type LoadedConfig,
} from "./config.ts";
import {
  runGitCliff,
  extractPRNumber,
  extractPRUrl,
  firstLine,
  type CliffRelease,
} from "./git-cliff.ts";
import { enrichPRs } from "./github.ts";
import { getOriginGitHubSlug, buildCommitUrl } from "./git-remote.ts";
import { makeLLMClient } from "./llm.ts";
import type { EntryInput } from "./schemas.ts";
import { assembleRender, formatDate, renderSection } from "./render.ts";
import { mergeChangelog } from "./merge.ts";
import type { Progress } from "./progress.ts";

export interface PipelineOptions {
  configPath?: string;
  tag?: string;
  unreleased: boolean;
  dryRun: boolean;
  out?: string;
  providerOverride?: string;
  modelOverride?: string;
  yes: boolean;
  verbose?: boolean;
  progress: Progress;
}

export async function runPipeline(opts: PipelineOptions): Promise<void> {
  if (!opts.tag && !opts.unreleased) {
    throw new Error(
      "specify --tag <version> or --unreleased. " +
        "cliff-notes does not infer the next version number.",
    );
  }

  const { progress } = opts;
  const loaded = await loadConfig(opts.configPath);
  const cliffConfig = await chooseCliffConfig(loaded);
  const repoSlug = await getOriginGitHubSlug(loaded.projectRoot);

  progress.step("git-cliff", "collecting commits");
  const releases = await runGitCliff({
    cwd: loaded.projectRoot,
    configPath: cliffConfig,
    unreleased: opts.unreleased,
    tag: opts.tag,
  });

  if (opts.verbose) {
    process.stderr.write(`cliff-notes: git-cliff returned ${releases.length} release(s)\n`);
  }

  const target = pickTargetRelease(releases, opts);
  if (!target) {
    throw new Error("no matching release found in git-cliff output");
  }
  if (target.commits.length === 0) {
    throw new Error("target release contains no commits — nothing to render");
  }

  const versionHeader = opts.unreleased
    ? "Unreleased"
    : (opts.tag ?? target.version ?? "Unreleased");

  const date = opts.unreleased
    ? null
    : formatDate(
        target.timestamp ? new Date(target.timestamp * 1000) : new Date(),
        loaded.config.output.date_format,
      );

  // Build EntryInput[] preserving commit order from git-cliff.
  const prNumbers: number[] = [];
  const inputsRaw = target.commits.map((c) => {
    const prNumber = extractPRNumber(c);
    if (prNumber !== null) prNumbers.push(prNumber);
    return { commit: c, prNumber };
  });

  // Enrich PR data via gh — best-effort, errors per-PR don't fail the run.
  if (prNumbers.length > 0) {
    const uniqueCount = new Set(prNumbers).size;
    progress.step("github", `enriching ${uniqueCount} PR${uniqueCount === 1 ? "" : "s"}`);
  }
  const prMap = await enrichPRs(prNumbers, {
    cwd: loaded.projectRoot,
    verbose: opts.verbose,
  });

  const inputs: EntryInput[] = inputsRaw.map(({ commit, prNumber }) => {
    const pr = prNumber !== null ? (prMap.get(prNumber) ?? null) : null;
    const subject = firstLine(commit.message);
    const subjectWithoutPRSuffix = subject.replace(/\s*\(#\d+\)\s*$/, "");
    const commitSha = commit.id || null;
    const commitUrl =
      prNumber === null && commitSha && repoSlug ? buildCommitUrl(repoSlug, commitSha) : null;
    return {
      pr_number: prNumber,
      raw_subject: subjectWithoutPRSuffix,
      pr_title: pr?.title ?? null,
      pr_body: pr?.body ?? null,
      type: commit.group ?? "Other",
      scope: commit.scope ?? null,
      author: pr?.author ?? commit.author?.name ?? null,
      url: pr?.url ?? extractPRUrl(commit),
      commit_sha: commitSha,
      commit_url: commitUrl,
    };
  });

  if (opts.verbose) {
    process.stderr.write(
      `cliff-notes: rewriting ${inputs.length} entries (${prMap.size} PRs enriched)\n`,
    );
  }

  const llm = await makeLLMClient(loaded.config, {
    providerOverride: opts.providerOverride,
    modelOverride: opts.modelOverride,
    verbose: opts.verbose,
  });

  progress.step("model", `rewriting ${inputs.length} entries · ${llm.provider}/${llm.model}`);
  const rewriteResp = await llm.rewriteEntries(inputs);
  progress.step("model", "generating summary");
  const summaryResp = await llm.summarize(inputs, rewriteResp.entries);

  const renderInput = assembleRender({
    versionHeader,
    date,
    summary: summaryResp.summary,
    inputs,
    rewritten: rewriteResp.entries,
    groupForInput: (i) => inputs[i]?.type ?? "Other",
  });
  const section = renderSection(renderInput);

  if (opts.dryRun) {
    process.stdout.write(section);
    return;
  }

  if (opts.out) {
    await writeFile(opts.out, section);
    progress.done(`wrote ${opts.out}`);
    return;
  }

  // Default: splice into CHANGELOG.md.
  const changelogPath = resolveChangelogPath(loaded);
  const existing = await readMaybe(changelogPath);
  const merged = mergeChangelog({
    existing,
    newSection: section,
    unreleased: opts.unreleased,
  });

  process.stderr.write(`cliff-notes: preview (first lines):\n`);
  process.stderr.write(
    section
      .split("\n")
      .slice(0, 10)
      .map((l) => "  " + l)
      .join("\n") + "\n",
  );

  if (!opts.yes) {
    const ok = await confirmPrompt(`write to ${changelogPath}? [y/N] `);
    if (!ok) {
      process.stderr.write("cliff-notes: aborted\n");
      return;
    }
  }
  await writeFile(changelogPath, merged);
  progress.done(`wrote ${changelogPath}`);
}

function pickTargetRelease(releases: CliffRelease[], opts: PipelineOptions): CliffRelease | null {
  if (releases.length === 0) return null;
  if (opts.unreleased) {
    // git-cliff --unreleased typically yields one release with version=null
    // (or the user-supplied --tag value if both are given).
    return releases.find((r) => !r.version || r.version === opts.tag) ?? releases[0]!;
  }
  if (opts.tag) {
    return releases.find((r) => r.version === opts.tag) ?? releases[0]!;
  }
  return releases[0]!;
}

async function chooseCliffConfig(loaded: LoadedConfig): Promise<string | undefined> {
  // 1. Explicit override in cliff-notes.toml
  const explicit = resolveGitCliffConfig(loaded);
  if (explicit && (await exists(explicit))) {
    return explicit;
  }
  if (explicit) {
    throw new Error(`git_cliff.config points to a missing file: ${explicit}`);
  }
  // 2. A cliff.toml at the project root
  const projectRootCliff = resolve(loaded.projectRoot, "cliff.toml");
  if (await exists(projectRootCliff)) {
    return projectRootCliff;
  }
  // 3. Fall back to the cliff.toml bundled with cliff-notes
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../cliff.toml"), resolve(here, "../../cliff.toml")];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return undefined; // let git-cliff use its own defaults
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf-8");
  } catch {
    return null;
  }
}

async function confirmPrompt(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const answer = data.toString().trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    });
  });
}
