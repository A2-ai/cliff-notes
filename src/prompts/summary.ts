import type { Config } from "../config.ts";
import type { EntryInput, RewrittenEntry } from "../schemas.ts";

export const SUMMARY_PROMPT_GUIDANCE = [
  "Write a release summary in 1–2 short sentences, plain prose, no bullet list, no heading.",
  "Lead with the user-visible outcome or operational impact, not implementation details or changelog mechanics.",
  "Use highlighted entries as the main signal. Mention low-level details only when they change user behavior, compatibility, deployment, or operations.",
  "Prefer one coherent release theme over enumerating entries.",
  "Do not include PR numbers or links.",
] as const;

export function buildSummaryPrompt(
  inputs: EntryInput[],
  rewritten: RewrittenEntry[],
  cfg: Config,
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
    ...SUMMARY_PROMPT_GUIDANCE,
    style ? `Style guidance: ${style}` : "",
    "",
    "Entries (JSON):",
    JSON.stringify(items, null, 2),
  ]
    .filter(Boolean)
    .join("\n");
}
