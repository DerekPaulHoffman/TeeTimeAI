import { describe, expect, it } from "vitest";

import {
  normalizeGitCommandOutput,
  parseGitNulPaths,
  parseGitPorcelainV1ZPaths
} from "../../../scripts/automation/git-output";

describe("course-support git output", () => {
  it("preserves the first porcelain status column while removing trailing lines", () => {
    const output = " M docs/deployment-status.md\r\n";

    expect(normalizeGitCommandOutput(output)).toBe(
      " M docs/deployment-status.md"
    );
  });

  it("parses complete NUL-delimited paths for unstaged, staged, and untracked changes", () => {
    const output = [
      " M docs/deployment-status.md",
      "M  src/lib/automation/course-support-batches.ts",
      "?? src/lib/automation/course-support-batches.test.ts",
      ""
    ].join("\0");

    expect(parseGitPorcelainV1ZPaths(output)).toEqual([
      "docs/deployment-status.md",
      "src/lib/automation/course-support-batches.ts",
      "src/lib/automation/course-support-batches.test.ts"
    ]);
  });

  it("accounts for both sides of rename/copy records and preserves path whitespace", () => {
    const output = [
      "R  src/new name.ts",
      "src/old name.ts",
      " C src/copied.ts",
      "src/source.ts",
      "??  leading-space.ts",
      ""
    ].join("\0");

    expect(parseGitPorcelainV1ZPaths(output)).toEqual([
      "src/new name.ts",
      "src/old name.ts",
      "src/copied.ts",
      "src/source.ts",
      " leading-space.ts"
    ]);
  });

  it("parses unquoted NUL-delimited diff paths without rename collapsing", () => {
    expect(parseGitNulPaths("src/old name.ts\0src/new name.ts\0")).toEqual([
      "src/old name.ts",
      "src/new name.ts"
    ]);
  });
});
