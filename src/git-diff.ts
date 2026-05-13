import { execCapture } from "./exec.ts";

export interface CommitDiffStat {
  sha: string;
  files: string[];
  additions: number;
  deletions: number;
}

export async function getDiffStats(
  shas: string[],
  cwd: string,
): Promise<Map<string, CommitDiffStat>> {
  const unique = [...new Set(shas.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const out = new Map<string, CommitDiffStat>();
  const { stdout, code } = await execCapture(
    "git",
    [
      "show",
      "--no-renames",
      "--name-only",
      "--shortstat",
      "--format=__CLiff_NOTES_COMMIT__%H",
      ...unique,
    ],
    cwd,
  );
  if (code !== 0) return out;

  for (const rawChunk of stdout.split("__CLiff_NOTES_COMMIT__")) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const lines = chunk
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const sha = lines.shift();
    if (!sha) continue;

    const files: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      const add = line.match(/(\d+) insertion/);
      const del = line.match(/(\d+) deletion/);
      if (add?.[1] || del?.[1]) {
        additions = add?.[1] ? parseInt(add[1], 10) : 0;
        deletions = del?.[1] ? parseInt(del[1], 10) : 0;
        continue;
      }
      files.push(line);
    }
    out.set(sha, { sha, files, additions, deletions });
  }

  return out;
}
