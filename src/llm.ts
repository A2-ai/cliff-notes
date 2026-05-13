import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import type { Config } from "./config.ts";
import type { EntryInput } from "./schemas.ts";
import {
  buildRewriteSchema,
  SummaryResponseSchema,
  type RewriteResponse,
  type SummaryResponse,
} from "./schemas.ts";
import { buildSystemPrompt } from "./prompts/system.ts";
import { buildRewritePrompt } from "./prompts/rewrite.ts";
import { buildSummaryPrompt } from "./prompts/summary.ts";

export interface LLMClient {
  rewriteEntries(entries: EntryInput[]): Promise<RewriteResponse>;
  summarize(
    entries: EntryInput[],
    rewritten: RewriteResponse["entries"]
  ): Promise<SummaryResponse>;
}

export interface LLMOptions {
  providerOverride?: string;
  modelOverride?: string;
  verbose?: boolean;
}

export async function makeLLMClient(
  cfg: Config,
  opts: LLMOptions = {}
): Promise<LLMClient> {
  const providerName = opts.providerOverride ?? cfg.provider.name;
  const modelName = opts.modelOverride ?? cfg.provider.model;

  const { model, isAnthropic } = await loadProvider(providerName, modelName, cfg);
  const system = buildSystemPrompt(cfg);

  return {
    async rewriteEntries(entries) {
      const schema = buildRewriteSchema(entries);
      const result = await generateObject({
        model,
        schema,
        messages: buildMessages(system, buildRewritePrompt(entries), isAnthropic),
      });
      if (opts.verbose) {
        process.stderr.write(
          `cliff-notes: rewrite tokens=${JSON.stringify(result.usage)}\n`
        );
      }
      return result.object;
    },
    async summarize(entries, rewritten) {
      const result = await generateObject({
        model,
        schema: SummaryResponseSchema,
        messages: buildMessages(
          system,
          buildSummaryPrompt(entries, rewritten, cfg),
          isAnthropic
        ),
      });
      if (opts.verbose) {
        process.stderr.write(
          `cliff-notes: summary tokens=${JSON.stringify(result.usage)}\n`
        );
      }
      return result.object;
    },
  };
}

function buildMessages(
  system: string,
  user: string,
  isAnthropic: boolean
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
  cfg: Config
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
      cfg.provider.aws_profile ? { profile: cfg.provider.aws_profile } : {}
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
