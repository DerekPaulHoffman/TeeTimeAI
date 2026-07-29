import { Prisma, type CourseMonitoringState } from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { getLocalReaderCourseKey, isLocalReaderCandidateUrl } from "@/lib/local-reader/course-key";
import { prisma } from "@/lib/prisma";

import {
  createIncidentReference,
  createMonitoringReference,
  getCourseMonitoringEscalationDeadline
} from "./course-monitoring";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";
import {
  buildProviderFailureFingerprint,
  resolveProviderCapability
} from "./provider-capabilities";

export type CourseMonitoringBackfillReport = {
  apply: boolean;
  coursesScanned: number;
  statusesToCreate: number;
  baselineEventsToCreate: number;
  technicalRowsToReopen: number;
  incidentsToCreate: number;
  incidentsToConfirm: number;
  readerCandidateIncidentsToCreate: number;
  manualFinalsPreserved: number;
  technicalFinalsPreserved: number;
  identityFinalsPreserved: number;
  applied: {
    statusesCreated: number;
    baselineEventsCreated: number;
    technicalRowsReopened: number;
    incidentsCreated: number;
    incidentsConfirmed: number;
  };
};

export type CourseMonitoringReconciliationReport = {
  apply: boolean;
  coursesScanned: number;
  mismatchesFound: number;
  transitions: Record<string, number>;
  applied: number;
  skippedAfterRefresh: number;
};

export async function reconcileCourseMonitoringLifecycle(input: {
  apply: boolean;
  actorId: string;
  now?: Date;
}): Promise<CourseMonitoringReconciliationReport> {
  const now = input.now ?? new Date();
  const courses = await prisma.course.findMany({
    where: {
      supportIncident: { isNot: null },
      monitoringStatus: { isNot: null }
    },
    select: {
      id: true,
      monitoringStatus: {
        select: {
          state: true
        }
      },
      supportIncident: {
        select: {
          status: true,
          resolution: true
        }
      }
    }
  });
  const mismatches = courses.flatMap((course) => {
    if (!course.monitoringStatus || !course.supportIncident) {
      return [];
    }
    const desiredState = getIncidentLifecycleState({
      incidentStatus: course.supportIncident.status,
      resolution: course.supportIncident.resolution,
      currentState: course.monitoringStatus.state
    });
    return desiredState && desiredState !== course.monitoringStatus.state
      ? [
          {
            courseId: course.id,
            fromState: course.monitoringStatus.state,
            toState: desiredState
          }
        ]
      : [];
  });
  const report: CourseMonitoringReconciliationReport = {
    apply: input.apply,
    coursesScanned: courses.length,
    mismatchesFound: mismatches.length,
    transitions: Object.fromEntries(
      [...new Set(mismatches.map((item) => `${item.fromState}->${item.toState}`))].map(
        (transition) => [
          transition,
          mismatches.filter((item) => `${item.fromState}->${item.toState}` === transition).length
        ]
      )
    ),
    applied: 0,
    skippedAfterRefresh: 0
  };
  if (!input.apply) {
    return report;
  }

  for (const mismatch of mismatches) {
    const outcome = await prisma.$transaction(
      async (transaction) => {
        const [status, incident] = await Promise.all([
          transaction.courseMonitoringStatus.findUnique({
            where: { courseId: mismatch.courseId }
          }),
          transaction.courseSupportIncident.findUnique({
            where: { courseId: mismatch.courseId }
          })
        ]);
        if (!status || !incident) {
          return "skipped" as const;
        }
        const desiredState = getIncidentLifecycleState({
          incidentStatus: incident.status,
          resolution: incident.resolution,
          currentState: status.state
        });
        if (!desiredState || desiredState === status.state) {
          return "skipped" as const;
        }
        const updated = await transaction.courseMonitoringStatus.updateMany({
          where: {
            courseId: mismatch.courseId,
            revision: status.revision,
            state: status.state
          },
          data: getReconciledMonitoringUpdate({
            desiredState,
            incident,
            now
          })
        });
        if (updated.count !== 1) {
          return "skipped" as const;
        }
        await transaction.courseMonitoringEvent.create({
          data: {
            courseId: mismatch.courseId,
            incidentId: incident.id,
            eventType: desiredState === "HEALTHY" ? "RECOVERED" : "STATE_CHANGED",
            source: "OPERATOR_CLI",
            fromState: status.state,
            toState: desiredState,
            failureFingerprint:
              desiredState === "AUTO_INVESTIGATING" ||
              desiredState === "ENGINEERING_VERIFICATION_NEEDED"
                ? incident.failureFingerprint
                : null,
            operatorActorId: input.actorId,
            message:
              "Reconciled the course monitoring lifecycle to the authoritative support incident outcome.",
            idempotencyKey: `course-monitoring-reconcile-v1:${incident.id}:${incident.cycle}:${incident.revision}:${desiredState}`,
            occurredAt: now,
            audit: {
              priorState: status.state,
              incidentStatus: incident.status,
              incidentResolution: incident.resolution,
              customerDataIncluded: false
            }
          }
        });
        return "applied" as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    if (outcome === "applied") {
      report.applied += 1;
    } else {
      report.skippedAfterRefresh += 1;
    }
  }
  return report;
}

export async function backfillCourseMonitoringLifecycle(input: {
  apply: boolean;
  now?: Date;
}): Promise<CourseMonitoringBackfillReport> {
  const now = input.now ?? new Date();
  const courses = await prisma.course.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      monitoringStatus: true,
      supportIncident: true,
      probes: {
        orderBy: { observedAt: "desc" },
        take: 1,
        select: {
          outcome: true,
          observedAt: true
        }
      }
    }
  });

  const plans = await Promise.all(
    courses.map(async (course) => {
      const realDemand = await prisma.teeSearch.aggregate({
        where: {
          status: "ACTIVE",
          date: {
            gte: getCourseLocalDateStorageBoundary(course.timeZone, now)
          },
          trafficClass: {
            notIn: [...syntheticWebsiteTrafficClasses]
          },
          preferences: {
            some: { courseId: course.id }
          }
        },
        _count: { id: true },
        _min: { date: true }
      });
      const readerCandidate = Boolean(
        getLocalReaderCourseKey(course.detectedBookingUrl) ||
        isLocalReaderCandidateUrl(course.detectedBookingUrl)
      );
      const technicalAutomatedFinal =
        isAutomatedTechnicalFinal(course) &&
        course.supportIncident?.resolution !== "HUMAN_VERIFIED_TECHNICAL_LIMITATION";
      const humanApprovedTechnicalFinal =
        course.supportIncident?.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION";
      const state = getBaselineState({
        isPublic: course.isPublic,
        bookingMethod: course.bookingMethod,
        automationReason: course.automationReason,
        automationEligibility: course.automationEligibility,
        bookingAccessMode: course.bookingAccessMode,
        latestProbeOutcome: course.probes[0]?.outcome,
        incidentStatus: course.supportIncident?.status ?? null,
        incidentResolution: course.supportIncident?.resolution ?? null,
        readerCandidate,
        humanApprovedTechnicalFinal
      });
      const needsIncident = Boolean(
        !course.supportIncident && (technicalAutomatedFinal || readerCandidate)
      );
      return {
        course,
        state,
        realDemandCount: realDemand._count.id,
        earliestTargetDate: realDemand._min.date,
        technicalAutomatedFinal,
        readerCandidate,
        needsIncident,
        needsIncidentConfirmation: Boolean(
          course.supportIncident &&
          course.supportIncident.status !== "RESOLVED" &&
          !course.supportIncident.confirmedAt
        ),
        needsStatus: !course.monitoringStatus
      };
    })
  );

  const baselineEventKeys = plans.map((plan) => `course-monitoring-baseline-v1:${plan.course.id}`);
  const existingEvents = await prisma.courseMonitoringEvent.findMany({
    where: { idempotencyKey: { in: baselineEventKeys } },
    select: { idempotencyKey: true }
  });
  const existingEventKeys = new Set(
    existingEvents.flatMap((event) => (event.idempotencyKey ? [event.idempotencyKey] : []))
  );

  const report: CourseMonitoringBackfillReport = {
    apply: input.apply,
    coursesScanned: plans.length,
    statusesToCreate: plans.filter((plan) => plan.needsStatus).length,
    baselineEventsToCreate: plans.filter(
      (plan) => !existingEventKeys.has(`course-monitoring-baseline-v1:${plan.course.id}`)
    ).length,
    technicalRowsToReopen: plans.filter((plan) => plan.technicalAutomatedFinal).length,
    incidentsToCreate: plans.filter((plan) => plan.needsIncident).length,
    incidentsToConfirm: plans.filter((plan) => plan.needsIncidentConfirmation).length,
    readerCandidateIncidentsToCreate: plans.filter(
      (plan) => plan.needsIncident && plan.readerCandidate
    ).length,
    manualFinalsPreserved: plans.filter((plan) => plan.state === "FINAL_MANUAL").length,
    technicalFinalsPreserved: plans.filter((plan) => plan.state === "FINAL_TECHNICAL").length,
    identityFinalsPreserved: plans.filter((plan) => plan.state === "FINAL_IDENTITY").length,
    applied: {
      statusesCreated: 0,
      baselineEventsCreated: 0,
      technicalRowsReopened: 0,
      incidentsCreated: 0,
      incidentsConfirmed: 0
    }
  };

  if (!input.apply) {
    return report;
  }

  for (const plan of plans) {
    const baselineKey = `course-monitoring-baseline-v1:${plan.course.id}`;
    const result = await prisma.$transaction(
      async (transaction) => {
        let statusesCreated = 0;
        let baselineEventsCreated = 0;
        let technicalRowsReopened = 0;
        let incidentsCreated = 0;
        let incidentsConfirmed = 0;

        const status = await transaction.courseMonitoringStatus.findUnique({
          where: { courseId: plan.course.id }
        });
        if (!status) {
          await transaction.courseMonitoringStatus.create({
            data: {
              courseId: plan.course.id,
              reference: createMonitoringReference(),
              state: plan.state,
              lastSuccessfulAt:
                plan.state === "HEALTHY" ? (plan.course.probes[0]?.observedAt ?? null) : null,
              lastFailureAt:
                plan.state === "AUTO_INVESTIGATING"
                  ? (plan.course.supportIncident?.lastSeenAt ?? now)
                  : null,
              consecutiveFailures:
                plan.state === "AUTO_INVESTIGATING"
                  ? Math.max(plan.course.supportIncident?.occurrenceCount ?? 1, 1)
                  : 0,
              failureFingerprint:
                plan.state === "AUTO_INVESTIGATING"
                  ? (plan.course.supportIncident?.failureFingerprint ??
                    buildBaselineFingerprint(plan.course, plan.readerCandidate))
                  : null,
              firstDegradedAt:
                plan.state === "AUTO_INVESTIGATING"
                  ? (plan.course.supportIncident?.firstSeenAt ?? now)
                  : null,
              nextAutomaticAttemptAt: plan.state === "AUTO_INVESTIGATING" ? now : null,
              stateChangedAt: now,
              updatedAt: now
            }
          });
          statusesCreated += 1;
        }

        if (plan.technicalAutomatedFinal) {
          const reopened = await transaction.course.updateMany({
            where: {
              id: plan.course.id,
              automationEligibility: "BLOCKED",
              automationReason: {
                in: ["ACCOUNT_REQUIRED", "CAPTCHA_OR_QUEUE", "TEMPORARILY_UNAVAILABLE", "OTHER"]
              }
            },
            data: {
              automationEligibility: "NEEDS_REVIEW",
              intelligenceReviewAt: null
            }
          });
          technicalRowsReopened += reopened.count;
        }

        let incidentId = plan.course.supportIncident?.id ?? null;
        if (plan.needsIncident) {
          const provider = resolveProviderCapability(plan.course);
          const failureClass = plan.readerCandidate
            ? "READER_PARSER_MISSING"
            : plan.course.bookingAccessMode === "CAPTCHA_OR_QUEUE"
              ? "CHALLENGE"
              : plan.course.bookingAccessMode.startsWith("ACCOUNT")
                ? "AUTH"
                : "UNKNOWN";
          const failureFingerprint = plan.readerCandidate
            ? buildBaselineFingerprint(plan.course, true)
            : buildProviderFailureFingerprint({
                providerFamilyKey: provider.providerFamilyKey,
                failureClass,
                operation: "AVAILABILITY",
                httpStatus: null
              });
          const incident = await transaction.courseSupportIncident.create({
            data: {
              reference: createIncidentReference(),
              courseId: plan.course.id,
              status: "AUTO_INVESTIGATING",
              kind: plan.readerCandidate ? "READER_CANDIDATE" : "BLOCKED_AUTH",
              providerFamilyKey: provider.providerFamilyKey,
              failureClass,
              failureFingerprint,
              courseNameSnapshot: plan.course.name,
              platformSnapshot: plan.course.detectedPlatform,
              bookingUrlSnapshot: plan.course.detectedBookingUrl ?? plan.course.website,
              initialMessage: plan.readerCandidate
                ? "A public booking page needs a fail-closed local reader parser and exact allowlist."
                : "An automated technical classification requires the bounded recovery playbook and engineer approval.",
              latestMessage: plan.readerCandidate
                ? "Reader candidate imported for durable investigation."
                : "Technical limitation imported for durable investigation.",
              nextAction: plan.readerCandidate
                ? "Build and test an exact fail-closed reader parser; request extension reload only if the installed bundle must change."
                : "Exhaust safe public signed-out reads, repair reusable support, and require fresh runtime proof.",
              affectedSearchCount: Math.max(plan.realDemandCount, 1),
              engineeringOnly: plan.realDemandCount === 0,
              nextAttemptAt: now,
              confirmedAt: now,
              escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                now,
                plan.realDemandCount
              ),
              activeRealSearchCount: plan.realDemandCount,
              earliestTargetDate: plan.earliestTargetDate,
              firstSeenAt: now,
              lastSeenAt: now
            }
          });
          incidentId = incident.id;
          incidentsCreated += 1;
        } else if (
          plan.course.supportIncident &&
          (plan.technicalAutomatedFinal || plan.needsIncidentConfirmation)
        ) {
          await transaction.courseSupportIncident.update({
            where: { id: plan.course.supportIncident.id },
            data: {
              cycle:
                plan.technicalAutomatedFinal && plan.course.supportIncident.status === "RESOLVED"
                  ? { increment: 1 }
                  : undefined,
              status: plan.technicalAutomatedFinal
                ? "AUTO_INVESTIGATING"
                : plan.course.supportIncident.status,
              ...(plan.technicalAutomatedFinal
                ? {
                    resolvedAt: null,
                    resolution: null,
                    resolutionMessage: null,
                    resolutionNotifiedAt: null,
                    humanReviewReason: null,
                    nextReminderAt: null
                  }
                : {}),
              confirmedAt: plan.course.supportIncident.confirmedAt ?? now,
              escalationDeadlineAt:
                plan.course.supportIncident.escalationDeadlineAt ??
                getCourseMonitoringEscalationDeadline(now, plan.realDemandCount),
              nextAttemptAt: now,
              activeRealSearchCount: plan.realDemandCount,
              earliestTargetDate: plan.earliestTargetDate,
              revision: { increment: 1 }
            }
          });
          if (plan.needsIncidentConfirmation) {
            incidentsConfirmed += 1;
          }
        }

        const baselineEvent = await transaction.courseMonitoringEvent.findUnique({
          where: { idempotencyKey: baselineKey },
          select: { id: true }
        });
        if (!baselineEvent) {
          await transaction.courseMonitoringEvent.create({
            data: {
              courseId: plan.course.id,
              incidentId,
              eventType: "BASELINE_IMPORTED",
              source: "MAINTENANCE",
              toState: plan.state,
              outcome: plan.course.probes[0]?.outcome,
              failureFingerprint:
                plan.course.supportIncident?.failureFingerprint ??
                (plan.state === "AUTO_INVESTIGATING"
                  ? buildBaselineFingerprint(plan.course, plan.readerCandidate)
                  : null),
              message:
                "Current durable course facts were imported as the monitoring lifecycle baseline; no earlier timeline was invented.",
              idempotencyKey: baselineKey,
              occurredAt: now,
              audit: {
                baselineVersion: 1,
                preservedManualFinal: plan.state === "FINAL_MANUAL",
                preservedIdentityFinal: plan.state === "FINAL_IDENTITY",
                reopenedAutomatedTechnicalFinal: plan.technicalAutomatedFinal,
                readerCandidate: plan.readerCandidate,
                customerDataIncluded: false
              }
            }
          });
          baselineEventsCreated += 1;
        }

        return {
          statusesCreated,
          baselineEventsCreated,
          technicalRowsReopened,
          incidentsCreated,
          incidentsConfirmed
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    report.applied.statusesCreated += result.statusesCreated;
    report.applied.baselineEventsCreated += result.baselineEventsCreated;
    report.applied.technicalRowsReopened += result.technicalRowsReopened;
    report.applied.incidentsCreated += result.incidentsCreated;
    report.applied.incidentsConfirmed += result.incidentsConfirmed;
  }

  return report;
}

function getBaselineState(input: {
  isPublic: boolean | null;
  bookingMethod: string;
  automationReason: string;
  automationEligibility: string;
  bookingAccessMode: string;
  latestProbeOutcome?: string;
  incidentStatus: string | null;
  incidentResolution: string | null;
  readerCandidate: boolean;
  humanApprovedTechnicalFinal: boolean;
}): CourseMonitoringState {
  if (input.incidentStatus) {
    const incidentState = getIncidentLifecycleState({
      incidentStatus: input.incidentStatus,
      resolution: input.incidentResolution,
      currentState: "UNKNOWN"
    });
    if (incidentState) {
      return incidentState;
    }
  }
  if (input.humanApprovedTechnicalFinal) {
    return "FINAL_TECHNICAL";
  }
  if (input.isPublic === false) {
    return "FINAL_IDENTITY";
  }
  if (
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(input.bookingMethod) ||
    input.automationReason === "NO_ONLINE_BOOKING"
  ) {
    return "FINAL_MANUAL";
  }
  if (input.latestProbeOutcome === "MATCH_FOUND" || input.latestProbeOutcome === "NO_MATCH") {
    return "HEALTHY";
  }
  if (
    input.readerCandidate ||
    (input.automationEligibility === "BLOCKED" &&
      (input.bookingAccessMode === "CAPTCHA_OR_QUEUE" ||
        input.bookingAccessMode.startsWith("ACCOUNT") ||
        ["CAPTCHA_OR_QUEUE", "ACCOUNT_REQUIRED", "TEMPORARILY_UNAVAILABLE", "OTHER"].includes(
          input.automationReason
        )))
  ) {
    return "AUTO_INVESTIGATING";
  }
  return "UNKNOWN";
}

export function getIncidentLifecycleState(input: {
  incidentStatus: string;
  resolution: string | null;
  currentState: CourseMonitoringState;
}): CourseMonitoringState | null {
  if (input.currentState === "REVALIDATING_FINAL") {
    return "REVALIDATING_FINAL";
  }
  if (input.incidentStatus === "NEEDS_HUMAN") {
    return "ENGINEERING_VERIFICATION_NEEDED";
  }
  if (input.incidentStatus === "AUTO_INVESTIGATING") {
    return "AUTO_INVESTIGATING";
  }
  if (input.incidentStatus !== "RESOLVED") {
    return null;
  }
  if (
    input.currentState !== "DEGRADED_RETRYING" &&
    input.currentState !== "AUTO_INVESTIGATING" &&
    input.currentState !== "ENGINEERING_VERIFICATION_NEEDED"
  ) {
    return null;
  }
  if (input.resolution === "MONITORING_RESTORED") {
    return "HEALTHY";
  }
  if (input.resolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION") {
    return "FINAL_TECHNICAL";
  }
  if (
    input.resolution === "DIRECT_BOOKING_CLASSIFIED" ||
    input.resolution === "SOURCE_UNVERIFIED"
  ) {
    return "FINAL_MANUAL";
  }
  return null;
}

function getReconciledMonitoringUpdate(input: {
  desiredState: CourseMonitoringState;
  incident: {
    status: string;
    resolution: string | null;
    failureFingerprint: string;
    nextAttemptAt: Date | null;
    resolvedAt: Date | null;
  };
  now: Date;
}): Prisma.CourseMonitoringStatusUpdateManyMutationInput {
  const investigating =
    input.desiredState === "AUTO_INVESTIGATING" ||
    input.desiredState === "ENGINEERING_VERIFICATION_NEEDED";
  return {
    state: input.desiredState,
    lastSuccessfulAt:
      input.desiredState === "HEALTHY" ? (input.incident.resolvedAt ?? input.now) : undefined,
    consecutiveFailures: investigating ? undefined : 0,
    failureFingerprint: investigating ? input.incident.failureFingerprint : null,
    firstDegradedAt: investigating ? undefined : null,
    nextAutomaticAttemptAt: investigating ? input.incident.nextAttemptAt : null,
    revalidationRequestedAt: null,
    stateChangedAt: input.now,
    revision: { increment: 1 }
  };
}

function isAutomatedTechnicalFinal(course: {
  isPublic: boolean | null;
  bookingMethod: string;
  automationEligibility: string;
  automationReason: string;
  bookingAccessMode: string;
}) {
  return Boolean(
    course.isPublic !== false &&
    course.automationEligibility === "BLOCKED" &&
    !["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(course.bookingMethod) &&
    (course.bookingAccessMode === "CAPTCHA_OR_QUEUE" ||
      course.bookingAccessMode.startsWith("ACCOUNT") ||
      ["CAPTCHA_OR_QUEUE", "ACCOUNT_REQUIRED", "TEMPORARILY_UNAVAILABLE", "OTHER"].includes(
        course.automationReason
      ))
  );
}

function buildBaselineFingerprint(
  course: {
    providerFamilyKey: string;
    detectedBookingUrl: string | null;
    website: string | null;
  },
  readerCandidate: boolean
) {
  const providerFamilyKey = resolveProviderCapability(course).providerFamilyKey;
  return buildProviderFailureFingerprint({
    providerFamilyKey,
    failureClass: readerCandidate ? "READER_PARSER_MISSING" : "UNKNOWN",
    operation: readerCandidate ? "METADATA" : "AVAILABILITY",
    httpStatus: null
  });
}
