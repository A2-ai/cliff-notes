import { describe, test, expect } from "bun:test";
import { extractSection } from "../src/extract.ts";

const CHANGELOG = `# Changelog

## [v1.1.0] - 2026-05-20

Latest stuff.

### Features
- Baz qux ([#9](https://gh/pr/9))

<!-- cliff-notes:raw v1
- feat: baz qux
-->

## [v1.0.0] - 2026-05-13

Initial release.

### Features
- Foo bar ([#1](https://gh/pr/1))

<!-- cliff-notes:raw v1
- feat: foo bar
-->
`;

describe("extractSection", () => {
  test("extracts a middle section, stopping before next heading", () => {
    const out = extractSection(CHANGELOG, "v1.1.0");
    expect(out).not.toBeNull();
    expect(out!.startsWith("## [v1.1.0]")).toBe(true);
    expect(out).toContain("Baz qux");
    expect(out).not.toContain("v1.0.0");
  });

  test("extracts the last section through EOF", () => {
    const out = extractSection(CHANGELOG, "v1.0.0");
    expect(out).not.toBeNull();
    expect(out!.startsWith("## [v1.0.0]")).toBe(true);
    expect(out).toContain("Foo bar");
  });

  test("strips the audit comment block", () => {
    const out = extractSection(CHANGELOG, "v1.0.0");
    expect(out).not.toContain("cliff-notes:raw");
    expect(out).not.toContain("feat: foo bar");
  });

  test("returns null for unknown tag", () => {
    expect(extractSection(CHANGELOG, "v9.9.9")).toBeNull();
  });
});
