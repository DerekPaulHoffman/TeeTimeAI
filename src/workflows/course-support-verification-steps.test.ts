import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerReadMocks = vi.hoisted(() => ({
  fetchCourseTeeSheet: vi.fn(),
}));

const playbookMocks = vi.hoisted(() => ({
  loadCourseMonitoringPlaybookRuntime: vi.fn(),
  recordRuntimePlaybookTransition: vi.fn(),
}));

const courseMonitoringMocks = vi.hoisted(() => ({
  recordCourseMonitoringFinalClassification: vi.fn(),
}));

const supportIncidentMocks = vi.hoisted(() => ({
  resolveCourseSupportIncident: vi.fn(),
}));

const verificationMocks = vi.hoisted(() => ({
  attachCourseSupportVerificationProviderSnapshot: vi.fn(),
  buildCourseSupportProviderSnapshotFingerprint: vi.fn(),
  completeCourseSupportVerificationFactualFinal: vi.fn(),
  completeCourseSupportVerificationRequest: vi.fn(),
  failCourseSupportVerificationRequest: vi.fn(),
  heartbeatCourseSupportVerificationRequest: vi.fn(),
  markCourseSupportVerificationDiscoveryAttempted: vi.fn(),
  markCourseSupportVerificationDiscoveryVerified: vi.fn(),
}));

const discoveryMocks = vi.hoisted(() => ({
  prepareCourseSupportVerificationMonitoring: vi.fn(),
}));

const capabilityMocks = vi.hoisted(() => ({
  classifyProviderFailure: vi.fn(),
  getProviderReadinessFailure: vi.fn(),
  normalizeProviderFamilyKey: vi.fn(),
  resolveProviderCapability: vi.fn(),
}));

const providerLeaseMocks = vi.hoisted(() => ({
  runWithProviderRequestLease: vi.fn(),
}));

const providerObservationMocks = vi.hoisted(() => ({
  beginCourseProviderObservation: vi.fn(),
  markCourseProviderObservationUnreconciled: vi.fn(),
  releaseCourseProviderObservation: vi.fn(),
  assertOwned: vi.fn(),
  stop: vi.fn(),
  startCourseProviderObservationHeartbeat: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  getAutomationRuntimeVersion: vi.fn(),
}));

const deliveryMocks = vi.hoisted(() => ({
  getSafeOfficialBookingUrl: vi.fn(),
}));

const localReaderMocks = vi.hoisted(() => ({
  getLocalReaderCourseKey: vi.fn(),
  getLocalReaderCourseVerification: vi.fn(),
  queueLocalReaderCourseVerification: vi.fn(),
}));

const prismaMocks = vi.hoisted(() => ({
  courseFindUnique: vi.fn(),
}));

vi.mock("@/lib/automation/course-provider-read", () => providerReadMocks);
vi.mock(
  "@/lib/automation/course-monitoring-playbook-runtime",
  () => playbookMocks,
);
vi.mock("@/lib/automation/course-monitoring", () => courseMonitoringMocks);
vi.mock("@/lib/automation/support-incidents", () => supportIncidentMocks);
vi.mock(
  "@/lib/automation/course-support-verification",
  () => verificationMocks,
);
vi.mock("@/lib/automation/search-monitoring-discovery", () => discoveryMocks);
vi.mock("@/lib/automation/provider-capabilities", () => capabilityMocks);
vi.mock("@/lib/automation/provider-request-lease", () => providerLeaseMocks);
vi.mock(
  "@/lib/automation/provider-execution-marker",
  () => providerObservationMocks,
);
vi.mock("@/lib/automation/runtime-version", () => runtimeMocks);
vi.mock("@/lib/email/search-delivery-outbox", () => deliveryMocks);
vi.mock("@/lib/local-reader/service", () => localReaderMocks);
vi.mock("@/lib/prisma", () => ({
  prisma: { course: { findUnique: prismaMocks.courseFindUnique } },
}));

import { executeCourseSupportVerificationStep } from "./course-support-verification-steps";
import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  type AutomationPlaybookEventInput,
  type AutomationPlaybookLedger,
} from "@/lib/automation/course-monitoring-playbook";

const runtimeVersion = "a".repeat(40);
const input = {
  requestId: "verification-request-1",
  expectedRevision: 3,
  leaseToken: "lease-1",
  runtimeVersion,
};

const intent = {
  targetDateLocal: "2026-07-24",
  startTimeLocal: "06:00",
  endTimeLocal: "20:00",
  timeZone: "America/New_York",
  players: 1,
};

const course = {
  id: "course-1",
  timeZone: "America/New_York",
  website: "https://course.example",
  detectedBookingUrl: "https://booking.example/tee-times",
  providerFamilyKey: "CPS",
  detectedPlatform: "CUSTOM",
  bookingMetadata: { provider: "CPS", tenantId: "tenant-1" },
  bookingWindowEvidenceUrl: null,
  bookingWindowDaysAhead: 7,
  bookingReleaseTimeLocal: "07:00",
  bookingWindowSource: "PROVIDER_CONFIG",
  bookingWindowConfidence: 0.9,
  bookingMethod: "PUBLIC_ONLINE",
  automationEligibility: "ALLOWED",
  automationReason: "PUBLIC_READ_ONLY",
  monitoringMode: "AUTOMATIC",
  bookingAccessMode: "PUBLIC_SIGNED_OUT",
  isPublic: true,
  intelligenceVerifiedAt: null,
  intelligenceReviewAt: null,
  intelligenceConfidence: null,
  layoutHoleCounts: [],
  layoutHolesVerifiedAt: null,
};

const discoveryAttemptedAt = new Date("2026-07-21T12:00:00.000Z");
const discoveryVerifiedAt = new Date("2026-07-21T12:00:01.000Z");

function slot(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: "slot-1",
    courseId: "course-1",
    startsAt: "2026-07-24T08:00:00",
    availableSpots: 4,
    bookingUrl: "https://booking.example/tee-times",
    ...overrides,
  };
}

function allowOwnedExecution() {
  verificationMocks.attachCourseSupportVerificationProviderSnapshot
    .mockResolvedValueOnce({
      attached: true,
      revision: 4,
      providerSnapshotFingerprint: "before-discovery",
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent,
    })
    .mockResolvedValueOnce({
      attached: true,
      revision: 6,
      providerSnapshotFingerprint: "after-discovery",
      discoveryAttemptedAt,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent,
    });
}

function allowOwnedDiscovery() {
  verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
    {
      attached: true,
      revision: 4,
      providerSnapshotFingerprint: "before-discovery",
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent,
    },
  );
}

function allowDirectDiscoveryVerification() {
  verificationMocks.markCourseSupportVerificationDiscoveryVerified.mockResolvedValueOnce(
    {
      marked: true,
      revision: 6,
      discoveryAttemptedAt,
      discoveryVerifiedAt: discoveryAttemptedAt,
    },
  );
}

function installPlaybookRuntime(
  seed: AutomationPlaybookEventInput[] = [],
  afterTransition?: () => void,
) {
  let ledger: AutomationPlaybookLedger | null = null;
  for (const event of seed) {
    ledger = appendAutomationPlaybookEvent(ledger, event);
  }
  const runtime = {
    courseId: "course-1",
    incidentId: "incident-1",
    cycle: 1,
    assessment: assessAutomationPlaybook(ledger, 1),
    localReaderTechnicalReason:
      [...seed]
        .reverse()
        .find(
          (event) =>
            event.stage === "LOCAL_READER" &&
            event.transition === "TECHNICAL_LIMITATION",
        )?.technicalReason ?? null,
  };
  playbookMocks.loadCourseMonitoringPlaybookRuntime.mockResolvedValue(runtime);
  playbookMocks.recordRuntimePlaybookTransition.mockImplementation(
    async (_runtime, event) => {
      const { now, ...playbookEvent } = event;
      ledger = appendAutomationPlaybookEvent(ledger, {
        cycle: 1,
        ...playbookEvent,
        failureFingerprint: `PLAYBOOK:${event.stage}:${event.failureClass ?? event.skipReason ?? event.technicalReason ?? event.transition}`,
        observedAt: now ?? new Date(),
      });
      runtime.assessment = assessAutomationPlaybook(ledger, 1);
      if (
        event.stage === "LOCAL_READER" &&
        event.transition === "TECHNICAL_LIMITATION"
      ) {
        runtime.localReaderTechnicalReason = event.technicalReason;
      }
      afterTransition?.();
      return {
        recorded: true,
        result: {
          replayed: false,
          incidentId: "incident-1",
          incidentRevision: 2,
          ledger,
          assessment: runtime.assessment,
        },
      };
    },
  );
  return runtime;
}

function completedPlaybookSeedThroughRenderedBrowser(): AutomationPlaybookEventInput[] {
  const observedAt = new Date("2026-07-21T11:55:00.000Z");
  return [
    {
      cycle: 1,
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "TYPED_ADAPTER",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PLAYBOOK:TYPED_ADAPTER:CHALLENGE",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "OFFICIAL_HTTP_DISCOVERY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_HTTP",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_HTTP_DISCOVERY:COMPLETED",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "HTTP_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PLAYBOOK:HTTP_ADAPTER_RETRY:CHALLENGE",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "RENDERED_BROWSER_DISCOVERY",
      transition: "TECHNICAL_LIMITATION",
      readPath: "RENDERED_BROWSER",
      evidenceKind: "RENDERED_PAGE",
      technicalReason: "CAPTCHA_OR_QUEUE",
      failureFingerprint:
        "PLAYBOOK:RENDERED_BROWSER_DISCOVERY:CAPTCHA_OR_QUEUE",
      runtimeVersion,
      observedAt,
    },
  ];
}

function completedPlaybookSeedThroughBrowserAdapter(): AutomationPlaybookEventInput[] {
  return [
    ...completedPlaybookSeedThroughRenderedBrowser(),
    {
      cycle: 1,
      stage: "BROWSER_ADAPTER_RETRY",
      transition: "FAILED_TERMINAL",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureClass: "CHALLENGE",
      failureFingerprint: "PLAYBOOK:BROWSER_ADAPTER_RETRY:CHALLENGE",
      runtimeVersion,
      observedAt: new Date("2026-07-21T11:56:00.000Z"),
    },
  ];
}

function completedPlaybookSeedThroughTypedAdapter(): AutomationPlaybookEventInput[] {
  const observedAt = new Date("2026-07-21T11:59:00.000Z");
  return [
    {
      cycle: 1,
      stage: "OFFICIAL_IDENTITY",
      transition: "COMPLETED",
      readPath: "OFFICIAL_IDENTITY",
      evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "TYPED_ADAPTER",
      transition: "SUCCEEDED",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "PROVIDER_RESPONSE",
      failureFingerprint: "PLAYBOOK:TYPED_ADAPTER:SUCCEEDED",
      runtimeVersion,
      observedAt,
    },
  ];
}

function completedPlaybookSeedThroughLocalReader(): AutomationPlaybookEventInput[] {
  return [
    ...completedPlaybookSeedThroughBrowserAdapter(),
    {
      cycle: 1,
      stage: "LOCAL_READER",
      transition: "SUCCEEDED",
      readPath: "LOCAL_READER",
      evidenceKind: "LOCAL_READER_RESULT",
      failureFingerprint: "PLAYBOOK:LOCAL_READER:SUCCEEDED",
      runtimeVersion: "reader-v1",
      observedAt: new Date("2026-07-21T11:59:00.000Z"),
    },
  ];
}

function completedPlaybookSeedThroughIndependentFactualFinal(
  disposition: "MANUAL_DIRECT" | "IDENTITY_FINAL",
): AutomationPlaybookEventInput[] {
  const observedAt = new Date("2026-07-21T11:59:00.000Z");
  return [
    ...completedPlaybookSeedThroughBrowserAdapter(),
    {
      cycle: 1,
      stage: "LOCAL_READER",
      transition: "NOT_APPLICABLE",
      readPath: "LOCAL_READER",
      evidenceKind: "TOOLING",
      skipReason: "NO_LOCAL_READER_CAPABILITY",
      failureFingerprint: "PLAYBOOK:LOCAL_READER:NO_LOCAL_READER_CAPABILITY",
      runtimeVersion,
      observedAt,
    },
    {
      cycle: 1,
      stage: "INDEPENDENT_CONFIRMATION",
      transition: "FACTUAL_FINAL",
      readPath: "INDEPENDENT_CONFIRMATION",
      evidenceKind: "RENDERED_PAGE",
      factualDisposition: disposition,
      failureFingerprint: `PLAYBOOK:INDEPENDENT_CONFIRMATION:${disposition}`,
      runtimeVersion,
      observedAt,
    },
  ];
}

function allowDeferredFailureConfirmation() {
  verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
    {
      attached: true,
      revision: 4,
      providerFamilyKeySnapshot: "CPS",
      providerSnapshotFingerprint: "current-provider-snapshot",
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
      courseId: "course-1",
      intent,
      deferredFailureConfirmation: true,
    },
  );
}

describe("executeCourseSupportVerificationStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-21T12:00:00.000Z"));

    runtimeMocks.getAutomationRuntimeVersion.mockReturnValue(runtimeVersion);
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      "current-provider-snapshot",
    );
    capabilityMocks.normalizeProviderFamilyKey.mockImplementation(
      (value: string) => value.trim().toUpperCase(),
    );
    playbookMocks.loadCourseMonitoringPlaybookRuntime.mockResolvedValue(null);
    verificationMocks.heartbeatCourseSupportVerificationRequest.mockResolvedValue(
      {
        renewed: true,
      },
    );
    verificationMocks.completeCourseSupportVerificationRequest.mockResolvedValue(
      {
        completed: true,
      },
    );
    verificationMocks.completeCourseSupportVerificationFactualFinal.mockImplementation(
      async ({ disposition }) => ({
        completed: true,
        outcome: disposition,
      }),
    );
    verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mockResolvedValue(
      {
        marked: true,
        revision: 5,
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
      },
    );
    verificationMocks.markCourseSupportVerificationDiscoveryVerified.mockResolvedValue(
      {
        marked: true,
        revision: 7,
        discoveryAttemptedAt,
        discoveryVerifiedAt,
      },
    );
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "FAILED",
    });
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue(
      {
        attemptedCourseIds: ["course-1"],
        appliedCourseIds: ["course-1"],
        failedCourseIds: [],
        deferredCourseIds: [],
        retryCourseIds: [],
      },
    );
    prismaMocks.courseFindUnique.mockResolvedValue(course);
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CPS",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false,
    });
    capabilityMocks.getProviderReadinessFailure.mockReturnValue(null);
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "NETWORK",
      httpStatus: null,
      retryAfterSeconds: null,
    });
    providerLeaseMocks.runWithProviderRequestLease.mockImplementation(
      async (_providerFamily: string, worker: () => Promise<unknown>) => ({
        acquired: true,
        value: await worker(),
      }),
    );
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValue({
      courseId: "course-1",
      leaseToken: "provider-observation-1",
      observationStartedAt: new Date("2026-07-21T12:00:00.000Z"),
      leaseExpiresAt: new Date("2026-07-21T12:20:00.000Z"),
      ttlMs: 20 * 60_000,
    });
    providerObservationMocks.assertOwned.mockReturnValue(undefined);
    providerObservationMocks.stop.mockResolvedValue(undefined);
    providerObservationMocks.startCourseProviderObservationHeartbeat.mockReturnValue(
      {
        assertOwned: providerObservationMocks.assertOwned,
        stop: providerObservationMocks.stop,
      },
    );
    providerObservationMocks.markCourseProviderObservationUnreconciled.mockResolvedValue(
      true,
    );
    providerObservationMocks.releaseCourseProviderObservation.mockResolvedValue(
      undefined,
    );
    deliveryMocks.getSafeOfficialBookingUrl.mockImplementation(
      (value: unknown) =>
        typeof value === "string" && !value.includes("/checkout")
          ? value
          : undefined,
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(null);
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue(null);
    localReaderMocks.queueLocalReaderCourseVerification.mockResolvedValue({
      id: "reader-verification-1",
    });
  });

  it("executes one provider read for an authenticated deferred confirmation on an exhausted ledger", async () => {
    allowDeferredFailureConfirmation();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({ slots: [] });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          outcome: "NO_MATCH",
          providerExecution: true,
        }),
      }),
    );
  });

  it("fails closed for a local-reader-only deferred course without acquiring a provider lease", async () => {
    allowDeferredFailureConfirmation();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      monitoringMode: "LOCAL_READER_ONLY",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "stopped",
      reason: "monitoring_not_actionable",
    });

    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
  });

  it("stops before the provider lease when the final deferred pre-I/O mark observes an authoritative winner", async () => {
    allowDeferredFailureConfirmation();
    verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mockResolvedValueOnce(
      { marked: false, reason: "monitoring_not_actionable" },
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "stopped",
      reason: "monitoring_not_actionable",
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).toHaveBeenCalledOnce();
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "full provider snapshot drift",
      arrange: () =>
        verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
          "changed-provider-snapshot",
        ),
    },
    {
      label: "normalized provider family drift",
      arrange: () =>
        capabilityMocks.normalizeProviderFamilyKey.mockReturnValue(
          "CHANGED_FAMILY",
        ),
    },
  ])(
    "stops deferred I/O after the post-attach reload detects $label",
    async ({ arrange }) => {
      allowDeferredFailureConfirmation();
      arrange();

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "stopped",
        reason: "provider_snapshot_changed",
      });

      expect(
        providerLeaseMocks.runWithProviderRequestLease,
      ).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
    },
  );

  it("propagates the provider retry floor from a deferred provider failure", async () => {
    allowDeferredFailureConfirmation();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider throttled"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterSeconds: 30 * 60,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "STALE",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "RATE_LIMIT",
        retryAfterSeconds: 30 * 60,
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        observation: expect.objectContaining({
          httpStatus: 429,
          providerExecution: true,
        }),
      }),
    );
  });

  it.each(["discovery mark", "completion"])(
    "does not rewrite a healthy deferred response as provider failure when $label persistence throws",
    async (label) => {
      allowDeferredFailureConfirmation();
      verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
        { attached: false, reason: "stale_revision" },
      );
      providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({ slots: [] });
      if (label === "discovery mark") {
        verificationMocks.markCourseSupportVerificationDiscoveryVerified.mockRejectedValueOnce(
          new Error("discovery CAS unavailable"),
        );
      } else {
        verificationMocks.completeCourseSupportVerificationRequest.mockRejectedValueOnce(
          new Error("completion CAS unavailable"),
        );
      }

      await expect(executeCourseSupportVerificationStep(input)).rejects.toThrow(
        label === "discovery mark"
          ? "discovery CAS unavailable"
          : "completion CAS unavailable",
      );
      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "stopped",
        reason: "stale_revision",
      });

      expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
      expect(capabilityMocks.classifyProviderFailure).not.toHaveBeenCalled();
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
    },
  );

  it("does not classify provider-lease persistence errors as provider read failures", async () => {
    allowDeferredFailureConfirmation();
    providerLeaseMocks.runWithProviderRequestLease.mockRejectedValue(
      new Error("provider lease store unavailable"),
    );

    await expect(executeCourseSupportVerificationStep(input)).rejects.toThrow(
      "provider lease store unavailable",
    );

    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(capabilityMocks.classifyProviderFailure).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it.each([
    "tampered source",
    "tampered admission",
    "consumed",
    "route drift",
    "technical revision drift",
  ])(
    "does not fall back to ordinary playbook or provider I/O after terminal deferred %s rejection",
    async () => {
      verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
        { attached: false, reason: "invalid_evidence" },
      );

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "stopped",
        reason: "invalid_evidence",
      });

      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring,
      ).not.toHaveBeenCalled();
      expect(
        playbookMocks.recordRuntimePlaybookTransition,
      ).not.toHaveBeenCalled();
      expect(
        playbookMocks.loadCourseMonitoringPlaybookRuntime,
      ).not.toHaveBeenCalled();
    },
  );

  it("does not execute the deferred provider read again after a restarted step", async () => {
    allowDeferredFailureConfirmation();
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
      { attached: false, reason: "stale_revision" },
    );
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({ slots: [] });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });
    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "stopped",
      reason: "stale_revision",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops an exact-runtime mismatch before any database or network I/O", async () => {
    runtimeMocks.getAutomationRuntimeVersion.mockReturnValue("b".repeat(40));

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "runtime_mismatch",
    });

    expect(
      verificationMocks.attachCourseSupportVerificationProviderSnapshot,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.heartbeatCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseFindUnique).not.toHaveBeenCalled();
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "private identity",
      overrides: { isPublic: false },
      failureClass: "UNSUPPORTED_FAMILY",
    },
    {
      label: "account requirement",
      overrides: {
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
      },
      failureClass: "AUTH",
    },
    {
      label: "captcha or queue",
      overrides: {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
      },
      failureClass: "CHALLENGE",
    },
    {
      label: "manual booking",
      overrides: {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
      },
      failureClass: "UNSUPPORTED_FAMILY",
    },
  ])(
    "performs no discovery or provider I/O for a current $label disposition",
    async ({ overrides, failureClass }) => {
      allowOwnedDiscovery();
      prismaMocks.courseFindUnique.mockResolvedValue({
        ...course,
        ...overrides,
        intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
        intelligenceConfidence: 0.95,
      });

      await executeCourseSupportVerificationStep(input);

      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedRevision: 4,
          failureClass,
          observation: expect.objectContaining({ providerExecution: false }),
        }),
      );
      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
      ).not.toHaveBeenCalled();
      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring,
      ).not.toHaveBeenCalled();
      expect(
        providerLeaseMocks.runWithProviderRequestLease,
      ).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    },
  );

  it("uses high-confidence runnable provider evidence when fresh official discovery has a network failure", async () => {
    allowOwnedExecution();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      intelligenceVerifiedAt: new Date("2026-07-21T11:30:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
      intelligenceConfidence: 0.95,
    });
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue(
      {
        attemptedCourseIds: ["course-1"],
        appliedCourseIds: [],
        failedCourseIds: ["course-1"],
        deferredCourseIds: [],
        retryCourseIds: ["course-1"],
      },
    );
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [slot()],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "MATCH_FOUND",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalled();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).toHaveBeenCalled();
  });

  it("uses the normal capped discovery path after the one-shot attempt is persisted", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
      {
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "before-discovery",
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
        courseId: "course-1",
        intent,
      },
    );
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue(
      {
        attemptedCourseIds: [],
        appliedCourseIds: [],
        failedCourseIds: [],
        deferredCourseIds: [],
        retryCourseIds: ["course-1"],
      },
    );

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).toHaveBeenCalledWith(
      "course-1",
      undefined,
      new Date("2026-07-21T12:00:00.000Z"),
      { forceFresh: false },
    );
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        failureClass: "RATE_LIMIT",
        retryAt: new Date("2026-07-21T12:15:00.000Z"),
      }),
    );
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
  });

  it("reuses verified discovery on a provider-only retry", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot
      .mockResolvedValueOnce({
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "verified-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        courseId: "course-1",
        intent,
      })
      .mockResolvedValueOnce({
        attached: true,
        revision: 5,
        providerSnapshotFingerprint: "verified-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt,
        courseId: "course-1",
        intent,
      });
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 5 }));
  });

  it.each([
    {
      label: "not attempted",
      result: {
        attemptedCourseIds: [],
        appliedCourseIds: [],
        failedCourseIds: [],
        deferredCourseIds: [],
        retryCourseIds: [],
      },
      failureClass: "MISSING_SOURCE",
      retryAt: undefined,
    },
    {
      label: "failed",
      result: {
        attemptedCourseIds: ["course-1"],
        appliedCourseIds: [],
        failedCourseIds: ["course-1"],
        deferredCourseIds: [],
        retryCourseIds: ["course-1"],
      },
      failureClass: "NETWORK",
      retryAt: new Date("2026-07-21T12:15:00.000Z"),
    },
    {
      label: "deferred",
      result: {
        attemptedCourseIds: [],
        appliedCourseIds: [],
        failedCourseIds: [],
        deferredCourseIds: ["course-1"],
        retryCourseIds: ["course-1"],
      },
      failureClass: "RATE_LIMIT",
      retryAt: new Date("2026-07-21T12:02:00.000Z"),
    },
  ])(
    "fails closed when forced discovery is $label",
    async ({ result, failureClass, retryAt }) => {
      allowOwnedDiscovery();
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue(
        result,
      );

      await executeCourseSupportVerificationStep(input);

      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "verification-request-1",
          expectedRevision: 5,
          leaseToken: "lease-1",
          runtimeVersion,
          failureClass,
          retryAt,
          observation: expect.objectContaining({ providerExecution: false }),
        }),
      );
      expect(
        verificationMocks.attachCourseSupportVerificationProviderSnapshot,
      ).toHaveBeenCalledTimes(1);
      expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
      expect(
        providerLeaseMocks.runWithProviderRequestLease,
      ).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.completeCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
    },
  );

  it("terminalizes a previously retried official HTTP stage before advancing", async () => {
    const observedAt = new Date("2026-07-21T11:55:00.000Z");
    const runtime = installPlaybookRuntime([
      {
        cycle: 1,
        stage: "OFFICIAL_IDENTITY",
        transition: "COMPLETED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY:COMPLETED",
        runtimeVersion,
        observedAt,
      },
      {
        cycle: 1,
        stage: "TYPED_ADAPTER",
        transition: "FAILED_TERMINAL",
        readPath: "TYPED_PROVIDER_ADAPTER",
        evidenceKind: "PROVIDER_RESPONSE",
        failureClass: "CHALLENGE",
        failureFingerprint: "PLAYBOOK:TYPED_ADAPTER:CHALLENGE",
        runtimeVersion,
        observedAt,
      },
      {
        cycle: 1,
        stage: "OFFICIAL_HTTP_DISCOVERY",
        transition: "STARTED",
        readPath: "OFFICIAL_HTTP",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "PLAYBOOK:OFFICIAL_HTTP_DISCOVERY:NETWORK",
        runtimeVersion,
        observedAt,
      },
      {
        cycle: 1,
        stage: "OFFICIAL_HTTP_DISCOVERY",
        transition: "FAILED_RETRYABLE",
        readPath: "OFFICIAL_HTTP",
        evidenceKind: "OFFICIAL_SOURCE",
        failureClass: "NETWORK",
        failureFingerprint: "PLAYBOOK:OFFICIAL_HTTP_DISCOVERY:NETWORK",
        runtimeVersion,
        observedAt,
      },
    ]);
    allowOwnedDiscovery();
    discoveryMocks.prepareCourseSupportVerificationMonitoring.mockResolvedValue({
      attemptedCourseIds: ["course-1"],
      appliedCourseIds: [],
      failedCourseIds: ["course-1"],
      deferredCourseIds: [],
      retryCourseIds: ["course-1"],
    });
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider still unavailable"),
    );

    await executeCourseSupportVerificationStep(input);

    expect(playbookMocks.recordRuntimePlaybookTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "OFFICIAL_HTTP_DISCOVERY",
        transition: "FAILED_TERMINAL",
        failureClass: "NETWORK",
      }),
    );
    expect(
      runtime.assessment.stages.find(
        (stage) => stage.stage === "OFFICIAL_HTTP_DISCOVERY",
      ),
    ).toMatchObject({ status: "FAILED_TERMINAL", attemptCount: 2 });
    expect(runtime.assessment.nextStage).not.toBe("OFFICIAL_HTTP_DISCOVERY");
  });

  it("stops when the authoritative request course changes during discovery", async () => {
    verificationMocks.attachCourseSupportVerificationProviderSnapshot
      .mockResolvedValueOnce({
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "before-discovery",
        discoveryAttemptedAt: null,
        discoveryVerifiedAt: null,
        courseId: "course-1",
        intent,
      })
      .mockResolvedValueOnce({
        attached: true,
        revision: 6,
        providerSnapshotFingerprint: "after-discovery",
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
        courseId: "course-2",
        intent,
      });

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 6,
        failureClass: "SCHEMA",
        observation: expect.objectContaining({ providerExecution: false }),
      }),
    );
    expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
  });

  it.each([
    { providerOutcome: "NO_MATCH" as const, slots: [], availabilityCount: 0 },
    {
      providerOutcome: "MATCH_FOUND" as const,
      slots: [slot()],
      availabilityCount: 1,
    },
  ])(
    "completes a safe $providerOutcome through the provider lease",
    async ({ providerOutcome, slots, availabilityCount }) => {
      allowOwnedExecution();
      providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
        slots,
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null,
      });

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "completed",
        providerOutcome,
      });

      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 4,
        leaseToken: "lease-1",
        runtimeVersion,
      });
      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring,
      ).toHaveBeenCalledWith(
        "course-1",
        undefined,
        new Date("2026-07-21T12:00:00.000Z"),
        { forceFresh: true },
      );
      expect(
        verificationMocks.markCourseSupportVerificationDiscoveryVerified,
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 6,
        leaseToken: "lease-1",
        runtimeVersion,
      });
      expect(
        providerLeaseMocks.runWithProviderRequestLease,
      ).toHaveBeenCalledWith("CPS", expect.any(Function));
      expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledWith(
        course,
        new Date("2026-07-24T00:00:00.000Z"),
        1,
        true,
      );
      expect(
        verificationMocks.completeCourseSupportVerificationRequest,
      ).toHaveBeenCalledWith({
        requestId: "verification-request-1",
        expectedRevision: 7,
        leaseToken: "lease-1",
        runtimeVersion,
        observation: {
          outcome: providerOutcome,
          observedAt: new Date("2026-07-21T12:00:00.000Z"),
          adapterKey: "CPS",
          availabilityCount,
          providerExecution: true,
        },
      });
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
    },
  );

  it("holds the course marker across provider I/O and durable verification evidence", async () => {
    const providerObservedAt = new Date("2026-07-21T12:00:00.123Z");
    allowOwnedExecution();
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValueOnce(
      {
        courseId: "course-1",
        leaseToken: "provider-observation-1",
        observationStartedAt: providerObservedAt,
        leaseExpiresAt: new Date("2026-07-21T12:20:00.123Z"),
        ttlMs: 20 * 60_000,
      },
    );
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      providerObservationMocks.beginCourseProviderObservation.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      providerReadMocks.fetchCourseTeeSheet.mock.invocationCallOrder[0],
    );
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ observedAt: providerObservedAt }),
      }),
    );
    expect(
      verificationMocks.completeCourseSupportVerificationRequest.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      providerObservationMocks.markCourseProviderObservationUnreconciled.mock
        .invocationCallOrder[0],
    );
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ observationStartedAt: providerObservedAt }),
    );
    expect(
      providerObservationMocks.releaseCourseProviderObservation,
    ).not.toHaveBeenCalled();
  });

  it("records no verification evidence after provider observation ownership is lost", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });
    providerObservationMocks.assertOwned.mockImplementationOnce(() => {
      throw new Error("provider observation ownership lost");
    });

    await expect(executeCourseSupportVerificationStep(input)).rejects.toThrow(
      "provider observation ownership lost",
    );

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
    expect(
      providerObservationMocks.markCourseProviderObservationUnreconciled,
    ).toHaveBeenCalledOnce();
    expect(
      providerObservationMocks.releaseCourseProviderObservation,
    ).not.toHaveBeenCalled();
  });

  it("performs no provider I/O while another course observation owns the marker", async () => {
    allowOwnedExecution();
    providerObservationMocks.beginCourseProviderObservation.mockResolvedValueOnce(
      null,
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ providerExecution: false }),
      }),
    );
  });

  it("rechecks the monitoring gate after discovery before provider I/O", async () => {
    allowOwnedExecution();
    prismaMocks.courseFindUnique
      .mockResolvedValueOnce(course)
      .mockResolvedValueOnce({
        ...course,
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        intelligenceVerifiedAt: new Date("2026-07-21T11:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-21T12:00:00.000Z"),
        intelligenceConfidence: 0.98,
      });

    await executeCourseSupportVerificationStep(input);

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 7,
        failureClass: "CHALLENGE",
        observation: expect.objectContaining({ providerExecution: false }),
      }),
    );
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
  });

  it("fails closed on an unsafe provider booking URL without recording success", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [slot({ bookingUrl: "https://booking.example/checkout" })],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "verification-request-1",
        expectedRevision: 7,
        leaseToken: "lease-1",
        runtimeVersion,
        failureClass: "SCHEMA",
        retryAt: undefined,
        observation: expect.objectContaining({
          outcome: "FETCH_FAILED",
          providerExecution: true,
        }),
      }),
    );
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it.each(["lease_lost"] as const)(
    "honors a post-discovery %s rejection before the adapter request",
    async (reason) => {
      verificationMocks.attachCourseSupportVerificationProviderSnapshot
        .mockResolvedValueOnce({
          attached: true,
          revision: 4,
          providerSnapshotFingerprint: "before-discovery",
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
          courseId: "course-1",
          intent,
        })
        .mockResolvedValueOnce({ attached: false, reason });

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "stopped",
        reason,
      });

      expect(
        discoveryMocks.prepareCourseSupportVerificationMonitoring,
      ).toHaveBeenCalledWith(
        "course-1",
        undefined,
        new Date("2026-07-21T12:00:00.000Z"),
        { forceFresh: true },
      );
      expect(prismaMocks.courseFindUnique).toHaveBeenCalledTimes(1);
      expect(
        providerLeaseMocks.runWithProviderRequestLease,
      ).not.toHaveBeenCalled();
      expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
      expect(
        verificationMocks.completeCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
    },
  );

  it("persists a transient adapter retry with truthful provider execution", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
    );
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(capabilityMocks.classifyProviderFailure).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: "ECONNRESET" }),
    });
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith({
      requestId: "verification-request-1",
      expectedRevision: 7,
      leaseToken: "lease-1",
      runtimeVersion,
      failureClass: "NETWORK",
      message: "Public provider availability verification failed.",
      retryAfterSeconds: null,
      retryAt: new Date("2026-07-21T12:15:00.000Z"),
      observation: {
        outcome: "FETCH_FAILED",
        observedAt: new Date("2026-07-21T12:00:00.000Z"),
        httpStatus: null,
        providerExecution: true,
      },
    });
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it("queues an allowlisted local-reader fallback after a server 5xx", async () => {
    allowOwnedExecution();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:crestbrook-park-golf-course",
    );
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CHRONOGOLF",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false,
    });
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider unavailable"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "HTTP_5XX",
      httpStatus: 503,
      retryAfterSeconds: null,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: "2026-07-24",
      players: 1,
      bookingUrl: "https://booking.example/tee-times",
      notBefore: new Date("2026-07-21T12:00:00.000Z"),
    });
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "HTTP_5XX",
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
      }),
    );
  });

  it("uses a fresh signed local-reader result only after the server adapter fails", async () => {
    allowOwnedExecution();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:crestbrook-park-golf-course",
    );
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T12:00:30.000Z"),
      readerVersion: "reader-v1",
      slots: [],
    });
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CHRONOGOLF",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false,
    });
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("public adapter challenge"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "CHALLENGE",
      httpStatus: 403,
      retryAfterSeconds: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: "2026-07-24",
      players: 1,
      bookingUrl: "https://booking.example/tee-times",
      notBefore: discoveryAttemptedAt,
    });
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeVersion,
        observation: expect.objectContaining({
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-21T12:00:30.000Z"),
          adapterKey: "LOCAL_READER:CHRONOGOLF",
          providerExecution: true,
        }),
      }),
    );
  });

  it("records a delayed reader challenge at provider source time instead of receipt time", async () => {
    const readerFailureObservedAt = new Date("2026-07-21T12:00:30.000Z");
    const delayedSuccessObservedAt = new Date("2026-07-21T12:01:00.000Z");
    const receiptAt = new Date("2026-07-21T12:10:00.000Z");
    vi.setSystemTime(receiptAt);
    allowOwnedExecution();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:crestbrook-park-golf-course",
    );
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: readerFailureObservedAt,
      readerVersion: "reader-v1",
      resultStatus: "ACCESS_CHALLENGE",
    });
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CHRONOGOLF",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false,
    });
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("public adapter challenge"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "CHALLENGE",
      httpStatus: 403,
      retryAfterSeconds: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "CHALLENGE",
        message: expect.stringContaining("persistent access control"),
        observation: expect.objectContaining({
          observedAt: readerFailureObservedAt,
          providerExecution: true,
        }),
      }),
    );
    expect(readerFailureObservedAt.getTime()).toBeLessThan(
      delayedSuccessObservedAt.getTime(),
    );
    expect(delayedSuccessObservedAt.getTime()).toBeLessThan(receiptAt.getTime());
  });

  it("keeps an expired reader deadline from fencing a delayed valid provider result", async () => {
    const readerExpiredAt = new Date("2026-07-21T12:00:30.000Z");
    const delayedSuccessObservedAt = new Date("2026-07-21T12:01:00.000Z");
    const receiptAt = new Date("2026-07-21T12:10:00.000Z");
    vi.setSystemTime(receiptAt);
    allowOwnedExecution();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(
      "chronogolf:crestbrook-park-golf-course",
    );
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: readerExpiredAt,
      readerVersion: null,
      resultStatus: "EXPIRED",
    });
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CHRONOGOLF",
      isRunnable: true,
      metadataReady: true,
      evidenceConflict: false,
    });
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("public adapter challenge"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "CHALLENGE",
      httpStatus: 403,
      retryAfterSeconds: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "TIMEOUT",
        observation: expect.objectContaining({
          observedAt: receiptAt,
          providerExecution: false,
        }),
      }),
    );
    expect(readerExpiredAt.getTime()).toBeLessThan(
      delayedSuccessObservedAt.getTime(),
    );
    expect(delayedSuccessObservedAt.getTime()).toBeLessThan(receiptAt.getTime());
  });

  it("bypasses blocked provider and browser paths for local-reader-only verification", async () => {
    allowOwnedExecution();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      providerFamilyKey: "secure.east.prophetservices.com",
      automationEligibility: "BLOCKED",
      automationReason: "CAPTCHA_OR_QUEUE",
      monitoringMode: "LOCAL_READER_ONLY",
    });
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("frear-park");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T12:00:30.000Z"),
      readerVersion: "legacy-prophet-rendered-v1",
      slots: [],
    });
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "secure.east.prophetservices.com",
      isRunnable: false,
      metadataReady: false,
      evidenceConflict: false,
    });
    capabilityMocks.getProviderReadinessFailure.mockReturnValue(
      "UNSUPPORTED_FAMILY",
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledWith({
      courseId: "course-1",
      targetDate: "2026-07-24",
      players: 1,
      bookingUrl: "https://booking.example/tee-times",
      notBefore: discoveryAttemptedAt,
    });
    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          outcome: "NO_MATCH",
          providerExecution: true,
        }),
      }),
    );
  });

  it("never retries before a longer provider Retry-After", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider throttled"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterSeconds: 30 * 60,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "RATE_LIMIT",
        retryAfterSeconds: 30 * 60,
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        observation: expect.objectContaining({
          httpStatus: 429,
          providerExecution: true,
        }),
      }),
    );
  });

  it("does not schedule a request retry beyond the bounded horizon", async () => {
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider unavailable"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "HTTP_5XX",
      httpStatus: 503,
      retryAfterSeconds: 25 * 60 * 60,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "STALE",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "HTTP_5XX",
        retryAfterSeconds: 25 * 60 * 60,
        retryAt: null,
        observation: expect.objectContaining({
          httpStatus: 503,
          providerExecution: true,
        }),
      }),
    );
  });

  it("persists typed-adapter discovery proof before recording ordered success", async () => {
    installPlaybookRuntime();
    allowOwnedDiscovery();
    allowDirectDiscoveryVerification();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).toHaveBeenCalledWith({
      requestId: "verification-request-1",
      expectedRevision: 4,
      leaseToken: "lease-1",
      runtimeVersion,
      now: new Date("2026-07-21T12:00:00.000Z"),
    });
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      providerLeaseMocks.runWithProviderRequestLease.mock
        .invocationCallOrder[0],
    );
    expect(
      providerReadMocks.fetchCourseTeeSheet.mock.invocationCallOrder[0],
    ).toBeLessThan(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified.mock
        .invocationCallOrder[0],
    );
    const typedSuccessCall =
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.findIndex(
        ([, transition]) =>
          transition.stage === "TYPED_ADAPTER" &&
          transition.transition === "SUCCEEDED",
      );
    expect(typedSuccessCall).toBeGreaterThanOrEqual(0);
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      playbookMocks.recordRuntimePlaybookTransition.mock.invocationCallOrder[
        typedSuccessCall
      ],
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.invocationCallOrder[
        typedSuccessCall
      ],
    ).toBeLessThan(
      verificationMocks.completeCourseSupportVerificationRequest.mock
        .invocationCallOrder[0],
    );
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
  });

  it("preserves the assigned adapter stage when provider execution cannot begin", async () => {
    const runtime = installPlaybookRuntime();
    allowOwnedDiscovery();
    providerLeaseMocks.runWithProviderRequestLease
      .mockResolvedValueOnce({ acquired: false })
      .mockResolvedValueOnce({ acquired: false });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "RATE_LIMIT",
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
        observation: expect.objectContaining({
          providerExecution: false,
        }),
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
        ([, transition]) => transition.stage === "TYPED_ADAPTER",
      ),
    ).toBe(false);
    expect(runtime.assessment).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "TYPED_ADAPTER",
      stages: expect.arrayContaining([
        expect.objectContaining({
          stage: "TYPED_ADAPTER",
          attemptCount: 0,
        }),
      ]),
    });

    vi.setSystemTime(new Date("2026-07-21T12:02:00.000Z"));
    allowOwnedDiscovery();
    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(runtime.assessment).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "TYPED_ADAPTER",
      stages: expect.arrayContaining([
        expect.objectContaining({
          stage: "TYPED_ADAPTER",
          attemptCount: 0,
        }),
      ]),
    });

    vi.setSystemTime(new Date("2026-07-21T12:04:00.000Z"));
    allowOwnedDiscovery();
    allowDirectDiscoveryVerification();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });
    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(runtime.assessment.conclusion).toBe("MONITORING_RESTORED");
  });

  it("retries a provider-lease exception without recording an adapter-stage failure", async () => {
    const runtime = installPlaybookRuntime();
    allowOwnedDiscovery();
    providerLeaseMocks.runWithProviderRequestLease.mockRejectedValueOnce(
      new Error("provider lease store unavailable"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValueOnce({
      failureClass: "UNKNOWN",
      httpStatus: null,
      retryAfterSeconds: null,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValueOnce(
      {
        failed: true,
        status: "RETRYABLE_FAILED",
      },
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "UNKNOWN",
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
        observation: expect.objectContaining({ providerExecution: false }),
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
        ([, transition]) => transition.stage === "TYPED_ADAPTER",
      ),
    ).toBe(false);
    expect(runtime.assessment).toMatchObject({
      conclusion: "INCOMPLETE",
      nextStage: "TYPED_ADAPTER",
    });
  });

  it("performs no provider I/O when the typed-adapter attempt fence rejects ownership", async () => {
    installPlaybookRuntime();
    allowOwnedDiscovery();
    verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mockResolvedValueOnce(
      { marked: false, reason: "provider_snapshot_changed" },
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "stopped",
      reason: "provider_snapshot_changed",
    });

    expect(
      providerLeaseMocks.runWithProviderRequestLease,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
        ([, transition]) =>
          transition.stage === "TYPED_ADAPTER" &&
          transition.transition === "SUCCEEDED",
      ),
    ).toBe(false);
  });

  it("records no typed success when ownership is lost after a safe provider response", async () => {
    installPlaybookRuntime();
    allowOwnedDiscovery();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });
    verificationMocks.markCourseSupportVerificationDiscoveryVerified.mockResolvedValueOnce(
      { marked: false, reason: "provider_snapshot_changed" },
    );

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "stopped",
      reason: "provider_snapshot_changed",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
        ([, transition]) =>
          transition.stage === "TYPED_ADAPTER" &&
          transition.transition === "SUCCEEDED",
      ),
    ).toBe(false);
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it("recovers a concluded typed-adapter ledger with fresh request proof and no duplicate transition", async () => {
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughTypedAdapter(),
    );
    allowOwnedDiscovery();
    allowDirectDiscoveryVerification();
    providerReadMocks.fetchCourseTeeSheet.mockResolvedValue({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
    });

    expect(runtime.assessment.conclusion).toBe("MONITORING_RESTORED");
    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).toHaveBeenCalledOnce();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).toHaveBeenCalledOnce();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
  });

  it("allows only one bounded transient retry while recovering a concluded adapter", async () => {
    installPlaybookRuntime(completedPlaybookSeedThroughTypedAdapter());
    allowOwnedDiscovery();
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider throttled"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterSeconds: 30 * 60,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 5,
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        retryAfterSeconds: 30 * 60,
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
  });

  it("fails concluded-adapter recovery closed after its persisted retry fence", async () => {
    installPlaybookRuntime(completedPlaybookSeedThroughTypedAdapter());
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
      {
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "current-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
        courseId: "course-1",
        intent,
      },
    );
    providerReadMocks.fetchCourseTeeSheet.mockRejectedValue(
      new Error("provider throttled again"),
    );
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "RATE_LIMIT",
      httpStatus: 429,
      retryAfterSeconds: 30 * 60,
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "STALE",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledOnce();
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        retryAt: null,
        retryAfterSeconds: undefined,
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
  });

  it("runs the typed adapter before HTTP discovery and retries it after learned metadata", async () => {
    installPlaybookRuntime();
    allowOwnedExecution();
    providerReadMocks.fetchCourseTeeSheet
      .mockRejectedValueOnce(new Error("public adapter challenge"))
      .mockResolvedValueOnce({
        slots: [],
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null,
      });
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "CHALLENGE",
      httpStatus: 403,
      retryAfterSeconds: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(providerReadMocks.fetchCourseTeeSheet).toHaveBeenCalledTimes(2);
    expect(
      providerReadMocks.fetchCourseTeeSheet.mock.invocationCallOrder[0],
    ).toBeLessThan(
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mock
        .invocationCallOrder[0],
    );
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      providerReadMocks.fetchCourseTeeSheet.mock.invocationCallOrder[1],
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mock
        .invocationCallOrder[0],
    );
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      verificationMocks.attachCourseSupportVerificationProviderSnapshot.mock
        .invocationCallOrder[1],
    );
    expect(
      verificationMocks.attachCourseSupportVerificationProviderSnapshot.mock
        .invocationCallOrder[1],
    ).toBeLessThan(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified.mock
        .invocationCallOrder[0],
    );
    expect(
      verificationMocks.attachCourseSupportVerificationProviderSnapshot,
    ).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 5,
        purpose: "POST_DISCOVERY",
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.map(
        ([, transition]) => [transition.stage, transition.transition],
      ),
    ).toEqual([
      ["OFFICIAL_IDENTITY", "COMPLETED"],
      ["TYPED_ADAPTER", "FAILED_TERMINAL"],
      ["OFFICIAL_HTTP_DISCOVERY", "COMPLETED"],
      ["HTTP_ADAPTER_RETRY", "SUCCEEDED"],
    ]);
  });

  it("does not treat BROWSER_ONLY as permission to skip typed and HTTP stages", async () => {
    installPlaybookRuntime();
    allowOwnedExecution();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      monitoringMode: "BROWSER_ONLY",
    });
    providerReadMocks.fetchCourseTeeSheet
      .mockRejectedValueOnce(new Error("public adapter challenge"))
      .mockResolvedValueOnce({
        slots: [],
        targetDateStatus: "OPEN",
        bookingWindowEvidence: null,
      });
    capabilityMocks.classifyProviderFailure.mockReturnValue({
      failureClass: "CHALLENGE",
      httpStatus: 403,
      retryAfterSeconds: null,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.map(
        ([, transition]) => transition.stage,
      ),
    ).toEqual([
      "OFFICIAL_IDENTITY",
      "TYPED_ADAPTER",
      "OFFICIAL_HTTP_DISCOVERY",
      "HTTP_ADAPTER_RETRY",
    ]);
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
  });

  it("establishes owned proof for ordered local-reader-only success", async () => {
    installPlaybookRuntime();
    allowOwnedDiscovery();
    allowDirectDiscoveryVerification();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      monitoringMode: "LOCAL_READER_ONLY",
    });
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T12:00:30.000Z"),
      readerVersion: "reader-v1",
      slots: [],
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      localReaderMocks.getLocalReaderCourseVerification.mock
        .invocationCallOrder[0],
    );
    expect(
      localReaderMocks.getLocalReaderCourseVerification.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified.mock
        .invocationCallOrder[0],
    );
    const localSuccessCall =
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.findIndex(
        ([, transition]) =>
          transition.stage === "LOCAL_READER" &&
          transition.transition === "SUCCEEDED",
      );
    expect(localSuccessCall).toBeGreaterThanOrEqual(0);
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified.mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      playbookMocks.recordRuntimePlaybookTransition.mock.invocationCallOrder[
        localSuccessCall
      ],
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.invocationCallOrder[
        localSuccessCall
      ],
    ).toBeLessThan(
      verificationMocks.completeCourseSupportVerificationRequest.mock
        .invocationCallOrder[0],
    );
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ notBefore: discoveryAttemptedAt }),
    );
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
  });

  it("rejects a signed reader result that predates the owned attempt boundary", async () => {
    installPlaybookRuntime();
    allowOwnedDiscovery();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      monitoringMode: "LOCAL_READER_ONLY",
    });
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T11:59:59.000Z"),
      readerVersion: "reader-v1",
      slots: [],
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ notBefore: discoveryAttemptedAt }),
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it("recovers a concluded local-reader ledger only from a fresh signed result", async () => {
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughLocalReader(),
    );
    allowOwnedDiscovery();
    allowDirectDiscoveryVerification();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T12:00:30.000Z"),
      readerVersion: "reader-v2",
      slots: [],
    });

    expect(runtime.assessment.conclusion).toBe("MONITORING_RESTORED");
    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ notBefore: discoveryAttemptedAt }),
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).toHaveBeenCalledOnce();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 6 }));
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
  });

  it("records an unsafe concluded reader result at its provider source time", async () => {
    const readerObservedAt = new Date("2026-07-21T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-07-21T12:10:00.000Z"));
    installPlaybookRuntime(completedPlaybookSeedThroughLocalReader());
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: readerObservedAt,
      readerVersion: "reader-v2",
      slots: [slot({ bookingUrl: "https://booking.example/checkout" })],
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "SCHEMA",
        observation: expect.objectContaining({
          observedAt: readerObservedAt,
          providerExecution: true,
        }),
      }),
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
  });

  it("records a terminal concluded reader result at its provider source time", async () => {
    const readerObservedAt = new Date("2026-07-21T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-07-21T12:10:00.000Z"));
    installPlaybookRuntime(completedPlaybookSeedThroughLocalReader());
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: readerObservedAt,
      readerVersion: "reader-v2",
      resultStatus: "ACCESS_CHALLENGE",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "CHALLENGE",
        retryAt: null,
        observation: expect.objectContaining({
          observedAt: readerObservedAt,
          providerExecution: true,
        }),
      }),
    );
  });

  it("keeps a concluded reader expiry from fencing a delayed valid provider result", async () => {
    const readerExpiredAt = new Date("2026-07-21T12:00:30.000Z");
    const delayedSuccessObservedAt = new Date("2026-07-21T12:01:00.000Z");
    const receiptAt = new Date("2026-07-21T12:10:00.000Z");
    vi.setSystemTime(receiptAt);
    installPlaybookRuntime(completedPlaybookSeedThroughLocalReader());
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: readerExpiredAt,
      readerVersion: null,
      resultStatus: "EXPIRED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "TIMEOUT",
        retryAt: null,
        observation: expect.objectContaining({
          observedAt: receiptAt,
          providerExecution: false,
        }),
      }),
    );
    expect(readerExpiredAt.getTime()).toBeLessThan(
      delayedSuccessObservedAt.getTime(),
    );
    expect(delayedSuccessObservedAt.getTime()).toBeLessThan(receiptAt.getTime());
  });

  it("queues one fresh signed read for a concluded local-reader recovery", async () => {
    installPlaybookRuntime(completedPlaybookSeedThroughLocalReader());
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue(null);
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ notBefore: discoveryAttemptedAt }),
    );
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 5,
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
      }),
    );
    expect(
      playbookMocks.recordRuntimePlaybookTransition,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it("fails concluded local-reader recovery closed after its one queued retry", async () => {
    installPlaybookRuntime(completedPlaybookSeedThroughLocalReader());
    verificationMocks.attachCourseSupportVerificationProviderSnapshot.mockResolvedValueOnce(
      {
        attached: true,
        revision: 4,
        providerSnapshotFingerprint: "current-provider",
        discoveryAttemptedAt,
        discoveryVerifiedAt: null,
        courseId: "course-1",
        intent,
      },
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "PENDING",
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "STALE",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryAttempted,
    ).not.toHaveBeenCalled();
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4, retryAt: null }),
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
  });

  it("waits for ordinary browser discovery before any local-reader fallback", async () => {
    installPlaybookRuntime(
      completedPlaybookSeedThroughBrowserAdapter().slice(0, 4),
    );
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
  });

  it.each(["MANUAL_DIRECT", "IDENTITY_FINAL"] as const)(
    "completes an active-batch independent %s conclusion without recording a fetch failure",
    async (disposition) => {
      installPlaybookRuntime(
        completedPlaybookSeedThroughIndependentFactualFinal(disposition),
      );
      allowOwnedDiscovery();

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "completed",
        providerOutcome: disposition,
      });

      expect(
        verificationMocks.completeCourseSupportVerificationFactualFinal,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "verification-request-1",
          expectedRevision: 4,
          leaseToken: "lease-1",
          runtimeVersion,
          disposition,
        }),
      );
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).not.toHaveBeenCalled();
      expect(
        supportIncidentMocks.resolveCourseSupportIncident,
      ).not.toHaveBeenCalled();
    },
  );

  it("records current factual identity proof without racing a newer search success", async () => {
    let newerSearchHealthyCommitted = false;
    installPlaybookRuntime([], () => {
      newerSearchHealthyCommitted = true;
    });
    allowOwnedDiscovery();
    prismaMocks.courseFindUnique.mockResolvedValue({
      ...course,
      isPublic: false,
      intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
      intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
      intelligenceConfidence: 0.95,
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "IDENTITY_FINAL",
    });

    expect(playbookMocks.recordRuntimePlaybookTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "OFFICIAL_IDENTITY",
        transition: "FACTUAL_FINAL",
        factualDisposition: "IDENTITY_FINAL",
      }),
    );
    expect(newerSearchHealthyCommitted).toBe(true);
    expect(
      courseMonitoringMocks.recordCourseMonitoringFinalClassification,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.completeCourseSupportVerificationFactualFinal,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        disposition: "IDENTITY_FINAL",
        expectedRevision: 4,
      }),
    );
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).not.toHaveBeenCalled();
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      discoveryMocks.prepareCourseSupportVerificationMonitoring,
    ).not.toHaveBeenCalled();
  });

  it("leaves independent confirmation pending when no safe reader capability exists", async () => {
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughBrowserAdapter(),
    );
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(null);
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.map(
        ([, transition]) => [transition.stage, transition.transition],
      ),
    ).toEqual([["LOCAL_READER", "NOT_APPLICABLE"]]);
    expect(runtime.assessment.conclusion).toBe("INCOMPLETE");
    expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "MISSING_SOURCE",
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
      }),
    );
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      supportIncidentMocks.resolveCourseSupportIncident,
    ).not.toHaveBeenCalled();
  });

  it("advances an assigned non-runnable browser adapter retry in the exact runtime", async () => {
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughRenderedBrowser(),
    );
    allowOwnedDiscovery();
    capabilityMocks.resolveProviderCapability.mockReturnValue({
      providerFamilyKey: "CUSTOM",
      isRunnable: false,
      metadataReady: false,
      evidenceConflict: false,
    });
    capabilityMocks.getProviderReadinessFailure.mockReturnValue(
      "MISSING_METADATA",
    );
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue(null);
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.map(
        ([, transition]) => ({
          stage: transition.stage,
          transition: transition.transition,
          skipReason: transition.skipReason,
          runtimeVersion: transition.runtimeVersion,
        }),
      ),
    ).toEqual([
      {
        stage: "BROWSER_ADAPTER_RETRY",
        transition: "NOT_APPLICABLE",
        skipReason: "NO_RUNNABLE_ADAPTER",
        runtimeVersion,
      },
      {
        stage: "LOCAL_READER",
        transition: "NOT_APPLICABLE",
        skipReason: "NO_LOCAL_READER_CAPABILITY",
        runtimeVersion,
      },
    ]);
    expect(runtime.assessment.conclusion).toBe("INCOMPLETE");
    expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
    expect(providerReadMocks.fetchCourseTeeSheet).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "MISSING_SOURCE",
        retryAt: new Date("2026-07-21T12:02:00.000Z"),
      }),
    );
  });

  it.each([
    { resultStatus: "PAGE_MISMATCH" as const, failureClass: "SCHEMA" },
    { resultStatus: "READER_ERROR" as const, failureClass: "UNKNOWN" },
  ])(
    "leaves independent confirmation pending after terminal reader result $resultStatus",
    async ({ resultStatus, failureClass }) => {
      const runtime = installPlaybookRuntime(
        completedPlaybookSeedThroughBrowserAdapter(),
      );
      allowOwnedDiscovery();
      localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
      localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
        status: "TERMINAL",
        observedAt: new Date("2026-07-21T12:00:30.000Z"),
        readerVersion: "reader-v1",
        resultStatus,
      });
      verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
        failed: true,
        status: "RETRYABLE_FAILED",
      });

      await expect(
        executeCourseSupportVerificationStep(input),
      ).resolves.toEqual({
        outcome: "failed",
        retryable: true,
      });

      expect(
        playbookMocks.recordRuntimePlaybookTransition,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          stage: "LOCAL_READER",
          transition: "FAILED_TERMINAL",
          failureClass,
          runtimeVersion: "reader-v1",
        }),
      );
      expect(
        playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
          ([, transition]) => transition.stage === "INDEPENDENT_CONFIRMATION",
        ),
      ).toBe(false);
      expect(runtime.assessment.conclusion).toBe("INCOMPLETE");
      expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
      expect(
        verificationMocks.failCourseSupportVerificationRequest,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          failureClass: "MISSING_SOURCE",
          retryAt: new Date("2026-07-21T12:02:00.000Z"),
        }),
      );
    },
  );

  it("records an expired five-minute reader window once and advances to independent confirmation", async () => {
    vi.setSystemTime(new Date("2026-07-21T12:05:00.000Z"));
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughBrowserAdapter(),
    );
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: new Date("2026-07-21T12:05:00.000Z"),
      readerVersion: null,
      resultStatus: "EXPIRED",
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(playbookMocks.recordRuntimePlaybookTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "LOCAL_READER",
        transition: "FAILED_TERMINAL",
        evidenceKind: "TOOLING",
        failureClass: "TIMEOUT",
        runtimeVersion,
        now: new Date("2026-07-21T12:05:00.000Z"),
      }),
    );
    expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-07-21T12:07:00.000Z"));
    allowOwnedDiscovery();
    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledOnce();
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.filter(
        ([, transition]) => transition.stage === "LOCAL_READER",
      ),
    ).toHaveLength(1);
    expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
  });

  it("treats a fresh signed reader availability result as direct monitoring proof", async () => {
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughBrowserAdapter(),
    );
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: new Date("2026-07-21T12:00:30.000Z"),
      readerVersion: "reader-v1",
      slots: [],
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "completed",
      providerOutcome: "NO_MATCH",
    });

    expect(playbookMocks.recordRuntimePlaybookTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "LOCAL_READER",
        transition: "SUCCEEDED",
        runtimeVersion: "reader-v1",
      }),
    );
    expect(runtime.assessment.conclusion).toBe("MONITORING_RESTORED");
    expect(runtime.assessment.nextStage).toBeNull();
    expect(
      playbookMocks.recordRuntimePlaybookTransition.mock.calls.some(
        ([, transition]) => transition.stage === "INDEPENDENT_CONFIRMATION",
      ),
    ).toBe(false);
    expect(
      verificationMocks.completeCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          outcome: "NO_MATCH",
          adapterKey: "LOCAL_READER:CPS",
          providerExecution: true,
        }),
      }),
    );
  });

  it("records an unsafe ordered reader result at its provider source time", async () => {
    const readerObservedAt = new Date("2026-07-21T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-07-21T12:10:00.000Z"));
    installPlaybookRuntime(completedPlaybookSeedThroughBrowserAdapter());
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "COMPLETED",
      observedAt: readerObservedAt,
      readerVersion: "reader-v1",
      slots: [slot({ bookingUrl: "https://booking.example/checkout" })],
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: false,
    });

    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "SCHEMA",
        observation: expect.objectContaining({
          observedAt: readerObservedAt,
          providerExecution: true,
        }),
      }),
    );
    expect(
      verificationMocks.markCourseSupportVerificationDiscoveryVerified,
    ).not.toHaveBeenCalled();
  });

  it("keeps a terminal reader challenge unresolved until an independent current observation", async () => {
    const readerObservedAt = new Date("2026-07-21T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-07-21T12:10:00.000Z"));
    const runtime = installPlaybookRuntime(
      completedPlaybookSeedThroughBrowserAdapter(),
    );
    allowOwnedDiscovery();
    localReaderMocks.getLocalReaderCourseKey.mockReturnValue("cps:course-1");
    localReaderMocks.getLocalReaderCourseVerification.mockResolvedValue({
      status: "TERMINAL",
      observedAt: readerObservedAt,
      readerVersion: "reader-v1",
      resultStatus: "ACCESS_CHALLENGE",
    });
    verificationMocks.failCourseSupportVerificationRequest.mockResolvedValue({
      failed: true,
      status: "RETRYABLE_FAILED",
    });

    await expect(executeCourseSupportVerificationStep(input)).resolves.toEqual({
      outcome: "failed",
      retryable: true,
    });

    expect(playbookMocks.recordRuntimePlaybookTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        stage: "LOCAL_READER",
        transition: "TECHNICAL_LIMITATION",
        technicalReason: "CAPTCHA_OR_QUEUE",
        runtimeVersion: "reader-v1",
      }),
    );
    expect(runtime.assessment.nextStage).toBe("INDEPENDENT_CONFIRMATION");
    expect(
      localReaderMocks.getLocalReaderCourseVerification,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        notBefore: discoveryAttemptedAt,
      }),
    );
    expect(
      localReaderMocks.queueLocalReaderCourseVerification,
    ).not.toHaveBeenCalled();
    expect(
      verificationMocks.failCourseSupportVerificationRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        failureClass: "CHALLENGE",
        observation: expect.objectContaining({
          observedAt: readerObservedAt,
          providerExecution: true,
        }),
      }),
    );
    expect(
      supportIncidentMocks.resolveCourseSupportIncident,
    ).not.toHaveBeenCalled();
  });
});
