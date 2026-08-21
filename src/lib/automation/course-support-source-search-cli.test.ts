import { describe, expect, it } from "vitest";

import {
  parseCanonicalCourseSupportDeployedAt,
  parseCourseSupportSourceSearchResultOptions,
  shouldCompleteParkedCampaignForInspection,
} from "../../../scripts/automation/course-support";

describe("course-support source-search CLI", () => {
  it("accepts only one exact canonical UTC deployment timestamp", () => {
    expect(
      parseCanonicalCourseSupportDeployedAt([
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
      ]),
    ).toEqual(new Date("2026-08-21T15:04:05.123Z"));
    expect(parseCanonicalCourseSupportDeployedAt([])).toBeNull();

    for (const raw of [
      " 2026-08-21T15:04:05.123Z",
      "2026-08-21T15:04:05.123Z ",
      "2026-08-21T11:04:05.123-04:00",
      "2026-08-21T15:04:05Z",
      "not-a-timestamp",
    ]) {
      expect(() =>
        parseCanonicalCourseSupportDeployedAt(["--deployed-at", raw]),
      ).toThrow("exact canonical UTC ISO");
    }
    expect(() =>
      parseCanonicalCourseSupportDeployedAt([
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
        "--deployed-at",
        "2026-08-21T15:04:05.123Z",
      ]),
    ).toThrow("only once");
    expect(() =>
      parseCanonicalCourseSupportDeployedAt(["--deployed-at"]),
    ).toThrow("requires a value");
  });

  it("parses one ordinal-scoped candidate result", () => {
    expect(
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "2",
        "--attempt-ref",
        "a".repeat(64),
        "--candidate-url",
        "https://course.example/",
      ]),
    ).toEqual({
      ordinal: 2,
      attemptRef: "a".repeat(64),
      candidateUrl: "https://course.example/",
      noUnique: false,
    });
  });

  it("parses the bounded no-result alternative and rejects duplicate flags", () => {
    expect(
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "1",
        "--attempt-ref",
        "b".repeat(64),
        "--no-unique",
      ]),
    ).toEqual({
      ordinal: 1,
      attemptRef: "b".repeat(64),
      candidateUrl: undefined,
      noUnique: true,
    });
    expect(() =>
      parseCourseSupportSourceSearchResultOptions([
        "--ordinal",
        "1",
        "--attempt-ref",
        "b".repeat(64),
        "--no-unique",
        "--no-unique",
      ]),
    ).toThrow("only once");
  });

  it("allows only the scheduled responder inspection to complete a parked campaign", () => {
    expect(shouldCompleteParkedCampaignForInspection([])).toBe(false);
    expect(shouldCompleteParkedCampaignForInspection(["--owner-thread", "hourly-loop"])).toBe(
      false,
    );
    expect(shouldCompleteParkedCampaignForInspection(["--scheduled-cycle"])).toBe(true);
  });
});
