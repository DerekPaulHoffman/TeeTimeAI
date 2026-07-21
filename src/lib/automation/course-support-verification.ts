import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  AutomationEligibility,
  AutomationReason,
  BookingMethod,
  CourseSupportFailureClass,
  DetectedPlatform,
  ProbeOutcome
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeTimeZone } from "@/lib/timezones";

import { evaluateMonitoringGate } from "./policy";
import { normalizeProviderFamilyKey } from "./provider-capabilities";
import { sanitizeResponderText } from "./course-support-responder-policy";
import { getAutomationRuntimeVersion } from "./runtime-version";

export const COURSE_SUPPORT_VERIFICATION_LEASE_MS = 10 * 60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_MAX_DUE = 20;
export const COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS =
  24 * 60 * 60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_START_TIME = "06:00";
export const COURSE_SUPPORT_VERIFICATION_END_TIME = "20:00";
export const COURSE_SUPPORT_VERIFICATION_PLAYERS = 1;

const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_AGE_MS = 30 * 60 * 1000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 60 * 1000;
const MAX_MESSAGE_LENGTH = 500;
const SAFE_ADAPTER_KEY = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const SAFE_WORKFLOW_RUN_ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;

const providerCourseSelect = {
  id: true,
  timeZone: true,
  website: true,
  detectedBookingUrl: true,
  detectedPlatform: true,
  providerFamilyKey: true,
  bookingMethod: true,
  bookingWindowDaysAhead: true,
  bookingWindowEvidenceUrl: true,
  bookingReleaseTimeLocal: true,
  bookingWindowSource: true,
  automationEligibility: true,
  automationReason: true,
  isPublic: true,
  intelligenceVerifiedAt: true,
  intelligenceReviewAt: true,
  intelligenceConfidence: true,
  bookingMetadata: true
} satisfies Prisma.CourseSelect;

const requestExecutionSelect = {
  id: true,
  batchIncidentId: true,
  courseId: true,
  releaseSha: true,
  runtimeVersion: true,
  status: true,
  revision: true,
  leaseToken: true,
  leaseExpiresAt: true,
  nextAttemptAt: true,
  targetDateLocal: true,
  startTimeLocal: true,
  endTimeLocal: true,
  timeZone: true,
  players: true,
  providerSnapshotFingerprint: true,
  discoveryAttemptedAt: true,
  discoveryVerifiedAt: true,
  startedAt: true,
  createdAt: true,
  batchIncident: {
    select: {
      id: true,
      batchId: true,
      courseId: true,
      cycle: true,
      batch: {
        select: {
          id: true,
          status: true,
          releaseSha: true,
          completedAt: true
        }
      },
      incident: {
        select: {
          id: true,
          cycle: true,
          activeBatchId: true,
          engineeringOnly: true,
          status: true
        }
      }
    }
  },
  course: { select: providerCourseSelect }
} satisfies Prisma.CourseSupportVerificationRequestSelect;

type ProviderCourseSnapshot = Prisma.CourseGetPayload<{
  select: typeof providerCourseSelect;
}>;

type VerificationExecutionRow =
  Prisma.CourseSupportVerificationRequestGetPayload<{
    select: typeof requestExecutionSelect;
  }>;

export type CourseSupportVerificationIntent = {
  targetDateLocal: string;
  startTimeLocal: typeof COURSE_SUPPORT_VERIFICATION_START_TIME;
  endTimeLocal: typeof COURSE_SUPPORT_VERIFICATION_END_TIME;
  timeZone: string;
  players: typeof COURSE_SUPPORT_VERIFICATION_PLAYERS;
};

export type CourseSupportVerificationObservation = {
  outcome: ProbeOutcome;
  observedAt: Date;
  providerExecution: boolean;
  adapterKey?: string | null;
  availabilityCount?: number | null;
  httpStatus?: number | null;
  failureClass?: CourseSupportFailureClass | null;
  message?: string | null;
};

export type CourseSupportVerificationRejectionReason =
  | "not_found"
  | "stale_revision"
  | "not_due"
  | "runtime_mismatch"
  | "batch_release_changed"
  | "batch_not_verifying"
  | "batch_ownership_changed"
  | "incident_not_engineering_only"
  | "incident_resolved"
  | "active_demand"
  | "lease_lost"
  | "provider_snapshot_changed"
  | "monitoring_not_actionable"
  | "request_horizon_exceeded"
  | "discovery_already_attempted"
  | "discovery_not_attempted"
  | "discovery_not_verified"
  | "invalid_evidence"
  | "not_succeeded"
  | "not_failed_observation";

export async function scheduleCourseSupportVerificationRequests(input: {
  batchId: string;
  releaseSha: string;
  batchIncidentIds?: readonly string[];
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "schedule time");
  const releaseSha = validateReleaseSha(input.releaseSha);

  return prisma.$transaction(
    async (transaction) => {
      const batch = await transaction.courseSupportBatch.findUnique({
        where: { id: input.batchId },
        select: {
          id: true,
          status: true,
          releaseSha: true,
          completedAt: true,
          incidents: {
            ...(input.batchIncidentIds
              ? { where: { id: { in: [...new Set(input.batchIncidentIds)] } } }
              : {}),
            select: {
              id: true,
              courseId: true,
              cycle: true,
              incident: {
                select: {
                  id: true,
                  cycle: true,
                  activeBatchId: true,
                  engineeringOnly: true,
                  status: true
                }
              },
              course: { select: providerCourseSelect }
            }
          }
        }
      });

      if (!batch) {
        throw new Error("Course-support verification batch was not found.");
      }
      if (batch.releaseSha !== releaseSha) {
        throw new Error(
          "Course-support verification release must equal the batch release SHA."
        );
      }
      if (batch.status !== "VERIFYING" || batch.completedAt !== null) {
        throw new Error(
          "Course-support verification requires an actively verifying batch."
        );
      }

      const eligible = [] as Array<{
        batchIncidentId: string;
        courseId: string;
        releaseSha: string;
        nextAttemptAt: Date;
        targetDateLocal: string;
        startTimeLocal: string;
        endTimeLocal: string;
        timeZone: string;
        players: number;
        providerFamilyKeySnapshot: string;
        platformSnapshot: DetectedPlatform;
        bookingMethodSnapshot: BookingMethod;
        automationEligibilitySnapshot: AutomationEligibility;
        automationReasonSnapshot: AutomationReason;
        providerSnapshotFingerprint: string;
        providerSnapshotAt: Date;
        createdAt: Date;
        updatedAt: Date;
      }>;

      for (const entry of batch.incidents) {
        const eligibility = await evaluateDetachedEligibility(
          transaction,
          buildDetachedEligibilityInput({
            batch,
            batchIncident: entry,
            courseId: entry.courseId,
            course: entry.course,
            releaseSha
          }),
          now
        );
        if (!eligibility.eligible) {
          continue;
        }

        const provider = buildProviderSnapshot(entry.course);
        const intent = buildCourseSupportVerificationIntent(
          entry.course.timeZone,
          now
        );
        eligible.push({
          batchIncidentId: entry.id,
          courseId: entry.courseId,
          releaseSha,
          nextAttemptAt: now,
          ...intent,
          ...provider,
          providerSnapshotAt: now,
          createdAt: now,
          updatedAt: now
        });
      }

      const created = eligible.length
        ? await transaction.courseSupportVerificationRequest.createMany({
            data: eligible,
            skipDuplicates: true
          })
        : { count: 0 };

      const requests = eligible.length
        ? await transaction.courseSupportVerificationRequest.findMany({
            where: {
              releaseSha,
              batchIncidentId: {
                in: eligible.map((entry) => entry.batchIncidentId)
              }
            },
            select: {
              id: true,
              batchIncidentId: true,
              releaseSha: true,
              status: true,
              revision: true,
              nextAttemptAt: true
            },
            orderBy: { createdAt: "asc" }
          })
        : [];

      return {
        createdCount: created.count,
        eligibleCount: eligible.length,
        ineligibleCount: batch.incidents.length - eligible.length,
        requests
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function listDueCourseSupportVerificationRequests(input: {
  now?: Date;
  limit?: number;
} = {}) {
  const now = validDate(input.now ?? new Date(), "due-list time");
  const requestedLimit =
    input.limit === undefined || !Number.isFinite(input.limit)
      ? COURSE_SUPPORT_VERIFICATION_MAX_DUE
      : Math.trunc(input.limit);
  const limit = Math.min(
    COURSE_SUPPORT_VERIFICATION_MAX_DUE,
    Math.max(1, requestedLimit)
  );
  const horizonStartedAfter = new Date(
    now.getTime() - COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS
  );

  await prisma.courseSupportVerificationRequest.updateMany({
    where: {
      status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
      createdAt: { lte: horizonStartedAfter }
    },
    data: {
      status: "STALE",
      revision: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      completedAt: now,
      lastError: "request_horizon_exceeded",
      updatedAt: now
    }
  });

  return prisma.courseSupportVerificationRequest.findMany({
    where: {
      createdAt: { gt: horizonStartedAfter },
      OR: [
        { status: "QUEUED", nextAttemptAt: { lte: now } },
        { status: "RETRYABLE_FAILED", nextAttemptAt: { lte: now } },
        { status: "CHECKING", leaseExpiresAt: { lte: now } }
      ]
    },
    select: {
      id: true,
      releaseSha: true,
      status: true,
      revision: true
    },
    orderBy: [{ nextAttemptAt: "asc" }, { updatedAt: "asc" }],
    take: limit
  });
}

export async function claimCourseSupportVerificationRequest(input: {
  requestId: string;
  expectedRevision: number;
  runtimeVersion?: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "claim time");
  const runtimeVersion = input.runtimeVersion ?? getAutomationRuntimeVersion();

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      if (!request) {
        return rejected("not_found");
      }
      if (request.revision !== input.expectedRevision) {
        return rejected("stale_revision");
      }
      if (isRequestHorizonExpired(request, now)) {
        await markRequestStale(
          transaction,
          request,
          now,
          "request_horizon_exceeded"
        );
        return rejected("request_horizon_exceeded");
      }
      if (request.batchIncident.batch.releaseSha !== request.releaseSha) {
        await markRequestStale(transaction, request, now, "batch_release_changed");
        return rejected("batch_release_changed");
      }
      if (runtimeVersion !== request.releaseSha) {
        await markRequestStale(transaction, request, now, "runtime_mismatch");
        return rejected("runtime_mismatch");
      }
      if (!isDueForClaim(request, now)) {
        return rejected("not_due");
      }

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, request, now, eligibility.reason);
        return rejected(eligibility.reason);
      }

      const provider = buildProviderSnapshot(request.course);
      const providerSnapshotChanged =
        provider.providerSnapshotFingerprint !==
        request.providerSnapshotFingerprint;
      const intent = buildCourseSupportVerificationIntent(
        request.course.timeZone,
        now
      );
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(
        now.getTime() + COURSE_SUPPORT_VERIFICATION_LEASE_MS
      );
      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: {
          id: request.id,
          revision: request.revision,
          releaseSha: runtimeVersion,
          OR: claimableStatePredicate(now)
        },
        data: {
          status: "CHECKING",
          runtimeVersion,
          revision: { increment: 1 },
          leaseToken,
          leaseExpiresAt,
          workflowRunId: null,
          nextAttemptAt: null,
          attemptCount: { increment: 1 },
          ...intent,
          ...provider,
          ...(providerSnapshotChanged
            ? {
                discoveryVerifiedAt: null
              }
            : {}),
          providerSnapshotAt: now,
          outcome: null,
          failureClass: null,
          evidence: Prisma.JsonNull,
          lastError: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejected("stale_revision");
      }

      return {
        claimed: true as const,
        requestId: request.id,
        courseId: request.courseId,
        releaseSha: request.releaseSha,
        runtimeVersion,
        revision: request.revision + 1,
        leaseToken,
        leaseExpiresAt,
        providerSnapshotFingerprint: provider.providerSnapshotFingerprint,
        intent
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function attachCourseSupportVerificationWorkflow(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  workflowRunId: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "workflow attachment time");
  validateReleaseSha(input.runtimeVersion);
  if (!SAFE_WORKFLOW_RUN_ID.test(input.workflowRunId)) {
    throw new Error("Course-support verification Workflow id is not bounded.");
  }

  const updated = await prisma.courseSupportVerificationRequest.updateMany({
    // A Workflow can begin and advance the same lease's revision before the
    // starter receives its run id. The lease token is the exclusive owner, so
    // allow only monotonic revision advancement for this attachment race.
    where: {
      ...ownedCheckingWhere(input, now),
      revision: { gte: input.expectedRevision }
    },
    data: { workflowRunId: input.workflowRunId, updatedAt: now }
  });
  return { attached: updated.count === 1 };
}

export async function heartbeatCourseSupportVerificationRequest(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "heartbeat time");
  validateReleaseSha(input.runtimeVersion);
  const leaseExpiresAt = new Date(
    now.getTime() + COURSE_SUPPORT_VERIFICATION_LEASE_MS
  );
  const updated = await prisma.courseSupportVerificationRequest.updateMany({
    where: ownedCheckingWhere(input, now),
    data: { leaseExpiresAt, updatedAt: now }
  });
  return {
    renewed: updated.count === 1,
    leaseExpiresAt: updated.count === 1 ? leaseExpiresAt : null
  };
}

export async function attachCourseSupportVerificationProviderSnapshot(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "provider snapshot time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedAttachment(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, ownedRequest, now, eligibility.reason);
        return rejectedAttachment(eligibility.reason);
      }
      if (
        ownedRequest.batchIncident.batch.releaseSha !== ownedRequest.releaseSha
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "batch_release_changed"
        );
        return rejectedAttachment("batch_release_changed");
      }

      const provider = buildProviderSnapshot(ownedRequest.course);
      const providerSnapshotChanged =
        provider.providerSnapshotFingerprint !==
        ownedRequest.providerSnapshotFingerprint;
      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: ownedCheckingWhere(input, now),
        data: {
          ...provider,
          ...(providerSnapshotChanged
            ? {
                discoveryVerifiedAt: null
              }
            : {}),
          providerSnapshotAt: now,
          revision: { increment: 1 },
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejectedAttachment("lease_lost");
      }
      return {
        attached: true as const,
        revision: ownedRequest.revision + 1,
        providerSnapshotFingerprint: provider.providerSnapshotFingerprint,
        discoveryAttemptedAt: ownedRequest.discoveryAttemptedAt,
        discoveryVerifiedAt: providerSnapshotChanged
          ? null
          : ownedRequest.discoveryVerifiedAt,
        courseId: ownedRequest.courseId,
        intent: {
          targetDateLocal: ownedRequest.targetDateLocal,
          startTimeLocal: ownedRequest.startTimeLocal,
          endTimeLocal: ownedRequest.endTimeLocal,
          timeZone: ownedRequest.timeZone,
          players: ownedRequest.players
        }
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function markCourseSupportVerificationDiscoveryAttempted(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "discovery attempt time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedDiscoveryMark(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, ownedRequest, now, eligibility.reason);
        return rejectedDiscoveryMark(eligibility.reason);
      }
      if (!providerSnapshotIsCurrent(ownedRequest)) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "provider_snapshot_changed"
        );
        return rejectedDiscoveryMark("provider_snapshot_changed");
      }
      if (ownedRequest.discoveryAttemptedAt) {
        return rejectedDiscoveryMark("discovery_already_attempted");
      }

      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: ownedCheckingWhere(input, now),
        data: {
          discoveryAttemptedAt: now,
          revision: { increment: 1 },
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejectedDiscoveryMark("lease_lost");
      }
      return {
        marked: true as const,
        revision: ownedRequest.revision + 1,
        discoveryAttemptedAt: now,
        discoveryVerifiedAt: ownedRequest.discoveryVerifiedAt
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function markCourseSupportVerificationDiscoveryVerified(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "discovery verification time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedDiscoveryMark(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, ownedRequest, now, eligibility.reason);
        return rejectedDiscoveryMark(eligibility.reason);
      }
      if (!providerSnapshotIsCurrent(ownedRequest)) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "provider_snapshot_changed"
        );
        return rejectedDiscoveryMark("provider_snapshot_changed");
      }
      if (
        !ownedRequest.discoveryAttemptedAt ||
        ownedRequest.discoveryAttemptedAt.getTime() > now.getTime()
      ) {
        return rejectedDiscoveryMark("discovery_not_attempted");
      }
      if (ownedRequest.discoveryVerifiedAt) {
        return {
          marked: true as const,
          revision: ownedRequest.revision,
          discoveryAttemptedAt: ownedRequest.discoveryAttemptedAt,
          discoveryVerifiedAt: ownedRequest.discoveryVerifiedAt
        };
      }

      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: ownedCheckingWhere(input, now),
        data: {
          discoveryVerifiedAt: now,
          revision: { increment: 1 },
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejectedDiscoveryMark("lease_lost");
      }
      return {
        marked: true as const,
        revision: ownedRequest.revision + 1,
        discoveryAttemptedAt: ownedRequest.discoveryAttemptedAt,
        discoveryVerifiedAt: now
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function completeCourseSupportVerificationRequest(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  observation: CourseSupportVerificationObservation;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "completion time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedCompletion(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, ownedRequest, now, eligibility.reason);
        return rejectedCompletion(eligibility.reason);
      }
      if (
        ownedRequest.batchIncident.batch.releaseSha !== ownedRequest.releaseSha
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "batch_release_changed"
        );
        return rejectedCompletion("batch_release_changed");
      }
      if (
        (input.observation.outcome === "MATCH_FOUND" ||
          input.observation.outcome === "NO_MATCH") &&
        !hasCoherentVerifiedDiscovery(ownedRequest, now)
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "discovery_not_verified"
        );
        return rejectedCompletion("discovery_not_verified");
      }

      const provider = buildProviderSnapshot(ownedRequest.course);
      if (
        provider.providerSnapshotFingerprint !==
        ownedRequest.providerSnapshotFingerprint
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "provider_snapshot_changed"
        );
        return rejectedCompletion("provider_snapshot_changed");
      }

      const evidence = buildAllowlistedEvidence(
        input.observation,
        ownedRequest,
        provider,
        input.runtimeVersion,
        now
      );
      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: ownedCheckingWhere(input, now),
        data: {
          status: "SUCCEEDED",
          revision: { increment: 1 },
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          outcome: input.observation.outcome,
          failureClass: input.observation.failureClass ?? null,
          evidence,
          lastError: null,
          completedAt: now,
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejectedCompletion("lease_lost");
      }
      return {
        completed: true as const,
        status: "SUCCEEDED" as const,
        revision: ownedRequest.revision + 1,
        outcome: input.observation.outcome,
        evidence
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function failCourseSupportVerificationRequest(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  failureClass: CourseSupportFailureClass;
  message: string;
  retryAt?: Date | null;
  retryAfterSeconds?: number | null;
  observation?: Omit<CourseSupportVerificationObservation, "failureClass" | "message">;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "failure time");
  validateReleaseSha(input.runtimeVersion);
  const providerRetryNotBeforeAt =
    resolveCourseSupportProviderRetryNotBeforeAt({
      retryAfterSeconds: input.retryAfterSeconds ?? null,
      now
    });
  const retryAt = resolveCourseSupportVerificationRetryAt({
    requestedRetryAt: input.retryAt ?? null,
    retryAfterSeconds: input.retryAfterSeconds ?? null,
    now
  });

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: { id: input.requestId },
        select: requestExecutionSelect
      });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedFailure(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now
      );
      const provider = buildProviderSnapshot(ownedRequest.course);
      const stillCurrent =
        ownedRequest.batchIncident.batch.releaseSha ===
          ownedRequest.releaseSha &&
        provider.providerSnapshotFingerprint ===
          ownedRequest.providerSnapshotFingerprint;
      const retryWithinRequestHorizon = Boolean(
        retryAt &&
          retryAt.getTime() <
            ownedRequest.createdAt.getTime() +
              COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS
      );
      const retryable =
        eligibility.eligible && stillCurrent && retryWithinRequestHorizon;
      const status = retryable ? "RETRYABLE_FAILED" : "STALE";
      const message = boundedMessage(input.message);
      const observation: CourseSupportVerificationObservation = {
        outcome: input.observation?.outcome ?? "FETCH_FAILED",
        observedAt: input.observation?.observedAt ?? now,
        providerExecution: input.observation?.providerExecution ?? false,
        adapterKey: input.observation?.adapterKey,
        availabilityCount: input.observation?.availabilityCount,
        httpStatus: input.observation?.httpStatus,
        failureClass: input.failureClass,
        message
      };
      const evidence = buildAllowlistedEvidence(
        observation,
        ownedRequest,
        provider,
        input.runtimeVersion,
        now,
        providerRetryNotBeforeAt
      );
      const updated = await transaction.courseSupportVerificationRequest.updateMany({
        where: ownedCheckingWhere(input, now),
        data: {
          status,
          revision: { increment: 1 },
          leaseToken: null,
          leaseExpiresAt: null,
          nextAttemptAt: retryable ? retryAt : null,
          outcome: observation.outcome,
          failureClass: input.failureClass,
          evidence,
          lastError: message,
          completedAt: retryable ? null : now,
          updatedAt: now
        }
      });
      if (updated.count !== 1) {
        return rejectedFailure("lease_lost");
      }
      return {
        failed: true as const,
        status,
        revision: ownedRequest.revision + 1,
        nextAttemptAt: retryable ? retryAt : null
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getEligibleCourseSupportVerificationProof(input: {
  batchIncidentId: string;
  releaseSha: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "proof time");
  const releaseSha = validateReleaseSha(input.releaseSha);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: {
          batchIncidentId_releaseSha: {
            batchIncidentId: input.batchIncidentId,
            releaseSha
          }
        },
        select: {
          ...requestExecutionSelect,
          outcome: true,
          evidence: true,
          completedAt: true
        }
      });
      if (!request) {
        return rejectedProof("not_found");
      }
      if (
        request.status !== "SUCCEEDED" ||
        request.runtimeVersion !== releaseSha ||
        !request.outcome ||
        !request.completedAt
      ) {
        return rejectedProof("not_succeeded");
      }
      if (
        !hasCoherentVerifiedDiscovery(
          request,
          request.completedAt.getTime() < now.getTime()
            ? request.completedAt
            : now
        )
      ) {
        await markRequestStale(
          transaction,
          request,
          now,
          "discovery_not_verified"
        );
        return rejectedProof("discovery_not_verified");
      }
      if (
        !isCoherentVerificationEvidence(request.evidence, {
          releaseSha,
          outcome: request.outcome,
          providerSnapshotFingerprint: request.providerSnapshotFingerprint
        })
      ) {
        await markRequestStale(transaction, request, now, "invalid_evidence");
        return rejectedProof("invalid_evidence");
      }
      if (request.batchIncident.batch.releaseSha !== releaseSha) {
        await markRequestStale(transaction, request, now, "batch_release_changed");
        return rejectedProof("batch_release_changed");
      }

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStale(transaction, request, now, eligibility.reason);
        return rejectedProof(eligibility.reason);
      }
      if (
        buildProviderSnapshot(request.course).providerSnapshotFingerprint !==
        request.providerSnapshotFingerprint
      ) {
        await markRequestStale(
          transaction,
          request,
          now,
          "provider_snapshot_changed"
        );
        return rejectedProof("provider_snapshot_changed");
      }

      return {
        eligible: true as const,
        releaseSha,
        runtimeVersion: request.runtimeVersion,
        outcome: request.outcome,
        providerExecution: request.evidence.providerExecution,
        completedAt: request.completedAt,
        providerSnapshotFingerprint: request.providerSnapshotFingerprint,
        evidence: request.evidence
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function getCurrentCourseSupportVerificationFailure(input: {
  batchIncidentId: string;
  releaseSha: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "failure evidence time");
  const releaseSha = validateReleaseSha(input.releaseSha);

  return prisma.$transaction(
    async (transaction) => {
      const request = await transaction.courseSupportVerificationRequest.findUnique({
        where: {
          batchIncidentId_releaseSha: {
            batchIncidentId: input.batchIncidentId,
            releaseSha
          }
        },
        select: {
          ...requestExecutionSelect,
          outcome: true,
          failureClass: true,
          evidence: true,
          completedAt: true
        }
      });
      if (!request) {
        return rejectedFailureObservation("not_found");
      }
      if (
        (request.status !== "RETRYABLE_FAILED" && request.status !== "STALE") ||
        request.runtimeVersion !== releaseSha ||
        !request.outcome ||
        request.outcome === "MATCH_FOUND" ||
        request.outcome === "NO_MATCH" ||
        !request.failureClass
      ) {
        return rejectedFailureObservation("not_failed_observation");
      }
      if (
        !isCoherentVerificationEvidence(request.evidence, {
          releaseSha,
          outcome: request.outcome,
          providerSnapshotFingerprint: request.providerSnapshotFingerprint
        }) ||
        request.evidence.failureClass !== request.failureClass
      ) {
        await markRequestStaleIfNeeded(
          transaction,
          request,
          now,
          "invalid_evidence"
        );
        return rejectedFailureObservation("invalid_evidence");
      }

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now
      );
      if (!eligibility.eligible) {
        await markRequestStaleIfNeeded(
          transaction,
          request,
          now,
          eligibility.reason
        );
        return rejectedFailureObservation(eligibility.reason);
      }
      if (
        buildProviderSnapshot(request.course).providerSnapshotFingerprint !==
        request.providerSnapshotFingerprint
      ) {
        await markRequestStaleIfNeeded(
          transaction,
          request,
          now,
          "provider_snapshot_changed"
        );
        return rejectedFailureObservation("provider_snapshot_changed");
      }

      const observedAt = new Date(String(request.evidence.observedAt));
      const providerRetryNotBeforeAt = parseProviderRetryNotBeforeAt(
        request.evidence,
        observedAt
      );
      return {
        current: true as const,
        releaseSha,
        runtimeVersion: request.runtimeVersion,
        status: request.status,
        outcome: request.outcome,
        failureClass: request.failureClass,
        providerExecution: request.evidence.providerExecution,
        observedAt,
        completedAt: request.completedAt,
        nextAttemptAt: request.nextAttemptAt,
        providerRetryNotBeforeAt,
        providerSnapshotFingerprint: request.providerSnapshotFingerprint,
        evidence: request.evidence
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export function buildCourseSupportVerificationIntent(
  timeZone: string | null | undefined,
  now = new Date()
): CourseSupportVerificationIntent {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(validDate(now, "intent time"));
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  return {
    targetDateLocal: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    startTimeLocal: COURSE_SUPPORT_VERIFICATION_START_TIME,
    endTimeLocal: COURSE_SUPPORT_VERIFICATION_END_TIME,
    timeZone: normalizedTimeZone,
    players: COURSE_SUPPORT_VERIFICATION_PLAYERS
  };
}

export function buildCourseSupportProviderSnapshotFingerprint(input: {
  timeZone?: string | null;
  website?: string | null;
  detectedBookingUrl?: string | null;
  detectedPlatform: DetectedPlatform;
  providerFamilyKey?: string | null;
  bookingMethod: BookingMethod;
  bookingWindowDaysAhead?: number | null;
  bookingWindowEvidenceUrl?: string | null;
  bookingReleaseTimeLocal?: string | null;
  bookingWindowSource?: string | null;
  automationEligibility: AutomationEligibility;
  automationReason: AutomationReason;
  isPublic?: boolean | null;
  intelligenceVerifiedAt?: Date | null;
  intelligenceReviewAt?: Date | null;
  intelligenceConfidence?: number | null;
  bookingMetadata?: unknown;
}) {
  return createHash("sha256")
    .update(
      stableJson({
        timeZone: normalizeTimeZone(input.timeZone),
        website: input.website ?? null,
        detectedBookingUrl: input.detectedBookingUrl ?? null,
        detectedPlatform: input.detectedPlatform,
        providerFamilyKey: normalizeProviderFamilyKey(input.providerFamilyKey),
        bookingMethod: input.bookingMethod,
        bookingWindowDaysAhead: input.bookingWindowDaysAhead ?? null,
        bookingWindowEvidenceUrl: input.bookingWindowEvidenceUrl ?? null,
        bookingReleaseTimeLocal: input.bookingReleaseTimeLocal ?? null,
        bookingWindowSource: input.bookingWindowSource ?? null,
        automationEligibility: input.automationEligibility,
        automationReason: input.automationReason,
        isPublic: input.isPublic ?? null,
        intelligenceVerifiedAt: normalizeFingerprintDate(
          input.intelligenceVerifiedAt
        ),
        intelligenceReviewAt: normalizeFingerprintDate(
          input.intelligenceReviewAt
        ),
        intelligenceConfidence: input.intelligenceConfidence ?? null,
        bookingMetadata: input.bookingMetadata ?? null
      })
    )
    .digest("hex");
}

function normalizeFingerprintDate(value: Date | null | undefined) {
  if (!value) {
    return null;
  }
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Course-support provider intelligence date is invalid.");
  }
  return value.toISOString();
}

function buildProviderSnapshot(course: ProviderCourseSnapshot) {
  return {
    providerFamilyKeySnapshot: normalizeProviderFamilyKey(
      course.providerFamilyKey
    ),
    platformSnapshot: course.detectedPlatform,
    bookingMethodSnapshot: course.bookingMethod,
    automationEligibilitySnapshot: course.automationEligibility,
    automationReasonSnapshot: course.automationReason,
    providerSnapshotFingerprint:
      buildCourseSupportProviderSnapshotFingerprint(course)
  };
}

type DetachedEligibilityInput = {
  batchId: string;
  batchStatus: string;
  batchReleaseSha: string | null;
  batchCompletedAt: Date | null;
  batchIncidentCourseId: string;
  batchIncidentCycle: number;
  courseId: string;
  course: Pick<
    ProviderCourseSnapshot,
    | "timeZone"
    | "bookingMethod"
    | "automationEligibility"
    | "automationReason"
    | "isPublic"
    | "intelligenceVerifiedAt"
    | "intelligenceReviewAt"
    | "intelligenceConfidence"
  >;
  releaseSha: string;
  incident: {
    cycle: number;
    activeBatchId: string | null;
    engineeringOnly: boolean;
    status: string;
  };
};

function buildDetachedEligibilityInput(input: {
  batch: {
    id: string;
    status: string;
    releaseSha: string | null;
    completedAt: Date | null;
  };
  batchIncident: {
    courseId: string;
    cycle: number;
    incident: DetachedEligibilityInput["incident"];
  };
  courseId: string;
  course: ProviderCourseSnapshot;
  releaseSha: string;
}): DetachedEligibilityInput {
  return {
    batchId: input.batch.id,
    batchStatus: input.batch.status,
    batchReleaseSha: input.batch.releaseSha,
    batchCompletedAt: input.batch.completedAt,
    batchIncidentCourseId: input.batchIncident.courseId,
    batchIncidentCycle: input.batchIncident.cycle,
    courseId: input.courseId,
    course: input.course,
    releaseSha: input.releaseSha,
    incident: input.batchIncident.incident
  };
}

function buildDetachedEligibilityInputFromRequest(
  request: VerificationExecutionRow
): DetachedEligibilityInput {
  return buildDetachedEligibilityInput({
    batch: request.batchIncident.batch,
    batchIncident: request.batchIncident,
    courseId: request.courseId,
    course: request.course,
    releaseSha: request.releaseSha
  });
}

async function evaluateDetachedEligibility(
  transaction: Prisma.TransactionClient,
  input: DetachedEligibilityInput,
  now: Date
): Promise<
  | { eligible: true }
  | {
      eligible: false;
      reason: CourseSupportVerificationRejectionReason;
    }
> {
  if (input.batchReleaseSha !== input.releaseSha) {
    return { eligible: false, reason: "batch_release_changed" };
  }
  if (input.batchStatus !== "VERIFYING" || input.batchCompletedAt !== null) {
    return { eligible: false, reason: "batch_not_verifying" };
  }
  if (
    input.batchIncidentCourseId !== input.courseId ||
    input.batchIncidentCycle !== input.incident.cycle ||
    input.incident.activeBatchId !== input.batchId
  ) {
    return { eligible: false, reason: "batch_ownership_changed" };
  }
  if (!input.incident.engineeringOnly) {
    return { eligible: false, reason: "incident_not_engineering_only" };
  }
  if (input.incident.status !== "AUTO_INVESTIGATING") {
    return { eligible: false, reason: "incident_resolved" };
  }
  if (
    evaluateMonitoringGate({ ...input.course, now }).disposition !== "ACTIONABLE"
  ) {
    return { eligible: false, reason: "monitoring_not_actionable" };
  }
  const activeFuturePairs = await transaction.teeSearch.count({
    where: {
      status: "ACTIVE",
      date: { gte: localDateStorageBoundary(input.course.timeZone, now) },
      preferences: { some: { courseId: input.courseId } }
    }
  });
  return activeFuturePairs === 0
    ? { eligible: true }
    : { eligible: false, reason: "active_demand" };
}

function validateExecutionOwnership(
  request: VerificationExecutionRow | null,
  input: {
    expectedRevision: number;
    leaseToken: string;
    runtimeVersion: string;
  },
  now: Date
):
  | { valid: true; request: VerificationExecutionRow }
  | { valid: false; reason: CourseSupportVerificationRejectionReason } {
  if (!request) {
    return { valid: false, reason: "not_found" };
  }
  if (request.revision !== input.expectedRevision) {
    return { valid: false, reason: "stale_revision" };
  }
  if (
    request.releaseSha !== input.runtimeVersion ||
    request.runtimeVersion !== input.runtimeVersion
  ) {
    return { valid: false, reason: "runtime_mismatch" };
  }
  if (
    request.status !== "CHECKING" ||
    request.leaseToken !== input.leaseToken ||
    !request.leaseExpiresAt ||
    request.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    return { valid: false, reason: "lease_lost" };
  }
  return { valid: true, request };
}

function ownedCheckingWhere(
  input: {
    requestId: string;
    expectedRevision: number;
    leaseToken: string;
    runtimeVersion: string;
  },
  now: Date
) {
  return {
    id: input.requestId,
    revision: input.expectedRevision,
    status: "CHECKING" as const,
    releaseSha: input.runtimeVersion,
    runtimeVersion: input.runtimeVersion,
    leaseToken: input.leaseToken,
    leaseExpiresAt: { gt: now }
  };
}

function isDueForClaim(request: VerificationExecutionRow, now: Date) {
  if (
    (request.status === "QUEUED" || request.status === "RETRYABLE_FAILED") &&
    request.nextAttemptAt &&
    request.nextAttemptAt.getTime() <= now.getTime()
  ) {
    return true;
  }
  return (
    request.status === "CHECKING" &&
    Boolean(
      request.leaseExpiresAt &&
        request.leaseExpiresAt.getTime() <= now.getTime()
    )
  );
}

function isRequestHorizonExpired(
  request: Pick<VerificationExecutionRow, "createdAt">,
  now: Date
) {
  return (
    now.getTime() >=
    request.createdAt.getTime() + COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS
  );
}

function claimableStatePredicate(now: Date) {
  return [
    { status: "QUEUED" as const, nextAttemptAt: { lte: now } },
    { status: "RETRYABLE_FAILED" as const, nextAttemptAt: { lte: now } },
    { status: "CHECKING" as const, leaseExpiresAt: { lte: now } }
  ];
}

async function markRequestStale(
  transaction: Prisma.TransactionClient,
  request: Pick<
    VerificationExecutionRow,
    "id" | "revision" | "status" | "leaseToken"
  >,
  now: Date,
  reason: CourseSupportVerificationRejectionReason
) {
  await transaction.courseSupportVerificationRequest.updateMany({
    where: {
      id: request.id,
      revision: request.revision,
      status: request.status,
      leaseToken: request.leaseToken
    },
    data: {
      status: "STALE",
      revision: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: reason,
      completedAt: now,
      updatedAt: now
    }
  });
}

async function markRequestStaleIfNeeded(
  transaction: Prisma.TransactionClient,
  request: Pick<
    VerificationExecutionRow,
    "id" | "revision" | "status" | "leaseToken"
  >,
  now: Date,
  reason: CourseSupportVerificationRejectionReason
) {
  if (request.status !== "STALE") {
    await markRequestStale(transaction, request, now, reason);
  }
}

function buildAllowlistedEvidence(
  observation: CourseSupportVerificationObservation,
  request: VerificationExecutionRow,
  provider: ReturnType<typeof buildProviderSnapshot>,
  runtimeVersion: string,
  now: Date,
  providerRetryNotBeforeAt: Date | null = null
): Prisma.InputJsonObject {
  const observedAt = validDate(observation.observedAt, "observation time");
  if (
    observedAt.getTime() < now.getTime() - MAX_EVIDENCE_AGE_MS ||
    observedAt.getTime() > now.getTime() + MAX_EVIDENCE_FUTURE_SKEW_MS
  ) {
    throw new Error("Course-support verification evidence is not fresh.");
  }
  const availabilityCount = normalizeAvailabilityCount(
    observation.availabilityCount
  );
  const httpStatus = normalizeHttpStatus(observation.httpStatus);
  const adapterKey = normalizeAdapterKey(observation.adapterKey);
  const message = observation.message
    ? boundedMessage(observation.message)
    : null;
  if (
    (observation.outcome === "MATCH_FOUND" ||
      observation.outcome === "NO_MATCH") &&
    observation.providerExecution !== true
  ) {
    throw new Error(
      "Runnable course-support verification outcomes require provider execution."
    );
  }

  return {
    schemaVersion: 1,
    kind: "PROVIDER_VERIFICATION",
    providerExecution: observation.providerExecution,
    releaseSha: runtimeVersion,
    runtimeVersion,
    observedAt: observedAt.toISOString(),
    outcome: observation.outcome,
    providerFamilyKey: provider.providerFamilyKeySnapshot,
    detectedPlatform: provider.platformSnapshot,
    bookingMethod: provider.bookingMethodSnapshot,
    automationEligibility: provider.automationEligibilitySnapshot,
    automationReason: provider.automationReasonSnapshot,
    providerSnapshotFingerprint: provider.providerSnapshotFingerprint,
    ...(adapterKey ? { adapterKey } : {}),
    ...(availabilityCount !== null ? { availabilityCount } : {}),
    ...(httpStatus !== null ? { httpStatus } : {}),
    ...(providerRetryNotBeforeAt
      ? { providerRetryNotBeforeAt: providerRetryNotBeforeAt.toISOString() }
      : {}),
    ...(observation.failureClass
      ? { failureClass: observation.failureClass }
      : {}),
    ...(message ? { message } : {})
  };
}

function isCoherentVerificationEvidence(
  value: Prisma.JsonValue | null,
  expected: {
    releaseSha: string;
    outcome: ProbeOutcome;
    providerSnapshotFingerprint: string;
  }
): value is Prisma.JsonObject & {
  providerExecution: boolean;
} {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const providerExecution = value.providerExecution;
  const observedAt =
    typeof value.observedAt === "string" ? new Date(value.observedAt) : null;
  const providerRetryNotBeforeAt = observedAt
    ? parseProviderRetryNotBeforeAt(value, observedAt)
    : null;
  if (
    value.schemaVersion !== 1 ||
    value.kind !== "PROVIDER_VERIFICATION" ||
    typeof providerExecution !== "boolean" ||
    value.releaseSha !== expected.releaseSha ||
    value.runtimeVersion !== expected.releaseSha ||
    value.outcome !== expected.outcome ||
    value.providerSnapshotFingerprint !== expected.providerSnapshotFingerprint ||
    !observedAt ||
    !Number.isFinite(observedAt.getTime()) ||
    (value.providerRetryNotBeforeAt !== undefined &&
      !providerRetryNotBeforeAt)
  ) {
    return false;
  }
  return !(
    (expected.outcome === "MATCH_FOUND" || expected.outcome === "NO_MATCH") &&
    providerExecution !== true
  );
}

function parseProviderRetryNotBeforeAt(
  value: Prisma.JsonObject,
  observedAt: Date
) {
  const raw = value.providerRetryNotBeforeAt;
  if (typeof raw !== "string") {
    return null;
  }
  const parsed = new Date(raw);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.getTime() <= observedAt.getTime() ||
    parsed.toISOString() !== raw
  ) {
    return null;
  }
  return parsed;
}

function normalizeAvailabilityCount(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("Course-support verification availability count is invalid.");
  }
  return value;
}

function normalizeHttpStatus(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error("Course-support verification HTTP status is invalid.");
  }
  return value;
}

function normalizeAdapterKey(value: string | null | undefined) {
  if (!value) {
    return null;
  }
  if (!SAFE_ADAPTER_KEY.test(value)) {
    throw new Error("Course-support verification adapter key is invalid.");
  }
  return value;
}

function boundedMessage(value: string) {
  return sanitizeResponderText(value)
    .replace(
      /\b[a-z0-9_-]*(?:token|secret|signature|credential|password|session|cookie|code|key|sig)[a-z0-9_-]*\s*[:=]\s*[^\s,;]+/gi,
      "[redacted-credential]"
    )
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

export function resolveCourseSupportProviderRetryNotBeforeAt(input: {
  retryAfterSeconds?: number | null;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "provider cooldown time");
  if (
    input.retryAfterSeconds === null ||
    input.retryAfterSeconds === undefined ||
    !Number.isFinite(input.retryAfterSeconds) ||
    input.retryAfterSeconds < 0
  ) {
    return null;
  }
  const retryAfterMilliseconds = Math.ceil(input.retryAfterSeconds) * 1000;
  const retryAfterAt = new Date(now.getTime() + retryAfterMilliseconds);
  return Number.isFinite(retryAfterAt.getTime()) &&
    retryAfterAt.getTime() > now.getTime()
    ? retryAfterAt
    : null;
}

export function resolveCourseSupportVerificationRetryAt(input: {
  requestedRetryAt?: Date | null;
  retryAfterSeconds?: number | null;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "retry calculation time");
  const retryAfterAt = resolveCourseSupportProviderRetryNotBeforeAt({
    retryAfterSeconds: input.retryAfterSeconds,
    now
  });
  if (!retryAfterAt) {
    return validateRetryAt(input.requestedRetryAt ?? null, now);
  }
  if (retryAfterAt.getTime() > now.getTime() + MAX_RETRY_DELAY_MS) {
    // Never retry earlier than a provider's requested cooldown. A cooldown
    // beyond this request's bounded retry horizon is left to incident backoff.
    return null;
  }
  const requestedRetryAt = validateRetryAt(
    input.requestedRetryAt ?? null,
    now
  );
  return validateRetryAt(
    !requestedRetryAt || requestedRetryAt.getTime() < retryAfterAt.getTime()
      ? retryAfterAt
      : requestedRetryAt,
    now
  );
}

function validateRetryAt(value: Date | null, now: Date) {
  if (!value) {
    return null;
  }
  const retryAt = validDate(value, "retry time");
  if (
    retryAt.getTime() <= now.getTime() ||
    retryAt.getTime() > now.getTime() + MAX_RETRY_DELAY_MS
  ) {
    throw new Error("Course-support verification retry must be within 24 hours.");
  }
  return retryAt;
}

function validateReleaseSha(value: string) {
  const normalized = value.trim();
  if (!FULL_GIT_SHA.test(normalized)) {
    throw new Error(
      "Course-support verification requires a full Git release SHA."
    );
  }
  return normalized;
}

function validDate(value: Date, label: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`Course-support verification ${label} is invalid.`);
  }
  return value;
}

function localDateStorageBoundary(timeZone: string, value: Date) {
  const localDate = buildCourseSupportVerificationIntent(
    timeZone,
    value
  ).targetDateLocal;
  return new Date(`${localDate}T00:00:00.000Z`);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function providerSnapshotIsCurrent(request: VerificationExecutionRow) {
  return (
    buildProviderSnapshot(request.course).providerSnapshotFingerprint ===
    request.providerSnapshotFingerprint
  );
}

function hasCoherentVerifiedDiscovery(
  request: Pick<
    VerificationExecutionRow,
    "discoveryAttemptedAt" | "discoveryVerifiedAt"
  >,
  notAfter: Date
) {
  return Boolean(
    request.discoveryAttemptedAt &&
      request.discoveryVerifiedAt &&
      request.discoveryVerifiedAt.getTime() >=
        request.discoveryAttemptedAt.getTime() &&
      request.discoveryVerifiedAt.getTime() <= notAfter.getTime()
  );
}

function rejected(reason: CourseSupportVerificationRejectionReason) {
  return { claimed: false as const, reason };
}

function rejectedAttachment(reason: CourseSupportVerificationRejectionReason) {
  return { attached: false as const, reason };
}

function rejectedDiscoveryMark(
  reason: CourseSupportVerificationRejectionReason
) {
  return { marked: false as const, reason };
}

function rejectedCompletion(reason: CourseSupportVerificationRejectionReason) {
  return { completed: false as const, reason };
}

function rejectedFailure(reason: CourseSupportVerificationRejectionReason) {
  return { failed: false as const, reason };
}

function rejectedProof(reason: CourseSupportVerificationRejectionReason) {
  return { eligible: false as const, reason };
}

function rejectedFailureObservation(
  reason: CourseSupportVerificationRejectionReason
) {
  return { current: false as const, reason };
}
