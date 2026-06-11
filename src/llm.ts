import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { CurationInput, EntryInput } from "./schemas.ts";
import {
  buildCurationSchema,
  buildRewriteSchema,
  SummaryResponseSchema,
  type CurationResponse,
  type RewriteResponse,
  type SummaryResponse,
} from "./schemas.ts";
import { buildCurationPrompt, CURATION_PROMPT_VERSION } from "./prompts/curate.ts";
import { buildSystemPrompt } from "./prompts/system.ts";
import { buildRewritePrompt } from "./prompts/rewrite.ts";
import { buildSummaryPrompt } from "./prompts/summary.ts";

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  rewriteEntries(entries: EntryInput[]): Promise<RewriteResponse>;
  summarize(entries: EntryInput[], rewritten: RewriteResponse["entries"]): Promise<SummaryResponse>;
  curate(
    residual: CurationInput[],
    opts: {
      maxPerGroup: number;
      maxIndexGap: number;
      requireSameType: boolean;
      allowOmissions: boolean;
    },
  ): Promise<CurationResponse>;
}

export interface LLMOptions {
  providerOverride?: string;
  modelOverride?: string;
  verbose?: boolean;
  projectRoot?: string;
}

export async function makeLLMClient(cfg: Config, opts: LLMOptions = {}): Promise<LLMClient> {
  const providerName = opts.providerOverride ?? cfg.provider.name;
  const modelName = opts.modelOverride ?? cfg.provider.model;

  const { model, isAnthropic } = await loadProvider(providerName, modelName, cfg);
  const system = buildSystemPrompt(cfg);

  return {
    provider: providerName,
    model: modelName,
    async rewriteEntries(entries) {
      const schema = buildRewriteSchema(entries);
      const result = await generateObject({
        model,
        schema,
        messages: buildMessages(system, buildRewritePrompt(entries), isAnthropic),
      });
      if (opts.verbose) {
        process.stderr.write(`cliff-notes: rewrite tokens=${JSON.stringify(result.usage)}\n`);
      }
      return result.object;
    },
    async summarize(entries, rewritten) {
      const result = await generateObject({
        model,
        schema: SummaryResponseSchema,
        messages: buildMessages(system, buildSummaryPrompt(entries, rewritten, cfg), isAnthropic),
      });
      if (opts.verbose) {
        process.stderr.write(`cliff-notes: summary tokens=${JSON.stringify(result.usage)}\n`);
      }
      return result.object;
    },
    async curate(residual, curateOpts) {
      const audience = cfg.project.audience.trim() || "end-users of the application";
      const cacheKey = curationCacheKey(residual, curateOpts, audience);
      if (cfg.curation.cache && opts.projectRoot) {
        const cached = await readCurationCache(opts.projectRoot, cacheKey);
        if (cached) return cached;
      }

      const schema = buildCurationSchema(residual, curateOpts);
      const result = await generateObject({
        model,
        schema,
        temperature: 0,
        messages: buildMessages(
          system,
          buildCurationPrompt(residual, {
            allowOmissions: curateOpts.allowOmissions,
            audience,
          }),
          isAnthropic,
        ),
      });
      if (opts.verbose) {
        process.stderr.write(`cliff-notes: curation tokens=${JSON.stringify(result.usage)}\n`);
      }
      if (cfg.curation.cache && opts.projectRoot) {
        await writeCurationCache(opts.projectRoot, cacheKey, result.object);
      }
      return result.object;
    },
  };
}

function curationCacheKey(
  residual: CurationInput[],
  opts: {
    maxPerGroup: number;
    maxIndexGap: number;
    requireSameType: boolean;
    allowOmissions: boolean;
  },
  audience: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ residual, opts, audience, prompt: CURATION_PROMPT_VERSION }))
    .digest("hex")
    .slice(0, 32);
}

async function readCurationCache(
  projectRoot: string,
  key: string,
): Promise<CurationResponse | null> {
  try {
    const raw = await readFile(
      join(projectRoot, ".cliff-notes", "cache", `curate-${key}.json`),
      "utf-8",
    );
    return JSON.parse(raw) as CurationResponse;
  } catch {
    return null;
  }
}

async function writeCurationCache(
  projectRoot: string,
  key: string,
  response: CurationResponse,
): Promise<void> {
  try {
    const dir = join(projectRoot, ".cliff-notes", "cache");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `curate-${key}.json`), JSON.stringify(response, null, 2));
  } catch {
    // Cache failures should not affect changelog generation.
  }
}

function buildMessages(
  system: string,
  user: string,
  isAnthropic: boolean,
): Parameters<typeof generateObject>[0]["messages"] {
  const systemMsg: Record<string, unknown> = {
    role: "system",
    content: system,
  };
  if (isAnthropic) {
    systemMsg.providerOptions = {
      anthropic: { cacheControl: { type: "ephemeral" } },
    };
  }
  return [systemMsg, { role: "user", content: user }] as Parameters<
    typeof generateObject
  >[0]["messages"];
}

async function loadProvider(
  name: string,
  modelName: string,
  cfg: Config,
): Promise<{ model: LanguageModel; isAnthropic: boolean }> {
  if (name === "anthropic") {
    const envVar = cfg.provider.api_key_env ?? "ANTHROPIC_API_KEY";
    requireEnv(envVar);
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const anthropic = createAnthropic({ apiKey: process.env[envVar] });
    return { model: anthropic(modelName), isAnthropic: true };
  }
  if (name === "openai") {
    const envVar = cfg.provider.api_key_env ?? "OPENAI_API_KEY";
    requireEnv(envVar);
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ apiKey: process.env[envVar] });
    return { model: openai(modelName), isAnthropic: false };
  }
  if (name === "bedrock") {
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
    const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
    if (cfg.provider.aws_profile) {
      process.env.AWS_PROFILE = cfg.provider.aws_profile;
    }
    const credentialProvider = fromNodeProviderChain(
      cfg.provider.aws_profile ? { profile: cfg.provider.aws_profile } : {},
    );
    const bedrock = createAmazonBedrock({
      region: process.env.AWS_REGION ?? "us-east-1",
      credentialProvider: async () => {
        const c = await credentialProvider();
        return {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        };
      },
    });
    return { model: bedrock(modelName), isAnthropic: true };
  }
  throw new Error(`unknown provider: ${name}`);
}

function requireEnv(name: string): void {
  if (!process.env[name]) {
    throw new Error(`environment variable ${name} is not set`);
  }
}
