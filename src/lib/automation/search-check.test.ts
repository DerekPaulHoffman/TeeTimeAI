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
  getRenderedTeeTimeAlertMatchIds: vi.fn((matches: Array<{ matchId: string }>) =>
    matches.slice(0, 8).map((match) => match.matchId)
  ),
  sendSearchStatusEmail: vi.fn(),
  sendTeeTimeAlert: vi.fn()
}));

const deliveryOutboxMocks = vi.hoisted(() => ({
  drainSearchEmailDeliveryGroup: vi.fn(),
  finalizeSearchEmailDeliveryGroup: vi.fn(),
  getPendingStatusEmailReplacement: vi.fn(),
  getSafeOfficialBookingUrl: vi.fn((value: unknown) =>
    typeof value === "string" ? value : undefined
  ),
  hydrateMatchAlertPayload: vi.fn(),
  hydrateSearchStatusEmailPayload: vi.fn(),
  listRetryableSearchEmailDeliveryGroups: vi.fn(),
  prepareRecipientMatchDeliveryGroups: vi.fn(),
  prepareSearchEmailDeliveryGroup: vi.fn(),
  satisfyPendingDailyStatusReplacementWithMatch: vi.fn(),
  suppressSearchEmailDeliveriesForMatches: vi.fn(),
  toSearchEmailJson: vi.fn(),
  preparedPayload: undefined as unknown
}));

const adapterMocks = vi.hoisted(() => ({
  fetchCpsTeeSheet: vi.fn(),
  fetchChelseaTeeSheet: vi.fn(),
  fetchChronogolfSlots: vi.fn(),
  fetchClubCaddieTeeSheet: vi.fn(),
  fetchForeupTeeSheet: vi.fn(),
  fetchGolfBackTeeSheet: vi.fn(),
  fetchWebTracTeeSheet: vi.fn(),
  isChelseaMetadata: vi.fn(),
  isCpsMetadata: vi.fn(),
  isChronogolfMetadata: vi.fn(),
  isClubCaddieMetadata: vi.fn(),
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
  isCpsMetadata: adapterMocks.isCpsMetadata
}));
vi.mock("@/lib/adapters/golfback", () => adapterMocks);
vi.mock("@/lib/adapters/webtrac", () => adapterMocks);
vi.mock("@/lib/adapters/chelsea", () => adapterMocks);
vi.mock("@/lib/adapters/chronogolf", () => adapterMocks);
vi.mock("@/lib/adapters/clubcaddie", () => adapterMocks);
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
  alertStatus: "PENDING",
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
    dbMocks.recordTeeTimeMatch.mockImplementation(async (input) => ({
      id: String(input.sourceId).replace(/^slot-/, "match-"),
      alertStatus: "PENDING",
      availabilityCycle: 0
    }));
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
    deliveryOutboxMocks.getPendingStatusEmailReplacement.mockResolvedValue(null);
    deliveryOutboxMocks.satisfyPendingDailyStatusReplacementWithMatch.mockResolvedValue({
      current: true,
      count: 1
    });
    deliveryOutboxMocks.prepareSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        deliveryOutboxMocks.preparedPayload = input.payload;
        return { prepared: true, deliveries: [], continuationGroups: [] };
      }
    );
    deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups.mockImplementation(
      async (input) => {
        deliveryOutboxMocks.preparedPayload = input.payload;
        return {
          prepared: true,
          groups: [{ groupKey: `recipient-${input.sourceGroupKey}`, recipient: "player@resend.dev" }]
        };
      }
    );
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        await input.send({
          recipient: "player@resend.dev",
          idempotencyKey: "tee-search-delivery-delivery-1",
          payload: deliveryOutboxMocks.preparedPayload,
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
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
      status: "SENT",
      ownerSent: true,
      retainedMatchCount: 1,
      sentMatchCount: 1
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
    adapterMocks.isClubCaddieMetadata.mockReturnValue(false);
    adapterMocks.fetchClubCaddieTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
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

  it("does not cover or count a pending match omitted from the setup report", async () => {
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
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({ matchIds: [] })
      })
    );
    expect(result).toEqual(
      expect.objectContaining({ newlyAlertedMatches: 0, statusEmailOutcome: "sent" })
    );
  });

  it("replaces a stale attempted setup with current content and a distinct logical key", async () => {
    deliveryOutboxMocks.getPendingStatusEmailReplacement.mockResolvedValue({
      kind: "SETUP",
      groups: [
        { kind: "SETUP", groupKey: "stale-setup-group" },
        { kind: "DAILY", groupKey: "stale-daily-group" }
      ],
      anyRecipientReached: false,
      ownerSent: false
    });

    const result = await runSearchCheck("search-1", "test");

    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        groupKey: expect.stringMatching(
          /^setup-[a-f0-9]+-replacement-[a-f0-9]+$/
        ),
        supersededStatusGroups: [
          { kind: "SETUP", groupKey: "stale-setup-group" },
          { kind: "DAILY", groupKey: "stale-daily-group" }
        ]
      })
    );
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ statusEmailOutcome: "sent" })
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
    dbMocks.listPendingMatchAlerts.mockResolvedValue([
      {
        ...pendingMatch,
        startsAt: new Date("2026-07-12T12:10:00.000Z")
      }
    ]);

    const result = await runSearchCheck("search-1", "test");

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
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({ matchIds: ["match-1"] })
      })
    );
    expect(result.newlyAlertedMatches).toBe(1);
  });

  it("covers only pending matches rendered within the setup email row limit", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
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
    const localStartsAt = Array.from({ length: 9 }, (_, index) => {
      const totalMinutes = 7 * 60 + index * 20;
      const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
      const minutes = String(totalMinutes % 60).padStart(2, "0");
      return `2026-07-12T${hours}:${minutes}:00-04:00`;
    });
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: localStartsAt.map((startsAt, index) => ({
        sourceId: `slot-${index + 1}`,
        courseId: "course-1",
        startsAt,
        availableSpots: 4,
        bookingUrl: "https://example.com/book",
        priceCents: 6200,
        bookableHoleCounts: [9, 18]
      })),
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue(
      localStartsAt.map((startsAt, index) => ({
        ...pendingMatch,
        id: `match-${index + 1}`,
        startsAt: new Date(startsAt)
      }))
    );

    const result = await runSearchCheck("search-1", "test");

    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({
          matchIds: localStartsAt.slice(0, 8).map((_, index) => `match-${index + 1}`)
        })
      })
    );
    expect(result.newlyAlertedMatches).toBe(8);
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
    expect(deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("uses the persisted match id when two rows share one course and tee time", async () => {
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
          sourceId: "slot-current",
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
    dbMocks.recordTeeTimeMatch.mockResolvedValue({
      id: "match-current",
      alertStatus: "PENDING",
      availabilityCycle: 2
    });
    const sharedStart = new Date("2026-07-12T12:00:00.000Z");
    const stale = {
      ...pendingMatch,
      id: "match-stale",
      availabilityCycle: 1,
      startsAt: sharedStart
    };
    const current = {
      ...pendingMatch,
      id: "match-current",
      availabilityCycle: 2,
      startsAt: sharedStart
    };
    dbMocks.listPendingMatchAlerts.mockResolvedValue([stale, current]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([stale, current]);

    await runSearchCheck("search-1", "test");

    expect(deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          matchIds: ["match-current"],
          matchRefs: [{ matchId: "match-current", availabilityCycle: 2 }],
          displayMatchIds: ["match-current"]
        })
      })
    );
  });

  it("keeps a ninth same-course opening pending when the MATCH email renders eight rows", async () => {
    const localStartsAt = Array.from({ length: 9 }, (_, index) => {
      const totalMinutes = 7 * 60 + index * 20;
      const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
      const minutes = String(totalMinutes % 60).padStart(2, "0");
      return `2026-07-12T${hours}:${minutes}:00-04:00`;
    });
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
      slots: localStartsAt.map((startsAt, index) => ({
        sourceId: `slot-${index + 1}`,
        courseId: "course-1",
        startsAt,
        availableSpots: 4,
        bookingUrl: "https://example.com/book",
        priceCents: 6100,
        bookableHoleCounts: [9, 18]
      })),
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    const matches = localStartsAt.map((startsAt, index) => ({
      ...pendingMatch,
      id: `match-${index + 1}`,
      startsAt: new Date(startsAt)
    }));
    dbMocks.listPendingMatchAlerts.mockResolvedValue(matches);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue(matches);
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockResolvedValue({
      finalized: true,
      status: "SENT",
      ownerSent: true,
      retainedMatchCount: 8,
      sentMatchCount: 8
    });

    const result = await runSearchCheck("search-1", "test");

    const renderedIds = localStartsAt
      .slice(0, 8)
      .map((_, index) => `match-${index + 1}`);
    expect(deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          matchIds: renderedIds,
          displayMatchIds: renderedIds,
          matchReport: expect.objectContaining({
            matches: expect.arrayContaining(
              renderedIds.map((matchId) => expect.objectContaining({ matchId }))
            )
          })
        })
      })
    );
    const preparedPayload =
      deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups.mock.calls[0]?.[0]
        .payload;
    expect(preparedPayload.matchReport.matches).toHaveLength(8);
    expect(preparedPayload.matchIds).not.toContain("match-9");
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 8,
        statusEmailOutcome: "covered_by_match_alert"
      })
    );
  });

  it("sends the daily update when a prepared MATCH group sends no valid match email", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z"),
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
    dbMocks.recordTeeTimeMatch.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING"
    });
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        if (input.kind === "MATCH") {
          return [{ id: "delivery-1", status: "SUPPRESSED" }];
        }
        await input.send({
          recipient: "player@resend.dev",
          idempotencyKey: "tee-search-delivery-daily",
          payload: deliveryOutboxMocks.preparedPayload,
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
        });
        return [{ id: "daily-delivery", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockImplementation(
      async (input) =>
        input.kind === "MATCH"
          ? {
              finalized: true,
              status: "SUPPRESSED",
              ownerSent: false,
              retainedMatchCount: 0,
              sentMatchCount: 0
            }
          : {
              finalized: true,
              status: "SENT",
              ownerSent: true,
              retainedMatchCount: 0,
              sentMatchCount: 0
            }
    );

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 0,
        statusEmailOutcome: "sent"
      })
    );
  });

  it("does not duplicate a daily update while an owner match obligation is still retryable", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z"),
      additionalEmails: ["friend@resend.dev"],
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
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [
        {
          sourceId: "slot-1",
          courseId: "course-1",
          startsAt: "2026-07-12T08:00:00-04:00",
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          priceCents: 6100,
          bookableHoleCounts: [18]
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups.mockImplementation(
      async (input) => {
        deliveryOutboxMocks.preparedPayload = input.payload;
        return {
          prepared: true,
          hasExistingObligation: false,
          groups: [
            { groupKey: "owner-match", recipient: "player@resend.dev" },
            { groupKey: "friend-match", recipient: "friend@resend.dev" }
          ]
        };
      }
    );
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        if (input.groupKey === "owner-match") {
          throw new Error("owner delivery pending");
        }
        await input.send({
          recipient: "friend@resend.dev",
          idempotencyKey: "friend-match-key",
          payload: deliveryOutboxMocks.preparedPayload,
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
        });
        return [{ id: "friend-delivery", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockResolvedValue({
      finalized: true,
      status: "SENT",
      ownerSent: false,
      retainedMatchCount: 1,
      sentMatchCount: 0
    });

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 0,
        statusEmailOutcome: "covered_by_match_alert"
      })
    );
  });

  it("lets a freshly sent owner MATCH retry satisfy and retire the pending daily replacement", async () => {
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce({
        ...search,
        statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z")
      })
      .mockResolvedValue({
        ...search,
        statusEmailSentAt: new Date("2026-07-11T12:10:00.000Z")
      });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups
      .mockResolvedValueOnce([
        {
          kind: "MATCH",
          groupKey: "owner-retry",
          createdAt: new Date("2026-07-11T11:00:00.000Z"),
          ownerRetryable: true
        }
      ])
      .mockResolvedValue([]);
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        await input.send({
          recipient: "player@resend.dev",
          idempotencyKey: "owner-retry-key",
          payload: { schemaVersion: 2, checkedAt: "2026-07-11T12:10:00.000Z" },
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
        });
        return [{ id: "owner-retry", status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockResolvedValue({
      finalized: true,
      status: "SENT",
      ownerSent: true,
      retainedMatchCount: 1,
      sentMatchCount: 1
    });
    deliveryOutboxMocks.getPendingStatusEmailReplacement.mockResolvedValue({
      kind: "DAILY",
      groups: [{ kind: "DAILY", groupKey: "stale-daily" }],
      anyRecipientReached: false,
      ownerSent: false
    });
    dbMocks.markSearchStatusEmailSent.mockResolvedValue({ count: 1 });

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalled();
    expect(dbMocks.markSearchStatusEmailSent).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        alertGeneration: 0,
        checkLeaseToken: "check-lease",
        snapshot: expect.any(Array)
      })
    );
    expect(
      deliveryOutboxMocks.satisfyPendingDailyStatusReplacementWithMatch
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        groups: [{ kind: "DAILY", groupKey: "stale-daily" }]
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 1,
        statusEmailOutcome: "covered_by_match_alert"
      })
    );
  });

  it("does not treat an already-sent owner as newly delivered when only a friend retry runs", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-10T13:00:00.000Z")
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups
      .mockResolvedValueOnce([
        {
          kind: "MATCH",
          groupKey: "friend-retry",
          createdAt: new Date("2026-07-11T11:00:00.000Z"),
          ownerRetryable: false
        }
      ])
      .mockResolvedValue([]);
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementation(
      async (input) => {
        await input.send({
          recipient:
            input.kind === "MATCH"
              ? "friend@resend.dev"
              : "player@resend.dev",
          idempotencyKey: `${input.kind.toLowerCase()}-retry-key`,
          payload:
            input.kind === "MATCH"
              ? { schemaVersion: 2, checkedAt: "2026-07-11T12:10:00.000Z" }
              : deliveryOutboxMocks.preparedPayload,
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
        });
        return [{ id: `${input.kind.toLowerCase()}-delivery`, status: "SENT" }];
      }
    );
    deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup.mockImplementation(
      async (input) =>
        input.kind === "MATCH"
          ? {
              finalized: true,
              status: "SENT",
              ownerSent: true,
              retainedMatchCount: 1,
              sentMatchCount: 1
            }
          : {
              finalized: true,
              status: "SENT",
              ownerSent: true,
              retainedMatchCount: 0,
              sentMatchCount: 0
            }
    );

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
    expect(dbMocks.markSearchStatusEmailSent).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 0,
        statusEmailOutcome: "sent"
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
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(dbMocks.recordCourseProbe).not.toHaveBeenCalled();
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
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "FETCH_FAILED",
        rawSummary: {
          providerExecution: "RUNNABLE_PROVIDER_CHECK"
        }
      })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "FETCH_FAILED" })
    );
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches
    ).not.toHaveBeenCalled();
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).not.toHaveBeenCalled();
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
  });

  it("keeps a CPS access failure in engineering instead of creating a policy block", async () => {
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
    adapterMocks.fetchCpsTeeSheet.mockRejectedValue(
      new Error("CPS configuration returned 403")
    );
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.courseResults).toEqual([
      expect.objectContaining({
        outcome: "FETCH_FAILED",
        bookingUrl: "https://policy-blocked.cps.golf/"
      })
    ]);
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "FETCH_FAILED",
        message: "CPS configuration returned 403",
        rawSummary: {
          providerExecution: "RUNNABLE_PROVIDER_CHECK"
        }
      })
    );
    expect(dbMocks.recordBrowserDiscovery).not.toHaveBeenCalled();
    expect(dbMocks.applyBrowserDiscoveryToCourse).not.toHaveBeenCalled();
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-1" }),
        kind: "FETCH_FAILED"
      })
    );
    expect(supportIncidentMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
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
          payload: deliveryOutboxMocks.preparedPayload,
          assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
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
          : {
              finalized: true,
              status: "SENT",
              ownerSent: true,
              retainedMatchCount: 0,
              sentMatchCount: 0
            }
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
        expect.objectContaining({ newlyAlertedMatches: 0, statusEmailOutcome: "sent" })
      );
      expect(warning).toHaveBeenCalledWith(
        "[email:additional-recipient-retry-pending]",
        expect.objectContaining({ kind: "MATCH" })
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("tries every old delivery group without blocking newer delivery on one unresolved owner", async () => {
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
          : {
              finalized: true,
              status: "SENT",
              ownerSent: true,
              retainedMatchCount: 0,
              sentMatchCount: 0
            }
    );

    const result = await runSearchCheck("search-1", "test");

    expect(
      deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mock.calls.map(
        ([input]) => input.groupKey
      )
    ).toEqual([
      "unresolved-owner-group",
      "independent-retry-group",
      expect.stringMatching(/^setup-/)
    ]);
    expect(result).toEqual(
      expect.objectContaining({ outcome: "success", statusEmailOutcome: "sent" })
    );
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

  it("runs a runnable public adapter despite legacy policy-only evidence", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            detectedBookingUrl:
              "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
            automationEligibility: "BLOCKED",
            automationReason: "AUTOMATION_PROHIBITED",
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledTimes(1);
    expect(result.courseResults[0]).toMatchObject({ outcome: "NO_MATCH" });
  });

  it("reconciles a pending match before reporting a current technical final", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    const result = await runSearchCheck("search-1", "test");

    expect(providerRequestLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith({
      searchId: "search-1",
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-12",
      timeZone: "America/New_York",
      confirmedMatches: []
    });
    expect(dbMocks.listPendingMatchAlerts).toHaveBeenCalledWith("search-1");
    expect(dbMocks.markMatchAlertSuppressed).not.toHaveBeenCalled();
    expect(deliveryOutboxMocks.prepareSearchEmailDeliveryGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({ matchIds: [] })
      })
    );
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "BLOCKED_AUTH",
        rawSummary: expect.objectContaining({
          automationReason: "CAPTCHA_OR_QUEUE"
        })
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "BLOCKED_AUTH",
      automationReason: "CAPTCHA_OR_QUEUE",
      monitoringDisposition: "TECHNICAL_FINAL"
    });
    expect(result.newlyAlertedMatches).toBe(0);
  });

  it("reconciles historical matches gone when a course is identity final", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: false,
            automationEligibility: "BLOCKED",
            automationReason: "OTHER",
            bookingMethod: "CONTACT_COURSE"
          }
        }
      ]
    });

    const result = await runSearchCheck("search-1", "test");

    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith({
      searchId: "search-1",
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-12",
      timeZone: "America/New_York",
      confirmedMatches: []
    });
    expect(result.courseResults[0]).toMatchObject({
      monitoringDisposition: "IDENTITY_FINAL",
      availableMatches: 0,
      bookingUrl: undefined,
      phone: undefined,
      bookingAccess: undefined
    });
  });

  it("keeps an expired private identity paused without closing its support incident", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: false,
            automationEligibility: "BLOCKED",
            automationReason: "OTHER",
            bookingMethod: "CONTACT_COURSE",
            bookingPhone: "+1 (203) 555-0100",
            detectedBookingUrl: "https://private.example/book",
            intelligenceVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-07-10T00:00:00.000Z"),
            intelligenceConfidence: 0.98
          }
        }
      ]
    });

    const result = await runSearchCheck("search-1", "test");

    expect(providerRequestLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(supportIncidentMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "BLOCKED_POLICY",
        message: expect.stringContaining("identity review is due"),
        rawSummary: expect.objectContaining({
          monitoringDisposition: "IDENTITY_RECHECK"
        })
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "BLOCKED_POLICY",
      monitoringDisposition: "IDENTITY_RECHECK",
      availableMatches: 0,
      bookingUrl: undefined,
      phone: undefined,
      bookingAccess: undefined,
      message: expect.stringContaining("monitoring remains paused")
    });
  });

  it("revalidates a stale technical reason by running the public adapter", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
            intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
            intelligenceConfidence: 0.95,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledTimes(1);
    expect(result.courseResults[0]).toMatchObject({ outcome: "NO_MATCH" });
  });

  it("records a manual final without calling an adapter", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "(860) 555-0102",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            intelligenceVerifiedAt: new Date("2026-07-11T11:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(providerRequestLeaseMocks.runWithProviderRequestLease).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        courseId: "course-1",
        confirmedMatches: []
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "BLOCKED_POLICY",
      automationReason: "NO_ONLINE_BOOKING",
      bookingAccess: "PHONE_ONLY",
      monitoringDisposition: "MANUAL_FINAL"
    });
  });

  it("revalidates stale raw manual metadata through the runnable adapter", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            bookingMethod: "WALK_IN",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            intelligenceVerifiedAt: new Date("2025-01-01T00:00:00.000Z"),
            intelligenceReviewAt: new Date("2025-02-01T00:00:00.000Z"),
            intelligenceConfidence: 0.95,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledTimes(1);
    expect(result.courseResults[0]).toMatchObject({ outcome: "NO_MATCH" });
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
            providerFamilyKey: "FOREUP",
            detectedBookingUrl:
              "https://foreupsoftware.com/index.php/booking/123#/teetimes",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              scheduleId: 123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/123#/teetimes"
            },
            bookingWindowDaysAhead: 14,
            bookingReleaseTimeLocal: "05:00",
            bookingWindowSource: "PROVIDER_CONFIG",
            bookingWindowConfidence: 1,
            bookingWindowEvidenceUrl:
              "https://foreupsoftware.com/index.php/booking/123#/teetimes",
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

  it("dispatches reusable Club Caddie metadata to the anonymous public adapter", async () => {
    const bookingBaseUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/public-course/slots";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [{
        rank: 1,
        course: {
          ...search.preferences[0].course,
          id: "ponemah",
          name: "Ponemah Green Family Golf Center",
          detectedPlatform: "CLUB_CADDIE",
          detectedBookingUrl: bookingBaseUrl,
          automationEligibility: "ALLOWED",
          automationReason: "NONE",
          policyNotes: "Read-only signed-out availability; booking remains on Club Caddie.",
          bookingMetadata: {
            provider: "CLUB_CADDIE",
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
    adapterMocks.isWebTracMetadata.mockReturnValue(false);
    adapterMocks.isClubCaddieMetadata.mockReturnValue(true);

    await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchClubCaddieTeeSheet).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "ponemah",
        players: 2,
        metadata: { provider: "CLUB_CADDIE", bookingBaseUrl }
      })
    );
  });
});
