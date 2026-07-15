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
    expect(parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "7",
      "--release-time", "5:30am",
      "--evidence-url", "https://example.com/booking-policy"
    ])).toEqual({
      action: "booking-window",
      courseId: "course-1",
      daysAhead: 7,
      releaseTimeLocal: "05:30",
      evidenceUrl: "https://example.com/booking-policy",
      apply: false
    });
  });

  it("rejects invalid booking-window facts before touching the database", () => {
    expect(() => parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "100",
      "--evidence-url", "https://example.com/policy"
    ])).toThrow("--days-ahead must be an integer");
    expect(() => parseCourseProfileCommand([
      "booking-window",
      "--course-id", "course-1",
      "--days-ahead", "7",
      "--release-time", "25:00",
      "--evidence-url", "https://example.com/policy"
    ])).toThrow("--release-time must be a valid course-local time");
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
