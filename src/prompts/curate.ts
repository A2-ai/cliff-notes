import type { CurationInput } from "../schemas.ts";

export const CURATION_PROMPT_VERSION = "curate-v4";

export function buildCurationPrompt(
  residual: CurationInput[],
  opts: { allowOmissions: boolean; audience: string },
): string {
  const payload = residual.map((entry, index) => ({
    index,
    original_index: entry.index,
    sha: entry.sha,
    subject: entry.subject,
    body: truncate(entry.body, 1500),
    type: entry.type,
    scope: entry.scope,
    author: entry.author,
    pr_number: entry.pr_number,
    files: entry.files,
    additions: entry.additions,
    deletions: entry.deletions,
  }));

  return [
    `Audience: ${opts.audience}.`,
    "",
    "Default to one disposition per commit. Most commits should stand alone as their own changelog entry.",
    "Group commits only when they describe one logical change. Omit commits only when they clearly do not belong in release notes for this audience.",
    "",
    "Grouping criteria:",
    "- Strong evidence includes overlapping files, sequential indices with terse subjects, fixup!/squash! prefixes, and shared scope plus author in a small window.",
    "- Different conventional types should stay separate. Different non-null PR numbers must stay separate.",
    "- When in doubt, return solo groups.",
    "",
    opts.allowOmissions
      ? [
          "Omission criteria:",
          "- Use the configured audience literally. It may describe any mix of users, operators, admins, developers, maintainers, or business stakeholders.",
          "- The audience examples below are non-exhaustive guidance, not a closed list. Apply the same judgment to analogous audience descriptions.",
          "- Omit only changes that are not meaningful to the configured audience.",
          "- For external product users, operators, or sysadmins, omit developer-only changes such as test additions, test rewrites, test relocations, Playwright/Cypress/Jest setup, smoke/e2e/unit coverage expansion, internal refactors, internal renames, developer-only tooling, dependency bumps without security/compatibility/runtime/deployment impact, lint/format/whitespace fixes, comment-only edits, and CI config touches that do not change delivered behavior.",
          "- For internal developer or maintainer audiences, keep refactors, tooling, infrastructure, build, test, and CI changes when they affect developer workflow, maintainability, APIs, release reliability, or operational behavior.",
          "- For every audience, comment-only edits, pure formatting, lint-only cleanup, and dependency bumps without security, compatibility, runtime, or deployment impact are safe to omit.",
          "- Do not omit user-facing changes, bug fixes, performance changes, API changes, removed features, or added features.",
          "- When in doubt, do not omit. Every omission needs a one-line reason.",
        ].join("\n")
      : "Omissions are disabled. Return every commit in groups, using singleton groups where needed.",
    "",
    "Return JSON shaped as { groups: [{ member_indices, primary_index, reason }], omitted: [{ index, reason }] }.",
    "Every input index must appear exactly once, either in one group or in omitted.",
    "Reasons are shown to human reviewers, so keep them specific and under one sentence.",
    "",
    "Examples:",
    JSON.stringify(
      {
        groups: [
          {
            member_indices: [0, 1, 2],
            primary_index: 0,
            reason: "all touch src/user.ts and describe the initial user model rollout",
          },
          { member_indices: [3], primary_index: 3, reason: "standalone user-facing fix" },
        ],
        omitted: opts.allowOmissions
          ? [
              { index: 4, reason: "dependency type bump with no runtime behavior change" },
              { index: 5, reason: "lint-only cleanup" },
            ]
          : [],
      },
      null,
      2,
    ),
    "",
    "Commits (JSON):",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}
