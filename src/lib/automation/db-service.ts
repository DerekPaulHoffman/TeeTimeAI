import { Prisma } from "@prisma/client";

import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import { prisma } from "@/lib/prisma";
import { zonedDateTimeToDate } from "@/lib/timezones";

import type { BrowserDiscovery } from "./browser-discovery";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "./browser-discovery";
import { startOfUtcCalendarDay } from "./date-boundary";
import {
  hasCompletePreEditProvenance,
  HOURLY_IMPROVEMENT_AUTOMATION_ID,
  markImprovementOutcomeRecorded,
  type HourlyImprovementRunRecord
} from "./improvement";
import { withPostgresAdvisoryLease, withPostgresAdvisoryTextLease } from "./lease";

const AUTOMATION_POLL_LEASE_KEY = 917300120260709n;
const REOPEN_ALERT_MINIMUM_ABSENCE_MS = 30 * 60 * 1000;

const activeSearchInclude = {
  user: true,
  preferences: {
    orderBy: { rank: "asc" },
    include: { course: true }
  },
  matches: true
} satisfies Prisma.TeeSearchInclude;

export type ActiveAutomationSearch = Prisma.TeeSearchGetPayload<{
  include: typeof activeSearchInclude;
}>;

const pendingAlertInclude = {
  course: true,
  teeSearch: {
    include: {
      user: true
    }
  }
} satisfies Prisma.TeeTimeMatchInclude;

export type PendingAlertMatch = Prisma.TeeTimeMatchGetPayload<{
  include: typeof pendingAlertInclude;
}>;

export type BrowserProbeTarget = {
  searchId: string;
  date: Date;
  startTime: string;
  endTime: string;
  players: number;
  rank: number;
  course: {
    id: string;
    name: string;
    website: string | null;
    detectedBookingUrl: string | null;
    detectedPlatform: string;
    automationEligibility: string;
    bookingMetadata: unknown;
  };
  probeUrl: string;
};

export function runWithAutomationPollLease<T>(worker: () => Promise<T>) {
  return withPostgresAdvisoryLease(prisma, AUTOMATION_POLL_LEASE_KEY, worker);
}

export function runWithSearchCheckLease<T>(searchId: string, worker: () => Promise<T>) {
  return withPostgresAdvisoryTextLease(prisma, `tee-search:${searchId}`, worker);
}

export function runWithHourlyImprovementLease<T>(worker: () => Promise<T>) {
  return withPostgresAdvisoryTextLease(
    prisma,
    "tee-time-spot:hourly-improvement",
    worker
  );
}

export async function listActiveSearchesForAutomation(): Promise<ActiveAutomationSearch[]> {
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: {
        gte: startOfUtcCalendarDay()
      },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }]
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: activeSearchInclude
  });
}

export async function getActiveSearchForAutomation(
  searchId: string
): Promise<ActiveAutomationSearch | null> {
  return prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      status: "ACTIVE",
      date: {
        gte: startOfUtcCalendarDay()
      }
    },
    include: activeSearchInclude
  });
}

export async function listBrowserProbeTargets(limit = 5): Promise<BrowserProbeTarget[]> {
  const [searches, openIncidents] = await Promise.all([
    prisma.teeSearch.findMany({
      where: {
        status: "ACTIVE",
        date: {
          gte: startOfUtcCalendarDay()
        }
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: {
        preferences: {
          orderBy: { rank: "asc" },
          include: { course: true }
        }
      }
    }),
    prisma.courseSupportIncident.findMany({
      where: { status: { not: "RESOLVED" } },
      select: { courseId: true, status: true }
    })
  ]);
  const incidentPriority = new Map(
    openIncidents.map((incident) => [
      incident.courseId,
      incident.status === "NEEDS_HUMAN" ? 0 : 1
    ])
  );

  const targets: Array<BrowserProbeTarget & { supportPriority: number }> = [];
  const queuedCourseIds = new Set<string>();

  for (const search of searches) {
    for (const preference of search.preferences) {
      const course = preference.course;
      const probeUrl = getBestProbeUrl(course);

      if (!probeUrl || queuedCourseIds.has(course.id) || !shouldQueueBrowserProbe(course)) {
        continue;
      }

      targets.push({
        searchId: search.id,
        date: search.date,
        startTime: search.startTime,
        endTime: search.endTime,
        players: search.players,
        rank: preference.rank,
        course: {
          id: course.id,
          name: course.name,
          website: course.website,
          detectedBookingUrl: course.detectedBookingUrl,
          detectedPlatform: course.detectedPlatform,
          automationEligibility: course.automationEligibility,
          bookingMetadata: course.bookingMetadata
        },
        probeUrl,
        supportPriority: incidentPriority.get(course.id) ?? 2
      });
      queuedCourseIds.add(course.id);
    }
  }

  return targets
    .sort((left, right) => left.supportPriority - right.supportPriority || left.rank - right.rank)
    .slice(0, limit)
    .map((target) => ({
      searchId: target.searchId,
      date: target.date,
      startTime: target.startTime,
      endTime: target.endTime,
      players: target.players,
      rank: target.rank,
      course: target.course,
      probeUrl: target.probeUrl
    }));
}

export async function listPendingMatchAlerts(searchId?: string): Promise<PendingAlertMatch[]> {
  return prisma.teeTimeMatch.findMany({
    where: {
      alertStatus: "PENDING",
      availabilityStatus: "AVAILABLE",
      teeSearch: {
        status: "ACTIVE",
        ...(searchId ? { id: searchId } : {})
      }
    },
    orderBy: {
      firstSeenAt: "asc"
    },
    include: pendingAlertInclude
  });
}

type CourseProbeInput = {
  searchId: string;
  courseId: string;
  outcome:
    | "MATCH_FOUND"
    | "NO_MATCH"
    | "BLOCKED_POLICY"
    | "BLOCKED_AUTH"
    | "BLOCKED_TOOLING"
    | "FETCH_FAILED"
    | "NEEDS_ADAPTER";
  message?: string;
  evidenceUrl?: string;
  rawSummary?: Prisma.InputJsonValue;
  automationRunId?: string;
};

export async function recordCourseProbe(input: CourseProbeInput) {
  return prisma.courseProbe.create({
    data: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      outcome: input.outcome,
      message: input.message,
      evidenceUrl: input.evidenceUrl,
      rawSummary: input.rawSummary,
      automationRunId: input.automationRunId
    }
  });
}

export async function recordBrowserDiscovery(input: BrowserDiscovery) {
  const learnedOnline = input.status === "LEARNED" && Boolean(input.apiMetadata);
  return prisma.courseAutomationDiscovery.create({
    data: {
      courseId: input.courseId,
      status: input.status,
      detectedPlatform: input.detectedPlatform,
      bookingMethod:
        input.bookingMethod ?? (learnedOnline && input.bookingUrl ? "PUBLIC_ONLINE" : "UNKNOWN"),
      bookingPhone: input.bookingPhone,
      automationEligibility:
        input.automationEligibility ?? (learnedOnline ? "ALLOWED" : "UNKNOWN"),
      automationReason: input.automationReason ?? "NONE",
      sourceUrl: input.sourceUrl,
      bookingUrl: input.bookingUrl,
      apiEndpoint: input.apiEndpoint,
      apiMetadata: input.apiMetadata as Prisma.InputJsonValue | undefined,
      confidence: input.confidence,
      evidence: input.evidence as Prisma.InputJsonValue
    }
  });
}

export async function applyBrowserDiscoveryToCourse(input: BrowserDiscovery) {
  const learnedOnlineAdapter =
    input.status === "LEARNED" &&
    Boolean(input.apiMetadata) &&
    ["FOREUP", "TEEITUP", "CHRONOGOLF", "CUSTOM"].includes(input.detectedPlatform);
  const verifiedClassification = Boolean(
    input.bookingMethod &&
    input.bookingMethod !== "UNKNOWN" &&
    input.automationEligibility &&
    input.automationEligibility !== "UNKNOWN" &&
    input.confidence >= 0.8
  );

  if (!learnedOnlineAdapter && !verifiedClassification) {
    return null;
  }

  const bookingMethod = input.bookingMethod ?? "PUBLIC_ONLINE";
  const automationEligibility = input.automationEligibility ?? "ALLOWED";
  const manualOnly =
    automationEligibility === "BLOCKED" &&
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(bookingMethod);

  return prisma.course.update({
    where: { id: input.courseId },
    data: {
      detectedPlatform: input.detectedPlatform,
      automationEligibility,
      detectedBookingUrl: manualOnly ? null : input.bookingUrl,
      bookingMetadata: manualOnly
        ? Prisma.DbNull
        : (input.apiMetadata as Prisma.InputJsonValue),
      bookingMethod,
      bookingPhone: input.bookingPhone,
      automationReason: input.automationReason ?? "NONE",
      policyNotes: input.policyNotes,
      intelligenceVerifiedAt: new Date(),
      intelligenceReviewAt: input.intelligenceReviewAt
        ? new Date(input.intelligenceReviewAt)
        : null,
      intelligenceConfidence: input.confidence
    }
  });
}

export async function recordTeeTimeMatch(input: {
  searchId: string;
  courseId: string;
  sourceId: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  priceCents?: number;
  holes?: number;
  evidenceUrl?: string;
}) {
  const existing = await prisma.teeTimeMatch.findUnique({
    where: {
      teeSearchId_courseId_sourceId_startsAt: {
        teeSearchId: input.searchId,
        courseId: input.courseId,
        sourceId: input.sourceId,
        startsAt: input.startsAt
      }
    },
    select: {
      availabilityStatus: true,
      unavailableAt: true
    }
  });

  const confirmedAt = new Date();
  const shouldAlertReopenedMatch = Boolean(
    existing?.availabilityStatus === "GONE" &&
      (!existing.unavailableAt ||
        confirmedAt.getTime() - existing.unavailableAt.getTime() >=
          REOPEN_ALERT_MINIMUM_ABSENCE_MS)
  );
  return prisma.teeTimeMatch.upsert({
    where: {
      teeSearchId_courseId_sourceId_startsAt: {
        teeSearchId: input.searchId,
        courseId: input.courseId,
        sourceId: input.sourceId,
        startsAt: input.startsAt
      }
    },
    update: {
      lastSeenAt: confirmedAt,
      lastConfirmedAt: confirmedAt,
      availabilityStatus: "AVAILABLE",
      unavailableAt: null,
      ...(shouldAlertReopenedMatch
        ? { alertStatus: "PENDING", sentAt: null }
        : {}),
      availableSpots: input.availableSpots,
      bookingUrl: input.bookingUrl,
      priceCents: input.priceCents,
      holes: input.holes,
      evidenceUrl: input.evidenceUrl
    },
    create: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      sourceId: input.sourceId,
      startsAt: input.startsAt,
      availableSpots: input.availableSpots,
      bookingUrl: input.bookingUrl,
      priceCents: input.priceCents,
      holes: input.holes,
      evidenceUrl: input.evidenceUrl
    }
  });
}

export async function markMissingMatchesUnavailable(input: {
  searchId: string;
  courseId: string;
  date: string;
  timeZone: string;
  confirmedMatches: Array<{ sourceId: string; startsAt: Date }>;
}) {
  const dayStart = zonedDateTimeToDate(`${input.date}T00:00:00`, input.timeZone);
  const dayEnd = zonedDateTimeToDate(`${addIsoDateDays(input.date, 1)}T00:00:00`, input.timeZone);

  const missingMatchWhere: Prisma.TeeTimeMatchWhereInput = {
    teeSearchId: input.searchId,
    courseId: input.courseId,
    availabilityStatus: "AVAILABLE" as const,
    startsAt: {
      gte: dayStart,
      lt: dayEnd
    },
    ...(input.confirmedMatches.length > 0
      ? {
          NOT: input.confirmedMatches.map((match) => ({
            sourceId: match.sourceId,
            startsAt: match.startsAt
          }))
        }
      : {})
  };
  const unavailableAt = new Date();

  return prisma.$transaction([
    prisma.teeTimeMatch.updateMany({
      where: {
        ...missingMatchWhere,
        alertStatus: "PENDING"
      },
      data: {
        alertStatus: "SUPPRESSED",
        availabilityStatus: "GONE",
        sentAt: unavailableAt,
        unavailableAt
      }
    }),
    prisma.teeTimeMatch.updateMany({
      where: {
        ...missingMatchWhere,
        alertStatus: { not: "PENDING" }
      },
      data: {
        availabilityStatus: "GONE",
        unavailableAt
      }
    })
  ]);
}

function addIsoDateDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export async function queueSearchCheck(searchId: string) {
  return prisma.teeSearch.update({
    where: { id: searchId },
    data: {
      scheduleVersion: { increment: 1 },
      checkStatus: "QUEUED",
      nextCheckAt: new Date(),
      lastCheckOutcome: null
    },
    select: {
      id: true,
      status: true,
      scheduleVersion: true,
      workflowRunId: true,
      checkStatus: true,
      updatedAt: true
    }
  });
}

export async function getSearchCheckRequestState(searchId: string) {
  return prisma.teeSearch.findUnique({
    where: { id: searchId },
    select: {
      id: true,
      status: true,
      checkStatus: true,
      workflowRunId: true,
      lastCheckedAt: true,
      nextCheckAt: true
    }
  });
}

export async function attachSearchWorkflowRun(
  searchId: string,
  scheduleVersion: number,
  workflowRunId: string
) {
  return prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion
    },
    data: {
      workflowRunId
    }
  });
}

export async function claimScheduledSearchCheck(searchId: string, scheduleVersion: number) {
  const result = await prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE"
    },
    data: {
      checkStatus: "CHECKING",
      nextCheckAt: null
    }
  });

  return result.count === 1;
}

export async function completeScheduledSearchCheck(input: {
  searchId: string;
  scheduleVersion: number;
  outcome: string;
  nextCheckAt: Date | null;
  completeSearch?: boolean;
}) {
  return prisma.teeSearch.updateMany({
    where: {
      id: input.searchId,
      scheduleVersion: input.scheduleVersion
    },
    data: {
      ...(input.completeSearch ? { status: "COMPLETED" as const } : {}),
      checkStatus: input.nextCheckAt ? "WAITING" : "STOPPED",
      lastCheckedAt: new Date(),
      lastCheckOutcome: input.outcome,
      nextCheckAt: input.nextCheckAt
    }
  });
}

export async function failScheduledSearchCheck(input: {
  searchId: string;
  scheduleVersion: number;
  message: string;
  nextCheckAt: Date;
}) {
  return prisma.teeSearch.updateMany({
    where: {
      id: input.searchId,
      scheduleVersion: input.scheduleVersion
    },
    data: {
      checkStatus: "FAILED",
      lastCheckedAt: new Date(),
      lastCheckOutcome: input.message,
      nextCheckAt: input.nextCheckAt
    }
  });
}

export async function stopSearchSchedule(searchId: string) {
  return prisma.teeSearch.update({
    where: { id: searchId },
    data: {
      scheduleVersion: { increment: 1 },
      checkStatus: "STOPPED",
      nextCheckAt: null,
      workflowRunId: null
    }
  });
}

export async function getSearchScheduleState(searchId: string, scheduleVersion: number) {
  return prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE"
    },
    select: {
      id: true,
      scheduleVersion: true,
      status: true,
      nextCheckAt: true
    }
  });
}

export async function getSearchScheduleTiming(searchId: string, scheduleVersion: number) {
  return prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE"
    },
    select: {
      id: true,
      date: true,
      endTime: true,
      userTimeZone: true,
      cadenceMinutes: true,
      scheduleVersion: true,
      preferences: {
        select: {
          course: {
            select: {
              timeZone: true,
              bookingWindowDaysAhead: true,
              bookingReleaseTimeLocal: true,
              bookingWindowSource: true,
              bookingWindowConfidence: true,
              bookingWindowEvidenceUrl: true,
              bookingWindowCheckedAt: true,
              bookingWindowObservedAt: true
            }
          }
        }
      }
    }
  });
}

export async function listSearchesNeedingScheduleRecovery() {
  const overdueBefore = new Date(Date.now() - 10 * 60 * 1000);
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: { gte: startOfUtcCalendarDay() },
      OR: [
        { checkStatus: "IDLE" },
        { checkStatus: "FAILED", nextCheckAt: { lte: new Date() } },
        { checkStatus: "WAITING", nextCheckAt: { lte: overdueBefore } }
      ]
    },
    select: { id: true },
    take: 25
  });
}

export async function markMatchAlertSent(matchId: string) {
  return prisma.teeTimeMatch.update({
    where: { id: matchId },
    data: {
      alertStatus: "SENT",
      sentAt: new Date()
    }
  });
}

export async function markMatchAlertSuppressed(matchId: string) {
  return prisma.teeTimeMatch.update({
    where: { id: matchId },
    data: {
      alertStatus: "SUPPRESSED",
      sentAt: new Date()
    }
  });
}

export async function markSearchStatusEmailSent(input: {
  searchId: string;
  sentAt: Date;
  snapshot: Prisma.InputJsonValue;
}) {
  return prisma.teeSearch.update({
    where: { id: input.searchId },
    data: {
      statusEmailSentAt: input.sentAt,
      statusEmailSnapshot: input.snapshot
    }
  });
}

export async function recordCourseProbeIfChanged(input: CourseProbeInput) {
  const latest = await prisma.courseProbe.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId
    },
    orderBy: { observedAt: "desc" }
  });

  if (latest?.outcome === input.outcome && latest.message === (input.message ?? null)) {
    return latest;
  }

  return recordCourseProbe(input);
}

export async function listAvailableMatchAlerts(searchId: string): Promise<PendingAlertMatch[]> {
  return prisma.teeTimeMatch.findMany({
    where: {
      teeSearchId: searchId,
      availabilityStatus: "AVAILABLE",
      teeSearch: {
        status: "ACTIVE"
      }
    },
    orderBy: [{ course: { name: "asc" } }, { startsAt: "asc" }],
    include: pendingAlertInclude
  });
}

export async function startAutomationRun(promptVersion: string) {
  return prisma.automationRun.create({
    data: { promptVersion }
  });
}

export async function listRecentCourseAutomationDiscoveries(
  courseIds: string[],
  since: Date
) {
  if (courseIds.length === 0) {
    return [];
  }

  return prisma.courseAutomationDiscovery.findMany({
    where: {
      courseId: { in: courseIds },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    select: { courseId: true, createdAt: true }
  });
}

export async function recordCourseBookingWindowEvidence(input: {
  courseId: string;
  evidence: BookingWindowEvidence;
  observedAt?: Date;
}) {
  const observedAt = input.observedAt ?? new Date();
  return prisma.course.update({
    where: { id: input.courseId },
    data: {
      bookingWindowDaysAhead: input.evidence.daysAhead,
      bookingReleaseTimeLocal: input.evidence.releaseTimeLocal,
      bookingWindowSource: input.evidence.source,
      bookingWindowConfidence: input.evidence.confidence,
      bookingWindowEvidenceUrl: input.evidence.evidenceUrl,
      bookingWindowCheckedAt: observedAt,
      bookingWindowObservedAt: observedAt
    }
  });
}

export async function markCourseBookingWindowChecked(courseId: string, checkedAt = new Date()) {
  return prisma.course.update({
    where: { id: courseId },
    data: { bookingWindowCheckedAt: checkedAt }
  });
}

export async function updateHourlyImprovementRunState(
  id: string,
  record: HourlyImprovementRunRecord
) {
  if (record.checkpoints.outcome_recorded) {
    throw new Error(
      "outcome_recorded may only become true in the atomic hourly improvement closeout"
    );
  }
  if (
    record.automationId !== HOURLY_IMPROVEMENT_AUTOMATION_ID ||
    record.owner.runId !== id ||
    record.provenance.ownerRunId !== id
  ) {
    throw new Error("Hourly improvement state does not match its durable owner run");
  }
  if (
    record.checkpoints.provenance_recorded &&
    !hasCompletePreEditProvenance(record.provenance)
  ) {
    throw new Error(
      "provenance_recorded requires owner, branch, SHA, thread, and planned-path evidence"
    );
  }

  const result = await prisma.automationRun.updateMany({
    where: {
      id,
      completedAt: null
    },
    data: {
      notes: JSON.stringify(record)
    }
  });

  return result.count === 1;
}

export async function closeHourlyImprovementRun(
  id: string,
  input: {
    outcome: string;
    record: HourlyImprovementRunRecord;
    errors?: Prisma.InputJsonValue;
    changedFiles?: Prisma.InputJsonValue;
  }
) {
  if (
    input.record.automationId !== HOURLY_IMPROVEMENT_AUTOMATION_ID ||
    input.record.owner.runId !== id ||
    input.record.provenance.ownerRunId !== id
  ) {
    throw new Error("Hourly improvement closeout does not match its durable owner run");
  }
  const closeoutRecord: HourlyImprovementRunRecord = {
    ...input.record,
    lifecycle: input.record.blocker ? "blocked" : "closeout",
    checkpoints: markImprovementOutcomeRecorded(input.record.checkpoints)
  };
  const result = await prisma.automationRun.updateMany({
    where: {
      id,
      completedAt: null
    },
    data: {
      completedAt: new Date(),
      outcome: input.outcome,
      errors: input.errors,
      changedFiles: input.changedFiles,
      notes: JSON.stringify(closeoutRecord)
    }
  });

  return result.count === 1;
}

export async function finishAutomationRun(
  id: string,
  input: {
    outcome: string;
    errors?: Prisma.InputJsonValue;
    changedFiles?: Prisma.InputJsonValue;
    notes?: string;
  }
) {
  return prisma.automationRun.update({
    where: { id },
    data: {
      completedAt: new Date(),
      outcome: input.outcome,
      errors: input.errors,
      changedFiles: input.changedFiles,
      notes: input.notes
    }
  });
}
