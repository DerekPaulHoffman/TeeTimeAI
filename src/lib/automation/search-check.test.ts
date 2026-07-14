import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  finishAutomationRun: vi.fn(),
  getActiveSearchForAutomation: vi.fn(),
  listAvailableMatchAlerts: vi.fn(),
  listPendingMatchAlerts: vi.fn(),
  markCourseBookingWindowChecked: vi.fn(),
  markMatchAlertSent: vi.fn(),
  markMatchAlertSuppressed: vi.fn(),
  markMissingMatchesUnavailable: vi.fn(),
  markSearchStatusEmailSent: vi.fn(),
  recordCourseBookingWindowEvidence: vi.fn(),
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
  fetchChelseaTeeSheet: vi.fn(),
  fetchChronogolfSlots: vi.fn(),
  fetchForeupTeeSheet: vi.fn(),
  isChelseaMetadata: vi.fn(),
  isChronogolfMetadata: vi.fn(),
  isForeupMetadata: vi.fn()
}));

const supportIncidentMocks = vi.hoisted(() => ({
  notifyCourseSupportIssueBatch: vi.fn(),
  reportCourseSupportIssue: vi.fn(),
  resolveCourseSupportIncident: vi.fn()
}));

const monitoringDiscoveryMocks = vi.hoisted(() => ({
  prepareSearchMonitoring: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/email/alerts", () => emailMocks);
vi.mock("@/lib/adapters/foreup", () => adapterMocks);
vi.mock("@/lib/adapters/chelsea", () => adapterMocks);
vi.mock("@/lib/adapters/chronogolf", () => adapterMocks);
vi.mock("@/lib/automation/support-incidents", () => supportIncidentMocks);
vi.mock("@/lib/automation/search-monitoring-discovery", () => monitoringDiscoveryMocks);

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
        bookingWindowDaysAhead: null,
        bookingReleaseTimeLocal: null,
        bookingWindowSource: null,
        bookingWindowConfidence: null,
        bookingWindowEvidenceUrl: null,
        bookingWindowCheckedAt: null,
        bookingWindowObservedAt: null,
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
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    adapterMocks.fetchChronogolfSlots.mockResolvedValue([]);
    adapterMocks.isChelseaMetadata.mockReturnValue(true);
    adapterMocks.fetchChelseaTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    supportIncidentMocks.reportCourseSupportIssue.mockResolvedValue({
      incidentId: "incident-1",
      status: "AUTO_INVESTIGATING",
      ownerAlerted: true
    });
    supportIncidentMocks.notifyCourseSupportIssueBatch.mockResolvedValue({
      notifiedIncidentIds: [],
      pendingIncidentIds: []
    });
    supportIncidentMocks.resolveCourseSupportIncident.mockResolvedValue(null);
    monitoringDiscoveryMocks.prepareSearchMonitoring.mockResolvedValue({
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      retryCourseIds: []
    });
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

  it("lets a new-opening email satisfy the weekly reminder instead of sending twice", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-04T13:00:00.000Z")
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
        message: expect.stringContaining("Official booking surface inspected")
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

    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
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

  it("opens a persistent operator incident for unsupported courses", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            automationEligibility: "UNKNOWN",
            policyNotes: null
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        kind: "NEEDS_ADAPTER"
      })
    );
    expect(result.courseResults[0]).toEqual(
      expect.objectContaining({
        outcome: "NEEDS_ADAPTER",
        supportStatus: "TEAM_ALERTED"
      })
    );
    expect(result.supportRetryNeeded).toBe(false);
  });

  it("runs official-site discovery before classifying an unsupported course", async () => {
    const unsupportedSearch = {
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            automationEligibility: "UNKNOWN",
            policyNotes: null
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(unsupportedSearch);
    monitoringDiscoveryMocks.prepareSearchMonitoring.mockResolvedValue({
      attemptedCourseIds: ["course-1"],
      appliedCourseIds: [],
      failedCourseIds: [],
      retryCourseIds: ["course-1"]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(monitoringDiscoveryMocks.prepareSearchMonitoring).toHaveBeenCalledWith(
      unsupportedSearch
    );
    expect(monitoringDiscoveryMocks.prepareSearchMonitoring.mock.invocationCallOrder[0]).toBeLessThan(
      supportIncidentMocks.reportCourseSupportIssue.mock.invocationCallOrder[0]
    );
    expect(result.supportRetryNeeded).toBe(true);
  });

  it("waits until a fresh course-specific booking release without hitting the tee sheet", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      date: new Date("2026-07-29T00:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Weekend Golf Course",
            detectedPlatform: "FOREUP",
            detectedBookingUrl: "https://foreupsoftware.com/booking/weekend",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              scheduleId: 123,
              bookingBaseUrl: "https://foreupsoftware.com/booking/weekend"
            },
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00",
            bookingWindowSource: "PROVIDER_CONFIG",
            bookingWindowConfidence: 1,
            bookingWindowEvidenceUrl: "https://foreupsoftware.com/booking/weekend",
            bookingWindowCheckedAt: new Date("2026-07-10T12:00:00.000Z"),
            bookingWindowObservedAt: new Date("2026-07-10T12:00:00.000Z")
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "NO_MATCH",
        message: expect.stringContaining("2026-07-15T09:00:00.000Z")
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NO_MATCH",
      bookingWindow: {
        releaseDate: "2026-07-15",
        releaseTimeLocal: "05:00",
        opensAt: "2026-07-15T09:00:00.000Z",
        exactTime: true
      }
    });
  });

  it("uses learned Chronogolf metadata for public availability checks", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "blue-rock",
            name: "Blue Rock Golf Course",
            detectedPlatform: "CHRONOGOLF",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: "Public Chronogolf marketplace availability.",
            bookingMetadata: {
              clubId: 7221,
              courseIds: ["course-public-uuid"],
              bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchChronogolfSlots).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        players: 2
      })
    );
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        outcome: "NO_MATCH"
      })
    );
    expect(supportIncidentMocks.resolveCourseSupportIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        resolution: "MONITORING_RESTORED"
      })
    );
  });

  it("uses public Chelsea metadata and persists its non-member booking window", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      date: new Date("2026-08-15T00:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "dennis-highland",
            name: "Dennis Highland Course",
            detectedPlatform: "CUSTOM",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: "Public Chelsea non-member availability.",
            bookingMetadata: {
              provider: "CHELSEA",
              bookingBaseUrl: "https://dennis.chelseareservations.com/",
              courseCode: 2,
              courseLabel: "Highland",
              bookingWindowDaysAhead: 7,
              bookingWindowEvidenceUrl: "https://www.dennisgolf.com/policy.pdf"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    adapterMocks.fetchChelseaTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "NOT_OPEN",
      bookingWindowEvidence: {
        daysAhead: 7,
        releaseTimeLocal: null,
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 0.98,
        evidenceUrl: "https://www.dennisgolf.com/policy.pdf"
      }
    });

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchChelseaTeeSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "dennis-highland",
        players: 2,
        timeZone: "America/New_York"
      })
    );
    expect(dbMocks.recordCourseBookingWindowEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "dennis-highland",
        evidence: expect.objectContaining({ daysAhead: 7 })
      })
    );
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "dennis-highland",
        outcome: "NO_MATCH",
        message: expect.stringContaining("2026-08-08")
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NO_MATCH",
      bookingWindow: { releaseDate: "2026-08-08", exactTime: false }
    });
  });
});
