import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

import type { BrowserDiscovery } from "./browser-discovery";
import { getBestProbeUrl, shouldQueueBrowserProbe } from "./browser-discovery";
import { withPostgresAdvisoryLease } from "./lease";

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

export async function listActiveSearchesForAutomation(): Promise<ActiveAutomationSearch[]> {
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: {
        gte: startOfToday()
      }
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
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

export async function listPendingMatchAlerts(): Promise<PendingAlertMatch[]> {
  return prisma.teeTimeMatch.findMany({
    where: {
      alertStatus: "PENDING",
      teeSearch: {
        status: "ACTIVE"
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

  if (input.detectedPlatform !== "FOREUP" && input.detectedPlatform !== "TEEITUP") {
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
      lastSeenAt: new Date(),
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
