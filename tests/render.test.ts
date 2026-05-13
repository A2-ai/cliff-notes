import { describe, test, expect } from "bun:test";
import { renderSection, assembleRender, formatDate } from "../src/render.ts";
import type { EntryInput } from "../src/schemas.ts";

describe("renderSection", () => {
  test("renders header, summary, grouped entries, and audit block", () => {
    const out = renderSection({
      versionHeader: "v1.2.3",
      date: "2026-05-13",
      summary: "Adds foo and fixes bar.",
      groupOrder: ["Features", "Bug Fixes"],
      byGroup: new Map([
        [
          "Features",
          [
            {
              text: "Added foo endpoint",
              prNumber: 123,
              prUrl: "https://gh/pr/123",
              commitSha: null,
              commitUrl: null,
            },
          ],
        ],
        [
          "Bug Fixes",
          [
            {
              text: "Fixed bar crash",
              prNumber: 124,
              prUrl: null,
              commitSha: null,
              commitUrl: null,
            },
          ],
        ],
      ]),
      rawLines: [
        "- feat(api): add foo endpoint (PR #123)",
        "- fix(core): bar crash on startup (PR #124)",
      ],
    });
    expect(out).toMatchSnapshot();
  });

  test("Unreleased header omits the date", () => {
    const out = renderSection({
      versionHeader: "Unreleased",
      date: null,
      summary: "stuff",
      groupOrder: ["Features"],
      byGroup: new Map([
        ["Features", [{ text: "x", prNumber: 1, prUrl: null, commitSha: null, commitUrl: null }]],
      ]),
      rawLines: ["- feat: x (PR #1)"],
    });
    expect(out.startsWith("## [Unreleased]\n")).toBe(true);
    expect(out).not.toContain(" - 20");
  });

  test("non-PR entry with commit url renders short-SHA link", () => {
    const out = renderSection({
      versionHeader: "v0.1.0",
      date: "2026-05-13",
      summary: "s",
      groupOrder: ["Features"],
      byGroup: new Map([
        [
          "Features",
          [
            {
              text: "direct push",
              prNumber: null,
              prUrl: null,
              commitSha: "abc1234deadbeef",
              commitUrl: "https://github.com/o/r/commit/abc1234deadbeef",
            },
          ],
        ],
      ]),
      rawLines: ["- feat: direct push"],
    });
    expect(out).toContain(
      "- direct push ([abc1234](https://github.com/o/r/commit/abc1234deadbeef))",
    );
  });

  test("PR-linked entry ignores commit fallback (no redundant suffix)", () => {
    const out = renderSection({
      versionHeader: "v0.1.0",
      date: "2026-05-13",
      summary: "s",
      groupOrder: ["Features"],
      byGroup: new Map([
        [
          "Features",
          [
            {
              text: "via PR",
              prNumber: 7,
              prUrl: "https://gh/pr/7",
              commitSha: "abc1234deadbeef",
              commitUrl: "https://github.com/o/r/commit/abc1234deadbeef",
            },
          ],
        ],
      ]),
      rawLines: ["- feat: via PR (PR #7)"],
    });
    expect(out).toContain("- via PR ([#7](https://gh/pr/7))");
    expect(out).not.toContain("abc1234");
  });

  test("entry without a PR number renders no suffix", () => {
    const out = renderSection({
      versionHeader: "v0.1.0",
      date: "2026-05-13",
      summary: "initial",
      groupOrder: ["Features"],
      byGroup: new Map([
        [
          "Features",
          [
            {
              text: "first commit",
              prNumber: null,
              prUrl: null,
              commitSha: null,
              commitUrl: null,
            },
          ],
        ],
      ]),
      rawLines: ["- feat: first commit"],
    });
    expect(out).toContain("- first commit\n");
    expect(out).not.toContain("(#)");
  });
});

describe("assembleRender", () => {
  test("preserves git-cliff input order and groups by type", () => {
    const inputs: EntryInput[] = [
      {
        pr_number: 1,
        raw_subject: "add foo",
        pr_title: null,
        pr_body: null,
        type: "Features",
        scope: "api",
        author: null,
        url: "https://gh/pr/1",
        commit_sha: null,
        commit_url: null,
      },
      {
        pr_number: 2,
        raw_subject: "fix bar",
        pr_title: null,
        pr_body: null,
        type: "Bug Fixes",
        scope: null,
        author: null,
        url: null,
        commit_sha: null,
        commit_url: null,
      },
      {
        pr_number: 3,
        raw_subject: "add baz",
        pr_title: null,
        pr_body: null,
        type: "Features",
        scope: null,
        author: null,
        url: null,
        commit_sha: null,
        commit_url: null,
      },
    ];
    const render = assembleRender({
      versionHeader: "v1.0.0",
      date: "2026-05-13",
      summary: "s",
      inputs,
      rewritten: [
        { pr_number: 1, rewritten: "Added foo", highlight: false },
        { pr_number: 2, rewritten: "Fixed bar", highlight: false },
        { pr_number: 3, rewritten: "Added baz", highlight: false },
      ],
      groupForInput: (i) => inputs[i]!.type,
    });
    expect(render.groupOrder).toEqual(["Features", "Bug Fixes"]);
    expect(render.byGroup.get("Features")?.map((e) => e.text)).toEqual(["Added foo", "Added baz"]);
    expect(render.rawLines).toEqual([
      "- Features(api): add foo (PR #1)",
      "- Bug Fixes: fix bar (PR #2)",
      "- Features: add baz (PR #3)",
    ]);
  });
});

describe("formatDate", () => {
  test("strftime-ish substitution", () => {
    const d = new Date(Date.UTC(2026, 4, 13)); // May 13 2026
    expect(formatDate(d, "%Y-%m-%d")).toBe("2026-05-13");
    expect(formatDate(d, "%d/%m/%Y")).toBe("13/05/2026");
  });
});
