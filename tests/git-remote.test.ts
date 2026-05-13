import { describe, test, expect } from "bun:test";
import { parseGitHubRemote, buildCommitUrl, shortSha } from "../src/git-remote.ts";

describe("parseGitHubRemote", () => {
  test("parses https with .git", () => {
    expect(parseGitHubRemote("https://github.com/a2-ai/cliff-notes.git")).toEqual({
      owner: "a2-ai",
      repo: "cliff-notes",
    });
  });

  test("parses https without .git", () => {
    expect(parseGitHubRemote("https://github.com/a2-ai/cliff-notes")).toEqual({
      owner: "a2-ai",
      repo: "cliff-notes",
    });
  });

  test("parses SCP-style SSH", () => {
    expect(parseGitHubRemote("git@github.com:a2-ai/cliff-notes.git")).toEqual({
      owner: "a2-ai",
      repo: "cliff-notes",
    });
  });

  test("parses ssh:// URL", () => {
    expect(parseGitHubRemote("ssh://git@github.com/a2-ai/cliff-notes.git")).toEqual({
      owner: "a2-ai",
      repo: "cliff-notes",
    });
  });

  test("rejects non-github hosts", () => {
    expect(parseGitHubRemote("https://gitlab.com/a/b.git")).toBeNull();
    expect(parseGitHubRemote("git@bitbucket.org:a/b.git")).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(parseGitHubRemote("")).toBeNull();
    expect(parseGitHubRemote("not a url")).toBeNull();
    expect(parseGitHubRemote("https://github.com/only-owner")).toBeNull();
  });
});

describe("buildCommitUrl", () => {
  test("constructs canonical commit URL", () => {
    expect(buildCommitUrl({ owner: "a2-ai", repo: "cliff-notes" }, "abc1234")).toBe(
      "https://github.com/a2-ai/cliff-notes/commit/abc1234",
    );
  });
});

describe("shortSha", () => {
  test("truncates to 7 chars", () => {
    expect(shortSha("abc1234deadbeef")).toBe("abc1234");
  });

  test("returns shorter SHAs unchanged", () => {
    expect(shortSha("abc")).toBe("abc");
  });
});
