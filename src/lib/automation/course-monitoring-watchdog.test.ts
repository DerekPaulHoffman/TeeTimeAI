import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
  course: {
    findUnique: vi.fn(),
  },
  courseMonitoringStatus: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  courseMonitoringEvent: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
  },
  courseProbe: {
    findFirst: vi.fn(),
  },
  courseSupportBatch: {
    updateMany: vi.fn(),
  },
  courseSupportBatchSearch: {
    findMany: vi.fn(),
  },
  courseSupportBatchIncident: {
    updateMany: vi.fn(),
  },
  courseSupportIncident: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  courseSupportVerificationRequest: {
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  automationRun: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  teeSearch: {
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  FAILURE_CONFIRMATION_WINDOW_MS,
  getDeferredFailureHandoffEscalationDeadline,
  recordCourseMonitoringFailure,
  recordCourseMonitoringSuccess,
  runCourseMonitoringWatchdog,
} from "./course-monitoring";
import {
  appendAutomationPlaybookEvent,
  type AutomationPlaybookLedger,
  type AutomationPlaybookReadPath,
  type AutomationPlaybookStage,
} from "./course-monitoring-playbook";
import { createParkedCourseCampaignAudit } from "./course-support-campaign";
import {
  buildCourseSupportSearchExecutionFenceSnapshot,
  persistCourseSupportSearchExecutionFence,
} from "./course-support-search-execution-fence";
import {
  createDeferredFailureHandoffAdmission,
  createDeferredFailureHandoffBatchIncidentDigest,
  createDeferredFailureHandoffSignal,
  parseDeferredFailureHandoffAdmission,
  parseDeferredFailureHandoffSignal,
} from "./course-support-deferred-failure-handoff";
import { buildProviderFailureFingerprint } from "./provider-capabilities";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

const now = new Date("2026-07-27T16:00:00.000Z");

function course(incident: Record<string, unknown> | null) {
  return {
    id: "course-1",
    name: "Example Public Golf Course",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    detectedBookingUrl: "https://course.example/book",
    website: "https://course.example",
    bookingAccessMode: "UNKNOWN",
    automationReason: "OTHER",
    timeZone: "America/New_York",
    supportIncident: incident,
    preferences: [],
  };
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    reference: "csi_123456789012345678901234",
    courseId: "course-1",
    cycle: 1,
    revision: 0,
    status: "AUTO_INVESTIGATING",
    kind: "FETCH_FAILED",
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "UNKNOWN",
    failureFingerprint: "SOURCE_MISSING:UNKNOWN",
    courseNameSnapshot: "Example Public Golf Course",
    platformSnapshot: "UNKNOWN",
    bookingUrlSnapshot: "https://course.example/book",
    initialMessage: "Public check failed.",
    latestMessage: "Public check failed.",
    nextAction: "Retry safely.",
    affectedSearchCount: 1,
    occurrenceCount: 1,
    engineeringOnly: true,
    attemptLedger: null,
    nextAttemptAt: now,
    confirmedAt: null,
    escalationDeadlineAt: null,
    humanReviewReason: null,
    nextReminderAt: null,
    decisionActorId: null,
    decisionAt: null,
    decisionNote: null,
    decisionEvidenceUrl: null,
    decisionIdempotencyKey: null,
    lastAttemptAt: null,
    attemptCount: 0,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    activeBatchId: null,
    firstSeenAt: new Date(now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS),
    lastSeenAt: now,
    ownerNotifiedAt: null,
    escalatedAt: null,
    escalationNotifiedAt: null,
    resolvedAt: null,
    resolution: null,
    resolutionMessage: null,
    resolutionNotifiedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function exhaustedLedger(cycle = 1) {
  const stages: Array<[AutomationPlaybookStage, AutomationPlaybookReadPath]> = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["LOCAL_READER", "LOCAL_READER"],
    ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION"],
  ];
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      skipReason: "MONITORING_MODE_EXCLUDED",
      failureFingerprint: "PLAYBOOK:NOT_APPLICABLE",
      runtimeVersion: "watchdog-test",
      observedAt: new Date("2026-07-27T15:20:00.000Z"),
    });
  }
  return ledger;
}

function renderedBrowserPendingLedger(cycle = 1) {
  const stages: Array<[AutomationPlaybookStage, AutomationPlaybookReadPath]> = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ];
  let ledger: AutomationPlaybookLedger | null = null;
  for (const [stage, readPath] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle,
      stage,
      transition:
        stage === "OFFICIAL_IDENTITY" || stage === "OFFICIAL_HTTP_DISCOVERY"
          ? "COMPLETED"
          : "FAILED_TERMINAL",
      readPath,
      evidenceKind:
        stage === "OFFICIAL_IDENTITY" || stage === "OFFICIAL_HTTP_DISCOVERY"
          ? "OFFICIAL_SOURCE"
          : "PROVIDER_RESPONSE",
      failureFingerprint: `PLAYBOOK:${stage}`,
      failureClass:
        stage === "TYPED_ADAPTER" || stage === "HTTP_ADAPTER_RETRY"
          ? "UNKNOWN"
          : undefined,
      runtimeVersion: "watchdog-test",
      observedAt: new Date("2026-07-27T15:20:00.000Z"),
    });
  }
  return ledger;
}

function priorCycleExhaustedCurrentCyclePendingLedger() {
  return appendAutomationPlaybookEvent(exhaustedLedger(), {
    cycle: 2,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "PLAYBOOK:OFFICIAL_IDENTITY",
    runtimeVersion: "watchdog-test",
    observedAt: new Date("2026-07-27T15:50:00.000Z"),
  });
}

function monitoringSnapshot(
  state = "AUTO_INVESTIGATING",
  overrides: Record<string, unknown> = {},
) {
  return {
    state,
    stateChangedAt: new Date("2026-07-27T15:20:00.000Z"),
    nextAutomaticAttemptAt: now,
    revalidationRequestedAt: null,
    revision: 7,
    ...overrides,
  };
}

function responderBatch(
  entries: Array<{
    incident: Record<string, unknown>;
    monitoringStatus: Record<string, unknown> | null;
    result?: string;
    course?: Record<string, unknown>;
    verificationRequests?: Array<{
      id?: string;
      batchIncidentId?: string;
      releaseSha?: string;
      runtimeVersion?: string | null;
      status?: string;
      revision?: number;
      attemptCount?: number;
      startedAt: Date | null;
      providerSnapshotAt?: Date;
      discoveryAttemptedAt?: Date | null;
      discoveryVerifiedAt?: Date | null;
      outcome?: string | null;
      failureClass?: string | null;
      evidence?: unknown;
      lastError?: string | null;
      providerSnapshotFingerprint?: string | null;
      nextAttemptAt?: Date | null;
      completedAt?: Date | null;
      createdAt?: Date;
      updatedAt?: Date;
    }>;
  }>,
  overrides: Record<string, unknown> = {},
) {
  const courseIds = entries.map((entry) => String(entry.incident.courseId));
  const overrideSummary =
    overrides.summary &&
    typeof overrides.summary === "object" &&
    !Array.isArray(overrides.summary)
      ? (overrides.summary as Record<string, unknown>)
      : {};
  const searchExecutionFence = persistCourseSupportSearchExecutionFence(
    buildCourseSupportSearchExecutionFenceSnapshot({
      courseIds,
      expectedSearches: [],
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      now,
      dispatches: [],
    }),
    now,
  );
  return {
    id: "batch-1",
    status: "VERIFYING",
    leaseExpiresAt: new Date("2026-07-27T15:59:00.000Z"),
    heartbeatAt: new Date("2026-07-27T15:50:00.000Z"),
    completedAt: null,
    baseSha: "a".repeat(40),
    releaseSha: "a".repeat(40),
    deployedAt: new Date("2026-07-27T15:45:00.000Z"),
    recheckDispatchKey: null,
    recheckDispatchStartedAt: null,
    recheckDispatchedAt: null,
    revision: 4,
    ownerAutomationRunId: "run-1",
    ownerAutomationRun: null,
    activeIncidents: entries.map((entry) => ({
      id: String(entry.incident.id),
    })),
    incidents: entries.map((entry, index) => ({
      id: `batch-entry-${index + 1}`,
      incidentId: String(entry.incident.id),
      courseId: String(entry.incident.courseId),
      cycle: Number(entry.incident.cycle),
      result: entry.result ?? "PENDING",
      proofSnapshot: null,
      updatedAt: new Date(`2026-07-27T15:5${index}:00.000Z`),
      verificationRequests: (
        entry.verificationRequests ?? [
          { startedAt: new Date("2026-07-27T15:46:00.000Z") },
        ]
      ).map((request, requestIndex) => ({
        id: `verification-${index + 1}-${requestIndex + 1}`,
        batchIncidentId: `batch-entry-${index + 1}`,
        releaseSha: "a".repeat(40),
        status: "RETRYABLE_FAILED",
        revision: 2,
        attemptCount: 1,
        outcome: null,
        failureClass: null,
        evidence: null,
        lastError: null,
        ...request,
      })),
      incident: entry.incident,
      course: {
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
        probes: [],
        monitoringStatus: entry.monitoringStatus,
        ...entry.course,
      },
    })),
    ...overrides,
    summary: {
      ...overrideSummary,
      searchExecutionFence:
        overrideSummary.searchExecutionFence ?? searchExecutionFence,
    },
  };
}

function deferredFailureCarrierScenario(startedAt: Date | null) {
  const canonicalFailureFingerprint = buildProviderFailureFingerprint({
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "HTTP_5XX",
    operation: "AVAILABILITY",
    httpStatus: null,
  });
  const observedFailureFingerprint = buildProviderFailureFingerprint({
    providerFamilyKey: "SOURCE_MISSING",
    failureClass: "MISSING_SOURCE",
    operation: "AVAILABILITY",
    httpStatus: null,
  });
  const runtimeVersion = "a".repeat(40);
  const providerCourse = {
    timeZone: "America/New_York",
    website: "https://course.example",
    detectedBookingUrl: "https://course.example/book",
    detectedPlatform: "UNKNOWN" as const,
    providerFamilyKey: "SOURCE_MISSING",
    bookingMethod: "UNKNOWN" as const,
    bookingWindowDaysAhead: null,
    bookingWindowEvidenceUrl: null,
    bookingReleaseTimeLocal: null,
    bookingWindowSource: null,
    bookingWindowConfidence: null,
    automationEligibility: "NEEDS_REVIEW" as const,
    automationReason: "OTHER" as const,
    monitoringMode: "AUTOMATIC" as const,
    bookingAccessMode: "UNKNOWN",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: null,
    layoutHoleCounts: [] as number[],
    layoutHolesVerifiedAt: null,
  };
  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(providerCourse);
  const source = createDeferredFailureHandoffSignal({
    state: "AVAILABLE",
    sourceBatchIncidentDigest:
      createDeferredFailureHandoffBatchIncidentDigest("source-entry"),
    sourceProofDigest: "3".repeat(64),
    providerFamilyKey: "SOURCE_MISSING",
    canonicalFailureFingerprint,
    observedFailureFingerprint,
    claimedProviderSnapshotFingerprint: providerSnapshotFingerprint,
    observedProviderSnapshotFingerprint: providerSnapshotFingerprint,
    runtimeVersion,
    cooldownExpiresAt: new Date(now.getTime() - 5 * 60 * 1000).toISOString(),
    providerNotBeforeAt: null,
    eligibleAt: new Date(now.getTime() - 60 * 1000).toISOString(),
    sourceVerificationWatchMode: "WATCH_SETTLED",
    sourceResult: "RETRY_SCHEDULED",
    sourceAttemptConsumed: true,
    confirmationStarted: false,
  });
  const admission = createDeferredFailureHandoffAdmission({
    signal: source,
    admittedAt: new Date(now.getTime() - 60 * 1000),
  });
  const currentIncident = incident({
    activeBatchId: "batch-1",
    providerFamilyKey: "SOURCE_MISSING",
    failureFingerprint: canonicalFailureFingerprint,
    attemptLedger: exhaustedLedger(),
    escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    activeRealSearchCount: 0,
    engineeringOnly: true,
    batchIncidents: [],
  });
  const currentMonitoring = monitoringSnapshot("AUTO_INVESTIGATING", {
    failureFingerprint: canonicalFailureFingerprint,
  });
  const courseRef = createHash("sha256")
    .update("course-1")
    .digest("hex")
    .slice(0, 24);
  const batch = responderBatch(
    [
      {
        incident: currentIncident,
        monitoringStatus: currentMonitoring,
        course: providerCourse,
        verificationRequests: [
          {
            startedAt,
            runtimeVersion: startedAt ? runtimeVersion : null,
            providerSnapshotAt: new Date("2026-07-27T15:49:00.000Z"),
            discoveryAttemptedAt: null,
            discoveryVerifiedAt: null,
            status: startedAt ? "CHECKING" : "QUEUED",
            attemptCount: startedAt ? 1 : 0,
            outcome: null,
            failureClass: null,
            evidence: null,
            lastError: null,
            providerSnapshotFingerprint,
            nextAttemptAt: null,
            completedAt: null,
            createdAt: new Date("2026-07-27T15:49:00.000Z"),
            updatedAt: startedAt ?? new Date("2026-07-27T15:49:00.000Z"),
          },
        ],
      },
    ],
    {
      providerFamilyKey: "SOURCE_MISSING",
      failureFingerprint: canonicalFailureFingerprint,
      baseSha: runtimeVersion,
      releaseSha: runtimeVersion,
      deployedAt: null,
      summary: {
        plannedPaths: [],
        remediation: {
          attempts: [
            {
              courseRef,
              providerSnapshotFingerprint,
              failureFingerprint: canonicalFailureFingerprint,
              runtimeVersion,
              activeRealSearchCount: 0,
              approach: null,
              deferredFailureHandoffSource: source,
              deferredFailureHandoffAdmission: admission,
            },
          ],
        },
      },
    },
  );
  return {
    admission,
    batch,
    canonicalFailureFingerprint,
    courseRef,
    currentIncident,
    currentMonitoring,
    observedFailureFingerprint,
    providerSnapshotFingerprint,
    runtimeVersion,
    source,
  };
}

function legacyDeferredFailureHandoffScenario(
  overrides: {
    monitoringEvents?: Array<Record<string, unknown>>;
    sourceActiveRealSearchCount?: number;
    currentActiveRealSearchCount?: number;
    currentEngineeringOnly?: boolean;
  } = {},
) {
  const cycle = 2;
  const canonicalFailureFingerprint = "ab".repeat(32);
  const priorFailureFingerprint = "cd".repeat(32);
  const runtimeVersion = "a".repeat(40);
  const lineageAt = new Date("2026-07-27T15:00:00.000Z");
  const sourceBatchCreatedAt = new Date("2026-07-27T15:10:00.000Z");
  const sourceObservedAt = new Date("2026-07-27T15:19:00.000Z");
  const sourceCompletedAt = new Date("2026-07-27T15:20:00.000Z");
  const endpointAt = sourceCompletedAt;
  const escalationDeadlineAt = new Date("2026-07-27T15:25:00.000Z");
  const cooldownExpiresAt = new Date("2026-07-27T15:40:00.000Z");
  const providerCourse = {
    timeZone: "America/New_York",
    website: "https://course.example",
    detectedBookingUrl: "https://www.chronogolf.com/club/example-course",
    detectedPlatform: "CHRONOGOLF" as const,
    providerFamilyKey: "CHRONOGOLF",
    bookingMethod: "PUBLIC_ONLINE" as const,
    bookingWindowDaysAhead: 7,
    bookingWindowEvidenceUrl: "https://course.example/booking-policy",
    bookingReleaseTimeLocal: "07:00",
    bookingWindowSource: "OFFICIAL_BOOKING_PAGE",
    bookingWindowConfidence: 0.95,
    automationEligibility: "ALLOWED" as const,
    automationReason: "NONE" as const,
    monitoringMode: "AUTOMATIC" as const,
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    isPublic: true,
    intelligenceVerifiedAt: new Date("2026-07-26T12:00:00.000Z"),
    intelligenceReviewAt: new Date("2026-08-26T12:00:00.000Z"),
    intelligenceConfidence: 0.95,
    bookingMetadata: {
      clubId: 123,
      courseIds: ["example-course"],
      bookingBaseUrl: "https://www.chronogolf.com/club/example-course",
    },
    layoutHoleCounts: [18],
    layoutHolesVerifiedAt: new Date("2026-07-26T12:00:00.000Z"),
  };
  const providerSnapshotFingerprint =
    buildCourseSupportProviderSnapshotFingerprint(providerCourse);
  const observedFailureFingerprint = buildProviderFailureFingerprint({
    providerFamilyKey: "CHRONOGOLF",
    failureClass: "MISSING_SOURCE",
    operation: "AVAILABILITY",
    httpStatus: null,
  });
  const courseRef = createHash("sha256")
    .update("course-1")
    .digest("hex")
    .slice(0, 24);
  const sourceActiveRealSearchCount =
    overrides.sourceActiveRealSearchCount ?? 0;
  const currentActiveRealSearchCount =
    overrides.currentActiveRealSearchCount ?? sourceActiveRealSearchCount;
  const endpointEvent = {
    incidentId: "incident-1",
    eventType: "HUMAN_REVIEW_REQUESTED",
    occurredAt: endpointAt,
    audit: {
      humanReviewReason: "AUTOMATION_STALLED",
      cycle,
      customerState: "NEEDS_HUMAN_REVIEW",
      automationStalled: true,
      parkedUntilMaterialChange: true,
      endpointStalled: true,
      operationalRetryBudgetExhausted: false,
      reason: null,
      escalationDeadlineAt: escalationDeadlineAt.toISOString(),
      playbookExhausted: true,
      activeDemand: sourceActiveRealSearchCount > 0,
      customerDataIncluded: false,
    },
  };
  const lineageEvent = {
    id: "lineage-event",
    eventType: "REVALIDATION_REQUESTED",
    occurredAt: lineageAt,
    failureFingerprint: canonicalFailureFingerprint,
    audit: {
      providerFamilyHandoff: true,
      providerFamilyChanged: false,
      providerSnapshotChanged: false,
      priorCycle: cycle - 1,
      cycle,
      priorProviderFamilyKey: "CHRONOGOLF",
      providerFamilyKey: "CHRONOGOLF",
      priorFailureFingerprint,
      failureFingerprint: canonicalFailureFingerprint,
      claimedProviderSnapshotFingerprint: providerSnapshotFingerprint,
      observedProviderSnapshotFingerprint: providerSnapshotFingerprint,
      customerDataIncluded: false,
    },
  };
  const sourceProof = {
    kind: "PROVIDER_VERIFICATION_FAILURE",
    status: "RETRYABLE_FAILED",
    outcome: "FETCH_FAILED",
    failureClass: "MISSING_SOURCE",
    observedAt: sourceObservedAt.toISOString(),
    runtimeVersion,
    providerExecution: false,
    providerSnapshotFingerprint,
    completedAt: null,
    nextAttemptAt: new Date("2026-07-27T15:25:00.000Z").toISOString(),
    providerRetryNotBeforeAt: null,
    httpStatus: null,
  };
  const sourceEntry = {
    id: "legacy-source-entry",
    incidentId: "incident-1",
    courseId: "course-1",
    cycle,
    result: "NEEDS_HUMAN",
    proofSnapshot: sourceProof,
    verifiedAt: sourceObservedAt,
    createdAt: sourceBatchCreatedAt,
    updatedAt: new Date(sourceCompletedAt.getTime() + 2),
    verificationRequests: [
      {
        id: "legacy-source-request",
        batchIncidentId: "legacy-source-entry",
        releaseSha: runtimeVersion,
        runtimeVersion,
        status: "STALE",
        revision: 3,
        attemptCount: 1,
        startedAt: new Date("2026-07-27T15:18:00.000Z"),
        outcome: "FETCH_FAILED",
        failureClass: "MISSING_SOURCE",
        evidence: {
          schemaVersion: 1,
          kind: "PROVIDER_VERIFICATION",
          releaseSha: runtimeVersion,
          runtimeVersion,
          observedAt: sourceObservedAt.toISOString(),
          outcome: "FETCH_FAILED",
          failureClass: "MISSING_SOURCE",
          providerExecution: false,
          providerFamilyKey: "CHRONOGOLF",
          providerSnapshotFingerprint,
        },
        lastError: "batch_closed",
        providerSnapshotFingerprint,
        nextAttemptAt: null,
        completedAt: sourceCompletedAt,
        createdAt: new Date("2026-07-27T15:17:00.000Z"),
        updatedAt: sourceCompletedAt,
      },
    ],
    batch: {
      id: "legacy-source-batch",
      status: "PARTIAL",
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: canonicalFailureFingerprint,
      baseSha: runtimeVersion,
      releaseSha: runtimeVersion,
      deployedAt: new Date("2026-07-27T15:12:00.000Z"),
      createdAt: sourceBatchCreatedAt,
      completedAt: sourceCompletedAt,
      revision: 8,
      updatedAt: new Date(sourceCompletedAt.getTime() + 1),
      _count: { incidents: 1 },
      summary: {
        closeout: {
          outcome: "needs_human",
          derivedOutcome: "needs_human",
          terminalCount: 0,
          reusableFamilyRestoredCount: 0,
          retryCount: 0,
          needsHumanCount: 1,
          automationStalledCount: 1,
          operationalRetryBudgetExhaustedCount: 0,
          orchestrationOnlyCount: 0,
          providerFamilyHandoffCount: 0,
          verificationWatchMode: "WATCH_SETTLED",
          remediationAttemptConsumed: false,
          remediationAttempts: [
            {
              courseRef,
              consumed: false,
              countsTowardOperationalNoProgress: true,
              executionEvidence: {
                claimedImplementationPaths: false,
                newReleaseRecorded: false,
                deploymentRecorded: false,
                postProbeRecorded: false,
                providerAttemptRecorded: false,
                providerExecutionAttemptRecorded: false,
                playbookAttemptRecorded: false,
                terminalResultRecorded: false,
                providerExecutionStarted: true,
              },
              failureFingerprint: canonicalFailureFingerprint,
              observedFailureFingerprint,
              providerSnapshotFingerprint,
              observedProviderSnapshotFingerprint:
                providerSnapshotFingerprint,
              runtimeVersion,
              activeRealSearchCount: sourceActiveRealSearchCount,
              failureOnlyHandoffCooldownUntil:
                cooldownExpiresAt.toISOString(),
              operationalRetry: null,
              orchestrationRetry: null,
            },
          ],
        },
      },
    },
  };
  const currentIncident = incident({
    cycle,
    status: "NEEDS_HUMAN",
    kind: "FETCH_FAILED",
    providerFamilyKey: "CHRONOGOLF",
    failureClass: "HTTP_5XX",
    failureFingerprint: canonicalFailureFingerprint,
    attemptLedger: exhaustedLedger(cycle),
    humanReviewReason: "AUTOMATION_STALLED",
    escalatedAt: endpointAt,
    escalationDeadlineAt,
    nextAttemptAt: null,
    nextReminderAt: sourceCompletedAt,
    activeBatchId: null,
    attemptCount: 8,
    occurrenceCount: 11,
    activeRealSearchCount: currentActiveRealSearchCount,
    engineeringOnly:
      overrides.currentEngineeringOnly ?? currentActiveRealSearchCount === 0,
    lastSeenAt: endpointAt,
    batchIncidents: [sourceEntry],
    monitoringEvents: overrides.monitoringEvents ?? [lineageEvent],
  });
  const currentMonitoring = monitoringSnapshot(
    "ENGINEERING_VERIFICATION_NEEDED",
    {
      stateChangedAt: endpointAt,
      failureFingerprint: canonicalFailureFingerprint,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
    },
  );
  return {
    canonicalFailureFingerprint,
    cooldownExpiresAt,
    currentIncident,
    currentMonitoring,
    endpointEvent,
    lineageEvent,
    observedFailureFingerprint,
    providerCourse,
    providerSnapshotFingerprint,
    runtimeVersion,
    sourceCompletedAt,
    sourceObservedAt,
  };
}

function completedBatchEvidence(
  completedAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const closeout = {
    outcome: "success",
    derivedOutcome: "success",
    terminalCount: 1,
    retryCount: 0,
    needsHumanCount: 0,
    automationStalledCount: 0,
    failureDomain: "NONE",
    verificationWatchMode: "STANDARD",
    ...overrides,
  };
  const notes = JSON.stringify({
    schemaVersion: 1,
    lifecycle: "closeout",
    status: "SUCCEEDED",
    outcome: closeout.outcome,
    derivedOutcome: closeout.derivedOutcome,
    terminalCount: closeout.terminalCount,
    retryCount: closeout.retryCount,
    automationStalledCount: closeout.automationStalledCount,
    verificationWatchMode: closeout.verificationWatchMode,
    failureDomain: closeout.failureDomain,
  });
  return {
    status: "SUCCEEDED",
    completedAt,
    summary: { closeout },
    ownerAutomationRun: {
      id: "run-1",
      kind: "COURSE_SUPPORT",
      status: "COMPLETED",
      completedAt,
      outcome: closeout.outcome,
      notes,
    },
  };
}

describe("course monitoring watchdog", () => {
  beforeEach(() => {
    // Reset queued one-shot implementations as well as call history. Several
    // watchdog paths intentionally skip the human-review follow-up query, so a
    // leftover `mockResolvedValueOnce` must not leak into the next example.
    vi.resetAllMocks();
    prismaMocks.$transaction.mockImplementation(
      async (
        input:
          | Promise<unknown>[]
          | ((transaction: typeof prismaMocks) => Promise<unknown>),
      ) => (Array.isArray(input) ? Promise.all(input) : input(prismaMocks)),
    );
    prismaMocks.$queryRaw.mockResolvedValue([]);
    prismaMocks.$queryRawUnsafe.mockResolvedValue([]);
    prismaMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({});
    prismaMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "UNKNOWN",
      revision: 0,
    });
    prismaMocks.courseSupportIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportIncident.update.mockResolvedValue({});
    prismaMocks.courseSupportBatch.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([]);
    prismaMocks.courseSupportBatchIncident.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportVerificationRequest.updateMany.mockResolvedValue({
      count: 1,
    });
    prismaMocks.courseSupportVerificationRequest.findFirst.mockResolvedValue(
      null,
    );
    prismaMocks.automationRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.automationRun.findMany.mockResolvedValue([]);
    prismaMocks.automationRun.findFirst.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(null);
    prismaMocks.course.findUnique.mockResolvedValue(null);
    prismaMocks.teeSearch.updateMany.mockResolvedValue({ count: 1 });
    prismaMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
  });

  function useDeadlineIncident(value: Record<string, unknown>) {
    prismaMocks.courseSupportIncident.findUnique.mockReset();
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce(value);
  }

  function useDeferredFailureCarrierScenario(
    scenario: ReturnType<typeof deferredFailureCarrierScenario>,
    monitoringStatus = scenario.currentMonitoring,
  ) {
    scenario.batch.incidents[0]!.course.monitoringStatus = monitoringStatus;
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...scenario.currentIncident,
      activeBatch: scenario.batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      monitoringStatus,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
  }

  it("turns an unconfirmed fifteen-minute gap into explicit tooling work", async () => {
    const failureObservedAt = new Date(
      now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS,
    );
    const existingIncident = incident({
      firstSeenAt: failureObservedAt,
      lastSeenAt: failureObservedAt,
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "DEGRADED_RETRYING",
        lastSuccessfulAt: null,
        lastFailureAt: failureObservedAt,
        firstDegradedAt: failureObservedAt,
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: now,
        revision: 0,
        course: course(existingIncident),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "BLOCKED_TOOLING",
          confirmedAt: failureObservedAt,
          escalationDeadlineAt: new Date(now.getTime() + 15 * 60 * 1000),
          nextAttemptAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data,
    ).not.toHaveProperty("lastSeenAt");
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "TOOLING_INCIDENT",
          fromState: "DEGRADED_RETRYING",
          toState: "AUTO_INVESTIGATING",
        }),
      }),
    );
  });

  it("keeps a delayed local-reader success newer than a watchdog tooling transition", async () => {
    const failureObservedAt = new Date("2026-07-27T15:40:00.000Z");
    const successObservedAt = new Date("2026-07-27T15:55:00.000Z");
    const successConsumedAt = new Date("2026-07-27T16:05:00.000Z");
    const toolingIncident = incident({
      id: "incident-tooling",
      kind: "BLOCKED_TOOLING",
      confirmedAt: failureObservedAt,
      firstSeenAt: failureObservedAt,
      lastSeenAt: failureObservedAt,
    });
    const investigatingStatus = {
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      lastSuccessfulAt: null,
      lastFailureAt: failureObservedAt,
      consecutiveFailures: 1,
      failureFingerprint: "SOURCE_MISSING:UNKNOWN",
      firstDegradedAt: failureObservedAt,
      nextAutomaticAttemptAt: now,
      revalidationRequestedAt: null,
      revision: 1,
    };
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        ...investigatingStatus,
        state: "DEGRADED_RETRYING",
        revision: 0,
        course: course(null),
      },
    ]);
    prismaMocks.courseSupportIncident.create.mockResolvedValue(toolingIncident);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: "BLOCKED_TOOLING",
        confirmedAt: failureObservedAt,
        firstSeenAt: failureObservedAt,
        lastSeenAt: failureObservedAt,
        nextAttemptAt: now,
      }),
    });
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "TOOLING_INCIDENT",
          occurredAt: now,
        }),
      }),
    );

    prismaMocks.courseMonitoringStatus.upsert.mockResolvedValue(
      investigatingStatus,
    );
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({
      ...investigatingStatus,
      state: "HEALTHY",
      lastSuccessfulAt: successObservedAt,
      consecutiveFailures: 0,
      failureFingerprint: null,
      firstDegradedAt: null,
      nextAutomaticAttemptAt: null,
      revision: 2,
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      toolingIncident,
    );

    await expect(
      recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        source: "LOCAL_READER",
        providerObservedAt: successObservedAt,
        now: successConsumedAt,
        runtimeVersion: "reader-runtime",
      }),
    ).resolves.toMatchObject({
      state: "HEALTHY",
      lastSuccessfulAt: successObservedAt,
      sourceEvidenceAccepted: true,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          resolvedAt: successConsumedAt,
          lastSeenAt: successObservedAt,
        }),
      }),
    );
  });

  it("retains a proof-backed human decision without repeated escalation or writes", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T10:30:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T10:30:00.000Z"),
      nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
      nextReminderAt: new Date("2026-07-28T10:00:00.000Z"),
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      humanIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 0,
      remindersSent: 0,
    });
    expect(
      prismaMocks.courseSupportIncident.updateMany,
    ).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AUTO_INVESTIGATING" }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["incident-1"] },
          status: "NEEDS_HUMAN",
        }),
      }),
    );

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
      scheduled: 0,
    });
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("immediately repairs a stale needs-human row without current or prior proof", async () => {
    const staleHuman = incident({
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: now,
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      attemptLedger: renderedBrowserPendingLedger(),
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(staleHuman);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
  });

  it("repairs a stale non-stalled human reason with an invalid ledger", async () => {
    const stale = incident({
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "ACCOUNT_REQUIRED",
      escalatedAt: now,
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      attemptLedger: { version: 999, events: [] },
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(stale);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "ACCOUNT_REQUIRED",
      automationReason: "ACCOUNT_REQUIRED",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextAttemptAt: now,
        }),
      }),
    );
  });

  it.each([
    ["unexhausted", renderedBrowserPendingLedger()],
    ["current-cycle exhausted", exhaustedLedger()],
  ])(
    "does not mutate a stale-human incident with %s proof while a responder batch owns it",
    async (_proof, attemptLedger) => {
      const ownedIncident = incident({
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        escalatedAt: now,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        attemptLedger,
        activeBatchId: "batch-1",
        activeRealSearchCount: 0,
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        ownedIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 3,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        automationReason: "CAPTCHA_OR_QUEUE",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
        {
          courseId: "course-1",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          stateChangedAt: now,
          firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
          failureFingerprint: "SOURCE_MISSING:CHALLENGE",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          revision: 3,
          course: course(ownedIncident),
        },
      ]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it("releases an expired multi-course owner and continues the incomplete endpoint atomically", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    const siblingIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 0,
      revision: 2,
    });
    const currentMonitoring = monitoringSnapshot();
    const siblingMonitoring = monitoringSnapshot("AUTO_INVESTIGATING", {
      revision: 9,
    });
    const parkedCurrentIncident = {
      ...currentIncident,
      revision: 1,
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: now,
      nextAttemptAt: null,
      nextReminderAt: new Date("2026-07-28T16:00:00.000Z"),
    };
    const batch = responderBatch([
      { incident: currentIncident, monitoringStatus: currentMonitoring },
      { incident: siblingIncident, monitoringStatus: siblingMonitoring },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([parkedCurrentIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "batch-1",
        status: "VERIFYING",
        revision: 4,
        heartbeatAt: new Date("2026-07-27T15:50:00.000Z"),
        leaseExpiresAt: new Date("2026-07-27T15:59:00.000Z"),
        completedAt: null,
        AND: [{ leaseExpiresAt: { lt: now } }],
      },
      data: expect.objectContaining({
        status: "RETRYABLE_FAILED",
        completedAt: now,
        heartbeatAt: now,
        leaseExpiresAt: now,
        summary: expect.objectContaining({
          closeout: {
            outcome: "retryable_failed",
            derivedOutcome: "retryable_failed",
            terminalCount: 0,
            restoredCount: 0,
            finalDispositionCount: 0,
            retryCount: 2,
            needsHumanCount: 0,
            endpointCount: 0,
            automationStalledCount: 0,
            exhaustedEndpointCount: 0,
            orchestrationRetryCount: 0,
            orchestrationOnlyCourseRefs: [],
            failureDomain: "SLA",
            verificationWatchMode: "ENDPOINT",
            reason: "stale_endpoint_ownership_released",
          },
        }),
        revision: { increment: 1 },
      }),
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      2,
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          escalationDeadlineAt: new Date("2026-07-27T16:28:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.every(
        ([call]) => call.data.activeBatchId === null,
      ),
    ).toBe(true);
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-1" }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" }),
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-2" }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            cycle: 1,
            action: "continue_incomplete_playbook_after_stale_ownership",
            playbookConclusion: "INCOMPLETE",
            preservesAttemptLedger: true,
          }),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(
      prismaMocks.courseMonitoringStatus.updateMany.mock.calls.some(
        ([call]) =>
          call.where?.courseId === "course-1" &&
          call.data?.nextAutomaticAttemptAt instanceof Date,
      ),
    ).toBe(true);
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncident: { batchId: "batch-1" },
        }),
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", completedAt: null },
        data: expect.objectContaining({
          kind: "COURSE_SUPPORT",
          status: "COMPLETED",
          outcome: "retryable_failed",
        }),
      }),
    );
  });

  it.each([
    {
      label: "no detached request was created",
      verificationRequests: [] as Array<{
        startedAt: Date | null;
        outcome?: string | null;
        failureClass?: string | null;
        evidence?: unknown;
        lastError?: string | null;
      }>,
    },
    {
      label: "Workflow start failed before PRE_EXECUTION",
      verificationRequests: [
        {
          startedAt: null,
          outcome: "FETCH_FAILED",
          failureClass: "UNKNOWN",
          evidence: { providerExecution: false },
          lastError: "Workflow start failed before verification execution.",
        },
      ],
    },
  ])(
    "retries an expired endpoint without human review when $label",
    async ({ verificationRequests }) => {
      const currentIncident = incident({
        courseId: "course-1",
        activeBatchId: "batch-1",
        attemptLedger: null,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        activeRealSearchCount: 0,
        engineeringOnly: true,
      });
      const currentMonitoring = monitoringSnapshot();
      const batch = responderBatch(
        [
          {
            incident: currentIncident,
            monitoringStatus: currentMonitoring,
            verificationRequests,
          },
        ],
        { deployedAt: null },
      );
      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValueOnce([]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
        ...currentIncident,
        activeBatch: batch,
      });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 1,
        escalated: 0,
      });

      const retryAt = new Date(now.getTime() + 15 * 60 * 1000);
      expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RETRYABLE_FAILED",
            summary: expect.objectContaining({
              closeout: expect.objectContaining({
                outcome: "retryable_failed",
                retryCount: 1,
                needsHumanCount: 0,
                automationStalledCount: 0,
                orchestrationRetryCount: 1,
                orchestrationOnlyCourseRefs: [
                  expect.stringMatching(/^[a-f0-9]{24}$/u),
                ],
              }),
            }),
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            activeBatchId: "batch-1",
          }),
          data: expect.objectContaining({
            activeBatchId: null,
            nextAttemptAt: retryAt,
            escalationDeadlineAt: null,
            nextAction:
              "Retry provider verification because the prior responder ownership expired before execution began.",
          }),
        }),
      );
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "AUTO_INVESTIGATING",
            nextAutomaticAttemptAt: retryAt,
            revalidationRequestedAt: retryAt,
          }),
        }),
      );
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "REVALIDATION_REQUESTED",
            toState: "AUTO_INVESTIGATING",
            audit: expect.objectContaining({
              action: "course_support_orchestration_retry",
              cycle: 1,
              executionStarted: false,
              countsTowardOperationalNoProgress: false,
            }),
          }),
        }),
      );
      expect(
        prismaMocks.courseMonitoringEvent.create.mock.calls.some(
          ([input]) => input.data.eventType === "HUMAN_REVIEW_REQUESTED",
        ),
      ).toBe(false);
      expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1", completedAt: null },
          data: expect.objectContaining({
            status: "FAILED",
            outcome: "retryable_failed",
          }),
        }),
      );
    },
  );

  it("preserves an admitted deferred failure carrier when stale ownership expires before confirmation starts", async () => {
    const scenario = deferredFailureCarrierScenario(null);
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...scenario.currentIncident,
      activeBatch: scenario.batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    const closeoutCall =
      prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
        ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
      );
    expect(closeoutCall).toBeDefined();
    const closeout = closeoutCall?.[0].data.summary.closeout;
    expect(closeout).toMatchObject({
      outcome: "retryable_failed",
      endpointCount: 0,
      automationStalledCount: 0,
      exhaustedEndpointCount: 0,
      orchestrationRetryCount: 1,
      deferredFailureHandoffAvailableCount: 1,
      deferredFailureHandoffConsumedCount: 0,
    });
    const attempt = closeout.remediationAttempts[0];
    const carried = parseDeferredFailureHandoffSignal(
      attempt.deferredFailureHandoff,
    );
    expect(carried).toMatchObject({
      state: "AVAILABLE",
      confirmationStarted: false,
      signalDigest: scenario.source.signalDigest,
      sourceBatchIncidentDigest:
        createDeferredFailureHandoffBatchIncidentDigest("batch-entry-1"),
      canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
      observedFailureFingerprint: scenario.observedFailureFingerprint,
      claimedProviderSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      runtimeVersion: scenario.runtimeVersion,
      eligibleAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    });
    expect(attempt).toMatchObject({
      courseRef: scenario.courseRef,
      consumed: false,
      countsTowardOperationalNoProgress: false,
      executionEvidence: {
        claimedImplementationPaths: false,
        newReleaseRecorded: false,
        deploymentRecorded: false,
        postProbeRecorded: false,
        providerAttemptRecorded: false,
        providerExecutionAttemptRecorded: false,
        playbookAttemptRecorded: false,
        terminalResultRecorded: false,
        providerExecutionStarted: false,
      },
      orchestrationRetry: {
        attemptNumber: 1,
        delaySeconds: 15 * 60,
        retryAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      },
    });
    expect(
      parseDeferredFailureHandoffAdmission(
        attempt.deferredFailureHandoffAdmission,
      ),
    ).toMatchObject({
      signalDigest: carried?.signalDigest,
      sourceRecordDigest: carried?.recordDigest,
      sourceBatchIncidentDigest: carried?.sourceBatchIncidentDigest,
      admittedAt: scenario.admission.admittedAt,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 1,
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date(now.getTime() + 15 * 60 * 1000),
          escalationDeadlineAt: null,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "verification-1-1",
          batchIncidentId: "batch-entry-1",
          startedAt: null,
        }),
        data: {
          revision: { increment: 0 },
          updatedAt: new Date("2026-07-27T15:49:00.000Z"),
        },
      }),
    );
    expect(prismaMocks.courseSupportBatchIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-1",
          result: "PENDING",
        }),
        data: expect.objectContaining({
          result: "RETRY_SCHEDULED",
          updatedAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany.mock.calls.some(
        ([input]) => "proofSnapshot" in input.data,
      ),
    ).toBe(false);
    expect(
      prismaMocks.courseMonitoringEvent.create.mock.calls.some(
        ([input]) => input.data.eventType === "HUMAN_REVIEW_REQUESTED",
      ),
    ).toBe(false);
  });

  it("consumes an admitted deferred failure carrier when confirmation started without durable current-failure proof", async () => {
    const startedAt = new Date("2026-07-27T15:50:00.000Z");
    const scenario = deferredFailureCarrierScenario(startedAt);
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...scenario.currentIncident,
      activeBatch: scenario.batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    const closeoutCall =
      prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
        ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
      );
    expect(closeoutCall).toBeDefined();
    const closeout = closeoutCall?.[0].data.summary.closeout;
    expect(closeout).toMatchObject({
      outcome: "retryable_failed",
      endpointCount: 0,
      automationStalledCount: 0,
      exhaustedEndpointCount: 0,
      orchestrationRetryCount: 0,
      deferredFailureHandoffAvailableCount: 0,
      deferredFailureHandoffConsumedCount: 1,
    });
    const attempt = closeout.remediationAttempts[0];
    const consumed = parseDeferredFailureHandoffSignal(
      attempt.deferredFailureHandoff,
    );
    expect(consumed).toMatchObject({
      state: "CONSUMED",
      confirmationStarted: true,
      signalDigest: scenario.source.signalDigest,
      sourceBatchIncidentDigest:
        createDeferredFailureHandoffBatchIncidentDigest("batch-entry-1"),
      canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
    });
    expect(attempt).toMatchObject({
      consumed: false,
      countsTowardOperationalNoProgress: true,
      executionEvidence: expect.objectContaining({
        providerExecutionStarted: true,
        providerExecutionAttemptRecorded: false,
        providerAttemptRecorded: false,
      }),
      operationalRetry: null,
      orchestrationRetry: null,
    });
    expect(
      parseDeferredFailureHandoffAdmission(
        attempt.deferredFailureHandoffAdmission,
      ),
    ).toMatchObject({
      signalDigest: consumed?.signalDigest,
      sourceRecordDigest: consumed?.recordDigest,
      sourceBatchIncidentDigest: consumed?.sourceBatchIncidentDigest,
      admittedAt: scenario.admission.admittedAt,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 1,
          activeBatchId: "batch-1",
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date(now.getTime() + 60 * 1000),
          escalationDeadlineAt: new Date(now.getTime() + 30 * 60 * 1000),
          nextAction:
            "Retry the unchanged failure after the deferred confirmation started without durable current-failure proof.",
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "verification-1-1",
          batchIncidentId: "batch-entry-1",
          startedAt,
        }),
        data: {
          revision: { increment: 0 },
          updatedAt: startedAt,
        },
      }),
    );
    expect(
      prismaMocks.courseMonitoringEvent.create.mock.calls.some(
        ([input]) => input.data.eventType === "HUMAN_REVIEW_REQUESTED",
      ),
    ).toBe(false);
  });

  it.each(["MISSING_SOURCE", "SCHEMA"] as const)(
    "atomically hands off a provider-executed deferred %s proof while releasing stale ownership",
    async (failureClass) => {
      const startedAt = new Date("2026-07-27T15:50:00.000Z");
      const observedAt = new Date("2026-07-27T15:55:00.000Z");
      const scenario = deferredFailureCarrierScenario(startedAt);
      scenario.batch.incidents[0].proofSnapshot = {
        kind: "PROVIDER_VERIFICATION_FAILURE",
        status: "RETRYABLE_FAILED",
        outcome: "FETCH_FAILED",
        failureClass,
        observedAt: observedAt.toISOString(),
        completedAt: null,
        nextAttemptAt: null,
        providerRetryNotBeforeAt: null,
        runtimeVersion: scenario.runtimeVersion,
        providerExecution: true,
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      };
      Object.assign(scenario.batch.incidents[0].verificationRequests[0], {
        runtimeVersion: scenario.runtimeVersion,
        status: "RETRYABLE_FAILED",
        attemptCount: 1,
        startedAt,
        providerSnapshotAt: startedAt,
        outcome: "FETCH_FAILED",
        failureClass,
        evidence: {
          schemaVersion: 1,
          kind: "PROVIDER_VERIFICATION",
          releaseSha: scenario.runtimeVersion,
          runtimeVersion: scenario.runtimeVersion,
          observedAt: observedAt.toISOString(),
          outcome: "FETCH_FAILED",
          failureClass,
          providerExecution: true,
          providerFamilyKey: "SOURCE_MISSING",
          providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
        },
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
        nextAttemptAt: null,
        completedAt: null,
        createdAt: new Date("2026-07-27T15:49:00.000Z"),
        updatedAt: observedAt,
      });
      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValueOnce([]);
      useDeadlineIncident({
        ...scenario.currentIncident,
        activeBatch: scenario.batch,
      });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        scenario.currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 1,
        escalated: 0,
      });

      const failureFingerprint = buildProviderFailureFingerprint({
        providerFamilyKey: "SOURCE_MISSING",
        failureClass,
        operation: "AVAILABILITY",
        httpStatus: null,
      });
      const closeoutCall =
        prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
          ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
        );
      expect(closeoutCall?.[0].data.summary.closeout).toMatchObject({
        derivedOutcome: "retryable_failed",
        deferredFailureHandoffAvailableCount: 0,
        deferredFailureHandoffConsumedCount: 1,
        deferredFailureMaterialHandoffCount: 1,
      });
      expect(
        parseDeferredFailureHandoffSignal(
          closeoutCall?.[0].data.summary.closeout.remediationAttempts[0]
            .deferredFailureHandoff,
        ),
      ).toMatchObject({ state: "CONSUMED", confirmationStarted: true });
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            cycle: 1,
            activeBatchId: "batch-1",
            failureFingerprint: scenario.canonicalFailureFingerprint,
          }),
          data: expect.objectContaining({
            cycle: { increment: 1 },
            activeBatchId: null,
            failureClass,
            failureFingerprint,
            attemptCount: 0,
            firstSeenAt: observedAt,
            confirmedAt: observedAt,
            lastSeenAt: observedAt,
            nextAttemptAt: now,
          }),
        }),
      );
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            failureFingerprint: scenario.canonicalFailureFingerprint,
          }),
          data: expect.objectContaining({
            state: "AUTO_INVESTIGATING",
            lastFailureAt: observedAt,
            failureFingerprint,
            nextAutomaticAttemptAt: now,
            revalidationRequestedAt: now,
            stateChangedAt: now,
          }),
        }),
      );
      expect(
        prismaMocks.courseSupportVerificationRequest.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "verification-1-1",
            runtimeVersion: scenario.runtimeVersion,
            providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
            startedAt,
            createdAt: new Date("2026-07-27T15:49:00.000Z"),
            updatedAt: observedAt,
            evidence: { equals: expect.anything() },
          }),
          data: expect.objectContaining({
            revision: { increment: 0 },
            updatedAt: observedAt,
          }),
        }),
      );
      expect(
        prismaMocks.courseSupportBatchIncident.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "batch-entry-1",
            proofSnapshot: { equals: expect.anything() },
          }),
        }),
      );
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "REVALIDATION_REQUESTED",
            failureFingerprint,
            occurredAt: observedAt,
            audit: expect.objectContaining({
              priorCycle: 1,
              cycle: 2,
              providerFamilyHandoff: true,
              providerFamilyChanged: false,
              priorFailureFingerprint: scenario.canonicalFailureFingerprint,
              failureFingerprint,
              staleOwnershipRecovery: true,
              confirmationStarted: true,
              customerDataIncluded: false,
            }),
          }),
        }),
      );
      expect(
        prismaMocks.courseMonitoringEvent.create.mock.calls.some(
          ([input]) => input.data.eventType === "HUMAN_REVIEW_REQUESTED",
        ),
      ).toBe(false);

      const delayedSuccessObservedAt = new Date(
        "2026-07-27T15:57:00.000Z",
      );
      const delayedSuccessConsumedAt = new Date(
        "2026-07-27T16:05:00.000Z",
      );
      const handedOffMonitoring = {
        courseId: "course-1",
        state: "AUTO_INVESTIGATING",
        lastSuccessfulAt: null,
        lastFailureAt: observedAt,
        consecutiveFailures: 1,
        failureFingerprint,
        firstDegradedAt: observedAt,
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: now,
        stateChangedAt: now,
        revision: 8,
      };
      prismaMocks.courseMonitoringStatus.upsert.mockResolvedValue(
        handedOffMonitoring,
      );
      prismaMocks.courseMonitoringStatus.update.mockResolvedValue({
        ...handedOffMonitoring,
        state: "HEALTHY",
        lastSuccessfulAt: delayedSuccessObservedAt,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        stateChangedAt: delayedSuccessConsumedAt,
        revision: 9,
      });
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue({
        ...scenario.currentIncident,
        cycle: 2,
        revision: 1,
        status: "AUTO_INVESTIGATING",
        activeBatchId: null,
        failureClass,
        failureFingerprint,
        confirmedAt: observedAt,
        lastSeenAt: observedAt,
      });

      await expect(
        recordCourseMonitoringSuccess({
          courseId: "course-1",
          outcome: "NO_MATCH",
          source: "LOCAL_READER",
          providerObservedAt: delayedSuccessObservedAt,
          now: delayedSuccessConsumedAt,
          runtimeVersion: "reader-runtime",
        }),
      ).resolves.toMatchObject({
        state: "HEALTHY",
        lastSuccessfulAt: delayedSuccessObservedAt,
        sourceEvidenceAccepted: true,
      });
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RESOLVED",
            resolvedAt: delayedSuccessConsumedAt,
            lastSeenAt: delayedSuccessObservedAt,
          }),
        }),
      );
    },
  );

  it.each([
    { failureClass: "RATE_LIMIT" as const, httpStatus: 429 },
    { failureClass: "HTTP_5XX" as const, httpStatus: 503 },
  ])(
    "keeps a provider-executed deferred $failureClass handoff behind its one-hour provider floor",
    async ({ failureClass, httpStatus }) => {
      const startedAt = new Date("2026-07-27T15:50:00.000Z");
      const observedAt = new Date("2026-07-27T15:55:00.000Z");
      const providerFloor = new Date(now.getTime() + 60 * 60 * 1000);
      const scenario = deferredFailureCarrierScenario(startedAt);
      scenario.batch.incidents[0].proofSnapshot = {
        kind: "PROVIDER_VERIFICATION_FAILURE",
        status: "RETRYABLE_FAILED",
        outcome: "FETCH_FAILED",
        failureClass,
        observedAt: observedAt.toISOString(),
        completedAt: null,
        nextAttemptAt: providerFloor.toISOString(),
        providerRetryNotBeforeAt: providerFloor.toISOString(),
        httpStatus,
        runtimeVersion: scenario.runtimeVersion,
        providerExecution: true,
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      };
      Object.assign(scenario.batch.incidents[0].verificationRequests[0], {
        runtimeVersion: scenario.runtimeVersion,
        status: "RETRYABLE_FAILED",
        attemptCount: 1,
        startedAt,
        providerSnapshotAt: startedAt,
        outcome: "FETCH_FAILED",
        failureClass,
        evidence: {
          schemaVersion: 1,
          kind: "PROVIDER_VERIFICATION",
          releaseSha: scenario.runtimeVersion,
          runtimeVersion: scenario.runtimeVersion,
          observedAt: observedAt.toISOString(),
          outcome: "FETCH_FAILED",
          failureClass,
          providerExecution: true,
          providerFamilyKey: "SOURCE_MISSING",
          providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
          providerRetryNotBeforeAt: providerFloor.toISOString(),
          httpStatus,
        },
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
        nextAttemptAt: providerFloor,
        completedAt: null,
        createdAt: new Date("2026-07-27T15:49:00.000Z"),
        updatedAt: observedAt,
      });
      useDeferredFailureCarrierScenario(scenario);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 1,
        escalated: 0,
      });

      const failureFingerprint = buildProviderFailureFingerprint({
        providerFamilyKey: "SOURCE_MISSING",
        failureClass,
        operation: "AVAILABILITY",
        httpStatus,
      });
      const incidentHandoff =
        prismaMocks.courseSupportIncident.updateMany.mock.calls.find(
          ([input]) => input.data?.cycle?.increment === 1,
        )?.[0];
      expect(incidentHandoff?.data).toEqual(
        expect.objectContaining({
          cycle: { increment: 1 },
          failureClass,
          failureFingerprint,
          nextAttemptAt: providerFloor,
        }),
      );
      const freshCycleDeadline = incidentHandoff?.data.escalationDeadlineAt;
      expect(freshCycleDeadline).toBeInstanceOf(Date);
      expect(freshCycleDeadline.getTime()).toBeGreaterThan(
        providerFloor.getTime(),
      );
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: "AUTO_INVESTIGATING",
            failureFingerprint,
            nextAutomaticAttemptAt: providerFloor,
            revalidationRequestedAt: providerFloor,
          }),
        }),
      );

      const beforeProviderFloor = new Date(
        providerFloor.getTime() - 10 * 60 * 1000,
      );
      const recoveredIncident = {
        ...scenario.currentIncident,
        cycle: scenario.currentIncident.cycle + 1,
        revision: scenario.currentIncident.revision + 1,
        activeBatchId: null,
        failureClass,
        failureFingerprint,
        firstSeenAt: now,
        confirmedAt: now,
        escalationDeadlineAt: freshCycleDeadline,
        nextAttemptAt: providerFloor,
        humanReviewReason: null,
        nextReminderAt: null,
        lastSeenAt: now,
      };
      vi.clearAllMocks();
      prismaMocks.courseSupportIncident.findMany.mockResolvedValue([]);
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
        {
          courseId: "course-1",
          state: "AUTO_INVESTIGATING",
          stateChangedAt: now,
          firstDegradedAt: null,
          failureFingerprint,
          nextAutomaticAttemptAt: providerFloor,
          revalidationRequestedAt: providerFloor,
          revision: scenario.currentMonitoring.revision + 1,
          course: course(recoveredIncident),
        },
      ]);

      await expect(
        runCourseMonitoringWatchdog(beforeProviderFloor),
      ).resolves.toMatchObject({ checked: 1, scheduled: 0, escalated: 0 });

      expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it("adopts a completed deferred failure request when ownership expires before entry reflection", async () => {
    const startedAt = new Date("2026-07-27T15:50:00.000Z");
    const observedAt = new Date("2026-07-27T15:55:00.000Z");
    const scenario = deferredFailureCarrierScenario(startedAt);
    Object.assign(scenario.batch.incidents[0].verificationRequests[0], {
      runtimeVersion: scenario.runtimeVersion,
      status: "RETRYABLE_FAILED",
      outcome: "FETCH_FAILED",
      failureClass: "MISSING_SOURCE",
      evidence: {
        schemaVersion: 1,
        kind: "PROVIDER_VERIFICATION",
        releaseSha: scenario.runtimeVersion,
        runtimeVersion: scenario.runtimeVersion,
        observedAt: observedAt.toISOString(),
        outcome: "FETCH_FAILED",
        failureClass: "MISSING_SOURCE",
        providerExecution: true,
        providerFamilyKey: "SOURCE_MISSING",
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      },
      providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      nextAttemptAt: null,
      completedAt: null,
      updatedAt: observedAt,
    });
    expect(scenario.batch.incidents[0].proofSnapshot).toBeNull();
    scenario.currentIncident.activeRealSearchCount = 1;
    const legacyMonitoringFingerprint =
      scenario.canonicalFailureFingerprint.toUpperCase();
    scenario.currentMonitoring.failureFingerprint = legacyMonitoringFingerprint;
    useDeferredFailureCarrierScenario(scenario);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    const failureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      operation: "AVAILABILITY",
      httpStatus: null,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          failureClass: "MISSING_SOURCE",
          failureFingerprint,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          failureFingerprint: legacyMonitoringFingerprint,
        }),
        data: expect.objectContaining({
          failureFingerprint,
        }),
      }),
    );
    expect(prismaMocks.courseSupportBatchIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-1",
          proofSnapshot: { equals: expect.anything() },
        }),
        data: expect.objectContaining({
          result: "RETRY_SCHEDULED",
          updatedAt: now,
        }),
      }),
    );
  });

  it("consumes a completed current-F1 confirmation without replaying the old F2 after an owner crash", async () => {
    const startedAt = new Date("2026-07-27T15:50:00.000Z");
    const observedAt = new Date("2026-07-27T15:55:00.000Z");
    const scenario = deferredFailureCarrierScenario(startedAt);
    Object.assign(scenario.batch.incidents[0].verificationRequests[0], {
      runtimeVersion: scenario.runtimeVersion,
      status: "RETRYABLE_FAILED",
      outcome: "FETCH_FAILED",
      failureClass: "HTTP_5XX",
      evidence: {
        schemaVersion: 1,
        kind: "PROVIDER_VERIFICATION",
        releaseSha: scenario.runtimeVersion,
        runtimeVersion: scenario.runtimeVersion,
        observedAt: observedAt.toISOString(),
        outcome: "FETCH_FAILED",
        failureClass: "HTTP_5XX",
        providerExecution: true,
        providerFamilyKey: "SOURCE_MISSING",
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      },
      providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      nextAttemptAt: null,
      completedAt: null,
      updatedAt: observedAt,
    });
    expect(scenario.batch.incidents[0].proofSnapshot).toBeNull();
    useDeferredFailureCarrierScenario(scenario);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    const incidentUpdate =
      prismaMocks.courseSupportIncident.updateMany.mock.calls.find(
        ([input]) => input.where?.id === "incident-1",
      )?.[0];
    expect(incidentUpdate?.data).not.toHaveProperty("cycle");
    expect(incidentUpdate?.data).not.toHaveProperty(
      "failureFingerprint",
      scenario.observedFailureFingerprint,
    );
    expect(incidentUpdate?.data).toMatchObject({
      activeBatchId: null,
      nextAttemptAt: new Date(now.getTime() + 60 * 1000),
    });
    const closeoutCall =
      prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
        ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
      );
    expect(
      parseDeferredFailureHandoffSignal(
        closeoutCall?.[0].data.summary.closeout.remediationAttempts[0]
          .deferredFailureHandoff,
      ),
    ).toMatchObject({
      state: "CONSUMED",
      confirmationStarted: true,
      canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
    });
    expect(
      prismaMocks.courseMonitoringEvent.create.mock.calls.some(
        ([input]) => input.data?.audit?.providerFamilyHandoff === true,
      ),
    ).toBe(false);
  });

  it("adopts a completed deferred success request when ownership expires before entry reflection", async () => {
    const startedAt = new Date("2026-07-27T15:50:00.000Z");
    const attemptedAt = new Date("2026-07-27T15:51:00.000Z");
    const verifiedAt = new Date("2026-07-27T15:52:00.000Z");
    const observedAt = new Date("2026-07-27T15:55:00.000Z");
    const completedAt = new Date("2026-07-27T15:56:00.000Z");
    const scenario = deferredFailureCarrierScenario(startedAt);
    Object.assign(scenario.batch.incidents[0].verificationRequests[0], {
      runtimeVersion: scenario.runtimeVersion,
      status: "SUCCEEDED",
      outcome: "NO_MATCH",
      failureClass: null,
      evidence: {
        schemaVersion: 1,
        kind: "PROVIDER_VERIFICATION",
        releaseSha: scenario.runtimeVersion,
        runtimeVersion: scenario.runtimeVersion,
        observedAt: observedAt.toISOString(),
        outcome: "NO_MATCH",
        providerExecution: true,
        providerFamilyKey: "SOURCE_MISSING",
        providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      },
      lastError: null,
      providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      discoveryAttemptedAt: attemptedAt,
      discoveryVerifiedAt: verifiedAt,
      nextAttemptAt: null,
      completedAt,
      updatedAt: completedAt,
    });
    expect(scenario.batch.incidents[0].proofSnapshot).toBeNull();
    useDeferredFailureCarrierScenario(scenario);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "HEALTHY",
          lastSuccessfulAt: observedAt,
          failureFingerprint: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          activeBatchId: null,
          resolution: "MONITORING_RESTORED",
          resolvedAt: now,
          lastSeenAt: observedAt,
        }),
      }),
    );
    expect(prismaMocks.courseSupportBatchIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: "RESTORED", updatedAt: now }),
      }),
    );
  });

  it.each([
    ["HEALTHY", "RESTORED", "MONITORING_RESTORED"],
    ["FINAL_TECHNICAL", "FINAL_DISPOSITION", "TECHNICAL_LIMITATION_CLASSIFIED"],
  ] as const)(
    "releases an expired deferred carrier to the newer authoritative %s state without replaying the stale failure",
    async (state, result, resolution) => {
      const scenario = deferredFailureCarrierScenario(null);
      const authoritativeMonitoring = monitoringSnapshot(state, {
        failureFingerprint: null,
        stateChangedAt: new Date("2026-07-27T15:58:00.000Z"),
        revision: 9,
      });
      useDeferredFailureCarrierScenario(scenario, authoritativeMonitoring);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });

      expect(
        prismaMocks.courseSupportBatchIncident.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "batch-entry-1",
            incidentId: "incident-1",
            cycle: 1,
            result: "PENDING",
          }),
          data: expect.objectContaining({ result }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            cycle: 1,
            activeBatchId: "batch-1",
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            activeBatchId: null,
            resolution,
          }),
        }),
      );
      const closeoutCall =
        prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
          ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
        );
      const attempt = closeoutCall?.[0].data.summary.closeout.remediationAttempts[0];
      expect(parseDeferredFailureHandoffSignal(attempt?.deferredFailureHandoff)).toMatchObject({
        state: "CONSUMED",
        confirmationStarted: false,
        canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
      });
      expect(attempt?.deferredFailureHandoffInvalidation).toEqual({
        schemaVersion: 1,
        reason: "MUTABLE_CURRENT_STATE_CHANGED",
        signalDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        customerDataIncluded: false,
      });
      expect(
        prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
          ([input]) => input.data?.cycle !== undefined,
        ),
      ).toBe(false);
      expect(
        prismaMocks.courseMonitoringEvent.create.mock.calls.some(
          ([input]) => input.data?.audit?.providerFamilyHandoff === true,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["provider snapshot", null],
    ["monitoring identity", null],
    ["provider snapshot", new Date("2026-07-27T15:50:00.000Z")],
    ["monitoring identity", new Date("2026-07-27T15:50:00.000Z")],
  ] as const)(
    "invalidates an expired deferred carrier after %s drift (started at %s) and releases ownership without projecting the stale F2",
    async (drift, startedAt) => {
      const scenario = deferredFailureCarrierScenario(startedAt);
      if (drift === "provider snapshot") {
        scenario.batch.incidents[0]!.course.website =
          "https://new-provider-shape.example";
      } else {
        scenario.currentMonitoring.failureFingerprint = "4".repeat(64);
      }
      useDeferredFailureCarrierScenario(scenario);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 1,
        escalated: 0,
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            cycle: 1,
            activeBatchId: "batch-1",
          }),
          data: expect.objectContaining({
            activeBatchId: null,
            nextAttemptAt: new Date(now.getTime() + 60 * 1000),
            nextAction:
              "Retry from current monitoring and provider evidence after invalidating the superseded deferred confirmation.",
          }),
        }),
      );
      const closeoutCall =
        prismaMocks.courseSupportBatch.updateMany.mock.calls.find(
          ([input]) => input.data?.completedAt?.getTime() === now.getTime(),
        );
      expect(closeoutCall?.[0].data.summary.closeout).toMatchObject({
        outcome: "retryable_failed",
        deferredFailureHandoffAvailableCount: 0,
        deferredFailureHandoffConsumedCount: 1,
        deferredFailureMaterialHandoffCount: 0,
      });
      const attempt = closeoutCall?.[0].data.summary.closeout.remediationAttempts[0];
      const consumed = parseDeferredFailureHandoffSignal(
        attempt?.deferredFailureHandoff,
      );
      expect(consumed).toMatchObject({
        state: "CONSUMED",
        confirmationStarted: startedAt !== null,
        canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
        observedFailureFingerprint: scenario.observedFailureFingerprint,
      });
      expect(attempt).toMatchObject({
        consumed: false,
        countsTowardOperationalNoProgress: startedAt !== null,
        executionEvidence: expect.objectContaining({
          providerExecutionStarted: startedAt !== null,
        }),
        deferredFailureHandoffInvalidation: {
          schemaVersion: 1,
          reason: "MUTABLE_CURRENT_STATE_CHANGED",
          signalDigest: consumed?.signalDigest,
          customerDataIncluded: false,
        },
      });
      expect(
        prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
          ([input]) =>
            input.data?.cycle !== undefined ||
            input.data?.failureFingerprint === scenario.observedFailureFingerprint,
        ),
      ).toBe(false);
      expect(
        prismaMocks.courseMonitoringEvent.create.mock.calls.some(
          ([input]) => input.data?.audit?.providerFamilyHandoff === true,
        ),
      ).toBe(false);
    },
  );

  it("restores the exact parked CHRONOGOLF legacy handoff once at database-clock expiry", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    const legacyMonitoringFingerprint =
      scenario.canonicalFailureFingerprint.toUpperCase();
    scenario.currentMonitoring.failureFingerprint = legacyMonitoringFingerprint;
    expect(scenario.currentIncident.batchIncidents).toEqual([
      expect.objectContaining({
        result: "NEEDS_HUMAN",
        updatedAt: new Date(scenario.sourceCompletedAt.getTime() + 2),
        verificationRequests: [
          expect.objectContaining({
            status: "STALE",
            lastError: "batch_closed",
            nextAttemptAt: null,
            completedAt: scenario.sourceCompletedAt,
            updatedAt: scenario.sourceCompletedAt,
          }),
        ],
        batch: expect.objectContaining({
          status: "PARTIAL",
          updatedAt: new Date(scenario.sourceCompletedAt.getTime() + 1),
          _count: { incidents: 1 },
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              outcome: "needs_human",
              derivedOutcome: "needs_human",
              retryCount: 0,
              needsHumanCount: 1,
              automationStalledCount: 1,
              verificationWatchMode: "WATCH_SETTLED",
              remediationAttemptConsumed: false,
              remediationAttempts: [
                expect.objectContaining({
                  consumed: false,
                  executionEvidence: expect.objectContaining({
                    playbookAttemptRecorded: false,
                    providerExecutionStarted: true,
                    providerAttemptRecorded: false,
                  }),
                }),
              ],
            }),
          }),
        }),
      }),
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.$queryRaw.mockResolvedValue([
      { now: scenario.cooldownExpiresAt },
    ]);

    await expect(
      runCourseMonitoringWatchdog(
        new Date(scenario.cooldownExpiresAt.getTime() + 5 * 60 * 1000),
      ),
    ).resolves.toMatchObject({
      checked: 0,
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "legacy-source-batch",
          status: "PARTIAL",
          providerFamilyKey: "CHRONOGOLF",
          failureFingerprint: scenario.canonicalFailureFingerprint,
          releaseSha: scenario.runtimeVersion,
        }),
        data: {
          revision: { increment: 0 },
          updatedAt: new Date(scenario.sourceCompletedAt.getTime() + 1),
        },
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "legacy-source-entry",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 2,
          result: "NEEDS_HUMAN",
        }),
        data: {
          updatedAt: new Date(scenario.sourceCompletedAt.getTime() + 2),
        },
      }),
    );
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "legacy-source-request",
          releaseSha: scenario.runtimeVersion,
          runtimeVersion: scenario.runtimeVersion,
          status: "STALE",
          failureClass: "MISSING_SOURCE",
          providerSnapshotFingerprint: scenario.providerSnapshotFingerprint,
        }),
        data: {
          revision: { increment: 0 },
          updatedAt: scenario.sourceCompletedAt,
        },
      }),
    );

    const incidentRecovery =
      prismaMocks.courseSupportIncident.updateMany.mock.calls.find(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      )?.[0];
    expect(incidentRecovery).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          courseId: "course-1",
          cycle: 2,
          revision: 0,
          status: "NEEDS_HUMAN",
          kind: "FETCH_FAILED",
          providerFamilyKey: "CHRONOGOLF",
          failureClass: "HTTP_5XX",
          failureFingerprint: scenario.canonicalFailureFingerprint,
          humanReviewReason: "AUTOMATION_STALLED",
          activeBatchId: null,
          nextAttemptAt: null,
          nextReminderAt: scenario.sourceCompletedAt,
          lastSeenAt: scenario.sourceCompletedAt,
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextAttemptAt: scenario.cooldownExpiresAt,
          revision: { increment: 1 },
        }),
      }),
    );
    expect(incidentRecovery?.data.escalationDeadlineAt).toBeInstanceOf(Date);
    expect(
      incidentRecovery?.data.escalationDeadlineAt.getTime(),
    ).toBeGreaterThan(scenario.cooldownExpiresAt.getTime());
    expect(incidentRecovery?.data).not.toHaveProperty("cycle");
    expect(incidentRecovery?.data).not.toHaveProperty("failureFingerprint");
    expect(incidentRecovery?.data).not.toHaveProperty("attemptLedger");
    expect(incidentRecovery?.data).not.toHaveProperty("attemptCount");
    expect(incidentRecovery?.data).not.toHaveProperty("occurrenceCount");
    expect(incidentRecovery?.data).not.toHaveProperty("lastSeenAt");

    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-1",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 7,
          failureFingerprint: legacyMonitoringFingerprint,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          failureFingerprint: scenario.canonicalFailureFingerprint,
          nextAutomaticAttemptAt: scenario.cooldownExpiresAt,
          revalidationRequestedAt: scenario.cooldownExpiresAt,
          stateChangedAt: scenario.cooldownExpiresAt,
        }),
      }),
    );

    const marker =
      prismaMocks.courseMonitoringEvent.create.mock.calls.find(
        ([input]) =>
          input.data?.audit?.action ===
          "deferred_failure_handoff_legacy_recovery",
      )?.[0].data;
    expect(marker).toEqual(
      expect.objectContaining({
        courseId: "course-1",
        incidentId: "incident-1",
        eventType: "REVALIDATION_REQUESTED",
        fromState: "ENGINEERING_VERIFICATION_NEEDED",
        toState: "AUTO_INVESTIGATING",
        failureFingerprint: scenario.canonicalFailureFingerprint,
        runtimeVersion: scenario.runtimeVersion,
        occurredAt: scenario.cooldownExpiresAt,
        idempotencyKey: expect.stringContaining(
          "course-monitoring-deferred-failure-recovery:incident-1:2:",
        ),
        audit: expect.objectContaining({
          schemaVersion: 1,
          action: "deferred_failure_handoff_legacy_recovery",
          cycle: 2,
          sourceResult: "NEEDS_HUMAN",
          sourceBatchStatus: "PARTIAL",
          sourceDerivedOutcome: "needs_human",
          sourceVerificationWatchMode: "WATCH_SETTLED",
          sourceAttemptConsumed: true,
          eligibleAt: scenario.cooldownExpiresAt.toISOString(),
          sameCycleRecovery: true,
          oneShotPerEvidenceSnapshot: true,
          preservesCanonicalFailureFingerprint: true,
          preservesAttemptLedger: true,
          preservesAttemptCount: true,
          customerDataIncluded: false,
        }),
      }),
    );
    const signal = parseDeferredFailureHandoffSignal(
      marker?.audit?.deferredFailureHandoff,
    );
    expect(signal).toMatchObject({
      state: "AVAILABLE",
      providerFamilyKey: "CHRONOGOLF",
      canonicalFailureFingerprint: scenario.canonicalFailureFingerprint,
      observedFailureFingerprint: scenario.observedFailureFingerprint,
      claimedProviderSnapshotFingerprint: scenario.providerSnapshotFingerprint,
      observedProviderSnapshotFingerprint:
        scenario.providerSnapshotFingerprint,
      runtimeVersion: scenario.runtimeVersion,
      cooldownExpiresAt: scenario.cooldownExpiresAt.toISOString(),
      eligibleAt: scenario.cooldownExpiresAt.toISOString(),
      sourceVerificationWatchMode: "WATCH_SETTLED",
      sourceResult: "NEEDS_HUMAN",
      sourceAttemptConsumed: true,
      confirmationStarted: false,
    });
    expect(marker?.audit?.legacySourceRecordDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(marker?.audit?.sourceBatchIncidentDigest).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(marker?.audit?.sourceProofDigest).toMatch(/^[a-f0-9]{64}$/u);
    const privacySafeAudit = JSON.stringify(marker?.audit);
    expect(privacySafeAudit).not.toContain("course-1");
    expect(privacySafeAudit).not.toContain("Example Public Golf Course");
    expect(privacySafeAudit).not.toContain("course.example");
    expect(privacySafeAudit).not.toContain("chronogolf.com");
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "historical demand ended before recovery",
      sourceActiveRealSearchCount: 1,
      currentActiveRealSearchCount: 0,
      currentEngineeringOnly: false,
    },
    {
      label: "real demand arrived after the archived closeout",
      sourceActiveRealSearchCount: 0,
      currentActiveRealSearchCount: 1,
      currentEngineeringOnly: false,
    },
  ])(
    "validates archived demand against the archived endpoint when $label",
    async ({
      sourceActiveRealSearchCount,
      currentActiveRealSearchCount,
      currentEngineeringOnly,
    }) => {
      const scenario = legacyDeferredFailureHandoffScenario({
        sourceActiveRealSearchCount,
        currentActiveRealSearchCount,
        currentEngineeringOnly,
      });
      const sourceAttempt =
        scenario.currentIncident.batchIncidents[0].batch.summary.closeout
          .remediationAttempts[0];
      expect(sourceAttempt.activeRealSearchCount).toBe(
        sourceActiveRealSearchCount,
      );
      expect(scenario.endpointEvent.audit.activeDemand).toBe(
        sourceActiveRealSearchCount > 0,
      );
      expect(scenario.currentIncident.activeRealSearchCount).toBe(
        currentActiveRealSearchCount,
      );
      expect(scenario.currentIncident.engineeringOnly).toBe(
        currentEngineeringOnly,
      );

      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValue([]);
      useDeadlineIncident(scenario.currentIncident);
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        scenario.currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
      prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
        scenario.endpointEvent,
      );
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
      prismaMocks.$queryRaw.mockResolvedValue([
        { now: scenario.cooldownExpiresAt },
      ]);

      await expect(
        runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
      ).resolves.toMatchObject({ scheduled: 1, escalated: 0 });

      const incidentRecovery =
        prismaMocks.courseSupportIncident.updateMany.mock.calls.find(
          ([input]) => input.data?.status === "AUTO_INVESTIGATING",
        )?.[0];
      expect(incidentRecovery?.data).toEqual(
        expect.objectContaining({
          escalationDeadlineAt: getDeferredFailureHandoffEscalationDeadline(
            scenario.cooldownExpiresAt,
            currentActiveRealSearchCount,
          ),
        }),
      );
      expect(incidentRecovery?.data).not.toHaveProperty(
        "activeRealSearchCount",
      );
      expect(incidentRecovery?.data).not.toHaveProperty("engineeringOnly");
    },
  );

  it("rejects a legacy source whose archived demand count contradicts its archived endpoint", async () => {
    const scenario = legacyDeferredFailureHandoffScenario({
      sourceActiveRealSearchCount: 1,
      currentActiveRealSearchCount: 0,
      currentEngineeringOnly: false,
    });
    scenario.endpointEvent.audit.activeDemand = false;
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("rejects the fabricated retryable legacy source shape that settled exhausted closeout never persisted", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    const sourceEntry = scenario.currentIncident.batchIncidents[0];
    sourceEntry.result = "RETRY_SCHEDULED";
    sourceEntry.batch.status = "RETRYABLE_FAILED";
    Object.assign(sourceEntry.batch.summary.closeout, {
      outcome: "retryable_failed",
      derivedOutcome: "retryable_failed",
      retryCount: 1,
      needsHumanCount: 0,
      automationStalledCount: 0,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the exact legacy handoff parked one database millisecond before expiry", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.$queryRaw.mockResolvedValue([
      { now: new Date(scenario.cooldownExpiresAt.getTime() - 1) },
    ]);

    await expect(
      runCourseMonitoringWatchdog(
        new Date(scenario.cooldownExpiresAt.getTime() + 5 * 60 * 1000),
      ),
    ).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(
      prismaMocks.courseMonitoringStatus.updateMany.mock.calls.some(
        ([input]) => input.data?.state === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("writes the newest exact recovery marker after nineteen bounded old events", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    const oldEvents = Array.from({ length: 18 }, (_, index) => ({
      id: `old-revalidation-${String(index + 1).padStart(2, "0")}`,
      eventType: "REVALIDATION_REQUESTED",
      occurredAt: new Date(
        scenario.sourceCompletedAt.getTime() - (index + 1) * 1_000,
      ),
      failureFingerprint: scenario.canonicalFailureFingerprint,
      audit: {
        action: "ordinary_revalidation",
        customerDataIncluded: false,
      },
    }));
    scenario.currentIncident.monitoringEvents = [
      ...oldEvents,
      scenario.lineageEvent,
    ].sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        right.id.localeCompare(left.id),
    );
    expect(scenario.currentIncident.monitoringEvents).toHaveLength(19);
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.$queryRaw.mockResolvedValue([
      { now: scenario.cooldownExpiresAt },
    ]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 1, escalated: 0 });

    expect(prismaMocks.courseSupportIncident.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          monitoringEvents: expect.objectContaining({
            orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
            take: 20,
          }),
        }),
      }),
    );
    const marker =
      prismaMocks.courseMonitoringEvent.create.mock.calls.find(
        ([input]) =>
          input.data?.audit?.action ===
          "deferred_failure_handoff_legacy_recovery",
      )?.[0].data;
    expect(marker?.occurredAt).toEqual(scenario.cooldownExpiresAt);
    expect(
      scenario.currentIncident.monitoringEvents.every(
        (event) => event.occurredAt.getTime() < marker!.occurredAt.getTime(),
      ),
    ).toBe(true);
  });

  it("fails closed when an aged recovery marker could be outside the saturated event window", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    const newerEvents = Array.from({ length: 19 }, (_, index) => ({
      id: `newer-revalidation-${String(index + 1).padStart(2, "0")}`,
      eventType: "REVALIDATION_REQUESTED",
      occurredAt: new Date(
        scenario.sourceCompletedAt.getTime() - (index + 1) * 1_000,
      ),
      failureFingerprint: scenario.canonicalFailureFingerprint,
      audit: {
        action: "ordinary_revalidation",
        customerDataIncluded: false,
      },
    }));
    scenario.currentIncident.monitoringEvents = [
      ...newerEvents,
      scenario.lineageEvent,
    ].sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        right.id.localeCompare(left.id),
    );
    expect(scenario.currentIncident.monitoringEvents).toHaveLength(20);
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.findUnique).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the legacy handoff parked when an active campaign exists", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.automationRun.findMany.mockResolvedValue([{ audit: null }]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "course ownership survives an incident-id change",
      conflictCourseId: "course-1",
      conflictIncidentId: "replacement-incident",
    },
    {
      label: "incident ownership survives a course-id mismatch",
      conflictCourseId: "replacement-course",
      conflictIncidentId: "incident-1",
    },
  ])(
    "checks every bounded active campaign when $label",
    async ({ conflictCourseId, conflictIncidentId }) => {
      const scenario = legacyDeferredFailureHandoffScenario();
      const campaignAudit = (courseId: string, incidentId: string) =>
        createParkedCourseCampaignAudit({
          expectedCount: 1,
          capturedAt: new Date("2026-07-27T15:05:00.000Z"),
          members: [
            {
              courseId,
              incidentId,
              cycle: 2,
              revision: 1,
              monitoringRevision: 1,
              monitoringFailureFingerprint: "1".repeat(64),
              kind: "FETCH_FAILED",
              providerFamilyKey: "CHRONOGOLF",
              failureClass: "HTTP_5XX",
              failureFingerprint: "1".repeat(64),
              providerSnapshotFingerprint:
                scenario.providerSnapshotFingerprint,
              attemptLedgerFingerprint: "4".repeat(64),
              playbookConclusion: "UNRESOLVED_EXHAUSTED",
              latestProbeAt: null,
              latestDiscoveryAt: null,
            },
          ],
        });
      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValue([]);
      useDeadlineIncident(scenario.currentIncident);
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        scenario.currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
      prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
        scenario.endpointEvent,
      );
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
      prismaMocks.automationRun.findMany.mockResolvedValue([
        {
          audit: campaignAudit("unrelated-course", "unrelated-incident"),
        },
        {
          audit: campaignAudit(conflictCourseId, conflictIncidentId),
        },
      ]);

      await expect(
        runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
      ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

      expect(prismaMocks.automationRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "RUNNING",
            completedAt: null,
          }),
          take: 21,
        }),
      );
      expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
      expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
          ([input]) => input.data?.status === "AUTO_INVESTIGATING",
        ),
      ).toBe(false);
    },
  );

  it("keeps the legacy handoff parked when its one-shot marker already exists", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    scenario.currentIncident.monitoringEvents = [
      scenario.lineageEvent,
      {
        id: "prior-legacy-recovery",
        eventType: "REVALIDATION_REQUESTED",
        occurredAt: scenario.sourceCompletedAt,
        failureFingerprint: scenario.canonicalFailureFingerprint,
        audit: {
          action: "deferred_failure_handoff_legacy_recovery",
          cycle: 2,
          customerDataIncluded: false,
        },
      },
    ];
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the legacy handoff parked when a newer duplicate source request shadows it", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    const sourceEntry = scenario.currentIncident.batchIncidents[0];
    sourceEntry.verificationRequests.push({
      ...structuredClone(sourceEntry.verificationRequests[0]),
      id: "newer-contradictory-request",
      createdAt: new Date("2026-07-27T15:18:30.000Z"),
      updatedAt: new Date("2026-07-27T15:19:30.000Z"),
    });
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).resolves.toMatchObject({ scheduled: 0, escalated: 0 });

    expect(prismaMocks.$queryRaw).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("fails closed when the legacy source batch loses its no-op CAS", async () => {
    const scenario = legacyDeferredFailureHandoffScenario();
    prismaMocks.courseSupportIncident.findMany
      .mockReset()
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    useDeadlineIncident(scenario.currentIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      scenario.currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue(scenario.providerCourse);
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(
      scenario.endpointEvent,
    );
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.$queryRaw.mockResolvedValue([
      { now: scenario.cooldownExpiresAt },
    ]);
    prismaMocks.courseSupportBatch.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      runCourseMonitoringWatchdog(scenario.cooldownExpiresAt),
    ).rejects.toThrow(
      "The legacy deferred-failure source changed during watchdog recovery.",
    );

    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.some(
        ([input]) => input.data?.status === "AUTO_INVESTIGATING",
      ),
    ).toBe(false);
    expect(prismaMocks.courseMonitoringStatus.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("does not label a stalled descendant orchestration-only after an archived release deployment", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 0,
      engineeringOnly: true,
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch(
      [
        {
          incident: currentIncident,
          monitoringStatus: currentMonitoring,
          verificationRequests: [],
        },
      ],
      {
        deployedAt: null,
        summary: {
          executionEver: {
            schemaVersion: 1,
            changedReleaseDeploymentRecorded: true,
            providerExecutionCourseRefs: [],
            terminalExecutionCourseRefs: [],
          },
        },
      },
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 1,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              orchestrationRetryCount: 0,
              orchestrationOnlyCourseRefs: [],
            }),
          }),
        }),
      }),
    );
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
  });

  it("does not retry orchestration after archived attempt-only provider execution", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 0,
      engineeringOnly: true,
    });
    const currentMonitoring = monitoringSnapshot();
    const courseRef = createHash("sha256")
      .update("course-1")
      .digest("hex")
      .slice(0, 24);
    const batch = responderBatch(
      [
        {
          incident: currentIncident,
          monitoringStatus: currentMonitoring,
          verificationRequests: [],
        },
      ],
      {
        deployedAt: null,
        summary: {
          executionEver: {
            schemaVersion: 2,
            changedReleaseDeploymentRecorded: false,
            providerExecutionCourseRefs: [],
            providerExecutionAttemptCourseRefs: [courseRef],
            terminalExecutionCourseRefs: [],
          },
        },
      },
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 1,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              orchestrationRetryCount: 0,
              orchestrationOnlyCourseRefs: [],
            }),
          }),
        }),
      }),
    );
    expect(
      prismaMocks.courseMonitoringEvent.create.mock.calls.some(
        ([input]) =>
          input.data.audit?.action === "course_support_orchestration_retry",
      ),
    ).toBe(false);
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED" }),
      }),
    );
    expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it.each([
    {
      label: "a late non-provider probe",
      sharedRemediationOwner: false,
      probeCount: 1,
    },
    {
      label: "a shared-TeeSearch remediation owner",
      sharedRemediationOwner: true,
      probeCount: 0,
    },
  ])(
    "persists $label before operational endpoint closeout",
    async (scenario) => {
      const currentIncident = incident({
        courseId: "course-1",
        activeBatchId: "batch-1",
        attemptLedger: null,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        activeRealSearchCount: 0,
        engineeringOnly: true,
      });
      const currentMonitoring = monitoringSnapshot();
      const searchRef = "f".repeat(64);
      const recheckDispatchStartedAt = new Date("2026-07-27T15:40:00.000Z");
      const recheckDispatchedAt = new Date("2026-07-27T15:41:00.000Z");
      const currentDispatch = {
        id: "batch-search-1",
        teeSearchId: "search-1",
        searchRef,
        scheduleVersion: 2,
        removedAt: null,
        removalReason: null,
        teeSearch: {
          id: "search-1",
          status: "ACTIVE",
          trafficClass: "PUBLIC",
          scheduleVersion: 2,
          alertGeneration: 1,
          workflowRunId: "workflow-1",
          checkStatus: "WAITING",
          checkLeaseToken: null,
          checkLeaseExpiresAt: null,
          recheckRequestedAt: null,
          remediationDispatchKey: "dispatch-1",
          remediationDispatchVersion: 2,
          nextCheckAt: new Date("2026-07-27T16:15:00.000Z"),
          lastCheckedAt: new Date("2026-07-27T15:55:00.000Z"),
          lastCheckOutcome: "provider fetch failed",
          updatedAt: new Date("2026-07-27T15:55:00.000Z"),
          preferences: [
            {
              id: "preference-1",
              teeSearchId: "search-1",
              courseId: "course-1",
              rank: 1,
            },
          ],
          probes: [
            {
              id: "search-execution-evidence-1",
              teeSearchId: "search-1",
              courseId: "course-1",
              automationRunId: "search-run-1",
              outcome: "FETCH_FAILED",
              observedAt: new Date("2026-07-27T15:55:00.000Z"),
              message: "Provider request failed.",
              evidenceUrl: null,
              rawSummary: { providerExecution: false },
              runtimeVersion: null,
            },
          ],
        },
      };
      if (scenario.sharedRemediationOwner) {
        currentDispatch.teeSearch.remediationDispatchKey =
          "second-active-batch-dispatch";
        currentDispatch.teeSearch.probes = [];
      }
      const initialDispatch = {
        ...currentDispatch,
        teeSearch: {
          ...currentDispatch.teeSearch,
          remediationDispatchKey: "dispatch-1",
          probes: [],
        },
      };
      const unsettledDispatch = {
        ...currentDispatch,
        teeSearch: {
          ...currentDispatch.teeSearch,
          checkLeaseToken: "active-search-lease",
        },
      };
      const initialFence = persistCourseSupportSearchExecutionFence(
        buildCourseSupportSearchExecutionFenceSnapshot({
          courseIds: ["course-1"],
          expectedSearches: [{ searchRef, scheduleVersion: 2 }],
          recheckDispatchKey: "dispatch-1",
          recheckDispatchStartedAt,
          recheckDispatchedAt,
          now,
          dispatches: [initialDispatch],
        }),
        new Date("2026-07-27T15:56:00.000Z"),
      );
      const batch = responderBatch(
        [
          {
            incident: currentIncident,
            monitoringStatus: currentMonitoring,
            verificationRequests: [],
          },
        ],
        {
          deployedAt: null,
          recheckDispatchKey: "dispatch-1",
          recheckDispatchStartedAt,
          recheckDispatchedAt,
          summary: {
            recheckDispatch: {
              affectedSearchRefs: [{ searchRef, scheduleVersion: 2 }],
            },
            searchExecutionFence: initialFence,
          },
        },
      );
      prismaMocks.courseSupportBatchSearch.findMany
        .mockResolvedValueOnce([unsettledDispatch])
        .mockResolvedValue([currentDispatch]);
      prismaMocks.courseSupportIncident.findMany
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValueOnce([]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
        ...currentIncident,
        activeBatch: batch,
      });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });
      expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();

      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValueOnce([]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
        ...currentIncident,
        activeBatch: batch,
      });

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });

      const persistedSummary = prismaMocks.courseSupportBatch.updateMany.mock
        .calls[0]?.[0]?.data?.summary as Record<string, unknown>;
      const courseRef = createHash("sha256")
        .update("course-1")
        .digest("hex")
        .slice(0, 24);
      expect(persistedSummary).toMatchObject({
        executionEver: {
          schemaVersion: 2,
          providerExecutionCourseRefs: [],
          providerExecutionAttemptCourseRefs: [courseRef],
        },
        searchExecutionFence: expect.objectContaining({
          providerExecutionAttemptCourseRefs: [],
          searchExecutionMayHaveStartedCourseRefs: [courseRef],
          probeCount: scenario.probeCount,
        }),
      });
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();

      prismaMocks.courseSupportBatch.updateMany.mockClear();
      prismaMocks.courseSupportIncident.updateMany.mockClear();
      prismaMocks.courseSupportBatchIncident.updateMany.mockClear();
      prismaMocks.courseMonitoringEvent.create.mockClear();
      prismaMocks.automationRun.updateMany.mockClear();
      prismaMocks.courseSupportIncident.findMany
        .mockReset()
        .mockResolvedValueOnce([{ courseId: "course-1" }])
        .mockResolvedValueOnce([]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
        ...currentIncident,
        activeBatch: {
          ...batch,
          revision: 5,
          summary: persistedSummary,
        },
      });

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 1,
      });

      expect(
        prismaMocks.courseMonitoringEvent.create.mock.calls.some(
          ([call]) =>
            call.data.audit?.action === "course_support_orchestration_retry",
        ),
      ).toBe(false);
      expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "COMPLETED" }),
        }),
      );
      expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "FAILED" }),
        }),
      );
    },
  );

  it("keeps queue-before-batch-search-upsert dispatch ownership open", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 0,
      engineeringOnly: true,
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch(
      [
        {
          incident: currentIncident,
          monitoringStatus: currentMonitoring,
          verificationRequests: [],
        },
      ],
      {
        deployedAt: null,
        recheckDispatchKey: "dispatch-before-batch-search-upsert",
        recheckDispatchStartedAt: new Date("2026-07-27T15:55:00.000Z"),
        recheckDispatchedAt: null,
        summary: {
          recheckDispatch: { affectedSearchRefs: [] },
        },
      },
    );
    prismaMocks.courseSupportBatchSearch.findMany.mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      }),
    );
  });

  it("does not close an expired endpoint when execution starts during the request fence", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch(
      [
        {
          incident: currentIncident,
          monitoringStatus: currentMonitoring,
          verificationRequests: [{ startedAt: null }],
        },
      ],
      { deployedAt: null },
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.courseSupportVerificationRequest.updateMany.mockResolvedValueOnce(
      { count: 0 },
    );

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalled();
  });

  it("does not close an expired endpoint when a current-runtime request appears after an empty snapshot", async () => {
    const currentIncident = incident({
      courseId: "course-1",
      activeBatchId: "batch-1",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch(
      [
        {
          incident: currentIncident,
          monitoringStatus: currentMonitoring,
          verificationRequests: [],
        },
      ],
      { deployedAt: null },
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.courseSupportVerificationRequest.findFirst.mockResolvedValueOnce(
      {
        id: "late-request",
      },
    );

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalled();
  });

  it("closes a mixed expired batch with stalled, exhausted, and later retry outcomes in one pass", async () => {
    const stalledIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const exhaustedIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: exhaustedLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:31:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const laterIncident = incident({
      id: "incident-3",
      reference: "csi_323456789012345678901234",
      courseId: "course-3",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      revision: 3,
    });
    const currentMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: stalledIncident, monitoringStatus: currentMonitoring },
      {
        incident: exhaustedIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 8,
        }),
      },
      {
        incident: laterIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 9,
        }),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...stalledIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
      scheduled: 1,
    });
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(2);
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-1",
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            action: "continue_incomplete_playbook_after_stale_ownership",
            playbookConclusion: "INCOMPLETE",
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-2",
          audit: expect.objectContaining({
            playbookExhausted: true,
            automationStalled: false,
          }),
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-2" }),
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          activeBatchId: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-3" }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          summary: expect.objectContaining({
            closeout: {
              outcome: "needs_human",
              derivedOutcome: "needs_human",
              terminalCount: 0,
              restoredCount: 0,
              finalDispositionCount: 0,
              retryCount: 2,
              needsHumanCount: 1,
              endpointCount: 1,
              automationStalledCount: 0,
              exhaustedEndpointCount: 1,
              orchestrationRetryCount: 0,
              orchestrationOnlyCourseRefs: [],
              failureDomain: "SLA",
              verificationWatchMode: "ENDPOINT",
              reason: "stale_endpoint_ownership_released",
            },
          }),
        }),
      }),
    );
  });

  it("adopts a success inserted after the batch snapshot before expired closeout", async () => {
    const currentIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const siblingIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      lastSeenAt: new Date("2026-07-27T15:40:00.000Z"),
      revision: 2,
    });
    const currentMonitoring = monitoringSnapshot();
    const freshObservedAt = new Date("2026-07-27T15:59:00.000Z");
    const batch = responderBatch([
      { incident: currentIncident, monitoringStatus: currentMonitoring },
      {
        incident: siblingIncident,
        monitoringStatus: monitoringSnapshot("AUTO_INVESTIGATING", {
          revision: 8,
        }),
      },
    ]);
    let probeInsertCommitted = false;
    prismaMocks.$queryRaw.mockImplementationOnce(async () => {
      probeInsertCommitted = true;
      return [];
    });
    prismaMocks.courseProbe.findFirst.mockImplementation(
      async (query: { where?: { courseId?: string } }) =>
        probeInsertCommitted && query.where?.courseId === "course-2"
          ? {
              outcome: "NO_MATCH",
              observedAt: freshObservedAt,
              runtimeVersion: "fresh-runtime",
            }
          : null,
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...currentIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await runCourseMonitoringWatchdog(now);

    expect(prismaMocks.$queryRaw).toHaveBeenCalledTimes(7);
    for (let index = 0; index < 6; index += 1) {
      expect(
        prismaMocks.$queryRaw.mock.invocationCallOrder[index],
      ).toBeLessThan(
        prismaMocks.$queryRaw.mock.invocationCallOrder[index + 1]!,
      );
    }
    expect(prismaMocks.$queryRaw.mock.invocationCallOrder[6]).toBeLessThan(
      prismaMocks.courseProbe.findFirst.mock.invocationCallOrder[0]!,
    );

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "incident-2" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          activeBatchId: null,
          resolution: "MONITORING_RESTORED",
          resolvedAt: now,
          lastSeenAt: freshObservedAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ courseId: "course-2", revision: 8 }),
        data: expect.objectContaining({
          state: "HEALTHY",
          lastSuccessfulAt: freshObservedAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          incidentId: "incident-2",
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
  });

  it("normalizes detached resolved evidence while closing the remaining expired endpoint", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const detachedResolved = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: null,
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-07-27T15:55:00.000Z"),
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: detachedResolved,
        monitoringStatus: monitoringSnapshot("HEALTHY", { revision: 8 }),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValueOnce({
      ...dueIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
      scheduled: 1,
    });
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-2",
          result: "PENDING",
        }),
        data: expect.objectContaining({ result: "RESTORED" }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "PARTIAL",
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              outcome: "partial",
              needsHumanCount: 0,
              restoredCount: 1,
              retryCount: 1,
            }),
          }),
        }),
      }),
    );
  });

  it("fails closed when a detached batch entry points at a later incident cycle", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const laterCycleIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      cycle: 2,
      activeBatchId: null,
      status: "RESOLVED",
      resolution: "MONITORING_RESTORED",
      resolvedAt: new Date("2026-07-27T15:55:00.000Z"),
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: laterCycleIncident,
        monitoringStatus: monitoringSnapshot("HEALTHY", { revision: 8 }),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    batch.incidents[1]!.cycle = 1;
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({ ...dueIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("repairs detached unproven AUTO human markers during expired closeout", async () => {
    const dueIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const detachedUnprovenHuman = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: null,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:45:00.000Z"),
      nextReminderAt: new Date("2026-07-27T15:50:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const dueMonitoring = monitoringSnapshot();
    const batch = responderBatch([
      { incident: dueIncident, monitoringStatus: dueMonitoring },
      {
        incident: detachedUnprovenHuman,
        monitoringStatus: monitoringSnapshot(
          "ENGINEERING_VERIFICATION_NEEDED",
          {
            revision: 8,
          },
        ),
        result: "PENDING",
      },
    ]);
    batch.activeIncidents = [{ id: "incident-1" }];
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({ ...dueIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      dueMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
      scheduled: 1,
    });
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "batch-entry-2" }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" }),
      }),
    );
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              needsHumanCount: 0,
              retryCount: 2,
            }),
          }),
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
          nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-2",
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 8,
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          preferences: { some: { courseId: "course-2" } },
        }),
      }),
    );
  });

  it.each([
    ["authoritative course first", "course-1"],
    ["due endpoint first", "course-2"],
  ])(
    "adopts an authoritative sibling and a due endpoint when the %s triggers cleanup",
    async (_label, triggerCourseId) => {
      const authoritativeIncident = incident({
        id: "incident-authoritative",
        courseId: "course-1",
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      const dueIncident = incident({
        id: "incident-due",
        reference: "csi_223456789012345678901234",
        courseId: "course-2",
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
        revision: 2,
      });
      const authoritativeMonitoring = monitoringSnapshot("HEALTHY", {
        revision: 7,
      });
      const dueMonitoring = monitoringSnapshot("AUTO_INVESTIGATING", {
        revision: 8,
      });
      const batch = responderBatch([
        {
          incident: authoritativeIncident,
          monitoringStatus: authoritativeMonitoring,
        },
        { incident: dueIncident, monitoringStatus: dueMonitoring },
      ]);
      const triggerIncident =
        triggerCourseId === "course-1" ? authoritativeIncident : dueIncident;
      const triggerMonitoring =
        triggerCourseId === "course-1"
          ? authoritativeMonitoring
          : dueMonitoring;
      prismaMocks.courseSupportIncident.findMany
        .mockResolvedValueOnce([{ courseId: triggerCourseId }])
        .mockResolvedValueOnce([]);
      useDeadlineIncident({
        ...triggerIncident,
        activeBatch: batch,
      });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        triggerMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await runCourseMonitoringWatchdog(now);

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "incident-authoritative" }),
          data: expect.objectContaining({
            status: "RESOLVED",
            activeBatchId: null,
            resolution: "MONITORING_RESTORED",
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "incident-due" }),
          data: expect.objectContaining({
            activeBatchId: null,
            nextAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
            escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
          }),
        }),
      );
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            incidentId: "incident-due",
            eventType: "REVALIDATION_REQUESTED",
            audit: expect.objectContaining({
              action: "continue_incomplete_playbook_after_stale_ownership",
              playbookConclusion: "INCOMPLETE",
            }),
          }),
        }),
      );
    },
  );

  it("writes a selector-compatible retryable closeout when every stale entry retries", async () => {
    const firstIncident = incident({
      activeBatchId: "batch-1",
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:45:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const secondIncident = incident({
      id: "incident-2",
      reference: "csi_223456789012345678901234",
      courseId: "course-2",
      activeBatchId: "batch-1",
      humanReviewReason: "ACCOUNT_REQUIRED",
      escalatedAt: new Date("2026-07-27T15:46:00.000Z"),
      nextReminderAt: new Date("2026-07-27T15:51:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
      revision: 2,
    });
    const topLevelMonitoring = monitoringSnapshot(
      "ENGINEERING_VERIFICATION_NEEDED",
    );
    const batch = responderBatch([
      { incident: firstIncident, monitoringStatus: topLevelMonitoring },
      {
        incident: secondIncident,
        monitoringStatus: monitoringSnapshot(
          "ENGINEERING_VERIFICATION_NEEDED",
          {
            revision: 8,
          },
        ),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...firstIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      topLevelMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          completedAt: now,
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              outcome: "retryable_failed",
              derivedOutcome: "retryable_failed",
              retryCount: 2,
              needsHumanCount: 0,
              terminalCount: 0,
            }),
          }),
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany.mock.calls.every(
        ([call]) => call.data.result === "RETRY_SCHEDULED",
      ),
    ).toBe(true);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      2,
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls.every(
        ([call]) =>
          call.data.activeBatchId === null &&
          call.data.nextAttemptAt.getTime() ===
            new Date("2026-07-27T16:01:00.000Z").getTime(),
      ),
    ).toBe(true);
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          status: "NEEDS_HUMAN",
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          status: "AUTO_INVESTIGATING",
        }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-1",
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          courseId: "course-2",
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: new Date("2026-07-27T16:01:00.000Z"),
          revalidationRequestedAt: new Date("2026-07-27T16:01:00.000Z"),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(2);
    for (const courseId of ["course-1", "course-2"]) {
      expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            preferences: { some: { courseId } },
          }),
        }),
      );
    }
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("clears a terminal batch orphan without rewriting its durable closeout", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot("HEALTHY");
    const completedAt = new Date("2026-07-27T15:55:00.000Z");
    const terminalEvidence = completedBatchEvidence(completedAt);
    terminalEvidence.ownerAutomationRun.kind = "OTHER";
    terminalEvidence.ownerAutomationRun.status = "RUNNING";
    const batch = responderBatch(
      [
        {
          incident: ownedIncident,
          monitoringStatus: currentMonitoring,
          result: "RESTORED",
        },
      ],
      terminalEvidence,
    );
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledWith({
      where: {
        id: "run-1",
        kind: "OTHER",
        status: "RUNNING",
        completedAt,
        outcome: "success",
        notes: terminalEvidence.ownerAutomationRun.notes,
      },
      data: {
        kind: "COURSE_SUPPORT",
        status: "COMPLETED",
        outcome: "success",
      },
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeBatchId: "batch-1" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
          activeBatchId: null,
        }),
      }),
    );
  });

  it.each([
    ["missing", { closeout: { outcome: "success" } }],
    [
      "contradictory",
      {
        closeout: {
          ...completedBatchEvidence(new Date("2026-07-27T15:55:00.000Z"))
            .summary.closeout,
          terminalCount: 2,
        },
      },
    ],
  ])(
    "fails closed on a terminal orphan with %s canonical closeout evidence",
    async (_label, summary) => {
      const ownedIncident = incident({
        activeBatchId: "batch-1",
        attemptLedger: renderedBrowserPendingLedger(),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      const currentMonitoring = monitoringSnapshot("HEALTHY");
      const completedAt = new Date("2026-07-27T15:55:00.000Z");
      const terminalEvidence = completedBatchEvidence(completedAt);
      const batch = responderBatch(
        [
          {
            incident: ownedIncident,
            monitoringStatus: currentMonitoring,
            result: "RESTORED",
          },
        ],
        { ...terminalEvidence, summary },
      );
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      useDeadlineIncident({ ...ownedIncident, activeBatch: batch });
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
        currentMonitoring,
      );
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "UNKNOWN",
        automationReason: "OTHER",
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        scheduled: 0,
        escalated: 0,
      });
      expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
      expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).not.toHaveBeenCalled();
      expect(
        prismaMocks.courseSupportBatchIncident.updateMany,
      ).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it("fails closed when terminal orphan AutomationRun evidence loses its CAS", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const currentMonitoring = monitoringSnapshot("HEALTHY");
    const completedAt = new Date("2026-07-27T15:55:00.000Z");
    const terminalEvidence = completedBatchEvidence(completedAt);
    const batch = responderBatch(
      [
        {
          incident: ownedIncident,
          monitoringStatus: currentMonitoring,
          result: "RESTORED",
        },
      ],
      terminalEvidence,
    );
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({ ...ownedIncident, activeBatch: batch });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      currentMonitoring,
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.automationRun.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.automationRun.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("preserves an active batch whose endpoint lease is still live", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
    });
    const batch = responderBatch(
      [{ incident: ownedIncident, monitoringStatus: monitoringSnapshot() }],
      { leaseExpiresAt: now },
    );
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      monitoringSnapshot(),
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed when stale batch ownership is renewed during the endpoint CAS", async () => {
    const ownedIncident = incident({
      activeBatchId: "batch-1",
      attemptLedger: renderedBrowserPendingLedger(),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    const batch = responderBatch([
      { incident: ownedIncident, monitoringStatus: monitoringSnapshot() },
    ]);
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    useDeadlineIncident({
      ...ownedIncident,
      activeBatch: batch,
    });
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue(
      monitoringSnapshot(),
    );
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseSupportBatch.updateMany.mockResolvedValue({ count: 0 });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportBatch.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportBatchIncident.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseSupportVerificationRequest.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("does not disturb prior human proof while an incomplete current cycle is within its deadline", async () => {
    const escalatedAt = new Date("2026-07-27T10:00:00.000Z");
    const revalidatingIncident = incident({
      cycle: 2,
      status: "AUTO_INVESTIGATING",
      attemptLedger: priorCycleExhaustedCurrentCyclePendingLedger(),
      escalatedAt,
      escalationDeadlineAt: new Date("2026-07-27T16:30:00.000Z"),
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      revalidatingIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("repairs proofless engineering state with no incident owner", async () => {
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: now,
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 3,
        course: course(null),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
        }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({ missingIncidentProof: true }),
        }),
      }),
    );
  });

  it("repairs proofless engineering state with an automatic incident before its deadline", async () => {
    const futureDeadline = new Date("2026-07-27T18:00:00.000Z");
    const orphanedIncident = incident({
      status: "AUTO_INVESTIGATING",
      attemptLedger: null,
      escalationDeadlineAt: futureDeadline,
      humanReviewReason: null,
      nextAttemptAt: null,
      activeRealSearchCount: 1,
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      orphanedIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          nextAttemptAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data
        ?.escalationDeadlineAt,
    ).toBeUndefined();
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
        }),
      }),
    );
  });

  it("retains a cycle-scoped material-change parking decision without reopening or queueing searches", async () => {
    const parkedAt = new Date("2026-07-27T15:45:00.000Z");
    const parkedIncident = incident({
      cycle: 3,
      status: "NEEDS_HUMAN",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T18:00:00.000Z"),
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      nextAttemptAt: null,
      nextReminderAt: parkedAt,
      lastSeenAt: parkedAt,
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      parkedIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
      },
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseMonitoringEvent.findFirst).toHaveBeenCalledWith({
      where: {
        incidentId: "incident-1",
        eventType: "HUMAN_REVIEW_REQUESTED",
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      select: {
        incidentId: true,
        eventType: true,
        occurredAt: true,
        audit: true,
      },
    });
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("keeps a proven park null-scheduled through repeated watchdog visibility cycles", async () => {
    const parkedAt = new Date("2026-07-27T15:45:00.000Z");
    const parkedIncident = incident({
      cycle: 3,
      status: "NEEDS_HUMAN",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T18:00:00.000Z"),
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      nextAttemptAt: null,
      nextReminderAt: parkedAt,
      lastSeenAt: parkedAt,
      activeRealSearchCount: 0,
      engineeringOnly: true,
    });
    const statusSnapshot = {
      courseId: "course-1",
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
      failureFingerprint: "SOURCE_MISSING:UNKNOWN",
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
      course: course(parkedIncident),
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([parkedIncident])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([parkedIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      parkedIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
      },
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      statusSnapshot,
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 0,
    });
    await expect(
      runCourseMonitoringWatchdog(new Date("2026-07-27T16:10:00.000Z")),
    ).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      2,
    );
    for (const [call] of prismaMocks.courseSupportIncident.updateMany.mock
      .calls) {
      expect(call).toEqual(
        expect.objectContaining({
          where: expect.objectContaining({ nextAttemptAt: null }),
          data: expect.not.objectContaining({
            nextAttemptAt: expect.anything(),
          }),
        }),
      );
    }
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("promotes new real demand on a proven park without reopening technical work", async () => {
    const parkedAt = new Date("2026-07-27T15:45:00.000Z");
    const activeDate = new Date("2026-08-02T00:00:00.000Z");
    const parkedIncident = incident({
      cycle: 3,
      status: "NEEDS_HUMAN",
      attemptLedger: null,
      escalationDeadlineAt: new Date("2026-07-27T18:00:00.000Z"),
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      nextAttemptAt: null,
      nextReminderAt: new Date("2026-07-28T15:45:00.000Z"),
      lastSeenAt: parkedAt,
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      engineeringOnly: true,
    });
    const promotedIncident = {
      ...parkedIncident,
      revision: 1,
      activeRealSearchCount: 1,
      earliestTargetDate: activeDate,
      engineeringOnly: false,
      nextAttemptAt: null,
      nextReminderAt: now,
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([promotedIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      parkedIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
      },
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: parkedAt,
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:UNKNOWN",
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 3,
        course: {
          ...course(parkedIncident),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: now,
              },
            },
          ],
        },
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      escalated: 0,
    });

    const updates = prismaMocks.courseSupportIncident.updateMany.mock.calls.map(
      ([call]) => call,
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          activeRealSearchCount: 1,
          earliestTargetDate: activeDate,
          engineeringOnly: false,
          nextReminderAt: now,
        }),
      }),
    );
    for (const update of updates) {
      expect(update.data).not.toHaveProperty("nextAttemptAt");
    }
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("records an unchanged alert failure without dissolving a proven park, then retains it at the deadline", async () => {
    const parkedAt = new Date("2026-07-27T15:45:00.000Z");
    const failureFingerprint = "SOURCE_MISSING:UNKNOWN";
    const parkedIncident = incident({
      cycle: 3,
      status: "NEEDS_HUMAN",
      failureFingerprint,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T18:00:00.000Z"),
      activeBatchId: null,
      nextAttemptAt: null,
      nextReminderAt: new Date("2026-07-28T15:45:00.000Z"),
      lastSeenAt: parkedAt,
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    const parkedMonitoring = {
      courseId: "course-1",
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: parkedAt,
      firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
      lastFailureAt: parkedAt,
      consecutiveFailures: 3,
      failureFingerprint,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
    };
    const parkedEvent = {
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: parkedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
      },
    };
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      parkedIncident,
    );
    prismaMocks.courseMonitoringStatus.upsert.mockResolvedValue(
      parkedMonitoring,
    );
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({
      ...parkedMonitoring,
      lastFailureAt: now,
      consecutiveFailures: 4,
      revision: 4,
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(parkedEvent);

    await expect(
      recordCourseMonitoringFailure({
        courseId: "course-1",
        outcome: "NEEDS_ADAPTER",
        failureFingerprint,
        readPath: "TYPED_PROVIDER_ADAPTER",
        activeRealSearchCount: 1,
        failureObservedAt: now,
        now,
      }),
    ).resolves.toMatchObject({
      confirmed: true,
      nextAttemptAt: null,
    });

    expect(prismaMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastFailureAt: now,
          nextAutomaticAttemptAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          revision: 0,
          status: "NEEDS_HUMAN",
        }),
        data: expect.objectContaining({
          nextAttemptAt: null,
          lastSeenAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "CHECK_FAILED",
          failureFingerprint,
          audit: expect.objectContaining({
            retainedHumanReview: true,
            parkedUntilMaterialChange: true,
          }),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    const afterFailureIncident = {
      ...parkedIncident,
      revision: 1,
      lastSeenAt: now,
      nextAttemptAt: null,
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      afterFailureIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      ...parkedMonitoring,
      revision: 4,
      lastFailureAt: now,
      consecutiveFailures: 4,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue(parkedEvent);
    prismaMocks.courseProbe.findFirst.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(
      runCourseMonitoringWatchdog(new Date("2026-07-27T16:10:00.000Z")),
    ).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("repairs the same parked-shaped state when its durable parking proof is missing", async () => {
    const escalatedAt = new Date("2026-07-27T15:30:00.000Z");
    const failureObservedAt = new Date("2026-07-27T15:25:00.000Z");
    const prooflessIncident = incident({
      cycle: 3,
      status: "NEEDS_HUMAN",
      attemptLedger: renderedBrowserPendingLedger(3),
      confirmedAt: failureObservedAt,
      lastSeenAt: failureObservedAt,
      escalationDeadlineAt: escalatedAt,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt,
      nextAttemptAt: null,
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      prooflessIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      lastSuccessfulAt: null,
      lastFailureAt: failureObservedAt,
      stateChangedAt: escalatedAt,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 3,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findFirst.mockResolvedValue({
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: escalatedAt,
      audit: {
        cycle: 3,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        playbookExhausted: false,
        playbookConclusion: "INCOMPLETE",
        nextStage: "RENDERED_BROWSER_DISCOVERY",
        escalationDeadlineAt: escalatedAt.toISOString(),
      },
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          nextAttemptAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseSupportIncident.updateMany.mock.calls[0]?.[0]?.data,
    ).not.toHaveProperty("lastSeenAt");
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now,
        }),
      }),
    );
    expect(
      prismaMocks.courseMonitoringStatus.updateMany.mock.calls[0]?.[0]?.data,
    ).not.toHaveProperty("lastFailureAt");
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          occurredAt: now,
          audit: expect.objectContaining({
            action: "resume_incomplete_automation_stalled_playbook",
          }),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalled();

    const delayedSuccessObservedAt = new Date(
      "2026-07-27T15:45:00.000Z",
    );
    const delayedSuccessConsumedAt = new Date(
      "2026-07-27T16:05:00.000Z",
    );
    const resumedMonitoring = {
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      lastSuccessfulAt: null,
      lastFailureAt: failureObservedAt,
      consecutiveFailures: 1,
      failureFingerprint: prooflessIncident.failureFingerprint,
      firstDegradedAt: prooflessIncident.firstSeenAt,
      nextAutomaticAttemptAt: now,
      revalidationRequestedAt: now,
      stateChangedAt: now,
      revision: 4,
    };
    prismaMocks.courseMonitoringStatus.upsert.mockResolvedValue(
      resumedMonitoring,
    );
    prismaMocks.courseMonitoringStatus.update.mockResolvedValue({
      ...resumedMonitoring,
      state: "HEALTHY",
      lastSuccessfulAt: delayedSuccessObservedAt,
      consecutiveFailures: 0,
      failureFingerprint: null,
      firstDegradedAt: null,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      stateChangedAt: delayedSuccessConsumedAt,
      revision: 5,
    });
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue({
      ...prooflessIncident,
      revision: 1,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: null,
      activeBatchId: null,
      nextAttemptAt: now,
    });

    await expect(
      recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        source: "LOCAL_READER",
        providerObservedAt: delayedSuccessObservedAt,
        now: delayedSuccessConsumedAt,
        runtimeVersion: "reader-runtime",
      }),
    ).resolves.toMatchObject({
      state: "HEALTHY",
      lastSuccessfulAt: delayedSuccessObservedAt,
      sourceEvidenceAccepted: true,
    });
    expect(
      prismaMocks.courseSupportIncident.updateMany,
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RESOLVED",
          resolvedAt: delayedSuccessConsumedAt,
          lastSeenAt: delayedSuccessObservedAt,
        }),
      }),
    );
  });

  it.each([
    ["HEALTHY", "MONITORING_RESTORED"],
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_TECHNICAL", "TECHNICAL_LIMITATION_CLASSIFIED"],
  ] as const)(
    "lets a newer %s monitoring state win over a stale due incident",
    async (state, resolution) => {
      const staleIncident = incident({
        activeRealSearchCount: 1,
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        revision: 9,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        checked: 0,
        escalated: 0,
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            revision: 0,
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution,
            resolvedAt: now,
            nextAttemptAt: null,
            nextReminderAt: null,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    },
  );

  it.each(["NO_MATCH", "MATCH_FOUND"] as const)(
    "adopts a fresh %s probe when success closeout crashed before the deadline",
    async (outcome) => {
      const lastFailureAt = new Date("2026-07-27T15:30:00.000Z");
      const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
      const staleIncident = incident({
        activeRealSearchCount: 1,
        engineeringOnly: false,
        lastSeenAt: lastFailureAt,
        escalationDeadlineAt: new Date("2026-07-27T15:58:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleIncident,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state: "AUTO_INVESTIGATING",
        revision: 7,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseProbe.findFirst.mockResolvedValue({
        outcome,
        observedAt: successObservedAt,
        runtimeVersion: "success-runtime",
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        checked: 0,
        escalated: 0,
      });

      expect(prismaMocks.courseProbe.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          courseId: "course-1",
          outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
          observedAt: { gt: lastFailureAt, lte: now },
          teeSearch: {
            status: "ACTIVE",
            trafficClass: { notIn: ["AUTOMATION", "TEST"] },
          },
        }),
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        select: {
          outcome: true,
          observedAt: true,
          runtimeVersion: true,
        },
      });
      expect(
        prismaMocks.courseMonitoringStatus.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { courseId: "course-1", revision: 7 },
          data: expect.objectContaining({
            state: "HEALTHY",
            lastSuccessfulAt: successObservedAt,
            failureFingerprint: null,
            firstDegradedAt: null,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution: "MONITORING_RESTORED",
            resolvedAt: successObservedAt,
          }),
        }),
      );
      expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
      expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: "RECOVERED",
            outcome,
          }),
        }),
      );
    },
  );

  it.each([
    ["HEALTHY", "MONITORING_RESTORED"],
    ["FINAL_TECHNICAL", "TECHNICAL_LIMITATION_CLASSIFIED"],
  ] as const)(
    "lets an authoritative %s state heal a stale needs-human row",
    async (state, resolution) => {
      const staleHuman = incident({
        status: "NEEDS_HUMAN",
        humanReviewReason: "CAPTCHA_OR_QUEUE",
        escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
        escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      });
      prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
        { courseId: "course-1" },
      ]);
      prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
        staleHuman,
      );
      prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
        state,
        revision: 4,
      });
      prismaMocks.course.findUnique.mockResolvedValue({
        bookingAccessMode: "PUBLIC_READ_ONLY",
        automationReason: null,
      });
      prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

      await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
        escalated: 0,
      });

      expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "NEEDS_HUMAN" }),
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution,
          }),
        }),
      );
    },
  );

  it("lets a fresh probe heal a stale needs-human row", async () => {
    const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
    const staleHuman = incident({
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: new Date("2026-07-27T15:30:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      lastSeenAt: new Date("2026-07-27T15:40:00.000Z"),
    });
    prismaMocks.courseSupportIncident.findMany.mockResolvedValue([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(staleHuman);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "ENGINEERING_VERIFICATION_NEEDED",
      revision: 4,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "PUBLIC_READ_ONLY",
      automationReason: null,
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue({
      outcome: "NO_MATCH",
      observedAt: successObservedAt,
      runtimeVersion: "success-runtime",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "NEEDS_HUMAN" }),
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED",
        }),
      }),
    );
  });

  it("adopts fresh success without detaching an active responder batch", async () => {
    const successObservedAt = new Date("2026-07-27T15:59:00.000Z");
    prismaMocks.courseSupportIncident.findMany.mockResolvedValueOnce([
      { courseId: "course-1" },
    ]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      incident({
        activeBatchId: "batch-1",
        activeRealSearchCount: 1,
        lastSeenAt: new Date("2026-07-27T15:30:00.000Z"),
        escalationDeadlineAt: new Date("2026-07-27T15:58:00.000Z"),
      }),
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "PUBLIC_READ_ONLY",
      automationReason: null,
    });
    prismaMocks.courseProbe.findFirst.mockResolvedValue({
      outcome: "NO_MATCH",
      observedAt: successObservedAt,
      runtimeVersion: "success-runtime",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 0,
    });

    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "HEALTHY" }),
      }),
    );
    expect(prismaMocks.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseSupportIncident.update).not.toHaveBeenCalled();
  });

  it("keeps an expired incomplete campaign playbook automatic and makes its continuation idempotent", async () => {
    const dueIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
      attemptLedger: renderedBrowserPendingLedger(),
    });
    const continuationAt = new Date("2026-07-27T16:00:00.123Z");
    const continuedIncident = {
      ...dueIncident,
      revision: 1,
      status: "AUTO_INVESTIGATING",
      humanReviewReason: null,
      escalatedAt: null,
      nextReminderAt: null,
      nextAttemptAt: continuationAt,
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(dueIncident)
      .mockResolvedValue(continuedIncident);
    prismaMocks.courseMonitoringStatus.findUnique
      .mockResolvedValueOnce({
        state: "AUTO_INVESTIGATING",
        stateChangedAt: new Date("2026-07-27T15:00:00.000Z"),
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: null,
        revision: 7,
      })
      .mockResolvedValue({
        state: "AUTO_INVESTIGATING",
        stateChangedAt: continuationAt,
        nextAutomaticAttemptAt: continuationAt,
        revalidationRequestedAt: continuationAt,
        revision: 8,
      });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        id: "deadline-continuation",
      });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);
    prismaMocks.automationRun.findMany.mockResolvedValue([{ audit: null }]);

    await expect(
      runCourseMonitoringWatchdog(continuationAt),
    ).resolves.toMatchObject({
      checked: 0,
      scheduled: 1,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          escalatedAt: null,
          nextReminderAt: null,
          nextAttemptAt: continuationAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 7 }),
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: continuationAt,
          revalidationRequestedAt: continuationAt,
          stateChangedAt: continuationAt,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          fromState: "AUTO_INVESTIGATING",
          toState: "AUTO_INVESTIGATING",
          occurredAt: continuationAt,
          audit: expect.objectContaining({
            action: "playbook_deadline_continuation",
            cycle: 1,
            attemptLedgerFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
            customerState: "RETRYING_AUTOMATICALLY",
            playbookExhausted: false,
            nextStage: "RENDERED_BROWSER_DISCOVERY",
            continuationAt: continuationAt.toISOString(),
            escalationDeadlineAt: "2026-07-27T15:30:00.000Z",
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextCheckAt: continuationAt,
          recheckRequestedAt: continuationAt,
        }),
      }),
    );

    await expect(
      runCourseMonitoringWatchdog(new Date("2026-07-27T22:00:00.123Z")),
    ).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledTimes(
      1,
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseSupportBatch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRun.findMany).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledTimes(1);
  });

  it("continues an expired legacy null ledger at the first automatic playbook stage", async () => {
    const legacyIncident = incident({
      cycle: 4,
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      attemptLedger: null,
      nextAttemptAt: null,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      legacyIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: new Date("2026-07-27T15:00:00.000Z"),
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          humanReviewReason: null,
          nextAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          occurredAt: now,
          audit: expect.objectContaining({
            action: "playbook_deadline_continuation",
            cycle: 4,
            playbookConclusion: "INCOMPLETE",
            playbookExhausted: false,
            nextStage: "OFFICIAL_IDENTITY",
            continuationAt: now.toISOString(),
          }),
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
        }),
      }),
    );
  });

  it("preserves one coherent future automatic retry when the playbook deadline has expired", async () => {
    const retryAt = new Date("2026-07-27T16:20:00.000Z");
    const dueIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      activeRealSearchCount: 1,
      engineeringOnly: false,
      attemptLedger: renderedBrowserPendingLedger(),
      nextAttemptAt: retryAt,
    });
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValue([]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(dueIncident);
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: new Date("2026-07-27T15:50:00.000Z"),
      nextAutomaticAttemptAt: retryAt,
      revalidationRequestedAt: retryAt,
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 1,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextAttemptAt: retryAt }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAutomaticAttemptAt: retryAt,
          revalidationRequestedAt: retryAt,
          stateChangedAt: now,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          occurredAt: now,
          audit: expect.objectContaining({
            action: "playbook_deadline_continuation",
            continuationAt: retryAt.toISOString(),
          }),
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextCheckAt: retryAt,
          recheckRequestedAt: retryAt,
        }),
      }),
    );
  });

  it("upgrades a strongly proven legacy stalled endpoint without rearming its schedules", async () => {
    const escalationDeadlineAt = new Date("2026-07-27T15:30:00.000Z");
    const endpointAt = new Date("2026-07-27T15:45:00.000Z");
    const scheduledAt = new Date("2026-07-27T22:00:00.000Z");
    const reminderAt = new Date("2026-07-28T16:00:00.000Z");
    const legacyIncident = incident({
      cycle: 4,
      status: "NEEDS_HUMAN",
      attemptLedger: null,
      escalationDeadlineAt,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: endpointAt,
      nextAttemptAt: scheduledAt,
      nextReminderAt: scheduledAt,
      activeRealSearchCount: 1,
      engineeringOnly: false,
    });
    const upgradedIncident = {
      ...legacyIncident,
      revision: 1,
      nextAttemptAt: null,
      nextReminderAt: endpointAt,
    };
    const visibleIncident = {
      ...upgradedIncident,
      revision: 2,
      nextReminderAt: reminderAt,
    };
    const legacyEndpointEvent = {
      id: "legacy-deadline-stalled",
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: endpointAt,
      audit: {
        cycle: 4,
        customerState: "NEEDS_HUMAN_REVIEW",
        playbookConclusion: "INCOMPLETE",
        playbookExhausted: false,
        automationStalled: true,
        nextStage: "OFFICIAL_IDENTITY",
        escalationDeadlineAt: escalationDeadlineAt.toISOString(),
        automaticRecheckHours: 6,
        customerDataIncluded: false,
      },
    };
    const parkedEndpointEvent = {
      id: "parked-deadline-stalled",
      incidentId: "incident-1",
      eventType: "HUMAN_REVIEW_REQUESTED",
      occurredAt: endpointAt,
      audit: {
        ...legacyEndpointEvent.audit,
        parkedUntilMaterialChange: true,
      },
    };

    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([upgradedIncident])
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([visibleIncident]);
    prismaMocks.courseSupportIncident.findUnique
      .mockResolvedValueOnce(legacyIncident)
      .mockResolvedValueOnce(visibleIncident);
    prismaMocks.courseMonitoringStatus.findUnique
      .mockResolvedValueOnce({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: endpointAt,
        nextAutomaticAttemptAt: scheduledAt,
        revalidationRequestedAt: null,
        revision: 8,
      })
      .mockResolvedValueOnce({
        state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: endpointAt,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 9,
      });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
    });
    let parkingMarkerCreated = false;
    prismaMocks.courseMonitoringEvent.findFirst.mockImplementation(
      ({ where }) =>
        Promise.resolve(
          where.eventType === "HUMAN_REVIEW_REQUESTED"
            ? parkingMarkerCreated
              ? parkedEndpointEvent
              : legacyEndpointEvent
            : null,
        ),
    );
    prismaMocks.courseMonitoringEvent.findUnique.mockImplementation(
      ({ where }) => {
        const key = String(where.idempotencyKey);
        return Promise.resolve(
          key.endsWith(":parked")
            ? parkingMarkerCreated
              ? parkedEndpointEvent
              : null
            : legacyEndpointEvent,
        );
      },
    );
    prismaMocks.courseMonitoringEvent.create.mockImplementation(({ data }) => {
      if (String(data.idempotencyKey).endsWith(":parked")) {
        parkingMarkerCreated = true;
      }
      return Promise.resolve({ id: "parked-deadline-stalled" });
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(
      prismaMocks.courseSupportIncident.updateMany,
    ).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 4,
          status: "NEEDS_HUMAN",
          activeBatchId: null,
        }),
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          humanReviewReason: "AUTOMATION_STALLED",
          nextAttemptAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "HUMAN_REVIEW_REQUESTED",
          idempotencyKey: expect.stringMatching(/:parked$/u),
          audit: expect.objectContaining({
            cycle: 4,
            automationStalled: true,
            parkedUntilMaterialChange: true,
          }),
        }),
      }),
    );
    expect(
      prismaMocks.courseMonitoringEvent.findUnique.mock.calls.map(
        ([call]) => call.where.idempotencyKey,
      ),
    ).toEqual([
      expect.not.stringMatching(/:parked$/u),
      expect.stringMatching(/:parked$/u),
    ]);
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(
      prismaMocks.courseMonitoringStatus.updateMany.mock.calls.some(
        ([call]) =>
          call.where?.courseId === "course-1" &&
          call.data?.nextAutomaticAttemptAt instanceof Date,
      ),
    ).toBe(false);

    const incidentWriteCount =
      prismaMocks.courseSupportIncident.updateMany.mock.calls.length;
    const statusWriteCount =
      prismaMocks.courseMonitoringStatus.updateMany.mock.calls.length;
    const eventWriteCount =
      prismaMocks.courseMonitoringEvent.create.mock.calls.length;

    await expect(
      runCourseMonitoringWatchdog(new Date("2026-07-27T16:01:00.000Z")),
    ).resolves.toMatchObject({
      scheduled: 0,
      escalated: 0,
    });

    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledTimes(
      incidentWriteCount,
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledTimes(
      statusWriteCount,
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(
      eventWriteCount,
    );
    expect(
      prismaMocks.courseMonitoringEvent.findUnique.mock.calls.map(
        ([call]) => call.where.idempotencyKey,
      ),
    ).toEqual([
      expect.not.stringMatching(/:parked$/u),
      expect.stringMatching(/:parked$/u),
    ]);
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("uses the course limitation reason only when current-cycle playbook exhaustion is proven", async () => {
    const provenIncident = incident({
      confirmedAt: new Date("2026-07-27T15:00:00.000Z"),
      escalationDeadlineAt: new Date("2026-07-27T15:30:00.000Z"),
      failureClass: "CHALLENGE",
      attemptLedger: exhaustedLedger(),
    });
    const humanIncident = {
      ...provenIncident,
      revision: 1,
      status: "NEEDS_HUMAN",
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      escalatedAt: now,
      nextReminderAt: now,
      nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
    };
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([{ courseId: "course-1" }])
      .mockResolvedValueOnce([humanIncident]);
    prismaMocks.courseSupportIncident.findUnique.mockResolvedValue(
      provenIncident,
    );
    prismaMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      revision: 7,
    });
    prismaMocks.course.findUnique.mockResolvedValue({
      bookingAccessMode: "CAPTCHA_OR_QUEUE",
      automationReason: "CAPTCHA_OR_QUEUE",
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T15:00:00.000Z"),
        failureFingerprint: "SOURCE_MISSING:CHALLENGE",
        nextAutomaticAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
        revision: 8,
        course: course(humanIncident),
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      escalated: 1,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          humanReviewReason: "CAPTCHA_OR_QUEUE",
        }),
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          audit: expect.objectContaining({
            playbookConclusion: "UNRESOLVED_EXHAUSTED",
            playbookExhausted: true,
          }),
        }),
      }),
    );
  });

  it("keeps due six-hour human review parked without repeating the playbook", async () => {
    const humanIncident = incident({
      status: "NEEDS_HUMAN",
      attemptLedger: exhaustedLedger(),
      confirmedAt: new Date("2026-07-27T10:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      activeRealSearchCount: 1,
      nextReminderAt: now,
      nextAttemptAt: now,
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
        firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        nextAutomaticAttemptAt: now,
        revision: 3,
        course: course(humanIncident),
      },
    ]);
    prismaMocks.courseSupportIncident.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([humanIncident]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
      remindersSent: 0,
    });
    expect(prismaMocks.courseSupportIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          cycle: 1,
          status: "NEEDS_HUMAN",
        }),
        data: {
          nextAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
          nextReminderAt: new Date("2026-07-28T16:00:00.000Z"),
          revision: { increment: 1 },
        },
      }),
    );
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        state: "ENGINEERING_VERIFICATION_NEEDED",
      },
      data: {
        nextAutomaticAttemptAt: new Date("2026-07-27T22:00:00.000Z"),
        revalidationRequestedAt: null,
        revision: { increment: 1 },
      },
    });
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("recovers a missed new-demand revalidation for a human-approved final", async () => {
    const activeDate = new Date("2026-08-02T00:00:00.000Z");
    const humanFinalIncident = incident({
      status: "RESOLVED",
      resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
      resolvedAt: new Date("2026-07-26T16:00:00.000Z"),
      humanReviewReason: "CAPTCHA_OR_QUEUE",
      activeRealSearchCount: 0,
      earliestTargetDate: null,
    });
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "FINAL_TECHNICAL",
        stateChangedAt: new Date("2026-07-26T16:00:00.000Z"),
        firstDegradedAt: new Date("2026-07-26T10:00:00.000Z"),
        failureFingerprint: "CPS:CHALLENGE",
        revalidationRequestedAt: null,
        nextAutomaticAttemptAt: null,
        revision: 4,
        course: {
          ...course(humanFinalIncident),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: new Date("2026-07-27T15:00:00.000Z"),
              },
            },
          ],
        },
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 1,
    });
    expect(prismaMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "REVALIDATING_FINAL",
          revalidationRequestedAt: now,
          nextAutomaticAttemptAt: now,
        }),
      }),
    );
    expect(prismaMocks.teeSearch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          nextCheckAt: now,
          recheckRequestedAt: now,
        },
      }),
    );
    expect(prismaMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "REVALIDATION_REQUESTED",
          source: "RECOVERY_CRON",
        }),
      }),
    );
  });

  it("does not reopen a human-approved final for demand that already existed", async () => {
    const activeDate = new Date("2026-08-02T00:00:00.000Z");
    prismaMocks.courseMonitoringStatus.findMany.mockResolvedValue([
      {
        courseId: "course-1",
        state: "FINAL_TECHNICAL",
        stateChangedAt: new Date("2026-07-27T15:30:00.000Z"),
        firstDegradedAt: null,
        failureFingerprint: null,
        revalidationRequestedAt: null,
        nextAutomaticAttemptAt: null,
        revision: 5,
        course: {
          ...course(
            incident({
              status: "RESOLVED",
              resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
              activeRealSearchCount: 1,
            }),
          ),
          preferences: [
            {
              teeSearch: {
                date: activeDate,
                createdAt: new Date("2026-07-27T14:00:00.000Z"),
              },
            },
          ],
        },
      },
    ]);

    await expect(runCourseMonitoringWatchdog(now)).resolves.toMatchObject({
      checked: 1,
      scheduled: 0,
    });
    expect(
      prismaMocks.courseMonitoringStatus.updateMany,
    ).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearch.updateMany).not.toHaveBeenCalled();
  });
});
