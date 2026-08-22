import type { WebsiteTrafficClass } from "@prisma/client";

import { classifyProviderCoverage } from "@/lib/automation/provider-coverage";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { localReaderResultSchema } from "@/lib/local-reader/contracts";
import {
  getLocalReaderCourseKey,
  isLocalReaderCandidateUrl,
} from "@/lib/local-reader/course-key";
import { prisma } from "@/lib/prisma";

import {
  buildCourseInventory,
  summarizeCourseInventory,
} from "./course-status";

const NON_SYNTHETIC_TRAFFIC: { notIn: WebsiteTrafficClass[] } = {
  notIn: [...syntheticWebsiteTrafficClasses],
};
const RECENT_LOCAL_READER_DAYS = 30;

export async function loadOperatorCourseFleet(input: { now?: Date } = {}) {
  const now = input.now ?? new Date();
  const recentLocalReaderSince = new Date(
    now.getTime() - RECENT_LOCAL_READER_DAYS * 24 * 60 * 60 * 1000,
  );
  const allCourses = await prisma.course.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      address: true,
      city: true,
      stateCode: true,
      isPublic: true,
      detectedPlatform: true,
      providerFamilyKey: true,
      automationEligibility: true,
      automationReason: true,
      bookingAccessMode: true,
      bookingMethod: true,
      bookingMetadata: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      detectedBookingUrl: true,
      website: true,
      automationDiscoveries: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          status: true,
          detectedPlatform: true,
          bookingMethod: true,
          automationEligibility: true,
          automationReason: true,
          bookingAccessMode: true,
          bookingUrl: true,
          confidence: true,
          evidence: true,
          createdAt: true,
        },
      },
      profile: {
        select: {
          canonicalSlug: true,
          status: true,
        },
      },
      supportIncident: {
        select: {
          id: true,
          status: true,
          kind: true,
          activeRealSearchCount: true,
          cycle: true,
          firstSeenAt: true,
          resolvedAt: true,
          resolution: true,
          engineeringOnly: true,
          latestMessage: true,
          nextAction: true,
          failureClass: true,
          humanReviewReason: true,
          escalatedAt: true,
          escalationDeadlineAt: true,
          nextAttemptAt: true,
          activeBatchId: true,
          activeBatch: {
            select: {
              status: true,
              leaseExpiresAt: true,
            },
          },
          attemptCount: true,
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
      monitoringStatus: {
        select: {
          reference: true,
          state: true,
          lastSuccessfulAt: true,
          lastFailureAt: true,
          nextAutomaticAttemptAt: true,
          revalidationRequestedAt: true,
        },
      },
      localReaderJobs: {
        where: {
          status: "COMPLETED",
          completedAt: { gte: recentLocalReaderSince },
        },
        orderBy: { completedAt: "desc" },
        take: 1,
        select: {
          completedAt: true,
          readerVersion: true,
          result: true,
        },
      },
    },
  });

  const allCourseIds = allCourses.map((course) => course.id);
  const [
    allLatestProbes,
    selectionCounts,
    activeAlertCounts,
    activeSyntheticAlertCounts,
  ] = await Promise.all([
    allCourseIds.length > 0
      ? prisma.courseProbe.findMany({
          where: {
            courseId: { in: allCourseIds },
          },
          orderBy: { observedAt: "desc" },
          distinct: ["courseId"],
          select: {
            courseId: true,
            outcome: true,
            observedAt: true,
            message: true,
            evidenceUrl: true,
          },
        })
      : [],
    prisma.coursePreference.groupBy({
      by: ["courseId"],
      where: {
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.coursePreference.groupBy({
      by: ["courseId"],
      where: {
        teeSearch: {
          status: "ACTIVE",
          trafficClass: NON_SYNTHETIC_TRAFFIC,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.coursePreference.groupBy({
      by: ["courseId"],
      where: {
        teeSearch: {
          status: "ACTIVE",
          trafficClass: "TEST",
          syntheticMultiCycle: true,
        },
      },
      _count: {
        _all: true,
      },
    }),
  ]);
  const allLatestProbeByCourse = new Map(
    allLatestProbes.map((probe) => [probe.courseId, probe]),
  );
  const selectionCountByCourse = new Map(
    selectionCounts.map((group) => [group.courseId, group._count._all]),
  );
  const activeAlertCountByCourse = new Map(
    activeAlertCounts.map((group) => [group.courseId, group._count._all]),
  );
  const activeSyntheticAlertCountByCourse = new Map(
    activeSyntheticAlertCounts.map((group) => [
      group.courseId,
      group._count._all,
    ]),
  );
  const courses = buildCourseInventory(
    allCourses.map((course) => {
      const latestProbe = allLatestProbeByCourse.get(course.id);
      const latestLocalReaderJob = course.localReaderJobs[0];
      const latestLocalReaderResult = localReaderResultSchema.safeParse(
        latestLocalReaderJob?.result,
      );
      const localReaderVerified =
        latestLocalReaderResult.success &&
        (latestLocalReaderResult.data.status === "AVAILABLE" ||
          latestLocalReaderResult.data.status === "NO_AVAILABILITY");
      const coverageCategory = classifyProviderCoverage(
        {
          isPublic: course.isPublic,
          website: course.website,
          detectedBookingUrl: course.detectedBookingUrl,
          detectedPlatform: course.detectedPlatform,
          providerFamilyKey: course.providerFamilyKey,
          bookingMethod: course.bookingMethod,
          automationEligibility: course.automationEligibility,
          automationReason: course.automationReason,
          bookingMetadata: course.bookingMetadata,
          intelligenceVerifiedAt: course.intelligenceVerifiedAt,
          intelligenceReviewAt: course.intelligenceReviewAt,
          intelligenceConfidence: course.intelligenceConfidence,
          probes: latestProbe
            ? [
                {
                  outcome: latestProbe.outcome,
                  observedAt: latestProbe.observedAt,
                },
              ]
            : [],
          supportIncident: course.supportIncident,
        },
        now,
      );
      return {
        id: course.id,
        name: course.name,
        address: course.address,
        city: course.city,
        stateCode: course.stateCode,
        providerFamilyKey: course.providerFamilyKey,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
        bookingAccessMode: course.bookingAccessMode,
        bookingMethod: course.bookingMethod,
        detectedBookingUrl: sanitizeOperatorUrl(course.detectedBookingUrl),
        website: sanitizeOperatorUrl(course.website),
        localReaderSupported:
          getLocalReaderCourseKey(course.detectedBookingUrl) !== null,
        localReaderCandidate: isLocalReaderCandidateUrl(
          course.detectedBookingUrl,
        ),
        localReaderVerifiedAt: localReaderVerified
          ? (latestLocalReaderJob?.completedAt ?? null)
          : null,
        localReaderVersion: localReaderVerified
          ? (latestLocalReaderJob?.readerVersion ?? null)
          : null,
        activeAlertCount: activeAlertCountByCourse.get(course.id) ?? 0,
        activeSyntheticAlertCount:
          activeSyntheticAlertCountByCourse.get(course.id) ?? 0,
        selectionCount: selectionCountByCourse.get(course.id) ?? 0,
        monitoringStatus: course.monitoringStatus,
        incident: course.supportIncident,
        latestProbe: latestProbe
          ? {
              ...latestProbe,
              evidenceUrl: sanitizeOperatorUrl(latestProbe.evidenceUrl),
            }
          : null,
        latestDiscovery: buildOperatorDiscoverySummary(
          course.automationDiscoveries[0] ?? null,
        ),
        coverageCategory,
        profileSlug:
          course.profile?.status === "PUBLISHED"
            ? course.profile.canonicalSlug
            : null,
      };
    }),
    now,
  );

  return {
    courses,
    counts: summarizeCourseInventory(courses),
  };
}

export type OperatorCourseFleet = Awaited<
  ReturnType<typeof loadOperatorCourseFleet>
>;
export type OperatorCourseFleetCounts = OperatorCourseFleet["counts"];

export async function loadOperatorCourseFleetCounts(
  input: { now?: Date } = {},
): Promise<OperatorCourseFleetCounts> {
  const now = input.now ?? new Date();
  const recentLocalReaderSince = new Date(
    now.getTime() - RECENT_LOCAL_READER_DAYS * 24 * 60 * 60 * 1000,
  );
  const courses = await prisma.course.findMany({
    select: {
      id: true,
      isPublic: true,
      detectedPlatform: true,
      providerFamilyKey: true,
      automationEligibility: true,
      automationReason: true,
      bookingAccessMode: true,
      bookingMethod: true,
      bookingMetadata: true,
      intelligenceVerifiedAt: true,
      intelligenceReviewAt: true,
      intelligenceConfidence: true,
      detectedBookingUrl: true,
      website: true,
      automationDiscoveries: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          status: true,
          detectedPlatform: true,
          bookingMethod: true,
          automationEligibility: true,
          automationReason: true,
          bookingAccessMode: true,
          bookingUrl: true,
          confidence: true,
          evidence: true,
          createdAt: true,
        },
      },
      supportIncident: {
        select: {
          id: true,
          status: true,
          kind: true,
          activeRealSearchCount: true,
          cycle: true,
          firstSeenAt: true,
          resolvedAt: true,
          resolution: true,
          engineeringOnly: true,
          latestMessage: true,
          nextAction: true,
          failureClass: true,
          humanReviewReason: true,
          escalatedAt: true,
          escalationDeadlineAt: true,
          nextAttemptAt: true,
          activeBatchId: true,
          activeBatch: {
            select: {
              status: true,
              leaseExpiresAt: true,
            },
          },
          attemptCount: true,
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
      monitoringStatus: {
        select: {
          reference: true,
          state: true,
          lastSuccessfulAt: true,
          lastFailureAt: true,
          nextAutomaticAttemptAt: true,
          revalidationRequestedAt: true,
        },
      },
      localReaderJobs: {
        where: {
          status: "COMPLETED",
          completedAt: { gte: recentLocalReaderSince },
        },
        orderBy: { completedAt: "desc" },
        take: 1,
        select: {
          completedAt: true,
          result: true,
        },
      },
    },
  });

  const courseIds = courses.map((course) => course.id);
  const [latestProbes, activeAlertCounts, activeSyntheticAlertCounts] =
    await Promise.all([
      courseIds.length > 0
        ? prisma.courseProbe.findMany({
            where: { courseId: { in: courseIds } },
            orderBy: { observedAt: "desc" },
            distinct: ["courseId"],
            select: {
              courseId: true,
              outcome: true,
              observedAt: true,
              message: true,
            },
          })
        : [],
      prisma.coursePreference.groupBy({
        by: ["courseId"],
        where: {
          teeSearch: {
            status: "ACTIVE",
            trafficClass: NON_SYNTHETIC_TRAFFIC,
          },
        },
        _count: { _all: true },
      }),
      prisma.coursePreference.groupBy({
        by: ["courseId"],
        where: {
          teeSearch: {
            status: "ACTIVE",
            trafficClass: "TEST",
            syntheticMultiCycle: true,
          },
        },
        _count: { _all: true },
      }),
    ]);
  const latestProbeByCourse = new Map(
    latestProbes.map((probe) => [probe.courseId, probe]),
  );
  const activeAlertCountByCourse = new Map(
    activeAlertCounts.map((group) => [group.courseId, group._count._all]),
  );
  const activeSyntheticAlertCountByCourse = new Map(
    activeSyntheticAlertCounts.map((group) => [
      group.courseId,
      group._count._all,
    ]),
  );
  const inventory = buildCourseInventory(
    courses.map((course) => {
      const latestProbe = latestProbeByCourse.get(course.id);
      const latestLocalReaderJob = course.localReaderJobs[0];
      const latestLocalReaderResult = localReaderResultSchema.safeParse(
        latestLocalReaderJob?.result,
      );
      const localReaderVerified =
        latestLocalReaderResult.success &&
        (latestLocalReaderResult.data.status === "AVAILABLE" ||
          latestLocalReaderResult.data.status === "NO_AVAILABILITY");
      return {
        id: course.id,
        name: course.id,
        address: null,
        city: null,
        stateCode: null,
        providerFamilyKey: course.providerFamilyKey,
        automationEligibility: course.automationEligibility,
        automationReason: course.automationReason,
        bookingAccessMode: course.bookingAccessMode,
        bookingMethod: course.bookingMethod,
        detectedBookingUrl: course.detectedBookingUrl,
        website: course.website,
        localReaderSupported:
          getLocalReaderCourseKey(course.detectedBookingUrl) !== null,
        localReaderCandidate: isLocalReaderCandidateUrl(
          course.detectedBookingUrl,
        ),
        localReaderVerifiedAt: localReaderVerified
          ? (latestLocalReaderJob?.completedAt ?? null)
          : null,
        localReaderVersion: null,
        activeAlertCount: activeAlertCountByCourse.get(course.id) ?? 0,
        activeSyntheticAlertCount:
          activeSyntheticAlertCountByCourse.get(course.id) ?? 0,
        selectionCount: 0,
        monitoringStatus: course.monitoringStatus,
        incident: course.supportIncident,
        latestProbe: latestProbe ? { ...latestProbe, evidenceUrl: null } : null,
        latestDiscovery: buildOperatorDiscoverySummary(
          course.automationDiscoveries[0] ?? null,
        ),
        profileSlug: null,
        coverageCategory: classifyProviderCoverage(
          {
            isPublic: course.isPublic,
            website: course.website,
            detectedBookingUrl: course.detectedBookingUrl,
            detectedPlatform: course.detectedPlatform,
            providerFamilyKey: course.providerFamilyKey,
            bookingMethod: course.bookingMethod,
            automationEligibility: course.automationEligibility,
            automationReason: course.automationReason,
            bookingMetadata: course.bookingMetadata,
            intelligenceVerifiedAt: course.intelligenceVerifiedAt,
            intelligenceReviewAt: course.intelligenceReviewAt,
            intelligenceConfidence: course.intelligenceConfidence,
            probes: latestProbe
              ? [
                  {
                    outcome: latestProbe.outcome,
                    observedAt: latestProbe.observedAt,
                  },
                ]
              : [],
            supportIncident: course.supportIncident,
          },
          now,
        ),
      };
    }),
    now,
  );
  return summarizeCourseInventory(inventory);
}

function sanitizeOperatorUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function buildOperatorDiscoverySummary(
  discovery: {
    status: string;
    detectedPlatform: string;
    bookingMethod: string;
    automationEligibility: string;
    automationReason: string;
    bookingAccessMode: string;
    bookingUrl: string | null;
    confidence: number;
    evidence: unknown;
    createdAt: Date;
  } | null,
) {
  if (!discovery) return null;
  const bookingUrl = sanitizeOperatorUrl(discovery.bookingUrl);
  const evidence = readOperatorEvidenceRecord(discovery.evidence);
  const learnedFrom = readOperatorEvidenceString(evidence, "learnedFrom");
  const finalUrl = sanitizeOperatorUrl(
    readOperatorEvidenceString(evidence, "finalUrl"),
  );
  const accountRequired =
    discovery.automationReason === "ACCOUNT_REQUIRED" &&
    [
      "ACCOUNT_REQUIRED",
      "ACCOUNT_SELF_SERVICE",
      "ACCOUNT_STAFF_PROVISIONED",
    ].includes(discovery.bookingAccessMode);
  const officialAccountFinding = Boolean(
    discovery.status === "VERIFIED" &&
    bookingUrl &&
    accountRequired &&
    learnedFrom &&
    [
      "official-booking-cta-account-access",
      "official-booking-cta-account-sign-in",
    ].includes(learnedFrom),
  );
  const officialLinkCorroborated = Boolean(
    discovery.status !== "FAILED" &&
    bookingUrl &&
    (officialAccountFinding ||
      hasOperatorOfficialLinkCorroboration(evidence, bookingUrl)),
  );
  const providerLandingFound = Boolean(
    bookingUrl &&
    finalUrl &&
    ["LEARNED", "VERIFIED", "BLOCKED"].includes(discovery.status) &&
    haveSameOperatorUrlOrigin(bookingUrl, finalUrl),
  );
  return {
    status: discovery.status,
    detectedPlatform: discovery.detectedPlatform,
    bookingMethod: discovery.bookingMethod,
    automationEligibility: discovery.automationEligibility,
    automationReason: discovery.automationReason,
    bookingAccessMode: discovery.bookingAccessMode,
    bookingCandidateRecorded: Boolean(
      discovery.status !== "FAILED" &&
      (bookingUrl || discovery.detectedPlatform !== "UNKNOWN"),
    ),
    officialLinkCorroborated,
    providerLandingFound,
    confidence: discovery.confidence,
    observedAt: discovery.createdAt,
  };
}

function readOperatorEvidenceRecord(
  value: unknown,
): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOperatorEvidenceString(
  value: Record<string, unknown> | null,
  key: string,
) {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function hasOperatorOfficialLinkCorroboration(
  evidence: Record<string, unknown> | null,
  bookingUrl: string,
) {
  const proof = readOperatorEvidenceRecord(
    evidence?.courseIdentityCorroboration,
  );
  if (
    proof?.kind !== "OFFICIAL_COURSE_PROVIDER_LINK" &&
    proof?.kind !== "OFFICIAL_COURSE_NON_RUNNABLE_BOOKING_LINK"
  ) {
    return false;
  }
  const officialWebsiteUrl = sanitizeOperatorUrl(
    readOperatorEvidenceString(proof, "officialWebsiteUrl"),
  );
  const officialPageUrl = sanitizeOperatorUrl(
    readOperatorEvidenceString(proof, "officialPageUrl"),
  );
  const providerUrl = sanitizeOperatorUrl(
    readOperatorEvidenceString(proof, "providerUrl"),
  );
  return Boolean(
    officialWebsiteUrl &&
    officialPageUrl &&
    providerUrl === bookingUrl &&
    haveSameOperatorUrlOrigin(officialWebsiteUrl, officialPageUrl),
  );
}

function haveSameOperatorUrlOrigin(left: string, right: string) {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  const normalizeHostname = (hostname: string) =>
    hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  return (
    normalizeHostname(leftUrl.hostname) ===
      normalizeHostname(rightUrl.hostname) &&
    leftUrl.port === rightUrl.port &&
    (leftUrl.protocol === rightUrl.protocol ||
      (leftUrl.protocol === "http:" && rightUrl.protocol === "https:"))
  );
}
