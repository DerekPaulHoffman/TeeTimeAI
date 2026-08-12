import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  applyBrowserDiscoveryToCourse: vi.fn(),
  finishAutomationRun: vi.fn(),
  getActiveSearchForAutomation: vi.fn(),
  getCourseMonitoringPlaybookContext: vi.fn(),
  heartbeatSearchCheckLease: vi.fn(),
  isSearchCheckLeaseCurrent: vi.fn(),
  listAvailableMatchAlerts: vi.fn(),
  listPendingMatchAlerts: vi.fn(),
  listSearchCourseVerdictsSince: vi.fn(),
  markCourseBookingWindowChecked: vi.fn(),
  markMatchAlertSent: vi.fn(),
  markMatchAlertSuppressed: vi.fn(),
  markMissingMatchesUnavailable: vi.fn(),
  markSearchStatusEmailSent: vi.fn(),
  recordCourseBookingFacts: vi.fn(),
  recordCourseBookingWindowEvidence: vi.fn(),
  recordBrowserDiscovery: vi.fn(),
  recordCourseProbe: vi.fn(),
  recordCourseProbeIfChanged: vi.fn(),
  recordTeeTimeMatch: vi.fn(),
  runWithSearchCheckLease: vi.fn(),
  startAutomationRun: vi.fn()
}));

const emailMocks = vi.hoisted(() => ({
  getRenderedTeeTimeAlertMatchIds: vi.fn(
    (matches: Array<{ matchId: string }>) =>
      matches.slice(0, 8).map((match) => match.matchId)
  ),
  sendSearchStatusEmail: vi.fn(),
  sendTeeTimeAlert: vi.fn()
}));

const deliveryPolicyMocks = vi.hoisted(() => ({
  areSearchStatusEmailsEnabled: vi.fn(),
  isSearchEmailDeliveryEnabled: vi.fn()
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
  listReachedMonitoringFinals: vi.fn(),
  listReachedMonitoringOutages: vi.fn(),
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
  isGolfBackMetadata: vi.fn(),
  isWebTracMetadata: vi.fn()
}));

const supportIncidentMocks = vi.hoisted(() => ({
  reportCourseSupportIssue: vi.fn(),
  resolveCourseSupportIncident: vi.fn()
}));

const monitoringDiscoveryMocks = vi.hoisted(() => ({
  prepareSearchMonitoring: vi.fn()
}));

const courseMonitoringMocks = vi.hoisted(() => ({
  confirmCourseMonitoringTechnicalFinal: vi.fn(),
  getCourseMonitoringRetryAt: vi.fn(),
  reconcileCourseMonitoringDeadlines: vi.fn(),
  recordCourseMonitoringFinalClassification: vi.fn(),
  recordCourseMonitoringPlaybookTransition: vi.fn(),
  recordCourseMonitoringSuccess: vi.fn()
}));

const providerRequestLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn()
}));

const localReaderMocks = vi.hoisted(() => ({
  getFreshLocalReaderObservation: vi.fn(),
  getLocalReaderCourseKey: vi.fn(),
  queueLocalReaderJob: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => dbMocks);
vi.mock("@/lib/email/alerts", () => emailMocks);
vi.mock("@/lib/email/delivery-policy", () => deliveryPolicyMocks);
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
vi.mock(
  "@/lib/automation/search-monitoring-discovery",
  () => monitoringDiscoveryMocks
);
vi.mock("@/lib/automation/course-monitoring", () => ({
  ACTIVE_DEMAND_ESCALATION_MS: 30 * 60 * 1000,
  CUSTOMER_ENDPOINT_DELIVERY_HEADROOM_MS: 2 * 60 * 1000,
  FAILURE_CONFIRMATION_WINDOW_MS: 15 * 60 * 1000,
  FIRST_FAILURE_RETRY_MS: 2 * 60 * 1000,
  ...courseMonitoringMocks
}));
vi.mock(
  "@/lib/automation/provider-request-lease",
  () => providerRequestLeaseMocks
);
vi.mock("@/lib/local-reader/service", () => localReaderMocks);

import { buildMatchDeliveryGroupKey, runSearchCheck } from "./search-check";
import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  type AutomationPlaybookEventInput,
  type AutomationPlaybookLedger
} from "./course-monitoring-playbook";
import { preserveAlertGenerationClockInStatusSnapshot } from "@/lib/searches/generation-clock";

const search = {
  id: "search-1",
  createdAt: new Date("2026-07-11T12:00:00.000Z"),
  date: new Date("2026-07-12T00:00:00.000Z"),
  startTime: "07:00",
  endTime: "10:00",
  players: 2,
  requestedLayoutHoles: null as 9 | 18 | null,
  userTimeZone: "America/New_York",
  statusEmailSentAt: null as Date | null,
  statusEmailSnapshot: null,
  alertGeneration: 0,
  scheduleVersion: 1,
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
        monitoringMode: "AUTOMATIC",
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

const PLAYBOOK_OBSERVED_AT = new Date("2026-07-11T12:00:00.000Z");

function appendPlaybookEvent(
  ledger: AutomationPlaybookLedger | null,
  input: Omit<AutomationPlaybookEventInput, "cycle" | "observedAt" | "runtimeVersion">
) {
  return appendAutomationPlaybookEvent(ledger, {
    ...input,
    cycle: 1,
    observedAt: PLAYBOOK_OBSERVED_AT,
    runtimeVersion: "search-check-test-v1"
  });
}

function buildPlaybookThroughTypedAdapter() {
  let ledger: AutomationPlaybookLedger | null = null;
  ledger = appendPlaybookEvent(ledger, {
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "OFFICIAL_IDENTITY:CURRENT"
  });
  ledger = appendPlaybookEvent(ledger, {
    stage: "TYPED_ADAPTER",
    transition: "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "PROVIDER_RESPONSE",
    failureFingerprint: "TYPED_ADAPTER:FAILED",
    failureClass: "CHALLENGE"
  });
  return ledger;
}

function buildPlaybookThroughBrowserRetry() {
  let ledger = buildPlaybookThroughTypedAdapter();
  ledger = appendPlaybookEvent(ledger, {
    stage: "OFFICIAL_HTTP_DISCOVERY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_HTTP",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "OFFICIAL_HTTP:COMPLETE"
  });
  ledger = appendPlaybookEvent(ledger, {
    stage: "HTTP_ADAPTER_RETRY",
    transition: "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "PROVIDER_RESPONSE",
    failureFingerprint: "HTTP_ADAPTER:FAILED",
    failureClass: "CHALLENGE"
  });
  ledger = appendPlaybookEvent(ledger, {
    stage: "RENDERED_BROWSER_DISCOVERY",
    transition: "COMPLETED",
    readPath: "RENDERED_BROWSER",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: "RENDERED_BROWSER:COMPLETE"
  });
  return appendPlaybookEvent(ledger, {
    stage: "BROWSER_ADAPTER_RETRY",
    transition: "FAILED_TERMINAL",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "PROVIDER_RESPONSE",
    failureFingerprint: "BROWSER_ADAPTER:FAILED",
    failureClass: "CHALLENGE"
  });
}

function buildIndependentFactualFinalPlaybook() {
  let ledger = buildPlaybookThroughBrowserRetry();
  ledger = appendPlaybookEvent(ledger, {
    stage: "LOCAL_READER",
    transition: "FAILED_TERMINAL",
    readPath: "LOCAL_READER",
    evidenceKind: "LOCAL_READER_RESULT",
    failureFingerprint: "LOCAL_READER:FAILED",
    failureClass: "UNKNOWN"
  });
  return appendPlaybookEvent(ledger, {
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "FACTUAL_FINAL",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: "INDEPENDENT_CONFIRMATION:MANUAL_FINAL",
    factualDisposition: "MANUAL_DIRECT"
  });
}

function installPlaybookPersistence(initialLedger: AutomationPlaybookLedger) {
  let ledger = initialLedger;
  const context = () => ({
    id: "incident-1",
    cycle: 1,
    status: "AUTO_INVESTIGATING" as const,
    attemptLedger: ledger
  });
  dbMocks.getCourseMonitoringPlaybookContext.mockImplementation(async () =>
    context()
  );
  courseMonitoringMocks.recordCourseMonitoringPlaybookTransition.mockImplementation(
    async (input) => {
      ledger = appendAutomationPlaybookEvent(ledger, {
        cycle: 1,
        observedAt: PLAYBOOK_OBSERVED_AT,
        stage: input.stage,
        transition: input.transition,
        readPath: input.readPath,
        evidenceKind: input.evidenceKind,
        failureFingerprint: input.failureFingerprint,
        runtimeVersion: input.runtimeVersion,
        failureClass: input.failureClass,
        skipReason: input.skipReason,
        factualDisposition: input.factualDisposition,
        technicalReason: input.technicalReason,
        note: input.note
      });
      return {
        replayed: false,
        incidentId: "incident-1",
        incidentRevision: ledger.events.length,
        ledger,
        assessment: assessAutomationPlaybook(ledger, 1)
      };
    }
  );
  return {
    context,
    getLedger: () => ledger
  };
}

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
    deliveryPolicyMocks.areSearchStatusEmailsEnabled.mockReturnValue(true);
    deliveryPolicyMocks.isSearchEmailDeliveryEnabled.mockReturnValue(true);
    courseMonitoringMocks.getCourseMonitoringRetryAt.mockImplementation(
      async (_courseIds, options) =>
        options?.transientRetryCourseIds?.length
          ? new Date(Date.now() + 2 * 60 * 1000)
          : null
    );
    courseMonitoringMocks.reconcileCourseMonitoringDeadlines.mockResolvedValue({
      checked: 0,
      escalated: 0,
      humanReviewIncidentIds: []
    });
    courseMonitoringMocks.recordCourseMonitoringFinalClassification.mockResolvedValue(
      null
    );
    courseMonitoringMocks.recordCourseMonitoringPlaybookTransition.mockResolvedValue(
      null
    );
    courseMonitoringMocks.recordCourseMonitoringSuccess.mockResolvedValue(null);
    dbMocks.startAutomationRun.mockResolvedValue({ id: "run-1" });
    dbMocks.finishAutomationRun.mockResolvedValue(undefined);
    dbMocks.heartbeatSearchCheckLease.mockResolvedValue(true);
    dbMocks.isSearchCheckLeaseCurrent.mockResolvedValue(true);
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({ ...search });
    dbMocks.listSearchCourseVerdictsSince.mockResolvedValue([]);
    dbMocks.getCourseMonitoringPlaybookContext.mockResolvedValue(null);
    dbMocks.runWithSearchCheckLease.mockImplementation(
      async (_searchId, worker) => ({
        acquired: true,
        value: await worker({
          searchId: "search-1",
          scheduleVersion: 1,
          token: "check-lease",
          expiresAt: new Date("2026-07-11T12:25:00.000Z")
        })
      })
    );
    providerRequestLeaseMocks.runWithProviderRequestLease.mockImplementation(
      async (_providerFamily, worker) => ({
        acquired: true,
        value: await worker()
      })
    );
    localReaderMocks.getFreshLocalReaderObservation.mockResolvedValue(null);
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(null);
    localReaderMocks.queueLocalReaderJob.mockResolvedValue(null);
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
    deliveryOutboxMocks.getSafeOfficialBookingUrl.mockImplementation(
      (value: unknown) => (typeof value === "string" ? value : undefined)
    );
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue(
      []
    );
    deliveryOutboxMocks.listReachedMonitoringOutages.mockResolvedValue([]);
    deliveryOutboxMocks.listReachedMonitoringFinals.mockResolvedValue([]);
    deliveryOutboxMocks.getPendingStatusEmailReplacement.mockResolvedValue(
      null
    );
    deliveryOutboxMocks.satisfyPendingDailyStatusReplacementWithMatch.mockResolvedValue(
      {
        current: true,
        count: 1
      }
    );
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
          groups: [
            {
              groupKey: `recipient-${input.sourceGroupKey}`,
              recipient: "player@resend.dev"
            }
          ]
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
    deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches.mockResolvedValue(
      {
        count: 0
      }
    );
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
    expect(
      deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(expect.objectContaining({ kind: "SETUP" }));
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({ matchIds: [] })
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 0,
        statusEmailOutcome: "sent"
      })
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

    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
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
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({ matchIds: ["match-1"] })
      })
    );
    expect(result.newlyAlertedMatches).toBe(1);
  });

  it("covers every pending match in the setup email even beyond the visible pill limit", async () => {
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
    const localStartsAt = Array.from({ length: 17 }, (_, index) => {
      const totalMinutes = 7 * 60 + index * 10;
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

    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "SETUP",
        payload: expect.objectContaining({
          matchIds: localStartsAt.map((_, index) => `match-${index + 1}`),
          displayMatchIds: localStartsAt.map((_, index) => `match-${index + 1}`)
        })
      })
    );
    expect(result.newlyAlertedMatches).toBe(17);
  });

  it("sends only a new-opening alert when status emails are disabled", async () => {
    deliveryPolicyMocks.areSearchStatusEmailsEnabled.mockReturnValue(false);
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
    expect(
      deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          satisfiesStatusReport: false,
          statusSnapshot: expect.any(Array)
        })
      })
    );
    expect(
      deliveryOutboxMocks.finalizeSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(expect.objectContaining({ kind: "MATCH" }));
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 1,
        statusEmailOutcome: "skipped"
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

    expect(
      deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          matchIds: ["match-current"],
          matchRefs: [{ matchId: "match-current", availabilityCycle: 2 }],
          displayMatchIds: ["match-current"]
        })
      })
    );
  });

  it("covers every same-course opening in one MATCH delivery even when the email renders a concise subset", async () => {
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
      retainedMatchCount: 9,
      sentMatchCount: 9
    });

    const result = await runSearchCheck("search-1", "test");

    const coveredIds = localStartsAt.map((_, index) => `match-${index + 1}`);
    expect(
      deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          matchIds: coveredIds,
          displayMatchIds: coveredIds,
          matchReport: expect.objectContaining({
            matches: expect.arrayContaining(
              coveredIds.map((matchId) => expect.objectContaining({ matchId }))
            )
          })
        })
      })
    );
    const preparedPayload =
      deliveryOutboxMocks.prepareRecipientMatchDeliveryGroups.mock.calls[0]?.[0]
        .payload;
    expect(preparedPayload.matchReport.matches).toHaveLength(9);
    expect(preparedPayload.matchIds).toContain("match-9");
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 9,
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
            input.kind === "MATCH" ? "friend@resend.dev" : "player@resend.dev",
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
    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.suppressSearchEmailDeliveriesForMatches
    ).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).not.toHaveBeenCalled();
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
    adapterMocks.fetchForeupTeeSheet.mockRejectedValue(
      new Error("fetch failed")
    );
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
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).not.toHaveBeenCalled();
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
  });

  it("keeps a confirmed provider outage in the operator queue without email", async () => {
    const firstDegradedAt = new Date("2026-07-11T12:00:00.000Z");
    const base = {
      ...search,
      statusEmailSentAt: new Date("2026-07-11T12:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "CHRONOGOLF",
            providerFamilyKey: "CHRONOGOLF",
            detectedBookingUrl:
              "https://www.chronogolf.com/club/blue-rock-golf-course",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              clubId: 7221,
              courseIds: ["course-1"],
              bookingBaseUrl:
                "https://www.chronogolf.com/club/blue-rock-golf-course"
            },
            monitoringStatus: {
              state: "DEGRADED_RETRYING",
              firstDegradedAt,
              failureFingerprint: "chronogolf-network",
              nextAutomaticAttemptAt: firstDegradedAt,
              revalidationRequestedAt: null
            }
          }
        }
      ]
    };
    const confirmed = {
      ...base,
      preferences: [
        {
          ...base.preferences[0],
          course: {
            ...base.preferences[0].course,
            monitoringStatus: {
              ...base.preferences[0].course.monitoringStatus,
              state: "AUTO_INVESTIGATING"
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(base)
      .mockResolvedValue(confirmed);
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    adapterMocks.fetchChronogolfSlots.mockRejectedValue(
      new Error("Chronogolf tee times returned 503")
    );
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MONITORING_OUTAGE" })
    );
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "outage" })
    );
  });

  it("records monitoring recovery without sending a recovery email", async () => {
    const firstDegradedAt = new Date("2026-07-11T11:30:00.000Z");
    const degraded = {
      ...search,
      additionalEmails: ["friend@resend.dev", "new@resend.dev"],
      statusEmailSentAt: new Date("2026-07-11T11:45:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "CHRONOGOLF",
            providerFamilyKey: "CHRONOGOLF",
            detectedBookingUrl:
              "https://www.chronogolf.com/club/blue-rock-golf-course",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              clubId: 7221,
              courseIds: ["course-1"],
              bookingBaseUrl:
                "https://www.chronogolf.com/club/blue-rock-golf-course"
            },
            monitoringStatus: {
              state: "AUTO_INVESTIGATING",
              firstDegradedAt,
              failureFingerprint: "chronogolf-network",
              nextAutomaticAttemptAt: new Date("2026-07-11T12:00:00.000Z"),
              revalidationRequestedAt: null
            }
          }
        }
      ]
    };
    const healthy = {
      ...degraded,
      statusEmailSentAt: new Date("2026-07-11T11:45:00.000Z"),
      preferences: [
        {
          ...degraded.preferences[0],
          course: {
            ...degraded.preferences[0].course,
            monitoringStatus: {
              state: "HEALTHY",
              firstDegradedAt: null,
              failureFingerprint: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(degraded)
      .mockResolvedValue(healthy);
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    adapterMocks.fetchChronogolfSlots.mockResolvedValue([]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    await runSearchCheck("search-1", "test");

    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MONITORING_RECOVERY" })
    );
    expect(emailMocks.sendSearchStatusEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "recovery" })
    );
  });

  it("delivers a consolidated factual-final status update to every alert recipient", async () => {
    const finalizedSearch = {
      ...search,
      statusEmailSentAt: new Date("2026-07-11T11:00:00.000Z"),
      additionalEmails: ["friend@resend.dev"],
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedBookingUrl: null,
            website: "https://example.com/course",
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "203-555-0100",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            intelligenceVerifiedAt: new Date("2026-07-11T11:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T11:00:00.000Z"),
            intelligenceConfidence: 0.99,
            monitoringStatus: {
              state: "FINAL_MANUAL",
              firstDegradedAt: null,
              failureFingerprint: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: new Date("2026-07-11T12:10:00.000Z")
            },
            supportIncident: {
              id: "incident-final-1",
              cycle: 1,
              status: "RESOLVED",
              attemptLedger: null,
              firstSeenAt: new Date("2026-07-11T11:39:00.000Z")
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(finalizedSearch);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    expect(
      deliveryOutboxMocks.listReachedMonitoringFinals
    ).toHaveBeenCalledWith({
      searchId: "search-1",
      alertGeneration: 0
    });
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MONITORING_STATUS_UPDATE",
        recipients: ["player@resend.dev", "friend@resend.dev"],
        payload: expect.objectContaining({
          statusReport: expect.objectContaining({
            kind: "status-update",
            courses: [
              expect.objectContaining({
                courseId: "course-1",
                outcome: "MANUAL_DIRECT"
              })
            ]
          })
        })
      })
    );
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "status-update",
        courses: [expect.objectContaining({ outcome: "MANUAL_DIRECT" })]
      })
    );
  });

  it("combines due factual-final and human-review courses into one status update", async () => {
    const episodeStartedAt = new Date("2026-07-11T11:39:00.000Z");
    const mixedSearch = {
      ...search,
      statusEmailSentAt: new Date("2026-07-11T11:00:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "course-final",
            name: "Phone Course",
            detectedBookingUrl: null,
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "203-555-0100",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            intelligenceVerifiedAt: new Date("2026-07-11T11:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T11:00:00.000Z"),
            intelligenceConfidence: 0.99,
            monitoringStatus: {
              state: "FINAL_MANUAL",
              firstDegradedAt: null,
              failureFingerprint: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: new Date("2026-07-11T12:10:00.000Z")
            },
            supportIncident: {
              id: "incident-final",
              cycle: 1,
              status: "RESOLVED",
              attemptLedger: null,
              firstSeenAt: episodeStartedAt
            }
          }
        },
        {
          rank: 2,
          course: {
            ...search.preferences[0].course,
            id: "course-human",
            name: "Human Review Course",
            detectedBookingUrl: "https://example.com/human-review",
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "OTHER",
            monitoringStatus: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              firstDegradedAt: episodeStartedAt,
              failureFingerprint: "human-review",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: episodeStartedAt
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(mixedSearch);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    const statusDeliveries =
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup.mock.calls.filter(
        ([input]) =>
          input.kind === "MONITORING_STATUS_UPDATE" ||
          input.kind === "MONITORING_OUTAGE"
      );
    expect(statusDeliveries).toHaveLength(1);
    expect(statusDeliveries[0]?.[0]).toEqual(
      expect.objectContaining({
        kind: "MONITORING_STATUS_UPDATE",
        payload: expect.objectContaining({
          statusReport: expect.objectContaining({
            kind: "status-update",
            courses: expect.arrayContaining([
              expect.objectContaining({ courseId: "course-final" }),
              expect.objectContaining({ courseId: "course-human" })
            ])
          })
        })
      })
    );
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "status-update",
        courses: expect.arrayContaining([
          expect.objectContaining({ courseId: "course-final" }),
          expect.objectContaining({ courseId: "course-human" })
        ])
      })
    );
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
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
  });

  it("checks five mixed courses independently in one alert cycle", async () => {
    const baseCourse = {
      ...search.preferences[0].course,
      isPublic: true,
      phone: null,
      bookingPhone: null,
      policyNotes: null,
      monitoringStatus: null
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...baseCourse,
            id: "course-success",
            name: "Working ForeUP Course",
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            detectedBookingUrl:
              "https://foreupsoftware.com/index.php/booking/1/1#/teetimes",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            bookingAccessMode: "PUBLIC_SIGNED_OUT",
            bookingMetadata: {
              scheduleId: 1,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/1/1#/teetimes"
            }
          }
        },
        {
          rank: 2,
          course: {
            ...baseCourse,
            id: "course-captcha",
            name: "Challenge Course",
            detectedPlatform: "CHRONOGOLF",
            providerFamilyKey: "CHRONOGOLF",
            detectedBookingUrl:
              "https://www.chronogolf.com/club/challenge-course",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            bookingAccessMode: "PUBLIC_SIGNED_OUT",
            bookingMetadata: {
              provider: "CHRONOGOLF",
              clubSlug: "challenge-course"
            }
          }
        },
        {
          rank: 3,
          course: {
            ...baseCourse,
            id: "course-phone",
            name: "Phone Booking Course",
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "MANUAL",
            detectedBookingUrl: null,
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "203-555-0100",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            bookingAccessMode: "PHONE_ONLY",
            intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            bookingMetadata: null
          }
        },
        {
          rank: 4,
          course: {
            ...baseCourse,
            id: "course-reader",
            name: "Reader Candidate Course",
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl:
              "https://grassyhill.cps.golf/onlineresweb/search-teetime",
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "OTHER",
            bookingAccessMode: "UNKNOWN",
            bookingMetadata: null
          }
        },
        {
          rank: 5,
          course: {
            ...baseCourse,
            id: "course-technical",
            name: "Unverified Technical Course",
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "SOURCE_MISSING",
            detectedBookingUrl: "https://technical.example/book",
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "OTHER",
            bookingAccessMode: "UNKNOWN",
            bookingMetadata: null
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(true);
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    adapterMocks.fetchChronogolfSlots.mockRejectedValue(
      new Error("Public captcha challenge")
    );
    localReaderMocks.getLocalReaderCourseKey.mockImplementation(
      (bookingUrl: string | null) =>
        bookingUrl?.includes("grassyhill") ? "cps:grassyhill.cps.golf" : null
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "reader-job-1"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");
    const outcomes = Object.fromEntries(
      result.courseResults.map((courseResult) => [
        courseResult.courseId,
        courseResult.outcome
      ])
    );

    expect(outcomes).toMatchObject({
      "course-success": "NO_MATCH",
      "course-captcha": "FETCH_FAILED",
      "course-phone": "MANUAL_DIRECT",
      "course-reader": "NEEDS_ADAPTER",
      "course-technical": "NEEDS_ADAPTER"
    });
    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-reader"
      })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-reader" }),
        kind: "NEEDS_ADAPTER"
      })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-captcha" }),
        kind: "FETCH_FAILED"
      })
    );
    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledOnce();
  });

  it("does not queue Grassy Hill for the local reader before browser discovery", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const grassyHillSearch = {
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Grassy Hill Country Club",
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(grassyHillSearch);
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    adapterMocks.fetchCpsTeeSheet.mockRejectedValue(
      new Error("CPS configuration returned 403")
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-1"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      message: expect.stringContaining("403")
    });
    expect(result.statusEmailOutcome).toBe("sent");
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledOnce();
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "setup",
        courses: [expect.objectContaining({ outcome: "FETCH_FAILED" })]
      })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-1" }),
        kind: "FETCH_FAILED",
        readPath: "TYPED_PROVIDER_ADAPTER"
      })
    );
  });

  it("delivers a same-check recovery match once to every current recipient", async () => {
    const firstDegradedAt = new Date("2026-07-11T11:30:00.000Z");
    const monitoredCourse = {
      ...search.preferences[0].course,
      name: "Recovered Course",
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      policyNotes: null,
      bookingMetadata: { courseId: "course-1" }
    };
    const degradedSearch = {
      ...search,
      additionalEmails: ["friend@example.com"],
      statusEmailSentAt: new Date("2026-07-11T11:40:00.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...monitoredCourse,
            monitoringStatus: {
              state: "DEGRADED_RETRYING",
              firstDegradedAt,
              failureFingerprint: "foreup-timeout",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null
            }
          }
        }
      ]
    };
    const healthySearch = {
      ...degradedSearch,
      preferences: [
        {
          rank: 1,
          course: {
            ...monitoredCourse,
            monitoringStatus: {
              state: "HEALTHY",
              firstDegradedAt: null,
              failureFingerprint: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(degradedSearch)
      .mockResolvedValue(healthySearch);
    adapterMocks.fetchForeupTeeSheet.mockResolvedValue({
      slots: [
        {
          sourceId: "slot-1",
          courseId: "course-1",
          startsAt: "2026-07-12T08:10:00-04:00",
          availableSpots: 4,
          bookingUrl: "https://example.com/book",
          priceCents: 6200,
          bookableHoleCounts: [18]
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    dbMocks.recordTeeTimeMatch.mockResolvedValue({
      id: "match-1",
      alertStatus: "PENDING",
      availabilityCycle: 0
    });
    dbMocks.listPendingMatchAlerts
      .mockResolvedValueOnce([pendingMatch])
      .mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([pendingMatch]);
    deliveryOutboxMocks.listReachedMonitoringOutages.mockResolvedValue([
      {
        courseId: "course-1",
        recipient: "player@resend.dev",
        sentAt: new Date("2026-07-11T11:40:00.000Z"),
        customerStatus: "RETRYING_AUTOMATICALLY"
      }
    ]);
    deliveryOutboxMocks.drainSearchEmailDeliveryGroup.mockImplementationOnce(
      async (input) => {
        const deliveries = [];
        for (const recipient of [
          "player@resend.dev",
          "friend@example.com"
        ]) {
          await input.send({
            recipient,
            idempotencyKey: `tee-search-delivery-${recipient}`,
            payload: deliveryOutboxMocks.preparedPayload,
            assertCurrentDelivery: vi.fn().mockResolvedValue(undefined)
          });
          deliveries.push({ id: `delivery-${recipient}`, status: "SENT" });
        }
        return deliveries;
      }
    );

    const result = await runSearchCheck("search-1", "test");

    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledTimes(2);
    expect(
      emailMocks.sendSearchStatusEmail.mock.calls
        .map(([input]) => input.to)
        .sort()
    ).toEqual(["friend@example.com", "player@resend.dev"]);
    for (const [input] of emailMocks.sendSearchStatusEmail.mock.calls) {
      expect(input).toEqual(
        expect.objectContaining({
          kind: "recovery",
          courses: [expect.objectContaining({ outcome: "MATCH_FOUND" })]
        })
      );
    }
    expect(emailMocks.sendTeeTimeAlert).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MONITORING_RECOVERY",
        recipients: ["player@resend.dev", "friend@example.com"],
        payload: expect.objectContaining({
          matchIds: ["match-1"],
          matchRefs: [{ matchId: "match-1", availabilityCycle: 0 }]
        })
      })
    );
    expect(result).toEqual(
      expect.objectContaining({
        newlyAlertedMatches: 1,
        statusEmailOutcome: "sent"
      })
    );
  });

  it("does not queue a Chronogolf reader before browser discovery", async () => {
    const bookingUrl = "https://www.chronogolf.com/club/hyde-park-golf-club";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Hyde Park Golf Club",
            detectedPlatform: "CHRONOGOLF",
            providerFamilyKey: "CHRONOGOLF",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              provider: "CHRONOGOLF",
              clubId: 4006,
              courseIds: ["5d8f129e-e7b8-4855-970c-bd3bc39879a3"],
              bookingBaseUrl: bookingUrl
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    adapterMocks.fetchChronogolfSlots.mockRejectedValue(
      new Error("Chronogolf tee times returned 403")
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:hyde-park-golf-club"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-hyde-park"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      message: expect.stringContaining("403")
    });
    expect(dbMocks.recordCourseProbe).toHaveBeenCalled();
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "FETCH_FAILED",
        readPath: "TYPED_PROVIDER_ADAPTER"
      })
    );
  });

  it("does not queue Grassy Hill for the local reader after an initial challenge", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Grassy Hill Country Club",
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    adapterMocks.fetchCpsTeeSheet.mockRejectedValue(
      Object.assign(new Error("Provider challenge detected"), {
        failureClass: "CHALLENGE"
      })
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-1"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      message: expect.stringContaining("challenge")
    });
    expect(dbMocks.recordCourseProbe).toHaveBeenCalled();
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "FETCH_FAILED",
        readPath: "TYPED_PROVIDER_ADAPTER"
      })
    );
  });

  it("records the first typed-adapter failure in the newly opened incident cycle", async () => {
    const playbook = installPlaybookPersistence({
      version: 1,
      events: []
    });
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            detectedBookingUrl:
              "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });
    adapterMocks.fetchForeupTeeSheet.mockRejectedValue(
      new Error("ForeUp tee times returned 503")
    );
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(playbook.getLedger().events.map((event) => [
      event.stage,
      event.transition
    ])).toEqual([
      ["OFFICIAL_IDENTITY", "STARTED"],
      ["OFFICIAL_IDENTITY", "COMPLETED"],
      ["TYPED_ADAPTER", "STARTED"],
      ["TYPED_ADAPTER", "FAILED_RETRYABLE"]
    ]);
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "TYPED_ADAPTER",
      stages: expect.arrayContaining([
        expect.objectContaining({
          stage: "TYPED_ADAPTER",
          attemptCount: 1,
          status: "FAILED_RETRYABLE"
        })
      ])
    });
    expect(result).toMatchObject({
      supportRetryNeeded: true,
      supportRetryAt: new Date("2026-07-11T12:12:00.000Z")
    });
  });

  it("retries a typed adapter learned during official HTTP discovery and closes the current cycle before resolution", async () => {
    const playbook = installPlaybookPersistence(
      buildPlaybookThroughTypedAdapter()
    );
    const initialSearch = {
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "SOURCE_MISSING",
            detectedBookingUrl: "https://learned.example/tee-times",
            automationEligibility: "UNKNOWN",
            automationReason: "OTHER",
            policyNotes: null,
            bookingMetadata: null,
            supportIncident: playbook.context()
          }
        }
      ]
    };
    const refreshedSearch = {
      ...initialSearch,
      preferences: [
        {
          rank: 1,
          course: {
            ...initialSearch.preferences[0].course,
            detectedPlatform: "FOREUP",
            providerFamilyKey: "FOREUP",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(initialSearch)
      .mockResolvedValue(refreshedSearch);
    monitoringDiscoveryMocks.prepareSearchMonitoring.mockResolvedValue({
      attemptedCourseIds: ["course-1"],
      appliedCourseIds: ["course-1"],
      failedCourseIds: [],
      deferredCourseIds: [],
      retryCourseIds: []
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(monitoringDiscoveryMocks.prepareSearchMonitoring).toHaveBeenCalledWith(
      initialSearch,
      undefined,
      new Date("2026-07-11T12:10:00.000Z"),
      {
        includeCourseIds: ["course-1"],
        forceFreshCourseIds: ["course-1"]
      }
    );
    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledOnce();
    const transitions =
      courseMonitoringMocks.recordCourseMonitoringPlaybookTransition.mock.calls.map(
        ([input]) => ({
          stage: input.stage,
          transition: input.transition
        })
      );
    expect(transitions).toEqual([
      { stage: "OFFICIAL_HTTP_DISCOVERY", transition: "STARTED" },
      { stage: "OFFICIAL_HTTP_DISCOVERY", transition: "COMPLETED" },
      { stage: "HTTP_ADAPTER_RETRY", transition: "STARTED" },
      { stage: "HTTP_ADAPTER_RETRY", transition: "SUCCEEDED" }
    ]);
    expect(transitions).not.toContainEqual({
      stage: "HTTP_ADAPTER_RETRY",
      transition: "NOT_APPLICABLE"
    });
    expect(result.courseResults[0]).toMatchObject({ outcome: "NO_MATCH" });
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      cycle: 1,
      conclusion: "MONITORING_RESTORED",
      nextStage: null
    });
    const successTransitionIndex = transitions.findIndex(
      (transition) => transition.transition === "SUCCEEDED"
    );
    expect(
      courseMonitoringMocks.recordCourseMonitoringPlaybookTransition.mock
        .invocationCallOrder[successTransitionIndex]
    ).toBeLessThan(
      courseMonitoringMocks.recordCourseMonitoringSuccess.mock
        .invocationCallOrder[0]!
    );
    expect(
      courseMonitoringMocks.recordCourseMonitoringSuccess
    ).toHaveBeenCalled();
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
  });

  it("reports a completed reader challenge without returning to CHECK_PENDING", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const playbook = installPlaybookPersistence(
      buildPlaybookThroughBrowserRetry()
    );
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Grassy Hill Country Club",
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            supportIncident: playbook.context(),
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    adapterMocks.fetchCpsTeeSheet.mockRejectedValue(
      Object.assign(new Error("Provider challenge detected"), {
        failureClass: "CHALLENGE"
      })
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-terminal",
      queueDisposition: "TERMINAL",
      readerResultStatus: "ACCESS_CHALLENGE"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      message: expect.stringContaining("stopped safely")
    });
    expect(result.courseResults[0]?.outcome).not.toBe("CHECK_PENDING");
    expect(result.statusEmailOutcome).toBe("sent");
    expect(adapterMocks.fetchCpsTeeSheet).not.toHaveBeenCalled();
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "READER_CANDIDATE",
        readPath: "LOCAL_READER_TERMINAL"
      })
    );
    const assessment = assessAutomationPlaybook(playbook.getLedger(), 1);
    expect(assessment).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "INDEPENDENT_CONFIRMATION",
      technicalObservationCount: 1
    });
    expect(playbook.getLedger().events.at(-1)).toMatchObject({
      stage: "LOCAL_READER",
      transition: "TECHNICAL_LIMITATION",
      technicalReason: "CAPTCHA_OR_QUEUE"
    });
  });

  it("does not let a local reader bypass browser stages for a stored technical block", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Grassy Hill Country Club",
            isPublic: true,
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "UNKNOWN",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            policyNotes: null,
            bookingMetadata: null
          }
        }
      ]
    });
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-1"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).not.toHaveBeenCalled();
    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NEEDS_ADAPTER"
    });
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "NEEDS_ADAPTER" })
    );
    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalled();
  });

  it("requires independent confirmation after a fresh reader challenge", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const playbook = installPlaybookPersistence(
      buildPlaybookThroughBrowserRetry()
    );
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Grassy Hill Country Club",
            isPublic: true,
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "UNKNOWN",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            monitoringStatus: {
              state: "REVALIDATING_FINAL",
              firstDegradedAt: new Date("2026-07-11T11:00:00.000Z"),
              failureFingerprint: "reader-challenge",
              nextAutomaticAttemptAt: new Date("2026-07-11T12:00:00.000Z"),
              revalidationRequestedAt: new Date("2026-07-11T12:00:00.000Z"),
              stateChangedAt: new Date("2026-07-11T12:00:00.000Z")
            },
            supportIncident: playbook.context(),
            bookingMetadata: null
          }
        }
      ]
    });
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.getFreshLocalReaderObservation.mockResolvedValue({
      status: "ACCESS_CHALLENGE",
      observedAt: new Date("2026-07-11T12:01:00.000Z"),
      readerVersion: "cps-rendered-v1",
      teeSheet: null
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(
      courseMonitoringMocks.confirmCourseMonitoringTechnicalFinal
    ).not.toHaveBeenCalled();
    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).toHaveBeenCalledWith({
      searchId: "search-1",
      courseId: "course-1",
      targetDate: "2026-07-12",
      players: 2,
      bookingUrl,
      notBefore: PLAYBOOK_OBSERVED_AT
    });
    expect(
      courseMonitoringMocks.recordCourseMonitoringPlaybookTransition
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "LOCAL_READER",
        transition: "TECHNICAL_LIMITATION",
        now: new Date("2026-07-11T12:01:00.000Z")
      })
    );
    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "FETCH_FAILED",
        rawSummary: {
          providerExecution: "LOCAL_BROWSER_READER",
          readerStatus: "ACCESS_CHALLENGE",
          playbookConclusion: "INCOMPLETE"
        }
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      message: expect.stringContaining("independent signed-out confirmation")
    });
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "INDEPENDENT_CONFIRMATION",
      technicalObservationCount: 1
    });
    expect(
      courseMonitoringMocks.recordCourseMonitoringFinalClassification
    ).not.toHaveBeenCalled();
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
  });

  it("applies independent factual proof before the human-review short circuit", async () => {
    const attemptLedger = buildIndependentFactualFinalPlaybook();
    let freshCycleStatus = "NOT_OPEN";
    courseMonitoringMocks.recordCourseMonitoringFinalClassification.mockImplementationOnce(
      async () => {
        freshCycleStatus = "AUTO_INVESTIGATING";
        return null;
      }
    );
    supportIncidentMocks.resolveCourseSupportIncident.mockImplementationOnce(
      async () => {
        freshCycleStatus = "RESOLVED";
        return null;
      }
    );
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "203-555-0100",
            monitoringStatus: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              firstDegradedAt: new Date("2026-07-11T11:00:00.000Z"),
              failureFingerprint: "reader-review",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: new Date("2026-07-11T11:30:00.000Z")
            },
            supportIncident: {
              id: "incident-independent-final",
              cycle: 1,
              status: "NEEDS_HUMAN",
              attemptLedger,
              firstSeenAt: new Date("2026-07-11T11:00:00.000Z")
            }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(result.courseResults[0]).toMatchObject({
      outcome: "MANUAL_DIRECT",
      monitoringDisposition: "MANUAL_FINAL"
    });
    expect(result.courseResults[0]?.supportStatus).toBeUndefined();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(localReaderMocks.queueLocalReaderJob).not.toHaveBeenCalled();
    expect(
      courseMonitoringMocks.recordCourseMonitoringFinalClassification
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-1",
        state: "FINAL_MANUAL",
        outcome: "MANUAL_DIRECT"
      })
    );
    expect(freshCycleStatus).toBe("AUTO_INVESTIGATING");
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
  });

  it("uses only the local reader when the persisted monitoring mode requires it", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const playbook = installPlaybookPersistence({ version: 1, events: [] });
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Reader Only Public Course",
            isPublic: true,
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            monitoringMode: "LOCAL_READER_ONLY",
            intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            policyNotes: null,
            supportIncident: {
              ...playbook.context(),
              firstSeenAt: new Date("2026-07-11T12:00:00.000Z")
            },
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-only"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).toHaveBeenCalledWith({
      searchId: "search-1",
      courseId: "course-1",
      targetDate: "2026-07-12",
      players: 2,
      bookingUrl,
      notBefore: PLAYBOOK_OBSERVED_AT
    });
    expect(localReaderMocks.queueLocalReaderJob).toHaveBeenCalledWith({
      searchId: "search-1",
      courseId: "course-1",
      scheduleVersion: 1,
      targetDate: "2026-07-12",
      players: 2,
      bookingUrl,
      notBefore: PLAYBOOK_OBSERVED_AT
    });
    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(adapterMocks.fetchCpsTeeSheet).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "CHECK_PENDING",
      message: expect.stringContaining("in progress")
    });
  });

  it("does not reopen a reader-only job after its cycle advances to independent confirmation", async () => {
    const bookingUrl =
      "https://grassyhill.cps.golf/onlineresweb/search-teetime";
    const playbook = installPlaybookPersistence(
      buildPlaybookThroughBrowserRetry()
    );
    const buildReaderOnlySearch = () => ({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Reader Only Public Course",
            isPublic: true,
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl: bookingUrl,
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            monitoringMode: "LOCAL_READER_ONLY",
            intelligenceVerifiedAt: new Date("2026-07-11T12:00:00.000Z"),
            intelligenceReviewAt: new Date("2026-08-11T12:00:00.000Z"),
            intelligenceConfidence: 0.95,
            policyNotes: null,
            supportIncident: {
              ...playbook.context(),
              firstSeenAt: new Date("2026-07-11T12:00:00.000Z")
            },
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    dbMocks.getActiveSearchForAutomation.mockImplementation(async () =>
      buildReaderOnlySearch()
    );
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.queueLocalReaderJob.mockResolvedValue({
      id: "local-job-terminal",
      status: "COMPLETED",
      queueDisposition: "TERMINAL",
      readerResultStatus: "PAGE_MISMATCH"
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const first = await runSearchCheck("search-1", "test");
    expect(first.courseResults[0]).toMatchObject({ outcome: "FETCH_FAILED" });
    expect(first.courseResults[0]?.outcome).not.toBe("CHECK_PENDING");
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "INDEPENDENT_CONFIRMATION"
    });
    expect(localReaderMocks.queueLocalReaderJob).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date("2026-07-11T12:16:00.000Z"));
    const second = await runSearchCheck("search-1", "test");

    expect(second.courseResults[0]).toMatchObject({
      outcome: "NEEDS_ADAPTER",
      message: expect.stringContaining("independent signed-out confirmation")
    });
    expect(second.courseResults[0]?.outcome).not.toBe("CHECK_PENDING");
    expect(localReaderMocks.queueLocalReaderJob).toHaveBeenCalledOnce();
    expect(localReaderMocks.getFreshLocalReaderObservation).toHaveBeenCalledOnce();
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "INDEPENDENT_CONFIRMATION"
    });
  });

  it("uses the CPS server adapter before an available local-reader result", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            detectedPlatform: "CUSTOM",
            providerFamilyKey: "CPS",
            detectedBookingUrl:
              "https://grassyhill.cps.golf/onlineresweb/search-teetime",
            bookingMetadata: {
              provider: "CPS",
              siteName: "grassyhill",
              bookingBaseUrl: "https://grassyhill.cps.golf/",
              courseIds: [1]
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isCpsMetadata.mockReturnValue(true);
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
    localReaderMocks.getFreshLocalReaderObservation.mockResolvedValue({
      status: "AVAILABLE",
      observedAt: new Date("2026-07-11T12:01:00.000Z"),
      readerVersion: "cps-rendered-v1",
      teeSheet: {
        slots: [
          {
            sourceId: "local-grassy-hill-2026-07-12T08:10:00-18",
            courseId: "course-1",
            startsAt: "2026-07-12T08:10:00",
            availableSpots: 4,
            bookingUrl:
              "https://grassyhill.cps.golf/onlineresweb/search-teetime",
            priceCents: 8200,
            holes: 18,
            bookableHoleCounts: [9, 18]
          }
        ],
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null
      }
    });

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchCpsTeeSheet).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NO_MATCH",
      availableMatches: 0
    });
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeVersion: "local",
        rawSummary: expect.objectContaining({
          providerExecution: "RUNNABLE_PROVIDER_CHECK"
        })
      })
    );
  });

  it("uses the Chronogolf server adapter before an available local-reader result", async () => {
    const bookingUrl = "https://www.chronogolf.com/club/hyde-park-golf-club";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            name: "Hyde Park Golf Club",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            monitoringMode: "AUTOMATIC",
            policyNotes: null,
            detectedPlatform: "CHRONOGOLF",
            providerFamilyKey: "CHRONOGOLF",
            detectedBookingUrl: bookingUrl,
            bookingMetadata: {
              provider: "CHRONOGOLF",
              clubId: 4006,
              courseIds: ["5d8f129e-e7b8-4855-970c-bd3bc39879a3"],
              bookingBaseUrl: bookingUrl
            }
          }
        }
      ]
    });
    adapterMocks.isForeupMetadata.mockReturnValue(false);
    adapterMocks.isChronogolfMetadata.mockReturnValue(true);
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:hyde-park-golf-club"
    );
    localReaderMocks.getFreshLocalReaderObservation.mockResolvedValue({
      status: "AVAILABLE",
      observedAt: new Date("2026-07-11T12:01:00.000Z"),
      readerVersion: "chronogolf-rendered-v1",
      teeSheet: {
        slots: [
          {
            sourceId: "local-hyde-park-2026-07-12T09:10:00",
            courseId: "course-1",
            startsAt: "2026-07-12T09:10:00",
            availableSpots: 4,
            bookingUrl,
            priceCents: 3900,
            holes: 18,
            bookableHoleCounts: [9, 18]
          }
        ],
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null,
        readerVersion: "chronogolf-rendered-v1"
      }
    });

    const result = await runSearchCheck("search-1", "test");

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).toHaveBeenCalledOnce();
    expect(adapterMocks.fetchChronogolfSlots).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NO_MATCH",
      availableMatches: 0
    });
    expect(dbMocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeVersion: "local",
        rawSummary: expect.objectContaining({
          providerExecution: "RUNNABLE_PROVIDER_CHECK"
        })
      })
    );
  });

  it("retries a persisted match delivery group even after no match remains globally pending", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      statusEmailSentAt: new Date("2026-07-11T12:00:00.000Z")
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue(
      [
        {
          kind: "MATCH",
          groupKey: "persisted-match-group",
          createdAt: new Date("2026-07-11T12:00:00.000Z")
        }
      ]
    );

    await runSearchCheck("search-1", "test");

    expect(
      deliveryOutboxMocks.drainSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MATCH",
        groupKey: "persisted-match-group"
      })
    );
    expect(emailMocks.sendTeeTimeAlert).toHaveBeenCalledOnce();
  });

  it("continues to newer owner delivery when an old group only has an additional-recipient retry pending", async () => {
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue(
      [
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
      ]
    );
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
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

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
        expect.objectContaining({
          newlyAlertedMatches: 0,
          statusEmailOutcome: "sent"
        })
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
    deliveryOutboxMocks.listRetryableSearchEmailDeliveryGroups.mockResolvedValue(
      [
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
      ]
    );
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
      expect.objectContaining({
        outcome: "success",
        statusEmailOutcome: "sent"
      })
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
        message: expect.stringContaining(
          "requested 18-hole physical course layout"
        )
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
    const createdAt = new Date("2026-07-11T12:04:00.000Z");
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      createdAt,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            createdAt,
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
        kind: "NEEDS_ADAPTER",
        episodeStartedAt: createdAt
      })
    );
    expect(result.courseResults[0]).toEqual(
      expect.objectContaining({
        outcome: "NEEDS_ADAPTER",
        supportStatus: "IN_OPERATOR_QUEUE",
        firstTimeLookup: true
      })
    );
    expect(result.supportRetryNeeded).toBe(false);
  });

  it("anchors a delayed edited generation to its durable generation marker", async () => {
    const generationStartedAt = new Date("2026-07-11T12:04:00.000Z");
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      alertGeneration: 3,
      statusEmailSentAt: null,
      statusEmailSnapshot: {
        schemaVersion: 1,
        kind: "ALERT_GENERATION_START",
        alertGeneration: 3,
        generationStartedAt: generationStartedAt.toISOString()
      },
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

    await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        kind: "NEEDS_ADAPTER",
        episodeStartedAt: generationStartedAt
      })
    );
  });

  it("keeps generation zero anchored after unrecorded setup delivery", async () => {
    const createdAt = new Date("2026-07-11T12:00:00.000Z");
    const initialSearch = {
      ...search,
      createdAt,
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
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(initialSearch);
    dbMocks.listSearchCourseVerdictsSince
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          courseId: "course-1",
          outcome: "NEEDS_ADAPTER",
          observedAt: new Date("2026-07-11T12:10:00.000Z")
        }
      ]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    supportIncidentMocks.reportCourseSupportIssue.mockResolvedValue({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    const first = await runSearchCheck("search-1", "test");
    const setupPayload = deliveryOutboxMocks.preparedPayload as {
      statusSnapshot: unknown;
    };
    expect(first.statusEmailOutcome).toBe("sent");

    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...initialSearch,
      statusEmailSentAt: new Date("2026-07-11T12:10:00.000Z"),
      statusEmailSnapshot: setupPayload.statusSnapshot
    });
    await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledTimes(
      2
    );
    for (const [issue] of supportIncidentMocks.reportCourseSupportIssue.mock
      .calls) {
      expect(issue).toEqual(
        expect.objectContaining({ episodeStartedAt: createdAt })
      );
    }
  });

  it("keeps an edited generation anchored after unrecorded setup delivery", async () => {
    const generationStartedAt = new Date("2026-07-11T12:04:00.000Z");
    const generationMarker = {
      schemaVersion: 1,
      kind: "ALERT_GENERATION_START",
      alertGeneration: 3,
      generationStartedAt: generationStartedAt.toISOString()
    };
    const initialSearch = {
      ...search,
      alertGeneration: 3,
      statusEmailSentAt: null,
      statusEmailSnapshot: generationMarker,
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
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(initialSearch);
    dbMocks.listSearchCourseVerdictsSince
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        {
          courseId: "course-1",
          outcome: "NEEDS_ADAPTER",
          observedAt: new Date("2026-07-11T12:10:00.000Z")
        }
      ]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    supportIncidentMocks.reportCourseSupportIssue.mockResolvedValue({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    const first = await runSearchCheck("search-1", "test");
    const setupPayload = deliveryOutboxMocks.preparedPayload as {
      statusSnapshot: unknown;
    };
    expect(first.statusEmailOutcome).toBe("sent");
    const persistedSnapshot = preserveAlertGenerationClockInStatusSnapshot({
      alertGeneration: 3,
      currentStatusEmailSnapshot: generationMarker,
      courseSnapshot: setupPayload.statusSnapshot as never
    });

    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...initialSearch,
      statusEmailSentAt: new Date("2026-07-11T12:10:00.000Z"),
      statusEmailSnapshot: persistedSnapshot
    });
    await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledTimes(
      2
    );
    for (const [issue] of supportIncidentMocks.reportCourseSupportIssue.mock
      .calls) {
      expect(issue).toEqual(
        expect.objectContaining({ episodeStartedAt: generationStartedAt })
      );
    }
  });

  it("keeps an unrecorded post-success failure on its first failure timestamp", async () => {
    const createdAt = new Date("2026-07-01T12:00:00.000Z");
    const failureObservedAt = new Date("2026-07-11T12:10:00.000Z");
    const retryObservedAt = new Date("2026-07-11T12:12:00.000Z");
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      createdAt,
      statusEmailSentAt: new Date("2026-07-01T12:00:10.000Z"),
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            automationEligibility: "UNKNOWN",
            policyNotes: null,
            monitoringStatus: {
              state: "HEALTHY",
              firstDegradedAt: null,
              failureFingerprint: null,
              stateChangedAt: new Date("2026-07-01T12:00:05.000Z")
            }
          }
        }
      ]
    });
    dbMocks.listSearchCourseVerdictsSince
      .mockResolvedValueOnce([
        {
          courseId: "course-1",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-10T12:00:00.000Z"),
          failureEpisodeStartedAt: null
        }
      ])
      .mockResolvedValueOnce([
        {
          courseId: "course-1",
          outcome: "NEEDS_ADAPTER",
          observedAt: failureObservedAt,
          failureEpisodeStartedAt: failureObservedAt
        }
      ]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);
    supportIncidentMocks.reportCourseSupportIssue.mockResolvedValue({
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    });

    await runSearchCheck("search-1", "test");
    vi.setSystemTime(retryObservedAt);
    await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledTimes(
      2
    );
    for (const [issue] of supportIncidentMocks.reportCourseSupportIssue.mock
      .calls) {
      expect(issue).toEqual(
        expect.objectContaining({
          searchId: "search-1",
          kind: "NEEDS_ADAPTER",
          episodeStartedAt: failureObservedAt
        })
      );
    }
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
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "cps:grassyhill.cps.golf"
    );
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
            monitoringStatus: {
              state: "FINAL_TECHNICAL",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null
            },
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

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(
      localReaderMocks.getFreshLocalReaderObservation
    ).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith({
      searchId: "search-1",
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-12",
      timeZone: "America/New_York",
      confirmedMatches: []
    });
    expect(dbMocks.listPendingMatchAlerts).toHaveBeenCalledWith("search-1", []);
    expect(dbMocks.markMatchAlertSuppressed).not.toHaveBeenCalled();
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
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

  it("does not re-run a provider while the course is waiting for human review", async () => {
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
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "CAPTCHA_OR_QUEUE",
            monitoringStatus: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null
            },
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

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith({
      searchId: "search-1",
      alertGeneration: 0,
      checkLeaseToken: "check-lease",
      courseId: "course-1",
      date: "2026-07-12",
      timeZone: "America/New_York",
      confirmedMatches: []
    });
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "NEEDS_ADAPTER",
        rawSummary: {
          monitoringDisposition: "HUMAN_REVIEW_PENDING"
        }
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "NEEDS_ADAPTER",
      supportStatus: "NEEDS_HUMAN_REVIEW"
    });
  });

  it("revalidates an escalated incident while keeping the customer status in human review", async () => {
    const firstDegradedAt = new Date("2026-07-11T11:00:00.000Z");
    const escalatedAt = new Date("2026-07-11T11:30:00.000Z");
    const revalidating = {
      ...search,
      statusEmailSentAt: new Date("2026-07-11T11:05:00.000Z"),
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
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            monitoringStatus: {
              state: "AUTO_INVESTIGATING",
              firstDegradedAt,
              failureFingerprint: "FOREUP:NETWORK",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: new Date("2026-07-11T12:00:00.000Z"),
              stateChangedAt: firstDegradedAt
            },
            supportIncident: {
              id: "incident-escalated",
              cycle: 1,
              status: "AUTO_INVESTIGATING",
              attemptLedger: null,
              humanReviewReason: null,
              escalatedAt,
              escalationDeadlineAt: new Date("2026-07-11T13:00:00.000Z"),
              firstSeenAt: firstDegradedAt
            },
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(revalidating);
    adapterMocks.fetchForeupTeeSheet.mockRejectedValue(
      new Error("Temporary public tee-sheet failure")
    );
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledTimes(1);
    expect(result.courseResults[0]).toMatchObject({
      outcome: "FETCH_FAILED",
      supportStatus: "NEEDS_HUMAN_REVIEW"
    });
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "MONITORING_STATUS_UPDATE",
        payload: expect.objectContaining({
          statusSnapshot: [
            expect.objectContaining({
              customerStatus: "NEEDS_HUMAN_REVIEW"
            })
          ]
        })
      })
    );
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup.mock.calls.some(
        ([input]) =>
          input.payload.statusSnapshot?.some(
            (course: { customerStatus?: string }) =>
              course.customerStatus === "RETRYING_AUTOMATICALLY"
          )
      )
    ).toBe(false);
  });

  it("sends monitored recovery after escalated revalidation succeeds durably", async () => {
    const firstDegradedAt = new Date("2026-07-11T11:00:00.000Z");
    const escalatedAt = new Date("2026-07-11T11:30:00.000Z");
    const supportIncident = {
      id: "incident-escalated",
      cycle: 1,
      status: "AUTO_INVESTIGATING" as const,
      attemptLedger: null,
      humanReviewReason: null,
      escalatedAt,
      escalationDeadlineAt: new Date("2026-07-11T13:00:00.000Z"),
      firstSeenAt: firstDegradedAt
    };
    const revalidating = {
      ...search,
      statusEmailSentAt: new Date("2026-07-11T11:05:00.000Z"),
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
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            monitoringStatus: {
              state: "AUTO_INVESTIGATING",
              firstDegradedAt,
              failureFingerprint: "FOREUP:NETWORK",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: new Date("2026-07-11T12:00:00.000Z"),
              stateChangedAt: firstDegradedAt
            },
            supportIncident,
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    };
    const healthy = {
      ...revalidating,
      preferences: [
        {
          ...revalidating.preferences[0],
          course: {
            ...revalidating.preferences[0].course,
            monitoringStatus: {
              state: "HEALTHY",
              firstDegradedAt: null,
              failureFingerprint: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: new Date("2026-07-11T12:10:00.000Z")
            }
          }
        }
      ]
    };
    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(revalidating)
      .mockResolvedValue(healthy);
    deliveryOutboxMocks.listReachedMonitoringOutages.mockResolvedValue([
      {
        courseId: "course-1",
        recipient: "player@resend.dev",
        sentAt: escalatedAt,
        customerStatus: "NEEDS_HUMAN_REVIEW"
      }
    ]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(adapterMocks.fetchForeupTeeSheet).toHaveBeenCalledTimes(1);
    expect(result.courseResults[0]).toMatchObject({ outcome: "NO_MATCH" });
    expect(result.courseResults[0]?.supportStatus).toBeUndefined();
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup
    ).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "MONITORING_RECOVERY" })
    );
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "recovery" })
    );
  });

  it("persists and sends one human-review status update at the endpoint deadline", async () => {
    const firstDegradedAt = new Date("2026-07-11T11:40:00.000Z");
    const escalationDeadlineAt = new Date("2026-07-11T12:10:00.000Z");
    const buildDeadlineSearch = (humanReviewReason: string | null) => ({
      ...search,
      statusEmailSentAt: new Date("2026-07-11T11:45:00.000Z"),
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
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "OTHER",
            monitoringStatus: {
              state: humanReviewReason
                ? "ENGINEERING_VERIFICATION_NEEDED"
                : "AUTO_INVESTIGATING",
              firstDegradedAt,
              failureFingerprint: "FOREUP:UNKNOWN",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: firstDegradedAt
            },
            supportIncident: {
              id: "incident-1",
              cycle: 1,
              status: "AUTO_INVESTIGATING",
              attemptLedger: null,
              humanReviewReason,
              escalatedAt: humanReviewReason ? escalationDeadlineAt : null,
              escalationDeadlineAt,
              firstSeenAt: firstDegradedAt
            },
            bookingMetadata: {
              scheduleId: 6123,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/22518/6123#/teetimes"
            }
          }
        }
      ]
    });

    dbMocks.getActiveSearchForAutomation
      .mockResolvedValueOnce(buildDeadlineSearch(null))
      .mockResolvedValue(buildDeadlineSearch("AUTOMATION_STALLED"));
    courseMonitoringMocks.reconcileCourseMonitoringDeadlines
      .mockResolvedValueOnce({
        checked: 1,
        escalated: 0,
        humanReviewIncidentIds: []
      })
      .mockResolvedValueOnce({
        checked: 1,
        escalated: 1,
        humanReviewIncidentIds: []
      });
    const first = await runSearchCheck("search-1", "test");

    expect(first.courseResults[0]).toMatchObject({
      outcome: "NEEDS_ADAPTER",
      supportStatus: "NEEDS_HUMAN_REVIEW"
    });
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledTimes(1);
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "status-update",
        courses: [
          expect.objectContaining({
            supportStatus: "NEEDS_HUMAN_REVIEW"
          })
        ]
      })
    );
    expect(
      deliveryOutboxMocks.prepareSearchEmailDeliveryGroup.mock.calls[0]?.[0]
        .payload.statusSnapshot[0]
    ).toMatchObject({ customerStatus: "NEEDS_HUMAN_REVIEW" });

    deliveryOutboxMocks.listReachedMonitoringOutages.mockResolvedValue([
      {
        courseId: "course-1",
        recipient: "player@resend.dev",
        sentAt: escalationDeadlineAt,
        customerStatus: "NEEDS_HUMAN_REVIEW"
      }
    ]);
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(
      buildDeadlineSearch("AUTOMATION_STALLED")
    );
    courseMonitoringMocks.reconcileCourseMonitoringDeadlines.mockResolvedValue({
      checked: 0,
      escalated: 0,
      humanReviewIncidentIds: []
    });

    const replay = await runSearchCheck("search-1", "test");
    expect(replay.courseResults[0]).toMatchObject({
      supportStatus: "NEEDS_HUMAN_REVIEW"
    });
    expect(emailMocks.sendSearchStatusEmail).toHaveBeenCalledTimes(1);
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
    expect(
      courseMonitoringMocks.recordCourseMonitoringFinalClassification
    ).toHaveBeenCalledWith(
      expect.objectContaining({ state: "FINAL_IDENTITY" })
    );
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
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

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(adapterMocks.fetchForeupTeeSheet).not.toHaveBeenCalled();
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "IDENTITY_RECHECK",
        message: expect.stringContaining("identity review is due"),
        rawSummary: expect.objectContaining({
          monitoringDisposition: "IDENTITY_RECHECK"
        })
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "IDENTITY_RECHECK",
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

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(dbMocks.markMissingMatchesUnavailable).toHaveBeenCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        courseId: "course-1",
        confirmedMatches: []
      })
    );
    expect(result.courseResults[0]).toMatchObject({
      outcome: "MANUAL_DIRECT",
      automationReason: "NO_ONLINE_BOOKING",
      bookingAccess: "PHONE_ONLY",
      monitoringDisposition: "MANUAL_FINAL"
    });
  });

  it("preserves a durable manual decision after raw intelligence ages out", async () => {
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            isPublic: true,
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "SOURCE_MISSING",
            bookingMethod: "PHONE_ONLY",
            bookingPhone: "(860) 555-0102",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            intelligenceVerifiedAt: null,
            intelligenceReviewAt: null,
            intelligenceConfidence: null,
            monitoringStatus: { state: "FINAL_MANUAL" }
          }
        }
      ]
    });
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    const result = await runSearchCheck("search-1", "test");

    expect(
      providerRequestLeaseMocks.runWithProviderRequestLease
    ).not.toHaveBeenCalled();
    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toMatchObject({
      outcome: "MANUAL_DIRECT",
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

    expect(
      monitoringDiscoveryMocks.prepareSearchMonitoring
    ).toHaveBeenCalledWith(
      unsupportedSearch,
      undefined,
      new Date("2026-07-11T12:10:00.000Z"),
      undefined
    );
    expect(
      monitoringDiscoveryMocks.prepareSearchMonitoring.mock
        .invocationCallOrder[0]
    ).toBeLessThan(
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

    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
    expect(result.courseResults[0]).toEqual(
      expect.objectContaining({
        outcome: "NEEDS_ADAPTER",
        message: expect.stringContaining("will retry shortly")
      })
    );
    expect(result.supportRetryNeeded).toBe(true);
  });

  it("advances to rendered-browser discovery after one deferred official HTTP retry", async () => {
    let ledger = buildPlaybookThroughTypedAdapter();
    ledger = appendPlaybookEvent(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "STARTED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "OFFICIAL_HTTP:DISCOVERY"
    });
    ledger = appendPlaybookEvent(ledger, {
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "FAILED_RETRYABLE",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "OFFICIAL_HTTP:DISCOVERY",
      failureClass: "UNKNOWN"
    });
    const playbook = installPlaybookPersistence(ledger);
    const unsupportedSearch = {
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            automationEligibility: "UNKNOWN",
            automationReason: "OTHER",
            policyNotes: null,
            supportIncident: playbook.context()
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

    expect(
      playbook.getLedger().events.slice(-3).map((event) => [
        event.stage,
        event.transition
      ])
    ).toEqual([
      ["OFFICIAL_HTTP_DISCOVERY", "STARTED"],
      ["OFFICIAL_HTTP_DISCOVERY", "FAILED_TERMINAL"],
      ["HTTP_ADAPTER_RETRY", "NOT_APPLICABLE"]
    ]);
    expect(assessAutomationPlaybook(playbook.getLedger(), 1)).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "RENDERED_BROWSER_DISCOVERY"
    });
    expect(result.courseResults[0]).toMatchObject({
      outcome: "CHECK_PENDING",
      message: expect.stringContaining("rendered-browser")
    });
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

    expect(
      supportIncidentMocks.reportCourseSupportIssue
    ).not.toHaveBeenCalled();
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

  it("keeps an edited generation fresh through unchanged booking-window success and later failure", async () => {
    const generationStartedAt = new Date("2026-07-11T12:04:00.000Z");
    const failureObservedAt = new Date("2026-07-11T12:12:00.000Z");
    const generationMarker = {
      schemaVersion: 1,
      kind: "ALERT_GENERATION_START",
      alertGeneration: 3,
      generationStartedAt: generationStartedAt.toISOString()
    };
    const bookingWindowCourse = {
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
    };
    const editedSearch = {
      ...search,
      alertGeneration: 3,
      statusEmailSnapshot: generationMarker,
      date: new Date("2026-07-29T00:00:00.000Z"),
      preferences: [{ rank: 1, course: bookingWindowCourse }]
    };
    dbMocks.getActiveSearchForAutomation.mockResolvedValue(editedSearch);
    dbMocks.listSearchCourseVerdictsSince
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          courseId: "course-1",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-11T12:10:00.000Z"),
          failureEpisodeStartedAt: null
        }
      ]);
    dbMocks.listPendingMatchAlerts.mockResolvedValue([]);
    dbMocks.listAvailableMatchAlerts.mockResolvedValue([]);

    await runSearchCheck("search-1", "test");

    expect(dbMocks.recordCourseProbeIfChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "course-1",
        outcome: "NO_MATCH",
        observedAtOrAfter: generationStartedAt
      })
    );

    const persistedSnapshot = preserveAlertGenerationClockInStatusSnapshot({
      alertGeneration: 3,
      currentStatusEmailSnapshot: generationMarker,
      courseSnapshot: []
    });
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...editedSearch,
      statusEmailSentAt: new Date("2026-07-11T12:10:00.000Z"),
      statusEmailSnapshot: persistedSnapshot,
      preferences: [
        {
          rank: 1,
          course: {
            ...bookingWindowCourse,
            detectedPlatform: "UNKNOWN",
            providerFamilyKey: "UNKNOWN",
            detectedBookingUrl: null,
            automationEligibility: "UNKNOWN",
            policyNotes: null,
            bookingMetadata: null,
            bookingWindowDaysAhead: null,
            bookingReleaseTimeLocal: null,
            bookingWindowSource: null,
            bookingWindowConfidence: null,
            bookingWindowEvidenceUrl: null,
            bookingWindowCheckedAt: null,
            bookingWindowObservedAt: null
          }
        }
      ]
    });
    vi.setSystemTime(failureObservedAt);

    await runSearchCheck("search-1", "test");

    expect(supportIncidentMocks.reportCourseSupportIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        course: expect.objectContaining({ id: "course-1" }),
        episodeStartedAt: failureObservedAt,
        kind: "NEEDS_ADAPTER"
      })
    );
  });

  it("passes a stored official rule page to ForeUP when refreshing booking-window evidence", async () => {
    const evidenceUrl =
      "https://www.tashuaknolls.com/tee-times-fees/reservations/";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            detectedPlatform: "FOREUP",
            detectedBookingUrl:
              "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes: null,
            bookingMetadata: {
              scheduleId: 6654,
              bookingBaseUrl:
                "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
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
        metadata: expect.objectContaining({
          bookingWindowEvidenceUrl: evidenceUrl
        })
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
              bookingBaseUrl:
                "https://www.chronogolf.com/club/blue-rock-golf-course"
            }
          }
        }
      ]
    });
    adapterMocks.fetchChronogolfSlots.mockResolvedValueOnce([
      {
        sourceId: "blue-rock-2026-07-12-0800",
        startsAt: "2026-07-12T08:00",
        availableSpots: 4,
        bookingUrl: "https://www.chronogolf.com/club/blue-rock-golf-course",
        bookableHoleCounts: [9, 18]
      }
    ]);
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
    expect(dbMocks.recordCourseBookingFacts).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        bookableHoleCounts: [9, 18]
      })
    );
    expect(courseMonitoringMocks.recordCourseMonitoringSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: "blue-rock",
        outcome: "NO_MATCH"
      })
    );
    expect(
      supportIncidentMocks.resolveCourseSupportIncident
    ).not.toHaveBeenCalled();
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
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "windsor-parke",
            name: "Windsor Parke Golf Club",
            detectedPlatform: "CUSTOM",
            detectedBookingUrl: bookingBaseUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes:
              "Public availability is exposed without login; booking stays on GolfBack.",
            bookingMetadata: {
              provider: "GOLFBACK",
              courseId: "5a90fb0c-b928-43f0-9486-d5d43c03d25d",
              bookingBaseUrl
            }
          }
        }
      ]
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
        metadata: expect.objectContaining({
          provider: "GOLFBACK",
          bookingBaseUrl
        })
      })
    );
  });

  it("dispatches reusable WebTrac metadata to the signed-out search adapter", async () => {
    const bookingBaseUrl =
      "https://myffr.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "casa-linda",
            name: "Casa Linda Oaks Golf Club",
            detectedPlatform: "CUSTOM",
            detectedBookingUrl: bookingBaseUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes:
              "Read-only signed-out search; booking remains on WebTrac.",
            bookingMetadata: {
              provider: "WEBTRAC",
              courseCode: "25",
              bookingBaseUrl
            }
          }
        }
      ]
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
        metadata: expect.objectContaining({
          provider: "WEBTRAC",
          courseCode: "25"
        })
      })
    );
  });

  it("dispatches reusable Club Caddie metadata to the anonymous public adapter", async () => {
    const bookingBaseUrl =
      "https://apimanager-cc28.clubcaddie.com/webapi/view/public-course/slots";
    dbMocks.getActiveSearchForAutomation.mockResolvedValue({
      ...search,
      preferences: [
        {
          rank: 1,
          course: {
            ...search.preferences[0].course,
            id: "ponemah",
            name: "Ponemah Green Family Golf Center",
            detectedPlatform: "CLUB_CADDIE",
            detectedBookingUrl: bookingBaseUrl,
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            policyNotes:
              "Read-only signed-out availability; booking remains on Club Caddie.",
            bookingMetadata: {
              provider: "CLUB_CADDIE",
              bookingBaseUrl
            }
          }
        }
      ]
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
