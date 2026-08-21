import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type AutomationRunKind,
  type AutomationRunStatus,
  type CourseSupportBatchIncidentResult,
  type CourseSupportBatchStatus,
  type CourseSupportFailureClass,
  type CourseSupportIncidentKind,
  type CourseSupportIncidentStatus,
  type CourseSupportResolution,
  type CourseSupportVerificationStatus,
  type CourseHumanReviewReason,
  type CourseMonitoringEventSource,
  type CourseMonitoringState,
  type ProbeOutcome,
} from "@prisma/client";

import {
  hasDurableAutomationStalledEndpointProof,
  hasDurableWaitForMaterialChangeProof,
} from "@/lib/customer-monitoring-status";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { sanitizeResponderText } from "./course-support-responder-policy";
import {
  runCourseSupportBrowserPersistenceWrite,
  type CourseSupportBrowserPersistenceFence,
} from "./course-support-browser-stages";
import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  isAutomationHumanReviewProofCurrentOrPrior,
  isAutomationPlaybookExhausted,
  serializeAutomationPlaybookLedger,
  type AutomationPlaybookEventInput,
} from "./course-monitoring-playbook";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";
import {
  COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS,
  canonicalizeCourseProviderExecutionEvidence,
  stableCourseProviderExecutionEvidenceValue,
  type CourseProviderExecutionEvidenceField,
  type CourseProviderExecutionEvidenceInput,
} from "./course-provider-execution-evidence";
import {
  buildProviderFailureFingerprint,
  normalizeProviderFamilyKey,
} from "./provider-capabilities";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import {
  buildCourseSupportExecutionEverSummary,
  areCourseSupportCompletedAttemptsOrchestrationOnly,
  assessCourseSupportZeroExecutionHistory,
  countCourseSupportCompletedOrchestrationOnlyAttempts,
  getCourseSupportOrchestrationRetrySchedule,
  isCourseSupportVerificationRequestUnstarted,
  readCourseSupportReleaseExecutionEvidence,
} from "./course-support-zero-execution";
import {
  canAdvanceCourseSupportSearchExecutionFence,
  courseSupportSearchExecutionFenceMatches,
  createCourseSupportSearchExecutionFenceInput,
  getCourseSupportSearchExecutionMayHaveStartedCourseRefs,
  lockCourseSupportSearchExecutionFenceRows,
  persistCourseSupportSearchExecutionFence,
  readCourseSupportSearchExecutionFence,
  readPersistedCourseSupportSearchExecutionFence,
} from "./course-support-search-execution-fence";
import {
  assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery,
  assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery,
  assessParkedCourseCampaignRequestlessStaleOwnershipRecovery,
  assessParkedCourseCampaignSameCycleRecoveryHistory,
  findParkedCourseCampaignDescendantLineage,
  findParkedCourseCampaignCurrentCycleOrchestrationLineage,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  parseParkedCourseCampaignAudit,
} from "./course-support-campaign";

export const FAILURE_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;
export const FIRST_FAILURE_RETRY_MS = 2 * 60 * 1000;
export const ACTIVE_DEMAND_ESCALATION_MS = 30 * 60 * 1000;
export const CUSTOMER_ENDPOINT_DELIVERY_HEADROOM_MS = 2 * 60 * 1000;
export const INACTIVE_INVESTIGATION_MS = 30 * 60 * 1000;
export const ACTIVE_HUMAN_RETRY_MS = 6 * 60 * 60 * 1000;
export const INACTIVE_HUMAN_RETRY_MS = 6 * 60 * 60 * 1000;
export const ACTIVE_REMINDER_MS = 24 * 60 * 60 * 1000;
export const INACTIVE_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
const DEPLOYMENT_REVALIDATION_PROMPT_VERSION =
  "course-monitoring-deployment-revalidation-v1";

const AUTOMATED_STATES: CourseMonitoringState[] = [
  "DEGRADED_RETRYING",
  "AUTO_INVESTIGATING",
  "ENGINEERING_VERIFICATION_NEEDED",
  "REVALIDATING_FINAL",
];
const REVALIDATABLE_FINAL_RESOLUTIONS = new Set<CourseSupportResolution>([
  "TECHNICAL_LIMITATION_CLASSIFIED",
  "SOURCE_UNVERIFIED",
  "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
]);
const COURSE_MONITORING_WRITE_ATTEMPTS = 3;
const COURSE_MONITORING_WRITE_TIMEOUT_MS = 15_000;
const PROVIDER_EVIDENCE_REVALIDATION_CAS_ATTEMPTS = 3;
const MAX_COURSE_SUPPORT_BATCH_INCIDENTS = 20;
const STALE_BATCH_RELEASE_RETRY_MS = 60 * 1000;
const ACTIVE_COURSE_SUPPORT_BATCH_STATUSES = new Set([
  "CLAIMED",
  "IMPLEMENTING",
  "VERIFYING",
]);

type FailureObservation = {
  readPath: string | null;
  failureFingerprint: string | null;
};

type DeadlineMonitoringStatusSnapshot = {
  state: CourseMonitoringState;
  stateChangedAt: Date;
  nextAutomaticAttemptAt: Date | null;
  revalidationRequestedAt: Date | null;
  revision: number;
};

type DeadlineIncidentSnapshot = {
  id: string;
  courseId: string;
  cycle: number;
  confirmedAt: Date | null;
  revision: number;
  status: CourseSupportIncidentStatus;
  kind: string;
  failureClass: string;
  attemptLedger: Prisma.JsonValue | null;
  failureFingerprint: string;
  humanReviewReason: CourseHumanReviewReason | null;
  escalatedAt: Date | null;
  escalationDeadlineAt: Date | null;
  activeRealSearchCount: number;
  attemptCount?: number;
  activeBatchId: string | null;
  nextAttemptAt: Date | null;
  nextReminderAt: Date | null;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolution: CourseSupportResolution | null;
  batchIncidents?: Array<{
    cycle: number;
    batch: { summary: Prisma.JsonValue | null };
  }>;
};

type DeadlineBatchIncidentSnapshot = {
  id: string;
  createdAt: Date;
  incidentId: string;
  courseId: string;
  cycle: number;
  result: CourseSupportBatchIncidentResult;
  proofSnapshot: Prisma.JsonValue | null;
  updatedAt: Date;
  verificationRequests: Array<{
    id: string;
    batchIncidentId: string;
    releaseSha: string;
    status: CourseSupportVerificationStatus;
    revision: number;
    attemptCount: number;
    startedAt: Date | null;
    outcome: ProbeOutcome | null;
    failureClass: CourseSupportFailureClass | null;
    evidence: Prisma.JsonValue | null;
    lastError: string | null;
  }>;
  incident: DeadlineIncidentSnapshot;
  course: {
    id: string;
    name: string;
    bookingAccessMode: string | null;
    automationReason: string | null;
    monitoringStatus: DeadlineMonitoringStatusSnapshot | null;
    probes: Array<{
      outcome: ProbeOutcome;
      observedAt: Date;
      runtimeVersion: string | null;
    }>;
  };
};

type DeadlineBatchSnapshot = {
  id: string;
  baseSha: string;
  releaseSha: string | null;
  status: CourseSupportBatchStatus;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  completedAt: Date | null;
  deployedAt: Date | null;
  recheckDispatchKey: string | null;
  recheckDispatchStartedAt: Date | null;
  recheckDispatchedAt: Date | null;
  revision: number;
  ownerAutomationRunId: string | null;
  ownerAutomationRun: {
    id: string;
    kind: AutomationRunKind;
    status: AutomationRunStatus;
    completedAt: Date | null;
    outcome: string | null;
    notes: string | null;
  } | null;
  summary: Prisma.JsonValue | null;
  activeIncidents: Array<{ id: string }>;
  incidents: DeadlineBatchIncidentSnapshot[];
};

export type MonitoringFailureDecision = {
  confirmed: boolean;
  independentPathCount: number;
  samePathCount: number;
  state: "DEGRADED_RETRYING" | "AUTO_INVESTIGATING";
};

export function decideMonitoringFailureState(
  previousFailures: FailureObservation[],
  current: Required<FailureObservation>,
): MonitoringFailureDecision {
  const currentFingerprint = normalizeFingerprint(
    current.failureFingerprint ?? "",
  );
  const observations = [
    ...previousFailures.filter(
      (observation) =>
        observation.failureFingerprint !== null &&
        normalizeFingerprint(observation.failureFingerprint) ===
          currentFingerprint,
    ),
    { ...current, failureFingerprint: currentFingerprint },
  ];
  const independentPathCount = new Set(
    observations.map((observation) => observation.readPath).filter(Boolean),
  ).size;
  const samePathCount = observations.filter(
    (observation) => observation.readPath === current.readPath,
  ).length;
  const confirmed = independentPathCount >= 2 || samePathCount >= 2;
  return {
    confirmed,
    independentPathCount,
    samePathCount,
    state: confirmed ? "AUTO_INVESTIGATING" : "DEGRADED_RETRYING",
  };
}

export function getCourseMonitoringEscalationDeadline(
  episodeStartedAt: Date,
  activeRealSearchCount: number,
) {
  const escalationMs =
    activeRealSearchCount > 0
      ? ACTIVE_DEMAND_ESCALATION_MS - CUSTOMER_ENDPOINT_DELIVERY_HEADROOM_MS
      : INACTIVE_INVESTIGATION_MS;
  return new Date(episodeStartedAt.getTime() + escalationMs);
}

export function getFirstFailureRetryAt(
  observedAt: Date,
  episodeStartedAt: Date = observedAt,
) {
  const requestedAnchor = episodeStartedAt.getTime();
  const observedTime = observedAt.getTime();
  const anchor =
    Number.isFinite(requestedAnchor) && requestedAnchor <= observedTime
      ? requestedAnchor
      : observedTime;
  return new Date(anchor + FIRST_FAILURE_RETRY_MS);
}

export function getHumanReviewRetryAt(
  now: Date,
  activeRealSearchCount: number,
) {
  const retryMs =
    activeRealSearchCount > 0 ? ACTIVE_HUMAN_RETRY_MS : INACTIVE_HUMAN_RETRY_MS;
  return new Date(now.getTime() + retryMs);
}

export function getHumanReviewReminderAt(
  now: Date,
  activeRealSearchCount: number,
) {
  return new Date(
    now.getTime() +
      (activeRealSearchCount > 0 ? ACTIVE_REMINDER_MS : INACTIVE_REMINDER_MS),
  );
}

export async function recordCourseMonitoringFailure(input: {
  courseId: string;
  outcome: Extract<
    ProbeOutcome,
    "FETCH_FAILED" | "NEEDS_ADAPTER" | "BLOCKED_AUTH" | "BLOCKED_TOOLING"
  >;
  failureFingerprint: string;
  failureClass?: CourseSupportFailureClass;
  providerFamilyKey?: string;
  readPath: string;
  message?: string;
  source?: CourseMonitoringEventSource;
  activeRealSearchCount: number;
  now?: Date;
  episodeStartedAt?: Date;
  runtimeVersion?: string | null;
  materialEvidenceChanged?: boolean;
}) {
  const now = input.now ?? new Date();
  const safeMessage = sanitizeMonitoringMessage(input.message);
  const readPath = normalizeReadPath(input.readPath);
  const failureFingerprint = normalizeFingerprint(input.failureFingerprint);
  const source = input.source ?? "SEARCH_WORKFLOW";
  if (!hasMonitoringModels(prisma)) {
    const decision = decideMonitoringFailureState([], {
      readPath,
      failureFingerprint,
    });
    return {
      status: null,
      confirmed: decision.confirmed,
      retainedHumanFinal: false,
      independentPathCount: decision.independentPathCount,
      samePathCount: decision.samePathCount,
      nextAttemptAt: getFirstFailureRetryAt(now, input.episodeStartedAt),
    };
  }

  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      const current = await ensureMonitoringStatus(
        transaction,
        input.courseId,
        now,
      );
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          status: true,
          resolution: true,
          failureFingerprint: true,
          humanReviewReason: true,
          escalatedAt: true,
          escalationDeadlineAt: true,
          activeBatchId: true,
          nextAttemptAt: true,
          revision: true,
          activeRealSearchCount: true,
        },
      });
      const currentFailureIdentityAudit = {
        cycle: incident?.cycle ?? null,
        failureClass: input.failureClass ?? null,
        providerFamilyKey: input.providerFamilyKey ?? null,
      };

      const incidentFactualFinalState =
        incident?.status === "RESOLVED" &&
        incident.resolution === "DIRECT_BOOKING_CLASSIFIED"
          ? ("FINAL_MANUAL" as const)
          : incident?.status === "RESOLVED" &&
              incident.resolution === "IDENTITY_CLASSIFIED"
            ? ("FINAL_IDENTITY" as const)
            : null;
      const currentFactualFinalState =
        current.state === "FINAL_MANUAL" || current.state === "FINAL_IDENTITY"
          ? current.state
          : null;
      const retainedTechnicalFinalState =
        incident?.status === "RESOLVED" &&
        incident.resolution &&
        incident.resolution !== "MONITORING_RESTORED" &&
        !incidentFactualFinalState &&
        !input.materialEvidenceChanged &&
        [
          "FINAL_MANUAL",
          "FINAL_TECHNICAL",
          "FINAL_IDENTITY",
          "REVALIDATING_FINAL",
        ].includes(current.state)
          ? ("FINAL_TECHNICAL" as const)
          : null;
      const retainedFinalState =
        incidentFactualFinalState ??
        currentFactualFinalState ??
        retainedTechnicalFinalState;
      if (retainedFinalState) {
        const status = await transaction.courseMonitoringStatus.update({
          where: {
            courseId: input.courseId,
            revision: current.revision,
          },
          data: {
            state: retainedFinalState,
            lastFailureAt: now,
            consecutiveFailures: { increment: 1 },
            failureFingerprint,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id,
          eventType: "CHECK_FAILED",
          source,
          fromState: current.state,
          toState: status.state,
          outcome: input.outcome,
          failureFingerprint,
          readPath,
          message:
            safeMessage ??
            "The existing final monitoring decision was reconfirmed.",
          runtimeVersion: input.runtimeVersion,
          occurredAt: now,
          audit: {
            ...currentFailureIdentityAudit,
            retainedFinalDecision: true,
            resolution: incident?.resolution ?? null,
            customerDataIncluded: false,
          },
        });
        return {
          status,
          confirmed: true,
          retainedHumanFinal: true,
          independentPathCount: 1,
          samePathCount: 1,
          nextAttemptAt: null,
        };
      }

      if (
        current.state === "ENGINEERING_VERIFICATION_NEEDED" &&
        !input.materialEvidenceChanged
      ) {
        const potentiallyParkedUntilMaterialChange =
          incident?.status === "NEEDS_HUMAN" &&
          Boolean(incident.humanReviewReason) &&
          incident.activeBatchId === null &&
          incident.nextAttemptAt === null &&
          incident.failureFingerprint === failureFingerprint &&
          current.failureFingerprint === failureFingerprint &&
          current.nextAutomaticAttemptAt === null &&
          current.revalidationRequestedAt === null;
        const parkedEvent = potentiallyParkedUntilMaterialChange
          ? await transaction.courseMonitoringEvent.findFirst({
              where: {
                incidentId: incident.id,
                eventType: "HUMAN_REVIEW_REQUESTED",
              },
              orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
              select: {
                incidentId: true,
                eventType: true,
                occurredAt: true,
                audit: true,
              },
            })
          : null;
        const parkedUntilMaterialChange =
          potentiallyParkedUntilMaterialChange &&
          hasDurableWaitForMaterialChangeProof({
            incidentId: incident.id,
            incidentCycle: incident.cycle,
            incidentStatus: incident.status,
            humanReviewReason: incident.humanReviewReason,
            incidentEscalatedAt: incident.escalatedAt,
            escalationDeadlineAt: incident.escalationDeadlineAt,
            monitoringState: current.state,
            endpointEvents: parkedEvent ? [parkedEvent] : [],
          });
        const retryAt = getHumanReviewRetryAt(
          now,
          incident?.activeRealSearchCount ?? input.activeRealSearchCount,
        );
        const nextAttemptAt = parkedUntilMaterialChange ? null : retryAt;
        const status = await transaction.courseMonitoringStatus.update({
          where: {
            courseId: input.courseId,
            revision: current.revision,
          },
          data: {
            lastFailureAt: now,
            consecutiveFailures:
              current.failureFingerprint === failureFingerprint
                ? { increment: 1 }
                : 1,
            failureFingerprint,
            nextAutomaticAttemptAt: nextAttemptAt,
            revision: { increment: 1 },
          },
        });
        if (incident?.status === "NEEDS_HUMAN") {
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              revision: incident.revision,
              status: "NEEDS_HUMAN",
            },
            data: {
              nextAttemptAt,
              lastSeenAt: now,
              revision: { increment: 1 },
            },
          });
        }
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id,
          eventType: "CHECK_FAILED",
          source,
          fromState: current.state,
          toState: current.state,
          outcome: input.outcome,
          failureFingerprint,
          readPath,
          message:
            safeMessage ??
            "A safe recheck reconfirmed the limitation while human review remains open.",
          runtimeVersion: input.runtimeVersion,
          occurredAt: now,
          audit: {
            ...currentFailureIdentityAudit,
            retainedHumanReview: true,
            parkedUntilMaterialChange,
            activeDemand: input.activeRealSearchCount > 0,
            customerDataIncluded: false,
          },
        });
        return {
          status,
          confirmed: true,
          retainedHumanFinal: false,
          independentPathCount: 1,
          samePathCount: Math.max(status.consecutiveFailures, 1),
          nextAttemptAt,
        };
      }

      const recentFailures = await transaction.courseMonitoringEvent.findMany({
        where: {
          courseId: input.courseId,
          eventType: "CHECK_FAILED",
          occurredAt: {
            gte: new Date(now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS),
            lte: now,
          },
        },
        orderBy: { occurredAt: "desc" },
        select: {
          readPath: true,
          failureFingerprint: true,
        },
      });
      const decision = decideMonitoringFailureState(recentFailures, {
        readPath,
        failureFingerprint,
      });
      const continuingFailureEpisode =
        !input.materialEvidenceChanged &&
        current.failureFingerprint === failureFingerprint;
      const firstDegradedAt = continuingFailureEpisode
        ? (current.firstDegradedAt ?? now)
        : now;
      const nextAttemptAt = decision.confirmed
        ? now
        : getFirstFailureRetryAt(now, input.episodeStartedAt);
      const stateChanged = current.state !== decision.state;
      const status = await transaction.courseMonitoringStatus.update({
        where: {
          courseId: input.courseId,
          revision: current.revision,
        },
        data: {
          state: decision.state,
          lastFailureAt: now,
          consecutiveFailures:
            current.failureFingerprint === failureFingerprint
              ? { increment: 1 }
              : 1,
          failureFingerprint,
          firstDegradedAt,
          nextAutomaticAttemptAt: nextAttemptAt,
          revalidationRequestedAt: null,
          ...(stateChanged ? { stateChangedAt: now } : {}),
          revision: { increment: 1 },
        },
      });

      await appendMonitoringEvent(transaction, {
        courseId: input.courseId,
        incidentId: incident?.id,
        eventType: "CHECK_FAILED",
        source,
        fromState: current.state,
        toState: status.state,
        outcome: input.outcome,
        failureFingerprint,
        readPath,
        message: safeMessage,
        runtimeVersion: input.runtimeVersion,
        occurredAt: now,
        audit: {
          ...currentFailureIdentityAudit,
          confirmationWindowMinutes: 15,
          independentPathCount: decision.independentPathCount,
          samePathCount: decision.samePathCount,
          confirmed: decision.confirmed,
          customerDataIncluded: false,
        },
      });
      if (stateChanged) {
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id,
          eventType: "STATE_CHANGED",
          source,
          fromState: current.state,
          toState: status.state,
          failureFingerprint,
          message: decision.confirmed
            ? "Repeated independent evidence confirmed an automated investigation."
            : "A failure was recorded and a fresh public retry was scheduled.",
          occurredAt: now,
        });
      }

      return {
        status,
        confirmed: decision.confirmed,
        retainedHumanFinal: false,
        independentPathCount: decision.independentPathCount,
        samePathCount: decision.samePathCount,
        nextAttemptAt,
      };
    },
  );
}

export async function recordCourseMonitoringSuccess(input: {
  courseId: string;
  outcome: Extract<ProbeOutcome, "MATCH_FOUND" | "NO_MATCH">;
  source?: CourseMonitoringEventSource;
  message?: string;
  now?: Date;
  runtimeVersion?: string | null;
}) {
  const now = input.now ?? new Date();
  const source = input.source ?? "SEARCH_WORKFLOW";
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      const current = await ensureMonitoringStatus(
        transaction,
        input.courseId,
        now,
      );
      const recovered = current.state !== "HEALTHY";
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          confirmedAt: true,
          status: true,
          resolution: true,
          decisionAt: true,
          activeBatchId: true,
          revision: true,
        },
      });
      const retainedFactualFinalState =
        current.state === "FINAL_MANUAL"
          ? ("FINAL_MANUAL" as const)
          : current.state === "FINAL_IDENTITY"
            ? ("FINAL_IDENTITY" as const)
            : incident?.status === "RESOLVED" &&
                incident.resolution === "DIRECT_BOOKING_CLASSIFIED"
              ? ("FINAL_MANUAL" as const)
              : incident?.status === "RESOLVED" &&
                  incident.resolution === "IDENTITY_CLASSIFIED"
                ? ("FINAL_IDENTITY" as const)
                : null;
      if (retainedFactualFinalState) {
        const status = await transaction.courseMonitoringStatus.update({
          where: {
            courseId: input.courseId,
            revision: current.revision,
          },
          data: {
            state: retainedFactualFinalState,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            ...(current.state !== retainedFactualFinalState
              ? { stateChangedAt: now }
              : {}),
            revision: { increment: 1 },
          },
        });
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id ?? null,
          eventType: "CHECK_SUCCEEDED",
          source,
          fromState: current.state,
          toState: retainedFactualFinalState,
          outcome: input.outcome,
          message:
            "A successful observation was recorded without overriding the authoritative factual final.",
          runtimeVersion: input.runtimeVersion,
          occurredAt: now,
        });
        return status;
      }
      let status = await transaction.courseMonitoringStatus.update({
        where: {
          courseId: input.courseId,
          revision: current.revision,
        },
        data: {
          state: "HEALTHY",
          lastSuccessfulAt: now,
          consecutiveFailures: 0,
          failureFingerprint: null,
          firstDegradedAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          ...(recovered ? { stateChangedAt: now } : {}),
          revision: { increment: 1 },
        },
      });
      if (
        incident &&
        (incident.status === "AUTO_INVESTIGATING" ||
          incident.status === "NEEDS_HUMAN" ||
          (current.state === "REVALIDATING_FINAL" &&
            incident.status === "RESOLVED" &&
            incident.resolution !== null &&
            REVALIDATABLE_FINAL_RESOLUTIONS.has(incident.resolution))) &&
        !incident.activeBatchId
      ) {
        const resolutionData = {
          status: "RESOLVED" as const,
          resolvedAt: now,
          resolution: "MONITORING_RESTORED" as const,
          resolutionMessage:
            "Fresh public signed-out monitoring succeeded and restored the course.",
          nextAction: null,
          nextAttemptAt: null,
          nextReminderAt: null,
          lastSeenAt: now,
          revision: { increment: 1 },
        };
        const resolved = await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            status: incident.status,
            ...(incident.status === "RESOLVED"
              ? { resolution: incident.resolution }
              : {}),
            activeBatchId: null,
            revision: incident.revision,
          },
          data: resolutionData,
        });
        if (resolved.count === 0) {
          const latestIncident =
            await transaction.courseSupportIncident.findUnique({
              where: { courseId: input.courseId },
              select: {
                id: true,
                status: true,
                resolution: true,
                activeBatchId: true,
                revision: true,
              },
            });
          const racedFactualFinalState =
            latestIncident?.status === "RESOLVED" &&
            latestIncident.resolution === "DIRECT_BOOKING_CLASSIFIED"
              ? ("FINAL_MANUAL" as const)
              : latestIncident?.status === "RESOLVED" &&
                  latestIncident.resolution === "IDENTITY_CLASSIFIED"
                ? ("FINAL_IDENTITY" as const)
                : null;
          if (racedFactualFinalState && !latestIncident?.activeBatchId) {
            status = await transaction.courseMonitoringStatus.update({
              where: {
                courseId: input.courseId,
                revision: status.revision,
              },
              data: {
                state: racedFactualFinalState,
                nextAutomaticAttemptAt: null,
                revalidationRequestedAt: null,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
            await appendMonitoringEvent(transaction, {
              courseId: input.courseId,
              incidentId: latestIncident?.id ?? null,
              eventType: "CHECK_SUCCEEDED",
              source,
              fromState: current.state,
              toState: racedFactualFinalState,
              outcome: input.outcome,
              message:
                "A successful observation lost a concurrent race to an authoritative factual final.",
              runtimeVersion: input.runtimeVersion,
              occurredAt: now,
            });
            return status;
          }
          if (
            latestIncident &&
            (latestIncident.status !== "RESOLVED" ||
              (current.state === "REVALIDATING_FINAL" &&
                latestIncident.resolution !== null &&
                REVALIDATABLE_FINAL_RESOLUTIONS.has(
                  latestIncident.resolution,
                ))) &&
            !latestIncident.activeBatchId
          ) {
            const retried = await transaction.courseSupportIncident.updateMany({
              where: {
                id: latestIncident.id,
                status: latestIncident.status,
                ...(latestIncident.status === "RESOLVED"
                  ? { resolution: latestIncident.resolution }
                  : {}),
                activeBatchId: null,
                revision: latestIncident.revision,
              },
              data: resolutionData,
            });
            if (retried.count !== 1) {
              throw new Error(
                "Course monitoring incident write conflict while reconciling success.",
              );
            }
          }
        }
      }
      await appendMonitoringEvent(transaction, {
        courseId: input.courseId,
        incidentId: incident?.id,
        eventType: "CHECK_SUCCEEDED",
        source,
        fromState: current.state,
        toState: "HEALTHY",
        outcome: input.outcome,
        message: sanitizeMonitoringMessage(input.message),
        runtimeVersion: input.runtimeVersion,
        occurredAt: now,
      });
      if (recovered) {
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id,
          eventType: "RECOVERED",
          source,
          fromState: current.state,
          toState: "HEALTHY",
          outcome: input.outcome,
          message:
            "Fresh public signed-out monitoring succeeded and restored the course.",
          runtimeVersion: input.runtimeVersion,
          deploymentSha: getAutomaticDeploymentSha(
            source,
            input.runtimeVersion,
          ),
          occurredAt: now,
          audit: {
            ...(incident ? { cycle: incident.cycle } : {}),
            confirmedAt: incident?.confirmedAt?.toISOString() ?? null,
            automatedFinal: true,
            customerDataIncluded: false,
          },
        });
        if (source !== "SEARCH_WORKFLOW") {
          await queueActiveRealSearchesForCourse(
            transaction,
            input.courseId,
            now,
          );
        }
      }
      return status;
    },
  );
}

export async function recordCourseMonitoringFinalClassification(input: {
  courseId: string;
  state: "FINAL_MANUAL" | "FINAL_IDENTITY";
  outcome: "MANUAL_DIRECT" | "IDENTITY_FINAL";
  source?: CourseMonitoringEventSource;
  message: string;
  evidenceUrl?: string | null;
  now?: Date;
  runtimeVersion?: string | null;
}) {
  const now = input.now ?? new Date();
  const source = input.source ?? "SEARCH_WORKFLOW";
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      const current = await ensureMonitoringStatus(
        transaction,
        input.courseId,
        now,
      );
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          confirmedAt: true,
          status: true,
          resolution: true,
          decisionAt: true,
          activeBatchId: true,
          revision: true,
        },
      });
      const stateChanged = current.state !== input.state;
      const snapshotNeedsRepair =
        current.consecutiveFailures !== 0 ||
        current.failureFingerprint !== null ||
        current.firstDegradedAt !== null ||
        current.nextAutomaticAttemptAt !== null ||
        current.revalidationRequestedAt !== null;
      const status =
        stateChanged || snapshotNeedsRepair
          ? await transaction.courseMonitoringStatus.update({
              where: {
                courseId: input.courseId,
                revision: current.revision,
              },
              data: {
                state: input.state,
                consecutiveFailures: 0,
                failureFingerprint: null,
                firstDegradedAt: null,
                nextAutomaticAttemptAt: null,
                revalidationRequestedAt: null,
                ...(stateChanged ? { stateChangedAt: now } : {}),
                revision: { increment: 1 },
              },
            })
          : current;
      const revalidatableTechnicalResolution =
        incident?.status === "RESOLVED" &&
        (incident.resolution === "TECHNICAL_LIMITATION_CLASSIFIED" ||
          incident.resolution === "SOURCE_UNVERIFIED" ||
          incident.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION");
      const factualResolution =
        input.state === "FINAL_IDENTITY"
          ? ("IDENTITY_CLASSIFIED" as const)
          : ("DIRECT_BOOKING_CLASSIFIED" as const);
      const factualResolutionData = {
        status: "RESOLVED" as const,
        resolvedAt: now,
        resolution: factualResolution,
        resolutionMessage:
          sanitizeMonitoringMessage(input.message) ??
          "Current official evidence confirmed the factual final state.",
        nextAction: null,
        nextAttemptAt: null,
        nextReminderAt: null,
        lastSeenAt: now,
        revision: { increment: 1 },
      };
      if (
        incident &&
        !incident.activeBatchId &&
        (incident.status !== "RESOLVED" || revalidatableTechnicalResolution)
      ) {
        const resolvedIncident =
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              status: incident.status,
              activeBatchId: null,
              revision: incident.revision,
              ...(incident.status === "RESOLVED"
                ? { resolution: incident.resolution }
                : {}),
            },
            data: factualResolutionData,
          });
        if (resolvedIncident.count === 0) {
          const latestIncident =
            await transaction.courseSupportIncident.findUnique({
              where: { courseId: input.courseId },
              select: {
                id: true,
                status: true,
                resolution: true,
                activeBatchId: true,
                revision: true,
              },
            });
          const latestRevalidatableTechnicalResolution =
            latestIncident?.status === "RESOLVED" &&
            (latestIncident.resolution === "TECHNICAL_LIMITATION_CLASSIFIED" ||
              latestIncident.resolution === "SOURCE_UNVERIFIED" ||
              latestIncident.resolution ===
                "HUMAN_VERIFIED_TECHNICAL_LIMITATION");
          if (
            latestIncident &&
            !latestIncident.activeBatchId &&
            (latestIncident.status !== "RESOLVED" ||
              latestRevalidatableTechnicalResolution)
          ) {
            await transaction.courseSupportIncident.updateMany({
              where: {
                id: latestIncident.id,
                status: latestIncident.status,
                activeBatchId: null,
                revision: latestIncident.revision,
                ...(latestIncident.status === "RESOLVED"
                  ? { resolution: latestIncident.resolution }
                  : {}),
              },
              data: factualResolutionData,
            });
          }
        }
      }
      if (stateChanged) {
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident?.id,
          eventType: "STATE_CHANGED",
          source,
          fromState: current.state,
          toState: input.state,
          outcome: input.outcome,
          message: sanitizeMonitoringMessage(input.message),
          evidenceUrl: sanitizeEvidenceUrl(input.evidenceUrl),
          runtimeVersion: input.runtimeVersion,
          deploymentSha: getAutomaticDeploymentSha(
            source,
            input.runtimeVersion,
          ),
          occurredAt: now,
          ...(incident
            ? {
                audit: {
                  cycle: incident.cycle,
                  confirmedAt: incident.confirmedAt?.toISOString() ?? null,
                  automatedFinal:
                    incident.decisionAt === null &&
                    source !== "OPERATOR_DASHBOARD" &&
                    source !== "OPERATOR_CLI" &&
                    source !== "MAINTENANCE",
                  customerDataIncluded: false,
                },
              }
            : {}),
        });
        if (source !== "SEARCH_WORKFLOW") {
          await queueActiveRealSearchesForCourse(
            transaction,
            input.courseId,
            now,
          );
        }
      }
      return status;
    },
  );
}

export async function confirmCourseMonitoringTechnicalFinal(input: {
  courseId: string;
  message: string;
  source?: CourseMonitoringEventSource;
  now?: Date;
  runtimeVersion?: string | null;
}) {
  const now = input.now ?? new Date();
  const source = input.source ?? "LOCAL_READER";
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      const current = await ensureMonitoringStatus(
        transaction,
        input.courseId,
        now,
      );
      if (
        current.state !== "REVALIDATING_FINAL" &&
        current.state !== "AUTO_INVESTIGATING"
      ) {
        return current;
      }
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          confirmedAt: true,
          decisionAt: true,
          attemptLedger: true,
        },
      });
      if (
        !incident ||
        assessAutomationPlaybook(incident.attemptLedger, incident.cycle)
          .conclusion !== "TECHNICAL_FINAL"
      ) {
        throw new Error(
          "Automatic technical finality requires current-cycle local-reader and independent confirmation proof.",
        );
      }
      const status = await transaction.courseMonitoringStatus.update({
        where: {
          courseId: input.courseId,
          revision: current.revision,
        },
        data: {
          state: "FINAL_TECHNICAL",
          consecutiveFailures: 0,
          failureFingerprint: null,
          firstDegradedAt: null,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          stateChangedAt: now,
          revision: { increment: 1 },
        },
      });
      await appendMonitoringEvent(transaction, {
        courseId: input.courseId,
        incidentId: incident?.id,
        eventType: "STATE_CHANGED",
        source,
        fromState: current.state,
        toState: "FINAL_TECHNICAL",
        outcome: "BLOCKED_AUTH",
        message: sanitizeMonitoringMessage(input.message),
        runtimeVersion: input.runtimeVersion,
        deploymentSha: getAutomaticDeploymentSha(source, input.runtimeVersion),
        occurredAt: now,
        audit: {
          cycle: incident.cycle,
          confirmedAt: incident.confirmedAt?.toISOString() ?? null,
          automatedFinal: incident.decisionAt === null,
          customerDataIncluded: false,
        },
      });
      if (source !== "SEARCH_WORKFLOW") {
        await queueActiveRealSearchesForCourse(
          transaction,
          input.courseId,
          now,
        );
      }
      return status;
    },
  );
}

export async function requestTechnicalFinalRevalidationForDemand(input: {
  courseIds: string[];
  source?: CourseMonitoringEventSource;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const uniqueCourseIds = [...new Set(input.courseIds)];
  if (uniqueCourseIds.length === 0 || !hasMonitoringModels(prisma)) {
    return { requestedCourseIds: [] as string[] };
  }

  const requestedCourseIds: string[] = [];
  for (const courseId of uniqueCourseIds) {
    const result = await runSerializedCourseMonitoringWrite(
      courseId,
      async (transaction) => {
        const current = await transaction.courseMonitoringStatus.findUnique({
          where: { courseId },
        });
        if (!current || current.state !== "FINAL_TECHNICAL") {
          return false;
        }
        const updated = await transaction.courseMonitoringStatus.updateMany({
          where: {
            courseId,
            revision: current.revision,
            state: "FINAL_TECHNICAL",
          },
          data: {
            state: "REVALIDATING_FINAL",
            revalidationRequestedAt: now,
            nextAutomaticAttemptAt: now,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) {
          return false;
        }
        const incident = await transaction.courseSupportIncident.findUnique({
          where: { courseId },
          select: { id: true },
        });
        await appendMonitoringEvent(transaction, {
          courseId,
          incidentId: incident?.id,
          eventType: "REVALIDATION_REQUESTED",
          source: input.source ?? "SEARCH_WORKFLOW",
          fromState: "FINAL_TECHNICAL",
          toState: "REVALIDATING_FINAL",
          message:
            "New real demand requested one safe revalidation of the engineer-approved limitation.",
          occurredAt: now,
        });
        return true;
      },
    );
    if (result) {
      requestedCourseIds.push(courseId);
    }
  }
  return { requestedCourseIds };
}

type MaterialProviderEvidenceField = CourseProviderExecutionEvidenceField;

export type CourseProviderEvidenceSnapshot =
  CourseProviderExecutionEvidenceInput & Record<string, unknown>;

export type ProviderEvidenceRevalidationOutcome =
  | "IMMATERIAL"
  | "NOT_ACTIONABLE"
  | "REPLAYED"
  | "RECHECK_QUEUED"
  | "HUMAN_REVIEW_PRESERVED"
  | "AUTHORITATIVE_FINAL_PRESERVED"
  | "REQUEUED";

type ProviderEvidenceRevalidationResult = {
  outcome: ProviderEvidenceRevalidationOutcome;
  changedFields: MaterialProviderEvidenceField[];
  searchesQueued: number;
};

export function shouldOpenFreshPlaybookCycleForProviderEvidence(input: {
  status: string;
  humanReviewReason?: string | null;
  resolution?: CourseSupportResolution | null;
}) {
  return (
    input.status === "NEEDS_HUMAN" ||
    (input.status === "AUTO_INVESTIGATING" &&
      input.humanReviewReason === "AUTOMATION_STALLED") ||
    (input.status === "RESOLVED" &&
      input.resolution !== null &&
      input.resolution !== undefined &&
      REVALIDATABLE_FINAL_RESOLUTIONS.has(input.resolution))
  );
}

export function getMaterialProviderEvidenceChanges(
  before: CourseProviderEvidenceSnapshot,
  after: CourseProviderEvidenceSnapshot,
) {
  const canonicalBefore = canonicalizeCourseProviderExecutionEvidence(before);
  const canonicalAfter = canonicalizeCourseProviderExecutionEvidence(after);
  return COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS.filter(
    (field) =>
      stableCourseProviderExecutionEvidenceValue(canonicalBefore[field]) !==
      stableCourseProviderExecutionEvidenceValue(canonicalAfter[field]),
  );
}

export async function revalidateCourseMonitoringForProviderEvidenceChange(input: {
  courseId: string;
  before: CourseProviderEvidenceSnapshot;
  after: CourseProviderEvidenceSnapshot;
  providerSnapshotFingerprint?: string;
  source: CourseMonitoringEventSource;
  now?: Date;
}) {
  const changedFields = getMaterialProviderEvidenceChanges(
    input.before,
    input.after,
  );
  if (changedFields.length === 0 || !hasMonitoringModels(prisma)) {
    return {
      outcome: "IMMATERIAL" as const,
      changedFields,
      searchesQueued: 0,
    };
  }
  return runSerializedCourseMonitoringWrite(input.courseId, (transaction) =>
    revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
      transaction,
      {
        ...input,
        changedFields,
        now: input.now ?? new Date(),
      },
    ),
  );
}

export async function revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    before: CourseProviderEvidenceSnapshot;
    after: CourseProviderEvidenceSnapshot;
    providerSnapshotFingerprint?: string;
    source: CourseMonitoringEventSource;
    changedFields?: MaterialProviderEvidenceField[];
    now: Date;
  },
) {
  const changedFields =
    input.changedFields ??
    getMaterialProviderEvidenceChanges(input.before, input.after);
  if (changedFields.length === 0) {
    return {
      outcome: "IMMATERIAL" as const,
      changedFields,
      searchesQueued: 0,
    };
  }

  const attemptRevalidation = async (
    attempt: number,
  ): Promise<ProviderEvidenceRevalidationResult> => {
    const [incident, status] = await Promise.all([
      transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          revision: true,
          status: true,
          activeBatchId: true,
          activeRealSearchCount: true,
          kind: true,
          providerFamilyKey: true,
          failureClass: true,
          failureFingerprint: true,
          humanReviewReason: true,
          resolution: true,
          activeBatch: {
            select: {
              status: true,
              releaseSha: true,
              deployedAt: true,
              recheckDispatchedAt: true,
            },
          },
        },
      }),
      transaction.courseMonitoringStatus.findUnique({
        where: { courseId: input.courseId },
        select: {
          state: true,
          revision: true,
        },
      }),
    ]);
    if (!incident) {
      return {
        outcome: "NOT_ACTIONABLE" as const,
        changedFields,
        searchesQueued: 0,
      };
    }

    if (incident.activeBatchId) {
      const freshnessUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            revision: incident.revision,
            status: incident.status,
            activeBatchId: incident.activeBatchId,
          },
          data: {
            lastSeenAt: input.now,
            revision: { increment: 1 },
          },
        });
      if (freshnessUpdated.count !== 1) {
        if (attempt >= PROVIDER_EVIDENCE_REVALIDATION_CAS_ATTEMPTS) {
          throw new Error(
            "Course provider-evidence revalidation write conflict while preserving active ownership.",
          );
        }
        return attemptRevalidation(attempt + 1);
      }
      const providerSnapshotFingerprint = input.providerSnapshotFingerprint;
      const timeZone = input.after.timeZone;
      if (
        !incident.activeBatch ||
        !["CLAIMED", "IMPLEMENTING", "VERIFYING"].includes(
          incident.activeBatch.status,
        ) ||
        !incident.activeBatch.releaseSha ||
        !incident.activeBatch.deployedAt ||
        !incident.activeBatch.recheckDispatchedAt ||
        typeof providerSnapshotFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/iu.test(providerSnapshotFingerprint) ||
        typeof timeZone !== "string" ||
        !timeZone.trim()
      ) {
        return {
          outcome: "NOT_ACTIONABLE" as const,
          changedFields,
          searchesQueued: 0,
        };
      }

      const idempotencyKey = `course-provider-evidence-recheck:${createHash(
        "sha256",
      )
        .update(
          `${input.courseId}:${incident.id}:${incident.cycle}:${providerSnapshotFingerprint}`,
        )
        .digest("hex")}`;
      const replay = await transaction.courseMonitoringEvent.findUnique({
        where: { idempotencyKey },
        select: { id: true },
      });
      if (replay) {
        return {
          outcome: "REPLAYED" as const,
          changedFields,
          searchesQueued: 0,
        };
      }

      const queued = await queueImmediateActiveRealSearchSchedulesForCourse(
        transaction,
        input.courseId,
        input.now,
        getCourseLocalDateStorageBoundary(timeZone, input.now),
      );
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: input.source,
          fromState: status?.state ?? null,
          toState: status?.state ?? null,
          failureFingerprint: incident.failureFingerprint,
          message:
            "Material provider evidence changed after the batch recheck dispatch, so current searches were queued again.",
          idempotencyKey,
          occurredAt: input.now,
          audit: {
            cycle: incident.cycle,
            changedFields,
            providerSnapshotFingerprint,
            exactReleaseProgression: true,
            postDispatchRecheck: true,
            customerDataIncluded: false,
          },
        },
      });
      return {
        outcome: "RECHECK_QUEUED" as const,
        changedFields,
        searchesQueued: queued.count,
      };
    }

    const providerFamilyWasSupplied = Object.prototype.hasOwnProperty.call(
      input.after,
      "providerFamilyKey",
    );
    const nextProviderFamilyKey = providerFamilyWasSupplied
      ? normalizeProviderFamilyKey(
          typeof input.after.providerFamilyKey === "string"
            ? input.after.providerFamilyKey
            : null,
        )
      : incident.providerFamilyKey;
    const providerFamilyChanged =
      nextProviderFamilyKey !== incident.providerFamilyKey;
    const nextFailureFingerprint = providerFamilyChanged
      ? buildProviderFailureFingerprint({
          providerFamilyKey: nextProviderFamilyKey,
          failureClass: incident.failureClass,
          operation:
            incident.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
          httpStatus: null,
        })
      : incident.failureFingerprint;
    const evidenceFingerprint = createHash("sha256")
      .update(
        stableCourseProviderExecutionEvidenceValue(
          canonicalizeCourseProviderExecutionEvidence(input.after),
        ),
      )
      .digest("hex");
    const revalidationKeyForCycle = (cycle: number) =>
      `course-provider-evidence-revalidate:${createHash("sha256")
        .update(
          `${input.courseId}:${incident.id}:${cycle}:${evidenceFingerprint}`,
        )
        .digest("hex")}`;
    const idempotencyKey = revalidationKeyForCycle(incident.cycle);
    const replayKeys = [idempotencyKey];
    if (incident.cycle > 1) {
      replayKeys.push(revalidationKeyForCycle(incident.cycle - 1));
    }
    let replay: { id: string } | null = null;
    for (const replayKey of replayKeys) {
      replay = await transaction.courseMonitoringEvent.findUnique({
        where: { idempotencyKey: replayKey },
        select: { id: true },
      });
      if (replay) break;
    }
    if (replay) {
      return {
        outcome: "REPLAYED" as const,
        changedFields,
        searchesQueued: 0,
      };
    }

    const authoritativeFinal = Boolean(
      status?.state === "FINAL_MANUAL" ||
      status?.state === "FINAL_IDENTITY" ||
      incident.resolution === "DIRECT_BOOKING_CLASSIFIED" ||
      incident.resolution === "IDENTITY_CLASSIFIED",
    );
    if (authoritativeFinal) {
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: input.source,
          fromState: status?.state ?? null,
          toState: status?.state ?? null,
          failureFingerprint: incident.failureFingerprint,
          message:
            "Changed provider evidence was recorded without reopening an authoritative factual final.",
          idempotencyKey,
          occurredAt: input.now,
          audit: {
            cycle: incident.cycle,
            changedFields,
            evidenceFingerprint,
            authoritativeFinalRetained: true,
            customerDataIncluded: false,
          },
        },
      });
      return {
        outcome: "AUTHORITATIVE_FINAL_PRESERVED" as const,
        changedFields,
        searchesQueued: 0,
      };
    }

    if (
      incident.status !== "RESOLVED" &&
      isAccountRequiredProviderEvidence(input.after)
    ) {
      const accountFailureFingerprint = buildProviderFailureFingerprint({
        providerFamilyKey: nextProviderFamilyKey,
        failureClass: "AUTH",
        operation:
          incident.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
        httpStatus: null,
      });
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            revision: incident.revision,
            activeBatchId: null,
            status: incident.status,
          },
          data: {
            status: "NEEDS_HUMAN",
            providerFamilyKey: nextProviderFamilyKey,
            failureClass: "AUTH",
            failureFingerprint: accountFailureFingerprint,
            humanReviewReason: "ACCOUNT_REQUIRED",
            latestMessage:
              "Verified official course evidence indicates an account is required to view tee times.",
            nextAction:
              "Confirm the account-required technical limitation; retry only after the official site exposes signed-out tee-time availability.",
            nextAttemptAt: null,
            escalatedAt: input.now,
            nextReminderAt: input.now,
            confirmedAt: input.now,
            lastSeenAt: input.now,
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        if (attempt >= PROVIDER_EVIDENCE_REVALIDATION_CAS_ATTEMPTS) {
          throw new Error(
            "Course provider-evidence revalidation write conflict while preserving account-required human review.",
          );
        }
        return attemptRevalidation(attempt + 1);
      }

      if (status) {
        const statusUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: input.courseId,
              revision: status.revision,
              state: status.state,
            },
            data: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              failureFingerprint: accountFailureFingerprint,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: input.now,
              revision: { increment: 1 },
            },
          });
        if (statusUpdated.count !== 1) {
          throw new Error(
            "The monitoring state changed while account-required human review was preserved.",
          );
        }
      } else {
        await transaction.courseMonitoringStatus.create({
          data: {
            courseId: input.courseId,
            reference: createMonitoringReference(),
            state: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: accountFailureFingerprint,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
            stateChangedAt: input.now,
            updatedAt: input.now,
          },
        });
      }

      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "HUMAN_REVIEW_REQUESTED",
          source: input.source,
          fromState: status?.state ?? null,
          toState: "ENGINEERING_VERIFICATION_NEEDED",
          failureFingerprint: accountFailureFingerprint,
          message:
            "Material provider evidence confirmed an account-required booking surface, so engineering review remained parked without another automatic attempt.",
          idempotencyKey,
          occurredAt: input.now,
          audit: {
            cycle: incident.cycle,
            customerState: "NEEDS_HUMAN_REVIEW",
            changedFields,
            evidenceFingerprint,
            humanReviewReason: "ACCOUNT_REQUIRED",
            parkedUntilMaterialChange: true,
            automaticRetrySuppressed: true,
            customerDataIncluded: false,
          },
        },
      });
      return {
        outcome: "HUMAN_REVIEW_PRESERVED" as const,
        changedFields,
        searchesQueued: 0,
      };
    }

    const automationStalled =
      incident.humanReviewReason === "AUTOMATION_STALLED";
    if (!shouldOpenFreshPlaybookCycleForProviderEvidence(incident)) {
      return {
        outcome: "NOT_ACTIONABLE" as const,
        changedFields,
        searchesQueued: 0,
      };
    }

    const nextCycle = incident.cycle + 1;
    const incidentUpdated = await transaction.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        cycle: incident.cycle,
        revision: incident.revision,
        activeBatchId: null,
        status: incident.status,
        ...(incident.status === "AUTO_INVESTIGATING"
          ? { humanReviewReason: "AUTOMATION_STALLED" as const }
          : {}),
        ...(incident.status === "RESOLVED"
          ? { resolution: incident.resolution }
          : {}),
      },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        providerFamilyKey: nextProviderFamilyKey,
        failureFingerprint: nextFailureFingerprint,
        occurrenceCount: 1,
        lastAttemptAt: null,
        attemptCount: 0,
        firstSeenAt: input.now,
        confirmedAt: input.now,
        escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
          input.now,
          incident.activeRealSearchCount,
        ),
        humanReviewReason: null,
        nextReminderAt: null,
        nextAttemptAt: input.now,
        nextAction:
          "Run a fresh ordered playbook because material provider evidence changed.",
        ownerNotifiedAt: null,
        escalatedAt: null,
        escalationNotifiedAt: null,
        resolvedAt: null,
        resolution: null,
        resolutionMessage: null,
        resolutionNotifiedAt: null,
        decisionActorId: null,
        decisionAt: null,
        decisionNote: null,
        decisionEvidenceUrl: null,
        decisionIdempotencyKey: null,
        lastSeenAt: input.now,
        revision: { increment: 1 },
      },
    });
    if (incidentUpdated.count !== 1) {
      if (attempt >= PROVIDER_EVIDENCE_REVALIDATION_CAS_ATTEMPTS) {
        throw new Error(
          "Course provider-evidence revalidation write conflict while opening a fresh cycle.",
        );
      }
      return attemptRevalidation(attempt + 1);
    }

    if (status) {
      const statusUpdated = await transaction.courseMonitoringStatus.updateMany(
        {
          where: {
            courseId: input.courseId,
            revision: status.revision,
            state: status.state,
          },
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: nextFailureFingerprint,
            firstDegradedAt: input.now,
            nextAutomaticAttemptAt: input.now,
            revalidationRequestedAt: input.now,
            stateChangedAt: input.now,
            revision: { increment: 1 },
          },
        },
      );
      if (statusUpdated.count !== 1) {
        throw new Error(
          "The monitoring state changed while provider-evidence revalidation was queued.",
        );
      }
    } else {
      await transaction.courseMonitoringStatus.create({
        data: {
          courseId: input.courseId,
          reference: createMonitoringReference(),
          state: "AUTO_INVESTIGATING",
          failureFingerprint: nextFailureFingerprint,
          firstDegradedAt: input.now,
          nextAutomaticAttemptAt: input.now,
          revalidationRequestedAt: input.now,
          stateChangedAt: input.now,
          updatedAt: input.now,
        },
      });
    }

    const queued = await queueActiveRealSearchesForCourse(
      transaction,
      input.courseId,
      input.now,
    );
    await transaction.courseMonitoringEvent.create({
      data: {
        courseId: input.courseId,
        incidentId: incident.id,
        eventType: "REVALIDATION_REQUESTED",
        source: input.source,
        fromState: status?.state ?? null,
        toState: "AUTO_INVESTIGATING",
        failureFingerprint: nextFailureFingerprint,
        message:
          "Material provider evidence changed, so a fresh ordered-playbook cycle was queued.",
        idempotencyKey,
        occurredAt: input.now,
        audit: {
          priorCycle: incident.cycle,
          cycle: nextCycle,
          reason: automationStalled
            ? "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED"
            : incident.status === "RESOLVED"
              ? "TECHNICAL_FINAL_PROVIDER_EVIDENCE_CHANGED"
              : "HUMAN_REVIEW_PROVIDER_EVIDENCE_CHANGED",
          priorProviderFamilyKey: incident.providerFamilyKey,
          providerFamilyKey: nextProviderFamilyKey,
          providerFamilyChanged,
          changedFields,
          evidenceFingerprint,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    });
    return {
      outcome: "REQUEUED" as const,
      changedFields,
      searchesQueued: queued.count,
    };
  };

  return attemptRevalidation(1);
}

function isAccountRequiredProviderEvidence(
  evidence: CourseProviderEvidenceSnapshot,
) {
  return Boolean(
    evidence.automationReason === "ACCOUNT_REQUIRED" ||
    [
      "ACCOUNT_REQUIRED",
      "ACCOUNT_SELF_SERVICE",
      "ACCOUNT_STAFF_PROVISIONED",
    ].includes(
      typeof evidence.bookingAccessMode === "string"
        ? evidence.bookingAccessMode
        : "",
    ),
  );
}

export function getNextMonitoringWakeAt(
  courses: Array<{
    monitoringStatus?: {
      state: CourseMonitoringState;
      nextAutomaticAttemptAt: Date | null;
      revalidationRequestedAt: Date | null;
    } | null;
  }>,
) {
  const values = courses
    .flatMap((course) => {
      const status = course.monitoringStatus;
      if (!status || !AUTOMATED_STATES.includes(status.state)) {
        return [];
      }
      return status.nextAutomaticAttemptAt
        ? [status.nextAutomaticAttemptAt]
        : [];
    })
    .sort((left, right) => left.getTime() - right.getTime());
  return values[0] ?? null;
}

export function shouldSleepTechnicalFinalSearch(
  courses: Array<{
    monitoringStatus?: {
      state: CourseMonitoringState;
      revalidationRequestedAt: Date | null;
      nextAutomaticAttemptAt?: Date | null;
    } | null;
  }>,
) {
  return Boolean(
    courses.length > 0 &&
    courses.every((course) => {
      const state = course.monitoringStatus?.state;
      return (
        (state === "ENGINEERING_VERIFICATION_NEEDED" ||
          state === "FINAL_TECHNICAL" ||
          state === "FINAL_MANUAL" ||
          state === "FINAL_IDENTITY") &&
        !course.monitoringStatus?.nextAutomaticAttemptAt &&
        !course.monitoringStatus?.revalidationRequestedAt
      );
    }),
  );
}

export async function recordCourseMonitoringAutomationAttempt(input: {
  courseId: string;
  incidentId?: string | null;
  message: string;
  source?: CourseMonitoringEventSource;
  runtimeVersion?: string | null;
  deploymentSha?: string | null;
  audit?: Prisma.InputJsonObject;
  now?: Date;
}) {
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  return prisma.courseMonitoringEvent.create({
    data: {
      courseId: input.courseId,
      incidentId: input.incidentId,
      eventType: input.deploymentSha
        ? "DEPLOYMENT_VERIFIED"
        : "AUTOMATION_ATTEMPTED",
      source: input.source ?? "COURSE_SUPPORT_RESPONDER",
      message: sanitizeMonitoringMessage(input.message),
      runtimeVersion: normalizeRuntimeVersion(input.runtimeVersion),
      deploymentSha: normalizeDeploymentSha(input.deploymentSha),
      audit: input.audit,
      occurredAt: input.now ?? new Date(),
    },
  });
}

export async function recordCourseMonitoringPlaybookTransition(
  input: Omit<AutomationPlaybookEventInput, "cycle" | "observedAt"> & {
    courseId: string;
    incidentId?: string | null;
    source?: CourseMonitoringEventSource;
    idempotencyKey?: string | null;
    now?: Date;
    browserPersistenceFence?: CourseSupportBrowserPersistenceFence;
  },
) {
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  const now = input.now ?? new Date();
  const idempotencyKey = normalizeMonitoringIdempotencyKey(
    input.idempotencyKey,
  );
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      if (input.browserPersistenceFence) {
        await runCourseSupportBrowserPersistenceWrite({
          transaction,
          fence: input.browserPersistenceFence,
          runtimeVersion: input.runtimeVersion,
          mutate: async () => undefined,
        });
      }
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId: input.courseId },
        select: {
          id: true,
          cycle: true,
          revision: true,
          status: true,
          attemptLedger: true,
        },
      });
      if (!incident || (input.incidentId && input.incidentId !== incident.id)) {
        throw new Error(
          "A current durable course incident is required to record playbook proof.",
        );
      }
      if (idempotencyKey) {
        const replay = await transaction.courseMonitoringEvent.findUnique({
          where: { idempotencyKey },
          select: { courseId: true },
        });
        if (replay) {
          if (replay.courseId !== input.courseId) {
            throw new Error(
              "The playbook idempotency key belongs to another course.",
            );
          }
          const assessment = assessAutomationPlaybook(
            incident.attemptLedger,
            incident.cycle,
          );
          return {
            replayed: true,
            incidentId: incident.id,
            incidentRevision: incident.revision,
            ledger: incident.attemptLedger,
            assessment,
          };
        }
      }
      if (incident.status === "RESOLVED") {
        throw new Error(
          "A resolved incident cannot receive automated playbook proof.",
        );
      }

      const ledger = appendAutomationPlaybookEvent(incident.attemptLedger, {
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
        note: input.note,
        cycle: incident.cycle,
        observedAt: now,
      });
      const assessment = assessAutomationPlaybook(ledger, incident.cycle);
      const updated = await transaction.courseSupportIncident.updateMany({
        where: {
          id: incident.id,
          cycle: incident.cycle,
          revision: incident.revision,
          status: { not: "RESOLVED" },
        },
        data: {
          attemptLedger: serializeAutomationPlaybookLedger(ledger),
          revision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          "The course incident changed while playbook proof was appended.",
        );
      }
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "AUTOMATION_ATTEMPTED",
          source: input.source ?? "COURSE_SUPPORT_RESPONDER",
          failureFingerprint: input.failureFingerprint,
          readPath: input.readPath,
          message: sanitizeMonitoringMessage(input.note),
          runtimeVersion: normalizeRuntimeVersion(input.runtimeVersion),
          idempotencyKey,
          occurredAt: now,
          audit: {
            playbookVersion: ledger.version,
            cycle: incident.cycle,
            stage: input.stage,
            transition: input.transition,
            conclusion: assessment.conclusion,
            exhausted: isAutomationPlaybookExhausted(ledger, incident.cycle),
            customerDataIncluded: false,
          },
        },
      });
      return {
        replayed: false,
        incidentId: incident.id,
        incidentRevision: incident.revision + 1,
        ledger,
        assessment,
      };
    },
  );
}

export async function revalidateHumanReviewCoursesForDeployment(input: {
  deploymentSha?: string | null;
  now?: Date;
}) {
  const deploymentSha = normalizeDeploymentSha(input.deploymentSha);
  if (!deploymentSha || !hasMonitoringModels(prisma)) {
    return {
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0,
    };
  }

  const now = input.now ?? new Date();
  await prisma.automationRun.upsert({
    where: { id: `cm_deploy_${deploymentSha}` },
    create: {
      id: `cm_deploy_${deploymentSha}`,
      promptVersion: DEPLOYMENT_REVALIDATION_PROMPT_VERSION,
      kind: "MAINTENANCE",
      status: "COMPLETED",
      runtimeVersion: deploymentSha,
      auditSchemaVersion: 1,
      audit: {
        customerDataIncluded: false,
      },
      startedAt: now,
      completedAt: now,
      outcome: "deployment_observed",
      notes:
        "Recorded the deployed runtime boundary without reopening unchanged course investigations.",
    },
    update: {},
    select: { id: true },
  });
  return {
    considered: 0,
    requeued: 0,
    retainedAuthoritativeFinals: 0,
  };
}

export async function reconcileCourseMonitoringDeadlines(input: {
  courseIds?: string[];
  now?: Date;
  source?: Extract<
    CourseMonitoringEventSource,
    "SEARCH_WORKFLOW" | "RECOVERY_CRON"
  >;
}) {
  const now = input.now ?? new Date();
  if (!hasMonitoringModels(prisma)) {
    return {
      checked: 0,
      escalated: 0,
      retrying: 0,
      humanReviewIncidentIds: [] as string[],
      parkedIncidentIds: [] as string[],
    };
  }
  const courseIds = [...new Set(input.courseIds?.filter(Boolean) ?? [])];
  if (input.courseIds && courseIds.length === 0) {
    return {
      checked: 0,
      escalated: 0,
      retrying: 0,
      humanReviewIncidentIds: [] as string[],
      parkedIncidentIds: [] as string[],
    };
  }
  const candidates = await prisma.courseSupportIncident.findMany({
    where: {
      OR: [
        {
          status: "AUTO_INVESTIGATING",
          OR: [
            {
              humanReviewReason: null,
              escalationDeadlineAt: { lte: now },
            },
            { humanReviewReason: { not: null } },
            {
              course: {
                monitoringStatus: {
                  is: { state: "ENGINEERING_VERIFICATION_NEEDED" },
                },
              },
            },
          ],
        },
        {
          status: "NEEDS_HUMAN",
        },
      ],
      /*
       * NEEDS_HUMAN rows are included so stale pre-fence writes cannot wait
       * six hours before their missing current/prior playbook proof is healed.
       */
      AND: [
        {
          OR: [
            { escalationDeadlineAt: { lte: now } },
            { status: "NEEDS_HUMAN" },
            { humanReviewReason: { not: null } },
            {
              course: {
                monitoringStatus: {
                  is: { state: "ENGINEERING_VERIFICATION_NEEDED" },
                },
              },
            },
          ],
        },
      ],
      ...(courseIds.length > 0 ? { courseId: { in: courseIds } } : {}),
    },
    select: { courseId: true },
  });
  let escalated = 0;
  let retrying = 0;
  const humanReviewIncidentIds: string[] = [];
  const parkedIncidentIds: string[] = [];
  for (const candidate of candidates) {
    const outcome = await reconcileCourseMonitoringDeadline({
      courseId: candidate.courseId,
      now,
      source: input.source ?? "RECOVERY_CRON",
    });
    if (outcome.outcome === "NEEDS_HUMAN") {
      escalated += 1;
    }
    if (outcome.outcome === "RETRYING") {
      retrying += 1;
    }
    if (
      outcome.outcome === "RETAINED_PARKED" ||
      ("parkedUntilMaterialChange" in outcome &&
        outcome.parkedUntilMaterialChange === true)
    ) {
      parkedIncidentIds.push(outcome.incidentId);
    }
    if (
      (outcome.outcome === "NEEDS_HUMAN" ||
        outcome.outcome === "RETAINED_HUMAN" ||
        outcome.outcome === "RETAINED_PARKED") &&
      outcome.incidentId
    ) {
      humanReviewIncidentIds.push(outcome.incidentId);
    }
  }
  return {
    checked: candidates.length,
    escalated,
    retrying,
    humanReviewIncidentIds,
    parkedIncidentIds,
  };
}

export async function reconcileCourseMonitoringDeadline(input: {
  courseId: string;
  now: Date;
  source: Extract<
    CourseMonitoringEventSource,
    "SEARCH_WORKFLOW" | "RECOVERY_CRON"
  >;
}) {
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      const [incident, status, course] = await Promise.all([
        transaction.courseSupportIncident.findUnique({
          where: { courseId: input.courseId },
          select: {
            id: true,
            courseId: true,
            cycle: true,
            confirmedAt: true,
            status: true,
            attemptLedger: true,
            kind: true,
            failureClass: true,
            failureFingerprint: true,
            humanReviewReason: true,
            escalatedAt: true,
            escalationDeadlineAt: true,
            activeRealSearchCount: true,
            activeBatchId: true,
            activeBatch: {
              select: {
                id: true,
                baseSha: true,
                releaseSha: true,
                status: true,
                leaseExpiresAt: true,
                heartbeatAt: true,
                completedAt: true,
                deployedAt: true,
                recheckDispatchKey: true,
                recheckDispatchStartedAt: true,
                recheckDispatchedAt: true,
                revision: true,
                ownerAutomationRunId: true,
                ownerAutomationRun: {
                  select: {
                    id: true,
                    kind: true,
                    status: true,
                    completedAt: true,
                    outcome: true,
                    notes: true,
                  },
                },
                summary: true,
                activeIncidents: {
                  orderBy: { id: "asc" },
                  take: MAX_COURSE_SUPPORT_BATCH_INCIDENTS + 1,
                  select: { id: true },
                },
                incidents: {
                  orderBy: [
                    { course: { name: "asc" } },
                    { createdAt: "asc" },
                    { id: "asc" },
                  ],
                  take: MAX_COURSE_SUPPORT_BATCH_INCIDENTS + 1,
                  select: {
                    id: true,
                    createdAt: true,
                    incidentId: true,
                    courseId: true,
                    cycle: true,
                    result: true,
                    proofSnapshot: true,
                    updatedAt: true,
                    verificationRequests: {
                      select: {
                        id: true,
                        batchIncidentId: true,
                        releaseSha: true,
                        status: true,
                        revision: true,
                        attemptCount: true,
                        startedAt: true,
                        outcome: true,
                        failureClass: true,
                        evidence: true,
                        lastError: true,
                      },
                    },
                    incident: {
                      select: {
                        id: true,
                        courseId: true,
                        cycle: true,
                        confirmedAt: true,
                        revision: true,
                        status: true,
                        kind: true,
                        failureClass: true,
                        attemptLedger: true,
                        failureFingerprint: true,
                        humanReviewReason: true,
                        escalatedAt: true,
                        escalationDeadlineAt: true,
                        activeRealSearchCount: true,
                        attemptCount: true,
                        activeBatchId: true,
                        nextAttemptAt: true,
                        nextReminderAt: true,
                        lastSeenAt: true,
                        resolvedAt: true,
                        resolution: true,
                        batchIncidents: {
                          where: { batch: { completedAt: { not: null } } },
                          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                          take: 20,
                          select: {
                            cycle: true,
                            batch: { select: { summary: true } },
                          },
                        },
                      },
                    },
                    course: {
                      select: {
                        id: true,
                        name: true,
                        bookingAccessMode: true,
                        automationReason: true,
                        probes: {
                          where: {
                            outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
                            observedAt: { lte: input.now },
                            teeSearch: {
                              status: "ACTIVE",
                              trafficClass: {
                                notIn: [...syntheticWebsiteTrafficClasses],
                              },
                            },
                          },
                          orderBy: [{ observedAt: "desc" }, { id: "desc" }],
                          take: 1,
                          select: {
                            outcome: true,
                            observedAt: true,
                            runtimeVersion: true,
                          },
                        },
                        monitoringStatus: {
                          select: {
                            state: true,
                            stateChangedAt: true,
                            nextAutomaticAttemptAt: true,
                            revalidationRequestedAt: true,
                            revision: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            nextAttemptAt: true,
            nextReminderAt: true,
            resolution: true,
            resolvedAt: true,
            lastSeenAt: true,
            revision: true,
          },
        }),
        transaction.courseMonitoringStatus.findUnique({
          where: { courseId: input.courseId },
          select: {
            state: true,
            stateChangedAt: true,
            nextAutomaticAttemptAt: true,
            revalidationRequestedAt: true,
            revision: true,
          },
        }),
        transaction.course.findUnique({
          where: { id: input.courseId },
          select: {
            bookingAccessMode: true,
            automationReason: true,
          },
        }),
      ]);
      if (
        !incident ||
        !status ||
        !course ||
        (incident.status !== "AUTO_INVESTIGATING" &&
          incident.status !== "NEEDS_HUMAN")
      ) {
        return {
          outcome: "UNCHANGED" as const,
          incidentId: incident?.id ?? null,
        };
      }
      const currentCycleExhausted = isAutomationPlaybookExhausted(
        incident.attemptLedger,
        incident.cycle,
      );
      const humanReviewProofEstablished =
        isAutomationHumanReviewProofCurrentOrPrior(
          incident.attemptLedger,
          incident.cycle,
        );
      const needsImmediateAutomationRepair =
        status.state === "ENGINEERING_VERIFICATION_NEEDED" &&
        !humanReviewProofEstablished;
      if (
        incident.status === "AUTO_INVESTIGATING" &&
        incident.humanReviewReason === null &&
        (!incident.escalationDeadlineAt ||
          incident.escalationDeadlineAt > input.now) &&
        !needsImmediateAutomationRepair
      ) {
        return { outcome: "UNCHANGED" as const, incidentId: incident.id };
      }

      const playbookAssessment = assessAutomationPlaybook(
        incident.attemptLedger,
        incident.cycle,
      );
      const escalationDeadlineReached = Boolean(
        incident.escalationDeadlineAt &&
        incident.escalationDeadlineAt <= input.now,
      );
      const activeBatch = incident.activeBatch;
      const liveBatchOwner = Boolean(
        activeBatch &&
        ACTIVE_COURSE_SUPPORT_BATCH_STATUSES.has(activeBatch.status) &&
        activeBatch.completedAt === null &&
        activeBatch.leaseExpiresAt >= input.now,
      );
      const staleBatchNeedsEndpointReconcile = Boolean(
        incident.activeBatchId &&
        activeBatch &&
        !liveBatchOwner &&
        (escalationDeadlineReached ||
          incident.status === "NEEDS_HUMAN" ||
          incident.humanReviewReason !== null ||
          needsImmediateAutomationRepair),
      );
      if (staleBatchNeedsEndpointReconcile && activeBatch) {
        return reconcileStaleBatchOwnershipAtEndpoint(transaction, {
          batch: activeBatch,
          currentCourseId: input.courseId,
          currentIncidentId: incident.id,
          now: input.now,
          source: input.source,
        });
      }

      const authoritativeResolution =
        status.state === "HEALTHY"
          ? ("MONITORING_RESTORED" as const)
          : status.state === "FINAL_MANUAL"
            ? ("DIRECT_BOOKING_CLASSIFIED" as const)
            : status.state === "FINAL_IDENTITY"
              ? ("IDENTITY_CLASSIFIED" as const)
              : status.state === "FINAL_TECHNICAL"
                ? ("TECHNICAL_LIMITATION_CLASSIFIED" as const)
                : null;
      if (authoritativeResolution) {
        if (staleBatchNeedsEndpointReconcile && activeBatch) {
          return reconcileStaleBatchOwnershipAtEndpoint(transaction, {
            batch: activeBatch,
            currentCourseId: input.courseId,
            currentIncidentId: incident.id,
            now: input.now,
            source: input.source,
          });
        }
        if (!incident.activeBatchId) {
          const incidentUpdated =
            await transaction.courseSupportIncident.updateMany({
              where: {
                id: incident.id,
                revision: incident.revision,
                status: incident.status,
                activeBatchId: null,
              },
              data: {
                status: "RESOLVED",
                resolvedAt: input.now,
                resolution: authoritativeResolution,
                resolutionMessage:
                  "Reconciled to the newer authoritative course monitoring state.",
                nextAction: null,
                nextAttemptAt: null,
                nextReminderAt: null,
                lastSeenAt: input.now,
                revision: { increment: 1 },
              },
            });
          if (incidentUpdated.count !== 1) {
            throw new Error(
              "The course incident changed while an authoritative monitoring state was reconciled.",
            );
          }
        }
        return {
          outcome: "AUTHORITATIVE_STATE" as const,
          incidentId: incident.id,
        };
      }

      const freshSuccessProbe = await transaction.courseProbe.findFirst({
        where: {
          courseId: input.courseId,
          outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
          observedAt: {
            gt: incident.lastSeenAt,
            lte: input.now,
          },
          teeSearch: {
            status: "ACTIVE",
            trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
          },
        },
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        select: {
          outcome: true,
          observedAt: true,
          runtimeVersion: true,
        },
      });
      if (freshSuccessProbe) {
        if (staleBatchNeedsEndpointReconcile && activeBatch) {
          return reconcileStaleBatchOwnershipAtEndpoint(transaction, {
            batch: activeBatch,
            currentCourseId: input.courseId,
            currentIncidentId: incident.id,
            now: input.now,
            source: input.source,
          });
        }
        const statusUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: input.courseId,
              revision: status.revision,
            },
            data: {
              state: "HEALTHY",
              lastSuccessfulAt: freshSuccessProbe.observedAt,
              consecutiveFailures: 0,
              failureFingerprint: null,
              firstDegradedAt: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: freshSuccessProbe.observedAt,
              revision: { increment: 1 },
            },
          });
        if (statusUpdated.count !== 1) {
          throw new Error(
            "The course monitoring status changed while a fresh probe was reconciled.",
          );
        }
        if (!incident.activeBatchId) {
          const incidentUpdated =
            await transaction.courseSupportIncident.updateMany({
              where: {
                id: incident.id,
                revision: incident.revision,
                status: incident.status,
                activeBatchId: null,
              },
              data: {
                status: "RESOLVED",
                resolvedAt: freshSuccessProbe.observedAt,
                resolution: "MONITORING_RESTORED",
                resolutionMessage:
                  "Reconciled from a fresh successful customer monitoring probe.",
                nextAction: null,
                nextAttemptAt: null,
                nextReminderAt: null,
                lastSeenAt: freshSuccessProbe.observedAt,
                revision: { increment: 1 },
              },
            });
          if (incidentUpdated.count !== 1) {
            throw new Error(
              "The course incident changed while a fresh monitoring probe was reconciled.",
            );
          }
        }
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "CHECK_SUCCEEDED",
          source: input.source,
          fromState: status.state,
          toState: "HEALTHY",
          outcome: freshSuccessProbe.outcome,
          message:
            "A durable fresh probe was adopted after monitoring closeout was interrupted.",
          runtimeVersion: freshSuccessProbe.runtimeVersion,
          occurredAt: input.now,
          audit: {
            recoveredFromProbeCrashBoundary: true,
            customerDataIncluded: false,
          },
        });
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "RECOVERED",
          source: input.source,
          fromState: status.state,
          toState: "HEALTHY",
          outcome: freshSuccessProbe.outcome,
          message:
            "Fresh public monitoring proof prevented stale deadline escalation.",
          runtimeVersion: freshSuccessProbe.runtimeVersion,
          deploymentSha: getAutomaticDeploymentSha(
            input.source,
            freshSuccessProbe.runtimeVersion,
          ),
          occurredAt: input.now,
          audit: {
            cycle: incident.cycle,
            confirmedAt: incident.confirmedAt?.toISOString() ?? null,
            automatedFinal: true,
            customerDataIncluded: false,
          },
        });
        if (incident.activeRealSearchCount > 0) {
          await queueActiveRealSearchesForCourse(
            transaction,
            input.courseId,
            input.now,
          );
        }
        return {
          outcome: "AUTHORITATIVE_PROBE" as const,
          incidentId: incident.id,
        };
      }

      const humanReviewEndpointEvent =
        incident.status === "NEEDS_HUMAN" && incident.humanReviewReason
          ? await transaction.courseMonitoringEvent.findFirst({
              where: {
                incidentId: incident.id,
                eventType: "HUMAN_REVIEW_REQUESTED",
              },
              orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
              select: {
                incidentId: true,
                eventType: true,
                occurredAt: true,
                audit: true,
              },
            })
          : null;
      const endpointProofInput = {
        incidentId: incident.id,
        incidentCycle: incident.cycle,
        incidentStatus: incident.status,
        humanReviewReason: incident.humanReviewReason,
        incidentEscalatedAt: incident.escalatedAt,
        escalationDeadlineAt: incident.escalationDeadlineAt,
        monitoringState: status.state,
        endpointEvents: humanReviewEndpointEvent
          ? [humanReviewEndpointEvent]
          : [],
      } as const;
      const durableMaterialChangeParking =
        hasDurableWaitForMaterialChangeProof(endpointProofInput);
      const durableAutomationStalledEndpoint =
        hasDurableAutomationStalledEndpointProof(endpointProofInput);
      const parkedWithoutNewMaterial =
        incident.status === "NEEDS_HUMAN" &&
        Boolean(incident.humanReviewReason) &&
        incident.nextAttemptAt === null &&
        status.state === "ENGINEERING_VERIFICATION_NEEDED" &&
        status.nextAutomaticAttemptAt === null &&
        status.revalidationRequestedAt === null;
      if (
        parkedWithoutNewMaterial &&
        durableAutomationStalledEndpoint &&
        playbookAssessment.valid === true &&
        playbookAssessment.cycle === incident.cycle &&
        playbookAssessment.conclusion === "INCOMPLETE" &&
        playbookAssessment.nextStage !== null
      ) {
        const ownedByActiveCampaign = await isOwnedByActiveParkedCourseCampaign(
          transaction,
          {
            courseId: input.courseId,
            incidentId: incident.id,
          },
        );
        if (ownedByActiveCampaign) {
          return {
            outcome: "RETAINED_PARKED" as const,
            incidentId: incident.id,
            parkedUntilMaterialChange: true as const,
          };
        }
        const resumed = await resumeIncompleteAutomationStalledPlaybook(
          transaction,
          {
            courseId: input.courseId,
            incident,
            monitoringStatus: status,
            playbookAssessment,
            endpointEvent: humanReviewEndpointEvent!,
            now: input.now,
            source: input.source,
          },
        );
        if (resumed) {
          return {
            outcome: "RETRYING" as const,
            incidentId: incident.id,
          };
        }
      }
      if (parkedWithoutNewMaterial && durableMaterialChangeParking) {
        return {
          outcome: "RETAINED_PARKED" as const,
          incidentId: incident.id,
        };
      }

      /*
       * Older endpoint events predate the explicit material-change marker.
       * Their deadline/cycle/timestamp proof is still strong enough to retain
       * the factual human-review endpoint, but the row must first be upgraded
       * atomically so the watchdog cannot turn it back into six-hour work.
       */
      if (
        !incident.activeBatchId &&
        durableAutomationStalledEndpoint &&
        (!parkedWithoutNewMaterial || !durableMaterialChangeParking)
      ) {
        await persistAutomationStalledEndpoint(transaction, {
          courseId: input.courseId,
          incident,
          monitoringStatus: status,
          playbookAssessment,
          expectedActiveBatchId: null,
          endpointAt: incident.escalatedAt!,
          existingDurableParkingProof: durableMaterialChangeParking,
          source: input.source,
        });
        return {
          outcome: "RETAINED_PARKED" as const,
          incidentId: incident.id,
          parkedUntilMaterialChange: true as const,
        };
      }

      // A live responder lease owns remaining non-authoritative work. Missing
      // or not-yet-due ownership fails closed instead of being stolen.
      if (incident.activeBatchId) {
        if (!staleBatchNeedsEndpointReconcile || !activeBatch) {
          return {
            outcome: "OWNED" as const,
            incidentId: incident.id,
          };
        }
        return reconcileStaleBatchOwnershipAtEndpoint(transaction, {
          batch: activeBatch,
          currentCourseId: input.courseId,
          currentIncidentId: incident.id,
          now: input.now,
          source: input.source,
        });
      }

      if (!currentCycleExhausted && escalationDeadlineReached) {
        const stalledEndpoint = await persistAutomationStalledEndpoint(
          transaction,
          {
            courseId: input.courseId,
            incident,
            monitoringStatus: status,
            playbookAssessment,
            expectedActiveBatchId: null,
            endpointAt: input.now,
            source: input.source,
          },
        );
        return {
          outcome: stalledEndpoint.alreadyApplied
            ? ("RETAINED_HUMAN" as const)
            : ("NEEDS_HUMAN" as const),
          incidentId: incident.id,
          parkedUntilMaterialChange: true as const,
        };
      }

      if (!currentCycleExhausted) {
        const idempotencyKey = createDeadlineContinuationIdempotencyKey({
          courseId: input.courseId,
          incidentId: incident.id,
          cycle: incident.cycle,
          escalationDeadlineAt: incident.escalationDeadlineAt,
          nextStage: playbookAssessment.nextStage,
        });
        const priorContinuation =
          await transaction.courseMonitoringEvent.findUnique({
            where: { idempotencyKey },
            select: { id: true, occurredAt: true },
          });
        const continuationAt = priorContinuation?.occurredAt ?? input.now;
        const continuationAlreadyApplied =
          incident.status === "AUTO_INVESTIGATING" &&
          incident.humanReviewReason === null &&
          status.state === "AUTO_INVESTIGATING" &&
          incident.nextAttemptAt?.getTime() === continuationAt.getTime() &&
          status.nextAutomaticAttemptAt?.getTime() ===
            continuationAt.getTime() &&
          status.revalidationRequestedAt?.getTime() ===
            continuationAt.getTime();
        if (priorContinuation && continuationAlreadyApplied) {
          return {
            outcome: "UNCHANGED" as const,
            incidentId: incident.id,
          };
        }
        const incidentUpdated =
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              revision: incident.revision,
              status: incident.status,
              activeBatchId: null,
            },
            data: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalatedAt: humanReviewProofEstablished
                ? incident.escalatedAt
                : null,
              nextReminderAt: null,
              nextAttemptAt: continuationAt,
              nextAction:
                "Continue the current-cycle ordered playbook before requesting human review.",
              revision: { increment: 1 },
            },
          });
        if (incidentUpdated.count !== 1) {
          throw new Error(
            "The course incident changed while automatic deadline continuation was reconciled.",
          );
        }
        const statusUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: { courseId: input.courseId, revision: status.revision },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: continuationAt,
              revalidationRequestedAt: continuationAt,
              stateChangedAt: input.now,
              revision: { increment: 1 },
            },
          });
        if (statusUpdated.count !== 1) {
          throw new Error(
            "The course monitoring status changed while automatic deadline continuation was reconciled.",
          );
        }
        if (incident.activeRealSearchCount > 0) {
          await queueActiveRealSearchesForCourse(
            transaction,
            input.courseId,
            input.now,
          );
        }
        if (!priorContinuation) {
          await appendMonitoringEvent(transaction, {
            courseId: input.courseId,
            incidentId: incident.id,
            eventType: "REVALIDATION_REQUESTED",
            source: input.source,
            fromState: status.state,
            toState: "AUTO_INVESTIGATING",
            failureFingerprint: incident.failureFingerprint,
            message:
              "The automation deadline queued the next safe current-cycle playbook stage.",
            idempotencyKey,
            occurredAt: continuationAt,
            audit: {
              activeDemand: incident.activeRealSearchCount > 0,
              customerState: "RETRYING_AUTOMATICALLY",
              playbookVersion: playbookAssessment.version,
              playbookConclusion: playbookAssessment.conclusion,
              playbookExhausted: currentCycleExhausted,
              priorCycleHumanReviewProof:
                humanReviewProofEstablished && !currentCycleExhausted,
              nextStage: playbookAssessment.nextStage,
              escalationDeadlineAt:
                incident.escalationDeadlineAt?.toISOString() ?? null,
              customerDataIncluded: false,
            },
          });
        }
        return {
          outcome: "RETRYING" as const,
          incidentId: incident.id,
        };
      }
      if (incident.status === "NEEDS_HUMAN") {
        return {
          outcome: "RETAINED_HUMAN" as const,
          incidentId: incident.id,
        };
      }
      const retryAt = getHumanReviewRetryAt(
        input.now,
        incident.activeRealSearchCount,
      );
      const humanReviewReason = inferHumanReviewReason({
        kind: incident.kind,
        failureClass: incident.failureClass,
        bookingAccessMode: course.bookingAccessMode,
        automationReason: course.automationReason,
      });
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            revision: incident.revision,
            status: "AUTO_INVESTIGATING",
            activeBatchId: null,
          },
          data: {
            status: "NEEDS_HUMAN",
            humanReviewReason,
            escalatedAt: incident.escalatedAt ?? input.now,
            nextReminderAt: input.now,
            nextAttemptAt: retryAt,
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        throw new Error(
          "The course incident changed while human-review escalation was reconciled.",
        );
      }
      const statusUpdated = await transaction.courseMonitoringStatus.updateMany(
        {
          where: { courseId: input.courseId, revision: status.revision },
          data: {
            state: "ENGINEERING_VERIFICATION_NEEDED",
            nextAutomaticAttemptAt: retryAt,
            revalidationRequestedAt: null,
            stateChangedAt: input.now,
            revision: { increment: 1 },
          },
        },
      );
      if (statusUpdated.count !== 1) {
        throw new Error(
          "The course monitoring status changed while human-review escalation was reconciled.",
        );
      }
      if (incident.activeRealSearchCount > 0) {
        await queueActiveRealSearchesForCourse(
          transaction,
          input.courseId,
          input.now,
        );
      }
      await appendMonitoringEvent(transaction, {
        courseId: input.courseId,
        incidentId: incident.id,
        eventType: "HUMAN_REVIEW_REQUESTED",
        source: input.source,
        fromState: status.state,
        toState: "ENGINEERING_VERIFICATION_NEEDED",
        failureFingerprint: incident.failureFingerprint,
        message:
          "The bounded automated playbook ended without fresh runnable proof.",
        occurredAt: input.now,
        audit: {
          cycle: incident.cycle,
          activeDemand: incident.activeRealSearchCount > 0,
          customerState: "NEEDS_HUMAN_REVIEW",
          playbookVersion: playbookAssessment.version,
          playbookConclusion: playbookAssessment.conclusion,
          playbookExhausted: currentCycleExhausted,
          automationStalled: false,
          nextStage: playbookAssessment.nextStage,
          escalationDeadlineAt:
            incident.escalationDeadlineAt?.toISOString() ?? null,
          automaticRecheckHours: 6,
          customerDataIncluded: false,
        },
      });
      return {
        outcome: "NEEDS_HUMAN" as const,
        incidentId: incident.id,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

async function isOwnedByActiveParkedCourseCampaign(
  transaction: Prisma.TransactionClient,
  input: { courseId: string; incidentId: string },
) {
  const campaign = await transaction.automationRun.findFirst({
    where: {
      promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
      status: "RUNNING",
      completedAt: null,
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { audit: true },
  });
  if (!campaign) {
    return false;
  }
  const audit = parseParkedCourseCampaignAudit(campaign.audit);
  if (!audit) {
    // An active but unreadable immutable campaign must fail closed. Reopening
    // the row through the generic watchdog would bypass its cycle and
    // provenance fences and could make the member impossible to close.
    return true;
  }
  return Boolean(
    audit.members.some(
      (member) =>
        member.courseId === input.courseId &&
        member.incidentId === input.incidentId,
    ),
  );
}

async function resumeIncompleteAutomationStalledPlaybook(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    incident: DeadlineIncidentSnapshot;
    monitoringStatus: DeadlineMonitoringStatusSnapshot;
    playbookAssessment: ReturnType<typeof assessAutomationPlaybook>;
    endpointEvent: {
      incidentId: string | null;
      eventType: string;
      occurredAt: Date;
      audit: Prisma.JsonValue | null;
    };
    now: Date;
    source: Extract<
      CourseMonitoringEventSource,
      "SEARCH_WORKFLOW" | "RECOVERY_CRON"
    >;
  },
) {
  const attemptLedgerFingerprint = createHash("sha256")
    .update(
      stableCourseProviderExecutionEvidenceValue(
        input.incident.attemptLedger ?? null,
      ),
    )
    .digest("hex");
  const idempotencyKey = `course-monitoring-incomplete-endpoint-retry:${input.incident.id}:${input.incident.cycle}:${attemptLedgerFingerprint}:${input.playbookAssessment.nextStage}`;
  const priorRecovery = await transaction.courseMonitoringEvent.findUnique({
    where: { idempotencyKey },
    select: { id: true },
  });
  if (priorRecovery) return false;

  const nextDeadlineAt = getCourseMonitoringEscalationDeadline(
    input.now,
    input.incident.activeRealSearchCount,
  );
  const incidentUpdated = await transaction.courseSupportIncident.updateMany({
    where: {
      id: input.incident.id,
      courseId: input.courseId,
      cycle: input.incident.cycle,
      revision: input.incident.revision,
      status: "NEEDS_HUMAN",
      humanReviewReason: "AUTOMATION_STALLED",
      activeBatchId: null,
      nextAttemptAt: null,
      escalationDeadlineAt: input.incident.escalationDeadlineAt,
      escalatedAt: input.incident.escalatedAt,
    },
    data: {
      status: "AUTO_INVESTIGATING",
      humanReviewReason: null,
      escalationDeadlineAt: nextDeadlineAt,
      nextReminderAt: null,
      nextAttemptAt: input.now,
      nextAction:
        "Continue the next incomplete current-cycle playbook stage before requesting human review.",
      lastSeenAt: input.now,
      revision: { increment: 1 },
    },
  });
  if (incidentUpdated.count !== 1) {
    throw new Error(
      "The incomplete course incident changed while its automatic endpoint continuation was reopened.",
    );
  }
  const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
    where: {
      courseId: input.courseId,
      state: "ENGINEERING_VERIFICATION_NEEDED",
      stateChangedAt: input.monitoringStatus.stateChangedAt,
      revision: input.monitoringStatus.revision,
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
    },
    data: {
      state: "AUTO_INVESTIGATING",
      nextAutomaticAttemptAt: input.now,
      revalidationRequestedAt: input.now,
      stateChangedAt: input.now,
      revision: { increment: 1 },
    },
  });
  if (statusUpdated.count !== 1) {
    throw new Error(
      "The incomplete course monitoring state changed while its automatic endpoint continuation was reopened.",
    );
  }
  if (input.incident.activeRealSearchCount > 0) {
    await queueActiveRealSearchesForCourse(
      transaction,
      input.courseId,
      input.now,
    );
  }
  await appendMonitoringEvent(transaction, {
    courseId: input.courseId,
    incidentId: input.incident.id,
    eventType: "REVALIDATION_REQUESTED",
    source: input.source,
    fromState: input.monitoringStatus.state,
    toState: "AUTO_INVESTIGATING",
    failureFingerprint: input.incident.failureFingerprint,
    message:
      "The watchdog resumed the next incomplete current-cycle playbook stage from durable evidence.",
    idempotencyKey,
    occurredAt: input.now,
    audit: {
      action: "resume_incomplete_automation_stalled_playbook",
      cycle: input.incident.cycle,
      playbookVersion: input.playbookAssessment.version,
      playbookConclusion: input.playbookAssessment.conclusion,
      playbookCompletedStageCount:
        input.playbookAssessment.completedStages.length,
      nextStage: input.playbookAssessment.nextStage,
      attemptLedgerFingerprint,
      priorEndpointAt: input.endpointEvent.occurredAt.toISOString(),
      nextEscalationDeadlineAt: nextDeadlineAt.toISOString(),
      sameCycleRecovery: true,
      oneShotPerEvidenceSnapshot: true,
      preservesAttemptLedger: true,
      preservesAttemptCount: true,
      preservesOperatorEvidence: true,
      customerDataIncluded: false,
    },
  });
  return true;
}

async function persistAutomationStalledEndpoint(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    incident: DeadlineIncidentSnapshot;
    monitoringStatus: DeadlineMonitoringStatusSnapshot;
    playbookAssessment: ReturnType<typeof assessAutomationPlaybook>;
    expectedActiveBatchId: string | null;
    endpointAt: Date;
    existingDurableParkingProof?: boolean;
    source: Extract<
      CourseMonitoringEventSource,
      "SEARCH_WORKFLOW" | "RECOVERY_CRON"
    >;
  },
) {
  const idempotencyKey = createDeadlineStallIdempotencyKey({
    courseId: input.courseId,
    incidentId: input.incident.id,
    cycle: input.incident.cycle,
    escalationDeadlineAt: input.incident.escalationDeadlineAt,
  });
  const parkingIdempotencyKey = `${idempotencyKey}:parked`;
  const endpointEventSelect = {
    id: true,
    incidentId: true,
    eventType: true,
    occurredAt: true,
    audit: true,
  } as const;
  const [priorEndpoint, priorParkingUpgrade] = await Promise.all([
    transaction.courseMonitoringEvent.findUnique({
      where: { idempotencyKey },
      select: endpointEventSelect,
    }),
    transaction.courseMonitoringEvent.findUnique({
      where: { idempotencyKey: parkingIdempotencyKey },
      select: endpointEventSelect,
    }),
  ]);
  const endpointAt =
    priorEndpoint?.occurredAt ??
    priorParkingUpgrade?.occurredAt ??
    input.endpointAt;
  const priorEndpointHasDurableParking = hasDurableWaitForMaterialChangeProof({
    incidentId: input.incident.id,
    incidentCycle: input.incident.cycle,
    incidentStatus: input.incident.status,
    humanReviewReason: input.incident.humanReviewReason,
    incidentEscalatedAt: input.incident.escalatedAt,
    escalationDeadlineAt: input.incident.escalationDeadlineAt,
    monitoringState: input.monitoringStatus.state,
    endpointEvents: [priorEndpoint, priorParkingUpgrade].filter(
      (event) => event !== null,
    ),
  });
  const durableParkingProofExists = Boolean(
    input.existingDurableParkingProof || priorEndpointHasDurableParking,
  );
  const endpointAlreadyApplied = Boolean(
    durableParkingProofExists &&
    input.expectedActiveBatchId === null &&
    input.incident.activeBatchId === null &&
    input.incident.status === "NEEDS_HUMAN" &&
    input.incident.humanReviewReason === "AUTOMATION_STALLED" &&
    input.incident.nextAttemptAt === null &&
    input.incident.escalatedAt?.getTime() === endpointAt.getTime() &&
    input.monitoringStatus.state === "ENGINEERING_VERIFICATION_NEEDED" &&
    input.monitoringStatus.nextAutomaticAttemptAt === null &&
    input.monitoringStatus.revalidationRequestedAt === null &&
    input.monitoringStatus.stateChangedAt?.getTime() === endpointAt.getTime(),
  );
  if (endpointAlreadyApplied) {
    return { endpointAt, alreadyApplied: true };
  }

  const incidentUpdated = await transaction.courseSupportIncident.updateMany({
    where: {
      id: input.incident.id,
      courseId: input.courseId,
      cycle: input.incident.cycle,
      revision: input.incident.revision,
      status: input.incident.status,
      activeBatchId: input.expectedActiveBatchId,
    },
    data: {
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      humanReviewReason: "AUTOMATION_STALLED",
      escalatedAt: endpointAt,
      nextReminderAt: endpointAt,
      nextAttemptAt: null,
      nextAction:
        "Wait for a material provider, failure, reader-capability, relevant implementation, or operator change before retrying.",
      revision: { increment: 1 },
    },
  });
  if (incidentUpdated.count !== 1) {
    throw new Error(
      "The course incident changed while its automation-stalled endpoint was reconciled.",
    );
  }
  const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
    where: {
      courseId: input.courseId,
      state: input.monitoringStatus.state,
      stateChangedAt: input.monitoringStatus.stateChangedAt,
      revision: input.monitoringStatus.revision,
    },
    data: {
      state: "ENGINEERING_VERIFICATION_NEEDED",
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
      stateChangedAt: endpointAt,
      revision: { increment: 1 },
    },
  });
  if (statusUpdated.count !== 1) {
    throw new Error(
      "The course monitoring status changed while its automation-stalled endpoint was reconciled.",
    );
  }
  if (!durableParkingProofExists) {
    await appendMonitoringEvent(transaction, {
      courseId: input.courseId,
      incidentId: input.incident.id,
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: input.source,
      fromState: input.monitoringStatus.state,
      toState: "ENGINEERING_VERIFICATION_NEEDED",
      failureFingerprint: input.incident.failureFingerprint,
      message:
        "The endpoint deadline arrived before the bounded automated playbook could finish.",
      idempotencyKey: priorEndpoint ? parkingIdempotencyKey : idempotencyKey,
      occurredAt: endpointAt,
      audit: {
        cycle: input.incident.cycle,
        activeDemand: input.incident.activeRealSearchCount > 0,
        customerState: "NEEDS_HUMAN_REVIEW",
        playbookVersion: input.playbookAssessment.version,
        playbookConclusion: input.playbookAssessment.conclusion,
        playbookExhausted: false,
        automationStalled: true,
        parkedUntilMaterialChange: true,
        nextStage: input.playbookAssessment.nextStage,
        escalationDeadlineAt:
          input.incident.escalationDeadlineAt?.toISOString() ?? null,
        customerDataIncluded: false,
      },
    });
  }
  return { endpointAt, alreadyApplied: false };
}

async function persistExhaustedHumanReviewEndpoint(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    incident: DeadlineIncidentSnapshot;
    monitoringStatus: DeadlineMonitoringStatusSnapshot;
    bookingAccessMode?: string | null;
    automationReason?: string | null;
    expectedActiveBatchId: string;
    endpointAt: Date;
    source: Extract<
      CourseMonitoringEventSource,
      "SEARCH_WORKFLOW" | "RECOVERY_CRON"
    >;
  },
) {
  const humanReviewReason = inferHumanReviewReason({
    kind: input.incident.kind,
    failureClass: input.incident.failureClass,
    bookingAccessMode: input.bookingAccessMode,
    automationReason: input.automationReason,
  });
  const retryAt = getHumanReviewRetryAt(
    input.endpointAt,
    input.incident.activeRealSearchCount,
  );
  const incidentUpdated = await transaction.courseSupportIncident.updateMany({
    where: {
      id: input.incident.id,
      courseId: input.courseId,
      cycle: input.incident.cycle,
      revision: input.incident.revision,
      status: input.incident.status,
      activeBatchId: input.expectedActiveBatchId,
    },
    data: {
      status: "NEEDS_HUMAN",
      activeBatchId: null,
      humanReviewReason,
      escalatedAt: input.incident.escalatedAt ?? input.endpointAt,
      nextReminderAt: input.endpointAt,
      nextAttemptAt: retryAt,
      revision: { increment: 1 },
    },
  });
  if (incidentUpdated.count !== 1) {
    throw new Error(
      "The exhausted course incident changed during stale batch endpoint reconciliation.",
    );
  }
  const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
    where: {
      courseId: input.courseId,
      state: input.monitoringStatus.state,
      stateChangedAt: input.monitoringStatus.stateChangedAt,
      revision: input.monitoringStatus.revision,
    },
    data: {
      state: "ENGINEERING_VERIFICATION_NEEDED",
      nextAutomaticAttemptAt: retryAt,
      revalidationRequestedAt: null,
      stateChangedAt: input.endpointAt,
      revision: { increment: 1 },
    },
  });
  if (statusUpdated.count !== 1) {
    throw new Error(
      "The exhausted course monitoring state changed during stale batch endpoint reconciliation.",
    );
  }
  if (input.incident.activeRealSearchCount > 0) {
    await queueActiveRealSearchesForCourse(
      transaction,
      input.courseId,
      input.endpointAt,
    );
  }
  const playbookAssessment = assessAutomationPlaybook(
    input.incident.attemptLedger,
    input.incident.cycle,
  );
  await appendMonitoringEvent(transaction, {
    courseId: input.courseId,
    incidentId: input.incident.id,
    eventType: "HUMAN_REVIEW_REQUESTED",
    source: input.source,
    fromState: input.monitoringStatus.state,
    toState: "ENGINEERING_VERIFICATION_NEEDED",
    failureFingerprint: input.incident.failureFingerprint,
    message:
      "The bounded automated playbook ended without fresh runnable proof.",
    occurredAt: input.endpointAt,
    audit: {
      cycle: input.incident.cycle,
      activeDemand: input.incident.activeRealSearchCount > 0,
      customerState: "NEEDS_HUMAN_REVIEW",
      playbookVersion: playbookAssessment.version,
      playbookConclusion: playbookAssessment.conclusion,
      playbookExhausted: true,
      automationStalled: false,
      nextStage: playbookAssessment.nextStage,
      escalationDeadlineAt:
        input.incident.escalationDeadlineAt?.toISOString() ?? null,
      automaticRecheckHours: 6,
      customerDataIncluded: false,
    },
  });
}

async function fenceAndLoadFreshBatchSuccessProbes(
  transaction: Prisma.TransactionClient,
  input: {
    batch: DeadlineBatchSnapshot;
    now: Date;
  },
) {
  const courseIds = [
    ...new Set(input.batch.incidents.map((entry) => entry.courseId)),
  ].sort();

  /*
   * CourseProbe inserts take a foreign-key KEY SHARE lock on the referenced
   * Course row. Taking the stronger row lock in stable order therefore waits
   * for an in-flight insert and prevents a new insert until this transaction
   * commits. The reads below are consequently the final pre-closeout view:
   * a success that began before this fence is adopted, while a later success
   * serializes after the endpoint decision and repairs it normally.
   */
  await transaction.$queryRaw(
    Prisma.sql`SELECT "id"
               FROM "Course"
               WHERE "id" IN (${Prisma.join(courseIds)})
               ORDER BY "id"
               FOR UPDATE`,
  );

  const probes = await Promise.all(
    input.batch.incidents.map(async (entry) => {
      const probe = await transaction.courseProbe.findFirst({
        where: {
          courseId: entry.courseId,
          outcome: { in: ["MATCH_FOUND", "NO_MATCH"] },
          observedAt: {
            gt: entry.incident.lastSeenAt,
            lte: input.now,
          },
          teeSearch: {
            status: "ACTIVE",
            trafficClass: {
              notIn: [...syntheticWebsiteTrafficClasses],
            },
          },
        },
        orderBy: [{ observedAt: "desc" }, { id: "desc" }],
        select: {
          outcome: true,
          observedAt: true,
          runtimeVersion: true,
        },
      });
      return [entry.incidentId, probe] as const;
    }),
  );

  const probeByIncidentId = new Map<
    string,
    DeadlineBatchIncidentSnapshot["course"]["probes"][number]
  >();
  for (const [incidentId, probe] of probes) {
    if (probe) {
      probeByIncidentId.set(incidentId, probe);
    }
  }
  return probeByIncidentId;
}

async function reconcileStaleBatchOwnershipAtEndpoint(
  transaction: Prisma.TransactionClient,
  input: {
    batch: DeadlineBatchSnapshot;
    currentCourseId: string;
    currentIncidentId: string;
    now: Date;
    source: Extract<
      CourseMonitoringEventSource,
      "SEARCH_WORKFLOW" | "RECOVERY_CRON"
    >;
  },
) {
  const { batch } = input;
  const activeIncidentIds = new Set(
    batch.activeIncidents.map((incident) => incident.id),
  );
  const activeEntries = batch.incidents.filter((entry) =>
    activeIncidentIds.has(entry.incidentId),
  );
  const currentEntry = activeEntries.find(
    (entry) =>
      entry.incidentId === input.currentIncidentId &&
      entry.courseId === input.currentCourseId,
  );
  const batchHasUniqueEntryIdentity =
    new Set(batch.incidents.map((entry) => entry.id)).size ===
      batch.incidents.length &&
    new Set(batch.incidents.map((entry) => entry.incidentId)).size ===
      batch.incidents.length &&
    new Set(batch.incidents.map((entry) => entry.courseId)).size ===
      batch.incidents.length;
  const boundedAndComplete =
    batch.incidents.length > 0 &&
    batch.activeIncidents.length > 0 &&
    batch.activeIncidents.length <= MAX_COURSE_SUPPORT_BATCH_INCIDENTS &&
    batch.incidents.length <= MAX_COURSE_SUPPORT_BATCH_INCIDENTS &&
    activeIncidentIds.size === batch.activeIncidents.length &&
    batchHasUniqueEntryIdentity &&
    batch.incidents.every(
      (entry) =>
        entry.incident.id === entry.incidentId &&
        entry.incident.courseId === entry.courseId &&
        entry.incident.cycle === entry.cycle &&
        (entry.incident.activeBatchId === batch.id ||
          entry.incident.activeBatchId === null) &&
        entry.course.monitoringStatus !== null,
    ) &&
    activeEntries.length === batch.activeIncidents.length &&
    activeEntries.every(
      (entry) =>
        entry.incident.id === entry.incidentId &&
        entry.incident.courseId === entry.courseId &&
        entry.incident.cycle === entry.cycle &&
        entry.incident.activeBatchId === batch.id,
    );
  if (!boundedAndComplete || !currentEntry) {
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
    };
  }

  const batchWasActive = ACTIVE_COURSE_SUPPORT_BATCH_STATUSES.has(batch.status);
  const batchLifecycleIsCoherent = batchWasActive
    ? batch.completedAt === null
    : batch.completedAt !== null;
  if (!batchLifecycleIsCoherent) {
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
    };
  }
  const shouldCloseBatch = batchWasActive && batch.completedAt === null;
  if (shouldCloseBatch && batch.leaseExpiresAt >= input.now) {
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
    };
  }

  const searchExecutionFenceInput =
    createCourseSupportSearchExecutionFenceInput({
      batchId: batch.id,
      courseIds: batch.incidents.map((entry) => entry.courseId),
      summary: batch.summary,
      recheckDispatchKey: batch.recheckDispatchKey,
      recheckDispatchStartedAt: batch.recheckDispatchStartedAt,
      recheckDispatchedAt: batch.recheckDispatchedAt,
      now: input.now,
    });
  await lockCourseSupportSearchExecutionFenceRows(
    transaction,
    searchExecutionFenceInput,
  );
  const freshSuccessProbeByIncidentId =
    await fenceAndLoadFreshBatchSuccessProbes(transaction, {
      batch,
      now: input.now,
    });
  const currentSearchExecutionFence =
    await readCourseSupportSearchExecutionFence(
      transaction,
      searchExecutionFenceInput,
    );
  const persistedSearchExecutionFence =
    readPersistedCourseSupportSearchExecutionFence(
      asMonitoringJsonRecord(batch.summary).searchExecutionFence,
    );
  const searchExecutionFenceMatches = Boolean(
    persistedSearchExecutionFence &&
    courseSupportSearchExecutionFenceMatches(
      persistedSearchExecutionFence,
      currentSearchExecutionFence,
    ),
  );
  const firstPostDispatchSearchExecutionFence = Boolean(
    persistedSearchExecutionFence &&
    persistedSearchExecutionFence.batchSearchCount === 0 &&
    persistedSearchExecutionFence.memberships.length === 0,
  );
  const searchExecutionFenceCanAdvance = Boolean(
    persistedSearchExecutionFence &&
    currentSearchExecutionFence.settled &&
    (firstPostDispatchSearchExecutionFence ||
      canAdvanceCourseSupportSearchExecutionFence(
        persistedSearchExecutionFence,
        currentSearchExecutionFence,
      )),
  );
  const searchExecutionMayHaveStartedCourseRefs = new Set(
    getCourseSupportSearchExecutionMayHaveStartedCourseRefs(
      persistedSearchExecutionFence,
      currentSearchExecutionFence,
    ),
  );
  const searchExecutionAttemptRequiresPersistence = batch.incidents.some(
    (entry) => {
      const courseRef = createHash("sha256")
        .update(entry.courseId)
        .digest("hex")
        .slice(0, 24);
      return (
        searchExecutionMayHaveStartedCourseRefs.has(courseRef) &&
        !readCourseSupportReleaseExecutionEvidence({
          summary: batch.summary,
          baseSha: batch.baseSha,
          courseRef,
        }).providerExecutionAttemptEverForCourse
      );
    },
  );
  const searchExecutionFenceRequiresAdvancement =
    !searchExecutionFenceMatches && searchExecutionFenceCanAdvance;
  if (
    shouldCloseBatch &&
    (searchExecutionAttemptRequiresPersistence ||
      searchExecutionFenceRequiresAdvancement) &&
    (searchExecutionFenceMatches || searchExecutionFenceCanAdvance)
  ) {
    const summary = asMonitoringJsonRecord(batch.summary);
    const executionEver = buildCourseSupportExecutionEverSummary({
      summary: batch.summary,
      baseSha: batch.baseSha,
      previousReleaseSha: batch.releaseSha ?? batch.baseSha,
      previousDeployedAt: batch.deployedAt,
      previousIncidentVerifications: batch.incidents.map((entry, index) => ({
        ordinal: index + 1,
        courseRef: createHash("sha256")
          .update(entry.courseId)
          .digest("hex")
          .slice(0, 24),
        providerExecutionRecorded: false,
        providerExecutionAttemptRecorded:
          searchExecutionMayHaveStartedCourseRefs.has(
            createHash("sha256")
              .update(entry.courseId)
              .digest("hex")
              .slice(0, 24),
          ),
        terminalExecutionRecorded: false,
      })),
    });
    const executionPersisted = await transaction.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
        revision: batch.revision,
        heartbeatAt: batch.heartbeatAt,
        leaseExpiresAt: batch.leaseExpiresAt,
        completedAt: null,
        AND: [{ leaseExpiresAt: { lt: input.now } }],
      },
      data: {
        summary: {
          ...summary,
          executionEver,
          searchExecutionFence: persistCourseSupportSearchExecutionFence(
            {
              ...currentSearchExecutionFence,
              searchExecutionMayHaveStartedCourseRefs: [
                ...searchExecutionMayHaveStartedCourseRefs,
              ].sort(),
            },
            input.now,
          ),
        } as Prisma.InputJsonValue,
        revision: { increment: 1 },
      },
    });
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
      executionAttemptPersisted: executionPersisted.count === 1,
    };
  }
  if (shouldCloseBatch && !searchExecutionFenceMatches) {
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
    };
  }

  type StaleOwnerDisposition =
    | "STALLED_ENDPOINT"
    | "EXHAUSTED_ENDPOINT"
    | "AUTHORITATIVE_STATE"
    | "AUTHORITATIVE_PROBE"
    | "TERMINAL_HUMAN"
    | "TERMINAL_RESOLVED"
    | "RETRY";
  const dispositionByIncidentId = new Map<
    string,
    {
      disposition: StaleOwnerDisposition;
      result: CourseSupportBatchIncidentResult;
      orchestrationOnly?: boolean;
      incompletePlaybook?: boolean;
      resolution?: CourseSupportResolution;
      successProbe?: DeadlineBatchIncidentSnapshot["course"]["probes"][number];
    }
  >();
  const releaseHistoryOrdinalByBatchIncidentId = new Map(
    batch.incidents.map((entry, index) => [entry.id, index + 1]),
  );
  for (const entry of batch.incidents) {
    const incident = entry.incident;
    // The bounded gate above requires this snapshot. Keeping the local guard
    // makes the evidence ordering explicit to TypeScript and future readers.
    const monitoringStatus = entry.course.monitoringStatus;
    if (!monitoringStatus) {
      return {
        outcome: "OWNED" as const,
        incidentId: input.currentIncidentId,
      };
    }
    const authoritativeResolution =
      monitoringStatus?.state === "HEALTHY"
        ? ("MONITORING_RESTORED" as const)
        : monitoringStatus?.state === "FINAL_MANUAL"
          ? ("DIRECT_BOOKING_CLASSIFIED" as const)
          : monitoringStatus?.state === "FINAL_IDENTITY"
            ? ("IDENTITY_CLASSIFIED" as const)
            : monitoringStatus?.state === "FINAL_TECHNICAL"
              ? ("TECHNICAL_LIMITATION_CLASSIFIED" as const)
              : null;
    if (authoritativeResolution) {
      dispositionByIncidentId.set(incident.id, {
        disposition: "AUTHORITATIVE_STATE",
        result:
          authoritativeResolution === "MONITORING_RESTORED"
            ? "RESTORED"
            : "FINAL_DISPOSITION",
        resolution: authoritativeResolution,
      });
      continue;
    }
    const successProbe = freshSuccessProbeByIncidentId.get(incident.id);
    if (successProbe) {
      dispositionByIncidentId.set(incident.id, {
        disposition: "AUTHORITATIVE_PROBE",
        result: "RESTORED",
        resolution: "MONITORING_RESTORED",
        successProbe,
      });
      continue;
    }
    if (
      incident.status === "RESOLVED" &&
      incident.resolvedAt &&
      incident.resolution
    ) {
      dispositionByIncidentId.set(incident.id, {
        disposition: "TERMINAL_RESOLVED",
        result:
          incident.resolution === "MONITORING_RESTORED"
            ? "RESTORED"
            : "FINAL_DISPOSITION",
      });
      continue;
    }
    if (
      incident.status === "NEEDS_HUMAN" &&
      incident.humanReviewReason !== null &&
      incident.escalatedAt !== null &&
      isAutomationHumanReviewProofCurrentOrPrior(
        incident.attemptLedger,
        incident.cycle,
      )
    ) {
      dispositionByIncidentId.set(incident.id, {
        disposition: "TERMINAL_HUMAN",
        result: "NEEDS_HUMAN",
      });
      continue;
    }
    const dueEndpoint = Boolean(
      incident.activeBatchId === batch.id &&
      shouldCloseBatch &&
      incident.escalationDeadlineAt &&
      incident.escalationDeadlineAt <= input.now,
    );
    if (dueEndpoint) {
      const playbookAssessment = assessAutomationPlaybook(
        incident.attemptLedger,
        incident.cycle,
      );
      const historicalExecution = readCourseSupportReleaseExecutionEvidence({
        summary: batch.summary,
        baseSha: batch.baseSha,
        courseRef: createHash("sha256")
          .update(entry.courseId)
          .digest("hex")
          .slice(0, 24),
        legacyOrdinal: releaseHistoryOrdinalByBatchIncidentId.get(entry.id),
      });
      const orchestrationOnly = Boolean(
        batch.deployedAt === null &&
        !historicalExecution.changedReleaseDeploymentEver &&
        !historicalExecution.providerExecutionEverForCourse &&
        !historicalExecution.providerExecutionAttemptEverForCourse &&
        !historicalExecution.terminalExecutionEverForCourse &&
        asMonitoringJsonRecord(entry.proofSnapshot).providerExecution !==
          true &&
        entry.verificationRequests.every((request) =>
          isCourseSupportVerificationRequestUnstarted(request),
        ) &&
        playbookAssessment.completedStages.length === 0 &&
        areCourseSupportCompletedAttemptsOrchestrationOnly({
          courseId: entry.courseId,
          cycle: incident.cycle,
          entries: incident.batchIncidents ?? [],
          allowEmpty: true,
        }),
      );
      if (
        playbookAssessment.valid === true &&
        playbookAssessment.cycle === incident.cycle &&
        playbookAssessment.conclusion === "INCOMPLETE" &&
        playbookAssessment.nextStage !== null
      ) {
        dispositionByIncidentId.set(incident.id, {
          disposition: "RETRY",
          result: "RETRY_SCHEDULED",
          orchestrationOnly,
          incompletePlaybook: true,
        });
        continue;
      }
      if (orchestrationOnly) {
        dispositionByIncidentId.set(incident.id, {
          disposition: "RETRY",
          result: "RETRY_SCHEDULED",
          orchestrationOnly: true,
        });
        continue;
      }
      dispositionByIncidentId.set(incident.id, {
        disposition: isAutomationPlaybookExhausted(
          incident.attemptLedger,
          incident.cycle,
        )
          ? "EXHAUSTED_ENDPOINT"
          : "STALLED_ENDPOINT",
        result: "NEEDS_HUMAN",
      });
      continue;
    }
    dispositionByIncidentId.set(incident.id, {
      disposition: "RETRY",
      result: "RETRY_SCHEDULED",
    });
  }

  const finalResultByEntryId = new Map(
    batch.incidents.map((entry) => [
      entry.id,
      shouldCloseBatch
        ? dispositionByIncidentId.get(entry.incidentId)!.result
        : entry.result,
    ]),
  );
  const finalResults = [...finalResultByEntryId.values()];
  if (
    finalResults.some(
      (result) => result === "PENDING" || result === "STALE_EVIDENCE",
    )
  ) {
    return {
      outcome: "OWNED" as const,
      incidentId: input.currentIncidentId,
    };
  }
  const orchestrationOnlyEntries = shouldCloseBatch
    ? batch.incidents.filter(
        (entry) =>
          dispositionByIncidentId.get(entry.incidentId)?.orchestrationOnly ===
          true,
      )
    : [];
  const effectiveReleaseSha = batch.releaseSha ?? batch.baseSha;
  for (const entry of orchestrationOnlyEntries) {
    for (const request of entry.verificationRequests) {
      const requestUnchanged =
        await transaction.courseSupportVerificationRequest.updateMany({
          where: {
            id: request.id,
            batchIncidentId: request.batchIncidentId,
            releaseSha: request.releaseSha,
            status: request.status,
            revision: request.revision,
            attemptCount: request.attemptCount,
            startedAt: null,
            outcome: request.outcome,
            failureClass: request.failureClass,
            lastError: request.lastError,
          },
          data: { revision: { increment: 0 } },
        });
      if (requestUnchanged.count !== 1) {
        return {
          outcome: "OWNED" as const,
          incidentId: input.currentIncidentId,
        };
      }
    }
    if (
      !entry.verificationRequests.some(
        (request) => request.releaseSha === effectiveReleaseSha,
      )
    ) {
      const lateRequest =
        await transaction.courseSupportVerificationRequest.findFirst({
          where: {
            batchIncidentId: entry.id,
            releaseSha: effectiveReleaseSha,
          },
          select: { id: true },
        });
      if (lateRequest) {
        return {
          outcome: "OWNED" as const,
          incidentId: input.currentIncidentId,
        };
      }
    }
  }
  const needsHumanCount = finalResults.filter(
    (result) => result === "NEEDS_HUMAN",
  ).length;
  const retryCount = finalResults.filter(
    (result) => result === "RETRY_SCHEDULED",
  ).length;
  const restoredCount = finalResults.filter(
    (result) => result === "RESTORED",
  ).length;
  const finalDispositionCount = finalResults.filter(
    (result) => result === "FINAL_DISPOSITION",
  ).length;
  const terminalCount = restoredCount + finalDispositionCount;
  const endpointCount = [...dispositionByIncidentId.values()].filter(
    (entry) =>
      entry.disposition === "STALLED_ENDPOINT" ||
      entry.disposition === "EXHAUSTED_ENDPOINT",
  ).length;
  const automationStalledCount = [...dispositionByIncidentId.values()].filter(
    (entry) => entry.disposition === "STALLED_ENDPOINT",
  ).length;
  const exhaustedEndpointCount = [...dispositionByIncidentId.values()].filter(
    (entry) => entry.disposition === "EXHAUSTED_ENDPOINT",
  ).length;
  const orchestrationRetryCount = [...dispositionByIncidentId.values()].filter(
    (entry) =>
      entry.disposition === "RETRY" && entry.orchestrationOnly === true,
  ).length;
  const batchStatus: CourseSupportBatchStatus =
    needsHumanCount > 0 || (retryCount > 0 && terminalCount > 0)
      ? "PARTIAL"
      : retryCount === finalResults.length
        ? "RETRYABLE_FAILED"
        : "SUCCEEDED";
  const derivedOutcome =
    needsHumanCount > 0
      ? ("needs_human" as const)
      : retryCount === finalResults.length
        ? ("retryable_failed" as const)
        : retryCount > 0
          ? ("partial" as const)
          : finalDispositionCount === finalResults.length
            ? ("classification_only" as const)
            : ("success" as const);
  if (!shouldCloseBatch) {
    const closeout = asMonitoringJsonRecord(
      asMonitoringJsonRecord(batch.summary).closeout,
    );
    const closeoutOutcome =
      typeof closeout.outcome === "string" && closeout.outcome.length > 0
        ? closeout.outcome
        : null;
    const terminalBatchIsCoherent =
      batch.status === batchStatus &&
      batch.incidents.every(
        (entry) =>
          dispositionByIncidentId.get(entry.incidentId)?.result ===
          entry.result,
      ) &&
      closeoutOutcome !== null &&
      closeout.derivedOutcome === derivedOutcome &&
      closeout.terminalCount === terminalCount &&
      closeout.retryCount === retryCount &&
      closeout.needsHumanCount === needsHumanCount &&
      closeout.automationStalledCount === automationStalledCount &&
      typeof closeout.failureDomain === "string" &&
      closeout.failureDomain.length > 0 &&
      typeof closeout.verificationWatchMode === "string" &&
      closeout.verificationWatchMode.length > 0;
    if (!terminalBatchIsCoherent) {
      return {
        outcome: "OWNED" as const,
        incidentId: input.currentIncidentId,
      };
    }
    if (batch.ownerAutomationRunId) {
      const ownerRun = batch.ownerAutomationRun;
      const ownerRunNotes = parseMonitoringAutomationRunNotes(ownerRun?.notes);
      const ownerRunIsCoherent = Boolean(
        ownerRun &&
        ownerRun.id === batch.ownerAutomationRunId &&
        (ownerRun.kind === "COURSE_SUPPORT" || ownerRun.kind === "OTHER") &&
        (ownerRun.status === "COMPLETED" ||
          ownerRun.status === "FAILED" ||
          ownerRun.status === "RUNNING") &&
        ownerRun.completedAt?.getTime() === batch.completedAt?.getTime() &&
        ownerRun.outcome === closeoutOutcome &&
        ownerRunNotes.schemaVersion === 1 &&
        ownerRunNotes.lifecycle === "closeout" &&
        ownerRunNotes.status === batch.status &&
        ownerRunNotes.outcome === closeoutOutcome &&
        ownerRunNotes.derivedOutcome === derivedOutcome &&
        ownerRunNotes.terminalCount === terminalCount &&
        ownerRunNotes.retryCount === retryCount &&
        ownerRunNotes.automationStalledCount === automationStalledCount &&
        ownerRunNotes.failureDomain === closeout.failureDomain &&
        ownerRunNotes.verificationWatchMode === closeout.verificationWatchMode,
      );
      if (!ownerRunIsCoherent || !ownerRun) {
        return {
          outcome: "OWNED" as const,
          incidentId: input.currentIncidentId,
        };
      }
      const ownerRunConfirmed = await transaction.automationRun.updateMany({
        where: {
          id: ownerRun.id,
          kind: ownerRun.kind,
          status: ownerRun.status,
          completedAt: ownerRun.completedAt,
          outcome: ownerRun.outcome,
          notes: ownerRun.notes,
        },
        data: {
          kind: "COURSE_SUPPORT",
          status: ownerRun.status === "FAILED" ? "FAILED" : "COMPLETED",
          outcome: ownerRun.outcome,
        },
      });
      if (ownerRunConfirmed.count !== 1) {
        return {
          outcome: "OWNED" as const,
          incidentId: input.currentIncidentId,
        };
      }
    } else if (batch.ownerAutomationRun) {
      return {
        outcome: "OWNED" as const,
        incidentId: input.currentIncidentId,
      };
    }
  }
  if (shouldCloseBatch) {
    const summary = asMonitoringJsonRecord(batch.summary);
    const batchUpdated = await transaction.courseSupportBatch.updateMany({
      where: {
        id: batch.id,
        status: batch.status,
        revision: batch.revision,
        heartbeatAt: batch.heartbeatAt,
        leaseExpiresAt: batch.leaseExpiresAt,
        completedAt: null,
        AND: [{ leaseExpiresAt: { lt: input.now } }],
      },
      data: {
        status: batchStatus,
        completedAt: input.now,
        heartbeatAt: input.now,
        leaseExpiresAt: input.now,
        summary: {
          ...summary,
          closeout: {
            outcome: derivedOutcome,
            derivedOutcome,
            terminalCount,
            restoredCount,
            finalDispositionCount,
            retryCount,
            needsHumanCount,
            endpointCount,
            automationStalledCount,
            exhaustedEndpointCount,
            orchestrationRetryCount,
            orchestrationOnlyCourseRefs: batch.incidents.flatMap((entry) => {
              const disposition = dispositionByIncidentId.get(entry.incidentId);
              return disposition?.orchestrationOnly
                ? [
                    createHash("sha256")
                      .update(entry.courseId)
                      .digest("hex")
                      .slice(0, 24),
                  ]
                : [];
            }),
            failureDomain: "SLA",
            verificationWatchMode: "ENDPOINT",
            reason: "stale_endpoint_ownership_released",
          },
        } as Prisma.InputJsonValue,
        revision: { increment: 1 },
      },
    });
    if (batchUpdated.count !== 1) {
      return {
        outcome: "OWNED" as const,
        incidentId: input.currentIncidentId,
      };
    }
  }

  const retryScheduleByIncidentId = new Map(
    batch.incidents.flatMap((entry) => {
      const planned = dispositionByIncidentId.get(entry.incidentId);
      if (planned?.disposition !== "RETRY") return [];
      if (!planned.orchestrationOnly) {
        return [
          [
            entry.incidentId,
            {
              attemptNumber: 0,
              delayMs: STALE_BATCH_RELEASE_RETRY_MS,
              retryAt: new Date(
                input.now.getTime() + STALE_BATCH_RELEASE_RETRY_MS,
              ),
            },
          ] as const,
        ];
      }
      return [
        [
          entry.incidentId,
          getCourseSupportOrchestrationRetrySchedule({
            now: input.now,
            priorAttemptCount:
              countCourseSupportCompletedOrchestrationOnlyAttempts({
                courseId: entry.courseId,
                cycle: entry.incident.cycle,
                entries: entry.incident.batchIncidents ?? [],
              }),
          }),
        ] as const,
      ];
    }),
  );
  for (const entry of activeEntries) {
    const incident = entry.incident;
    const monitoringStatus = entry.course.monitoringStatus;
    const planned = dispositionByIncidentId.get(incident.id)!;
    if (planned.disposition === "STALLED_ENDPOINT" && monitoringStatus) {
      await persistAutomationStalledEndpoint(transaction, {
        courseId: entry.courseId,
        incident,
        monitoringStatus,
        playbookAssessment: assessAutomationPlaybook(
          incident.attemptLedger,
          incident.cycle,
        ),
        expectedActiveBatchId: batch.id,
        endpointAt: input.now,
        source: input.source,
      });
    } else if (
      planned.disposition === "EXHAUSTED_ENDPOINT" &&
      monitoringStatus
    ) {
      await persistExhaustedHumanReviewEndpoint(transaction, {
        courseId: entry.courseId,
        incident,
        monitoringStatus,
        bookingAccessMode: entry.course.bookingAccessMode,
        automationReason: entry.course.automationReason,
        expectedActiveBatchId: batch.id,
        endpointAt: input.now,
        source: input.source,
      });
    } else if (
      (planned.disposition === "AUTHORITATIVE_STATE" ||
        planned.disposition === "AUTHORITATIVE_PROBE") &&
      planned.resolution
    ) {
      const resolvedAt = planned.successProbe?.observedAt ?? input.now;
      if (planned.disposition === "AUTHORITATIVE_PROBE" && monitoringStatus) {
        const monitoringUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: entry.courseId,
              state: monitoringStatus.state,
              stateChangedAt: monitoringStatus.stateChangedAt,
              revision: monitoringStatus.revision,
            },
            data: {
              state: "HEALTHY",
              lastSuccessfulAt: resolvedAt,
              consecutiveFailures: 0,
              failureFingerprint: null,
              firstDegradedAt: null,
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: resolvedAt,
              revision: { increment: 1 },
            },
          });
        if (monitoringUpdated.count !== 1) {
          throw new Error(
            "A fresh success changed during stale batch ownership release.",
          );
        }
      } else if (
        planned.disposition === "AUTHORITATIVE_STATE" &&
        monitoringStatus
      ) {
        const monitoringConfirmed =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: entry.courseId,
              state: monitoringStatus.state,
              stateChangedAt: monitoringStatus.stateChangedAt,
              revision: monitoringStatus.revision,
            },
            data: { revision: { increment: 0 } },
          });
        if (monitoringConfirmed.count !== 1) {
          throw new Error(
            "Authoritative course monitoring state changed during stale batch ownership release.",
          );
        }
      }
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            courseId: entry.courseId,
            cycle: entry.cycle,
            revision: incident.revision,
            status: incident.status,
            activeBatchId: batch.id,
          },
          data: {
            status: "RESOLVED",
            activeBatchId: null,
            resolvedAt,
            resolution: planned.resolution,
            resolutionMessage:
              planned.disposition === "AUTHORITATIVE_PROBE"
                ? "Reconciled from a fresh successful customer monitoring probe."
                : "Reconciled to the newer authoritative course monitoring state.",
            nextAction: null,
            nextAttemptAt: null,
            nextReminderAt: null,
            lastSeenAt: resolvedAt,
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        throw new Error(
          "Authoritative monitoring evidence changed during stale batch ownership release.",
        );
      }
      if (planned.disposition === "AUTHORITATIVE_PROBE") {
        await appendMonitoringEvent(transaction, {
          courseId: entry.courseId,
          incidentId: incident.id,
          eventType: "CHECK_SUCCEEDED",
          source: input.source,
          fromState: monitoringStatus?.state ?? null,
          toState: "HEALTHY",
          outcome: planned.successProbe?.outcome,
          message:
            "A durable fresh probe was adopted while stale responder ownership was released.",
          runtimeVersion: planned.successProbe?.runtimeVersion,
          occurredAt: input.now,
          audit: {
            recoveredFromProbeCrashBoundary: true,
            customerDataIncluded: false,
          },
        });
        await appendMonitoringEvent(transaction, {
          courseId: entry.courseId,
          incidentId: incident.id,
          eventType: "RECOVERED",
          source: input.source,
          fromState: monitoringStatus?.state ?? null,
          toState: "HEALTHY",
          outcome: planned.successProbe?.outcome,
          message:
            "Fresh public monitoring proof prevented stale deadline escalation.",
          runtimeVersion: planned.successProbe?.runtimeVersion,
          deploymentSha: getAutomaticDeploymentSha(
            input.source,
            planned.successProbe?.runtimeVersion,
          ),
          occurredAt: input.now,
          audit: {
            cycle: incident.cycle,
            confirmedAt: incident.confirmedAt?.toISOString() ?? null,
            automatedFinal: true,
            customerDataIncluded: false,
          },
        });
      }
      if (incident.activeRealSearchCount > 0) {
        await queueActiveRealSearchesForCourse(
          transaction,
          entry.courseId,
          input.now,
        );
      }
    } else {
      const retryable = planned.disposition === "RETRY";
      const retrySchedule = retryScheduleByIncidentId.get(incident.id);
      const retryAt =
        retrySchedule?.retryAt ??
        new Date(input.now.getTime() + STALE_BATCH_RELEASE_RETRY_MS);
      const repairsUnprovenHuman =
        retryable &&
        (planned.incompletePlaybook === true ||
          !isAutomationHumanReviewProofCurrentOrPrior(
            incident.attemptLedger,
            incident.cycle,
          )) &&
        (incident.status === "NEEDS_HUMAN" ||
          incident.humanReviewReason !== null ||
          incident.escalatedAt !== null ||
          incident.nextReminderAt !== null ||
          monitoringStatus?.state === "ENGINEERING_VERIFICATION_NEEDED");
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            courseId: entry.courseId,
            cycle: entry.cycle,
            revision: incident.revision,
            status: incident.status,
            activeBatchId: batch.id,
          },
          data: {
            activeBatchId: null,
            ...(retryable
              ? {
                  ...(repairsUnprovenHuman
                    ? {
                        status: "AUTO_INVESTIGATING" as const,
                        humanReviewReason: null,
                        escalatedAt: null,
                        nextReminderAt: null,
                      }
                    : {}),
                  nextAttemptAt: retryAt,
                  escalationDeadlineAt: planned.incompletePlaybook
                    ? getCourseMonitoringEscalationDeadline(
                        input.now,
                        incident.activeRealSearchCount,
                      )
                    : planned.orchestrationOnly
                      ? null
                      : incident.escalationDeadlineAt,
                  nextAction: planned.incompletePlaybook
                    ? "Continue the next incomplete current-cycle playbook stage after stale responder ownership was released."
                    : planned.orchestrationOnly
                      ? "Retry provider verification because the prior responder ownership expired before execution began."
                      : "Retry the ordered playbook after stale responder ownership was released.",
                }
              : {}),
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        throw new Error(
          "A responder incident changed during stale batch ownership release.",
        );
      }
      if (
        retryable &&
        monitoringStatus &&
        (["UNKNOWN", "DEGRADED_RETRYING", "AUTO_INVESTIGATING"].includes(
          monitoringStatus.state,
        ) ||
          (repairsUnprovenHuman &&
            monitoringStatus.state === "ENGINEERING_VERIFICATION_NEEDED"))
      ) {
        const monitoringUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: entry.courseId,
              state: monitoringStatus.state,
              stateChangedAt: monitoringStatus.stateChangedAt,
              revision: monitoringStatus.revision,
            },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: retryAt,
              revalidationRequestedAt: retryAt,
              stateChangedAt: input.now,
              revision: { increment: 1 },
            },
          });
        if (monitoringUpdated.count !== 1) {
          throw new Error(
            "A course monitoring state changed during stale batch ownership release.",
          );
        }
      }
      if (retryable && incident.activeRealSearchCount > 0) {
        await queueActiveRealSearchesForCourse(
          transaction,
          entry.courseId,
          retryAt,
        );
      }
      if (
        retryable &&
        (planned.orchestrationOnly || planned.incompletePlaybook)
      ) {
        const nextDeadlineAt = planned.incompletePlaybook
          ? getCourseMonitoringEscalationDeadline(
              input.now,
              incident.activeRealSearchCount,
            )
          : null;
        await appendMonitoringEvent(transaction, {
          courseId: entry.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: input.source,
          fromState: monitoringStatus?.state ?? null,
          toState: "AUTO_INVESTIGATING",
          failureFingerprint: incident.failureFingerprint,
          message: planned.incompletePlaybook
            ? "The next incomplete playbook stage was rescheduled after stale responder ownership was released."
            : "Provider verification was rescheduled because the prior responder ownership expired before execution began.",
          idempotencyKey: planned.incompletePlaybook
            ? `course-support-incomplete-playbook-retry:${batch.id}:${entry.id}`
            : `course-support-orchestration-retry:${batch.id}:${entry.id}`,
          occurredAt: input.now,
          audit: {
            action: planned.incompletePlaybook
              ? "continue_incomplete_playbook_after_stale_ownership"
              : "course_support_orchestration_retry",
            cycle: incident.cycle,
            executionStarted: planned.orchestrationOnly ? false : true,
            countsTowardOperationalNoProgress: planned.orchestrationOnly
              ? false
              : true,
            orchestrationAttemptNumber: retrySchedule?.attemptNumber ?? 1,
            retryDelaySeconds: Math.floor(
              (retrySchedule?.delayMs ?? 15 * 60 * 1000) / 1000,
            ),
            retryAt: retryAt.toISOString(),
            playbookConclusion: planned.incompletePlaybook
              ? "INCOMPLETE"
              : null,
            nextStage: planned.incompletePlaybook
              ? assessAutomationPlaybook(incident.attemptLedger, incident.cycle)
                  .nextStage
              : null,
            nextEscalationDeadlineAt: nextDeadlineAt?.toISOString() ?? null,
            preservesAttemptLedger: planned.incompletePlaybook === true,
            preservesOperatorEvidence: planned.incompletePlaybook === true,
            customerDataIncluded: false,
          },
        });
      }
    }

    if (!shouldCloseBatch) {
      continue;
    }
    const batchEntryUpdated =
      await transaction.courseSupportBatchIncident.updateMany({
        where: {
          id: entry.id,
          incidentId: entry.incidentId,
          courseId: entry.courseId,
          cycle: entry.cycle,
          result: entry.result,
          updatedAt: entry.updatedAt,
        },
        data: {
          result: planned.result,
          message:
            planned.disposition === "STALLED_ENDPOINT"
              ? "The responder lease expired before the bounded automation endpoint completed."
              : planned.disposition === "EXHAUSTED_ENDPOINT"
                ? "The responder lease expired after the bounded automation playbook was exhausted."
                : planned.disposition === "RETRY"
                  ? planned.orchestrationOnly
                    ? "Expired responder ownership was released because provider verification never began execution."
                    : "Expired responder ownership was released for a safe automatic retry."
                  : "Expired responder ownership was superseded by authoritative course evidence.",
        },
      });
    if (batchEntryUpdated.count !== 1) {
      throw new Error(
        "Responder batch evidence changed during stale ownership release.",
      );
    }
  }

  if (shouldCloseBatch) {
    for (const entry of batch.incidents) {
      if (activeIncidentIds.has(entry.incidentId)) {
        continue;
      }
      const targetResult = finalResultByEntryId.get(entry.id)!;
      const planned = dispositionByIncidentId.get(entry.incidentId)!;
      const retrySchedule = retryScheduleByIncidentId.get(entry.incidentId);
      const retryAt =
        retrySchedule?.retryAt ??
        new Date(input.now.getTime() + STALE_BATCH_RELEASE_RETRY_MS);
      const repairsUnprovenHuman =
        planned.disposition === "RETRY" &&
        !isAutomationHumanReviewProofCurrentOrPrior(
          entry.incident.attemptLedger,
          entry.incident.cycle,
        ) &&
        (entry.incident.status === "NEEDS_HUMAN" ||
          entry.incident.humanReviewReason !== null ||
          entry.incident.escalatedAt !== null ||
          entry.incident.nextReminderAt !== null ||
          entry.course.monitoringStatus?.state ===
            "ENGINEERING_VERIFICATION_NEEDED");
      if (repairsUnprovenHuman) {
        const incidentUpdated =
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: entry.incidentId,
              courseId: entry.courseId,
              cycle: entry.cycle,
              revision: entry.incident.revision,
              status: entry.incident.status,
              activeBatchId: null,
            },
            data: {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: null,
              escalatedAt: null,
              nextReminderAt: null,
              nextAttemptAt: retryAt,
              escalationDeadlineAt: planned.orchestrationOnly
                ? null
                : entry.incident.escalationDeadlineAt,
              nextAction: planned.orchestrationOnly
                ? "Retry provider verification because the prior responder ownership expired before execution began."
                : "Retry the ordered playbook after stale responder ownership was released.",
              revision: { increment: 1 },
            },
          });
        if (incidentUpdated.count !== 1) {
          throw new Error(
            "Detached human-review evidence changed during stale ownership repair.",
          );
        }
        const monitoringStatus = entry.course.monitoringStatus!;
        const monitoringUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: entry.courseId,
              state: monitoringStatus.state,
              stateChangedAt: monitoringStatus.stateChangedAt,
              revision: monitoringStatus.revision,
            },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: retryAt,
              revalidationRequestedAt: retryAt,
              stateChangedAt: input.now,
              revision: { increment: 1 },
            },
          });
        if (monitoringUpdated.count !== 1) {
          throw new Error(
            "Detached course monitoring changed during stale human-review repair.",
          );
        }
        if (entry.incident.activeRealSearchCount > 0) {
          await queueActiveRealSearchesForCourse(
            transaction,
            entry.courseId,
            retryAt,
          );
        }
        if (planned.orchestrationOnly) {
          await appendMonitoringEvent(transaction, {
            courseId: entry.courseId,
            incidentId: entry.incidentId,
            eventType: "REVALIDATION_REQUESTED",
            source: input.source,
            fromState: monitoringStatus.state,
            toState: "AUTO_INVESTIGATING",
            failureFingerprint: entry.incident.failureFingerprint,
            message:
              "Provider verification was rescheduled because the prior responder ownership expired before execution began.",
            idempotencyKey: `course-support-orchestration-retry:${batch.id}:${entry.id}`,
            occurredAt: input.now,
            audit: {
              action: "course_support_orchestration_retry",
              cycle: entry.incident.cycle,
              executionStarted: false,
              countsTowardOperationalNoProgress: false,
              orchestrationAttemptNumber: retrySchedule?.attemptNumber ?? 1,
              retryDelaySeconds: Math.floor(
                (retrySchedule?.delayMs ?? 15 * 60 * 1000) / 1000,
              ),
              retryAt: retryAt.toISOString(),
              customerDataIncluded: false,
            },
          });
        }
      }
      if (targetResult === entry.result) {
        continue;
      }
      const batchEntryUpdated =
        await transaction.courseSupportBatchIncident.updateMany({
          where: {
            id: entry.id,
            incidentId: entry.incidentId,
            courseId: entry.courseId,
            cycle: entry.cycle,
            result: entry.result,
            updatedAt: entry.updatedAt,
          },
          data: {
            result: targetResult,
            message:
              "Detached responder evidence was reconciled from its durable course decision.",
          },
        });
      if (batchEntryUpdated.count !== 1) {
        throw new Error(
          "Detached responder evidence changed during stale ownership reconciliation.",
        );
      }
    }
  }

  if (shouldCloseBatch) {
    await transaction.courseSupportVerificationRequest.updateMany({
      where: {
        batchIncident: { batchId: batch.id },
        status: { in: ["QUEUED", "CHECKING", "RETRYABLE_FAILED"] },
      },
      data: {
        status: "STALE",
        revision: { increment: 1 },
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        completedAt: input.now,
        lastError: "batch_endpoint_ownership_expired",
        updatedAt: input.now,
      },
    });
  }
  if (shouldCloseBatch && batch.ownerAutomationRunId) {
    const ownerRunUpdated = await transaction.automationRun.updateMany({
      where: { id: batch.ownerAutomationRunId, completedAt: null },
      data: {
        kind: "COURSE_SUPPORT",
        status: orchestrationRetryCount > 0 ? "FAILED" : "COMPLETED",
        completedAt: input.now,
        outcome: derivedOutcome,
        notes: JSON.stringify({
          schemaVersion: 1,
          lifecycle: "closeout",
          status: batchStatus,
          outcome: derivedOutcome,
          derivedOutcome,
          reason: "stale_endpoint_ownership_released",
          endpointCount,
          automationStalledCount,
          exhaustedEndpointCount,
          orchestrationRetryCount,
          failureDomain: "SLA",
          verificationWatchMode: "ENDPOINT",
          terminalCount,
          restoredCount,
          finalDispositionCount,
          retryCount,
          needsHumanCount,
        }),
      },
    });
    if (ownerRunUpdated.count !== 1) {
      throw new Error(
        "The responder automation run changed during stale endpoint closeout.",
      );
    }
  }

  const currentDisposition = dispositionByIncidentId.get(
    input.currentIncidentId,
  )?.disposition;
  if (currentDisposition === "STALLED_ENDPOINT") {
    return {
      outcome: "NEEDS_HUMAN" as const,
      incidentId: input.currentIncidentId,
      parkedUntilMaterialChange: true as const,
    };
  }
  if (currentDisposition === "EXHAUSTED_ENDPOINT") {
    return {
      outcome: "NEEDS_HUMAN" as const,
      incidentId: input.currentIncidentId,
    };
  }
  if (currentDisposition === "TERMINAL_HUMAN") {
    return {
      outcome: "RETAINED_HUMAN" as const,
      incidentId: input.currentIncidentId,
    };
  }
  if (
    currentDisposition === "AUTHORITATIVE_STATE" ||
    currentDisposition === "AUTHORITATIVE_PROBE" ||
    currentDisposition === "TERMINAL_RESOLVED"
  ) {
    return {
      outcome: "AUTHORITATIVE_STATE" as const,
      incidentId: input.currentIncidentId,
    };
  }
  return {
    outcome: "RETRYING" as const,
    incidentId: input.currentIncidentId,
  };
}

export async function runCourseMonitoringWatchdog(now = new Date()) {
  if (!hasMonitoringModels(prisma)) {
    return {
      checked: 0,
      scheduled: 0,
      escalated: 0,
      remindersSent: 0,
    };
  }
  const deadlineReconciliation = await reconcileCourseMonitoringDeadlines({
    now,
    source: "RECOVERY_CRON",
  });
  const statuses = await prisma.courseMonitoringStatus.findMany({
    where: {
      state: { in: [...AUTOMATED_STATES, "FINAL_TECHNICAL"] },
    },
    include: {
      course: {
        select: {
          id: true,
          name: true,
          detectedPlatform: true,
          providerFamilyKey: true,
          detectedBookingUrl: true,
          website: true,
          bookingAccessMode: true,
          automationReason: true,
          timeZone: true,
          supportIncident: true,
          preferences: {
            where: {
              teeSearch: {
                status: "ACTIVE",
                trafficClass: {
                  notIn: [...syntheticWebsiteTrafficClasses],
                },
              },
            },
            select: {
              teeSearch: {
                select: {
                  date: true,
                  createdAt: true,
                },
              },
            },
          },
        },
      },
    },
  });

  let scheduled = deadlineReconciliation.retrying;
  const escalated = deadlineReconciliation.escalated;
  const humanReviewIds: string[] = [
    ...deadlineReconciliation.humanReviewIncidentIds,
  ];
  const parkedIncidentIds = new Set(deadlineReconciliation.parkedIncidentIds);

  for (const status of statuses) {
    let incident = status.course.supportIncident;
    const localBoundary = getCourseLocalDateStorageBoundary(
      status.course.timeZone,
      now,
    );
    const realDemandDates = status.course.preferences
      .map((preference) => preference.teeSearch.date)
      .filter((date) => date >= localBoundary)
      .sort((left, right) => left.getTime() - right.getTime());
    const activeRealSearchCount = realDemandDates.length;
    const hasDemandCreatedAfterFinal = status.course.preferences.some(
      (preference) =>
        preference.teeSearch.date >= localBoundary &&
        preference.teeSearch.createdAt > status.stateChangedAt,
    );
    if (
      incident &&
      (incident.activeRealSearchCount !== activeRealSearchCount ||
        (incident.earliestTargetDate?.getTime() ?? null) !==
          (realDemandDates[0]?.getTime() ?? null))
    ) {
      const promotedToRealDemand =
        incident.activeRealSearchCount === 0 && activeRealSearchCount > 0;
      const parkedUntilMaterialChange = parkedIncidentIds.has(incident.id);
      const refreshed = await prisma.courseSupportIncident.updateMany({
        where: {
          id: incident.id,
          revision: incident.revision,
        },
        data: {
          activeRealSearchCount,
          earliestTargetDate: realDemandDates[0] ?? null,
          engineeringOnly:
            activeRealSearchCount > 0 ? false : incident.engineeringOnly,
          ...(promotedToRealDemand
            ? parkedUntilMaterialChange
              ? {
                  nextReminderAt:
                    incident.status === "NEEDS_HUMAN" ? now : undefined,
                }
              : {
                  nextAttemptAt: now,
                  nextReminderAt:
                    incident.status === "NEEDS_HUMAN" ? now : undefined,
                }
            : {}),
          revision: { increment: 1 },
        },
      });
      if (refreshed.count === 1) {
        incident = {
          ...incident,
          activeRealSearchCount,
          earliestTargetDate: realDemandDates[0] ?? null,
          engineeringOnly:
            activeRealSearchCount > 0 ? false : incident.engineeringOnly,
          nextAttemptAt:
            promotedToRealDemand && !parkedUntilMaterialChange
              ? now
              : incident.nextAttemptAt,
          nextReminderAt:
            promotedToRealDemand && incident.status === "NEEDS_HUMAN"
              ? now
              : incident.nextReminderAt,
          revision: incident.revision + 1,
        };
      }
    }

    if (
      status.state === "FINAL_TECHNICAL" &&
      activeRealSearchCount > 0 &&
      hasDemandCreatedAfterFinal &&
      !status.revalidationRequestedAt
    ) {
      const requested = await prisma.$transaction(
        async (transaction) => {
          const statusUpdated =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: status.courseId,
                revision: status.revision,
                state: "FINAL_TECHNICAL",
                revalidationRequestedAt: null,
              },
              data: {
                state: "REVALIDATING_FINAL",
                revalidationRequestedAt: now,
                nextAutomaticAttemptAt: now,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
          if (statusUpdated.count !== 1) {
            return false;
          }
          await transaction.teeSearch.updateMany({
            where: {
              status: "ACTIVE",
              trafficClass: {
                notIn: [...syntheticWebsiteTrafficClasses],
              },
              preferences: {
                some: { courseId: status.courseId },
              },
            },
            data: {
              nextCheckAt: now,
              recheckRequestedAt: now,
            },
          });
          await appendMonitoringEvent(transaction, {
            courseId: status.courseId,
            incidentId: incident?.id,
            eventType: "REVALIDATION_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: "FINAL_TECHNICAL",
            toState: "REVALIDATING_FINAL",
            message:
              "The invariant watchdog recovered a revalidation request for new real demand.",
            occurredAt: now,
          });
          return true;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
      if (requested) {
        scheduled += 1;
      }
      continue;
    }

    if (
      ["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY"].includes(
        status.state,
      )
    ) {
      continue;
    }

    if (status.state === "ENGINEERING_VERIFICATION_NEEDED" && !incident) {
      const repaired = await prisma.$transaction(
        async (transaction) => {
          const statusUpdated =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: status.courseId,
                revision: status.revision,
                state: "ENGINEERING_VERIFICATION_NEEDED",
              },
              data: {
                state: "AUTO_INVESTIGATING",
                nextAutomaticAttemptAt: now,
                revalidationRequestedAt: now,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
          if (statusUpdated.count !== 1) {
            return false;
          }
          await queueActiveRealSearchesForCourse(
            transaction,
            status.courseId,
            now,
          );
          await appendMonitoringEvent(transaction, {
            courseId: status.courseId,
            eventType: "REVALIDATION_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: "ENGINEERING_VERIFICATION_NEEDED",
            toState: "AUTO_INVESTIGATING",
            failureFingerprint: status.failureFingerprint,
            message:
              "Missing human-review proof returned the course to automatic investigation.",
            occurredAt: now,
            audit: {
              missingIncidentProof: true,
              customerState: "RETRYING_AUTOMATICALLY",
              customerDataIncluded: false,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (repaired) {
        scheduled += 1;
      }
      continue;
    }

    if (
      status.state === "DEGRADED_RETRYING" &&
      status.firstDegradedAt &&
      status.firstDegradedAt.getTime() + FAILURE_CONFIRMATION_WINDOW_MS <=
        now.getTime() &&
      !incident?.activeBatchId
    ) {
      const episodeStartedAt =
        status.firstDegradedAt ?? incident?.firstSeenAt ?? now;
      const escalationDeadlineAt = getCourseMonitoringEscalationDeadline(
        episodeStartedAt,
        activeRealSearchCount,
      );
      const toolingEscalated = await prisma.$transaction(
        async (transaction) => {
          const statusUpdated =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: status.courseId,
                revision: status.revision,
                state: "DEGRADED_RETRYING",
              },
              data: {
                state: "AUTO_INVESTIGATING",
                nextAutomaticAttemptAt: now,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
          if (statusUpdated.count !== 1) {
            return false;
          }
          let incidentId = incident?.id ?? null;
          if (incident) {
            const incidentUpdated =
              await transaction.courseSupportIncident.updateMany({
                where: {
                  id: incident.id,
                  revision: incident.revision,
                  activeBatchId: null,
                },
                data: {
                  kind: "BLOCKED_TOOLING",
                  confirmedAt: incident.confirmedAt ?? now,
                  escalationDeadlineAt:
                    incident.escalationDeadlineAt ?? escalationDeadlineAt,
                  nextAttemptAt: now,
                  latestMessage:
                    "The first-failure verification window ended without enough independent observations.",
                  nextAction:
                    "Repair the verification path, then run the bounded public signed-out playbook.",
                  activeRealSearchCount,
                  earliestTargetDate: realDemandDates[0] ?? null,
                  revision: { increment: 1 },
                },
              });
            if (incidentUpdated.count !== 1) {
              throw new Error(
                "The course incident changed during tooling escalation.",
              );
            }
          } else {
            const created = await transaction.courseSupportIncident.create({
              data: {
                reference: createIncidentReference(),
                courseId: status.courseId,
                kind: "BLOCKED_TOOLING",
                providerFamilyKey: status.course.providerFamilyKey,
                failureClass: "UNKNOWN",
                failureFingerprint:
                  status.failureFingerprint ?? "TOOLING:UNCONFIRMED",
                courseNameSnapshot: status.course.name,
                platformSnapshot: status.course.detectedPlatform,
                bookingUrlSnapshot:
                  status.course.detectedBookingUrl ?? status.course.website,
                initialMessage:
                  "The first-failure verification window ended without enough independent observations.",
                latestMessage:
                  "The first-failure verification window ended without enough independent observations.",
                nextAction:
                  "Repair the verification path, then run the bounded public signed-out playbook.",
                affectedSearchCount: Math.max(activeRealSearchCount, 1),
                engineeringOnly: activeRealSearchCount === 0,
                nextAttemptAt: now,
                confirmedAt: now,
                escalationDeadlineAt,
                activeRealSearchCount,
                earliestTargetDate: realDemandDates[0] ?? null,
                firstSeenAt: status.firstDegradedAt ?? now,
                lastSeenAt: now,
              },
            });
            incidentId = created.id;
          }
          await transaction.courseMonitoringEvent.create({
            data: {
              courseId: status.courseId,
              incidentId,
              eventType: "TOOLING_INCIDENT",
              source: "RECOVERY_CRON",
              fromState: "DEGRADED_RETRYING",
              toState: "AUTO_INVESTIGATING",
              failureFingerprint: status.failureFingerprint,
              message:
                "Confirmation machinery could not complete within fifteen minutes, so the gap became explicit responder work.",
              occurredAt: now,
              audit: {
                confirmationWindowMinutes: 15,
                customerDataIncluded: false,
              },
            },
          });
          return true;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
      if (toolingEscalated) {
        scheduled += 1;
      }
      continue;
    }

    if (
      incident?.status === "NEEDS_HUMAN" &&
      !incident.activeBatchId &&
      isAutomationHumanReviewProofCurrentOrPrior(
        incident.attemptLedger,
        incident.cycle,
      )
    ) {
      humanReviewIds.push(incident.id);
    }

    const ownsAutomatedAttempt = Boolean(
      incident?.activeBatchId ||
      status.nextAutomaticAttemptAt ||
      (incident?.humanReviewReason && incident.nextReminderAt),
    );
    if (!ownsAutomatedAttempt) {
      if (status.state === "ENGINEERING_VERIFICATION_NEEDED") {
        continue;
      }
      const retryAt = now;
      await prisma.courseMonitoringStatus.updateMany({
        where: {
          courseId: status.courseId,
          revision: status.revision,
          nextAutomaticAttemptAt: null,
        },
        data: {
          nextAutomaticAttemptAt: retryAt,
          revision: { increment: 1 },
        },
      });
      if (incident && !incident.activeBatchId) {
        await prisma.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            revision: incident.revision,
            nextAttemptAt: null,
          },
          data: {
            nextAttemptAt: retryAt,
            revision: { increment: 1 },
          },
        });
      }
      scheduled += 1;
    }
  }

  const humanReview = await advanceHumanReviewVisibility(
    humanReviewIds,
    parkedIncidentIds,
    now,
  );
  scheduled += humanReview.rechecksQueued;
  return {
    checked: statuses.length,
    scheduled,
    escalated,
    remindersSent: 0,
  };
}

async function advanceHumanReviewVisibility(
  incidentIds: string[],
  parkedIncidentIds: ReadonlySet<string>,
  now: Date,
) {
  const uniqueIds = [...new Set(incidentIds)];
  if (uniqueIds.length === 0) {
    return { rechecksQueued: 0 };
  }
  const incidents = await prisma.courseSupportIncident.findMany({
    where: {
      id: { in: uniqueIds },
      status: "NEEDS_HUMAN",
    },
    orderBy: [{ activeRealSearchCount: "desc" }, { firstSeenAt: "asc" }],
  });
  if (incidents.length === 0) {
    return { rechecksQueued: 0 };
  }

  const rechecksQueued = 0;
  for (const incident of incidents) {
    if (parkedIncidentIds.has(incident.id)) {
      if (!incident.nextReminderAt || incident.nextReminderAt <= now) {
        await prisma.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            revision: incident.revision,
            status: "NEEDS_HUMAN",
            activeBatchId: null,
            nextAttemptAt: null,
          },
          data: {
            nextReminderAt: getHumanReviewReminderAt(
              now,
              incident.activeRealSearchCount,
            ),
            revision: { increment: 1 },
          },
        });
      }
      continue;
    }
    if (!incident.nextAttemptAt || incident.nextAttemptAt <= now) {
      const nextAttemptAt = getHumanReviewRetryAt(
        now,
        incident.activeRealSearchCount,
      );
      const nextReminderAt =
        !incident.nextReminderAt || incident.nextReminderAt <= now
          ? getHumanReviewReminderAt(now, incident.activeRealSearchCount)
          : incident.nextReminderAt;
      await prisma.$transaction(
        async (transaction) => {
          const incidentUpdated =
            await transaction.courseSupportIncident.updateMany({
              where: {
                id: incident.id,
                cycle: incident.cycle,
                revision: incident.revision,
                status: "NEEDS_HUMAN",
                activeBatchId: null,
              },
              data: {
                nextAttemptAt,
                nextReminderAt,
                revision: { increment: 1 },
              },
            });
          if (incidentUpdated.count !== 1) {
            return false;
          }
          const statusUpdated =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: incident.courseId,
                state: "ENGINEERING_VERIFICATION_NEEDED",
              },
              data: {
                nextAutomaticAttemptAt: nextAttemptAt,
                revalidationRequestedAt: null,
                revision: { increment: 1 },
              },
            });
          if (statusUpdated.count !== 1) {
            throw new Error(
              "The monitoring state changed while human-review timing was advanced.",
            );
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      continue;
    }
    if (!incident.nextReminderAt || incident.nextReminderAt > now) {
      continue;
    }
    const nextReminderAt = getHumanReviewReminderAt(
      now,
      incident.activeRealSearchCount,
    );
    await prisma.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        status: "NEEDS_HUMAN",
        revision: incident.revision,
      },
      data: {
        nextReminderAt,
        revision: { increment: 1 },
      },
    });
  }
  return { rechecksQueued };
}

export function inferHumanReviewReason(input: {
  kind: string;
  failureClass: string;
  bookingAccessMode?: string | null;
  automationReason?: string | null;
}): CourseHumanReviewReason {
  if (input.kind === "BLOCKED_TOOLING") {
    return "AUTOMATION_STALLED";
  }
  if (
    input.kind === "READER_CANDIDATE" ||
    input.failureClass === "READER_PARSER_MISSING"
  ) {
    return "READER_RELOAD_REQUIRED";
  }
  if (
    input.failureClass === "CHALLENGE" ||
    input.bookingAccessMode === "CAPTCHA_OR_QUEUE" ||
    input.automationReason === "CAPTCHA_OR_QUEUE"
  ) {
    return "CAPTCHA_OR_QUEUE";
  }
  if (
    input.failureClass === "AUTH" ||
    input.bookingAccessMode?.startsWith("ACCOUNT") ||
    input.automationReason === "ACCOUNT_REQUIRED"
  ) {
    return "ACCOUNT_REQUIRED";
  }
  if (input.failureClass === "MISSING_SOURCE") {
    return "SOURCE_UNVERIFIED";
  }
  if (input.failureClass === "NOT_FOUND") {
    return "OFFICIAL_LINK_VERIFICATION_FAILED";
  }
  return "OTHER_TECHNICAL_LIMITATION";
}

async function ensureMonitoringStatus(
  transaction: Prisma.TransactionClient,
  courseId: string,
  now: Date,
) {
  return transaction.courseMonitoringStatus.upsert({
    where: { courseId },
    create: {
      courseId,
      reference: createMonitoringReference(),
      state: "UNKNOWN",
      stateChangedAt: now,
      updatedAt: now,
    },
    update: {},
  });
}

async function queueActiveRealSearchesForCourse(
  transaction: Prisma.TransactionClient,
  courseId: string,
  now: Date,
) {
  return transaction.teeSearch.updateMany({
    where: {
      status: "ACTIVE",
      trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
      preferences: { some: { courseId } },
    },
    data: {
      nextCheckAt: now,
      recheckRequestedAt: now,
    },
  });
}

async function queueImmediateActiveRealSearchSchedulesForCourse(
  transaction: Prisma.TransactionClient,
  courseId: string,
  now: Date,
  currentDateBoundary: Date,
) {
  return transaction.teeSearch.updateMany({
    where: {
      status: "ACTIVE",
      trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
      date: { gte: currentDateBoundary },
      preferences: { some: { courseId } },
    },
    data: {
      scheduleVersion: { increment: 1 },
      checkStatus: "QUEUED",
      nextCheckAt: now,
      lastCheckOutcome: null,
      workflowRunId: null,
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
      recheckRequestedAt: null,
    },
  });
}

async function appendMonitoringEvent(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    incidentId?: string | null;
    eventType:
      | "CHECK_SUCCEEDED"
      | "CHECK_FAILED"
      | "STATE_CHANGED"
      | "HUMAN_REVIEW_REQUESTED"
      | "REVALIDATION_REQUESTED"
      | "RECOVERED";
    source: CourseMonitoringEventSource;
    fromState?: CourseMonitoringState | null;
    toState?: CourseMonitoringState | null;
    outcome?: ProbeOutcome;
    failureFingerprint?: string | null;
    readPath?: string | null;
    message?: string | null;
    evidenceUrl?: string | null;
    runtimeVersion?: string | null;
    deploymentSha?: string | null;
    idempotencyKey?: string | null;
    occurredAt: Date;
    audit?: Prisma.InputJsonObject;
  },
) {
  const audit = await attachParkedCampaignToMonitoringAudit(transaction, input);
  return transaction.courseMonitoringEvent.create({
    data: {
      courseId: input.courseId,
      incidentId: input.incidentId,
      eventType: input.eventType,
      source: input.source,
      fromState: input.fromState,
      toState: input.toState,
      outcome: input.outcome,
      failureFingerprint: input.failureFingerprint,
      readPath: input.readPath,
      message: input.message,
      evidenceUrl: input.evidenceUrl,
      runtimeVersion: normalizeRuntimeVersion(input.runtimeVersion),
      deploymentSha: normalizeDeploymentSha(input.deploymentSha),
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
      audit,
    },
  });
}

async function attachParkedCampaignToMonitoringAudit(
  transaction: Prisma.TransactionClient,
  input: {
    incidentId?: string | null;
    occurredAt: Date;
    audit?: Prisma.InputJsonObject;
  },
) {
  const audit = input.audit;
  const rawCycle = asMonitoringJsonRecord(audit).cycle;
  if (
    !input.incidentId ||
    !Number.isInteger(rawCycle) ||
    Number(rawCycle) < 1
  ) {
    return audit;
  }
  const cycle = Number(rawCycle);
  const campaignEvent = await transaction.courseMonitoringEvent.findFirst({
    where: {
      incidentId: input.incidentId,
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      occurredAt: { lte: input.occurredAt },
      AND: [{ audit: { path: ["cycle"], equals: cycle } }],
      OR: [
        { audit: { path: ["action"], equals: "parked_cohort_admission" } },
        {
          audit: {
            path: ["action"],
            equals: "parked_cohort_post_marker_incomplete_playbook_recovery",
          },
        },
        {
          audit: {
            path: ["action"],
            equals: "parked_cohort_descendant_incomplete_playbook_recovery",
          },
        },
        {
          audit: {
            path: ["action"],
            equals: "parked_cohort_requestless_stale_ownership_recovery",
          },
        },
        {
          audit: {
            path: ["action"],
            equals:
              "parked_cohort_same_identity_material_change_incomplete_playbook_recovery",
          },
        },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { audit: true, occurredAt: true },
  });
  const admissionAudit = asMonitoringJsonRecord(campaignEvent?.audit);
  const descendantRecovery =
    admissionAudit.action ===
    "parked_cohort_descendant_incomplete_playbook_recovery";
  const postMarkerIncompleteRecovery =
    admissionAudit.action ===
    "parked_cohort_post_marker_incomplete_playbook_recovery";
  const requestlessStaleOwnershipRecovery =
    admissionAudit.action ===
    "parked_cohort_requestless_stale_ownership_recovery";
  const sameIdentityMaterialChangeIncompleteRecovery =
    admissionAudit.action ===
    "parked_cohort_same_identity_material_change_incomplete_playbook_recovery";
  if (
    (admissionAudit.action !== "parked_cohort_admission" &&
      admissionAudit.action !==
        "parked_cohort_post_marker_incomplete_playbook_recovery" &&
      admissionAudit.action !==
        "parked_cohort_descendant_incomplete_playbook_recovery" &&
      admissionAudit.action !==
        "parked_cohort_requestless_stale_ownership_recovery" &&
      admissionAudit.action !==
        "parked_cohort_same_identity_material_change_incomplete_playbook_recovery") ||
    admissionAudit.cycle !== cycle ||
    typeof admissionAudit.campaignRunId !== "string" ||
    !admissionAudit.campaignRunId.trim() ||
    typeof admissionAudit.campaignMembershipDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(admissionAudit.campaignMembershipDigest) ||
    (postMarkerIncompleteRecovery &&
      (admissionAudit.admissionMode !==
        "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY" ||
        typeof admissionAudit.sameCycleRecoveryHistoryDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(
          admissionAudit.sameCycleRecoveryHistoryDigest,
        ) ||
        typeof admissionAudit.priorRecoveryMarkerDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.priorRecoveryMarkerDigest) ||
        typeof admissionAudit.recoveryRuntimeVersion !== "string" ||
        !/^[a-f0-9]{40}$/u.test(admissionAudit.recoveryRuntimeVersion) ||
        typeof admissionAudit.priorRecoveryRuntimeVersion !== "string" ||
        !/^[a-f0-9]{40}$/u.test(admissionAudit.priorRecoveryRuntimeVersion) ||
        admissionAudit.recoveryRuntimeVersion ===
          admissionAudit.priorRecoveryRuntimeVersion ||
        !Array.isArray(admissionAudit.failedRuntimeVersions) ||
        admissionAudit.failedRuntimeVersions.length !== 1 ||
        admissionAudit.failedRuntimeVersions[0] !==
          admissionAudit.priorRecoveryRuntimeVersion ||
        typeof admissionAudit.postMarkerHistoryDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.postMarkerHistoryDigest) ||
        admissionAudit.postMarkerBatchCount !== 1 ||
        admissionAudit.postMarkerRequestCount !== 0 ||
        !Number.isInteger(admissionAudit.startedRequestCount) ||
        Number(admissionAudit.startedRequestCount) < 1 ||
        !Number.isInteger(admissionAudit.batchCount) ||
        Number(admissionAudit.batchCount) < 1 ||
        admissionAudit.playbookCompletedStageCount !== 4 ||
        admissionAudit.playbookNextStage !== "RENDERED_BROWSER_DISCOVERY" ||
        typeof admissionAudit.supersededEndpointId !== "string" ||
        !admissionAudit.supersededEndpointId.trim() ||
        typeof admissionAudit.supersededEndpointAt !== "string" ||
        !Number.isFinite(
          new Date(admissionAudit.supersededEndpointAt).getTime(),
        ) ||
        !campaignEvent ||
        new Date(admissionAudit.supersededEndpointAt).getTime() >=
          campaignEvent.occurredAt.getTime() ||
        typeof admissionAudit.providerSnapshotFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.providerSnapshotFingerprint) ||
        typeof admissionAudit.attemptLedgerFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.attemptLedgerFingerprint) ||
        admissionAudit.customerDataIncluded !== false ||
        admissionAudit.preservesOperatorEvidence !== true ||
        asMonitoringJsonRecord(admissionAudit.campaign).kind !==
          "PARKED_COHORT" ||
        asMonitoringJsonRecord(admissionAudit.campaign).runId !==
          admissionAudit.campaignRunId ||
        asMonitoringJsonRecord(admissionAudit.campaign).membershipDigest !==
          admissionAudit.campaignMembershipDigest ||
        asMonitoringJsonRecord(admissionAudit.campaign).cycle !== cycle ||
        admissionAudit.sameCycleRecovery !== true ||
        admissionAudit.oneShot !== true ||
        admissionAudit.preservesAttemptLedger !== true ||
        admissionAudit.preservesAttemptCounts !== true ||
        admissionAudit.preservesAttemptTimestamps !== true ||
        admissionAudit.preservesImmutableCampaignAudit !== true)) ||
    (descendantRecovery &&
      (admissionAudit.admissionMode !==
        "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY" ||
        typeof admissionAudit.descendantLineageDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.descendantLineageDigest) ||
        !Number.isInteger(admissionAudit.descendantHandoffCount) ||
        Number(admissionAudit.descendantHandoffCount) < 1 ||
        admissionAudit.sameCycleRecovery !== true ||
        admissionAudit.oneShot !== true ||
        admissionAudit.preservesImmutableCampaignAudit !== true)) ||
    (requestlessStaleOwnershipRecovery &&
      (admissionAudit.admissionMode !==
        "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY" ||
        typeof admissionAudit.sameCycleRecoveryHistoryDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(
          admissionAudit.sameCycleRecoveryHistoryDigest,
        ) ||
        typeof admissionAudit.abandonedBaseRuntime !== "string" ||
        !admissionAudit.abandonedBaseRuntime.trim() ||
        typeof admissionAudit.recoveryRuntimeVersion !== "string" ||
        !admissionAudit.recoveryRuntimeVersion.trim() ||
        admissionAudit.abandonedBaseRuntime ===
          admissionAudit.recoveryRuntimeVersion ||
        admissionAudit.requestCount !== 0 ||
        admissionAudit.releaseEvidenceAbsent !== true ||
        admissionAudit.executionEvidenceAbsent !== true ||
        admissionAudit.sameCycleRecovery !== true ||
        admissionAudit.oneShot !== true ||
        admissionAudit.preservesAttemptLedger !== true ||
        admissionAudit.preservesAttemptCounts !== true ||
        admissionAudit.preservesAttemptTimestamps !== true ||
        admissionAudit.preservesImmutableCampaignAudit !== true)) ||
    (sameIdentityMaterialChangeIncompleteRecovery &&
      (admissionAudit.admissionMode !==
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY" ||
        typeof admissionAudit.sameCycleRecoveryHistoryDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(
          admissionAudit.sameCycleRecoveryHistoryDigest,
        ) ||
        typeof admissionAudit.materialChangeLineageDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.materialChangeLineageDigest) ||
        !Number.isInteger(admissionAudit.startedRequestCount) ||
        Number(admissionAudit.startedRequestCount) < 1 ||
        !Number.isInteger(admissionAudit.batchCount) ||
        Number(admissionAudit.batchCount) < 1 ||
        !Number.isInteger(admissionAudit.playbookCompletedStageCount) ||
        Number(admissionAudit.playbookCompletedStageCount) < 1 ||
        typeof admissionAudit.playbookNextStage !== "string" ||
        !admissionAudit.playbookNextStage.trim() ||
        typeof admissionAudit.supersededEndpointId !== "string" ||
        !admissionAudit.supersededEndpointId.trim() ||
        typeof admissionAudit.supersededEndpointAt !== "string" ||
        !Number.isFinite(
          new Date(admissionAudit.supersededEndpointAt).getTime(),
        ) ||
        !campaignEvent ||
        new Date(admissionAudit.supersededEndpointAt).getTime() >=
          campaignEvent.occurredAt.getTime() ||
        typeof admissionAudit.providerSnapshotFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.providerSnapshotFingerprint) ||
        typeof admissionAudit.attemptLedgerFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(admissionAudit.attemptLedgerFingerprint) ||
        admissionAudit.customerDataIncluded !== false ||
        admissionAudit.preservesOperatorEvidence !== true ||
        asMonitoringJsonRecord(admissionAudit.campaign).kind !==
          "PARKED_COHORT" ||
        asMonitoringJsonRecord(admissionAudit.campaign).runId !==
          admissionAudit.campaignRunId ||
        asMonitoringJsonRecord(admissionAudit.campaign).membershipDigest !==
          admissionAudit.campaignMembershipDigest ||
        asMonitoringJsonRecord(admissionAudit.campaign).cycle !== cycle ||
        admissionAudit.sameCycleRecovery !== true ||
        admissionAudit.oneShot !== true ||
        admissionAudit.preservesAttemptLedger !== true ||
        admissionAudit.preservesAttemptCounts !== true ||
        admissionAudit.preservesAttemptTimestamps !== true ||
        admissionAudit.preservesImmutableCampaignAudit !== true))
  ) {
    return audit;
  }
  return {
    ...(audit ?? {}),
    campaign: {
      kind: "PARKED_COHORT",
      runId: admissionAudit.campaignRunId,
      membershipDigest: admissionAudit.campaignMembershipDigest,
      cycle,
    },
    customerDataIncluded: false,
  } satisfies Prisma.InputJsonObject;
}

export type ParkedCourseResponderCampaignReopenInput = {
  courseId: string;
  incidentId: string;
  expectedCycle: number;
  expectedRevision: number;
  expectedMonitoringRevision: number;
  capturedRevision: number;
  capturedMonitoringRevision: number;
  expectedKind: CourseSupportIncidentKind;
  expectedFailureClass: CourseSupportFailureClass;
  expectedLatestProbeAt: string | null;
  expectedLatestDiscoveryAt: string | null;
  expectedLatestProbeId?: string | null;
  expectedLatestDiscoveryId?: string | null;
  expectedProviderFamilyKey: string;
  expectedFailureFingerprint: string;
  expectedMonitoringFailureFingerprint: string | null;
  expectedProviderSnapshotFingerprint: string;
  expectedAttemptLedgerFingerprint: string;
  expectedPlaybookConclusion: string;
  campaignRunId: string;
  campaignMembershipDigest: string;
  admissionMode?:
    | "FRESH_CYCLE"
    | "ZERO_EXECUTION_RECOVERY"
    | "INCOMPLETE_PLAYBOOK_RECOVERY"
    | "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY"
    | "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY"
    | "CURRENT_CYCLE_ORCHESTRATION_RECOVERY";
  capturedCycle?: number;
  capturedKind?: string;
  capturedProviderFamilyKey?: string;
  campaignCapturedAt?: string;
  expectedZeroExecutionHistoryDigest?: string | null;
  expectedSameCycleRecoveryHistoryDigest?: string | null;
  expectedPlaybookNextStage?: string | null;
  expectedPlaybookCompletedStageCount?: number;
  currentRuntimeVersion?: string;
  now?: Date;
};

// Evidence rows are retained append-only. Lock and compare them without using a
// no-op write, which would violate that contract even when the value is equal.
async function lockExactCourseProbeEvidence(
  transaction: Prisma.TransactionClient,
  expected: { id: string; courseId: string; observedAt: Date },
) {
  const rows = await transaction.$queryRaw<
    Array<{ id: string; courseId: string; observedAt: Date }>
  >(Prisma.sql`
    SELECT "id", "courseId", "observedAt"
    FROM "CourseProbe"
    WHERE "id" = ${expected.id}
      AND "courseId" = ${expected.courseId}
      AND "observedAt" = ${expected.observedAt}
    ORDER BY "id"
    FOR UPDATE
  `);
  const [row] = rows;
  return (
    rows.length === 1 &&
    row.id === expected.id &&
    row.courseId === expected.courseId &&
    row.observedAt instanceof Date &&
    row.observedAt.getTime() === expected.observedAt.getTime()
  );
}

async function lockExactCourseAutomationDiscoveryEvidence(
  transaction: Prisma.TransactionClient,
  expected: { id: string; courseId: string; createdAt: Date },
) {
  const rows = await transaction.$queryRaw<
    Array<{ id: string; courseId: string; createdAt: Date }>
  >(Prisma.sql`
    SELECT "id", "courseId", "createdAt"
    FROM "CourseAutomationDiscovery"
    WHERE "id" = ${expected.id}
      AND "courseId" = ${expected.courseId}
      AND "createdAt" = ${expected.createdAt}
    ORDER BY "id"
    FOR UPDATE
  `);
  const [row] = rows;
  return (
    rows.length === 1 &&
    row.id === expected.id &&
    row.courseId === expected.courseId &&
    row.createdAt instanceof Date &&
    row.createdAt.getTime() === expected.createdAt.getTime()
  );
}

export async function reopenParkedCourseForResponderCampaign(
  input: ParkedCourseResponderCampaignReopenInput,
) {
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    (transaction) =>
      reopenParkedCourseForResponderCampaignInTransaction(transaction, input),
    input.admissionMode ===
      "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY" ||
      input.admissionMode ===
        "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY" ||
      input.admissionMode === "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY"
      ? { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      : undefined,
  );
}

export async function reopenParkedCourseForResponderCampaignInTransaction(
  transaction: Prisma.TransactionClient,
  input: ParkedCourseResponderCampaignReopenInput,
) {
  const now = input.now ?? new Date();
  const sameIdentityMaterialChangeIncompleteRecoveryRequested =
    input.admissionMode ===
    "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY";
  const postMarkerIncompletePlaybookRecoveryRequested =
    input.admissionMode === "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY";
  const exactEvidenceRecoveryRequested =
    sameIdentityMaterialChangeIncompleteRecoveryRequested ||
    postMarkerIncompletePlaybookRecoveryRequested;
  return (async () => {
    const incident = await transaction.courseSupportIncident.findUnique({
      where: { id: input.incidentId },
      select: {
        id: true,
        courseId: true,
        cycle: true,
        revision: true,
        status: true,
        kind: true,
        providerFamilyKey: true,
        failureClass: true,
        failureFingerprint: true,
        attemptLedger: true,
        humanReviewReason: true,
        activeRealSearchCount: true,
        activeBatchId: true,
        nextAttemptAt: true,
        escalatedAt: true,
        resolution: true,
        resolvedAt: true,
        resolutionMessage: true,
        resolutionNotifiedAt: true,
        decisionActorId: true,
        decisionAt: true,
        decisionNote: true,
        decisionEvidenceUrl: true,
        decisionIdempotencyKey: true,
        monitoringEvents: {
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          take: 50,
          select: {
            id: true,
            incidentId: true,
            eventType: true,
            source: true,
            failureFingerprint: true,
            readPath: true,
            occurredAt: true,
            audit: true,
          },
        },
        batchIncidents: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
          select: {
            id: true,
            batchId: true,
            incidentId: true,
            courseId: true,
            cycle: true,
            result: true,
            preProbeId: true,
            postProbeId: true,
            proofSnapshot: true,
            verifiedIncidentUpdatedAt: true,
            verifiedAt: true,
            createdAt: true,
            updatedAt: true,
            batch: {
              select: {
                id: true,
                status: true,
                revision: true,
                ownerAutomationRunId: true,
                baseSha: true,
                releaseSha: true,
                deployedAt: true,
                createdAt: true,
                updatedAt: true,
                recheckDispatchKey: true,
                recheckDispatchStartedAt: true,
                recheckDispatchedAt: true,
                completedAt: true,
                summary: true,
                ownerAutomationRun: {
                  select: {
                    id: true,
                    promptVersion: true,
                    kind: true,
                    status: true,
                    runtimeVersion: true,
                    completedAt: true,
                    outcome: true,
                    notes: true,
                  },
                },
              },
            },
            verificationRequests: {
              select: {
                id: true,
                courseId: true,
                releaseSha: true,
                providerSnapshotFingerprint: true,
                providerSnapshotAt: true,
                createdAt: true,
                updatedAt: true,
                status: true,
                revision: true,
                attemptCount: true,
                workflowRunId: true,
                startedAt: true,
                outcome: true,
                failureClass: true,
                evidence: true,
                lastError: true,
              },
            },
          },
        },
        course: {
          select: {
            updatedAt: true,
            timeZone: true,
            isPublic: true,
            website: true,
            detectedBookingUrl: true,
            detectedPlatform: true,
            providerFamilyKey: true,
            bookingMethod: true,
            bookingWindowDaysAhead: true,
            bookingReleaseTimeLocal: true,
            bookingWindowSource: true,
            bookingWindowConfidence: true,
            bookingWindowEvidenceUrl: true,
            automationEligibility: true,
            automationReason: true,
            monitoringMode: true,
            bookingAccessMode: true,
            intelligenceVerifiedAt: true,
            intelligenceReviewAt: true,
            intelligenceConfidence: true,
            bookingMetadata: true,
            layoutHoleCounts: true,
            layoutHolesVerifiedAt: true,
            probes: {
              orderBy: [{ observedAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { id: true, courseId: true, observedAt: true },
            },
            automationDiscoveries: {
              orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { id: true, courseId: true, createdAt: true },
            },
            preferences: {
              where: {
                teeSearch: {
                  status: "ACTIVE",
                  trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
                },
              },
              take: 1,
              select: { id: true },
            },
            monitoringStatus: {
              select: {
                state: true,
                revision: true,
                failureFingerprint: true,
                nextAutomaticAttemptAt: true,
                revalidationRequestedAt: true,
              },
            },
          },
        },
      },
    });
    const exactCurrentCycleBatchIncidents =
      exactEvidenceRecoveryRequested && incident
        ? await transaction.courseSupportBatchIncident.findMany({
            where: { incidentId: incident.id, cycle: incident.cycle },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: 21,
            select: {
              id: true,
              batchId: true,
              incidentId: true,
              courseId: true,
              cycle: true,
              result: true,
              preProbeId: true,
              postProbeId: true,
              proofSnapshot: true,
              verifiedIncidentUpdatedAt: true,
              verifiedAt: true,
              createdAt: true,
              updatedAt: true,
              batch: {
                select: {
                  id: true,
                  status: true,
                  revision: true,
                  ownerAutomationRunId: true,
                  baseSha: true,
                  releaseSha: true,
                  deployedAt: true,
                  createdAt: true,
                  updatedAt: true,
                  recheckDispatchKey: true,
                  recheckDispatchStartedAt: true,
                  recheckDispatchedAt: true,
                  completedAt: true,
                  summary: true,
                  ownerAutomationRun: {
                    select: {
                      id: true,
                      promptVersion: true,
                      kind: true,
                      status: true,
                      runtimeVersion: true,
                      completedAt: true,
                      outcome: true,
                      notes: true,
                    },
                  },
                },
              },
              verificationRequests: {
                select: {
                  id: true,
                  courseId: true,
                  releaseSha: true,
                  providerSnapshotFingerprint: true,
                  providerSnapshotAt: true,
                  createdAt: true,
                  updatedAt: true,
                  status: true,
                  revision: true,
                  attemptCount: true,
                  workflowRunId: true,
                  startedAt: true,
                  outcome: true,
                  failureClass: true,
                  evidence: true,
                  lastError: true,
                },
              },
            },
          })
        : null;
    const status = incident?.course.monitoringStatus;
    const activeRealSearchCount = incident
      ? Math.max(
          incident.activeRealSearchCount,
          incident.course.preferences.length,
        )
      : 0;
    const zeroExecutionRecoveryRequested =
      input.admissionMode === "ZERO_EXECUTION_RECOVERY";
    const incompletePlaybookRecoveryRequested =
      input.admissionMode === "INCOMPLETE_PLAYBOOK_RECOVERY";
    const descendantIncompletePlaybookRecoveryRequested =
      input.admissionMode === "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY";
    const requestlessStaleOwnershipRecoveryRequested =
      input.admissionMode ===
      "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY";
    const currentCycleOrchestrationRecoveryRequested =
      input.admissionMode === "CURRENT_CYCLE_ORCHESTRATION_RECOVERY";
    const sameCycleRecoveryRequested =
      incompletePlaybookRecoveryRequested ||
      postMarkerIncompletePlaybookRecoveryRequested ||
      descendantIncompletePlaybookRecoveryRequested ||
      requestlessStaleOwnershipRecoveryRequested ||
      sameIdentityMaterialChangeIncompleteRecoveryRequested ||
      currentCycleOrchestrationRecoveryRequested;
    const originalAdmission =
      zeroExecutionRecoveryRequested || incompletePlaybookRecoveryRequested
        ? incident?.monitoringEvents.find((event) => {
            const audit = asMonitoringJsonRecord(event.audit);
            return (
              event.eventType === "REVALIDATION_REQUESTED" &&
              audit.action === "parked_cohort_admission" &&
              audit.campaignRunId === input.campaignRunId &&
              audit.campaignMembershipDigest ===
                input.campaignMembershipDigest &&
              audit.priorCycle === input.capturedCycle &&
              audit.cycle === incident.cycle
            );
          })
        : null;
    const automationStalledEndpoint =
      zeroExecutionRecoveryRequested || sameCycleRecoveryRequested
        ? incident?.monitoringEvents.find((event) => {
            const audit = asMonitoringJsonRecord(event.audit);
            const campaign = asMonitoringJsonRecord(audit.campaign);
            return (
              event.eventType === "HUMAN_REVIEW_REQUESTED" &&
              event.failureFingerprint === incident.failureFingerprint &&
              audit.cycle === incident.cycle &&
              audit.automationStalled === true &&
              audit.parkedUntilMaterialChange === true &&
              audit.customerState === "NEEDS_HUMAN_REVIEW" &&
              audit.playbookExhausted === false &&
              (!sameCycleRecoveryRequested ||
                (event.source !== "OPERATOR_CLI" &&
                  event.source !== "OPERATOR_DASHBOARD")) &&
              (sameCycleRecoveryRequested ||
                audit.endpointStalled === true ||
                audit.operationalRetryBudgetExhausted === true ||
                (event.source === "RECOVERY_CRON" &&
                  campaign.runId === input.campaignRunId &&
                  campaign.membershipDigest ===
                    input.campaignMembershipDigest &&
                  campaign.cycle === incident.cycle))
            );
          })
        : null;
    const zeroExecutionRecoveryAlreadyRecorded = Boolean(
      zeroExecutionRecoveryRequested &&
      incident?.monitoringEvents.some((event) => {
        const audit = asMonitoringJsonRecord(event.audit);
        return (
          event.eventType === "REVALIDATION_REQUESTED" &&
          audit.action === "parked_cohort_zero_execution_recovery" &&
          audit.campaignRunId === input.campaignRunId &&
          audit.cycle === incident.cycle
        );
      }),
    );
    const zeroExecutionHistory =
      zeroExecutionRecoveryRequested && incident && input.currentRuntimeVersion
        ? assessCourseSupportZeroExecutionHistory({
            courseId: input.courseId,
            cycle: incident.cycle,
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            currentRuntimeVersion: input.currentRuntimeVersion,
            entries: incident.batchIncidents,
          })
        : null;
    const currentPlaybookAssessment = incident
      ? assessAutomationPlaybook(incident.attemptLedger, incident.cycle)
      : null;
    const currentCampaignMember =
      incident && status && currentPlaybookAssessment
        ? {
            courseId: incident.courseId,
            incidentId: incident.id,
            cycle: incident.cycle,
            revision: incident.revision,
            monitoringRevision: status.revision,
            monitoringFailureFingerprint: status.failureFingerprint,
            kind: incident.kind,
            providerFamilyKey: incident.providerFamilyKey,
            failureClass: incident.failureClass,
            failureFingerprint: incident.failureFingerprint,
            providerSnapshotFingerprint:
              buildCourseSupportProviderSnapshotFingerprint(incident.course),
            attemptLedgerFingerprint: createHash("sha256")
              .update(
                stableCourseProviderExecutionEvidenceValue(
                  incident.attemptLedger ?? null,
                ),
              )
              .digest("hex"),
            playbookConclusion: currentPlaybookAssessment.conclusion,
            latestProbeAt:
              incident.course.probes[0]?.observedAt.toISOString() ?? null,
            latestDiscoveryAt:
              incident.course.automationDiscoveries[0]?.createdAt.toISOString() ??
              null,
            activeRealSearchCount,
            zeroExecutionEvidence: {
              latestProbe: incident.course.probes[0] ?? null,
              latestDiscovery: incident.course.automationDiscoveries[0] ?? null,
              monitoringEvents: incident.monitoringEvents,
              batchIncidents:
                exactCurrentCycleBatchIncidents ?? incident.batchIncidents,
              playbookAssessment: currentPlaybookAssessment,
            },
          }
        : null;
    const sameCycleRecoveryAction = incompletePlaybookRecoveryRequested
      ? "parked_cohort_incomplete_playbook_recovery"
      : postMarkerIncompletePlaybookRecoveryRequested
        ? "parked_cohort_post_marker_incomplete_playbook_recovery"
        : descendantIncompletePlaybookRecoveryRequested
          ? "parked_cohort_descendant_incomplete_playbook_recovery"
          : requestlessStaleOwnershipRecoveryRequested
            ? "parked_cohort_requestless_stale_ownership_recovery"
            : sameIdentityMaterialChangeIncompleteRecoveryRequested
              ? "parked_cohort_same_identity_material_change_incomplete_playbook_recovery"
              : currentCycleOrchestrationRecoveryRequested
                ? "parked_cohort_current_cycle_orchestration_recovery"
                : null;
    const sameCycleRecoveryAlreadyRecorded = Boolean(
      sameCycleRecoveryAction &&
      incident?.monitoringEvents.some((event) => {
        const audit = asMonitoringJsonRecord(event.audit);
        return (
          event.eventType === "REVALIDATION_REQUESTED" &&
          audit.action === sameCycleRecoveryAction &&
          audit.campaignRunId === input.campaignRunId &&
          audit.cycle === incident.cycle
        );
      }),
    );
    const campaignCapturedAt = input.campaignCapturedAt
      ? new Date(input.campaignCapturedAt)
      : null;
    const descendantCampaignRun =
      descendantIncompletePlaybookRecoveryRequested ||
      requestlessStaleOwnershipRecoveryRequested ||
      postMarkerIncompletePlaybookRecoveryRequested ||
      sameIdentityMaterialChangeIncompleteRecoveryRequested
        ? await transaction.automationRun.findUnique({
            where: { id: input.campaignRunId },
            select: {
              promptVersion: true,
              status: true,
              completedAt: true,
              audit: true,
            },
          })
        : null;
    const descendantCampaignAudit = descendantCampaignRun
      ? parseParkedCourseCampaignAudit(descendantCampaignRun.audit)
      : null;
    const descendantCapturedMember = descendantCampaignAudit?.members.find(
      (member) =>
        member.courseId === input.courseId &&
        member.incidentId === input.incidentId,
    );
    const descendantLineage =
      descendantIncompletePlaybookRecoveryRequested &&
      currentCampaignMember &&
      descendantCampaignRun?.promptVersion ===
        PARKED_COURSE_CAMPAIGN_PROMPT_VERSION &&
      descendantCampaignRun.status === "RUNNING" &&
      descendantCampaignRun.completedAt === null &&
      descendantCampaignAudit &&
      descendantCampaignAudit.membershipDigest ===
        input.campaignMembershipDigest &&
      descendantCapturedMember &&
      campaignCapturedAt !== null &&
      Number.isFinite(campaignCapturedAt.getTime()) &&
      descendantCampaignAudit.capturedAt === input.campaignCapturedAt
        ? findParkedCourseCampaignDescendantLineage({
            captured: descendantCapturedMember,
            current: currentCampaignMember,
            capturedAt: campaignCapturedAt,
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            events:
              currentCampaignMember.zeroExecutionEvidence.monitoringEvents,
          })
        : null;
    const requestlessStaleOwnershipRecovery =
      requestlessStaleOwnershipRecoveryRequested &&
      currentCampaignMember &&
      descendantCampaignRun?.promptVersion ===
        PARKED_COURSE_CAMPAIGN_PROMPT_VERSION &&
      descendantCampaignRun.status === "RUNNING" &&
      descendantCampaignRun.completedAt === null &&
      descendantCampaignAudit &&
      descendantCampaignAudit.membershipDigest ===
        input.campaignMembershipDigest &&
      descendantCapturedMember &&
      campaignCapturedAt !== null &&
      Number.isFinite(campaignCapturedAt.getTime()) &&
      descendantCampaignAudit.capturedAt === input.campaignCapturedAt &&
      input.currentRuntimeVersion
        ? assessParkedCourseCampaignRequestlessStaleOwnershipRecovery({
            captured: descendantCapturedMember,
            current: currentCampaignMember,
            capturedAt: campaignCapturedAt,
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            currentRuntimeVersion: input.currentRuntimeVersion,
          })
        : null;
    const currentCycleOrchestrationLineage =
      currentCycleOrchestrationRecoveryRequested &&
      incident &&
      Number.isInteger(input.capturedCycle) &&
      typeof input.capturedKind === "string" &&
      typeof input.capturedProviderFamilyKey === "string" &&
      campaignCapturedAt !== null &&
      Number.isFinite(campaignCapturedAt.getTime())
        ? findParkedCourseCampaignCurrentCycleOrchestrationLineage({
            captured: {
              courseId: input.courseId,
              incidentId: incident.id,
              cycle: input.capturedCycle!,
              kind: input.capturedKind,
              providerFamilyKey: input.capturedProviderFamilyKey,
            },
            current: {
              courseId: incident.courseId,
              incidentId: incident.id,
              cycle: incident.cycle,
              kind: incident.kind,
              providerFamilyKey: incident.providerFamilyKey,
              failureFingerprint: incident.failureFingerprint,
              providerSnapshotFingerprint:
                buildCourseSupportProviderSnapshotFingerprint(incident.course),
            },
            capturedAt: campaignCapturedAt,
            events: incident.monitoringEvents,
          })
        : null;
    const sameIdentityMaterialChangeIncompleteRecovery =
      sameIdentityMaterialChangeIncompleteRecoveryRequested &&
      currentCampaignMember &&
      descendantCampaignRun?.promptVersion ===
        PARKED_COURSE_CAMPAIGN_PROMPT_VERSION &&
      descendantCampaignRun.status === "RUNNING" &&
      descendantCampaignRun.completedAt === null &&
      descendantCampaignAudit &&
      descendantCampaignAudit.membershipDigest ===
        input.campaignMembershipDigest &&
      descendantCapturedMember &&
      campaignCapturedAt !== null &&
      Number.isFinite(campaignCapturedAt.getTime()) &&
      descendantCampaignAudit.capturedAt === input.campaignCapturedAt
        ? assessParkedCourseCampaignSameIdentityMaterialChangeIncompletePlaybookRecovery(
            {
              captured: descendantCapturedMember,
              current: currentCampaignMember,
              capturedAt: campaignCapturedAt,
              campaignRunId: input.campaignRunId,
              campaignMembershipDigest: input.campaignMembershipDigest,
            },
          )
        : null;
    const postMarkerIncompletePlaybookRecovery =
      postMarkerIncompletePlaybookRecoveryRequested &&
      currentCampaignMember &&
      descendantCampaignRun?.promptVersion ===
        PARKED_COURSE_CAMPAIGN_PROMPT_VERSION &&
      descendantCampaignRun.status === "RUNNING" &&
      descendantCampaignRun.completedAt === null &&
      descendantCampaignAudit &&
      descendantCampaignAudit.membershipDigest ===
        input.campaignMembershipDigest &&
      descendantCapturedMember &&
      campaignCapturedAt !== null &&
      Number.isFinite(campaignCapturedAt.getTime()) &&
      descendantCampaignAudit.capturedAt === input.campaignCapturedAt &&
      input.currentRuntimeVersion
        ? assessParkedCourseCampaignPostMarkerIncompletePlaybookRecovery({
            captured: descendantCapturedMember,
            current: currentCampaignMember,
            capturedAt: campaignCapturedAt,
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            currentRuntimeVersion: input.currentRuntimeVersion,
          })
        : null;
    const sameCycleRecoveryHistory =
      sameCycleRecoveryRequested && incident
        ? requestlessStaleOwnershipRecoveryRequested
          ? requestlessStaleOwnershipRecovery
          : postMarkerIncompletePlaybookRecoveryRequested
            ? (postMarkerIncompletePlaybookRecovery?.history ?? null)
            : sameIdentityMaterialChangeIncompleteRecoveryRequested
              ? (sameIdentityMaterialChangeIncompleteRecovery?.history ?? null)
              : assessParkedCourseCampaignSameCycleRecoveryHistory({
                  courseId: input.courseId,
                  cycle: incident.cycle,
                  entries: incident.batchIncidents,
                  requireOrchestrationOnly:
                    currentCycleOrchestrationRecoveryRequested,
                  requireStartedRequest:
                    descendantIncompletePlaybookRecoveryRequested ||
                    sameIdentityMaterialChangeIncompleteRecoveryRequested,
                })
        : null;
    if (
      !incident ||
      !status ||
      incident.courseId !== input.courseId ||
      incident.cycle !== input.expectedCycle ||
      incident.revision !== input.expectedRevision ||
      status.revision !== input.expectedMonitoringRevision ||
      !Number.isInteger(input.capturedRevision) ||
      input.capturedRevision < 0 ||
      input.capturedRevision > incident.revision ||
      !Number.isInteger(input.capturedMonitoringRevision) ||
      input.capturedMonitoringRevision < 0 ||
      input.capturedMonitoringRevision > status.revision ||
      !input.campaignRunId.trim() ||
      !/^[a-f0-9]{64}$/u.test(input.campaignMembershipDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.expectedProviderSnapshotFingerprint) ||
      !/^[a-f0-9]{64}$/u.test(input.expectedAttemptLedgerFingerprint) ||
      (zeroExecutionRecoveryRequested &&
        (!Number.isInteger(input.capturedCycle) ||
          input.expectedCycle !== (input.capturedCycle ?? 0) + 1 ||
          !input.currentRuntimeVersion ||
          !/^[a-f0-9]{64}$/u.test(
            input.expectedZeroExecutionHistoryDigest ?? "",
          ) ||
          !originalAdmission ||
          !automationStalledEndpoint ||
          automationStalledEndpoint.occurredAt < originalAdmission.occurredAt ||
          zeroExecutionRecoveryAlreadyRecorded ||
          !zeroExecutionHistory ||
          zeroExecutionHistory.historyDigest !==
            input.expectedZeroExecutionHistoryDigest)) ||
      (sameCycleRecoveryRequested &&
        (!Number.isInteger(input.capturedCycle) ||
          !/^[a-f0-9]{64}$/u.test(
            input.expectedSameCycleRecoveryHistoryDigest ?? "",
          ) ||
          !automationStalledEndpoint ||
          sameCycleRecoveryAlreadyRecorded ||
          !currentPlaybookAssessment ||
          currentPlaybookAssessment.valid !== true ||
          currentPlaybookAssessment.cycle !== incident.cycle ||
          currentPlaybookAssessment.conclusion !== "INCOMPLETE" ||
          currentPlaybookAssessment.nextStage === null ||
          currentPlaybookAssessment.nextStage !==
            input.expectedPlaybookNextStage ||
          currentPlaybookAssessment.completedStages.length !==
            input.expectedPlaybookCompletedStageCount ||
          !sameCycleRecoveryHistory ||
          sameCycleRecoveryHistory.historyDigest !==
            input.expectedSameCycleRecoveryHistoryDigest ||
          (incompletePlaybookRecoveryRequested &&
            (input.expectedCycle !== (input.capturedCycle ?? 0) + 1 ||
              !originalAdmission ||
              automationStalledEndpoint.occurredAt <
                originalAdmission.occurredAt ||
              currentPlaybookAssessment.completedStages.length === 0)) ||
          (postMarkerIncompletePlaybookRecoveryRequested &&
            (!descendantCampaignRun ||
              descendantCampaignRun.promptVersion !==
                PARKED_COURSE_CAMPAIGN_PROMPT_VERSION ||
              descendantCampaignRun.status !== "RUNNING" ||
              descendantCampaignRun.completedAt !== null ||
              !descendantCampaignAudit ||
              descendantCampaignAudit.membershipDigest !==
                input.campaignMembershipDigest ||
              descendantCampaignAudit.capturedAt !== input.campaignCapturedAt ||
              !descendantCapturedMember ||
              descendantCapturedMember.revision !== input.capturedRevision ||
              descendantCapturedMember.monitoringRevision !==
                input.capturedMonitoringRevision ||
              descendantCapturedMember.cycle !== input.capturedCycle ||
              descendantCapturedMember.kind !== input.capturedKind ||
              descendantCapturedMember.providerFamilyKey !==
                input.capturedProviderFamilyKey ||
              descendantCapturedMember.failureClass !==
                input.expectedFailureClass ||
              descendantCapturedMember.failureFingerprint !==
                input.expectedFailureFingerprint ||
              descendantCapturedMember.providerSnapshotFingerprint !==
                input.expectedProviderSnapshotFingerprint ||
              input.expectedLatestProbeId === undefined ||
              input.expectedLatestDiscoveryId === undefined ||
              (incident.course.probes[0]?.id ?? null) !==
                input.expectedLatestProbeId ||
              (incident.course.automationDiscoveries[0]?.id ?? null) !==
                input.expectedLatestDiscoveryId ||
              input.expectedCycle !== (input.capturedCycle ?? 0) + 1 ||
              !input.currentRuntimeVersion ||
              !/^[a-f0-9]{40}$/u.test(input.currentRuntimeVersion) ||
              currentPlaybookAssessment.completedStages.length !== 4 ||
              currentPlaybookAssessment.nextStage !==
                "RENDERED_BROWSER_DISCOVERY" ||
              !postMarkerIncompletePlaybookRecovery ||
              postMarkerIncompletePlaybookRecovery.history.historyDigest !==
                input.expectedSameCycleRecoveryHistoryDigest ||
              automationStalledEndpoint.id !==
                postMarkerIncompletePlaybookRecovery.supersededEndpointId ||
              automationStalledEndpoint.occurredAt.getTime() !==
                postMarkerIncompletePlaybookRecovery.supersededEndpointAt.getTime())) ||
          (descendantIncompletePlaybookRecoveryRequested &&
            (!descendantCapturedMember ||
              descendantCapturedMember.revision !== input.capturedRevision ||
              descendantCapturedMember.monitoringRevision !==
                input.capturedMonitoringRevision ||
              descendantCapturedMember.cycle !== input.capturedCycle ||
              descendantCapturedMember.kind !== input.capturedKind ||
              descendantCapturedMember.providerFamilyKey !==
                input.capturedProviderFamilyKey ||
              !descendantLineage ||
              automationStalledEndpoint.occurredAt <
                descendantLineage.lastHandoffAt ||
              currentPlaybookAssessment.completedStages.length === 0 ||
              sameCycleRecoveryHistory.startedRequestCount === 0)) ||
          (requestlessStaleOwnershipRecoveryRequested &&
            (!descendantCampaignAudit ||
              descendantCampaignAudit.membershipDigest !==
                input.campaignMembershipDigest ||
              descendantCampaignAudit.capturedAt !== input.campaignCapturedAt ||
              !descendantCapturedMember ||
              descendantCapturedMember.revision !== input.capturedRevision ||
              descendantCapturedMember.monitoringRevision !==
                input.capturedMonitoringRevision ||
              descendantCapturedMember.cycle !== input.capturedCycle ||
              descendantCapturedMember.kind !== input.capturedKind ||
              descendantCapturedMember.providerFamilyKey !==
                input.capturedProviderFamilyKey ||
              descendantCapturedMember.failureClass !==
                input.expectedFailureClass ||
              descendantCapturedMember.failureFingerprint !==
                input.expectedFailureFingerprint ||
              descendantCapturedMember.monitoringFailureFingerprint !==
                input.expectedMonitoringFailureFingerprint ||
              descendantCapturedMember.providerSnapshotFingerprint !==
                input.expectedProviderSnapshotFingerprint ||
              descendantCapturedMember.attemptLedgerFingerprint !==
                input.expectedAttemptLedgerFingerprint ||
              descendantCapturedMember.playbookConclusion !==
                input.expectedPlaybookConclusion ||
              descendantCapturedMember.latestProbeAt !==
                input.expectedLatestProbeAt ||
              descendantCapturedMember.latestDiscoveryAt !==
                input.expectedLatestDiscoveryAt ||
              input.expectedCycle !== (input.capturedCycle ?? 0) + 1 ||
              currentPlaybookAssessment.completedStages.length !== 0 ||
              currentPlaybookAssessment.nextStage !== "OFFICIAL_IDENTITY" ||
              !requestlessStaleOwnershipRecovery ||
              requestlessStaleOwnershipRecovery.historyDigest !==
                input.expectedSameCycleRecoveryHistoryDigest ||
              !input.currentRuntimeVersion ||
              requestlessStaleOwnershipRecovery.abandonedBaseRuntime ===
                input.currentRuntimeVersion)) ||
          (sameIdentityMaterialChangeIncompleteRecoveryRequested &&
            (!descendantCampaignRun ||
              descendantCampaignRun.promptVersion !==
                PARKED_COURSE_CAMPAIGN_PROMPT_VERSION ||
              descendantCampaignRun.status !== "RUNNING" ||
              descendantCampaignRun.completedAt !== null ||
              !descendantCampaignAudit ||
              descendantCampaignAudit.membershipDigest !==
                input.campaignMembershipDigest ||
              descendantCampaignAudit.capturedAt !== input.campaignCapturedAt ||
              !descendantCapturedMember ||
              descendantCapturedMember.revision !== input.capturedRevision ||
              descendantCapturedMember.monitoringRevision !==
                input.capturedMonitoringRevision ||
              descendantCapturedMember.cycle !== input.capturedCycle ||
              descendantCapturedMember.kind !== input.capturedKind ||
              descendantCapturedMember.providerFamilyKey !==
                input.capturedProviderFamilyKey ||
              descendantCapturedMember.failureClass !==
                input.expectedFailureClass ||
              descendantCapturedMember.failureFingerprint !==
                input.expectedFailureFingerprint ||
              input.expectedLatestProbeId === undefined ||
              input.expectedLatestDiscoveryId === undefined ||
              (incident.course.probes[0]?.id ?? null) !==
                input.expectedLatestProbeId ||
              (incident.course.automationDiscoveries[0]?.id ?? null) !==
                input.expectedLatestDiscoveryId ||
              input.expectedCycle !== (input.capturedCycle ?? 0) + 2 ||
              !sameIdentityMaterialChangeIncompleteRecovery ||
              sameIdentityMaterialChangeIncompleteRecovery.history
                .historyDigest !==
                input.expectedSameCycleRecoveryHistoryDigest ||
              sameIdentityMaterialChangeIncompleteRecovery.history
                .startedRequestCount < 1 ||
              automationStalledEndpoint.id !==
                sameIdentityMaterialChangeIncompleteRecovery.supersededEndpointId ||
              automationStalledEndpoint.occurredAt <
                sameIdentityMaterialChangeIncompleteRecovery.lineage
                  .materialChangeAt)) ||
          (currentCycleOrchestrationRecoveryRequested &&
            (input.expectedCycle !== (input.capturedCycle ?? 0) + 2 ||
              currentPlaybookAssessment.completedStages.length !== 0 ||
              !currentCycleOrchestrationLineage ||
              automationStalledEndpoint.occurredAt <
                currentCycleOrchestrationLineage.providerFamilyHandoffAt)))) ||
      incident.status !== "NEEDS_HUMAN" ||
      incident.humanReviewReason !== "AUTOMATION_STALLED" ||
      incident.kind !== input.expectedKind ||
      incident.providerFamilyKey !== input.expectedProviderFamilyKey ||
      incident.failureClass !== input.expectedFailureClass ||
      incident.failureFingerprint !== input.expectedFailureFingerprint ||
      status.failureFingerprint !==
        input.expectedMonitoringFailureFingerprint ||
      buildCourseSupportProviderSnapshotFingerprint(incident.course) !==
        input.expectedProviderSnapshotFingerprint ||
      createHash("sha256")
        .update(
          stableCourseProviderExecutionEvidenceValue(
            incident.attemptLedger ?? null,
          ),
        )
        .digest("hex") !== input.expectedAttemptLedgerFingerprint ||
      assessAutomationPlaybook(incident.attemptLedger, incident.cycle)
        .conclusion !== input.expectedPlaybookConclusion ||
      (incident.course.probes[0]?.observedAt.toISOString() ?? null) !==
        input.expectedLatestProbeAt ||
      (incident.course.automationDiscoveries[0]?.createdAt.toISOString() ??
        null) !== input.expectedLatestDiscoveryAt ||
      incident.activeBatchId !== null ||
      incident.nextAttemptAt !== null ||
      incident.resolution !== null ||
      incident.resolvedAt !== null ||
      incident.resolutionMessage !== null ||
      incident.resolutionNotifiedAt !== null ||
      incident.decisionActorId !== null ||
      incident.decisionAt !== null ||
      incident.decisionNote !== null ||
      incident.decisionEvidenceUrl !== null ||
      incident.decisionIdempotencyKey !== null ||
      status.state !== "ENGINEERING_VERIFICATION_NEEDED" ||
      status.nextAutomaticAttemptAt !== null ||
      status.revalidationRequestedAt !== null ||
      !hasDurableWaitForMaterialChangeProof({
        incidentId: incident.id,
        incidentCycle: incident.cycle,
        incidentStatus: incident.status,
        humanReviewReason: incident.humanReviewReason,
        incidentEscalatedAt: incident.escalatedAt,
        monitoringState: status.state,
        endpointEvents: incident.monitoringEvents.filter(
          (event) => event.failureFingerprint === incident.failureFingerprint,
        ),
      })
    ) {
      return { admitted: false as const };
    }

    if (sameCycleRecoveryRequested) {
      if (exactEvidenceRecoveryRequested) {
        const campaignAuditUnchanged =
          await transaction.automationRun.updateMany({
            where: {
              id: input.campaignRunId,
              promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
              status: "RUNNING",
              completedAt: null,
              audit: {
                equals: descendantCampaignRun!.audit as Prisma.InputJsonValue,
              },
            },
            data: { status: "RUNNING" },
          });
        if (campaignAuditUnchanged.count !== 1) {
          return { admitted: false as const };
        }

        const courseEvidenceUnchanged = await transaction.course.updateMany({
          where: {
            id: input.courseId,
            updatedAt: incident.course.updatedAt,
          },
          data: { updatedAt: incident.course.updatedAt },
        });
        if (courseEvidenceUnchanged.count !== 1) {
          return { admitted: false as const };
        }

        const currentCycleEntries =
          currentCampaignMember!.zeroExecutionEvidence.batchIncidents.filter(
            (entry) => entry.cycle === incident.cycle,
          );
        for (const entry of currentCycleEntries) {
          const batchUnchanged =
            await transaction.courseSupportBatch.updateMany({
              where: {
                id: entry.batch.id,
                status: entry.batch.status as CourseSupportBatchStatus,
                revision: entry.batch.revision,
                ownerAutomationRunId: entry.batch.ownerAutomationRunId,
                baseSha: entry.batch.baseSha,
                releaseSha: entry.batch.releaseSha,
                deployedAt: entry.batch.deployedAt,
                createdAt: entry.batch.createdAt,
                updatedAt: entry.batch.updatedAt,
                recheckDispatchKey: entry.batch.recheckDispatchKey,
                recheckDispatchStartedAt: entry.batch.recheckDispatchStartedAt,
                recheckDispatchedAt: entry.batch.recheckDispatchedAt,
                completedAt: entry.batch.completedAt,
                summary:
                  entry.batch.summary === null
                    ? { equals: Prisma.DbNull }
                    : {
                        equals: entry.batch.summary as Prisma.InputJsonValue,
                      },
              },
              data: { updatedAt: entry.batch.updatedAt },
            });
          if (batchUnchanged.count !== 1) {
            return { admitted: false as const };
          }

          if (entry.batch.ownerAutomationRun) {
            const ownerRunUnchanged =
              await transaction.automationRun.updateMany({
                where: {
                  id: entry.batch.ownerAutomationRun.id,
                  promptVersion: entry.batch.ownerAutomationRun.promptVersion,
                  kind: entry.batch.ownerAutomationRun.kind,
                  status: entry.batch.ownerAutomationRun.status,
                  runtimeVersion: entry.batch.ownerAutomationRun.runtimeVersion,
                  completedAt: entry.batch.ownerAutomationRun.completedAt,
                  outcome: entry.batch.ownerAutomationRun.outcome,
                  notes: entry.batch.ownerAutomationRun.notes,
                },
                data: {
                  status: entry.batch.ownerAutomationRun.status,
                  outcome: entry.batch.ownerAutomationRun.outcome,
                },
              });
            if (ownerRunUnchanged.count !== 1) {
              return { admitted: false as const };
            }
          }

          const batchIncidentUnchanged =
            await transaction.courseSupportBatchIncident.updateMany({
              where: {
                id: entry.id,
                batchId: entry.batchId,
                incidentId: entry.incidentId,
                courseId: entry.courseId,
                cycle: entry.cycle,
                result: entry.result as CourseSupportBatchIncidentResult,
                preProbeId: entry.preProbeId,
                postProbeId: entry.postProbeId,
                proofSnapshot:
                  entry.proofSnapshot === null
                    ? { equals: Prisma.DbNull }
                    : {
                        equals: entry.proofSnapshot as Prisma.InputJsonValue,
                      },
                verifiedIncidentUpdatedAt: entry.verifiedIncidentUpdatedAt,
                verifiedAt: entry.verifiedAt,
                createdAt: entry.createdAt,
                updatedAt: entry.updatedAt,
              },
              data: { updatedAt: entry.updatedAt },
            });
          if (batchIncidentUnchanged.count !== 1) {
            return { admitted: false as const };
          }
        }

        const currentCycleEntryIds = currentCycleEntries.map(
          (entry) => entry.id,
        );
        const currentCycleRequestIds =
          sameCycleRecoveryHistory!.requestFences.map((request) => request.id);
        const currentMonitoringEvents =
          currentCampaignMember!.zeroExecutionEvidence.monitoringEvents;
        if (
          currentMonitoringEvents.some(
            (event) => typeof event.id !== "string" || !event.id.trim(),
          )
        ) {
          return { admitted: false as const };
        }
        const currentMonitoringEventIds = currentMonitoringEvents.map(
          (event) => event.id!,
        );
        const [
          latestProbe,
          latestDiscovery,
          unexpectedCurrentCycleEntry,
          unexpectedCurrentCycleRequest,
          unexpectedMonitoringEvent,
        ] = await Promise.all([
          transaction.courseProbe.findFirst({
            where: { courseId: input.courseId },
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            select: { id: true, courseId: true, observedAt: true },
          }),
          transaction.courseAutomationDiscovery.findFirst({
            where: { courseId: input.courseId },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { id: true, courseId: true, createdAt: true },
          }),
          transaction.courseSupportBatchIncident.findFirst({
            where: {
              incidentId: incident.id,
              cycle: incident.cycle,
              id: { notIn: currentCycleEntryIds },
            },
            select: { id: true },
          }),
          transaction.courseSupportVerificationRequest.findFirst({
            where: {
              batchIncidentId: { in: currentCycleEntryIds },
              id: { notIn: currentCycleRequestIds },
            },
            select: { id: true },
          }),
          transaction.courseMonitoringEvent.findFirst({
            where: {
              incidentId: incident.id,
              occurredAt: { gte: new Date(input.campaignCapturedAt!) },
              id: { notIn: currentMonitoringEventIds },
            },
            select: { id: true },
          }),
        ]);
        if (
          (latestProbe?.observedAt.toISOString() ?? null) !==
            input.expectedLatestProbeAt ||
          (latestDiscovery
            ? `${latestDiscovery.id}:${latestDiscovery.createdAt.toISOString()}`
            : null) !==
            (incident.course.automationDiscoveries[0]
              ? `${incident.course.automationDiscoveries[0].id}:${incident.course.automationDiscoveries[0].createdAt.toISOString()}`
              : null) ||
          (latestDiscovery?.createdAt.toISOString() ?? null) !==
            input.expectedLatestDiscoveryAt ||
          (exactEvidenceRecoveryRequested &&
            ((latestProbe?.id ?? null) !== input.expectedLatestProbeId ||
              (latestDiscovery?.id ?? null) !==
                input.expectedLatestDiscoveryId)) ||
          unexpectedCurrentCycleEntry ||
          unexpectedCurrentCycleRequest ||
          unexpectedMonitoringEvent
        ) {
          return { admitted: false as const };
        }
        if (
          latestProbe &&
          !(await lockExactCourseProbeEvidence(transaction, latestProbe))
        ) {
          return { admitted: false as const };
        }
        if (
          latestDiscovery &&
          !(await lockExactCourseAutomationDiscoveryEvidence(
            transaction,
            latestDiscovery,
          ))
        ) {
          return { admitted: false as const };
        }
      }

      if (requestlessStaleOwnershipRecoveryRequested) {
        const staleRecovery = requestlessStaleOwnershipRecovery!;
        const campaignAuditUnchanged =
          await transaction.automationRun.updateMany({
            where: {
              id: input.campaignRunId,
              promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
              status: "RUNNING",
              completedAt: null,
              audit: {
                equals: descendantCampaignRun!.audit as Prisma.InputJsonValue,
              },
            },
            data: { status: "RUNNING" },
          });
        if (campaignAuditUnchanged.count !== 1) {
          return { admitted: false as const };
        }
        const batchUnchanged = await transaction.courseSupportBatch.updateMany({
          where: {
            id: staleRecovery.batchFence.id,
            status: staleRecovery.batchFence.status as CourseSupportBatchStatus,
            revision: staleRecovery.batchFence.revision,
            ownerAutomationRunId: staleRecovery.batchFence.ownerAutomationRunId,
            baseSha: staleRecovery.batchFence.baseSha,
            releaseSha: null,
            deployedAt: null,
            recheckDispatchKey: null,
            recheckDispatchStartedAt: null,
            recheckDispatchedAt: null,
            completedAt: staleRecovery.batchFence.completedAt,
            summary: {
              equals: staleRecovery.batchFence.summary as Prisma.InputJsonValue,
            },
          },
          data: { revision: { increment: 0 } },
        });
        if (batchUnchanged.count !== 1) {
          return { admitted: false as const };
        }
        const batchIncidentUnchanged =
          await transaction.courseSupportBatchIncident.updateMany({
            where: {
              id: staleRecovery.batchIncidentFence.id,
              batchId: staleRecovery.batchIncidentFence.batchId,
              incidentId: staleRecovery.batchIncidentFence.incidentId,
              courseId: staleRecovery.batchIncidentFence.courseId,
              cycle: staleRecovery.batchIncidentFence.cycle,
              result: staleRecovery.batchIncidentFence
                .result as CourseSupportBatchIncidentResult,
              preProbeId: staleRecovery.probeFence?.id ?? null,
              postProbeId: null,
              proofSnapshot: { equals: Prisma.DbNull },
              verifiedIncidentUpdatedAt: null,
              verifiedAt: null,
              createdAt: staleRecovery.batchIncidentFence.createdAt,
              updatedAt: staleRecovery.batchIncidentFence.updatedAt,
            },
            data: { updatedAt: staleRecovery.batchIncidentFence.updatedAt },
          });
        if (batchIncidentUnchanged.count !== 1) {
          return { admitted: false as const };
        }
        const ownerRunUnchanged = await transaction.automationRun.updateMany({
          where: {
            id: staleRecovery.ownerRunFence.id,
            promptVersion: staleRecovery.ownerRunFence.promptVersion,
            kind: "COURSE_SUPPORT",
            status: "COMPLETED",
            runtimeVersion: staleRecovery.ownerRunFence.runtimeVersion,
            completedAt: staleRecovery.ownerRunFence.completedAt,
            outcome: staleRecovery.ownerRunFence.outcome,
            notes: staleRecovery.ownerRunFence.notes,
          },
          data: {
            status: "COMPLETED",
            outcome: staleRecovery.ownerRunFence.outcome,
          },
        });
        if (ownerRunUnchanged.count !== 1) {
          return { admitted: false as const };
        }
        const [
          unexpectedCurrentCycleEntry,
          lateRecoveryMarker,
          lateProbe,
          lateDiscovery,
        ] = await Promise.all([
          transaction.courseSupportBatchIncident.findFirst({
            where: {
              incidentId: incident.id,
              cycle: incident.cycle,
              id: { not: staleRecovery.batchIncidentFence.id },
            },
            select: { id: true },
          }),
          transaction.courseMonitoringEvent.findFirst({
            where: {
              incidentId: incident.id,
              eventType: "REVALIDATION_REQUESTED",
              source: "COURSE_SUPPORT_RESPONDER",
              AND: [
                {
                  audit: {
                    path: ["action"],
                    equals:
                      "parked_cohort_requestless_stale_ownership_recovery",
                  },
                },
                { audit: { path: ["cycle"], equals: incident.cycle } },
              ],
            },
            select: { id: true },
          }),
          transaction.courseProbe.findFirst({
            where: { courseId: input.courseId },
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            select: { id: true, courseId: true, observedAt: true },
          }),
          transaction.courseAutomationDiscovery.findFirst({
            where: { courseId: input.courseId },
            select: { id: true },
          }),
        ]);
        if (
          unexpectedCurrentCycleEntry ||
          lateRecoveryMarker ||
          (staleRecovery.probeFence
            ? !lateProbe ||
              lateProbe.id !== staleRecovery.probeFence.id ||
              lateProbe.courseId !== staleRecovery.probeFence.courseId ||
              lateProbe.observedAt.getTime() !==
                staleRecovery.probeFence.observedAt.getTime()
            : lateProbe !== null) ||
          lateDiscovery
        ) {
          return { admitted: false as const };
        }
        if (
          staleRecovery.probeFence &&
          !(await lockExactCourseProbeEvidence(
            transaction,
            staleRecovery.probeFence,
          ))
        ) {
          return { admitted: false as const };
        }
      }
      for (const request of sameCycleRecoveryHistory!.requestFences) {
        const requestUnchanged =
          await transaction.courseSupportVerificationRequest.updateMany({
            where: {
              id: request.id,
              batchIncidentId: request.batchIncidentId,
              courseId: request.courseId,
              releaseSha: request.releaseSha,
              providerSnapshotFingerprint: request.providerSnapshotFingerprint,
              providerSnapshotAt: request.providerSnapshotAt,
              createdAt: request.createdAt,
              updatedAt: request.updatedAt,
              status: request.status,
              revision: request.revision,
              attemptCount: request.attemptCount,
              workflowRunId: request.workflowRunId,
              startedAt: request.startedAt,
              outcome: request.outcome,
              failureClass: request.failureClass,
              evidence:
                request.evidence === null
                  ? { equals: Prisma.DbNull }
                  : { equals: request.evidence as Prisma.InputJsonValue },
              lastError: request.lastError,
            },
            data: { updatedAt: request.updatedAt },
          });
        if (requestUnchanged.count !== 1) {
          return { admitted: false as const };
        }
      }
      for (const absentRequest of sameCycleRecoveryHistory!
        .absentRequestFences) {
        const lateRequest =
          await transaction.courseSupportVerificationRequest.findFirst({
            where: { batchIncidentId: absentRequest.batchIncidentId },
            select: { id: true },
          });
        if (lateRequest) {
          return { admitted: false as const };
        }
      }

      const action = sameCycleRecoveryAction!;
      const idempotencyKey = `course-support-${action.replaceAll("_", "-")}:${input.campaignRunId}:${incident.id}:${incident.cycle}`;
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            courseId: input.courseId,
            cycle: incident.cycle,
            revision: incident.revision,
            status: "NEEDS_HUMAN",
            humanReviewReason: "AUTOMATION_STALLED",
            kind: input.expectedKind,
            providerFamilyKey: input.expectedProviderFamilyKey,
            failureClass: input.expectedFailureClass,
            failureFingerprint: input.expectedFailureFingerprint,
            activeBatchId: null,
            nextAttemptAt: null,
            resolution: null,
            resolvedAt: null,
            resolutionMessage: null,
            resolutionNotifiedAt: null,
            decisionActorId: null,
            decisionAt: null,
            decisionNote: null,
            decisionEvidenceUrl: null,
            decisionIdempotencyKey: null,
          },
          data: {
            status: "AUTO_INVESTIGATING",
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              now,
              activeRealSearchCount,
            ),
            humanReviewReason: null,
            nextReminderAt: null,
            nextAttemptAt: now,
            nextAction: incompletePlaybookRecoveryRequested
              ? "Continue the current campaign cycle at the next incomplete ordered-playbook stage."
              : postMarkerIncompletePlaybookRecoveryRequested
                ? "Continue the unfinished rendered-browser stage on the newer exact runtime without discarding current-cycle evidence."
                : descendantIncompletePlaybookRecoveryRequested
                  ? "Continue the material-handoff descendant at its next incomplete ordered-playbook stage."
                  : requestlessStaleOwnershipRecoveryRequested
                    ? "Resume the current campaign cycle because stale endpoint ownership parked before any provider request or execution evidence existed."
                    : sameIdentityMaterialChangeIncompleteRecoveryRequested
                      ? "Continue the exact same-identity material-change cycle at its next incomplete ordered-playbook stage."
                      : "Retry provider verification in the current material-change cycle because prior orchestration never began execution.",
            lastSeenAt: now,
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        return { admitted: false as const };
      }
      const statusUpdated = await transaction.courseMonitoringStatus.updateMany(
        {
          where: {
            courseId: input.courseId,
            revision: status.revision,
            state: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: input.expectedMonitoringFailureFingerprint,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
          },
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: input.expectedFailureFingerprint,
            firstDegradedAt: now,
            nextAutomaticAttemptAt: now,
            revalidationRequestedAt: now,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        },
      );
      if (statusUpdated.count !== 1) {
        throw new Error(
          "The monitoring state changed during same-cycle campaign recovery.",
        );
      }
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          failureFingerprint: input.expectedFailureFingerprint,
          message: incompletePlaybookRecoveryRequested
            ? "The responder resumed the next incomplete playbook stage without discarding current-cycle evidence."
            : postMarkerIncompletePlaybookRecoveryRequested
              ? "The responder resumed the unfinished rendered-browser stage once on a newer exact runtime."
              : descendantIncompletePlaybookRecoveryRequested
                ? "The responder resumed the next incomplete playbook stage in the exact campaign material-handoff descendant."
                : requestlessStaleOwnershipRecoveryRequested
                  ? "The responder resumed the exact requestless campaign member after stale endpoint ownership parked it without execution."
                  : sameIdentityMaterialChangeIncompleteRecoveryRequested
                    ? "The responder resumed the next incomplete playbook stage in the exact same-identity operator material-change cycle."
                    : "The responder retried current-cycle orchestration without discarding the operator material-change evidence.",
          idempotencyKey,
          occurredAt: now,
          audit: {
            action,
            admissionMode: input.admissionMode,
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            capturedCycle: input.capturedCycle,
            cycle: incident.cycle,
            sameCycleRecoveryHistoryDigest:
              input.expectedSameCycleRecoveryHistoryDigest,
            descendantLineageDigest: descendantLineage?.lineageDigest ?? null,
            descendantHandoffCount: descendantLineage?.handoffCount ?? null,
            materialChangeLineageDigest:
              sameIdentityMaterialChangeIncompleteRecovery?.lineage
                .lineageDigest ?? null,
            batchCount: sameCycleRecoveryHistory!.batchCount,
            startedRequestCount:
              sameIdentityMaterialChangeIncompleteRecoveryRequested ||
              postMarkerIncompletePlaybookRecoveryRequested
                ? sameCycleRecoveryHistory!.startedRequestCount
                : null,
            priorRecoveryMarkerDigest:
              postMarkerIncompletePlaybookRecovery?.priorRecoveryMarkerDigest ??
              null,
            priorRecoveryRuntimeVersion:
              postMarkerIncompletePlaybookRecovery?.priorRecoveryRuntimeVersion ??
              null,
            failedRuntimeVersions:
              postMarkerIncompletePlaybookRecovery?.failedRuntimeVersions ??
              null,
            postMarkerHistoryDigest:
              postMarkerIncompletePlaybookRecovery?.postMarkerHistoryDigest ??
              null,
            postMarkerBatchCount:
              postMarkerIncompletePlaybookRecovery?.postMarkerBatchCount ??
              null,
            postMarkerRequestCount:
              postMarkerIncompletePlaybookRecovery?.postMarkerRequestCount ??
              null,
            providerSnapshotFingerprint:
              input.expectedProviderSnapshotFingerprint,
            attemptLedgerFingerprint: input.expectedAttemptLedgerFingerprint,
            latestProbeAt: input.expectedLatestProbeAt,
            latestDiscoveryAt: input.expectedLatestDiscoveryAt,
            playbookNextStage: input.expectedPlaybookNextStage,
            playbookCompletedStageCount:
              input.expectedPlaybookCompletedStageCount,
            supersededEndpointId:
              sameIdentityMaterialChangeIncompleteRecoveryRequested ||
              postMarkerIncompletePlaybookRecoveryRequested
                ? automationStalledEndpoint!.id
                : null,
            supersededEndpointAt:
              sameIdentityMaterialChangeIncompleteRecoveryRequested ||
              postMarkerIncompletePlaybookRecoveryRequested
                ? automationStalledEndpoint!.occurredAt.toISOString()
                : null,
            recoveryRuntimeVersion: input.currentRuntimeVersion ?? null,
            abandonedBaseRuntime:
              requestlessStaleOwnershipRecovery?.abandonedBaseRuntime ?? null,
            requestCount: requestlessStaleOwnershipRecoveryRequested
              ? sameCycleRecoveryHistory!.requestCount
              : null,
            releaseEvidenceAbsent: requestlessStaleOwnershipRecoveryRequested
              ? true
              : null,
            executionEvidenceAbsent: requestlessStaleOwnershipRecoveryRequested
              ? true
              : null,
            capturedIncidentRevision: input.capturedRevision,
            capturedMonitoringRevision: input.capturedMonitoringRevision,
            recoveredIncidentRevision: incident.revision,
            recoveredMonitoringRevision: status.revision,
            activeDemandAtRecovery: activeRealSearchCount > 0,
            sameCycleRecovery: true,
            oneShot: true,
            preservesAttemptLedger: true,
            preservesAttemptCounts: true,
            preservesAttemptTimestamps: true,
            preservesOperatorEvidence: true,
            preservesImmutableCampaignAudit: true,
            campaign: {
              kind: "PARKED_COHORT",
              runId: input.campaignRunId,
              membershipDigest: input.campaignMembershipDigest,
              cycle: incident.cycle,
            },
            customerDataIncluded: false,
          },
        },
      });
      return {
        admitted: true as const,
        incidentId: incident.id,
        courseId: input.courseId,
        cycle: incident.cycle,
      };
    }

    if (zeroExecutionRecoveryRequested) {
      for (const request of zeroExecutionHistory!.requestFences) {
        const requestUnchanged =
          await transaction.courseSupportVerificationRequest.updateMany({
            where: {
              id: request.id,
              batchIncidentId: request.batchIncidentId,
              releaseSha: request.releaseSha,
              status: request.status,
              revision: request.revision,
              attemptCount: request.attemptCount,
              startedAt: null,
              outcome: request.outcome,
              failureClass: request.failureClass,
              lastError: request.lastError,
            },
            data: { revision: { increment: 0 } },
          });
        if (requestUnchanged.count !== 1) {
          return { admitted: false as const };
        }
      }
      for (const absentRequest of zeroExecutionHistory!.absentRequestFences) {
        const lateRequest =
          await transaction.courseSupportVerificationRequest.findFirst({
            where: {
              batchIncidentId: absentRequest.batchIncidentId,
              releaseSha: absentRequest.releaseSha,
            },
            select: { id: true },
          });
        if (lateRequest) {
          return { admitted: false as const };
        }
      }
      const idempotencyKey = `course-support-parked-cohort-zero-execution:${input.campaignRunId}:${incident.id}:${incident.cycle}`;
      const incidentUpdated =
        await transaction.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            courseId: input.courseId,
            cycle: incident.cycle,
            revision: incident.revision,
            status: "NEEDS_HUMAN",
            humanReviewReason: "AUTOMATION_STALLED",
            kind: input.expectedKind,
            providerFamilyKey: input.expectedProviderFamilyKey,
            failureClass: input.expectedFailureClass,
            failureFingerprint: input.expectedFailureFingerprint,
            activeBatchId: null,
            nextAttemptAt: null,
            resolution: null,
            resolvedAt: null,
            resolutionMessage: null,
            resolutionNotifiedAt: null,
            decisionActorId: null,
            decisionAt: null,
            decisionNote: null,
            decisionEvidenceUrl: null,
            decisionIdempotencyKey: null,
          },
          data: {
            status: "AUTO_INVESTIGATING",
            lastAttemptAt: null,
            attemptCount: 0,
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              now,
              activeRealSearchCount,
            ),
            humanReviewReason: null,
            nextReminderAt: null,
            nextAttemptAt: now,
            nextAction:
              "Resume the current campaign cycle because its prior provider verification never began execution.",
            ownerNotifiedAt: null,
            escalatedAt: null,
            escalationNotifiedAt: null,
            lastSeenAt: now,
            revision: { increment: 1 },
          },
        });
      if (incidentUpdated.count !== 1) {
        return { admitted: false as const };
      }
      const statusUpdated = await transaction.courseMonitoringStatus.updateMany(
        {
          where: {
            courseId: input.courseId,
            revision: status.revision,
            state: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: input.expectedMonitoringFailureFingerprint,
            nextAutomaticAttemptAt: null,
            revalidationRequestedAt: null,
          },
          data: {
            state: "AUTO_INVESTIGATING",
            failureFingerprint: input.expectedFailureFingerprint,
            firstDegradedAt: now,
            nextAutomaticAttemptAt: now,
            revalidationRequestedAt: now,
            stateChangedAt: now,
            revision: { increment: 1 },
          },
        },
      );
      if (statusUpdated.count !== 1) {
        throw new Error(
          "The monitoring state changed during zero-execution campaign recovery.",
        );
      }
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: input.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: "COURSE_SUPPORT_RESPONDER",
          fromState: "ENGINEERING_VERIFICATION_NEEDED",
          toState: "AUTO_INVESTIGATING",
          failureFingerprint: input.expectedFailureFingerprint,
          message:
            "The responder resumed one campaign member whose prior provider verification never began execution.",
          idempotencyKey,
          occurredAt: now,
          audit: {
            action: "parked_cohort_zero_execution_recovery",
            campaignRunId: input.campaignRunId,
            campaignMembershipDigest: input.campaignMembershipDigest,
            capturedCycle: input.capturedCycle,
            cycle: incident.cycle,
            zeroExecutionHistoryDigest:
              input.expectedZeroExecutionHistoryDigest,
            recoveryRuntimeVersion: input.currentRuntimeVersion,
            capturedIncidentRevision: input.capturedRevision,
            capturedMonitoringRevision: input.capturedMonitoringRevision,
            recoveredIncidentRevision: incident.revision,
            recoveredMonitoringRevision: status.revision,
            activeDemandAtRecovery: activeRealSearchCount > 0,
            sameCycleRecovery: true,
            oneShot: true,
            customerDataIncluded: false,
          },
        },
      });
      return {
        admitted: true as const,
        incidentId: incident.id,
        courseId: input.courseId,
        cycle: incident.cycle,
      };
    }

    const nextCycle = incident.cycle + 1;
    const idempotencyKey = `course-support-parked-cohort:${input.campaignRunId}:${incident.id}:${nextCycle}`;
    const incidentUpdated = await transaction.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        courseId: input.courseId,
        cycle: incident.cycle,
        revision: incident.revision,
        status: "NEEDS_HUMAN",
        humanReviewReason: "AUTOMATION_STALLED",
        kind: input.expectedKind,
        providerFamilyKey: input.expectedProviderFamilyKey,
        failureClass: input.expectedFailureClass,
        failureFingerprint: input.expectedFailureFingerprint,
        activeBatchId: null,
        nextAttemptAt: null,
        resolution: null,
        resolvedAt: null,
        resolutionMessage: null,
        resolutionNotifiedAt: null,
        decisionActorId: null,
        decisionAt: null,
        decisionNote: null,
        decisionEvidenceUrl: null,
        decisionIdempotencyKey: null,
      },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        lastAttemptAt: null,
        attemptCount: 0,
        confirmedAt: now,
        escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
          now,
          activeRealSearchCount,
        ),
        humanReviewReason: null,
        nextReminderAt: null,
        nextAttemptAt: now,
        nextAction:
          "Run the fresh ordered playbook from official identity through independent confirmation.",
        ownerNotifiedAt: null,
        escalatedAt: null,
        escalationNotifiedAt: null,
        lastSeenAt: now,
        revision: { increment: 1 },
      },
    });
    if (incidentUpdated.count !== 1) {
      return { admitted: false as const };
    }
    const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
      where: {
        courseId: input.courseId,
        revision: status.revision,
        state: "ENGINEERING_VERIFICATION_NEEDED",
        failureFingerprint: input.expectedMonitoringFailureFingerprint,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      },
      data: {
        state: "AUTO_INVESTIGATING",
        failureFingerprint: input.expectedFailureFingerprint,
        firstDegradedAt: now,
        nextAutomaticAttemptAt: now,
        revalidationRequestedAt: now,
        stateChangedAt: now,
        revision: { increment: 1 },
      },
    });
    if (statusUpdated.count !== 1) {
      throw new Error(
        "The monitoring state changed while a parked-course campaign member was admitted.",
      );
    }
    await transaction.courseMonitoringEvent.create({
      data: {
        courseId: input.courseId,
        incidentId: incident.id,
        eventType: "REVALIDATION_REQUESTED",
        source: "COURSE_SUPPORT_RESPONDER",
        fromState: "ENGINEERING_VERIFICATION_NEEDED",
        toState: "AUTO_INVESTIGATING",
        failureFingerprint: input.expectedFailureFingerprint,
        message:
          "The responder admitted one parked campaign member to a fresh ordered-playbook cycle.",
        idempotencyKey,
        occurredAt: now,
        audit: {
          action: "parked_cohort_admission",
          campaignRunId: input.campaignRunId,
          campaignMembershipDigest: input.campaignMembershipDigest,
          admissionRuntimeVersion: input.currentRuntimeVersion ?? null,
          priorCycle: incident.cycle,
          cycle: nextCycle,
          capturedIncidentRevision: input.capturedRevision,
          capturedMonitoringRevision: input.capturedMonitoringRevision,
          admittedIncidentRevision: incident.revision,
          admittedMonitoringRevision: status.revision,
          activeDemandAtAdmission: activeRealSearchCount > 0,
          preservesPriorAttemptEvents: true,
          customerDataIncluded: false,
        },
      },
    });
    return {
      admitted: true as const,
      incidentId: incident.id,
      courseId: input.courseId,
      cycle: nextCycle,
    };
  })();
}

export async function runSerializedCourseMonitoringWrite<T>(
  courseId: string,
  worker: (transaction: Prisma.TransactionClient) => Promise<T>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
) {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= COURSE_MONITORING_WRITE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await acquireCourseMonitoringWriteLock(transaction, courseId);
          return worker(transaction);
        },
        {
          isolationLevel:
            options?.isolationLevel ??
            Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: COURSE_MONITORING_WRITE_TIMEOUT_MS,
        },
      );
    } catch (error) {
      lastError = error;
      if (
        !isRetryableCourseMonitoringWriteError(error) ||
        attempt === COURSE_MONITORING_WRITE_ATTEMPTS
      ) {
        throw error;
      }
      await delayCourseMonitoringRetry(attempt * 20);
    }
  }
  throw lastError;
}

async function acquireCourseMonitoringWriteLock(
  transaction: Prisma.TransactionClient,
  courseId: string,
) {
  const query = (
    transaction as Prisma.TransactionClient & {
      $queryRawUnsafe?: <T = unknown>(
        sql: string,
        ...values: unknown[]
      ) => Promise<T>;
    }
  ).$queryRawUnsafe;
  if (!query) {
    return;
  }
  await query.call(
    transaction,
    `WITH acquired AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
     )
     SELECT true AS locked FROM acquired`,
    `course-monitoring:${courseId}`,
  );
}

function isRetryableCourseMonitoringWriteError(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  if (["P2025", "P2028", "P2034"].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /write conflict|deadlock|transaction.*closed/i.test(message);
}

function delayCourseMonitoringRetry(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function createMonitoringReference() {
  return `cm_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function createIncidentReference() {
  return `csi_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function createCourseMonitoringSafeReference(courseId: string) {
  return `course_${createHash("sha256").update(courseId).digest("hex").slice(0, 12)}`;
}

function createDeadlineContinuationIdempotencyKey(input: {
  courseId: string;
  incidentId: string;
  cycle: number;
  escalationDeadlineAt: Date | null;
  nextStage: string | null;
}) {
  return `course-deadline-continue:${createHash("sha256")
    .update(
      `${input.courseId}:${input.incidentId}:${input.cycle}:${
        input.escalationDeadlineAt?.toISOString() ?? "missing"
      }:${input.nextStage ?? "complete"}`,
    )
    .digest("hex")}`;
}

function createDeadlineStallIdempotencyKey(input: {
  courseId: string;
  incidentId: string;
  cycle: number;
  escalationDeadlineAt: Date | null;
}) {
  return `course-deadline-stalled:${createHash("sha256")
    .update(
      `${input.courseId}:${input.incidentId}:${input.cycle}:${
        input.escalationDeadlineAt?.toISOString() ?? "missing"
      }`,
    )
    .digest("hex")}`;
}

function asMonitoringJsonRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseMonitoringAutomationRunNotes(value: string | null | undefined) {
  if (!value) {
    return {} as Record<string, unknown>;
  }
  try {
    return asMonitoringJsonRecord(JSON.parse(value) as unknown);
  } catch {
    return {} as Record<string, unknown>;
  }
}

function normalizeReadPath(value: string) {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:_-]/gu, "_")
    .slice(0, 80);
  return normalized || "UNKNOWN_PUBLIC_READ";
}

function normalizeFingerprint(value: string) {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9:._-]/gu, "_")
    .slice(0, 160);
  return normalized || "UNKNOWN";
}

function sanitizeMonitoringMessage(value: string | null | undefined) {
  if (!value?.trim()) {
    return undefined;
  }
  return sanitizeResponderText(value).slice(0, 500);
}

const SAFE_EXACT_EVIDENCE_FRAGMENT = /^#[a-z][a-z0-9_.:-]{0,199}$/iu;
const SENSITIVE_EXACT_EVIDENCE_FRAGMENT =
  /(?:^|[#_.:-])(?:access[-_]?token|api[-_]?key|auth(?:orization)?[-_]?code|credential|id[-_]?token|password|recipient|secret|session|signature)(?:$|[#_.:-])/iu;

export function sanitizeEvidenceUrl(value: string | null | undefined) {
  return sanitizeEvidenceUrlWithFragmentPolicy(value, false);
}

export function sanitizeExactEvidenceUrl(value: string | null | undefined) {
  return sanitizeEvidenceUrlWithFragmentPolicy(value, true);
}

function sanitizeEvidenceUrlWithFragmentPolicy(
  value: string | null | undefined,
  preserveSafeFragment: boolean,
) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }
    if (
      [...url.searchParams.keys()].some((key) =>
        /(?:token|secret|signature|credential|password|authorization|session|email|recipient|api[_-]?key|code)/iu.test(
          key,
        ),
      )
    ) {
      return null;
    }
    if (preserveSafeFragment && url.hash) {
      if (
        !SAFE_EXACT_EVIDENCE_FRAGMENT.test(url.hash) ||
        SENSITIVE_EXACT_EVIDENCE_FRAGMENT.test(url.hash)
      ) {
        return null;
      }
    } else {
      url.hash = "";
    }
    const serialized = url.toString();
    return serialized.length <= 1000 ? serialized : null;
  } catch {
    return null;
  }
}

function normalizeRuntimeVersion(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 100) : null;
}

function getAutomaticDeploymentSha(
  source: CourseMonitoringEventSource,
  runtimeVersion: string | null | undefined,
) {
  return source === "SEARCH_WORKFLOW" || source === "RECOVERY_CRON"
    ? normalizeDeploymentSha(runtimeVersion)
    : null;
}

function normalizeDeploymentSha(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[a-f0-9]{7,40}$/u.test(normalized) ? normalized : null;
}

function normalizeMonitoringIdempotencyKey(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (
    normalized.length < 16 ||
    normalized.length > 100 ||
    !/^[A-Za-z0-9:_-]+$/u.test(normalized)
  ) {
    throw new Error("The playbook idempotency key is invalid.");
  }
  return normalized;
}

type SearchWorkflowMonitoringRetryStatus = {
  courseId: string;
  state: CourseMonitoringState;
  nextAutomaticAttemptAt: Date | null;
};

type SearchWorkflowMonitoringRetryIncident = {
  courseId: string;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
  humanReviewReason: CourseHumanReviewReason | null;
  escalationDeadlineAt: Date | null;
};

export function selectSearchWorkflowMonitoringRetryAt(input: {
  statuses: SearchWorkflowMonitoringRetryStatus[];
  incidents?: SearchWorkflowMonitoringRetryIncident[];
  transientRetryCourseIds: string[];
  now: Date;
}) {
  const statusByCourseId = new Map(
    input.statuses.map((status) => [status.courseId, status] as const),
  );
  const candidates = input.statuses.flatMap((status) => {
    if (
      !status.nextAutomaticAttemptAt ||
      ![
        "DEGRADED_RETRYING",
        "ENGINEERING_VERIFICATION_NEEDED",
        "REVALIDATING_FINAL",
      ].includes(status.state)
    ) {
      return [];
    }
    return [
      status.nextAutomaticAttemptAt > input.now
        ? status.nextAutomaticAttemptAt
        : status.state === "DEGRADED_RETRYING"
          ? input.now
          : new Date(input.now.getTime() + FIRST_FAILURE_RETRY_MS),
    ];
  });
  for (const incident of input.incidents ?? []) {
    if (
      incident.status === "AUTO_INVESTIGATING" &&
      !incident.humanReviewReason &&
      incident.escalationDeadlineAt
    ) {
      candidates.push(incident.escalationDeadlineAt);
    }
  }

  const needsTransientRetry = input.transientRetryCourseIds.some((courseId) => {
    const status = statusByCourseId.get(courseId);
    return (
      !status ||
      status.state === "UNKNOWN" ||
      status.state === "HEALTHY" ||
      (status.state === "DEGRADED_RETRYING" && !status.nextAutomaticAttemptAt)
    );
  });
  if (needsTransientRetry) {
    candidates.push(new Date(input.now.getTime() + FIRST_FAILURE_RETRY_MS));
  }

  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ?? null;
}

export async function getCourseMonitoringRetryAt(
  courseIds: string[],
  options?: {
    transientRetryCourseIds?: string[];
    now?: Date;
  },
) {
  const transientRetryCourseIds = [
    ...new Set(options?.transientRetryCourseIds ?? []),
  ];
  const uniqueCourseIds = [
    ...new Set([...courseIds, ...transientRetryCourseIds]),
  ];
  if (uniqueCourseIds.length === 0 || !hasMonitoringModels(prisma)) {
    return null;
  }
  const [statuses, incidents] = await Promise.all([
    prisma.courseMonitoringStatus.findMany({
      where: {
        courseId: { in: uniqueCourseIds },
      },
      select: {
        courseId: true,
        state: true,
        nextAutomaticAttemptAt: true,
      },
    }),
    prisma.courseSupportIncident.findMany({
      where: {
        courseId: { in: uniqueCourseIds },
        status: "AUTO_INVESTIGATING",
        humanReviewReason: null,
        escalationDeadlineAt: { not: null },
      },
      select: {
        courseId: true,
        status: true,
        humanReviewReason: true,
        escalationDeadlineAt: true,
      },
    }),
  ]);
  return selectSearchWorkflowMonitoringRetryAt({
    statuses,
    incidents,
    transientRetryCourseIds,
    now: options?.now ?? new Date(),
  });
}

function hasMonitoringModels(client: typeof prisma) {
  const partial = client as unknown as {
    courseMonitoringStatus?: unknown;
    courseMonitoringEvent?: unknown;
  };
  return Boolean(
    partial.courseMonitoringStatus && partial.courseMonitoringEvent,
  );
}
