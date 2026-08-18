import type {
  CourseSupportIncident,
  CourseSupportIncidentKind,
  CourseSupportResolution,
  DetectedPlatform
} from "@prisma/client";

import {
  isSyntheticWebsiteTrafficClass,
  syntheticWebsiteTrafficClasses
} from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { sanitizeResponderText } from "./course-support-responder-policy";
import { getCourseLocalDateStorageBoundary } from "./date-boundary";
import {
  createIncidentReference,
  getCourseMonitoringEscalationDeadline,
  inferHumanReviewReason,
  recordCourseMonitoringFailure
} from "./course-monitoring";
import { withPostgresAdvisoryTextLease } from "./lease";
import {
  buildProviderFailureFingerprint,
  classifyProviderFailure,
  getProviderReadinessFailure,
  resolveProviderCapability
} from "./provider-capabilities";

export type CourseSupportIssueInput = {
  course: {
    id: string;
    name: string;
    timeZone: string;
    detectedPlatform: DetectedPlatform;
    detectedBookingUrl: string | null;
    website: string | null;
    providerFamilyKey?: string | null;
    bookingMetadata?: unknown;
  };
  searchId: string;
  kind: CourseSupportIncidentKind;
  message?: string;
  error?: unknown;
  nextAction?: string;
  readPath?: string;
  now?: Date;
  episodeStartedAt?: Date;
};

export type CourseSupportIssueState = {
  incidentId: string | null;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "UNRECORDED";
  ownerAlerted: boolean;
};

function canUpgradeResolvedCourseSupportIncident(
  currentResolution: CourseSupportResolution | null,
  nextResolution: CourseSupportResolution
) {
  const factualResolution =
    nextResolution === "DIRECT_BOOKING_CLASSIFIED" ||
    nextResolution === "IDENTITY_CLASSIFIED";
  const revalidatableTechnicalResolution =
    currentResolution === "TECHNICAL_LIMITATION_CLASSIFIED" ||
    currentResolution === "SOURCE_UNVERIFIED" ||
    currentResolution === "HUMAN_VERIFIED_TECHNICAL_LIMITATION";
  return factualResolution && revalidatableTechnicalResolution;
}

export async function reportCourseSupportIssue(
  input: CourseSupportIssueInput
): Promise<CourseSupportIssueState> {
  const lease = await withPostgresAdvisoryTextLease(
    prisma,
    `course-support:${input.course.id}`,
    () => reportCourseSupportIssueWithLease(input)
  );

  return lease.acquired
    ? lease.value
    : {
        incidentId: null,
        status: "UNRECORDED",
        ownerAlerted: false
      };
}

export async function resolveCourseSupportIncident(input: {
  courseId: string;
  resolution: CourseSupportResolution;
  message: string;
  now?: Date;
}) {
  const current = await prisma.courseSupportIncident.findUnique({
    where: { courseId: input.courseId },
    select: {
      id: true,
      courseId: true,
      status: true,
      activeBatchId: true,
      resolution: true,
      revision: true,
      ownerNotifiedAt: true,
      escalationNotifiedAt: true,
      resolutionNotifiedAt: true
    }
  });
  if (
    !current ||
    current.activeBatchId ||
    (current.status === "RESOLVED" &&
      !canUpgradeResolvedCourseSupportIncident(
        current.resolution,
        input.resolution
      ))
  ) {
    return current;
  }

  const lease = await withPostgresAdvisoryTextLease(
    prisma,
    `course-support:${input.courseId}`,
    () => resolveCourseSupportIncidentWithLease(input)
  );

  return lease.acquired ? lease.value : null;
}

export async function escalateCourseSupportIncident(input: {
  incidentId: string;
  message: string;
  nextAction: string;
  now?: Date;
}) {
  const current = await prisma.courseSupportIncident.findUnique({
    where: { id: input.incidentId }
  });
  if (!current || current.status === "RESOLVED") {
    return current;
  }

  const now = input.now ?? new Date();
  const lease = await withPostgresAdvisoryTextLease(
    prisma,
    `course-support:${current.courseId}`,
    async () => {
      const latest = await prisma.courseSupportIncident.findUnique({
        where: { id: input.incidentId }
      });
      if (!latest || latest.status === "RESOLVED") {
        return latest;
      }
      return prisma.courseSupportIncident.update({
        where: { id: latest.id },
        data: {
          status: "NEEDS_HUMAN",
          latestMessage: sanitizeResponderText(input.message).slice(0, 500),
          nextAction: sanitizeResponderText(input.nextAction).slice(0, 500),
          humanReviewReason:
            latest.humanReviewReason ??
            inferHumanReviewReason({
              kind: latest.kind,
              failureClass: latest.failureClass
            }),
          nextReminderAt: now,
          escalatedAt: latest.escalatedAt ?? now,
          lastSeenAt: now,
          revision: { increment: 1 }
        }
      });
    }
  );
  if (!lease.acquired || !lease.value || lease.value.status === "RESOLVED") {
    return lease.acquired ? lease.value : null;
  }

  return lease.value;
}

async function reportCourseSupportIssueWithLease(input: CourseSupportIssueInput) {
  const now = input.now ?? new Date();
  const requestedEpisodeTime = input.episodeStartedAt?.getTime();
  const requestedEpisodeStartedAt = new Date(
    Number.isFinite(requestedEpisodeTime) && requestedEpisodeTime! <= now.getTime()
      ? requestedEpisodeTime!
      : now.getTime()
  );
  const safeMessage = input.message
    ? sanitizeResponderText(input.message).slice(0, 500)
    : undefined;
  const safeNextAction = input.nextAction
    ? sanitizeResponderText(input.nextAction).slice(0, 500)
    : undefined;
  const dateBoundary = getCourseLocalDateStorageBoundary(input.course.timeZone, now);
  const [sourceSearch, affectedSearchCount, realDemand, existing] = await Promise.all([
    prisma.teeSearch.findUnique({
      where: { id: input.searchId },
      select: { trafficClass: true, syntheticMultiCycle: true }
    }),
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        date: { gte: dateBoundary },
        OR: [
          { trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] } },
          { syntheticMultiCycle: true }
        ],
        preferences: {
          some: { courseId: input.course.id }
        }
      }
    }),
    prisma.teeSearch.aggregate({
      where: {
        status: "ACTIVE",
        date: { gte: dateBoundary },
        trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
        preferences: {
          some: { courseId: input.course.id }
        }
      },
      _count: { id: true },
      _min: { date: true }
    }),
    prisma.courseSupportIncident.findUnique({
      where: { courseId: input.course.id }
    })
  ]);

  const disposableSyntheticSearch = Boolean(
    sourceSearch &&
    isSyntheticWebsiteTrafficClass(sourceSearch.trafficClass) &&
    !sourceSearch.syntheticMultiCycle
  );
  const engineeringOnlySource = Boolean(
    sourceSearch &&
    isSyntheticWebsiteTrafficClass(sourceSearch.trafficClass) &&
    sourceSearch.syntheticMultiCycle
  );
  const activeRealSearchCount = realDemand._count.id;
  const earliestTargetDate = realDemand._min.date;
  const bookingUrl = input.course.detectedBookingUrl ?? input.course.website;
  const provider = resolveProviderCapability(input.course);
  const readinessFailure =
    input.kind === "NEEDS_ADAPTER" ? getProviderReadinessFailure(provider) : null;
  const failure = classifyProviderFailure({
    error: input.error ?? input.message,
    readinessFailure
  });
  const failureClass =
    input.kind === "READER_CANDIDATE" ? ("READER_PARSER_MISSING" as const) : failure.failureClass;
  const failureFingerprint = buildProviderFailureFingerprint({
    providerFamilyKey: provider.providerFamilyKey,
    failureClass,
    operation: input.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
    httpStatus: failure.httpStatus
  });
  const materialFailureInputChanged = Boolean(
    existing &&
      (existing.providerFamilyKey !== provider.providerFamilyKey ||
        existing.failureFingerprint !== failureFingerprint ||
        existing.platformSnapshot !== input.course.detectedPlatform ||
        existing.bookingUrlSnapshot !== bookingUrl)
  );
  const authoritativeFactualFinal = Boolean(
    existing?.status === "RESOLVED" &&
      (existing.resolution === "DIRECT_BOOKING_CLASSIFIED" ||
        existing.resolution === "IDENTITY_CLASSIFIED")
  );
  const sourceUnverifiedWithRealDemand = Boolean(
    existing?.status === "RESOLVED" &&
      existing.resolution === "SOURCE_UNVERIFIED" &&
      activeRealSearchCount > 0
  );
  const resolvedFinalDecision = Boolean(
    existing?.status === "RESOLVED" &&
      existing.resolution &&
      existing.resolution !== "MONITORING_RESTORED" &&
      existing.resolution !== "SOURCE_UNVERIFIED"
  );
  const opensFreshFailureCycle = Boolean(
    existing &&
      !existing.activeBatchId &&
      (existing.status === "RESOLVED" || materialFailureInputChanged)
  );
  const effectiveEpisodeStartedAt = opensFreshFailureCycle
    ? now
    : requestedEpisodeStartedAt;

  if (disposableSyntheticSearch) {
    return {
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    } satisfies CourseSupportIssueState;
  }

  if (
    existing?.status === "RESOLVED" &&
    existing.resolution === "SOURCE_UNVERIFIED" &&
    activeRealSearchCount === 0 &&
    existing.providerFamilyKey === provider.providerFamilyKey &&
    existing.failureFingerprint === failureFingerprint
  ) {
    return {
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    } satisfies CourseSupportIssueState;
  }

  const monitoringFailure = await recordCourseMonitoringFailure({
    courseId: input.course.id,
    outcome:
      input.kind === "NEEDS_ADAPTER" || input.kind === "READER_CANDIDATE"
        ? "NEEDS_ADAPTER"
        : input.kind === "BLOCKED_AUTH"
          ? "BLOCKED_AUTH"
          : input.kind === "BLOCKED_TOOLING"
            ? "BLOCKED_TOOLING"
            : "FETCH_FAILED",
    failureFingerprint,
    failureClass,
    providerFamilyKey: provider.providerFamilyKey,
    readPath:
      input.readPath ??
      (input.kind === "NEEDS_ADAPTER"
        ? "OFFICIAL_SOURCE_DISCOVERY"
        : input.kind === "READER_CANDIDATE"
          ? "LOCAL_READER_ALLOWLIST"
          : "TYPED_PROVIDER_ADAPTER"),
    message: safeMessage,
    activeRealSearchCount,
    materialEvidenceChanged:
      !authoritativeFactualFinal &&
      (materialFailureInputChanged || sourceUnverifiedWithRealDemand),
    now,
    episodeStartedAt: effectiveEpisodeStartedAt
  });

  if (monitoringFailure.retainedHumanFinal) {
    return {
      incidentId: existing?.id ?? null,
      status: "UNRECORDED",
      ownerAlerted: false
    } satisfies CourseSupportIssueState;
  }

  const beginsFirstRealDemandEpisode = Boolean(
    existing?.engineeringOnly &&
      existing.activeRealSearchCount === 0 &&
      activeRealSearchCount > 0
  );
  const continuesCurrentIncidentEpisode = Boolean(
    existing &&
      existing.status !== "RESOLVED" &&
      !materialFailureInputChanged
  );
  const incidentEpisodeStartedAt =
    continuesCurrentIncidentEpisode && !beginsFirstRealDemandEpisode
    ? new Date(
        Math.min(
          existing?.firstSeenAt.getTime() ?? now.getTime(),
          effectiveEpisodeStartedAt.getTime()
        )
      )
    : effectiveEpisodeStartedAt;
  const episodeEscalationDeadlineAt = getCourseMonitoringEscalationDeadline(
    incidentEpisodeStartedAt,
    activeRealSearchCount
  );

  if (
    existing &&
    !existing.activeBatchId &&
    (authoritativeFactualFinal ||
      (!materialFailureInputChanged &&
        (resolvedFinalDecision || existing.status === "NEEDS_HUMAN")))
  ) {
    await prisma.courseSupportIncident.updateMany({
      where: {
        id: existing.id,
        cycle: existing.cycle,
        status: existing.status,
        activeBatchId: null
      },
      data: {
        affectedSearchCount: Math.max(existing.affectedSearchCount, affectedSearchCount, 1),
        occurrenceCount: { increment: 1 },
        engineeringOnly:
          existing.engineeringOnly && engineeringOnlySource && activeRealSearchCount === 0,
        activeRealSearchCount: Math.max(existing.activeRealSearchCount, activeRealSearchCount),
        earliestTargetDate:
          existing.earliestTargetDate && earliestTargetDate
            ? new Date(
                Math.min(existing.earliestTargetDate.getTime(), earliestTargetDate.getTime())
              )
            : (existing.earliestTargetDate ?? earliestTargetDate),
        lastSeenAt: now,
        revision: { increment: 1 }
      }
    });
    return {
      incidentId: existing.id,
      status: existing.status === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "UNRECORDED",
      ownerAlerted: Boolean(existing.ownerNotifiedAt || existing.escalationNotifiedAt)
    } satisfies CourseSupportIssueState;
  }

  if (existing?.activeBatchId && existing.status !== "RESOLVED") {
    const nextActiveRealSearchCount = Math.max(
      existing.activeRealSearchCount,
      activeRealSearchCount
    );
    const nextAffectedSearchCount = Math.max(existing.affectedSearchCount, affectedSearchCount, 1);
    const nextEarliestTargetDate =
      existing.earliestTargetDate && earliestTargetDate
        ? new Date(Math.min(existing.earliestTargetDate.getTime(), earliestTargetDate.getTime()))
        : (existing.earliestTargetDate ?? earliestTargetDate);
    const shouldPromoteRealDemand =
      activeRealSearchCount > 0 &&
      (existing.engineeringOnly ||
        nextActiveRealSearchCount !== existing.activeRealSearchCount ||
        nextAffectedSearchCount !== existing.affectedSearchCount ||
        nextEarliestTargetDate?.getTime() !== existing.earliestTargetDate?.getTime());

    if (shouldPromoteRealDemand || materialFailureInputChanged) {
      await prisma.courseSupportIncident.updateMany({
        where: {
          id: existing.id,
          cycle: existing.cycle,
          status: existing.status,
          activeBatchId: existing.activeBatchId,
          updatedAt: existing.updatedAt
        },
        data: {
          ...(shouldPromoteRealDemand
            ? {
                affectedSearchCount: nextAffectedSearchCount,
                engineeringOnly: false,
                activeRealSearchCount: nextActiveRealSearchCount,
                earliestTargetDate: nextEarliestTargetDate,
                confirmedAt: existing.confirmedAt ?? (monitoringFailure.confirmed ? now : null),
                escalationDeadlineAt:
                  beginsFirstRealDemandEpisode
                    ? episodeEscalationDeadlineAt
                    : (existing.escalationDeadlineAt ?? episodeEscalationDeadlineAt)
              }
            : {}),
          ...(materialFailureInputChanged
            ? { occurrenceCount: { increment: 1 } }
            : {}),
          lastSeenAt: now,
          revision: { increment: 1 }
        }
      });
    }

    return {
      incidentId: existing.id,
      status: existing.status === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "AUTO_INVESTIGATING",
      ownerAlerted: Boolean(existing.ownerNotifiedAt || existing.escalationNotifiedAt)
    } satisfies CourseSupportIssueState;
  }

  const initialNextAttemptAt =
    failureClass === "RATE_LIMIT"
      ? getInitialCourseSupportAttemptAt(failure, now)
      : (monitoringFailure.nextAttemptAt ?? now);
  const confirmedAt = monitoringFailure.confirmed ? now : null;
  const escalationDeadlineAt = episodeEscalationDeadlineAt;
  let incident: CourseSupportIncident;

  if (!existing) {
    incident = await prisma.courseSupportIncident.create({
      data: {
        reference: createIncidentReference(),
        courseId: input.course.id,
        firstAffectedSearchId: input.searchId,
        kind: input.kind,
        providerFamilyKey: provider.providerFamilyKey,
        failureClass,
        failureFingerprint,
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        initialMessage: safeMessage,
        latestMessage: safeMessage,
        nextAction: safeNextAction,
        affectedSearchCount: Math.max(affectedSearchCount, 1),
        engineeringOnly: engineeringOnlySource && activeRealSearchCount === 0,
        nextAttemptAt: initialNextAttemptAt,
        confirmedAt,
        escalationDeadlineAt,
        activeRealSearchCount,
        earliestTargetDate,
        firstSeenAt: now,
        lastSeenAt: now
      }
    });
  } else if (existing.status === "RESOLVED") {
    const reopened = await prisma.courseSupportIncident.updateMany({
      where: {
        id: existing.id,
        cycle: existing.cycle,
        revision: existing.revision,
        status: "RESOLVED",
        resolution: existing.resolution,
        activeBatchId: null
      },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        kind: input.kind,
        providerFamilyKey: provider.providerFamilyKey,
        failureClass,
        failureFingerprint,
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        firstAffectedSearchId: input.searchId,
        initialMessage: safeMessage,
        latestMessage: safeMessage,
        nextAction: safeNextAction,
        affectedSearchCount: Math.max(affectedSearchCount, 1),
        occurrenceCount: 1,
        engineeringOnly: engineeringOnlySource && activeRealSearchCount === 0,
        nextAttemptAt: initialNextAttemptAt,
        lastAttemptAt: null,
        attemptCount: 0,
        activeRealSearchCount,
        earliestTargetDate,
        activeBatchId: null,
        firstSeenAt: now,
        lastSeenAt: now,
        ownerNotifiedAt: null,
        escalatedAt: null,
        escalationNotifiedAt: null,
        resolvedAt: null,
        resolution: null,
        resolutionMessage: null,
        resolutionNotifiedAt: null,
        confirmedAt,
        escalationDeadlineAt,
        humanReviewReason: null,
        nextReminderAt: null,
        decisionActorId: null,
        decisionAt: null,
        decisionNote: null,
        decisionEvidenceUrl: null,
        decisionIdempotencyKey: null,
        revision: { increment: 1 }
      }
    });
    const current = await prisma.courseSupportIncident.findUnique({
      where: { id: existing.id }
    });
    if (reopened.count !== 1 || !current) {
      return {
        incidentId: current?.id ?? null,
        status:
          current?.status === "NEEDS_HUMAN"
            ? "NEEDS_HUMAN"
            : current?.status === "AUTO_INVESTIGATING"
              ? "AUTO_INVESTIGATING"
              : "UNRECORDED",
        ownerAlerted: Boolean(current?.ownerNotifiedAt || current?.escalationNotifiedAt)
      } satisfies CourseSupportIssueState;
    }
    incident = current;
  } else {
    const promotedToRealDemand = existing.engineeringOnly && activeRealSearchCount > 0;
    const promotedNextAttemptAt =
      failureClass === "RATE_LIMIT"
        ? new Date(Math.max(existing.nextAttemptAt?.getTime() ?? 0, initialNextAttemptAt.getTime()))
        : now;
    const incidentUpdateData = {
      ...(materialFailureInputChanged
        ? {
            cycle: { increment: 1 },
            status: "AUTO_INVESTIGATING" as const,
            firstAffectedSearchId: input.searchId,
            initialMessage: safeMessage,
            courseNameSnapshot: input.course.name,
            platformSnapshot: input.course.detectedPlatform,
            bookingUrlSnapshot: bookingUrl,
            firstSeenAt: now,
            lastAttemptAt: null,
            attemptCount: 0,
            activeBatchId: null,
            ownerNotifiedAt: null,
            escalatedAt: null,
            escalationNotifiedAt: null,
            humanReviewReason: null,
            nextReminderAt: null,
            decisionActorId: null,
            decisionAt: null,
            decisionNote: null,
            decisionEvidenceUrl: null,
            decisionIdempotencyKey: null
          }
        : {}),
      kind: input.kind,
      providerFamilyKey: provider.providerFamilyKey,
      failureClass,
      failureFingerprint,
      latestMessage: safeMessage,
      nextAction: safeNextAction,
      affectedSearchCount: Math.max(existing.affectedSearchCount, affectedSearchCount, 1),
      occurrenceCount: { increment: 1 },
      engineeringOnly:
        existing.engineeringOnly && engineeringOnlySource && activeRealSearchCount === 0,
      nextAttemptAt: materialFailureInputChanged
        ? initialNextAttemptAt
        : promotedToRealDemand
          ? promotedNextAttemptAt
          : (existing.nextAttemptAt ?? initialNextAttemptAt),
      activeRealSearchCount,
      earliestTargetDate,
      lastSeenAt: now,
      confirmedAt: materialFailureInputChanged
        ? confirmedAt
        : (existing.confirmedAt ?? confirmedAt),
      escalationDeadlineAt: materialFailureInputChanged
        ? escalationDeadlineAt
        : beginsFirstRealDemandEpisode
          ? escalationDeadlineAt
          : (existing.escalationDeadlineAt ?? escalationDeadlineAt),
      revision: { increment: 1 }
    };

    if (materialFailureInputChanged) {
      const reopen = await prisma.courseSupportIncident.updateMany({
        where: {
          id: existing.id,
          cycle: existing.cycle,
          revision: existing.revision,
          status: existing.status,
          activeBatchId: null
        },
        data: incidentUpdateData
      });

      if (reopen.count === 0) {
        const winner = await prisma.courseSupportIncident.findUnique({
          where: { id: existing.id }
        });
        return {
          incidentId: winner?.id ?? null,
          status:
            winner?.status === "NEEDS_HUMAN"
              ? "NEEDS_HUMAN"
              : winner && winner.status !== "RESOLVED"
                ? "AUTO_INVESTIGATING"
                : "UNRECORDED",
          ownerAlerted: Boolean(winner?.ownerNotifiedAt || winner?.escalationNotifiedAt)
        } satisfies CourseSupportIssueState;
      }

      return {
        incidentId: existing.id,
        status: "AUTO_INVESTIGATING",
        ownerAlerted: false
      } satisfies CourseSupportIssueState;
    }

    incident = await prisma.courseSupportIncident.update({
      where: { id: existing.id },
      data: incidentUpdateData
    });
  }

  return {
    incidentId: incident.id,
    status: incident.status === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "AUTO_INVESTIGATING",
    ownerAlerted: Boolean(incident.ownerNotifiedAt || incident.escalationNotifiedAt)
  } satisfies CourseSupportIssueState;
}

function getInitialCourseSupportAttemptAt(
  failure: ReturnType<typeof classifyProviderFailure>,
  now: Date
) {
  if (failure.failureClass !== "RATE_LIMIT") {
    return now;
  }
  const retrySeconds =
    failure.retryAfterSeconds !== null && failure.retryAfterSeconds > 0
      ? Math.min(24 * 60 * 60, Math.max(60, failure.retryAfterSeconds))
      : 15 * 60;
  return new Date(now.getTime() + retrySeconds * 1000);
}

async function resolveCourseSupportIncidentWithLease(input: {
  courseId: string;
  resolution: CourseSupportResolution;
  message: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const existing = await prisma.courseSupportIncident.findUnique({
    where: { courseId: input.courseId }
  });

  if (!existing || existing.activeBatchId) {
    return null;
  }

  if (
    existing.status !== "RESOLVED" ||
    canUpgradeResolvedCourseSupportIncident(
      existing.resolution,
      input.resolution
    )
  ) {
    const updated = await prisma.courseSupportIncident.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        activeBatchId: null,
        revision: existing.revision,
        ...(existing.status === "RESOLVED"
          ? { resolution: existing.resolution }
          : {})
      },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: input.resolution,
        resolutionMessage: sanitizeResponderText(input.message).slice(0, 500),
        nextAction: null,
        lastSeenAt: now,
        nextAttemptAt: null,
        activeBatchId: null,
        nextReminderAt: null,
        revision: { increment: 1 }
      }
    });
    if (updated.count !== 1) {
      return prisma.courseSupportIncident.findUnique({
        where: { id: existing.id }
      });
    }
    const resolved = await prisma.courseSupportIncident.findUnique({
      where: { id: existing.id }
    });
    if (!resolved) {
      return null;
    }
    return resolved;
  }
  return existing;
}
