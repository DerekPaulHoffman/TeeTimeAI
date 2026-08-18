import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  batchFindFirst: vi.fn(),
  batchFindMany: vi.fn(),
  batchFindUnique: vi.fn(),
  batchCreate: vi.fn(),
  batchUpdateMany: vi.fn(),
  batchIncidentCreateMany: vi.fn(),
  supportIncidentFindMany: vi.fn(),
  supportIncidentFindUnique: vi.fn(),
  incidentUpdateMany: vi.fn(),
  supportIncidentUpdateMany: vi.fn(),
  automationRunFindFirst: vi.fn(),
  automationRunCreate: vi.fn(),
  courseProbeFindMany: vi.fn(),
  verificationRequestFindUnique: vi.fn(),
  verificationRequestFindMany: vi.fn(),
  verificationRequestUpdateMany: vi.fn(),
  monitoringStatusUpdateMany: vi.fn(),
  monitoringStatusFindUnique: vi.fn(),
  monitoringEventCreate: vi.fn(),
  monitoringEventCreateMany: vi.fn(),
  automationRunUpdateMany: vi.fn(),
  teeSearchCount: vi.fn(),
  teeSearchUpdateMany: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn()
}));
const verificationMocks = vi.hoisted(() => ({
  buildCourseSupportProviderSnapshotFingerprint: vi.fn(),
  getCurrentCourseSupportVerificationFailure: vi.fn(),
  getEligibleCourseSupportVerificationProof: vi.fn(),
  isCourseSupportFactualFinalProof: vi.fn(),
  scheduleCourseSupportVerificationRequests: vi.fn()
}));
const leaseMocks = vi.hoisted(() => ({
  withPostgresAdvisoryTextLease: vi.fn()
}));
const supportIncidentMocks = vi.hoisted(() => ({
  resolveCourseSupportIncident: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    courseSupportBatch: {
      findFirst: prismaMocks.batchFindFirst,
      findMany: prismaMocks.batchFindMany,
      findUnique: prismaMocks.batchFindUnique,
      updateMany: prismaMocks.batchUpdateMany
    },
    courseSupportIncident: { findMany: prismaMocks.supportIncidentFindMany },
    courseProbe: { findMany: prismaMocks.courseProbeFindMany },
    courseSupportVerificationRequest: {
      findMany: prismaMocks.verificationRequestFindMany
    },
    automationRun: {
      findFirst: prismaMocks.automationRunFindFirst,
      create: prismaMocks.automationRunCreate,
      updateMany: prismaMocks.automationRunUpdateMany
    },
    $transaction: prismaMocks.transaction
  }
}));

vi.mock("./course-support-verification", () => verificationMocks);
vi.mock("./lease", () => leaseMocks);
vi.mock("./support-incidents", () => supportIncidentMocks);

import { appendAutomationPlaybookEvent } from "./course-monitoring-playbook";
import { hasDurableAutomationStalledEndpointProof } from "../customer-monitoring-status";
import { buildProviderFailureFingerprint } from "./provider-capabilities";

import {
  appendCourseSupportBatchPath,
  assessCourseSupportRecovery,
  assessCourseSupportReleaseTransition,
  buildFailureFingerprint,
  buildCourseSupportReleaseHistory,
  canAppendCourseSupportBatchPath,
  canCloseCourseSupportRetry,
  canSafelyRequeueExpiredCourseSupportBatch,
  chooseCourseSupportReleaseDiffBase,
  chooseNewestProviderVerificationEvidence,
  classifyCourseSupportQueueInspection,
  classifyDetachedVerificationFailure,
  classifyDetachedVerificationEvidence,
  classifyFreshBatchEvidence,
  claimCourseSupportBatch,
  closeoutCourseSupportBatch,
  canVerifyUnchangedCourseSupportRuntime,
  collectFreshRemediatedCourseProof,
  computeCourseSupportNextAttemptAt,
  courseSupportRecoveryBatchesConflict,
  deriveCourseSupportCurrentDemand,
  findConflictingResponderPaths,
  getCourseSupportBatchPacket,
  heartbeatCourseSupportBatch,
  inspectCourseSupportQueue,
  isDurableTerminalProof,
  isRetryableCourseSupportWriteConflict,
  isRemediatedSearchSchedulerHealthy,
  markCourseSupportBatchNeedsHuman,
  normalizeCourseSupportObservedGitPaths,
  orderCourseSupportBatchIncidents,
  preserveExplicitHumanVerification,
  recoverCourseSupportBatch,
  renewCourseSupportBatchOperationLease,
  resolveCourseSupportProviderCapability,
  selectCourseSupportBatch,
  selectCourseSupportRetryBatch,
  shouldDispatchRemediatedCourseRechecks,
  shouldFinalizeSourceUnverified,
  shouldContinueSettledCourseSupportRemediation,
  verifyCourseSupportBatch,
  withCourseSupportWriteConflictRetry,
  type CourseSupportCandidate,
  type CourseSupportRetryBatchEvidence
} from "./course-support-batches";

const now = new Date("2026-07-15T20:00:00.000Z");

function exhaustedAttemptLedger(cycle = 1) {
  let ledger: unknown = null;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "NO_PROVIDER_METADATA"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "NO_RUNNABLE_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "NO_PROVIDER_METADATA"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "NO_BROWSER_ROUTE"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["LOCAL_READER", "LOCAL_READER", "NO_LOCAL_READER_CAPABILITY"],
    ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION", "NO_INDEPENDENT_CONFIRMATION"]
  ] as const;
  for (const [stage, readPath, skipReason] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      failureFingerprint: "TEST:EXHAUSTED",
      runtimeVersion: "test-runtime",
      skipReason,
      observedAt: now
    });
  }
  return ledger;
}

function browserReadyAttemptLedger(cycle = 1) {
  let ledger: unknown = null;
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "TEST:OFFICIAL_IDENTITY:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt: now
  });
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "TYPED_ADAPTER",
    transition: "NOT_APPLICABLE",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "TOOLING",
    failureFingerprint: "TEST:TYPED_ADAPTER:SKIPPED",
    runtimeVersion: "test-runtime",
    skipReason: "NO_RUNNABLE_ADAPTER",
    observedAt: now
  });
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "OFFICIAL_HTTP_DISCOVERY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_HTTP",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: "TEST:OFFICIAL_HTTP:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt: now
  });
  return appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "HTTP_ADAPTER_RETRY",
    transition: "NOT_APPLICABLE",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "TOOLING",
    failureFingerprint: "TEST:HTTP_ADAPTER_RETRY:SKIPPED",
    runtimeVersion: "test-runtime",
    skipReason: "NO_RUNNABLE_ADAPTER",
    observedAt: now
  });
}

function independentReadyAttemptLedger(cycle = 1) {
  let ledger: unknown = browserReadyAttemptLedger(cycle);
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "RENDERED_BROWSER_DISCOVERY",
    transition: "COMPLETED",
    readPath: "RENDERED_BROWSER",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: "TEST:RENDERED_BROWSER:COMPLETE",
    runtimeVersion: "test-runtime",
    observedAt: now
  });
  ledger = appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "BROWSER_ADAPTER_RETRY",
    transition: "NOT_APPLICABLE",
    readPath: "TYPED_PROVIDER_ADAPTER",
    evidenceKind: "TOOLING",
    failureFingerprint: "TEST:BROWSER_ADAPTER_RETRY:SKIPPED",
    runtimeVersion: "test-runtime",
    skipReason: "NO_RUNNABLE_ADAPTER",
    observedAt: now
  });
  return appendAutomationPlaybookEvent(ledger, {
    cycle,
    stage: "LOCAL_READER",
    transition: "FAILED_TERMINAL",
    readPath: "LOCAL_READER",
    evidenceKind: "LOCAL_READER_RESULT",
    failureFingerprint: "TEST:LOCAL_READER:TERMINAL",
    runtimeVersion: "test-runtime",
    failureClass: "UNKNOWN",
    observedAt: now
  });
}

function factualFinalLedger(disposition: "MANUAL_DIRECT" | "IDENTITY_FINAL") {
  let ledger: unknown = null;
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "NO_PROVIDER_METADATA"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "NO_RUNNABLE_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "NO_PROVIDER_METADATA"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "NO_BROWSER_ROUTE"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NO_METADATA_CHANGE"],
    ["LOCAL_READER", "LOCAL_READER", "NO_LOCAL_READER_CAPABILITY"]
  ] as const;
  for (const [stage, readPath, skipReason] of stages) {
    ledger = appendAutomationPlaybookEvent(ledger, {
      cycle: 1,
      stage,
      transition: "NOT_APPLICABLE",
      readPath,
      evidenceKind: "TOOLING",
      failureFingerprint: `PLAYBOOK:${stage}:${skipReason}`,
      runtimeVersion: "a".repeat(40),
      skipReason,
      observedAt: new Date("2026-07-15T20:05:30.000Z")
    });
  }
  return appendAutomationPlaybookEvent(ledger, {
    cycle: 1,
    stage: "INDEPENDENT_CONFIRMATION",
    transition: "FACTUAL_FINAL",
    readPath: "INDEPENDENT_CONFIRMATION",
    evidenceKind: "RENDERED_PAGE",
    failureFingerprint: `PLAYBOOK:INDEPENDENT_CONFIRMATION:${disposition}`,
    runtimeVersion: "a".repeat(40),
    factualDisposition: disposition,
    observedAt: new Date("2026-07-15T20:06:00.000Z")
  });
}

describe("course-support path planning", () => {
  it("rejects exact and provider-family code scope collisions", () => {
    expect(
      findConflictingResponderPaths(
        [
          "src/lib/tee-times/adapters/cps/normalize.ts",
          "src/lib/automation/course-support-batches.ts",
          "docs/course-support-responder.md"
        ],
        ["src/lib/tee-times/adapters/cps/fetch.ts", "src/lib/automation/course-support-batches.ts"]
      )
    ).toEqual([
      "src/lib/automation/course-support-batches.ts",
      "src/lib/tee-times/adapters/cps/normalize.ts"
    ]);
  });

  it("keeps unrelated provider and documentation scopes independent", () => {
    expect(
      findConflictingResponderPaths(
        ["src/lib/tee-times/adapters/chronogolf/fetch.ts", "docs/course-support-responder.md"],
        ["src/lib/tee-times/adapters/cps/fetch.ts"]
      )
    ).toEqual([]);
  });

  it("blocks recovery only for matching provider, fingerprint, or code scope", () => {
    const recovering = {
      providerFamilyKey: "CPS",
      failureFingerprint: "cps-timeout",
      summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
    };
    expect(
      courseSupportRecoveryBatchesConflict(recovering, {
        providerFamilyKey: "CPS",
        failureFingerprint: "different-failure",
        summary: { plannedPaths: [] }
      })
    ).toBe(true);
    expect(
      courseSupportRecoveryBatchesConflict(recovering, {
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "cps-timeout",
        summary: { plannedPaths: [] }
      })
    ).toBe(true);
    expect(
      courseSupportRecoveryBatchesConflict(recovering, {
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "chronogolf-schema",
        summary: {
          plannedPaths: ["src/lib/tee-times/adapters/cps/normalize.ts"]
        }
      })
    ).toBe(true);
    expect(
      courseSupportRecoveryBatchesConflict(recovering, {
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "chronogolf-schema",
        summary: {
          plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"]
        }
      })
    ).toBe(false);
  });

  it("reopens only an unreleased verifying batch whose original plan was empty", () => {
    expect(
      canAppendCourseSupportBatchPath({
        status: "VERIFYING",
        releaseSha: null,
        plannedPaths: []
      })
    ).toBe(true);
    expect(
      canAppendCourseSupportBatchPath({
        status: "VERIFYING",
        releaseSha: "a".repeat(40),
        plannedPaths: []
      })
    ).toBe(false);
    expect(
      canAppendCourseSupportBatchPath({
        status: "VERIFYING",
        releaseSha: null,
        plannedPaths: ["src/lib/adapters/teeitup.ts"]
      })
    ).toBe(false);
  });

  it.each(["CLAIMED", "IMPLEMENTING"] as const)(
    "keeps ordinary %s path planning available",
    (status) => {
      expect(
        canAppendCourseSupportBatchPath({
          status,
          releaseSha: null,
          plannedPaths: []
        })
      ).toBe(true);
    }
  );
});

describe("course-support write-conflict retry", () => {
  it("recognizes Prisma serialization and Postgres deadlock failures", () => {
    expect(isRetryableCourseSupportWriteConflict({ code: "P2034" })).toBe(true);
    expect(isRetryableCourseSupportWriteConflict({ code: "40P01" })).toBe(true);
    expect(
      isRetryableCourseSupportWriteConflict(new Error("deadlock detected while writing"))
    ).toBe(true);
    expect(isRetryableCourseSupportWriteConflict(new Error("request timed out"))).toBe(false);
  });

  it("retries a bounded number of rolled-back write conflicts", async () => {
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034"
    });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue("persisted");
    const sleep = vi.fn(async () => undefined);

    await expect(withCourseSupportWriteConflictRetry(operation, { sleep })).resolves.toBe(
      "persisted"
    );
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 25);
    expect(sleep).toHaveBeenNthCalledWith(2, 50);
  });

  it("does not retry an ownership or validation failure", async () => {
    const operation = vi.fn(async () => {
      throw new Error("Responder ownership changed.");
    });
    const sleep = vi.fn(async () => undefined);

    await expect(withCourseSupportWriteConflictRetry(operation, { sleep })).rejects.toThrow(
      "ownership changed"
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

const transactionClient = {
  $queryRaw: prismaMocks.queryRaw,
  automationRun: {
    create: prismaMocks.automationRunCreate,
    updateMany: prismaMocks.automationRunUpdateMany
  },
  courseSupportBatch: {
    create: prismaMocks.batchCreate,
    findFirst: prismaMocks.batchFindFirst,
    findMany: prismaMocks.batchFindMany,
    updateMany: prismaMocks.batchUpdateMany
  },
  courseSupportBatchIncident: {
    createMany: prismaMocks.batchIncidentCreateMany,
    updateMany: prismaMocks.incidentUpdateMany
  },
  courseSupportIncident: {
    findMany: prismaMocks.supportIncidentFindMany,
    findUnique: prismaMocks.supportIncidentFindUnique,
    updateMany: prismaMocks.supportIncidentUpdateMany
  },
  courseSupportVerificationRequest: {
    findUnique: prismaMocks.verificationRequestFindUnique,
    findMany: prismaMocks.verificationRequestFindMany,
    updateMany: prismaMocks.verificationRequestUpdateMany
  },
  courseMonitoringStatus: {
    findUnique: prismaMocks.monitoringStatusFindUnique,
    updateMany: prismaMocks.monitoringStatusUpdateMany
  },
  teeSearch: {
    count: prismaMocks.teeSearchCount,
    updateMany: prismaMocks.teeSearchUpdateMany
  }
};

const monitoringTransactionClient = {
  ...transactionClient,
  courseMonitoringEvent: {
    create: prismaMocks.monitoringEventCreate,
    createMany: prismaMocks.monitoringEventCreateMany
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.transaction.mockImplementation(
    async (worker: (transaction: typeof transactionClient) => Promise<unknown>) =>
      worker(transactionClient)
  );
  verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue({
    eligible: false,
    reason: "not_found"
  });
  verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue({
    current: false,
    reason: "not_found"
  });
  verificationMocks.scheduleCourseSupportVerificationRequests.mockResolvedValue({
    createdCount: 0,
    eligibleCount: 0,
    ineligibleCount: 0,
    requests: []
  });
  verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue("b".repeat(64));
  verificationMocks.isCourseSupportFactualFinalProof.mockReturnValue(true);
  prismaMocks.verificationRequestFindMany.mockResolvedValue([]);
  prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 0 });
  prismaMocks.monitoringStatusUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.monitoringStatusFindUnique.mockResolvedValue(null);
  prismaMocks.monitoringEventCreate.mockResolvedValue({
    id: "monitoring-event-1"
  });
  prismaMocks.monitoringEventCreateMany.mockResolvedValue({ count: 1 });
  prismaMocks.automationRunUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.teeSearchCount.mockResolvedValue(0);
  prismaMocks.supportIncidentFindMany.mockResolvedValue([]);
  prismaMocks.supportIncidentFindUnique.mockResolvedValue(null);
  prismaMocks.batchFindFirst.mockResolvedValue(null);
  prismaMocks.batchFindMany.mockResolvedValue([]);
  prismaMocks.batchFindUnique.mockResolvedValue(null);
  prismaMocks.batchCreate.mockResolvedValue({
    id: "batch-1",
    reference: "batch-reference"
  });
  prismaMocks.batchIncidentCreateMany.mockResolvedValue({ count: 1 });
  prismaMocks.queryRaw.mockResolvedValue([{ now }]);
  prismaMocks.courseProbeFindMany.mockResolvedValue([]);
  prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
  prismaMocks.automationRunFindFirst.mockResolvedValue(null);
  prismaMocks.automationRunCreate.mockResolvedValue({ id: "routine-run" });
  leaseMocks.withPostgresAdvisoryTextLease.mockImplementation(
    async (_client: unknown, _key: string, worker: () => Promise<unknown>) => ({
      acquired: true,
      value: await worker()
    })
  );
});

function candidate(overrides: Partial<CourseSupportCandidate> = {}): CourseSupportCandidate {
  return {
    id: "incident-1",
    courseId: "course-1",
    cycle: 1,
    kind: "NEEDS_ADAPTER",
    providerFamilyKey: "CHRONOGOLF",
    failureClass: "UNSUPPORTED_FAMILY",
    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
    humanReviewReason: null,
    engineeringOnly: true,
    activeRealSearchCount: 0,
    earliestTargetDate: null,
    escalationDeadlineAt: null,
    endpointHumanReviewProven: false,
    firstSeenAt: new Date("2026-07-14T18:00:00.000Z"),
    lastSeenAt: new Date("2026-07-15T18:00:00.000Z"),
    lastAttemptAt: null,
    nextAttemptAt: new Date("2026-07-15T19:30:00.000Z"),
    attemptCount: 0,
    updatedAt: new Date("2026-07-15T18:00:00.000Z"),
    ...overrides
  };
}

function retryBatchEvidence(
  intended: CourseSupportCandidate,
  overrides: Partial<CourseSupportRetryBatchEvidence> = {}
): CourseSupportRetryBatchEvidence {
  const batchIncidentId = `batch-entry-${intended.id}`;
  return {
    status: "RETRYABLE_FAILED",
    completedAt: new Date("2026-07-15T19:00:00.000Z"),
    summary: { closeout: { outcome: "retryable_failed" } },
    providerFamilyKey: intended.providerFamilyKey,
    failureFingerprint: intended.failureFingerprint,
    incidents: [
      {
        id: batchIncidentId,
        incidentId: intended.id,
        courseId: intended.courseId,
        cycle: intended.cycle,
        result: "RETRY_SCHEDULED",
        incident: {
          batchIncidents: [{ id: batchIncidentId, cycle: intended.cycle }]
        }
      }
    ],
    ...overrides
  };
}

function retryBatchEntry(intended: CourseSupportCandidate) {
  return retryBatchEvidence(intended).incidents[0];
}

describe("course-support batch selection", () => {
  it("deduplicates live demand and keeps its earliest target date", () => {
    expect(
      deriveCourseSupportCurrentDemand([
        {
          teeSearch: {
            id: "search-2",
            date: new Date("2026-07-20T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "search-1",
            date: new Date("2026-07-18T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "search-1",
            date: new Date("2026-07-18T00:00:00.000Z")
          }
        }
      ])
    ).toEqual({
      activeRealSearchCount: 2,
      earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
    });
    expect(deriveCourseSupportCurrentDemand([])).toEqual({
      activeRealSearchCount: 0,
      earliestTargetDate: null
    });
  });

  it("keeps a same-day western search current across the UTC date rollover", () => {
    const currentDemand = deriveCourseSupportCurrentDemand(
      [
        {
          teeSearch: {
            id: "same-local-day",
            date: new Date("2026-07-20T00:00:00.000Z")
          }
        },
        {
          teeSearch: {
            id: "previous-local-day",
            date: new Date("2026-07-19T00:00:00.000Z")
          }
        }
      ],
      {
        timeZone: "America/Los_Angeles",
        now: new Date("2026-07-21T01:00:00.000Z")
      }
    );

    expect(currentDemand).toEqual({
      activeRealSearchCount: 1,
      earliestTargetDate: new Date("2026-07-20T00:00:00.000Z")
    });
  });

  it("prioritizes a near-date real fetch failure", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({ id: "synthetic", courseId: "course-synthetic" }),
        candidate({
          id: "real",
          courseId: "course-real",
          kind: "FETCH_FAILED",
          failureClass: "NETWORK",
          failureFingerprint: "v1:NETWORK:FETCH_FAILED",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
        })
      ],
      now
    });

    expect(selected).toMatchObject({
      failureFingerprint: "v1:NETWORK:FETCH_FAILED",
      containsCriticalRealDemand: true
    });
    expect(selected?.incidents.map((incident) => incident.id)).toEqual(["real"]);
  });

  it("keeps aged synthetic fairness eligible beside already-escalated noncritical demand", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({
          id: "real",
          courseId: "course-real",
          providerFamilyKey: "FOREUP",
          failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          endpointHumanReviewProven: true,
          firstSeenAt: new Date("2026-07-15T18:00:00.000Z")
        }),
        candidate({
          id: "aged-synthetic",
          courseId: "course-synthetic",
          providerFamilyKey: "CHRONOGOLF",
          firstSeenAt: new Date("2026-07-13T18:00:00.000Z")
        })
      ],
      recentBatches: Array.from({ length: 3 }, () => ({
        includedEngineeringOnly: false,
        includedCriticalRealDemand: false
      })),
      now
    });

    expect(selected).toMatchObject({
      providerFamilyKey: "CHRONOGOLF",
      fairnessReason: "AGED_SYNTHETIC_RESERVATION"
    });
  });

  it("prioritizes the nearest customer escalation deadline over older real-demand work", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({
          id: "older-real",
          courseId: "older-real-course",
          providerFamilyKey: "OLDER",
          failureFingerprint: "older-failure",
          engineeringOnly: false,
          activeRealSearchCount: 2,
          escalationDeadlineAt: new Date("2026-07-15T20:25:00.000Z"),
          firstSeenAt: new Date("2026-07-15T18:00:00.000Z")
        }),
        candidate({
          id: "new-alert",
          courseId: "new-alert-course",
          providerFamilyKey: "NEW_ALERT",
          failureFingerprint: "new-alert-failure",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          escalationDeadlineAt: new Date("2026-07-15T20:10:00.000Z"),
          firstSeenAt: new Date("2026-07-15T19:55:00.000Z")
        })
      ],
      now
    });

    expect(selected?.providerFamilyKey).toBe("NEW_ALERT");
    expect(selected?.incidents.map((incident) => incident.id)).toEqual(["new-alert"]);
  });

  it("prioritizes a never-escalated customer endpoint over an earlier human-review recheck", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        candidate({
          id: "already-human-recheck",
          courseId: "already-human-course",
          cycle: 2,
          kind: "FETCH_FAILED",
          providerFamilyKey: "ALREADY_HUMAN",
          failureClass: "NETWORK",
          failureFingerprint: "already-human-failure",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-07-18T00:00:00.000Z"),
          escalationDeadlineAt: new Date("2026-07-15T20:05:00.000Z"),
          endpointHumanReviewProven: true
        }),
        candidate({
          id: "new-alert-endpoint",
          courseId: "new-alert-course",
          providerFamilyKey: "NEW_ALERT",
          failureFingerprint: "new-alert-failure",
          engineeringOnly: false,
          activeRealSearchCount: 1,
          escalationDeadlineAt: new Date("2026-07-15T20:08:00.000Z"),
          firstSeenAt: new Date("2026-07-15T19:38:00.000Z")
        })
      ],
      now
    });

    expect(selected).toMatchObject({
      providerFamilyKey: "NEW_ALERT",
      containsCriticalRealDemand: false
    });
    expect(selected?.incidents.map((incident) => incident.id)).toEqual(["new-alert-endpoint"]);
  });

  it("keeps a provider/fingerprint batch bounded at twenty", () => {
    const selected = selectCourseSupportBatch({
      candidates: Array.from({ length: 30 }, (_, index) =>
        candidate({
          id: `incident-${index}`,
          courseId: `course-${index}`
        })
      ),
      maxCourses: 100,
      now
    });

    expect(selected?.incidents).toHaveLength(20);
  });

  it("reserves bounded aged synthetic fairness beside noncritical customer work", () => {
    const selected = selectCourseSupportBatch({
      candidates: [
        ...Array.from({ length: 5 }, (_, index) =>
          candidate({
            id: `real-${index}`,
            courseId: `real-course-${index}`,
            engineeringOnly: false,
            activeRealSearchCount: 1,
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z")
          })
        ),
        candidate({
          id: "aged-synthetic",
          courseId: "synthetic-course",
          firstSeenAt: new Date("2026-07-13T18:00:00.000Z")
        })
      ],
      maxCourses: 5,
      now
    });

    expect(selected?.incidents).toHaveLength(5);
    expect(selected?.incidents.some((incident) => incident.id === "aged-synthetic")).toBe(true);
    expect(selected?.incidents.filter((incident) => incident.id.startsWith("real-"))).toHaveLength(
      4
    );
  });

  it("claims only the exact due incidents from a completed retryable batch", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      cycle: 3,
      providerFamilyKey: "BROWSER_DISCOVERY",
      failureFingerprint: "v1:MISSING_SOURCE:NEEDS_ADAPTER"
    });
    const selected = selectCourseSupportRetryBatch({
      candidates: [candidate(), intended],
      retryBatch: retryBatchEvidence(intended),
      maxCourses: 1,
      now
    });

    expect(selected).toMatchObject({
      fairnessReason: "TARGETED_RETRY",
      incidents: [{ id: "retry-incident", courseId: "retry-course" }]
    });
  });

  it("claims one exact source ordinal without requiring sibling retries to be due", () => {
    const first = candidate({ id: "retry-first", courseId: "retry-course-1" });
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course-2",
      cycle: 3
    });
    const last = candidate({ id: "retry-last", courseId: "retry-course-3" });
    const retryBatch = retryBatchEvidence(intended, {
      incidents: [retryBatchEntry(first), retryBatchEntry(intended), retryBatchEntry(last)]
    });

    expect(
      selectCourseSupportRetryBatch({
        candidates: [candidate(), intended],
        retryBatch,
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).toMatchObject({
      fairnessReason: "TARGETED_RETRY",
      incidents: [{ id: "retry-intended", courseId: "retry-course-2" }]
    });
  });

  it("fails closed for invalid exact-entry retry ordinals and batch sizes", () => {
    const intended = candidate();
    const retryBatch = retryBatchEvidence(intended);

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 0,
        maxCourses: 1,
        now
      })
    ).toThrow("positive integer");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).toThrow("out of range");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        now
      })
    ).toThrow("requires maxCourses to be 1");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        maxCourses: 0,
        now
      })
    ).toThrow("requires maxCourses to be 1");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        retryOrdinal: 1,
        maxCourses: 2,
        now
      })
    ).toThrow("requires maxCourses to be 1");
  });

  it("never falls back when the selected retry ordinal is not currently eligible", () => {
    const selected = candidate({
      id: "selected-retry",
      courseId: "selected-course"
    });
    const unrelated = candidate({
      id: "unrelated-due",
      courseId: "unrelated-course"
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [unrelated],
        retryBatch: retryBatchEvidence(selected),
        retryOrdinal: 1,
        maxCourses: 1,
        now
      })
    ).toThrow("not currently due or its provenance changed");
  });

  it("fails closed when a targeted retry is not due or its provenance changed", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      cycle: 3
    });
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [
          {
            ...intended,
            failureFingerprint: "v2:changed"
          }
        ],
        retryBatch: retryBatchEvidence(intended),
        now
      })
    ).toThrow("not currently due or its provenance changed");
  });

  it("rejects incomplete, terminal, duplicate, or oversized retry evidence", () => {
    const intended = candidate();
    const retryBatch = retryBatchEvidence(intended);
    retryBatch.incidents[0].result = "FINAL_DISPOSITION";

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        now
      })
    ).toThrow("non-retryable incident evidence");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: { ...retryBatch, status: "PARTIAL" },
        now
      })
    ).toThrow("durably closed retryable batch");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: {
          ...retryBatch,
          incidents: [
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" },
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" }
          ]
        },
        maxCourses: 2,
        now
      })
    ).toThrow("duplicate incident evidence");
    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: {
          ...retryBatch,
          incidents: [
            { ...retryBatch.incidents[0], result: "RETRY_SCHEDULED" },
            {
              ...retryBatch.incidents[0],
              incidentId: "incident-2",
              courseId: "course-2",
              result: "RETRY_SCHEDULED"
            }
          ]
        },
        maxCourses: 1,
        now
      })
    ).toThrow("exceeds the requested batch size");
  });

  it("does not let a targeted retry bypass due critical real demand", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course"
    });
    const critical = candidate({
      id: "critical-incident",
      courseId: "critical-course",
      kind: "FETCH_FAILED",
      engineeringOnly: false,
      activeRealSearchCount: 1,
      earliestTargetDate: new Date("2026-07-18T00:00:00.000Z")
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended, critical],
        retryBatch: retryBatchEvidence(intended),
        maxCourses: 1,
        now
      })
    ).toThrow("cannot bypass due critical real-demand work");
  });

  it.each([
    ["missing", null],
    ["not newer than closeout", new Date("2026-07-15T19:00:00.000Z")],
    ["not due yet", new Date("2026-07-15T20:01:00.000Z")]
  ])("rejects a %s targeted retry schedule", (_label, nextAttemptAt) => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course",
      nextAttemptAt
    });

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch: retryBatchEvidence(intended),
        now
      })
    ).toThrow("does not have a current due retry schedule");
  });

  it("rejects an old retry source after a later batch attempt", () => {
    const intended = candidate({
      id: "retry-incident",
      courseId: "retry-course"
    });
    const retryBatch = retryBatchEvidence(intended);
    retryBatch.incidents[0].incident.batchIncidents = [
      { id: "newer-batch-entry", cycle: intended.cycle }
    ];

    expect(() =>
      selectCourseSupportRetryBatch({
        candidates: [intended],
        retryBatch,
        now
      })
    ).toThrow("superseded by a later batch");
  });
});

describe("course-support claim demand fencing", () => {
  const baseSha = "a".repeat(40);

  function activeBatch(index: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `active-batch-${index}`,
      leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
      status: "VERIFYING",
      providerFamilyKey: `ACTIVE_GROUP_${index}`,
      failureFingerprint: `active-fingerprint-${index}`,
      summary: null,
      ...overrides
    };
  }

  function incidentRecord(input: {
    engineeringOnly: boolean;
    preferences: Array<{
      teeSearch: { id: string; date: Date };
    }>;
  }) {
    return {
      ...candidate({ engineeringOnly: input.engineeringOnly }),
      confirmedAt: now,
      attemptLedger: null,
      course: {
        timeZone: "America/Los_Angeles",
        preferences: input.preferences
      }
    };
  }

  function remediationHistoryEntry(input: {
    consumed: boolean;
    workMode?: "IMPLEMENT_REUSABLE_SUPPORT" | "VERIFY_TRANSIENT";
    strategyAction?: "REPAIR_PROVIDER_ADAPTER" | "RETRY_PROVIDER";
    playbookStage?: "OFFICIAL_IDENTITY" | null;
    outcome?: "retryable_failed" | "blocked_env" | "production_verification_failed";
    failureFingerprint?: string;
    providerSnapshotFingerprint?: string;
    runtimeVersion?: string;
  }) {
    const outcome = input.outcome ?? "retryable_failed";
    return {
      cycle: 1,
      batch: {
        summary: {
          closeout: {
            outcome,
            derivedOutcome: "retryable_failed",
            remediationAttemptConsumed: input.consumed,
            remediationAttempts: [
              {
                courseRef: createHash("sha256")
                  .update("course-1")
                  .digest("hex")
                  .slice(0, 24),
                providerSnapshotFingerprint:
                  input.providerSnapshotFingerprint ?? "b".repeat(64),
                failureFingerprint:
                  input.failureFingerprint ?? "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                runtimeVersion: input.runtimeVersion ?? baseSha,
                activeRealSearchCount: 0,
                consumed: input.consumed,
                approach: {
                  workMode: input.workMode ?? "IMPLEMENT_REUSABLE_SUPPORT",
                  strategyAction: input.strategyAction ?? "REPAIR_PROVIDER_ADAPTER",
                  playbookStage:
                    input.playbookStage === undefined
                      ? "OFFICIAL_IDENTITY"
                      : input.playbookStage
                }
              }
            ]
          }
        }
      }
    };
  }

  function mockMaterialChangeParking(incident: {
    id: string;
    courseId: string;
    cycle: number;
    updatedAt: Date;
    failureFingerprint: string;
    engineeringOnly: boolean;
    activeRealSearchCount: number;
    earliestTargetDate: Date | null;
  }) {
    prismaMocks.supportIncidentFindUnique.mockResolvedValue({
      id: incident.id,
      courseId: incident.courseId,
      cycle: incident.cycle,
      revision: 3,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      resolution: null,
      resolvedAt: null,
      updatedAt: incident.updatedAt,
      failureFingerprint: incident.failureFingerprint,
      engineeringOnly: incident.engineeringOnly,
      activeRealSearchCount: incident.activeRealSearchCount,
      earliestTargetDate: incident.earliestTargetDate,
      escalatedAt: null
    });
    prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: incident.updatedAt,
      lastSuccessfulAt: null,
      revision: 2
    });
    prismaMocks.transaction.mockImplementation(
      async (
        worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>
      ) => worker(monitoringTransactionClient)
    );
  }

  it("admits a second unrelated provider group", async () => {
    const incident = incidentRecord({ engineeringOnly: true, preferences: [] });
    prismaMocks.batchFindMany.mockResolvedValueOnce([activeBatch(1)]);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchFindMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ take: 2 })
    );
    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            remediation: expect.objectContaining({
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              allowUnchangedRuntime: false,
              requiresImplementationPath: true
            })
          })
        })
      })
    );
    expect(prismaMocks.automationRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "COURSE_SUPPORT",
          status: "RUNNING",
          runtimeVersion: baseSha,
          ownerThreadId: "owner-thread"
        })
      })
    );
  });

  it("parks an identical structural remediation until a material input changes", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      batchIncidents: [
        ...Array.from({ length: 6 }, () =>
          remediationHistoryEntry({ consumed: false, outcome: "blocked_env" })
        ),
        {
          cycle: 1,
          batch: {
            summary: {
              closeout: {
                outcome: "retryable_failed",
                derivedOutcome: "retryable_failed",
                remediationAttempts: [
                  {
                    courseRef: createHash("sha256")
                      .update("course-1")
                      .digest("hex")
                      .slice(0, 24),
                    providerSnapshotFingerprint: "b".repeat(64),
                    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                    runtimeVersion: baseSha,
                    activeRealSearchCount: 0,
                    consumed: true,
                    approach: {
                      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                      strategyAction: "REPAIR_PROVIDER_ADAPTER",
                      playbookStage: "OFFICIAL_IDENTITY"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    prismaMocks.supportIncidentFindUnique.mockResolvedValue({
      id: incident.id,
      courseId: incident.courseId,
      cycle: incident.cycle,
      revision: 3,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      resolution: null,
      resolvedAt: null,
      updatedAt: incident.updatedAt,
      failureFingerprint: incident.failureFingerprint,
      engineeringOnly: incident.engineeringOnly,
      activeRealSearchCount: incident.activeRealSearchCount,
      earliestTargetDate: incident.earliestTargetDate,
      escalatedAt: null
    });
    prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: incident.updatedAt,
      lastSuccessfulAt: null,
      revision: 2
    });
    prismaMocks.transaction.mockImplementation(
      async (
        worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>
      ) => worker(monitoringTransactionClient)
    );

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(
      prismaMocks.supportIncidentFindMany.mock.calls[0]?.[0]?.select?.batchIncidents
    ).not.toHaveProperty("take");
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          humanReviewReason: "AUTOMATION_STALLED",
          nextAttemptAt: null
        })
      })
    );
    expect(prismaMocks.teeSearchUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.automationRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "COURSE_SUPPORT",
          status: "COMPLETED",
          outcome: "no_due_work"
        })
      })
    );
  });

  it("reclaims the same implementation route after an operational environment closeout", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      attemptCount: 1,
      batchIncidents: [
        {
          cycle: 1,
          batch: {
            summary: {
              closeout: {
                outcome: "blocked_env",
                derivedOutcome: "retryable_failed",
                failureDomain: "ENV",
                remediationAttemptConsumed: false,
                remediationAttempts: [
                  {
                    courseRef: createHash("sha256")
                      .update("course-1")
                      .digest("hex")
                      .slice(0, 24),
                    providerSnapshotFingerprint: "b".repeat(64),
                    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                    runtimeVersion: baseSha,
                    activeRealSearchCount: 0,
                    consumed: false,
                    approach: {
                      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                      strategyAction: "REPAIR_PROVIDER_ADAPTER",
                      playbookStage: "OFFICIAL_IDENTITY"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-env-repair",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            remediation: expect.objectContaining({
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              reason: "IMPLEMENTATION_REQUIRED",
              requiresImplementationPath: true
            })
          })
        })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_HUMAN" })
      })
    );
  });

  it("reclaims the same route after an ordinary zero-work retry closeout", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      attemptCount: 1,
      batchIncidents: [remediationHistoryEntry({ consumed: false })]
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-zero-work-retry",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            remediation: expect.objectContaining({
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              reason: "IMPLEMENTATION_REQUIRED"
            })
          })
        })
      })
    );
  });

  it("parks after two unchanged zero-work closeouts even when unrelated commits changed HEAD", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      attemptCount: 2,
      batchIncidents: [
        remediationHistoryEntry({ consumed: false, runtimeVersion: "f".repeat(40) }),
        remediationHistoryEntry({
          consumed: false,
          outcome: "blocked_env",
          runtimeVersion: "f".repeat(40)
        })
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    mockMaterialChangeParking(incident);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-operational-budget",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: expect.objectContaining({
          reason: "OPERATIONAL_RETRY_BUDGET_EXHAUSTED",
          operationalRetryBudgetExhausted: true
        })
      })
    });
  });

  it("resets the zero-work budget when the provider snapshot materially changes", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      attemptCount: 2,
      batchIncidents: [
        remediationHistoryEntry({
          consumed: false,
          providerSnapshotFingerprint: "a".repeat(64)
        }),
        remediationHistoryEntry({
          consumed: false,
          outcome: "blocked_env",
          providerSnapshotFingerprint: "a".repeat(64)
        })
      ]
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-provider-change",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalledTimes(1);
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "NEEDS_HUMAN" })
      })
    );
  });

  it("does not repeat a deployed implementation after production verification fails", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      attemptCount: 1,
      batchIncidents: [
        remediationHistoryEntry({
          consumed: true,
          outcome: "production_verification_failed"
        })
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    mockMaterialChangeParking(incident);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-production-failure",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("keeps a consumed transient budget exhausted behind newer zero-work closeouts", async () => {
    const transientFingerprint = "v1:RATE_LIMIT:FETCH_FAILED";
    const baseIncident = incidentRecord({ engineeringOnly: true, preferences: [] });
    const incident = {
      ...baseIncident,
      kind: "FETCH_FAILED" as const,
      failureClass: "RATE_LIMIT" as const,
      failureFingerprint: transientFingerprint,
      attemptCount: 9,
      course: {
        ...baseIncident.course,
        isPublic: true,
        website: "https://public-course.example/",
        detectedBookingUrl: "https://www.chronogolf.com/club/example-course",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        bookingMetadata: {
          clubId: 1,
          courseIds: ["course-1"],
          bookingBaseUrl: "https://www.chronogolf.com/club/example-course"
        },
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      },
      batchIncidents: [
        ...Array.from({ length: 6 }, () =>
          remediationHistoryEntry({
            consumed: false,
            outcome: "blocked_env",
            workMode: "VERIFY_TRANSIENT",
            strategyAction: "RETRY_PROVIDER",
            playbookStage: null,
            failureFingerprint: transientFingerprint
          })
        ),
        ...Array.from({ length: 4 }, () =>
          remediationHistoryEntry({
            consumed: true,
            workMode: "VERIFY_TRANSIENT",
            strategyAction: "RETRY_PROVIDER",
            playbookStage: null,
            failureFingerprint: transientFingerprint
          })
        )
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    mockMaterialChangeParking(incident);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread-after-transient-budget",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "starts the changed provider snapshot with one consumed attempt",
      currentSnapshotAttemptCount: 1,
      expectedOutcome: "ready" as const,
      expectedAttemptsCompleted: 1
    },
    {
      label: "exhausts only after four attempts on the changed provider snapshot",
      currentSnapshotAttemptCount: 4,
      expectedOutcome: "no_due_work" as const,
      expectedAttemptsCompleted: 4
    }
  ])("$label", async (testCase) => {
    const transientFingerprint = "v1:RATE_LIMIT:FETCH_FAILED";
    const baseIncident = incidentRecord({ engineeringOnly: true, preferences: [] });
    const transientAttempt = (providerSnapshotFingerprint: string) =>
      remediationHistoryEntry({
        consumed: true,
        workMode: "VERIFY_TRANSIENT",
        strategyAction: "RETRY_PROVIDER",
        playbookStage: null,
        failureFingerprint: transientFingerprint,
        providerSnapshotFingerprint
      });
    const incident = {
      ...baseIncident,
      kind: "FETCH_FAILED" as const,
      failureClass: "RATE_LIMIT" as const,
      failureFingerprint: transientFingerprint,
      attemptCount: 4 + testCase.currentSnapshotAttemptCount,
      course: {
        ...baseIncident.course,
        isPublic: true,
        website: "https://public-course.example/",
        detectedBookingUrl: "https://www.chronogolf.com/club/example-course",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        bookingMetadata: {
          clubId: 1,
          courseIds: ["course-1"],
          bookingBaseUrl: "https://www.chronogolf.com/club/example-course"
        },
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      },
      batchIncidents: [
        ...Array.from({ length: testCase.currentSnapshotAttemptCount }, () =>
          transientAttempt("b".repeat(64))
        ),
        ...Array.from({ length: 4 }, () => transientAttempt("a".repeat(64)))
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    if (testCase.expectedOutcome === "ready") {
      prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    } else {
      mockMaterialChangeParking(incident);
    }

    const result = await claimCourseSupportBatch({
      ownerThreadId: `owner-thread-provider-episode-${testCase.currentSnapshotAttemptCount}`,
      branch: "automation/course-support-20260715-200000",
      baseSha,
      now
    });

    expect(result.outcome).toBe(testCase.expectedOutcome);
    if (testCase.expectedOutcome === "ready") {
      expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            summary: expect.objectContaining({
              remediation: expect.objectContaining({
                workMode: "VERIFY_TRANSIENT",
                retryBudget: expect.objectContaining({
                  attemptsCompleted: testCase.expectedAttemptsCompleted,
                  attemptsRemaining: 3,
                  exhausted: false
                })
              })
            })
          })
        })
      );
    } else {
      expect(result).toMatchObject({ parkedForMaterialChangeCount: 1 });
      expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    }
  });

  it("does not let a prior-cycle attempt suppress an explicit material reopen", async () => {
    const reopened = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      cycle: 2,
      attemptCount: 4,
      batchIncidents: [
        {
          cycle: 1,
          batch: {
            summary: {
              closeout: {
                outcome: "retryable_failed",
                derivedOutcome: "retryable_failed",
                remediationAttempts: [
                  {
                    courseRef: createHash("sha256")
                      .update("course-1")
                      .digest("hex")
                      .slice(0, 24),
                    providerSnapshotFingerprint: "b".repeat(64),
                    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                    runtimeVersion: baseSha,
                    activeRealSearchCount: 0,
                    consumed: true,
                    approach: {
                      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                      strategyAction: "REPAIR_PROVIDER_ADAPTER",
                      playbookStage: "OFFICIAL_IDENTITY"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([reopened])
      .mockResolvedValueOnce([reopened]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "NEEDS_HUMAN" }) })
    );
  });

  it("selects a provider snapshot that changed after the prior attempt", async () => {
    const changedProvider = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      batchIncidents: [
        {
          cycle: 1,
          batch: {
            summary: {
              closeout: {
                outcome: "retryable_failed",
                derivedOutcome: "retryable_failed",
                remediationAttempts: [
                  {
                    courseRef: createHash("sha256")
                      .update("course-1")
                      .digest("hex")
                      .slice(0, 24),
                    providerSnapshotFingerprint: "a".repeat(64),
                    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                    runtimeVersion: baseSha,
                    activeRealSearchCount: 0,
                    consumed: true,
                    approach: {
                      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                      strategyAction: "REPAIR_PROVIDER_ADAPTER",
                      playbookStage: "OFFICIAL_IDENTITY"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([changedProvider])
      .mockResolvedValueOnce([changedProvider]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({
            remediation: expect.objectContaining({ reason: "MATERIAL_CHANGE_REOPENED" })
          })
        })
      })
    );
  });

  it("promotes new real demand without repeating the same technical approach", async () => {
    const incident = {
      ...incidentRecord({
        engineeringOnly: true,
        preferences: [
          {
            teeSearch: {
              id: "new-real-demand",
              date: new Date("2026-07-18T00:00:00.000Z")
            }
          }
        ]
      }),
      batchIncidents: [
        {
          cycle: 1,
          batch: {
            summary: {
              closeout: {
                outcome: "retryable_failed",
                derivedOutcome: "retryable_failed",
                remediationAttempts: [
                  {
                    courseRef: createHash("sha256")
                      .update("course-1")
                      .digest("hex")
                      .slice(0, 24),
                    providerSnapshotFingerprint: "b".repeat(64),
                    failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
                    runtimeVersion: baseSha,
                    activeRealSearchCount: 0,
                    consumed: true,
                    approach: {
                      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                      strategyAction: "REPAIR_PROVIDER_ADAPTER",
                      playbookStage: "OFFICIAL_IDENTITY"
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    };
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);
    prismaMocks.supportIncidentFindUnique.mockResolvedValue({
      id: incident.id,
      courseId: incident.courseId,
      cycle: incident.cycle,
      revision: 3,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      resolution: null,
      resolvedAt: null,
      updatedAt: incident.updatedAt,
      failureFingerprint: incident.failureFingerprint,
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      escalatedAt: null
    });
    prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: incident.updatedAt,
      lastSuccessfulAt: null,
      revision: 2
    });
    prismaMocks.transaction.mockImplementation(
      async (
        worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>
      ) => worker(monitoringTransactionClient)
    );

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          engineeringOnly: false,
          activeRealSearchCount: 1
        })
      })
    );
    expect(prismaMocks.teeSearchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a third concurrent provider group", async () => {
    prismaMocks.batchFindMany.mockResolvedValueOnce(
      Array.from({ length: 2 }, (_, index) => activeBatch(index + 1))
    );

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "deferred_busy",
      durableCloseoutRecorded: true
    });

    expect(prismaMocks.supportIncidentFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("admits no-path read-only verification beside the shared checkout owner", async () => {
    const incident = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      failureClass: "RATE_LIMIT" as const,
      course: {
        ...incidentRecord({ engineeringOnly: true, preferences: [] }).course,
        isPublic: true,
        website: "https://public-course.example/",
        detectedBookingUrl: "https://www.chronogolf.com/club/example-course",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        bookingMetadata: {
          clubId: 1,
          courseIds: ["course-1"],
          bookingBaseUrl: "https://www.chronogolf.com/club/example-course"
        },
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    };
    prismaMocks.batchFindMany.mockResolvedValueOnce([
      activeBatch(1, {
        status: "IMPLEMENTING",
        summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
      })
    ]);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1
    });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "CLAIMED",
          summary: expect.objectContaining({
            plannedPaths: [],
            remediation: expect.objectContaining({
              workMode: "VERIFY_TRANSIENT",
              requiresImplementationPath: false
            })
          })
        })
      })
    );
  });

  it("does not consume a second responder slot for implementation before paths are claimed", async () => {
    const incident = incidentRecord({ engineeringOnly: true, preferences: [] });
    prismaMocks.batchFindMany.mockResolvedValueOnce([
      activeBatch(1, {
        status: "CLAIMED",
        summary: {
          plannedPaths: [],
          remediation: {
            schemaVersion: 1,
            workMode: "IMPLEMENT_REUSABLE_SUPPORT",
            resumeWorkMode: "IMPLEMENT_REUSABLE_SUPPORT",
            allowUnchangedRuntime: false,
            requiresImplementationPath: true,
            reason: "IMPLEMENTATION_REQUIRED",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            strategyReason: "PROVIDER_ADAPTER_DEFECT",
            playbookStage: "OFFICIAL_IDENTITY",
            retryBudget: null
          }
        }
      })
    ]);
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({
      outcome: "deferred_busy",
      durableCloseoutRecorded: true,
      sharedCheckoutImplementationBusy: true
    });

    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("admits the first planned implementation owner beside no-path verification work", async () => {
    const incident = incidentRecord({ engineeringOnly: true, preferences: [] });
    prismaMocks.batchFindMany.mockResolvedValueOnce([activeBatch(1)]);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"],
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1
    });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "IMPLEMENTING",
          summary: expect.objectContaining({
            plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"]
          })
        })
      })
    );
  });

  it("serializes an active provider/fingerprint pair while admitting another fingerprint", async () => {
    const blocked = {
      ...incidentRecord({
        engineeringOnly: false,
        preferences: [
          {
            teeSearch: {
              id: "priority-search",
              date: new Date("2026-07-18T00:00:00.000Z")
            }
          }
        ]
      }),
      id: "blocked-incident",
      courseId: "blocked-course",
      escalationDeadlineAt: new Date("2026-07-15T20:05:00.000Z")
    };
    const admitted = {
      ...incidentRecord({ engineeringOnly: true, preferences: [] }),
      id: "admitted-incident",
      courseId: "admitted-course",
      failureFingerprint: "v2:UNSUPPORTED_FAMILY:NEEDS_ADAPTER"
    };
    prismaMocks.batchFindMany.mockResolvedValueOnce([
      activeBatch(1, {
        providerFamilyKey: blocked.providerFamilyKey,
        failureFingerprint: blocked.failureFingerprint
      })
    ]);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([blocked, admitted])
      .mockResolvedValueOnce([admitted]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.batchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerFamilyKey: admitted.providerFamilyKey,
        failureFingerprint: admitted.failureFingerprint
      }),
      select: { id: true, reference: true }
    });
    expect(prismaMocks.batchIncidentCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ incidentId: admitted.id })]
    });
  });

  it("rejects an exact retry ordinal without a source batch", async () => {
    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryOrdinal: 1,
        maxCourses: 1,
        now
      })
    ).rejects.toThrow("requires a retry batch reference");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("claims due engineering-only work at any minute of the hour", async () => {
    const incident = incidentRecord({
      engineeringOnly: true,
      preferences: []
    });
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:37:00.000Z")
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1
    });

    expect(prismaMocks.batchCreate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["rendered browser discovery", browserReadyAttemptLedger()],
    ["independent confirmation", independentReadyAttemptLedger()]
  ])("claims unconfirmed active demand at %s", async (_stage, attemptLedger) => {
    const preferences = [
      {
        teeSearch: {
          id: "active-public-search",
          date: new Date("2026-07-22T00:00:00.000Z")
        }
      }
    ];
    const incident = {
      ...incidentRecord({ engineeringOnly: false, preferences }),
      confirmedAt: null,
      attemptLedger
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:37:00.000Z")
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1,
      leverage: { activeRealDemandCount: 1 }
    });
  });

  it("excludes unconfirmed zero-demand work even when its ledger is browser-ready", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        ...incidentRecord({ engineeringOnly: true, preferences: [] }),
        confirmedAt: null,
        attemptLedger: browserReadyAttemptLedger()
      }
    ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:37:00.000Z")
      })
    ).resolves.toMatchObject({ outcome: "no_due_work" });
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("rejects an unconfirmed claim when live demand expires during ownership fencing", async () => {
    const selected = {
      ...incidentRecord({
        engineeringOnly: false,
        preferences: [
          {
            teeSearch: {
              id: "expiring-public-search",
              date: new Date("2026-07-22T00:00:00.000Z")
            }
          }
        ]
      }),
      confirmedAt: null,
      attemptLedger: browserReadyAttemptLedger()
    };
    const expired = {
      ...selected,
      course: { ...selected.course, preferences: [] }
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([selected])
      .mockResolvedValueOnce([expired]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:37:00.000Z")
      })
    ).rejects.toThrow("stage eligibility changed during claim");
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("rejects an unconfirmed claim if its playbook moves back to a search-owned stage", async () => {
    const preferences = [
      {
        teeSearch: {
          id: "active-public-search",
          date: new Date("2026-07-22T00:00:00.000Z")
        }
      }
    ];
    const selected = {
      ...incidentRecord({ engineeringOnly: false, preferences }),
      confirmedAt: null,
      attemptLedger: browserReadyAttemptLedger()
    };
    const searchOwned = {
      ...selected,
      attemptLedger: appendAutomationPlaybookEvent(null, {
        cycle: 1,
        stage: "OFFICIAL_IDENTITY",
        transition: "COMPLETED",
        readPath: "OFFICIAL_IDENTITY",
        evidenceKind: "OFFICIAL_SOURCE",
        failureFingerprint: "TEST:OFFICIAL_IDENTITY:ONLY",
        runtimeVersion: "test-runtime",
        observedAt: now
      })
    };
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([selected])
      .mockResolvedValueOnce([searchOwned]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:37:00.000Z")
      })
    ).rejects.toThrow("stage eligibility changed during claim");
  });

  it.each([
    ["HEALTHY", "MONITORING_RESTORED"],
    ["FINAL_MANUAL", "DIRECT_BOOKING_CLASSIFIED"],
    ["FINAL_TECHNICAL", "TECHNICAL_LIMITATION_CLASSIFIED"],
    ["FINAL_IDENTITY", "IDENTITY_CLASSIFIED"]
  ] as const)(
    "reconciles a persisted authoritative %s state before responder ownership",
    async (state, resolution) => {
      const selected = incidentRecord({
        engineeringOnly: true,
        preferences: []
      });
      prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([selected]).mockResolvedValueOnce([
        {
          ...selected,
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          revision: 7,
          course: {
            ...selected.course,
            monitoringStatus: {
              state,
              revision: 11,
              lastSuccessfulAt: state === "HEALTHY" ? new Date("2026-07-21T01:36:30.000Z") : null
            }
          }
        }
      ]);

      await expect(
        claimCourseSupportBatch({
          ownerThreadId: "owner-thread",
          branch: "automation/course-support-20260715-200000",
          baseSha,
          now: new Date("2026-07-21T01:37:00.000Z")
        })
      ).resolves.toMatchObject({
        outcome: "no_due_work",
        reconciledAuthoritativeFinalCount: 1
      });

      expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith({
        where: {
          id: selected.id,
          cycle: selected.cycle,
          revision: 7,
          status: "AUTO_INVESTIGATING",
          activeBatchId: null
        },
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution
        })
      });
      expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith({
        where: {
          courseId: selected.courseId,
          state,
          revision: 11,
          lastSuccessfulAt: state === "HEALTHY" ? new Date("2026-07-21T01:36:30.000Z") : null
        },
        data: { revision: { increment: 0 } }
      });
      expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
      expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    }
  );

  it("atomically promotes synthetic provenance when current real demand exists", async () => {
    const preferences = [
      {
        teeSearch: {
          id: "real-search",
          date: new Date("2026-07-20T00:00:00.000Z")
        }
      }
    ];
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incidentRecord({ engineeringOnly: true, preferences })])
      .mockResolvedValueOnce([incidentRecord({ engineeringOnly: true, preferences })]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).resolves.toMatchObject({ outcome: "ready", incidentCount: 1 });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          activeRealSearchCount: 1,
          earliestTargetDate: new Date("2026-07-20T00:00:00.000Z"),
          engineeringOnly: false
        })
      })
    );
    expect(prismaMocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable"
    });
  });

  it("rolls back claim creation when live demand changes after selection", async () => {
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incidentRecord({ engineeringOnly: true, preferences: [] })])
      .mockResolvedValueOnce([
        incidentRecord({
          engineeringOnly: true,
          preferences: [
            {
              teeSearch: {
                id: "late-real-search",
                date: new Date("2026-07-20T00:00:00.000Z")
              }
            }
          ]
        })
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls back claim creation when live demand ends after selection", async () => {
    const preferences = [
      {
        teeSearch: {
          id: "ending-real-search",
          date: new Date("2026-07-20T00:00:00.000Z")
        }
      }
    ];
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incidentRecord({ engineeringOnly: false, preferences })])
      .mockResolvedValueOnce([incidentRecord({ engineeringOnly: false, preferences: [] })]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("claims only one exact retry ordinal and records redacted source provenance", async () => {
    const first = candidate({ id: "retry-first", courseId: "retry-course-1" });
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course-2",
      engineeringOnly: false
    });
    const last = candidate({ id: "retry-last", courseId: "retry-course-3" });
    const retryBatch = retryBatchEvidence(intended, {
      incidents: [retryBatchEntry(first), retryBatchEntry(intended), retryBatchEntry(last)]
    });
    const incident = {
      ...intended,
      confirmedAt: now,
      attemptLedger: null,
      course: { timeZone: "America/Los_Angeles", preferences: [] }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatch);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 2,
        maxCourses: 1,
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      incidentCount: 1,
      fairnessReason: "TARGETED_RETRY"
    });

    expect(prismaMocks.batchIncidentCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          incidentId: "retry-intended",
          courseId: "retry-course-2"
        })
      ]
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "retry-intended",
          batchIncidents: {
            some: expect.objectContaining({
              id: "batch-entry-retry-intended",
              batchId: "private-source-batch-id",
              incidentId: "retry-intended",
              courseId: "retry-course-2",
              result: "RETRY_SCHEDULED"
            })
          }
        })
      })
    );
    const notes = JSON.parse(prismaMocks.automationRunCreate.mock.calls[0][0].data.notes);
    expect(notes).toMatchObject({
      targetedRetry: true,
      retryScope: "ENTRY",
      retrySourceOrdinal: "02"
    });
    expect(notes.retrySourceBatchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(notes)).not.toContain("private-source-batch-id");
    const summary = prismaMocks.batchCreate.mock.calls[0][0].data.summary;
    expect(summary).toMatchObject({
      targetedRetry: true,
      retryScope: "ENTRY",
      retrySourceOrdinal: "02"
    });
    expect(summary.retrySourceBatchDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("private-source-batch-id");
  });

  it("rolls back an exact-entry retry when live demand changes during claim", async () => {
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course",
      engineeringOnly: false
    });
    const retryBatch = retryBatchEvidence(intended);
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatch);
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([
        {
          ...intended,
          confirmedAt: now,
          attemptLedger: null,
          course: { timeZone: "America/Los_Angeles", preferences: [] }
        }
      ])
      .mockResolvedValueOnce([
        {
          ...intended,
          confirmedAt: now,
          attemptLedger: null,
          course: {
            timeZone: "America/Los_Angeles",
            preferences: [
              {
                teeSearch: {
                  id: "new-real-demand",
                  date: new Date("2026-07-20T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 1,
        maxCourses: 1,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("demand changed during claim");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls back an exact-entry retry when critical real demand appears", async () => {
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course",
      engineeringOnly: false
    });
    const incident = {
      ...intended,
      confirmedAt: now,
      attemptLedger: null,
      course: { timeZone: "America/Los_Angeles", preferences: [] }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatchEvidence(intended));
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([
        {
          cycle: 1,
          confirmedAt: now,
          attemptLedger: null,
          course: {
            timeZone: "America/New_York",
            preferences: [
              {
                teeSearch: {
                  id: "new-critical-demand",
                  date: new Date("2026-07-22T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 1,
        maxCourses: 1,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("cannot bypass due critical real-demand work");

    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("does not let a targeted retry bypass unconfirmed browser-ready real demand", async () => {
    const intended = candidate({
      id: "retry-intended",
      courseId: "retry-course",
      engineeringOnly: false
    });
    const incident = {
      ...intended,
      confirmedAt: now,
      attemptLedger: null,
      course: { timeZone: "America/Los_Angeles", preferences: [] }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(retryBatchEvidence(intended));
    prismaMocks.supportIncidentFindMany
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([incident])
      .mockResolvedValueOnce([
        {
          cycle: 1,
          confirmedAt: null,
          attemptLedger: browserReadyAttemptLedger(),
          course: {
            timeZone: "America/New_York",
            preferences: [
              {
                teeSearch: {
                  id: "unconfirmed-critical-demand",
                  date: new Date("2026-07-22T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

    await expect(
      claimCourseSupportBatch({
        ownerThreadId: "owner-thread",
        branch: "automation/course-support-20260715-200000",
        baseSha,
        retryBatchId: "private-source-batch-id",
        retryOrdinal: 1,
        maxCourses: 1,
        now: new Date("2026-07-21T01:00:00.000Z")
      })
    ).rejects.toThrow("cannot bypass due critical real-demand work");
  });
});

describe("course-support retry policy", () => {
  it("backs transient failures off from minutes to one day", () => {
    const attempts = [1, 2, 3, 4].map((attemptCount) =>
      computeCourseSupportNextAttemptAt({
        failureClass: "NETWORK",
        failureFingerprint: "v1:NETWORK:FETCH_FAILED",
        attemptCount,
        now
      }).getTime()
    );

    expect(attempts[0]).toBeGreaterThan(now.getTime() + 13 * 60 * 1000);
    expect(attempts[1]).toBeGreaterThan(now.getTime() + 54 * 60 * 1000);
    expect(attempts[2]).toBeGreaterThan(now.getTime() + 5 * 60 * 60 * 1000);
    expect(attempts[3]).toBeGreaterThan(now.getTime() + 21 * 60 * 60 * 1000);
  });

  it("honors a bounded rate-limit Retry-After", () => {
    expect(
      computeCourseSupportNextAttemptAt({
        failureClass: "RATE_LIMIT",
        failureFingerprint: "v1:RATE_LIMIT:FETCH_FAILED",
        attemptCount: 1,
        retryAfterSeconds: 90,
        now
      }).toISOString()
    ).toBe("2026-07-15T20:01:30.000Z");
  });

  it("permits non-transient retry release only for explicit operational failures", () => {
    expect(canCloseCourseSupportRetry("AUTH", "blocked_auth")).toBe(true);
    expect(canCloseCourseSupportRetry("UNSUPPORTED_FAMILY", "blocked_git")).toBe(true);
    expect(canCloseCourseSupportRetry("AUTH", "retryable_failed")).toBe(false);
    expect(canCloseCourseSupportRetry("AUTH")).toBe(false);
  });
});

describe("fresh runtime verification", () => {
  const runnableCourse = {
    isPublic: true,
    bookingMethod: "PUBLIC_ONLINE" as const,
    automationEligibility: "ALLOWED" as const,
    automationReason: "NONE" as const
  };
  const browserPrivateSourceUrl = "https://course.example/golf/deer-creek";
  const browserPrivatePolicyNotes =
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.";
  const browserPrivateProof = {
    kind: "BROWSER_PRIVATE_IDENTITY",
    disposition: "VERIFIED_PRIVATE",
    discoveryCreatedAt: "2026-07-15T19:30:00.000Z",
    intelligenceVerifiedAt: "2026-07-15T19:31:00.000Z",
    intelligenceReviewAt: "2027-01-11T19:31:00.000Z",
    evidenceOrigin: "https://course.example",
    provenance: "official-private-course-profile",
    confidence: 0.98,
    intelligenceConfidence: 0.98,
    policyNotes: browserPrivatePolicyNotes,
    courseBookingMethod: "UNKNOWN",
    courseAutomationEligibility: "BLOCKED",
    courseAutomationReason: "OTHER",
    discoveryStatus: "VERIFIED",
    discoveryDetectedPlatform: "UNKNOWN",
    discoveryBookingMethod: "UNKNOWN",
    discoveryBookingPhone: null,
    discoveryAutomationEligibility: "BLOCKED",
    discoveryAutomationReason: "OTHER",
    discoveryApiEndpoint: null,
    discoveryApiMetadata: null
  } as const;

  function browserPrivateCourse(input?: {
    discoveryCreatedAt?: Date;
    intelligenceVerifiedAt?: Date;
    intelligenceReviewAt?: Date;
    provenance?: string;
    bookingPhone?: string | null;
    apiEndpoint?: string | null;
    apiMetadata?: Record<string, string> | null;
  }) {
    return {
      ...runnableCourse,
      isPublic: false,
      bookingMethod: "UNKNOWN" as const,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      policyNotes: browserPrivatePolicyNotes,
      intelligenceVerifiedAt: input?.intelligenceVerifiedAt ?? new Date("2026-07-15T19:31:00.000Z"),
      intelligenceReviewAt: input?.intelligenceReviewAt ?? new Date("2027-01-11T19:31:00.000Z"),
      intelligenceConfidence: 0.98,
      latestDiscovery: {
        status: "VERIFIED",
        detectedPlatform: "UNKNOWN",
        bookingMethod: "UNKNOWN" as const,
        bookingPhone: input?.bookingPhone ?? null,
        automationEligibility: "BLOCKED" as const,
        automationReason: "OTHER" as const,
        sourceUrl: browserPrivateSourceUrl,
        bookingUrl: browserPrivateSourceUrl,
        apiEndpoint: input?.apiEndpoint ?? null,
        apiMetadata: input?.apiMetadata ?? null,
        confidence: 0.98,
        evidence: {
          learnedFrom: input?.provenance ?? "official-private-course-profile",
          finalUrl: browserPrivateSourceUrl,
          observedUrls: [browserPrivateSourceUrl],
          visibleText: "Deer Creek Details Status: Private"
        },
        createdAt: input?.discoveryCreatedAt ?? new Date("2026-07-15T19:30:00.000Z")
      }
    };
  }

  it("accepts fresh no-email provider verification from the exact release", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationEvidence({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        proof: {
          eligible: true,
          releaseSha,
          runtimeVersion: releaseSha,
          outcome: "NO_MATCH",
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            providerExecution: true
          }
        }
      })
    ).toMatchObject({
      result: "RESTORED",
      postProbeId: null,
      proofSnapshot: { kind: "PROVIDER_VERIFICATION" }
    });
  });

  it("keeps provider-independent factual proof current after incident freshness advances", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationEvidence({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:08:00.000Z"),
        proof: {
          eligible: true,
          releaseSha,
          runtimeVersion: releaseSha,
          outcome: "MANUAL_DIRECT",
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PLAYBOOK_FACTUAL_FINAL",
            releaseSha,
            runtimeVersion: releaseSha,
            outcome: "MANUAL_DIRECT",
            disposition: "MANUAL_DIRECT",
            observedAt: "2026-07-15T20:06:00.000Z",
            completedAt: "2026-07-15T20:06:30.000Z",
            providerExecution: false
          }
        }
      })
    ).toMatchObject({
      result: "FINAL_DISPOSITION",
      proofSnapshot: { kind: "PLAYBOOK_FACTUAL_FINAL" }
    });
  });

  it("rejects detached proof observed before the remediation dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationEvidence({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        proof: {
          eligible: true,
          releaseSha,
          runtimeVersion: releaseSha,
          outcome: "NO_MATCH",
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            providerExecution: true
          }
        }
      })?.result
    ).toBe("STALE_EVIDENCE");
  });

  it("persists current exact-runtime detached failure evidence as retryable", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationFailure({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        failure: {
          current: true,
          releaseSha,
          runtimeVersion: releaseSha,
          status: "RETRYABLE_FAILED",
          outcome: "FETCH_FAILED",
          failureClass: "RATE_LIMIT",
          providerExecution: true,
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          completedAt: null,
          nextAttemptAt: new Date("2026-07-15T20:21:00.000Z"),
          providerRetryNotBeforeAt: new Date("2026-07-15T22:00:00.000Z"),
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerExecution: true,
            observedAt: "2026-07-15T20:06:00.000Z"
          }
        }
      })
    ).toMatchObject({
      result: "RETRY_SCHEDULED",
      proofSnapshot: {
        kind: "PROVIDER_VERIFICATION_FAILURE",
        outcome: "FETCH_FAILED",
        failureClass: "RATE_LIMIT",
        providerExecution: true,
        providerRetryNotBeforeAt: "2026-07-15T22:00:00.000Z"
      }
    });
  });

  it("keeps a newer detached failure over an older workflow success", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: {
        result: "RESTORED",
        postProbeId: "probe-success",
        message: "Older workflow success.",
        proofSnapshot: {
          kind: "PROVIDER_PROBE",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      },
      detachedVerification: null,
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Newer detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:07:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RETRY_SCHEDULED",
      message: "Newer detached failure.",
      proofSnapshot: { kind: "PROVIDER_VERIFICATION_FAILURE" }
    });
  });

  it("keeps a newer workflow success over an older detached failure", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: {
        result: "RESTORED",
        postProbeId: "probe-success",
        message: "Newer workflow success.",
        proofSnapshot: {
          kind: "PROVIDER_PROBE",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:07:00.000Z"
        }
      },
      detachedVerification: null,
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Older detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RESTORED",
      message: "Newer workflow success.",
      proofSnapshot: { kind: "PROVIDER_PROBE" }
    });
  });

  it("fails safe when success and failure observations have the same timestamp", () => {
    const selected = chooseNewestProviderVerificationEvidence({
      workflow: null,
      detachedVerification: {
        result: "RESTORED",
        postProbeId: null,
        message: "Tied detached success.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION",
          outcome: "NO_MATCH",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      },
      detachedFailure: {
        result: "RETRY_SCHEDULED",
        postProbeId: null,
        message: "Tied detached failure.",
        proofSnapshot: {
          kind: "PROVIDER_VERIFICATION_FAILURE",
          outcome: "FETCH_FAILED",
          observedAt: "2026-07-15T20:06:00.000Z"
        }
      }
    });

    expect(selected).toMatchObject({
      result: "RETRY_SCHEDULED",
      message: "Tied detached failure."
    });
  });

  it("does not carry detached failure evidence from before dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      classifyDetachedVerificationFailure({
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T20:04:00.000Z"),
        failure: {
          current: true,
          releaseSha,
          runtimeVersion: releaseSha,
          status: "STALE",
          outcome: "FETCH_FAILED",
          failureClass: "SCHEMA",
          providerExecution: false,
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          completedAt: new Date("2026-07-15T20:06:30.000Z"),
          nextAttemptAt: null,
          providerRetryNotBeforeAt: null,
          providerSnapshotFingerprint: "b".repeat(64),
          evidence: {
            kind: "PROVIDER_VERIFICATION",
            runtimeVersion: releaseSha,
            outcome: "FETCH_FAILED",
            failureClass: "SCHEMA",
            providerExecution: false,
            observedAt: "2026-07-15T20:06:00.000Z"
          }
        }
      })
    ).toBeNull();
  });

  it("rejects an older successful probe from another runtime", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        preProbeId: "pre-probe",
        newestProbe: {
          id: "old-runtime-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts the newest successful observation from the deployed release", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z"),
        preProbeId: "pre-probe",
        newestProbe: {
          id: "post-probe",
          outcome: "MATCH_FOUND",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      })
    ).toMatchObject({ result: "RESTORED", postProbeId: "post-probe" });
  });

  it("accepts an exact-runtime reused probe only with a fresh dispatched search check", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentLastSeenAt: new Date("2026-07-15T20:09:00.000Z"),
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        recheckDispatchStartedAt: new Date("2026-07-15T20:10:00.000Z"),
        newestProbe: {
          id: "reused-exact-runtime-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          freshSearchCheckedAt: new Date("2026-07-15T20:11:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("RESTORED");
  });

  it("does not consume an exact-release probe before a recheck dispatch is durable", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        newestProbe: {
          id: "pre-dispatch-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: true
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects a fresh semantic NO_MATCH that did not execute the provider", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        deployedAt: new Date("2026-07-15T20:05:00.000Z"),
        releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        preProbeId: "pre-probe",
        newestProbe: {
          id: "layout-skip-probe",
          outcome: "NO_MATCH",
          observedAt: new Date("2026-07-15T20:06:00.000Z"),
          runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          providerExecution: false
        },
        course: runnableCourse
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects a manual snapshot without current source-backed discovery", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        course: {
          ...runnableCourse,
          bookingMethod: "PHONE_ONLY",
          automationReason: "NO_ONLINE_BOOKING"
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current source-backed manual disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          monitoringMode: "CONTACT_ONLY",
          website: "https://course.example/",
          latestDiscovery: {
            status: "VERIFIED",
            bookingMethod: "PHONE_ONLY",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: null,
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("rejects contact-only evidence from a different origin", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: "PHONE_ONLY",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          monitoringMode: "CONTACT_ONLY",
          website: "https://course.example/",
          latestDiscovery: {
            status: "VERIFIED",
            bookingMethod: "PHONE_ONLY",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://unrelated.example/phone-only",
            bookingUrl: null,
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts current exact browser-verified private identity evidence", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        now,
        course: browserPrivateCourse()
      })
    ).toMatchObject({
      result: "FINAL_DISPOSITION",
      proofSnapshot: {
        kind: "BROWSER_PRIVATE_IDENTITY",
        disposition: "VERIFIED_PRIVATE",
        provenance: "official-private-course-profile",
        discoveryApiMetadata: null
      }
    });
  });

  it("accepts replayed private identity evidence when discovery is recorded after the course update", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          intelligenceVerifiedAt: new Date("2026-07-15T19:30:00.000Z"),
          discoveryCreatedAt: new Date("2026-07-15T19:31:00.000Z")
        })
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("rejects forged browser-private provenance as a batch final", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          provenance: "official-private-course-profile:untrusted-marker"
        })
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("requires an explicit persisted private identity for a batch final", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: { ...browserPrivateCourse(), isPublic: undefined }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it.each([
    { field: "booking phone", value: { bookingPhone: "555-0100" } },
    {
      field: "API endpoint",
      value: { apiEndpoint: "https://course.example/api/tee-times" }
    },
    {
      field: "API metadata",
      value: { apiMetadata: { provider: "unexpected" } }
    }
  ])("rejects browser-private evidence with forged $field metadata", ({ value }) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse(value)
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("rejects browser-private evidence timestamped beyond the clock-skew allowance", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        now,
        course: browserPrivateCourse({
          intelligenceVerifiedAt: new Date("2026-07-15T20:01:01.000Z"),
          discoveryCreatedAt: new Date("2026-07-15T20:01:01.000Z")
        })
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it.each([
    {
      label: "the current course method is unknown",
      courseMethod: "UNKNOWN" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "UNKNOWN" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the current course is not blocked",
      courseMethod: "PHONE_ONLY" as const,
      courseEligibility: "ALLOWED" as const,
      discoveryMethod: "PHONE_ONLY" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the discovery is not blocked",
      courseMethod: "CONTACT_COURSE" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "CONTACT_COURSE" as const,
      discoveryEligibility: "ALLOWED" as const,
      discoveryStatus: "VERIFIED"
    },
    {
      label: "the discovery is learned but not verified",
      courseMethod: "WALK_IN" as const,
      courseEligibility: "BLOCKED" as const,
      discoveryMethod: "WALK_IN" as const,
      discoveryEligibility: "BLOCKED" as const,
      discoveryStatus: "LEARNED"
    }
  ])("rejects a manual final when $label", (scenario) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: scenario.courseMethod,
          automationEligibility: scenario.courseEligibility,
          automationReason: "NO_ONLINE_BOOKING",
          latestDiscovery: {
            status: scenario.discoveryStatus,
            bookingMethod: scenario.discoveryMethod,
            automationEligibility: scenario.discoveryEligibility,
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: null,
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current technical access barrier as a terminal disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          latestDiscovery: {
            status: "BLOCKED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "ACCOUNT_REQUIRED",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T18:30:00.000Z")
          }
        }
      }).result
    ).toBe("FINAL_DISPOSITION");
  });

  it("keeps a current source-backed prohibited-automation disposition actionable", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          automationEligibility: "BLOCKED",
          automationReason: "AUTOMATION_PROHIBITED",
          latestDiscovery: {
            status: "BLOCKED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "AUTOMATION_PROHIBITED",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T18:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a current exact-place non-course disposition after course reconciliation", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          isPublic: false,
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          latestPlaceReview: {
            active: true,
            accessOverride: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceUrl: "https://course.example/",
            reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
            updatedAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      })
    ).toMatchObject({
      result: "FINAL_DISPOSITION",
      proofSnapshot: {
        kind: "EXACT_PLACE_REVIEW",
        disposition: "VERIFIED_NON_COURSE"
      }
    });
  });

  it.each([
    {
      label: "the exact review predates the incident cycle",
      isPublic: false,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: true,
      updatedAt: new Date("2026-07-15T18:30:00.000Z")
    },
    {
      label: "the reconciled course state is still public",
      isPublic: true,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: true,
      updatedAt: new Date("2026-07-15T19:30:00.000Z")
    },
    {
      label: "the exact review is inactive",
      isPublic: false,
      automationEligibility: "BLOCKED" as const,
      automationReason: "OTHER" as const,
      active: false,
      updatedAt: new Date("2026-07-15T19:30:00.000Z")
    }
  ])("rejects an exact-place disposition when $label", (scenario) => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentFirstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
        incidentLastSeenAt: new Date("2026-07-15T19:45:00.000Z"),
        course: {
          ...runnableCourse,
          isPublic: scenario.isPublic,
          automationEligibility: scenario.automationEligibility,
          automationReason: scenario.automationReason,
          latestPlaceReview: {
            active: scenario.active,
            accessOverride: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceUrl: "https://course.example/",
            reviewedAt: new Date("2026-07-15T00:00:00.000Z"),
            updatedAt: scenario.updatedAt
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("accepts a fresh reconciled exact-place review as durable terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "EXACT_PLACE_REVIEW",
            disposition: "VERIFIED_NON_COURSE",
            classification: "PRIVATE_PRACTICE_GREEN",
            evidenceOrigin: "https://course.example",
            reviewedAt: "2026-07-15T00:00:00.000Z",
            reviewUpdatedAt: "2026-07-15T19:30:00.000Z",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:00:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it.each(["MANUAL_DIRECT", "IDENTITY_FINAL"] as const)(
    "accepts exact-release ordered %s proof as a durable batch final",
    (disposition) => {
      const releaseSha = "a".repeat(40);
      const attemptLedger = factualFinalLedger(disposition);
      const event = attemptLedger.events.at(-1)!;
      expect(
        isDurableTerminalProof(
          {
            normalizedResult: "FINAL_DISPOSITION",
            proofSnapshot: {
              schemaVersion: 1,
              kind: "PLAYBOOK_FACTUAL_FINAL",
              playbookVersion: 1,
              disposition,
              outcome: disposition,
              cycle: 1,
              stage: event.stage,
              sequence: event.sequence,
              readPath: event.readPath,
              evidenceKind: event.evidenceKind,
              failureFingerprint: event.failureFingerprint,
              observedAt: event.observedAt,
              completedAt: "2026-07-15T20:06:30.000Z",
              releaseSha,
              runtimeVersion: releaseSha,
              providerExecution: false
            },
            verifiedAt: new Date("2026-07-15T20:07:00.000Z"),
            verifiedIncidentUpdatedAt: new Date("2026-07-15T20:06:30.000Z"),
            incident: {
              cycle: 1,
              attemptLedger,
              firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
              lastSeenAt: new Date("2026-07-15T20:05:30.000Z")
            }
          },
          {
            createdAt: new Date("2026-07-15T19:00:00.000Z"),
            releaseSha,
            deployedAt: new Date("2026-07-15T20:05:00.000Z"),
            recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z")
          }
        )
      ).toBe(true);
    }
  );

  it("rejects exact-place terminal proof older than the incident cycle", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "EXACT_PLACE_REVIEW",
            disposition: "VERIFIED_PRIVATE",
            classification: "PRIVATE_MEMBER_AMENITY",
            evidenceOrigin: "https://course.example",
            reviewedAt: "2026-07-15T00:00:00.000Z",
            reviewUpdatedAt: "2026-07-15T18:30:00.000Z",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:00:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("accepts strict browser-private identity evidence as durable terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: browserPrivateProof,
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it("keeps replay-ordered browser-private identity evidence durable", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            ...browserPrivateProof,
            discoveryCreatedAt: "2026-07-15T19:31:00.000Z",
            intelligenceVerifiedAt: "2026-07-15T19:30:00.000Z"
          },
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it.each([
    {
      label: "provider metadata",
      proof: {
        ...browserPrivateProof,
        discoveryApiMetadata: { provider: "unexpected" }
      }
    },
    {
      label: "a future evidence timestamp",
      proof: {
        ...browserPrivateProof,
        discoveryCreatedAt: "2026-07-15T20:01:01.000Z",
        intelligenceVerifiedAt: "2026-07-15T20:01:01.000Z"
      }
    },
    {
      label: "evidence timestamps more than five minutes apart",
      proof: {
        ...browserPrivateProof,
        intelligenceVerifiedAt: "2026-07-15T19:36:01.000Z"
      }
    },
    {
      label: "forged provenance",
      proof: {
        ...browserPrivateProof,
        provenance: "official-private-course-profile:forged"
      }
    },
    {
      label: "tampered course eligibility",
      proof: {
        ...browserPrivateProof,
        courseAutomationEligibility: "ALLOWED"
      }
    },
    {
      label: "tampered policy notes",
      proof: {
        ...browserPrivateProof,
        policyNotes: "Private according to an unverified source."
      }
    }
  ])("rejects durable browser-private proof with $label", ({ proof }) => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: proof,
          verifiedAt: now,
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("keeps a source-backed terminal disposition durable across repeated identical failures", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "MANUAL_DIRECT",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T18:30:00.000Z",
            confidence: 0.9,
            discoveryStatus: "VERIFIED",
            bookingMethod: "PHONE_ONLY",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            discoveryBookingMethod: "PHONE_ONLY",
            discoveryAutomationEligibility: "BLOCKED",
            discoveryAutomationReason: "NO_ONLINE_BOOKING"
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(true);
  });

  it("rejects legacy manual proof without coherent course and discovery fields", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "MANUAL_DIRECT",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T18:30:00.000Z",
            confidence: 0.9
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("rejects a legacy policy-only terminal proof", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "FINAL_DISPOSITION",
          proofSnapshot: {
            kind: "FINAL_DISPOSITION",
            disposition: "AUTOMATION_PROHIBITED",
            evidenceOrigin: "https://course.example",
            discoveryCreatedAt: "2026-07-15T19:30:00.000Z",
            confidence: 0.99
          },
          verifiedAt: new Date("2026-07-15T20:00:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T19:45:00.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T19:45:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T19:00:00.000Z"),
          releaseSha: null,
          deployedAt: null,
          recheckDispatchStartedAt: null
        }
      )
    ).toBe(false);
  });

  it("still requires restored monitoring to supersede the newest failure", () => {
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "RESTORED",
          proofSnapshot: {
            kind: "PROVIDER_PROBE",
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            freshSearchCheckedAt: "2026-07-15T20:06:00.000Z",
            runtimeVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            providerExecution: true
          },
          verifiedAt: new Date("2026-07-15T20:07:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:06:30.000Z"),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T20:06:30.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T20:00:00.000Z"),
          releaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          deployedAt: new Date("2026-07-15T20:05:00.000Z"),
          recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z")
        }
      )
    ).toBe(false);
  });

  it("accepts durable no-email provider proof after deployment and dispatch", () => {
    const releaseSha = "a".repeat(40);
    expect(
      isDurableTerminalProof(
        {
          normalizedResult: "RESTORED",
          proofSnapshot: {
            kind: "PROVIDER_VERIFICATION",
            outcome: "NO_MATCH",
            observedAt: "2026-07-15T20:06:00.000Z",
            completedAt: "2026-07-15T20:06:30.000Z",
            runtimeVersion: releaseSha,
            providerExecution: true,
            providerSnapshotFingerprint: "b".repeat(64)
          },
          verifiedAt: new Date("2026-07-15T20:07:00.000Z"),
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          currentProviderSnapshotFingerprint: "b".repeat(64),
          incident: {
            firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
            lastSeenAt: new Date("2026-07-15T20:04:00.000Z")
          }
        },
        {
          createdAt: new Date("2026-07-15T20:00:00.000Z"),
          releaseSha,
          deployedAt: new Date("2026-07-15T20:05:00.000Z"),
          recheckDispatchStartedAt: new Date("2026-07-15T20:05:30.000Z")
        }
      )
    ).toBe(true);
  });

  it("rejects contradictory online metadata for a no-online-booking disposition", () => {
    expect(
      classifyFreshBatchEvidence({
        batchCreatedAt: now,
        incidentLastSeenAt: new Date("2026-07-15T19:00:00.000Z"),
        course: {
          ...runnableCourse,
          bookingMethod: "PUBLIC_ONLINE",
          automationEligibility: "BLOCKED",
          automationReason: "NO_ONLINE_BOOKING",
          latestDiscovery: {
            status: "VERIFIED",
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "BLOCKED",
            automationReason: "NO_ONLINE_BOOKING",
            sourceUrl: "https://course.example/official-booking",
            bookingUrl: "https://course.example/official-booking",
            confidence: 0.9,
            createdAt: new Date("2026-07-15T19:30:00.000Z")
          }
        }
      }).result
    ).toBe("STALE_EVIDENCE");
  });

  it("dispatches rechecks only on the first persisted release transition", () => {
    const releaseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deployedAt = new Date("2026-07-15T20:05:00.000Z");
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: releaseSha,
        persistedDeployedAt: null,
        nextReleaseSha: null,
        nextDeployedAt: deployedAt
      })
    ).toBe(true);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: null,
        persistedDeployedAt: null,
        nextReleaseSha: releaseSha,
        nextDeployedAt: deployedAt
      })
    ).toBe(true);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: releaseSha,
        persistedDeployedAt: deployedAt,
        nextReleaseSha: releaseSha,
        nextDeployedAt: deployedAt
      })
    ).toBe(false);
    expect(
      shouldDispatchRemediatedCourseRechecks({
        persistedReleaseSha: null,
        persistedDeployedAt: null,
        nextReleaseSha: releaseSha,
        nextDeployedAt: null
      })
    ).toBe(false);
  });

  it("preserves an explicit human escalation across verification", () => {
    expect(
      preserveExplicitHumanVerification({
        result: "NEEDS_HUMAN",
        engineeringOnly: false,
        message: "Provider approval is required."
      })
    ).toMatchObject({
      result: "NEEDS_HUMAN",
      message: "Provider approval is required."
    });
    expect(
      preserveExplicitHumanVerification({
        result: "NEEDS_HUMAN",
        engineeringOnly: true,
        message: "Must remain autonomous."
      })
    ).toMatchObject({
      result: "NEEDS_HUMAN",
      message: "Must remain autonomous."
    });
  });
});

describe("search-specific remediation proof", () => {
  const releaseSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const deployedAt = new Date("2026-07-15T20:05:00.000Z");
  const dispatchedAt = new Date("2026-07-15T20:10:00.000Z");
  const checkedAt = new Date("2026-07-15T20:11:00.000Z");

  function searchEvidence(
    outcome: "MATCH_FOUND" | "NO_MATCH" | "FETCH_FAILED",
    overrides: Record<string, unknown> = {}
  ) {
    return {
      status: "ACTIVE",
      scheduleVersion: 2,
      dispatchedScheduleVersion: 2,
      lastCheckedAt: checkedAt,
      trafficClass: "PUBLIC",
      courseIds: ["course-1"],
      probes: [
        {
          id: `probe-${outcome.toLowerCase()}`,
          courseId: "course-1",
          outcome,
          observedAt: checkedAt,
          runtimeVersion: releaseSha,
          providerExecution: true
        }
      ],
      ...overrides
    };
  }

  it("does not let one search's success hide another affected search's failure", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [searchEvidence("NO_MATCH"), searchEvidence("FETCH_FAILED")],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
    expect(proof.affectedCourseSearchPairCountByCourse.get("course-1")).toBe(2);
    expect(proof.healthyCourseSearchPairCountByCourse.get("course-1")).toBe(1);
  });

  it("requires the claimed runtime and fresh checks for every affected search", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [
        searchEvidence("NO_MATCH"),
        searchEvidence("MATCH_FOUND", {
          probes: [
            {
              id: "wrong-runtime",
              courseId: "course-1",
              outcome: "MATCH_FOUND",
              observedAt: checkedAt,
              runtimeVersion: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              providerExecution: true
            }
          ]
        })
      ],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
  });

  it("does not use a successful probe from another course as remediation proof", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [
        searchEvidence("NO_MATCH", {
          probes: [
            {
              id: "unrelated-course-probe",
              courseId: "course-2",
              outcome: "NO_MATCH",
              observedAt: checkedAt,
              runtimeVersion: releaseSha,
              providerExecution: true
            }
          ]
        })
      ],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.has("course-1")).toBe(false);
  });

  it("accepts a course only after every active affected search has runnable proof", () => {
    const proof = collectFreshRemediatedCourseProof({
      searches: [searchEvidence("NO_MATCH"), searchEvidence("MATCH_FOUND")],
      courseIds: ["course-1"],
      releaseSha,
      deployedAt,
      dispatchedAt
    });

    expect(proof.freshProviderProofByCourse.get("course-1")).toMatchObject({
      runtimeVersion: releaseSha,
      providerExecution: true,
      freshSearchCheckedAt: checkedAt
    });
    expect(proof.healthyCourseSearchPairCountByCourse.get("course-1")).toBe(2);
  });
});

describe("remediated scheduler health", () => {
  const dispatchedAt = new Date("2026-07-15T20:00:00.000Z");
  const observedAt = new Date("2026-07-15T20:30:00.000Z");

  it("requires a WAITING scheduler to retain a non-overdue next wake", () => {
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "WAITING",
          checkLeaseExpiresAt: null,
          nextCheckAt: null,
          updatedAt: observedAt
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "WAITING",
          checkLeaseExpiresAt: null,
          nextCheckAt: new Date("2026-07-15T20:14:59.000Z"),
          updatedAt: observedAt
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
  });

  it("rejects queued, failed, and stale checking states", () => {
    for (const checkStatus of ["QUEUED", "FAILED"]) {
      expect(
        isRemediatedSearchSchedulerHealthy(
          {
            status: "ACTIVE",
            workflowRunId: "workflow-1",
            checkStatus,
            checkLeaseExpiresAt: null,
            nextCheckAt: observedAt,
            updatedAt: observedAt
          },
          dispatchedAt,
          observedAt
        )
      ).toBe(false);
    }
    expect(
      isRemediatedSearchSchedulerHealthy(
        {
          status: "ACTIVE",
          workflowRunId: "workflow-1",
          checkStatus: "CHECKING",
          checkLeaseExpiresAt: new Date("2026-07-15T20:31:00.000Z"),
          nextCheckAt: observedAt,
          updatedAt: new Date("2026-07-15T20:14:59.000Z")
        },
        dispatchedAt,
        observedAt
      )
    ).toBe(false);
  });
});

function expiredRecoveryBatch(
  incidentStates: Array<"AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED">
) {
  const releaseSha = "c".repeat(40);
  return {
    id: "batch-1",
    status: "VERIFYING",
    leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
    ownerThreadId: "old-thread",
    ownerAutomationRunId: "run-1",
    providerFamilyKey: "UNKNOWN",
    failureFingerprint: "unknown-provider",
    baseSha: releaseSha,
    releaseSha,
    deployedAt: new Date("2026-07-15T19:05:00.000Z"),
    recheckDispatchKey: null,
    recheckDispatchStartedAt: null,
    recheckDispatchedAt: null,
    revision: 3,
    summary: {
      branch: "automation/course-support-old",
      plannedPaths: ["src/lib/provider.ts"]
    },
    incidents: incidentStates.map((status, index) => {
      const suffix = index + 1;
      const updatedAt = new Date(`2026-07-15T19:${30 + index}:00.000Z`);
      const resolution =
        status === "RESOLVED"
          ? index % 2 === 0
            ? "MONITORING_RESTORED"
            : "IDENTITY_CLASSIFIED"
          : null;
      return {
        id: `batch-entry-${suffix}`,
        incidentId: `incident-${suffix}`,
        courseId: `course-${suffix}`,
        cycle: 2,
        result: "STALE_EVIDENCE",
        proofSnapshot: null,
        updatedAt: new Date(`2026-07-15T19:${40 + index}:00.000Z`),
        course: {
          monitoringStatus: {
            state: status === "AUTO_INVESTIGATING" ? "DEGRADED_RETRYING" : "AUTO_INVESTIGATING",
            revision: 7 + index,
            lastSuccessfulAt: null
          }
        },
        incident: {
          status,
          resolution,
          decisionAt: status === "RESOLVED" ? updatedAt : null,
          cycle: 2,
          activeBatchId: "batch-1",
          updatedAt
        }
      };
    })
  };
}

describe("course-support recovery", () => {
  it("does not recover a persisted implementation reservation beside another checkout owner", async () => {
    const batch = {
      ...expiredRecoveryBatch(["AUTO_INVESTIGATING"]),
      status: "CLAIMED",
      releaseSha: null,
      deployedAt: null,
      summary: {
        branch: "automation/course-support-old",
        plannedPaths: [],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "TYPED_ADAPTER",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED",
          retryBudget: null
        }
      }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(batch);
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        id: "other-batch",
        status: "IMPLEMENTING",
        providerFamilyKey: "OTHER_PROVIDER",
        failureFingerprint: "other-fingerprint",
        summary: { plannedPaths: ["src/lib/unrelated-provider.ts"] }
      }
    ]);

    await expect(
      recoverCourseSupportBatch({
        batchId: batch.id,
        requestingThreadId: "new-thread",
        currentBranch: "automation/course-support-old",
        currentHeadSha: batch.baseSha,
        dirtyPaths: [],
        releaseIsPublished: false,
        now
      })
    ).resolves.toMatchObject({
      outcome: "deferred_busy",
      recovered: false
    });

    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("allows a clean expired batch to move to a new task", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        plannedPaths: [],
        dirtyPaths: [],
        now
      }).action
    ).toBe("RECOVER");
  });

  it("blocks another task from adopting dirty work", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        plannedPaths: ["src/lib/provider.ts"],
        dirtyPaths: ["src/lib/provider.ts"],
        now
      }).action
    ).toBe("BLOCK");
  });

  it("recovers a clean committed planned-path change before release heartbeat", () => {
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "old-thread",
        requestingThreadId: "new-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        plannedPaths: ["src/lib/provider.ts"],
        committedPaths: ["src/lib/provider.ts"],
        baseIsAncestor: true,
        dirtyPaths: [],
        now
      }).action
    ).toBe("RECOVER");
  });

  it("lets only the same task recover a planned descendant of a persisted release", () => {
    const input = {
      leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
      ownerThreadId: "owner-thread",
      requestingThreadId: "owner-thread",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      releaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      expectedBranch: "automation/course-support-20260715-190000",
      currentBranch: "automation/course-support-20260715-190000",
      currentHeadSha: "cccccccccccccccccccccccccccccccccccccccc",
      plannedPaths: ["src/lib/provider.ts"],
      committedPaths: ["src/lib/provider.ts"],
      releaseCommittedPaths: ["src/lib/provider.ts"],
      baseIsAncestor: true,
      releaseIsAncestor: true,
      dirtyPaths: [],
      now
    };

    expect(assessCourseSupportRecovery(input).action).toBe("RECOVER");
    expect(
      assessCourseSupportRecovery({
        ...input,
        requestingThreadId: "different-thread"
      }).action
    ).toBe("BLOCK");
    expect(
      assessCourseSupportRecovery({
        ...input,
        releaseIsAncestor: false
      }).action
    ).toBe("BLOCK");
  });

  it("keeps observed Git-path whitespace exact and blocks a lookalike claimed path", () => {
    const observedPaths = normalizeCourseSupportObservedGitPaths([" src\\lib\\provider.ts"]);

    expect(observedPaths).toEqual([" src/lib/provider.ts"]);
    expect(
      assessCourseSupportRecovery({
        leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
        ownerThreadId: "owner-thread",
        requestingThreadId: "owner-thread",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        releaseSha: null,
        expectedBranch: "automation/course-support-20260715-190000",
        currentBranch: "automation/course-support-20260715-190000",
        currentHeadSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        plannedPaths: ["src/lib/provider.ts"],
        committedPaths: observedPaths,
        baseIsAncestor: true,
        dirtyPaths: [],
        now
      }).action
    ).toBe("BLOCK");
  });

  it("requeues only expired clean work without a published release or terminal evidence", () => {
    const safeInput = {
      leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
      baseSha: "b".repeat(40),
      releaseSha: null,
      releaseIsPublished: false,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      dirtyPaths: [],
      incidentResults: ["PENDING" as const],
      now
    };

    expect(canSafelyRequeueExpiredCourseSupportBatch(safeInput)).toBe(true);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        releaseSha: "a".repeat(40)
      })
    ).toBe(true);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        releaseSha: safeInput.baseSha,
        releaseIsPublished: true,
        deployedAt: new Date("2026-07-15T19:10:00.000Z"),
        recheckDispatchKey: "dispatch-key",
        recheckDispatchStartedAt: new Date("2026-07-15T19:15:00.000Z"),
        recheckDispatchedAt: new Date("2026-07-15T19:16:00.000Z"),
        incidentResults: ["RETRY_SCHEDULED"]
      })
    ).toBe(true);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        releaseSha: "a".repeat(40),
        releaseIsPublished: true
      })
    ).toBe(false);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        releaseSha: safeInput.baseSha,
        releaseIsPublished: true,
        deployedAt: new Date("2026-07-15T19:10:00.000Z")
      })
    ).toBe(true);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        releaseSha: "a".repeat(40),
        releaseIsPublished: false,
        deployedAt: new Date("2026-07-15T19:10:00.000Z")
      })
    ).toBe(false);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        dirtyPaths: ["src/lib/provider.ts"]
      })
    ).toBe(false);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        recheckDispatchKey: "dispatch-key"
      })
    ).toBe(false);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        recheckDispatchKey: "dispatch-key",
        recheckDispatchStartedAt: new Date("2026-07-15T19:15:00.000Z"),
        recheckDispatchedAt: new Date("2026-07-15T19:16:00.000Z"),
        incidentResults: ["STALE_EVIDENCE"]
      })
    ).toBe(true);
    expect(
      canSafelyRequeueExpiredCourseSupportBatch({
        ...safeInput,
        incidentResults: ["FINAL_DISPOSITION"]
      })
    ).toBe(false);
  });

  it("durably reconciles an expired deployed retry instead of deadlocking on provenance", async () => {
    const expiredAt = new Date("2026-07-15T19:00:00.000Z");
    const incidentUpdatedAt = new Date("2026-07-15T19:30:00.000Z");
    const batchEntryUpdatedAt = new Date("2026-07-15T19:31:00.000Z");
    const candidateReleaseSha = "c".repeat(40);
    const recheckDispatchStartedAt = new Date("2026-07-15T19:15:00.000Z");
    const recheckDispatchedAt = new Date("2026-07-15T19:16:00.000Z");
    const deployedAt = new Date("2026-07-15T19:05:00.000Z");
    const providerRetryNotBeforeAt = new Date("2026-07-15T20:30:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      leaseExpiresAt: expiredAt,
      ownerThreadId: "old-thread",
      ownerAutomationRunId: "run-1",
      baseSha: candidateReleaseSha,
      releaseSha: candidateReleaseSha,
      deployedAt,
      recheckDispatchKey: "dispatch-key",
      recheckDispatchStartedAt,
      recheckDispatchedAt,
      revision: 3,
      summary: {
        branch: "automation/course-support-old",
        plannedPaths: ["src/lib/provider.ts"]
      },
      incidents: [
        {
          id: "batch-entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 2,
          result: "RETRY_SCHEDULED",
          proofSnapshot: {
            kind: "PROVIDER_VERIFICATION_FAILURE",
            status: "RETRYABLE_FAILED",
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            observedAt: "2026-07-15T19:45:00.000Z",
            completedAt: "2026-07-15T19:46:00.000Z",
            nextAttemptAt: "2026-07-15T20:20:00.000Z",
            providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString(),
            runtimeVersion: candidateReleaseSha,
            providerExecution: true,
            providerSnapshotFingerprint: "a".repeat(64)
          },
          updatedAt: batchEntryUpdatedAt,
          course: {
            monitoringStatus: {
              state: "DEGRADED_RETRYING",
              revision: 7,
              lastSuccessfulAt: null
            }
          },
          incident: {
            status: "AUTO_INVESTIGATING",
            resolution: null,
            decisionAt: null,
            cycle: 2,
            activeBatchId: "batch-1",
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.monitoringStatusUpdateMany.mockResolvedValue({ count: 0 });

    const result = await recoverCourseSupportBatch({
      batchId: "batch-1",
      requestingThreadId: "new-thread",
      currentBranch: "fix/release-expired-responder-work",
      currentHeadSha: "b".repeat(40),
      dirtyPaths: [],
      releaseIsPublished: true,
      baseIsAncestor: false,
      committedPaths: [],
      now
    });

    expect(result).toMatchObject({
      outcome: "retryable_failed",
      recovered: false,
      safelyRequeued: true,
      durableCloseoutRecorded: true,
      nextAttemptAt: providerRetryNotBeforeAt.toISOString(),
      threadDisposition: "ARCHIVE"
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-1",
          status: "VERIFYING",
          releaseSha: candidateReleaseSha,
          deployedAt,
          recheckDispatchKey: "dispatch-key",
          recheckDispatchStartedAt,
          recheckDispatchedAt,
          completedAt: null
        }),
        data: expect.objectContaining({
          status: "RETRYABLE_FAILED",
          completedAt: now
        })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-1",
          result: "RETRY_SCHEDULED",
          updatedAt: batchEntryUpdatedAt
        }),
        data: expect.objectContaining({
          result: "RETRY_SCHEDULED"
        })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          activeBatchId: "batch-1",
          updatedAt: incidentUpdatedAt
        }),
        data: expect.objectContaining({
          activeBatchId: null,
          nextAttemptAt: providerRetryNotBeforeAt
        })
      })
    );
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        state: "DEGRADED_RETRYING",
        revision: 7,
        lastSuccessfulAt: null
      },
      data: {
        state: "AUTO_INVESTIGATING",
        nextAutomaticAttemptAt: providerRetryNotBeforeAt,
        stateChangedAt: now,
        revision: { increment: 1 }
      }
    });
    expect(prismaMocks.automationRunUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "run-1", completedAt: null },
        data: expect.objectContaining({
          kind: "COURSE_SUPPORT",
          status: "COMPLETED",
          outcome: "retryable_failed"
        })
      })
    );
    expect(prismaMocks.batchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseExpiresAt: { gt: now }
        })
      })
    );
  });

  it("records safe-requeue no-progress attempts so two abandoned tasks are parked", async () => {
    const courseRef = createHash("sha256").update("course-1").digest("hex").slice(0, 24);
    const approach = {
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      strategyAction: "REPAIR_PROVIDER_ADAPTER",
      playbookStage: "OFFICIAL_IDENTITY"
    };
    const expiredBatch = {
      ...expiredRecoveryBatch(["AUTO_INVESTIGATING"]),
      status: "CLAIMED",
      ownerAutomationRunId: null,
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
      releaseSha: null,
      deployedAt: null,
      summary: {
        branch: "automation/course-support-old",
        plannedPaths: [],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "OFFICIAL_IDENTITY",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED",
          attempts: [
            {
              courseRef,
              providerSnapshotFingerprint: "b".repeat(64),
              approach
            }
          ]
        }
      }
    };
    expiredBatch.incidents[0].result = "PENDING";
    Object.assign(expiredBatch.incidents[0].incident, {
      failureFingerprint: expiredBatch.failureFingerprint,
      activeRealSearchCount: 0,
      batchIncidents: []
    });
    prismaMocks.batchFindUnique.mockResolvedValue(expiredBatch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      recoverCourseSupportBatch({
        batchId: expiredBatch.id,
        requestingThreadId: "new-thread",
        currentBranch: "fix/unrelated-head",
        currentHeadSha: "b".repeat(40),
        dirtyPaths: [],
        releaseIsPublished: false,
        baseIsAncestor: false,
        now
      })
    ).resolves.toMatchObject({ safelyRequeued: true });

    const recoveredSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(recoveredSummary?.closeout).toMatchObject({
      remediationAttemptConsumed: false,
      remediationAttempts: [
        expect.objectContaining({
          courseRef,
          consumed: false,
          providerSnapshotFingerprint: "b".repeat(64),
          failureFingerprint: expiredBatch.failureFingerprint,
          approach,
          operationalRetry: expect.objectContaining({
            attemptsCompleted: 1,
            exhausted: false
          })
        })
      ]
    });

    const updatedAt = new Date("2026-07-15T19:30:00.000Z");
    const dueIncident = {
      ...candidate({
        cycle: 2,
        updatedAt,
        failureClass: "SCHEMA",
        failureFingerprint: expiredBatch.failureFingerprint
      }),
      confirmedAt: now,
      attemptLedger: null,
      batchIncidents: [
        { cycle: 2, batch: { summary: recoveredSummary } },
        { cycle: 2, batch: { summary: recoveredSummary } }
      ],
      course: {
        timeZone: "America/New_York",
        preferences: [],
        isPublic: true,
        website: "https://public-course.example/",
        detectedBookingUrl: "https://www.chronogolf.com/club/public-course",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        bookingMetadata: {
          clubId: 1,
          courseIds: ["course-1"],
          bookingBaseUrl: "https://www.chronogolf.com/club/public-course"
        },
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "ALLOWED",
        automationReason: "NONE",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null
      }
    };
    prismaMocks.batchFindMany.mockReset().mockResolvedValue([]);
    prismaMocks.batchCreate.mockClear();
    prismaMocks.supportIncidentFindMany.mockReset().mockResolvedValue([dueIncident]);
    prismaMocks.supportIncidentFindUnique.mockResolvedValue({
      id: dueIncident.id,
      courseId: dueIncident.courseId,
      cycle: dueIncident.cycle,
      revision: 3,
      status: "AUTO_INVESTIGATING",
      activeBatchId: null,
      resolution: null,
      resolvedAt: null,
      updatedAt,
      failureFingerprint: dueIncident.failureFingerprint,
      engineeringOnly: dueIncident.engineeringOnly,
      activeRealSearchCount: dueIncident.activeRealSearchCount,
      earliestTargetDate: dueIncident.earliestTargetDate,
      escalatedAt: null
    });
    prismaMocks.monitoringStatusFindUnique.mockResolvedValue({
      state: "AUTO_INVESTIGATING",
      stateChangedAt: updatedAt,
      lastSuccessfulAt: null,
      revision: 2
    });
    prismaMocks.transaction.mockImplementation(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    const abandonedResult = await claimCourseSupportBatch({
      ownerThreadId: "owner-after-two-abandoned-tasks",
      branch: "automation/course-support-20260715-200000",
      baseSha: "d".repeat(40),
      now
    });
    expect(abandonedResult).toMatchObject({
      outcome: "no_due_work",
      parkedForMaterialChangeCount: 1
    });
    expect(prismaMocks.batchCreate).not.toHaveBeenCalled();
  });

  it("atomically closes terminal members and requeues only unresolved work in an expired batch", async () => {
    const batch = expiredRecoveryBatch([
      "NEEDS_HUMAN",
      "NEEDS_HUMAN",
      "NEEDS_HUMAN",
      "AUTO_INVESTIGATING"
    ]);
    const retryAt = new Date(now.getTime() + 60_000);
    prismaMocks.batchFindUnique.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await recoverCourseSupportBatch({
      batchId: batch.id,
      requestingThreadId: "new-thread",
      currentBranch: "fix/recover-mixed-expired-work",
      currentHeadSha: "b".repeat(40),
      dirtyPaths: [],
      releaseIsPublished: true,
      now
    });

    expect(result).toMatchObject({
      outcome: "needs_human",
      recovered: false,
      safelyRequeued: true,
      superseded: true,
      durableCloseoutRecorded: true,
      nextAttemptAt: retryAt.toISOString(),
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: batch.id,
          status: "VERIFYING",
          revision: 3,
          leaseExpiresAt: { lte: now },
          releaseSha: batch.releaseSha,
          deployedAt: batch.deployedAt,
          completedAt: null
        }),
        data: expect.objectContaining({
          status: "PARTIAL",
          completedAt: now,
          summary: expect.objectContaining({
            closeout: expect.objectContaining({
              outcome: "needs_human",
              derivedOutcome: "needs_human",
              failureDomain: "GIT",
              terminalCount: 0,
              retryCount: 1,
              needsHumanCount: 3,
              reason: "expired_mixed_reconciled_without_adoption"
            })
          })
        })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledTimes(4);
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-4",
          result: "STALE_EVIDENCE"
        }),
        data: expect.objectContaining({ result: "RETRY_SCHEDULED" })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-entry-1",
          result: "STALE_EVIDENCE"
        }),
        data: expect.objectContaining({ result: "NEEDS_HUMAN" })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledTimes(4);
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-4",
        cycle: 2,
        activeBatchId: batch.id,
        status: "AUTO_INVESTIGATING"
      }),
      data: expect.objectContaining({
        activeBatchId: null,
        nextAttemptAt: retryAt
      })
    });
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith({
      where: {
        courseId: "course-4",
        state: "DEGRADED_RETRYING",
        revision: 10,
        lastSuccessfulAt: null
      },
      data: {
        state: "AUTO_INVESTIGATING",
        nextAutomaticAttemptAt: retryAt,
        stateChangedAt: now,
        revision: { increment: 1 }
      }
    });
    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          batchIncident: { batchId: batch.id },
          status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] }
        }),
        data: expect.objectContaining({
          status: "STALE",
          completedAt: now,
          lastError: "batch_mixed_reconciled"
        })
      })
    );
  });

  it("releases stale batch ownership from every member of an all-terminal expired batch", async () => {
    const batch = expiredRecoveryBatch(["NEEDS_HUMAN", "RESOLVED"]);
    prismaMocks.batchFindUnique.mockResolvedValue(batch);
    prismaMocks.supportIncidentFindMany.mockResolvedValue(
      batch.incidents.map((entry) => ({
        id: entry.incidentId,
        ...entry.incident
      }))
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await recoverCourseSupportBatch({
      batchId: batch.id,
      requestingThreadId: "new-thread",
      currentBranch: "fix/recover-all-terminal-work",
      currentHeadSha: "b".repeat(40),
      dirtyPaths: [],
      releaseIsPublished: true,
      now
    });

    expect(result).toMatchObject({
      outcome: "needs_human",
      recovered: false,
      superseded: true,
      durableCloseoutRecorded: true
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledTimes(2);
    for (const entry of batch.incidents) {
      expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith({
        where: {
          id: entry.incidentId,
          cycle: entry.cycle,
          activeBatchId: batch.id,
          status: entry.incident.status,
          resolution: entry.incident.resolution,
          decisionAt: entry.incident.decisionAt,
          updatedAt: entry.incident.updatedAt
        },
        data: {
          activeBatchId: null,
          revision: { increment: 1 }
        }
      });
    }
    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "STALE",
          lastError: "batch_superseded"
        })
      })
    );
  });

  it("fails mixed recovery when terminal ownership changes after the batch snapshot", async () => {
    const batch = expiredRecoveryBatch(["NEEDS_HUMAN", "AUTO_INVESTIGATING"]);
    prismaMocks.batchFindUnique.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      recoverCourseSupportBatch({
        batchId: batch.id,
        requestingThreadId: "new-thread",
        currentBranch: "fix/recover-raced-work",
        currentHeadSha: "b".repeat(40),
        dirtyPaths: [],
        releaseIsPublished: true,
        now
      })
    ).rejects.toThrow("mixed terminal ownership release");
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "incident-1",
        cycle: 2,
        activeBatchId: batch.id,
        status: "NEEDS_HUMAN",
        updatedAt: batch.incidents[0].incident.updatedAt
      }),
      data: {
        activeBatchId: null,
        revision: { increment: 1 }
      }
    });
  });

  it("does not recover checkout-owning implementation beside another checkout owner", async () => {
    const batch = {
      ...expiredRecoveryBatch(["AUTO_INVESTIGATING"]),
      status: "IMPLEMENTING" as const,
      summary: {
        branch: "fix/recover-cps",
        plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"]
      }
    };
    prismaMocks.batchFindUnique.mockResolvedValue(batch);
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        id: "batch-2",
        status: "IMPLEMENTING",
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "chronogolf-schema",
        summary: {
          plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"]
        }
      }
    ]);

    await expect(
      recoverCourseSupportBatch({
        batchId: batch.id,
        requestingThreadId: "new-thread",
        currentBranch: "fix/recover-cps",
        currentHeadSha: batch.baseSha,
        dirtyPaths: [],
        releaseIsPublished: true,
        now
      })
    ).resolves.toMatchObject({
      outcome: "deferred_busy",
      recovered: false
    });
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("recovers no-path work beside an unrelated active checkout owner", async () => {
    const expiredAt = new Date("2026-07-15T19:00:00.000Z");
    const incidentUpdatedAt = new Date("2026-07-15T19:30:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "CLAIMED",
      leaseExpiresAt: expiredAt,
      ownerThreadId: "old-thread",
      ownerAutomationRunId: null,
      providerFamilyKey: "CPS",
      failureFingerprint: "cps-timeout",
      baseSha: "a".repeat(40),
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      revision: 1,
      summary: {
        branch: "fix/recover-cps",
        plannedPaths: []
      },
      incidents: [
        {
          id: "batch-entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result: "PENDING",
          updatedAt: incidentUpdatedAt,
          incident: {
            status: "AUTO_INVESTIGATING",
            resolution: null,
            decisionAt: null,
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        id: "batch-2",
        status: "IMPLEMENTING",
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "chronogolf-schema",
        summary: {
          plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"]
        }
      }
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      recoverCourseSupportBatch({
        batchId: "batch-1",
        requestingThreadId: "new-thread",
        currentBranch: "fix/recover-cps",
        currentHeadSha: "a".repeat(40),
        dirtyPaths: [],
        releaseIsPublished: false,
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", recovered: true });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-1",
          leaseExpiresAt: { lte: now }
        })
      })
    );
  });

  it("defers recovery for an active batch with overlapping provider scope", async () => {
    const incidentUpdatedAt = new Date("2026-07-15T19:30:00.000Z");
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "CLAIMED",
      leaseExpiresAt: new Date("2026-07-15T19:00:00.000Z"),
      ownerThreadId: "old-thread",
      ownerAutomationRunId: null,
      providerFamilyKey: "CPS",
      failureFingerprint: "cps-timeout",
      baseSha: "a".repeat(40),
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      revision: 1,
      summary: { branch: "fix/recover-cps", plannedPaths: [] },
      incidents: [
        {
          id: "batch-entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result: "PENDING",
          updatedAt: incidentUpdatedAt,
          incident: {
            status: "AUTO_INVESTIGATING",
            resolution: null,
            decisionAt: null,
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        id: "batch-2",
        providerFamilyKey: "CPS",
        failureFingerprint: "cps-schema",
        summary: { plannedPaths: [] }
      }
    ]);

    await expect(
      recoverCourseSupportBatch({
        batchId: "batch-1",
        requestingThreadId: "new-thread",
        currentBranch: "fix/recover-cps",
        currentHeadSha: "a".repeat(40),
        dirtyPaths: [],
        releaseIsPublished: false,
        now
      })
    ).resolves.toMatchObject({ outcome: "deferred_busy", recovered: false });
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("closes expired ownership superseded by a later durable course decision", async () => {
    const expiredAt = new Date("2026-07-15T19:00:00.000Z");
    const decidedAt = new Date("2026-07-15T19:20:00.000Z");
    const incidentUpdatedAt = new Date("2026-07-15T19:21:00.000Z");
    const batchEntryUpdatedAt = new Date("2026-07-15T19:10:00.000Z");
    const terminalIncident = {
      id: "incident-1",
      status: "RESOLVED",
      resolution: "IDENTITY_CLASSIFIED",
      decisionAt: decidedAt,
      cycle: 2,
      activeBatchId: "batch-1",
      updatedAt: incidentUpdatedAt
    };
    prismaMocks.batchFindUnique.mockResolvedValue({
      id: "batch-1",
      status: "VERIFYING",
      leaseExpiresAt: expiredAt,
      ownerThreadId: "old-thread",
      ownerAutomationRunId: "run-1",
      baseSha: "a".repeat(40),
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      revision: 3,
      summary: {
        branch: "automation/course-support-old",
        plannedPaths: []
      },
      incidents: [
        {
          id: "batch-entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 2,
          result: "STALE_EVIDENCE",
          updatedAt: batchEntryUpdatedAt,
          incident: {
            status: terminalIncident.status,
            resolution: terminalIncident.resolution,
            decisionAt: terminalIncident.decisionAt,
            cycle: terminalIncident.cycle,
            activeBatchId: terminalIncident.activeBatchId,
            updatedAt: terminalIncident.updatedAt
          }
        }
      ]
    });
    prismaMocks.supportIncidentFindMany.mockResolvedValue([terminalIncident]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await recoverCourseSupportBatch({
      batchId: "batch-1",
      requestingThreadId: "new-thread",
      currentBranch: "fix/close-stale-course-investigations",
      currentHeadSha: "b".repeat(40),
      dirtyPaths: [],
      releaseIsPublished: false,
      now
    });

    expect(result).toMatchObject({
      outcome: "classification_only",
      recovered: false,
      superseded: true,
      durableCloseoutRecorded: true
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SUCCEEDED",
          completedAt: now
        })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "FINAL_DISPOSITION"
        })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "incident-1",
        cycle: 2,
        activeBatchId: "batch-1",
        status: "RESOLVED",
        resolution: "IDENTITY_CLASSIFIED",
        decisionAt: decidedAt,
        updatedAt: incidentUpdatedAt
      },
      data: {
        activeBatchId: null,
        revision: { increment: 1 }
      }
    });
  });
});

describe("course-support inspection ownership", () => {
  const inspection = {
    hasActiveBatch: true,
    activeBatchOwnerThreadId: "owner-thread",
    requestingThreadId: "owner-thread",
    hasExpiredBatch: false,
    dueIncidentCount: 4
  };

  it("resumes a healthy batch owned by the requesting task", () => {
    expect(classifyCourseSupportQueueInspection(inspection)).toBe("resume_owned_work");
  });

  it.each([undefined, null, "different-thread"])(
    "defers when the active batch is not proven to belong to the requester (%s)",
    (requestingThreadId) => {
      expect(
        classifyCourseSupportQueueInspection({
          ...inspection,
          requestingThreadId
        })
      ).toBe("deferred_busy");
    }
  );

  it("prioritizes expired recovery before unrelated due work when a writer slot is open", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: true
      })
    ).toBe("recovery_required");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        activeBatchCount: 4,
        maxActiveBatches: 5,
        requestingThreadId: "different-thread",
        hasExpiredBatch: true
      })
    ).toBe("recovery_required");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        activeBatchCount: 5,
        maxActiveBatches: 5,
        requestingThreadId: "different-thread",
        hasExpiredBatch: true
      })
    ).toBe("deferred_busy");
  });

  it("preserves empty and ready queue outcomes without an active writer", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: false,
        dueIncidentCount: 0
      })
    ).toBe("no_due_work");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        hasExpiredBatch: false
      })
    ).toBe("ready");
  });

  it("keeps due engineering work ready throughout the hour", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        dueIncidentCount: 1
      })
    ).toBe("ready");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        hasActiveBatch: false,
        dueIncidentCount: 5
      })
    ).toBe("ready");
  });

  it("keeps unrelated work ready until five provider groups are active", () => {
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        activeBatchCount: 4,
        maxActiveBatches: 5,
        requestingThreadId: "different-thread",
        dueIncidentCount: 1
      })
    ).toBe("ready");
    expect(
      classifyCourseSupportQueueInspection({
        ...inspection,
        activeBatchCount: 5,
        maxActiveBatches: 5,
        requestingThreadId: "different-thread",
        dueIncidentCount: 1
      })
    ).toBe("deferred_busy");
  });

  it("finalizes only old repeated source gaps without active real demand", () => {
    const evidence = {
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE" as const,
      attemptCount: 4,
      activeRealSearchCount: 0,
      firstSeenAt: new Date("2026-07-20T20:00:00.000Z"),
      verifiedAt: new Date("2026-07-22T20:00:00.000Z"),
      result: "RETRY_SCHEDULED" as const,
      now: new Date("2026-07-22T20:00:00.000Z")
    };
    expect(shouldFinalizeSourceUnverified(evidence)).toBe(true);
    expect(
      shouldFinalizeSourceUnverified({
        ...evidence,
        activeRealSearchCount: 1
      })
    ).toBe(false);
    expect(
      shouldFinalizeSourceUnverified({
        ...evidence,
        attemptCount: 3
      })
    ).toBe(false);
  });

  it("selects the owner internally and resumes only the same task", async () => {
    prismaMocks.batchFindMany.mockResolvedValueOnce([
      {
        id: "batch-1",
        reference: "batch-reference",
        status: "VERIFYING",
        leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "network",
        ownerThreadId: "owner-thread"
      }
    ]);
    prismaMocks.batchFindFirst.mockResolvedValueOnce(null);

    const result = await inspectCourseSupportQueue({
      requestingThreadId: "owner-thread",
      now
    });

    expect(result).toMatchObject({
      outcome: "resume_owned_work",
      ownedByCurrentTask: true,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(prismaMocks.batchFindMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        select: expect.objectContaining({ ownerThreadId: true })
      })
    );
    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
  });

  it("reports live demand separately from historical real provenance", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        confirmedAt: now,
        providerFamilyKey: "FOREUP",
        failureFingerprint: "historical",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:30:00.000Z"),
        firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        course: { timeZone: "America/New_York", preferences: [] }
      },
      {
        confirmedAt: now,
        providerFamilyKey: "FOREUP",
        failureFingerprint: "live",
        engineeringOnly: true,
        escalationDeadlineAt: new Date("2026-07-15T20:20:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:50:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "search-live",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      },
      {
        confirmedAt: now,
        providerFamilyKey: "CPS",
        failureFingerprint: "synthetic",
        engineeringOnly: true,
        escalationDeadlineAt: new Date("2026-07-15T20:30:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:00:00.000Z"),
        course: { timeZone: "America/New_York", preferences: [] }
      }
    ]);
    prismaMocks.batchFindFirst.mockResolvedValue(null);

    await expect(inspectCourseSupportQueue({ now })).resolves.toMatchObject({
      outcome: "ready",
      dueIncidentCount: 3,
      dueRealCount: 1,
      dueHistoricalRealCount: 1,
      dueEngineeringCount: 1,
      providerGroupCount: 3
    });
    expect(prismaMocks.supportIncidentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                { confirmedAt: { not: null } },
                expect.objectContaining({ course: expect.any(Object) })
              ])
            })
          ])
        }),
        select: expect.objectContaining({
          confirmedAt: true,
          attemptLedger: true,
          escalatedAt: true,
          course: expect.objectContaining({ select: expect.any(Object) })
        })
      })
    );
  });

  it("includes due unconfirmed live demand only at a responder-owned browser stage", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        cycle: 1,
        confirmedAt: null,
        attemptLedger: browserReadyAttemptLedger(),
        providerFamilyKey: "LIVE_BROWSER_GROUP",
        failureFingerprint: "live-browser",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:28:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:58:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "live-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      },
      {
        cycle: 1,
        confirmedAt: null,
        attemptLedger: browserReadyAttemptLedger(),
        providerFamilyKey: "NO_DEMAND_GROUP",
        failureFingerprint: "no-demand",
        engineeringOnly: true,
        escalationDeadlineAt: new Date("2026-07-15T20:28:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:58:00.000Z"),
        course: { timeZone: "America/New_York", preferences: [] }
      }
    ]);

    await expect(inspectCourseSupportQueue({ now })).resolves.toMatchObject({
      outcome: "ready",
      dueIncidentCount: 1,
      dueRealCount: 1,
      dueHistoricalRealCount: 0,
      dueEngineeringCount: 0,
      readOnlyDispatchPlan: {
        groups: [
          expect.objectContaining({
            providerFamilyKey: "LIVE_BROWSER_GROUP",
            activeRealDemandCount: 1
          })
        ]
      }
    });
  });

  it("shows nearest-deadline active customer groups first in the inspect plan", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        confirmedAt: now,
        providerFamilyKey: "OLDER_GROUP",
        failureFingerprint: "older",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:25:00.000Z"),
        firstSeenAt: new Date("2026-07-15T18:00:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "older-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      },
      {
        confirmedAt: now,
        providerFamilyKey: "NEW_ALERT_GROUP",
        failureFingerprint: "new-alert",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:10:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:55:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "new-alert-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      }
    ]);

    const result = await inspectCourseSupportQueue({ now });

    expect(result.readOnlyDispatchPlan.groups.map((group) => group.providerFamilyKey)).toEqual([
      "NEW_ALERT_GROUP",
      "OLDER_GROUP"
    ]);
  });

  it("publishes a deadline-ordered dispatch plan for up to two provider groups", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) => ({
        confirmedAt: now,
        providerFamilyKey: `GROUP_${index + 1}`,
        failureFingerprint: `fingerprint-${index + 1}`,
        engineeringOnly: false,
        escalationDeadlineAt: new Date(
          `2026-07-15T20:${String(index + 6).padStart(2, "0")}:00.000Z`
        ),
        firstSeenAt: new Date("2026-07-15T19:30:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: `search-${index + 1}`,
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      }))
    );

    const result = await inspectCourseSupportQueue({ now });

    expect(result).toMatchObject({
      outcome: "ready",
      availableWriterSlots: 2,
      readOnlyDispatchPlan: {
        maxProviderGroups: 2
      }
    });
    expect(result.readOnlyDispatchPlan.groups.map((group) => group.providerFamilyKey)).toEqual([
      "GROUP_1",
      "GROUP_2"
    ]);
    expect(prismaMocks.batchFindMany.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ take: 2 })
    );
  });

  it("shows a never-escalated customer endpoint before an earlier human-review recheck", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        cycle: 2,
        confirmedAt: now,
        attemptLedger: exhaustedAttemptLedger(),
        providerFamilyKey: "ALREADY_HUMAN_GROUP",
        failureFingerprint: "already-human",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:05:00.000Z"),
        escalatedAt: new Date("2026-07-15T14:00:00.000Z"),
        firstSeenAt: new Date("2026-07-15T14:00:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "already-human-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      },
      {
        cycle: 1,
        confirmedAt: null,
        attemptLedger: browserReadyAttemptLedger(),
        providerFamilyKey: "NEW_ALERT_GROUP",
        failureFingerprint: "new-alert",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:08:00.000Z"),
        escalatedAt: null,
        firstSeenAt: new Date("2026-07-15T19:38:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "new-alert-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      }
    ]);

    const result = await inspectCourseSupportQueue({ now });

    expect(result.readOnlyDispatchPlan.groups.map((group) => group.providerFamilyKey)).toEqual([
      "NEW_ALERT_GROUP",
      "ALREADY_HUMAN_GROUP"
    ]);
  });

  it.each([
    ["missing", null],
    ["invalid", { version: 1, events: "invalid" }],
    ["unexhausted", browserReadyAttemptLedger(2)]
  ])(
    "keeps a stale escalation marker with %s playbook proof in the initial-endpoint tier",
    async (_proofState, staleAttemptLedger) => {
      prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
        {
          cycle: 2,
          confirmedAt: now,
          attemptLedger: exhaustedAttemptLedger(),
          providerFamilyKey: "PROVEN_HUMAN_GROUP",
          failureFingerprint: "proven-human",
          engineeringOnly: false,
          escalationDeadlineAt: new Date("2026-07-15T20:05:00.000Z"),
          escalatedAt: new Date("2026-07-15T14:00:00.000Z"),
          firstSeenAt: new Date("2026-07-15T14:00:00.000Z"),
          course: {
            timeZone: "America/New_York",
            preferences: [
              {
                teeSearch: {
                  id: "proven-human-search",
                  date: new Date("2026-07-18T00:00:00.000Z")
                }
              }
            ]
          }
        },
        {
          cycle: 2,
          confirmedAt: now,
          attemptLedger: staleAttemptLedger,
          providerFamilyKey: "STALE_MARKER_GROUP",
          failureFingerprint: "stale-marker",
          engineeringOnly: false,
          escalationDeadlineAt: new Date("2026-07-15T20:08:00.000Z"),
          escalatedAt: new Date("2026-07-15T13:00:00.000Z"),
          firstSeenAt: new Date("2026-07-15T13:00:00.000Z"),
          course: {
            timeZone: "America/New_York",
            preferences: [
              {
                teeSearch: {
                  id: "stale-marker-search",
                  date: new Date("2026-07-18T00:00:00.000Z")
                }
              }
            ]
          }
        }
      ]);

      const result = await inspectCourseSupportQueue({ now });

      expect(result.readOnlyDispatchPlan.groups.map((group) => group.providerFamilyKey)).toEqual([
        "STALE_MARKER_GROUP",
        "PROVEN_HUMAN_GROUP"
      ]);
    }
  );

  it("preserves due dispatch work for one reinspection after expired recovery", async () => {
    prismaMocks.supportIncidentFindMany.mockResolvedValueOnce([
      {
        confirmedAt: now,
        providerFamilyKey: "DUE_GROUP",
        failureFingerprint: "due",
        engineeringOnly: false,
        escalationDeadlineAt: new Date("2026-07-15T20:10:00.000Z"),
        firstSeenAt: new Date("2026-07-15T19:55:00.000Z"),
        course: {
          timeZone: "America/New_York",
          preferences: [
            {
              teeSearch: {
                id: "due-search",
                date: new Date("2026-07-18T00:00:00.000Z")
              }
            }
          ]
        }
      }
    ]);
    prismaMocks.batchFindFirst.mockResolvedValueOnce({
      id: "expired-batch",
      reference: "expired-reference",
      status: "VERIFYING",
      leaseExpiresAt: new Date("2026-07-15T19:59:00.000Z")
    });

    await expect(inspectCourseSupportQueue({ now })).resolves.toMatchObject({
      outcome: "recovery_required",
      recoveryContinuation: {
        reinspectAfterRecovery: true,
        dueIncidentCount: 1,
        availableWriterSlots: 2
      },
      readOnlyDispatchPlan: {
        groups: [{ providerFamilyKey: "DUE_GROUP" }]
      }
    });
  });

  it("resumes owned responder work without consulting the hourly lane", async () => {
    prismaMocks.batchFindMany.mockResolvedValueOnce([
      {
        id: "batch-1",
        reference: "batch-reference",
        status: "VERIFYING",
        leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
        providerFamilyKey: "CHRONOGOLF",
        failureFingerprint: "network",
        ownerThreadId: "owner-thread"
      }
    ]);
    prismaMocks.batchFindFirst.mockResolvedValueOnce(null);
    const result = await inspectCourseSupportQueue({
      requestingThreadId: "owner-thread",
      now
    });

    expect(result).toMatchObject({
      outcome: "resume_owned_work",
      ownedByCurrentTask: true,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(prismaMocks.automationRunFindFirst).not.toHaveBeenCalled();
    expect(prismaMocks.automationRunCreate).not.toHaveBeenCalled();
  });

  it.each([undefined, "different-thread"])(
    "keeps inspect fail-closed for an unproven requester (%s)",
    async (requestingThreadId) => {
      prismaMocks.batchFindMany.mockResolvedValueOnce([
        {
          id: "batch-1",
          reference: "batch-reference",
          status: "VERIFYING",
          leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z"),
          providerFamilyKey: "CHRONOGOLF",
          failureFingerprint: "network",
          ownerThreadId: "owner-thread"
        }
      ]);
      prismaMocks.batchFindFirst.mockResolvedValueOnce(null);

      const result = await inspectCourseSupportQueue({
        requestingThreadId,
        now
      });

      expect(result).toMatchObject({
        outcome: "no_due_work",
        ownedByCurrentTask: false,
        durableCloseoutRecorded: true,
        threadDisposition: "ARCHIVE"
      });
      expect(prismaMocks.automationRunCreate).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects a blank requester identity before reading queue state", async () => {
    await expect(inspectCourseSupportQueue({ requestingThreadId: " ", now })).rejects.toThrow(
      "current task id"
    );
    expect(prismaMocks.batchFindFirst).not.toHaveBeenCalled();
  });
});

describe("course-support batch ordinals", () => {
  it("uses course name before creation time and id for stable packet/history ordinals", () => {
    const entries = [
      {
        id: "entry-1",
        createdAt: new Date("2026-07-15T18:00:00.000Z"),
        course: { name: "Zulu Course" }
      },
      {
        id: "entry-3",
        createdAt: new Date("2026-07-15T19:00:00.000Z"),
        course: { name: "Alpha Course" }
      },
      {
        id: "entry-2",
        createdAt: new Date("2026-07-15T19:00:00.000Z"),
        course: { name: "Alpha Course" }
      }
    ];

    expect(orderCourseSupportBatchIncidents(entries).map((entry) => entry.id)).toEqual([
      "entry-2",
      "entry-3",
      "entry-1"
    ]);
  });

  it("exposes only the current-cycle playbook exhaustion decision", async () => {
    const incident = (input: { id: string; name: string; attemptLedger: unknown }) => ({
      id: input.id,
      createdAt: now,
      cycle: 1,
      result: "STALE_EVIDENCE",
      course: {
        name: input.name,
        website: null,
        detectedBookingUrl: null,
        detectedPlatform: null,
        bookingMethod: "UNKNOWN",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: null,
        providerFamilyKey: "UNKNOWN"
      },
      incident: {
        kind: "NEEDS_ADAPTER",
        failureClass: "UNSUPPORTED_FAMILY",
        engineeringOnly: false,
        activeRealSearchCount: 1,
        earliestTargetDate: null,
        attemptCount: 1,
        attemptLedger: input.attemptLedger,
        latestMessage: null,
        nextAction: null,
        firstSeenAt: now,
        lastSeenAt: now
      }
    });
    prismaMocks.batchFindFirst.mockResolvedValue({
      reference: "batch-reference",
      providerFamilyKey: "UNKNOWN",
      failureFingerprint: "bounded-fingerprint",
      createdAt: now,
      incidents: [
        incident({ id: "entry-1", name: "Alpha", attemptLedger: null }),
        incident({
          id: "entry-2",
          name: "Bravo",
          attemptLedger: exhaustedAttemptLedger()
        })
      ]
    });

    const result = await getCourseSupportBatchPacket({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      now
    });

    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") {
      throw new Error("Expected a ready packet.");
    }
    expect(
      result.courses.map(({ ordinal, playbookExhausted }) => ({
        ordinal,
        playbookExhausted
      }))
    ).toEqual([
      { ordinal: "01", playbookExhausted: false },
      { ordinal: "02", playbookExhausted: true }
    ]);
    expect(result.courses[1]).not.toHaveProperty("attemptLedger");
    expect(result.courses.every((course) => !("name" in course))).toBe(true);
  });

  it("claims implementation scope only while the shared checkout is otherwise idle", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "CLAIMED",
      revision: 2,
      releaseSha: null,
      summary: { plannedPaths: [] },
      ownerAutomationRunId: null
    });
    prismaMocks.batchFindMany.mockResolvedValue([]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      appendCourseSupportBatchPath({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        path: "src/lib/tee-times/adapters/cps/fetch.ts",
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", pathRecorded: true });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IMPLEMENTING" })
      })
    );
  });

  it("claims the first implementation path beside no-path responder batches", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "CLAIMED",
      revision: 2,
      releaseSha: null,
      summary: { plannedPaths: [] },
      ownerAutomationRunId: null
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "VERIFYING",
        summary: { plannedPaths: [] }
      }
    ]);

    await expect(
      appendCourseSupportBatchPath({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        path: "src/lib/tee-times/adapters/cps/normalize.ts",
        now
      })
    ).resolves.toMatchObject({ outcome: "ready", pathRecorded: true });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "IMPLEMENTING",
          summary: expect.objectContaining({
            plannedPaths: ["src/lib/tee-times/adapters/cps/normalize.ts"]
          })
        })
      })
    );
  });

  it("rejects a second implementation path owner", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "CLAIMED",
      revision: 2,
      releaseSha: null,
      summary: { plannedPaths: [] },
      ownerAutomationRunId: null
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "IMPLEMENTING",
        summary: {
          plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"]
        }
      }
    ]);

    await expect(
      appendCourseSupportBatchPath({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        path: "src/lib/tee-times/adapters/cps/normalize.ts",
        now
      })
    ).rejects.toThrow("exclusive access");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("waits for a claimed implementation reservation before claiming a path", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "CLAIMED",
      revision: 2,
      releaseSha: null,
      summary: { plannedPaths: [] },
      ownerAutomationRunId: null
    });
    prismaMocks.batchFindMany
      .mockResolvedValueOnce([
        {
          status: "CLAIMED",
          summary: {
            plannedPaths: [],
            remediation: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER",
              allowUnchangedRuntime: false,
              requiresImplementationPath: true,
              reason: "IMPLEMENTATION_REQUIRED",
              retryBudget: null
            }
          }
        }
      ])
      .mockResolvedValueOnce([]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    const input = {
      batchId: "verification-batch",
      leaseToken: "verification-lease",
      ownerThreadId: "verification-thread",
      path: "src/lib/tee-times/adapters/cps/normalize.ts",
      now
    };

    await expect(appendCourseSupportBatchPath(input)).rejects.toThrow("exclusive access");
    await expect(appendCourseSupportBatchPath(input)).resolves.toMatchObject({
      outcome: "ready",
      pathRecorded: true
    });

    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe("course-support follow-up releases", () => {
  const previousReleaseSha = "a".repeat(40);
  const nextReleaseSha = "b".repeat(40);
  const branch = "automation/course-support-20260715-190000";

  it("accepts a nonempty same-branch descendant containing only planned paths", () => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: nextReleaseSha,
        expectedBranch: branch,
        plannedPaths: ["src/lib/provider.ts"],
        advanceProof: {
          fromSha: previousReleaseSha,
          toSha: nextReleaseSha,
          branch,
          committedPaths: ["src/lib/provider.ts"],
          descendantVerified: true
        }
      })
    ).toEqual({ action: "ADVANCE", reasons: [] });
  });

  it.each([
    {
      label: "mismatched target SHA",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: "c".repeat(40),
        branch,
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: true
      }
    },
    {
      label: "sibling release",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: false
      }
    },
    {
      label: "wrong branch",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch: "automation/course-support-other",
        committedPaths: ["src/lib/provider.ts"],
        descendantVerified: true
      }
    },
    {
      label: "empty delta",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: [],
        descendantVerified: true
      }
    },
    {
      label: "unplanned path",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: ["src/lib/unplanned.ts"],
        descendantVerified: true
      }
    },
    {
      label: "whitespace lookalike path",
      advanceProof: {
        fromSha: previousReleaseSha,
        toSha: nextReleaseSha,
        branch,
        committedPaths: [" src/lib/provider.ts"],
        descendantVerified: true
      }
    }
  ])("rejects a $label", ({ advanceProof }) => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: nextReleaseSha,
        expectedBranch: branch,
        plannedPaths: ["src/lib/provider.ts"],
        advanceProof
      }).action
    ).toBe("REJECT");
  });

  it("archives prior deployment and verification evidence without duplicating unchanged releases", () => {
    expect(
      assessCourseSupportReleaseTransition({
        persistedReleaseSha: previousReleaseSha,
        requestedReleaseSha: previousReleaseSha,
        expectedBranch: branch,
        plannedPaths: []
      }).action
    ).toBe("UNCHANGED");

    const summary = buildCourseSupportReleaseHistory({
      summary: {
        branch,
        plannedPaths: ["src/lib/provider.ts"],
        recheckDispatch: { attempted: true }
      },
      previousReleaseSha,
      previousDeployedAt: new Date("2026-07-15T20:05:00.000Z"),
      previousRecheckDispatchKey: "dispatch-key",
      previousRecheckDispatchStartedAt: new Date("2026-07-15T20:06:00.000Z"),
      previousRecheckDispatchedAt: new Date("2026-07-15T20:07:00.000Z"),
      previousIncidentVerifications: [
        {
          ordinal: 1,
          result: "FINAL_DISPOSITION",
          message: "Reviewed final disposition.",
          proofSnapshot: { kind: "EXACT_PLACE_REVIEW" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:08:00.000Z")
        }
      ],
      nextReleaseSha,
      advancedAt: new Date("2026-07-15T20:10:00.000Z")
    }) as Record<string, unknown>;

    expect(summary.recheckDispatch).toBeNull();
    expect(summary.releaseHistory).toEqual([
      expect.objectContaining({
        releaseSha: previousReleaseSha,
        deployedAt: "2026-07-15T20:05:00.000Z",
        supersededBy: nextReleaseSha,
        supersededAt: "2026-07-15T20:10:00.000Z",
        incidentVerifications: [
          expect.objectContaining({
            ordinal: 1,
            result: "FINAL_DISPOSITION"
          })
        ]
      })
    ]);
  });
});

describe("course-support release Git reconciliation", () => {
  const baseSha = "a".repeat(40);
  const persistedReleaseSha = "b".repeat(40);
  const originMainSha = "c".repeat(40);
  const requestedReleaseSha = "d".repeat(40);

  it("checks only the responder delta after a trusted concurrent main advance", () => {
    expect(
      chooseCourseSupportReleaseDiffBase({
        baseSha,
        persistedReleaseSha: null,
        requestedReleaseSha,
        originMainSha,
        claimedBaseIsAncestorOfOriginMain: true,
        originMainIsAncestorOfRequestedRelease: true
      })
    ).toBe(originMainSha);
  });

  it("checks a follow-up release after concurrent main from the trusted main tip", () => {
    expect(
      chooseCourseSupportReleaseDiffBase({
        baseSha,
        persistedReleaseSha,
        requestedReleaseSha,
        originMainSha,
        claimedBaseIsAncestorOfOriginMain: true,
        originMainIsAncestorOfRequestedRelease: true
      })
    ).toBe(originMainSha);
  });

  it("falls back to the durable responder base when main is unrelated", () => {
    expect(
      chooseCourseSupportReleaseDiffBase({
        baseSha,
        persistedReleaseSha,
        requestedReleaseSha,
        originMainSha,
        claimedBaseIsAncestorOfOriginMain: false,
        originMainIsAncestorOfRequestedRelease: true
      })
    ).toBe(persistedReleaseSha);
  });

  it("does not re-derive paths after the exact release was durably fenced", () => {
    expect(
      chooseCourseSupportReleaseDiffBase({
        baseSha,
        persistedReleaseSha: requestedReleaseSha,
        requestedReleaseSha,
        originMainSha: requestedReleaseSha,
        claimedBaseIsAncestorOfOriginMain: true,
        originMainIsAncestorOfRequestedRelease: true
      })
    ).toBeNull();
  });

  it("allows evidence-only verification on the unchanged claimed runtime", () => {
    expect(
      canVerifyUnchangedCourseSupportRuntime({
        allowUnchangedRuntime: true,
        remediationAllowsUnchangedRuntime: true,
        baseSha,
        persistedReleaseSha: null,
        requestedReleaseSha: baseSha,
        plannedPaths: []
      })
    ).toBe(true);
  });

  it.each([
    {
      label: "when the remediation route requires implementation",
      allowUnchangedRuntime: true,
      remediationAllowsUnchangedRuntime: false,
      persistedReleaseSha: null,
      requestedReleaseSha: baseSha,
      plannedPaths: [] as string[]
    },
    {
      label: "without an explicit current-runtime request",
      allowUnchangedRuntime: false,
      persistedReleaseSha: null,
      requestedReleaseSha: baseSha,
      plannedPaths: [] as string[]
    },
    {
      label: "after a release was already fenced",
      allowUnchangedRuntime: true,
      persistedReleaseSha,
      requestedReleaseSha: baseSha,
      plannedPaths: [] as string[]
    },
    {
      label: "for a different commit",
      allowUnchangedRuntime: true,
      persistedReleaseSha: null,
      requestedReleaseSha,
      plannedPaths: [] as string[]
    },
    {
      label: "after implementation paths were claimed",
      allowUnchangedRuntime: true,
      persistedReleaseSha: null,
      requestedReleaseSha: baseSha,
      plannedPaths: ["src/lib/adapters/example.ts"]
    }
  ])("rejects unchanged-runtime verification $label", (candidate) => {
    expect(
      canVerifyUnchangedCourseSupportRuntime({
        ...candidate,
        remediationAllowsUnchangedRuntime:
          "remediationAllowsUnchangedRuntime" in candidate
            ? candidate.remediationAllowsUnchangedRuntime
            : true,
        baseSha
      })
    ).toBe(false);
  });
});

describe("course-support release heartbeat persistence", () => {
  const previousReleaseSha = "a".repeat(40);
  const nextReleaseSha = "b".repeat(40);
  const branch = "automation/course-support-20260715-190000";
  const deployedAt = new Date("2026-07-15T20:05:00.000Z");

  function ownedBatch() {
    return {
      status: "VERIFYING",
      revision: 7,
      releaseSha: previousReleaseSha,
      deployedAt,
      recheckDispatchKey: "dispatch-key",
      recheckDispatchStartedAt: new Date("2026-07-15T20:06:00.000Z"),
      recheckDispatchedAt: new Date("2026-07-15T20:07:00.000Z"),
      summary: {
        branch,
        plannedPaths: ["src/lib/provider.ts"],
        recheckDispatch: { attempted: true }
      },
      incidents: [
        {
          id: "entry-zulu",
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          course: { name: "Zulu Course" },
          result: "NEEDS_HUMAN",
          message: "Owner action is still required.",
          proofSnapshot: { kind: "HUMAN_ACTION" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:03:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:08:00.000Z")
        },
        {
          id: "entry-alpha",
          createdAt: new Date("2026-07-15T19:00:00.000Z"),
          course: { name: "Alpha Course" },
          result: "FINAL_DISPOSITION",
          message: "Reviewed final disposition.",
          proofSnapshot: { kind: "EXACT_PLACE_REVIEW" },
          verifiedIncidentUpdatedAt: new Date("2026-07-15T20:04:00.000Z"),
          verifiedAt: new Date("2026-07-15T20:09:00.000Z")
        }
      ]
    };
  }

  const advanceProof = {
    fromSha: previousReleaseSha,
    toSha: nextReleaseSha,
    branch,
    committedPaths: ["src/lib/provider.ts"],
    descendantVerified: true
  };

  it("rejects unchanged-runtime heartbeat for an implementation-required route", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      baseSha: previousReleaseSha,
      status: "CLAIMED",
      revision: 1,
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      summary: {
        branch,
        plannedPaths: [],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "OFFICIAL_IDENTITY",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED"
        }
      },
      incidents: []
    });

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        status: "VERIFYING",
        releaseSha: previousReleaseSha,
        now
      })
    ).rejects.toThrow("unchanged-runtime verification is not allowed");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects a docs-only implementation release even when its claimed diff is committed", async () => {
    const docsPath = "docs/course-support-provider-notes/example.md";
    prismaMocks.batchFindFirst.mockResolvedValue({
      baseSha: previousReleaseSha,
      status: "CLAIMED",
      revision: 1,
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      summary: {
        branch,
        plannedPaths: [docsPath],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "TYPED_ADAPTER",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED"
        }
      },
      incidents: []
    });

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        status: "VERIFYING",
        releaseSha: nextReleaseSha,
        releaseAdvanceProof: {
          fromSha: previousReleaseSha,
          toSha: nextReleaseSha,
          branch,
          committedPaths: [docsPath],
          descendantVerified: true
        },
        now
      })
    ).rejects.toThrow("no runtime-bearing");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("persists initial release provenance when runtime source ships alongside docs", async () => {
    const runtimePath = "src/lib/tee-times/adapters/example/fetch.ts";
    const docsPath = "docs/course-support-provider-notes/example.md";
    const batch = {
      baseSha: previousReleaseSha,
      status: "CLAIMED",
      revision: 1,
      releaseSha: null,
      deployedAt: null,
      recheckDispatchKey: null,
      recheckDispatchStartedAt: null,
      recheckDispatchedAt: null,
      summary: {
        branch,
        plannedPaths: [runtimePath, docsPath],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "TYPED_ADAPTER",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED"
        }
      },
      incidents: []
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        status: "VERIFYING",
        releaseSha: nextReleaseSha,
        releaseAdvanceProof: {
          fromSha: previousReleaseSha,
          toSha: nextReleaseSha,
          branch,
          committedPaths: [runtimePath, docsPath],
          descendantVerified: true
        },
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      releaseSha: nextReleaseSha
    });

    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          releaseSha: nextReleaseSha,
          summary: expect.objectContaining({
            releaseProvenance: {
              schemaVersion: 1,
              fromSha: previousReleaseSha,
              toSha: nextReleaseSha,
              branch,
              committedPaths: [docsPath, runtimePath],
              descendantVerified: true
            }
          })
        })
      })
    );
  });

  it("uses the persisted route budget after a material-change reopen", () => {
    const remediationDirective = {
      workMode: "VERIFY_TRANSIENT" as const,
      strategyAction: "RETRY_PROVIDER" as const,
      playbookStage: null,
      allowUnchangedRuntime: true,
      requiresImplementationPath: false,
      reason: "MATERIAL_CHANGE_REOPENED",
      retryBudget: {
        maximumAttempts: 4,
        attemptsCompleted: 0,
        attemptsRemaining: 4,
        exhausted: false
      }
    };

    expect(
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective,
        failureClass: "RATE_LIMIT",
        attemptCount: 9,
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: null
      })
    ).toBe(true);
    expect(
      shouldContinueSettledCourseSupportRemediation({
        remediationDirective: {
          ...remediationDirective,
          retryBudget: {
            maximumAttempts: 4,
            attemptsCompleted: 3,
            attemptsRemaining: 1,
            exhausted: false
          }
        },
        failureClass: "RATE_LIMIT",
        attemptCount: 12,
        playbookConclusion: "INCOMPLETE",
        nextPlaybookStage: null
      })
    ).toBe(false);
  });

  it("renews a no-path operation lease without serializing against a checkout owner", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "VERIFYING",
      revision: 4,
      summary: { plannedPaths: [] }
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "IMPLEMENTING",
        summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
      }
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      renewCourseSupportBatchOperationLease({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      heartbeatRecorded: true,
      leaseExpiresAt: "2026-07-15T20:15:00.000Z"
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        status: "VERIFYING",
        revision: 4,
        leaseExpiresAt: { gte: now }
      }),
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date("2026-07-15T20:15:00.000Z")
      }
    });
    expect(leaseMocks.withPostgresAdvisoryTextLease).not.toHaveBeenCalled();
    expect(prismaMocks.batchFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.queryRaw).not.toHaveBeenCalled();
  });

  it("renews the sole checkout owner under the writer lease and database clock", async () => {
    const databaseNow = new Date("2026-07-15T20:00:02.000Z");
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "IMPLEMENTING",
      revision: 8,
      summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
    });
    prismaMocks.queryRaw.mockResolvedValue([{ now: databaseNow }]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      renewCourseSupportBatchOperationLease({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "ready",
      heartbeatRecorded: true,
      leaseExpiresAt: "2026-07-15T20:15:02.000Z"
    });
    expect(leaseMocks.withPostgresAdvisoryTextLease).toHaveBeenCalledTimes(1);
    expect(prismaMocks.batchFindMany).toHaveBeenCalledWith({
      where: {
        id: { not: "batch-1" },
        status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
        leaseExpiresAt: { gt: databaseNow }
      },
      select: { status: true, summary: true }
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        status: "IMPLEMENTING",
        revision: 8,
        leaseExpiresAt: { gt: databaseNow }
      }),
      data: {
        heartbeatAt: databaseNow,
        leaseExpiresAt: new Date("2026-07-15T20:15:02.000Z")
      }
    });
  });

  it("rejects a delayed expired checkout-owner renewal after a new path owner wins", async () => {
    const beforeExpiry = new Date("2026-07-15T19:59:59.000Z");
    const afterExpiry = new Date("2026-07-15T20:00:01.000Z");
    let releaseRenewal!: () => void;
    let renewalPaused!: () => void;
    const waitForRenewal = new Promise<void>((resolve) => {
      releaseRenewal = resolve;
    });
    const renewalReachedWriterLease = new Promise<void>((resolve) => {
      renewalPaused = resolve;
    });
    leaseMocks.withPostgresAdvisoryTextLease
      .mockImplementationOnce(async (_client: unknown, _key: string, worker: () => Promise<unknown>) => {
        renewalPaused();
        await waitForRenewal;
        return { acquired: true, value: await worker() };
      })
      .mockImplementationOnce(
        async (_client: unknown, _key: string, worker: () => Promise<unknown>) => ({
          acquired: true,
          value: await worker()
        })
      );
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce({
        status: "IMPLEMENTING",
        revision: 8,
        summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
      })
      .mockResolvedValueOnce({
        status: "CLAIMED",
        revision: 2,
        releaseSha: null,
        summary: { plannedPaths: [] },
        ownerAutomationRunId: null
      })
      .mockResolvedValueOnce(null);
    prismaMocks.queryRaw.mockResolvedValue([{ now: afterExpiry }]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    const renewalPromise = renewCourseSupportBatchOperationLease({
      batchId: "expired-owner",
      leaseToken: "expired-lease",
      ownerThreadId: "expired-thread",
      now: beforeExpiry
    });
    await renewalReachedWriterLease;
    const pathClaim = await appendCourseSupportBatchPath({
      batchId: "new-owner",
      leaseToken: "new-lease",
      ownerThreadId: "new-thread",
      path: "src/lib/tee-times/adapters/chronogolf/fetch.ts",
      now: afterExpiry
    });
    releaseRenewal();
    const renewal = await renewalPromise;

    expect(pathClaim).toMatchObject({ outcome: "ready", pathRecorded: true });
    expect(renewal).toMatchObject({
      outcome: "recovery_required",
      heartbeatRecorded: false
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "new-owner" }),
        data: expect.objectContaining({
          status: "IMPLEMENTING",
          summary: expect.objectContaining({
            plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"]
          })
        })
      })
    );
  });

  it("rejects checkout-owner renewal while another live checkout owner exists", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "IMPLEMENTING",
      revision: 8,
      summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "VERIFYING",
        summary: { plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"] }
      }
    ]);

    await expect(
      renewCourseSupportBatchOperationLease({
        batchId: "batch-1",
        leaseToken: "lease-token",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "recovery_required",
      heartbeatRecorded: false
    });
    expect(leaseMocks.withPostgresAdvisoryTextLease).toHaveBeenCalledTimes(1);
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps a claimed batch classification-only when a heartbeat omits status", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      ...ownedBatch(),
      status: "CLAIMED",
      releaseSha: null,
      deployedAt: null,
      summary: { branch, plannedPaths: [] }
    });
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      now
    });

    expect(result).toMatchObject({ outcome: "ready", heartbeatRecorded: true });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "CLAIMED" })
      })
    );
    expect(leaseMocks.withPostgresAdvisoryTextLease).not.toHaveBeenCalled();
    expect(prismaMocks.queryRaw).not.toHaveBeenCalled();
  });

  it("keeps a no-path verification heartbeat concurrent with a checkout owner", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      ...ownedBatch(),
      summary: { branch, plannedPaths: [] }
    });
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "IMPLEMENTING",
        summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
      }
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      now
    });

    expect(result).toMatchObject({ outcome: "ready", heartbeatRecorded: true });
    expect(leaseMocks.withPostgresAdvisoryTextLease).not.toHaveBeenCalled();
    expect(prismaMocks.batchFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a checkout-owner heartbeat when another live checkout owner exists", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());
    prismaMocks.batchFindMany.mockResolvedValue([
      {
        status: "IMPLEMENTING",
        summary: { plannedPaths: ["src/lib/tee-times/adapters/cps/fetch.ts"] }
      }
    ]);

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      now
    });

    expect(result).toMatchObject({
      outcome: "recovery_required",
      heartbeatRecorded: false
    });
    expect(leaseMocks.withPostgresAdvisoryTextLease).toHaveBeenCalledTimes(1);
    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("waits for a claimed implementation reservation before entering IMPLEMENTING", async () => {
    const verificationBatch = {
      ...ownedBatch(),
      status: "IMPLEMENTING",
      releaseSha: null,
      deployedAt: null,
      summary: {
        branch,
        plannedPaths: ["src/lib/tee-times/adapters/cps/normalize.ts"]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch);
    prismaMocks.batchFindMany
      .mockResolvedValueOnce([
        {
          status: "CLAIMED",
          summary: {
            plannedPaths: [],
            remediation: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER",
              allowUnchangedRuntime: false,
              requiresImplementationPath: true,
              reason: "IMPLEMENTATION_REQUIRED",
              retryBudget: null
            }
          }
        }
      ])
      .mockResolvedValueOnce([]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    const input = {
      batchId: "verification-batch",
      leaseToken: "verification-lease",
      ownerThreadId: "verification-thread",
      status: "IMPLEMENTING" as const,
      now
    };

    await expect(heartbeatCourseSupportBatch(input)).resolves.toMatchObject({
      outcome: "recovery_required",
      heartbeatRecorded: false
    });
    await expect(heartbeatCourseSupportBatch(input)).resolves.toMatchObject({
      outcome: "ready",
      heartbeatRecorded: true
    });

    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("requires path ownership before a claimed batch can enter IMPLEMENTING", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      ...ownedBatch(),
      status: "CLAIMED",
      releaseSha: null,
      deployedAt: null,
      summary: { branch, plannedPaths: [] }
    });

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        status: "IMPLEMENTING",
        now
      })
    ).rejects.toThrow("claim a planned path");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("advances with owner/CAS fences, archives stable ordinals, and resets only machine proof", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      releaseSha: nextReleaseSha,
      releaseAdvanceProof: advanceProof,
      now
    });

    expect(result).toMatchObject({
      outcome: "ready",
      releaseSha: nextReleaseSha,
      releaseAdvanced: true
    });
    expect(prismaMocks.batchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          status: "VERIFYING",
          revision: 7,
          releaseSha: previousReleaseSha,
          deployedAt
        }),
        data: expect.objectContaining({
          status: "VERIFYING",
          releaseSha: nextReleaseSha,
          deployedAt: null,
          recheckDispatchKey: null,
          recheckDispatchStartedAt: null,
          recheckDispatchedAt: null
        })
      })
    );
    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith({
      where: {
        batchId: "batch-1",
        result: { not: "NEEDS_HUMAN" }
      },
      data: {
        result: "PENDING",
        postProbeId: null,
        message: null,
        proofSnapshot: expect.anything(),
        verifiedIncidentUpdatedAt: null,
        verifiedAt: null
      }
    });

    const updateInput = prismaMocks.batchUpdateMany.mock.calls[0]?.[0] as {
      data: { summary: { releaseHistory: Array<Record<string, unknown>> } };
    };
    expect(updateInput.data.summary.releaseHistory[0]?.incidentVerifications).toEqual([
      expect.objectContaining({ ordinal: 1, result: "FINAL_DISPOSITION" }),
      expect.objectContaining({ ordinal: 2, result: "NEEDS_HUMAN" })
    ]);
  });

  it("requires an explicit VERIFYING transition before advancing", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());

    await expect(
      heartbeatCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        status: "IMPLEMENTING",
        releaseSha: nextReleaseSha,
        releaseAdvanceProof: advanceProof,
        now
      })
    ).rejects.toThrow("explicitly enter VERIFYING");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("does not reset incident proof when the batch compare-and-set loses", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(ownedBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 0 });

    const result = await heartbeatCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      status: "VERIFYING",
      releaseSha: nextReleaseSha,
      releaseAdvanceProof: advanceProof,
      now
    });

    expect(result).toMatchObject({
      outcome: "recovery_required",
      releaseAdvanced: false
    });
    expect(prismaMocks.incidentUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects release verification until deployment proof exists", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      releaseSha: previousReleaseSha,
      deployedAt: null,
      incidents: []
    });

    await expect(
      verifyCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        releaseSha: previousReleaseSha,
        now
      })
    ).rejects.toThrow("requires deployment proof");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });
});

describe("detached verification atomic batch fences", () => {
  const releaseSha = "a".repeat(40);
  const providerFingerprint = "b".repeat(64);
  const observedAt = new Date("2026-07-15T19:56:00.000Z");
  const completedAt = new Date("2026-07-15T19:57:00.000Z");
  const incidentUpdatedAt = new Date("2026-07-15T19:45:00.000Z");

  function providerCourse(
    overrides: Partial<{
      isPublic: boolean;
      bookingMethod: "PUBLIC_ONLINE" | "PHONE_ONLY";
      automationEligibility: "ALLOWED" | "BLOCKED";
      automationReason: "NONE" | "ACCOUNT_REQUIRED" | "NO_ONLINE_BOOKING";
      intelligenceVerifiedAt: Date | null;
      intelligenceReviewAt: Date | null;
      intelligenceConfidence: number | null;
      monitoringStatus: {
        state: "AUTO_INVESTIGATING" | "HEALTHY" | "FINAL_MANUAL";
        lastSuccessfulAt: Date | null;
        revision: number;
      } | null;
    }> = {}
  ) {
    return {
      timeZone: "America/Los_Angeles",
      isPublic: true,
      website: "https://course.example/",
      detectedBookingUrl: "https://booking.example/tee-times",
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "booking.example",
      bookingMethod: "PUBLIC_ONLINE",
      bookingWindowDaysAhead: 7,
      bookingReleaseTimeLocal: "07:00",
      bookingWindowSource: "COURSE_POLICY",
      bookingWindowEvidenceUrl: "https://course.example/booking-policy",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null,
      bookingMetadata: { adapter: "example" },
      monitoringStatus: {
        state: "AUTO_INVESTIGATING",
        lastSuccessfulAt: new Date("2026-07-15T18:00:00.000Z"),
        revision: 4
      },
      ...overrides
    };
  }

  function proofEvidence() {
    return {
      schemaVersion: 1,
      kind: "PROVIDER_VERIFICATION",
      releaseSha,
      runtimeVersion: releaseSha,
      providerExecution: true,
      outcome: "NO_MATCH",
      observedAt: observedAt.toISOString(),
      providerSnapshotFingerprint: providerFingerprint
    };
  }

  function eligibleProof() {
    return {
      eligible: true as const,
      releaseSha,
      runtimeVersion: releaseSha,
      outcome: "NO_MATCH" as const,
      providerExecution: true,
      completedAt,
      providerSnapshotFingerprint: providerFingerprint,
      evidence: proofEvidence()
    };
  }

  function atomicRequest(course = providerCourse(), engineeringOnly = true) {
    return {
      courseId: "course-1",
      releaseSha,
      runtimeVersion: releaseSha,
      status: "SUCCEEDED",
      leaseToken: null,
      leaseExpiresAt: null,
      outcome: "NO_MATCH",
      evidence: proofEvidence(),
      providerSnapshotFingerprint: providerFingerprint,
      completedAt,
      batchIncident: {
        id: "entry-1",
        batchId: "batch-1",
        incidentId: "incident-1",
        courseId: "course-1",
        cycle: 1,
        batch: {
          id: "batch-1",
          status: "VERIFYING",
          ownerThreadId: "owner-thread",
          leaseToken: "lease-1",
          leaseExpiresAt: new Date("2026-07-15T21:00:00.000Z"),
          releaseSha,
          completedAt: null
        },
        incident: {
          id: "incident-1",
          cycle: 1,
          status: "AUTO_INVESTIGATING",
          activeBatchId: "batch-1",
          engineeringOnly
        },
        course
      }
    };
  }

  function verificationBatch(engineeringOnly = true) {
    return {
      id: "batch-1",
      status: "VERIFYING",
      revision: 7,
      releaseSha,
      deployedAt: new Date("2026-07-15T19:50:00.000Z"),
      recheckDispatchKey: null,
      recheckDispatchStartedAt: new Date("2026-07-15T19:51:00.000Z"),
      recheckDispatchedAt: null,
      summary: null,
      createdAt: new Date("2026-07-15T18:00:00.000Z"),
      incidents: [
        {
          id: "entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result: "PENDING",
          preProbeId: null,
          postProbeId: null,
          message: null,
          proofSnapshot: null,
          updatedAt: incidentUpdatedAt,
          incident: {
            cycle: 1,
            status: "AUTO_INVESTIGATING",
            engineeringOnly,
            activeBatchId: "batch-1",
            firstSeenAt: new Date("2026-07-15T18:30:00.000Z"),
            lastSeenAt: incidentUpdatedAt,
            updatedAt: incidentUpdatedAt
          },
          course: {
            googlePlaceId: null,
            isPublic: true,
            bookingMethod: "PUBLIC_ONLINE",
            automationEligibility: "ALLOWED",
            automationReason: "NONE",
            automationDiscoveries: []
          }
        }
      ]
    };
  }

  function healthyDetachedDispatch() {
    return {
      recheckDispatch: {
        attempted: true,
        dispatchError: false,
        detachedVerificationDispatchError: false,
        schedulerHealthComplete: true,
        courseOutcomeHealthComplete: true,
        affectedSearchCount: 0,
        currentAffectedSearchCount: 0,
        queuedCount: 0,
        queueFailureCount: 0,
        directStartCount: 0,
        healthySchedulerCount: 0,
        freshSearchCheckCount: 0,
        restoredCourseCount: 1,
        provenRunnableCourseCount: 1,
        affectedCourseSearchPairCount: 0,
        healthyCourseSearchPairCount: 0,
        schedulerHealthObservedAt: now.toISOString()
      }
    };
  }

  function detachedFailureProof(
    overrides: Partial<{
      status: "RETRYABLE_FAILED" | "STALE";
      nextAttemptAt: string | null;
      providerRetryNotBeforeAt: string | null;
    }> = {}
  ) {
    return {
      kind: "PROVIDER_VERIFICATION_FAILURE",
      status: "RETRYABLE_FAILED" as const,
      outcome: "FETCH_FAILED",
      failureClass: "RATE_LIMIT",
      observedAt: observedAt.toISOString(),
      completedAt: null,
      nextAttemptAt: null,
      providerRetryNotBeforeAt: null,
      runtimeVersion: releaseSha,
      providerExecution: true,
      providerSnapshotFingerprint: providerFingerprint,
      ...overrides
    };
  }

  function detachedRequestState(
    status: "QUEUED" | "CHECKING" | "SUCCEEDED" | "RETRYABLE_FAILED" | "STALE",
    overrides: Record<string, unknown> = {}
  ) {
    const failed = status === "RETRYABLE_FAILED" || status === "STALE";
    return {
      batchIncidentId: "entry-1",
      releaseSha,
      runtimeVersion: status === "QUEUED" ? null : releaseSha,
      status,
      outcome: failed ? "FETCH_FAILED" : status === "SUCCEEDED" ? "NO_MATCH" : null,
      failureClass: failed ? "RATE_LIMIT" : null,
      evidence: failed
        ? {
            ...proofEvidence(),
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerRetryNotBeforeAt: "2026-07-16T02:00:00.000Z"
          }
        : status === "SUCCEEDED"
          ? proofEvidence()
          : null,
      providerSnapshotFingerprint: providerFingerprint,
      nextAttemptAt: status === "RETRYABLE_FAILED" ? new Date("2026-07-15T22:00:00.000Z") : null,
      completedAt: status === "SUCCEEDED" || status === "STALE" ? completedAt : null,
      ...overrides
    };
  }

  function currentDetachedFailure(status: "RETRYABLE_FAILED" | "STALE" = "RETRYABLE_FAILED") {
    const request = detachedRequestState(status);
    return {
      current: true as const,
      releaseSha,
      runtimeVersion: releaseSha,
      status,
      outcome: "FETCH_FAILED" as const,
      failureClass: "RATE_LIMIT" as const,
      providerExecution: true,
      observedAt,
      completedAt: request.completedAt as Date | null,
      nextAttemptAt: request.nextAttemptAt as Date | null,
      providerRetryNotBeforeAt: new Date("2026-07-16T02:00:00.000Z"),
      providerSnapshotFingerprint: providerFingerprint,
      evidence: request.evidence as Record<string, unknown>
    };
  }

  function closeoutBatch(
    result:
      | "RESTORED"
      | "FINAL_DISPOSITION"
      | "PENDING"
      | "RETRY_SCHEDULED"
      | "STALE_EVIDENCE"
      | "NEEDS_HUMAN",
    retryProofSnapshot: Record<string, unknown> | null = null
  ) {
    const proofSnapshot =
      result === "RESTORED"
        ? {
            kind: "PROVIDER_VERIFICATION",
            outcome: "NO_MATCH",
            observedAt: observedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            runtimeVersion: releaseSha,
            providerExecution: true,
            providerSnapshotFingerprint: providerFingerprint
          }
        : result === "FINAL_DISPOSITION"
          ? {
              kind: "PLAYBOOK_FACTUAL_FINAL",
              disposition: "MANUAL_DIRECT",
              runtimeVersion: releaseSha
            }
          : result === "RETRY_SCHEDULED"
            ? (retryProofSnapshot ?? detachedFailureProof())
            : retryProofSnapshot;
    return {
      id: "batch-1",
      status: "VERIFYING",
      revision: 8,
      releaseSha,
      deployedAt: new Date("2026-07-15T19:50:00.000Z"),
      recheckDispatchStartedAt: new Date("2026-07-15T19:51:00.000Z"),
      leaseToken: "lease-1",
      leaseExpiresAt: new Date("2026-07-15T21:00:00.000Z"),
      ownerThreadId: "owner-thread",
      ownerAutomationRunId: null,
      summary: healthyDetachedDispatch(),
      createdAt: new Date("2026-07-15T18:00:00.000Z"),
      incidents: [
        {
          id: "entry-1",
          incidentId: "incident-1",
          courseId: "course-1",
          cycle: 1,
          result,
          message: "Current verification recorded.",
          proofSnapshot,
          verifiedAt: new Date("2026-07-15T19:58:00.000Z"),
          verifiedIncidentUpdatedAt: incidentUpdatedAt,
          updatedAt: new Date("2026-07-15T19:58:00.000Z"),
          course: providerCourse(),
          incident: {
            cycle: 1,
            status: "AUTO_INVESTIGATING",
            providerFamilyKey: "booking.example",
            engineeringOnly: result === "NEEDS_HUMAN" ? false : true,
            activeBatchId: "batch-1",
            firstSeenAt: new Date("2026-07-15T18:30:00.000Z"),
            lastSeenAt: incidentUpdatedAt,
            updatedAt: incidentUpdatedAt,
            failureClass: "UNSUPPORTED_FAMILY",
            failureFingerprint: "fingerprint",
            attemptCount: 1,
            attemptLedger:
              result === "NEEDS_HUMAN"
                ? exhaustedAttemptLedger()
                : result === "FINAL_DISPOSITION"
                  ? factualFinalLedger("MANUAL_DIRECT")
                  : null,
            escalatedAt: null
          }
        }
      ]
    };
  }

  function sameIdentityRateLimitRetryBatch(
    retryProofSnapshot: Record<string, unknown> = detachedFailureProof()
  ) {
    const batch = closeoutBatch("RETRY_SCHEDULED", retryProofSnapshot);
    Object.assign(batch.incidents[0].incident, {
      kind: "FETCH_FAILED",
      failureClass: "RATE_LIMIT",
      failureFingerprint: buildProviderFailureFingerprint({
        providerFamilyKey: "booking.example",
        failureClass: "RATE_LIMIT",
        operation: "AVAILABILITY"
      })
    });
    return batch;
  }

  function factualDetachedEvidence(disposition: "MANUAL_DIRECT" | "IDENTITY_FINAL") {
    const attemptLedger = factualFinalLedger(disposition);
    const event = attemptLedger.events.at(-1)!;
    return {
      attemptLedger,
      evidence: {
        schemaVersion: 1,
        kind: "PLAYBOOK_FACTUAL_FINAL",
        playbookVersion: 1,
        disposition,
        outcome: disposition,
        cycle: 1,
        stage: event.stage,
        sequence: event.sequence,
        readPath: event.readPath,
        evidenceKind: event.evidenceKind,
        failureFingerprint: event.failureFingerprint,
        observedAt: event.observedAt,
        completedAt: "2026-07-15T20:06:30.000Z",
        releaseSha,
        runtimeVersion: releaseSha,
        providerExecution: false
      }
    };
  }

  it("hands a same-family provider snapshot change to a fresh episode", async () => {
    const claimedProviderFingerprint = "a".repeat(64);
    const observedProviderFingerprint = "b".repeat(64);
    const priorFailureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "booking.example",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA"
    });
    const batch = closeoutBatch("PENDING");
    batch.incidents[0].proofSnapshot = null;
    Object.assign(batch.incidents[0].incident, {
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "booking.example",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: priorFailureFingerprint
    });
    batch.summary = {
      ...healthyDetachedDispatch(),
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: claimedProviderFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      observedProviderFingerprint
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "blocked_env",
      providerFamilyHandoffCount: 1,
      nextAttemptAt: now.toISOString()
    });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout?.remediationAttempts?.[0]).toMatchObject({
      providerSnapshotFingerprint: claimedProviderFingerprint,
      observedProviderSnapshotFingerprint: observedProviderFingerprint,
      failureFingerprint: priorFailureFingerprint,
      observedFailureFingerprint: priorFailureFingerprint
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerFamilyKey: "booking.example",
          cycle: 1
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          providerFamilyKey: "booking.example",
          failureClass: "UNSUPPORTED_FAMILY",
          failureFingerprint: priorFailureFingerprint,
          attemptCount: 0,
          occurrenceCount: 1,
          firstSeenAt: now,
          confirmedAt: now,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        audit: expect.objectContaining({
          providerFamilyChanged: false,
          providerSnapshotChanged: true,
          claimedProviderSnapshotFingerprint: claimedProviderFingerprint,
          observedProviderSnapshotFingerprint: observedProviderFingerprint,
          priorCycle: 1,
          cycle: 2
        })
      })
    });
  });

  it("downgrades stale restored proof when the current provider snapshot changed", async () => {
    const proofProviderFingerprint = "b".repeat(64);
    const currentProviderFingerprint = "c".repeat(64);
    const batch = closeoutBatch("RESTORED");
    batch.incidents[0].proofSnapshot = {
      ...proofEvidence(),
      providerSnapshotFingerprint: proofProviderFingerprint
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      currentProviderFingerprint
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      terminalCount: 0,
      retryCount: 1,
      providerFamilyHandoffCount: 1,
      nextAttemptAt: now.toISOString()
    });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout?.remediationAttempts?.[0]).toMatchObject({
      providerSnapshotFingerprint: proofProviderFingerprint,
      observedProviderSnapshotFingerprint: currentProviderFingerprint
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: now
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "RECOVERED" })
      })
    );
  });

  it("supersedes a succeeded detached request before settled material handoff", async () => {
    const batch = closeoutBatch("RESTORED");
    batch.incidents[0].proofSnapshot = {
      ...proofEvidence(),
      providerSnapshotFingerprint: "a".repeat(64)
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      "c".repeat(64)
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("SUCCEEDED")
    ]);
    prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      terminalCount: 0,
      retryCount: 1,
      providerFamilyHandoffCount: 1
    });
    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        batchIncidentId: { in: ["entry-1"] },
        releaseSha,
        status: { in: ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"] }
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "material_failure_identity_superseded",
        updatedAt: now
      }
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          attemptCount: 0,
          firstSeenAt: now,
          nextAttemptAt: now
        })
      })
    );
  });

  it.each(["HEALTHY", "FINAL_TECHNICAL"] as const)(
    "starts a fresh cycle instead of accepting stale $state proof after material change",
    async (state) => {
      const proofProviderFingerprint = "a".repeat(64);
      const currentProviderFingerprint = "c".repeat(64);
      const batch = closeoutBatch("RESTORED");
      batch.incidents[0].proofSnapshot = {
        ...proofEvidence(),
        providerSnapshotFingerprint: proofProviderFingerprint
      };
      Object.assign(batch.incidents[0].course.monitoringStatus!, {
        state,
        lastSuccessfulAt:
          state === "HEALTHY" ? new Date("2026-07-15T19:59:00.000Z") : null,
        revision: 5
      });
      verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
        currentProviderFingerprint
      );
      prismaMocks.batchFindFirst.mockResolvedValue(batch);
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.transaction.mockImplementationOnce(
        async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
          worker(monitoringTransactionClient)
      );

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          verificationWatchMode: "EARLY_RETRY",
          now
        })
      ).resolves.toMatchObject({
        outcome: "retryable_failed",
        terminalCount: 0,
        retryCount: 1,
        providerFamilyHandoffCount: 1
      });
      expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cycle: { increment: 1 },
            attemptCount: 0,
            occurrenceCount: 1,
            firstSeenAt: now,
            nextAttemptAt: now
          })
        })
      );
      expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state, revision: 5 }),
          data: expect.objectContaining({ state: "AUTO_INVESTIGATING" })
        })
      );
    }
  );

  it.each(["FINAL_MANUAL", "FINAL_IDENTITY"] as const)(
    "preserves factual $state after a provider snapshot changes",
    async (state) => {
      const batch = closeoutBatch("RESTORED");
      batch.incidents[0].proofSnapshot = {
        ...proofEvidence(),
        providerSnapshotFingerprint: "a".repeat(64)
      };
      Object.assign(batch.incidents[0].course.monitoringStatus!, {
        state,
        lastSuccessfulAt: null,
        revision: 5
      });
      verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
        "c".repeat(64)
      );
      prismaMocks.batchFindFirst.mockResolvedValue(batch);
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.transaction.mockImplementationOnce(
        async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
          worker(monitoringTransactionClient)
      );

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          verificationWatchMode: "EARLY_RETRY",
          now
        })
      ).resolves.toMatchObject({
        outcome: "classification_only",
        terminalCount: 1,
        retryCount: 0,
        providerFamilyHandoffCount: 0
      });
      expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "RESOLVED",
            resolution:
              state === "FINAL_IDENTITY"
                ? "IDENTITY_CLASSIFIED"
                : "DIRECT_BOOKING_CLASSIFIED"
          })
        })
      );
      expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith({
        where: {
          courseId: "course-1",
          state,
          revision: 5,
          lastSuccessfulAt: null
        },
        data: { revision: { increment: 0 } }
      });
    }
  );

  it("preserves durable factual batch proof across a provider snapshot change", async () => {
    const { attemptLedger, evidence } = factualDetachedEvidence("MANUAL_DIRECT");
    const providerChangeAt = new Date("2026-07-15T20:08:00.000Z");
    const closeoutNow = new Date("2026-07-15T20:10:00.000Z");
    const batch = closeoutBatch("FINAL_DISPOSITION");
    batch.incidents[0].proofSnapshot = evidence;
    batch.incidents[0].verifiedAt = new Date("2026-07-15T20:07:00.000Z");
    batch.incidents[0].verifiedIncidentUpdatedAt = new Date(
      "2026-07-15T20:06:30.000Z"
    );
    batch.incidents[0].incident.attemptLedger = attemptLedger;
    batch.incidents[0].incident.lastSeenAt = providerChangeAt;
    batch.incidents[0].incident.updatedAt = providerChangeAt;
    batch.summary = {
      ...healthyDetachedDispatch(),
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: "a".repeat(64),
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      "c".repeat(64)
    );
    verificationMocks.isCourseSupportFactualFinalProof.mockImplementation(
      (input: { proof: unknown; notBefore?: Date[] }) => {
        const proof = input.proof as { observedAt?: string };
        const observedAt = new Date(proof.observedAt ?? "invalid");
        return Boolean(
          Number.isFinite(observedAt.getTime()) &&
            (input.notBefore ?? []).every(
              (boundary) => observedAt.getTime() >= boundary.getTime()
            )
        );
      }
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now: closeoutNow
      })
    ).resolves.toMatchObject({
      outcome: "classification_only",
      terminalCount: 1,
      retryCount: 0,
      providerFamilyHandoffCount: 0
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: providerChangeAt }),
        data: expect.objectContaining({
          status: "RESOLVED",
          resolution: "DIRECT_BOOKING_CLASSIFIED"
        })
      })
    );
    expect(verificationMocks.isCourseSupportFactualFinalProof).toHaveBeenCalledWith(
      expect.objectContaining({
        notBefore: [
          new Date("2026-07-15T19:50:00.000Z"),
          new Date("2026-07-15T19:51:00.000Z")
        ]
      })
    );
    expect(prismaMocks.verificationRequestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: "material_failure_identity_superseded"
        })
      })
    );
  });

  it("requires factual detached success to be copied before it can win material change", async () => {
    const { attemptLedger, evidence } = factualDetachedEvidence("MANUAL_DIRECT");
    const buildMaterialBatch = (
      result: "RETRY_SCHEDULED" | "FINAL_DISPOSITION"
    ) => {
      const batch = closeoutBatch(result);
      batch.summary = {
        ...healthyDetachedDispatch(),
        remediation: {
          attempts: [
            {
              courseRef: createHash("sha256")
                .update("course-1")
                .digest("hex")
                .slice(0, 24),
              providerSnapshotFingerprint: "a".repeat(64),
              approach: {
                workMode: "IMPLEMENT_REUSABLE_SUPPORT",
                strategyAction: "REPAIR_PROVIDER_ADAPTER",
                playbookStage: "TYPED_ADAPTER"
              }
            }
          ]
        }
      };
      if (result === "FINAL_DISPOSITION") {
        batch.incidents[0].proofSnapshot = evidence;
        batch.incidents[0].verifiedAt = new Date("2026-07-15T20:07:00.000Z");
        batch.incidents[0].incident.attemptLedger = attemptLedger;
      }
      return batch;
    };
    const staleBatch = buildMaterialBatch("RETRY_SCHEDULED");
    const copiedBatch = buildMaterialBatch("FINAL_DISPOSITION");
    const factualRequest = detachedRequestState("SUCCEEDED", {
      outcome: "MANUAL_DIRECT",
      evidence,
      completedAt: new Date(evidence.completedAt),
      providerSnapshotFingerprint: "a".repeat(64)
    });
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      "c".repeat(64)
    );
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(staleBatch)
      .mockResolvedValueOnce(copiedBatch);
    prismaMocks.verificationRequestFindMany.mockResolvedValue([factualRequest]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementation(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).rejects.toThrow("completed after the last evidence read");
    expect(prismaMocks.verificationRequestUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastError: "material_failure_identity_superseded"
        })
      })
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).resolves.toMatchObject({
      outcome: "classification_only",
      terminalCount: 1,
      providerFamilyHandoffCount: 0
    });
  });

  it("hands incomplete non-source human proof to the changed provider episode", async () => {
    const claimedProviderFingerprint = "a".repeat(64);
    const observedProviderFingerprint = "c".repeat(64);
    const batch = closeoutBatch("NEEDS_HUMAN");
    batch.incidents[0].proofSnapshot = {
      kind: "HUMAN_REVIEW_REQUIRED",
      disposition: "ACCOUNT_REQUIRED"
    };
    batch.incidents[0].incident.attemptLedger = null;
    batch.summary = {
      ...healthyDetachedDispatch(),
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: claimedProviderFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      observedProviderFingerprint
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      retryCount: 1,
      providerFamilyHandoffCount: 1,
      nextAttemptAt: now.toISOString()
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cycle: { increment: 1 },
          attemptCount: 0,
          occurrenceCount: 1,
          firstSeenAt: now,
          nextAttemptAt: now
        })
      })
    );
  });

  it("preserves the claimed provider fingerprint and persists a newly observed transient", async () => {
    const claimedProviderFingerprint = "a".repeat(64);
    const observedProviderFingerprint = "b".repeat(64);
    const batch = closeoutBatch("RETRY_SCHEDULED");
    batch.summary = {
      ...healthyDetachedDispatch(),
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: claimedProviderFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    verificationMocks.buildCourseSupportProviderSnapshotFingerprint.mockReturnValue(
      observedProviderFingerprint
    );
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).resolves.toMatchObject({ outcome: "retryable_failed" });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout?.remediationAttempts?.[0]).toMatchObject({
      providerSnapshotFingerprint: claimedProviderFingerprint,
      observedProviderSnapshotFingerprint: observedProviderFingerprint
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureClass: "RATE_LIMIT",
          failureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    );
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      })
    );
  });

  it("rejects implementation verification when no implementation release was provided", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      ...verificationBatch(),
      baseSha: "c".repeat(40),
      releaseSha: null,
      deployedAt: null,
      summary: {
        plannedPaths: [],
        remediation: {
          workMode: "IMPLEMENT_REUSABLE_SUPPORT",
          strategyAction: "REPAIR_PROVIDER_ADAPTER",
          playbookStage: "TYPED_ADAPTER",
          allowUnchangedRuntime: false,
          requiresImplementationPath: true,
          reason: "IMPLEMENTATION_REQUIRED",
          retryBudget: null
        }
      }
    });

    await expect(
      verifyCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).rejects.toThrow(
      "requires a runtime-bearing committed implementation path, a new release SHA, and deployment proof"
    );
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      result: "NEEDS_HUMAN" as const,
      requestedOutcome: "needs_human" as const
    },
    {
      result: "FINAL_DISPOSITION" as const,
      requestedOutcome: "classification_only" as const
    },
    {
      result: "RETRY_SCHEDULED" as const,
      requestedOutcome: "retryable_failed" as const
    }
  ])(
    "does not overwrite a search success racing responder $result closeout",
    async ({ result, requestedOutcome }) => {
      prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch(result));
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.monitoringStatusUpdateMany.mockResolvedValue({ count: 0 });
      prismaMocks.transaction.mockImplementationOnce(
        async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
          worker(monitoringTransactionClient)
      );

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          requestedOutcome,
          now
        })
      ).rejects.toThrow("Course monitoring changed during responder closeout");

      expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            courseId: "course-1",
            state: "AUTO_INVESTIGATING",
            revision: 4,
            lastSuccessfulAt: new Date("2026-07-15T18:00:00.000Z")
          }
        })
      );
      expect(prismaMocks.monitoringEventCreate).not.toHaveBeenCalled();
    }
  );

  it("reasserts a matching factual final snapshot before resolving the batch", async () => {
    const batch = closeoutBatch("FINAL_DISPOSITION");
    batch.incidents[0].course.monitoringStatus = {
      state: "FINAL_MANUAL",
      lastSuccessfulAt: null,
      revision: 5
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    // A search restored HEALTHY after the batch snapshot was read.
    prismaMocks.monitoringStatusUpdateMany.mockResolvedValue({ count: 0 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "classification_only",
        now
      })
    ).rejects.toThrow("Course monitoring changed during responder closeout");

    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        state: "FINAL_MANUAL",
        revision: 5,
        lastSuccessfulAt: null
      },
      data: {
        revision: { increment: 0 }
      }
    });
    expect(prismaMocks.monitoringEventCreate).not.toHaveBeenCalled();
  });

  it("does not resolve a fresh incident cycle opened after atomic batch closeout", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("FINAL_DISPOSITION"));
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    let freshCycleStatus = "NOT_OPEN";
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) => {
        const result = await worker(monitoringTransactionClient);
        freshCycleStatus = "AUTO_INVESTIGATING";
        return result;
      }
    );
    supportIncidentMocks.resolveCourseSupportIncident.mockImplementation(async () => {
      freshCycleStatus = "RESOLVED";
    });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "classification_only",
        now
      })
    ).resolves.toMatchObject({
      outcome: "classification_only",
      durableCloseoutRecorded: true
    });

    expect(freshCycleStatus).toBe("AUTO_INVESTIGATING");
    expect(supportIncidentMocks.resolveCourseSupportIncident).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledOnce();
  });

  it.each(["HEALTHY", "FINAL_MANUAL"] as const)(
    "requires re-verification instead of replacing an already authoritative %s state",
    async (state) => {
      const batch = closeoutBatch("NEEDS_HUMAN");
      batch.incidents[0].course.monitoringStatus = {
        state,
        lastSuccessfulAt: state === "HEALTHY" ? new Date("2026-07-15T19:59:00.000Z") : null,
        revision: 5
      };
      prismaMocks.batchFindFirst.mockResolvedValue(batch);
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.transaction.mockImplementationOnce(
        async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
          worker(monitoringTransactionClient)
      );

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          requestedOutcome: "needs_human",
          now
        })
      ).rejects.toThrow("newer authoritative state");
      expect(prismaMocks.monitoringStatusUpdateMany).not.toHaveBeenCalled();
      expect(prismaMocks.monitoringEventCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      state: "HEALTHY" as const,
      lastSuccessfulAt: new Date("2026-07-15T19:59:00.000Z"),
      derivedOutcome: "success" as const,
      resolution: "MONITORING_RESTORED" as const
    },
    {
      state: "FINAL_MANUAL" as const,
      lastSuccessfulAt: null,
      derivedOutcome: "classification_only" as const,
      resolution: "DIRECT_BOOKING_CLASSIFIED" as const
    }
  ])(
    "releases ownership after clean closeout races a newer $state state",
    async ({ state, lastSuccessfulAt, derivedOutcome, resolution }) => {
      const initialBatch = closeoutBatch("PENDING");
      const authoritativeBatch = closeoutBatch("PENDING");
      authoritativeBatch.incidents[0].course.monitoringStatus = {
        state,
        lastSuccessfulAt,
        revision: 5
      };
      prismaMocks.batchFindFirst
        .mockResolvedValueOnce(initialBatch)
        .mockResolvedValueOnce(authoritativeBatch);
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.monitoringStatusUpdateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      prismaMocks.transaction.mockImplementation(
        async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
          worker(monitoringTransactionClient)
      );

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          verificationWatchMode: "WATCH_SETTLED",
          now
        })
      ).rejects.toThrow("Course monitoring changed during responder closeout");

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          requestedOutcome: "command_failed",
          verificationWatchMode: "EARLY_RETRY",
          now
        })
      ).resolves.toMatchObject({
        outcome: "command_failed",
        derivedOutcome,
        durableCloseoutRecorded: true,
        terminalCount: 1,
        retryCount: 0
      });
      expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "incident-1",
            activeBatchId: "batch-1"
          }),
          data: expect.objectContaining({
            status: "RESOLVED",
            activeBatchId: null,
            resolution
          })
        })
      );
      expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenLastCalledWith({
        where: {
          courseId: "course-1",
          state,
          revision: 5,
          lastSuccessfulAt
        },
        data: { revision: { increment: 0 } }
      });
      expect(prismaMocks.monitoringEventCreate).not.toHaveBeenCalled();
    }
  );

  it("atomically stales detached work when human evidence supersedes it", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "VERIFYING",
      revision: 7,
      incidents: [
        {
          id: "entry-1",
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          incidentId: "incident-1",
          cycle: 1,
          updatedAt: incidentUpdatedAt,
          course: { name: "Course One" },
          incident: {
            engineeringOnly: false,
            attemptLedger: exhaustedAttemptLedger(),
            status: "AUTO_INVESTIGATING",
            activeBatchId: "batch-1",
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      markCourseSupportBatchNeedsHuman({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        ordinal: 1,
        evidence: "Provider approval is required.",
        nextAction: "Request provider access.",
        now
      })
    ).resolves.toMatchObject({ outcome: "needs_human" });

    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        batchIncidentId: "entry-1",
        status: {
          in: ["QUEUED", "CHECKING", "SUCCEEDED", "RETRYABLE_FAILED"]
        }
      },
      data: expect.objectContaining({
        status: "STALE",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "human_verification_superseded"
      })
    });
  });

  it("refuses human escalation before every safe playbook stage is exhausted", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue({
      status: "VERIFYING",
      revision: 7,
      incidents: [
        {
          id: "entry-1",
          createdAt: new Date("2026-07-15T18:00:00.000Z"),
          incidentId: "incident-1",
          cycle: 1,
          updatedAt: incidentUpdatedAt,
          course: { name: "Course One" },
          incident: {
            engineeringOnly: false,
            attemptLedger: null,
            status: "AUTO_INVESTIGATING",
            activeBatchId: "batch-1",
            updatedAt: incidentUpdatedAt
          }
        }
      ]
    });

    await expect(
      markCourseSupportBatchNeedsHuman({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        ordinal: 1,
        evidence: "Provider approval is required.",
        nextAction: "Request provider access.",
        now
      })
    ).rejects.toThrow("exhaust every safe read path");
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it("downgrades detached success when live demand appears before atomic persistence", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    prismaMocks.teeSearchCount.mockResolvedValue(1);
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(eligibleProof());

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "STALE_EVIDENCE",
          proofSnapshot: expect.anything()
        })
      })
    );
    expect(prismaMocks.teeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-15T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
    expect(prismaMocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
      timeout: 15_000
    });
  });

  it.each([
    ["private identity", providerCourse({ isPublic: false })],
    [
      "current technical gate",
      providerCourse({
        automationEligibility: "BLOCKED",
        automationReason: "ACCOUNT_REQUIRED",
        intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
        intelligenceConfidence: 0.95
      })
    ],
    [
      "current manual gate",
      providerCourse({
        bookingMethod: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
        intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
        intelligenceConfidence: 0.95
      })
    ]
  ])(
    "downgrades detached success when the course changes to a %s before atomic persistence",
    async (_label, currentCourse) => {
      prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
      prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
      prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest(currentCourse));
      verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(
        eligibleProof()
      );

      await verifyCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        releaseSha,
        now
      });

      expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ result: "STALE_EVIDENCE" })
        })
      );
      expect(prismaMocks.teeSearchCount).not.toHaveBeenCalled();
      expect(verificationMocks.buildCourseSupportProviderSnapshotFingerprint).toHaveBeenCalledWith(
        expect.objectContaining({
          isPublic: currentCourse.isPublic,
          intelligenceVerifiedAt: currentCourse.intelligenceVerifiedAt,
          intelligenceReviewAt: currentCourse.intelligenceReviewAt,
          intelligenceConfidence: currentCourse.intelligenceConfidence
        })
      );
    }
  );

  it("persists detached success only after the atomic request and fingerprint pass", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(eligibleProof());

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: "RESTORED" })
      })
    );
    expect(verificationMocks.buildCourseSupportProviderSnapshotFingerprint).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingWindowEvidenceUrl: "https://course.example/booking-policy"
      })
    );
    expect(prismaMocks.verificationRequestFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          batchIncident: expect.objectContaining({
            select: expect.objectContaining({
              course: {
                select: expect.objectContaining({ monitoringMode: true })
              }
            })
          })
        })
      })
    );
  });

  it("persists detached success for historical real demand after its searches end", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch(false));
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(providerCourse(), false)
    );
    verificationMocks.getEligibleCourseSupportVerificationProof.mockResolvedValue(eligibleProof());

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ result: "RESTORED" })
      })
    );
    expect(prismaMocks.teeSearchCount).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        date: { gte: new Date("2026-07-15T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      }
    });
  });

  it("reports aggregate pending detached verification and requires a verify rerun", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("QUEUED")]);
    verificationMocks.scheduleCourseSupportVerificationRequests.mockResolvedValue({
      createdCount: 1,
      eligibleCount: 1,
      ineligibleCount: 0,
      requests: []
    });

    const result = await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(result).toMatchObject({
      detachedVerification: { pendingCount: 1, rerunNeeded: true },
      recheckDispatch: {
        detachedVerificationPendingCount: 1,
        detachedVerificationRerunNeeded: true
      }
    });
  });

  it("does not schedule or await detached work after human evidence wins", async () => {
    const batch = verificationBatch(false);
    batch.incidents[0].result = "NEEDS_HUMAN";
    batch.incidents[0].message = "Provider approval is required.";
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("QUEUED")]);

    const result = await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(verificationMocks.scheduleCourseSupportVerificationRequests).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      detachedVerification: { pendingCount: 0, rerunNeeded: false }
    });
  });

  it("carries current detached fetch failure evidence without restoring", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(verificationBatch());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue({
      current: true,
      releaseSha,
      runtimeVersion: releaseSha,
      status: "RETRYABLE_FAILED",
      outcome: "FETCH_FAILED",
      failureClass: "RATE_LIMIT",
      providerExecution: true,
      observedAt,
      completedAt: null,
      nextAttemptAt: new Date("2026-07-15T20:15:00.000Z"),
      providerRetryNotBeforeAt: new Date("2026-07-15T22:00:00.000Z"),
      providerSnapshotFingerprint: providerFingerprint,
      evidence: {
        ...proofEvidence(),
        outcome: "FETCH_FAILED",
        failureClass: "RATE_LIMIT"
      }
    });

    await verifyCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      releaseSha,
      now
    });

    expect(prismaMocks.incidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          result: "RETRY_SCHEDULED",
          proofSnapshot: expect.objectContaining({
            kind: "PROVIDER_VERIFICATION_FAILURE",
            outcome: "FETCH_FAILED",
            failureClass: "RATE_LIMIT",
            providerRetryNotBeforeAt: "2026-07-15T22:00:00.000Z"
          })
        })
      })
    );
  });

  it("rejects terminal detached closeout when live demand appears after verification", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("RESTORED"));
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    prismaMocks.teeSearchCount.mockResolvedValue(1);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "success",
        now
      })
    ).rejects.toThrow("changed before terminal closeout");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects terminal detached closeout when current access intelligence becomes terminal", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("RESTORED"));
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(
        providerCourse({
          automationEligibility: "BLOCKED",
          automationReason: "ACCOUNT_REQUIRED",
          intelligenceVerifiedAt: new Date("2026-07-15T19:59:00.000Z"),
          intelligenceReviewAt: new Date("2026-07-16T20:00:00.000Z"),
          intelligenceConfidence: 0.95
        })
      )
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "success",
        now
      })
    ).rejects.toThrow("changed before terminal closeout");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.teeSearchCount).not.toHaveBeenCalled();
  });

  it("wakes runnable parked siblings after a partial reusable-support closeout", async () => {
    const batch = closeoutBatch("RESTORED");
    const chronogolfCourse = {
      ...providerCourse(),
      detectedPlatform: "CHRONOGOLF",
      providerFamilyKey: "CHRONOGOLF",
      detectedBookingUrl: "https://www.chronogolf.com/club/primary-course",
      bookingMetadata: {
        clubId: 1,
        courseIds: ["primary-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/primary-course"
      }
    };
    batch.baseSha = "c".repeat(40);
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.summary = {
      ...healthyDetachedDispatch(),
      plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"],
      remediation: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
        allowUnchangedRuntime: false,
        requiresImplementationPath: true,
        reason: "IMPLEMENTATION_REQUIRED"
      }
    };
    batch.incidents[0].course = chronogolfCourse;
    batch.incidents[0].incident.providerFamilyKey = "CHRONOGOLF";
    batch.incidents.push({
      ...batch.incidents[0],
      id: "entry-human",
      incidentId: "incident-human",
      courseId: "course-human",
      result: "NEEDS_HUMAN",
      proofSnapshot: null,
      course: chronogolfCourse,
      incident: {
        ...batch.incidents[0].incident,
        activeBatchId: "batch-1",
        engineeringOnly: false,
        attemptLedger: exhaustedAttemptLedger()
      }
    });
    const stateChangedAt = new Date("2026-07-15T19:40:00.000Z");
    const sameFamilySibling = {
      id: "incident-sibling",
      courseId: "course-sibling",
      cycle: 3,
      revision: 7,
      updatedAt: new Date("2026-07-15T19:45:00.000Z"),
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: "sibling-fingerprint",
      activeRealSearchCount: 1,
      course: {
        timeZone: "America/New_York",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        detectedBookingUrl: "https://www.chronogolf.com/club/sibling-course",
        website: "https://sibling-course.example/",
        bookingMetadata: {
          clubId: 2,
          courseIds: ["sibling-course"],
          bookingBaseUrl: "https://www.chronogolf.com/club/sibling-course"
        },
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 5,
          stateChangedAt,
          lastSuccessfulAt: null
        }
      }
    };
    const unrelatedSibling = {
      ...sameFamilySibling,
      id: "incident-unrelated",
      courseId: "course-unrelated",
      providerFamilyKey: "FOREUP",
      course: {
        ...sameFamilySibling.course,
        detectedPlatform: "FOREUP",
        providerFamilyKey: "FOREUP",
        detectedBookingUrl:
          "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
        bookingMetadata: {
          scheduleId: 6654,
          bookingBaseUrl:
            "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
        }
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(chronogolfCourse)
    );
    prismaMocks.supportIncidentFindMany.mockResolvedValue([
      sameFamilySibling,
      unrelatedSibling
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      batchStatus: "PARTIAL",
      reusableFamilyRestoredCount: 1,
      siblingWakeCount: 1
    });

    expect(prismaMocks.supportIncidentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerFamilyKey: "CHRONOGOLF",
          status: "NEEDS_HUMAN",
          humanReviewReason: "AUTOMATION_STALLED",
          nextAttemptAt: null
        })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ["incident-sibling"] },
          OR: [
            expect.objectContaining({ id: "incident-sibling", cycle: 3 })
          ]
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          attemptCount: 0,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ["incident-unrelated"] } })
      })
    );
    expect(prismaMocks.teeSearchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            expect.objectContaining({
              preferences: { some: { courseId: { in: ["course-sibling"] } } }
            })
          ]
        }),
        data: { nextCheckAt: now, recheckRequestedAt: now }
      })
    );
    expect(prismaMocks.monitoringEventCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          courseId: "course-sibling",
          incidentId: "incident-sibling",
          eventType: "REVALIDATION_REQUESTED",
          audit: expect.objectContaining({
            providerFamilySupportDeployed: true,
            priorCycle: 3,
            cycle: 4
          })
        })
      ]
    });
  });

  it("wakes more than twenty runnable siblings with set-based writes", async () => {
    const batch = closeoutBatch("RESTORED");
    const chronogolfCourse = {
      ...providerCourse(),
      detectedPlatform: "CHRONOGOLF",
      providerFamilyKey: "CHRONOGOLF",
      detectedBookingUrl: "https://www.chronogolf.com/club/primary-course",
      bookingMetadata: {
        clubId: 1,
        courseIds: ["primary-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/primary-course"
      }
    };
    batch.baseSha = "c".repeat(40);
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.summary = {
      ...healthyDetachedDispatch(),
      plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"],
      remediation: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
        allowUnchangedRuntime: false,
        requiresImplementationPath: true,
        reason: "IMPLEMENTATION_REQUIRED"
      }
    };
    batch.incidents[0].course = chronogolfCourse;
    batch.incidents[0].incident.providerFamilyKey = "CHRONOGOLF";
    const stateChangedAt = new Date("2026-07-15T19:40:00.000Z");
    const siblings = Array.from({ length: 25 }, (_, index) => ({
      id: `incident-sibling-${index}`,
      courseId: `course-sibling-${index}`,
      cycle: 3,
      revision: 7,
      updatedAt: new Date("2026-07-15T19:45:00.000Z"),
      providerFamilyKey: "CHRONOGOLF",
      failureFingerprint: `sibling-fingerprint-${index}`,
      activeRealSearchCount: 1,
      course: {
        timeZone: "America/New_York",
        detectedPlatform: "CHRONOGOLF",
        providerFamilyKey: "CHRONOGOLF",
        detectedBookingUrl: `https://www.chronogolf.com/club/sibling-${index}`,
        website: `https://sibling-${index}.example/`,
        bookingMetadata: {
          clubId: index + 2,
          courseIds: [`sibling-${index}`],
          bookingBaseUrl: `https://www.chronogolf.com/club/sibling-${index}`
        },
        monitoringStatus: {
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: 5,
          stateChangedAt,
          lastSuccessfulAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null
        }
      }
    }));
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(
      atomicRequest(chronogolfCourse)
    );
    prismaMocks.supportIncidentFindMany.mockResolvedValue(siblings);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockImplementation(
      async (args: { where?: { id?: { in?: string[] } } }) => ({
        count: args.where?.id?.in?.length ?? 1
      })
    );
    prismaMocks.monitoringStatusUpdateMany.mockImplementation(
      async (args: { where?: { courseId?: { in?: string[] } } }) => ({
        count: args.where?.courseId?.in?.length ?? 1
      })
    );
    prismaMocks.monitoringEventCreateMany.mockResolvedValue({ count: siblings.length });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "success",
      reusableFamilyRestoredCount: 1,
      siblingWakeCount: 25
    });

    const incidentBulkCalls = prismaMocks.supportIncidentUpdateMany.mock.calls.filter(
      ([args]) => Array.isArray(args.where?.id?.in)
    );
    expect(incidentBulkCalls).toHaveLength(1);
    expect(incidentBulkCalls[0]?.[0].where.id.in).toHaveLength(25);
    expect(incidentBulkCalls[0]?.[0].data).toMatchObject({
      cycle: { increment: 1 },
      attemptCount: 0,
      occurrenceCount: 1,
      firstSeenAt: now,
      confirmedAt: now
    });
    const monitoringBulkCalls = prismaMocks.monitoringStatusUpdateMany.mock.calls.filter(
      ([args]) => Array.isArray(args.where?.courseId?.in)
    );
    expect(monitoringBulkCalls).toHaveLength(1);
    expect(monitoringBulkCalls[0]?.[0].where.courseId.in).toHaveLength(25);
    expect(prismaMocks.monitoringEventCreateMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.monitoringEventCreateMany.mock.calls[0]?.[0].data).toHaveLength(25);
    expect(prismaMocks.teeSearchUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            expect.objectContaining({
              preferences: {
                some: {
                  courseId: {
                    in: siblings.map((sibling) => sibling.courseId)
                  }
                }
              }
            })
          ]
        })
      })
    );
  });

  it("does not wake the old family when its only restored course now resolves to another family", async () => {
    const batch = closeoutBatch("RESTORED");
    const foreupCourse = {
      ...providerCourse(),
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
      bookingMetadata: {
        scheduleId: 6654,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
      }
    };
    batch.baseSha = "c".repeat(40);
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.summary = {
      ...healthyDetachedDispatch(),
      plannedPaths: ["src/lib/tee-times/adapters/chronogolf/fetch.ts"],
      remediation: {
        workMode: "IMPLEMENT_REUSABLE_SUPPORT",
        strategyAction: "REPAIR_PROVIDER_ADAPTER",
        playbookStage: "TYPED_ADAPTER",
        allowUnchangedRuntime: false,
        requiresImplementationPath: true,
        reason: "IMPLEMENTATION_REQUIRED"
      }
    };
    batch.incidents[0].course = foreupCourse;
    batch.incidents[0].incident.providerFamilyKey = "CHRONOGOLF";
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest(foreupCourse));
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      providerFamilyHandoffCount: 1,
      reusableFamilyRestoredCount: 0,
      siblingWakeCount: 0
    });
    expect(prismaMocks.supportIncidentFindMany).not.toHaveBeenCalled();
  });

  it("hands nonterminal work to a fresh canonical provider-family episode", async () => {
    const batch = closeoutBatch("PENDING");
    const foreupCourse = {
      ...providerCourse(),
      detectedPlatform: "FOREUP",
      providerFamilyKey: "FOREUP",
      detectedBookingUrl:
        "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
      bookingMetadata: {
        scheduleId: 6654,
        bookingBaseUrl:
          "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
      }
    };
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.incidents[0].course = foreupCourse;
    Object.assign(batch.incidents[0].incident, {
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "CHRONOGOLF"
    });
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    const expectedFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "FOREUP",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA"
    });
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "blocked_env",
      derivedOutcome: "retryable_failed",
      providerFamilyHandoffCount: 1,
      retryCount: 1,
      nextAttemptAt: now.toISOString()
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerFamilyKey: "CHRONOGOLF",
          cycle: 1
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          providerFamilyKey: "FOREUP",
          failureFingerprint: expectedFingerprint,
          attemptCount: 0,
          occurrenceCount: 1,
          firstSeenAt: now,
          confirmedAt: now,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        failureFingerprint: expectedFingerprint,
        audit: expect.objectContaining({
          providerFamilyHandoff: true,
          priorProviderFamilyKey: "CHRONOGOLF",
          providerFamilyKey: "FOREUP",
          priorCycle: 1,
          cycle: 2
        })
      })
    });
  });

  it("hands a same-family monitoring fingerprint change to a fresh episode", async () => {
    const batch = closeoutBatch("PENDING");
    const priorFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "UNSUPPORTED_FAMILY",
      operation: "METADATA"
    });
    const currentFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "SCHEMA",
      operation: "METADATA"
    });
    const chronogolfCourse = {
      ...providerCourse(),
      detectedPlatform: "CHRONOGOLF",
      providerFamilyKey: "CHRONOGOLF",
      detectedBookingUrl: "https://www.chronogolf.com/club/primary-course",
      bookingMetadata: {
        clubId: 1,
        courseIds: ["primary-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/primary-course"
      }
    };
    Object.assign(chronogolfCourse.monitoringStatus, {
      failureFingerprint: currentFingerprint
    });
    Object.assign(chronogolfCourse, {
      monitoringEvents: [
        {
          failureFingerprint: currentFingerprint,
          occurredAt: new Date("2026-07-15T19:59:00.000Z"),
          audit: {
            cycle: 1,
            failureClass: "SCHEMA",
            providerFamilyKey: "CHRONOGOLF",
            customerDataIncluded: false
          }
        }
      ]
    });
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.incidents[0].course = chronogolfCourse;
    batch.incidents[0].proofSnapshot = null;
    Object.assign(batch.incidents[0].incident, {
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "UNSUPPORTED_FAMILY",
      failureFingerprint: priorFingerprint,
      updatedAt: new Date("2026-07-15T19:59:30.000Z")
    });
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        now
      })
    ).resolves.toMatchObject({
      outcome: "blocked_env",
      providerFamilyHandoffCount: 1,
      retryCount: 1,
      nextAttemptAt: now.toISOString()
    });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout?.remediationAttempts?.[0]).toMatchObject({
      failureFingerprint: priorFingerprint,
      observedFailureFingerprint: currentFingerprint
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          providerFamilyKey: "CHRONOGOLF",
          cycle: 1
        }),
        data: expect.objectContaining({
          cycle: { increment: 1 },
          providerFamilyKey: "CHRONOGOLF",
          failureClass: "SCHEMA",
          failureFingerprint: currentFingerprint,
          attemptCount: 0,
          occurrenceCount: 1,
          firstSeenAt: now,
          confirmedAt: now,
          nextAttemptAt: now
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "REVALIDATION_REQUESTED",
        failureFingerprint: currentFingerprint,
        audit: expect.objectContaining({
          providerFamilyHandoff: true,
          providerFamilyChanged: false,
          priorProviderFamilyKey: "CHRONOGOLF",
          providerFamilyKey: "CHRONOGOLF",
          priorFailureFingerprint: priorFingerprint,
          failureFingerprint: currentFingerprint,
          priorCycle: 1,
          cycle: 2
        })
      })
    });
  });

  it("uses the canonical incident operation for a newly observed transient fingerprint", async () => {
    const batch = closeoutBatch("PENDING");
    const chronogolfCourse = {
      ...providerCourse(),
      detectedPlatform: "CHRONOGOLF",
      providerFamilyKey: "CHRONOGOLF",
      detectedBookingUrl: "https://www.chronogolf.com/club/primary-course",
      bookingMetadata: {
        clubId: 1,
        courseIds: ["primary-course"],
        bookingBaseUrl: "https://www.chronogolf.com/club/primary-course"
      }
    };
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.providerFamilyKey = "CHRONOGOLF";
    batch.incidents[0].course = chronogolfCourse;
    batch.incidents[0].proofSnapshot = { failureClass: "TIMEOUT" };
    Object.assign(batch.incidents[0].incident, {
      kind: "NEEDS_ADAPTER",
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "UNSUPPORTED_FAMILY"
    });
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    const reportFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "CHRONOGOLF",
      failureClass: "TIMEOUT",
      operation: "METADATA"
    });
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "command_failed",
        failureDomain: "SLA",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({ outcome: "command_failed" });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureClass: "TIMEOUT",
          failureFingerprint: reportFingerprint
        })
      })
    );
  });

  it.each(["QUEUED", "CHECKING"] as const)(
    "refuses closeout while detached verification is %s",
    async (status) => {
      prismaMocks.batchFindFirst.mockResolvedValue(sameIdentityRateLimitRetryBatch());
      prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState(status)]);

      await expect(
        closeoutCourseSupportBatch({
          batchId: "batch-1",
          leaseToken: "lease-1",
          ownerThreadId: "owner-thread",
          requestedOutcome: "retryable_failed",
          now
        })
      ).rejects.toThrow("still pending");
      expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
    }
  );

  it("allows human closeout when an older detached request is still pending", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("NEEDS_HUMAN"));
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("QUEUED")]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "needs_human",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      durableCloseoutRecorded: true
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          nextAttemptAt: new Date("2026-07-16T02:00:00.000Z")
        })
      })
    );
    expect(prismaMocks.teeSearchUpdateMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        date: { gte: new Date("2026-07-15T00:00:00.000Z") },
        preferences: { some: { courseId: "course-1" } }
      },
      data: {
        nextCheckAt: now,
        recheckRequestedAt: now
      }
    });
  });

  it("derives retry closeout for a clean watch pass without marking human", async () => {
    const batch = closeoutBatch("RETRY_SCHEDULED");
    batch.incidents[0].incident.attemptLedger = independentReadyAttemptLedger();
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      derivedOutcome: "retryable_failed",
      batchStatus: "RETRYABLE_FAILED",
      durableCloseoutRecorded: true,
      retryCount: 1,
      automationStalledCount: 0
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeBatchId: "batch-1" }),
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          nextAttemptAt: new Date(now.getTime() + 60 * 1000)
        })
      })
    );
  });

  it("parks mixed restored and unchanged structural work instead of retrying it", async () => {
    const batch = closeoutBatch("RESTORED");
    batch.incidents.push({
      ...batch.incidents[0],
      id: "entry-2",
      incidentId: "incident-2",
      courseId: "course-2",
      result: "RETRY_SCHEDULED",
      proofSnapshot: null,
      course: providerCourse(),
      incident: {
        ...batch.incidents[0].incident,
        engineeringOnly: true,
        attemptLedger: null
      }
    });
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindUnique.mockResolvedValue(atomicRequest());
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      durableCloseoutRecorded: true,
      terminalCount: 1,
      retryCount: 0,
      automationStalledCount: 1
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledTimes(2);
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-2",
          activeBatchId: "batch-1"
        }),
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          activeBatchId: null,
          nextAttemptAt: null
        })
      })
    );
  });

  it("records a truthful endpoint automation stall and releases ownership", async () => {
    const batch = closeoutBatch("PENDING");
    batch.incidents[0].incident.escalationDeadlineAt = now;
    batch.incidents[0].incident.attemptLedger = null;
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "ENDPOINT",
        failureDomain: "SLA",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      durableCloseoutRecorded: true,
      automationStalledCount: 1
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeBatchId: "batch-1" }),
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          activeBatchId: null,
          humanReviewReason: "AUTOMATION_STALLED",
          nextAttemptAt: null
        })
      })
    );
    expect(prismaMocks.monitoringStatusUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED"
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "HUMAN_REVIEW_REQUESTED",
        audit: expect.objectContaining({
          humanReviewReason: "AUTOMATION_STALLED",
          cycle: 1,
          customerState: "NEEDS_HUMAN_REVIEW",
          automationStalled: true,
          endpointStalled: true,
          escalationDeadlineAt: now.toISOString(),
          playbookExhausted: false,
          customerDataIncluded: false
        })
      })
    });
    const endpointEvent = prismaMocks.monitoringEventCreate.mock.calls[0][0].data;
    expect(
      hasDurableAutomationStalledEndpointProof({
        incidentId: endpointEvent.incidentId,
        incidentCycle: 1,
        incidentStatus: "NEEDS_HUMAN",
        humanReviewReason: "AUTOMATION_STALLED",
        incidentEscalatedAt: endpointEvent.occurredAt,
        escalationDeadlineAt: now,
        monitoringState: endpointEvent.toState,
        endpointEvents: [endpointEvent]
      })
    ).toBe(true);
    expect(prismaMocks.teeSearchUpdateMany).not.toHaveBeenCalled();
  });

  it("releases early watch stops as retry without claiming endpoint finality", async () => {
    const batch = closeoutBatch("PENDING");
    batch.incidents[0].incident.escalationDeadlineAt = new Date(now.getTime() + 10 * 60_000);
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "command_failed",
        failureDomain: "SLA",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "command_failed",
      derivedOutcome: "retryable_failed",
      durableCloseoutRecorded: true,
      retryCount: 1,
      automationStalledCount: 0
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "AUTO_INVESTIGATING",
          activeBatchId: null
        })
      })
    );
  });

  it("does not consume an ordinary pending closeout with no execution proof", async () => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.incidents[0].incident.failureClass = "RATE_LIMIT";
    batch.incidents[0].incident.failureFingerprint = "v1:RATE_LIMIT:FETCH_FAILED";
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            playbookEventCountAtClaim: 0,
            approach: {
              workMode: "VERIFY_TRANSIENT",
              strategyAction: "RETRY_PROVIDER",
              playbookStage: null
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      derivedOutcome: "retryable_failed"
    });

    expect(
      prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary?.closeout
    ).toMatchObject({
      remediationAttemptConsumed: false,
      remediationAttempts: [expect.objectContaining({ consumed: false })]
    });
  });

  it("audits blocked environment closeout without consuming the planned remediation", async () => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.incidents[0].incident.escalationDeadlineAt = new Date(
      now.getTime() + 10 * 60_000
    );
    batch.summary = {
      ...healthyDetachedDispatch(),
      plannedPaths: ["src/lib/tee-times/adapters/example.ts"],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        summary: "Environment setup failed before implementation could run.",
        now
      })
    ).resolves.toMatchObject({
      outcome: "blocked_env",
      derivedOutcome: "retryable_failed",
      durableCloseoutRecorded: true
    });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout).toMatchObject({
      outcome: "blocked_env",
      derivedOutcome: "retryable_failed",
      failureDomain: "ENV",
      remediationAttemptConsumed: false,
      remediationAttempts: [
        expect.objectContaining({
          consumed: false,
          executionEvidence: expect.objectContaining({
            claimedImplementationPaths: true,
            newReleaseRecorded: false,
            deploymentRecorded: false,
            providerAttemptRecorded: false,
            playbookAttemptRecorded: false
          }),
          approach: {
            workMode: "IMPLEMENT_REUSABLE_SUPPORT",
            strategyAction: "REPAIR_PROVIDER_ADAPTER",
            playbookStage: "TYPED_ADAPTER"
          }
        })
      ]
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: new Date(now.getTime() + 60_000)
        })
      })
    );
    expect(prismaMocks.automationRunUpdateMany).not.toHaveBeenCalled();
  });

  it("parks the second unchanged operational closeout without scheduling another AI retry", async () => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    const courseRef = createHash("sha256").update("course-1").digest("hex").slice(0, 24);
    const approach = {
      workMode: "IMPLEMENT_REUSABLE_SUPPORT",
      strategyAction: "REPAIR_PROVIDER_ADAPTER",
      playbookStage: "TYPED_ADAPTER"
    };
    batch.incidents[0].incident.batchIncidents = [
      {
        cycle: 1,
        batch: {
          summary: {
            closeout: {
              outcome: "blocked_env",
              remediationAttempts: [
                {
                  courseRef,
                  providerSnapshotFingerprint: providerFingerprint,
                  failureFingerprint: "fingerprint",
                  runtimeVersion: "a".repeat(40),
                  activeRealSearchCount: 0,
                  consumed: false,
                  approach
                }
              ]
            }
          }
        }
      }
    ];
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef,
            providerSnapshotFingerprint: providerFingerprint,
            approach
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.transaction.mockImplementationOnce(
      async (worker: (transaction: typeof monitoringTransactionClient) => Promise<unknown>) =>
        worker(monitoringTransactionClient)
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "blocked_env",
      derivedOutcome: "needs_human",
      retryCount: 0,
      automationStalledCount: 1,
      operationalRetryBudgetExhaustedCount: 1
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          humanReviewReason: "AUTOMATION_STALLED",
          nextAttemptAt: null
        })
      })
    );
    expect(prismaMocks.monitoringEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audit: expect.objectContaining({
          reason: "OPERATIONAL_RETRY_BUDGET_EXHAUSTED",
          operationalRetryBudgetExhausted: true
        })
      })
    });
  });

  it("keeps a changed undeployed release active for provenance-aware recovery", async () => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = "d".repeat(40);
    batch.deployedAt = null;
    batch.summary = {
      plannedPaths: ["src/lib/tee-times/adapters/example.ts"],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).rejects.toThrow(
      "cannot be closed before deployment; recover or adopt the active release continuation"
    );

    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).not.toHaveBeenCalled();
  });

  it("consumes a deployed implementation that later fails production verification", async () => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.incidents[0].incident.escalationDeadlineAt = new Date(
      now.getTime() + 10 * 60_000
    );
    batch.summary = {
      ...healthyDetachedDispatch(),
      plannedPaths: ["src/lib/tee-times/adapters/example.ts"],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            playbookEventCountAtClaim: 0,
            approach: {
              workMode: "IMPLEMENT_REUSABLE_SUPPORT",
              strategyAction: "REPAIR_PROVIDER_ADAPTER",
              playbookStage: "TYPED_ADAPTER"
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "production_verification_failed",
        failureDomain: "PRODUCTION_VERIFICATION",
        verificationWatchMode: "EARLY_RETRY",
        summary: "The deployed implementation did not pass production verification.",
        now
      })
    ).resolves.toMatchObject({
      outcome: "production_verification_failed",
      derivedOutcome: "retryable_failed",
      durableCloseoutRecorded: true
    });

    const persistedSummary = prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary;
    expect(persistedSummary?.closeout).toMatchObject({
      outcome: "production_verification_failed",
      derivedOutcome: "retryable_failed",
      remediationAttemptConsumed: true,
      remediationAttempts: [
        expect.objectContaining({
          consumed: true,
          executionEvidence: expect.objectContaining({
            claimedImplementationPaths: true,
            newReleaseRecorded: true,
            deploymentRecorded: true
          })
        })
      ]
    });
  });

  it.each([
    {
      label: "does not consume an unrelated newer probe",
      proofRuntimeVersion: "d".repeat(40),
      expectedConsumed: false
    },
    {
      label: "consumes current provider execution proof",
      proofRuntimeVersion: "c".repeat(40),
      expectedConsumed: true
    }
  ])("$label during an operational closeout", async (testCase) => {
    const batch = closeoutBatch("PENDING");
    batch.baseSha = "c".repeat(40);
    batch.releaseSha = null;
    batch.deployedAt = null;
    batch.incidents[0].preProbeId = "pre-probe";
    batch.incidents[0].postProbeId = "newer-probe";
    batch.incidents[0].proofSnapshot = {
      kind: "PROVIDER_PROBE",
      outcome: "FETCH_FAILED",
      observedAt: new Date(now.getTime() - 60_000).toISOString(),
      runtimeVersion: testCase.proofRuntimeVersion,
      providerExecution: true
    };
    batch.incidents[0].incident.escalationDeadlineAt = new Date(
      now.getTime() + 10 * 60_000
    );
    batch.summary = {
      plannedPaths: [],
      remediation: {
        attempts: [
          {
            courseRef: createHash("sha256")
              .update("course-1")
              .digest("hex")
              .slice(0, 24),
            providerSnapshotFingerprint: providerFingerprint,
            playbookEventCountAtClaim: 0,
            approach: {
              workMode: "VERIFY_TRANSIENT",
              strategyAction: "RETRY_PROVIDER",
              playbookStage: null
            }
          }
        ]
      }
    };
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "blocked_env",
        failureDomain: "ENV",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({ outcome: "blocked_env" });

    const persistedAttempt =
      prismaMocks.batchUpdateMany.mock.calls[0]?.[0]?.data?.summary?.closeout
        ?.remediationAttempts?.[0];
    expect(persistedAttempt).toMatchObject({
      consumed: testCase.expectedConsumed,
      executionEvidence: expect.objectContaining({
        newReleaseRecorded: false,
        postProbeRecorded: true,
        providerAttemptRecorded: testCase.expectedConsumed
      })
    });
  });

  it("releases early watch ownership from the freshly reread incident revision", async () => {
    const batch = closeoutBatch("PENDING");
    const currentIncidentUpdatedAt = new Date(now.getTime() - 30_000);
    batch.incidents[0].incident.updatedAt = currentIncidentUpdatedAt;
    batch.incidents[0].incident.lastSeenAt = currentIncidentUpdatedAt;
    batch.incidents[0].incident.escalationDeadlineAt = new Date(now.getTime() + 10 * 60_000);
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "command_failed",
        failureDomain: "SLA",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "command_failed",
      derivedOutcome: "retryable_failed",
      durableCloseoutRecorded: true,
      retryCount: 1
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          activeBatchId: "batch-1",
          updatedAt: currentIncidentUpdatedAt
        }),
        data: expect.objectContaining({ activeBatchId: null })
      })
    );
  });

  it("resnapshots early watch closeout after a concurrent incident write", async () => {
    const staleBatch = closeoutBatch("PENDING");
    const currentBatch = closeoutBatch("PENDING");
    const staleIncidentUpdatedAt = new Date(now.getTime() - 60_000);
    const currentIncidentUpdatedAt = new Date(now.getTime() - 30_000);
    staleBatch.incidents[0].incident.updatedAt = staleIncidentUpdatedAt;
    staleBatch.incidents[0].incident.lastSeenAt = staleIncidentUpdatedAt;
    currentBatch.incidents[0].incident.updatedAt = currentIncidentUpdatedAt;
    currentBatch.incidents[0].incident.lastSeenAt = currentIncidentUpdatedAt;
    for (const batch of [staleBatch, currentBatch]) {
      batch.incidents[0].incident.escalationDeadlineAt = new Date(
        now.getTime() + 10 * 60_000
      );
    }
    prismaMocks.batchFindFirst
      .mockResolvedValueOnce(staleBatch)
      .mockResolvedValueOnce(currentBatch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "command_failed",
        failureDomain: "SLA",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "command_failed",
      derivedOutcome: "retryable_failed",
      durableCloseoutRecorded: true,
      retryCount: 1
    });
    expect(prismaMocks.batchFindFirst).toHaveBeenCalledTimes(2);
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "incident-1",
          activeBatchId: "batch-1",
          updatedAt: currentIncidentUpdatedAt
        })
      })
    );
  });

  it("keeps settled closeout fenced to the verified incident revision", async () => {
    const batch = closeoutBatch("PENDING");
    batch.incidents[0].incident.updatedAt = new Date(now.getTime() - 30_000);
    prismaMocks.batchFindFirst.mockResolvedValue(batch);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).rejects.toThrow("A course-support incident changed after verification.");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("releases early watch ownership without repeating a failed detached read", async () => {
    const batch = closeoutBatch("PENDING");
    batch.incidents[0].incident.escalationDeadlineAt = new Date(now.getTime() + 10 * 60_000);
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockRejectedValue(
      new Error("detached read unavailable")
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.incidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "command_failed",
        failureDomain: "SLA",
        verificationWatchMode: "EARLY_RETRY",
        now
      })
    ).resolves.toMatchObject({
      outcome: "command_failed",
      durableCloseoutRecorded: true,
      retryCount: 1
    });
    expect(verificationMocks.getCurrentCourseSupportVerificationFailure).not.toHaveBeenCalled();
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activeBatchId: null })
      })
    );
  });

  it("moves source-age-eligible watch evidence to explicit human review", async () => {
    const batch = closeoutBatch("RETRY_SCHEDULED", {
      kind: "SOURCE_REVALIDATION",
      outcome: "NEEDS_ADAPTER"
    });
    batch.incidents[0].incident.kind = "NEEDS_ADAPTER";
    batch.incidents[0].incident.providerFamilyKey = "SOURCE_MISSING";
    batch.incidents[0].incident.failureClass = "MISSING_SOURCE";
    batch.incidents[0].incident.failureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: "SOURCE_MISSING",
      failureClass: "MISSING_SOURCE",
      operation: "METADATA"
    });
    Object.assign(batch.incidents[0].course, {
      detectedPlatform: null,
      providerFamilyKey: "SOURCE_MISSING",
      detectedBookingUrl: null,
      website: null,
      bookingMetadata: null
    });
    batch.incidents[0].incident.attemptCount = 4;
    batch.incidents[0].incident.activeRealSearchCount = 0;
    batch.incidents[0].incident.firstSeenAt = new Date(now.getTime() - 25 * 60 * 60_000);
    batch.incidents[0].verifiedAt = new Date(now.getTime() - 30 * 60_000);
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        verificationWatchMode: "WATCH_SETTLED",
        now
      })
    ).resolves.toMatchObject({
      outcome: "needs_human",
      durableCloseoutRecorded: true,
      retryCount: 0,
      automationStalledCount: 0
    });
    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "NEEDS_HUMAN",
          activeBatchId: null,
          humanReviewReason: "SOURCE_UNVERIFIED"
        })
      })
    );
  });

  it("refuses human closeout without current-cycle playbook exhaustion", async () => {
    const batch = closeoutBatch("NEEDS_HUMAN");
    batch.incidents[0].incident.attemptLedger = null;
    prismaMocks.batchFindFirst.mockResolvedValue(batch);
    prismaMocks.verificationRequestFindMany.mockResolvedValue([]);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "needs_human",
        now
      })
    ).rejects.toThrow(/playbook is exhausted/i);
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses closeout when detached success finished after the last verify read", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(sameIdentityRateLimitRetryBatch());
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("SUCCEEDED")]);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("completed after the last evidence read");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses closeout until a current retryable failure is copied by verify", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(sameIdentityRateLimitRetryBatch());
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("RETRYABLE_FAILED")
    ]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure()
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("failure changed after the last evidence read");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("refuses closeout until current stale cooldown evidence is copied by verify", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(sameIdentityRateLimitRetryBatch());
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("STALE")]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure("STALE")
    );

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("cooldown evidence has not been recorded");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("catches a rate-limit request that becomes stale after the pre-closeout evidence read", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(sameIdentityRateLimitRetryBatch());
    prismaMocks.verificationRequestFindMany.mockResolvedValue([detachedRequestState("STALE")]);

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).rejects.toThrow("cooldown evidence has not been recorded");
    expect(prismaMocks.batchUpdateMany).not.toHaveBeenCalled();
  });

  it("allows retry closeout after verify copied the exact current detached failure", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      sameIdentityRateLimitRetryBatch(
        detachedFailureProof({
          nextAttemptAt: "2026-07-15T22:00:00.000Z",
          providerRetryNotBeforeAt: "2026-07-16T02:00:00.000Z"
        })
      )
    );
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("RETRYABLE_FAILED")
    ]);
    verificationMocks.getCurrentCourseSupportVerificationFailure.mockResolvedValue(
      currentDetachedFailure()
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await expect(
      closeoutCourseSupportBatch({
        batchId: "batch-1",
        leaseToken: "lease-1",
        ownerThreadId: "owner-thread",
        requestedOutcome: "retryable_failed",
        now
      })
    ).resolves.toMatchObject({
      outcome: "retryable_failed",
      durableCloseoutRecorded: true
    });
  });

  it("preserves the later detached provider cooldown during retry closeout", async () => {
    const persistedRetryAt = new Date("2026-07-15T22:00:00.000Z");
    const providerRetryNotBeforeAt = new Date("2026-07-16T02:00:00.000Z");
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          nextAttemptAt: persistedRetryAt.toISOString(),
          providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString()
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: providerRetryNotBeforeAt
        })
      })
    );
  });

  it("preserves a valid detached provider cooldown beyond the request horizon", async () => {
    const providerRetryNotBeforeAt = new Date("2026-07-17T02:00:00.000Z");
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          status: "STALE",
          nextAttemptAt: null,
          providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString()
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: providerRetryNotBeforeAt
        })
      })
    );
  });

  it("uses a 24-hour fail-safe for current detached rate limits without a valid cooldown", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(
      closeoutBatch(
        "RETRY_SCHEDULED",
        detachedFailureProof({
          status: "STALE",
          nextAttemptAt: null,
          providerRetryNotBeforeAt: null
        })
      )
    );
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });

    await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(prismaMocks.supportIncidentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextAttemptAt: new Date("2026-07-16T20:00:00.000Z")
        })
      })
    );
  });

  it("allows closeout for stale requests without current eligible failure evidence", async () => {
    prismaMocks.batchFindFirst.mockResolvedValue(closeoutBatch("RETRY_SCHEDULED"));
    prismaMocks.verificationRequestFindMany.mockResolvedValue([
      detachedRequestState("STALE", {
        failureClass: "SCHEMA",
        evidence: {
          ...proofEvidence(),
          outcome: "FETCH_FAILED",
          failureClass: "SCHEMA"
        }
      })
    ]);
    prismaMocks.batchUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.supportIncidentUpdateMany.mockResolvedValue({ count: 1 });
    prismaMocks.verificationRequestUpdateMany.mockResolvedValue({ count: 2 });

    const result = await closeoutCourseSupportBatch({
      batchId: "batch-1",
      leaseToken: "lease-1",
      ownerThreadId: "owner-thread",
      requestedOutcome: "retryable_failed",
      now
    });

    expect(result).toMatchObject({
      outcome: "retryable_failed",
      durableCloseoutRecorded: true
    });
    expect(prismaMocks.verificationRequestUpdateMany).toHaveBeenCalledWith({
      where: {
        batchIncident: { batchId: "batch-1" },
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] }
      },
      data: expect.objectContaining({
        status: "STALE",
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: now,
        lastError: "batch_closed"
      })
    });
  });
});

describe("course-support fingerprints", () => {
  it("groups by structured class and kind without URLs or customer data", () => {
    expect(
      buildFailureFingerprint({
        providerFamilyKey: "FOREUP",
        kind: "FETCH_FAILED",
        failureClass: "HTTP_5XX"
      })
    ).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("course-support provider discovery reconciliation", () => {
  it.each([
    {
      expectedFamily: "CHRONOGOLF",
      detectedPlatform: "CHRONOGOLF",
      bookingUrl: "https://www.chronogolf.com/club/example-course",
      confidence: 0.45
    },
    {
      expectedFamily: "TEEITUP",
      detectedPlatform: "TEEITUP",
      bookingUrl: "https://example-course.book.teeitup.golf/",
      confidence: 0.45
    },
    {
      expectedFamily: "TEESNAP",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://example-course.teesnap.net/",
      confidence: 0.55
    },
    {
      expectedFamily: "EZLINKS",
      detectedPlatform: "CUSTOM",
      bookingUrl: "https://example-course.ezlinksgolf.com/",
      confidence: 0.45
    }
  ])(
    "uses an inspected $expectedFamily booking surface instead of the official-site host",
    ({ expectedFamily, detectedPlatform, bookingUrl, confidence }) => {
      const provider = resolveCourseSupportProviderCapability({
        providerFamilyKey: "course.example.com",
        detectedPlatform: "UNKNOWN",
        detectedBookingUrl: "https://course.example.com/book-a-tee-time",
        website: "https://course.example.com/",
        bookingMetadata: null,
        automationDiscoveries: [
          {
            status: "INSPECTED",
            detectedPlatform,
            bookingUrl,
            sourceUrl: "https://course.example.com/",
            apiMetadata: null,
            confidence
          }
        ]
      });

      expect(provider).toMatchObject({
        providerFamilyKey: expectedFamily,
        metadataReady: false,
        isRunnable: false,
        evidenceConflict: false
      });
    }
  );

  it("does not use failed or conflicting discovery evidence", () => {
    const failedProvider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "FAILED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://www.chronogolf.com/club/example-course",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });
    const conflictingProvider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "FOREUP",
      detectedPlatform: "FOREUP",
      detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/1/2#/teetimes",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "INSPECTED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://www.chronogolf.com/club/example-course",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });

    expect(failedProvider.providerFamilyKey).toBe("course.example.com");
    expect(conflictingProvider.providerFamilyKey).toBe("FOREUP");
  });

  it("does not trust a platform label when the selected booking URL is still the official site", () => {
    const provider = resolveCourseSupportProviderCapability({
      providerFamilyKey: "course.example.com",
      detectedPlatform: "UNKNOWN",
      website: "https://course.example.com/",
      automationDiscoveries: [
        {
          status: "INSPECTED",
          detectedPlatform: "CHRONOGOLF",
          bookingUrl: "https://course.example.com/book-a-tee-time",
          sourceUrl: "https://course.example.com/",
          confidence: 0.95
        }
      ]
    });

    expect(provider.providerFamilyKey).toBe("course.example.com");
  });
});
