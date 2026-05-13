import { readFile, writeFile } from "node:fs/promises";
import { loadConfig, resolveChangelogPath } from "./config.ts";
import type { Progress } from "./progress.ts";

export interface ExtractOptions {
  tag: string;
  configPath?: string;
  out?: string;
  verbose?: boolean;
  progress: Progress;
}

export async function runExtract(opts: ExtractOptions): Promise<void> {
  if (!opts.out) {
    throw new Error("--extract requires --out <file>");
  }
  const { progress } = opts;
  const loaded = await loadConfig(opts.configPath);
  const changelogPath = resolveChangelogPath(loaded);

  progress.step("extract", `reading ${changelogPath}`);
  let contents: string;
  try {
    contents = await readFile(changelogPath, "utf-8");
  } catch {
    throw new Error(`changelog not found at ${changelogPath}`);
  }

  progress.step("extract", `slicing section for ${opts.tag}`);
  const section = extractSection(contents, opts.tag);
  if (!section) {
    throw new Error(
      `tag "${opts.tag}" not found in ${changelogPath}. ` +
        `expected a heading like \`## [${opts.tag}]\`.`,
    );
  }
  await writeFile(opts.out, section);
  progress.done(`wrote ${opts.out} (${section.length} bytes)`);
}

export function extractSection(changelog: string, tag: string): string | null {
  const re = /^## \[([^\]]+)\]/gm;
  let match: RegExpExecArray | null;
  let startIdx: number | null = null;
  let endIdx: number | null = null;
  while ((match = re.exec(changelog)) !== null) {
    if (startIdx === null) {
      if (match[1] === tag) {
        startIdx = match.index;
      }
    } else {
      endIdx = match.index;
      break;
    }
  }
  if (startIdx === null) return null;
  const slice = changelog.slice(startIdx, endIdx ?? undefined);
  // Strip the audit comment block — goreleaser shouldn't surface it.
  return stripAuditBlock(slice).trimEnd() + "\n";
}

function stripAuditBlock(s: string): string {
  return s.replace(/\n*<!-- cliff-notes:raw v\d+[\s\S]*?-->\n*/g, "\n");
}
