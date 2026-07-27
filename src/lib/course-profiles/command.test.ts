import { describe, expect, it } from "vitest";

import {
  parseCourseProfileCommand
} from "../../../scripts/automation/course-profile";

describe("automation:course-profile", () => {
  it("supports generic profile verification and dry-run profile updates", () => {
    expect(parseCourseProfileCommand(["verify-profiles", "--state", "ct"])).toEqual({
      action: "verify-profiles",
      stateCode: "CT"
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

  it("requires a state for generic profile verification", () => {
    expect(() => parseCourseProfileCommand(["verify-profiles"])).toThrow(
      "verify-profiles requires a two-letter --state"
    );
  });
});
