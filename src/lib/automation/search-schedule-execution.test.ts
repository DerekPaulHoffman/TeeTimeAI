import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  claimScheduledSearchCheck: vi.fn(),
  completeExpiredSyntheticSearch: vi.fn(),
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
  executeScheduledSearchCheck,
  selectSearchEndpointWakeAt
} from "./search-schedule-execution";

const SOURCE_BACKED_BOOKING_WINDOW = {
  bookingWindowSource: "OFFICIAL_BOOKING_PAGE" as const,
  bookingWindowEvidenceUrl: "https://example.com/official-booking"
};

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
  dbMocks.completeExpiredSyntheticSearch.mockResolvedValue({
    completedAt: new Date("2026-07-16T06:00:00.000Z")
  });
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
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
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

  it("completes a multi-cycle synthetic search after eighteen hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T18:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "TEST",
      syntheticMultiCycle: true,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "completed",
      nextCheckAt: null
    });
    expect(runSearchCheck).not.toHaveBeenCalled();
    expect(dbMocks.completeExpiredSyntheticSearch).toHaveBeenCalledWith({
      searchId: "search-1",
      scheduleVersion: 3,
      leaseToken: "lease-1",
      outcome: "synthetic multi-cycle test lifetime ended"
    });
  });

  it("caps the next multi-cycle synthetic wake at the eighteen-hour lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T17:55:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      createdAt: new Date("2026-07-15T00:00:00.000Z"),
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "TEST",
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
      nextCheckAt: "2026-07-15T18:00:00.000Z"
    });
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        nextCheckAt: new Date("2026-07-15T18:00:00.000Z")
      })
    );
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

  it("stops without a successor wake when failure persistence rejects the stale lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-07-18T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [{ course: { timeZone: "America/New_York" } }]
    });
    runSearchCheck.mockRejectedValue(new Error("search check lease lost"));
    dbMocks.failScheduledSearchCheck.mockResolvedValue({
      count: 0,
      nextCheckAt: null
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toEqual({
      outcome: "stopped",
      nextCheckAt: null,
      availableMatches: 0,
      newlyAlertedMatches: 0,
      courseResults: []
    });
    expect(dbMocks.failScheduledSearchCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        nextCheckAt: new Date("2026-07-15T12:05:00.000Z")
      })
    );
  });

  it("keeps a successful long-cadence check awake for the earliest unresolved endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 120,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:28:00.000Z")
            }
          }
        },
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:25:00.000Z")
            }
          }
        }
      ]
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
      nextCheckAt: "2026-08-11T20:25:00.000Z"
    });
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        nextCheckAt: new Date("2026-08-11T20:25:00.000Z")
      })
    );
  });

  it("keeps a successful booking-window sleep awake for an unresolved endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-08-30T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 120,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00",
            ...SOURCE_BACKED_BOOKING_WINDOW,
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-01T12:28:00.000Z")
            }
          }
        }
      ]
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
      nextCheckAt: "2026-08-01T12:28:00.000Z"
    });
  });

  it("does not shorten a successful wake for an incident that already has a human reason", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 120,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: "AUTOMATION_STALLED",
              escalationDeadlineAt: new Date("2026-08-11T20:28:00.000Z")
            }
          }
        }
      ]
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
      nextCheckAt: "2026-08-11T22:20:00.000Z"
    });
  });

  it("keeps an engineering-only overdue endpoint on the bounded support cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      createdAt: new Date("2026-08-11T18:00:00.000Z"),
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "AUTOMATION",
      syntheticMultiCycle: true,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:15:00.000Z")
            }
          }
        }
      ]
    });
    runSearchCheck.mockResolvedValue({
      outcome: "success",
      availableMatches: 0,
      newlyAlertedMatches: 0,
      supportRetryNeeded: true,
      statusEmailOutcome: "failed",
      courseResults: []
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "success",
      nextCheckAt: "2026-08-11T20:35:00.000Z"
    });
    expect(dbMocks.completeScheduledSearchCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        nextCheckAt: new Date("2026-08-11T20:35:00.000Z")
      })
    );
  });

  it("keeps an already-consumed real-demand endpoint on the bounded support cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:15:00.000Z")
            }
          }
        }
      ]
    });
    runSearchCheck.mockResolvedValue({
      outcome: "success",
      availableMatches: 0,
      newlyAlertedMatches: 0,
      supportRetryNeeded: true,
      courseResults: []
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "success",
      nextCheckAt: "2026-08-11T20:35:00.000Z"
    });
  });

  it("schedules one immediate catch-up when a real-demand endpoint crosses during the check", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 120,
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:22:00.000Z")
            }
          }
        }
      ]
    });
    runSearchCheck.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-08-11T20:25:00.000Z"));
      return {
        outcome: "success",
        availableMatches: 0,
        newlyAlertedMatches: 0,
        supportRetryNeeded: false,
        courseResults: []
      };
    });

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "success",
      nextCheckAt: "2026-08-11T20:25:00.000Z"
    });
  });

  it("uses the failed-check backoff for an engineering-only overdue endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T20:20:00.000Z"));
    dbMocks.getSearchScheduleTiming.mockResolvedValue({
      createdAt: new Date("2026-08-11T18:00:00.000Z"),
      date: new Date("2026-08-15T00:00:00.000Z"),
      endTime: "18:00",
      userTimeZone: "America/New_York",
      cadenceMinutes: 15,
      trafficClass: "AUTOMATION",
      syntheticMultiCycle: true,
      preferences: [
        {
          course: {
            timeZone: "America/New_York",
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:15:00.000Z")
            }
          }
        }
      ]
    });
    runSearchCheck.mockRejectedValue(new Error("check failed"));

    await expect(executeScheduledSearchCheck("search-1", 3)).resolves.toMatchObject({
      outcome: "failed",
      nextCheckAt: "2026-08-11T20:25:00.000Z"
    });
  });
});

describe("calculateNextCheckAt", () => {
  it("keeps the persisted customer endpoint as a hard workflow wake", () => {
    const checkStartedAt = new Date("2026-08-11T20:20:00.000Z");
    const now = new Date("2026-08-11T20:25:00.000Z");
    const deadline = new Date("2026-08-11T20:28:00.000Z");

    expect(
      selectSearchEndpointWakeAt(
        [
          {
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: deadline
            }
          }
        ],
        "PUBLIC",
        checkStartedAt,
        now
      )
    ).toEqual(deadline);
  });

  it("returns one immediate catch-up when a real-demand endpoint crosses during a check", () => {
    const checkStartedAt = new Date("2026-08-11T20:15:00.000Z");
    const now = new Date("2026-08-11T20:25:00.000Z");

    expect(
      selectSearchEndpointWakeAt(
        [
          {
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:20:00.000Z")
            }
          }
        ],
        "PUBLIC",
        checkStartedAt,
        now
      )
    ).toEqual(now);
  });

  it("ignores a real-demand endpoint that was already overdue when the check started", () => {
    const checkStartedAt = new Date("2026-08-11T20:21:00.000Z");
    const now = new Date("2026-08-11T20:25:00.000Z");

    expect(
      selectSearchEndpointWakeAt(
        [
          {
            supportIncident: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalationDeadlineAt: new Date("2026-08-11T20:20:00.000Z")
            }
          }
        ],
        "PUBLIC",
        checkStartedAt,
        now
      )
    ).toBeNull();
  });

  it("uses configured cadence when a booking window is unknown", () => {
    const searchDate = new Date("2026-08-30T04:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(calculateNextCheckAt(searchDate, 15, now)?.toISOString()).toBe(
      "2026-08-01T12:15:00.000Z"
    );
  });

  it("uses a source-backed course-local release hour", () => {
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
            bookingReleaseTimeLocal: "05:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          }
        ]
      )?.toISOString()
    ).toBe("2026-07-15T09:00:00.000Z");
  });

  it("caps an unresolved monitoring retry at fifteen minutes", () => {
    const searchDate = new Date("2026-08-15T00:00:00.000Z");
    const now = new Date("2026-07-13T20:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-16T00:00:00.000Z"),
        [{ timeZone: "America/New_York" }],
        true
      )?.toISOString()
    ).toBe("2026-07-13T20:15:00.000Z");
  });

  it("does not turn a stale monitoring retry into an immediate workflow loop", () => {
    const searchDate = new Date("2026-08-15T00:00:00.000Z");
    const now = new Date("2026-07-13T20:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-16T00:00:00.000Z"),
        [{ timeZone: "America/New_York" }],
        true,
        undefined,
        { supportRetryAt: new Date("2026-07-13T19:00:00.000Z") }
      )?.toISOString()
    ).toBe("2026-07-13T20:15:00.000Z");
  });

  it("runs an immediate catch-up when the first-retry deadline crosses during the check", () => {
    const searchDate = new Date("2026-08-15T00:00:00.000Z");
    const checkStartedAt = new Date("2026-07-13T20:00:00.000Z");
    const now = new Date("2026-07-13T20:02:04.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-16T00:00:00.000Z"),
        [{ timeZone: "America/New_York" }],
        true,
        checkStartedAt,
        { supportRetryAt: new Date("2026-07-13T20:02:00.000Z") }
      )?.toISOString()
    ).toBe("2026-07-13T20:02:04.000Z");
  });

  it("runs an immediate catch-up when a delayed initial workflow normalizes its overdue retry", () => {
    const searchDate = new Date("2026-08-15T00:00:00.000Z");
    const checkStartedAt = new Date("2026-07-13T20:06:00.000Z");
    const now = new Date("2026-07-13T20:06:04.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        120,
        now,
        new Date("2026-08-16T00:00:00.000Z"),
        [{ timeZone: "America/New_York" }],
        true,
        checkStartedAt,
        { supportRetryAt: new Date("2026-07-13T20:06:00.000Z") }
      )?.toISOString()
    ).toBe("2026-07-13T20:06:04.000Z");
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
            bookingReleaseTimeLocal: "06:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          },
          {
            timeZone: "America/Los_Angeles",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          }
        ]
      )?.toISOString()
    ).toBe("2026-08-16T12:00:00.000Z");
  });

  it("uses configured cadence when any selected course lacks source-backed evidence", () => {
    const searchDate = new Date("2026-08-30T00:00:00.000Z");
    const now = new Date("2026-08-01T12:00:00.000Z");

    expect(
      calculateNextCheckAt(
        searchDate,
        60,
        now,
        new Date("2026-08-31T00:00:00.000Z"),
        [
          {
            timeZone: "America/Los_Angeles",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          },
          { timeZone: "America/New_York" }
        ]
      )?.toISOString()
    ).toBe("2026-08-01T13:00:00.000Z");
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
            bookingReleaseTimeLocal: "05:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          },
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 7,
            bookingReleaseTimeLocal: "06:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
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
            bookingReleaseTimeLocal: "04:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
          },
          {
            timeZone: "America/New_York",
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "08:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
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
            bookingReleaseTimeLocal: "08:00",
            ...SOURCE_BACKED_BOOKING_WINDOW
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
