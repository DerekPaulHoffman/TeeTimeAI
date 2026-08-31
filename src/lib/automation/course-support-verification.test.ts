import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  batchFindUnique: vi.fn(),
  requestFindUnique: vi.fn(),
  requestFindMany: vi.fn(),
  requestCreateMany: vi.fn(),
  requestUpdateMany: vi.fn(),
  incidentUpdateMany: vi.fn(),
  batchIncidentUpdateMany: vi.fn(),
  sourceBatchIncidentFindMany: vi.fn(),
  monitoringStatusFindUnique: vi.fn(),
  monitoringStatusUpdateMany: vi.fn(),
  probeFindMany: vi.fn(),
  activeSearchCount: vi.fn(),
  rootRequestFindMany: vi.fn(),
  rootRequestUpdateMany: vi.fn(),
}));

const transactionClient = {
  courseSupportBatch: { findUnique: prismaMocks.batchFindUnique },
  courseSupportVerificationRequest: {
    findUnique: prismaMocks.requestFindUnique,
    findMany: prismaMocks.requestFindMany,
    createMany: prismaMocks.requestCreateMany,
    updateMany: prismaMocks.requestUpdateMany,
  },
  courseSupportIncident: { updateMany: prismaMocks.incidentUpdateMany },
  courseSupportBatchIncident: {
    findMany: prismaMocks.sourceBatchIncidentFindMany,
    updateMany: prismaMocks.batchIncidentUpdateMany,
  },
  courseMonitoringStatus: {
    findUnique: prismaMocks.monitoringStatusFindUnique,
    updateMany: prismaMocks.monitoringStatusUpdateMany,
  },
  courseProbe: { findMany: prismaMocks.probeFindMany },
  teeSearch: { count: prismaMocks.activeSearchCount },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: prismaMocks.transaction,
    courseSupportVerificationRequest: {
      findMany: prismaMocks.rootRequestFindMany,
      updateMany: prismaMocks.rootRequestUpdateMany,
    },
  },
}));

import {
  completeCourseSupportVerificationFactualFinal,
  attachCourseSupportVerificationProviderSnapshot,
  attachCourseSupportVerificationWorkflow,
  buildCourseSupportProviderSnapshotFingerprint,
  buildCourseSupportVerificationIntent,
  claimCourseSupportVerificationRequest,
  completeCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  getCourseSupportVerificationRequestDeadline,
  getCurrentCourseSupportVerificationFailure,
  getEligibleCourseSupportVerificationProof,
  heartbeatCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests,
  markCourseSupportVerificationDiscoveryAttempted,
  markCourseSupportVerificationDiscoveryVerified,
  resolveCourseSupportProviderRetryNotBeforeAt,
  resolveCourseSupportVerificationRetryAt,
  scheduleCourseSupportVerificationRequests,
} from "./course-support-verification";
import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import {
  createDeferredFailureHandoffAdmission,
  createDeferredFailureHandoffBatchIncidentDigest,
  createDeferredFailureHandoffSignal,
  createDeferredFailureHandoffSourceProofDigest,
  parseDeferredFailureHandoffSignal,
} from "./course-support-deferred-failure-handoff";

const releaseSha = "a".repeat(40);
const newerReleaseSha = "b".repeat(40);
const priorReleaseSha = "c".repeat(40);
const now = new Date("2026-07-21T12:00:00.000Z");
const canonicalFailureFingerprint = "1".repeat(64);
const observedFailureFingerprint = "2".repeat(64);

function currentIntelligence() {
  return {
    intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
    intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
    intelligenceConfidence: 0.95,
  };
}

function course(overrides: Record<string, unknown> = {}) {
  return {
    id: "course-1",
    timeZone: "America/New_York",
    website: "https://course.example/",
    detectedBookingUrl:
      "https://book.example/tee-times?token=never-persist-this",
    detectedPlatform: "CUSTOM",
    providerFamilyKey: "CPS",
    bookingMethod: "PUBLIC_ONLINE",
    bookingWindowDaysAhead: 7,
    bookingReleaseTimeLocal: "07:00",
    bookingWindowSource: "PROVIDER_CONFIG",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    monitoringMode: "AUTOMATIC",
    isPublic: true,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    bookingMetadata: {
      provider: "CPS",
      facilityId: "opaque-provider-value",
      nested: { second: 2, first: 1 },
    },
    ...overrides,
  };
}

function fingerprint(courseValue = course()) {
  return buildCourseSupportProviderSnapshotFingerprint(
    courseValue as Parameters<
      typeof buildCourseSupportProviderSnapshotFingerprint
    >[0],
  );
}

function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident-1",
    cycle: 1,
    providerFamilyKey: "CPS",
    failureFingerprint: canonicalFailureFingerprint,
    activeBatchId: "batch-1",
    engineeringOnly: true,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    escalationDeadlineAt: null,
    firstSeenAt: new Date("2026-07-21T11:00:00.000Z"),
    attemptLedger: null,
    revision: 3,
    updatedAt: new Date("2026-07-21T11:55:00.000Z"),
    status: "AUTO_INVESTIGATING",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  const providerCourse = course();
  return {
    id: "request-1",
    batchIncidentId: "batch-incident-1",
    courseId: "course-1",
    releaseSha,
    runtimeVersion: releaseSha,
    status: "CHECKING",
    revision: 1,
    leaseToken: "lease-1",
    leaseExpiresAt: new Date("2026-07-21T12:10:00.000Z"),
    nextAttemptAt: null,
    targetDateLocal: "2026-07-21",
    startTimeLocal: "06:00",
    endTimeLocal: "20:00",
    timeZone: "America/New_York",
    players: 1,
    providerSnapshotFingerprint: fingerprint(providerCourse),
    discoveryAttemptedAt: new Date("2026-07-21T11:57:00.000Z"),
    discoveryVerifiedAt: new Date("2026-07-21T11:58:00.000Z"),
    startedAt: new Date("2026-07-21T11:59:00.000Z"),
    createdAt: new Date("2026-07-21T11:00:00.000Z"),
    updatedAt: new Date("2026-07-21T11:59:00.000Z"),
    lastError: null,
    batchIncident: {
      id: "batch-incident-1",
      batchId: "batch-1",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 1,
      result: "PENDING",
      proofSnapshot: null,
      verifiedAt: null,
      updatedAt: new Date("2026-07-21T11:55:00.000Z"),
      verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
      batch: {
        id: "batch-1",
        status: "VERIFYING",
        providerFamilyKey: "CPS",
        failureFingerprint: canonicalFailureFingerprint,
        baseSha: releaseSha,
        releaseSha,
        summary: null,
        createdAt: new Date("2026-07-21T11:50:00.000Z"),
        completedAt: null,
      },
      incident: incident(),
    },
    course: providerCourse,
    ...overrides,
  };
}

function browserAdapterRetryReadyLedger(attempted = false) {
  let ledger: unknown = null;
  const completedStages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "COMPLETED", null],
    [
      "TYPED_ADAPTER",
      "TYPED_PROVIDER_ADAPTER",
      "NOT_APPLICABLE",
      "NO_RUNNABLE_ADAPTER",
    ],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "COMPLETED", null],
    [
      "HTTP_ADAPTER_RETRY",
      "TYPED_PROVIDER_ADAPTER",
      "NOT_APPLICABLE",
      "NO_METADATA_CHANGE",
    ],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "COMPLETED", null],
  ] as const;
  for (const [stage, readPath, transition, skipReason] of completedStages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      transition,
      readPath,
      evidenceKind:
        readPath === "RENDERED_BROWSER" ? "RENDERED_PAGE" : "TOOLING",
      failureFingerprint: `TEST:${stage}:${transition}`,
      runtimeVersion: releaseSha,
      ...(skipReason ? { skipReason } : {}),
      observedAt: now,
    });
  }
  if (!attempted) return ledger;
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "BROWSER_ADAPTER_RETRY",
    transition: "STARTED",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "TOOLING",
    failureFingerprint: "TEST:BROWSER_ADAPTER_RETRY:NETWORK",
    runtimeVersion: releaseSha,
    observedAt: now,
  });
  return appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "BROWSER_ADAPTER_RETRY",
    transition: "FAILED_RETRYABLE",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "TOOLING",
    failureClass: "NETWORK",
    failureFingerprint: "TEST:BROWSER_ADAPTER_RETRY:NETWORK",
    runtimeVersion: releaseSha,
    observedAt: now,
  });
}

function browserAdapterRetryHandoffRequest(input: {
  claimedStage: "RENDERED_BROWSER_DISCOVERY" | "BROWSER_ADAPTER_RETRY";
  runnableProvider: boolean;
  discoveryRepair?: boolean;
}) {
  const providerCourse = input.runnableProvider
    ? course({
        detectedBookingUrl: "https://public-course.cps.golf/",
        bookingMetadata: {
          provider: "CPS",
          siteName: "public-course",
          bookingBaseUrl: "https://public-course.cps.golf/",
          courseIds: [1],
        },
      })
    : course({
        detectedBookingUrl: null,
        detectedPlatform: null,
        providerFamilyKey: "SOURCE_MISSING",
        bookingMetadata: null,
      });
  const baseRequest = request();
  const ownsBrowserAdapterRetry =
    input.claimedStage === "BROWSER_ADAPTER_RETRY";
  const ownsDiscoveryRepair =
    ownsBrowserAdapterRetry && input.discoveryRepair === true;
  return request({
    runtimeVersion: null,
    status: "QUEUED",
    revision: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    nextAttemptAt: now,
    deadlineAt: new Date("2026-07-21T12:35:00.000Z"),
    discoveryAttemptedAt: null,
    discoveryVerifiedAt: null,
    startedAt: null,
    providerSnapshotFingerprint: fingerprint(providerCourse),
    course: providerCourse,
    batchIncident: {
      ...baseRequest.batchIncident,
      batch: {
        ...baseRequest.batchIncident.batch,
        summary: {
          remediation: {
            workMode: ownsBrowserAdapterRetry
              ? ownsDiscoveryRepair
                ? "ADVANCE_DISCOVERY"
                : "VERIFY_TRANSIENT"
              : "ADVANCE_DISCOVERY",
            strategyAction: ownsBrowserAdapterRetry
              ? ownsDiscoveryRepair
                ? "REPAIR_PROVIDER_ADAPTER"
                : "RUN_TYPED_ADAPTER"
              : "DISCOVER_WITH_BROWSER",
            playbookStage: input.claimedStage,
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            reason: ownsBrowserAdapterRetry
              ? ownsDiscoveryRepair
                ? "PLAYBOOK_STAGE_PENDING"
                : "EXISTING_SUPPORT_READY"
              : "PLAYBOOK_STAGE_PENDING",
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: 3,
              attemptsRemaining: 1,
              exhausted: false,
            },
          },
        },
      },
      incident: incident({ attemptLedger: browserAdapterRetryReadyLedger() }),
    },
  });
}

function localReaderReadyLedger(
  attempted = false,
  runtimeVersion = releaseSha,
  attemptedAt = now,
  startedEvidenceKind: "TOOLING" | "LOCAL_READER_RESULT" = "TOOLING",
) {
  const ledger = appendAutomationPlaybookEvent(
    browserAdapterRetryReadyLedger(),
    {
      cycle: 1,
      stage: "BROWSER_ADAPTER_RETRY",
      transition: "NOT_APPLICABLE",
      readPath: "TYPED_PROVIDER_ADAPTER",
      evidenceKind: "TOOLING",
      failureFingerprint: "TEST:BROWSER_ADAPTER_RETRY:SKIPPED",
      runtimeVersion: releaseSha,
      skipReason: "NO_RUNNABLE_ADAPTER",
      observedAt: now,
    },
  );
  if (!attempted) return ledger;
  return appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "LOCAL_READER",
    transition: "STARTED",
    readPath: "LOCAL_READER",
    evidenceKind: startedEvidenceKind,
    failureFingerprint: "TEST:LOCAL_READER:STARTED",
    runtimeVersion,
    observedAt: attemptedAt,
  });
}

function localReaderFailedRetryableLedger(
  attemptCount = 1,
  resultRuntimeVersion = releaseSha,
) {
  let ledger: unknown = localReaderReadyLedger();
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const observedAt = now;
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage: "LOCAL_READER",
      transition: "STARTED",
      readPath: "LOCAL_READER",
      evidenceKind: "TOOLING",
      failureFingerprint: "TEST:LOCAL_READER:NETWORK",
      runtimeVersion: releaseSha,
      observedAt,
    });
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage: "LOCAL_READER",
      transition: "FAILED_RETRYABLE",
      readPath: "LOCAL_READER",
      evidenceKind: "TOOLING",
      failureClass: "NETWORK",
      failureFingerprint: "TEST:LOCAL_READER:NETWORK",
      runtimeVersion: resultRuntimeVersion,
      observedAt,
    });
  }
  return ledger;
}

function localReaderSucceededLedger(
  options: {
    evidenceKind?: "LOCAL_READER_RESULT" | "TOOLING";
    runtimeVersion?: string;
  } = {},
) {
  return appendAutomationPlaybookEvent(localReaderReadyLedger(), {
    cycle: 1,
    stage: "LOCAL_READER",
    transition: "SUCCEEDED",
    readPath: "LOCAL_READER",
    evidenceKind: options.evidenceKind ?? "LOCAL_READER_RESULT",
    failureFingerprint: "TEST:LOCAL_READER:SUCCEEDED",
    runtimeVersion: options.runtimeVersion ?? "cps-rendered-v1",
    observedAt: now,
  });
}

function localReaderIndependentHandoffLedger(
  transition: "NOT_APPLICABLE" | "FAILED_TERMINAL" | "TECHNICAL_LIMITATION",
  options: {
    localRuntimeVersion?: string;
    successorRuntimeVersion?: string;
  } = {},
) {
  const ledger: unknown = appendAutomationPlaybookEvent(
    localReaderReadyLedger(),
    {
      cycle: 1,
      stage: "LOCAL_READER",
      transition,
      readPath: "LOCAL_READER",
      evidenceKind:
        transition === "NOT_APPLICABLE" ? "TOOLING" : "LOCAL_READER_RESULT",
      failureFingerprint: `TEST:LOCAL_READER:${transition}`,
      runtimeVersion:
        options.localRuntimeVersion ??
        (transition === "NOT_APPLICABLE" ? releaseSha : "reader-v1"),
      ...(transition === "NOT_APPLICABLE"
        ? { skipReason: "NO_LOCAL_READER_CAPABILITY" as const }
        : transition === "FAILED_TERMINAL"
          ? { failureClass: "UNKNOWN" as const }
          : { technicalReason: "CAPTCHA_OR_QUEUE" as const }),
      observedAt: now,
    },
  );
  return appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "STARTED",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: "TEST:INDEPENDENT_CONFIRMATION:STARTED",
    runtimeVersion: options.successorRuntimeVersion ?? releaseSha,
    observedAt: now,
  });
}

function assignedLocalReaderRequest(
  input: {
    attemptLedger?: unknown;
    requestOverrides?: Record<string, unknown>;
    courseOverrides?: Record<string, unknown>;
    remediationOverrides?: Record<string, unknown>;
  } = {},
) {
  const providerCourse = course({
    detectedPlatform: null,
    providerFamilyKey: "SOURCE_MISSING",
    bookingMetadata: null,
    automationEligibility: "BLOCKED",
    automationReason: "ACCOUNT_REQUIRED",
    ...currentIntelligence(),
    ...input.courseOverrides,
  });
  const baseRequest = request();
  return request({
    createdAt: new Date("2026-07-21T11:51:00.000Z"),
    startedAt: new Date("2026-07-21T11:57:00.000Z"),
    updatedAt: new Date("2026-07-21T11:59:00.000Z"),
    completedAt: null,
    deadlineAt: new Date("2026-07-21T12:35:00.000Z"),
    providerSnapshotFingerprint: fingerprint(providerCourse),
    course: providerCourse,
    batchIncident: {
      ...baseRequest.batchIncident,
      batch: {
        ...baseRequest.batchIncident.batch,
        summary: {
          remediation: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            playbookStage: "LOCAL_READER",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            reason: "PLAYBOOK_STAGE_PENDING",
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: 1,
              attemptsRemaining: 3,
              exhausted: false,
            },
            ...input.remediationOverrides,
          },
        },
      },
      incident: incident({
        attemptLedger: input.attemptLedger ?? localReaderReadyLedger(true),
      }),
    },
    ...input.requestOverrides,
  });
}

function verificationEvidence(outcome = "NO_MATCH", providerExecution = true) {
  return {
    schemaVersion: 1,
    kind: "PROVIDER_VERIFICATION",
    providerExecution,
    releaseSha,
    runtimeVersion: releaseSha,
    observedAt: now.toISOString(),
    outcome,
    providerSnapshotFingerprint: fingerprint(),
  };
}

function independentFactualFinalLedger(
  disposition: "MANUAL_DIRECT" | "IDENTITY_FINAL",
) {
  let ledger: unknown = null;
  const terminalStages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "COMPLETED", "OFFICIAL_SOURCE"],
    [
      "TYPED_ADAPTER",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    [
      "OFFICIAL_HTTP_DISCOVERY",
      "OFFICIAL_HTTP",
      "COMPLETED",
      "OFFICIAL_SOURCE",
    ],
    [
      "HTTP_ADAPTER_RETRY",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    [
      "RENDERED_BROWSER_DISCOVERY",
      "RENDERED_BROWSER",
      "COMPLETED",
      "RENDERED_PAGE",
    ],
    [
      "BROWSER_ADAPTER_RETRY",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    ["LOCAL_READER", "LOCAL_READER", "NOT_APPLICABLE", "TOOLING"],
  ] as const;
  for (const [stage, readPath, transition, evidenceKind] of terminalStages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      readPath,
      transition,
      evidenceKind,
      failureFingerprint: `PLAYBOOK:${stage}:${transition}`,
      runtimeVersion: releaseSha,
      observedAt: new Date("2026-07-21T11:58:00.000Z"),
      ...(transition === "FAILED_TERMINAL"
        ? { failureClass: "CHALLENGE" as const }
        : {}),
      ...(transition === "NOT_APPLICABLE"
        ? { skipReason: "NO_LOCAL_READER_CAPABILITY" as const }
        : {}),
    });
  }
  return appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "INDEPENDENT_CONFIRMATION",
    readPath: "INDEPENDENT_CONFIRMATION",
    transition: "FACTUAL_FINAL",
    evidenceKind: "RENDERED_PAGE",
    factualDisposition: disposition,
    failureFingerprint: `PLAYBOOK:INDEPENDENT_CONFIRMATION:${disposition}`,
    runtimeVersion: releaseSha,
    observedAt: new Date("2026-07-21T11:59:00.000Z"),
  });
}

function unresolvedExhaustedLedger() {
  let ledger: unknown = null;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "COMPLETED", "OFFICIAL_SOURCE"],
    [
      "TYPED_ADAPTER",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    [
      "OFFICIAL_HTTP_DISCOVERY",
      "OFFICIAL_HTTP",
      "COMPLETED",
      "OFFICIAL_SOURCE",
    ],
    [
      "HTTP_ADAPTER_RETRY",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    [
      "RENDERED_BROWSER_DISCOVERY",
      "RENDERED_BROWSER",
      "COMPLETED",
      "RENDERED_PAGE",
    ],
    [
      "BROWSER_ADAPTER_RETRY",
      "TYPED_PROVIDER_ADAPTER",
      "FAILED_TERMINAL",
      "PROVIDER_RESPONSE",
    ],
    ["LOCAL_READER", "LOCAL_READER", "NOT_APPLICABLE", "TOOLING"],
    [
      "INDEPENDENT_CONFIRMATION",
      "INDEPENDENT_CONFIRMATION",
      "NOT_APPLICABLE",
      "TOOLING",
    ],
  ] as const;
  for (const [stage, readPath, transition, evidenceKind] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      readPath,
      transition,
      evidenceKind,
      failureFingerprint: `PLAYBOOK:${stage}:${transition}`,
      runtimeVersion: releaseSha,
      observedAt: new Date("2026-07-21T11:48:00.000Z"),
      ...(transition === "FAILED_TERMINAL"
        ? { failureClass: "CHALLENGE" as const }
        : {}),
      ...(stage === "LOCAL_READER"
        ? { skipReason: "NO_LOCAL_READER_CAPABILITY" as const }
        : stage === "INDEPENDENT_CONFIRMATION"
          ? { skipReason: "NO_INDEPENDENT_CONFIRMATION" as const }
          : {}),
    });
  }
  return ledger;
}

function deferredConfirmationRequest(
  overrides: {
    signalState?: "AVAILABLE" | "CONSUMED";
    startedAt?: Date | null;
  } = {},
) {
  const providerCourse = course();
  const providerSnapshotFingerprint = fingerprint(providerCourse);
  const sourceBatchIncidentId = "source-batch-incident-1";
  const sourceProof = {
    kind: "PROVIDER_VERIFICATION_FAILURE",
    status: "RETRYABLE_FAILED",
    outcome: "FETCH_FAILED",
    failureClass: "NETWORK",
    observedAt: "2026-07-21T11:56:00.000Z",
    runtimeVersion: "c".repeat(40),
    providerExecution: false,
    providerSnapshotFingerprint,
    completedAt: null,
    nextAttemptAt: "2026-07-21T11:58:00.000Z",
    providerRetryNotBeforeAt: "2026-07-21T11:58:00.000Z",
  };
  const signal = createDeferredFailureHandoffSignal({
    state: overrides.signalState ?? "AVAILABLE",
    sourceBatchIncidentDigest: createDeferredFailureHandoffBatchIncidentDigest(
      sourceBatchIncidentId,
    ),
    sourceProofDigest:
      createDeferredFailureHandoffSourceProofDigest(sourceProof),
    providerFamilyKey: "CPS",
    canonicalFailureFingerprint,
    observedFailureFingerprint,
    claimedProviderSnapshotFingerprint: providerSnapshotFingerprint,
    observedProviderSnapshotFingerprint: providerSnapshotFingerprint,
    runtimeVersion: "c".repeat(40),
    cooldownExpiresAt: "2026-07-21T11:57:00.000Z",
    providerNotBeforeAt: "2026-07-21T11:58:00.000Z",
    eligibleAt: "2026-07-21T11:58:00.000Z",
    sourceVerificationWatchMode: "WATCH_SETTLED",
    sourceResult: "RETRY_SCHEDULED",
    sourceAttemptConsumed: true,
    confirmationStarted: overrides.signalState === "CONSUMED",
  });
  const admission = createDeferredFailureHandoffAdmission({
    signal,
    admittedAt: new Date("2026-07-21T11:59:00.000Z"),
  });
  const courseRef = createHash("sha256")
    .update("course-1")
    .digest("hex")
    .slice(0, 24);
  const currentIncident = incident({
    attemptLedger: unresolvedExhaustedLedger(),
  });
  return request({
    startedAt: overrides.startedAt ?? null,
    discoveryAttemptedAt: null,
    discoveryVerifiedAt: null,
    course: providerCourse,
    batchIncident: {
      id: "batch-incident-1",
      batchId: "batch-1",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 1,
      result: "PENDING",
      proofSnapshot: null,
      verifiedAt: null,
      updatedAt: new Date("2026-07-21T11:59:00.000Z"),
      verifiedIncidentUpdatedAt: currentIncident.updatedAt,
      batch: {
        id: "batch-1",
        status: "VERIFYING",
        providerFamilyKey: "CPS",
        failureFingerprint: canonicalFailureFingerprint,
        baseSha: releaseSha,
        releaseSha,
        createdAt: new Date("2026-07-21T11:58:30.000Z"),
        completedAt: null,
        summary: {
          plannedPaths: [],
          remediation: {
            workMode: "VERIFY_TRANSIENT",
            strategyAction: "RETRY_PROVIDER",
            playbookStage: null,
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            retryBudget: null,
            reason: "MATERIAL_CHANGE_REOPENED",
            attempts: [
              {
                courseRef,
                providerSnapshotFingerprint,
                failureFingerprint: canonicalFailureFingerprint,
                runtimeVersion: releaseSha,
                activeRealSearchCount: 0,
                playbookEventCountAtClaim: 8,
                deferredFailureHandoffSource: signal,
                deferredFailureHandoffAdmission: admission,
                approach: {
                  workMode: "VERIFY_TRANSIENT",
                  strategyAction: "RETRY_PROVIDER",
                  playbookStage: null,
                },
              },
            ],
          },
        },
      },
      incident: currentIncident,
    },
  });
}

function deferredConfirmationSourceRows(
  ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
) {
  const summary = ownedRequest.batchIncident.batch.summary as {
    remediation: { attempts: Array<Record<string, unknown>> };
  };
  const plannedAttempt = summary.remediation.attempts[0];
  const signal = parseDeferredFailureHandoffSignal(
    plannedAttempt.deferredFailureHandoffSource,
  )!;
  const observedAt = "2026-07-21T11:56:00.000Z";
  const nextAttemptAt = "2026-07-21T11:58:00.000Z";
  const evidence = {
    schemaVersion: 1,
    kind: "PROVIDER_VERIFICATION",
    status: "RETRYABLE_FAILED",
    releaseSha: signal.runtimeVersion,
    runtimeVersion: signal.runtimeVersion,
    observedAt,
    outcome: "FETCH_FAILED",
    failureClass: "NETWORK",
    providerExecution: false,
    providerFamilyKey: "CPS",
    providerSnapshotFingerprint: signal.claimedProviderSnapshotFingerprint,
    providerRetryNotBeforeAt: signal.providerNotBeforeAt,
  };
  return [
    {
      id: "source-batch-incident-1",
      batchId: "source-batch-1",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 1,
      result: "RETRY_SCHEDULED",
      proofSnapshot: {
        kind: "PROVIDER_VERIFICATION_FAILURE",
        status: "RETRYABLE_FAILED",
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        observedAt,
        runtimeVersion: signal.runtimeVersion,
        providerExecution: false,
        providerSnapshotFingerprint: signal.claimedProviderSnapshotFingerprint,
        completedAt: null,
        nextAttemptAt,
        providerRetryNotBeforeAt: signal.providerNotBeforeAt,
      },
      createdAt: new Date("2026-07-21T11:50:00.000Z"),
      updatedAt: new Date("2026-07-21T11:57:30.000Z"),
      verificationRequests: [
        {
          id: "source-request-1",
          batchIncidentId: "source-batch-incident-1",
          releaseSha: signal.runtimeVersion,
          runtimeVersion: signal.runtimeVersion,
          status: "RETRYABLE_FAILED",
          attemptCount: 1,
          startedAt: new Date("2026-07-21T11:55:00.000Z"),
          discoveryAttemptedAt: new Date("2026-07-21T11:55:00.000Z"),
          discoveryVerifiedAt: new Date("2026-07-21T11:55:30.000Z"),
          outcome: "FETCH_FAILED",
          failureClass: "NETWORK",
          evidence,
          providerSnapshotFingerprint:
            signal.claimedProviderSnapshotFingerprint,
          nextAttemptAt: new Date(nextAttemptAt),
          completedAt: null,
          createdAt: new Date("2026-07-21T11:54:00.000Z"),
          updatedAt: new Date("2026-07-21T11:57:00.000Z"),
        },
      ],
      batch: {
        id: "source-batch-1",
        status: "RETRYABLE_FAILED",
        providerFamilyKey: "CPS",
        failureFingerprint: canonicalFailureFingerprint,
        baseSha: signal.runtimeVersion,
        releaseSha: signal.runtimeVersion,
        summary: {
          closeout: {
            remediationAttempts: [
              {
                courseRef: plannedAttempt.courseRef,
                deferredFailureHandoff: signal,
              },
            ],
          },
        },
        createdAt: new Date("2026-07-21T11:49:00.000Z"),
        completedAt: new Date("2026-07-21T11:58:00.000Z"),
      },
    },
  ];
}

function deferredConfirmationCarrierSourceRows(
  ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
) {
  const summary = ownedRequest.batchIncident.batch.summary as {
    remediation: { attempts: Array<Record<string, unknown>> };
  };
  const plannedAttempt = summary.remediation.attempts[0];
  const signal = parseDeferredFailureHandoffSignal(
    plannedAttempt.deferredFailureHandoffSource,
  )!;
  const carrierCreatedAt = new Date("2026-07-21T11:57:30.000Z");
  const carrierAdmission = createDeferredFailureHandoffAdmission({
    signal,
    admittedAt: new Date("2026-07-21T11:57:40.000Z"),
  });
  return [
    {
      id: "source-batch-incident-1",
      batchId: "source-carrier-batch-1",
      incidentId: "incident-1",
      courseId: "course-1",
      cycle: 1,
      result: "RETRY_SCHEDULED",
      proofSnapshot: null,
      createdAt: carrierCreatedAt,
      updatedAt: new Date("2026-07-21T11:57:55.000Z"),
      verificationRequests: [],
      batch: {
        id: "source-carrier-batch-1",
        status: "RETRYABLE_FAILED",
        providerFamilyKey: "CPS",
        failureFingerprint: canonicalFailureFingerprint,
        baseSha: newerReleaseSha,
        releaseSha: newerReleaseSha,
        summary: {
          closeout: {
            remediationAttempts: [
              {
                courseRef: plannedAttempt.courseRef,
                providerSnapshotFingerprint:
                  signal.claimedProviderSnapshotFingerprint,
                failureFingerprint: canonicalFailureFingerprint,
                runtimeVersion: newerReleaseSha,
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
                deferredFailureHandoff: signal,
                deferredFailureHandoffAdmission: carrierAdmission,
              },
            ],
          },
        },
        createdAt: carrierCreatedAt,
        completedAt: new Date("2026-07-21T11:58:00.000Z"),
      },
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.transaction.mockImplementation(
    async (worker: (client: typeof transactionClient) => Promise<unknown>) =>
      worker(transactionClient),
  );
  prismaMocks.activeSearchCount.mockResolvedValue(0);
  prismaMocks.requestUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.batchIncidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue([]);
  prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
    state: "AUTO_INVESTIGATING",
    failureFingerprint: canonicalFailureFingerprint,
    stateChangedAt: new Date("2026-07-21T11:45:00.000Z"),
    lastSuccessfulAt: null,
    revision: 3,
    updatedAt: new Date("2026-07-21T11:55:00.000Z"),
  });
  prismaMocks.monitoringStatusUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.probeFindMany.mockResolvedValue([]);
  prismaMocks.rootRequestUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.requestCreateMany.mockResolvedValue({ count: 1 });
  prismaMocks.requestFindMany.mockResolvedValue([]);
});

describe("course-support verification intent and fingerprint", () => {
  it("generates a bounded one-player intent on the course-local current day", () => {
    expect(
      buildCourseSupportVerificationIntent(
        "America/Los_Angeles",
        new Date("2026-07-21T02:00:00.000Z"),
      ),
    ).toEqual({
      targetDateLocal: "2026-07-20",
      startTimeLocal: "06:00",
      endTimeLocal: "20:00",
      timeZone: "America/Los_Angeles",
      players: 1,
    });
  });

  it("uses a stable full digest and changes it when provider execution inputs change", () => {
    const left = fingerprint();
    const reordered = fingerprint(
      course({
        bookingMetadata: {
          nested: { first: 1, second: 2 },
          facilityId: "opaque-provider-value",
          provider: "CPS",
        },
      }),
    );
    const changed = fingerprint(
      course({ bookingMetadata: { provider: "CPS", facilityId: "changed" } }),
    );
    const accessChanged = fingerprint(course({ isPublic: false }));
    const timeZoneChanged = fingerprint(
      course({ timeZone: "America/Chicago" }),
    );
    const bookingWindowChanged = fingerprint(
      course({
        bookingWindowDaysAhead: 14,
        bookingWindowConfidence: 0.9,
      }),
    );
    const accessModeChanged = fingerprint(
      course({ bookingAccessMode: "CAPTCHA_OR_QUEUE" }),
    );
    const intelligenceBaseline = fingerprint(
      course({
        intelligenceVerifiedAt: new Date("2026-07-20T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-20T12:00:00.000Z"),
        intelligenceConfidence: 0.95,
      }),
    );
    const intelligenceDatesRefreshed = fingerprint(
      course({
        intelligenceVerifiedAt: new Date("2026-07-21T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-21T12:00:00.000Z"),
        intelligenceConfidence: 0.95,
      }),
    );
    const intelligenceConfidenceChanged = fingerprint(
      course({
        intelligenceVerifiedAt: new Date("2026-07-21T12:00:00.000Z"),
        intelligenceReviewAt: new Date("2026-08-21T12:00:00.000Z"),
        intelligenceConfidence: 0.9,
      }),
    );

    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(left);
    expect(changed).not.toBe(left);
    expect(accessChanged).not.toBe(left);
    expect(timeZoneChanged).not.toBe(left);
    expect(bookingWindowChanged).not.toBe(left);
    expect(accessModeChanged).not.toBe(left);
    expect(intelligenceDatesRefreshed).toBe(intelligenceBaseline);
    expect(intelligenceConfidenceChanged).not.toBe(intelligenceBaseline);
  });
});

describe("course-support verification scheduling", () => {
  it("uses the full request horizon when no earlier customer endpoint exists", () => {
    expect(
      getCourseSupportVerificationRequestDeadline({
        now,
        escalationDeadlineAt: null,
      }),
    ).toEqual(new Date("2026-07-21T12:35:00.000Z"));
  });

  it("reserves a one-minute delivery margin before an earlier customer endpoint", () => {
    expect(
      getCourseSupportVerificationRequestDeadline({
        now,
        escalationDeadlineAt: new Date("2026-07-21T12:20:00.000Z"),
      }),
    ).toEqual(new Date("2026-07-21T12:19:00.000Z"));
  });

  it("fails closed when the customer endpoint margin is already exhausted", () => {
    expect(
      getCourseSupportVerificationRequestDeadline({
        now,
        escalationDeadlineAt: new Date("2026-07-21T12:01:00.000Z"),
      }),
    ).toBeNull();
  });

  it.each([
    [61, "one second"],
    [90, "thirty seconds"],
    [119, "fifty-nine seconds"],
  ])(
    "rejects an endpoint %i seconds away because it leaves only %s before the next recovery launch",
    (endpointSeconds) => {
      expect(
        getCourseSupportVerificationRequestDeadline({
          now,
          escalationDeadlineAt: new Date(
            now.getTime() + endpointSeconds * 1_000,
          ),
        }),
      ).toBeNull();
    },
  );

  it("rejects exactly two minutes of launch runway after the delivery margin", () => {
    expect(
      getCourseSupportVerificationRequestDeadline({
        now,
        escalationDeadlineAt: new Date(now.getTime() + 3 * 60 * 1_000),
      }),
    ).toBeNull();
  });

  it("accepts more than two minutes of launch runway after the delivery margin", () => {
    expect(
      getCourseSupportVerificationRequestDeadline({
        now,
        escalationDeadlineAt: new Date(
          now.getTime() + 3 * 60 * 1_000 + 1,
        ),
      }),
    ).toEqual(new Date(now.getTime() + 2 * 60 * 1_000 + 1));
  });

  it("does not create a request that cannot survive the next recovery cron", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            escalationDeadlineAt: new Date(now.getTime() + 90 * 1_000),
          }),
          course: course(),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      ineligibleReasonCounts: { request_horizon_exceeded: 1 },
      requests: [],
    });

    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "request_horizon_exceeded",
        }),
      }),
    );
  });

  it("creates requests for inactive courses regardless of incident provenance", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident(),
          course: course(),
        },
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
          }),
          course: course({ id: "course-real" }),
        },
      ],
    });
    prismaMocks.requestFindMany.mockResolvedValue([
      {
        id: "request-1",
        batchIncidentId: "batch-incident-1",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now,
      },
      {
        id: "request-real",
        batchIncidentId: "batch-incident-real",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now,
      },
    ]);
    prismaMocks.requestCreateMany.mockResolvedValueOnce({ count: 2 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      createdCount: 2,
      eligibleCount: 2,
      ineligibleCount: 0,
    });

    const create = prismaMocks.requestCreateMany.mock.calls[0][0];
    expect(create.data).toHaveLength(2);
    expect(create.data[0]).toMatchObject({
      batchIncidentId: "batch-incident-1",
      courseId: "course-1",
      releaseSha,
      deadlineAt: new Date("2026-07-21T12:35:00.000Z"),
      targetDateLocal: "2026-07-21",
      startTimeLocal: "06:00",
      endTimeLocal: "20:00",
      players: 1,
      providerFamilyKeySnapshot: "CPS",
    });
    expect(create.data[0]).not.toHaveProperty("website");
    expect(create.data[0]).not.toHaveProperty("detectedBookingUrl");
    expect(create.data[0]).not.toHaveProperty("bookingMetadata");
    expect(create.data[0]).not.toHaveProperty("evidence");
    expect(create.data[0]).not.toHaveProperty("teeSearchId");
    expect(create.data[0]).not.toHaveProperty("recipient");
    expect(prismaMocks.activeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-21T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } },
      },
    });
  });

  it("reconciles stale real-demand cache before detached verification", async () => {
    const incidentUpdatedAt = new Date("2026-07-21T11:55:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
            updatedAt: incidentUpdatedAt,
          }),
          course: course({ id: "course-real" }),
        },
      ],
    });
    prismaMocks.requestFindMany.mockResolvedValue([
      {
        id: "request-real",
        batchIncidentId: "batch-incident-real",
        releaseSha,
        status: "QUEUED",
        revision: 0,
        nextAttemptAt: now,
      },
    ]);

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-real",
        cycle: 1,
        activeBatchId: "batch-1",
        status: "AUTO_INVESTIGATING",
        updatedAt: incidentUpdatedAt,
        activeRealSearchCount: 1,
        earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
      },
      data: {
        activeRealSearchCount: 0,
        earliestTargetDate: null,
        updatedAt: now,
      },
    });
    expect(prismaMocks.batchIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "batch-incident-real",
        batchId: "batch-1",
        incidentId: "incident-real",
        cycle: 1,
        verifiedIncidentUpdatedAt: incidentUpdatedAt,
      },
      data: { verifiedIncidentUpdatedAt: now },
    });
    const requestData = prismaMocks.requestCreateMany.mock.calls[0][0].data[0];
    expect(requestData).not.toHaveProperty("teeSearchId");
    expect(requestData).not.toHaveProperty("recipient");
    expect(requestData).not.toHaveProperty("match");
    expect(requestData).not.toHaveProperty("delivery");
    expect(
      prismaMocks.incidentUpdateMany.mock.calls[0][0].data,
    ).not.toHaveProperty("engineeringOnly");
  });

  it("fails closed when stale demand reconciliation loses its incident fence", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
          }),
          course: course({ id: "course-real" }),
        },
      ],
    });
    prismaMocks.incidentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      ineligibleReasonCounts: { incident_demand_changed: 1 },
      requests: [],
    });
    expect(prismaMocks.batchIncidentUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
  });

  it("rolls back scheduling when the batch proof-version fence is lost", async () => {
    const incidentUpdatedAt = new Date("2026-07-21T11:55:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-real",
          incidentId: "incident-real",
          courseId: "course-real",
          cycle: 1,
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          incident: incident({
            id: "incident-real",
            engineeringOnly: false,
            activeRealSearchCount: 1,
            earliestTargetDate: new Date("2026-07-22T00:00:00.000Z"),
            updatedAt: incidentUpdatedAt,
          }),
          course: course({ id: "course-real" }),
        },
      ],
    });
    prismaMocks.batchIncidentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).rejects.toThrow(
      "demand changed while detached verification was scheduled",
    );

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("schedules responder playbook progression while active demand remains customer-visible", async () => {
    const localTransition = new Date("2026-07-21T02:00:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          courseId: "course-1",
          cycle: 1,
          incident: incident(),
          course: course({ timeZone: "America/Los_Angeles" }),
        },
      ],
    });
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now: localTransition,
      }),
    ).resolves.toEqual({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ courseId: "course-1" })],
      }),
    );
    expect(prismaMocks.incidentUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-20T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } },
      },
    });
  });

  it("does not schedule detached work for a currently non-actionable course", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          courseId: "course-1",
          cycle: 1,
          incident: incident(),
          course: course({
            automationEligibility: "BLOCKED",
            automationReason: "CAPTCHA_OR_QUEUE",
            ...currentIntelligence(),
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      ineligibleReasonCounts: { monitoring_not_actionable: 1 },
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("requires a browser-retry stage handoff before scheduling non-runnable progression", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      summary: {
        remediation: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "DISCOVER_WITH_BROWSER",
          playbookStage: "RENDERED_BROWSER_DISCOVERY",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          reason: "PLAYBOOK_STAGE_PENDING",
          retryBudget: null,
        },
      },
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            attemptLedger: browserAdapterRetryReadyLedger(),
          }),
          course: course({
            detectedBookingUrl: null,
            detectedPlatform: null,
            providerFamilyKey: "SOURCE_MISSING",
            bookingMetadata: null,
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      ineligibleReasonCounts: { playbook_stage_handoff_required: 1 },
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("schedules only the assigned zero-attempt browser adapter progression while retaining blocked provider evidence", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      summary: {
        remediation: {
          workMode: "VERIFY_TRANSIENT",
          strategyAction: "RUN_TYPED_ADAPTER",
          playbookStage: "BROWSER_ADAPTER_RETRY",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          reason: "EXISTING_SUPPORT_READY",
          retryBudget: {
            maximumAttempts: 4,
            attemptsCompleted: 3,
            attemptsRemaining: 1,
            exhausted: false,
          },
        },
      },
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            attemptLedger: browserAdapterRetryReadyLedger(),
          }),
          course: course({
            detectedPlatform: null,
            providerFamilyKey: "SOURCE_MISSING",
            bookingMetadata: null,
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            ...currentIntelligence(),
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            automationEligibilitySnapshot: "BLOCKED",
            automationReasonSnapshot: "ACCOUNT_REQUIRED",
          }),
        ],
      }),
    );
  });

  it.each([
    [
      "first retryable stage attempt",
      browserAdapterRetryReadyLedger(true),
      false,
      false,
      true,
    ],
    [
      "exhausted route budget",
      browserAdapterRetryReadyLedger(),
      true,
      false,
      false,
    ],
    [
      "a current runnable-provider technical block",
      browserAdapterRetryReadyLedger(),
      false,
      true,
      false,
    ],
  ] as const)(
    "handles blocked browser adapter progression after %s",
    async (
      _case,
      attemptLedger,
      exhausted,
      runnableProvider,
      expectedEligible,
    ) => {
      prismaMocks.batchFindUnique.mockResolvedValue({
        id: "batch-1",
        status: "VERIFYING",
        releaseSha,
        completedAt: null,
        summary: {
          remediation: {
            workMode: "VERIFY_TRANSIENT",
            strategyAction: "RUN_TYPED_ADAPTER",
            playbookStage: "BROWSER_ADAPTER_RETRY",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            reason: "EXISTING_SUPPORT_READY",
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: exhausted ? 4 : 3,
              attemptsRemaining: exhausted ? 0 : 1,
              exhausted,
            },
          },
        },
        incidents: [
          {
            id: "batch-incident-1",
            incidentId: "incident-1",
            courseId: "course-1",
            cycle: 1,
            verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
            incident: incident({ attemptLedger }),
            course: course({
              ...(runnableProvider
                ? {
                    detectedBookingUrl: "https://public-course.cps.golf/",
                    bookingMetadata: {
                      provider: "CPS",
                      siteName: "public-course",
                      bookingBaseUrl: "https://public-course.cps.golf/",
                      courseIds: [1],
                    },
                  }
                : {
                    detectedPlatform: null,
                    providerFamilyKey: "SOURCE_MISSING",
                    bookingMetadata: null,
                  }),
              automationEligibility: "BLOCKED",
              automationReason: "ACCOUNT_REQUIRED",
              ...currentIntelligence(),
            }),
          },
        ],
      });

      await expect(
        scheduleCourseSupportVerificationRequests({
          batchId: "batch-1",
          releaseSha,
          now,
        }),
      ).resolves.toEqual(
        expectedEligible
          ? {
              createdCount: 1,
              eligibleCount: 1,
              ineligibleCount: 0,
              requests: [],
            }
          : {
              createdCount: 0,
              eligibleCount: 0,
              ineligibleCount: 1,
              ineligibleReasonCounts: { monitoring_not_actionable: 1 },
              requests: [],
            },
      );
      if (expectedEligible) {
        expect(prismaMocks.requestCreateMany).toHaveBeenCalledOnce();
      } else {
        expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
      }
    },
  );

  it("schedules only the assigned zero-attempt local reader while retaining blocked provider evidence", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      summary: {
        remediation: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "DISCOVER_WITH_HTTP",
          playbookStage: "LOCAL_READER",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          reason: "PLAYBOOK_STAGE_PENDING",
          retryBudget: null,
        },
      },
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({ attemptLedger: localReaderReadyLedger() }),
          course: course({
            detectedPlatform: null,
            providerFamilyKey: "SOURCE_MISSING",
            bookingMetadata: null,
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            ...currentIntelligence(),
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            automationEligibilitySnapshot: "BLOCKED",
            automationReasonSnapshot: "ACCOUNT_REQUIRED",
          }),
        ],
      }),
    );
  });

  it("schedules an assigned failed-retryable local reader with three attempts remaining", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      summary: {
        remediation: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "LOCAL_READER",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          reason: "PLAYBOOK_STAGE_PENDING",
          retryBudget: {
            maximumAttempts: 4,
            attemptsCompleted: 1,
            attemptsRemaining: 3,
            exhausted: false,
          },
        },
      },
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            attemptLedger: localReaderFailedRetryableLedger(),
          }),
          course: course({
            detectedPlatform: null,
            providerFamilyKey: "SOURCE_MISSING",
            bookingMetadata: null,
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            ...currentIntelligence(),
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ courseId: "course-1", releaseSha })],
      }),
    );
  });

  it.each([
    ["current-release", releaseSha, "TOOLING"],
    ["prior-release workflow upgrade", priorReleaseSha, "TOOLING"],
    [
      "prior-release search-monitoring upgrade",
      priorReleaseSha,
      "LOCAL_READER_RESULT",
    ],
  ] as const)("schedules, claims, and attaches a %s assigned started local reader", async (_label, startedRuntimeVersion, startedEvidenceKind) => {
    const priorStartedAt = now;
    const batchCreatedAt = new Date("2026-07-21T12:00:30.000Z");
    const requestCreatedAt = new Date("2026-07-21T12:00:31.000Z");
    const lifecycleNow = new Date("2026-07-21T12:01:00.000Z");
    const startedLedger = localReaderReadyLedger(
      true,
      startedRuntimeVersion,
      priorStartedAt,
      startedEvidenceKind,
    );
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      createdAt: batchCreatedAt,
      completedAt: null,
      summary: {
        remediation: {
          workMode: "ADVANCE_DISCOVERY",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "LOCAL_READER",
          allowUnchangedRuntime: true,
          requiresImplementationPath: false,
          reason: "PLAYBOOK_STAGE_PENDING",
          retryBudget: {
            maximumAttempts: 4,
            attemptsCompleted: 1,
            attemptsRemaining: 3,
            exhausted: false,
          },
        },
      },
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({ attemptLedger: startedLedger }),
          course: course({
            detectedPlatform: null,
            providerFamilyKey: "SOURCE_MISSING",
            bookingMetadata: null,
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            ...currentIntelligence(),
          }),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now: lifecycleNow,
      }),
    ).resolves.toEqual({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: [],
    });
    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ courseId: "course-1", releaseSha })],
      }),
    );

    const queuedRequest = assignedLocalReaderRequest({
      attemptLedger: startedLedger,
      requestOverrides: {
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: lifecycleNow,
        discoveryAttemptedAt: null,
        discoveryVerifiedAt: null,
        startedAt: null,
        createdAt: requestCreatedAt,
        updatedAt: requestCreatedAt,
      },
    });
    queuedRequest.batchIncident.batch.createdAt = batchCreatedAt;
    prismaMocks.requestFindUnique.mockResolvedValueOnce(queuedRequest);

    const claimed = await claimCourseSupportVerificationRequest({
      requestId: "request-1",
      expectedRevision: 0,
      runtimeVersion: releaseSha,
      now: lifecycleNow,
    });
    expect(claimed).toMatchObject({
      claimed: true,
      revision: 1,
      runtimeVersion: releaseSha,
    });
    if (!claimed.claimed) {
      throw new Error("Expected the scheduled local-reader continuation to claim.");
    }

    prismaMocks.requestFindUnique.mockResolvedValueOnce({
      ...queuedRequest,
      runtimeVersion: releaseSha,
      status: "CHECKING",
      revision: claimed.revision,
      leaseToken: claimed.leaseToken,
      leaseExpiresAt: claimed.leaseExpiresAt,
      nextAttemptAt: null,
      updatedAt: lifecycleNow,
    });

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: claimed.requestId,
        expectedRevision: claimed.revision,
        leaseToken: claimed.leaseToken,
        runtimeVersion: claimed.runtimeVersion,
        purpose: "PRE_EXECUTION",
        now: lifecycleNow,
      }),
    ).resolves.toMatchObject({
      attached: true,
      revision: 2,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: lifecycleNow }),
      }),
    );
  });

  it.each([
    ["private identity", { isPublic: false }],
    [
      "manual disposition",
      {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        ...currentIntelligence(),
      },
    ],
  ] as const)(
    "does not let an assigned local reader bypass a current %s gate",
    async (_label, courseOverrides) => {
      prismaMocks.batchFindUnique.mockResolvedValue({
        id: "batch-1",
        status: "VERIFYING",
        releaseSha,
        completedAt: null,
        summary: {
          remediation: {
            workMode: "ADVANCE_DISCOVERY",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            playbookStage: "LOCAL_READER",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            reason: "PLAYBOOK_STAGE_PENDING",
            retryBudget: {
              maximumAttempts: 4,
              attemptsCompleted: 1,
              attemptsRemaining: 3,
              exhausted: false,
            },
          },
        },
        incidents: [
          {
            id: "batch-incident-1",
            incidentId: "incident-1",
            courseId: "course-1",
            cycle: 1,
            verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
            incident: incident({
              attemptLedger: localReaderFailedRetryableLedger(),
            }),
            course: course({
              detectedPlatform: null,
              providerFamilyKey: "SOURCE_MISSING",
              bookingMetadata: null,
              ...courseOverrides,
            }),
          },
        ],
      });

      await expect(
        scheduleCourseSupportVerificationRequests({
          batchId: "batch-1",
          releaseSha,
          now,
        }),
      ).resolves.toEqual({
        createdCount: 0,
        eligibleCount: 0,
        ineligibleCount: 1,
        ineligibleReasonCounts: { monitoring_not_actionable: 1 },
        requests: [],
      });
      expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    },
  );

  it("rejects a started local-reader handoff recorded before the incident", async () => {
    const requestWithPreIncidentHandoff = assignedLocalReaderRequest({
      requestOverrides: { startedAt: null },
    });
    requestWithPreIncidentHandoff.batchIncident.incident.firstSeenAt =
      new Date("2026-07-21T12:00:01.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      requestWithPreIncidentHandoff,
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now: new Date("2026-07-21T12:02:00.000Z"),
      }),
    ).resolves.toEqual({
      attached: false,
      reason: "monitoring_not_actionable",
    });
  });

  it.each([
    ["first stage attempt", localReaderReadyLedger(true), "ADVANCE_DISCOVERY"],
    ["a mismatched route", localReaderReadyLedger(), "VERIFY_TRANSIENT"],
  ] as const)(
    "keeps blocked local reader progression ineligible after %s",
    async (_case, attemptLedger, workMode) => {
      prismaMocks.batchFindUnique.mockResolvedValue({
        id: "batch-1",
        status: "VERIFYING",
        releaseSha,
        completedAt: null,
        summary: {
          remediation: {
            workMode,
            strategyAction:
              workMode === "ADVANCE_DISCOVERY"
                ? "DISCOVER_WITH_HTTP"
                : "RUN_TYPED_ADAPTER",
            playbookStage: "LOCAL_READER",
            allowUnchangedRuntime: true,
            requiresImplementationPath: false,
            reason: "PLAYBOOK_STAGE_PENDING",
            retryBudget: null,
          },
        },
        incidents: [
          {
            id: "batch-incident-1",
            incidentId: "incident-1",
            courseId: "course-1",
            cycle: 1,
            verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
            incident: incident({ attemptLedger }),
            course: course({
              detectedPlatform: null,
              providerFamilyKey: "SOURCE_MISSING",
              bookingMetadata: null,
              automationEligibility: "BLOCKED",
              automationReason: "ACCOUNT_REQUIRED",
              ...currentIntelligence(),
            }),
          },
        ],
      });

      await expect(
        scheduleCourseSupportVerificationRequests({
          batchId: "batch-1",
          releaseSha,
          now,
        }),
      ).resolves.toEqual({
        createdCount: 0,
        eligibleCount: 0,
        ineligibleCount: 1,
        ineligibleReasonCounts: { monitoring_not_actionable: 1 },
        requests: [],
      });
      expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    },
  );

  it("caps a scheduled request before an earlier customer endpoint", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            escalationDeadlineAt: new Date("2026-07-21T12:20:00.000Z"),
          }),
          course: course(),
        },
      ],
    });

    await scheduleCourseSupportVerificationRequests({
      batchId: "batch-1",
      releaseSha,
      now,
    });

    expect(prismaMocks.requestCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          batchIncidentId: "batch-incident-1",
          deadlineAt: new Date("2026-07-21T12:19:00.000Z"),
        }),
      ],
      skipDuplicates: true,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
        deadlineAt: { gt: new Date("2026-07-21T12:19:00.000Z") },
        batchIncident: expect.objectContaining({
          batchId: "batch-1",
          incidentId: "incident-1",
          cycle: 1,
          incident: {
            is: expect.objectContaining({
              cycle: 1,
              activeBatchId: "batch-1",
              status: "AUTO_INVESTIGATING",
            }),
          },
        }),
      }),
      data: {
        deadlineAt: new Date("2026-07-21T12:19:00.000Z"),
        updatedAt: now,
      },
    });
  });

  it("monotonically shortens an existing same-release request after duplicate insertion", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            escalationDeadlineAt: new Date("2026-07-21T12:20:00.000Z"),
          }),
          course: course(),
        },
      ],
    });
    prismaMocks.requestCreateMany.mockResolvedValueOnce({ count: 0 });
    prismaMocks.requestFindMany.mockResolvedValueOnce([
      {
        id: "request-1",
        batchIncidentId: "batch-incident-1",
        releaseSha,
        status: "QUEUED",
        revision: 4,
        nextAttemptAt: now,
      },
    ]);

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      createdCount: 0,
      eligibleCount: 1,
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncidentId: "batch-incident-1",
          releaseSha,
          deadlineAt: { gt: new Date("2026-07-21T12:19:00.000Z") },
        }),
        data: expect.objectContaining({
          deadlineAt: new Date("2026-07-21T12:19:00.000Z"),
        }),
      }),
    );
  });

  it("stales an existing retry that cannot run before a newly earlier deadline", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            escalationDeadlineAt: new Date("2026-07-21T12:20:00.000Z"),
          }),
          course: course(),
        },
      ],
    });
    prismaMocks.requestCreateMany.mockResolvedValueOnce({ count: 0 });

    await scheduleCourseSupportVerificationRequests({
      batchId: "batch-1",
      releaseSha,
      now,
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncidentId: "batch-incident-1",
          releaseSha,
          status: { in: ["QUEUED", "RETRYABLE_FAILED"] },
          nextAttemptAt: { gte: new Date("2026-07-21T12:19:00.000Z") },
          deadlineAt: { gt: new Date("2026-07-21T12:19:00.000Z") },
        }),
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          lastError: "request_horizon_exceeded",
        }),
      }),
    );
  });

  it("does not schedule detached work after its endpoint delivery margin", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: null,
      incidents: [
        {
          id: "batch-incident-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
          incident: incident({
            escalationDeadlineAt: new Date("2026-07-21T12:01:00.000Z"),
          }),
          course: course(),
        },
      ],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      createdCount: 0,
      eligibleCount: 0,
      ineligibleCount: 1,
      ineligibleReasonCounts: { request_horizon_exceeded: 1 },
      requests: [],
    });
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
      }),
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "request_horizon_exceeded",
        updatedAt: now,
      },
    });
  });

  it("rejects scheduling against a release other than the batch release", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha: newerReleaseSha,
      completedAt: null,
      incidents: [],
    });
    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).rejects.toThrow("must equal the batch release SHA");
  });

  it("rejects scheduling once the owning batch is no longer verifying", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "RETRYABLE_FAILED",
      releaseSha,
      completedAt: now,
      incidents: [],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).rejects.toThrow("actively verifying batch");
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
  });

  it("rejects scheduling when a stale VERIFYING batch is already completed", async () => {
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      releaseSha,
      completedAt: now,
      incidents: [],
    });

    await expect(
      scheduleCourseSupportVerificationRequests({
        batchId: "batch-1",
        releaseSha,
        now,
      }),
    ).rejects.toThrow("actively verifying batch");
    expect(prismaMocks.requestCreateMany).not.toHaveBeenCalled();
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("lists only due and expired-lease states with a bounded limit", async () => {
    prismaMocks.rootRequestFindMany.mockResolvedValue([]);
    await listDueCourseSupportVerificationRequests({
      now,
      limit: Number.NaN,
    });

    expect(prismaMocks.rootRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          createdAt: { gt: new Date("2026-07-20T12:00:00.000Z") },
          deadlineAt: { gt: now },
          OR: [
            { status: "QUEUED", nextAttemptAt: { lte: now } },
            { status: "RETRYABLE_FAILED", nextAttemptAt: { lte: now } },
            { status: "CHECKING", leaseExpiresAt: { lte: now } },
          ],
        },
        take: 25,
      }),
    );
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
        deadlineAt: { lte: now },
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "request_horizon_exceeded",
        updatedAt: now,
      },
    });
  });

  it("selects a mismatch-grace request early only for its exact runtime", async () => {
    prismaMocks.rootRequestFindMany.mockResolvedValue([]);

    await listDueCourseSupportVerificationRequests({
      now,
      runtimeVersion: releaseSha,
    });

    expect(prismaMocks.rootRequestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              releaseSha,
              status: { in: ["QUEUED", "RETRYABLE_FAILED"] },
              lastError: { startsWith: "runtime_release_mismatch:" },
            },
          ]),
        }),
      }),
    );
  });
});

describe("course-support verification execution fencing", () => {
  it("stales a request at its absolute 24-hour execution horizon", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        createdAt: new Date("2026-07-20T12:00:00.000Z"),
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "request_horizon_exceeded",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          lastError: "request_horizon_exceeded",
        }),
      }),
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("durably defers queued work for one cron grace when a mismatched runtime sees it", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: newerReleaseSha,
        now,
      }),
    ).resolves.toEqual({ claimed: false, reason: "runtime_mismatch" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "request-1",
        revision: 0,
        status: "QUEUED",
        leaseToken: null,
        deadlineAt: { gt: now },
        OR: expect.any(Array),
      }),
      data: {
        status: "QUEUED",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        workflowRunId: null,
        nextAttemptAt: new Date("2026-07-21T12:01:00.000Z"),
        lastError: "runtime_release_mismatch:2026-07-21T12:00:00.000Z",
        completedAt: null,
        updatedAt: now,
      },
    });
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("lets the exact immutable runtime claim during the mismatch grace", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 1,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-07-21T12:01:00.000Z"),
        updatedAt: now,
        lastError: "runtime_release_mismatch:2026-07-21T12:00:00.000Z",
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        runtimeVersion: releaseSha,
        now: new Date("2026-07-21T12:00:30.000Z"),
      }),
    ).resolves.toMatchObject({
      claimed: true,
      revision: 2,
      runtimeVersion: releaseSha,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revision: 1,
          releaseSha,
          OR: expect.arrayContaining([
            expect.objectContaining({
              lastError: { startsWith: "runtime_release_mismatch:" },
            }),
          ]),
        }),
        data: expect.objectContaining({
          status: "CHECKING",
          lastError: null,
          attemptCount: { increment: 1 },
        }),
      }),
    );
  });

  it("stales the same mismatch with a cutover reason after one full cron grace", async () => {
    const cutoverAt = new Date("2026-07-21T12:01:00.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 1,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: cutoverAt,
        updatedAt: now,
        lastError: "runtime_release_mismatch:2026-07-21T12:00:00.000Z",
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        runtimeVersion: newerReleaseSha,
        now: cutoverAt,
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "release_runtime_cutover",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "request-1", revision: 1 }),
        data: expect.objectContaining({
          status: "STALE",
          revision: { increment: 1 },
          nextAttemptAt: null,
          completedAt: cutoverAt,
          lastError: "release_runtime_cutover",
        }),
      }),
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("cuts over a Workflow-start retry instead of preserving it to the horizon", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: releaseSha,
        status: "RETRYABLE_FAILED",
        revision: 4,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        lastError: "Workflow start failed before verification execution.",
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 4,
        runtimeVersion: newerReleaseSha,
        now,
      }),
    ).resolves.toEqual({ claimed: false, reason: "runtime_mismatch" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          revision: { increment: 1 },
          nextAttemptAt: new Date("2026-07-21T12:01:00.000Z"),
          lastError: "runtime_release_mismatch:2026-07-21T12:00:00.000Z",
        }),
      }),
    );
  });

  it("stales an old request once its batch advances to a newer release", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        batchIncident: {
          id: "batch-incident-1",
          batchId: "batch-1",
          courseId: "course-1",
          cycle: 1,
          batch: {
            id: "batch-1",
            status: "VERIFYING",
            releaseSha: newerReleaseSha,
            completedAt: null,
          },
          incident: incident(),
        },
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: newerReleaseSha,
        now,
      }),
    ).resolves.toEqual({
      claimed: false,
      reason: "batch_release_changed",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
  });

  it.each([
    {
      label: "closed batch",
      batchStatus: "RETRYABLE_FAILED",
      batchCompletedAt: now,
      incidentCycle: 1,
      activeBatchId: "batch-1",
      reason: "batch_not_verifying",
    },
    {
      label: "reopened incident cycle",
      batchStatus: "VERIFYING",
      batchCompletedAt: null,
      incidentCycle: 2,
      activeBatchId: "batch-1",
      reason: "batch_ownership_changed",
    },
    {
      label: "released incident ownership",
      batchStatus: "VERIFYING",
      batchCompletedAt: null,
      incidentCycle: 1,
      activeBatchId: null,
      reason: "batch_ownership_changed",
    },
  ])(
    "stales due work after a $label",
    async ({
      batchStatus,
      batchCompletedAt,
      incidentCycle,
      activeBatchId,
      reason,
    }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          runtimeVersion: null,
          status: "QUEUED",
          revision: 0,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: now,
          batchIncident: {
            ...request().batchIncident,
            batch: {
              ...request().batchIncident.batch,
              status: batchStatus,
              completedAt: batchCompletedAt,
            },
            incident: incident({ cycle: incidentCycle, activeBatchId }),
          },
        }),
      );

      await expect(
        claimCourseSupportVerificationRequest({
          requestId: "request-1",
          expectedRevision: 0,
          runtimeVersion: releaseSha,
          now,
        }),
      ).resolves.toEqual({ claimed: false, reason });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "STALE", lastError: reason }),
        }),
      );
      expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
    },
  );

  it("stales due work when the batch is completed despite a stale VERIFYING status", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "VERIFYING",
            completedAt: now,
          },
        },
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toEqual({ claimed: false, reason: "batch_not_verifying" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying",
        }),
      }),
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it("claims by revision and expired-state CAS only after eligibility is rechecked", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      }),
    );

    const result = await claimCourseSupportVerificationRequest({
      requestId: "request-1",
      expectedRevision: 0,
      runtimeVersion: releaseSha,
      now,
    });

    expect(result).toMatchObject({
      claimed: true,
      revision: 1,
      releaseSha,
      runtimeVersion: releaseSha,
      intent: {
        targetDateLocal: "2026-07-21",
        startTimeLocal: "06:00",
        endTimeLocal: "20:00",
        players: 1,
      },
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          revision: 0,
          releaseSha,
          OR: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: "CHECKING",
          runtimeVersion: releaseSha,
          revision: { increment: 1 },
          attemptCount: { increment: 1 },
          evidence: Prisma.JsonNull,
        }),
      }),
    );
    expect(
      prismaMocks.requestUpdateMany.mock.calls.at(-1)?.[0]?.data,
    ).not.toHaveProperty("startedAt");
  });

  it("claims queued responder progression even when active demand still exists", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      }),
    );
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      claimed: true,
      revision: 1,
      runtimeVersion: releaseSha,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CHECKING",
          runtimeVersion: releaseSha,
          attemptCount: { increment: 1 },
        }),
      }),
    );
  });

  it.each([
    {
      label: "an older rendered-browser claim on a non-runnable provider",
      claimedStage: "RENDERED_BROWSER_DISCOVERY" as const,
      runnableProvider: false,
      malformedDirective: false,
      expectedClaimed: false,
    },
    {
      label: "a malformed browser-retry claim on a non-runnable provider",
      claimedStage: "BROWSER_ADAPTER_RETRY" as const,
      runnableProvider: false,
      malformedDirective: true,
      expectedClaimed: false,
    },
    {
      label: "an older rendered-browser claim after capability becomes runnable",
      claimedStage: "RENDERED_BROWSER_DISCOVERY" as const,
      runnableProvider: true,
      malformedDirective: false,
      expectedClaimed: true,
    },
    {
      label: "an exact browser-retry claim on a non-runnable provider",
      claimedStage: "BROWSER_ADAPTER_RETRY" as const,
      runnableProvider: false,
      discoveryRepair: false,
      malformedDirective: false,
      expectedClaimed: true,
    },
    {
      label:
        "an exact browser-retry discovery repair on a non-runnable provider",
      claimedStage: "BROWSER_ADAPTER_RETRY" as const,
      runnableProvider: false,
      discoveryRepair: true,
      malformedDirective: false,
      expectedClaimed: true,
    },
  ])(
    "handles $label without crossing stage ownership",
    async ({
      claimedStage,
      runnableProvider,
      discoveryRepair,
      malformedDirective,
      expectedClaimed,
    }) => {
      const queuedRequest = browserAdapterRetryHandoffRequest({
        claimedStage,
        runnableProvider,
        discoveryRepair,
      });
      if (malformedDirective) {
        const summary = queuedRequest.batchIncident.batch.summary as {
          remediation: { strategyAction: string };
        };
        summary.remediation.strategyAction = "DISCOVER_WITH_BROWSER";
      }
      prismaMocks.requestFindUnique.mockResolvedValue(queuedRequest);

      const result = await claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now,
      });

      if (expectedClaimed) {
        expect(result).toMatchObject({
          claimed: true,
          revision: 1,
          runtimeVersion: releaseSha,
        });
        expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "CHECKING",
              attemptCount: { increment: 1 },
            }),
          }),
        );
      } else {
        expect(result).toEqual({
          claimed: false,
          reason: "playbook_stage_handoff_required",
        });
        expect(prismaMocks.requestUpdateMany).toHaveBeenCalledTimes(1);
        expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: "STALE",
              lastError: "playbook_stage_handoff_required",
            }),
          }),
        );
      }
    },
  );

  it.each([
    [
      "due retryable failure",
      {
        status: "RETRYABLE_FAILED",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      },
    ],
    [
      "expired checking lease",
      {
        status: "CHECKING",
        leaseToken: "expired-lease",
        leaseExpiresAt: new Date("2026-07-21T11:59:00.000Z"),
        nextAttemptAt: null,
      },
    ],
  ] as const)(
    "reclaims assigned local-reader authority after a release-matching STARTED event from a %s",
    async (_label, state) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        assignedLocalReaderRequest({
          requestOverrides: { ...state, revision: 4 },
        }),
      );

      await expect(
        claimCourseSupportVerificationRequest({
          requestId: "request-1",
          expectedRevision: 4,
          runtimeVersion: releaseSha,
          now,
        }),
      ).resolves.toMatchObject({
        claimed: true,
        revision: 5,
        runtimeVersion: releaseSha,
      });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "request-1",
            revision: 4,
            releaseSha,
            deadlineAt: { gt: now },
          }),
          data: expect.objectContaining({
            status: "CHECKING",
            runtimeVersion: releaseSha,
            attemptCount: { increment: 1 },
          }),
        }),
      );
    },
  );

  it("clears both discovery markers when a claim observes a changed provider snapshot", async () => {
    const changedCourse = course({
      bookingMetadata: { provider: "CPS", facilityId: "changed-before-claim" },
    });
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        runtimeVersion: null,
        status: "QUEUED",
        revision: 0,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
        course: changedCourse,
      }),
    );

    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 0,
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toMatchObject({ claimed: true, revision: 1 });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerSnapshotFingerprint: fingerprint(changedCourse),
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
        }),
      }),
    );
  });

  it("attaches and heartbeats a Workflow through its lease and monotonic revision fence", async () => {
    await expect(
      attachCourseSupportVerificationWorkflow({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        workflowRunId: "wf/run-safe_1",
        now,
      }),
    ).resolves.toEqual({ attached: true });
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          revision: { gte: 1 },
          releaseSha,
          runtimeVersion: releaseSha,
          leaseToken: "lease-1",
          leaseExpiresAt: { gt: now },
        }),
        data: { workflowRunId: "wf/run-safe_1", updatedAt: now },
      }),
    );

    await expect(
      heartbeatCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toMatchObject({ renewed: true });
    expect(prismaMocks.rootRequestUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          leaseExpiresAt: new Date("2026-07-21T12:10:00.000Z"),
        }),
      }),
    );
  });

  it("persists a fresh post-discovery provider snapshot before adapter I/O", async () => {
    const changedCourse = course({
      bookingMetadata: { provider: "CPS", facilityId: "fresh-discovery" },
    });
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ course: changedCourse }),
    );

    const result = await attachCourseSupportVerificationProviderSnapshot({
      requestId: "request-1",
      expectedRevision: 1,
      leaseToken: "lease-1",
      runtimeVersion: releaseSha,
      purpose: "PRE_EXECUTION",
      now,
    });

    expect(result).toMatchObject({ attached: true, revision: 2 });
    expect(result).toHaveProperty(
      "providerSnapshotFingerprint",
      fingerprint(changedCourse),
    );
    expect(result).toMatchObject({
      discoveryAttemptedAt: null,
      discoveryVerifiedAt: null,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerSnapshotFingerprint: fingerprint(changedCourse),
          providerSnapshotAt: now,
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
          revision: { increment: 1 },
        }),
      }),
    );
  });

  it("records execution only when the owned provider path is about to run", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ startedAt: null }),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({ attached: true });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: now }),
      }),
    );
  });

  it("retains exact local-reader authority when STARTED is recorded before provider attachment", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      assignedLocalReaderRequest({
        requestOverrides: { startedAt: null },
      }),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({ attached: true, revision: 2 });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: now }),
      }),
    );
  });

  it.each([
    [
      "another release",
      localReaderReadyLedger(true, newerReleaseSha, now),
      undefined,
    ],
    [
      "a retryable control result from a semantic reader runtime",
      localReaderFailedRetryableLedger(1, "reader-v1"),
      { retryBudget: null },
    ],
    [
      "a semantic success without reader-result evidence",
      localReaderSucceededLedger({ evidenceKind: "TOOLING" }),
      undefined,
    ],
    [
      "a non-result local-reader transition from another release",
      localReaderIndependentHandoffLedger("NOT_APPLICABLE", {
        localRuntimeVersion: newerReleaseSha,
      }),
      undefined,
    ],
    [
      "an independent-confirmation successor from another release",
      localReaderIndependentHandoffLedger("FAILED_TERMINAL", {
        successorRuntimeVersion: newerReleaseSha,
      }),
      undefined,
    ],
    [
      "a future timestamp",
      localReaderReadyLedger(
        true,
        releaseSha,
        new Date("2026-07-21T12:01:00.000Z"),
      ),
      undefined,
    ],
  ] as const)(
    "rejects local-reader lifecycle provenance from %s",
    async (_label, attemptLedger, remediationOverrides) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        assignedLocalReaderRequest({
          attemptLedger,
          remediationOverrides,
          requestOverrides: { startedAt: null },
        }),
      );

      await expect(
        attachCourseSupportVerificationProviderSnapshot({
          requestId: "request-1",
          expectedRevision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
          purpose: "PRE_EXECUTION",
          now,
        }),
      ).resolves.toEqual({
        attached: false,
        reason: "monitoring_not_actionable",
      });
    },
  );

  it.each([
    {
      label: "private identity",
      courseOverrides: { isPublic: false },
    },
    {
      label: "manual disposition",
      courseOverrides: {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
      },
    },
    {
      label: "invalid assignment",
      remediationOverrides: { strategyAction: "RETRY_PROVIDER" },
    },
  ])(
    "does not retain local-reader lifecycle authority through a $label gate",
    async ({ courseOverrides, remediationOverrides }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        assignedLocalReaderRequest({
          courseOverrides,
          remediationOverrides,
          requestOverrides: { startedAt: null },
        }),
      );

      await expect(
        attachCourseSupportVerificationProviderSnapshot({
          requestId: "request-1",
          expectedRevision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
          purpose: "PRE_EXECUTION",
          now,
        }),
      ).resolves.toEqual({
        attached: false,
        reason: "monitoring_not_actionable",
      });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "STALE",
            lastError: "monitoring_not_actionable",
          }),
        }),
      );
    },
  );

  it("authenticates one deferred confirmation against its exhausted admission without changing the ledger", async () => {
    const ownedRequest = deferredConfirmationRequest();
    prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(ownedRequest),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({
      attached: true,
      deferredFailureConfirmation: true,
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: now }),
      }),
    );
    expect(ownedRequest.batchIncident.incident.attemptLedger).toEqual(
      unresolvedExhaustedLedger(),
    );
  });

  it.each([
    {
      label: "planned one to current zero",
      plannedDemand: 1,
      currentDemand: 1,
      liveDemand: 0,
    },
    {
      label: "planned zero to current one",
      plannedDemand: 0,
      currentDemand: 1,
      liveDemand: 1,
    },
  ])(
    "does not use mutable demand as deferred technical authorization for $label",
    async ({ plannedDemand, currentDemand, liveDemand }) => {
      const ownedRequest = deferredConfirmationRequest();
      const summary = ownedRequest.batchIncident.batch.summary as {
        remediation: { attempts: Array<Record<string, unknown>> };
      };
      summary.remediation.attempts[0].activeRealSearchCount = plannedDemand;
      ownedRequest.batchIncident.incident.activeRealSearchCount = currentDemand;
      ownedRequest.batchIncident.incident.earliestTargetDate =
        currentDemand > 0 ? new Date("2026-07-24T00:00:00.000Z") : null;
      prismaMocks.activeSearchCount.mockResolvedValue(liveDemand);
      prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
      prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
        deferredConfirmationSourceRows(ownedRequest),
      );

      await expect(
        attachCourseSupportVerificationProviderSnapshot({
          requestId: "request-1",
          expectedRevision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
          purpose: "PRE_EXECUTION",
          now,
        }),
      ).resolves.toMatchObject({
        attached: true,
        deferredFailureConfirmation: true,
      });
    },
  );

  it.each([
    {
      label: "authoritative healthy monitoring",
      arrange: () =>
        prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
          state: "HEALTHY",
          failureFingerprint: null,
          stateChangedAt: new Date("2026-07-21T11:59:30.000Z"),
          lastSuccessfulAt: new Date("2026-07-21T11:59:30.000Z"),
          revision: 4,
          updatedAt: new Date("2026-07-21T11:59:30.000Z"),
        }),
      reason: "monitoring_not_actionable",
    },
    {
      label: "current monitoring identity drift",
      arrange: () =>
        prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
          state: "AUTO_INVESTIGATING",
          failureFingerprint: "9".repeat(64),
          stateChangedAt: new Date("2026-07-21T11:59:30.000Z"),
          lastSuccessfulAt: null,
          revision: 4,
          updatedAt: new Date("2026-07-21T11:59:30.000Z"),
        }),
      reason: "monitoring_not_actionable",
    },
    {
      label: "fresh monitoring success marker",
      arrange: () =>
        prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
          state: "AUTO_INVESTIGATING",
          failureFingerprint: canonicalFailureFingerprint,
          stateChangedAt: new Date("2026-07-21T11:45:00.000Z"),
          lastSuccessfulAt: new Date("2026-07-21T11:56:00.000Z"),
          revision: 4,
          updatedAt: new Date("2026-07-21T11:59:30.000Z"),
        }),
      reason: "monitoring_not_actionable",
    },
    {
      label: "fresh successful customer probe",
      arrange: () =>
        prismaMocks.probeFindMany.mockResolvedValue([
          {
            id: "probe-success",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-07-21T11:56:00.000Z"),
          },
        ]),
      reason: "monitoring_not_actionable",
    },
    {
      label: "equal-timestamp probe ambiguity",
      arrange: () =>
        prismaMocks.probeFindMany.mockResolvedValue([
          {
            id: "probe-b",
            outcome: "FETCH_FAILED",
            observedAt: new Date("2026-07-21T11:57:00.000Z"),
          },
          {
            id: "probe-a",
            outcome: "NO_MATCH",
            observedAt: new Date("2026-07-21T11:57:00.000Z"),
          },
        ]),
      reason: "invalid_evidence",
    },
  ])(
    "rejects a deferred provider attachment on $label before provider I/O",
    async ({ arrange, reason }) => {
      const ownedRequest = deferredConfirmationRequest();
      prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
      prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
        deferredConfirmationSourceRows(ownedRequest),
      );
      arrange();

      await expect(
        attachCourseSupportVerificationProviderSnapshot({
          requestId: "request-1",
          expectedRevision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
          purpose: "PRE_EXECUTION",
          now,
        }),
      ).resolves.toEqual({ attached: false, reason });

      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "STALE", lastError: reason }),
        }),
      );
    },
  );

  it("uses an exact zero-request carrier creation time as the factual probe floor", async () => {
    const ownedRequest = deferredConfirmationRequest();
    prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationCarrierSourceRows(ownedRequest),
    );
    prismaMocks.probeFindMany.mockResolvedValue([
      {
        id: "success-before-carrier",
        outcome: "NO_MATCH",
        observedAt: new Date("2026-07-21T11:57:00.000Z"),
      },
    ]);

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({
      attached: true,
      deferredFailureConfirmation: true,
    });

    prismaMocks.probeFindMany.mockResolvedValue([
      {
        id: "success-at-carrier",
        outcome: "NO_MATCH",
        observedAt: new Date("2026-07-21T11:57:30.000Z"),
      },
    ]);

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toEqual({
      attached: false,
      reason: "monitoring_not_actionable",
    });
  });

  it("authenticates a zero-request carrier through attach and the final pre-I/O mark across demand-only revision drift", async () => {
    const attachedRequest = deferredConfirmationRequest();
    const finalRequest = deferredConfirmationRequest({ startedAt: now });
    const finalAt = new Date("2026-07-21T12:00:01.000Z");
    finalRequest.revision = 2;
    finalRequest.updatedAt = now;
    finalRequest.batchIncident.incident.revision = 4;
    finalRequest.batchIncident.incident.updatedAt = new Date(
      "2026-07-21T11:59:30.000Z",
    );
    finalRequest.batchIncident.incident.earliestTargetDate = new Date(
      "2026-07-24T00:00:00.000Z",
    );
    finalRequest.batchIncident.incident.engineeringOnly = false;
    prismaMocks.requestFindUnique
      .mockResolvedValueOnce(attachedRequest)
      .mockResolvedValueOnce(finalRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationCarrierSourceRows(attachedRequest),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({
      attached: true,
      revision: 2,
      deferredFailureConfirmation: true,
    });

    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now: finalAt,
      }),
    ).resolves.toMatchObject({
      marked: true,
      revision: 3,
      discoveryAttemptedAt: finalAt,
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 4 }),
      }),
    );
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discoveryAttemptedAt: finalAt }),
      }),
    );
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
  });

  it("lets a fresh authoritative probe win at the final pre-I/O mark", async () => {
    const attachedRequest = deferredConfirmationRequest();
    const finalRequest = deferredConfirmationRequest({ startedAt: now });
    const finalAt = new Date("2026-07-21T12:00:01.000Z");
    finalRequest.revision = 2;
    finalRequest.updatedAt = now;
    prismaMocks.requestFindUnique
      .mockResolvedValueOnce(attachedRequest)
      .mockResolvedValueOnce(finalRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(attachedRequest),
    );
    prismaMocks.probeFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: "success-after-attach",
        outcome: "NO_MATCH",
        observedAt: new Date("2026-07-21T12:00:00.500Z"),
      },
    ]);

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({
      attached: true,
      deferredFailureConfirmation: true,
    });
    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now: finalAt,
      }),
    ).resolves.toEqual({
      marked: false,
      reason: "monitoring_not_actionable",
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: finalAt,
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discoveryAttemptedAt: finalAt }),
      }),
    );
  });

  it("fails terminally when technical incident identity changes after deferred attach", async () => {
    const attachedRequest = deferredConfirmationRequest();
    const finalRequest = deferredConfirmationRequest({ startedAt: now });
    const finalAt = new Date("2026-07-21T12:00:01.000Z");
    finalRequest.revision = 2;
    finalRequest.batchIncident.incident.revision = 4;
    finalRequest.batchIncident.incident.updatedAt = new Date(
      "2026-07-21T12:00:00.500Z",
    );
    finalRequest.batchIncident.incident.failureFingerprint = "9".repeat(64);
    prismaMocks.requestFindUnique
      .mockResolvedValueOnce(attachedRequest)
      .mockResolvedValueOnce(finalRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(attachedRequest),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({ attached: true });
    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now: finalAt,
      }),
    ).resolves.toEqual({ marked: false, reason: "invalid_evidence" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          completedAt: finalAt,
          lastError: "invalid_evidence",
        }),
      }),
    );
  });

  it("fails closed when the current incident CAS loses at the final deferred pre-I/O mark", async () => {
    const attachedRequest = deferredConfirmationRequest();
    const finalRequest = deferredConfirmationRequest({ startedAt: now });
    const finalAt = new Date("2026-07-21T12:00:01.000Z");
    finalRequest.revision = 2;
    prismaMocks.requestFindUnique
      .mockResolvedValueOnce(attachedRequest)
      .mockResolvedValueOnce(finalRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(attachedRequest),
    );
    prismaMocks.incidentUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toMatchObject({ attached: true });
    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now: finalAt,
      }),
    ).resolves.toEqual({
      marked: false,
      reason: "incident_demand_changed",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          completedAt: finalAt,
          lastError: "incident_demand_changed",
        }),
      }),
    );
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ discoveryAttemptedAt: finalAt }),
      }),
    );
  });

  it("lets a concurrent successful probe win after the deferred provider response", async () => {
    const ownedRequest = deferredConfirmationRequest({
      startedAt: new Date("2026-07-21T11:59:10.000Z"),
    });
    ownedRequest.discoveryAttemptedAt = new Date("2026-07-21T11:59:20.000Z");
    ownedRequest.discoveryVerifiedAt = new Date("2026-07-21T11:59:30.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(ownedRequest),
    );
    prismaMocks.probeFindMany.mockResolvedValue([
      {
        id: "concurrent-success",
        outcome: "MATCH_FOUND",
        observedAt: new Date("2026-07-21T11:59:45.000Z"),
      },
    ]);

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          adapterKey: "CPS",
          availabilityCount: 0,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      completed: false,
      reason: "monitoring_not_actionable",
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      }),
    );
  });

  it.each([
    {
      label: "absent",
      terminal: false,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        ownedRequest.batchIncident.batch.summary = null;
      },
    },
    {
      label: "tampered",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        const summary = ownedRequest.batchIncident.batch.summary as {
          remediation: { attempts: Array<Record<string, unknown>> };
        };
        const attempt = summary.remediation.attempts[0];
        attempt.deferredFailureHandoffSource = {
          ...(attempt.deferredFailureHandoffSource as Record<string, unknown>),
          recordDigest: "0".repeat(64),
        };
      },
    },
    {
      label: "tampered admission",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        const summary = ownedRequest.batchIncident.batch.summary as {
          remediation: { attempts: Array<Record<string, unknown>> };
        };
        const attempt = summary.remediation.attempts[0];
        attempt.deferredFailureHandoffAdmission = {
          ...(attempt.deferredFailureHandoffAdmission as Record<
            string,
            unknown
          >),
          sourceRecordDigest: "0".repeat(64),
        };
      },
    },
    {
      label: "missing source and admission on the deferred route",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        const summary = ownedRequest.batchIncident.batch.summary as {
          remediation: { attempts: Array<Record<string, unknown>> };
        };
        const attempt = summary.remediation.attempts[0];
        delete attempt.deferredFailureHandoffSource;
        delete attempt.deferredFailureHandoffAdmission;
      },
    },
    {
      label: "consumed",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        const consumed = deferredConfirmationRequest({
          signalState: "CONSUMED",
        });
        ownedRequest.batchIncident.batch.summary =
          consumed.batchIncident.batch.summary;
      },
    },
    {
      label: "already started",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        ownedRequest.startedAt = new Date("2026-07-21T11:59:30.000Z");
      },
    },
    {
      label: "outer route drift",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        const summary = ownedRequest.batchIncident.batch.summary as {
          remediation: { allowUnchangedRuntime: boolean };
        };
        summary.remediation.allowUnchangedRuntime = false;
      },
    },
    {
      label: "technical incident revision drift",
      terminal: true,
      mutate: (
        ownedRequest: ReturnType<typeof deferredConfirmationRequest>,
      ) => {
        ownedRequest.batchIncident.incident.revision += 1;
        ownedRequest.batchIncident.incident.updatedAt = new Date(
          "2026-07-21T11:59:30.000Z",
        );
        ownedRequest.batchIncident.incident.providerFamilyKey = "DRIFTED";
      },
    },
  ])(
    "does not authenticate a $label deferred intent",
    async ({ mutate, terminal }) => {
      const ownedRequest = deferredConfirmationRequest();
      mutate(ownedRequest);
      prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);

      const result = await attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      });

      if (!terminal) {
        expect(result).toMatchObject({
          attached: true,
          deferredFailureConfirmation: false,
        });
        return;
      }
      expect(result).toEqual({ attached: false, reason: "invalid_evidence" });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "STALE",
            nextAttemptAt: null,
            completedAt: now,
            lastError: "invalid_evidence",
          }),
        }),
      );
    },
  );

  it("preserves the first execution marker across provider-path retries", async () => {
    const firstExecutionAt = new Date("2026-07-21T11:58:00.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ startedAt: firstExecutionAt }),
    );

    await attachCourseSupportVerificationProviderSnapshot({
      requestId: "request-1",
      expectedRevision: 1,
      leaseToken: "lease-1",
      runtimeVersion: releaseSha,
      purpose: "PRE_EXECUTION",
      now,
    });

    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ startedAt: firstExecutionAt }),
      }),
    );
  });

  it("preserves the owned attempt when post-discovery attachment observes learned provider metadata", async () => {
    const attemptedAt = new Date("2026-07-21T11:59:00.000Z");
    const changedCourse = course({
      bookingMetadata: { provider: "CPS", facilityId: "learned-by-discovery" },
    });
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        course: changedCourse,
        discoveryAttemptedAt: attemptedAt,
        discoveryVerifiedAt: null,
      }),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "POST_DISCOVERY",
        now,
      }),
    ).resolves.toMatchObject({
      attached: true,
      revision: 2,
      providerSnapshotFingerprint: fingerprint(changedCourse),
      discoveryAttemptedAt: attemptedAt,
      discoveryVerifiedAt: null,
    });

    const update = prismaMocks.requestUpdateMany.mock.calls.at(-1)?.[0];
    expect(update).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          providerSnapshotFingerprint: fingerprint(changedCourse),
          discoveryVerifiedAt: null,
        }),
      }),
    );
    expect(update.data).not.toHaveProperty("discoveryAttemptedAt");
  });

  it("rejects post-discovery attachment without an owned discovery attempt", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: null, discoveryVerifiedAt: null }),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "POST_DISCOVERY",
        now,
      }),
    ).resolves.toEqual({
      attached: false,
      reason: "discovery_not_attempted",
    });
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("stops provider attachment when the current course becomes private", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ course: course({ isPublic: false }) }),
    );

    await expect(
      attachCourseSupportVerificationProviderSnapshot({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        purpose: "PRE_EXECUTION",
        now,
      }),
    ).resolves.toEqual({
      attached: false,
      reason: "monitoring_not_actionable",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
    expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
  });

  it.each([
    "NOT_APPLICABLE",
    "FAILED_TERMINAL",
    "TECHNICAL_LIMITATION",
  ] as const)(
    "retains exact local-reader authority after %s hands off to independent confirmation",
    async (transition) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        assignedLocalReaderRequest({
          attemptLedger: localReaderIndependentHandoffLedger(transition),
          requestOverrides: {
            discoveryAttemptedAt: null,
            discoveryVerifiedAt: null,
          },
        }),
      );

      await expect(
        markCourseSupportVerificationDiscoveryAttempted({
          requestId: "request-1",
          expectedRevision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
          now,
        }),
      ).resolves.toMatchObject({
        marked: true,
        revision: 2,
        discoveryAttemptedAt: now,
      });
    },
  );

  it("retains a same-release STARTED event recorded just before provider attachment persisted startedAt", async () => {
    const continuedAt = new Date("2026-07-21T12:01:00.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      assignedLocalReaderRequest({
        requestOverrides: {
          startedAt: new Date("2026-07-21T12:00:30.000Z"),
          updatedAt: new Date("2026-07-21T12:00:30.000Z"),
          discoveryAttemptedAt: null,
          discoveryVerifiedAt: null,
        },
      }),
    );

    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now: continuedAt,
      }),
    ).resolves.toMatchObject({
      marked: true,
      revision: 2,
      discoveryAttemptedAt: continuedAt,
    });
  });

  it("persists a one-shot discovery attempt under the exact execution lease", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: null, discoveryVerifiedAt: null }),
    );

    await expect(
      markCourseSupportVerificationDiscoveryAttempted({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toEqual({
      marked: true,
      revision: 2,
      discoveryAttemptedAt: now,
      discoveryVerifiedAt: null,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          revision: 1,
          leaseToken: "lease-1",
          runtimeVersion: releaseSha,
        }),
        data: {
          discoveryAttemptedAt: now,
          revision: { increment: 1 },
          updatedAt: now,
        },
      }),
    );
  });

  it("marks discovery verified only after an owned attempted discovery", async () => {
    const attemptedAt = new Date("2026-07-21T11:59:00.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        revision: 2,
        discoveryAttemptedAt: attemptedAt,
        discoveryVerifiedAt: null,
      }),
    );

    await expect(
      markCourseSupportVerificationDiscoveryVerified({
        requestId: "request-1",
        expectedRevision: 2,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toEqual({
      marked: true,
      revision: 3,
      discoveryAttemptedAt: attemptedAt,
      discoveryVerifiedAt: now,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          discoveryVerifiedAt: now,
          revision: { increment: 1 },
          updatedAt: now,
        },
      }),
    );
  });

  it("rejects discovery verification when no discovery attempt was persisted", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: null, discoveryVerifiedAt: null }),
    );

    await expect(
      markCourseSupportVerificationDiscoveryVerified({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        now,
      }),
    ).resolves.toEqual({
      marked: false,
      reason: "discovery_not_attempted",
    });
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });
});

describe("course-support verification terminal evidence", () => {
  it.each(["MANUAL_DIRECT", "IDENTITY_FINAL"] as const)(
    "atomically records an independent %s factual final on the delegated batch entry",
    async (disposition) => {
      const attemptLedger = independentFactualFinalLedger(disposition);
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          batchIncident: {
            ...request().batchIncident,
            incident: incident({ attemptLedger }),
          },
        }),
      );

      const result = await completeCourseSupportVerificationFactualFinal({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        disposition,
        message: "Current independent public-page evidence is conclusive.",
        now,
      });

      expect(result).toMatchObject({
        completed: true,
        status: "SUCCEEDED",
        outcome: disposition,
      });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "request-1",
            revision: 1,
            leaseToken: "lease-1",
          }),
          data: expect.objectContaining({
            status: "SUCCEEDED",
            outcome: disposition,
            failureClass: null,
            evidence: expect.objectContaining({
              kind: "PLAYBOOK_FACTUAL_FINAL",
              disposition,
              stage: "INDEPENDENT_CONFIRMATION",
              runtimeVersion: releaseSha,
              providerExecution: false,
            }),
          }),
        }),
      );
      expect(prismaMocks.batchIncidentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "batch-incident-1",
            batchId: "batch-1",
            incidentId: "incident-1",
            cycle: 1,
            result: "PENDING",
          }),
          data: expect.objectContaining({
            result: "FINAL_DISPOSITION",
            verifiedIncidentUpdatedAt: new Date("2026-07-21T11:55:00.000Z"),
            proofSnapshot: expect.objectContaining({
              kind: "PLAYBOOK_FACTUAL_FINAL",
              disposition,
            }),
          }),
        }),
      );
    },
  );

  it("refuses factual completion without current-cycle ordered-ledger proof", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      completeCourseSupportVerificationFactualFinal({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        disposition: "MANUAL_DIRECT",
        message: "Current evidence is conclusive.",
        now,
      }),
    ).resolves.toEqual({ completed: false, reason: "invalid_evidence" });
    expect(prismaMocks.batchIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("preserves valid long provider cooldowns and drops invalid values", () => {
    expect(
      resolveCourseSupportProviderRetryNotBeforeAt({
        retryAfterSeconds: 6 * 60 * 60,
        now,
      }),
    ).toEqual(new Date("2026-07-21T18:00:00.000Z"));
    for (const retryAfterSeconds of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      Number.MAX_VALUE,
    ]) {
      expect(
        resolveCourseSupportProviderRetryNotBeforeAt({
          retryAfterSeconds,
          now,
        }),
      ).toBeNull();
    }
  });

  it("honors Retry-After without exceeding the bounded request retry horizon", () => {
    expect(
      resolveCourseSupportVerificationRetryAt({
        requestedRetryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 60 * 60,
        now,
      }),
    ).toEqual(new Date("2026-07-21T13:00:00.000Z"));
    expect(
      resolveCourseSupportVerificationRetryAt({
        requestedRetryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 25 * 60 * 60,
        now,
      }),
    ).toBeNull();
  });

  it("stores only allowlisted aggregate evidence and removes signed URLs and email", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const observation = {
      outcome: "NO_MATCH" as const,
      observedAt: now,
      providerExecution: true,
      adapterKey: "cps.public-read",
      availabilityCount: 0,
      httpStatus: 200,
      message:
        "Fetched https://book.example/tee-times?session=secret for owner@example.com",
      bookingUrl: "https://evil.example/?token=secret",
      slots: [{ startsAt: "2026-07-21T09:00:00" }],
      recipient: "owner@example.com",
    };

    const result = await completeCourseSupportVerificationRequest({
      requestId: "request-1",
      expectedRevision: 1,
      leaseToken: "lease-1",
      runtimeVersion: releaseSha,
      observation,
      now,
    });

    expect(result).toMatchObject({
      completed: true,
      status: "SUCCEEDED",
      revision: 2,
      outcome: "NO_MATCH",
    });
    const evidence =
      prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      kind: "PROVIDER_VERIFICATION",
      providerExecution: true,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH",
      providerFamilyKey: "CPS",
      availabilityCount: 0,
      httpStatus: 200,
      message: "Fetched https://book.example for [redacted-email]",
    });
    expect(evidence).not.toHaveProperty("bookingUrl");
    expect(evidence).not.toHaveProperty("slots");
    expect(evidence).not.toHaveProperty("recipient");
    expect(JSON.stringify(evidence)).not.toContain("session=secret");
  });

  it("completes an owned local-reader request after a direct SUCCEEDED ledger result", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      assignedLocalReaderRequest({
        attemptLedger: localReaderSucceededLedger(),
        requestOverrides: {
          discoveryAttemptedAt: new Date("2026-07-21T11:57:30.000Z"),
          discoveryVerifiedAt: new Date("2026-07-21T11:58:30.000Z"),
        },
      }),
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true,
          adapterKey: "local-reader.public-read",
          availabilityCount: 0,
        },
        now,
      }),
    ).resolves.toMatchObject({
      completed: true,
      status: "SUCCEEDED",
      revision: 2,
      outcome: "NO_MATCH",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          completedAt: now,
        }),
      }),
    );
  });

  it("rejects completion when the batch completed after provider execution began", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "VERIFYING",
            completedAt: now,
          },
        },
      }),
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      completed: false,
      reason: "batch_not_verifying",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying",
        }),
      }),
    );
  });

  it("rejects completion when current evidence becomes account-required", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        course: course({
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          ...currentIntelligence(),
        }),
      }),
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      completed: false,
      reason: "monitoring_not_actionable",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
  });

  it("rejects runnable completion without a coherent verified discovery", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ discoveryAttemptedAt: now, discoveryVerifiedAt: null }),
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      completed: false,
      reason: "discovery_not_verified",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "discovery_not_verified",
        }),
      }),
    );
  });

  it("rejects completion as stale when the checked provider snapshot changed", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        course: course({
          bookingMetadata: {
            provider: "CPS",
            facilityId: "changed-after-check",
          },
        }),
      }),
    );

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      completed: false,
      reason: "provider_snapshot_changed",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
  });

  it("rejects a runnable outcome unless provider I/O actually executed", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      completeCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        observation: {
          outcome: "NO_MATCH",
          observedAt: now,
          providerExecution: false,
        },
        now,
      }),
    ).rejects.toThrow("require provider execution");
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("persists a deferred Retry-After as completed one-shot STALE evidence that cannot be reclaimed", async () => {
    const ownedRequest = deferredConfirmationRequest({
      startedAt: new Date("2026-07-21T11:59:10.000Z"),
    });
    ownedRequest.discoveryAttemptedAt = new Date("2026-07-21T11:59:20.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(ownedRequest),
    );

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        retryAfterSeconds: 60 * 60,
        observation: {
          outcome: "FETCH_FAILED",
          observedAt: now,
          providerExecution: true,
          httpStatus: 429,
        },
        now,
      }),
    ).resolves.toEqual({
      failed: true,
      status: "STALE",
      revision: 2,
      nextAttemptAt: null,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          evidence: expect.objectContaining({
            providerExecution: true,
            providerRetryNotBeforeAt: "2026-07-21T13:00:00.000Z",
          }),
        }),
      }),
    );

    prismaMocks.requestUpdateMany.mockClear();
    prismaMocks.requestFindUnique.mockResolvedValue({
      ...ownedRequest,
      status: "STALE",
      revision: 2,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      completedAt: now,
    });
    await expect(
      claimCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 2,
        runtimeVersion: releaseSha,
        now: new Date("2026-07-21T12:30:00.000Z"),
      }),
    ).resolves.toEqual({ claimed: false, reason: "not_due" });
    expect(prismaMocks.requestUpdateMany).not.toHaveBeenCalled();
  });

  it("invalidates a deferred failure when an authoritative successful probe wins after provider I/O", async () => {
    const ownedRequest = deferredConfirmationRequest({
      startedAt: new Date("2026-07-21T11:59:10.000Z"),
    });
    ownedRequest.discoveryAttemptedAt = new Date("2026-07-21T11:59:20.000Z");
    prismaMocks.requestFindUnique.mockResolvedValue(ownedRequest);
    prismaMocks.sourceBatchIncidentFindMany.mockResolvedValue(
      deferredConfirmationSourceRows(ownedRequest),
    );
    prismaMocks.probeFindMany.mockResolvedValue([
      {
        id: "winner-after-provider-read",
        outcome: "NO_MATCH",
        observedAt: new Date("2026-07-21T11:59:50.000Z"),
      },
    ]);

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAfterSeconds: 60 * 60,
        observation: {
          outcome: "FETCH_FAILED",
          observedAt: now,
          providerExecution: true,
          httpStatus: 429,
        },
        now,
      }),
    ).resolves.toEqual({
      failed: false,
      reason: "monitoring_not_actionable",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledOnce();
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
    expect(
      prismaMocks.requestUpdateMany.mock.calls[0][0].data,
    ).not.toHaveProperty("evidence");
  });

  it("persists a retry after an owned local-reader STARTED event under a technical-final gate", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      assignedLocalReaderRequest(),
    );
    const retryAt = new Date("2026-07-21T12:20:00.000Z");

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "NETWORK",
        message: "local reader network failure",
        retryAt,
        observation: {
          outcome: "FETCH_FAILED",
          observedAt: now,
          providerExecution: false,
        },
        now,
      }),
    ).resolves.toEqual({
      failed: true,
      status: "RETRYABLE_FAILED",
      revision: 2,
      nextAttemptAt: retryAt,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          nextAttemptAt: retryAt,
          completedAt: null,
        }),
      }),
    );
  });

  it("persists a bounded retry without calling it successful", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const retryAt = new Date("2026-07-21T12:30:00.000Z");

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "TIMEOUT",
        message:
          "request timed out at https://book.example/?token=secret session=bare-secret",
        retryAt,
        now,
      }),
    ).resolves.toEqual({
      failed: true,
      status: "RETRYABLE_FAILED",
      revision: 2,
      nextAttemptAt: retryAt,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          nextAttemptAt: retryAt,
          failureClass: "TIMEOUT",
          lastError:
            "request timed out at https://book.example [redacted-credential]",
        }),
      }),
    );
    const evidence =
      prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).toMatchObject({
      kind: "PROVIDER_VERIFICATION",
      providerExecution: false,
      outcome: "FETCH_FAILED",
    });
  });

  it("never retries before the provider Retry-After cooldown", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 60 * 60,
        now,
      }),
    ).resolves.toMatchObject({
      failed: true,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: new Date("2026-07-21T13:00:00.000Z"),
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: new Date("2026-07-21T13:00:00.000Z"),
        }),
      }),
    );
    expect(
      prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence,
    ).toMatchObject({
      providerRetryNotBeforeAt: "2026-07-21T13:00:00.000Z",
    });
  });

  it("preserves a provider cooldown beyond the request retry horizon", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt: new Date("2026-07-21T12:15:00.000Z"),
        retryAfterSeconds: 48 * 60 * 60,
        now,
      }),
    ).resolves.toEqual({
      failed: true,
      status: "STALE",
      revision: 2,
      nextAttemptAt: null,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          completedAt: now,
          evidence: expect.objectContaining({
            providerRetryNotBeforeAt: "2026-07-23T12:00:00.000Z",
          }),
        }),
      }),
    );
  });

  it("ignores a non-finite provider cooldown without losing a valid retry", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    const retryAt = new Date("2026-07-21T12:15:00.000Z");

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "RATE_LIMIT",
        message: "provider rate limit",
        retryAt,
        retryAfterSeconds: Number.POSITIVE_INFINITY,
        now,
      }),
    ).resolves.toMatchObject({
      failed: true,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: retryAt,
    });
    const evidence =
      prismaMocks.requestUpdateMany.mock.calls[0][0].data.evidence;
    expect(evidence).not.toHaveProperty("providerRetryNotBeforeAt");
  });

  it("stores current failure evidence without retrying beyond the request lifetime", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({ createdAt: new Date("2026-07-20T12:30:00.000Z") }),
    );

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "NETWORK",
        message: "network failure",
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        observation: {
          outcome: "FETCH_FAILED",
          observedAt: now,
          providerExecution: true,
        },
        now,
      }),
    ).resolves.toEqual({
      failed: true,
      status: "STALE",
      revision: 2,
      nextAttemptAt: null,
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          nextAttemptAt: null,
          outcome: "FETCH_FAILED",
          failureClass: "NETWORK",
          completedAt: now,
        }),
      }),
    );
  });

  it("keeps responder playbook retries active after real demand appears", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(request());
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      failCourseSupportVerificationRequest({
        requestId: "request-1",
        expectedRevision: 1,
        leaseToken: "lease-1",
        runtimeVersion: releaseSha,
        failureClass: "NETWORK",
        message: "network failure",
        retryAt: new Date("2026-07-21T12:30:00.000Z"),
        now,
      }),
    ).resolves.toMatchObject({
      failed: true,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: new Date("2026-07-21T12:30:00.000Z"),
    });
  });

  it("invalidates an earlier success when any active future pair now exists", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        completedAt: now,
      }),
    );
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({ eligible: false, reason: "active_demand" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revision: 2, status: "SUCCEEDED" }),
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
  });

  it("returns exact-release eligible proof without exposing workflow or lease state", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        completedAt: now,
      }),
    );

    const proof = await getEligibleCourseSupportVerificationProof({
      batchIncidentId: "batch-incident-1",
      releaseSha,
      now,
    });

    expect(proof).toMatchObject({
      eligible: true,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH",
      completedAt: now,
    });
    expect(proof).not.toHaveProperty("workflowRunId");
    expect(proof).not.toHaveProperty("leaseToken");
    expect(proof).not.toHaveProperty("courseId");
  });

  it("returns exact owned local-reader proof after a direct SUCCEEDED ledger result", async () => {
    const successfulRequest = assignedLocalReaderRequest({
      attemptLedger: localReaderSucceededLedger(),
      requestOverrides: {
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        outcome: "NO_MATCH",
        completedAt: now,
        updatedAt: now,
        discoveryAttemptedAt: new Date("2026-07-21T11:57:30.000Z"),
        discoveryVerifiedAt: new Date("2026-07-21T11:58:30.000Z"),
      },
    });
    successfulRequest.evidence = {
      ...verificationEvidence(),
      providerSnapshotFingerprint:
        successfulRequest.providerSnapshotFingerprint,
    };
    prismaMocks.requestFindUnique.mockResolvedValue(successfulRequest);

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      eligible: true,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH",
      completedAt: now,
    });
  });

  it("keeps active-demand proof fencing for an owned local-reader success", async () => {
    const successfulRequest = assignedLocalReaderRequest({
      attemptLedger: localReaderSucceededLedger(),
      requestOverrides: {
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        outcome: "NO_MATCH",
        completedAt: now,
        updatedAt: now,
        discoveryAttemptedAt: new Date("2026-07-21T11:57:30.000Z"),
        discoveryVerifiedAt: new Date("2026-07-21T11:58:30.000Z"),
      },
    });
    successfulRequest.evidence = {
      ...verificationEvidence(),
      providerSnapshotFingerprint:
        successfulRequest.providerSnapshotFingerprint,
    };
    prismaMocks.requestFindUnique.mockResolvedValue(successfulRequest);
    prismaMocks.activeSearchCount.mockResolvedValue(1);

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({ eligible: false, reason: "active_demand" });
  });

  it.each([
    {
      label: "private identity",
      courseOverrides: { isPublic: false },
    },
    {
      label: "current account requirement",
      courseOverrides: {
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        ...currentIntelligence(),
      },
    },
    {
      label: "current CAPTCHA or queue",
      courseOverrides: {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        ...currentIntelligence(),
      },
    },
    {
      label: "current manual booking disposition",
      courseOverrides: {
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        ...currentIntelligence(),
      },
    },
  ])(
    "invalidates prior runnable proof after a $label change",
    async ({ courseOverrides }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          status: "SUCCEEDED",
          revision: 2,
          leaseToken: null,
          leaseExpiresAt: null,
          outcome: "NO_MATCH",
          evidence: verificationEvidence(),
          course: course(courseOverrides),
          completedAt: now,
        }),
      );

      await expect(
        getEligibleCourseSupportVerificationProof({
          batchIncidentId: "batch-incident-1",
          releaseSha,
          now,
        }),
      ).resolves.toEqual({
        eligible: false,
        reason: "monitoring_not_actionable",
      });
      expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "STALE",
            lastError: "monitoring_not_actionable",
          }),
        }),
      );
      expect(prismaMocks.activeSearchCount).not.toHaveBeenCalled();
    },
  );

  it("invalidates runnable proof that bypassed verified discovery", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: verificationEvidence(),
        discoveryAttemptedAt: now,
        discoveryVerifiedAt: null,
        completedAt: now,
      }),
    );

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      eligible: false,
      reason: "discovery_not_verified",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "discovery_not_verified",
        }),
      }),
    );
  });

  it.each([
    { status: "RETRYABLE_FAILED" as const, completedAt: null },
    { status: "STALE" as const, completedAt: now },
  ])(
    "returns bounded current failure evidence from $status without treating it as proof",
    async ({ status, completedAt }) => {
      prismaMocks.requestFindUnique.mockResolvedValue(
        request({
          status,
          revision: 2,
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt:
            status === "RETRYABLE_FAILED"
              ? new Date("2026-07-21T12:30:00.000Z")
              : null,
          outcome: "FETCH_FAILED",
          failureClass: "AUTH",
          evidence: {
            ...verificationEvidence("FETCH_FAILED", true),
            failureClass: "AUTH",
            httpStatus: 403,
            providerRetryNotBeforeAt: "2026-07-23T12:00:00.000Z",
            message: "Public provider availability verification failed.",
          },
          completedAt,
        }),
      );

      const failure = await getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      });

      expect(failure).toMatchObject({
        current: true,
        releaseSha,
        runtimeVersion: releaseSha,
        status,
        outcome: "FETCH_FAILED",
        failureClass: "AUTH",
        providerExecution: true,
        observedAt: now,
        providerRetryNotBeforeAt: new Date("2026-07-23T12:00:00.000Z"),
      });
      expect(failure).not.toHaveProperty("courseId");
      expect(failure).not.toHaveProperty("workflowRunId");
      expect(failure).not.toHaveProperty("leaseToken");
    },
  );

  it("returns STALE failure evidence under exact owned local-reader authority", async () => {
    const failedRequest = assignedLocalReaderRequest({
      attemptLedger: localReaderFailedRetryableLedger(),
      requestOverrides: {
        status: "STALE",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        completedAt: now,
        updatedAt: now,
      },
    });
    failedRequest.evidence = {
      ...verificationEvidence("FETCH_FAILED", false),
      failureClass: "NETWORK",
      providerSnapshotFingerprint: failedRequest.providerSnapshotFingerprint,
    };
    prismaMocks.requestFindUnique.mockResolvedValue(failedRequest);

    await expect(
      getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toMatchObject({
      current: true,
      status: "STALE",
      outcome: "FETCH_FAILED",
      failureClass: "NETWORK",
      providerExecution: false,
    });
  });

  it("invalidates current failure evidence after a verified manual disposition", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "RETRYABLE_FAILED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-07-21T12:30:00.000Z"),
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        evidence: {
          ...verificationEvidence("FETCH_FAILED", true),
          failureClass: "NETWORK",
        },
        course: course({
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          ...currentIntelligence(),
        }),
      }),
    );

    await expect(
      getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({
      current: false,
      reason: "monitoring_not_actionable",
    });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "monitoring_not_actionable",
        }),
      }),
    );
  });

  it("invalidates current failure evidence after batch ownership ends", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "RETRYABLE_FAILED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date("2026-07-21T12:30:00.000Z"),
        outcome: "FETCH_FAILED",
        failureClass: "NETWORK",
        evidence: {
          ...verificationEvidence("FETCH_FAILED", true),
          failureClass: "NETWORK",
        },
        batchIncident: {
          ...request().batchIncident,
          batch: {
            ...request().batchIncident.batch,
            status: "RETRYABLE_FAILED",
          },
        },
      }),
    );

    await expect(
      getCurrentCourseSupportVerificationFailure({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({ current: false, reason: "batch_not_verifying" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_not_verifying",
        }),
      }),
    );
  });

  it("invalidates a success whose stored proof contract is incoherent", async () => {
    prismaMocks.requestFindUnique.mockResolvedValue(
      request({
        status: "SUCCEEDED",
        revision: 2,
        leaseToken: null,
        leaseExpiresAt: null,
        outcome: "NO_MATCH",
        evidence: {
          ...verificationEvidence(),
          providerExecution: false,
        },
        completedAt: now,
      }),
    );

    await expect(
      getEligibleCourseSupportVerificationProof({
        batchIncidentId: "batch-incident-1",
        releaseSha,
        now,
      }),
    ).resolves.toEqual({ eligible: false, reason: "invalid_evidence" });
    expect(prismaMocks.requestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "STALE" }),
      }),
    );
  });
});
