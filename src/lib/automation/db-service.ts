import { randomUUID } from "node:crypto";

import {
  Prisma,
  type CourseMonitoringEventSource,
  type CourseSupportIncidentStatus,
} from "@prisma/client";

import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import {
  normalizeLayoutHoleCounts,
  type CourseLayoutHoleCount,
} from "@/lib/courses/course-layout";
import { resolveBookingAccessMode } from "@/lib/courses/intelligence";
import {
  lockSearchForAlertMutation,
  lockSearchForEmailReconciliation,
  reactivateTerminalUnresolvedMatchDeliveries,
  suppressSearchEmailDeliveriesForMatches,
} from "@/lib/email/search-delivery-outbox";
import { prisma } from "@/lib/prisma";
import {
  haveCompatibleCourseNames,
  haveCompatibleOfficialPageCourseNames,
} from "@/lib/places/course-identity";
import { markCompletedLocalReaderProviderObservationConsumedInTransaction } from "@/lib/local-reader/service";
import { recordCourseBookingFacts } from "@/lib/pricing/course-booking-facts";
import type {
  BookableHoleCount,
  CoursePriceEstimate,
} from "@/lib/pricing/course-prices";
import { zonedDateTimeToDate } from "@/lib/timezones";

import {
  evaluateBrowserDiscoveryMonitoringGate,
  getBestProbeUrl,
  getBestUnsupportedCoverageProbeUrl,
  isSafeManualEvidenceUrl,
  keepPolicyOnlyDiscoveryActionable,
  OFFICIAL_SITE_SOFT_NOT_FOUND_POLICY_NOTES,
  shouldQueueBrowserProbe,
  type BrowserDiscovery,
  type BrowserProbeCourseInput,
} from "./browser-discovery";
import {
  revalidateCourseMonitoringForProviderEvidenceChangeInTransaction,
  runSerializedCourseMonitoringWrite,
} from "./course-monitoring";
import {
  releaseCourseProviderObservationInTransaction,
  renewCourseProviderObservationInTransaction,
  type CourseProviderObservationLease,
} from "./provider-execution-marker";
import {
  ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS,
  isActiveOwnedCourseSupportBrowserResult,
  runCourseSupportBrowserPersistenceWrite,
  type CourseSupportBrowserPersistenceFence,
} from "./course-support-browser-stages";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";
import { assessAutomationPlaybook } from "./course-monitoring-playbook";
import {
  buildCourseSupportSourceSearchScopeDigest,
  normalizeCourseSupportSourceSearchResult,
} from "./course-support-source-search";
import {
  earliestPotentiallyActiveSearchDate,
  isSearchWindowActive,
} from "./date-boundary";
import {
  hasCompletePreEditProvenance,
  HOURLY_IMPROVEMENT_AUTOMATION_ID,
  markImprovementOutcomeRecorded,
  type HourlyImprovementRunRecord,
} from "./improvement";
import {
  withPostgresAdvisoryLease,
  withPostgresAdvisoryTextLease,
} from "./lease";
import { HOURLY_IMPROVEMENT_WRITER_LANE } from "./writer-lanes";
import {
  getProviderPublicBookingLandingIdentity,
  isProviderPublicBookingLandingUrl,
  normalizeProviderFamilyKey,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_MISSING_PROVIDER_FAMILY,
} from "./provider-capabilities";
import { evaluateMonitoringGate } from "./policy";
import { getAutomationRuntimeVersion } from "./runtime-version";

export { recordCourseBookingFacts };

const AUTOMATION_POLL_LEASE_KEY = 917300120260709n;
const REOPEN_ALERT_MINIMUM_ABSENCE_MS = 30 * 60 * 1000;
const SEARCH_CHECK_LEASE_MS = 15 * 60 * 1000;
const TRUSTED_DISCOVERY_FUTURE_TOLERANCE_MS = 60_000;

const activeSearchCourseInclude = {
  bookingFacts: {
    orderBy: { holes: "asc" },
  },
  monitoringStatus: true,
  supportIncident: {
    select: {
      id: true,
      cycle: true,
      status: true,
      resolution: true,
      attemptLedger: true,
      humanReviewReason: true,
      escalatedAt: true,
      escalationDeadlineAt: true,
      firstSeenAt: true,
      monitoringEvents: {
        where: { eventType: "HUMAN_REVIEW_REQUESTED" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 5,
        select: {
          incidentId: true,
          eventType: true,
          occurredAt: true,
          audit: true,
        },
      },
    },
  },
  profile: {
    select: {
      canonicalSlug: true,
      status: true,
    },
  },
} satisfies Prisma.CourseInclude;

const activeSearchInclude = {
  user: true,
  preferences: {
    orderBy: { rank: "asc" },
    include: {
      course: {
        include: activeSearchCourseInclude,
      },
    },
  },
  matches: true,
} satisfies Prisma.TeeSearchInclude;

const activeSearchCheckInclude = {
  user: {
    select: {
      email: true,
    },
  },
  preferences: {
    orderBy: { rank: "asc" },
    include: {
      course: {
        include: activeSearchCourseInclude,
      },
    },
  },
} satisfies Prisma.TeeSearchInclude;

export type ActiveAutomationSearch = Prisma.TeeSearchGetPayload<{
  include: typeof activeSearchCheckInclude;
}>;

const pendingAlertSelect = {
  id: true,
  availabilityCycle: true,
  startsAt: true,
  availableSpots: true,
  bookingUrl: true,
  priceCents: true,
  holes: true,
  course: {
    select: {
      id: true,
      name: true,
      address: true,
      timeZone: true,
    },
  },
  teeSearch: {
    select: {
      alertGeneration: true,
      alertEmail: true,
      additionalEmails: true,
      userTimeZone: true,
      user: {
        select: {
          email: true,
        },
      },
    },
  },
} satisfies Prisma.TeeTimeMatchSelect;

export type PendingAlertMatch = Prisma.TeeTimeMatchGetPayload<{
  select: typeof pendingAlertSelect;
}>;

export type BrowserProbeTarget = {
  searchId?: string;
  rank: number;
  course: {
    id: string;
    name: string;
    address: string | null;
    city: string | null;
    stateCode: string | null;
    googlePlaceIdPresent: boolean;
    website: string | null;
    detectedBookingUrl: string | null;
    detectedPlatform: string;
    providerFamilyKey: string;
    automationEligibility: string;
    automationReason: string;
    bookingMethod: string;
    isPublic: boolean | null;
    intelligenceVerifiedAt: Date | null;
    intelligenceReviewAt: Date | null;
    intelligenceConfidence: number | null;
    bookingMetadata: unknown;
    providerSnapshotFingerprint?: string;
    verifiedLayoutHoleCounts?: CourseLayoutHoleCount[];
    monitoringFailureEvidence?: BrowserProbeCourseInput["monitoringFailureEvidence"];
    incidentConfirmedAt?: Date | null;
  };
  probeUrl: string;
  unprojectedSourceCandidate?: true;
};

export function runWithAutomationPollLease<T>(worker: () => Promise<T>) {
  return withPostgresAdvisoryLease(prisma, AUTOMATION_POLL_LEASE_KEY, worker);
}

export type SearchCheckLease = {
  searchId: string;
  scheduleVersion: number;
  token: string;
  expiresAt: Date;
};

export async function runWithSearchCheckLease<T>(
  searchId: string,
  worker: (lease: SearchCheckLease) => Promise<T>,
) {
  const lease = await claimDirectSearchCheckLease(searchId);
  if (!lease) {
    return { acquired: false as const };
  }

  try {
    return { acquired: true as const, value: await worker(lease) };
  } finally {
    await releaseSearchCheckLease(lease);
  }
}

export function runWithHourlyImprovementLease<T>(worker: () => Promise<T>) {
  return withPostgresAdvisoryTextLease(
    prisma,
    HOURLY_IMPROVEMENT_WRITER_LANE,
    worker,
  );
}

export async function listActiveSearchesForAutomation(): Promise<
  ActiveAutomationSearch[]
> {
  const now = new Date();
  const searches = await prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: {
        gte: earliestPotentiallyActiveSearchDate(now),
      },
      OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: now } }],
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
    include: activeSearchInclude,
  });
  return searches.filter((search) =>
    isSearchWindowActive({
      date: search.date,
      endTime: search.endTime,
      courseTimeZones: search.preferences.map(
        (preference) => preference.course.timeZone,
      ),
      fallbackTimeZone: search.userTimeZone,
      now,
    }),
  );
}

export async function getActiveSearchForAutomation(
  searchId: string,
): Promise<ActiveAutomationSearch | null> {
  const now = new Date();
  const search = await prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      status: "ACTIVE",
      date: {
        gte: earliestPotentiallyActiveSearchDate(now),
      },
    },
    include: activeSearchCheckInclude,
  });
  if (!search) {
    return null;
  }
  return isSearchWindowActive({
    date: search.date,
    endTime: search.endTime,
    courseTimeZones: search.preferences.map(
      (preference) => preference.course.timeZone,
    ),
    fallbackTimeZone: search.userTimeZone,
    now,
  })
    ? search
    : null;
}

export async function listSearchCourseVerdictsSince(input: {
  searchId: string;
  courseIds: string[];
  observedAtOrAfter: Date;
}) {
  const courseIds = [...new Set(input.courseIds.filter(Boolean))];
  if (courseIds.length === 0) {
    return [];
  }
  return prisma.$queryRaw<
    Array<{
      courseId: string;
      outcome: string;
      observedAt: Date;
      failureEpisodeStartedAt: Date | null;
    }>
  >(Prisma.sql`
    WITH scoped AS (
      SELECT "id", "courseId", "outcome", "observedAt"
      FROM "CourseProbe"
      WHERE "teeSearchId" = ${input.searchId}
        AND "courseId" IN (${Prisma.join(courseIds)})
        AND "observedAt" >= ${input.observedAtOrAfter}
    ), latest AS (
      SELECT DISTINCT ON ("courseId")
        "id", "courseId", "outcome", "observedAt"
      FROM scoped
      ORDER BY "courseId", "observedAt" DESC, "id" DESC
    ), latest_success AS (
      SELECT DISTINCT ON ("courseId")
        "id", "courseId", "observedAt"
      FROM scoped
      WHERE "outcome" IN (
        'MATCH_FOUND'::"ProbeOutcome",
        'NO_MATCH'::"ProbeOutcome"
      )
      ORDER BY "courseId", "observedAt" DESC, "id" DESC
    ), failure_episode AS (
      SELECT
        failure."courseId",
        MIN(failure."observedAt") AS "failureEpisodeStartedAt"
      FROM scoped AS failure
      INNER JOIN latest_success AS success
        ON success."courseId" = failure."courseId"
      WHERE (failure."observedAt", failure."id") >
        (success."observedAt", success."id")
        AND failure."outcome" NOT IN (
          'MATCH_FOUND'::"ProbeOutcome",
          'NO_MATCH'::"ProbeOutcome"
        )
      GROUP BY failure."courseId"
    )
    SELECT
      latest."courseId",
      latest."outcome",
      latest."observedAt",
      failure_episode."failureEpisodeStartedAt"
    FROM latest
    LEFT JOIN failure_episode
      ON failure_episode."courseId" = latest."courseId"
  `);
}

export async function getCourseMonitoringPlaybookContext(courseId: string) {
  return prisma.courseSupportIncident.findUnique({
    where: { courseId },
    select: {
      id: true,
      cycle: true,
      status: true,
      attemptLedger: true,
    },
  });
}

export async function listBrowserProbeTargets(
  limit = 5,
  courseName?: string,
  courseId?: string,
  persistenceFence?: CourseSupportBrowserPersistenceFence,
): Promise<BrowserProbeTarget[]> {
  const requestedCourseName = courseName?.trim().toLocaleLowerCase("en-US");
  const requestedCourseId = courseId?.trim();
  if (requestedCourseName && requestedCourseId) {
    throw new Error(
      "A browser probe may select a course by name or id, not both.",
    );
  }
  if (
    persistenceFence &&
    (!requestedCourseId ||
      requestedCourseName ||
      requestedCourseId !== persistenceFence.courseId)
  ) {
    throw new Error("An owned browser probe must select the fenced course id.");
  }
  if (requestedCourseName || requestedCourseId) {
    return listExactIncidentBrowserProbeTarget({
      requestedCourseName,
      requestedCourseId,
      persistenceFence,
    });
  }
  const [searches, openIncidents] = await Promise.all([
    prisma.teeSearch.findMany({
      where: {
        status: "ACTIVE",
        date: {
          gte: earliestPotentiallyActiveSearchDate(),
        },
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      include: {
        preferences: {
          orderBy: { rank: "asc" },
          include: { course: true },
        },
      },
    }),
    prisma.courseSupportIncident.findMany({
      where: { status: { not: "RESOLVED" } },
      select: {
        courseId: true,
        status: true,
        cycle: true,
        attemptLedger: true,
        activeRealSearchCount: true,
        firstSeenAt: true,
        nextAttemptAt: true,
        kind: true,
        occurrenceCount: true,
        lastSeenAt: true,
        confirmedAt: true,
        course: {
          select: {
            id: true,
            name: true,
            googlePlaceId: true,
            address: true,
            city: true,
            stateCode: true,
            website: true,
            detectedBookingUrl: true,
            detectedPlatform: true,
            providerFamilyKey: true,
            automationEligibility: true,
            automationReason: true,
            monitoringMode: true,
            bookingAccessMode: true,
            bookingMethod: true,
            isPublic: true,
            intelligenceVerifiedAt: true,
            intelligenceReviewAt: true,
            intelligenceConfidence: true,
            bookingMetadata: true,
            layoutHoleCounts: true,
            layoutHolesVerifiedAt: true,
            probes: {
              orderBy: { observedAt: "desc" },
              take: 1,
              select: { outcome: true, observedAt: true },
            },
          },
        },
      },
    }),
  ]);
  const browserReadyIncidentByCourse = new Map(
    openIncidents
      .filter((incident) => {
        if (incident.status !== "AUTO_INVESTIGATING") return false;
        const nextStage = assessAutomationPlaybook(
          incident.attemptLedger,
          incident.cycle,
        ).nextStage;
        return (
          nextStage === "RENDERED_BROWSER_DISCOVERY" ||
          nextStage === "INDEPENDENT_CONFIRMATION"
        );
      })
      .map((incident) => [incident.courseId, incident]),
  );
  const incidentPriority = new Map(
    [...browserReadyIncidentByCourse.values()].map((incident) => [
      incident.courseId,
      incident.activeRealSearchCount > 0 ? 0 : 1,
    ]),
  );
  const monitoringFailureByCourse = new Map(
    openIncidents.map((incident) => [
      incident.courseId,
      getIncidentMonitoringFailureEvidence(incident),
    ]),
  );

  const targets: Array<
    BrowserProbeTarget & { supportPriority: number; episodeStartedAt: Date }
  > = [];
  const queuedCourseIds = new Set<string>();

  for (const search of searches) {
    for (const preference of search.preferences) {
      const course = preference.course;
      const readyIncident = browserReadyIncidentByCourse.get(course.id);
      if (!readyIncident) continue;
      const monitoringFailureEvidence = monitoringFailureByCourse.get(
        course.id,
      );
      const probeCourse = { ...course, monitoringFailureEvidence };
      const probeUrl = getBestProbeUrl(probeCourse);

      if (
        !probeUrl ||
        queuedCourseIds.has(course.id) ||
        !shouldQueueBrowserProbe(probeCourse)
      ) {
        continue;
      }

      targets.push({
        searchId: search.id,
        rank: preference.rank,
        course: {
          id: course.id,
          name: course.name,
          address: course.address,
          city: course.city,
          stateCode: course.stateCode,
          googlePlaceIdPresent: Boolean(course.googlePlaceId),
          website: course.website,
          detectedBookingUrl: course.detectedBookingUrl,
          detectedPlatform: course.detectedPlatform,
          providerFamilyKey: course.providerFamilyKey,
          automationEligibility: course.automationEligibility,
          automationReason: course.automationReason,
          bookingMethod: course.bookingMethod,
          isPublic: course.isPublic,
          intelligenceVerifiedAt: course.intelligenceVerifiedAt,
          intelligenceReviewAt: course.intelligenceReviewAt,
          intelligenceConfidence: course.intelligenceConfidence,
          bookingMetadata: course.bookingMetadata,
          ...(course.layoutHolesVerifiedAt
            ? {
                verifiedLayoutHoleCounts: normalizeLayoutHoleCounts(
                  course.layoutHoleCounts,
                ),
              }
            : {}),
          monitoringFailureEvidence,
          incidentConfirmedAt: readyIncident.confirmedAt,
        },
        probeUrl,
        supportPriority: incidentPriority.get(course.id) ?? 1,
        episodeStartedAt: readyIncident.firstSeenAt,
      });
      queuedCourseIds.add(course.id);
    }
  }

  for (const incident of openIncidents) {
    const readyIncident = browserReadyIncidentByCourse.get(incident.courseId);
    if (!readyIncident) continue;
    const course = incident.course;
    if (!course?.id || queuedCourseIds.has(course.id)) {
      continue;
    }
    const monitoringFailureEvidence = monitoringFailureByCourse.get(course.id);
    const probeCourse = { ...course, monitoringFailureEvidence };
    const probeUrl = getBestProbeUrl(probeCourse);
    if (!probeUrl || !shouldQueueBrowserProbe(probeCourse)) {
      continue;
    }
    targets.push({
      rank: Number.MAX_SAFE_INTEGER,
      course: {
        id: course.id,
        name: course.name,
        address: course.address,
        city: course.city,
        stateCode: course.stateCode,
        googlePlaceIdPresent: Boolean(course.googlePlaceId),
        website: course.website,
        detectedBookingUrl: course.detectedBookingUrl,
        detectedPlatform: course.detectedPlatform,
        providerFamilyKey: course.providerFamilyKey,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
        bookingMethod: course.bookingMethod,
        isPublic: course.isPublic,
        intelligenceVerifiedAt: course.intelligenceVerifiedAt,
        intelligenceReviewAt: course.intelligenceReviewAt,
        intelligenceConfidence: course.intelligenceConfidence,
        bookingMetadata: course.bookingMetadata,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(course),
        ...(course.layoutHolesVerifiedAt
          ? {
              verifiedLayoutHoleCounts: normalizeLayoutHoleCounts(
                course.layoutHoleCounts,
              ),
            }
          : {}),
        monitoringFailureEvidence,
        incidentConfirmedAt: readyIncident.confirmedAt,
      },
      probeUrl,
      supportPriority: incidentPriority.get(course.id) ?? 1,
      episodeStartedAt: readyIncident.firstSeenAt,
    });
    queuedCourseIds.add(course.id);
  }

  const orderedTargets = targets.sort(
    (left, right) =>
      left.supportPriority - right.supportPriority ||
      left.episodeStartedAt.getTime() - right.episodeStartedAt.getTime() ||
      left.rank - right.rank,
  );
  return orderedTargets.slice(0, limit).map((target) => ({
    searchId: target.searchId,
    rank: target.rank,
    course: target.course,
    probeUrl: target.probeUrl,
  }));
}

async function listExactIncidentBrowserProbeTarget(input: {
  requestedCourseName?: string;
  requestedCourseId?: string;
  persistenceFence?: CourseSupportBrowserPersistenceFence;
}): Promise<BrowserProbeTarget[]> {
  const courses = await prisma.course.findMany({
    where: {
      ...(input.requestedCourseId
        ? { id: input.requestedCourseId }
        : {
            name: {
              equals: input.requestedCourseName!,
              mode: "insensitive" as const,
            },
          }),
      supportIncident: { is: { status: { not: "RESOLVED" } } },
    },
    include: {
      supportIncident: {
        select: {
          id: true,
          kind: true,
          failureClass: true,
          status: true,
          activeBatchId: true,
          occurrenceCount: true,
          lastSeenAt: true,
          cycle: true,
          confirmedAt: true,
          attemptLedger: true,
        },
      },
      probes: {
        orderBy: { observedAt: "desc" },
        take: 1,
        select: { outcome: true, observedAt: true },
      },
      preferences: {
        where: {
          teeSearch: {
            status: "ACTIVE",
            date: { gte: earliestPotentiallyActiveSearchDate() },
          },
        },
        orderBy: { rank: "asc" },
        take: 1,
        include: { teeSearch: { select: { id: true } } },
      },
    },
  });
  if (!input.requestedCourseId && courses.length > 1) {
    throw new Error("The requested browser-probe course name is ambiguous.");
  }
  const course = courses[0];
  const monitoringFailureEvidence = course
    ? getIncidentMonitoringFailureEvidence({
        kind: course.supportIncident?.kind,
        occurrenceCount: course.supportIncident?.occurrenceCount,
        lastSeenAt: course.supportIncident?.lastSeenAt,
        course: { probes: course.probes ?? [] },
      })
    : undefined;
  const probeCourse = course ? { ...course, monitoringFailureEvidence } : null;
  const nextPlaybookStage = course?.supportIncident
    ? assessAutomationPlaybook(
        course.supportIncident.attemptLedger,
        course.supportIncident.cycle,
      ).nextStage
    : null;
  const currentOwnedIncidentFence = input.persistenceFence
    ? isCurrentOwnedBrowserProbeIncidentFence({
        courseId: course?.id,
        incident: course?.supportIncident,
        nextPlaybookStage,
        fence: input.persistenceFence,
      })
    : false;
  const currentOwnedFence =
    currentOwnedIncidentFence && input.persistenceFence
      ? await hasCurrentOwnedBrowserProbeBatchFence(input.persistenceFence)
      : false;
  if (input.persistenceFence && !currentOwnedFence) {
    return [];
  }
  const hasCurrentTechnicalAccessFailure = Boolean(
    course?.supportIncident?.kind === "FETCH_FAILED" &&
    ["AUTH", "CHALLENGE"].includes(course.supportIncident.failureClass ?? ""),
  );
  const hasOwnedBlockedToolingAccessFailure = Boolean(
    currentOwnedFence &&
    course?.supportIncident?.kind === "BLOCKED_TOOLING" &&
    ["AUTH", "CHALLENGE"].includes(course.supportIncident.failureClass ?? ""),
  );
  const hasCurrentUnsupportedCoverageFailure = Boolean(
    course?.supportIncident?.kind === "NEEDS_ADAPTER" &&
    ["MISSING_SOURCE", "MISSING_METADATA", "UNSUPPORTED_FAMILY"].includes(
      course.supportIncident.failureClass ?? "",
    ),
  );
  const currentCourseProbeUrl = probeCourse
    ? hasCurrentUnsupportedCoverageFailure
      ? getBestUnsupportedCoverageProbeUrl(probeCourse)
      : getBestProbeUrl(probeCourse)
    : null;
  const ownedSourceCandidate =
    !currentCourseProbeUrl && input.persistenceFence
      ? await getOwnedCourseSupportSourceSearchCandidate(input.persistenceFence)
      : null;
  const probeUrl = currentCourseProbeUrl ?? ownedSourceCandidate;
  const readerOnlyIndependentConfirmation = Boolean(
    course?.monitoringMode === "LOCAL_READER_ONLY" &&
    nextPlaybookStage === "INDEPENDENT_CONFIRMATION",
  );
  const currentOwnedBrowserStageEligible = Boolean(
    currentOwnedFence && course?.isPublic !== false,
  );
  if (
    !course ||
    !probeUrl ||
    !probeCourse ||
    (course.monitoringMode === "LOCAL_READER_ONLY" &&
      !readerOnlyIndependentConfirmation) ||
    (!shouldQueueBrowserProbe(probeCourse) &&
      !currentOwnedBrowserStageEligible &&
      !hasCurrentTechnicalAccessFailure &&
      !hasOwnedBlockedToolingAccessFailure &&
      !hasCurrentUnsupportedCoverageFailure &&
      !readerOnlyIndependentConfirmation)
  ) {
    return [];
  }
  const preference = course.preferences[0];
  return [
    {
      searchId: preference?.teeSearch.id,
      rank: preference?.rank ?? Number.MAX_SAFE_INTEGER,
      course: {
        id: course.id,
        name: course.name,
        address: course.address,
        city: course.city,
        stateCode: course.stateCode,
        googlePlaceIdPresent: Boolean(course.googlePlaceId),
        website: course.website,
        detectedBookingUrl: course.detectedBookingUrl,
        detectedPlatform: course.detectedPlatform,
        providerFamilyKey: course.providerFamilyKey,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
        bookingMethod: course.bookingMethod,
        isPublic: course.isPublic,
        intelligenceVerifiedAt: course.intelligenceVerifiedAt,
        intelligenceReviewAt: course.intelligenceReviewAt,
        intelligenceConfidence: course.intelligenceConfidence,
        bookingMetadata: course.bookingMetadata,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(course),
        ...(course.layoutHolesVerifiedAt
          ? {
              verifiedLayoutHoleCounts: normalizeLayoutHoleCounts(
                course.layoutHoleCounts,
              ),
            }
          : {}),
        monitoringFailureEvidence,
        incidentConfirmedAt: course.supportIncident?.confirmedAt ?? null,
      },
      probeUrl,
      ...(!currentCourseProbeUrl && ownedSourceCandidate
        ? { unprojectedSourceCandidate: true as const }
        : {}),
    },
  ];
}

function isCurrentOwnedBrowserProbeIncidentFence(input: {
  courseId?: string;
  incident?: {
    id: string;
    cycle: number;
    status: string;
    activeBatchId: string | null;
  } | null;
  nextPlaybookStage: ReturnType<typeof assessAutomationPlaybook>["nextStage"];
  fence: CourseSupportBrowserPersistenceFence;
}) {
  return Boolean(
    input.courseId === input.fence.courseId &&
    input.incident?.id === input.fence.incidentId &&
    input.incident.cycle === input.fence.cycle &&
    input.incident.status === "AUTO_INVESTIGATING" &&
    input.incident.activeBatchId === input.fence.batchId &&
    input.nextPlaybookStage === input.fence.stage,
  );
}

async function hasCurrentOwnedBrowserProbeBatchFence(
  fence: CourseSupportBrowserPersistenceFence,
) {
  if (
    fence.runtimeVersion !== fence.releaseSha ||
    !Number.isFinite(fence.deployedAt.getTime())
  ) {
    return false;
  }
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: fence.batchId,
      leaseToken: fence.leaseToken,
      ownerThreadId: fence.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
      leaseExpiresAt: { gt: new Date() },
      releaseSha: fence.releaseSha,
      deployedAt: fence.deployedAt,
      incidents: {
        some: {
          incidentId: fence.incidentId,
          courseId: fence.courseId,
          cycle: fence.cycle,
          result: {
            in: [...ACTIVE_OWNED_COURSE_SUPPORT_BROWSER_RESULTS],
          },
        },
      },
    },
    select: { id: true },
  });
  return Boolean(batch);
}

async function getOwnedCourseSupportSourceSearchCandidate(
  fence: CourseSupportBrowserPersistenceFence,
) {
  const ownershipScopeDigest = buildCourseSupportSourceSearchScopeDigest({
    batchId: fence.batchId,
    incidentId: fence.incidentId,
    cycle: fence.cycle,
  });
  const event = await prisma.courseMonitoringEvent.findFirst({
    where: {
      courseId: fence.courseId,
      incidentId: fence.incidentId,
      eventType: "AUTOMATION_ATTEMPTED",
      source: "COURSE_SUPPORT_RESPONDER",
      readPath: "CODEX_EXACT_SOURCE_SEARCH",
      evidenceUrl: { not: null },
      audit: { path: ["ownershipScopeDigest"], equals: ownershipScopeDigest },
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { evidenceUrl: true, audit: true },
  });
  const audit = event?.audit;
  if (
    !event?.evidenceUrl ||
    !audit ||
    typeof audit !== "object" ||
    Array.isArray(audit)
  ) {
    return null;
  }
  const record = audit as Record<string, unknown>;
  if (
    record.result !== "CANDIDATE" ||
    record.incidentCycle !== fence.cycle ||
    record.ownershipScopeDigest !== ownershipScopeDigest ||
    record.courseProjectionApplied !== false ||
    record.browserVerificationRequired !== true
  ) {
    return null;
  }
  const batch = await prisma.courseSupportBatch.findFirst({
    where: {
      id: fence.batchId,
      leaseToken: fence.leaseToken,
      ownerThreadId: fence.ownerThreadId,
      status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] },
      leaseExpiresAt: { gte: new Date() },
      releaseSha: fence.releaseSha,
      deployedAt: fence.deployedAt,
    },
    select: {
      releaseSha: true,
      deployedAt: true,
      incidents: {
        where: {
          incidentId: fence.incidentId,
          courseId: fence.courseId,
          cycle: fence.cycle,
        },
        take: 1,
        select: {
          courseId: true,
          cycle: true,
          result: true,
          course: {
            select: {
              website: true,
              detectedBookingUrl: true,
            },
          },
          incident: {
            select: {
              id: true,
              cycle: true,
              status: true,
              activeBatchId: true,
              attemptLedger: true,
            },
          },
        },
      },
    },
  });
  const entry = batch?.incidents[0];
  if (
    fence.runtimeVersion !== fence.releaseSha ||
    !batch ||
    batch.releaseSha !== fence.releaseSha ||
    batch.deployedAt?.getTime() !== fence.deployedAt.getTime() ||
    !entry ||
    entry.courseId !== fence.courseId ||
    entry.cycle !== fence.cycle ||
    !isActiveOwnedCourseSupportBrowserResult(entry.result) ||
    Boolean(entry.course.website || entry.course.detectedBookingUrl) ||
    entry.incident.id !== fence.incidentId ||
    entry.incident.cycle !== fence.cycle ||
    entry.incident.status !== "AUTO_INVESTIGATING" ||
    entry.incident.activeBatchId !== fence.batchId ||
    assessAutomationPlaybook(entry.incident.attemptLedger, entry.incident.cycle)
      .nextStage !== fence.stage
  ) {
    return null;
  }
  try {
    return normalizeCourseSupportSourceSearchResult({
      candidateUrl: event.evidenceUrl,
    }).candidateUrl;
  } catch {
    return null;
  }
}

function getIncidentMonitoringFailureEvidence(incident: {
  kind?: string | null;
  occurrenceCount?: number | null;
  lastSeenAt?: Date | null;
  course?: {
    probes?: Array<{ outcome: string; observedAt: Date }>;
  } | null;
}): BrowserProbeCourseInput["monitoringFailureEvidence"] {
  if (
    incident.kind !== "FETCH_FAILED" ||
    !incident.lastSeenAt ||
    (incident.occurrenceCount ?? 0) < 2
  ) {
    return undefined;
  }
  const latestProbe = incident.course?.probes?.[0];
  const latestSuccessfulAt =
    latestProbe &&
    (latestProbe.outcome === "MATCH_FOUND" ||
      latestProbe.outcome === "NO_MATCH")
      ? latestProbe.observedAt
      : null;
  return {
    kind: "FETCH_FAILED",
    occurrenceCount: incident.occurrenceCount ?? 0,
    latestFailureAt: incident.lastSeenAt,
    latestSuccessfulAt,
  };
}

export async function listPendingMatchAlerts(
  searchId?: string,
  matchIds?: readonly string[],
): Promise<PendingAlertMatch[]> {
  if (matchIds?.length === 0) {
    return [];
  }

  return prisma.teeTimeMatch.findMany({
    where: {
      ...(matchIds ? { id: { in: [...matchIds] } } : {}),
      alertStatus: "PENDING",
      availabilityStatus: "AVAILABLE",
      teeSearch: {
        status: "ACTIVE",
        ...(searchId ? { id: searchId } : {}),
      },
    },
    orderBy: {
      firstSeenAt: "asc",
    },
    select: pendingAlertSelect,
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
    | "NEEDS_ADAPTER"
    | "MANUAL_DIRECT"
    | "IDENTITY_FINAL"
    | "IDENTITY_RECHECK";
  message?: string;
  evidenceUrl?: string;
  rawSummary?: Prisma.InputJsonValue;
  automationRunId?: string;
  runtimeVersion?: string;
  observedAtOrAfter?: Date;
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
      automationRunId: input.automationRunId,
      runtimeVersion: input.runtimeVersion ?? getAutomationRuntimeVersion(),
    },
  });
}

async function createCourseAutomationDiscoveryWithCourseFence(
  transaction: Prisma.TransactionClient,
  data: Prisma.CourseAutomationDiscoveryUncheckedCreateInput,
) {
  const touched = await transaction.$queryRaw<Array<{ updatedAt: Date }>>(
    Prisma.sql`UPDATE "Course"
               SET "updatedAt" = GREATEST(
                 "updatedAt" + INTERVAL '1 millisecond',
                 clock_timestamp() AT TIME ZONE 'UTC'
               )
               WHERE "id" = ${data.courseId}
               RETURNING "updatedAt"`,
  );
  if (touched.length === 0) {
    throw new Error(
      "Course automation discovery parent course no longer exists.",
    );
  }
  const courseUpdatedAt = touched.length === 1 ? touched[0]?.updatedAt : null;
  if (
    !(courseUpdatedAt instanceof Date) ||
    !Number.isFinite(courseUpdatedAt.getTime())
  ) {
    throw new Error(
      "Course automation discovery parent fence returned invalid evidence.",
    );
  }
  return {
    discovery: await transaction.courseAutomationDiscovery.create({ data }),
    courseUpdatedAt,
  };
}

async function assertCourseProviderObservationOwnedForWrite(
  transaction: Prisma.TransactionClient,
  courseId: string,
  providerObservation?: CourseProviderObservationLease,
) {
  if (!providerObservation) return;
  if (providerObservation.courseId !== courseId) {
    throw new Error(
      "Provider observation ownership does not match the discovery course.",
    );
  }
  if (
    !(await renewCourseProviderObservationInTransaction(
      transaction,
      providerObservation,
    ))
  ) {
    throw new Error(
      "Provider observation ownership expired before discovery persistence completed.",
    );
  }
}

export async function recordBrowserDiscovery(
  input: BrowserDiscovery,
  persistenceFence?: CourseSupportBrowserPersistenceFence,
  runtimeVersion?: string | null,
  expectedUnownedIncident?: BrowserDiscoveryUnownedIncidentExpectation,
  observedAtInput?: Date,
  providerObservation?: CourseProviderObservationLease,
) {
  const observedAt = resolveTrustedDiscoveryObservedAt(observedAtInput);
  const data = {
    ...buildBrowserDiscoveryPersistenceData(input),
    ...(observedAtInput ? { createdAt: observedAt } : {}),
  };
  if (!persistenceFence) {
    if (!expectedUnownedIncident) {
      return runSerializedCourseMonitoringWrite(
        input.courseId,
        async (transaction) => {
          await assertCourseProviderObservationOwnedForWrite(
            transaction,
            input.courseId,
            providerObservation,
          );
          return (
            await createCourseAutomationDiscoveryWithCourseFence(
              transaction,
              data,
            )
          ).discovery;
        },
      );
    }
    return runSerializedCourseMonitoringWrite(
      input.courseId,
      async (transaction) => {
        await assertCourseProviderObservationOwnedForWrite(
          transaction,
          input.courseId,
          providerObservation,
        );
        if (
          !(await reserveUnownedIncidentForBrowserDiscovery(
            transaction,
            input.courseId,
            expectedUnownedIncident,
          ))
        ) {
          return null;
        }
        return (
          await createCourseAutomationDiscoveryWithCourseFence(
            transaction,
            await attachParkedCampaignToDiscovery(
              transaction,
              data,
              expectedUnownedIncident.id,
              expectedUnownedIncident.cycle,
            ),
          )
        ).discovery;
      },
    );
  }
  return runSerializedCourseMonitoringWrite(input.courseId, (transaction) =>
    runCourseSupportBrowserPersistenceWrite({
      transaction,
      fence: persistenceFence,
      runtimeVersion,
      mutate: async (ownedTransaction) => {
        await assertCourseProviderObservationOwnedForWrite(
          ownedTransaction,
          input.courseId,
          providerObservation,
        );
        if (
          !(await reserveUnownedIncidentForBrowserDiscovery(
            ownedTransaction,
            input.courseId,
            expectedUnownedIncident,
          ))
        ) {
          return null;
        }
        return (
          await createCourseAutomationDiscoveryWithCourseFence(
            ownedTransaction,
            await attachParkedCampaignToDiscovery(
              ownedTransaction,
              data,
              persistenceFence.incidentId,
              persistenceFence.cycle,
            ),
          )
        ).discovery;
      },
    }),
  );
}

async function attachParkedCampaignToDiscovery(
  transaction: Prisma.TransactionClient,
  data: ReturnType<typeof buildBrowserDiscoveryPersistenceData> & {
    createdAt?: Date;
  },
  incidentId: string,
  cycle: number,
) {
  const admission = await transaction.courseMonitoringEvent.findFirst({
    where: {
      incidentId,
      eventType: "REVALIDATION_REQUESTED",
      source: "COURSE_SUPPORT_RESPONDER",
      AND: [
        {
          audit: {
            path: ["action"],
            equals: "parked_cohort_admission",
          },
        },
        {
          audit: {
            path: ["cycle"],
            equals: cycle,
          },
        },
      ],
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    select: { audit: true },
  });
  const audit =
    admission?.audit &&
    typeof admission.audit === "object" &&
    !Array.isArray(admission.audit)
      ? (admission.audit as Record<string, unknown>)
      : null;
  if (
    audit?.action !== "parked_cohort_admission" ||
    audit.cycle !== cycle ||
    typeof audit.campaignRunId !== "string" ||
    !audit.campaignRunId.trim() ||
    typeof audit.campaignMembershipDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(audit.campaignMembershipDigest)
  ) {
    return data;
  }
  const evidence =
    data.evidence &&
    typeof data.evidence === "object" &&
    !Array.isArray(data.evidence)
      ? (data.evidence as Prisma.InputJsonObject)
      : {};
  return {
    ...data,
    evidence: {
      ...evidence,
      campaign: {
        kind: "PARKED_COHORT",
        runId: audit.campaignRunId,
        membershipDigest: audit.campaignMembershipDigest,
        cycle,
      },
      customerDataIncluded: false,
    } satisfies Prisma.InputJsonObject,
  };
}

function buildBrowserDiscoveryPersistenceData(input: BrowserDiscovery) {
  const normalized = normalizeBrowserDiscoveryForMonitoring(input);
  const learnedOnline =
    normalized.status === "LEARNED" && Boolean(normalized.apiMetadata);
  const automationEligibility =
    normalized.automationEligibility ?? (learnedOnline ? "ALLOWED" : "UNKNOWN");
  const bookingMethod =
    normalized.bookingMethod ??
    (learnedOnline && normalized.bookingUrl ? "PUBLIC_ONLINE" : "UNKNOWN");
  return {
    courseId: normalized.courseId,
    status: normalized.status,
    detectedPlatform: normalized.detectedPlatform,
    bookingMethod,
    bookingPhone: normalized.bookingPhone,
    automationEligibility,
    automationReason: normalized.automationReason ?? "NONE",
    bookingAccessMode: resolveBookingAccessMode({
      automationEligibility,
      automationReason: normalized.automationReason,
      bookingMethod,
      bookingAccessMode: normalized.bookingAccessMode,
    }),
    sourceUrl: normalized.sourceUrl,
    bookingUrl: normalized.bookingUrl,
    apiEndpoint: normalized.apiEndpoint,
    apiMetadata: normalized.apiMetadata as Prisma.InputJsonValue | undefined,
    confidence: normalized.confidence,
    evidence: normalized.evidence as Prisma.InputJsonValue,
  };
}

export type BrowserDiscoveryCourseExpectation = {
  updatedAt: Date;
  detectedBookingUrl: string | null;
  bookingMethod: string;
  automationEligibility: string;
};

export type BrowserDiscoveryUnownedIncidentExpectation = {
  id: string;
  cycle: number;
  revision: number;
  status: CourseSupportIncidentStatus;
};

function hasAuthoritativeFactualCourseFinal(input: {
  monitoringStatus?: { state: string } | null;
  supportIncident?: { resolution: string | null } | null;
}) {
  return Boolean(
    input.monitoringStatus?.state === "FINAL_MANUAL" ||
    input.monitoringStatus?.state === "FINAL_IDENTITY" ||
    input.supportIncident?.resolution === "DIRECT_BOOKING_CLASSIFIED" ||
    input.supportIncident?.resolution === "IDENTITY_CLASSIFIED",
  );
}

function resolveTrustedDiscoveryObservedAt(value?: Date) {
  const now = new Date();
  if (value === undefined) {
    return now;
  }
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getTime() > now.getTime() + TRUSTED_DISCOVERY_FUTURE_TOLERANCE_MS
  ) {
    throw new Error(
      "Browser discovery observedAt must be a valid non-future date",
    );
  }
  return new Date(value.getTime());
}

export async function applyRecoveredOfficialWebsiteToCourse(input: {
  courseId: string;
  website: string;
  expectedUpdatedAt: Date;
  expectedUnownedIncident?: BrowserDiscoveryUnownedIncidentExpectation;
  observedAt?: Date;
  providerObservation?: CourseProviderObservationLease;
}) {
  const website = parseSafePublicUrl(input.website);
  if (!website || !isSafeManualEvidenceUrl(website)) {
    throw new Error(
      "Recovered official website must be a credential-free public HTTP(S) URL",
    );
  }
  if (
    !(input.expectedUpdatedAt instanceof Date) ||
    !Number.isFinite(input.expectedUpdatedAt.getTime())
  ) {
    throw new Error(
      "Recovered official website requires a valid pre-fetch course snapshot",
    );
  }
  const observedAt = resolveTrustedDiscoveryObservedAt(input.observedAt);

  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      await assertCourseProviderObservationOwnedForWrite(
        transaction,
        input.courseId,
        input.providerObservation,
      );
      const current = await transaction.course.findUnique({
        where: { id: input.courseId },
        include: {
          monitoringStatus: { select: { state: true } },
          supportIncident: { select: { resolution: true } },
        },
      });
      if (
        !current ||
        current.website !== null ||
        current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
        hasAuthoritativeFactualCourseFinal(current)
      ) {
        return null;
      }
      if (
        !(await reserveUnownedIncidentForBrowserDiscovery(
          transaction,
          input.courseId,
          input.expectedUnownedIncident,
        ))
      ) {
        return null;
      }

      const updated = await transaction.course.updateMany({
        where: {
          id: input.courseId,
          updatedAt: input.expectedUpdatedAt,
          website: null,
        },
        data: { website: website.toString() },
      });
      if (updated.count !== 1) {
        return null;
      }
      const applied = await transaction.course.findUnique({
        where: { id: input.courseId },
      });
      if (!applied) {
        return null;
      }
      await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
        transaction,
        {
          courseId: input.courseId,
          before: current,
          after: applied,
          providerSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(applied),
          source: "SEARCH_WORKFLOW",
          now: observedAt,
        },
      );
      const persisted = await createCourseAutomationDiscoveryWithCourseFence(
        transaction,
        {
          courseId: input.courseId,
          status: "INSPECTED",
          detectedPlatform: "UNKNOWN",
          bookingMethod: "UNKNOWN",
          automationEligibility: "UNKNOWN",
          automationReason: "NONE",
          bookingAccessMode: "UNKNOWN",
          sourceUrl: website.toString(),
          bookingUrl: null,
          confidence: 0.9,
          createdAt: observedAt,
          evidence: {
            learnedFrom: "google-places-official-website",
            observedUrls: [website.toString()],
            courseProjectionApplied: true,
            customerDataIncluded: false,
          },
        },
      );
      return { ...applied, updatedAt: persisted.courseUpdatedAt };
    },
  );
}

export async function retireLegacyPolicyOnlyCourseBlock(
  courseId: string,
  expectedCourse: BrowserDiscoveryCourseExpectation,
  preservation: {
    preserveWebsite: boolean;
    preserveDetectedBookingUrl: boolean;
    preserveBookingMetadata: boolean;
  },
  expectedUnownedIncident?: BrowserDiscoveryUnownedIncidentExpectation,
  observedAtInput?: Date,
  providerObservation?: CourseProviderObservationLease,
) {
  const observedAt = resolveTrustedDiscoveryObservedAt(observedAtInput);
  return runSerializedCourseMonitoringWrite(courseId, async (transaction) => {
    await assertCourseProviderObservationOwnedForWrite(
      transaction,
      courseId,
      providerObservation,
    );
    const current = await transaction.course.findUnique({
      where: { id: courseId },
      include: {
        monitoringStatus: { select: { state: true } },
        supportIncident: { select: { resolution: true } },
      },
    });
    if (!current || hasAuthoritativeFactualCourseFinal(current)) {
      return null;
    }
    const preserveProviderAccess =
      preservation.preserveDetectedBookingUrl ||
      preservation.preserveBookingMetadata;
    if (
      !(await reserveUnownedIncidentForBrowserDiscovery(
        transaction,
        courseId,
        expectedUnownedIncident,
      ))
    ) {
      return null;
    }
    const updated = await transaction.course.updateMany({
      where: {
        id: courseId,
        updatedAt: expectedCourse.updatedAt,
        detectedBookingUrl: expectedCourse.detectedBookingUrl,
        automationEligibility: "BLOCKED",
        automationReason: "AUTOMATION_PROHIBITED",
      },
      data: {
        ...(!preserveProviderAccess
          ? {
              providerFamilyKey: "SOURCE_MISSING",
              detectedPlatform: "UNKNOWN" as const,
            }
          : {}),
        ...(!preservation.preserveWebsite ? { website: null } : {}),
        ...(!preservation.preserveDetectedBookingUrl
          ? { detectedBookingUrl: null }
          : {}),
        ...(!preservation.preserveBookingMetadata
          ? { bookingMetadata: Prisma.DbNull }
          : {}),
        ...(!preserveProviderAccess
          ? { bookingMethod: "UNKNOWN" as const }
          : {}),
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "OTHER",
        bookingAccessMode: "UNKNOWN",
        policyNotes:
          "Legacy booking-policy text is not a technical monitoring blocker. Current public monitoring support requires fresh verification.",
        intelligenceVerifiedAt: null,
        intelligenceReviewAt: null,
        intelligenceConfidence: null,
      },
    });
    if (updated.count !== 1) {
      return null;
    }
    const applied = await transaction.course.findUnique({
      where: { id: courseId },
    });
    if (applied) {
      await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
        transaction,
        {
          courseId,
          before: current,
          after: applied,
          providerSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(applied),
          source: "COURSE_SUPPORT_RESPONDER",
          now: observedAt,
        },
      );
    }
    return applied;
  });
}

export async function applyBrowserDiscoveryToCourse(
  input: BrowserDiscovery,
  expectedCourse?: BrowserDiscoveryCourseExpectation,
  persistenceFence?: CourseSupportBrowserPersistenceFence,
  runtimeVersion?: string | null,
  expectedUnownedIncident?: BrowserDiscoveryUnownedIncidentExpectation,
  observedAtInput?: Date,
) {
  const observedAt = resolveTrustedDiscoveryObservedAt(observedAtInput);
  return runSerializedCourseMonitoringWrite(input.courseId, (transaction) =>
    persistenceFence
      ? runCourseSupportBrowserPersistenceWrite({
          transaction,
          fence: persistenceFence,
          runtimeVersion,
          mutate: (ownedTransaction) =>
            applyBrowserDiscoveryToCourseInTransaction(
              input,
              expectedCourse,
              ownedTransaction,
              expectedUnownedIncident,
              observedAt,
            ),
        })
      : applyBrowserDiscoveryToCourseInTransaction(
          input,
          expectedCourse,
          transaction,
          expectedUnownedIncident,
          observedAt,
        ),
  );
}

export function bindBrowserDiscoveryToProviderSnapshot(
  input: BrowserDiscovery,
  providerSnapshotFingerprint: string,
): BrowserDiscovery {
  if (!/^[a-f0-9]{64}$/u.test(providerSnapshotFingerprint)) {
    throw new Error(
      "Browser discovery provider snapshot fingerprint is invalid.",
    );
  }
  const evidence = input.evidence as BrowserDiscovery["evidence"] & {
    browserInvestigation?: unknown;
  };
  const browserInvestigation = evidence.browserInvestigation;
  if (
    !browserInvestigation ||
    typeof browserInvestigation !== "object" ||
    Array.isArray(browserInvestigation)
  ) {
    throw new Error(
      "Snapshot-bound browser discovery requires a browser investigation audit.",
    );
  }
  const existingFingerprint = (browserInvestigation as Record<string, unknown>)
    .providerSnapshotFingerprint;
  if (
    existingFingerprint !== undefined &&
    existingFingerprint !== providerSnapshotFingerprint
  ) {
    throw new Error(
      "Browser discovery provider snapshot fingerprint does not match.",
    );
  }
  return {
    ...input,
    evidence: {
      ...evidence,
      browserInvestigation: {
        ...(browserInvestigation as Record<string, unknown>),
        providerSnapshotFingerprint,
      },
    },
  } as BrowserDiscovery;
}

export async function recordAndApplyOwnedBrowserDiscoveryToCourse(
  projectionInput: BrowserDiscovery,
  persistenceInput: BrowserDiscovery,
  persistenceFence: CourseSupportBrowserPersistenceFence,
  runtimeVersion: string | null | undefined,
  observedProviderSnapshotFingerprint: string,
  providerObservation: CourseProviderObservationLease,
  observedAtInput?: Date,
) {
  const projectionIdentity = { ...projectionInput, evidence: undefined };
  const persistenceIdentity = { ...persistenceInput, evidence: undefined };
  if (
    JSON.stringify(projectionIdentity) !== JSON.stringify(persistenceIdentity)
  ) {
    throw new Error(
      "Browser projection and persistence identities do not match.",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(observedProviderSnapshotFingerprint)) {
    throw new Error(
      "Observed browser provider snapshot fingerprint is invalid.",
    );
  }
  const persistenceEvidence =
    persistenceInput.evidence as BrowserDiscovery["evidence"] & {
      browserInvestigation?: unknown;
    };
  const persistenceAudit = persistenceEvidence.browserInvestigation;
  if (
    !persistenceAudit ||
    typeof persistenceAudit !== "object" ||
    Array.isArray(persistenceAudit)
  ) {
    throw new Error(
      "Owned browser persistence requires a browser investigation audit.",
    );
  }
  if (
    (persistenceAudit as Record<string, unknown>)
      .providerSnapshotFingerprint !== undefined
  ) {
    throw new Error(
      "Caller-supplied browser provider snapshot bindings are not accepted.",
    );
  }
  const observedAt = resolveTrustedDiscoveryObservedAt(observedAtInput);

  return runSerializedCourseMonitoringWrite(
    projectionInput.courseId,
    (transaction) =>
      runCourseSupportBrowserPersistenceWrite({
        transaction,
        fence: persistenceFence,
        runtimeVersion,
        mutate: async (ownedTransaction) => {
          if (
            !(await renewCourseProviderObservationInTransaction(
              ownedTransaction,
              providerObservation,
            ))
          ) {
            throw new Error(
              "Rendered provider observation ownership expired before course persistence completed.",
            );
          }
          const persist = async (input: BrowserDiscovery) =>
            createCourseAutomationDiscoveryWithCourseFence(
              ownedTransaction,
              await attachParkedCampaignToDiscovery(
                ownedTransaction,
                {
                  ...buildBrowserDiscoveryPersistenceData(input),
                  createdAt: observedAt,
                },
                persistenceFence.incidentId,
                persistenceFence.cycle,
              ),
            );

          await ownedTransaction.$queryRaw(
            Prisma.sql`SELECT "id"
                     FROM "Course"
                     WHERE "id" = ${projectionInput.courseId}
                     FOR UPDATE`,
          );
          const preProjectionCourse = await ownedTransaction.course.findUnique({
            where: { id: projectionInput.courseId },
          });
          if (!preProjectionCourse) {
            throw new Error("Browser discovery course no longer exists.");
          }
          if (
            buildCourseSupportProviderSnapshotFingerprint(
              preProjectionCourse,
            ) !== observedProviderSnapshotFingerprint
          ) {
            return {
              applied: null,
              discovery: (await persist(persistenceInput)).discovery,
              providerSnapshotFingerprint: null,
              snapshotBound: false as const,
            };
          }

          const applied = await applyBrowserDiscoveryToCourseInTransaction(
            projectionInput,
            {
              updatedAt: preProjectionCourse.updatedAt,
              detectedBookingUrl: preProjectionCourse.detectedBookingUrl,
              bookingMethod: preProjectionCourse.bookingMethod,
              automationEligibility: preProjectionCourse.automationEligibility,
            },
            ownedTransaction,
            undefined,
            observedAt,
            observedProviderSnapshotFingerprint,
          );
          const resultingCourse =
            applied ??
            (await ownedTransaction.course.findUnique({
              where: { id: projectionInput.courseId },
            }));
          if (!resultingCourse) {
            throw new Error(
              "Browser discovery course no longer exists after projection.",
            );
          }
          const providerSnapshotFingerprint =
            buildCourseSupportProviderSnapshotFingerprint(resultingCourse);
          if (
            !applied &&
            providerSnapshotFingerprint !== observedProviderSnapshotFingerprint
          ) {
            return {
              applied: null,
              discovery: (await persist(persistenceInput)).discovery,
              providerSnapshotFingerprint: null,
              snapshotBound: false as const,
            };
          }
          const persisted = await persist(
            bindBrowserDiscoveryToProviderSnapshot(
              persistenceInput,
              providerSnapshotFingerprint,
            ),
          );
          return {
            applied: applied
              ? { ...applied, updatedAt: persisted.courseUpdatedAt }
              : null,
            discovery: persisted.discovery,
            providerSnapshotFingerprint,
            snapshotBound: true as const,
          };
        },
      }),
  );
}

export async function recordAndApplyBrowserDiscoveryToCourse(
  input: BrowserDiscovery,
  expectedCourse: BrowserDiscoveryCourseExpectation | undefined,
  expectedUnownedIncident?: BrowserDiscoveryUnownedIncidentExpectation,
  options: {
    recordIfNotApplied?: boolean;
    observedAt?: Date;
    providerObservation?: CourseProviderObservationLease;
  } = {},
) {
  const observedAt = resolveTrustedDiscoveryObservedAt(options.observedAt);
  const data = {
    ...buildBrowserDiscoveryPersistenceData(input),
    ...(options.observedAt ? { createdAt: observedAt } : {}),
  };
  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      await assertCourseProviderObservationOwnedForWrite(
        transaction,
        input.courseId,
        options.providerObservation,
      );
      if (
        !(await reserveUnownedIncidentForBrowserDiscovery(
          transaction,
          input.courseId,
          expectedUnownedIncident,
        ))
      ) {
        return null;
      }
      const applied = await applyBrowserDiscoveryToCourseInTransaction(
        input,
        expectedCourse,
        transaction,
        undefined,
        observedAt,
      );
      if (!applied && options.recordIfNotApplied === false) {
        return { applied: null, discovery: null };
      }
      const persisted = await createCourseAutomationDiscoveryWithCourseFence(
        transaction,
        data,
      );
      return {
        applied: applied
          ? { ...applied, updatedAt: persisted.courseUpdatedAt }
          : null,
        discovery: persisted.discovery,
      };
    },
  );
}

async function applyBrowserDiscoveryToCourseInTransaction(
  input: BrowserDiscovery,
  expectedCourse: BrowserDiscoveryCourseExpectation | undefined,
  transaction: Prisma.TransactionClient,
  expectedUnownedIncident:
    BrowserDiscoveryUnownedIncidentExpectation | undefined,
  observedAt: Date,
  expectedProviderSnapshotFingerprint?: string,
) {
  input = normalizeAutomatedTechnicalDiscovery(
    normalizeBrowserDiscoveryForMonitoring(input),
  );
  const provider = resolveProviderCapability({
    detectedPlatform: input.detectedPlatform,
    detectedBookingUrl: input.bookingUrl,
    website: input.sourceUrl,
    bookingMetadata: input.apiMetadata,
  });
  const inspectedProviderIdentity =
    input.status === "INSPECTED"
      ? resolveProviderDiscoveryIdentity({
          detectedPlatform: input.detectedPlatform,
          bookingUrl: input.bookingUrl,
          apiMetadata: input.apiMetadata,
          confidence: input.confidence,
        })
      : null;
  const learnedOnlineAdapter =
    input.status === "LEARNED" && provider.isRunnable;
  const nonRunnableOfficialBookingLink =
    resolveNonRunnableOfficialCourseBookingLinkIdentity(input);
  const claimsNonRunnableOfficialBookingLink =
    input.evidence.learnedFrom ===
      "official-course-non-runnable-booking-link" ||
    input.evidence.courseIdentityCorroboration?.kind ===
      "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK";
  const inspectedProviderRequiresOfficialCourseCorroboration =
    inspectedProviderIdentity?.providerFamilyKey === "MEMBERSPORTS";
  const incomingGate = evaluateBrowserDiscoveryMonitoringGate(input);
  const incomingTerminal = incomingGate.disposition !== "ACTIONABLE";
  const verifiedPrivateIdentity = isVerifiedPrivateIdentityDiscovery(input);
  const verifiedClassification =
    verifiedPrivateIdentity ||
    Boolean(
      input.bookingMethod &&
      input.bookingMethod !== "UNKNOWN" &&
      input.automationEligibility &&
      input.automationEligibility !== "UNKNOWN" &&
      input.confidence >= 0.8,
    );
  const sourceUnavailableClassification =
    isSourceUnavailableClassification(input);

  if (
    !learnedOnlineAdapter &&
    !verifiedClassification &&
    !sourceUnavailableClassification
  ) {
    if (
      claimsNonRunnableOfficialBookingLink &&
      !nonRunnableOfficialBookingLink
    ) {
      return null;
    }
    if (
      inspectedProviderRequiresOfficialCourseCorroboration &&
      !nonRunnableOfficialBookingLink
    ) {
      return null;
    }
    if (!inspectedProviderIdentity && !nonRunnableOfficialBookingLink) {
      return null;
    }

    const current = await transaction.course.findUnique({
      where: { id: input.courseId },
      select: {
        name: true,
        timeZone: true,
        providerFamilyKey: true,
        detectedPlatform: true,
        detectedBookingUrl: true,
        website: true,
        bookingMetadata: true,
        isPublic: true,
        bookingMethod: true,
        bookingWindowDaysAhead: true,
        bookingWindowEvidenceUrl: true,
        bookingReleaseTimeLocal: true,
        bookingWindowSource: true,
        bookingWindowConfidence: true,
        automationEligibility: true,
        automationReason: true,
        bookingAccessMode: true,
        monitoringMode: true,
        layoutHoleCounts: true,
        layoutHolesVerifiedAt: true,
        intelligenceVerifiedAt: true,
        intelligenceReviewAt: true,
        intelligenceConfidence: true,
        monitoringStatus: { select: { state: true } },
        supportIncident: { select: { resolution: true } },
        updatedAt: true,
      },
    });
    if (
      !current ||
      hasAuthoritativeFactualCourseFinal(current) ||
      !matchesBrowserDiscoveryCourseExpectation(current, expectedCourse) ||
      (expectedProviderSnapshotFingerprint !== undefined &&
        buildCourseSupportProviderSnapshotFingerprint(current) !==
          expectedProviderSnapshotFingerprint)
    ) {
      return null;
    }

    const persistedProvider = resolveProviderCapability(current);
    if (nonRunnableOfficialBookingLink) {
      if (
        !canApplyNonRunnableOfficialCourseBookingLink({
          current,
          identity: nonRunnableOfficialBookingLink,
          persistedProviderIsRunnable: persistedProvider.isRunnable,
        })
      ) {
        return null;
      }

      if (
        !(await reserveUnownedIncidentForBrowserDiscovery(
          transaction,
          input.courseId,
          expectedUnownedIncident,
        ))
      ) {
        return null;
      }

      const updated = await transaction.course.updateMany({
        where: { id: input.courseId, updatedAt: current.updatedAt },
        data: {
          detectedPlatform: nonRunnableOfficialBookingLink.detectedPlatform,
          providerFamilyKey: nonRunnableOfficialBookingLink.providerFamilyKey,
          detectedBookingUrl: nonRunnableOfficialBookingLink.bookingUrl,
        },
      });
      if (updated.count !== 1) {
        return null;
      }

      const applied = await transaction.course.findUnique({
        where: { id: input.courseId },
      });
      if (applied) {
        await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
          transaction,
          {
            courseId: input.courseId,
            before: current,
            after: applied,
            providerSnapshotFingerprint:
              buildCourseSupportProviderSnapshotFingerprint(applied),
            source: "COURSE_SUPPORT_RESPONDER",
            now: observedAt,
          },
        );
      }
      return applied;
    }

    if (!inspectedProviderIdentity) {
      return null;
    }

    if (
      persistedProvider.evidenceConflict ||
      persistedProvider.isRunnable ||
      (persistedProvider.capability &&
        persistedProvider.providerFamilyKey !==
          inspectedProviderIdentity.providerFamilyKey)
    ) {
      return null;
    }

    if (
      !(await reserveUnownedIncidentForBrowserDiscovery(
        transaction,
        input.courseId,
        expectedUnownedIncident,
      ))
    ) {
      return null;
    }

    const updated = await transaction.course.updateMany({
      where: { id: input.courseId, updatedAt: current.updatedAt },
      data: {
        detectedPlatform: inspectedProviderIdentity.detectedPlatform,
        providerFamilyKey: inspectedProviderIdentity.providerFamilyKey,
        ...(input.bookingUrl ? { detectedBookingUrl: input.bookingUrl } : {}),
      },
    });
    if (updated.count !== 1) {
      return null;
    }

    const applied = await transaction.course.findUnique({
      where: { id: input.courseId },
    });
    if (applied) {
      await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
        transaction,
        {
          courseId: input.courseId,
          before: current,
          after: applied,
          providerSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(applied),
          source: "COURSE_SUPPORT_RESPONDER",
          now: observedAt,
        },
      );
    }
    return applied;
  }

  const bookingMethod = input.bookingMethod ?? "PUBLIC_ONLINE";
  const automationEligibility = input.automationEligibility ?? "ALLOWED";
  const manualOnly =
    automationEligibility === "BLOCKED" &&
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(bookingMethod);
  const officialRequestUrl =
    bookingMethod === "CONTACT_COURSE" &&
    input.bookingUrl &&
    input.bookingUrl !== input.sourceUrl
      ? input.bookingUrl
      : null;

  const current = await transaction.course.findUnique({
    where: { id: input.courseId },
    select: {
      name: true,
      timeZone: true,
      providerFamilyKey: true,
      detectedPlatform: true,
      detectedBookingUrl: true,
      website: true,
      bookingMetadata: true,
      isPublic: true,
      bookingMethod: true,
      bookingWindowDaysAhead: true,
      bookingWindowEvidenceUrl: true,
      bookingReleaseTimeLocal: true,
      bookingWindowSource: true,
      bookingWindowConfidence: true,
      automationEligibility: true,
      automationReason: true,
      bookingAccessMode: true,
      monitoringMode: true,
      layoutHoleCounts: true,
      layoutHolesVerifiedAt: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      monitoringStatus: { select: { state: true } },
      supportIncident: { select: { resolution: true } },
      updatedAt: true,
    },
  });
  if (
    !current ||
    hasAuthoritativeFactualCourseFinal(current) ||
    !matchesBrowserDiscoveryCourseExpectation(current, expectedCourse) ||
    (expectedProviderSnapshotFingerprint !== undefined &&
      buildCourseSupportProviderSnapshotFingerprint(current) !==
        expectedProviderSnapshotFingerprint)
  ) {
    return null;
  }
  const persistedProvider = resolveProviderCapability(current);
  const persistedGate = evaluateMonitoringGate(current);
  const differentKnownProvider = Boolean(
    persistedProvider.capability &&
    provider.capability &&
    persistedProvider.providerFamilyKey !== provider.providerFamilyKey,
  );
  const replacingLegacyPolicyOnlyBlock = Boolean(
    expectedCourse &&
    input.status === "VERIFIED" &&
    verifiedClassification &&
    current.automationEligibility === "BLOCKED" &&
    current.automationReason === "AUTOMATION_PROHIBITED" &&
    input.automationReason !== "AUTOMATION_PROHIBITED",
  );
  const persistedMetadataStale =
    persistedGate.requiresRevalidation || !persistedGate.currentEvidence;
  const corroboratedLearnedReplacement = Boolean(
    learnedOnlineAdapter &&
    persistedGate.adapterAllowed &&
    persistedMetadataStale &&
    hasPersistedOfficialCourseProviderCorroboration(
      input,
      current.website,
      current.name,
    ),
  );
  const corroboratedPrivateReopening = Boolean(
    learnedOnlineAdapter &&
    current.isPublic === false &&
    hasPersistedOfficialCourseProviderCorroboration(
      input,
      current.website,
      current.name,
    ),
  );
  const corroboratedPendingPublicCourse = Boolean(
    current.isPublic === null &&
    (learnedOnlineAdapter ||
      (verifiedClassification && input.bookingMethod === "PUBLIC_ONLINE")) &&
    hasPersistedOfficialCourseProviderCorroboration(
      input,
      current.website,
      current.name,
    ),
  );
  const trustedPersistedReplacement =
    replacingLegacyPolicyOnlyBlock ||
    corroboratedLearnedReplacement ||
    corroboratedPrivateReopening ||
    corroboratedPendingPublicCourse;
  const sourceUnavailableWouldReplaceProviderState = Boolean(
    sourceUnavailableClassification &&
    !canApplySourceUnavailableClassification({
      current,
      discovery: input,
      persistedProviderFamilyKey: persistedProvider.providerFamilyKey,
      persistedProviderKnown: Boolean(persistedProvider.capability),
      persistedProviderConflict: persistedProvider.evidenceConflict,
    }),
  );
  const lowerAuthorityManualWouldReplaceRunnableProvider = Boolean(
    manualOnly &&
    persistedProvider.isRunnable &&
    !isAuthoritativeManualReplacement(input),
  );
  if (
    provider.evidenceConflict ||
    (persistedProvider.evidenceConflict && !trustedPersistedReplacement) ||
    (current.isPublic === false &&
      !verifiedPrivateIdentity &&
      !corroboratedPrivateReopening) ||
    sourceUnavailableWouldReplaceProviderState ||
    lowerAuthorityManualWouldReplaceRunnableProvider ||
    (learnedOnlineAdapter &&
      !persistedGate.adapterAllowed &&
      !corroboratedPrivateReopening) ||
    (!learnedOnlineAdapter &&
      !incomingTerminal &&
      persistedProvider.isRunnable &&
      !replacingLegacyPolicyOnlyBlock) ||
    (differentKnownProvider && !trustedPersistedReplacement)
  ) {
    return null;
  }

  if (
    !(await reserveUnownedIncidentForBrowserDiscovery(
      transaction,
      input.courseId,
      expectedUnownedIncident,
    ))
  ) {
    return null;
  }

  const updated = await transaction.course.updateMany({
    where: { id: input.courseId, updatedAt: current.updatedAt },
    data: sourceUnavailableClassification
      ? {
          automationEligibility,
          bookingMethod,
          automationReason: input.automationReason ?? "NONE",
          policyNotes: input.policyNotes,
          intelligenceVerifiedAt: observedAt,
          intelligenceReviewAt: new Date(input.intelligenceReviewAt!),
          intelligenceConfidence: input.confidence,
        }
      : verifiedPrivateIdentity
        ? {
            isPublic: false,
            bookingMethod: "UNKNOWN",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER",
            bookingAccessMode: "UNKNOWN",
            policyNotes: input.policyNotes,
            intelligenceVerifiedAt: observedAt,
            intelligenceReviewAt: new Date(input.intelligenceReviewAt!),
            intelligenceConfidence: input.confidence,
          }
        : {
            ...(corroboratedPrivateReopening || corroboratedPendingPublicCourse
              ? { isPublic: true, policyNotes: null }
              : { policyNotes: input.policyNotes }),
            detectedPlatform: input.detectedPlatform,
            providerFamilyKey: provider.providerFamilyKey,
            automationEligibility,
            detectedBookingUrl: manualOnly
              ? officialRequestUrl
              : input.bookingUrl,
            bookingMetadata: manualOnly
              ? Prisma.DbNull
              : (input.apiMetadata as Prisma.InputJsonValue),
            bookingMethod,
            bookingAccessMode: resolveBookingAccessMode({
              automationEligibility,
              automationReason: input.automationReason,
              bookingMethod,
              bookingAccessMode: input.bookingAccessMode,
            }),
            bookingPhone: corroboratedPrivateReopening
              ? (input.bookingPhone ?? null)
              : input.bookingPhone,
            automationReason: input.automationReason ?? "NONE",
            intelligenceVerifiedAt: observedAt,
            intelligenceReviewAt: input.intelligenceReviewAt
              ? new Date(input.intelligenceReviewAt)
              : null,
            intelligenceConfidence: input.confidence,
          },
  });
  if (updated.count !== 1) {
    return null;
  }

  const applied = await transaction.course.findUnique({
    where: { id: input.courseId },
  });
  if (applied) {
    await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
      transaction,
      {
        courseId: input.courseId,
        before: current,
        after: applied,
        providerSnapshotFingerprint:
          buildCourseSupportProviderSnapshotFingerprint(applied),
        source: "COURSE_SUPPORT_RESPONDER",
        now: observedAt,
      },
    );
  }
  return applied;
}

const AUTHORITATIVE_MANUAL_REPLACEMENT_SOURCES = new Set([
  "official-phone-only-tee-time-access",
  "official-public-play-request-form",
  "official-walk-in-only-tee-time-access",
  "chronogolf-public-club-profile",
]);

function isAuthoritativeManualReplacement(input: BrowserDiscovery) {
  if (
    input.status !== "VERIFIED" ||
    input.automationEligibility !== "BLOCKED" ||
    input.automationReason !== "NO_ONLINE_BOOKING" ||
    !input.bookingMethod ||
    !["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      input.bookingMethod,
    ) ||
    input.confidence < 0.95 ||
    !AUTHORITATIVE_MANUAL_REPLACEMENT_SOURCES.has(input.evidence.learnedFrom)
  ) {
    return false;
  }

  if (input.bookingMethod === "PHONE_ONLY") {
    const digits = input.bookingPhone?.replace(/\D/gu, "") ?? "";
    if (digits.length < 7 || digits.length > 15) {
      return false;
    }
  }

  const source = parseSafePublicUrl(input.sourceUrl);
  const finalUrl = parseSafePublicUrl(
    input.evidence.finalUrl ?? input.sourceUrl,
  );
  return Boolean(
    source &&
    finalUrl &&
    haveSameCourseWebsiteOrigin(source, finalUrl) &&
    input.evidence.observedUrls.some((url) => {
      const observed = parseSafePublicUrl(url);
      return Boolean(observed && haveSameCourseWebsiteOrigin(source, observed));
    }),
  );
}

async function reserveUnownedIncidentForBrowserDiscovery(
  transaction: Prisma.TransactionClient,
  courseId: string,
  expected: BrowserDiscoveryUnownedIncidentExpectation | undefined,
) {
  if (!expected) return true;
  const reserved = await transaction.courseSupportIncident.updateMany({
    where: {
      id: expected.id,
      courseId,
      cycle: expected.cycle,
      revision: expected.revision,
      status: expected.status,
      activeBatchId: null,
    },
    data: { revision: { increment: 0 } },
  });
  return reserved.count === 1;
}

function normalizeAutomatedTechnicalDiscovery(
  discovery: BrowserDiscovery,
): BrowserDiscovery {
  const gate = evaluateBrowserDiscoveryMonitoringGate(discovery);
  if (gate.disposition !== "TECHNICAL_FINAL") {
    return discovery;
  }
  return {
    ...discovery,
    status: "INSPECTED",
    automationEligibility: "NEEDS_REVIEW",
    intelligenceReviewAt: undefined,
    confidence: Math.min(discovery.confidence, 0.99),
    evidence: {
      ...discovery.evidence,
      learnedFrom: `${discovery.evidence.learnedFrom}:engineering-approval-required`,
    },
  };
}

function isSourceUnavailableClassification(input: BrowserDiscovery) {
  const source = parseSafePublicUrl(input.sourceUrl);
  const finalUrl = parseSafePublicUrl(input.evidence.finalUrl ?? "");
  const reviewAt = input.intelligenceReviewAt
    ? new Date(input.intelligenceReviewAt)
    : null;
  const now = Date.now();
  if (
    input.status !== "INSPECTED" ||
    input.detectedPlatform !== "UNKNOWN" ||
    input.bookingMethod !== "UNKNOWN" ||
    input.automationEligibility !== "NEEDS_REVIEW" ||
    input.automationReason !== "TEMPORARILY_UNAVAILABLE" ||
    input.evidence.learnedFrom !== "official-site-soft-not-found" ||
    input.policyNotes !== OFFICIAL_SITE_SOFT_NOT_FOUND_POLICY_NOTES ||
    input.bookingUrl !== undefined ||
    input.apiEndpoint !== undefined ||
    input.apiMetadata !== undefined ||
    input.bookingPhone !== undefined ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0.9 ||
    input.confidence > 1 ||
    !source ||
    source.search ||
    source.hash ||
    !finalUrl ||
    finalUrl.search ||
    finalUrl.hash ||
    !haveSameCourseWebsiteOrigin(source, finalUrl) ||
    !reviewAt ||
    Number.isNaN(reviewAt.getTime()) ||
    reviewAt.getTime() < now + 6 * 24 * 60 * 60 * 1000 ||
    reviewAt.getTime() > now + 8 * 24 * 60 * 60 * 1000
  ) {
    return false;
  }
  if (
    Object.keys(input.evidence).some(
      (key) => !["finalUrl", "learnedFrom", "observedUrls"].includes(key),
    )
  ) {
    return false;
  }
  const expectedUrls = new Set([source.toString(), finalUrl.toString()]);
  return Boolean(
    input.evidence.observedUrls.length === expectedUrls.size &&
    input.evidence.observedUrls.every((value) => expectedUrls.has(value)),
  );
}

function canApplySourceUnavailableClassification(input: {
  current: {
    providerFamilyKey: string | null;
    detectedPlatform: string | null;
    detectedBookingUrl: string | null;
    website: string | null;
    bookingMetadata: unknown;
    isPublic: boolean | null;
    bookingMethod: string | null;
    automationEligibility: string | null;
    automationReason: string | null;
  };
  discovery: BrowserDiscovery;
  persistedProviderFamilyKey: string;
  persistedProviderKnown: boolean;
  persistedProviderConflict: boolean;
}) {
  const { current, discovery } = input;
  const website = current.website ? parseSafePublicUrl(current.website) : null;
  const source = parseSafePublicUrl(discovery.sourceUrl);
  if (!website || !source) {
    return false;
  }
  const normalizePath = (url: URL) => {
    try {
      return decodeURIComponent(url.pathname).replace(/\/+$/u, "") || "/";
    } catch {
      return null;
    }
  };
  const officialFamily = normalizeProviderFamilyKey(website.hostname);
  const currentFamily = normalizeProviderFamilyKey(current.providerFamilyKey);
  const currentFamilyIsOfficialPlaceholder =
    currentFamily === SOURCE_MISSING_PROVIDER_FAMILY ||
    currentFamily === officialFamily;

  return Boolean(
    currentFamilyIsOfficialPlaceholder &&
    input.persistedProviderFamilyKey === officialFamily &&
    !input.persistedProviderKnown &&
    !input.persistedProviderConflict &&
    !resolveProviderCapability({ website: current.website }).capability &&
    haveSameCourseWebsiteOrigin(website, source) &&
    normalizePath(website) === normalizePath(source) &&
    normalizePath(website) !== null &&
    current.isPublic !== false &&
    (!current.detectedPlatform || current.detectedPlatform === "UNKNOWN") &&
    !current.detectedBookingUrl &&
    (current.bookingMetadata === null ||
      current.bookingMetadata === undefined) &&
    (!current.bookingMethod || current.bookingMethod === "UNKNOWN") &&
    (!current.automationEligibility ||
      ["UNKNOWN", "NEEDS_REVIEW"].includes(current.automationEligibility)) &&
    (!current.automationReason ||
      ["NONE", "TEMPORARILY_UNAVAILABLE"].includes(current.automationReason)),
  );
}

function matchesBrowserDiscoveryCourseExpectation(
  current: BrowserDiscoveryCourseExpectation,
  expected?: BrowserDiscoveryCourseExpectation,
) {
  return Boolean(
    !expected ||
    (current.updatedAt.getTime() === expected.updatedAt.getTime() &&
      current.detectedBookingUrl === expected.detectedBookingUrl &&
      current.bookingMethod === expected.bookingMethod &&
      current.automationEligibility === expected.automationEligibility),
  );
}

const VERIFIED_PRIVATE_IDENTITY_POLICY_NOTES = new Map([
  [
    "official-private-course-profile",
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory.",
  ],
  [
    "official-private-club-access",
    "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
  [
    "official-resident-member-access",
    "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course.",
  ],
]);

function isVerifiedPrivateIdentityDiscovery(
  discovery: BrowserDiscovery,
  now = new Date(),
) {
  const learnedFrom = discovery.evidence.learnedFrom;
  const [baseLearnedFrom, ...provenanceMarkers] = learnedFrom.split(":");
  const validProvenance =
    provenanceMarkers.length === 0 ||
    (provenanceMarkers.length === 1 &&
      provenanceMarkers[0] === "legacy-policy-reconciliation");
  const expectedPolicyNotes = validProvenance
    ? VERIFIED_PRIVATE_IDENTITY_POLICY_NOTES.get(baseLearnedFrom)
    : undefined;
  const source = parseSafePublicUrl(discovery.sourceUrl);
  const booking = parseSafePublicUrl(discovery.bookingUrl ?? "");
  const finalUrl = parseSafePublicUrl(discovery.evidence.finalUrl ?? "");
  const reviewAt = discovery.intelligenceReviewAt
    ? new Date(discovery.intelligenceReviewAt)
    : null;
  const maximumReviewAt = new Date(now.getTime() + 181 * 24 * 60 * 60 * 1000);
  return Boolean(
    discovery.isPublic === false &&
    discovery.status === "VERIFIED" &&
    discovery.detectedPlatform === "UNKNOWN" &&
    (discovery.bookingMethod ?? "UNKNOWN") === "UNKNOWN" &&
    discovery.bookingPhone === undefined &&
    discovery.automationEligibility === "BLOCKED" &&
    discovery.automationReason === "OTHER" &&
    discovery.apiEndpoint === undefined &&
    discovery.apiMetadata === undefined &&
    discovery.confidence === 0.98 &&
    expectedPolicyNotes &&
    discovery.policyNotes === expectedPolicyNotes &&
    source &&
    booking &&
    finalUrl &&
    source.toString() === booking.toString() &&
    source.toString() === finalUrl.toString() &&
    discovery.evidence.observedUrls.includes(source.toString()) &&
    Boolean(discovery.evidence.visibleText?.trim()) &&
    reviewAt &&
    !Number.isNaN(reviewAt.getTime()) &&
    reviewAt.getTime() > now.getTime() &&
    reviewAt.getTime() <= maximumReviewAt.getTime(),
  );
}

function normalizeBrowserDiscoveryForMonitoring(
  discovery: BrowserDiscovery,
): BrowserDiscovery {
  const normalized = keepPolicyOnlyDiscoveryActionable(discovery);
  const gate = evaluateBrowserDiscoveryMonitoringGate(normalized);
  const manualFieldsPresent =
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      normalized.bookingMethod ?? "",
    ) || normalized.automationReason === "NO_ONLINE_BOOKING";
  const verifiedPrivateIdentity =
    isVerifiedPrivateIdentityDiscovery(normalized) &&
    gate.disposition === "IDENTITY_FINAL";
  const incoherentPrivateIdentity =
    normalized.isPublic === false && !verifiedPrivateIdentity;
  const incoherentManualDisposition =
    manualFieldsPresent &&
    gate.disposition !== "MANUAL_FINAL" &&
    !verifiedPrivateIdentity;
  const nonTerminalBlock =
    normalized.automationEligibility === "BLOCKED" &&
    gate.disposition === "ACTIONABLE";
  if (
    !incoherentPrivateIdentity &&
    !incoherentManualDisposition &&
    !nonTerminalBlock
  ) {
    return normalized;
  }

  return {
    ...normalized,
    isPublic: incoherentPrivateIdentity ? undefined : normalized.isPublic,
    status: ["LEARNED", "VERIFIED", "BLOCKED"].includes(normalized.status)
      ? "INSPECTED"
      : normalized.status,
    automationEligibility: "NEEDS_REVIEW",
    intelligenceReviewAt: undefined,
    confidence: Math.min(normalized.confidence, 0.79),
    evidence: {
      ...normalized.evidence,
      learnedFrom: `${normalized.evidence.learnedFrom}:${
        incoherentPrivateIdentity
          ? "incoherent-private-identity"
          : incoherentManualDisposition
            ? "incoherent-manual-disposition"
            : "non-terminal-block"
      }`,
    },
  };
}

function hasPersistedOfficialCourseProviderCorroboration(
  discovery: BrowserDiscovery,
  persistedWebsite: string | null,
  persistedCourseName?: string,
) {
  const proof = discovery.evidence.courseIdentityCorroboration;
  if (
    proof?.kind !== "OFFICIAL_COURSE_PROVIDER_LINK" ||
    !persistedWebsite ||
    !discovery.bookingUrl ||
    (persistedCourseName !== undefined &&
      (!proof.courseName ||
        !haveCompatibleCourseNames(persistedCourseName, proof.courseName)))
  ) {
    return false;
  }
  const persisted = parseSafePublicUrl(persistedWebsite);
  const source = parseSafePublicUrl(discovery.sourceUrl);
  const proofWebsite = parseSafePublicUrl(proof.officialWebsiteUrl);
  const proofPage = parseSafePublicUrl(proof.officialPageUrl);
  const proofProvider = parseSafePublicUrl(proof.providerUrl);
  const discoveredProvider = parseSafePublicUrl(discovery.bookingUrl);
  if (
    !persisted ||
    !source ||
    !proofWebsite ||
    !proofPage ||
    !proofProvider ||
    !discoveredProvider ||
    resolveProviderCapability({ detectedBookingUrl: persisted.toString() })
      .capability
  ) {
    return false;
  }
  return (
    haveSameCourseWebsiteOrigin(persisted, proofWebsite) &&
    haveSameCourseWebsiteOrigin(persisted, proofPage) &&
    haveSameCourseWebsiteOrigin(persisted, source) &&
    proofProvider.toString() === discoveredProvider.toString()
  );
}

function resolveNonRunnableOfficialCourseBookingLinkIdentity(
  discovery: BrowserDiscovery,
) {
  const proof = discovery.evidence.courseIdentityCorroboration;
  const bookingUrl = parseSafePublicUrl(discovery.bookingUrl ?? "");
  const sourceUrl = parseSafePublicUrl(discovery.sourceUrl);
  const officialWebsiteUrl = parseSafePublicUrl(
    proof?.officialWebsiteUrl ?? "",
  );
  const officialPageUrl = parseSafePublicUrl(proof?.officialPageUrl ?? "");
  const providerUrl = parseSafePublicUrl(proof?.providerUrl ?? "");
  const provider = resolveProviderCapability({
    detectedPlatform: discovery.detectedPlatform,
    detectedBookingUrl: discovery.bookingUrl,
    website: discovery.sourceUrl,
    bookingMetadata: discovery.apiMetadata,
  });
  if (
    discovery.status !== "INSPECTED" ||
    discovery.evidence.learnedFrom !==
      "official-course-non-runnable-booking-link" ||
    discovery.evidence.bookingCallToAction !== true ||
    proof?.kind !== "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK" ||
    !proof.courseName ||
    discovery.confidence < 0.8 ||
    discovery.confidence > 1 ||
    discovery.bookingMethod !== undefined ||
    discovery.bookingPhone !== undefined ||
    discovery.automationEligibility !== undefined ||
    discovery.automationReason !== undefined ||
    discovery.bookingAccessMode !== undefined ||
    discovery.policyNotes !== undefined ||
    discovery.intelligenceReviewAt !== undefined ||
    discovery.apiEndpoint !== undefined ||
    discovery.apiMetadata !== undefined ||
    !bookingUrl ||
    !sourceUrl ||
    !officialWebsiteUrl ||
    !officialPageUrl ||
    !providerUrl ||
    !isSafeManualEvidenceUrl(bookingUrl) ||
    !isSafeManualEvidenceUrl(sourceUrl) ||
    !isSafeManualEvidenceUrl(officialWebsiteUrl) ||
    !isSafeManualEvidenceUrl(officialPageUrl) ||
    !isSafeManualEvidenceUrl(providerUrl) ||
    sourceUrl.toString() !== officialPageUrl.toString() ||
    bookingUrl.toString() !== providerUrl.toString() ||
    haveSameCourseWebsiteOrigin(officialPageUrl, providerUrl) ||
    !discovery.evidence.observedUrls.some((url) => {
      const observed = parseSafePublicUrl(url);
      return observed?.toString() === providerUrl.toString();
    }) ||
    provider.evidenceConflict ||
    provider.isRunnable ||
    provider.capability?.supportsAutomation ||
    (provider.capability &&
      (!isProviderPublicBookingLandingUrl(bookingUrl) ||
        !getProviderPublicBookingLandingIdentity(bookingUrl)))
  ) {
    return null;
  }

  return {
    bookingUrl: bookingUrl.toString(),
    detectedPlatform: provider.detectedPlatform,
    providerFamilyKey: provider.providerFamilyKey,
    courseName: proof.courseName,
    officialWebsiteUrl,
    officialPageUrl,
  };
}

function canApplyNonRunnableOfficialCourseBookingLink(input: {
  current: {
    name: string;
    providerFamilyKey: string | null;
    detectedPlatform: string | null;
    detectedBookingUrl: string | null;
    website: string | null;
    bookingMetadata: unknown;
    isPublic: boolean | null;
    bookingMethod: string | null;
    automationEligibility: string | null;
    automationReason: string | null;
    bookingAccessMode: string | null;
  };
  identity: NonNullable<
    ReturnType<typeof resolveNonRunnableOfficialCourseBookingLinkIdentity>
  >;
  persistedProviderIsRunnable: boolean;
}) {
  const { current, identity } = input;
  const persistedWebsite = parseSafePublicUrl(current.website ?? "");
  const currentBookingUrl = parseSafePublicUrl(
    current.detectedBookingUrl ?? "",
  );
  if (!persistedWebsite || !isSafeManualEvidenceUrl(persistedWebsite)) {
    return false;
  }

  const currentProviderFamily = normalizeProviderFamilyKey(
    current.providerFamilyKey,
  );
  const officialProviderFamily = normalizeProviderFamilyKey(
    persistedWebsite.hostname,
  );
  const currentFamilyIsSafePlaceholder =
    currentProviderFamily === SOURCE_MISSING_PROVIDER_FAMILY ||
    normalizeProviderHostnameFamily(currentProviderFamily) ===
      normalizeProviderHostnameFamily(officialProviderFamily) ||
    currentProviderFamily === identity.providerFamilyKey;

  return Boolean(
    currentFamilyIsSafePlaceholder &&
    !input.persistedProviderIsRunnable &&
    current.isPublic !== false &&
    (!current.detectedPlatform ||
      ["UNKNOWN", "CUSTOM"].includes(current.detectedPlatform)) &&
    (!currentBookingUrl ||
      currentBookingUrl.toString() === identity.bookingUrl) &&
    (current.bookingMetadata === null ||
      current.bookingMetadata === undefined) &&
    (!current.bookingMethod || current.bookingMethod === "UNKNOWN") &&
    (!current.automationEligibility ||
      ["UNKNOWN", "NEEDS_REVIEW"].includes(current.automationEligibility)) &&
    (!current.bookingAccessMode || current.bookingAccessMode === "UNKNOWN") &&
    (!current.automationReason ||
      [
        "NONE",
        "UNSUPPORTED_PLATFORM",
        "TEMPORARILY_UNAVAILABLE",
        "OTHER",
      ].includes(current.automationReason)) &&
    haveCompatibleOfficialPageCourseNames(current.name, identity.courseName) &&
    persistedWebsite.toString() === identity.officialWebsiteUrl.toString() &&
    haveSameCourseWebsiteOrigin(persistedWebsite, identity.officialPageUrl),
  );
}

function normalizeProviderHostnameFamily(value: string) {
  return value.toLowerCase().replace(/^www\./u, "");
}

function parseSafePublicUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}

function haveSameCourseWebsiteOrigin(left: URL, right: URL) {
  const normalizeHostname = (hostname: string) =>
    hostname.toLowerCase().replace(/^www\./u, "");
  return (
    (left.protocol === right.protocol ||
      (left.protocol === "http:" && right.protocol === "https:")) &&
    normalizeHostname(left.hostname) === normalizeHostname(right.hostname) &&
    left.port === right.port
  );
}

export type TeeTimeMatchObservationInput = {
  searchId: string;
  alertGeneration?: number;
  courseId: string;
  sourceId: string;
  startsAt: Date;
  availableSpots: number;
  bookingUrl: string;
  priceCents?: number;
  holes?: number;
  evidenceUrl?: string;
  observedAt?: Date;
  transaction?: Prisma.TransactionClient;
};

export async function recordTeeTimeMatch(input: TeeTimeMatchObservationInput) {
  const client = input.transaction ?? prisma;
  const existing = await client.teeTimeMatch.findUnique({
    where: {
      teeSearchId_courseId_sourceId_startsAt: {
        teeSearchId: input.searchId,
        courseId: input.courseId,
        sourceId: input.sourceId,
        startsAt: input.startsAt,
      },
    },
    select: {
      id: true,
      alertStatus: true,
      availabilityStatus: true,
      unavailableAt: true,
      availabilityCycle: true,
      lastConfirmedAt: true,
    },
  });

  const confirmedAt = input.observedAt ?? new Date();
  const shouldAlertReopenedMatch = Boolean(
    existing?.availabilityStatus === "GONE" &&
    (!existing.unavailableAt ||
      confirmedAt.getTime() - existing.unavailableAt.getTime() >=
        REOPEN_ALERT_MINIMUM_ABSENCE_MS),
  );
  if (
    input.alertGeneration !== undefined &&
    existing &&
    ["PENDING", "SENT"].includes(existing.alertStatus) &&
    existing.availabilityStatus === "AVAILABLE" &&
    existing.lastConfirmedAt instanceof Date &&
    confirmedAt > existing.lastConfirmedAt
  ) {
    await reactivateTerminalUnresolvedMatchDeliveries(client, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      matchId: existing.id,
      availabilityCycle: existing.availabilityCycle,
      retryAt: confirmedAt,
    });
  }
  return client.teeTimeMatch.upsert({
    where: {
      teeSearchId_courseId_sourceId_startsAt: {
        teeSearchId: input.searchId,
        courseId: input.courseId,
        sourceId: input.sourceId,
        startsAt: input.startsAt,
      },
    },
    update: {
      lastSeenAt: confirmedAt,
      lastConfirmedAt: confirmedAt,
      availabilityStatus: "AVAILABLE",
      unavailableAt: null,
      ...(shouldAlertReopenedMatch
        ? {
            alertStatus: "PENDING",
            sentAt: null,
            availabilityCycle: { increment: 1 },
          }
        : {}),
      availableSpots: input.availableSpots,
      bookingUrl: input.bookingUrl,
      priceCents: input.priceCents,
      holes: input.holes,
      evidenceUrl: input.evidenceUrl,
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
      evidenceUrl: input.evidenceUrl,
    },
  });
}

export async function markMissingMatchesUnavailable(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  courseId: string;
  date: string;
  timeZone: string;
  confirmedMatches: Array<{ sourceId: string; startsAt: Date }>;
  observedAt?: Date;
  transaction?: Prisma.TransactionClient;
}) {
  const dayStart = zonedDateTimeToDate(
    `${input.date}T00:00:00`,
    input.timeZone,
  );
  const dayEnd = zonedDateTimeToDate(
    `${addIsoDateDays(input.date, 1)}T00:00:00`,
    input.timeZone,
  );

  const missingMatchWhere: Prisma.TeeTimeMatchWhereInput = {
    teeSearchId: input.searchId,
    courseId: input.courseId,
    availabilityStatus: "AVAILABLE" as const,
    startsAt: {
      gte: dayStart,
      lt: dayEnd,
    },
    ...(input.confirmedMatches.length > 0
      ? {
          NOT: input.confirmedMatches.map((match) => ({
            sourceId: match.sourceId,
            startsAt: match.startsAt,
          })),
        }
      : {}),
  };
  const unavailableAt = input.observedAt ?? new Date();

  const reconcile = async (transaction: Prisma.TransactionClient) => {
    const search = await lockSearchForEmailReconciliation(transaction, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      now: unavailableAt,
    });
    if (!search) {
      throw new Error(
        "Search check is no longer current during availability reconciliation",
      );
    }
    const pendingMatches = await transaction.teeTimeMatch.findMany({
      where: {
        ...missingMatchWhere,
        alertStatus: "PENDING",
      },
      select: { id: true, availabilityCycle: true },
    });
    await suppressSearchEmailDeliveriesForMatches({
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      matchRefs: pendingMatches.map((match) => ({
        matchId: match.id,
        availabilityCycle: match.availabilityCycle,
      })),
      now: unavailableAt,
      transaction,
    });
    const suppressed = await transaction.teeTimeMatch.updateMany({
      where: {
        ...missingMatchWhere,
        alertStatus: "PENDING",
      },
      data: {
        alertStatus: "SUPPRESSED",
        availabilityStatus: "GONE",
        sentAt: unavailableAt,
        unavailableAt,
      },
    });
    const reconciled = await transaction.teeTimeMatch.updateMany({
      where: {
        ...missingMatchWhere,
        alertStatus: { not: "PENDING" },
      },
      data: {
        availabilityStatus: "GONE",
        unavailableAt,
      },
    });
    return [suppressed, reconciled];
  };

  return input.transaction
    ? reconcile(input.transaction)
    : prisma.$transaction(reconcile);
}

export async function commitCurrentCourseTeeTimeMatches(input: {
  searchId: string;
  alertGeneration: number;
  checkLeaseToken: string;
  courseId: string;
  date: string;
  timeZone: string;
  providerObservedAt: Date;
  providerObservation?: CourseProviderObservationLease;
  localReaderObservation?: {
    jobId: string;
    scheduleVersion: number;
    resultStatus: "AVAILABLE" | "NO_AVAILABILITY";
    monitoringOutcome: "MATCH_FOUND" | "NO_MATCH";
    resumePreviouslyAcceptedSource?: boolean;
  };
  sourceKind: "SUCCESS" | "FAILURE";
  bookingWindowEvidence?: BookingWindowEvidence;
  markBookingWindowChecked?: boolean;
  pricing?: CoursePriceEstimate;
  bookableHoleCounts?: readonly BookableHoleCount[];
  reconcileMatches?: boolean;
  matches: Array<
    Omit<
      TeeTimeMatchObservationInput,
      "searchId" | "courseId" | "observedAt" | "transaction"
    >
  >;
}) {
  if (
    !(input.providerObservedAt instanceof Date) ||
    !Number.isFinite(input.providerObservedAt.getTime())
  ) {
    throw new Error(
      "Course match persistence requires a valid provider observation time",
    );
  }
  if (
    input.sourceKind === "FAILURE" &&
    (input.matches.length > 0 ||
      input.reconcileMatches !== false ||
      input.bookingWindowEvidence !== undefined ||
      input.markBookingWindowChecked !== undefined ||
      input.pricing !== undefined ||
      input.bookableHoleCounts !== undefined)
  ) {
    throw new Error(
      "Failed provider observations cannot mutate customer matches or booking facts",
    );
  }
  if (input.bookingWindowEvidence && input.markBookingWindowChecked) {
    throw new Error(
      "Course observation persistence cannot apply booking-window evidence and a checked-only update together",
    );
  }
  if (
    input.providerObservation &&
    input.providerObservation.courseId !== input.courseId
  ) {
    throw new Error(
      "Course match persistence provider observation does not match the course",
    );
  }
  if (
    input.localReaderObservation &&
    (input.sourceKind !== "SUCCESS" ||
      !input.localReaderObservation.jobId.trim() ||
      input.localReaderObservation.scheduleVersion < 0 ||
      !Number.isSafeInteger(input.localReaderObservation.scheduleVersion))
  ) {
    throw new Error(
      "Course match persistence local-reader observation is invalid",
    );
  }

  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      if (
        input.providerObservation &&
        !(await renewCourseProviderObservationInTransaction(
          transaction,
          input.providerObservation,
        ))
      ) {
        throw new Error(
          "Provider observation ownership expired before course match persistence completed",
        );
      }
      const expectedSourceIsCurrent = await isCurrentCourseMonitoringSource(
        transaction,
        {
          courseId: input.courseId,
          providerObservedAt: input.providerObservedAt,
          sourceKind: input.sourceKind,
        },
      );
      if (!expectedSourceIsCurrent) {
        return {
          sourceEvidenceAccepted: false as const,
          persistedMatchStates: [] as Array<{
            matchId?: string;
            isPending: boolean;
          }>,
        };
      }
      if (
        input.localReaderObservation?.resumePreviouslyAcceptedSource &&
        !(await hasExactAcceptedLocalReaderMonitoringSource(transaction, {
          courseId: input.courseId,
          searchId: input.searchId,
          providerObservedAt: input.providerObservedAt,
          jobId: input.localReaderObservation.jobId,
          scheduleVersion: input.localReaderObservation.scheduleVersion,
          resultStatus: input.localReaderObservation.resultStatus,
          monitoringOutcome: input.localReaderObservation.monitoringOutcome,
        }))
      ) {
        return {
          sourceEvidenceAccepted: false as const,
          persistedMatchStates: [] as Array<{
            matchId?: string;
            isPending: boolean;
          }>,
        };
      }

      if (input.bookingWindowEvidence) {
        await recordCourseBookingWindowEvidenceInTransaction(transaction, {
          courseId: input.courseId,
          evidence: input.bookingWindowEvidence,
          observedAt: input.providerObservedAt,
          source: "SEARCH_WORKFLOW",
        });
      } else if (input.markBookingWindowChecked) {
        await markCourseBookingWindowCheckedInTransaction(
          transaction,
          input.courseId,
          input.providerObservedAt,
        );
      }
      if (input.bookableHoleCounts !== undefined) {
        await recordCourseBookingFacts({
          courseId: input.courseId,
          pricing: input.pricing,
          bookableHoleCounts: input.bookableHoleCounts,
          observedAt: input.providerObservedAt,
          transaction,
        });
      }

      const persistedMatchStates: Array<{
        matchId?: string;
        isPending: boolean;
      }> = [];
      for (const match of input.matches) {
        const persistedMatch = await recordTeeTimeMatch({
          ...match,
          searchId: input.searchId,
          alertGeneration: input.alertGeneration,
          courseId: input.courseId,
          observedAt: input.providerObservedAt,
          transaction,
        });
        persistedMatchStates.push({
          matchId: persistedMatch?.id,
          isPending: persistedMatch?.alertStatus === "PENDING",
        });
      }
      if (input.reconcileMatches !== false) {
        await markMissingMatchesUnavailable({
          searchId: input.searchId,
          alertGeneration: input.alertGeneration,
          checkLeaseToken: input.checkLeaseToken,
          courseId: input.courseId,
          date: input.date,
          timeZone: input.timeZone,
          confirmedMatches: input.matches.map((match) => ({
            sourceId: match.sourceId,
            startsAt: match.startsAt,
          })),
          observedAt: input.providerObservedAt,
          transaction,
        });
      }
      if (
        input.localReaderObservation &&
        !(await markCompletedLocalReaderProviderObservationConsumedInTransaction(
          transaction,
          {
            courseId: input.courseId,
            searchId: input.searchId,
            scheduleVersion: input.localReaderObservation.scheduleVersion,
            checkLeaseToken: input.checkLeaseToken,
            jobId: input.localReaderObservation.jobId,
            providerObservedAt: input.providerObservedAt,
            resultStatus: input.localReaderObservation.resultStatus,
          },
        ))
      ) {
        throw new Error(
          "The exact local-reader provider source could not be consumed with its canonical course commit",
        );
      }
      if (input.providerObservation) {
        await releaseCourseProviderObservationInTransaction(
          transaction,
          input.providerObservation,
        );
      }
      return {
        sourceEvidenceAccepted: true as const,
        persistedMatchStates,
      };
    },
  );
}

async function hasExactAcceptedLocalReaderMonitoringSource(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    searchId: string;
    providerObservedAt: Date;
    jobId: string;
    scheduleVersion: number;
    resultStatus: "AVAILABLE" | "NO_AVAILABILITY";
    monitoringOutcome: "MATCH_FOUND" | "NO_MATCH";
  },
) {
  const events = await transaction.courseMonitoringEvent.findMany({
    where: {
      courseId: input.courseId,
      eventType: "CHECK_SUCCEEDED",
      source: "SEARCH_WORKFLOW",
      toState: "HEALTHY",
      outcome: input.monitoringOutcome,
      occurredAt: input.providerObservedAt,
    },
    orderBy: { id: "desc" },
    take: 20,
    select: { audit: true },
  });
  return events.some((event) => {
    const audit = asProviderExecutionSummary(event.audit);
    const source = asProviderExecutionSummary(audit.localReaderCanonicalSource);
    return (
      source?.jobId === input.jobId &&
      source.searchId === input.searchId &&
      source.scheduleVersion === input.scheduleVersion &&
      source.resultStatus === input.resultStatus &&
      source.providerObservedAt === input.providerObservedAt.toISOString()
    );
  });
}

async function isCurrentCourseMonitoringSource(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    providerObservedAt: Date;
    sourceKind: "SUCCESS" | "FAILURE";
  },
) {
  const monitoring = await transaction.courseMonitoringStatus.findUnique({
    where: { courseId: input.courseId },
    select: { state: true, lastSuccessfulAt: true, lastFailureAt: true },
  });
  if (
    !monitoring ||
    ["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY"].includes(
      monitoring.state,
    )
  ) {
    return false;
  }
  const sourceTime = input.providerObservedAt.getTime();
  return input.sourceKind === "SUCCESS"
    ? monitoring.lastSuccessfulAt?.getTime() === sourceTime &&
        (monitoring.lastFailureAt?.getTime() ?? Number.NEGATIVE_INFINITY) <
          sourceTime
    : monitoring.lastFailureAt?.getTime() === sourceTime &&
        (monitoring.lastSuccessfulAt?.getTime() ?? Number.NEGATIVE_INFINITY) <
          sourceTime;
}

function addIsoDateDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

const queuedSearchCheckSelect = {
  id: true,
  status: true,
  scheduleVersion: true,
  workflowRunId: true,
  checkStatus: true,
  updatedAt: true,
} satisfies Prisma.TeeSearchSelect;

export type QueuedSearchCheck = Prisma.TeeSearchGetPayload<{
  select: typeof queuedSearchCheckSelect;
}>;

export type SearchScheduleExpectedState = {
  scheduleVersion: number;
  updatedAt: Date;
  observedAt: Date;
  checkStatus?: "WAITING" | "QUEUED";
  workflowRunId?: string | null;
  recoveryDispatchKey?: string;
};

export type SearchScheduleNotEligible = {
  outcome: "not_eligible";
  reason: "state_changed";
};

export function queueSearchCheck(
  searchId: string,
  remediationDispatchKey?: string,
): Promise<QueuedSearchCheck | null>;
export function queueSearchCheck(
  searchId: string,
  remediationDispatchKey: string | undefined,
  expectedState: SearchScheduleExpectedState,
): Promise<QueuedSearchCheck | SearchScheduleNotEligible>;

export async function queueSearchCheck(
  searchId: string,
  remediationDispatchKey?: string,
  expectedState?: SearchScheduleExpectedState,
): Promise<QueuedSearchCheck | SearchScheduleNotEligible | null> {
  if (remediationDispatchKey && remediationDispatchKey.length > 128) {
    throw new Error("Remediation dispatch key is too long.");
  }
  if (remediationDispatchKey && expectedState) {
    throw new Error(
      "Expected-state guards cannot be combined with remediation dispatch.",
    );
  }
  if (
    expectedState?.recoveryDispatchKey &&
    expectedState.recoveryDispatchKey.length > 128
  ) {
    throw new Error("Recovery dispatch key is too long.");
  }
  return prisma.$transaction(async (tx) => {
    if (expectedState) {
      const expectedCheckStatus = expectedState.checkStatus ?? "WAITING";
      const hasExpectedWorkflowRunId = Object.prototype.hasOwnProperty.call(
        expectedState,
        "workflowRunId",
      );
      const updated = await tx.teeSearch.updateMany({
        where: {
          id: searchId,
          status: "ACTIVE",
          scheduleVersion: expectedState.scheduleVersion,
          updatedAt: expectedState.updatedAt,
          checkStatus: expectedCheckStatus,
          ...(hasExpectedWorkflowRunId
            ? { workflowRunId: expectedState.workflowRunId }
            : {}),
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: expectedState.observedAt } },
          ],
        },
        data: {
          scheduleVersion: { increment: 1 },
          checkStatus: "QUEUED",
          nextCheckAt: new Date(),
          lastCheckOutcome: null,
          workflowRunId: null,
          checkLeaseToken: null,
          checkLeaseExpiresAt: null,
          recheckRequestedAt: null,
          ...(expectedState.recoveryDispatchKey
            ? {
                remediationDispatchKey: expectedState.recoveryDispatchKey,
                remediationDispatchVersion: expectedState.scheduleVersion + 1,
              }
            : {}),
        },
      });
      if (updated.count === 0) {
        return {
          outcome: "not_eligible" as const,
          reason: "state_changed" as const,
        };
      }
      const queued = await tx.teeSearch.findUnique({
        where: {
          id: searchId,
          status: "ACTIVE",
          scheduleVersion: expectedState.scheduleVersion + 1,
          checkStatus: "QUEUED",
          workflowRunId: null,
        },
        select: queuedSearchCheckSelect,
      });
      if (!queued) {
        throw new Error("Guarded search schedule changed after it was queued.");
      }
      return queued;
    }

    if (remediationDispatchKey) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await tx.teeSearch.findUnique({
          where: { id: searchId },
          select: {
            id: true,
            status: true,
            scheduleVersion: true,
            remediationDispatchKey: true,
            remediationDispatchVersion: true,
            workflowRunId: true,
            checkStatus: true,
            nextCheckAt: true,
            preferences: {
              select: {
                course: {
                  select: {
                    supportIncident: {
                      select: {
                        status: true,
                        humanReviewReason: true,
                        escalationDeadlineAt: true,
                      },
                    },
                  },
                },
              },
            },
            updatedAt: true,
          },
        });
        if (!current || current.status !== "ACTIVE") {
          return current;
        }
        if (current.remediationDispatchKey === remediationDispatchKey) {
          if (current.remediationDispatchVersion === null) {
            throw new Error("Remediation dispatch version is missing.");
          }
          return {
            ...current,
            scheduleVersion: current.remediationDispatchVersion,
          };
        }

        const earliestEndpointDeadlineAt = (current.preferences ?? [])
          .map((preference) => preference.course.supportIncident)
          .filter(
            (incident) =>
              incident?.status === "AUTO_INVESTIGATING" &&
              !incident.humanReviewReason &&
              incident.escalationDeadlineAt,
          )
          .map((incident) => incident!.escalationDeadlineAt!)
          .sort((left, right) => left.getTime() - right.getTime())[0];
        const remediationObservedAt = new Date();
        const preserveAttachedEndpointWake = Boolean(
          current.workflowRunId &&
          current.checkStatus === "WAITING" &&
          current.nextCheckAt &&
          earliestEndpointDeadlineAt &&
          earliestEndpointDeadlineAt > remediationObservedAt &&
          current.nextCheckAt > remediationObservedAt &&
          current.nextCheckAt <= earliestEndpointDeadlineAt,
        );
        if (preserveAttachedEndpointWake) {
          const preserved = await tx.teeSearch.updateMany({
            where: {
              id: searchId,
              status: "ACTIVE",
              scheduleVersion: current.scheduleVersion,
              workflowRunId: current.workflowRunId,
              checkStatus: "WAITING",
              nextCheckAt: current.nextCheckAt,
              OR: [
                { remediationDispatchKey: null },
                { remediationDispatchKey: { not: remediationDispatchKey } },
              ],
            },
            data: {
              remediationDispatchKey,
              remediationDispatchVersion: current.scheduleVersion,
            },
          });
          if (preserved.count === 1) {
            return current;
          }
          continue;
        }

        const nextVersion = current.scheduleVersion + 1;
        const updated = await tx.teeSearch.updateMany({
          where: {
            id: searchId,
            status: "ACTIVE",
            scheduleVersion: current.scheduleVersion,
            OR: [
              { remediationDispatchKey: null },
              { remediationDispatchKey: { not: remediationDispatchKey } },
            ],
          },
          data: {
            scheduleVersion: { increment: 1 },
            remediationDispatchKey,
            remediationDispatchVersion: nextVersion,
            checkStatus: "QUEUED",
            nextCheckAt: new Date(),
            lastCheckOutcome: null,
            workflowRunId: null,
            checkLeaseToken: null,
            checkLeaseExpiresAt: null,
            recheckRequestedAt: null,
          },
        });
        if (updated.count === 1) {
          return tx.teeSearch.findUnique({
            where: { id: searchId },
            select: queuedSearchCheckSelect,
          });
        }
      }

      throw new Error(
        "Remediation dispatch could not claim the search schedule.",
      );
    }

    await tx.teeSearch.updateMany({
      where: { id: searchId, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: new Date(),
        lastCheckOutcome: null,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null,
      },
    });
    return tx.teeSearch.findUnique({
      where: { id: searchId },
      select: queuedSearchCheckSelect,
    });
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
      nextCheckAt: true,
    },
  });
}

export async function attachSearchWorkflowRun(
  searchId: string,
  scheduleVersion: number,
  workflowRunId: string,
  expectedWorkflowRunId: string | null,
) {
  return prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
      workflowRunId: expectedWorkflowRunId,
    },
    data: {
      workflowRunId,
    },
  });
}

export async function claimScheduledSearchCheck(
  searchId: string,
  scheduleVersion: number,
) {
  const now = new Date();
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + SEARCH_CHECK_LEASE_MS);
  const result = await prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
      OR: [
        { checkLeaseToken: null },
        { checkLeaseExpiresAt: null },
        { checkLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      checkStatus: "CHECKING",
      nextCheckAt: null,
      checkLeaseToken: token,
      checkLeaseExpiresAt: expiresAt,
      recheckRequestedAt: null,
    },
  });

  if (result.count === 1) {
    return {
      searchId,
      scheduleVersion,
      token,
      expiresAt,
    } satisfies SearchCheckLease;
  }

  await requestSearchRecheck(searchId, scheduleVersion, now);
  return null;
}

async function claimDirectSearchCheckLease(searchId: string) {
  const state = await prisma.teeSearch.findFirst({
    where: { id: searchId, status: "ACTIVE" },
    select: { scheduleVersion: true },
  });
  if (!state) {
    return null;
  }

  const now = new Date();
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + SEARCH_CHECK_LEASE_MS);
  const claimed = await prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion: state.scheduleVersion,
      status: "ACTIVE",
      OR: [
        { checkLeaseToken: null },
        { checkLeaseExpiresAt: null },
        { checkLeaseExpiresAt: { lte: now } },
      ],
    },
    data: {
      checkLeaseToken: token,
      checkLeaseExpiresAt: expiresAt,
    },
  });
  if (claimed.count !== 1) {
    await requestSearchRecheck(searchId, state.scheduleVersion, now);
    return null;
  }

  return {
    searchId,
    scheduleVersion: state.scheduleVersion,
    token,
    expiresAt,
  } satisfies SearchCheckLease;
}

export async function requestSearchRecheck(
  searchId: string,
  scheduleVersion: number,
  requestedAt = new Date(),
) {
  return prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
    },
    data: {
      recheckRequestedAt: requestedAt,
    },
  });
}

export async function heartbeatSearchCheckLease(
  lease: SearchCheckLease,
  now = new Date(),
) {
  const expiresAt = new Date(now.getTime() + SEARCH_CHECK_LEASE_MS);
  const result = await prisma.teeSearch.updateMany({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      status: "ACTIVE",
      checkLeaseToken: lease.token,
      checkLeaseExpiresAt: { gt: now },
    },
    data: { checkLeaseExpiresAt: expiresAt },
  });
  if (result.count === 1) {
    lease.expiresAt = expiresAt;
  }
  return result.count === 1;
}

export async function isSearchCheckLeaseCurrent(
  lease: SearchCheckLease,
  now = new Date(),
) {
  const current = await prisma.teeSearch.findFirst({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      status: "ACTIVE",
      checkLeaseToken: lease.token,
      checkLeaseExpiresAt: { gt: now },
    },
    select: { id: true },
  });
  return Boolean(current);
}

async function releaseSearchCheckLease(lease: SearchCheckLease) {
  await prisma.teeSearch.updateMany({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      checkLeaseToken: lease.token,
    },
    data: {
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
    },
  });
}

export async function completeScheduledSearchCheck(input: {
  searchId: string;
  scheduleVersion: number;
  leaseToken: string;
  outcome: string;
  nextCheckAt: Date | null;
  completeSearch?: boolean;
}) {
  const checkedAt = new Date();
  const rows = await prisma.$queryRaw<
    Array<{ recheckRequested: boolean; nextCheckAt: Date | null }>
  >(
    Prisma.sql`
      WITH current AS (
        SELECT "id", "status", "recheckRequestedAt"
        FROM "TeeSearch"
        WHERE "id" = ${input.searchId}
          AND "scheduleVersion" = ${input.scheduleVersion}
          AND "checkLeaseToken" = ${input.leaseToken}
          AND "status" = 'ACTIVE'::"SearchStatus"
        FOR UPDATE
      )
      UPDATE "TeeSearch" AS search
      SET
        "status" = CASE
          WHEN ${input.completeSearch} THEN 'COMPLETED'::"SearchStatus"
          ELSE current."status"
        END,
        "checkStatus" = CASE
          WHEN ${input.completeSearch} THEN 'STOPPED'::"SearchCheckStatus"
          WHEN current."recheckRequestedAt" IS NOT NULL THEN 'WAITING'::"SearchCheckStatus"
          WHEN ${input.nextCheckAt}::timestamp IS NOT NULL THEN 'WAITING'::"SearchCheckStatus"
          ELSE 'STOPPED'::"SearchCheckStatus"
        END,
        "lastCheckedAt" = ${checkedAt},
        "lastCheckOutcome" = ${input.outcome},
        "nextCheckAt" = CASE
          WHEN ${input.completeSearch} THEN NULL
          WHEN current."recheckRequestedAt" IS NOT NULL THEN GREATEST(
            current."recheckRequestedAt",
            ${checkedAt}
          )
          ELSE ${input.nextCheckAt}
        END,
        "checkLeaseToken" = NULL,
        "checkLeaseExpiresAt" = NULL,
        "recheckRequestedAt" = NULL,
        "updatedAt" = ${checkedAt}
      FROM current
      WHERE search."id" = current."id"
      RETURNING
        (current."recheckRequestedAt" IS NOT NULL) AS "recheckRequested",
        search."nextCheckAt" AS "nextCheckAt"
    `,
  );

  return rows[0] ?? null;
}

export async function completeExpiredSyntheticSearch(input: {
  searchId: string;
  scheduleVersion: number;
  leaseToken: string;
  outcome: string;
}) {
  return prisma.$transaction(async (transaction) => {
    const search = await lockSearchForAlertMutation(transaction, {
      searchId: input.searchId,
    });
    if (
      search.status !== "ACTIVE" ||
      search.checkLeaseToken !== input.leaseToken
    ) {
      return null;
    }

    const completedAt = new Date();
    const updated = await transaction.teeSearch.updateMany({
      where: {
        id: input.searchId,
        scheduleVersion: input.scheduleVersion,
        checkLeaseToken: input.leaseToken,
        status: "ACTIVE",
      },
      data: {
        status: "COMPLETED",
        scheduleVersion: { increment: 1 },
        alertGeneration: { increment: 1 },
        checkStatus: "STOPPED",
        nextCheckAt: null,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null,
        lastCheckedAt: completedAt,
        lastCheckOutcome: input.outcome,
      },
    });
    if (updated.count !== 1) {
      return null;
    }

    await transaction.teeTimeMatch.updateMany({
      where: {
        teeSearchId: input.searchId,
        alertStatus: "PENDING",
      },
      data: {
        alertStatus: "SUPPRESSED",
        sentAt: null,
      },
    });
    return { completedAt };
  });
}

export async function failScheduledSearchCheck(input: {
  searchId: string;
  scheduleVersion: number;
  message: string;
  nextCheckAt: Date;
  leaseToken?: string;
  expectedWorkflowRunId?: string | null;
}) {
  const hasExpectedWorkflowRunId = Object.prototype.hasOwnProperty.call(
    input,
    "expectedWorkflowRunId",
  );
  const failedAt = new Date();
  const ownershipPredicate = input.leaseToken
    ? Prisma.sql`AND "checkLeaseToken" = ${input.leaseToken}`
    : Prisma.sql`
        AND "checkLeaseToken" IS NULL
        AND "checkStatus" IN (
          'QUEUED'::"SearchCheckStatus",
          'WAITING'::"SearchCheckStatus",
          'FAILED'::"SearchCheckStatus"
        )
        ${
          hasExpectedWorkflowRunId
            ? Prisma.sql`AND "workflowRunId" IS NOT DISTINCT FROM ${input.expectedWorkflowRunId}`
            : Prisma.empty
        }
      `;
  const rows = await prisma.$queryRaw<Array<{ nextCheckAt: Date }>>(Prisma.sql`
    UPDATE "TeeSearch"
    SET
      "checkStatus" = 'FAILED'::"SearchCheckStatus",
      "lastCheckedAt" = ${failedAt},
      "lastCheckOutcome" = ${input.message},
      "nextCheckAt" = CASE
        WHEN "recheckRequestedAt" IS NULL THEN ${input.nextCheckAt}
        ELSE LEAST(
          ${input.nextCheckAt},
          GREATEST("recheckRequestedAt", ${failedAt})
        )
      END,
      "checkLeaseToken" = NULL,
      "checkLeaseExpiresAt" = NULL,
      "updatedAt" = ${failedAt}
    WHERE "id" = ${input.searchId}
      AND "scheduleVersion" = ${input.scheduleVersion}
      AND "status" = 'ACTIVE'::"SearchStatus"
      ${ownershipPredicate}
    RETURNING "nextCheckAt"
  `);
  return {
    count: rows.length,
    nextCheckAt: rows[0]?.nextCheckAt ?? null,
  };
}

export async function stopSearchSchedule(searchId: string) {
  return prisma.teeSearch.update({
    where: { id: searchId },
    data: {
      scheduleVersion: { increment: 1 },
      checkStatus: "STOPPED",
      nextCheckAt: null,
      workflowRunId: null,
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
      recheckRequestedAt: null,
    },
  });
}

export async function getSearchScheduleState(
  searchId: string,
  scheduleVersion: number,
) {
  return prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
    },
    select: {
      id: true,
      scheduleVersion: true,
      status: true,
      nextCheckAt: true,
      workflowRunId: true,
      checkStatus: true,
    },
  });
}

export async function getSearchScheduleTiming(
  searchId: string,
  scheduleVersion: number,
) {
  return prisma.teeSearch.findFirst({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
    },
    select: {
      id: true,
      createdAt: true,
      date: true,
      endTime: true,
      userTimeZone: true,
      cadenceMinutes: true,
      scheduleVersion: true,
      trafficClass: true,
      syntheticMultiCycle: true,
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
              bookingWindowObservedAt: true,
              monitoringStatus: {
                select: {
                  state: true,
                  nextAutomaticAttemptAt: true,
                  revalidationRequestedAt: true,
                },
              },
              supportIncident: {
                select: {
                  status: true,
                  humanReviewReason: true,
                  escalationDeadlineAt: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function listSearchesNeedingScheduleRecovery(now = new Date()) {
  const queuedOverdueBefore = new Date(now.getTime() - 2 * 60 * 1000);
  const overdueBefore = new Date(now.getTime() - 10 * 60 * 1000);
  const missingInitialVerdictBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const attachedSetupRecoveryBefore = new Date(now.getTime() - 4 * 60 * 1000);
  // The general recovery cron runs every five minutes. Looking a second full
  // interval ahead guarantees that even the worst phase offset leaves one
  // complete cron interval to replace a sleeping endpoint Workflow.
  const endpointRecoveryHorizon = new Date(now.getTime() + 10 * 60 * 1000);
  const recentEndpointEscalationAfter = new Date(now.getTime() - 5 * 60 * 1000);
  const recoverySelect = {
    id: true,
    scheduleVersion: true,
    checkStatus: true,
    workflowRunId: true,
    nextCheckAt: true,
    updatedAt: true,
    statusEmailSentAt: true,
    remediationDispatchKey: true,
    preferences: {
      select: {
        course: {
          select: {
            supportIncident: {
              select: {
                id: true,
                cycle: true,
                status: true,
                humanReviewReason: true,
                escalationDeadlineAt: true,
                escalatedAt: true,
              },
            },
          },
        },
      },
    },
  } satisfies Prisma.TeeSearchSelect;
  const sharedWhere = {
    status: "ACTIVE" as const,
    // Exact multi-course expiry is enforced by executeScheduledSearchCheck.
    // This indexed floor keeps every possibly-current local calendar date in
    // the recovery cohort without reviving older searches.
    date: { gte: earliestPotentiallyActiveSearchDate(now) },
  };
  const criticalEndpointSearches = await prisma.teeSearch.findMany({
    where: {
      ...sharedWhere,
      OR: [
        {
          checkStatus: "QUEUED",
          workflowRunId: null,
          preferences: {
            some: {
              course: {
                supportIncident: {
                  is: {
                    status: "AUTO_INVESTIGATING",
                    humanReviewReason: null,
                    escalationDeadlineAt: { lte: endpointRecoveryHorizon },
                  },
                },
              },
            },
          },
        },
        {
          statusEmailSentAt: null,
          checkStatus: "QUEUED",
          workflowRunId: { not: null },
          updatedAt: { lte: attachedSetupRecoveryBefore },
        },
        {
          checkStatus: { in: ["QUEUED", "WAITING"] },
          workflowRunId: { not: null },
          preferences: {
            some: {
              course: {
                supportIncident: {
                  is: {
                    status: "AUTO_INVESTIGATING",
                    humanReviewReason: null,
                    escalationDeadlineAt: { lte: endpointRecoveryHorizon },
                  },
                },
              },
            },
          },
        },
        {
          AND: [
            {
              checkStatus: { in: ["QUEUED", "WAITING"] },
            },
            { recheckRequestedAt: { gte: recentEndpointEscalationAfter } },
            {
              preferences: {
                some: {
                  course: {
                    supportIncident: {
                      is: {
                        escalatedAt: { gte: recentEndpointEscalationAfter },
                        escalationDeadlineAt: { lte: now },
                        OR: [
                          {
                            status: "AUTO_INVESTIGATING",
                            humanReviewReason: "AUTOMATION_STALLED",
                          },
                          {
                            status: "NEEDS_HUMAN",
                            humanReviewReason: { not: null },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    },
    select: recoverySelect,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  const standardRecoverySearches = await prisma.teeSearch.findMany({
    where: {
      ...sharedWhere,
      OR: [
        { checkStatus: "IDLE" },
        {
          checkStatus: "QUEUED",
          workflowRunId: null,
          updatedAt: { lte: queuedOverdueBefore },
        },
        {
          checkStatus: "QUEUED",
          workflowRunId: { not: null },
          updatedAt: { lte: overdueBefore },
        },
        {
          checkStatus: "CHECKING",
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: now } },
          ],
        },
        { checkStatus: "FAILED", nextCheckAt: { lte: now } },
        { checkStatus: "WAITING", nextCheckAt: { lte: overdueBefore } },
        {
          AND: [
            {
              statusEmailSentAt: null,
              createdAt: { lte: missingInitialVerdictBefore },
            },
            {
              checkStatus: { in: ["WAITING", "FAILED"] },
              OR: [
                { checkLeaseExpiresAt: null },
                { checkLeaseExpiresAt: { lte: now } },
              ],
            },
          ],
        },
        {
          AND: [
            {
              checkStatus: { in: ["WAITING", "FAILED"] },
              OR: [
                { checkLeaseExpiresAt: null },
                { checkLeaseExpiresAt: { lte: now } },
              ],
            },
            {
              OR: [
                {
                  emailDeliveries: {
                    some: {
                      kind: { in: ["SETUP", "DAILY", "MATCH"] },
                      OR: [
                        {
                          status: "PENDING",
                          createdAt: { lte: overdueBefore },
                        },
                        { status: "FAILED", nextAttemptAt: { lte: now } },
                        { status: "SENDING", claimExpiresAt: { lte: now } },
                      ],
                    },
                  },
                },
                {
                  matches: {
                    some: {
                      availabilityStatus: "AVAILABLE",
                      alertStatus: "PENDING",
                      firstSeenAt: { lte: overdueBefore },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    select: recoverySelect,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50,
  });
  type RecoverySearch = (typeof criticalEndpointSearches)[number] & {
    endpointRecoveryDispatchKey?: string;
  };
  const filteredCriticalEndpointSearches = criticalEndpointSearches.flatMap(
    (search): RecoverySearch[] => {
      const incidents = (search.preferences ?? [])
        .map((preference) => preference.course.supportIncident)
        .filter((incident) => Boolean(incident));
      const imminentIncident = incidents
        .filter(
          (incident) =>
            incident?.status === "AUTO_INVESTIGATING" &&
            !incident.humanReviewReason &&
            incident.escalationDeadlineAt &&
            incident.escalationDeadlineAt <= endpointRecoveryHorizon,
        )
        .sort(
          (left, right) =>
            left!.escalationDeadlineAt!.getTime() -
            right!.escalationDeadlineAt!.getTime(),
        )[0];
      const recentlyEscalated = incidents.some(
        (incident) =>
          incident?.escalatedAt &&
          incident.escalatedAt >= recentEndpointEscalationAfter &&
          incident.escalationDeadlineAt &&
          incident.escalationDeadlineAt <= now &&
          (incident.humanReviewReason === "AUTOMATION_STALLED" ||
            (incident.status === "NEEDS_HUMAN" &&
              Boolean(incident.humanReviewReason))),
      );
      const attachedSetupRecovery =
        search.statusEmailSentAt === null &&
        search.checkStatus === "QUEUED" &&
        Boolean(search.workflowRunId) &&
        search.updatedAt <= attachedSetupRecoveryBefore;
      const attachedEndpointRecovery = Boolean(
        imminentIncident &&
        search.workflowRunId &&
        (search.checkStatus === "QUEUED" || search.checkStatus === "WAITING"),
      );
      if (!attachedEndpointRecovery || !imminentIncident) {
        return [search];
      }
      const recoveryDispatchKey = `endpoint-deadline:${imminentIncident.id}:${imminentIncident.cycle}`;
      const alreadyDispatched =
        search.remediationDispatchKey === recoveryDispatchKey;
      if (alreadyDispatched && !attachedSetupRecovery && !recentlyEscalated) {
        return [];
      }
      return alreadyDispatched
        ? [search]
        : [{ ...search, endpointRecoveryDispatchKey: recoveryDispatchKey }];
    },
  );
  const selected = new Map<string, RecoverySearch>();
  for (const search of [
    ...filteredCriticalEndpointSearches,
    ...standardRecoverySearches,
  ]) {
    if (!selected.has(search.id)) {
      selected.set(search.id, search);
    }
    if (selected.size === 50) {
      break;
    }
  }
  return [...selected.values()];
}

type MatchAlertCycleRef = {
  matchId: string;
  availabilityCycle: number;
};

async function markMatchAlertStatus(
  input: MatchAlertCycleRef,
  alertStatus: "SENT" | "SUPPRESSED",
) {
  const sentAt = new Date();
  const updated = await prisma.teeTimeMatch.updateMany({
    where: {
      id: input.matchId,
      availabilityCycle: input.availabilityCycle,
      alertStatus: "PENDING",
    },
    data: { alertStatus, sentAt },
  });
  return updated.count === 1
    ? {
        id: input.matchId,
        availabilityCycle: input.availabilityCycle,
        alertStatus,
        sentAt,
      }
    : null;
}

export async function markMatchAlertSent(input: MatchAlertCycleRef) {
  return markMatchAlertStatus(input, "SENT");
}

export async function markMatchAlertSuppressed(input: MatchAlertCycleRef) {
  return markMatchAlertStatus(input, "SUPPRESSED");
}

export async function markSearchStatusEmailSent(input: {
  searchId: string;
  sentAt: Date;
  snapshot: Prisma.InputJsonValue;
  alertGeneration: number;
  checkLeaseToken: string;
}) {
  return prisma.teeSearch.updateMany({
    where: {
      id: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      checkLeaseExpiresAt: { gt: input.sentAt },
      status: "ACTIVE",
    },
    data: {
      statusEmailSentAt: input.sentAt,
      statusEmailSnapshot: input.snapshot,
    },
  });
}

export async function recordCourseProbeIfChanged(input: CourseProbeInput) {
  const runtimeVersion = input.runtimeVersion ?? getAutomationRuntimeVersion();
  const latest = await prisma.courseProbe.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId,
      ...(input.observedAtOrAfter
        ? { observedAt: { gte: input.observedAtOrAfter } }
        : {}),
    },
    orderBy: { observedAt: "desc" },
    select: {
      observedAt: true,
      outcome: true,
      message: true,
      runtimeVersion: true,
      rawSummary: true,
    },
  });

  if (
    latest?.outcome === input.outcome &&
    latest.message === (input.message ?? null) &&
    latest.runtimeVersion === runtimeVersion &&
    canReuseProviderExecutionEvidence(latest.rawSummary, input.rawSummary)
  ) {
    return latest;
  }

  return recordCourseProbe({ ...input, runtimeVersion });
}

function canReuseProviderExecutionEvidence(
  latestValue: unknown,
  nextValue: unknown,
) {
  const latest = asProviderExecutionSummary(latestValue);
  const next = asProviderExecutionSummary(nextValue);

  // Each server-adapter invocation is a new synchronous provider observation,
  // even when its normalized outcome is unchanged.
  if (next.providerExecution === "RUNNABLE_PROVIDER_CHECK") {
    return false;
  }

  if (next.providerExecution === "LOCAL_BROWSER_READER") {
    const latestObservedAt = getCanonicalProviderObservedAt(latest);
    const nextObservedAt = getCanonicalProviderObservedAt(next);
    return (
      latest.providerExecution === "LOCAL_BROWSER_READER" &&
      latestObservedAt !== null &&
      latestObservedAt === nextObservedAt
    );
  }

  return (
    (latest.providerExecution ?? null) === (next.providerExecution ?? null)
  );
}

function getCanonicalProviderObservedAt(summary: Record<string, unknown>) {
  if (typeof summary.providerObservedAt !== "string") return null;
  const observedAt = new Date(summary.providerObservedAt);
  return Number.isFinite(observedAt.getTime()) &&
    observedAt.toISOString() === summary.providerObservedAt
    ? summary.providerObservedAt
    : null;
}

function asProviderExecutionSummary(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function listAvailableMatchAlerts(
  searchId: string,
  matchIds?: readonly string[],
): Promise<PendingAlertMatch[]> {
  if (matchIds?.length === 0) {
    return [];
  }

  return prisma.teeTimeMatch.findMany({
    where: {
      teeSearchId: searchId,
      ...(matchIds ? { id: { in: [...matchIds] } } : {}),
      availabilityStatus: "AVAILABLE",
      teeSearch: {
        status: "ACTIVE",
      },
    },
    orderBy: [{ course: { name: "asc" } }, { startsAt: "asc" }],
    select: pendingAlertSelect,
  });
}

export function classifyAutomationRunKind(promptVersion: string) {
  if (
    promptVersion.includes("event-driven-check") ||
    promptVersion.includes("search-check")
  ) {
    return "SEARCH_CHECK" as const;
  }
  if (promptVersion.includes("course-support"))
    return "COURSE_SUPPORT" as const;
  if (
    promptVersion.includes("improvement") ||
    promptVersion.includes("local-codex-loop")
  ) {
    return "IMPROVEMENT" as const;
  }
  if (promptVersion.includes("browser")) return "BROWSER_PROBE" as const;
  if (
    promptVersion.includes("maintenance") ||
    promptVersion.includes("backfill")
  ) {
    return "MAINTENANCE" as const;
  }
  return "OTHER" as const;
}

export function parseAutomationRunAudit(notes?: string | null) {
  if (!notes?.trim()) return null;
  try {
    const parsed = JSON.parse(notes) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Prisma.InputJsonValue)
      : null;
  } catch {
    return null;
  }
}

export async function startAutomationRun(
  promptVersion: string,
  input: { ownerThreadId?: string | null } = {},
) {
  const now = new Date();
  return prisma.automationRun.create({
    data: {
      promptVersion,
      kind: classifyAutomationRunKind(promptVersion),
      status: "RUNNING",
      runtimeVersion: getAutomationRuntimeVersion(),
      ownerThreadId:
        input.ownerThreadId ?? process.env.CODEX_THREAD_ID?.trim() ?? null,
      heartbeatAt: now,
    },
  });
}

export async function listRecentCourseAutomationDiscoveries(
  courseIds: string[],
  since: Date,
) {
  if (courseIds.length === 0) {
    return [];
  }

  return prisma.courseAutomationDiscovery.findMany({
    where: {
      courseId: { in: courseIds },
      createdAt: { gt: since },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      courseId: true,
      status: true,
      sourceUrl: true,
      createdAt: true,
      evidence: true,
    },
  });
}

export async function recordCourseBookingWindowEvidence(input: {
  courseId: string;
  evidence: BookingWindowEvidence;
  observedAt?: Date;
  source?: CourseMonitoringEventSource;
}) {
  const observedAt = input.observedAt ?? new Date();
  return runSerializedCourseMonitoringWrite(input.courseId, (transaction) =>
    recordCourseBookingWindowEvidenceInTransaction(transaction, {
      ...input,
      observedAt,
    }),
  );
}

async function recordCourseBookingWindowEvidenceInTransaction(
  transaction: Prisma.TransactionClient,
  input: {
    courseId: string;
    evidence: BookingWindowEvidence;
    observedAt: Date;
    source?: CourseMonitoringEventSource;
  },
) {
  const current = await transaction.course.findUnique({
    where: { id: input.courseId },
  });
  if (!current) {
    throw new Error(`Course ${input.courseId} was not found`);
  }
  if (
    current.bookingWindowObservedAt instanceof Date &&
    current.bookingWindowObservedAt > input.observedAt
  ) {
    return current;
  }

  const applied = await transaction.course.update({
    where: {
      id: input.courseId,
      updatedAt: current.updatedAt,
    },
    data: {
      bookingWindowDaysAhead: input.evidence.daysAhead,
      bookingReleaseTimeLocal: input.evidence.releaseTimeLocal,
      bookingWindowSource: input.evidence.source,
      bookingWindowConfidence: input.evidence.confidence,
      bookingWindowEvidenceUrl: input.evidence.evidenceUrl,
      bookingWindowCheckedAt: input.observedAt,
      bookingWindowObservedAt: input.observedAt,
    },
  });
  await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
    transaction,
    {
      courseId: input.courseId,
      before: current,
      after: applied,
      providerSnapshotFingerprint:
        buildCourseSupportProviderSnapshotFingerprint(applied),
      source: input.source ?? "SEARCH_WORKFLOW",
      now: input.observedAt,
    },
  );
  return applied;
}

export async function recordCoursePhysicalLayoutEvidence(input: {
  courseId: string;
  holeCounts: readonly CourseLayoutHoleCount[];
  evidenceUrl: string;
  verifiedAt: Date;
  expectedUpdatedAt: Date;
  expectedName: string;
  providerObservation: CourseProviderObservationLease;
  source?: CourseMonitoringEventSource;
}) {
  const operationTime = input.providerObservation.observationStartedAt;
  const holeCounts = normalizeLayoutHoleCounts(input.holeCounts);
  if (
    holeCounts.length === 0 ||
    holeCounts.length !== input.holeCounts.length ||
    !(operationTime instanceof Date) ||
    !Number.isFinite(operationTime.getTime()) ||
    !Number.isFinite(input.verifiedAt.getTime()) ||
    input.verifiedAt.getTime() > operationTime.getTime()
  ) {
    throw new Error(
      "Physical layout evidence must contain unique 9- and/or 18-hole values and a valid non-future verification date",
    );
  }
  if (
    input.providerObservation.courseId !== input.courseId ||
    !Number.isFinite(input.expectedUpdatedAt.getTime()) ||
    !input.expectedName.trim()
  ) {
    throw new Error(
      "Physical layout evidence requires its owned provider observation and a valid pre-fetch course snapshot",
    );
  }
  let evidenceUrl: URL;
  try {
    evidenceUrl = new URL(input.evidenceUrl);
  } catch {
    throw new Error(
      "Physical layout evidence URL must be a credential-free public HTTP(S) URL",
    );
  }
  if (
    !["http:", "https:"].includes(evidenceUrl.protocol) ||
    evidenceUrl.username ||
    evidenceUrl.password ||
    /^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/iu.test(
      evidenceUrl.hostname,
    ) ||
    !isSafeManualEvidenceUrl(evidenceUrl)
  ) {
    throw new Error(
      "Physical layout evidence URL must be a credential-free public HTTP(S) URL",
    );
  }

  return runSerializedCourseMonitoringWrite(
    input.courseId,
    async (transaction) => {
      if (
        !(await renewCourseProviderObservationInTransaction(
          transaction,
          input.providerObservation,
        ))
      ) {
        throw new Error(
          "Provider observation ownership expired before physical-layout evidence could be persisted",
        );
      }
      const current = await transaction.course.findUnique({
        where: { id: input.courseId },
      });
      if (!current) {
        throw new Error(`Course ${input.courseId} was not found`);
      }
      if (
        current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime() ||
        current.name !== input.expectedName
      ) {
        throw new Error(
          "Course identity or layout changed while physical-layout evidence was being verified; rerun the command",
        );
      }

      const applied = await transaction.course.update({
        where: {
          id: input.courseId,
          updatedAt: input.expectedUpdatedAt,
          name: input.expectedName,
        },
        data: {
          layoutHoleCounts: holeCounts,
          layoutHolesEvidenceUrl: evidenceUrl.toString(),
          layoutHolesVerifiedAt: input.verifiedAt,
        },
      });
      await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(
        transaction,
        {
          courseId: input.courseId,
          before: current,
          after: applied,
          providerSnapshotFingerprint:
            buildCourseSupportProviderSnapshotFingerprint(applied),
          source: input.source ?? "OPERATOR_CLI",
          now: operationTime,
        },
      );
      return applied;
    },
  );
}

export async function markCourseBookingWindowChecked(
  courseId: string,
  checkedAt = new Date(),
) {
  return runSerializedCourseMonitoringWrite(courseId, (transaction) =>
    markCourseBookingWindowCheckedInTransaction(
      transaction,
      courseId,
      checkedAt,
    ),
  );
}

async function markCourseBookingWindowCheckedInTransaction(
  transaction: Prisma.TransactionClient,
  courseId: string,
  checkedAt: Date,
) {
  const current = await transaction.course.findUnique({
    where: { id: courseId },
  });
  if (!current) {
    throw new Error(`Course ${courseId} was not found`);
  }
  if (
    current.bookingWindowCheckedAt instanceof Date &&
    current.bookingWindowCheckedAt > checkedAt
  ) {
    return current;
  }
  return transaction.course.update({
    where: { id: courseId, updatedAt: current.updatedAt },
    data: { bookingWindowCheckedAt: checkedAt },
  });
}

export async function updateHourlyImprovementRunState(
  id: string,
  record: HourlyImprovementRunRecord,
) {
  if (record.checkpoints.outcome_recorded) {
    throw new Error(
      "outcome_recorded may only become true in the atomic hourly improvement closeout",
    );
  }
  if (
    record.automationId !== HOURLY_IMPROVEMENT_AUTOMATION_ID ||
    record.owner.runId !== id ||
    record.provenance.ownerRunId !== id
  ) {
    throw new Error(
      "Hourly improvement state does not match its durable owner run",
    );
  }
  if (
    record.checkpoints.provenance_recorded &&
    !hasCompletePreEditProvenance(record.provenance)
  ) {
    throw new Error(
      "provenance_recorded requires owner, branch, SHA, thread, and planned-path evidence",
    );
  }

  const result = await prisma.automationRun.updateMany({
    where: {
      id,
      completedAt: null,
    },
    data: {
      kind: "IMPROVEMENT",
      status: "RUNNING",
      heartbeatAt: new Date(),
      auditSchemaVersion: 1,
      audit: record as unknown as Prisma.InputJsonValue,
      notes: JSON.stringify(record),
    },
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
  },
) {
  if (
    input.record.automationId !== HOURLY_IMPROVEMENT_AUTOMATION_ID ||
    input.record.owner.runId !== id ||
    input.record.provenance.ownerRunId !== id
  ) {
    throw new Error(
      "Hourly improvement closeout does not match its durable owner run",
    );
  }
  const closeoutRecord: HourlyImprovementRunRecord = {
    ...input.record,
    lifecycle: input.record.blocker ? "blocked" : "closeout",
    checkpoints: markImprovementOutcomeRecorded(input.record.checkpoints),
  };
  const result = await prisma.automationRun.updateMany({
    where: {
      id,
      completedAt: null,
    },
    data: {
      completedAt: new Date(),
      outcome: input.outcome,
      status: input.errors ? "FAILED" : "COMPLETED",
      errors: input.errors,
      changedFiles: input.changedFiles,
      heartbeatAt: new Date(),
      auditSchemaVersion: 1,
      audit: closeoutRecord as unknown as Prisma.InputJsonValue,
      notes: JSON.stringify(closeoutRecord),
    },
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
  },
) {
  return prisma.automationRun.update({
    where: { id },
    data: {
      completedAt: new Date(),
      outcome: input.outcome,
      status: input.errors ? "FAILED" : "COMPLETED",
      errors: input.errors,
      changedFiles: input.changedFiles,
      heartbeatAt: new Date(),
      auditSchemaVersion: parseAutomationRunAudit(input.notes) ? 1 : undefined,
      audit: parseAutomationRunAudit(input.notes) ?? undefined,
      notes: input.notes,
    },
  });
}
