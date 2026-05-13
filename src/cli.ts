#!/usr/bin/env node
import { Command } from "commander";
import { runPipeline } from "./pipeline.ts";
import { runExtract } from "./extract.ts";

const program = new Command();

program
  .name("cliff-notes")
  .description(
    "Controlled LLM changelog generator. Pairs git-cliff's deterministic " +
      "grouping with schema-validated LLM prose."
  )
  .version("0.1.0");

program
  .option("--config <path>", "path to cliff-notes.toml (default: ./cliff-notes.toml)")
  .option("--tag <version>", "force the version header (e.g. v1.2.3)")
  .option("--unreleased", "use ## [Unreleased] header; replaces any existing [Unreleased] block")
  .option("--dry-run", "print rendered markdown to stdout; never touch disk")
  .option("--out <file>", "write rendered markdown to file instead of splicing into CHANGELOG.md")
  .option(
    "--extract <tag>",
    "do not call LLM; extract an existing section from CHANGELOG.md (requires --out)"
  )
  .option("--provider <name>", "override provider from config (anthropic|openai|bedrock)")
  .option("--model <name>", "override model name from config")
  .option("--yes", "skip confirmation prompt before writing CHANGELOG.md")
  .option("--verbose", "log token counts, raw git-cliff JSON, intermediate LLM payloads")
  .action(async (opts) => {
    try {
      if (opts.extract) {
        await runExtract({
          tag: opts.extract,
          configPath: opts.config,
          out: opts.out,
          verbose: !!opts.verbose,
        });
        return;
      }
      await runPipeline({
        configPath: opts.config,
        tag: opts.tag,
        unreleased: !!opts.unreleased,
        dryRun: !!opts.dryRun,
        out: opts.out,
        providerOverride: opts.provider,
        modelOverride: opts.model,
        yes: !!opts.yes,
        verbose: !!opts.verbose,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`cliff-notes: ${msg}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
