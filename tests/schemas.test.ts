import { describe, test, expect } from "bun:test";
import { asSchema } from "ai";
import {
  buildCurationSchema,
  buildRewriteSchema,
  type CurationInput,
  type EntryInput,
} from "../src/schemas.ts";

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
    members: [
      {
        sha: "abc1234",
        subject: "x",
        body: "",
        type: "Features",
        scope: null,
        files: [],
        additions: 0,
        deletions: 0,
      },
    ],
    curated_by: "solo",
  };
}

function curationInput(index: number, type = "Features"): CurationInput {
  return {
    index,
    sha: `sha${index}`,
    subject: `subject ${index}`,
    body: "",
    type,
    scope: null,
    files: [],
    additions: 0,
    deletions: 0,
    author: null,
    pr_number: null,
    pr_url: null,
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

describe("buildCurationSchema", () => {
  const residual = [curationInput(0), curationInput(1), curationInput(2)];
  const opts = {
    maxPerGroup: 3,
    maxIndexGap: 2,
    requireSameType: true,
    allowOmissions: true,
  };

  test("accepts solo-only partition", () => {
    const schema = buildCurationSchema(residual, opts);
    const result = schema.safeParse({
      groups: [
        { member_indices: [0], primary_index: 0, reason: "solo" },
        { member_indices: [1], primary_index: 1, reason: "solo" },
        { member_indices: [2], primary_index: 2, reason: "solo" },
      ],
      omitted: [],
    });
    expect(result.success).toBe(true);
  });

  test("accepts groups plus omissions covering all indices", () => {
    const schema = buildCurationSchema(residual, opts);
    const result = schema.safeParse({
      groups: [{ member_indices: [0, 1], primary_index: 0, reason: "related" }],
      omitted: [{ index: 2, reason: "lint-only cleanup" }],
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing, duplicate, and out-of-range indices", () => {
    const schema = buildCurationSchema(residual, opts);
    expect(
      schema.safeParse({
        groups: [{ member_indices: [0, 1], primary_index: 0, reason: "related" }],
        omitted: [],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        groups: [
          { member_indices: [0, 1], primary_index: 0, reason: "related" },
          { member_indices: [1, 2], primary_index: 1, reason: "related" },
        ],
        omitted: [],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        groups: [{ member_indices: [0, 1, 3], primary_index: 0, reason: "related" }],
        omitted: [],
      }).success,
    ).toBe(false);
  });

  test("rejects invalid primary, mixed types, large spans, oversized groups, and disabled omissions", () => {
    expect(
      buildCurationSchema(residual, opts).safeParse({
        groups: [{ member_indices: [0, 1], primary_index: 2, reason: "related" }],
        omitted: [{ index: 2, reason: "lint" }],
      }).success,
    ).toBe(false);

    expect(
      buildCurationSchema([curationInput(0, "Features"), curationInput(1, "Chores")], {
        ...opts,
        maxIndexGap: 1,
      }).safeParse({
        groups: [{ member_indices: [0, 1], primary_index: 0, reason: "related" }],
        omitted: [],
      }).success,
    ).toBe(false);

    expect(
      buildCurationSchema(residual, { ...opts, maxIndexGap: 1 }).safeParse({
        groups: [{ member_indices: [0, 2], primary_index: 0, reason: "related" }],
        omitted: [{ index: 1, reason: "lint" }],
      }).success,
    ).toBe(false);

    expect(
      buildCurationSchema(residual, { ...opts, maxPerGroup: 2 }).safeParse({
        groups: [{ member_indices: [0, 1, 2], primary_index: 0, reason: "related" }],
        omitted: [],
      }).success,
    ).toBe(false);

    expect(
      buildCurationSchema(residual, { ...opts, allowOmissions: false }).safeParse({
        groups: [
          { member_indices: [0, 1], primary_index: 0, reason: "related" },
          { member_indices: [2], primary_index: 2, reason: "solo" },
        ],
        omitted: [{ index: 2, reason: "lint" }],
      }).success,
    ).toBe(false);
  });
});

describe("rewrite JSON schema", () => {
  test("carries the length guidance as a field description the model can see", async () => {
    const jsonSchema = (await asSchema(buildRewriteSchema([input(1)])).jsonSchema) as {
      properties: { entries: { items: { properties: { rewritten: Record<string, unknown> } } } };
    };
    const rewritten = jsonSchema.properties.entries.items.properties.rewritten;
    expect(rewritten.maxLength).toBe(400);
    expect(String(rewritten.description)).toContain("at most 400 characters");
    expect(String(rewritten.description)).toContain("two or three specific changes");
  });
});
