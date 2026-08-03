import { describe, expect, it } from "vitest";

import {
  getDashboardAvailabilityView,
  isDashboardMonitoringSetupInProgress,
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

  it("shows active monitoring setup as progress instead of a final unavailable state", () => {
    expect(
      getDashboardAvailabilityView({
        outcome: "NEEDS_ADAPTER",
        monitoringSetupInProgress: true,
        qualifyingMatchCount: 0,
        players: 4,
        startTime: "09:00",
        endTime: "18:00"
      })
    ).toEqual({
      label: "Monitoring setup in progress",
      detail:
        "We haven't connected to this course's public tee sheet yet. Use the official course site for current availability while Tee Time Spot works on alert coverage.",
      tone: "scheduled"
    });
  });

  it("limits setup-in-progress messaging to incidents opened for a newly introduced course", () => {
    const courseCreatedAt = new Date("2026-08-03T19:39:07.519Z");

    expect(
      isDashboardMonitoringSetupInProgress({
        courseCreatedAt,
        latestOutcome: "NEEDS_ADAPTER",
        incident: {
          status: "AUTO_INVESTIGATING",
          firstSeenAt: new Date("2026-08-03T19:39:16.602Z")
        }
      })
    ).toBe(true);

    expect(
      isDashboardMonitoringSetupInProgress({
        courseCreatedAt,
        latestOutcome: "NEEDS_ADAPTER",
        incident: {
          status: "AUTO_INVESTIGATING",
          firstSeenAt: new Date("2026-08-04T19:39:16.602Z")
        }
      })
    ).toBe(false);
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
