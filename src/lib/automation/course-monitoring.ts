import { createHash, randomUUID } from "node:crypto";

import {
  Prisma,
  type CourseHumanReviewReason,
  type CourseMonitoringEventSource,
  type CourseMonitoringState,
  type ProbeOutcome
} from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { sanitizeResponderText } from "./course-support-responder-policy";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";

export const FAILURE_CONFIRMATION_WINDOW_MS = 15 * 60 * 1000;
export const FIRST_FAILURE_RETRY_MS = 2 * 60 * 1000;
export const ACTIVE_DEMAND_ESCALATION_MS = 6 * 60 * 60 * 1000;
export const INACTIVE_INVESTIGATION_MS = 30 * 60 * 1000;
export const ACTIVE_HUMAN_RETRY_MS = 6 * 60 * 60 * 1000;
export const INACTIVE_HUMAN_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const ACTIVE_REMINDER_MS = 24 * 60 * 60 * 1000;
export const INACTIVE_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

const AUTOMATED_STATES: CourseMonitoringState[] = [
  "DEGRADED_RETRYING",
  "AUTO_INVESTIGATING",
  "ENGINEERING_VERIFICATION_NEEDED",
  "REVALIDATING_FINAL"
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
  current: Required<FailureObservation>
): MonitoringFailureDecision {
  const observations = [...previousFailures, current];
  const independentPathCount = new Set(
    observations.map((observation) => observation.readPath).filter(Boolean)
  ).size;
  const samePathCount = observations.filter(
    (observation) => observation.readPath === current.readPath
  ).length;
  const confirmed = independentPathCount >= 2 || samePathCount >= 2;
  return {
    confirmed,
    independentPathCount,
    samePathCount,
    state: confirmed ? "AUTO_INVESTIGATING" : "DEGRADED_RETRYING"
  };
}

export function getCourseMonitoringEscalationDeadline(now: Date, activeRealSearchCount: number) {
  return new Date(
    now.getTime() +
      (activeRealSearchCount > 0 ? ACTIVE_DEMAND_ESCALATION_MS : INACTIVE_INVESTIGATION_MS)
  );
}

export function getHumanReviewRetryAt(now: Date, activeRealSearchCount: number) {
  return new Date(
    now.getTime() + (activeRealSearchCount > 0 ? ACTIVE_HUMAN_RETRY_MS : INACTIVE_HUMAN_RETRY_MS)
  );
}

export function getHumanReviewReminderAt(now: Date, activeRealSearchCount: number) {
  return new Date(
    now.getTime() + (activeRealSearchCount > 0 ? ACTIVE_REMINDER_MS : INACTIVE_REMINDER_MS)
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
      failureFingerprint
    });
    return {
      status: null,
      confirmed: decision.confirmed,
      retainedHumanFinal: false,
      independentPathCount: decision.independentPathCount,
      samePathCount: decision.samePathCount,
      nextAttemptAt: new Date(now.getTime() + FIRST_FAILURE_RETRY_MS)
    };
  }

  return runSerializedCourseMonitoringWrite(input.courseId, async (transaction) => {
    const current = await ensureMonitoringStatus(transaction, input.courseId, now);
    const incident = await transaction.courseSupportIncident.findUnique({
      where: { courseId: input.courseId },
      select: {
        id: true,
        status: true,
        resolution: true,
        failureFingerprint: true
      }
    });

    const retainedFinalState =
      incident?.status === "RESOLVED" &&
      incident.resolution &&
      incident.resolution !== "MONITORING_RESTORED" &&
      !input.materialEvidenceChanged &&
      ["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY", "REVALIDATING_FINAL"].includes(
        current.state
      )
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
          revision: current.revision
        },
        data: {
          state: retainedFinalState,
          lastFailureAt: now,
          consecutiveFailures: { increment: 1 },
          failureFingerprint,
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
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
        message: safeMessage ?? "The existing final monitoring decision was reconfirmed.",
        runtimeVersion: input.runtimeVersion,
        occurredAt: now,
        audit: {
          retainedFinalDecision: true,
          resolution: incident?.resolution ?? null,
          customerDataIncluded: false
        }
      });
      return {
        status,
        confirmed: true,
        retainedHumanFinal: true,
        independentPathCount: 1,
        samePathCount: 1,
        nextAttemptAt: null
      };
    }

    if (current.state === "ENGINEERING_VERIFICATION_NEEDED" && !input.materialEvidenceChanged) {
      const status = await transaction.courseMonitoringStatus.update({
        where: {
          courseId: input.courseId,
          revision: current.revision
        },
        data: {
          lastFailureAt: now,
          consecutiveFailures:
            current.failureFingerprint === failureFingerprint ? { increment: 1 } : 1,
          failureFingerprint,
          nextAutomaticAttemptAt: null,
          revision: { increment: 1 }
        }
      });
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
          customerDataIncluded: false
        }
      });
      return {
        status,
        confirmed: true,
        retainedHumanFinal: false,
        independentPathCount: 1,
        samePathCount: Math.max(status.consecutiveFailures, 1),
        nextAttemptAt: null
      };
    }

    const recentFailures = await transaction.courseMonitoringEvent.findMany({
      where: {
        courseId: input.courseId,
        eventType: "CHECK_FAILED",
        occurredAt: {
          gte: new Date(now.getTime() - FAILURE_CONFIRMATION_WINDOW_MS),
          lte: now
        }
      },
      orderBy: { occurredAt: "desc" },
      select: {
        readPath: true,
        failureFingerprint: true
      }
    });
    const decision = decideMonitoringFailureState(recentFailures, {
      readPath,
      failureFingerprint
    });
    const nextAttemptAt = decision.confirmed
      ? now
      : new Date(now.getTime() + FIRST_FAILURE_RETRY_MS);
    const stateChanged = current.state !== decision.state;
    const status = await transaction.courseMonitoringStatus.update({
      where: {
        courseId: input.courseId,
        revision: current.revision
      },
      data: {
        state: decision.state,
        lastFailureAt: now,
        consecutiveFailures:
          current.failureFingerprint === failureFingerprint ? { increment: 1 } : 1,
        failureFingerprint,
        firstDegradedAt: current.firstDegradedAt ?? now,
        nextAutomaticAttemptAt: nextAttemptAt,
        revalidationRequestedAt: null,
        ...(stateChanged ? { stateChangedAt: now } : {}),
        revision: { increment: 1 }
      }
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
        customerDataIncluded: false
      }
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
        occurredAt: now
      });
    }

    return {
      status,
      confirmed: decision.confirmed,
      retainedHumanFinal: false,
      independentPathCount: decision.independentPathCount,
      samePathCount: decision.samePathCount,
      nextAttemptAt
    };
  });
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
  return runSerializedCourseMonitoringWrite(input.courseId, async (transaction) => {
    const current = await ensureMonitoringStatus(transaction, input.courseId, now);
    const recovered = current.state !== "HEALTHY";
    const incident = await transaction.courseSupportIncident.findUnique({
      where: { courseId: input.courseId },
      select: { id: true }
    });
    const status = await transaction.courseMonitoringStatus.update({
      where: {
        courseId: input.courseId,
        revision: current.revision
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
        revision: { increment: 1 }
      }
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
      occurredAt: now
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
        message: "Fresh public signed-out monitoring succeeded and restored the course.",
        runtimeVersion: input.runtimeVersion,
        occurredAt: now
      });
    }
    return status;
  });
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
  if (!hasMonitoringModels(prisma)) {
    return null;
  }
  return runSerializedCourseMonitoringWrite(input.courseId, async (transaction) => {
    const current = await ensureMonitoringStatus(transaction, input.courseId, now);
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
        revision: current.revision
      },
      data: {
        state: input.state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        ...(stateChanged ? { stateChangedAt: now } : {}),
        revision: { increment: 1 }
      }
    });
    if (stateChanged) {
      await appendMonitoringEvent(transaction, {
        courseId: input.courseId,
        eventType: "STATE_CHANGED",
        source: input.source ?? "SEARCH_WORKFLOW",
        fromState: current.state,
        toState: input.state,
        outcome: input.outcome,
        message: sanitizeMonitoringMessage(input.message),
        evidenceUrl: sanitizeEvidenceUrl(input.evidenceUrl),
        runtimeVersion: input.runtimeVersion,
        occurredAt: now
      });
    }
    return status;
  });
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
    const result = await runSerializedCourseMonitoringWrite(courseId, async (transaction) => {
      const current = await transaction.courseMonitoringStatus.findUnique({
        where: { courseId }
      });
      if (!current || current.state !== "FINAL_TECHNICAL") {
        return false;
      }
      const updated = await transaction.courseMonitoringStatus.updateMany({
        where: {
          courseId,
          revision: current.revision,
          state: "FINAL_TECHNICAL"
        },
        data: {
          state: "REVALIDATING_FINAL",
          revalidationRequestedAt: now,
          nextAutomaticAttemptAt: now,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      if (updated.count !== 1) {
        return false;
      }
      const incident = await transaction.courseSupportIncident.findUnique({
        where: { courseId },
        select: { id: true }
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
        occurredAt: now
      });
      return true;
    });
    if (result) {
      requestedCourseIds.push(courseId);
    }
  }
  return { requestedCourseIds };
}

export function getNextMonitoringWakeAt(
  courses: Array<{
    monitoringStatus?: {
      state: CourseMonitoringState;
      nextAutomaticAttemptAt: Date | null;
      revalidationRequestedAt: Date | null;
    } | null;
  }>
) {
  const values = courses
    .flatMap((course) => {
      const status = course.monitoringStatus;
      if (!status || !AUTOMATED_STATES.includes(status.state)) {
        return [];
      }
      return status.nextAutomaticAttemptAt ? [status.nextAutomaticAttemptAt] : [];
    })
    .sort((left, right) => left.getTime() - right.getTime());
  return values[0] ?? null;
}

export function shouldSleepTechnicalFinalSearch(
  courses: Array<{
    monitoringStatus?: {
      state: CourseMonitoringState;
      revalidationRequestedAt: Date | null;
    } | null;
  }>
) {
  return Boolean(
    courses.length > 0 &&
    courses.every((course) => {
      const state = course.monitoringStatus?.state;
      return (
        (state === "FINAL_TECHNICAL" || state === "FINAL_MANUAL" || state === "FINAL_IDENTITY") &&
        !course.monitoringStatus?.revalidationRequestedAt
      );
    })
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
      eventType: input.deploymentSha ? "DEPLOYMENT_VERIFIED" : "AUTOMATION_ATTEMPTED",
      source: input.source ?? "COURSE_SUPPORT_RESPONDER",
      message: sanitizeMonitoringMessage(input.message),
      runtimeVersion: normalizeRuntimeVersion(input.runtimeVersion),
      deploymentSha: normalizeDeploymentSha(input.deploymentSha),
      audit: input.audit,
      occurredAt: input.now ?? new Date()
    }
  });
}

export async function runCourseMonitoringWatchdog(now = new Date()) {
  if (!hasMonitoringModels(prisma)) {
    return {
      checked: 0,
      scheduled: 0,
      escalated: 0,
      remindersSent: 0
    };
  }
  const statuses = await prisma.courseMonitoringStatus.findMany({
    where: {
      state: { in: [...AUTOMATED_STATES, "FINAL_TECHNICAL"] }
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
                  notIn: [...syntheticWebsiteTrafficClasses]
                }
              }
            },
            select: {
              teeSearch: {
                select: {
                  date: true
                }
              }
            }
          }
        }
      }
    }
  });

  let scheduled = 0;
  let escalated = 0;
  const reminderIds: string[] = [];

  for (const status of statuses) {
    let incident = status.course.supportIncident;
    const localBoundary = getCourseLocalDateStorageBoundary(status.course.timeZone, now);
    const realDemandDates = status.course.preferences
      .map((preference) => preference.teeSearch.date)
      .filter((date) => date >= localBoundary)
      .sort((left, right) => left.getTime() - right.getTime());
    const activeRealSearchCount = realDemandDates.length;
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
          revision: incident.revision
        },
        data: {
          activeRealSearchCount,
          earliestTargetDate: realDemandDates[0] ?? null,
          engineeringOnly: activeRealSearchCount > 0 ? false : incident.engineeringOnly,
          ...(promotedToRealDemand
            ? {
                nextAttemptAt: now,
                nextReminderAt: incident.status === "NEEDS_HUMAN" ? now : undefined
              }
            : {}),
          revision: { increment: 1 }
        }
      });
      if (refreshed.count === 1) {
        incident = {
          ...incident,
          activeRealSearchCount,
          earliestTargetDate: realDemandDates[0] ?? null,
          engineeringOnly: activeRealSearchCount > 0 ? false : incident.engineeringOnly,
          nextAttemptAt: promotedToRealDemand ? now : incident.nextAttemptAt,
          nextReminderAt:
            promotedToRealDemand && incident.status === "NEEDS_HUMAN"
              ? now
              : incident.nextReminderAt,
          revision: incident.revision + 1
        };
      }
    }

    if (
      status.state === "FINAL_TECHNICAL" &&
      activeRealSearchCount > 0 &&
      !status.revalidationRequestedAt
    ) {
      const requested = await prisma.$transaction(
        async (transaction) => {
          const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: status.courseId,
              revision: status.revision,
              state: "FINAL_TECHNICAL",
              revalidationRequestedAt: null
            },
            data: {
              state: "REVALIDATING_FINAL",
              revalidationRequestedAt: now,
              nextAutomaticAttemptAt: now,
              stateChangedAt: now,
              revision: { increment: 1 }
            }
          });
          if (statusUpdated.count !== 1) {
            return false;
          }
          await transaction.teeSearch.updateMany({
            where: {
              status: "ACTIVE",
              trafficClass: {
                notIn: [...syntheticWebsiteTrafficClasses]
              },
              preferences: {
                some: { courseId: status.courseId }
              }
            },
            data: {
              nextCheckAt: now,
              recheckRequestedAt: now
            }
          });
          await appendMonitoringEvent(transaction, {
            courseId: status.courseId,
            incidentId: incident?.id,
            eventType: "REVALIDATION_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: "FINAL_TECHNICAL",
            toState: "REVALIDATING_FINAL",
            message: "The invariant watchdog recovered a revalidation request for new real demand.",
            occurredAt: now
          });
          return true;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }
      );
      if (requested) {
        scheduled += 1;
      }
      continue;
    }

    if (
      status.state === "DEGRADED_RETRYING" &&
      status.firstDegradedAt &&
      status.firstDegradedAt.getTime() + FAILURE_CONFIRMATION_WINDOW_MS <= now.getTime() &&
      !incident?.activeBatchId
    ) {
      const escalationDeadlineAt = getCourseMonitoringEscalationDeadline(
        now,
        activeRealSearchCount
      );
      const toolingEscalated = await prisma.$transaction(
        async (transaction) => {
          const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: status.courseId,
              revision: status.revision,
              state: "DEGRADED_RETRYING"
            },
            data: {
              state: "AUTO_INVESTIGATING",
              nextAutomaticAttemptAt: now,
              stateChangedAt: now,
              revision: { increment: 1 }
            }
          });
          if (statusUpdated.count !== 1) {
            return false;
          }
          let incidentId = incident?.id ?? null;
          if (incident) {
            const incidentUpdated = await transaction.courseSupportIncident.updateMany({
              where: {
                id: incident.id,
                revision: incident.revision,
                activeBatchId: null
              },
              data: {
                kind: "BLOCKED_TOOLING",
                confirmedAt: incident.confirmedAt ?? now,
                escalationDeadlineAt: incident.escalationDeadlineAt ?? escalationDeadlineAt,
                nextAttemptAt: now,
                latestMessage:
                  "The first-failure verification window ended without enough independent observations.",
                nextAction:
                  "Repair the verification path, then run the bounded public signed-out playbook.",
                activeRealSearchCount,
                earliestTargetDate: realDemandDates[0] ?? null,
                revision: { increment: 1 }
              }
            });
            if (incidentUpdated.count !== 1) {
              throw new Error("The course incident changed during tooling escalation.");
            }
          } else {
            const created = await transaction.courseSupportIncident.create({
              data: {
                reference: createIncidentReference(),
                courseId: status.courseId,
                kind: "BLOCKED_TOOLING",
                providerFamilyKey: status.course.providerFamilyKey,
                failureClass: "UNKNOWN",
                failureFingerprint: status.failureFingerprint ?? "TOOLING:UNCONFIRMED",
                courseNameSnapshot: status.course.name,
                platformSnapshot: status.course.detectedPlatform,
                bookingUrlSnapshot: status.course.detectedBookingUrl ?? status.course.website,
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
                lastSeenAt: now
              }
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
                customerDataIncluded: false
              }
            }
          });
          return true;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable
        }
      );
      if (toolingEscalated) {
        scheduled += 1;
      }
      continue;
    }

    if (
      status.state === "AUTO_INVESTIGATING" &&
      incident?.status === "AUTO_INVESTIGATING" &&
      incident.escalationDeadlineAt &&
      incident.escalationDeadlineAt <= now
    ) {
      const reason = inferHumanReviewReason({
        kind: incident.kind,
        failureClass: incident.failureClass,
        bookingAccessMode: status.course.bookingAccessMode,
        automationReason: status.course.automationReason
      });
      const escalatedRows = await prisma.$transaction(
        async (transaction) => {
          const incidentUpdated = await transaction.courseSupportIncident.updateMany({
            where: {
              id: incident.id,
              revision: incident.revision,
              status: "AUTO_INVESTIGATING"
            },
            data: {
              status: "NEEDS_HUMAN",
              humanReviewReason: reason,
              escalatedAt: incident.escalatedAt ?? now,
              nextReminderAt: now,
              nextAttemptAt: null,
              revision: { increment: 1 }
            }
          });
          const statusUpdated = await transaction.courseMonitoringStatus.updateMany({
            where: {
              courseId: status.courseId,
              revision: status.revision,
              state: "AUTO_INVESTIGATING"
            },
            data: {
              state: "ENGINEERING_VERIFICATION_NEEDED",
              nextAutomaticAttemptAt: null,
              revalidationRequestedAt: null,
              stateChangedAt: now,
              revision: { increment: 1 }
            }
          });
          if (incidentUpdated.count !== 1 || statusUpdated.count !== 1) {
            return false;
          }
          await appendMonitoringEvent(transaction, {
            courseId: status.courseId,
            incidentId: incident.id,
            eventType: "HUMAN_REVIEW_REQUESTED",
            source: "RECOVERY_CRON",
            fromState: "AUTO_INVESTIGATING",
            toState: "ENGINEERING_VERIFICATION_NEEDED",
            failureFingerprint: incident.failureFingerprint,
            message:
              "The bounded automated investigation window ended without fresh runnable proof.",
            occurredAt: now,
            audit: {
              activeDemand: incident.activeRealSearchCount > 0,
              reminderCadence: incident.activeRealSearchCount > 0 ? "daily" : "weekly",
              customerDataIncluded: false
            }
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
      if (escalatedRows) {
        escalated += 1;
        reminderIds.push(incident.id);
      }
      continue;
    }

    const ownsAutomatedAttempt = Boolean(
      incident?.activeBatchId ||
      status.nextAutomaticAttemptAt ||
      (incident?.humanReviewReason && incident.nextReminderAt)
    );
    if (!ownsAutomatedAttempt) {
      if (status.state === "ENGINEERING_VERIFICATION_NEEDED") {
        continue;
      }
      const retryAt =
        now;
      await prisma.courseMonitoringStatus.updateMany({
        where: {
          courseId: status.courseId,
          revision: status.revision,
          nextAutomaticAttemptAt: null
        },
        data: {
          nextAutomaticAttemptAt: retryAt,
          revision: { increment: 1 }
        }
      });
      if (incident && !incident.activeBatchId) {
        await prisma.courseSupportIncident.updateMany({
          where: {
            id: incident.id,
            revision: incident.revision,
            nextAttemptAt: null
          },
          data: {
            nextAttemptAt: retryAt,
            revision: { increment: 1 }
          }
        });
      }
      scheduled += 1;
    }

    if (
      incident?.status === "NEEDS_HUMAN" &&
      incident.nextReminderAt &&
      incident.nextReminderAt <= now
    ) {
      reminderIds.push(incident.id);
    }
  }

  await advanceHumanReviewVisibility(reminderIds, now);
  return {
    checked: statuses.length,
    scheduled,
    escalated,
    remindersSent: 0
  };
}

async function advanceHumanReviewVisibility(incidentIds: string[], now: Date) {
  const uniqueIds = [...new Set(incidentIds)];
  if (uniqueIds.length === 0) {
    return;
  }
  const incidents = await prisma.courseSupportIncident.findMany({
    where: {
      id: { in: uniqueIds },
      status: "NEEDS_HUMAN"
    },
    orderBy: [{ activeRealSearchCount: "desc" }, { firstSeenAt: "asc" }]
  });
  if (incidents.length === 0) {
    return;
  }

  for (const incident of incidents) {
    const nextReminderAt = getHumanReviewReminderAt(now, incident.activeRealSearchCount);
    await prisma.courseSupportIncident.updateMany({
      where: {
        id: incident.id,
        status: "NEEDS_HUMAN",
        revision: incident.revision
      },
      data: {
        nextReminderAt,
        revision: { increment: 1 }
      }
    });
  }
}

export function inferHumanReviewReason(input: {
  kind: string;
  failureClass: string;
  bookingAccessMode?: string | null;
  automationReason?: string | null;
}): CourseHumanReviewReason {
  if (input.kind === "READER_CANDIDATE" || input.failureClass === "READER_PARSER_MISSING") {
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
  now: Date
) {
  return transaction.courseMonitoringStatus.upsert({
    where: { courseId },
    create: {
      courseId,
      reference: createMonitoringReference(),
      state: "UNKNOWN",
      stateChangedAt: now,
      updatedAt: now
    },
    update: {}
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
  }
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
      audit: input.audit
    }
  });
}

async function runSerializedCourseMonitoringWrite<T>(
  courseId: string,
  worker: (transaction: Prisma.TransactionClient) => Promise<T>
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= COURSE_MONITORING_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (transaction) => {
          await acquireCourseMonitoringWriteLock(transaction, courseId);
          return worker(transaction);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: COURSE_MONITORING_WRITE_TIMEOUT_MS
        }
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
  courseId: string
) {
  const query = (
    transaction as Prisma.TransactionClient & {
      $queryRawUnsafe?: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>;
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
    `course-monitoring:${courseId}`
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
          key
        )
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
    input.statuses.map((status) => [status.courseId, status] as const)
  );
  const candidates = input.statuses.flatMap((status) => {
    if (
      !status.nextAutomaticAttemptAt ||
      !["DEGRADED_RETRYING", "ENGINEERING_VERIFICATION_NEEDED", "REVALIDATING_FINAL"].includes(
        status.state
      )
    ) {
      return [];
    }
    return [status.nextAutomaticAttemptAt];
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
  }
) {
  const transientRetryCourseIds = [...new Set(options?.transientRetryCourseIds ?? [])];
  const uniqueCourseIds = [...new Set([...courseIds, ...transientRetryCourseIds])];
  if (uniqueCourseIds.length === 0 || !hasMonitoringModels(prisma)) {
    return null;
  }
  const statuses = await prisma.courseMonitoringStatus.findMany({
    where: {
      courseId: { in: uniqueCourseIds }
    },
    select: {
      courseId: true,
      state: true,
      nextAutomaticAttemptAt: true
    }
  });
  return selectSearchWorkflowMonitoringRetryAt({
    statuses,
    transientRetryCourseIds,
    now: options?.now ?? new Date()
  });
}

function hasMonitoringModels(client: typeof prisma) {
  const partial = client as unknown as {
    courseMonitoringStatus?: unknown;
    courseMonitoringEvent?: unknown;
  };
  return Boolean(partial.courseMonitoringStatus && partial.courseMonitoringEvent);
}
