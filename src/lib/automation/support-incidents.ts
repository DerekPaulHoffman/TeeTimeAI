import type {
  CourseSupportIncident,
  CourseSupportIncidentKind,
  CourseSupportResolution,
  DetectedPlatform
} from "@prisma/client";

import { sendCourseSupportOperatorEmail } from "@/lib/email/alerts";
import { prisma } from "@/lib/prisma";

import { withPostgresAdvisoryTextLease } from "./lease";

const HUMAN_ESCALATION_AFTER_MS = 30 * 60 * 1000;

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

async function reportCourseSupportIssueWithLease(input: CourseSupportIssueInput) {
  const now = input.now ?? new Date();
  const affectedSearchCount = await prisma.teeSearch.count({
    where: {
      status: "ACTIVE",
      preferences: {
        some: { courseId: input.course.id }
      }
    }
  });
  const existing = await prisma.courseSupportIncident.findUnique({
    where: { courseId: input.course.id }
  });
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

  incident = await notifyIncidentEvent(incident, "opened", now);

  if (
    incident.status === "AUTO_INVESTIGATING" &&
    shouldEscalateCourseSupportIncident(incident.firstSeenAt, now)
  ) {
    incident = await prisma.courseSupportIncident.update({
      where: { id: incident.id },
      data: {
        status: "NEEDS_HUMAN",
        escalatedAt: incident.escalatedAt ?? now
      }
    });
  }

  if (incident.status === "NEEDS_HUMAN") {
    incident = await notifyIncidentEvent(incident, "escalated", now);
  }

  return {
    incidentId: incident.id,
    status: incident.status === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "AUTO_INVESTIGATING",
    ownerAlerted: Boolean(incident.ownerNotifiedAt || incident.escalationNotifiedAt)
  } satisfies CourseSupportIssueState;
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

export function shouldEscalateCourseSupportIncident(firstSeenAt: Date, now = new Date()) {
  return now.getTime() - firstSeenAt.getTime() >= HUMAN_ESCALATION_AFTER_MS;
}
