import { spawn } from "node:child_process";

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  url: string;
  author: string | null;
  labels: string[];
}

const PR_CONCURRENCY = 5;

export async function enrichPRs(
  prNumbers: number[],
  opts: { cwd: string; verbose?: boolean } = { cwd: process.cwd() }
): Promise<Map<number, PRInfo>> {
  const out = new Map<number, PRInfo>();
  if (prNumbers.length === 0) return out;

  await ensureGhAvailable();

  const unique = [...new Set(prNumbers)];
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const idx = cursor++;
      const n = unique[idx];
      if (n === undefined) continue;
      try {
        const info = await fetchPR(n, opts.cwd);
        if (info) out.set(n, info);
      } catch (err) {
        if (opts.verbose) {
          process.stderr.write(
            `cliff-notes: PR #${n} fetch failed (${
              err instanceof Error ? err.message : String(err)
            }); skipping enrichment\n`
          );
        }
      }
    }
  }

  const workerCount = Math.min(PR_CONCURRENCY, unique.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}

async function fetchPR(n: number, cwd: string): Promise<PRInfo | null> {
  const args = [
    "pr",
    "view",
    String(n),
    "--json",
    "number,title,body,url,author,labels",
  ];
  const { stdout, stderr, code } = await execCapture("gh", args, cwd);
  if (code !== 0) {
    throw new Error(stderr.trim() || `gh exited ${code}`);
  }
  const parsed = JSON.parse(stdout) as {
    number: number;
    title: string;
    body?: string;
    url: string;
    author?: { login?: string } | null;
    labels?: Array<{ name: string }>;
  };
  return {
    number: parsed.number,
    title: parsed.title,
    body: parsed.body ?? "",
    url: parsed.url,
    author: parsed.author?.login ?? null,
    labels: (parsed.labels ?? []).map((l) => l.name),
  };
}

let ghChecked = false;
async function ensureGhAvailable(): Promise<void> {
  if (ghChecked) return;
  const { code, stderr } = await execCapture("gh", ["--version"], process.cwd());
  if (code !== 0) {
    throw new Error(
      "gh CLI not found or not authenticated. install: https://cli.github.com/ " +
        `(detail: ${stderr.trim() || "unknown"})`
    );
  }
  ghChecked = true;
}

function execCapture(
  cmd: string,
  args: string[],
  cwd: string
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
