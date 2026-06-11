import { describe, expect, test } from "bun:test";
import { curateCommits, describeCurationPlan } from "../src/curation.ts";
import type { CliffCommit } from "../src/git-cliff.ts";
import type { LLMClient } from "../src/llm.ts";
import type { CurationResponse } from "../src/schemas.ts";

function commit(
  id: string,
  message: string,
  opts: {
    group?: string;
    scope?: string | null;
    prNumber?: number | null;
    author?: string;
  } = {},
): CliffCommit {
  return {
    id,
    message,
    group: opts.group ?? "Features",
    scope: opts.scope ?? null,
    links:
      opts.prNumber === undefined || opts.prNumber === null
        ? []
        : [{ text: `#${opts.prNumber}`, href: `https://gh/pr/${opts.prNumber}` }],
    author: { name: opts.author ?? "dev" },
    remote:
      opts.prNumber === undefined
        ? undefined
        : {
            pr_number: opts.prNumber,
            pr_title: null,
            pr_labels: [],
            username: null,
          },
  };
}

function llm(response: CurationResponse, calls: { count: number }): LLMClient {
  return {
    provider: "test",
    model: "test",
    async rewriteEntries() {
      throw new Error("not used");
    },
    async summarize() {
      throw new Error("not used");
    },
    async curate() {
      calls.count++;
      return response;
    },
  };
}

function baseOpts(overrides: Partial<Parameters<typeof curateCommits>[1]> = {}) {
  return {
    strategy: "auto" as const,
    omitPlumbing: true,
    minGroupSize: 2,
    maxPerGroup: 5,
    maxIndexGap: 15,
    requireSameType: true,
    cwd: process.cwd(),
    ...overrides,
  };
}

describe("curateCommits", () => {
  test("describes auto curation with PR grouping and residual model classification", () => {
    const message = describeCurationPlan(
      [
        commit("aaa1111", "feat: add model", { prNumber: 42 }),
        commit("bbb2222", "feat: wire model", { prNumber: 42 }),
        commit("ccc3333", "feat: add settings"),
        commit("ddd4444", "chore: fix lint", { group: "Chores" }),
      ],
      "auto",
    );
    expect(message).toBe(
      "PR grouping 2 commits into 1 entry; asking model to classify 2 remaining commits (group/solo/omit)",
    );
  });

  test("describes skipped model curation when auto has too little residual work", () => {
    const message = describeCurationPlan(
      [
        commit("aaa1111", "feat: add model", { prNumber: 42 }),
        commit("bbb2222", "feat: wire model", { prNumber: 42 }),
      ],
      "auto",
    );
    expect(message).toBe(
      "PR grouping 2 commits into 1 entry; keeping 0 remaining commits solo (model skipped)",
    );
  });

  test("strategy off returns one solo group per commit", async () => {
    const result = await curateCommits(
      [commit("aaa1111", "feat: add a"), commit("bbb2222", "feat: add b")],
      baseOpts({ strategy: "off" }),
    );
    expect(result.omitted).toEqual([]);
    expect(result.groups.map((g) => g.curatedBy)).toEqual(["solo", "solo"]);
  });

  test("by-pr-only groups commits sharing remote PR number without LLM", async () => {
    const calls = { count: 0 };
    const result = await curateCommits(
      [
        commit("aaa1111", "feat: add model", { prNumber: 42 }),
        commit("bbb2222", "feat: wire model", { prNumber: 42 }),
        commit("ccc3333", "feat: docs", { prNumber: 42 }),
      ],
      baseOpts({ strategy: "by-pr-only", llm: llm({ groups: [], omitted: [] }, calls) }),
    );
    expect(calls.count).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.curatedBy).toBe("pr");
    expect(result.groups[0]?.prNumber).toBe(42);
    expect(result.groups[0]?.members).toHaveLength(3);
  });

  test("by-pr-only groups commits using subject PR fallback", async () => {
    const result = await curateCommits(
      [
        commit("aaa1111", "feat: add model (#42)", { prNumber: null }),
        commit("bbb2222", "feat: wire model (#42)", { prNumber: null }),
        commit("ccc3333", "feat: fix model (#42)", { prNumber: null }),
      ],
      baseOpts({ strategy: "by-pr-only" }),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.prNumber).toBe(42);
  });

  test("auto skips LLM when no residual needs curation", async () => {
    const calls = { count: 0 };
    const result = await curateCommits(
      [
        commit("aaa1111", "feat: add model", { prNumber: 42 }),
        commit("bbb2222", "feat: wire model", { prNumber: 42 }),
        commit("ccc3333", "feat: unrelated squash PR", { prNumber: 43 }),
      ],
      baseOpts({ llm: llm({ groups: [], omitted: [] }, calls) }),
    );
    expect(calls.count).toBe(0);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.curatedBy)).toEqual(["pr", "solo"]);
  });

  test("auto applies validated LLM groups and omissions", async () => {
    const calls = { count: 0 };
    const result = await curateCommits(
      [
        commit("aaa1111", "feat: add user model"),
        commit("bbb2222", "feat: wire user model"),
        commit("ccc3333", "feat: add settings"),
        commit("ddd4444", "chore: fix lint", { group: "Chores" }),
      ],
      baseOpts({
        requireSameType: false,
        diffStats: new Map([
          ["aaa1111", { sha: "aaa1111", files: ["src/user.ts"], additions: 10, deletions: 0 }],
          ["bbb2222", { sha: "bbb2222", files: ["src/user.ts"], additions: 6, deletions: 1 }],
        ]),
        llm: llm(
          {
            groups: [
              { member_indices: [0, 1], primary_index: 0, reason: "both touch src/user.ts" },
              { member_indices: [2], primary_index: 2, reason: "standalone settings feature" },
            ],
            omitted: [{ index: 3, reason: "lint-only cleanup" }],
          },
          calls,
        ),
      }),
    );
    expect(calls.count).toBe(1);
    expect(result.groups.map((g) => g.curatedBy)).toEqual(["llm", "solo"]);
    expect(result.groups[0]?.llmReason).toBe("both touch src/user.ts");
    expect(result.omitted[0]?.reason).toBe("lint-only cleanup");
  });

  test("auto falls back to solos when omissions are disabled but returned", async () => {
    const calls = { count: 0 };
    const commits = [
      commit("aaa1111", "feat: add a"),
      commit("bbb2222", "chore: lint", { group: "Chores" }),
    ];
    const result = await curateCommits(
      commits,
      baseOpts({
        omitPlumbing: false,
        requireSameType: false,
        llm: llm(
          {
            groups: [{ member_indices: [0], primary_index: 0, reason: "solo" }],
            omitted: [{ index: 1, reason: "lint" }],
          },
          calls,
        ),
      }),
    );
    expect(calls.count).toBe(1);
    expect(result.omitted).toEqual([]);
    expect(result.groups.map((g) => g.curatedBy)).toEqual(["solo", "solo"]);
  });

  test("auto falls back to solos for mixed-type LLM groups when same type is required", async () => {
    const calls = { count: 0 };
    const result = await curateCommits(
      [commit("aaa1111", "feat: add a"), commit("bbb2222", "chore: lint", { group: "Chores" })],
      baseOpts({
        llm: llm(
          {
            groups: [{ member_indices: [0, 1], primary_index: 0, reason: "related" }],
            omitted: [],
          },
          calls,
        ),
      }),
    );
    expect(calls.count).toBe(1);
    expect(result.groups.map((g) => g.curatedBy)).toEqual(["solo", "solo"]);
  });
});
