import { describe, expect, it } from "vitest";

import {
  getDashboardAvailabilityView,
  readDashboardAvailabilitySnapshot
} from "./dashboard-availability";

describe("dashboard availability", () => {
  it("treats provider-returned times outside the request as availability found", () => {
    expect(
      getDashboardAvailabilityView({
        outcome: "NO_MATCH",
        rawSummary: {
          visibleSlotCount: 4,
          playerEligibleSlotCount: 4,
          closestAfter: "2026-07-31T18:10:00"
        },
        qualifyingMatchCount: 0,
        players: 2,
        startTime: "11:00",
        endTime: "14:00"
      })
    ).toEqual({
      label: "Available outside your window",
      detail:
        "4 tee times are available for 2 golfers, but none fall between 11:00 AM and 2:00 PM. The nearest later time is 6:10 PM.",
      tone: "available"
    });
  });

  it("prioritizes currently persisted qualifying matches", () => {
    expect(
      getDashboardAvailabilityView({
        outcome: "MATCH_FOUND",
        rawSummary: {
          visibleSlotCount: 8,
          playerEligibleSlotCount: 8
        },
        qualifyingMatchCount: 2,
        players: 3,
        startTime: "09:00",
        endTime: "13:00"
      })
    ).toMatchObject({
      label: "2 matching times",
      tone: "matching"
    });
  });

  it("distinguishes an empty public tee sheet from an unavailable check", () => {
    expect(
      getDashboardAvailabilityView({
        outcome: "NO_MATCH",
        rawSummary: {
          visibleSlotCount: 0,
          playerEligibleSlotCount: 0
        },
        qualifyingMatchCount: 0,
        players: 1,
        startTime: "08:00",
        endTime: "12:00"
      })
    ).toMatchObject({
      label: "No public times listed",
      tone: "empty"
    });

    expect(
      getDashboardAvailabilityView({
        outcome: "FETCH_FAILED",
        qualifyingMatchCount: 0,
        players: 1,
        startTime: "08:00",
        endTime: "12:00"
      })
    ).toMatchObject({
      label: "Current availability unavailable",
      tone: "unavailable"
    });
  });

  it("treats an unsupported-course check as a retrying current status", () => {
    expect(
      getDashboardAvailabilityView({
        outcome: "NEEDS_ADAPTER",
        qualifyingMatchCount: 0,
        players: 4,
        startTime: "09:00",
        endTime: "18:00"
      })
    ).toEqual({
      label: "Current availability unavailable",
      detail:
        "We could not confirm the current tee sheet. Your alert remains active. Use the official course site while Tee Time Spot keeps trying.",
      tone: "unavailable"
    });
  });

  it("rejects malformed probe summaries", () => {
    expect(
      readDashboardAvailabilitySnapshot({
        visibleSlotCount: "4",
        playerEligibleSlotCount: 4
      })
    ).toBeNull();
  });
});
