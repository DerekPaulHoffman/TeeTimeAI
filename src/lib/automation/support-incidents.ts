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

import { withPostgresAdvisoryTextLease } from "./lease";

export type CourseSupportIssueInput = {
  course: {
    id: string;
    name: string;
    detectedPlatform: DetectedPlatform;
    detectedBookingUrl: string | null;
    website: string | null;
  };
  searchId: string;
  kind: CourseSupportIncidentKind;
  message?: string;
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
    where: { courseId: input.courseId }
  });
  if (
    !current ||
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
  const [sourceSearch, affectedSearchCount, existing] = await Promise.all([
    prisma.teeSearch.findUnique({
      where: { id: input.searchId },
      select: { trafficClass: true }
    }),
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        trafficClass: { notIn: [...syntheticWebsiteTrafficClasses] },
        preferences: {
          some: { courseId: input.course.id }
        }
      }
    }),
    prisma.courseSupportIncident.findUnique({
      where: { courseId: input.course.id }
    })
  ]);

  if (sourceSearch && isSyntheticWebsiteTrafficClass(sourceSearch.trafficClass)) {
    if (
      existing &&
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

  const bookingUrl = input.course.detectedBookingUrl ?? input.course.website;
  let incident: CourseSupportIncident;

  if (!existing) {
    incident = await prisma.courseSupportIncident.create({
      data: {
        courseId: input.course.id,
        firstAffectedSearchId: input.searchId,
        kind: input.kind,
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        initialMessage: input.message,
        latestMessage: input.message,
        nextAction: input.nextAction,
        affectedSearchCount: Math.max(affectedSearchCount, 1),
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
        courseNameSnapshot: input.course.name,
        platformSnapshot: input.course.detectedPlatform,
        bookingUrlSnapshot: bookingUrl,
        firstAffectedSearchId: input.searchId,
        initialMessage: input.message,
        latestMessage: input.message,
        nextAction: input.nextAction,
        affectedSearchCount: Math.max(affectedSearchCount, 1),
        occurrenceCount: 1,
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
    incident = await prisma.courseSupportIncident.update({
      where: { id: existing.id },
      data: {
        kind: input.kind,
        latestMessage: input.message,
        nextAction: input.nextAction,
        affectedSearchCount: Math.max(existing.affectedSearchCount, affectedSearchCount, 1),
        occurrenceCount: { increment: 1 },
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

async function notifyCourseSupportIssueBatchWithLease(
  incidentIds: string[],
  now: Date
): Promise<CourseSupportBatchNotificationState> {
  const incidents = await prisma.courseSupportIncident.findMany({
    where: {
      id: { in: incidentIds },
      status: "NEEDS_HUMAN",
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

  if (!existing) {
    return null;
  }

  let incident = existing;
  if (existing.status !== "RESOLVED") {
    incident = await prisma.courseSupportIncident.update({
      where: { id: existing.id },
      data: {
        status: "RESOLVED",
        resolvedAt: now,
        resolution: input.resolution,
        resolutionMessage: input.message,
        lastSeenAt: now
      }
    });
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
