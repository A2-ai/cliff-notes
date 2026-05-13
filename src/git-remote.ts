import { spawn } from "node:child_process";

export interface RepoSlug {
  owner: string;
  repo: string;
}

export async function getOriginGitHubSlug(cwd: string): Promise<RepoSlug | null> {
  const { stdout, code } = await execCapture("git", ["remote", "get-url", "origin"], cwd);
  if (code !== 0) return null;
  return parseGitHubRemote(stdout.trim());
}

export function parseGitHubRemote(url: string): RepoSlug | null {
  if (!url) return null;

  // git@github.com:owner/repo(.git)
  const ssh = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) {
    if (ssh[1] !== "github.com") return null;
    return { owner: ssh[2]!, repo: ssh[3]! };
  }

  // ssh://git@github.com/owner/repo(.git) or https://github.com/owner/repo(.git)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "github.com") return null;

  const parts = parsed.pathname.replace(/^\//, "").split("/");
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repoRaw = parts[1];
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  return { owner, repo };
}

export function buildCommitUrl(slug: RepoSlug, sha: string): string {
  return `https://github.com/${slug.owner}/${slug.repo}/commit/${sha}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function execCapture(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout: "", stderr: `ENOENT: ${cmd} not found`, code: 127 });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
