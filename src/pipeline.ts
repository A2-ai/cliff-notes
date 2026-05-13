import { readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import {
  loadConfig,
  resolveChangelogPath,
  resolveGitCliffConfig,
  type LoadedConfig,
} from "./config.ts";
import { runGitCliff, type CliffRelease } from "./git-cliff.ts";
import { enrichPRs, resolveGitHubRepo, resolveGitHubToken } from "./github.ts";
import { getOriginGitHubSlug, buildCommitUrl } from "./git-remote.ts";
import { getDiffStats } from "./git-diff.ts";
import { curateCommits, describeCurationPlan, formatCurationResult } from "./curation.ts";
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
  showCuration?: boolean;
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

  let githubToken: string | null = null;
  let githubRepo: string | null = null;
  if (loaded.config.github.enabled) {
    [githubToken, githubRepo] = await Promise.all([
      resolveGitHubToken({ cwd: loaded.projectRoot, verbose: opts.verbose }),
      resolveGitHubRepo({
        cwd: loaded.projectRoot,
        configOverride: loaded.config.github.repo,
        verbose: opts.verbose,
      }),
    ]);
  }

  progress.step("git-cliff", "collecting commits");
  const releases = await runGitCliff({
    cwd: loaded.projectRoot,
    configPath: cliffConfig,
    unreleased: opts.unreleased,
    tag: opts.tag,
    githubToken,
    githubRepo,
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

  const llm = await makeLLMClient(loaded.config, {
    providerOverride: opts.providerOverride,
    modelOverride: opts.modelOverride,
    verbose: opts.verbose,
    projectRoot: loaded.projectRoot,
  });

  progress.step("diff", `collecting stats for ${target.commits.length} commits`);
  const diffStats = await getDiffStats(
    target.commits.map((c) => c.id),
    loaded.projectRoot,
  );

  progress.step("curation", describeCurationPlan(target.commits, loaded.config.curation.strategy));
  const curation = await curateCommits(target.commits, {
    strategy: loaded.config.curation.strategy,
    omitPlumbing: loaded.config.curation.omit_plumbing,
    minGroupSize: loaded.config.curation.min_group_size,
    maxPerGroup: loaded.config.curation.max_per_group,
    maxIndexGap: loaded.config.curation.max_index_gap,
    requireSameType: loaded.config.curation.require_same_type,
    cwd: loaded.projectRoot,
    llm,
    diffStats,
    verbose: opts.verbose,
  });
  if (opts.showCuration) {
    process.stderr.write(formatCurationResult(curation));
  }

  // Enrich PR data via gh — best-effort, errors per-PR don't fail the run.
  const prNumbers = curation.groups.flatMap((g) => (g.prNumber !== null ? [g.prNumber] : []));
  if (prNumbers.length > 0) {
    const uniqueCount = new Set(prNumbers).size;
    progress.step("github", `enriching ${uniqueCount} PR${uniqueCount === 1 ? "" : "s"}`);
  }
  const prMap = await enrichPRs(prNumbers, {
    cwd: loaded.projectRoot,
    verbose: opts.verbose,
  });

  const inputs: EntryInput[] = curation.groups.map((group) => {
    const pr = group.prNumber !== null ? (prMap.get(group.prNumber) ?? null) : null;
    const subject =
      pr?.title ??
      group.members.find((m) => m.subject.length > 8)?.subject ??
      group.members[0]!.subject;
    const isSolo = group.members.length === 1;
    const commitSha = isSolo ? group.members[0]!.sha : null;
    const commitUrl =
      group.prNumber === null && commitSha && repoSlug ? buildCommitUrl(repoSlug, commitSha) : null;
    return {
      pr_number: group.prNumber,
      raw_subject: subject,
      pr_title: pr?.title ?? null,
      pr_body: pr?.body ?? null,
      type: group.type,
      scope: group.scope,
      author: pr?.author ?? group.author,
      url: pr?.url ?? group.prUrl,
      commit_sha: commitSha,
      commit_url: commitUrl,
      members: group.members,
      curated_by: group.curatedBy,
      llm_reason: group.llmReason,
    };
  });

  if (opts.verbose) {
    process.stderr.write(
      `cliff-notes: rewriting ${inputs.length} entries (${prMap.size} PRs enriched)\n`,
    );
  }

  progress.step("model", `rewriting ${inputs.length} entries · ${llm.provider}/${llm.model}`);
  const rewriteResp = await llm.rewriteEntries(inputs);
  progress.step("summary", "generating release summary");
  const summaryResp = await llm.summarize(inputs, rewriteResp.entries);
  printGeneratedSummary(summaryResp.summary);

  const renderInput = assembleRender({
    versionHeader,
    date,
    summary: summaryResp.summary,
    inputs,
    rewritten: rewriteResp.entries,
    omitted: curation.omitted,
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
    const displayPath = displayPathFor(changelogPath, loaded.projectRoot);
    const ok = await confirmPrompt(pc.dim(`write to ${displayPath}? [y/N] `));
    if (!ok) {
      process.stderr.write("cliff-notes: aborted\n");
      return;
    }
  }
  await writeFile(changelogPath, merged);
  progress.done(`wrote ${changelogPath}`);
}

function printGeneratedSummary(summary: string): void {
  process.stderr.write("cliff-notes: generated summary:\n");
  process.stderr.write(
    summary
      .trim()
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n") + "\n",
  );
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

function displayPathFor(absPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, absPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return absPath;
  return rel;
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
