import { z } from "zod";
import { execCapture } from "./exec.ts";

const CommitSchema = z
  .object({
    id: z.string(),
    message: z.string(),
    group: z.string().nullable().optional(),
    scope: z.string().nullable().optional(),
    merge_commit: z.boolean().optional(),
    links: z
      .array(
        z.object({
          text: z.string(),
          href: z.string(),
        }),
      )
      .optional()
      .default([]),
    author: z
      .object({
        name: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        timestamp: z.number().optional(),
      })
      .optional(),
    conventional: z.boolean().optional(),
    remote: z
      .object({
        pr_number: z.number().int().nullable().optional(),
        pr_title: z.string().nullable().optional(),
        pr_labels: z.array(z.string()).optional().default([]),
        username: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const ReleaseSchema = z
  .object({
    version: z.string().nullable().optional(),
    commit_id: z.string().nullable().optional(),
    timestamp: z.number().nullable().optional(),
    previous: z.unknown().optional(),
    commits: z.array(CommitSchema).default([]),
  })
  .passthrough();

const ContextSchema = z.array(ReleaseSchema);

export type CliffCommit = z.infer<typeof CommitSchema>;
export type CliffRelease = z.infer<typeof ReleaseSchema>;

export interface CliffOptions {
  cwd: string;
  configPath?: string;
  unreleased: boolean;
  tag?: string;
  githubToken?: string | null;
  githubRepo?: string | null;
}

export async function runGitCliff(opts: CliffOptions): Promise<CliffRelease[]> {
  const args = ["--context"];
  if (opts.configPath) {
    args.push("--config", opts.configPath);
  }
  if (opts.unreleased) {
    args.push("--unreleased");
  }
  if (opts.tag) {
    args.push("--tag", opts.tag);
  }
  if (opts.githubToken && opts.githubRepo) {
    args.push("--github-token", opts.githubToken, "--github-repo", opts.githubRepo);
  }

  const { stdout, stderr, code } = await execCapture("git-cliff", args, opts.cwd);
  if (code !== 0) {
    if (stderr.includes("not found") || stderr.includes("ENOENT")) {
      throw new Error(
        "git-cliff binary not found. install it: " + "https://git-cliff.org/docs/installation/",
      );
    }
    throw new Error(`git-cliff exited ${code}: ${stderr.trim()}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `failed to parse git-cliff --context JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const result = ContextSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `unexpected git-cliff --context shape: ${result.error.issues
        .map((i) => i.path.join(".") + ": " + i.message)
        .join("; ")}`,
    );
  }
  return result.data;
}

// Pluck the PR number from links (first link with text like "#123") or fallback
// to scraping the commit message footer for "(#123)".
export function extractPRNumber(commit: CliffCommit): number | null {
  if (typeof commit.remote?.pr_number === "number") return commit.remote.pr_number;
  for (const link of commit.links ?? []) {
    const m = link.text.match(/^#(\d+)$/);
    if (m && m[1]) return parseInt(m[1], 10);
  }
  const subject = commit.message.split("\n")[0] ?? "";
  const m = subject.match(/\(#(\d+)\)\s*$/);
  if (m && m[1]) return parseInt(m[1], 10);
  return null;
}

export function extractPRUrl(commit: CliffCommit): string | null {
  for (const link of commit.links ?? []) {
    if (/^#\d+$/.test(link.text)) return link.href;
  }
  return null;
}

// Strip the conventional-commit prefix and PR suffix from the subject line.
export function firstLine(message: string): string {
  return (message.split("\n")[0] ?? "").trim();
}
