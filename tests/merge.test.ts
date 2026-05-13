import { describe, test, expect } from "bun:test";
import { mergeChangelog } from "../src/merge.ts";

const SECTION_A = `## [v1.0.0] - 2026-05-13

Initial release.

### Features
- Foo bar

<!-- cliff-notes:raw v1
- feat: foo bar
-->
`;

const SECTION_B = `## [v1.1.0] - 2026-05-20

Added baz.

### Features
- Baz qux

<!-- cliff-notes:raw v1
- feat: baz qux
-->
`;

describe("mergeChangelog", () => {
  test("creates new CHANGELOG with default preamble when none exists", () => {
    const merged = mergeChangelog({
      existing: null,
      newSection: SECTION_A,
      unreleased: false,
    });
    expect(merged.startsWith("# Changelog\n")).toBe(true);
    expect(merged).toContain("## [v1.0.0]");
  });

  test("prepends a new tag section before existing releases", () => {
    const existing = `# Changelog\n\n` + SECTION_A;
    const merged = mergeChangelog({
      existing,
      newSection: SECTION_B,
      unreleased: false,
    });
    // v1.1.0 must come before v1.0.0
    const idxB = merged.indexOf("## [v1.1.0]");
    const idxA = merged.indexOf("## [v1.0.0]");
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeLessThan(idxA);
  });

  test("--unreleased inserts an Unreleased block when none exists", () => {
    const existing = `# Changelog\n\n` + SECTION_A;
    const merged = mergeChangelog({
      existing,
      newSection: `## [Unreleased]\n\nstuff\n\n`,
      unreleased: true,
    });
    expect(merged).toContain("## [Unreleased]");
    expect(merged.indexOf("## [Unreleased]")).toBeLessThan(merged.indexOf("## [v1.0.0]"));
  });

  test("--unreleased replaces existing Unreleased block, leaving releases intact", () => {
    const existing = `# Changelog\n\n` + `## [Unreleased]\n\nold unreleased text\n\n` + SECTION_A;
    const merged = mergeChangelog({
      existing,
      newSection: `## [Unreleased]\n\nnew unreleased text\n\n`,
      unreleased: true,
    });
    expect(merged).toContain("new unreleased text");
    expect(merged).not.toContain("old unreleased text");
    expect(merged).toContain("## [v1.0.0]");
  });
});
