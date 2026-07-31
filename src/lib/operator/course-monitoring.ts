import { Prisma, type CourseHumanReviewReason } from "@prisma/client";
import { z } from "zod";

import {
  createIncidentReference,
  getHumanReviewRetryAt,
  getCourseMonitoringEscalationDeadline,
  sanitizeEvidenceUrl
} from "@/lib/automation/course-monitoring";
import {
  buildProviderFailureFingerprint,
  normalizeProviderFamilyKey,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { getCourseLocalDateStorageBoundary } from "@/lib/automation/date-boundary";
import { startSearchSchedule } from "@/lib/automation/search-scheduler";
import { queueLocalReaderCourseVerification } from "@/lib/local-reader/service";
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
const safeOperatorNoteSchema = boundedNoteSchema.transform((value) =>
  sanitizeResponderText(value)
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

export const operatorCourseDecisionSchema = z.enum([
  "LOCAL_READER",
  "WEBSITE_TEMPORARILY_UNAVAILABLE",
  "PRIVATE_COURSE",
  "PHONE_OR_MANUAL",
  "ACCOUNT_REQUIRED",
  "CAPTCHA_OR_QUEUE",
  "OTHER_TECHNICAL_LIMITATION"
]);

export type OperatorCourseDecision = z.infer<typeof operatorCourseDecisionSchema>;

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
      automationReason: status.course.automationReason,
      monitoringMode: status.course.monitoringMode,
      isPublic: status.course.isPublic
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

export async function updateOperatorCourseOfficialLinks(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    providerFamilyKey: string;
    website: string | null;
    bookingUrl: string | null;
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
      providerFamilyKey: z.string().trim().min(1).max(253),
      website: z.string().trim().max(1000).nullable(),
      bookingUrl: z.string().trim().max(1000).nullable(),
      idempotencyKey: idempotencyKeySchema
    })
    .parse(rawInput);
  const website = optionalSafeHttpsUrl(input.website, "official course site");
  const bookingUrl = optionalSafeHttpsUrl(input.bookingUrl, "official booking page");
  const providerFamilyKey = normalizeProviderFamilyKey(input.providerFamilyKey);
  if (
    providerFamilyKey === "SOURCE_MISSING" &&
    input.providerFamilyKey.toUpperCase() !== "SOURCE_MISSING"
  ) {
    throw new Error("Enter a known provider name or a valid booking hostname.");
  }
  if (!website && !bookingUrl) {
    throw new Error("Enter an official course site or booking page.");
  }
  const current = await requireMutationTarget(
    input.reference,
    input.statusRevision,
    input.incidentCycle,
    input.incidentRevision,
    input.idempotencyKey
  );
  if (
    website === current.status.course.website &&
    bookingUrl === current.status.course.detectedBookingUrl &&
    providerFamilyKey === current.status.course.providerFamilyKey
  ) {
    throw new Error("Change the provider or at least one official link before saving.");
  }
  const provider = resolveProviderCapability(
    providerFamilyKey === "SOURCE_MISSING"
      ? {
          website,
          detectedBookingUrl: bookingUrl
        }
      : { providerFamilyKey }
  );
  const evidenceUrl = bookingUrl ?? website!;
  const preview = {
    action: "update_official_links" as const,
    courseRef: current.status.reference,
    providerFamilyKey: provider.providerFamilyKey,
    queuedAlertCount: current.activeSearches.length
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  const message =
    "Provider or official links changed. Provider verification and a fresh monitoring check were queued.";
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
        bookingUrlSnapshot: bookingUrl ?? website!,
        message
      });
      await transaction.course.update({
        where: { id: current.status.courseId },
        data: {
          website,
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
          revalidationRequestedAt: now,
          stateChangedAt: now,
          revision: { increment: 1 }
        }
      });
      await transaction.courseMonitoringEvent.create({
        data: {
          courseId: current.status.courseId,
          incidentId: incident.id,
          eventType: "REVALIDATION_REQUESTED",
          source: context.source,
          fromState: current.status.state,
          toState: "AUTO_INVESTIGATING",
          message,
          evidenceUrl,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "update_official_links",
            providerFamilyKey: provider.providerFamilyKey,
            websiteChanged: website !== current.status.course.website,
            bookingUrlChanged: bookingUrl !== current.status.course.detectedBookingUrl,
            customerDataIncluded: false
          }
        }
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
  const localReaderJob = await queueOperatorLocalReaderRecheck(current, now, bookingUrl);
  await dispatchAffectedSearches(
    current.activeSearches.map((search) => search.id),
    context.dispatchSearches
  );
  return {
    ...preview,
    localReaderQueued: localReaderJob !== null,
    applied: true,
    replayed: false
  };
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
          revalidationRequestedAt: now,
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
            ...(current.incident.status === "NEEDS_HUMAN"
              ? {
                  status: "AUTO_INVESTIGATING" as const,
                  humanReviewReason: null,
                  nextReminderAt: null
                }
              : {}),
            nextAttemptAt: now,
            ...(current.incident.status !== "RESOLVED"
              ? {
                  escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
                    now,
                    current.incident.activeRealSearchCount
                  )
                }
              : {}),
            lastSeenAt: now,
            nextAction: input.note,
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
  const localReaderJob = await queueOperatorLocalReaderRecheck(current, now);
  await dispatchAffectedSearches(
    current.activeSearches.map((search) => search.id),
    context.dispatchSearches
  );
  return {
    ...preview,
    localReaderQueued: localReaderJob !== null,
    applied: true,
    replayed: false
  };
}

export async function applyOperatorCourseDecision(
  rawInput: {
    reference: string;
    statusRevision: number;
    incidentCycle: number | null;
    incidentRevision: number | null;
    decision: OperatorCourseDecision;
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
      decision: operatorCourseDecisionSchema,
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
  if (!current.incident) {
    throw new Error("A durable course incident is required before setting the course outcome.");
  }
  const incident = current.incident;
  const preview = {
    action: "set_course_outcome" as const,
    courseRef: current.status.reference,
    decision: input.decision
  };
  if (!context.apply || current.replayed) {
    return { ...preview, applied: false, replayed: current.replayed };
  }

  const now = new Date();
  if (input.decision === "WEBSITE_TEMPORARILY_UNAVAILABLE") {
    const message =
      "The course website is currently not working correctly. Tee Time Spot will check again and let golfers know when tee times can be viewed.";
    const retryAt = getHumanReviewRetryAt(
      now,
      incident.activeRealSearchCount
    );
    const failureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: current.status.course.providerFamilyKey,
      failureClass: "UNKNOWN",
      operation: "AVAILABILITY",
      httpStatus: null
    });
    await prisma.$transaction(
      async (transaction) => {
        await assertMutationStillCurrent(transaction, current, input);
        await transaction.course.update({
          where: { id: current.status.courseId },
          data: {
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "TEMPORARILY_UNAVAILABLE",
            intelligenceVerifiedAt: null,
            intelligenceReviewAt: retryAt,
            intelligenceConfidence: null
          }
        });
        await transaction.courseMonitoringStatus.update({
          where: {
            courseId: current.status.courseId,
            revision: current.status.revision
          },
          data: {
            state: "DEGRADED_RETRYING",
            lastFailureAt: now,
            consecutiveFailures: { increment: 1 },
            failureFingerprint,
            firstDegradedAt: current.status.firstDegradedAt ?? now,
            nextAutomaticAttemptAt: retryAt,
            revalidationRequestedAt: null,
            stateChangedAt: now,
            revision: { increment: 1 }
          }
        });
        await transaction.courseSupportIncident.update({
          where: {
            id: incident.id,
            cycle: incident.cycle,
            revision: incident.revision
          },
          data: {
            cycle: incident.status === "RESOLVED" ? { increment: 1 } : undefined,
            status: "AUTO_INVESTIGATING",
            kind: "FETCH_FAILED",
            failureClass: "UNKNOWN",
            failureFingerprint,
            latestMessage: message,
            nextAction: "Check the official course website again after the temporary retry window.",
            nextAttemptAt: retryAt,
            confirmedAt: now,
            escalationDeadlineAt: retryAt,
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
            incidentId: incident.id,
            eventType: "HUMAN_DECISION",
            source: context.source,
            fromState: current.status.state,
            toState: "DEGRADED_RETRYING",
            outcome: "FETCH_FAILED",
            failureFingerprint,
            message,
            evidenceUrl:
              current.status.course.detectedBookingUrl ?? current.status.course.website,
            operatorActorId: normalizeActorId(context.actorId),
            idempotencyKey: input.idempotencyKey,
            occurredAt: now,
            audit: {
              action: "set_course_outcome",
              decision: input.decision,
              timerBasedRevalidation: true,
              customerDataIncluded: false
            }
          }
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
    return {
      ...preview,
      retryAt,
      applied: true,
      replayed: false
    };
  }

  if (input.decision === "LOCAL_READER") {
    const message = "Use the local tee-time reader for this course.";
    const localReaderJob = await queueOperatorLocalReaderRecheck(current, now);
    if (!localReaderJob) {
      throw new Error(
        "The official booking page is not supported by the local tee-time reader yet. Engineering still owns this course, and no monitoring state was changed."
      );
    }
    const failureFingerprint = buildProviderFailureFingerprint({
      providerFamilyKey: current.status.course.providerFamilyKey,
      failureClass: "READER_PARSER_MISSING",
      operation: "AVAILABILITY",
      httpStatus: null
    });
    await prisma.$transaction(
      async (transaction) => {
        await assertMutationStillCurrent(transaction, current, input);
        await transaction.course.update({
          where: { id: current.status.courseId },
          data: {
            monitoringMode: "LOCAL_READER_ONLY",
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
            failureFingerprint,
            firstDegradedAt: current.status.firstDegradedAt ?? now,
            nextAutomaticAttemptAt: now,
            revalidationRequestedAt: now,
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
            cycle: current.incident!.status === "RESOLVED" ? { increment: 1 } : undefined,
            status: "AUTO_INVESTIGATING",
            kind: "READER_CANDIDATE",
            failureClass: "READER_PARSER_MISSING",
            failureFingerprint,
            latestMessage: message,
            nextAction: message,
            nextAttemptAt: now,
            confirmedAt: now,
            escalationDeadlineAt: getCourseMonitoringEscalationDeadline(
              now,
              current.incident!.activeRealSearchCount
            ),
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
            fromState: current.status.state,
            toState: "AUTO_INVESTIGATING",
            failureFingerprint,
            message,
            evidenceUrl:
              current.status.course.detectedBookingUrl ?? current.status.course.website,
            operatorActorId: normalizeActorId(context.actorId),
            idempotencyKey: input.idempotencyKey,
            occurredAt: now,
            audit: {
              action: "set_course_outcome",
              decision: input.decision,
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
    return {
      ...preview,
      localReaderQueued: true,
      applied: true,
      replayed: false
    };
  }

  const finalDecision = getFinalDecision(input.decision);
  await prisma.$transaction(
    async (transaction) => {
      await assertMutationStillCurrent(transaction, current, input);
      await transaction.course.update({
        where: { id: current.status.courseId },
        data: {
          ...finalDecision.course,
          policyNotes: finalDecision.message,
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
          state: finalDecision.state,
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
          humanReviewReason: finalDecision.humanReviewReason,
          nextReminderAt: null,
          nextAttemptAt: null,
          resolvedAt: now,
          resolution: finalDecision.resolution,
          resolutionMessage: finalDecision.message,
          decisionActorId: normalizeActorId(context.actorId),
          decisionAt: now,
          decisionNote: finalDecision.message,
          decisionEvidenceUrl:
            current.status.course.detectedBookingUrl ?? current.status.course.website,
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
          toState: finalDecision.state,
          outcome: finalDecision.outcome,
          failureFingerprint: current.incident!.failureFingerprint,
          message: finalDecision.message,
          evidenceUrl:
            current.status.course.detectedBookingUrl ?? current.status.course.website,
          operatorActorId: normalizeActorId(context.actorId),
          idempotencyKey: input.idempotencyKey,
          occurredAt: now,
          audit: {
            action: "set_course_outcome",
            decision: input.decision,
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
          timeZone: true,
          bookingAccessMode: true,
          automationReason: true,
          isPublic: true,
          monitoringMode: true,
          bookingMethod: true,
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
    select: { id: true, date: true, players: true }
  });
  return {
    status,
    incident,
    activeSearches,
    replayed: Boolean(replayed)
  };
}

async function queueOperatorLocalReaderRecheck(
  current: Awaited<ReturnType<typeof requireMutationTarget>>,
  now: Date,
  bookingUrlOverride?: string | null
) {
  const bookingUrl =
    bookingUrlOverride === undefined
      ? current.status.course.detectedBookingUrl
      : bookingUrlOverride;
  if (!bookingUrl) return null;
  const activeSearch = current.activeSearches[0];
  const fallbackDate = getCourseLocalDateStorageBoundary(
    current.status.course.timeZone,
    now
  );
  fallbackDate.setUTCDate(fallbackDate.getUTCDate() + 1);
  try {
    return await queueLocalReaderCourseVerification({
      courseId: current.status.courseId,
      targetDate: (activeSearch?.date ?? fallbackDate).toISOString().slice(0, 10),
      players: activeSearch?.players ?? 2,
      bookingUrl,
      force: true
    });
  } catch {
    console.error("[operator:course-recheck-local-reader]", {
      category: "local_reader_queue_failed"
    });
    return null;
  }
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

function getFinalDecision(
  decision: Exclude<
    OperatorCourseDecision,
    "LOCAL_READER" | "WEBSITE_TEMPORARILY_UNAVAILABLE"
  >
): {
  state: "FINAL_IDENTITY" | "FINAL_MANUAL" | "FINAL_TECHNICAL";
  resolution:
    | "IDENTITY_CLASSIFIED"
    | "DIRECT_BOOKING_CLASSIFIED"
    | "HUMAN_VERIFIED_TECHNICAL_LIMITATION";
  humanReviewReason: CourseHumanReviewReason | null;
  outcome: "IDENTITY_FINAL" | "MANUAL_DIRECT" | "BLOCKED_AUTH" | "BLOCKED_TOOLING";
  message: string;
  course: Prisma.CourseUpdateInput;
} {
  if (decision === "PRIVATE_COURSE") {
    return {
      state: "FINAL_IDENTITY",
      resolution: "IDENTITY_CLASSIFIED",
      humanReviewReason: null,
      outcome: "IDENTITY_FINAL",
      message: "This is a private course. Public tee-time monitoring is closed.",
      course: {
        isPublic: false,
        automationEligibility: "BLOCKED",
        automationReason: "OTHER",
        monitoringMode: "CONTACT_ONLY"
      }
    };
  }
  if (decision === "PHONE_OR_MANUAL") {
    return {
      state: "FINAL_MANUAL",
      resolution: "DIRECT_BOOKING_CLASSIFIED",
      humanReviewReason: null,
      outcome: "MANUAL_DIRECT",
      message: "Tee times are available only by phone or another manual course process.",
      course: {
        isPublic: true,
        bookingMethod: "PHONE_ONLY",
        bookingAccessMode: "PHONE_ONLY",
        automationEligibility: "BLOCKED",
        automationReason: "NO_ONLINE_BOOKING",
        monitoringMode: "CONTACT_ONLY"
      }
    };
  }
  const technicalFields = technicalCourseFieldsForReason(decision);
  const message =
    decision === "ACCOUNT_REQUIRED"
      ? "An account is required to view tee times."
      : decision === "CAPTCHA_OR_QUEUE"
        ? "A captcha or waiting room blocks signed-out tee-time monitoring."
        : "This course has another confirmed technical limitation.";
  return {
    state: "FINAL_TECHNICAL",
    resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
    humanReviewReason: decision,
    outcome: decision === "ACCOUNT_REQUIRED" ? "BLOCKED_AUTH" : "BLOCKED_TOOLING",
    message,
    course: {
      automationEligibility: "BLOCKED",
      ...technicalFields
    }
  };
}

function requireSafeHttpsUrl(value: string, label: string) {
  const sanitized = sanitizeEvidenceUrl(value);
  if (!sanitized) {
    throw new Error(`${label} must be a public HTTPS URL without credentials.`);
  }
  return sanitized;
}

function optionalSafeHttpsUrl(value: string | null, label: string) {
  if (!value?.trim()) {
    return null;
  }
  return requireSafeHttpsUrl(value, label);
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
