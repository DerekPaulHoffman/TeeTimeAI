import { createHash, randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";
import type {
  AutomationEligibility,
  AutomationReason,
  BookingMethod,
  CourseMonitoringMode,
  CourseSupportFailureClass,
  DetectedPlatform,
  ProbeOutcome,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeTimeZone } from "@/lib/timezones";

import { getCourseLocalDateStorageBoundary } from "./date-boundary";
import {
  canonicalizeCourseProviderExecutionEvidence,
  stableCourseProviderExecutionEvidenceValue,
} from "./course-provider-execution-evidence";
import {
  AUTOMATION_PLAYBOOK_VERSION,
  assessAutomationPlaybook,
  parseAutomationPlaybookLedger,
  type AutomationPlaybookEvent,
  type AutomationPlaybookFactualDisposition,
} from "./course-monitoring-playbook";
import {
  createDeferredFailureHandoffBatchIncidentDigest,
  createDeferredFailureHandoffSourceProofDigest,
  parseDeferredFailureHandoffAdmission,
  parseDeferredFailureHandoffSignal,
  type DeferredFailureHandoffSignal,
} from "./course-support-deferred-failure-handoff";
import { evaluateMonitoringGate } from "./policy";
import {
  normalizeProviderFamilyKey,
  resolveProviderCapability,
} from "./provider-capabilities";
import { sanitizeResponderText } from "./course-support-responder-policy";
import { getAutomationRuntimeVersion } from "./runtime-version";
import {
  isAssignedDetachedStageProgression,
  isExactAssignedDetachedStageDirective,
} from "./course-support-remediation-routing";

export const COURSE_SUPPORT_VERIFICATION_LEASE_MS = 10 * 60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_ACTIVE_BATCH_CAPACITY = 5;
export const COURSE_SUPPORT_VERIFICATION_DEFAULT_BATCH_SIZE = 5;
export const COURSE_SUPPORT_VERIFICATION_MAX_DUE =
  COURSE_SUPPORT_VERIFICATION_ACTIVE_BATCH_CAPACITY *
  COURSE_SUPPORT_VERIFICATION_DEFAULT_BATCH_SIZE;
export const COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS = 35 * 60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_ENDPOINT_DELIVERY_MARGIN_MS =
  60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_GRACE_MS = 60 * 1000;
const COURSE_SUPPORT_VERIFICATION_LEGACY_HORIZON_MS = 24 * 60 * 60 * 1000;
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
const COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX =
  "runtime_release_mismatch:";
const SUCCESSFUL_PROBE_OUTCOMES = new Set<ProbeOutcome>([
  "MATCH_FOUND",
  "NO_MATCH",
]);

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
  bookingWindowConfidence: true,
  automationEligibility: true,
  automationReason: true,
  monitoringMode: true,
  bookingAccessMode: true,
  isPublic: true,
  intelligenceVerifiedAt: true,
  intelligenceReviewAt: true,
  intelligenceConfidence: true,
  bookingMetadata: true,
  layoutHoleCounts: true,
  layoutHolesVerifiedAt: true,
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
  deadlineAt: true,
  targetDateLocal: true,
  startTimeLocal: true,
  endTimeLocal: true,
  timeZone: true,
  players: true,
  providerSnapshotFingerprint: true,
  discoveryAttemptedAt: true,
  discoveryVerifiedAt: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  lastError: true,
  batchIncident: {
    select: {
      id: true,
      batchId: true,
      incidentId: true,
      courseId: true,
      cycle: true,
      result: true,
      proofSnapshot: true,
      verifiedAt: true,
      updatedAt: true,
      batch: {
        select: {
          id: true,
          status: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          baseSha: true,
          releaseSha: true,
          summary: true,
          createdAt: true,
          completedAt: true,
        },
      },
      incident: {
        select: {
          id: true,
          cycle: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          activeBatchId: true,
          engineeringOnly: true,
          activeRealSearchCount: true,
          earliestTargetDate: true,
          escalationDeadlineAt: true,
          firstSeenAt: true,
          attemptLedger: true,
          revision: true,
          updatedAt: true,
          status: true,
        },
      },
      verifiedIncidentUpdatedAt: true,
    },
  },
  course: { select: providerCourseSelect },
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

export type CourseSupportFactualFinalProof = Prisma.JsonObject & {
  schemaVersion: 1;
  kind: "PLAYBOOK_FACTUAL_FINAL";
  playbookVersion: typeof AUTOMATION_PLAYBOOK_VERSION;
  disposition: AutomationPlaybookFactualDisposition;
  outcome: "MANUAL_DIRECT" | "IDENTITY_FINAL";
  cycle: number;
  stage:
    | "OFFICIAL_IDENTITY"
    | "RENDERED_BROWSER_DISCOVERY"
    | "INDEPENDENT_CONFIRMATION";
  sequence: number;
  readPath:
    "OFFICIAL_IDENTITY" | "RENDERED_BROWSER" | "INDEPENDENT_CONFIRMATION";
  evidenceKind: "OFFICIAL_SOURCE" | "RENDERED_PAGE";
  failureFingerprint: string;
  observedAt: string;
  completedAt: string;
  releaseSha: string;
  runtimeVersion: string;
  providerExecution: false;
};

export type CourseSupportVerificationRejectionReason =
  | "not_found"
  | "stale_revision"
  | "not_due"
  | "runtime_mismatch"
  | "release_runtime_cutover"
  | "batch_release_changed"
  | "batch_not_verifying"
  | "batch_ownership_changed"
  | "incident_not_engineering_only"
  | "incident_demand_changed"
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
          summary: true,
          incidents: {
            ...(input.batchIncidentIds
              ? { where: { id: { in: [...new Set(input.batchIncidentIds)] } } }
              : {}),
            select: {
              id: true,
              incidentId: true,
              courseId: true,
              cycle: true,
              verifiedIncidentUpdatedAt: true,
              incident: {
                select: {
                  id: true,
                  cycle: true,
                  activeBatchId: true,
                  engineeringOnly: true,
                  activeRealSearchCount: true,
                  earliestTargetDate: true,
                  escalationDeadlineAt: true,
                  firstSeenAt: true,
                  attemptLedger: true,
                  revision: true,
                  updatedAt: true,
                  status: true,
                },
              },
              course: { select: providerCourseSelect },
            },
          },
        },
      });

      if (!batch) {
        throw new Error("Course-support verification batch was not found.");
      }
      if (batch.releaseSha !== releaseSha) {
        throw new Error(
          "Course-support verification release must equal the batch release SHA.",
        );
      }
      if (batch.status !== "VERIFYING" || batch.completedAt !== null) {
        throw new Error(
          "Course-support verification requires an actively verifying batch.",
        );
      }

      const eligible = [] as Array<{
        batchIncidentId: string;
        courseId: string;
        releaseSha: string;
        nextAttemptAt: Date;
        deadlineAt: Date;
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
      const endpointExpired = [] as Array<{
        batchIncidentId: string;
        incidentId: string;
        batchIncidentCycle: number;
        incidentCycle: number;
      }>;
      const deadlineCaps = [] as Array<{
        batchIncidentId: string;
        incidentId: string;
        batchIncidentCycle: number;
        incidentCycle: number;
        deadlineAt: Date;
      }>;
      const ineligibleReasonCounts: Partial<
        Record<CourseSupportVerificationRejectionReason, number>
      > = {};
      const recordIneligibleReason = (
        reason: CourseSupportVerificationRejectionReason,
      ) => {
        ineligibleReasonCounts[reason] =
          (ineligibleReasonCounts[reason] ?? 0) + 1;
      };

      for (const entry of batch.incidents) {
        const deadlineAt = getCourseSupportVerificationRequestDeadline({
          now,
          escalationDeadlineAt: entry.incident.escalationDeadlineAt,
        });
        if (!deadlineAt) {
          recordIneligibleReason("request_horizon_exceeded");
          endpointExpired.push({
            batchIncidentId: entry.id,
            incidentId: entry.incidentId,
            batchIncidentCycle: entry.cycle,
            incidentCycle: entry.incident.cycle,
          });
          continue;
        }
        const eligibility = await evaluateDetachedEligibility(
          transaction,
          buildDetachedEligibilityInput({
            batch,
            batchIncident: entry,
            courseId: entry.courseId,
            course: entry.course,
            releaseSha,
          }),
          now,
          "PROGRESSION",
        );
        if (!eligibility.eligible) {
          recordIneligibleReason(eligibility.reason);
          continue;
        }

        const provider = buildProviderSnapshot(entry.course);
        const intent = buildCourseSupportVerificationIntent(
          entry.course.timeZone,
          now,
        );
        eligible.push({
          batchIncidentId: entry.id,
          courseId: entry.courseId,
          releaseSha,
          nextAttemptAt: now,
          deadlineAt,
          ...intent,
          ...provider,
          providerSnapshotAt: now,
          createdAt: now,
          updatedAt: now,
        });
        deadlineCaps.push({
          batchIncidentId: entry.id,
          incidentId: entry.incidentId,
          batchIncidentCycle: entry.cycle,
          incidentCycle: entry.incident.cycle,
          deadlineAt,
        });
      }

      const created = eligible.length
        ? await transaction.courseSupportVerificationRequest.createMany({
            data: eligible,
            skipDuplicates: true,
          })
        : { count: 0 };

      for (const entry of deadlineCaps) {
        const ownershipFence = {
          batchIncidentId: entry.batchIncidentId,
          releaseSha,
          batchIncident: {
            batchId: batch.id,
            incidentId: entry.incidentId,
            cycle: entry.batchIncidentCycle,
            incident: {
              is: {
                cycle: entry.incidentCycle,
                activeBatchId: batch.id,
                status: "AUTO_INVESTIGATING" as const,
              },
            },
          },
        };
        await transaction.courseSupportVerificationRequest.updateMany({
          where: {
            ...ownershipFence,
            status: { in: ["QUEUED", "RETRYABLE_FAILED"] },
            nextAttemptAt: { gte: entry.deadlineAt },
            deadlineAt: { gt: entry.deadlineAt },
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
        await transaction.courseSupportVerificationRequest.updateMany({
          where: {
            ...ownershipFence,
            status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
            deadlineAt: { gt: entry.deadlineAt },
          },
          data: {
            deadlineAt: entry.deadlineAt,
            updatedAt: now,
          },
        });
      }

      for (const entry of endpointExpired) {
        await transaction.courseSupportVerificationRequest.updateMany({
          where: {
            batchIncidentId: entry.batchIncidentId,
            releaseSha,
            status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
            batchIncident: {
              batchId: batch.id,
              incidentId: entry.incidentId,
              cycle: entry.batchIncidentCycle,
              incident: {
                is: {
                  cycle: entry.incidentCycle,
                  activeBatchId: batch.id,
                  status: "AUTO_INVESTIGATING",
                },
              },
            },
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
      }

      const requests = eligible.length
        ? await transaction.courseSupportVerificationRequest.findMany({
            where: {
              releaseSha,
              batchIncidentId: {
                in: eligible.map((entry) => entry.batchIncidentId),
              },
            },
            select: {
              id: true,
              batchIncidentId: true,
              releaseSha: true,
              status: true,
              revision: true,
              nextAttemptAt: true,
            },
            orderBy: { createdAt: "asc" },
          })
        : [];

      return {
        createdCount: created.count,
        eligibleCount: eligible.length,
        ineligibleCount: batch.incidents.length - eligible.length,
        ...(Object.keys(ineligibleReasonCounts).length > 0
          ? {
              ineligibleReasonCounts: Object.fromEntries(
                Object.entries(ineligibleReasonCounts).sort(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
            }
          : {}),
        requests,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function listDueCourseSupportVerificationRequests(
  input: {
    now?: Date;
    limit?: number;
    runtimeVersion?: string;
  } = {},
) {
  const now = validDate(input.now ?? new Date(), "due-list time");
  const runtimeVersion = input.runtimeVersion
    ? validateReleaseSha(input.runtimeVersion)
    : null;
  const requestedLimit =
    input.limit === undefined || !Number.isFinite(input.limit)
      ? COURSE_SUPPORT_VERIFICATION_MAX_DUE
      : Math.trunc(input.limit);
  const limit = Math.min(
    COURSE_SUPPORT_VERIFICATION_MAX_DUE,
    Math.max(1, requestedLimit),
  );
  await prisma.courseSupportVerificationRequest.updateMany({
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

  return prisma.courseSupportVerificationRequest.findMany({
    where: {
      createdAt: {
        gt: new Date(
          now.getTime() - COURSE_SUPPORT_VERIFICATION_LEGACY_HORIZON_MS,
        ),
      },
      deadlineAt: { gt: now },
      OR: [
        { status: "QUEUED", nextAttemptAt: { lte: now } },
        { status: "RETRYABLE_FAILED", nextAttemptAt: { lte: now } },
        { status: "CHECKING", leaseExpiresAt: { lte: now } },
        ...(runtimeVersion
          ? [
              {
                releaseSha: runtimeVersion,
                status: {
                  in: ["QUEUED" as const, "RETRYABLE_FAILED" as const],
                },
                lastError: {
                  startsWith:
                    COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX,
                },
              },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      releaseSha: true,
      status: true,
      revision: true,
    },
    orderBy: [{ nextAttemptAt: "asc" }, { updatedAt: "asc" }],
    take: limit,
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
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
          "request_horizon_exceeded",
        );
        return rejected("request_horizon_exceeded");
      }
      if (request.batchIncident.batch.releaseSha !== request.releaseSha) {
        await markRequestStale(
          transaction,
          request,
          now,
          "batch_release_changed",
        );
        return rejected("batch_release_changed");
      }
      if (runtimeVersion !== request.releaseSha) {
        const mismatchMarkedAt = getRuntimeMismatchMarkedAt(request.lastError);
        if (mismatchMarkedAt) {
          if (
            now.getTime() - mismatchMarkedAt.getTime() >=
            COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_GRACE_MS
          ) {
            await markRequestStale(
              transaction,
              request,
              now,
              "release_runtime_cutover",
            );
            return rejected("release_runtime_cutover");
          }
          return rejected("runtime_mismatch");
        }
        if (!isDueForClaim(request, now)) {
          return rejected("not_due");
        }
        const mismatchDeferred = await deferRuntimeMismatch(
          transaction,
          request,
          now,
        );
        if (!mismatchDeferred) {
          return rejected("stale_revision");
        }
        return rejected("runtime_mismatch");
      }
      if (
        !isDueForClaim(request, now) &&
        !isRuntimeMismatchGraceRequest(request)
      ) {
        return rejected("not_due");
      }

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now,
        "PROGRESSION",
        { kind: "RECLAIMABLE_REQUEST", request },
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
        now,
      );
      const leaseToken = randomUUID();
      const leaseExpiresAt = new Date(
        now.getTime() + COURSE_SUPPORT_VERIFICATION_LEASE_MS,
      );
      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: {
            id: request.id,
            revision: request.revision,
            releaseSha: runtimeVersion,
            deadlineAt: { gt: now },
            OR: claimableStatePredicate(
              now,
              isRuntimeMismatchGraceRequest(request),
            ),
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
                  discoveryAttemptedAt: null,
                  discoveryVerifiedAt: null,
                }
              : {}),
            providerSnapshotAt: now,
            outcome: null,
            failureClass: null,
            evidence: Prisma.JsonNull,
            lastError: null,
            completedAt: null,
            updatedAt: now,
          },
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
        intent,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      revision: { gte: input.expectedRevision },
    },
    data: { workflowRunId: input.workflowRunId, updatedAt: now },
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
    now.getTime() + COURSE_SUPPORT_VERIFICATION_LEASE_MS,
  );
  const updated = await prisma.courseSupportVerificationRequest.updateMany({
    where: ownedCheckingWhere(input, now),
    data: { leaseExpiresAt, updatedAt: now },
  });
  return {
    renewed: updated.count === 1,
    leaseExpiresAt: updated.count === 1 ? leaseExpiresAt : null,
  };
}

export async function attachCourseSupportVerificationProviderSnapshot(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  purpose: "PRE_EXECUTION" | "POST_DISCOVERY";
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "provider snapshot time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedAttachment(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      if (!eligibility.eligible) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          eligibility.reason,
        );
        return rejectedAttachment(eligibility.reason);
      }
      if (
        ownedRequest.batchIncident.batch.releaseSha !== ownedRequest.releaseSha
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "batch_release_changed",
        );
        return rejectedAttachment("batch_release_changed");
      }

      const provider = buildProviderSnapshot(ownedRequest.course);
      const providerSnapshotChanged =
        provider.providerSnapshotFingerprint !==
        ownedRequest.providerSnapshotFingerprint;
      const deferredFailureRouteClaimed =
        input.purpose === "PRE_EXECUTION" &&
        isDeferredFailureConfirmationRouteClaimed(ownedRequest);
      const deferredFailureIntent =
        input.purpose === "PRE_EXECUTION"
          ? readExactDeferredFailureConfirmationIntent({
              request: ownedRequest,
              provider,
              now,
              executionState: "UNSTARTED",
            })
          : null;
      let deferredFailureConfirmation = false;
      if (deferredFailureRouteClaimed && !deferredFailureIntent) {
        const reason = deferredFailureConfirmationRejectionReason(
          ownedRequest,
          provider,
        );
        await markRequestStale(transaction, ownedRequest, now, reason);
        return rejectedAttachment(reason);
      }
      if (deferredFailureIntent) {
        const currentState =
          await validateDeferredFailureConfirmationCurrentState({
            transaction,
            request: ownedRequest,
            provider,
            signal: deferredFailureIntent.signal,
            now,
          });
        if (!currentState.valid) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            currentState.reason,
          );
          return rejectedAttachment(currentState.reason);
        }
        deferredFailureConfirmation = true;
      }
      if (
        input.purpose === "POST_DISCOVERY" &&
        (!ownedRequest.discoveryAttemptedAt ||
          ownedRequest.discoveryAttemptedAt.getTime() > now.getTime())
      ) {
        return rejectedAttachment("discovery_not_attempted");
      }
      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: ownedCheckingWhere(input, now),
          data: {
            ...provider,
            ...(input.purpose === "PRE_EXECUTION"
              ? { startedAt: ownedRequest.startedAt ?? now }
              : {}),
            ...(providerSnapshotChanged
              ? {
                  ...(input.purpose === "PRE_EXECUTION"
                    ? { discoveryAttemptedAt: null }
                    : {}),
                  discoveryVerifiedAt: null,
                }
              : {}),
            providerSnapshotAt: now,
            revision: { increment: 1 },
            updatedAt: now,
          },
        });
      if (updated.count !== 1) {
        return rejectedAttachment("lease_lost");
      }
      return {
        attached: true as const,
        revision: ownedRequest.revision + 1,
        providerFamilyKeySnapshot: provider.providerFamilyKeySnapshot,
        providerSnapshotFingerprint: provider.providerSnapshotFingerprint,
        discoveryAttemptedAt:
          providerSnapshotChanged && input.purpose === "PRE_EXECUTION"
            ? null
            : ownedRequest.discoveryAttemptedAt,
        discoveryVerifiedAt: providerSnapshotChanged
          ? null
          : ownedRequest.discoveryVerifiedAt,
        courseId: ownedRequest.courseId,
        intent: {
          targetDateLocal: ownedRequest.targetDateLocal,
          startTimeLocal: ownedRequest.startTimeLocal,
          endTimeLocal: ownedRequest.endTimeLocal,
          timeZone: ownedRequest.timeZone,
          players: ownedRequest.players,
        },
        deferredFailureConfirmation,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedDiscoveryMark(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      if (!eligibility.eligible) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          eligibility.reason,
        );
        return rejectedDiscoveryMark(eligibility.reason);
      }
      if (!providerSnapshotIsCurrent(ownedRequest)) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "provider_snapshot_changed",
        );
        return rejectedDiscoveryMark("provider_snapshot_changed");
      }
      if (isDeferredFailureConfirmationRouteClaimed(ownedRequest)) {
        const provider = buildProviderSnapshot(ownedRequest.course);
        const deferredFailureIntent =
          readExactDeferredFailureConfirmationIntent({
            request: ownedRequest,
            provider,
            now,
            executionState: "STARTED",
          });
        if (!deferredFailureIntent) {
          const reason = deferredFailureConfirmationRejectionReason(
            ownedRequest,
            provider,
          );
          await markRequestStale(transaction, ownedRequest, now, reason);
          return rejectedDiscoveryMark(reason);
        }
        const currentState =
          await validateDeferredFailureConfirmationCurrentState({
            transaction,
            request: ownedRequest,
            provider,
            signal: deferredFailureIntent.signal,
            now,
          });
        if (!currentState.valid) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            currentState.reason,
          );
          return rejectedDiscoveryMark(currentState.reason);
        }
      }
      if (ownedRequest.discoveryAttemptedAt) {
        return rejectedDiscoveryMark("discovery_already_attempted");
      }

      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: ownedCheckingWhere(input, now),
          data: {
            discoveryAttemptedAt: now,
            revision: { increment: 1 },
            updatedAt: now,
          },
        });
      if (updated.count !== 1) {
        return rejectedDiscoveryMark("lease_lost");
      }
      return {
        marked: true as const,
        revision: ownedRequest.revision + 1,
        discoveryAttemptedAt: now,
        discoveryVerifiedAt: ownedRequest.discoveryVerifiedAt,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedDiscoveryMark(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      if (!eligibility.eligible) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          eligibility.reason,
        );
        return rejectedDiscoveryMark(eligibility.reason);
      }
      if (!providerSnapshotIsCurrent(ownedRequest)) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "provider_snapshot_changed",
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
          discoveryVerifiedAt: ownedRequest.discoveryVerifiedAt,
        };
      }

      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: ownedCheckingWhere(input, now),
          data: {
            discoveryVerifiedAt: now,
            revision: { increment: 1 },
            updatedAt: now,
          },
        });
      if (updated.count !== 1) {
        return rejectedDiscoveryMark("lease_lost");
      }
      return {
        marked: true as const,
        revision: ownedRequest.revision + 1,
        discoveryAttemptedAt: ownedRequest.discoveryAttemptedAt,
        discoveryVerifiedAt: now,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedCompletion(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      if (!eligibility.eligible) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          eligibility.reason,
        );
        return rejectedCompletion(eligibility.reason);
      }
      if (
        ownedRequest.batchIncident.batch.releaseSha !== ownedRequest.releaseSha
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "batch_release_changed",
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
          "discovery_not_verified",
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
          "provider_snapshot_changed",
        );
        return rejectedCompletion("provider_snapshot_changed");
      }
      if (isDeferredFailureConfirmationRouteClaimed(ownedRequest)) {
        const deferredFailureIntent =
          readExactDeferredFailureConfirmationIntent({
            request: ownedRequest,
            provider,
            now,
            executionState: "STARTED",
          });
        if (!deferredFailureIntent) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            "invalid_evidence",
          );
          return rejectedCompletion("invalid_evidence");
        }
        const currentState =
          await validateDeferredFailureConfirmationCurrentState({
            transaction,
            request: ownedRequest,
            provider,
            signal: deferredFailureIntent.signal,
            now,
          });
        if (!currentState.valid) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            currentState.reason,
          );
          return rejectedCompletion(currentState.reason);
        }
      }

      const evidence = buildAllowlistedEvidence(
        input.observation,
        ownedRequest,
        provider,
        input.runtimeVersion,
        now,
      );
      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
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
            updatedAt: now,
          },
        });
      if (updated.count !== 1) {
        return rejectedCompletion("lease_lost");
      }
      return {
        completed: true as const,
        status: "SUCCEEDED" as const,
        revision: ownedRequest.revision + 1,
        outcome: input.observation.outcome,
        evidence,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function completeCourseSupportVerificationFactualFinal(input: {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
  disposition: AutomationPlaybookFactualDisposition;
  message: string;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "factual completion time");
  validateReleaseSha(input.runtimeVersion);

  return prisma.$transaction(
    async (transaction) => {
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedCompletion(ownership.reason);
      }
      const ownedRequest = ownership.request;
      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      if (!eligibility.eligible) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          eligibility.reason,
        );
        return rejectedCompletion(eligibility.reason);
      }
      if (
        ownedRequest.batchIncident.batch.releaseSha !== ownedRequest.releaseSha
      ) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "batch_release_changed",
        );
        return rejectedCompletion("batch_release_changed");
      }

      const factualEvent = getCurrentCourseSupportFactualFinalEvent({
        attemptLedger: ownedRequest.batchIncident.incident.attemptLedger,
        cycle: ownedRequest.batchIncident.incident.cycle,
        firstSeenAt: ownedRequest.batchIncident.incident.firstSeenAt,
        runtimeVersion: input.runtimeVersion,
        disposition: input.disposition,
        notBefore: new Date(now.getTime() - MAX_EVIDENCE_AGE_MS),
        now,
      });
      if (!factualEvent) {
        await markRequestStale(
          transaction,
          ownedRequest,
          now,
          "invalid_evidence",
        );
        return rejectedCompletion("invalid_evidence");
      }

      const proof = buildCourseSupportFactualFinalProof({
        event: factualEvent,
        completedAt: now,
        runtimeVersion: input.runtimeVersion,
      });
      const outcome = factualOutcome(input.disposition);
      const message = boundedMessage(input.message);
      const requestUpdated =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: ownedCheckingWhere(input, now),
          data: {
            status: "SUCCEEDED",
            revision: { increment: 1 },
            leaseToken: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            outcome,
            failureClass: null,
            evidence: proof as Prisma.InputJsonObject,
            lastError: null,
            completedAt: now,
            updatedAt: now,
          },
        });
      if (requestUpdated.count !== 1) {
        return rejectedCompletion("lease_lost");
      }

      const batchIncidentUpdated =
        await transaction.courseSupportBatchIncident.updateMany({
          where: {
            id: ownedRequest.batchIncident.id,
            batchId: ownedRequest.batchIncident.batchId,
            incidentId: ownedRequest.batchIncident.incidentId,
            courseId: ownedRequest.batchIncident.courseId,
            cycle: ownedRequest.batchIncident.cycle,
            result: ownedRequest.batchIncident.result,
            updatedAt: ownedRequest.batchIncident.updatedAt,
            verifiedIncidentUpdatedAt:
              ownedRequest.batchIncident.verifiedIncidentUpdatedAt,
            batch: {
              status: "VERIFYING",
              releaseSha: input.runtimeVersion,
              completedAt: null,
            },
            incident: {
              cycle: ownedRequest.batchIncident.incident.cycle,
              activeBatchId: ownedRequest.batchIncident.batchId,
              status: "AUTO_INVESTIGATING",
              updatedAt: ownedRequest.batchIncident.incident.updatedAt,
            },
          },
          data: {
            result: "FINAL_DISPOSITION",
            postProbeId: null,
            message,
            proofSnapshot: proof as Prisma.InputJsonObject,
            verifiedIncidentUpdatedAt:
              ownedRequest.batchIncident.incident.updatedAt,
            verifiedAt: now,
          },
        });
      if (batchIncidentUpdated.count !== 1) {
        throw new Error(
          "Responder factual-final evidence changed during delegated verification completion.",
        );
      }

      return {
        completed: true as const,
        status: "SUCCEEDED" as const,
        revision: ownedRequest.revision + 1,
        outcome,
        evidence: proof,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
  observation?: Omit<
    CourseSupportVerificationObservation,
    "failureClass" | "message"
  >;
  now?: Date;
}) {
  const now = validDate(input.now ?? new Date(), "failure time");
  validateReleaseSha(input.runtimeVersion);
  const providerRetryNotBeforeAt = resolveCourseSupportProviderRetryNotBeforeAt(
    {
      retryAfterSeconds: input.retryAfterSeconds ?? null,
      now,
    },
  );
  const retryAt = resolveCourseSupportVerificationRetryAt({
    requestedRetryAt: input.retryAt ?? null,
    retryAfterSeconds: input.retryAfterSeconds ?? null,
    now,
  });

  return prisma.$transaction(
    async (transaction) => {
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: { id: input.requestId },
          select: requestExecutionSelect,
        });
      const ownership = validateExecutionOwnership(request, input, now);
      if (!ownership.valid) {
        return rejectedFailure(ownership.reason);
      }
      const ownedRequest = ownership.request;

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(ownedRequest),
        now,
        "PROGRESSION",
        { kind: "VALIDATED_CHECKING", request: ownedRequest },
      );
      const provider = buildProviderSnapshot(ownedRequest.course);
      const deferredFailureRouteClaimed =
        isDeferredFailureConfirmationRouteClaimed(ownedRequest);
      if (deferredFailureRouteClaimed) {
        if (!eligibility.eligible) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            eligibility.reason,
          );
          return rejectedFailure(eligibility.reason);
        }
        if (
          ownedRequest.batchIncident.batch.releaseSha !==
            ownedRequest.releaseSha ||
          provider.providerSnapshotFingerprint !==
            ownedRequest.providerSnapshotFingerprint
        ) {
          const reason =
            ownedRequest.batchIncident.batch.releaseSha !==
            ownedRequest.releaseSha
              ? "batch_release_changed"
              : "provider_snapshot_changed";
          await markRequestStale(transaction, ownedRequest, now, reason);
          return rejectedFailure(reason);
        }
        const deferredFailureIntent =
          readExactDeferredFailureConfirmationIntent({
            request: ownedRequest,
            provider,
            now,
            executionState: "STARTED",
          });
        if (!deferredFailureIntent) {
          const reason = deferredFailureConfirmationRejectionReason(
            ownedRequest,
            provider,
          );
          await markRequestStale(transaction, ownedRequest, now, reason);
          return rejectedFailure(reason);
        }
        const currentState =
          await validateDeferredFailureConfirmationCurrentState({
            transaction,
            request: ownedRequest,
            provider,
            signal: deferredFailureIntent.signal,
            now,
          });
        if (!currentState.valid) {
          await markRequestStale(
            transaction,
            ownedRequest,
            now,
            currentState.reason,
          );
          return rejectedFailure(currentState.reason);
        }
      }
      const stillCurrent =
        ownedRequest.batchIncident.batch.releaseSha ===
          ownedRequest.releaseSha &&
        provider.providerSnapshotFingerprint ===
          ownedRequest.providerSnapshotFingerprint;
      const retryWithinRequestHorizon = Boolean(
        retryAt &&
        retryAt.getTime() < getVerificationDeadline(ownedRequest).getTime(),
      );
      const retryable =
        !deferredFailureRouteClaimed &&
        eligibility.eligible &&
        stillCurrent &&
        retryWithinRequestHorizon;
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
        message,
      };
      const evidence = buildAllowlistedEvidence(
        observation,
        ownedRequest,
        provider,
        input.runtimeVersion,
        now,
        providerRetryNotBeforeAt,
      );
      const updated =
        await transaction.courseSupportVerificationRequest.updateMany({
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
            updatedAt: now,
          },
        });
      if (updated.count !== 1) {
        return rejectedFailure("lease_lost");
      }
      return {
        failed: true as const,
        status,
        revision: ownedRequest.revision + 1,
        nextAttemptAt: retryable ? retryAt : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: {
            batchIncidentId_releaseSha: {
              batchIncidentId: input.batchIncidentId,
              releaseSha,
            },
          },
          select: {
            ...requestExecutionSelect,
            outcome: true,
            evidence: true,
            completedAt: true,
          },
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
      if (request.batchIncident.batch.releaseSha !== releaseSha) {
        await markRequestStale(
          transaction,
          request,
          now,
          "batch_release_changed",
        );
        return rejectedProof("batch_release_changed");
      }
      if (asJsonRecord(request.evidence).kind === "PLAYBOOK_FACTUAL_FINAL") {
        if (
          !isCourseSupportFactualFinalProof({
            proof: request.evidence,
            attemptLedger: request.batchIncident.incident.attemptLedger,
            cycle: request.batchIncident.incident.cycle,
            firstSeenAt: request.batchIncident.incident.firstSeenAt,
            releaseSha,
            verifiedAt: request.completedAt,
            now,
          })
        ) {
          await markRequestStale(transaction, request, now, "invalid_evidence");
          return rejectedProof("invalid_evidence");
        }
        const eligibility = await evaluateDetachedEligibility(
          transaction,
          buildDetachedEligibilityInputFromRequest(request),
          now,
          "PROOF",
          { kind: "DURABLE_RESULT", request },
        );
        if (!eligibility.eligible) {
          await markRequestStale(transaction, request, now, eligibility.reason);
          return rejectedProof(eligibility.reason);
        }
        return {
          eligible: true as const,
          releaseSha,
          runtimeVersion: request.runtimeVersion,
          outcome: request.outcome,
          providerExecution: false as const,
          completedAt: request.completedAt,
          providerSnapshotFingerprint: request.providerSnapshotFingerprint,
          evidence: request.evidence,
        };
      }
      if (
        !hasCoherentVerifiedDiscovery(
          request,
          request.completedAt.getTime() < now.getTime()
            ? request.completedAt
            : now,
        )
      ) {
        await markRequestStale(
          transaction,
          request,
          now,
          "discovery_not_verified",
        );
        return rejectedProof("discovery_not_verified");
      }
      if (
        !isCoherentVerificationEvidence(request.evidence, {
          releaseSha,
          outcome: request.outcome,
          providerSnapshotFingerprint: request.providerSnapshotFingerprint,
        })
      ) {
        await markRequestStale(transaction, request, now, "invalid_evidence");
        return rejectedProof("invalid_evidence");
      }
      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now,
        "PROOF",
        { kind: "DURABLE_RESULT", request },
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
          "provider_snapshot_changed",
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
        evidence: request.evidence,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
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
      const request =
        await transaction.courseSupportVerificationRequest.findUnique({
          where: {
            batchIncidentId_releaseSha: {
              batchIncidentId: input.batchIncidentId,
              releaseSha,
            },
          },
          select: {
            ...requestExecutionSelect,
            outcome: true,
            failureClass: true,
            evidence: true,
            completedAt: true,
          },
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
          providerSnapshotFingerprint: request.providerSnapshotFingerprint,
        }) ||
        request.evidence.failureClass !== request.failureClass
      ) {
        await markRequestStaleIfNeeded(
          transaction,
          request,
          now,
          "invalid_evidence",
        );
        return rejectedFailureObservation("invalid_evidence");
      }

      const eligibility = await evaluateDetachedEligibility(
        transaction,
        buildDetachedEligibilityInputFromRequest(request),
        now,
        "PROOF",
        { kind: "DURABLE_RESULT", request },
      );
      if (!eligibility.eligible) {
        await markRequestStaleIfNeeded(
          transaction,
          request,
          now,
          eligibility.reason,
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
          "provider_snapshot_changed",
        );
        return rejectedFailureObservation("provider_snapshot_changed");
      }

      const observedAt = new Date(String(request.evidence.observedAt));
      const providerRetryNotBeforeAt = parseProviderRetryNotBeforeAt(
        request.evidence,
        observedAt,
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
        evidence: request.evidence,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export function buildCourseSupportVerificationIntent(
  timeZone: string | null | undefined,
  now = new Date(),
): CourseSupportVerificationIntent {
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(validDate(now, "intent time"));
  const byType = new Map(parts.map((part) => [part.type, part.value]));

  return {
    targetDateLocal: `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`,
    startTimeLocal: COURSE_SUPPORT_VERIFICATION_START_TIME,
    endTimeLocal: COURSE_SUPPORT_VERIFICATION_END_TIME,
    timeZone: normalizedTimeZone,
    players: COURSE_SUPPORT_VERIFICATION_PLAYERS,
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
  bookingWindowConfidence?: number | null;
  automationEligibility: AutomationEligibility;
  automationReason: AutomationReason;
  monitoringMode?: CourseMonitoringMode;
  bookingAccessMode?: string | null;
  isPublic?: boolean | null;
  intelligenceVerifiedAt?: Date | null;
  intelligenceReviewAt?: Date | null;
  intelligenceConfidence?: number | null;
  bookingMetadata?: unknown;
  layoutHoleCounts?: number[];
  layoutHolesVerifiedAt?: Date | null;
}) {
  return createHash("sha256")
    .update(
      stableCourseProviderExecutionEvidenceValue(
        canonicalizeCourseProviderExecutionEvidence(input),
      ),
    )
    .digest("hex");
}

function buildProviderSnapshot(course: ProviderCourseSnapshot) {
  return {
    providerFamilyKeySnapshot: normalizeProviderFamilyKey(
      course.providerFamilyKey,
    ),
    platformSnapshot: course.detectedPlatform,
    bookingMethodSnapshot: course.bookingMethod,
    automationEligibilitySnapshot: course.automationEligibility,
    automationReasonSnapshot: course.automationReason,
    providerSnapshotFingerprint:
      buildCourseSupportProviderSnapshotFingerprint(course),
  };
}

function readExactDeferredFailureConfirmationIntent(input: {
  request: VerificationExecutionRow;
  provider: ReturnType<typeof buildProviderSnapshot>;
  now: Date;
  executionState: "UNSTARTED" | "STARTED";
}) {
  const { request, provider, now, executionState } = input;
  const batch = request.batchIncident.batch;
  const incident = request.batchIncident.incident;
  const summary = asJsonRecord(batch.summary);
  const remediation = asJsonRecord(summary.remediation);
  const plannedPaths = summary.plannedPaths;
  const rawAttempts = remediation.attempts;
  const courseRef = createHash("sha256")
    .update(request.courseId)
    .digest("hex")
    .slice(0, 24);
  if (!Array.isArray(rawAttempts)) return null;
  const matchingAttempts = rawAttempts.filter(
    (candidate) => asJsonRecord(candidate).courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return null;
  const attempt = asJsonRecord(matchingAttempts[0]);
  const approach = asJsonRecord(attempt.approach);
  const signal = parseDeferredFailureHandoffSignal(
    attempt.deferredFailureHandoffSource,
  );
  const admission = parseDeferredFailureHandoffAdmission(
    attempt.deferredFailureHandoffAdmission,
  );
  if (!signal || !admission) return null;
  const admittedAt = new Date(admission.admittedAt);
  const eligibleAt = new Date(signal.eligibleAt);
  const playbook = assessAutomationPlaybook(
    incident.attemptLedger,
    incident.cycle,
  );
  const playbookEventCount =
    parseAutomationPlaybookLedger(incident.attemptLedger)?.events.filter(
      (event) => event.cycle === incident.cycle,
    ).length ?? -1;
  const valid = Boolean(
    Array.isArray(plannedPaths) &&
    plannedPaths.length === 0 &&
    remediation.workMode === "VERIFY_TRANSIENT" &&
    remediation.strategyAction === "RETRY_PROVIDER" &&
    remediation.playbookStage === null &&
    remediation.allowUnchangedRuntime === true &&
    remediation.requiresImplementationPath === false &&
    remediation.retryBudget === null &&
    remediation.reason === "MATERIAL_CHANGE_REOPENED" &&
    approach.workMode === "VERIFY_TRANSIENT" &&
    approach.strategyAction === "RETRY_PROVIDER" &&
    approach.playbookStage === null &&
    signal.state === "AVAILABLE" &&
    !signal.confirmationStarted &&
    admission.signalDigest === signal.signalDigest &&
    admission.sourceRecordDigest === signal.recordDigest &&
    admission.sourceBatchIncidentDigest === signal.sourceBatchIncidentDigest &&
    admittedAt.getTime() >= eligibleAt.getTime() &&
    admittedAt.getTime() >= batch.createdAt.getTime() &&
    admittedAt.getTime() <= now.getTime() &&
    batch.status === "VERIFYING" &&
    batch.completedAt === null &&
    batch.releaseSha === request.releaseSha &&
    batch.providerFamilyKey === signal.providerFamilyKey &&
    batch.failureFingerprint === signal.canonicalFailureFingerprint &&
    incident.status === "AUTO_INVESTIGATING" &&
    incident.activeBatchId === batch.id &&
    incident.cycle === request.batchIncident.cycle &&
    hasAuthenticatedDeferredIncidentRevision(request, now) &&
    incident.providerFamilyKey === signal.providerFamilyKey &&
    incident.failureFingerprint === signal.canonicalFailureFingerprint &&
    request.batchIncident.courseId === request.courseId &&
    request.batchIncident.result === "PENDING" &&
    request.batchIncident.proofSnapshot === null &&
    request.batchIncident.verifiedAt === null &&
    (executionState === "UNSTARTED"
      ? request.startedAt === null &&
        request.discoveryAttemptedAt === null &&
        request.discoveryVerifiedAt === null
      : request.startedAt instanceof Date &&
        request.startedAt.getTime() <= now.getTime()) &&
    attempt.providerSnapshotFingerprint ===
      signal.claimedProviderSnapshotFingerprint &&
    attempt.failureFingerprint === signal.canonicalFailureFingerprint &&
    attempt.runtimeVersion === request.releaseSha &&
    attempt.playbookEventCountAtClaim === playbookEventCount &&
    signal.claimedProviderSnapshotFingerprint ===
      signal.observedProviderSnapshotFingerprint &&
    signal.claimedProviderSnapshotFingerprint ===
      request.providerSnapshotFingerprint &&
    signal.claimedProviderSnapshotFingerprint ===
      provider.providerSnapshotFingerprint &&
    provider.providerFamilyKeySnapshot === signal.providerFamilyKey &&
    normalizeProviderFamilyKey(request.course.providerFamilyKey) ===
      signal.providerFamilyKey &&
    playbook.valid === true &&
    playbook.cycle === incident.cycle &&
    playbook.conclusion === "UNRESOLVED_EXHAUSTED" &&
    playbook.nextStage === null,
  );
  return valid ? { signal, admission } : null;
}

function hasAuthenticatedDeferredIncidentRevision(
  request: VerificationExecutionRow,
  now: Date,
) {
  const incident = request.batchIncident.incident;
  const verifiedIncidentUpdatedAt =
    request.batchIncident.verifiedIncidentUpdatedAt;
  if (
    !verifiedIncidentUpdatedAt ||
    !Number.isInteger(incident.revision) ||
    incident.revision < 0
  ) {
    return false;
  }
  return (
    Number.isFinite(verifiedIncidentUpdatedAt.getTime()) &&
    Number.isFinite(incident.updatedAt.getTime()) &&
    verifiedIncidentUpdatedAt.getTime() <= incident.updatedAt.getTime() &&
    incident.updatedAt.getTime() <= now.getTime()
  );
}

function isDeferredFailureConfirmationRouteClaimed(
  request: VerificationExecutionRow,
) {
  if (hasDeferredFailureConfirmationShadow(request)) return true;

  const summary = asJsonRecord(request.batchIncident.batch.summary);
  const remediation = asJsonRecord(summary.remediation);
  if (!Array.isArray(remediation.attempts)) return false;
  const courseRef = createHash("sha256")
    .update(request.courseId)
    .digest("hex")
    .slice(0, 24);
  const matchingAttempts = remediation.attempts.filter(
    (candidate) => asJsonRecord(candidate).courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return false;
  const approach = asJsonRecord(asJsonRecord(matchingAttempts[0]).approach);
  const playbook = assessAutomationPlaybook(
    request.batchIncident.incident.attemptLedger,
    request.batchIncident.incident.cycle,
  );
  return Boolean(
    Array.isArray(summary.plannedPaths) &&
    summary.plannedPaths.length === 0 &&
    remediation.workMode === "VERIFY_TRANSIENT" &&
    remediation.strategyAction === "RETRY_PROVIDER" &&
    remediation.playbookStage === null &&
    remediation.allowUnchangedRuntime === true &&
    remediation.requiresImplementationPath === false &&
    remediation.retryBudget === null &&
    remediation.reason === "MATERIAL_CHANGE_REOPENED" &&
    approach.workMode === "VERIFY_TRANSIENT" &&
    approach.strategyAction === "RETRY_PROVIDER" &&
    approach.playbookStage === null &&
    playbook.valid === true &&
    playbook.cycle === request.batchIncident.incident.cycle &&
    playbook.conclusion === "UNRESOLVED_EXHAUSTED" &&
    playbook.nextStage === null,
  );
}

function deferredFailureConfirmationRejectionReason(
  request: VerificationExecutionRow,
  provider: ReturnType<typeof buildProviderSnapshot>,
): CourseSupportVerificationRejectionReason {
  return provider.providerSnapshotFingerprint !==
    request.providerSnapshotFingerprint
    ? "provider_snapshot_changed"
    : "invalid_evidence";
}

function hasDeferredFailureConfirmationShadow(
  request: VerificationExecutionRow,
) {
  const summary = asJsonRecord(request.batchIncident.batch.summary);
  const remediation = asJsonRecord(summary.remediation);
  if (!Array.isArray(remediation.attempts)) return false;
  const courseRef = createHash("sha256")
    .update(request.courseId)
    .digest("hex")
    .slice(0, 24);
  return remediation.attempts.some((candidate) => {
    const attempt = asJsonRecord(candidate);
    return (
      attempt.courseRef === courseRef &&
      (Object.prototype.hasOwnProperty.call(
        attempt,
        "deferredFailureHandoffSource",
      ) ||
        Object.prototype.hasOwnProperty.call(
          attempt,
          "deferredFailureHandoffAdmission",
        ))
    );
  });
}

function getCloseoutDeferredFailureAttempt(summary: unknown, courseId: string) {
  const closeout = asJsonRecord(asJsonRecord(summary).closeout);
  if (!Array.isArray(closeout.remediationAttempts)) return null;
  const courseRef = createHash("sha256")
    .update(courseId)
    .digest("hex")
    .slice(0, 24);
  const matching = closeout.remediationAttempts.filter(
    (candidate) => asJsonRecord(candidate).courseRef === courseRef,
  );
  return matching.length === 1 ? asJsonRecord(matching[0]) : null;
}

function hasExactZeroExecutionCarrierEvidence(
  attempt: Record<string, unknown>,
) {
  const executionEvidence = asJsonRecord(attempt.executionEvidence);
  const keys = [
    "claimedImplementationPaths",
    "newReleaseRecorded",
    "deploymentRecorded",
    "postProbeRecorded",
    "providerAttemptRecorded",
    "providerExecutionAttemptRecorded",
    "playbookAttemptRecorded",
    "terminalResultRecorded",
    "providerExecutionStarted",
  ];
  return (
    Object.keys(executionEvidence).length === keys.length &&
    keys.every((key) => executionEvidence[key] === false) &&
    attempt.consumed === false &&
    attempt.countsTowardOperationalNoProgress === false
  );
}

async function getDeferredFailureConfirmationFactualProbeFloor(input: {
  transaction: Prisma.TransactionClient;
  request: VerificationExecutionRow;
  signal: DeferredFailureHandoffSignal;
  now: Date;
}) {
  const sources = await input.transaction.courseSupportBatchIncident.findMany({
    where: {
      incidentId: input.request.batchIncident.incidentId,
      courseId: input.request.courseId,
      cycle: input.request.batchIncident.cycle,
      batch: { completedAt: { not: null } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      batchId: true,
      incidentId: true,
      courseId: true,
      cycle: true,
      result: true,
      proofSnapshot: true,
      createdAt: true,
      updatedAt: true,
      verificationRequests: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          batchIncidentId: true,
          releaseSha: true,
          runtimeVersion: true,
          status: true,
          attemptCount: true,
          startedAt: true,
          discoveryAttemptedAt: true,
          discoveryVerifiedAt: true,
          outcome: true,
          failureClass: true,
          evidence: true,
          providerSnapshotFingerprint: true,
          nextAttemptAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      batch: {
        select: {
          id: true,
          status: true,
          providerFamilyKey: true,
          failureFingerprint: true,
          baseSha: true,
          releaseSha: true,
          summary: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });
  const matchingSources = sources.filter(
    (source) =>
      createDeferredFailureHandoffBatchIncidentDigest(source.id) ===
      input.signal.sourceBatchIncidentDigest,
  );
  if (matchingSources.length !== 1) return null;
  const source = matchingSources[0];
  const completedAt = source.batch.completedAt;
  const effectiveRuntime = source.batch.releaseSha ?? source.batch.baseSha;
  if (
    !completedAt ||
    source.batchId !== source.batch.id ||
    source.incidentId !== input.request.batchIncident.incidentId ||
    source.courseId !== input.request.courseId ||
    source.cycle !== input.request.batchIncident.cycle ||
    source.batch.providerFamilyKey !== input.signal.providerFamilyKey ||
    source.batch.failureFingerprint !==
      input.signal.canonicalFailureFingerprint ||
    source.batch.createdAt.getTime() > source.createdAt.getTime() ||
    source.createdAt.getTime() > source.updatedAt.getTime() ||
    source.updatedAt.getTime() > completedAt.getTime() ||
    completedAt.getTime() > input.now.getTime()
  ) {
    return null;
  }

  const attempt = getCloseoutDeferredFailureAttempt(
    source.batch.summary,
    input.request.courseId,
  );
  const sourceSignal = parseDeferredFailureHandoffSignal(
    attempt?.deferredFailureHandoff,
  );
  const sourceAdmission = parseDeferredFailureHandoffAdmission(
    attempt?.deferredFailureHandoffAdmission,
  );
  const requestsAtRuntime = source.verificationRequests.filter(
    (request) => request.releaseSha === effectiveRuntime,
  );
  const sourceRequest = requestsAtRuntime[0];
  const exactCarrierRequestState =
    source.verificationRequests.length === 0 ||
    Boolean(
      source.verificationRequests.length === 1 &&
      requestsAtRuntime.length === 1 &&
      sourceRequest &&
      sourceRequest.batchIncidentId === source.id &&
      sourceRequest.providerSnapshotFingerprint ===
        input.signal.claimedProviderSnapshotFingerprint &&
      (sourceRequest.runtimeVersion === null ||
        sourceRequest.runtimeVersion === effectiveRuntime) &&
      ["QUEUED", "CHECKING", "RETRYABLE_FAILED", "STALE"].includes(
        sourceRequest.status,
      ) &&
      sourceRequest.startedAt === null &&
      sourceRequest.discoveryAttemptedAt === null &&
      sourceRequest.discoveryVerifiedAt === null &&
      sourceRequest.createdAt.getTime() <= sourceRequest.updatedAt.getTime() &&
      sourceRequest.updatedAt.getTime() <= completedAt.getTime(),
    );

  const exactUnstartedCarrier = Boolean(
    attempt &&
    sourceSignal &&
    sourceAdmission &&
    sourceSignal.recordDigest === input.signal.recordDigest &&
    sourceSignal.signalDigest === input.signal.signalDigest &&
    sourceSignal.state === "AVAILABLE" &&
    !sourceSignal.confirmationStarted &&
    sourceAdmission.signalDigest === sourceSignal.signalDigest &&
    sourceAdmission.sourceRecordDigest === sourceSignal.recordDigest &&
    sourceAdmission.sourceBatchIncidentDigest ===
      sourceSignal.sourceBatchIncidentDigest &&
    new Date(sourceAdmission.admittedAt).getTime() >=
      source.batch.createdAt.getTime() &&
    new Date(sourceAdmission.admittedAt).getTime() <= completedAt.getTime() &&
    source.batch.status === "RETRYABLE_FAILED" &&
    source.result === "RETRY_SCHEDULED" &&
    attempt.runtimeVersion === effectiveRuntime &&
    attempt.failureFingerprint === input.signal.canonicalFailureFingerprint &&
    attempt.providerSnapshotFingerprint ===
      input.signal.claimedProviderSnapshotFingerprint &&
    hasExactZeroExecutionCarrierEvidence(attempt) &&
    exactCarrierRequestState,
  );
  if (exactUnstartedCarrier) {
    return source.batch.createdAt;
  }

  const proof = asJsonRecord(source.proofSnapshot);
  const proofObservedAt =
    typeof proof.observedAt === "string" ? new Date(proof.observedAt) : null;
  const proofCompletedAt =
    proof.completedAt === null || typeof proof.completedAt === "string"
      ? (proof.completedAt as string | null)
      : undefined;
  const proofNextAttemptAt =
    proof.nextAttemptAt === null || typeof proof.nextAttemptAt === "string"
      ? (proof.nextAttemptAt as string | null)
      : undefined;
  const proofProviderRetryNotBeforeAt =
    proof.providerRetryNotBeforeAt === null ||
    typeof proof.providerRetryNotBeforeAt === "string"
      ? (proof.providerRetryNotBeforeAt as string | null)
      : undefined;
  const sourceEvidence = asJsonRecord(sourceRequest?.evidence);
  const initialStatusMatches =
    input.signal.sourceResult === "RETRY_SCHEDULED"
      ? source.batch.status === "RETRYABLE_FAILED" &&
        source.result === "RETRY_SCHEDULED"
      : source.batch.status === "PARTIAL" && source.result === "NEEDS_HUMAN";
  const modernInitialSignalMatches =
    input.signal.sourceResult === "NEEDS_HUMAN" ||
    Boolean(
      attempt &&
      sourceSignal &&
      attempt.deferredFailureHandoffAdmission === undefined &&
      sourceSignal.recordDigest === input.signal.recordDigest &&
      sourceSignal.signalDigest === input.signal.signalDigest,
    );
  const exactInitialSource = Boolean(
    initialStatusMatches &&
    modernInitialSignalMatches &&
    proofObservedAt &&
    Number.isFinite(proofObservedAt.getTime()) &&
    proofObservedAt.toISOString() === proof.observedAt &&
    proofObservedAt.getTime() <= completedAt.getTime() &&
    proof.kind === "PROVIDER_VERIFICATION_FAILURE" &&
    (proof.status === "RETRYABLE_FAILED" || proof.status === "STALE") &&
    proof.outcome === "FETCH_FAILED" &&
    typeof proof.failureClass === "string" &&
    proof.providerExecution === false &&
    proof.runtimeVersion === input.signal.runtimeVersion &&
    proof.providerSnapshotFingerprint ===
      input.signal.claimedProviderSnapshotFingerprint &&
    proofCompletedAt !== undefined &&
    proofNextAttemptAt !== undefined &&
    proofProviderRetryNotBeforeAt !== undefined &&
    createDeferredFailureHandoffSourceProofDigest({
      kind: "PROVIDER_VERIFICATION_FAILURE",
      status: proof.status as string,
      outcome: "FETCH_FAILED",
      failureClass: proof.failureClass as string,
      observedAt: proof.observedAt as string,
      runtimeVersion: proof.runtimeVersion as string,
      providerExecution: false,
      providerSnapshotFingerprint: proof.providerSnapshotFingerprint as string,
      completedAt: proofCompletedAt,
      nextAttemptAt: proofNextAttemptAt,
      providerRetryNotBeforeAt: proofProviderRetryNotBeforeAt,
    }) === input.signal.sourceProofDigest &&
    requestsAtRuntime.length === 1 &&
    sourceRequest &&
    sourceRequest.batchIncidentId === source.id &&
    sourceRequest.runtimeVersion === effectiveRuntime &&
    sourceRequest.status === proof.status &&
    sourceRequest.outcome === proof.outcome &&
    sourceRequest.failureClass === proof.failureClass &&
    sourceRequest.providerSnapshotFingerprint ===
      input.signal.claimedProviderSnapshotFingerprint &&
    sourceRequest.startedAt instanceof Date &&
    sourceRequest.createdAt.getTime() <= sourceRequest.startedAt.getTime() &&
    sourceRequest.startedAt.getTime() <= proofObservedAt.getTime() &&
    sourceRequest.startedAt.getTime() <= sourceRequest.updatedAt.getTime() &&
    proofObservedAt.getTime() <= sourceRequest.updatedAt.getTime() &&
    sourceRequest.updatedAt.getTime() <= completedAt.getTime() &&
    (sourceRequest.nextAttemptAt?.toISOString() ?? null) ===
      proofNextAttemptAt &&
    (sourceRequest.completedAt?.toISOString() ?? null) === proofCompletedAt &&
    sourceEvidence.kind === "PROVIDER_VERIFICATION" &&
    sourceEvidence.releaseSha === effectiveRuntime &&
    sourceEvidence.runtimeVersion === effectiveRuntime &&
    sourceEvidence.observedAt === proof.observedAt &&
    sourceEvidence.outcome === proof.outcome &&
    sourceEvidence.failureClass === proof.failureClass &&
    sourceEvidence.providerExecution === false &&
    sourceEvidence.providerFamilyKey === input.signal.providerFamilyKey &&
    sourceEvidence.providerSnapshotFingerprint ===
      input.signal.claimedProviderSnapshotFingerprint &&
    (sourceEvidence.providerRetryNotBeforeAt ?? null) ===
      proofProviderRetryNotBeforeAt,
  );
  return exactInitialSource ? proofObservedAt : null;
}

async function validateDeferredFailureConfirmationCurrentState(input: {
  transaction: Prisma.TransactionClient;
  request: VerificationExecutionRow;
  provider: ReturnType<typeof buildProviderSnapshot>;
  signal: DeferredFailureHandoffSignal;
  now: Date;
}): Promise<
  | { valid: true; factualProbeFloor: Date }
  | { valid: false; reason: CourseSupportVerificationRejectionReason }
> {
  if (
    input.provider.providerSnapshotFingerprint !==
      input.signal.claimedProviderSnapshotFingerprint ||
    input.provider.providerSnapshotFingerprint !==
      input.signal.observedProviderSnapshotFingerprint ||
    input.provider.providerSnapshotFingerprint !==
      input.request.providerSnapshotFingerprint ||
    input.provider.providerFamilyKeySnapshot !==
      input.signal.providerFamilyKey ||
    normalizeProviderFamilyKey(input.request.course.providerFamilyKey) !==
      input.signal.providerFamilyKey
  ) {
    return { valid: false, reason: "provider_snapshot_changed" };
  }
  const gate = evaluateMonitoringGate({
    ...input.request.course,
    now: input.now,
  });
  if (
    input.request.course.monitoringMode === "LOCAL_READER_ONLY" ||
    gate.disposition !== "ACTIONABLE" ||
    gate.adapterAllowed !== true
  ) {
    return { valid: false, reason: "monitoring_not_actionable" };
  }
  const factualProbeFloor =
    await getDeferredFailureConfirmationFactualProbeFloor(input);
  if (!factualProbeFloor) {
    return { valid: false, reason: "invalid_evidence" };
  }
  const [monitoringStatus, newestProbes] = await Promise.all([
    input.transaction.courseMonitoringStatus.findUnique({
      where: { courseId: input.request.courseId },
      select: {
        state: true,
        failureFingerprint: true,
        stateChangedAt: true,
        lastSuccessfulAt: true,
        revision: true,
        updatedAt: true,
      },
    }),
    input.transaction.courseProbe.findMany({
      where: {
        courseId: input.request.courseId,
        observedAt: { lte: input.now },
      },
      orderBy: [{ observedAt: "desc" }, { id: "desc" }],
      take: 2,
      select: { id: true, outcome: true, observedAt: true },
    }),
  ]);
  if (
    !monitoringStatus ||
    monitoringStatus.state !== "AUTO_INVESTIGATING" ||
    monitoringStatus.failureFingerprint !==
      input.signal.canonicalFailureFingerprint
  ) {
    return { valid: false, reason: "monitoring_not_actionable" };
  }
  if (
    monitoringStatus.lastSuccessfulAt &&
    monitoringStatus.lastSuccessfulAt.getTime() >= factualProbeFloor.getTime()
  ) {
    return { valid: false, reason: "monitoring_not_actionable" };
  }
  if (
    newestProbes[0] &&
    newestProbes[1] &&
    newestProbes[0].observedAt.getTime() ===
      newestProbes[1].observedAt.getTime()
  ) {
    return { valid: false, reason: "invalid_evidence" };
  }
  if (
    newestProbes[0] &&
    SUCCESSFUL_PROBE_OUTCOMES.has(newestProbes[0].outcome) &&
    newestProbes[0].observedAt.getTime() >= factualProbeFloor.getTime()
  ) {
    return { valid: false, reason: "monitoring_not_actionable" };
  }
  const incident = input.request.batchIncident.incident;
  const incidentFenced =
    await input.transaction.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        cycle: incident.cycle,
        providerFamilyKey: incident.providerFamilyKey,
        failureFingerprint: incident.failureFingerprint,
        activeBatchId: incident.activeBatchId,
        engineeringOnly: incident.engineeringOnly,
        status: incident.status,
        revision: incident.revision,
        updatedAt: incident.updatedAt,
      },
      data: {
        revision: incident.revision,
        updatedAt: incident.updatedAt,
      },
    });
  if (incidentFenced.count !== 1) {
    return { valid: false, reason: "incident_demand_changed" };
  }
  const fenced = await input.transaction.courseMonitoringStatus.updateMany({
    where: {
      courseId: input.request.courseId,
      state: monitoringStatus.state,
      failureFingerprint: monitoringStatus.failureFingerprint,
      stateChangedAt: monitoringStatus.stateChangedAt,
      lastSuccessfulAt: monitoringStatus.lastSuccessfulAt,
      revision: monitoringStatus.revision,
      updatedAt: monitoringStatus.updatedAt,
    },
    data: { updatedAt: monitoringStatus.updatedAt },
  });
  return fenced.count === 1
    ? { valid: true, factualProbeFloor }
    : { valid: false, reason: "lease_lost" };
}

type DetachedEligibilityInput = {
  batchId: string;
  batchStatus: string;
  batchReleaseSha: string | null;
  batchCompletedAt: Date | null;
  batchSummary: Prisma.JsonValue | null;
  batchIncidentCourseId: string;
  batchIncidentId: string;
  batchIncidentIncidentId: string;
  batchIncidentCycle: number;
  batchIncidentVerifiedIncidentUpdatedAt: Date | null;
  courseId: string;
  course: ProviderCourseSnapshot;
  releaseSha: string;
  incident: {
    id: string;
    cycle: number;
    activeBatchId: string | null;
    engineeringOnly: boolean;
    activeRealSearchCount: number;
    earliestTargetDate: Date | null;
    firstSeenAt: Date;
    attemptLedger: Prisma.JsonValue | null;
    revision: number;
    updatedAt: Date;
    status: string;
  };
};

type DetachedEligibilityAuthority =
  | {
      kind: "VALIDATED_CHECKING";
      request: VerificationExecutionRow;
    }
  | {
      kind: "RECLAIMABLE_REQUEST";
      request: VerificationExecutionRow;
    }
  | {
      kind: "DURABLE_RESULT";
      request: VerificationExecutionRow;
    };

function buildDetachedEligibilityInput(input: {
  batch: {
    id: string;
    status: string;
    releaseSha: string | null;
    completedAt: Date | null;
    summary: Prisma.JsonValue | null;
  };
  batchIncident: {
    id: string;
    incidentId: string;
    courseId: string;
    cycle: number;
    verifiedIncidentUpdatedAt: Date | null;
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
    batchSummary: input.batch.summary,
    batchIncidentId: input.batchIncident.id,
    batchIncidentIncidentId: input.batchIncident.incidentId,
    batchIncidentCourseId: input.batchIncident.courseId,
    batchIncidentCycle: input.batchIncident.cycle,
    batchIncidentVerifiedIncidentUpdatedAt:
      input.batchIncident.verifiedIncidentUpdatedAt,
    courseId: input.courseId,
    course: input.course,
    releaseSha: input.releaseSha,
    incident: input.batchIncident.incident,
  };
}

function buildDetachedEligibilityInputFromRequest(
  request: VerificationExecutionRow,
): DetachedEligibilityInput {
  return buildDetachedEligibilityInput({
    batch: request.batchIncident.batch,
    batchIncident: request.batchIncident,
    courseId: request.courseId,
    course: request.course,
    releaseSha: request.releaseSha,
  });
}

async function evaluateDetachedEligibility(
  transaction: Prisma.TransactionClient,
  input: DetachedEligibilityInput,
  now: Date,
  mode: "PROGRESSION" | "PROOF" = "PROOF",
  authority?: DetachedEligibilityAuthority,
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
  if (input.incident.status !== "AUTO_INVESTIGATING") {
    return { eligible: false, reason: "incident_resolved" };
  }
  if (
    getCurrentCourseSupportFactualFinalEvent({
      attemptLedger: input.incident.attemptLedger,
      cycle: input.incident.cycle,
      firstSeenAt: input.incident.firstSeenAt,
      runtimeVersion: input.releaseSha,
      now,
    })
  ) {
    return { eligible: true };
  }
  const assignedDetachedStageProgression = isAssignedDetachedProgression(input);
  const ownedAssignedLocalReaderProgression =
    hasOwnedAssignedLocalReaderProgression(input, authority, now);
  const monitoringGate = evaluateMonitoringGate({ ...input.course, now });
  const assignedTechnicalFinalProgression = Boolean(
    monitoringGate.disposition === "TECHNICAL_FINAL" &&
    (assignedDetachedStageProgression || ownedAssignedLocalReaderProgression),
  );
  if (
    monitoringGate.disposition !== "ACTIONABLE" &&
    !assignedTechnicalFinalProgression
  ) {
    return { eligible: false, reason: "monitoring_not_actionable" };
  }
  const activeFuturePairs = await transaction.teeSearch.count({
    where: {
      status: "ACTIVE",
      date: {
        gte: getCourseLocalDateStorageBoundary(input.course.timeZone, now),
      },
      preferences: { some: { courseId: input.courseId } },
    },
  });
  if (activeFuturePairs > 0) {
    return mode === "PROGRESSION"
      ? { eligible: true }
      : { eligible: false, reason: "active_demand" };
  }
  if (
    input.incident.activeRealSearchCount === 0 &&
    input.incident.earliestTargetDate === null
  ) {
    return { eligible: true };
  }

  const reconciledAt = now;
  const incidentUpdated = await transaction.courseSupportIncident.updateMany({
    where: {
      id: input.incident.id,
      cycle: input.incident.cycle,
      activeBatchId: input.batchId,
      status: "AUTO_INVESTIGATING",
      updatedAt: input.incident.updatedAt,
      activeRealSearchCount: input.incident.activeRealSearchCount,
      earliestTargetDate: input.incident.earliestTargetDate,
    },
    data: {
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      updatedAt: reconciledAt,
    },
  });
  if (incidentUpdated.count !== 1) {
    return { eligible: false, reason: "incident_demand_changed" };
  }
  const batchIncidentUpdated =
    await transaction.courseSupportBatchIncident.updateMany({
      where: {
        id: input.batchIncidentId,
        batchId: input.batchId,
        incidentId: input.batchIncidentIncidentId,
        cycle: input.batchIncidentCycle,
        verifiedIncidentUpdatedAt: input.batchIncidentVerifiedIncidentUpdatedAt,
      },
      data: { verifiedIncidentUpdatedAt: reconciledAt },
    });
  if (batchIncidentUpdated.count !== 1) {
    throw new Error(
      "Course-support demand changed while detached verification was scheduled.",
    );
  }
  input.incident.activeRealSearchCount = 0;
  input.incident.earliestTargetDate = null;
  input.incident.updatedAt = reconciledAt;
  input.batchIncidentVerifiedIncidentUpdatedAt = reconciledAt;
  return { eligible: true };
}

function isAssignedDetachedProgression(input: DetachedEligibilityInput) {
  const remediation = asJsonRecord(
    asJsonRecord(input.batchSummary).remediation,
  );
  const playbook = assessAutomationPlaybook(
    input.incident.attemptLedger,
    input.incident.cycle,
  );
  const nextStageAssessment = playbook.stages.find(
    (stage) => stage.stage === playbook.nextStage,
  );
  const assigned = isAssignedDetachedStageProgression({
    remediationDirective: remediation,
    playbookConclusion: playbook.conclusion,
    nextPlaybookStage: playbook.nextStage,
    nextPlaybookStageStatus: nextStageAssessment?.status,
    nextPlaybookStageAttemptCount: nextStageAssessment?.attemptCount,
  });
  return Boolean(
    playbook.valid === true &&
    playbook.cycle === input.incident.cycle &&
    assigned &&
    (playbook.nextStage !== "BROWSER_ADAPTER_RETRY" ||
      !resolveProviderCapability(input.course).isRunnable),
  );
}

const SIGNED_LOCAL_READER_RESULT_TRANSITIONS = new Set<
  AutomationPlaybookEvent["transition"]
>(["FAILED_TERMINAL", "SUCCEEDED", "TECHNICAL_LIMITATION"]);

function hasOwnedDetachedLifecycleRuntime(
  event: AutomationPlaybookEvent,
  releaseSha: string,
) {
  if (event.runtimeVersion === releaseSha) return true;

  // Parsed ledgers already enforce the bounded runtime-version schema. Only
  // result-bearing transitions written from a validated signed-reader result
  // carry the reader's semantic version instead of the owning release SHA.
  return Boolean(
    event.stage === "LOCAL_READER" &&
      event.evidenceKind === "LOCAL_READER_RESULT" &&
      SIGNED_LOCAL_READER_RESULT_TRANSITIONS.has(event.transition),
  );
}

function hasOwnedAssignedLocalReaderProgression(
  input: DetachedEligibilityInput,
  authority: DetachedEligibilityAuthority | undefined,
  now: Date,
) {
  if (!authority) return false;
  const request = authority.request;
  const remediation = asJsonRecord(
    asJsonRecord(input.batchSummary).remediation,
  );
  if (
    !isExactAssignedDetachedStageDirective({
      remediationDirective: remediation,
      stage: "LOCAL_READER",
    }) ||
    request.batchIncidentId !== input.batchIncidentId ||
    request.batchIncident.id !== input.batchIncidentId ||
    request.batchIncident.incidentId !== input.batchIncidentIncidentId ||
    request.batchIncident.incident.id !== input.batchIncidentIncidentId ||
    request.batchIncident.courseId !== input.courseId ||
    request.courseId !== input.courseId ||
    request.batchIncident.cycle !== input.batchIncidentCycle ||
    request.batchIncident.incident.cycle !== input.incident.cycle ||
    request.batchIncident.batch.id !== input.batchId ||
    request.batchIncident.incident.activeBatchId !== input.batchId ||
    request.releaseSha !== input.releaseSha ||
    request.runtimeVersion !== input.releaseSha ||
    request.batchIncident.batch.releaseSha !== input.releaseSha ||
    request.createdAt.getTime() <
      request.batchIncident.batch.createdAt.getTime() ||
    request.createdAt.getTime() > now.getTime() ||
    request.updatedAt.getTime() < request.createdAt.getTime() ||
    request.updatedAt.getTime() > now.getTime()
  ) {
    return false;
  }

  if (authority.kind === "VALIDATED_CHECKING") {
    if (
      request.status !== "CHECKING" ||
      !request.leaseToken ||
      !request.leaseExpiresAt ||
      request.leaseExpiresAt.getTime() <= now.getTime() ||
      isRequestHorizonExpired(request, now)
    ) {
      return false;
    }
  } else if (authority.kind === "RECLAIMABLE_REQUEST") {
    if (
      (request.status !== "RETRYABLE_FAILED" &&
        request.status !== "CHECKING") ||
      !isDueForClaim(request, now) ||
      isRequestHorizonExpired(request, now)
    ) {
      return false;
    }
  } else {
    if (
      !request.startedAt ||
      request.startedAt.getTime() < request.createdAt.getTime() ||
      request.startedAt.getTime() > now.getTime() ||
      (request.status !== "SUCCEEDED" &&
        request.status !== "RETRYABLE_FAILED" &&
        request.status !== "STALE")
    ) {
      return false;
    }
    if (request.status === "RETRYABLE_FAILED") {
      if (
        request.completedAt !== null ||
        !request.nextAttemptAt ||
        request.nextAttemptAt.getTime() >=
          getVerificationDeadline(request).getTime()
      ) {
        return false;
      }
    } else if (
      !request.completedAt ||
      request.completedAt.getTime() < request.startedAt.getTime() ||
      request.completedAt.getTime() > now.getTime() ||
      request.completedAt.getTime() > getVerificationDeadline(request).getTime()
    ) {
      return false;
    }
  }

  const playbook = assessAutomationPlaybook(
    input.incident.attemptLedger,
    input.incident.cycle,
  );
  const localReader = playbook.stages.find(
    (stage) => stage.stage === "LOCAL_READER",
  );
  if (
    !playbook.valid ||
    playbook.cycle !== input.incident.cycle ||
    !localReader ||
    ![
      "STARTED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
      "NOT_APPLICABLE",
      "COMPLETED",
      "SUCCEEDED",
      "TECHNICAL_LIMITATION",
    ].includes(localReader.status) ||
    (localReader.status === "NOT_APPLICABLE"
      ? localReader.attemptCount !== 0
      : localReader.attemptCount <= 0)
  ) {
    return false;
  }

  const ledger = parseAutomationPlaybookLedger(input.incident.attemptLedger);
  if (!ledger) return false;
  const lifecycleEvents = ledger.events.filter(
    (event) =>
      event.cycle === input.incident.cycle &&
      (event.stage === "LOCAL_READER" ||
        event.stage === "INDEPENDENT_CONFIRMATION"),
  );
  const ownedLocalReaderTransitions = new Set([
    "STARTED",
    "FAILED_RETRYABLE",
    "FAILED_TERMINAL",
    "NOT_APPLICABLE",
    "COMPLETED",
    "SUCCEEDED",
    "TECHNICAL_LIMITATION",
  ]);
  const findFirstOwnedEventIndex = (eventFloor: Date, notAfter?: Date) =>
    lifecycleEvents.findIndex((event) => {
      const observedAt = Date.parse(event.observedAt);
      return (
        event.stage === "LOCAL_READER" &&
        ownedLocalReaderTransitions.has(event.transition) &&
        hasOwnedDetachedLifecycleRuntime(event, input.releaseSha) &&
        Number.isFinite(observedAt) &&
        observedAt >= eventFloor.getTime() &&
        (!notAfter || observedAt <= notAfter.getTime())
      );
    });
  let eventFloor = request.startedAt ?? request.createdAt;
  let firstOwnedEventIndex = findFirstOwnedEventIndex(eventFloor);
  if (firstOwnedEventIndex < 0 && request.startedAt) {
    // A direct reader result can be durably recorded immediately before the
    // first provider attachment persists startedAt. Prefer post-start events,
    // but retain that exact owned, post-creation handoff when needed.
    eventFloor = request.createdAt;
    firstOwnedEventIndex = findFirstOwnedEventIndex(
      eventFloor,
      request.startedAt,
    );
  }
  if (firstOwnedEventIndex < 0) return false;

  const lifecycleUpperBound =
    authority.kind === "DURABLE_RESULT" && request.completedAt
      ? request.completedAt.getTime()
      : now.getTime();
  let previousObservedAt = eventFloor.getTime();
  return lifecycleEvents.slice(firstOwnedEventIndex).every((event) => {
    const observedAt = Date.parse(event.observedAt);
    const current = Boolean(
      hasOwnedDetachedLifecycleRuntime(event, input.releaseSha) &&
      Number.isFinite(observedAt) &&
      observedAt >= previousObservedAt &&
      observedAt <= lifecycleUpperBound,
    );
    previousObservedAt = observedAt;
    return current;
  });
}

function validateExecutionOwnership(
  request: VerificationExecutionRow | null,
  input: {
    expectedRevision: number;
    leaseToken: string;
    runtimeVersion: string;
  },
  now: Date,
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
  now: Date,
) {
  return {
    id: input.requestId,
    revision: input.expectedRevision,
    status: "CHECKING" as const,
    releaseSha: input.runtimeVersion,
    runtimeVersion: input.runtimeVersion,
    leaseToken: input.leaseToken,
    leaseExpiresAt: { gt: now },
    deadlineAt: { gt: now },
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
      request.leaseExpiresAt.getTime() <= now.getTime(),
    )
  );
}

function isRequestHorizonExpired(
  request: Pick<VerificationExecutionRow, "deadlineAt" | "createdAt">,
  now: Date,
) {
  return now.getTime() >= getVerificationDeadline(request).getTime();
}

function getVerificationDeadline(
  request: Pick<VerificationExecutionRow, "deadlineAt" | "createdAt">,
) {
  return (
    request.deadlineAt ??
    new Date(
      request.createdAt.getTime() +
        COURSE_SUPPORT_VERIFICATION_LEGACY_HORIZON_MS,
    )
  );
}

function claimableStatePredicate(now: Date, allowMismatchGraceClaim = false) {
  return [
    { status: "QUEUED" as const, nextAttemptAt: { lte: now } },
    { status: "RETRYABLE_FAILED" as const, nextAttemptAt: { lte: now } },
    { status: "CHECKING" as const, leaseExpiresAt: { lte: now } },
    ...(allowMismatchGraceClaim
      ? [
          {
            status: {
              in: ["QUEUED" as const, "RETRYABLE_FAILED" as const],
            },
            lastError: {
              startsWith:
                COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX,
            },
          },
        ]
      : []),
  ];
}

function isRuntimeMismatchGraceRequest(
  request: Pick<VerificationExecutionRow, "status" | "lastError">,
) {
  return (
    (request.status === "QUEUED" || request.status === "RETRYABLE_FAILED") &&
    getRuntimeMismatchMarkedAt(request.lastError) !== null
  );
}

function getRuntimeMismatchMarkedAt(lastError: string | null) {
  if (
    !lastError?.startsWith(
      COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX,
    )
  ) {
    return null;
  }
  const markedAt = new Date(
    lastError.slice(
      COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX.length,
    ),
  );
  return Number.isFinite(markedAt.getTime()) ? markedAt : null;
}

async function deferRuntimeMismatch(
  transaction: Prisma.TransactionClient,
  request: Pick<
    VerificationExecutionRow,
    "id" | "revision" | "status" | "leaseToken" | "deadlineAt" | "createdAt"
  >,
  now: Date,
) {
  const nextAttemptAt = new Date(
    Math.min(
      now.getTime() + COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_GRACE_MS,
      getVerificationDeadline(request).getTime(),
    ),
  );
  const updated = await transaction.courseSupportVerificationRequest.updateMany(
    {
      where: {
        id: request.id,
        revision: request.revision,
        status: request.status,
        leaseToken: request.leaseToken,
        deadlineAt: { gt: now },
        OR: claimableStatePredicate(now),
      },
      data: {
        status: request.status === "CHECKING" ? "QUEUED" : request.status,
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        workflowRunId: null,
        nextAttemptAt,
        lastError: `${COURSE_SUPPORT_VERIFICATION_RUNTIME_MISMATCH_MARKER_PREFIX}${now.toISOString()}`,
        completedAt: null,
        updatedAt: now,
      },
    },
  );
  return updated.count === 1;
}

async function markRequestStale(
  transaction: Prisma.TransactionClient,
  request: Pick<
    VerificationExecutionRow,
    "id" | "revision" | "status" | "leaseToken"
  >,
  now: Date,
  reason: CourseSupportVerificationRejectionReason,
) {
  await transaction.courseSupportVerificationRequest.updateMany({
    where: {
      id: request.id,
      revision: request.revision,
      status: request.status,
      leaseToken: request.leaseToken,
    },
    data: {
      status: "STALE",
      revision: { increment: 1 },
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: null,
      lastError: reason,
      completedAt: now,
      updatedAt: now,
    },
  });
}

async function markRequestStaleIfNeeded(
  transaction: Prisma.TransactionClient,
  request: Pick<
    VerificationExecutionRow,
    "id" | "revision" | "status" | "leaseToken"
  >,
  now: Date,
  reason: CourseSupportVerificationRejectionReason,
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
  providerRetryNotBeforeAt: Date | null = null,
): Prisma.InputJsonObject {
  const observedAt = validDate(observation.observedAt, "observation time");
  if (
    observedAt.getTime() < now.getTime() - MAX_EVIDENCE_AGE_MS ||
    observedAt.getTime() > now.getTime() + MAX_EVIDENCE_FUTURE_SKEW_MS
  ) {
    throw new Error("Course-support verification evidence is not fresh.");
  }
  const availabilityCount = normalizeAvailabilityCount(
    observation.availabilityCount,
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
      "Runnable course-support verification outcomes require provider execution.",
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
    ...(message ? { message } : {}),
  };
}

export function getCourseSupportVerificationRequestDeadline(input: {
  now: Date;
  escalationDeadlineAt?: Date | null;
}) {
  const now = validDate(input.now, "verification request deadline base");
  const horizonAt = new Date(
    now.getTime() + COURSE_SUPPORT_VERIFICATION_REQUEST_HORIZON_MS,
  );
  if (!input.escalationDeadlineAt) {
    return horizonAt;
  }

  const endpointAt = validDate(
    input.escalationDeadlineAt,
    "course-support escalation deadline",
  );
  const endpointBoundAt = new Date(
    endpointAt.getTime() -
      COURSE_SUPPORT_VERIFICATION_ENDPOINT_DELIVERY_MARGIN_MS,
  );
  const deadlineAt =
    endpointBoundAt.getTime() < horizonAt.getTime()
      ? endpointBoundAt
      : horizonAt;
  return deadlineAt.getTime() > now.getTime() ? deadlineAt : null;
}

function getCurrentCourseSupportFactualFinalEvent(input: {
  attemptLedger: unknown;
  cycle: number;
  firstSeenAt: Date;
  runtimeVersion: string;
  disposition?: AutomationPlaybookFactualDisposition;
  notBefore?: Date;
  now: Date;
}) {
  const ledger = parseAutomationPlaybookLedger(input.attemptLedger);
  const assessment = assessAutomationPlaybook(ledger, input.cycle);
  if (
    !ledger ||
    !assessment.valid ||
    assessment.conclusion !== "FACTUAL_FINAL" ||
    !assessment.factualDisposition ||
    (input.disposition && assessment.factualDisposition !== input.disposition)
  ) {
    return null;
  }
  const event = [...ledger.events]
    .reverse()
    .find(
      (candidate) =>
        candidate.cycle === input.cycle &&
        candidate.transition === "FACTUAL_FINAL",
    );
  if (
    !event ||
    event.factualDisposition !== assessment.factualDisposition ||
    event.runtimeVersion !== input.runtimeVersion ||
    ![
      "OFFICIAL_IDENTITY",
      "RENDERED_BROWSER_DISCOVERY",
      "INDEPENDENT_CONFIRMATION",
    ].includes(event.stage) ||
    !["OFFICIAL_SOURCE", "RENDERED_PAGE"].includes(event.evidenceKind)
  ) {
    return null;
  }
  const observedAt = new Date(event.observedAt);
  if (
    !Number.isFinite(observedAt.getTime()) ||
    observedAt.getTime() < input.firstSeenAt.getTime() ||
    observedAt.getTime() <
      (input.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY) ||
    observedAt.getTime() > input.now.getTime() + MAX_EVIDENCE_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return event;
}

function buildCourseSupportFactualFinalProof(input: {
  event: AutomationPlaybookEvent;
  completedAt: Date;
  runtimeVersion: string;
}): CourseSupportFactualFinalProof {
  const disposition = input.event.factualDisposition;
  if (!disposition) {
    throw new Error(
      "A factual completion requires a factual playbook disposition.",
    );
  }
  return {
    schemaVersion: 1,
    kind: "PLAYBOOK_FACTUAL_FINAL",
    playbookVersion: AUTOMATION_PLAYBOOK_VERSION,
    disposition,
    outcome: factualOutcome(disposition),
    cycle: input.event.cycle,
    stage: input.event.stage as CourseSupportFactualFinalProof["stage"],
    sequence: input.event.sequence,
    readPath: input.event
      .readPath as CourseSupportFactualFinalProof["readPath"],
    evidenceKind: input.event
      .evidenceKind as CourseSupportFactualFinalProof["evidenceKind"],
    failureFingerprint: input.event.failureFingerprint,
    observedAt: input.event.observedAt,
    completedAt: input.completedAt.toISOString(),
    releaseSha: input.runtimeVersion,
    runtimeVersion: input.runtimeVersion,
    providerExecution: false,
  };
}

export function isCourseSupportFactualFinalProof(input: {
  proof: unknown;
  attemptLedger: unknown;
  cycle: number;
  firstSeenAt: Date;
  releaseSha: string;
  verifiedAt?: Date | null;
  notBefore?: readonly Date[];
  now?: Date;
}) {
  const proof = asJsonRecord(input.proof);
  const disposition =
    proof.disposition === "MANUAL_DIRECT" ||
    proof.disposition === "IDENTITY_FINAL"
      ? proof.disposition
      : null;
  if (!disposition) {
    return false;
  }
  const now = input.now ?? new Date();
  const event = getCurrentCourseSupportFactualFinalEvent({
    attemptLedger: input.attemptLedger,
    cycle: input.cycle,
    firstSeenAt: input.firstSeenAt,
    runtimeVersion: input.releaseSha,
    disposition,
    now,
  });
  const observedAt =
    typeof proof.observedAt === "string" ? new Date(proof.observedAt) : null;
  const completedAt =
    typeof proof.completedAt === "string" ? new Date(proof.completedAt) : null;
  if (
    !event ||
    !observedAt ||
    !completedAt ||
    !Number.isFinite(observedAt.getTime()) ||
    !Number.isFinite(completedAt.getTime()) ||
    completedAt.getTime() < observedAt.getTime() ||
    (input.verifiedAt && input.verifiedAt.getTime() < completedAt.getTime()) ||
    (input.notBefore ?? []).some(
      (boundary) => observedAt.getTime() < boundary.getTime(),
    )
  ) {
    return false;
  }
  return (
    proof.schemaVersion === 1 &&
    proof.kind === "PLAYBOOK_FACTUAL_FINAL" &&
    proof.playbookVersion === AUTOMATION_PLAYBOOK_VERSION &&
    proof.disposition === disposition &&
    proof.outcome === factualOutcome(disposition) &&
    proof.cycle === event.cycle &&
    proof.stage === event.stage &&
    proof.sequence === event.sequence &&
    proof.readPath === event.readPath &&
    proof.evidenceKind === event.evidenceKind &&
    proof.failureFingerprint === event.failureFingerprint &&
    proof.observedAt === event.observedAt &&
    proof.releaseSha === input.releaseSha &&
    proof.runtimeVersion === input.releaseSha &&
    proof.providerExecution === false
  );
}

function factualOutcome(disposition: AutomationPlaybookFactualDisposition) {
  return disposition === "IDENTITY_FINAL"
    ? ("IDENTITY_FINAL" as const)
    : ("MANUAL_DIRECT" as const);
}

function asJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isCoherentVerificationEvidence(
  value: Prisma.JsonValue | null,
  expected: {
    releaseSha: string;
    outcome: ProbeOutcome;
    providerSnapshotFingerprint: string;
  },
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
    value.providerSnapshotFingerprint !==
      expected.providerSnapshotFingerprint ||
    !observedAt ||
    !Number.isFinite(observedAt.getTime()) ||
    (value.providerRetryNotBeforeAt !== undefined && !providerRetryNotBeforeAt)
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
  observedAt: Date,
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
    throw new Error(
      "Course-support verification availability count is invalid.",
    );
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
      "[redacted-credential]",
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
    now,
  });
  if (!retryAfterAt) {
    return validateRetryAt(input.requestedRetryAt ?? null, now);
  }
  if (retryAfterAt.getTime() > now.getTime() + MAX_RETRY_DELAY_MS) {
    // Never retry earlier than a provider's requested cooldown. A cooldown
    // beyond this request's bounded retry horizon is left to incident backoff.
    return null;
  }
  const requestedRetryAt = validateRetryAt(input.requestedRetryAt ?? null, now);
  return validateRetryAt(
    !requestedRetryAt || requestedRetryAt.getTime() < retryAfterAt.getTime()
      ? retryAfterAt
      : requestedRetryAt,
    now,
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
    throw new Error(
      "Course-support verification retry must be within 24 hours.",
    );
  }
  return retryAt;
}

function validateReleaseSha(value: string) {
  const normalized = value.trim();
  if (!FULL_GIT_SHA.test(normalized)) {
    throw new Error(
      "Course-support verification requires a full Git release SHA.",
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
  notAfter: Date,
) {
  return Boolean(
    request.discoveryAttemptedAt &&
    request.discoveryVerifiedAt &&
    request.discoveryVerifiedAt.getTime() >=
      request.discoveryAttemptedAt.getTime() &&
    request.discoveryVerifiedAt.getTime() <= notAfter.getTime(),
  );
}

function rejected(reason: CourseSupportVerificationRejectionReason) {
  return { claimed: false as const, reason };
}

function rejectedAttachment(reason: CourseSupportVerificationRejectionReason) {
  return { attached: false as const, reason };
}

function rejectedDiscoveryMark(
  reason: CourseSupportVerificationRejectionReason,
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
  reason: CourseSupportVerificationRejectionReason,
) {
  return { current: false as const, reason };
}
