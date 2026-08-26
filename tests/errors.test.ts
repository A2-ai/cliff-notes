import { describe, test, expect } from "bun:test";
import { formatError } from "../src/errors.ts";
import { buildRewriteSchema, type EntryInput } from "../src/schemas.ts";

function input(pr: number | null): EntryInput {
  return {
    pr_number: pr,
    raw_subject: "x",
    pr_title: null,
    pr_body: null,
    type: "feat",
    scope: null,
    author: null,
    url: null,
    commit_sha: null,
    commit_url: null,
    members: [],
    curated_by: "solo",
  };
}

function schemaFailure(value: unknown, text: string): Error {
  const zodError = buildRewriteSchema([input(7), input(null)]).safeParse(value).error!;
  const typeError = new Error("Type validation failed", { cause: zodError });
  const top = new Error("No object generated: response did not match schema.", {
    cause: typeError,
  }) as Error & { text: string };
  top.text = text;
  return top;
}

describe("formatError", () => {
  test("plain errors keep their message", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
    expect(formatError("string error")).toBe("string error");
  });

  test("surfaces zod issues buried in the cause chain", () => {
    const err = schemaFailure(
      {
        entries: [
          { pr_number: 7, rewritten: "a".repeat(401) },
          { pr_number: 9, rewritten: "ok" },
        ],
      },
      "{...}",
    );
    const out = formatError(err);
    expect(out).toContain("No object generated: response did not match schema.");
    expect(out).toContain("entries.0.rewritten: String must contain at most 400 character(s)");
    expect(out).toContain("entries.1.pr_number: entry 1: pr_number must be null, got 9");
    expect(out).not.toContain("raw model response");
  });

  test("formats refinement issues on nested paths", () => {
    const err = schemaFailure({ entries: [] }, "{}");
    expect(formatError(err)).toContain("  - entries: expected 2 entries, got 0");
  });

  test("includes the raw model text only when verbose", () => {
    const err = schemaFailure({ entries: [] }, '{"entries":[]}');
    const out = formatError(err, { verbose: true });
    expect(out).toContain('raw model response:\n{"entries":[]}');
  });

  test("stops walking a cyclic cause chain", () => {
    const err = new Error("loop");
    (err as { cause?: unknown }).cause = err;
    expect(formatError(err)).toBe("loop");
  });
});
