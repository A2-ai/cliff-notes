import type { Config } from "../config.ts";
import type { EntryInput, RewrittenEntry } from "../schemas.ts";

export function buildSummaryPrompt(
  inputs: EntryInput[],
  rewritten: RewrittenEntry[],
  cfg: Config
): string {
  const items = inputs.map((inp, i) => {
    const r = rewritten[i];
    return {
      type: inp.type,
      scope: inp.scope,
      text: r?.rewritten ?? inp.raw_subject,
      highlight: r?.highlight ?? false,
    };
  });
  const style = cfg.prompt.summary_style?.trim();
  return [
    "Write a release summary in 2–4 sentences, plain prose, no bullet list, no heading.",
    "Lead with what changed for the audience, not the changelog mechanics.",
    "Do not include PR numbers or links.",
    style ? `Style guidance: ${style}` : "",
    "",
    "Entries (JSON):",
    JSON.stringify(items, null, 2),
  ]
    .filter(Boolean)
    .join("\n");
}
