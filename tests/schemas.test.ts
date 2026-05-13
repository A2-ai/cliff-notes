import { describe, test, expect } from "bun:test";
import { buildRewriteSchema, type EntryInput } from "../src/schemas.ts";

function input(pr: number | null): EntryInput {
  return {
    pr_number: pr,
    raw_subject: "x",
    pr_title: null,
    pr_body: null,
    type: "Features",
    scope: null,
    author: null,
    url: null,
    commit_sha: null,
    commit_url: null,
  };
}

describe("buildRewriteSchema", () => {
  test("accepts a well-formed response", () => {
    const schema = buildRewriteSchema([input(1), input(2)]);
    const result = schema.safeParse({
      entries: [
        { pr_number: 1, rewritten: "a", highlight: false },
        { pr_number: 2, rewritten: "b", highlight: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("rejects wrong array length", () => {
    const schema = buildRewriteSchema([input(1), input(2)]);
    const result = schema.safeParse({
      entries: [{ pr_number: 1, rewritten: "a", highlight: false }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("expected 2 entries");
    }
  });

  test("rejects mismatched pr_number", () => {
    const schema = buildRewriteSchema([input(1), input(2)]);
    const result = schema.safeParse({
      entries: [
        { pr_number: 1, rewritten: "a", highlight: false },
        { pr_number: 999, rewritten: "b", highlight: false }, // wrong
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join("\n");
      expect(msg).toContain("pr_number must be 2");
    }
  });

  test("preserves null pr_number requirement", () => {
    const schema = buildRewriteSchema([input(null)]);
    const ok = schema.safeParse({
      entries: [{ pr_number: null, rewritten: "a", highlight: false }],
    });
    expect(ok.success).toBe(true);
    const bad = schema.safeParse({
      entries: [{ pr_number: 1, rewritten: "a", highlight: false }],
    });
    expect(bad.success).toBe(false);
  });
});
