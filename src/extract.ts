import { readFile, writeFile } from "node:fs/promises";
import { loadConfig, resolveChangelogPath } from "./config.ts";

export interface ExtractOptions {
  tag: string;
  configPath?: string;
  out?: string;
  verbose?: boolean;
}

export async function runExtract(opts: ExtractOptions): Promise<void> {
  if (!opts.out) {
    throw new Error("--extract requires --out <file>");
  }
  const loaded = await loadConfig(opts.configPath);
  const changelogPath = resolveChangelogPath(loaded);
  let contents: string;
  try {
    contents = await readFile(changelogPath, "utf-8");
  } catch {
    throw new Error(`changelog not found at ${changelogPath}`);
  }

  const section = extractSection(contents, opts.tag);
  if (!section) {
    throw new Error(
      `tag "${opts.tag}" not found in ${changelogPath}. ` +
        `expected a heading like \`## [${opts.tag}]\`.`
    );
  }
  await writeFile(opts.out, section);
  if (opts.verbose) {
    process.stderr.write(`cliff-notes: wrote ${section.length} bytes to ${opts.out}\n`);
  }
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
