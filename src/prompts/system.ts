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
    "- Each rewritten entry must be one sentence under 280 characters.",
    "- pr_number in each output entry MUST equal the corresponding input pr_number — copy it verbatim.",
    "- Output the entries in the SAME ORDER as the input.",
    extra ? `\nProject-specific guidance:\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
