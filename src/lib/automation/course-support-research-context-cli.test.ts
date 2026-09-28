import { describe, expect, it } from "vitest";

import { parseCourseSupportResearchOptions } from "../../../scripts/automation/course-support";

describe("course-support research command arguments", () => {
  it("accepts only an owner-bound ordinal and an exact validation digest", () => {
    expect(parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--owner-thread", "thread-reference",
    ], false)).toEqual({ batchRef: "batch-reference", ordinal: 1, contextDigest: undefined });
    expect(parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "1", "--context-digest", "a".repeat(64),
    ], true)).toEqual({ batchRef: "batch-reference", ordinal: 1, contextDigest: "a".repeat(64) });
  });

  it("rejects URL overrides, duplicate fields, invalid ordinals, and malformed digests", () => {
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--url", "https://other.example/",
    ], false)).toThrow("accepts only");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--ordinal", "02",
    ], false)).toThrow("only once");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "21",
    ], false)).toThrow("01 through 20");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--context-digest", "short",
    ], true)).toThrow("64-character lowercase");
  });
});
