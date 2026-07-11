import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

import { zonedDateTimeToDate } from "@/lib/timezones";

import type { BrowserDiscovery } from "./browser-discovery";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "./browser-discovery";
import { withPostgresAdvisoryLease, withPostgresAdvisoryTextLease } from "./lease";

const AUTOMATION_POLL_LEASE_KEY = 917300120260709n;

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

export async function listActiveSearchesForAutomation(): Promise<ActiveAutomationSearch[]> {
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: {
        gte: startOfToday()
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
        gte: startOfToday()
      }
    },
    include: activeSearchInclude
  });
}

export async function listBrowserProbeTargets(limit = 5): Promise<BrowserProbeTarget[]> {
  const searches = await prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: {
        gte: startOfToday()
      }
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: {
      preferences: {
        orderBy: { rank: "asc" },
        include: { course: true }
      }
    }
  });

  const targets: BrowserProbeTarget[] = [];
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
        probeUrl
      });
      queuedCourseIds.add(course.id);

      if (targets.length >= limit) {
        return targets;
      }
    }
  }

  return targets;
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

export async function recordCourseProbe(input: {
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
}) {
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
  return prisma.courseAutomationDiscovery.create({
    data: {
      courseId: input.courseId,
      status: input.status,
      detectedPlatform: input.detectedPlatform,
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
  if (input.status !== "LEARNED" || !input.apiMetadata) {
    return null;
  }

  if (
    input.detectedPlatform !== "FOREUP" &&
    input.detectedPlatform !== "TEEITUP" &&
    input.detectedPlatform !== "CUSTOM"
  ) {
    return null;
  }

  return prisma.course.update({
    where: { id: input.courseId },
    data: {
      detectedPlatform: input.detectedPlatform,
      automationEligibility: "ALLOWED",
      detectedBookingUrl: input.bookingUrl,
      bookingMetadata: input.apiMetadata
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
      availabilityStatus: true
    }
  });

  const confirmedAt = new Date();
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
      ...(existing?.availabilityStatus === "GONE"
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
}) {
  return prisma.teeSearch.updateMany({
    where: {
      id: input.searchId,
      scheduleVersion: input.scheduleVersion
    },
    data: {
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
      cadenceMinutes: true,
      scheduleVersion: true
    }
  });
}

export async function listSearchesNeedingScheduleRecovery() {
  const overdueBefore = new Date(Date.now() - 10 * 60 * 1000);
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: { gte: startOfToday() },
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

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}
