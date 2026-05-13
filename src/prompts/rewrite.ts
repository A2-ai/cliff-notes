import type { EntryInput } from "../schemas.ts";

export function buildRewritePrompt(entries: EntryInput[]): string {
  const payload = entries.map((e, i) => ({
    index: i,
    pr_number: e.pr_number,
    type: e.type,
    scope: e.scope,
    raw_subject: e.raw_subject,
    pr_title: e.pr_title,
    pr_body: truncate(e.pr_body, 1500),
    author: e.author,
  }));
  return [
    "Rewrite the following changelog entries. Return an object with an `entries` array of the same length, in the same order.",
    "Each output entry must echo back pr_number verbatim.",
    "Set `highlight: true` for the 1–3 entries most worth surfacing in the release summary (user-visible features, breaking changes, important fixes). All others: `highlight: false`.",
    "",
    "Entries (JSON):",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}
