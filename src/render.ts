import type { EntryInput, RewrittenEntry } from "./schemas.ts";
import { shortSha } from "./git-remote.ts";

export interface RenderInput {
  versionHeader: string; // e.g. "v1.2.3" or "Unreleased"
  date: string | null; // formatted date or null for Unreleased
  summary: string;
  // Section ordering: the keys here drive section ordering. Use first-seen
  // ordering from `groupOrder`.
  groupOrder: string[];
  // Map of group label → entries (in the order git-cliff emitted them).
  byGroup: Map<string, RenderedEntry[]>;
  // Raw lines for the audit block (one per original commit).
  rawLines: string[];
}

export interface RenderedEntry {
  text: string;
  prNumber: number | null;
  prUrl: string | null;
  commitSha: string | null;
  commitUrl: string | null;
}

export function renderSection(input: RenderInput): string {
  const header = input.date
    ? `## [${input.versionHeader}] - ${input.date}`
    : `## [${input.versionHeader}]`;

  const lines: string[] = [header, ""];
  if (input.summary.trim()) {
    lines.push(input.summary.trim(), "");
  }

  for (const group of input.groupOrder) {
    const entries = input.byGroup.get(group);
    if (!entries || entries.length === 0) continue;
    lines.push(`### ${group}`);
    for (const e of entries) {
      lines.push(`- ${e.text}${renderLinkSuffix(e)}`);
    }
    lines.push("");
  }

  lines.push("<!-- cliff-notes:raw v1");
  for (const r of input.rawLines) {
    lines.push(r);
  }
  lines.push("-->");
  lines.push("");

  return lines.join("\n");
}

function renderLinkSuffix(e: RenderedEntry): string {
  if (e.prNumber !== null) {
    if (e.prUrl) return ` ([#${e.prNumber}](${e.prUrl}))`;
    return ` (#${e.prNumber})`;
  }
  if (e.commitSha && e.commitUrl) {
    return ` ([${shortSha(e.commitSha)}](${e.commitUrl}))`;
  }
  return "";
}

// Build a RenderInput from the validated LLM output + git-cliff context.
export function assembleRender(args: {
  versionHeader: string;
  date: string | null;
  summary: string;
  inputs: EntryInput[];
  rewritten: RewrittenEntry[];
  groupForInput: (i: number) => string;
}): RenderInput {
  const groupOrder: string[] = [];
  const byGroup = new Map<string, RenderedEntry[]>();
  const rawLines: string[] = [];

  for (let i = 0; i < args.inputs.length; i++) {
    const inp = args.inputs[i];
    const re = args.rewritten[i];
    if (!inp || !re) continue;
    const group = args.groupForInput(i);
    if (!byGroup.has(group)) {
      groupOrder.push(group);
      byGroup.set(group, []);
    }
    byGroup.get(group)!.push({
      text: re.rewritten,
      prNumber: inp.pr_number,
      prUrl: inp.url,
      commitSha: inp.commit_sha,
      commitUrl: inp.commit_url,
    });
    const scopeSuffix = inp.scope ? `(${inp.scope})` : "";
    const prSuffix = inp.pr_number !== null ? ` (PR #${inp.pr_number})` : "";
    rawLines.push(`- ${inp.type}${scopeSuffix}: ${inp.raw_subject}${prSuffix}`);
  }

  return {
    versionHeader: args.versionHeader,
    date: args.date,
    summary: args.summary,
    groupOrder,
    byGroup,
    rawLines,
  };
}

export function formatDate(d: Date, format: string): string {
  // Minimal strftime-ish support: %Y, %m, %d.
  const pad = (n: number) => n.toString().padStart(2, "0");
  return format
    .replace("%Y", d.getUTCFullYear().toString())
    .replace("%m", pad(d.getUTCMonth() + 1))
    .replace("%d", pad(d.getUTCDate()));
}
