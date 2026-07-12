import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  finishAutomationRun: vi.fn(),
  getActiveSearchForAutomation: vi.fn(),
  listAvailableMatchAlerts: vi.fn(),
  listPendingMatchAlerts: vi.fn(),
  markMatchAlertSent: vi.fn(),
  markMatchAlertSuppressed: vi.fn(),
  markMissingMatchesUnavailable: vi.fn(),
  markSearchStatusEmailSent: vi.fn(),
  recordCourseProbe: vi.fn(),
  recordCourseProbeIfChanged: vi.fn(),
  recordTeeTimeMatch: vi.fn(),
  runWithSearchCheckLease: vi.fn(),
  startAutomationRun: vi.fn()
}));

const emailMocks = vi.hoisted(() => ({
  sendSearchStatusEmail: vi.fn(),
  sendTeeTimeAlert: vi.fn()
}));

const adapterMocks = vi.hoisted(() => ({
  fetchForeupSlots: vi.fn(),
  isForeupMetadata: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/email/alerts", () => emailMocks);
vi.mock("@/lib/adapters/foreup", () => adapterMocks);

import { runSearchCheck } from "./search-check";

const search = {
  id: "search-1",
  date: new Date("2026-07-12T00:00:00.000Z"),
  startTime: "07:00",
  endTime: "10:00",
  players: 2,
  requestedLayoutHoles: null as 9 | 18 | null,
  userTimeZone: "America/New_York",
  statusEmailSentAt: null as Date | null,
  statusEmailSnapshot: null,
  additionalEmails: [],
  user: { email: "player@resend.dev" },
  preferences: [
    {
      rank: 1,
      course: {
        id: "course-1",
        name: "Official Site Only Course",
        timeZone: "America/New_York",
        phone: null,
        bookingPhone: null,
        website: "https://example.com/course",
        detectedBookingUrl: null,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "BLOCKED",
        automationReason: "POLICY_RESTRICTED",
        policyNotes: "Automated retrieval is not allowed.",
        detectedPlatform: "UNKNOWN",
        bookingMetadata: null,
        layoutHoleCounts: [] as number[],
        layoutHolesVerifiedAt: null as Date | null
      }
    }
  ],
  matches: []
};

const pendingMatch = {
  id: "match-1",
  course: {
    name: "Available Course",
    timeZone: "America/New_York"
  },
  teeSearch: {
    id: "search-1",
    userTimeZone: "America/New_York",
    additionalEmails: [],
    user: { email: "player@resend.dev" }
  },
  startsAt: new Date("2026-07-12T12:00:00.000Z"),
  availableSpots: 4,
  bookingUrl: "https://example.com/book",
  priceCents: null,
  holes: 18
};

describe("runSearchCheck email cadence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:10:00.000Z"));
    dbMocks.startAutomationRun.mockResolvedValue({ id: "run-1" });
    dbMocks.finishAutomationRun.mockResolvedValue(undefined);
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({ ...search });
    dbMocks.runWithSearchCheckLease.mockImplementation(async (_searchId, worker) => ({
      acquired: true,
      value: await worker()
    }));
    dbMocks.recordCourseProbeIfChanged.mockResolvedValue(undefined);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([pendingMatch]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([pendingMatch]);
    dbMocks.markMatchAlertSent.mockResolvedValue(undefined);
    dbMocks.markMatchAlertSuppressed.mockResolvedValue(undefined);
    dbMocks.markSearchStatusEmailSent.mockResolvedValue(undefined);
    emailMocks.sendSearchStatusEmail.mockResolvedValue({
      id: "status-email-1",
      deliveryStatus: "sent"
    });
    emailMocks.sendTeeTimeAlert.mockResolvedValue({
      id: "match-email-1",
      deliveryStatus: "sent"
    });
    adapterMocks.isForeupMetadata.mockReturnValue(true);
    adapterMocks.fetchForeupSlots.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the setup report for initial matches instead of sending a second instant email", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      requestedLayoutHoles: 18
    });

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "setup", requestedLayoutHoles: 18 })
    );
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
    expect(dbMocks.markMatchAlertSent).toHaveBeenCalledWith("match-1");
    expect(result).toEqual(
      expect.objectContaining({ newlyAlertedMatches: 1, statusEmailOutcome: "sent" })
    );
  });

  it("lets a new-opening email satisfy the morning update instead of sending twice", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z")
    });

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalled();
    expect(dbMocks.markSearchStatusEmailSent).toHaveBeenCalledWith(
      expect.objectContaining({ searchId: "search-1" })
    );
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 1,
        statusEmailOutcome: "covered_by_match_alert"
      })
    );
  });

  it("records an unchanged unsupported course probe only once", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            bookingMethod: "UNKNOWN",
            automationEligibility: "UNKNOWN",
            automationReason: "NONE",
            policyNotes: null
          }
        }
      ]
    });

    await runSearchCheck("search-1", "test");

    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-1",
        outcome: "NEEDS_ADAPTER",
        message: expect.stringContaining("queued for browser probe")
      })
    );
    expect(dbMocks.recordCourseProbe).not.toHaveBeenCalled();
  });

  it("does not fetch or alert a legacy course with a verified incompatible layout", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      requestedLayoutHoles: 18,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "woodhaven",
            name: "Woodhaven Country Club",
            detectedPlatform: "FOREUP",
            automationEligibility: "ALLOWED",
            policyNotes: null,
            bookingMetadata: { courseId: "woodhaven" },
            layoutHoleCounts: [9],
            layoutHolesVerifiedAt: new Date("2026-07-11T12:00:00.000Z")
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupSlots).not.toHaveBeenCalled();
    expect(dbMocks.recordTeeTimeMatch).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith({
      searchId: "search-1",
      courseId: "woodhaven",
      date: "2026-07-12",
      timeZone: "America/New_York",
      confirmedMatches: []
    });
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "woodhaven",
        outcome: "NO_MATCH",
        message: expect.stringContaining("requested 18-hole physical course layout")
      })
    );
    expect(result.courseResults).toEqual([
      expect.objectContaining({
        courseId: "woodhaven",
        outcome: "NO_MATCH",
        availableMatches: 0
      })
    ]);
  });
});
