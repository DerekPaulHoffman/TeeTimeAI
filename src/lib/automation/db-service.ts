import { randomUUID } from "node:crypto";

import { Prisma } from "@prisma/client";

import type { BookingWindowEvidence } from "@/lib/courses/booking-window";
import { resolveBookingAccessMode } from "@/lib/courses/intelligence";
import {
  lockSearchForEmailReconciliation,
  suppressSearchEmailDeliveriesForMatches
} from "@/lib/email/search-delivery-outbox";
import { prisma } from "@/lib/prisma";
import { haveCompatibleCourseNames } from "@/lib/places/course-identity";
import { recordCourseBookingFacts } from "@/lib/pricing/course-booking-facts";
import { zonedDateTimeToDate } from "@/lib/timezones";

import {
  evaluateBrowserDiscoveryMonitoringGate,
  getBestProbeUrl,
  keepPolicyOnlyDiscoveryActionable,
  OFFICIAL_SITE_SOFT_NOT_FOUND_POLICY_NOTES,
  shouldQueueBrowserProbe,
  type BrowserDiscovery,
  type BrowserProbeCourseInput
} from "./browser-discovery";
import { startOfUtcCalendarDay } from "./date-boundary";
import {
  hasCompletePreEditProvenance,
  HOURLY_IMPROVEMENT_AUTOMATION_ID,
  markImprovementOutcomeRecorded,
  type HourlyImprovementRunRecord
} from "./improvement";
import { withPostgresAdvisoryLease, withPostgresAdvisoryTextLease } from "./lease";
import { HOURLY_IMPROVEMENT_WRITER_LANE } from "./writer-lanes";
import {
  normalizeProviderFamilyKey,
  resolveProviderCapability,
  resolveProviderDiscoveryIdentity,
  SOURCE_MISSING_PROVIDER_FAMILY
} from "./provider-capabilities";
import { evaluateMonitoringGate } from "./policy";
import { getAutomationRuntimeVersion } from "./runtime-version";

export { recordCourseBookingFacts };

const AUTOMATION_POLL_LEASE_KEY = 917300120260709n;
const REOPEN_ALERT_MINIMUM_ABSENCE_MS = 30 * 60 * 1000;
const SEARCH_CHECK_LEASE_MS = 15 * 60 * 1000;

const activeSearchInclude = {
  user: true,
  preferences: {
    orderBy: { rank: "asc" },
    include: {
      course: {
        include: {
          bookingFacts: {
            orderBy: { holes: "asc" }
          },
          profile: {
            select: {
              canonicalSlug: true,
              status: true
            }
          }
        }
      }
    }
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
  searchId?: string;
  rank: number;
  course: {
    id: string;
    name: string;
    website: string | null;
    detectedBookingUrl: string | null;
    detectedPlatform: string;
    providerFamilyKey: string;
    automationEligibility: string;
    automationReason: string;
    bookingMethod: string;
    isPublic: boolean;
    intelligenceVerifiedAt: Date | null;
    intelligenceReviewAt: Date | null;
    intelligenceConfidence: number | null;
    bookingMetadata: unknown;
    monitoringFailureEvidence?: BrowserProbeCourseInput["monitoringFailureEvidence"];
  };
  probeUrl: string;
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
  worker: (lease: SearchCheckLease) => Promise<T>
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

export async function listBrowserProbeTargets(
  limit = 5,
  courseName?: string
): Promise<BrowserProbeTarget[]> {
  const requestedCourseName = courseName?.trim().toLocaleLowerCase("en-US");
  if (requestedCourseName) {
    return listExactIncidentBrowserProbeTarget(requestedCourseName);
  }
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
      select: {
        courseId: true,
        status: true,
        kind: true,
        occurrenceCount: true,
        lastSeenAt: true,
        course: {
          select: {
            id: true,
            name: true,
            website: true,
            detectedBookingUrl: true,
            detectedPlatform: true,
            providerFamilyKey: true,
            automationEligibility: true,
            automationReason: true,
            bookingAccessMode: true,
            bookingMethod: true,
            isPublic: true,
            intelligenceVerifiedAt: true,
            intelligenceReviewAt: true,
            intelligenceConfidence: true,
            bookingMetadata: true,
            probes: {
              orderBy: { observedAt: "desc" },
              take: 1,
              select: { outcome: true, observedAt: true }
            }
          }
        }
      }
    })
  ]);
  const incidentPriority = new Map(
    openIncidents.map((incident) => [
      incident.courseId,
      incident.status === "NEEDS_HUMAN" ? 0 : 1
    ])
  );
  const monitoringFailureByCourse = new Map(
    openIncidents.map((incident) => [
      incident.courseId,
      getIncidentMonitoringFailureEvidence(incident)
    ])
  );

  const targets: Array<BrowserProbeTarget & { supportPriority: number }> = [];
  const queuedCourseIds = new Set<string>();

  for (const search of searches) {
    for (const preference of search.preferences) {
      const course = preference.course;
      const monitoringFailureEvidence = monitoringFailureByCourse.get(course.id);
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
          monitoringFailureEvidence
        },
        probeUrl,
        supportPriority: incidentPriority.get(course.id) ?? 2
      });
      queuedCourseIds.add(course.id);
    }
  }

  for (const incident of openIncidents) {
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
        monitoringFailureEvidence
      },
      probeUrl,
      supportPriority: incidentPriority.get(course.id) ?? 1
    });
    queuedCourseIds.add(course.id);
  }

  const orderedTargets = targets.sort(
    (left, right) => left.supportPriority - right.supportPriority || left.rank - right.rank
  );
  return orderedTargets
    .slice(0, limit)
    .map((target) => ({
      searchId: target.searchId,
      rank: target.rank,
      course: target.course,
      probeUrl: target.probeUrl
    }));
}

async function listExactIncidentBrowserProbeTarget(
  requestedCourseName: string
): Promise<BrowserProbeTarget[]> {
  const courses = await prisma.course.findMany({
    where: {
      name: { equals: requestedCourseName, mode: "insensitive" },
      supportIncident: { is: { status: { not: "RESOLVED" } } }
    },
    include: {
      supportIncident: {
        select: {
          kind: true,
          failureClass: true,
          occurrenceCount: true,
          lastSeenAt: true
        }
      },
      probes: {
        orderBy: { observedAt: "desc" },
        take: 1,
        select: { outcome: true, observedAt: true }
      },
      preferences: {
        where: {
          teeSearch: {
            status: "ACTIVE",
            date: { gte: startOfUtcCalendarDay() }
          }
        },
        orderBy: { rank: "asc" },
        take: 1,
        include: { teeSearch: { select: { id: true } } }
      }
    }
  });
  if (courses.length > 1) {
    throw new Error("The requested browser-probe course name is ambiguous.");
  }
  const course = courses[0];
  const monitoringFailureEvidence = course
    ? getIncidentMonitoringFailureEvidence({
        kind: course.supportIncident?.kind,
        occurrenceCount: course.supportIncident?.occurrenceCount,
        lastSeenAt: course.supportIncident?.lastSeenAt,
        course: { probes: course.probes ?? [] }
      })
    : undefined;
  const probeCourse = course ? { ...course, monitoringFailureEvidence } : null;
  const probeUrl = probeCourse ? getBestProbeUrl(probeCourse) : null;
  const hasCurrentTechnicalAccessFailure = Boolean(
    course?.supportIncident?.kind === "FETCH_FAILED" &&
      ["AUTH", "CHALLENGE"].includes(
        course.supportIncident.failureClass ?? ""
      )
  );
  const hasCurrentUnsupportedCoverageFailure = Boolean(
    course?.supportIncident?.kind === "NEEDS_ADAPTER" &&
      ["MISSING_SOURCE", "MISSING_METADATA", "UNSUPPORTED_FAMILY"].includes(
        course.supportIncident.failureClass ?? ""
      )
  );
  if (
    !course ||
    !probeUrl ||
    !probeCourse ||
    (!shouldQueueBrowserProbe(probeCourse) &&
      !hasCurrentTechnicalAccessFailure &&
      !hasCurrentUnsupportedCoverageFailure)
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
        monitoringFailureEvidence
      },
      probeUrl
    }
  ];
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
    (latestProbe.outcome === "MATCH_FOUND" || latestProbe.outcome === "NO_MATCH")
      ? latestProbe.observedAt
      : null;
  return {
    kind: "FETCH_FAILED",
    occurrenceCount: incident.occurrenceCount ?? 0,
    latestFailureAt: incident.lastSeenAt,
    latestSuccessfulAt
  };
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
  runtimeVersion?: string;
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
      runtimeVersion: input.runtimeVersion ?? getAutomationRuntimeVersion()
    }
  });
}

export async function recordBrowserDiscovery(input: BrowserDiscovery) {
  input = normalizeBrowserDiscoveryForMonitoring(input);
  const learnedOnline = input.status === "LEARNED" && Boolean(input.apiMetadata);
  const automationEligibility =
    input.automationEligibility ?? (learnedOnline ? "ALLOWED" : "UNKNOWN");
  const bookingMethod =
    input.bookingMethod ?? (learnedOnline && input.bookingUrl ? "PUBLIC_ONLINE" : "UNKNOWN");
  return prisma.courseAutomationDiscovery.create({
    data: {
      courseId: input.courseId,
      status: input.status,
      detectedPlatform: input.detectedPlatform,
      bookingMethod,
      bookingPhone: input.bookingPhone,
      automationEligibility,
      automationReason: input.automationReason ?? "NONE",
      bookingAccessMode: resolveBookingAccessMode({
        automationEligibility,
        automationReason: input.automationReason,
        bookingMethod,
        bookingAccessMode: input.bookingAccessMode
      }),
      sourceUrl: input.sourceUrl,
      bookingUrl: input.bookingUrl,
      apiEndpoint: input.apiEndpoint,
      apiMetadata: input.apiMetadata as Prisma.InputJsonValue | undefined,
      confidence: input.confidence,
      evidence: input.evidence as Prisma.InputJsonValue
    }
  });
}

export type BrowserDiscoveryCourseExpectation = {
  updatedAt: Date;
  detectedBookingUrl: string | null;
  bookingMethod: string;
  automationEligibility: string;
};

export async function retireLegacyPolicyOnlyCourseBlock(
  courseId: string,
  expectedCourse: BrowserDiscoveryCourseExpectation,
  preservation: {
    preserveWebsite: boolean;
    preserveDetectedBookingUrl: boolean;
    preserveBookingMetadata: boolean;
  }
) {
  const preserveProviderAccess =
    preservation.preserveDetectedBookingUrl ||
    preservation.preserveBookingMetadata;
  const updated = await prisma.course.updateMany({
    where: {
      id: courseId,
      updatedAt: expectedCourse.updatedAt,
      detectedBookingUrl: expectedCourse.detectedBookingUrl,
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED"
    },
    data: {
      ...(!preserveProviderAccess
        ? {
            providerFamilyKey: "SOURCE_MISSING",
            detectedPlatform: "UNKNOWN" as const
          }
        : {}),
      ...(!preservation.preserveWebsite ? { website: null } : {}),
      ...(!preservation.preserveDetectedBookingUrl
        ? { detectedBookingUrl: null }
        : {}),
      ...(!preservation.preserveBookingMetadata
        ? { bookingMetadata: Prisma.DbNull }
        : {}),
      ...(!preserveProviderAccess ? { bookingMethod: "UNKNOWN" as const } : {}),
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "OTHER",
      bookingAccessMode: "UNKNOWN",
      policyNotes:
        "Legacy booking-policy text is not a technical monitoring blocker. Current public monitoring support requires fresh verification.",
      intelligenceVerifiedAt: null,
      intelligenceReviewAt: null,
      intelligenceConfidence: null
    }
  });
  if (updated.count !== 1) {
    return null;
  }
  return prisma.course.findUnique({ where: { id: courseId } });
}

export async function applyBrowserDiscoveryToCourse(
  input: BrowserDiscovery,
  expectedCourse?: BrowserDiscoveryCourseExpectation
) {
  input = normalizeBrowserDiscoveryForMonitoring(input);
  const provider = resolveProviderCapability({
    detectedPlatform: input.detectedPlatform,
    detectedBookingUrl: input.bookingUrl,
    website: input.sourceUrl,
    bookingMetadata: input.apiMetadata
  });
  const inspectedProviderIdentity =
    input.status === "INSPECTED"
      ? resolveProviderDiscoveryIdentity({
          detectedPlatform: input.detectedPlatform,
          bookingUrl: input.bookingUrl,
          apiMetadata: input.apiMetadata,
          confidence: input.confidence
        })
      : null;
  const learnedOnlineAdapter =
    input.status === "LEARNED" &&
    provider.isRunnable;
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
        input.confidence >= 0.8
    );
  const sourceUnavailableClassification =
    isSourceUnavailableClassification(input);

  if (
    !learnedOnlineAdapter &&
    !verifiedClassification &&
    !sourceUnavailableClassification
  ) {
    if (!inspectedProviderIdentity) {
      return null;
    }

    const current = await prisma.course.findUnique({
      where: { id: input.courseId },
      select: {
        providerFamilyKey: true,
        detectedPlatform: true,
        detectedBookingUrl: true,
        website: true,
        bookingMetadata: true,
        isPublic: true,
        bookingMethod: true,
        automationEligibility: true,
        automationReason: true,
        bookingAccessMode: true,
        intelligenceVerifiedAt: true,
        intelligenceReviewAt: true,
        intelligenceConfidence: true,
        updatedAt: true
      }
    });
    if (!current || !matchesBrowserDiscoveryCourseExpectation(current, expectedCourse)) {
      return null;
    }

    const persistedProvider = resolveProviderCapability(current);
    if (
      persistedProvider.evidenceConflict ||
      persistedProvider.isRunnable ||
      (persistedProvider.capability &&
        persistedProvider.providerFamilyKey !==
          inspectedProviderIdentity.providerFamilyKey)
    ) {
      return null;
    }

    const updated = await prisma.course.updateMany({
      where: { id: input.courseId, updatedAt: current.updatedAt },
      data: {
        detectedPlatform: inspectedProviderIdentity.detectedPlatform,
        providerFamilyKey: inspectedProviderIdentity.providerFamilyKey,
        ...(input.bookingUrl
          ? { detectedBookingUrl: input.bookingUrl }
          : {})
      }
    });
    if (updated.count !== 1) {
      return null;
    }

    return prisma.course.findUnique({ where: { id: input.courseId } });
  }

  const bookingMethod = input.bookingMethod ?? "PUBLIC_ONLINE";
  const automationEligibility = input.automationEligibility ?? "ALLOWED";
  const manualOnly =
    automationEligibility === "BLOCKED" &&
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(bookingMethod);

  const current = await prisma.course.findUnique({
    where: { id: input.courseId },
    select: {
      name: true,
      providerFamilyKey: true,
      detectedPlatform: true,
      detectedBookingUrl: true,
      website: true,
      bookingMetadata: true,
      isPublic: true,
      bookingMethod: true,
      automationEligibility: true,
      automationReason: true,
      bookingAccessMode: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      updatedAt: true
    }
  });
  if (!current || !matchesBrowserDiscoveryCourseExpectation(current, expectedCourse)) {
    return null;
  }
  const persistedProvider = resolveProviderCapability(current);
  const persistedGate = evaluateMonitoringGate(current);
  const differentKnownProvider = Boolean(
    persistedProvider.capability &&
      provider.capability &&
      persistedProvider.providerFamilyKey !== provider.providerFamilyKey
  );
  const replacingLegacyPolicyOnlyBlock = Boolean(
    expectedCourse &&
    input.status === "VERIFIED" &&
    verifiedClassification &&
    current.automationEligibility === "BLOCKED" &&
    current.automationReason === "AUTOMATION_PROHIBITED" &&
    input.automationReason !== "AUTOMATION_PROHIBITED"
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
        current.name
      )
  );
  const corroboratedPrivateReopening = Boolean(
    learnedOnlineAdapter &&
      current.isPublic === false &&
      hasPersistedOfficialCourseProviderCorroboration(
        input,
        current.website,
        current.name
      )
  );
  const trustedPersistedReplacement =
    replacingLegacyPolicyOnlyBlock ||
    corroboratedLearnedReplacement ||
    corroboratedPrivateReopening;
  const sourceUnavailableWouldReplaceProviderState = Boolean(
    sourceUnavailableClassification &&
      !canApplySourceUnavailableClassification({
        current,
        discovery: input,
        persistedProviderFamilyKey: persistedProvider.providerFamilyKey,
        persistedProviderKnown: Boolean(persistedProvider.capability),
        persistedProviderConflict: persistedProvider.evidenceConflict
      })
  );
  if (
    provider.evidenceConflict ||
    (persistedProvider.evidenceConflict && !trustedPersistedReplacement) ||
    (current.isPublic === false &&
      !verifiedPrivateIdentity &&
      !corroboratedPrivateReopening) ||
    sourceUnavailableWouldReplaceProviderState ||
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

  const updated = await prisma.course.updateMany({
    where: { id: input.courseId, updatedAt: current.updatedAt },
    data: sourceUnavailableClassification
      ? {
          automationEligibility,
          bookingMethod,
          automationReason: input.automationReason ?? "NONE",
          policyNotes: input.policyNotes,
          intelligenceVerifiedAt: new Date(),
          intelligenceReviewAt: new Date(input.intelligenceReviewAt!),
          intelligenceConfidence: input.confidence
        }
      : verifiedPrivateIdentity
        ? {
            isPublic: false,
            bookingMethod: "UNKNOWN",
            automationEligibility: "BLOCKED",
            automationReason: "OTHER",
            bookingAccessMode: "UNKNOWN",
            policyNotes: input.policyNotes,
            intelligenceVerifiedAt: new Date(),
            intelligenceReviewAt: new Date(input.intelligenceReviewAt!),
            intelligenceConfidence: input.confidence
          }
      : {
          ...(corroboratedPrivateReopening
            ? { isPublic: true, policyNotes: null }
            : { policyNotes: input.policyNotes }),
          detectedPlatform: input.detectedPlatform,
          providerFamilyKey: provider.providerFamilyKey,
          automationEligibility,
          detectedBookingUrl: manualOnly ? null : input.bookingUrl,
          bookingMetadata: manualOnly
            ? Prisma.DbNull
            : (input.apiMetadata as Prisma.InputJsonValue),
          bookingMethod,
          bookingAccessMode: resolveBookingAccessMode({
            automationEligibility,
            automationReason: input.automationReason,
            bookingMethod,
            bookingAccessMode: input.bookingAccessMode
          }),
          bookingPhone: corroboratedPrivateReopening
            ? (input.bookingPhone ?? null)
            : input.bookingPhone,
          automationReason: input.automationReason ?? "NONE",
          intelligenceVerifiedAt: new Date(),
          intelligenceReviewAt: input.intelligenceReviewAt
            ? new Date(input.intelligenceReviewAt)
            : null,
          intelligenceConfidence: input.confidence
        }
  });
  if (updated.count !== 1) {
    return null;
  }

  return prisma.course.findUnique({ where: { id: input.courseId } });
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
      (key) => !["finalUrl", "learnedFrom", "observedUrls"].includes(key)
    )
  ) {
    return false;
  }
  const expectedUrls = new Set([source.toString(), finalUrl.toString()]);
  return Boolean(
    input.evidence.observedUrls.length === expectedUrls.size &&
      input.evidence.observedUrls.every((value) => expectedUrls.has(value))
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
      (current.bookingMetadata === null || current.bookingMetadata === undefined) &&
      (!current.bookingMethod || current.bookingMethod === "UNKNOWN") &&
      (!current.automationEligibility ||
        ["UNKNOWN", "NEEDS_REVIEW"].includes(current.automationEligibility)) &&
      (!current.automationReason ||
        ["NONE", "TEMPORARILY_UNAVAILABLE"].includes(
          current.automationReason
        ))
  );
}

function matchesBrowserDiscoveryCourseExpectation(
  current: BrowserDiscoveryCourseExpectation,
  expected?: BrowserDiscoveryCourseExpectation
) {
  return Boolean(
    !expected ||
      (current.updatedAt.getTime() === expected.updatedAt.getTime() &&
        current.detectedBookingUrl === expected.detectedBookingUrl &&
        current.bookingMethod === expected.bookingMethod &&
        current.automationEligibility === expected.automationEligibility)
  );
}

const VERIFIED_PRIVATE_IDENTITY_POLICY_NOTES = new Map([
  [
    "official-private-course-profile",
    "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory."
  ],
  [
    "official-private-club-access",
    "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course."
  ],
  [
    "official-resident-member-access",
    "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course."
  ]
]);

function isVerifiedPrivateIdentityDiscovery(
  discovery: BrowserDiscovery,
  now = new Date()
) {
  const learnedFrom = discovery.evidence.learnedFrom;
  const [baseLearnedFrom, ...provenanceMarkers] = learnedFrom.split(":");
  const validProvenance =
    provenanceMarkers.length === 0 ||
    (provenanceMarkers.length === 1 &&
      provenanceMarkers[0] === "legacy-policy-reconciliation");
  const expectedPolicyNotes =
    validProvenance
      ? VERIFIED_PRIVATE_IDENTITY_POLICY_NOTES.get(baseLearnedFrom)
      : undefined;
  const source = parseSafePublicUrl(discovery.sourceUrl);
  const booking = parseSafePublicUrl(discovery.bookingUrl ?? "");
  const finalUrl = parseSafePublicUrl(discovery.evidence.finalUrl ?? "");
  const reviewAt = discovery.intelligenceReviewAt
    ? new Date(discovery.intelligenceReviewAt)
    : null;
  const maximumReviewAt = new Date(
    now.getTime() + 181 * 24 * 60 * 60 * 1000
  );
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
      reviewAt.getTime() <= maximumReviewAt.getTime()
  );
}

function normalizeBrowserDiscoveryForMonitoring(
  discovery: BrowserDiscovery
): BrowserDiscovery {
  const normalized = keepPolicyOnlyDiscoveryActionable(discovery);
  const gate = evaluateBrowserDiscoveryMonitoringGate(normalized);
  const manualFieldsPresent =
    ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      normalized.bookingMethod ?? ""
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
      }`
    }
  };
}

function hasPersistedOfficialCourseProviderCorroboration(
  discovery: BrowserDiscovery,
  persistedWebsite: string | null,
  persistedCourseName?: string
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
    resolveProviderCapability({ detectedBookingUrl: persisted.toString() }).capability
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

function parseSafePublicUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
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
      unavailableAt: true,
      availabilityCycle: true
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
        ? {
            alertStatus: "PENDING",
            sentAt: null,
            availabilityCycle: { increment: 1 }
          }
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
  alertGeneration: number;
  checkLeaseToken: string;
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

  return prisma.$transaction(async (transaction) => {
    const search = await lockSearchForEmailReconciliation(transaction, {
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      now: unavailableAt
    });
    if (!search) {
      throw new Error("Search check is no longer current during availability reconciliation");
    }
    const pendingMatches = await transaction.teeTimeMatch.findMany({
      where: {
        ...missingMatchWhere,
        alertStatus: "PENDING"
      },
      select: { id: true, availabilityCycle: true }
    });
    await suppressSearchEmailDeliveriesForMatches({
      searchId: input.searchId,
      alertGeneration: input.alertGeneration,
      checkLeaseToken: input.checkLeaseToken,
      matchRefs: pendingMatches.map((match) => ({
        matchId: match.id,
        availabilityCycle: match.availabilityCycle
      })),
      now: unavailableAt,
      transaction
    });
    const suppressed = await transaction.teeTimeMatch.updateMany({
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
    });
    const reconciled = await transaction.teeTimeMatch.updateMany({
      where: {
        ...missingMatchWhere,
        alertStatus: { not: "PENDING" }
      },
      data: {
        availabilityStatus: "GONE",
        unavailableAt
      }
    });
    return [suppressed, reconciled];
  });
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
  updatedAt: true
} satisfies Prisma.TeeSearchSelect;

export type QueuedSearchCheck = Prisma.TeeSearchGetPayload<{
  select: typeof queuedSearchCheckSelect;
}>;

export type SearchScheduleExpectedState = {
  scheduleVersion: number;
  updatedAt: Date;
  observedAt: Date;
};

export type SearchScheduleNotEligible = {
  outcome: "not_eligible";
  reason: "state_changed";
};

export function queueSearchCheck(
  searchId: string,
  remediationDispatchKey?: string
): Promise<QueuedSearchCheck | null>;
export function queueSearchCheck(
  searchId: string,
  remediationDispatchKey: string | undefined,
  expectedState: SearchScheduleExpectedState
): Promise<QueuedSearchCheck | SearchScheduleNotEligible>;

export async function queueSearchCheck(
  searchId: string,
  remediationDispatchKey?: string,
  expectedState?: SearchScheduleExpectedState
): Promise<QueuedSearchCheck | SearchScheduleNotEligible | null> {
  if (remediationDispatchKey && remediationDispatchKey.length > 128) {
    throw new Error("Remediation dispatch key is too long.");
  }
  if (remediationDispatchKey && expectedState) {
    throw new Error("Expected-state guards cannot be combined with remediation dispatch.");
  }
  return prisma.$transaction(async (tx) => {
    if (expectedState) {
      const updated = await tx.teeSearch.updateMany({
        where: {
          id: searchId,
          status: "ACTIVE",
          scheduleVersion: expectedState.scheduleVersion,
          updatedAt: expectedState.updatedAt,
          checkStatus: "WAITING",
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: expectedState.observedAt } }
          ]
        },
        data: {
          scheduleVersion: { increment: 1 },
          checkStatus: "QUEUED",
          nextCheckAt: new Date(),
          lastCheckOutcome: null,
          workflowRunId: null,
          checkLeaseToken: null,
          checkLeaseExpiresAt: null,
          recheckRequestedAt: null
        }
      });
      if (updated.count === 0) {
        return {
          outcome: "not_eligible" as const,
          reason: "state_changed" as const
        };
      }
      const queued = await tx.teeSearch.findUnique({
        where: {
          id: searchId,
          status: "ACTIVE",
          scheduleVersion: expectedState.scheduleVersion + 1,
          checkStatus: "QUEUED",
          workflowRunId: null
        },
        select: queuedSearchCheckSelect
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
            updatedAt: true
          }
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
            scheduleVersion: current.remediationDispatchVersion
          };
        }

        const nextVersion = current.scheduleVersion + 1;
        const updated = await tx.teeSearch.updateMany({
          where: {
            id: searchId,
            status: "ACTIVE",
            scheduleVersion: current.scheduleVersion,
            OR: [
              { remediationDispatchKey: null },
              { remediationDispatchKey: { not: remediationDispatchKey } }
            ]
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
            recheckRequestedAt: null
          }
        });
        if (updated.count === 1) {
          return tx.teeSearch.findUnique({
            where: { id: searchId },
            select: queuedSearchCheckSelect
          });
        }
      }

      throw new Error("Remediation dispatch could not claim the search schedule.");
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
        recheckRequestedAt: null
      }
    });
    return tx.teeSearch.findUnique({
      where: { id: searchId },
      select: queuedSearchCheckSelect
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
      nextCheckAt: true
    }
  });
}

export async function attachSearchWorkflowRun(
  searchId: string,
  scheduleVersion: number,
  workflowRunId: string,
  expectedWorkflowRunId: string | null
) {
  return prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE",
      workflowRunId: expectedWorkflowRunId
    },
    data: {
      workflowRunId
    }
  });
}

export async function claimScheduledSearchCheck(searchId: string, scheduleVersion: number) {
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
        { checkLeaseExpiresAt: { lte: now } }
      ]
    },
    data: {
      checkStatus: "CHECKING",
      nextCheckAt: null,
      checkLeaseToken: token,
      checkLeaseExpiresAt: expiresAt,
      recheckRequestedAt: null
    }
  });

  if (result.count === 1) {
    return { searchId, scheduleVersion, token, expiresAt } satisfies SearchCheckLease;
  }

  await requestSearchRecheck(searchId, scheduleVersion, now);
  return null;
}

async function claimDirectSearchCheckLease(searchId: string) {
  const state = await prisma.teeSearch.findFirst({
    where: { id: searchId, status: "ACTIVE" },
    select: { scheduleVersion: true }
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
        { checkLeaseExpiresAt: { lte: now } }
      ]
    },
    data: {
      checkLeaseToken: token,
      checkLeaseExpiresAt: expiresAt
    }
  });
  if (claimed.count !== 1) {
    await requestSearchRecheck(searchId, state.scheduleVersion, now);
    return null;
  }

  return {
    searchId,
    scheduleVersion: state.scheduleVersion,
    token,
    expiresAt
  } satisfies SearchCheckLease;
}

export async function requestSearchRecheck(
  searchId: string,
  scheduleVersion: number,
  requestedAt = new Date()
) {
  return prisma.teeSearch.updateMany({
    where: {
      id: searchId,
      scheduleVersion,
      status: "ACTIVE"
    },
    data: {
      recheckRequestedAt: requestedAt
    }
  });
}

export async function heartbeatSearchCheckLease(
  lease: SearchCheckLease,
  now = new Date()
) {
  const expiresAt = new Date(now.getTime() + SEARCH_CHECK_LEASE_MS);
  const result = await prisma.teeSearch.updateMany({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      status: "ACTIVE",
      checkLeaseToken: lease.token,
      checkLeaseExpiresAt: { gt: now }
    },
    data: { checkLeaseExpiresAt: expiresAt }
  });
  if (result.count === 1) {
    lease.expiresAt = expiresAt;
  }
  return result.count === 1;
}

export async function isSearchCheckLeaseCurrent(
  lease: SearchCheckLease,
  now = new Date()
) {
  const current = await prisma.teeSearch.findFirst({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      status: "ACTIVE",
      checkLeaseToken: lease.token,
      checkLeaseExpiresAt: { gt: now }
    },
    select: { id: true }
  });
  return Boolean(current);
}

async function releaseSearchCheckLease(lease: SearchCheckLease) {
  await prisma.teeSearch.updateMany({
    where: {
      id: lease.searchId,
      scheduleVersion: lease.scheduleVersion,
      checkLeaseToken: lease.token
    },
    data: {
      checkLeaseToken: null,
      checkLeaseExpiresAt: null
    }
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
  const rows = await prisma.$queryRaw<Array<{ recheckRequested: boolean; nextCheckAt: Date | null }>>(
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
    `
  );

  return rows[0] ?? null;
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
    "expectedWorkflowRunId"
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
        ${hasExpectedWorkflowRunId
          ? Prisma.sql`AND "workflowRunId" IS NOT DISTINCT FROM ${input.expectedWorkflowRunId}`
          : Prisma.empty}
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
    nextCheckAt: rows[0]?.nextCheckAt ?? null
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
      recheckRequestedAt: null
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
      nextCheckAt: true,
      workflowRunId: true,
      checkStatus: true
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
              bookingWindowObservedAt: true
            }
          }
        }
      }
    }
  });
}

export async function listSearchesNeedingScheduleRecovery() {
  const now = new Date();
  const queuedOverdueBefore = new Date(now.getTime() - 2 * 60 * 1000);
  const overdueBefore = new Date(now.getTime() - 10 * 60 * 1000);
  const missingInitialVerdictBefore = new Date(now.getTime() - 20 * 60 * 1000);
  return prisma.teeSearch.findMany({
    where: {
      status: "ACTIVE",
      date: { gte: startOfUtcCalendarDay() },
      OR: [
        { checkStatus: "IDLE" },
        {
          checkStatus: "QUEUED",
          workflowRunId: null,
          updatedAt: { lte: queuedOverdueBefore }
        },
        {
          checkStatus: "QUEUED",
          workflowRunId: { not: null },
          updatedAt: { lte: overdueBefore }
        },
        {
          checkStatus: "CHECKING",
          OR: [
            { checkLeaseExpiresAt: null },
            { checkLeaseExpiresAt: { lte: now } }
          ]
        },
        { checkStatus: "FAILED", nextCheckAt: { lte: now } },
        { checkStatus: "WAITING", nextCheckAt: { lte: overdueBefore } },
        {
          AND: [
            {
              statusEmailSentAt: null,
              createdAt: { lte: missingInitialVerdictBefore }
            },
            {
              checkStatus: { in: ["WAITING", "FAILED"] },
              OR: [
                { checkLeaseExpiresAt: null },
                { checkLeaseExpiresAt: { lte: now } }
              ]
            }
          ]
        },
        {
          AND: [
            {
              checkStatus: { in: ["WAITING", "FAILED"] },
              OR: [
                { checkLeaseExpiresAt: null },
                { checkLeaseExpiresAt: { lte: now } }
              ]
            },
            {
              OR: [
                {
                  emailDeliveries: {
                    some: {
                      OR: [
                        { status: "PENDING", createdAt: { lte: overdueBefore } },
                        { status: "FAILED", nextAttemptAt: { lte: now } },
                        { status: "SENDING", claimExpiresAt: { lte: now } }
                      ]
                    }
                  }
                },
                {
                  matches: {
                    some: {
                      availabilityStatus: "AVAILABLE",
                      alertStatus: "PENDING",
                      firstSeenAt: { lte: overdueBefore }
                    }
                  }
                }
              ]
            }
          ]
        }
      ]
    },
    select: { id: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 50
  });
}

type MatchAlertCycleRef = {
  matchId: string;
  availabilityCycle: number;
};

async function markMatchAlertStatus(
  input: MatchAlertCycleRef,
  alertStatus: "SENT" | "SUPPRESSED"
) {
  const sentAt = new Date();
  const updated = await prisma.teeTimeMatch.updateMany({
    where: {
      id: input.matchId,
      availabilityCycle: input.availabilityCycle,
      alertStatus: "PENDING"
    },
    data: { alertStatus, sentAt }
  });
  return updated.count === 1
    ? {
        id: input.matchId,
        availabilityCycle: input.availabilityCycle,
        alertStatus,
        sentAt
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
      status: "ACTIVE"
    },
    data: {
      statusEmailSentAt: input.sentAt,
      statusEmailSnapshot: input.snapshot
    }
  });
}

export async function recordCourseProbeIfChanged(input: CourseProbeInput) {
  const runtimeVersion = input.runtimeVersion ?? getAutomationRuntimeVersion();
  const latest = await prisma.courseProbe.findFirst({
    where: {
      teeSearchId: input.searchId,
      courseId: input.courseId
    },
    orderBy: { observedAt: "desc" }
  });

  if (
    latest?.outcome === input.outcome &&
    latest.message === (input.message ?? null) &&
    latest.runtimeVersion === runtimeVersion &&
    getProviderExecutionMarker(latest.rawSummary) ===
      getProviderExecutionMarker(input.rawSummary)
  ) {
    return latest;
  }

  return recordCourseProbe({ ...input, runtimeVersion });
}

function getProviderExecutionMarker(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return (value as Record<string, unknown>).providerExecution ?? null;
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
      createdAt: { gt: since }
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      courseId: true,
      status: true,
      sourceUrl: true,
      createdAt: true,
      evidence: true
    }
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
