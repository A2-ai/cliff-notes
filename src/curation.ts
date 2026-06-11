import { extractPRNumber, extractPRUrl, firstLine, type CliffCommit } from "./git-cliff.ts";
import type { CommitDiffStat } from "./git-diff.ts";
import type { LLMClient } from "./llm.ts";
import {
  buildCurationSchema,
  type CurationInput,
  type CurationResponse,
  type EntryMember,
} from "./schemas.ts";

export interface CuratedMember extends EntryMember {
  author: string | null;
  prNumber: number | null;
  prUrl: string | null;
  releaseIndex: number;
}

export interface CommitGroup {
  prNumber: number | null;
  prUrl: string | null;
  members: CuratedMember[];
  type: string;
  scope: string | null;
  author: string | null;
  curatedBy: "solo" | "pr" | "llm";
  llmReason?: string;
}

export interface OmittedCommit {
  member: CuratedMember;
  reason: string;
}

export interface CurationOptions {
  strategy: "off" | "by-pr-only" | "auto";
  omitPlumbing: boolean;
  minGroupSize: number;
  maxPerGroup: number;
  maxIndexGap: number;
  requireSameType: boolean;
  cwd: string;
  llm?: LLMClient;
  diffStats?: Map<string, CommitDiffStat>;
  verbose?: boolean;
}

export interface CurationResult {
  groups: CommitGroup[];
  omitted: OmittedCommit[];
}

export function describeCurationPlan(
  commits: CliffCommit[],
  strategy: CurationOptions["strategy"],
): string {
  if (strategy === "off") {
    const entryText = commits.length === 1 ? "an individual entry" : "individual entries";
    return `disabled; keeping ${plural(commits.length, "commit")} as ${entryText}`;
  }

  const members = commits.map((commit, index) => toMember(commit, index));
  const { groups: prefiltered, residual } = prefilterByPR(members);
  const prGroupedCommits = prefiltered.reduce((sum, group) => sum + group.members.length, 0);
  const prPart =
    prefiltered.length === 0
      ? "no multi-commit PR groups"
      : `PR grouping ${plural(prGroupedCommits, "commit")} into ${plural(
          prefiltered.length,
          "entry",
          "entries",
        )}`;

  if (strategy === "by-pr-only") {
    return `${prPart}; keeping ${plural(residual.length, "remaining commit")} solo`;
  }

  if (residual.length < 2) {
    return `${prPart}; keeping ${plural(residual.length, "remaining commit")} solo (model skipped)`;
  }

  return `${prPart}; asking model to classify ${plural(
    residual.length,
    "remaining commit",
  )} (group/solo/omit)`;
}

export async function curateCommits(
  commits: CliffCommit[],
  opts: CurationOptions,
): Promise<CurationResult> {
  const members = commits.map((commit, index) => toMember(commit, index, opts.diffStats));

  if (opts.strategy === "off") {
    return {
      groups: members.map((member) => makeGroup([member], "solo")),
      omitted: [],
    };
  }

  const { groups: prefiltered, residual } = prefilterByPR(members);
  if (opts.strategy === "by-pr-only" || residual.length < 2) {
    return {
      groups: sortGroups([...prefiltered, ...residual.map((m) => makeGroup([m], "solo"))]),
      omitted: [],
    };
  }

  if (!opts.llm) {
    warn(
      opts,
      "LLM curation requested but no LLM client was provided; keeping residual commits solo",
    );
    return {
      groups: sortGroups([...prefiltered, ...residual.map((m) => makeGroup([m], "solo"))]),
      omitted: [],
    };
  }

  let response: CurationResponse;
  const residualInput = residual.map(toCurationInput);
  const schemaOpts = {
    maxPerGroup: opts.maxPerGroup,
    maxIndexGap: opts.maxIndexGap,
    requireSameType: opts.requireSameType,
    allowOmissions: opts.omitPlumbing,
  };

  try {
    const raw = await opts.llm.curate(residualInput, schemaOpts);
    const parsed = buildCurationSchema(residualInput, schemaOpts).safeParse(raw);
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
    }
    rejectMixedPRGroups(parsed.data, residual);
    response = parsed.data;
  } catch (err) {
    warn(
      opts,
      `LLM curation failed (${err instanceof Error ? err.message : String(err)}); keeping residual commits solo`,
    );
    return {
      groups: sortGroups([...prefiltered, ...residual.map((m) => makeGroup([m], "solo"))]),
      omitted: [],
    };
  }

  const omitted: OmittedCommit[] = response.omitted.map((o) => ({
    member: residual[o.index]!,
    reason: o.reason,
  }));
  const llmGroups = response.groups.flatMap((group) => {
    const groupMembers = group.member_indices.map((i) => residual[i]!).filter(Boolean);
    if (groupMembers.length < opts.minGroupSize) {
      return groupMembers.map((member) => makeGroup([member], "solo"));
    }
    return [makeGroup(groupMembers, groupMembers.length > 1 ? "llm" : "solo", group.reason)];
  });

  return { groups: sortGroups([...prefiltered, ...llmGroups]), omitted };
}

export function formatCurationResult(result: CurationResult): string {
  const lines = ["cliff-notes: curation result"];
  for (const group of sortGroups(result.groups)) {
    if (group.members.length === 1) {
      const m = group.members[0]!;
      lines.push(`  - solo ${m.sha.slice(0, 7)} ${m.subject}`);
      continue;
    }
    const label =
      group.curatedBy === "pr"
        ? `PR #${group.prNumber}`
        : `model${group.llmReason ? `: ${group.llmReason}` : ""}`;
    lines.push(`  - group (${label}) ${group.members[0]?.subject ?? ""}`);
    for (const m of group.members) {
      lines.push(`    - ${m.sha.slice(0, 7)} ${m.subject}`);
    }
  }
  for (const o of result.omitted) {
    lines.push(`  - omitted ${o.member.sha.slice(0, 7)} ${o.member.subject}: ${o.reason}`);
  }
  return lines.join("\n") + "\n";
}

function prefilterByPR(members: CuratedMember[]): {
  groups: CommitGroup[];
  residual: CuratedMember[];
} {
  const byPR = new Map<number, CuratedMember[]>();
  for (const member of members) {
    if (member.prNumber === null) continue;
    const group = byPR.get(member.prNumber) ?? [];
    group.push(member);
    byPR.set(member.prNumber, group);
  }

  const grouped = new Set<CuratedMember>();
  const groups: CommitGroup[] = [];
  for (const prMembers of byPR.values()) {
    prMembers.forEach((member) => grouped.add(member));
    groups.push(makeGroup(prMembers, prMembers.length > 1 ? "pr" : "solo"));
  }

  return {
    groups,
    residual: members.filter((member) => !grouped.has(member)),
  };
}

function toMember(
  commit: CliffCommit,
  releaseIndex: number,
  diffStats?: Map<string, CommitDiffStat>,
): CuratedMember {
  const subject = firstLine(commit.message).replace(/\s*\(#\d+\)\s*$/, "");
  const body = commit.message.split("\n").slice(1).join("\n").trim();
  const stat = diffStats?.get(commit.id);
  const prNumber = extractPRNumber(commit);
  return {
    sha: commit.id,
    subject,
    body,
    type: commit.group ?? "Other",
    scope: commit.scope ?? null,
    files: stat?.files ?? [],
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    author: commit.author?.name ?? commit.remote?.username ?? null,
    prNumber,
    prUrl: extractPRUrl(commit),
    releaseIndex,
  };
}

function toCurationInput(member: CuratedMember): CurationInput {
  return {
    index: member.releaseIndex,
    sha: member.sha,
    subject: member.subject,
    body: member.body,
    type: member.type,
    scope: member.scope,
    files: member.files,
    additions: member.additions,
    deletions: member.deletions,
    author: member.author,
    pr_number: member.prNumber,
    pr_url: member.prUrl,
  };
}

function makeGroup(
  members: CuratedMember[],
  curatedBy: "solo" | "pr" | "llm",
  llmReason?: string,
): CommitGroup {
  return {
    prNumber: commonPRNumber(members),
    prUrl: commonPRUrl(members),
    members: sortMembers(members),
    type: resolveType(members),
    scope: resolveScope(members),
    author: mostFrequent(members.map((m) => m.author)),
    curatedBy,
    llmReason,
  };
}

function resolveType(members: CuratedMember[]): string {
  if (members.some((m) => m.type === "Reverts")) return "Reverts";
  const counts = new Map<string, number>();
  for (const member of members) {
    const type = member.type ?? "Other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  let bestType = "Other";
  let bestCount = -1;
  for (const [type, count] of counts) {
    if (count > bestCount || (count === bestCount && typeRank(type) < typeRank(bestType))) {
      bestType = type;
      bestCount = count;
    }
  }
  return bestType;
}

function typeRank(type: string): number {
  const precedence = [
    "Features",
    "Bug Fixes",
    "Performance",
    "Refactor",
    "Security",
    "Build",
    "CI",
    "Documentation",
    "Tests",
    "Chores",
    "Other",
  ];
  const idx = precedence.indexOf(type);
  return idx === -1 ? precedence.length : idx;
}

function resolveScope(members: CuratedMember[]): string | null {
  const first = members[0]?.scope ?? null;
  if (!first) return null;
  return members.every((m) => m.scope === first) ? first : null;
}

function commonPRNumber(members: CuratedMember[]): number | null {
  const numbers = [
    ...new Set(members.map((m) => m.prNumber).filter((n) => n !== null)),
  ] as number[];
  return numbers.length === 1 ? numbers[0]! : null;
}

function commonPRUrl(members: CuratedMember[]): string | null {
  const urls = [...new Set(members.map((m) => m.prUrl).filter((u) => u !== null))] as string[];
  return urls.length === 1 ? urls[0]! : null;
}

function mostFrequent(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = -1;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function sortGroups(groups: CommitGroup[]): CommitGroup[] {
  return ordered(
    groups,
    (a, b) => (a.members[0]?.releaseIndex ?? 0) - (b.members[0]?.releaseIndex ?? 0),
  );
}

function sortMembers(members: CuratedMember[]): CuratedMember[] {
  return ordered(members, (a, b) => a.releaseIndex - b.releaseIndex);
}

function ordered<T>(items: T[], compare: (a: T, b: T) => number): T[] {
  const result: T[] = [];
  for (const item of items) {
    const insertAt = result.findIndex((existing) => compare(item, existing) < 0);
    if (insertAt === -1) {
      result.push(item);
    } else {
      result.splice(insertAt, 0, item);
    }
  }
  return result;
}

function rejectMixedPRGroups(response: CurationResponse, residual: CuratedMember[]): void {
  for (const group of response.groups) {
    const prNumbers = new Set(
      group.member_indices.map((i) => residual[i]?.prNumber ?? null).filter((n) => n !== null),
    );
    if (prNumbers.size > 1) {
      throw new Error("curation grouped commits from different PRs");
    }
  }
}

function warn(opts: CurationOptions, message: string): void {
  if (opts.verbose) {
    process.stderr.write(`cliff-notes: ${message}\n`);
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
