import { describe, expect, it } from "vitest";

import {
  assertCourseProfileBackfillValid,
  executeCourseProfileCommand,
  parseCourseProfileCommand
} from "../../../scripts/automation/course-profile";

describe("automation:course-profile", () => {
  it("is dry-run by default and requires an explicit apply flag for Connecticut publishing", () => {
    expect(parseCourseProfileCommand(["backfill-connecticut"])).toEqual({
      action: "backfill-connecticut",
      apply: false
    });
    expect(parseCourseProfileCommand(["backfill-connecticut", "--apply"])).toEqual({
      action: "backfill-connecticut",
      apply: true
    });
    expect(parseCourseProfileCommand(["backfill-connecticut", "--county", "Fairfield County"])).toEqual({
      action: "backfill-connecticut",
      apply: false,
      county: "Fairfield County"
    });
    expect(parseCourseProfileCommand(["alias", "--course-id", "course-1", "--slug", "retired-course-url"])).toEqual({
      action: "alias",
      courseId: "course-1",
      slug: "retired-course-url",
      apply: false
    });
  });

  it("validates the full source-backed Connecticut cohort without a database write", async () => {
    const result = await executeCourseProfileCommand({ action: "validate-seeds" });
    expect(result).toMatchObject({ count: 26, valid: true });
    expect("profiles" in result && result.profiles).toHaveLength(26);
  });

  it("fails a batch preflight before publishing when any selected profile is invalid", () => {
    expect(() => assertCourseProfileBackfillValid([
      { course: "Ready Course", result: { valid: true, errors: [] } },
      { course: "Unverified Course", result: { valid: false, errors: ["Course support status is not verified"] } }
    ])).toThrow("Connecticut backfill preflight failed for 1 course: Unverified Course");
  });
});
