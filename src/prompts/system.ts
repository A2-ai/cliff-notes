import type { Config } from "../config.ts";

export function buildSystemPrompt(cfg: Config): string {
  const extra = cfg.prompt.system_extra?.trim();
  const audience = cfg.project.audience.trim();
  const voice = cfg.project.voice.trim();
  return [
    `You are writing release notes for the project "${cfg.project.name}".`,
    `Audience: ${audience}.`,
    `Voice: ${voice}.`,
    "",
    "Rules:",
    "- Rewrite each entry as a single line in past-tense, imperative-free prose.",
    "- Preserve the technical meaning. Do not invent details, files, APIs, or numbers.",
    "- Do not include PR numbers, commit hashes, or markdown links in the rewritten text — those are added deterministically.",
    "- Do not editorialize, do not add emojis (unless voice says otherwise), do not write marketing copy.",
    "- Each rewritten entry must be one sentence of at most 400 characters (about 50 words).",
    '- State the purpose of the change and name at most two or three specific changes. Do not enumerate every item from a PR body or bullet list; fold the rest into a short phrase such as "and other editor improvements".',
    "- pr_number in each output entry MUST equal the corresponding input pr_number — copy it verbatim.",
    "- Output the entries in the SAME ORDER as the input.",
    "- When member_commits is present, the entry represents a multi-commit change. Write one sentence that captures the net change. Use pr_title/pr_body as primary signal and member_commits for supporting context. Do not enumerate individual commits.",
    extra ? `\nProject-specific guidance:\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
