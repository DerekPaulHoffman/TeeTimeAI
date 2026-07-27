import { Prisma, type CourseHumanReviewReason } from "@prisma/client";
import { z } from "zod";

import {
  createIncidentReference,
  getCourseMonitoringEscalationDeadline,
  sanitizeEvidenceUrl
} from "@/lib/automation/course-monitoring";
import {
  buildProviderFailureFingerprint,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { prisma } from "@/lib/prisma";

const referenceSchema = z
  .string()
  .trim()
  .regex(/^(?:cm|csi)_[a-z0-9]{16,32}$/u);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(16)
  .max(100)
  .regex(/^[a-zA-Z0-9:_-]+$/u);
const boundedNoteSchema = z.string().trim().min(3).max(500);
const safeOperatorNoteSchema = boundedNoteSchema.refine(
  (value) => sanitizeResponderText(value) === value,
  "Operator notes must not contain emails, identifiers, credentials, tokens, or raw URLs."
);
const revisionSchema = z.number().int().nonnegative();
const cycleSchema = z.number().int().positive().nullable();

export const humanReviewReasonSchema = z.enum([
  "CAPTCHA_OR_QUEUE",
  "ACCOUNT_REQUIRED",
  "SOURCE_UNVERIFIED",
  "READER_RELOAD_REQUIRED",
  "OFFICIAL_LINK_VERIFICATION_FAILED",
  "OTHER_TECHNICAL_LIMITATION"
]);

export type OperatorMutationContext = {
  actorId: string;
  source: "OPERATOR_DASHBOARD" | "OPERATOR_CLI";
  apply: boolean;
  dispatchSearches?: boolean;
};

export async function loadOperatorCourseMonitoringDetail(reference: string) {
  const parsedReference = referenceSchema.safeParse(reference);
  if (!parsedReference.success) {
    return null;
  }
  const status = await prisma.courseMonitoringStatus.findFirst({
    where: {
      OR: [
        { reference: parsedReference.data },
        {
          course: {
            supportIncident: {
              reference: parsedReference.data
            }
          }
        }
      ]
    },
    include: {
      course: {
        include: {
          supportIncident: true,
          monitoringEvents: {
            orderBy: { occurredAt: "desc" },
            take: 100,
            select: {
              id: true,
              eventType: true,
              source: true,
              fromState: true,
              toState: true,
              outcome: true,
              readPath: true,
              message: true,
              evidenceUrl: true,
              runtimeVersion: true,
              deploymentSha: true,
              operatorActorId: true,
              occurredAt: true,
              audit: true
            }
          }
        }
      }
    }
  });
  if (!status) {
    return null;
  }

  const [activeRealAlerts, pendingDeliveries] = await Promise.all([
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: ["AUTOMATION", "TEST"] },
        preferences: { some: { courseId: status.courseId } }
      }
    }),
    prisma.searchEmailDelivery.count({
      where: {
        status: { in: ["PENDING", "SENDING", "FAILED"] },
        teeSearch: {
          preferences: { some: { courseId: status.courseId } }
        }
      }
    })
  ]);

  return {
    reference: status.reference,
    state: status.state,
    revision: status.revision,
    lastSuccessfulAt: status.lastSuccessfulAt,
    lastFailureAt: status.lastFailureAt,
    consecutiveFailures: status.consecutiveFailures,
    firstDegradedAt: status.firstDegradedAt,
    nextAutomaticAttemptAt: status.nextAutomaticAttemptAt,
    revalidationRequestedAt: status.revalidationRequestedAt,
    stateChangedAt: status.stateChangedAt,
    activeRealAlerts,
    pendingDeliveries,
    course: {
      name: status.course.name,
      address: status.course.address,
      city: status.course.city,
      stateCode: status.course.stateCode,
      detectedPlatform: status.course.detectedPlatform,
      providerFamilyKey: status.course.providerFamilyKey,
      website: safeOperatorUrl(status.course.website),
      detectedBookingUrl: safeOperatorUrl(status.course.detectedBookingUrl),
      bookingMethod: status.course.bookingMethod,
      bookingAccessMode: status.course.bookingAccessMode,
      automationEligibility: status.course.automationEligibility,
      automationReason: status.course.automationReason
    },
    incident: status.course.supportIncident
      ? {
          reference: status.course.supportIncident.reference,
          cycle: status.course.supportIncident.cycle,
          revision: status.course.supportIncident.revision,
          status: status.course.supportIncident.status,
          kind: status.course.supportIncident.kind,
          failureClass: status.course.supportIncident.failureClass,
          confirmedAt: status.course.supportIncident.confirmedAt,
          escalationDeadlineAt: status.course.supportIncident.escalationDeadlineAt,
          humanReviewReason: status.course.supportIncident.humanReviewReason,
          nextReminderAt: status.course.supportIncident.nextReminderAt,
          nextAction: sanitizeOperatorText(status.course.supportIncident.nextAction),
          latestMessage: sanitizeOperatorText(status.course.supportIncident.latestMessage),
          attemptCount: status.course.supportIncident.attemptCount,
          activeRealSearchCount: status.course.supportIncident.activeRealSearchCount,
          resolution: status.course.supportIncident.resolution,
          resolutionMessage: sanitizeOperatorText(status.course.supportIncident.resolutionMessage),
          decisionAt: status.course.supportIncident.decisionAt,
          decisionNote: sanitizeOperatorText(status.course.supportIncident.decisionNote),
          decisionEvidenceUrl: safeOperatorUrl(status.course.supportIncident.decisionEvidenceUrl)
        }
      : null,
    timeline: status.course.monitoringEvents.map((event) => ({
      ...event,
      evidenceUrl: safeOperatorUrl(event.evidenceUrl),
      operatorActorId: event.operatorActorId ? "[operator]" : null,
      audit: sanitizeTimelineAudit(event.audit)
    }))
  };
}

export async function correctOperatorCourseBookingLink(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    bookingUrl: string;
    evidenceUrl: string;
    note: string;
    idempotencyKey: string;
  },
  context: OperatorMutationContext
) {
  const input = z
    .object({
      reference: referenceSchema,
      statusRevision: revisionSchema,
      incidentCycle: cycleSchema,
      incidentRevision: revisionSchema.nullable(),
      bookingUrl: z.string().trim().url().max(1000),
      evidenceUrl: z.string().trim().url().max(1000),
      note: safeOperatorNoteSchema,
      idempotencyKey: idempotencyKeySchema
    })
    .parse(rawInput);
  const bookingUrl = requireSafeHttpsUrl(input.bookingUrl, "booking link");
  const evidenceUrl = requireSafeHttpsUrl(input.evidenceUrl, "official evidence link");
  const current = await requireMutationTarget(
    input.reference,
    input.statusRevision,
    input.incidentCycle,
    input.incidentRevision,
    input.idempotencyKey
  );
  const provider = resolveProviderCapability({
    detectedBookingUrl: bookingUrl
  });
  const preview = {
    action: "correct_booking_link" as const,
    courseRef: current.status.reference,
    providerFamilyKey: provider.providerFamilyKey,
    queuedAlertCount: current.activeSearches.length
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  await prisma.$transaction(
    async (transaction) => {
      await assertMutationStillCurrent(transaction, current, input);
      const incident = await ensureOperatorIncident(transaction, {
        current,
        now,
        kind: "NEEDS_ADAPTER",
        failureClass: "MISSING_METADATA",
        failureFingerprint: buildProviderFailureFingerprint({
          providerFamilyKey: provider.providerFamilyKey,
          failureClass: "MISSING_METADATA",
          operation: "METADATA",
          httpStatus: null
        }),
        providerFamilyKey: provider.providerFamilyKey,
        bookingUrlSnapshot: bookingUrl,
        message:
          "An operator corrected the official booking link and requested fresh monitoring proof."
      });
      await transaction.course.update({
        where: { id: current.status.courseId },
        data: {
          detectedBookingUrl: bookingUrl,
          detectedPlatform: provider.detectedPlatform,
          providerFamilyKey: provider.providerFamilyKey,
          automationEligibility: "NEEDS_REVIEW",
          automationReason: "OTHER",
          intelligenceVerifiedAt: null,
          intelligenceReviewAt: null,
          intelligenceConfidence: null
        }
      });
      await transaction.courseMonitoringStatus.update({
        where: {
          courseId: current.status.courseId,
          revision: current.status.revision
        },
        data: {
          state: "AUTO_INVESTIGATING",
          failureFingerprint: incident.failureFingerprint,
          firstDegradedAt: current.status.firstDegradedAt ?? now,
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: null,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: current.status.courseId,
          incidentId: incident.id,
          eventType: "HUMAN_DECISION",
          source: context.source,
          fromState: current.status.state,
          toState: "AUTO_INVESTIGATING",
          message: input.note,
          evidenceUrl,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "correct_booking_link",
            providerFamilyKey: provider.providerFamilyKey,
            customerDataIncluded: false
          }
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  await dispatchAffectedSearches(
    current.activeSearches.map((search) => search.id),
    context.dispatchSearches
  );
  return { ...preview, applied: true, replayed: false };
}

export async function requestOperatorCourseRecheck(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    note: string;
    idempotencyKey: string;
  },
  context: OperatorMutationContext
) {
  const input = z
    .object({
      reference: referenceSchema,
      statusRevision: revisionSchema,
      incidentCycle: cycleSchema,
      incidentRevision: revisionSchema.nullable(),
      note: safeOperatorNoteSchema,
      idempotencyKey: idempotencyKeySchema
    })
    .parse(rawInput);
  const current = await requireMutationTarget(
    input.reference,
    input.statusRevision,
    input.incidentCycle,
    input.incidentRevision,
    input.idempotencyKey
  );
  const preview = {
    action: "request_recheck" as const,
    courseRef: current.status.reference,
    queuedAlertCount: current.activeSearches.length
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  await prisma.$transaction(
    async (transaction) => {
      await assertMutationStillCurrent(transaction, current, input);
      await transaction.courseMonitoringStatus.update({
        where: {
          courseId: current.status.courseId,
          revision: current.status.revision
        },
        data: {
          state:
            current.status.state === "FINAL_TECHNICAL"
              ? "REVALIDATING_FINAL"
              : "AUTO_INVESTIGATING",
          revalidationRequestedAt: current.status.state === "FINAL_TECHNICAL" ? now : null,
          nextAutomaticAttemptAt: now,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      if (current.incident) {
        await transaction.courseSupportIncident.update({
          where: {
            id: current.incident.id,
            cycle: current.incident.cycle,
            revision: current.incident.revision
          },
          data: {
            nextAttemptAt: now,
            lastSeenAt: now,
            revision: { increment: 1 }
          }
        });
      }
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: current.status.courseId,
          incidentId: current.incident?.id,
          eventType: "REVALIDATION_REQUESTED",
          source: context.source,
          fromState: current.status.state,
          toState:
            current.status.state === "FINAL_TECHNICAL"
              ? "REVALIDATING_FINAL"
              : "AUTO_INVESTIGATING",
          message: input.note,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "request_recheck",
            customerDataIncluded: false
          }
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  await dispatchAffectedSearches(
    current.activeSearches.map((search) => search.id),
    context.dispatchSearches
  );
  return { ...preview, applied: true, replayed: false };
}

export async function approveOperatorCourseTechnicalFinal(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    reason: CourseHumanReviewReason;
    evidenceUrl: string;
    note: string;
    idempotencyKey: string;
  },
  context: OperatorMutationContext
) {
  const input = z
    .object({
      reference: referenceSchema,
      statusRevision: revisionSchema,
      incidentCycle: cycleSchema,
      incidentRevision: revisionSchema.nullable(),
      reason: humanReviewReasonSchema,
      evidenceUrl: z.string().trim().url().max(1000),
      note: safeOperatorNoteSchema,
      idempotencyKey: idempotencyKeySchema
    })
    .parse(rawInput);
  const evidenceUrl = requireSafeHttpsUrl(input.evidenceUrl, "official evidence link");
  const current = await requireMutationTarget(
    input.reference,
    input.statusRevision,
    input.incidentCycle,
    input.incidentRevision,
    input.idempotencyKey
  );
  if (!current.incident) {
    throw new Error("A durable course incident is required before approving a final limitation.");
  }
  const preview = {
    action: "approve_technical_final" as const,
    courseRef: current.status.reference,
    reason: input.reason
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  const technicalFields = technicalCourseFieldsForReason(input.reason);
  await prisma.$transaction(
    async (transaction) => {
      await assertMutationStillCurrent(transaction, current, input);
      await transaction.course.update({
        where: { id: current.status.courseId },
        data: {
          automationEligibility: "BLOCKED",
          ...technicalFields,
          policyNotes: input.note,
          intelligenceVerifiedAt: now,
          intelligenceReviewAt: null,
          intelligenceConfidence: 1
        }
      });
      await transaction.courseMonitoringStatus.update({
        where: {
          courseId: current.status.courseId,
          revision: current.status.revision
        },
        data: {
          state: "FINAL_TECHNICAL",
          nextAutomaticAttemptAt: null,
          revalidationRequestedAt: null,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseSupportIncident.update({
        where: {
          id: current.incident!.id,
          cycle: current.incident!.cycle,
          revision: current.incident!.revision
        },
        data: {
          status: "RESOLVED",
          humanReviewReason: input.reason,
          nextReminderAt: null,
          nextAttemptAt: null,
          resolvedAt: now,
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
          resolutionMessage: input.note,
          decisionActorId: normalizeActorId(context.actorId),
          decisionAt: now,
          decisionNote: input.note,
          decisionEvidenceUrl: evidenceUrl,
          decisionIdempotencyKey: input.idempotencyKey,
          lastSeenAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: current.status.courseId,
          incidentId: current.incident!.id,
          eventType: "HUMAN_DECISION",
          source: context.source,
          fromState: current.status.state,
          toState: "FINAL_TECHNICAL",
          failureFingerprint: current.incident!.failureFingerprint,
          message: input.note,
          evidenceUrl,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "approve_technical_final",
            reason: input.reason,
            timerBasedRevalidation: false,
            customerDataIncluded: false
          }
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  return { ...preview, applied: true, replayed: false };
}

export async function reopenOperatorCourseTechnicalFinal(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    evidenceUrl: string;
    note: string;
    idempotencyKey: string;
  },
  context: OperatorMutationContext
) {
  const input = z
    .object({
      reference: referenceSchema,
      statusRevision: revisionSchema,
      incidentCycle: cycleSchema,
      incidentRevision: revisionSchema.nullable(),
      evidenceUrl: z.string().trim().url().max(1000),
      note: safeOperatorNoteSchema,
      idempotencyKey: idempotencyKeySchema
    })
    .parse(rawInput);
  const evidenceUrl = requireSafeHttpsUrl(input.evidenceUrl, "official evidence link");
  const current = await requireMutationTarget(
    input.reference,
    input.statusRevision,
    input.incidentCycle,
    input.incidentRevision,
    input.idempotencyKey
  );
  if (
    current.status.state !== "FINAL_TECHNICAL" ||
    !current.incident ||
    current.incident.resolution !== "HUMAN_VERIFIED_TECHNICAL_LIMITATION"
  ) {
    throw new Error("Only an engineer-approved technical final can be reopened.");
  }
  const preview = {
    action: "reopen_technical_final" as const,
    courseRef: current.status.reference,
    queuedAlertCount: current.activeSearches.length
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  await prisma.$transaction(
    async (transaction) => {
      await assertMutationStillCurrent(transaction, current, input);
      await transaction.course.update({
        where: { id: current.status.courseId },
        data: {
          automationEligibility: "NEEDS_REVIEW",
          intelligenceVerifiedAt: null,
          intelligenceReviewAt: null,
          intelligenceConfidence: null
        }
      });
      await transaction.courseMonitoringStatus.update({
        where: {
          courseId: current.status.courseId,
          revision: current.status.revision
        },
        data: {
          state: "AUTO_INVESTIGATING",
          firstDegradedAt: now,
          nextAutomaticAttemptAt: now,
          revalidationRequestedAt: null,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseSupportIncident.update({
        where: {
          id: current.incident!.id,
          cycle: current.incident!.cycle,
          revision: current.incident!.revision
        },
        data: {
          cycle: { increment: 1 },
          status: "AUTO_INVESTIGATING",
          confirmedAt: now,
          escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
            now,
            current.incident!.activeRealSearchCount
          ),
          nextAttemptAt: now,
          humanReviewReason: null,
          nextReminderAt: null,
          resolvedAt: null,
          resolution: null,
          resolutionMessage: null,
          resolutionNotifiedAt: null,
          decisionActorId: null,
          decisionAt: null,
          decisionNote: null,
          decisionEvidenceUrl: null,
          decisionIdempotencyKey: null,
          lastSeenAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: current.status.courseId,
          incidentId: current.incident!.id,
          eventType: "HUMAN_DECISION",
          source: context.source,
          fromState: "FINAL_TECHNICAL",
          toState: "AUTO_INVESTIGATING",
          failureFingerprint: current.incident!.failureFingerprint,
          message: input.note,
          evidenceUrl,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "reopen_technical_final",
            customerDataIncluded: false
          }
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  await dispatchAffectedSearches(
    current.activeSearches.map((search) => search.id),
    context.dispatchSearches
  );
  return { ...preview, applied: true, replayed: false };
}

async function requireMutationTarget(
  reference: string,
  statusRevision: number,
  incidentCycle: number | null,
  incidentRevision: number | null,
  idempotencyKey: string
) {
  const replayed = await prisma.courseMonitoringEvent.findUnique({
    where: { idempotencyKey },
    select: { courseId: true }
  });
  const status = await prisma.courseMonitoringStatus.findFirst({
    where: {
      OR: [{ reference }, { course: { supportIncident: { reference } } }]
    },
    include: {
      course: {
        select: {
          name: true,
          detectedPlatform: true,
          detectedBookingUrl: true,
          website: true,
          providerFamilyKey: true,
          bookingAccessMode: true,
          automationReason: true,
          supportIncident: true
        }
      }
    }
  });
  if (!status) {
    throw new Error("Course monitoring record not found.");
  }
  const incident = status.course.supportIncident;
  if (replayed) {
    if (replayed.courseId !== status.courseId) {
      throw new Error("Idempotency key belongs to another course.");
    }
  } else if (
    status.revision !== statusRevision ||
    !incidentVersionMatches(incident, incidentCycle, incidentRevision)
  ) {
    throw new Error(
      "Course monitoring changed while this form was open. Refresh and review the newest evidence."
    );
  }
  const activeSearches = await prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      preferences: { some: { courseId: status.courseId } }
    },
    select: { id: true }
  });
  return {
    status,
    incident,
    activeSearches,
    replayed: Boolean(replayed)
  };
}

async function assertMutationStillCurrent(
  transaction: Prisma.TransactionClient,
  current: Awaited<ReturnType<typeof requireMutationTarget>>,
  input: {
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    idempotencyKey: string;
  }
) {
  const replayed = await transaction.courseMonitoringEvent.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { id: true }
  });
  if (replayed) {
    throw new Error("This operator action has already been applied.");
  }
  const status = await transaction.courseMonitoringStatus.findUnique({
    where: { courseId: current.status.courseId },
    select: { revision: true }
  });
  const incident = current.incident
    ? await transaction.courseSupportIncident.findUnique({
        where: { id: current.incident.id },
        select: { cycle: true, revision: true }
      })
    : null;
  if (
    status?.revision !== input.statusRevision ||
    !incidentVersionMatches(incident, input.incidentCycle, input.incidentRevision)
  ) {
    throw new Error("Course monitoring changed while this action was being applied.");
  }
}

async function ensureOperatorIncident(
  transaction: Prisma.TransactionClient,
  input: {
    current: Awaited<ReturnType<typeof requireMutationTarget>>;
    now: Date;
    kind: "NEEDS_ADAPTER";
    failureClass: "MISSING_METADATA";
    failureFingerprint: string;
    providerFamilyKey: string;
    bookingUrlSnapshot: string;
    message: string;
  }
) {
  const currentIncident = input.current.incident;
  if (currentIncident) {
    return transaction.courseSupportIncident.update({
      where: {
        id: currentIncident.id,
        cycle: currentIncident.cycle,
        revision: currentIncident.revision
      },
      data: {
        cycle: currentIncident.status === "RESOLVED" ? { increment: 1 } : undefined,
        status: "AUTO_INVESTIGATING",
        kind: input.kind,
        failureClass: input.failureClass,
        failureFingerprint: input.failureFingerprint,
        providerFamilyKey: input.providerFamilyKey,
        bookingUrlSnapshot: input.bookingUrlSnapshot,
        latestMessage: input.message,
        nextAction: "Run a fresh public signed-out check and require exact runtime proof.",
        nextAttemptAt: input.now,
        confirmedAt: input.now,
        escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
          input.now,
          currentIncident.activeRealSearchCount
        ),
        humanReviewReason: null,
        nextReminderAt: null,
        resolvedAt: null,
        resolution: null,
        resolutionMessage: null,
        resolutionNotifiedAt: null,
        revision: { increment: 1 }
      }
    });
  }
  return transaction.courseSupportIncident.create({
    data: {
      reference: createIncidentReference(),
      courseId: input.current.status.courseId,
      kind: input.kind,
      providerFamilyKey: input.providerFamilyKey,
      failureClass: input.failureClass,
      failureFingerprint: input.failureFingerprint,
      courseNameSnapshot: input.current.status.course.name,
      platformSnapshot: input.current.status.course.detectedPlatform,
      bookingUrlSnapshot: input.bookingUrlSnapshot,
      initialMessage: input.message,
      latestMessage: input.message,
      nextAction: "Run a fresh public signed-out check and require exact runtime proof.",
      nextAttemptAt: input.now,
      confirmedAt: input.now,
      escalationDeadlineAt: getCourseMonitoringEscalationDeadline(input.now, 0),
      firstSeenAt: input.now,
      lastSeenAt: input.now
    }
  });
}

async function dispatchAffectedSearches(searchIds: string[], dispatch = false) {
  if (!dispatch || searchIds.length === 0) {
    await prisma.teeSearch.updateMany({
      where: { id: { in: searchIds }, status: "ACTIVE" },
      data: {
        nextCheckAt: new Date(),
        recheckRequestedAt: new Date()
      }
    });
    return;
  }
  const results = await Promise.allSettled(
    searchIds.map((searchId) => startSearchSchedule(searchId))
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    console.error("[operator:course-recheck-dispatch]", {
      attempted: results.length,
      failed: failures.length
    });
  }
}

function technicalCourseFieldsForReason(reason: CourseHumanReviewReason): {
  automationReason: "ACCOUNT_REQUIRED" | "CAPTCHA_OR_QUEUE" | "TEMPORARILY_UNAVAILABLE" | "OTHER";
  bookingAccessMode: "ACCOUNT_REQUIRED" | "CAPTCHA_OR_QUEUE" | "UNKNOWN";
} {
  if (reason === "CAPTCHA_OR_QUEUE") {
    return {
      automationReason: "CAPTCHA_OR_QUEUE",
      bookingAccessMode: "CAPTCHA_OR_QUEUE"
    };
  }
  if (reason === "ACCOUNT_REQUIRED") {
    return {
      automationReason: "ACCOUNT_REQUIRED",
      bookingAccessMode: "ACCOUNT_REQUIRED"
    };
  }
  if (reason === "READER_RELOAD_REQUIRED") {
    return {
      automationReason: "TEMPORARILY_UNAVAILABLE",
      bookingAccessMode: "UNKNOWN"
    };
  }
  return {
    automationReason: "OTHER",
    bookingAccessMode: "UNKNOWN"
  };
}

function requireSafeHttpsUrl(value: string, label: string) {
  const sanitized = sanitizeEvidenceUrl(value);
  if (!sanitized) {
    throw new Error(`${label} must be a public HTTPS URL without credentials.`);
  }
  return sanitized;
}

function safeOperatorUrl(value: string | null | undefined) {
  return sanitizeEvidenceUrl(value);
}

function sanitizeOperatorText(value: string | null | undefined) {
  return value ? sanitizeResponderText(value).slice(0, 500) : null;
}

function normalizeActorId(value: string) {
  const normalized = value.trim().slice(0, 160);
  if (!normalized || /@/u.test(normalized)) {
    throw new Error("Operator actor id must not contain an email address.");
  }
  return normalized;
}

function incidentVersionMatches(
  incident: { cycle: number; revision: number } | null,
  cycle: number | null,
  revision: number | null
) {
  return incident
    ? incident.cycle === cycle && incident.revision === revision
    : cycle === null && revision === null;
}

function sanitizeTimelineAudit(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, item]) =>
          !/(?:email|recipient|searchid|credential|cookie|token|payload|error)/iu.test(key) &&
          ["string", "number", "boolean"].includes(typeof item)
      )
      .slice(0, 20)
  );
}
