import { describe, expect, it } from "vitest";

import {
  parseCourseSupportSourceSearchResultOptions,
  shouldCompleteParkedCampaignForInspection,
} from "../../../scripts/automation/course-support";

describe("course-support source-search CLI", () => {
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
