import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  claimScheduledSearchCheck: vi.fn(),
  completeScheduledSearchCheck: vi.fn(),
  failScheduledSearchCheck: vi.fn(),
  getSearchScheduleTiming: vi.fn()
}));
const runSearchCheck = vi.hoisted(() => vi.fn());

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/automation/search-check", () => ({ runSearchCheck }));

import {
  calculateNextCheckAt,
  calculateSearchWindowEnd,
  executeScheduledSearchCheck
} from "./search-schedule-execution";

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.claimScheduledSearchCheck.mockResolvedValue({
    searchId: "search-1",
    scheduleVersion: 3,
    token: "lease-1",
    expiresAt: new Date("2026-07-15T12:15:00.000Z")
  });
  dbMocks.completeScheduledSearchCheck.mockImplementation(
    async (input: { nextCheckAt: Date | null }) => ({
      recheckRequested: false,
      nextCheckAt: input.nextCheckAt
    })
  );
  dbMocks.failScheduledSearchCheck.mockImplementation(
    async (input: { nextCheckAt: Date }) => ({
      count: 1,
      nextCheckAt: input.nextCheckAt
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("executeScheduledSearchCheck", () => {
  it("completes an expired search without fetching course availability", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T23:25:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-07-11T00:00:00.000Z"),
      endTime: "09:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 5,
      trafficClass: "UNCLASSIFIED",
      syntheticMultiCycle: false,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "completed",
      nextCheckAt: null
    });
    expect(runSearchCheck).not.toHaveBeenCalled();
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 3,
      leaseToken: "lease-1",
      outcome: "search window ended",
      nextCheckAt: null,
      completeSearch: true
    });
  });

  it("completes a synthetic search after one successful check by default", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 5,
      trafficClass: "TEST",
      syntheticMultiCycle: false,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });
    runSearchCheck.mockResolvedValue({
      outcome: "success",
      availableMatches: 2,
      newlyAlertedMatches: 0,
      supportRetryNeeded: false,
      courseResults: []
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "success",
      nextCheckAt: null
    });
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 3,
      leaseToken: "lease-1",
      outcome: expect.stringContaining("synthetic one-check complete"),
      nextCheckAt: null,
      completeSearch: true
    });
  });

  it("keeps an explicitly multi-cycle synthetic search on its normal cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "AUTOMATION",
      syntheticMultiCycle: true,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });
    runSearchCheck.mockResolvedValue({
      outcome: "success",
      availableMatches: 0,
      newlyAlertedMatches: 0,
      supportRetryNeeded: false,
      courseResults: []
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "success",
      nextCheckAt: "2026-07-15T12:15:00.000Z"
    });
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 3,
      leaseToken: "lease-1",
      outcome: expect.any(String),
      nextCheckAt: new Date("2026-07-15T12:15:00.000Z")
    });
  });

  it("returns an earlier durable delivery retry when the check fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 120,
      trafficClass: "UNCLASSIFIED",
      syntheticMultiCycle: false,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });
    runSearchCheck.mockRejectedValue(new Error("delivery failed"));
    dbMocks.failScheduledSearchCheck.mockResolvedValue({
      count: 1,
      nextCheckAt: new Date("2026-07-15T12:01:00.000Z")
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "failed",
      nextCheckAt: "2026-07-15T12:01:00.000Z"
    });
  });
});

describe("calculateNextCheckAt", () => {
  it("sleeps until the booking window when a search is far in the future", () => {
    const searchDate = new Date("2026-08-30T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 15, now)?.getTime()).toBe(
      searchDate.getTime() - 14 * 24 * 60 * 60 * 1000
    );
  });

  it("uses a learned course-local release hour instead of the generic window", () => {
    const searchDate = new Date("2026-07-29T00:00:00.000Z");
    const now = new Date("2026-07-01T12:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        5,
        now,
        new Date("2026-07-30T00:00:00.000Z"),
        [
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00"
          }
        ]
      )?.toISOString()
    ).toBe("2026-07-15T09:00:00.000Z");
  });

  it("retries an unresolved initial monitoring discovery after thirty minutes", () => {
    const searchDate = new Date("2026-08-15T00:00:00.000Z");
    const now = new Date("2026-07-13T20:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        5,
        now,
        new Date("2026-08-16T00:00:00.000Z"),
        [{ timeZone: "America/New_York" }],
        true
      )?.toISOString()
    ).toBe("2026-07-13T20:15:00.000Z");
  });

  it("wakes for the earliest of several course-specific booking windows", () => {
    const searchDate = new Date("2026-08-30T00:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        5,
        now,
        new Date("2026-08-31T00:00:00.000Z"),
        [
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 7,
            bookingReleaseTimeLocal: "06:00"
          },
          {
            timeZone: "America/Los_Angeles",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00"
          }
        ]
      )?.toISOString()
    ).toBe("2026-08-16T12:00:00.000Z");
  });

  it("uses the normal cadence once any selected course is open", () => {
    const searchDate = new Date("2026-08-30T00:00:00.000Z");
    const now = new Date("2026-08-16T12:01:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        15,
        now,
        new Date("2026-08-31T00:00:00.000Z"),
        [
          {
            timeZone: "America/Los_Angeles",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00"
          },
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 7,
            bookingReleaseTimeLocal: "06:00"
          }
        ]
      )?.toISOString()
    ).toBe("2026-08-16T12:16:00.000Z");
  });

  it("wakes for another selected course's release even when one course is already open", () => {
    const searchDate = new Date("2026-08-30T00:00:00.000Z");
    const now = new Date("2026-08-16T11:55:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-31T00:00:00.000Z"),
        [
          {
            timeZone: "America/Los_Angeles",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "04:00"
          },
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "08:00"
          }
        ]
      )?.toISOString()
    ).toBe("2026-08-16T12:00:00.000Z");
  });

  it("immediately catches a release that occurred while the prior check was running", () => {
    const searchDate = new Date("2026-08-30T00:00:00.000Z");
    const checkStartedAt = new Date("2026-08-16T11:59:00.000Z");
    const now = new Date("2026-08-16T12:01:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-31T00:00:00.000Z"),
        [
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "08:00"
          }
        ],
        false,
        checkStartedAt
      )?.toISOString()
    ).toBe("2026-08-16T12:01:00.000Z");
  });

  it("uses the search cadence once the booking window is open", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 30, now)?.toISOString()).toBe(
      "2026-08-01T12:30:00.000Z"
    );
  });

  it("supports five-minute launch checks inside the booking window", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 5, now)?.toISOString()).toBe(
      "2026-08-01T12:05:00.000Z"
    );
  });

  it("stops after the search date has passed", () => {
    const searchDate = new Date("2026-08-10T04:00:00.000Z");
    const now = new Date("2026-08-12T04:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 15, now)).toBeNull();
  });

  it("stops at the requested course-local window end instead of midnight", () => {
    const searchDate = new Date("2026-07-11T00:00:00.000Z");
    const searchExpiresAt = calculateSearchWindowEnd(
      searchDate,
      "09:00",
      ["America/New_York"],
      "America/New_York"
    );

    expect(searchExpiresAt.toISOString()).toBe("2026-07-11T13:00:00.000Z");
    expect(
      calculateNextCheckAt(
        searchDate,
        5,
        new Date("2026-07-11T12:58:00.000Z"),
        searchExpiresAt
      )?.toISOString()
    ).toBe("2026-07-11T13:00:00.000Z");
    expect(
      calculateNextCheckAt(
        searchDate,
        5,
        new Date("2026-07-11T13:00:00.000Z"),
        searchExpiresAt
      )
    ).toBeNull();
  });

  it("uses the latest course-local cutoff for searches spanning time zones", () => {
    const searchExpiresAt = calculateSearchWindowEnd(
      new Date("2026-07-11T00:00:00.000Z"),
      "16:00",
      ["America/New_York", "America/Los_Angeles"],
      "America/New_York"
    );

    expect(searchExpiresAt.toISOString()).toBe("2026-07-11T23:00:00.000Z");
  });
});
