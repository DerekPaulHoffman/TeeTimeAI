import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyBrowserDiscoveryToCourse: vi.fn(),
  finishAutomationRun: vi.fn(),
  getActiveSearchForAutomation: vi.fn(),
  heartbeatSearchCheckLease: vi.fn(),
  isSearchCheckLeaseCurrent: vi.fn(),
  listAvailableMatchAlerts: vi.fn(),
  listPendingMatchAlerts: vi.fn(),
  markCourseBookingWindowChecked: vi.fn(),
  markMatchAlertSent: vi.fn(),
  markMatchAlertSuppressed: vi.fn(),
  markMissingMatchesUnavailable: vi.fn(),
  markSearchStatusEmailSent: vi.fn(),
  recordCourseBookingWindowEvidence: vi.fn(),
  recordBrowserDiscovery: vi.fn(),
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

const deliveryOutboxMocks = vi.hoisted(() => ({
  drainSearchEmailDeliveryGroup: vi.fn(),
  finalizeSearchEmailDeliveryGroup: vi.fn(),
  getSafeOfficialBookingUrl: vi.fn((value: unknown) =>
    typeof value === "string" ? value : undefined
  ),
  hydrateMatchAlertPayload: vi.fn(),
  hydrateSearchStatusEmailPayload: vi.fn(),
  listRetryableSearchEmailDeliveryGroups: vi.fn(),
  prepareSearchEmailDeliveryGroup: vi.fn(),
  suppressSearchEmailDeliveriesForMatches: vi.fn(),
  toSearchEmailJson: vi.fn(),
  preparedPayload: undefined as unknown
}));

const adapterMocks = vi.hoisted(() => ({
  fetchCpsTeeSheet: vi.fn(),
  fetchChelseaTeeSheet: vi.fn(),
  fetchChronogolfSlots: vi.fn(),
  fetchForeupTeeSheet: vi.fn(),
  fetchGolfBackTeeSheet: vi.fn(),
  fetchWebTracTeeSheet: vi.fn(),
  isChelseaMetadata: vi.fn(),
  isCpsMetadata: vi.fn(),
  isChronogolfMetadata: vi.fn(),
  isForeupMetadata: vi.fn(),
  isGolfBackMetadata: vi.fn()
  ,isWebTracMetadata: vi.fn()
}));

const supportIncidentMocks = vi.hoisted(() => ({
  notifyCourseSupportIssueBatch: vi.fn(),
  reportCourseSupportIssue: vi.fn(),
  resolveCourseSupportIncident: vi.fn()
}));

const monitoringDiscoveryMocks = vi.hoisted(() => ({
  prepareSearchMonitoring: vi.fn()
}));

const providerRequestLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/email/alerts", () => emailMocks);
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryOutboxMocks);
vi.mock("@/lib/adapters/foreup", () => adapterMocks);
vi.mock("@/lib/adapters/cps", () => ({
  fetchCpsTeeSheet: adapterMocks.fetchCpsTeeSheet,
  isCpsMetadata: adapterMocks.isCpsMetadata,
  isCpsAutomationPolicyBlockedError: (error: unknown) =>
    error instanceof Error && error.name === "CpsAutomationPolicyBlockedError"
}));
vi.mock("@/lib/adapters/golfback", () => adapterMocks);
vi.mock("@/lib/adapters/webtrac", () => adapterMocks);
vi.mock("@/lib/adapters/chelsea", () => adapterMocks);
vi.mock("@/lib/adapters/chronogolf", () => adapterMocks);
vi.mock("@/lib/automation/support-incidents", () => supportIncidentMocks);
vi.mock("@/lib/automation/search-monitoring-discovery", () => monitoringDiscoveryMocks);
vi.mock("@/lib/automation/provider-request-lease", () => providerRequestLeaseMocks);

import { buildMatchDeliveryGroupKey, runSearchCheck } from "./search-check";

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
  alertGeneration: 0,
  additionalEmails: [],
  user: { email: "player@resend.dev" },
  preferences: [
    {
      rank: 1,
      course: {
        id: "course-1",
        name: "Official Site Only Course",
        address: "1 Main Street, Glastonbury, CT 06033",
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
  availabilityCycle: 0,
  course: {
    id: "course-1",
    name: "Available Course",
    address: "1 Main Street, Glastonbury, CT 06033",
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

describe("buildMatchDeliveryGroupKey", () => {
  it("creates a new idempotency group when the same tee time reopens", () => {
    const initial = buildMatchDeliveryGroupKey([
      { id: "match-1", availabilityCycle: 0 }
    ]);
    const reopened = buildMatchDeliveryGroupKey([
      { id: "match-1", availabilityCycle: 1 }
    ]);

    expect(reopened).not.toBe(initial);
    expect(
      buildMatchDeliveryGroupKey([
        { id: "match-2", availabilityCycle: 4 },
        { id: "match-1", availabilityCycle: 1 }
      ])
    ).toBe(
      buildMatchDeliveryGroupKey([
        { id: "match-1", availabilityCycle: 1 },
        { id: "match-2", availabilityCycle: 4 }
      ])
    );
  });
});

describe("runSearchCheck email cadence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:10:00.000Z"));
    dbMocks.startAutomationRun.mockResolvedValue({ id: "run-1" });
    dbMocks.finishAutomationRun.mockResolvedValue(undefined);
    dbMocks.heartbeatSearchCheckLease.mockResolvedValue(true);
    dbMocks.isSearchCheckLeaseCurrent.mockResolvedValue(true);
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({ ...search });
    dbMocks.runWithSearchCheckLease.mockImplementation(async (_searchId, worker) => ({
      acquired: true,
      value: await worker({
        searchId: "search-1",
        scheduleVersion: 1,
        token: "check-lease",
        expiresAt: new Date("2026-07-11T12:25:00.000Z")
      })
    }));
    providerRequestLeaseMocks.runWithProviderRequestLease.mockImplementation(
      async (_providerFamily, worker) => ({ acquired: true, value: await worker() })
    );
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
    deliveryOutboxMocks.toSearchEmailJson.mockImplementation((value) =>
      JSON.parse(JSON.stringify(value))
    );
    deliveryOutboxMocks.getSafeOfficialBookingUrl.mockImplementation((value: unknown) =>
      typeof value === "string" ? value : undefined
    );
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue([]);
    deliveryOutboxMocks.prepareSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        deliveryOutboxMocks.preparedPayload = input.payload;
        return { prepared: true, deliveries: [] };
      }
    );
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        await input.send({
          recipient: "player@resend.dev",
          idempotencyKey: "tee-search-delivery-delivery-1",
          payload: deliveryOutboxMocks.preparedPayload
        });
        return [{ id: "delivery-1", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.hydrateSearchStatusEmailPayload.mockImplementation(
      async (payload) => ({
        ...payload.statusReport,
        checkedAt: new Date(payload.checkedAt)
      })
    );
    deliveryOutboxMocks.hydrateMatchAlertPayload.mockResolvedValue({
      matches: [
        {
          courseId: "course-1",
          courseName: "Available Course",
          courseRank: 1,
          courseAddress: "1 Main Street, Glastonbury, CT 06033",
          courseTimeZone: "America/New_York",
          startsAt: new Date("2026-07-12T12:00:00.000Z"),
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          priceCents: null,
          holes: 18,
          bookableHoleCounts: [9, 18],
          isNew: true
        }
      ],
      userTimeZone: "America/New_York",
      targetDate: "2026-07-12",
      startTime: "07:00",
      endTime: "10:00",
      players: 2,
      requestedLayoutHoles: null,
      checkedAt: new Date("2026-07-11T12:10:00.000Z")
    });
    deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches.mockResolvedValue({
      count: 0
    });
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockResolvedValue({
      finalized: true,
      status: "SENT"
    });
    adapterMocks.isForeupMetadata.mockReturnValue(true);
    adapterMocks.isCpsMetadata.mockReturnValue(false);
    adapterMocks.fetchCpsTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    adapterMocks.isGolfBackMetadata.mockReturnValue(false);
    adapterMocks.fetchGolfBackTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
    adapterMocks.isWebTracMetadata.mockReturnValue(false);
    adapterMocks.fetchWebTracTeeSheet.mockResolvedValue({
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
      deferredCourseIds: [],
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
    expect(deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "SETUP" })
    );
    expect(result).toEqual(
      expect.objectContaining({ newlyAlertedMatches: 1, statusEmailOutcome: "sent" })
    );
  });

  it("flows the persisted pending state into setup-report NEW rows", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Monitored Course",
            detectedPlatform: "FOREUP",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: { courseId: "course-1" }
          }
        }
      ]
    });
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [
        {
          sourceId: "slot-1",
          courseId: "course-1",
          startsAt: "2026-07-12T08:10:00-04:00",
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          priceCents: 6200,
          bookableHoleCounts: [9, 18]
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    dbMocks.recordTeeTimeMatch.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING"
    });

    await runSearchCheck("search-1", "test");

    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "setup",
        courses: [
          expect.objectContaining({
            rank: 1,
            courseAddress: "1 Main Street, Glastonbury, CT 06033",
            matchingTimes: [
              expect.objectContaining({
                startsAt: "2026-07-12T08:10:00-04:00",
                bookableHoleCounts: [9, 18],
                isNew: true
              })
            ]
          })
        ]
      })
    );
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
  });

  it("lets a new-opening email satisfy the morning update instead of sending twice", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Available Course",
            detectedPlatform: "FOREUP",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: { courseId: "course-1" }
          }
        }
      ]
    });
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [
        {
          sourceId: "slot-1",
          courseId: "course-1",
          startsAt: "2026-07-12T08:00:00-04:00",
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          priceCents: 6100,
          bookableHoleCounts: [9, 18]
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        targetDate: "2026-07-12",
        startTime: "07:00",
        endTime: "10:00",
        players: 2,
        matches: [
          expect.objectContaining({
            courseId: "course-1",
            courseRank: 1,
            courseAddress: "1 Main Street, Glastonbury, CT 06033",
            bookableHoleCounts: [9, 18],
            isNew: true
          })
        ]
      })
    );
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalled();
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MATCH",
        payload: expect.objectContaining({
          satisfiesStatusReport: true,
          statusSnapshot: expect.any(Array)
        })
      })
    );
    expect(deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MATCH" })
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

  it("falls back to a safe official homepage when the detected booking URL is restricted", async () => {
    const restrictedBookingUrl = "https://example.com/checkout?session=private";
    const officialHomepage = "https://example.com/course";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedBookingUrl: restrictedBookingUrl,
            website: officialHomepage
          }
        }
      ]
    });
    deliveryOutboxMocks.getSafeOfficialBookingUrl.mockImplementation(
      (value: unknown) =>
        typeof value === "string" && value !== restrictedBookingUrl
          ? value
          : undefined
    );

    const result = await runSearchCheck("search-1", "test");

    expect(result.courseResults[0]).toEqual(
      expect.objectContaining({
        bookingUrl: officialHomepage,
        bookingAccess: "OFFICIAL_SITE"
      })
    );
    expect(deliveryOutboxMocks.getSafeOfficialBookingUrl).toHaveBeenCalledWith(
      restrictedBookingUrl
    );
    expect(deliveryOutboxMocks.getSafeOfficialBookingUrl).toHaveBeenCalledWith(
      officialHomepage
    );
  });

  it("defers for provider capacity without suppressing a pending available match", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-11T12:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "FOREUP",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: { courseId: "course-1" }
          }
        }
      ]
    });
    providerRequestLeaseMocks.runWithProviderRequestLease.mockResolvedValue({
      acquired: false
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([pendingMatch]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([pendingMatch]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.supportRetryNeeded).toBe(true);
    expect(supportIncidentMocks.reportCourseSupportIssue).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches
    ).not.toHaveBeenCalled();
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).not.toHaveBeenCalled();
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
  });

  it("retries a transient provider failure without suppressing a pending available match", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-11T12:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "FOREUP",
            detectedBookingUrl: "https://foreupsoftware.com/booking/course-1",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: { courseId: "course-1" }
          }
        }
      ]
    });
    adapterMocks.fetchForeupTeeSheet.mockRejectedValue(new Error("fetch failed"));
    dbMocks.listPendingMatchAlerts.mockResolvedValue([pendingMatch]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([pendingMatch]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.supportRetryNeeded).toBe(true);
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "FETCH_FAILED" })
    );
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches
    ).not.toHaveBeenCalled();
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).not.toHaveBeenCalled();
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
  });

  it("persists and applies an official CPS robots-policy block without opening another support incident", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: "https://policy-blocked.cps.golf/",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              provider: "CPS",
              siteName: "policy-blocked",
              bookingBaseUrl: "https://policy-blocked.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    const policyError = Object.assign(
      new Error("Official robots policy blocks required endpoints"),
      {
        name: "CpsAutomationPolicyBlockedError",
        bookingUrl: "https://policy-blocked.cps.golf/",
        policyUrl: "https://policy-blocked.cps.golf/robots.txt"
      }
    );
    adapterMocks.fetchCpsTeeSheet.mockRejectedValue(policyError);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.courseResults).toEqual([
      expect.objectContaining({
        outcome: "BLOCKED_POLICY",
        bookingUrl: "https://policy-blocked.cps.golf/"
      })
    ]);
    expect(dbMocks.recordBrowserDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-1",
        status: "BLOCKED",
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
        sourceUrl: "https://policy-blocked.cps.golf/robots.txt"
      })
    );
    expect(dbMocks.applyBrowserDiscoveryToCourse).toHaveBeenCalledWith(
      expect.objectContaining({ automationReason: "AUTOMATION_PROHIBITED" })
    );
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "BLOCKED_POLICY" })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).not.toHaveBeenCalled();
  });

  it("retries a persisted match delivery group even after no match remains globally pending", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-11T12:00:00.000Z")
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue([
      {
        kind: "MATCH",
        groupKey: "persisted-match-group",
        createdAt: new Date("2026-07-11T12:00:00.000Z")
      }
    ]);

    await runSearchCheck("search-1", "test");

    expect(deliveryOutboxMocks.drainSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MATCH",
        groupKey: "persisted-match-group"
      })
    );
    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
  });

  it("continues to newer owner delivery when an old group only has an additional-recipient retry pending", async () => {
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue([
      {
        kind: "MATCH",
        groupKey: "old-match-group",
        createdAt: new Date("2026-07-11T11:00:00.000Z")
      },
      {
        kind: "DAILY",
        groupKey: "old-daily-group",
        createdAt: new Date("2026-07-11T11:30:00.000Z")
      }
    ]);
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        if (input.groupKey === "old-match-group") {
          throw new Error("additional recipient delivery failed");
        }
        if (input.groupKey === "old-daily-group") {
          return [{ id: "old-daily-delivery", status: "SENT" }];
        }
        await input.send({
          recipient: "player@resend.dev",
          idempotencyKey: "tee-search-delivery-delivery-1",
          payload: deliveryOutboxMocks.preparedPayload
        });
        return [{ id: "delivery-1", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockImplementation(
      async (input) =>
        input.groupKey === "old-match-group"
          ? {
              finalized: false,
              reason: "not_terminal",
              ownerFinalized: true
            }
          : { finalized: true, status: "SENT", ownerSent: true }
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await runSearchCheck("search-1", "test");

      expect(
        deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mock.calls.map(
          ([input]) => input.groupKey
        )
      ).toEqual([
        "old-match-group",
        "old-daily-group",
        expect.stringMatching(/^setup-/)
      ]);
      expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
      expect(result).toEqual(
        expect.objectContaining({ newlyAlertedMatches: 1, statusEmailOutcome: "sent" })
      );
      expect(warning).toHaveBeenCalledWith(
        "[email:additional-recipient-retry-pending]",
        expect.objectContaining({ kind: "MATCH" })
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("tries every old delivery group but blocks newer delivery while an owner remains unresolved", async () => {
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue([
      {
        kind: "MATCH",
        groupKey: "unresolved-owner-group",
        createdAt: new Date("2026-07-11T11:00:00.000Z")
      },
      {
        kind: "DAILY",
        groupKey: "independent-retry-group",
        createdAt: new Date("2026-07-11T11:30:00.000Z")
      }
    ]);
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        if (input.groupKey === "unresolved-owner-group") {
          throw new Error("owner delivery failed");
        }
        return [{ id: "delivery-1", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockImplementation(
      async (input) =>
        input.groupKey === "unresolved-owner-group"
          ? {
              finalized: false,
              reason: "not_terminal",
              ownerFinalized: false
            }
          : { finalized: true, status: "SENT", ownerSent: true }
    );

    await expect(runSearchCheck("search-1", "test")).rejects.toThrow(
      "owner delivery failed"
    );

    expect(
      deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mock.calls.map(
        ([input]) => input.groupKey
      )
    ).toEqual(["unresolved-owner-group", "independent-retry-group"]);
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalled();
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
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
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
      deferredCourseIds: [],
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

  it("defers an unsupported incident until official-site discovery acquires capacity", async () => {
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
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      deferredCourseIds: ["course-1"],
      retryCourseIds: ["course-1"]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toEqual(
      expect.objectContaining({
        outcome: "NEEDS_ADAPTER",
        message: expect.stringContaining("will retry shortly")
      })
    );
    expect(result.supportRetryNeeded).toBe(true);
  });

  it("does not open an unsupported incident when discovery preparation fails", async () => {
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
    monitoringDiscoveryMocks.prepareSearchMonitoring.mockRejectedValue(
      new Error("discovery state unavailable")
    );
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).not.toHaveBeenCalled();
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

  it("passes a stored official rule page to ForeUP when refreshing booking-window evidence", async () => {
    const evidenceUrl = "https://www.tashuaknolls.com/tee-times-fees/reservations/";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "FOREUP",
            detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              scheduleId: 6654,
              bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
            },
            bookingWindowEvidenceUrl: evidenceUrl,
            bookingWindowCheckedAt: new Date("2026-05-01T12:00:00.000Z"),
            bookingWindowObservedAt: new Date("2026-05-01T12:00:00.000Z")
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        discoverBookingWindow: true,
        metadata: expect.objectContaining({ bookingWindowEvidenceUrl: evidenceUrl })
      })
    );
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
    adapterMocks.fetchChronogolfSlots.mockResolvedValueOnce([{
      sourceId: "blue-rock-2026-07-12-0800",
      startsAt: "2026-07-12T08:00",
      availableSpots: 4,
      bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
      bookableHoleCounts: [9, 18]
    }]);
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
        outcome: "NO_MATCH",
        rawSummary: expect.objectContaining({ bookableHoleCounts: [9, 18] })
      })
    );
    expect(supportIncidentMocks.resolveCourseSupportIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        resolution: "MONITORING_RESTORED"
      })
    );
  });

  it("persists a booking window and ignores provider-visible slots until public release", async () => {
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
      slots: [
        {
          courseId: "dennis-highland",
          sourceId: "provider-visible-before-release",
          startsAt: "2026-08-15T08:00",
          availableSpots: 4,
          bookingUrl: "https://dennis.chelseareservations.com/"
        }
      ],
      targetDateStatus: "OPEN",
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
    expect(dbMocks.recordTeeTimeMatch).not.toHaveBeenCalled();
  });

  it("dispatches reusable GolfBack metadata to the public adapter", async () => {
    const bookingBaseUrl =
      "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [{
        rank: 1,
        course: {
          ...search.preferences[0].course,
          id: "windsor-parke",
          name: "Windsor Parke Golf Club",
          detectedPlatform: "CUSTOM",
          detectedBookingUrl: bookingBaseUrl,
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          policyNotes: "Public availability is exposed without login; booking stays on GolfBack.",
          bookingMetadata: {
            provider: "GOLFBACK",
            courseId: "5a90fb0c-b928-43f0-9486-d5d43c03d25d",
            bookingBaseUrl
          }
        }
      }]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(false);
    adapterMocks.isChelseaMetadata.mockReturnValue(false);
    adapterMocks.isGolfBackMetadata.mockReturnValue(true);

    await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchGolfBackTeeSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "windsor-parke",
        players: 2,
        timeZone: "America/New_York",
        metadata: expect.objectContaining({ provider: "GOLFBACK", bookingBaseUrl })
      })
    );
  });

  it("dispatches reusable WebTrac metadata to the signed-out search adapter", async () => {
    const bookingBaseUrl =
      "https://myffr.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [{
        rank: 1,
        course: {
          ...search.preferences[0].course,
          id: "casa-linda",
          name: "Casa Linda Oaks Golf Club",
          detectedPlatform: "CUSTOM",
          detectedBookingUrl: bookingBaseUrl,
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          policyNotes: "Read-only signed-out search; booking remains on WebTrac.",
          bookingMetadata: {
            provider: "WEBTRAC",
            courseCode: "25",
            bookingBaseUrl
          }
        }
      }]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(false);
    adapterMocks.isChelseaMetadata.mockReturnValue(false);
    adapterMocks.isGolfBackMetadata.mockReturnValue(false);
    adapterMocks.isWebTracMetadata.mockReturnValue(true);

    await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchWebTracTeeSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "casa-linda",
        players: 2,
        metadata: expect.objectContaining({ provider: "WEBTRAC", courseCode: "25" })
      })
    );
  });
});
