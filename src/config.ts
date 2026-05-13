import { readFile, access } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

const ProviderSchema = z.object({
  name: z.enum(["anthropic", "openai", "bedrock"]),
  model: z.string().min(1),
  aws_profile: z.string().optional(),
  api_key_env: z.string().optional(),
});

const ProjectSchema = z.object({
  name: z.string().min(1),
  audience: z.string().default("internal-devs"),
  voice: z.string().default("concise, technical, no marketing fluff"),
});

const PromptSchema = z
  .object({
    system_extra: z.string().optional(),
    summary_style: z.string().optional(),
  })
  .default({});

const GitCliffSchema = z
  .object({
    config: z.string().optional(),
  })
  .default({});

const OutputSchema = z
  .object({
    changelog_file: z.string().default("CHANGELOG.md"),
    date_format: z.string().default("%Y-%m-%d"),
  })
  .default({});

export const ConfigSchema = z.object({
  provider: ProviderSchema,
  project: ProjectSchema,
  prompt: PromptSchema,
  git_cliff: GitCliffSchema,
  output: OutputSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig {
  config: Config;
  configPath: string;
  projectRoot: string;
}

const DEFAULT_CONFIG_NAME = "cliff-notes.toml";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const cwd = process.cwd();
  const configPath = explicitPath
    ? resolve(cwd, explicitPath)
    : resolve(cwd, DEFAULT_CONFIG_NAME);

  if (!(await exists(configPath))) {
    throw new Error(
      `config file not found at ${configPath}.\n` +
        `create one — see cliff-notes.example.toml for the schema.`
    );
  }

  const raw = await readFile(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`failed to parse ${configPath}: ${msg}`);
  }

  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`invalid ${DEFAULT_CONFIG_NAME}:\n${issues}`);
  }

  return {
    config: result.data,
    configPath,
    projectRoot: dirname(configPath),
  };
}

export function resolveGitCliffConfig(loaded: LoadedConfig): string | undefined {
  const c = loaded.config.git_cliff.config;
  if (!c) return undefined;
  return resolve(loaded.projectRoot, c);
}

export function resolveChangelogPath(loaded: LoadedConfig): string {
  return join(loaded.projectRoot, loaded.config.output.changelog_file);
}
