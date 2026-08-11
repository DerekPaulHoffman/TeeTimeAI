import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type CourseHumanReviewReason,
  type CourseMonitoringEventSource,
  type CourseMonitoringState,
  type ProbeOutcome,
} from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { sanitizeResponderText } from "./course-support-responder-policy";
import {
  appendAutomationPlaybookEvent,
  assessAutomationPlaybook,
  isAutomationPlaybookExhausted,
  serializeAutomationPlaybookLedger,
  type AutomationPlaybookEventInput,
} from "./course-monitoring-playbook";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";

export const FAILURE_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;
export const FIRST_FAILURE_RETRY_MS = 2 * 60 * 1000;
export const ACTIVE_DEMAND_ESCALATION_MS = 30 * 60 * 1000;
export const INACTIVE_INVESTIGATION_MS = 30 * 60 * 1000;
export const ACTIVE_HUMAN_RETRY_MS = 6 * 60 * 60 * 1000;
export const INACTIVE_HUMAN_RETRY_MS = 6 * 60 * 60 * 1000;
export const ACTIVE_REMINDER_MS = 24 * 60 * 60 * 1000;
export const INACTIVE_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;
export const DEPLOYMENT_REVALIDATION_BATCH_SIZE = 20;

const DEPLOYMENT_REVALIDATION_PROMPT_VERSION =
  "course-monitoring-deployment-revalidation-v1";

const AUTOMATED_STATES: CourseMonitoringState[] = [
  "DEGRADED_RETRYING",
  "AUTO_INVESTIGATING",
  "ENGINEERING_VERIFICATION_NEEDED",
  "REVALIDATING_FINAL",
];
const COURSE_MONITORING_WRITE_ATTEMPTS = 3;
const COURSE_MONITORING_WRITE_TIMEOUT_MS = 15_000;

type FailureObservation = {
  readPath: string | null;
  failureFingerprint: string | null;
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
  const observations = [...previousFailures, current];
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
      ? ACTIVE_DEMAND_ESCALATION_MS
      : INACTIVE_INVESTIGATION_MS;
  return new Date(episodeStartedAt.getTime() + escalationMs);
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
  readPath: string;
  message?: string;
  source?: CourseMonitoringEventSource;
  activeRealSearchCount: number;
  now?: Date;
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
      nextAttemptAt: new Date(now.getTime() + FIRST_FAILURE_RETRY_MS),
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
          status: true,
          resolution: true,
          failureFingerprint: true,
          revision: true,
          activeRealSearchCount: true,
        },
      });

      const retainedFinalState =
        incident?.status === "RESOLVED" &&
        incident.resolution &&
        incident.resolution !== "MONITORING_RESTORED" &&
        !input.materialEvidenceChanged &&
        [
          "FINAL_MANUAL",
          "FINAL_TECHNICAL",
          "FINAL_IDENTITY",
          "REVALIDATING_FINAL",
        ].includes(current.state)
          ? incident.resolution === "DIRECT_BOOKING_CLASSIFIED"
            ? ("FINAL_MANUAL" as const)
            : incident.resolution === "IDENTITY_CLASSIFIED"
              ? ("FINAL_IDENTITY" as const)
              : ("FINAL_TECHNICAL" as const)
          : null;
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
        const retryAt = getHumanReviewRetryAt(
          now,
          incident?.activeRealSearchCount ?? input.activeRealSearchCount,
        );
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
            nextAutomaticAttemptAt: retryAt,
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
              nextAttemptAt: retryAt,
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
            retainedHumanReview: true,
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
          nextAttemptAt: retryAt,
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
      const nextAttemptAt = decision.confirmed
        ? now
        : new Date(now.getTime() + FIRST_FAILURE_RETRY_MS);
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
          firstDegradedAt: current.firstDegradedAt ?? now,
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
        select: { id: true },
      });
      const status = await transaction.courseMonitoringStatus.update({
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
          occurredAt: now,
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
      const stateChanged = current.state !== input.state;
      const snapshotNeedsRepair =
        current.consecutiveFailures !== 0 ||
        current.failureFingerprint !== null ||
        current.firstDegradedAt !== null ||
        current.nextAutomaticAttemptAt !== null ||
        current.revalidationRequestedAt !== null;
      if (!stateChanged && !snapshotNeedsRepair) {
        return current;
      }
      const status = await transaction.courseMonitoringStatus.update({
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
      });
      if (stateChanged) {
        await appendMonitoringEvent(transaction, {
          courseId: input.courseId,
          eventType: "STATE_CHANGED",
          source,
          fromState: current.state,
          toState: input.state,
          outcome: input.outcome,
          message: sanitizeMonitoringMessage(input.message),
          evidenceUrl: sanitizeEvidenceUrl(input.evidenceUrl),
          runtimeVersion: input.runtimeVersion,
          occurredAt: now,
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
        select: { id: true, cycle: true, attemptLedger: true },
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
        occurredAt: now,
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

const MATERIAL_PROVIDER_EVIDENCE_FIELDS = [
  "website",
  "detectedBookingUrl",
  "detectedPlatform",
  "providerFamilyKey",
  "bookingMethod",
  "bookingAccessMode",
  "automationEligibility",
  "automationReason",
  "monitoringMode",
  "bookingMetadata",
] as const;

type MaterialProviderEvidenceField =
  (typeof MATERIAL_PROVIDER_EVIDENCE_FIELDS)[number];

export type CourseProviderEvidenceSnapshot = Partial<
  Record<MaterialProviderEvidenceField, unknown>
> &
  Record<string, unknown>;

export type ProviderEvidenceRevalidationOutcome =
  | "IMMATERIAL"
  | "NOT_ACTIONABLE"
  | "REPLAYED"
  | "AUTHORITATIVE_FINAL_PRESERVED"
  | "REQUEUED";

export function shouldOpenFreshPlaybookCycleForProviderEvidence(input: {
  status: string;
  humanReviewReason?: string | null;
}) {
  return (
    input.status === "NEEDS_HUMAN" ||
    (input.status === "AUTO_INVESTIGATING" &&
      input.humanReviewReason === "AUTOMATION_STALLED")
  );
}

export function getMaterialProviderEvidenceChanges(
  before: CourseProviderEvidenceSnapshot,
  after: CourseProviderEvidenceSnapshot,
) {
  return MATERIAL_PROVIDER_EVIDENCE_FIELDS.filter(
    (field) =>
      stableProviderEvidenceValue(before[field]) !==
      stableProviderEvidenceValue(after[field]),
  );
}

export async function revalidateCourseMonitoringForProviderEvidenceChange(input: {
  courseId: string;
  before: CourseProviderEvidenceSnapshot;
  after: CourseProviderEvidenceSnapshot;
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
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    (transaction) =>
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
        failureFingerprint: true,
        humanReviewReason: true,
        resolution: true,
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
  if (!incident || incident.activeBatchId) {
    return {
      outcome: "NOT_ACTIONABLE" as const,
      changedFields,
      searchesQueued: 0,
    };
  }

  const evidenceFingerprint = createHash("sha256")
    .update(
      stableProviderEvidenceValue(
        Object.fromEntries(
          MATERIAL_PROVIDER_EVIDENCE_FIELDS.map((field) => [
            field,
            input.after[field],
          ]),
        ),
      ),
    )
    .digest("hex");
  const idempotencyKey = `course-provider-evidence-revalidate:${createHash(
    "sha256",
  )
    .update(
      `${input.courseId}:${incident.id}:${incident.cycle}:${evidenceFingerprint}`,
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

  const automationStalled = incident.humanReviewReason === "AUTOMATION_STALLED";
  if (!shouldOpenFreshPlaybookCycleForProviderEvidence(incident)) {
    return {
      outcome: "NOT_ACTIONABLE" as const,
      changedFields,
      searchesQueued: 0,
    };
  }

  const nextCycle = incident.cycle + 1;
  const incidentUpdated =
    await transaction.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        cycle: incident.cycle,
        revision: incident.revision,
        activeBatchId: null,
        OR: [
          { status: "NEEDS_HUMAN" },
          {
            status: "AUTO_INVESTIGATING",
            humanReviewReason: "AUTOMATION_STALLED",
          },
        ],
      },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
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
        lastSeenAt: input.now,
        revision: { increment: 1 },
      },
    });
  if (incidentUpdated.count !== 1) {
    return {
      outcome: "NOT_ACTIONABLE" as const,
      changedFields,
      searchesQueued: 0,
    };
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
          state: "AUTO_INVESTIGATING",
          nextAutomaticAttemptAt: input.now,
          revalidationRequestedAt: input.now,
          stateChangedAt: input.now,
          revision: { increment: 1 },
        },
      });
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
        failureFingerprint: incident.failureFingerprint,
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
      failureFingerprint: incident.failureFingerprint,
      message:
        "Material provider evidence changed, so a fresh ordered-playbook cycle was queued.",
      idempotencyKey,
      occurredAt: input.now,
      audit: {
        priorCycle: incident.cycle,
        cycle: nextCycle,
        reason: automationStalled
          ? "AUTOMATION_STALLED_PROVIDER_EVIDENCE_CHANGED"
          : "HUMAN_REVIEW_PROVIDER_EVIDENCE_CHANGED",
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
  const deploymentMarker = await prisma.automationRun.upsert({
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
        "Recorded the deployed runtime boundary for bounded course revalidation.",
    },
    update: {},
    select: { startedAt: true },
  });
  const deploymentObservedAt = deploymentMarker.startedAt;
  const candidates = await prisma.courseSupportIncident.findMany({
    where: {
      activeBatchId: null,
      AND: [
        {
          OR: [
            { status: "NEEDS_HUMAN" },
            {
              status: "AUTO_INVESTIGATING",
              humanReviewReason: "AUTOMATION_STALLED",
            },
          ],
        },
        {
          OR: [
            { escalatedAt: { lte: deploymentObservedAt } },
            {
              escalatedAt: null,
              firstSeenAt: { lte: deploymentObservedAt },
            },
          ],
        },
      ],
      monitoringEvents: {
        none: {
          source: "DEPLOYMENT",
          deploymentSha,
          eventType: {
            in: ["REVALIDATION_REQUESTED", "DEPLOYMENT_VERIFIED"],
          },
        },
      },
    },
    orderBy: [{ escalatedAt: "asc" }, { firstSeenAt: "asc" }],
    take: DEPLOYMENT_REVALIDATION_BATCH_SIZE,
    select: { courseId: true },
  });

  let requeued = 0;
  let retainedAuthoritativeFinals = 0;
  for (const candidate of candidates) {
    const outcome = await runSerializedCourseMonitoringWrite(
      candidate.courseId,
      async (transaction) => {
        const idempotencyKey = createDeploymentRevalidationIdempotencyKey(
          candidate.courseId,
          deploymentSha,
        );
        const replay = await transaction.courseMonitoringEvent.findUnique({
          where: { idempotencyKey },
          select: { id: true },
        });
        if (replay) {
          return "REPLAYED" as const;
        }

        const incident = await transaction.courseSupportIncident.findUnique({
          where: { courseId: candidate.courseId },
          select: {
            id: true,
            cycle: true,
            revision: true,
            status: true,
            humanReviewReason: true,
            activeBatchId: true,
            failureFingerprint: true,
            activeRealSearchCount: true,
            escalatedAt: true,
            firstSeenAt: true,
          },
        });
        const deploymentRevalidationEligible = Boolean(
          incident &&
            (incident.status === "NEEDS_HUMAN" ||
              (incident.status === "AUTO_INVESTIGATING" &&
                incident.humanReviewReason === "AUTOMATION_STALLED")),
        );
        if (
          !incident ||
          !deploymentRevalidationEligible ||
          incident.activeBatchId ||
          (incident.escalatedAt ?? incident.firstSeenAt) > deploymentObservedAt
        ) {
          return "SKIPPED" as const;
        }

        const current = await ensureMonitoringStatus(
          transaction,
          candidate.courseId,
          now,
        );
        if (
          current.state === "FINAL_MANUAL" ||
          current.state === "FINAL_IDENTITY"
        ) {
          await transaction.courseMonitoringEvent.create({
            data: {
              courseId: candidate.courseId,
              incidentId: incident.id,
              eventType: "DEPLOYMENT_VERIFIED",
              source: "DEPLOYMENT",
              fromState: current.state,
              toState: current.state,
              message:
                "A new deployment preserved the authoritative factual final classification.",
              deploymentSha,
              idempotencyKey,
              occurredAt: now,
              audit: {
                cycle: incident.cycle,
                authoritativeFinalRetained: true,
                customerDataIncluded: false,
              },
            },
          });
          return "RETAINED_FINAL" as const;
        }

        const nextCycle = incident.cycle + 1;
        const incidentUpdated =
          await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              cycle: incident.cycle,
              revision: incident.revision,
              status: incident.status,
              humanReviewReason: incident.humanReviewReason,
              activeBatchId: null,
            },
            data: {
              cycle: { increment: 1 },
              status: "AUTO_INVESTIGATING",
              confirmedAt: now,
              escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                now,
                incident.activeRealSearchCount,
              ),
              humanReviewReason: null,
              nextReminderAt: null,
              nextAttemptAt: now,
              nextAction:
                "Run a fresh current-cycle ordered playbook against the deployed runtime.",
              lastSeenAt: now,
              revision: { increment: 1 },
            },
          });
        const statusUpdated =
          await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: candidate.courseId,
              revision: current.revision,
              state: current.state,
            },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: now,
              revalidationRequestedAt: now,
              stateChangedAt: now,
              revision: { increment: 1 },
            },
          });
        if (incidentUpdated.count !== 1 || statusUpdated.count !== 1) {
          throw new Error(
            "The course changed while deployment revalidation was queued.",
          );
        }
        await queueActiveRealSearchesForCourse(
          transaction,
          candidate.courseId,
          now,
        );
        await transaction.courseMonitoringEvent.create({
          data: {
            courseId: candidate.courseId,
            incidentId: incident.id,
            eventType: "REVALIDATION_REQUESTED",
            source: "DEPLOYMENT",
            fromState: current.state,
            toState: "AUTO_INVESTIGATING",
            failureFingerprint: incident.failureFingerprint,
            message:
              "A new deployed runtime opened one bounded fresh playbook cycle.",
            deploymentSha,
            idempotencyKey,
            occurredAt: now,
            audit: {
              priorCycle: incident.cycle,
              cycle: nextCycle,
              escalationMinutes: 30,
              customerDataIncluded: false,
            },
          },
        });
        return "REQUEUED" as const;
      },
    );
    if (outcome === "REQUEUED") {
      requeued += 1;
    } else if (outcome === "RETAINED_FINAL") {
      retainedAuthoritativeFinals += 1;
    }
  }

  return {
    considered: candidates.length,
    requeued,
    retainedAuthoritativeFinals,
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

  let scheduled = 0;
  let escalated = 0;
  const humanReviewIds: string[] = [];

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
            ? {
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
          nextAttemptAt: promotedToRealDemand ? now : incident.nextAttemptAt,
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
      (status.state === "AUTO_INVESTIGATING" ||
        status.state === "ENGINEERING_VERIFICATION_NEEDED") &&
      incident?.status === "AUTO_INVESTIGATING" &&
      incident.humanReviewReason === "AUTOMATION_STALLED"
    ) {
      if (!incident.nextAttemptAt || incident.nextAttemptAt <= now) {
        const nextCycle = incident.cycle + 1;
        const requeued = await prisma.$transaction(
          async (transaction) => {
            const incidentUpdated =
              await transaction.courseSupportIncident.updateMany({
                where: {
                  id: incident.id,
                  cycle: incident.cycle,
                  revision: incident.revision,
                  status: "AUTO_INVESTIGATING",
                  humanReviewReason: "AUTOMATION_STALLED",
                  activeBatchId: null,
                },
                data: {
                  cycle: { increment: 1 },
                  confirmedAt: now,
                  escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                    now,
                    incident.activeRealSearchCount,
                  ),
                  humanReviewReason: null,
                  nextReminderAt: null,
                  nextAttemptAt: now,
                  nextAction:
                    "Run a fresh current-cycle ordered playbook before requesting proof-backed human review.",
                  lastSeenAt: now,
                  revision: { increment: 1 },
                },
              });
            if (incidentUpdated.count !== 1) {
              return false;
            }
            const statusUpdated =
              await transaction.courseMonitoringStatus.updateMany({
                where: {
                  courseId: status.courseId,
                  revision: status.revision,
                  state: status.state,
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
              throw new Error(
                "The monitoring state changed while an automation-stall recheck was queued.",
              );
            }
            if (incident.activeRealSearchCount > 0) {
              await queueActiveRealSearchesForCourse(
                transaction,
                status.courseId,
                now,
              );
            }
            await appendMonitoringEvent(transaction, {
              courseId: status.courseId,
              incidentId: incident.id,
              eventType: "REVALIDATION_REQUESTED",
              source: "RECOVERY_CRON",
              fromState: status.state,
              toState: "AUTO_INVESTIGATING",
              failureFingerprint: incident.failureFingerprint,
              message:
                "The six-hour automation-stall recheck opened a fresh ordered-playbook cycle.",
              occurredAt: now,
              audit: {
                priorCycle: incident.cycle,
                cycle: nextCycle,
                preservesPriorAttemptEvents: true,
                customerDataIncluded: false,
              },
            });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if (requeued) {
          scheduled += 1;
        }
      }
      continue;
    }

    if (
      (status.state === "AUTO_INVESTIGATING" ||
        status.state === "ENGINEERING_VERIFICATION_NEEDED") &&
      incident?.status === "AUTO_INVESTIGATING" &&
      incident.escalationDeadlineAt &&
      incident.escalationDeadlineAt <= now
    ) {
      const playbookAssessment = assessAutomationPlaybook(
        incident.attemptLedger,
        incident.cycle,
      );
      const playbookExhausted = isAutomationPlaybookExhausted(
        incident.attemptLedger,
        incident.cycle,
      );
      const retryAt = getHumanReviewRetryAt(
        now,
        incident.activeRealSearchCount,
      );
      if (!playbookExhausted) {
        const stalled = await prisma.$transaction(
          async (transaction) => {
            const incidentUpdated =
              await transaction.courseSupportIncident.updateMany({
                where: {
                  id: incident.id,
                  revision: incident.revision,
                  status: "AUTO_INVESTIGATING",
                  humanReviewReason: null,
                },
                data: {
                  humanReviewReason: "AUTOMATION_STALLED",
                  escalatedAt: incident.escalatedAt ?? now,
                  nextReminderAt: now,
                  nextAttemptAt: retryAt,
                  revision: { increment: 1 },
                },
              });
            const statusUpdated =
              await transaction.courseMonitoringStatus.updateMany({
                where: {
                  courseId: status.courseId,
                  revision: status.revision,
                  state: status.state,
                },
                data: {
                  nextAutomaticAttemptAt: retryAt,
                  revalidationRequestedAt: null,
                  stateChangedAt: now,
                  revision: { increment: 1 },
                },
              });
            if (incidentUpdated.count !== 1 || statusUpdated.count !== 1) {
              return false;
            }
            if (incident.activeRealSearchCount > 0) {
              await queueActiveRealSearchesForCourse(
                transaction,
                status.courseId,
                now,
              );
            }
            await appendMonitoringEvent(transaction, {
              courseId: status.courseId,
              incidentId: incident.id,
              eventType: "HUMAN_REVIEW_REQUESTED",
              source: "RECOVERY_CRON",
              fromState: status.state,
              toState: status.state,
              failureFingerprint: incident.failureFingerprint,
              message:
                "The automation deadline arrived before the ordered playbook produced complete proof.",
              occurredAt: now,
              audit: {
                activeDemand: incident.activeRealSearchCount > 0,
                customerState: "NEEDS_HUMAN_REVIEW",
                playbookVersion: playbookAssessment.version,
                playbookConclusion: playbookAssessment.conclusion,
                playbookExhausted: false,
                nextStage: playbookAssessment.nextStage,
                automaticRecheckHours: 6,
                customerDataIncluded: false,
              },
            });
            return true;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        if (stalled) {
          escalated += 1;
        }
        continue;
      }
      const reason = inferHumanReviewReason({
        kind: incident.kind,
        failureClass: incident.failureClass,
        bookingAccessMode: status.course.bookingAccessMode,
        automationReason: status.course.automationReason,
      });
      const escalatedRows = await prisma.$transaction(
        async (transaction) => {
          const incidentUpdated =
            await transaction.courseSupportIncident.updateMany({
              where: {
                id: incident.id,
                revision: incident.revision,
                status: "AUTO_INVESTIGATING",
              },
              data: {
                status: "NEEDS_HUMAN",
                humanReviewReason: reason,
                escalatedAt: incident.escalatedAt ?? now,
                nextReminderAt: now,
                nextAttemptAt: retryAt,
                revision: { increment: 1 },
              },
            });
          const statusUpdated =
            await transaction.courseMonitoringStatus.updateMany({
              where: {
                courseId: status.courseId,
                revision: status.revision,
                state: status.state,
              },
              data: {
                state: "ENGINEERING_VERIFICATION_NEEDED",
                nextAutomaticAttemptAt: retryAt,
                revalidationRequestedAt: null,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
          if (incidentUpdated.count !== 1 || statusUpdated.count !== 1) {
            return false;
          }
          if (incident.activeRealSearchCount > 0) {
            await queueActiveRealSearchesForCourse(
              transaction,
              status.courseId,
              now,
            );
          }
          await appendMonitoringEvent(transaction, {
            courseId: status.courseId,
            incidentId: incident.id,
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: status.state,
            toState: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: incident.failureFingerprint,
            message:
              "The bounded automated playbook ended without fresh runnable proof.",
            occurredAt: now,
            audit: {
              activeDemand: incident.activeRealSearchCount > 0,
              playbookVersion: playbookAssessment.version,
              playbookConclusion: playbookAssessment.conclusion,
              playbookExhausted: true,
              nextStage: playbookAssessment.nextStage,
              automaticRecheckHours: 6,
              reminderCadence:
                incident.activeRealSearchCount > 0 ? "daily" : "weekly",
              customerDataIncluded: false,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (escalatedRows) {
        escalated += 1;
        humanReviewIds.push(incident.id);
      }
      continue;
    }

    if (incident?.status === "NEEDS_HUMAN") {
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

  const humanReview = await advanceHumanReviewVisibility(humanReviewIds, now);
  scheduled += humanReview.rechecksQueued;
  return {
    checked: statuses.length,
    scheduled,
    escalated,
    remindersSent: 0,
  };
}

async function advanceHumanReviewVisibility(incidentIds: string[], now: Date) {
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

  let rechecksQueued = 0;
  for (const incident of incidents) {
    if (!incident.nextAttemptAt || incident.nextAttemptAt <= now) {
      const nextCycle = incident.cycle + 1;
      const queued = await prisma.$transaction(
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
                cycle: { increment: 1 },
                status: "AUTO_INVESTIGATING",
                confirmedAt: now,
                escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                  now,
                  incident.activeRealSearchCount,
                ),
                humanReviewReason: null,
                nextReminderAt: null,
                nextAttemptAt: now,
                nextAction:
                  "Run a fresh current-cycle ordered playbook before any new final decision.",
                lastSeenAt: now,
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
                state: "AUTO_INVESTIGATING",
                nextAutomaticAttemptAt: now,
                revalidationRequestedAt: now,
                stateChangedAt: now,
                revision: { increment: 1 },
              },
            });
          if (statusUpdated.count !== 1) {
            throw new Error(
              "The monitoring state changed while a human-review recheck was queued.",
            );
          }
          await transaction.teeSearch.updateMany({
            where: {
              status: "ACTIVE",
              trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
              preferences: { some: { courseId: incident.courseId } },
            },
            data: {
              nextCheckAt: now,
              recheckRequestedAt: now,
            },
          });
          await appendMonitoringEvent(transaction, {
            courseId: incident.courseId,
            incidentId: incident.id,
            eventType: "REVALIDATION_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: "ENGINEERING_VERIFICATION_NEEDED",
            toState: "AUTO_INVESTIGATING",
            failureFingerprint: incident.failureFingerprint,
            message:
              "The six-hour safe recheck opened a fresh playbook cycle and queued affected active searches.",
            occurredAt: now,
            audit: {
              priorCycle: incident.cycle,
              cycle: nextCycle,
              preservesPriorAttemptEvents: true,
              customerDataIncluded: false,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      if (queued) {
        rechecksQueued += 1;
      }
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
    occurredAt: Date;
    audit?: Prisma.InputJsonObject;
  },
) {
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
      occurredAt: input.occurredAt,
      audit: input.audit,
    },
  });
}

export async function runSerializedCourseMonitoringWrite<T>(
  courseId: string,
  worker: (transaction: Prisma.TransactionClient) => Promise<T>,
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
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
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

function createDeploymentRevalidationIdempotencyKey(
  courseId: string,
  deploymentSha: string,
) {
  return `course-deploy-revalidate:${createHash("sha256")
    .update(`${courseId}:${deploymentSha}`)
    .digest("hex")}`;
}

function stableProviderEvidenceValue(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === undefined) {
      return { $providerEvidenceType: "undefined" };
    }
    if (candidate instanceof Date) {
      return candidate.toISOString();
    }
    if (Array.isArray(candidate)) {
      return candidate.map(normalize);
    }
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
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

export function sanitizeEvidenceUrl(value: string | null | undefined) {
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
    url.hash = "";
    return url.toString().slice(0, 1000);
  } catch {
    return null;
  }
}

function normalizeRuntimeVersion(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 100) : null;
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

export function selectSearchWorkflowMonitoringRetryAt(input: {
  statuses: SearchWorkflowMonitoringRetryStatus[];
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
        : new Date(input.now.getTime() + FIRST_FAILURE_RETRY_MS),
    ];
  });

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
  const statuses = await prisma.courseMonitoringStatus.findMany({
    where: {
      courseId: { in: uniqueCourseIds },
    },
    select: {
      courseId: true,
      state: true,
      nextAutomaticAttemptAt: true,
    },
  });
  return selectSearchWorkflowMonitoringRetryAt({
    statuses,
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
