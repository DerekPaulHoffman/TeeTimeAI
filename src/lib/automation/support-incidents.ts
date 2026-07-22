import type {
  CourseSupportIncident,
  CourseSupportIncidentKind,
  CourseSupportResolution,
  DetectedPlatform
} from "@prisma/client";

import {
  sendCourseSupportOperatorEmail,
  sendCourseSupportOperatorSummaryEmail
} from "@/lib/email/alerts";
import {
  isSyntheticWebsiteTrafficClass,
  syntheticWebsiteTrafficClasses
} from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { getCourseLocalDateStorageBoundary } from "./date-boundary";
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
  now?: Date;
};

export type CourseSupportIssueState = {
  incidentId: string | null;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "UNRECORDED";
  ownerAlerted: boolean;
};

export type CourseSupportBatchNotificationState = {
  notifiedIncidentIds: string[];
  pendingIncidentIds: string[];
};

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
    : { incidentId: null, status: "UNRECORDED", ownerAlerted: false };
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
      ownerNotifiedAt: true,
      escalationNotifiedAt: true,
      resolutionNotifiedAt: true
    }
  });
  if (
    !current ||
    current.activeBatchId ||
    (current.status === "RESOLVED" &&
      (Boolean(current.resolutionNotifiedAt) ||
        (!current.ownerNotifiedAt && !current.escalationNotifiedAt)))
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

export async function notifyCourseSupportIssueBatch(
  incidentIds: string[],
  now = new Date()
): Promise<CourseSupportBatchNotificationState> {
  const uniqueIncidentIds = [...new Set(incidentIds.filter(Boolean))];
  if (uniqueIncidentIds.length === 0) {
    return { notifiedIncidentIds: [], pendingIncidentIds: [] };
  }

  const lease = await withPostgresAdvisoryTextLease(
    prisma,
    "course-support:operator-summary",
    () => notifyCourseSupportIssueBatchWithLease(uniqueIncidentIds, now)
  );
  return lease.acquired
    ? lease.value
    : { notifiedIncidentIds: [], pendingIncidentIds: uniqueIncidentIds };
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
  if (!current || current.status === "RESOLVED" || current.engineeringOnly) {
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
          latestMessage: input.message,
          nextAction: input.nextAction,
          escalatedAt: latest.escalatedAt ?? now,
          lastSeenAt: now
        }
      });
    }
  );
  if (!lease.acquired || !lease.value || lease.value.status === "RESOLVED") {
    return lease.acquired ? lease.value : null;
  }

  await notifyCourseSupportIssueBatch([lease.value.id], now);
  return lease.value;
}

async function reportCourseSupportIssueWithLease(input: CourseSupportIssueInput) {
  const now = input.now ?? new Date();
  const dateBoundary = getCourseLocalDateStorageBoundary(
    input.course.timeZone,
    now
  );
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
  const failureFingerprint = buildProviderFailureFingerprint({
    providerFamilyKey: provider.providerFamilyKey,
    failureClass: failure.failureClass,
    operation: input.kind === "NEEDS_ADAPTER" ? "METADATA" : "AVAILABILITY",
    httpStatus: failure.httpStatus
  });

  if (disposableSyntheticSearch) {
    if (
      existing &&
      !existing.activeBatchId &&
      !existing.engineeringOnly &&
      existing.status !== "RESOLVED" &&
      affectedSearchCount === 0 &&
      !existing.ownerNotifiedAt &&
      !existing.escalationNotifiedAt
    ) {
      await prisma.courseSupportIncident.update({
        where: { id: existing.id },
        data: {
          status: "RESOLVED",
          resolvedAt: now,
          resolution: null,
          resolutionMessage:
            "Closed because this course has only synthetic test demand.",
          nextAction: null,
          lastSeenAt: now
        }
      });
    }

    return {
      incidentId: null,
      status: "UNRECORDED",
      ownerAlerted: false
    } satisfies CourseSupportIssueState;
  }

  if (
    existing?.status === "RESOLVED" &&
    existing.resolution === "SOURCE_UNVERIFIED" &&
    engineeringOnlySource &&
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

  if (existing?.activeBatchId && existing.status !== "RESOLVED") {
    const nextActiveRealSearchCount = Math.max(
      existing.activeRealSearchCount,
      activeRealSearchCount
    );
    const nextAffectedSearchCount = Math.max(
      existing.affectedSearchCount,
      affectedSearchCount,
      1
    );
    const nextEarliestTargetDate =
      existing.earliestTargetDate && earliestTargetDate
        ? new Date(
            Math.min(
              existing.earliestTargetDate.getTime(),
              earliestTargetDate.getTime()
            )
          )
        : (existing.earliestTargetDate ?? earliestTargetDate);
    const shouldPromoteRealDemand =
      activeRealSearchCount > 0 &&
      (existing.engineeringOnly ||
        nextActiveRealSearchCount !== existing.activeRealSearchCount ||
        nextAffectedSearchCount !== existing.affectedSearchCount ||
        nextEarliestTargetDate?.getTime() !==
          existing.earliestTargetDate?.getTime());

    if (shouldPromoteRealDemand) {
      await prisma.courseSupportIncident.updateMany({
        where: {
          id: existing.id,
          cycle: existing.cycle,
          status: existing.status,
          activeBatchId: existing.activeBatchId,
          updatedAt: existing.updatedAt
        },
        data: {
          affectedSearchCount: nextAffectedSearchCount,
          engineeringOnly: false,
          activeRealSearchCount: nextActiveRealSearchCount,
          earliestTargetDate: nextEarliestTargetDate,
          lastSeenAt: now
        }
      });
    }

    return {
      incidentId: existing.id,
      status:
        existing.status === "NEEDS_HUMAN"
          ? "NEEDS_HUMAN"
          : "AUTO_INVESTIGATING",
      ownerAlerted: Boolean(
        existing.ownerNotifiedAt || existing.escalationNotifiedAt
      )
    } satisfies CourseSupportIssueState;
  }

  const initialNextAttemptAt = getInitialCourseSupportAttemptAt(failure, now);
  let incident: CourseSupportIncident;

  if (!existing) {
    incident = await prisma.courseSupportIncident.create({
      data: {
        courseId: input.course.id,
        firstAffectedSearchId: input.searchId,
        kind: input.kind,
        providerFamilyKey: provider.providerFamilyKey,
        failureClass: failure.failureClass,
        failureFingerprint,
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        initialMessage: input.message,
        latestMessage: input.message,
        nextAction: input.nextAction,
        affectedSearchCount: Math.max(affectedSearchCount, 1),
        engineeringOnly: engineeringOnlySource && activeRealSearchCount === 0,
        nextAttemptAt: initialNextAttemptAt,
        activeRealSearchCount,
        earliestTargetDate,
        firstSeenAt: now,
        lastSeenAt: now
      }
    });
  } else if (existing.status === "RESOLVED") {
    incident = await prisma.courseSupportIncident.update({
      where: { id: existing.id },
      data: {
        cycle: { increment: 1 },
        status: "AUTO_INVESTIGATING",
        kind: input.kind,
        providerFamilyKey: provider.providerFamilyKey,
        failureClass: failure.failureClass,
        failureFingerprint,
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        firstAffectedSearchId: input.searchId,
        initialMessage: input.message,
        latestMessage: input.message,
        nextAction: input.nextAction,
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
        resolutionNotifiedAt: null
      }
    });
  } else {
    const fingerprintChanged =
      existing.providerFamilyKey !== provider.providerFamilyKey ||
      existing.failureFingerprint !== failureFingerprint;
    const promotedToRealDemand =
      existing.engineeringOnly && activeRealSearchCount > 0;
    const promotedNextAttemptAt =
      failure.failureClass === "RATE_LIMIT"
        ? new Date(
            Math.max(
              existing.nextAttemptAt?.getTime() ?? 0,
              initialNextAttemptAt.getTime()
            )
          )
        : now;
    incident = await prisma.courseSupportIncident.update({
      where: { id: existing.id },
      data: {
        ...(fingerprintChanged
          ? {
              cycle: { increment: 1 },
              status: "AUTO_INVESTIGATING" as const,
              firstAffectedSearchId: input.searchId,
              initialMessage: input.message,
              firstSeenAt: now,
              lastAttemptAt: null,
              attemptCount: 0,
              activeBatchId: null,
              escalatedAt: null,
              escalationNotifiedAt: null
            }
          : {}),
        kind: input.kind,
        providerFamilyKey: provider.providerFamilyKey,
        failureClass: failure.failureClass,
        failureFingerprint,
        latestMessage: input.message,
        nextAction: input.nextAction,
        affectedSearchCount: Math.max(existing.affectedSearchCount, affectedSearchCount, 1),
        occurrenceCount: { increment: 1 },
        engineeringOnly:
          existing.engineeringOnly &&
          engineeringOnlySource &&
          activeRealSearchCount === 0,
        nextAttemptAt: fingerprintChanged
          ? initialNextAttemptAt
          : promotedToRealDemand
            ? promotedNextAttemptAt
            : (existing.nextAttemptAt ?? initialNextAttemptAt),
        activeRealSearchCount,
        earliestTargetDate,
        lastSeenAt: now
      }
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

async function notifyCourseSupportIssueBatchWithLease(
  incidentIds: string[],
  now: Date
): Promise<CourseSupportBatchNotificationState> {
  const incidents = await prisma.courseSupportIncident.findMany({
    where: {
      id: { in: incidentIds },
      status: "NEEDS_HUMAN",
      engineeringOnly: false,
      ownerNotifiedAt: null,
      escalationNotifiedAt: null
    },
    orderBy: [{ platformSnapshot: "asc" }, { courseNameSnapshot: "asc" }]
  });
  if (incidents.length === 0) {
    return { notifiedIncidentIds: [], pendingIncidentIds: [] };
  }

  try {
    const delivery = await sendCourseSupportOperatorSummaryEmail({
      incidents: incidents.map((incident) => ({
        incidentId: incident.id,
        cycle: incident.cycle,
        courseId: incident.courseId,
        courseName: incident.courseNameSnapshot,
        platform: incident.platformSnapshot,
        bookingUrl: incident.bookingUrlSnapshot,
        firstAffectedSearchId: incident.firstAffectedSearchId,
        affectedSearchCount: incident.affectedSearchCount,
        kind: incident.kind,
        message: incident.latestMessage,
        nextAction: incident.nextAction,
        firstSeenAt: incident.firstSeenAt
      }))
    });
    if (delivery.deliveryStatus !== "sent") {
      return {
        notifiedIncidentIds: [],
        pendingIncidentIds: incidents.map((incident) => incident.id)
      };
    }

    const notifiedIncidentIds = incidents.map((incident) => incident.id);
    await prisma.courseSupportIncident.updateMany({
      where: { id: { in: notifiedIncidentIds } },
      data: { escalationNotifiedAt: now }
    });
    return { notifiedIncidentIds, pendingIncidentIds: [] };
  } catch (error) {
    console.error("[email:operator-summary-failed]", {
      incidents: incidents.map((incident) => incident.id),
      message: error instanceof Error ? error.message : "Unknown operator summary failure"
    });
    return {
      notifiedIncidentIds: [],
      pendingIncidentIds: incidents.map((incident) => incident.id)
    };
  }
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

  let incident = existing;
  if (existing.status !== "RESOLVED") {
    const updated = await prisma.courseSupportIncident.updateMany({
      where: {
        id: existing.id,
        status: { not: "RESOLVED" },
        activeBatchId: null
      },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: input.resolution,
        resolutionMessage: input.message,
        lastSeenAt: now,
        nextAttemptAt: null,
        activeBatchId: null
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
    incident = resolved;
  }

  if (
    (incident.ownerNotifiedAt || incident.escalationNotifiedAt) &&
    !incident.resolutionNotifiedAt
  ) {
    incident = await notifyIncidentEvent(incident, "resolved", now);
  }

  return incident;
}

async function notifyIncidentEvent(
  incident: CourseSupportIncident,
  event: "opened" | "escalated" | "resolved",
  now: Date
) {
  const sentAtField =
    event === "opened"
      ? "ownerNotifiedAt"
      : event === "escalated"
        ? "escalationNotifiedAt"
        : "resolutionNotifiedAt";

  if (event === "opened" && incident.escalationNotifiedAt) {
    return incident;
  }

  if (incident[sentAtField]) {
    return incident;
  }

  try {
    const delivery = await sendCourseSupportOperatorEmail({
      event,
      incidentId: incident.id,
      cycle: incident.cycle,
      courseId: incident.courseId,
      courseName: incident.courseNameSnapshot,
      platform: incident.platformSnapshot,
      bookingUrl: incident.bookingUrlSnapshot,
      firstAffectedSearchId: incident.firstAffectedSearchId,
      affectedSearchCount: incident.affectedSearchCount,
      kind: incident.kind,
      message: incident.initialMessage,
      nextAction: incident.nextAction,
      firstSeenAt: incident.firstSeenAt,
      resolution: incident.resolution,
      resolutionMessage: incident.resolutionMessage
    });

    if (delivery.deliveryStatus !== "sent") {
      return incident;
    }

    return prisma.courseSupportIncident.update({
      where: { id: incident.id },
      data: { [sentAtField]: now }
    });
  } catch (error) {
    console.error("[email:operator-failed]", {
      incidentId: incident.id,
      courseId: incident.courseId,
      event,
      message: error instanceof Error ? error.message : "Unknown operator email failure"
    });
    return incident;
  }
}
