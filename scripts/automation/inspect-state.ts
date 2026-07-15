import "./load-local-env";

import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";

import {
  buildPortfolioCategoryHistory,
  buildRepeatedCoveragePortfolioCandidates
} from "@/lib/automation/improvement";
import { isCourseIntelligenceReviewDue } from "@/lib/courses/intelligence";
import { listCourseProfileQueue } from "@/lib/course-profiles/service";
import { sanitizePagePath } from "@/lib/engagement/page-path";
import { isEngineeringRemediationSearch } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

const RECENT_HOURS = 6;
const WEBSITE_FUNNEL_HOURS = 24;
const IMPROVEMENT_MEMORY_HOURS = 24;
const IMPROVEMENT_PROMPT_PREFIX = "tee-time-spot-improvement-loop-";
const activeSearchInspectionQuery = {
  where: {
    status: "ACTIVE"
  },
  include: {
    user: true,
    preferences: {
      orderBy: { rank: "asc" },
      include: { course: true }
    },
    matches: true
  },
  orderBy: [{ date: "asc" }, { createdAt: "asc" }]
} satisfies Prisma.TeeSearchFindManyArgs;

async function main() {
  const recentSince = new Date(Date.now() - RECENT_HOURS * 60 * 60 * 1000);
  const websiteFunnelSince = new Date(
    Date.now() - WEBSITE_FUNNEL_HOURS * 60 * 60 * 1000
  );
  const improvementMemorySince = new Date(
    Date.now() - IMPROVEMENT_MEMORY_HOURS * 60 * 60 * 1000
  );

  const [
    runs,
    improvementRuns,
    activeSearches,
    probeCounts,
    recentNotableProbes,
    openCourseSupportIncidents,
    recentMatches,
    pendingMatches,
    recentBrowserDiscoveries,
    recentWebsiteEvents,
    websiteEventCounts,
    courseDiscoveryEvents,
    unresolvedWebsiteFeedback,
    courseProfileQueue
  ] =
    await Promise.all([
      prisma.automationRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 8
      }),
      prisma.automationRun.findMany({
        where: {
          promptVersion: {
            startsWith: IMPROVEMENT_PROMPT_PREFIX
          },
          startedAt: {
            gte: improvementMemorySince
          }
        },
        orderBy: { startedAt: "desc" },
        select: {
          id: true,
          startedAt: true,
          completedAt: true,
          outcome: true,
          notes: true,
          changedFiles: true
        }
      }),
      prisma.teeSearch.findMany(activeSearchInspectionQuery),
      prisma.courseProbe.groupBy({
        by: ["outcome"],
        where: {
          observedAt: {
            gte: recentSince
          }
        },
        _count: {
          _all: true
        },
        orderBy: {
          outcome: "asc"
        }
      }),
      prisma.courseProbe.findMany({
        where: {
          observedAt: {
            gte: recentSince
          },
          outcome: {
            not: "NO_MATCH"
          }
        },
        orderBy: {
          observedAt: "desc"
        },
        take: 15,
        include: {
          course: true,
          teeSearch: {
            include: {
              user: true
            }
          },
          automationRun: true
        }
      }),
      prisma.courseSupportIncident.findMany({
        where: {
          status: { not: "RESOLVED" }
        },
        orderBy: [{ status: "desc" }, { firstSeenAt: "asc" }],
        include: {
          course: {
            include: {
              preferences: {
                where: { teeSearch: { status: "ACTIVE" } },
                select: {
                  teeSearch: {
                    select: { trafficClass: true, syntheticMultiCycle: true }
                  }
                }
              }
            }
          }
        }
      }),
      prisma.teeTimeMatch.findMany({
        orderBy: { firstSeenAt: "desc" },
        take: 10,
        include: {
          course: true,
          teeSearch: {
            include: {
              user: true
            }
          }
        }
      }),
      prisma.teeTimeMatch.findMany({
        where: {
          alertStatus: "PENDING"
        },
        orderBy: { firstSeenAt: "asc" },
        take: 25,
        include: {
          course: true,
          teeSearch: {
            include: {
              user: true
            }
          }
        }
      }),
      prisma.courseAutomationDiscovery.findMany({
        orderBy: {
          createdAt: "desc"
        },
        take: 10,
        include: {
          course: true
        }
      }),
      prisma.websiteEvent.findMany({
        orderBy: { createdAt: "desc" },
        take: 20
      }),
      prisma.websiteEvent.groupBy({
        by: ["trafficClass", "name"],
        where: {
          createdAt: {
            gte: websiteFunnelSince
          }
        },
        _count: {
          _all: true
        }
      }),
      prisma.websiteEvent.findMany({
        where: {
          createdAt: {
            gte: websiteFunnelSince
          },
          name: {
            in: ["course_discovery_completed", "course_discovery_failed"]
          }
        },
        select: {
          trafficClass: true,
          name: true,
          metadata: true
        }
      }),
      prisma.websiteFeedback.findMany({
        where: { resolvedAt: null },
        orderBy: { createdAt: "desc" },
        take: 20
      }),
      listCourseProfileQueue(3)
    ]);

  const activeSearchIds = activeSearches.map((search) => search.id);
  const improvementPortfolioHistory = buildPortfolioCategoryHistory(improvementRuns);
  const repeatedCoverageBlockers = buildRepeatedCoveragePortfolioCandidates(improvementRuns);
  const activePreferenceCourseIds = new Set(
    activeSearches.flatMap((search) =>
      search.preferences.map((preference) => preference.courseId)
    )
  );
  const recentActiveProbes =
    activeSearchIds.length > 0
      ? await prisma.courseProbe.findMany({
          where: {
            observedAt: {
              gte: recentSince
            },
            teeSearchId: {
              in: activeSearchIds
            },
            courseId: {
              in: [...activePreferenceCourseIds]
            }
          },
          orderBy: {
            observedAt: "desc"
          },
          include: {
            course: true,
            teeSearch: {
              include: {
                user: true
              }
            },
            automationRun: true
          }
        })
      : [];
  const currentActionableProbes = latestCurrentActionableProbes(recentActiveProbes).filter(
    (probe) =>
      isEngineeringRemediationSearch(
        probe.teeSearch.trafficClass,
        probe.teeSearch.syntheticMultiCycle
      )
  );
  const courseIntelligenceReviews = [
    ...new Map(
      activeSearches
        .flatMap((search) => search.preferences.map((preference) => preference.course))
        .filter((course) => isCourseIntelligenceReviewDue(course.intelligenceReviewAt))
        .map((course) => [course.id, course] as const)
    ).values()
  ];

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        checkpoints: {
          queue_confirmed: true,
          candidate_selected: false,
          tool_research_done: false,
          ui_smoke_done: false,
          verification_done: false,
          outcome_recorded: false
        },
        recentRuns: runs.map((run) => ({
          id: run.id,
          promptVersion: run.promptVersion,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
          outcome: run.outcome,
          notes: summarize(run.notes),
          changedFiles: run.changedFiles
        })),
        recentImprovementRuns: {
          hours: IMPROVEMENT_MEMORY_HOURS,
          runs: improvementRuns.map((run) => ({
            id: run.id,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            outcome: run.outcome,
            changedFiles: run.changedFiles,
            memory: extractImprovementRunMemory(run.notes)
          }))
        },
        improvementPortfolio: {
          hours: IMPROVEMENT_MEMORY_HOURS,
          recentSelections: improvementPortfolioHistory,
          repeatedCoverageBlockers: repeatedCoverageBlockers.map((candidate) => ({
            id: candidate.id,
            category: candidate.category,
            summary: candidate.summary,
            observedAt: candidate.observedAt,
            evidenceCount: candidate.evidence.length
          }))
        },
        courseProfileQueue: courseProfileQueue.map((course) => ({
          courseId: course.id,
          name: course.name,
          city: course.city,
          stateCode: course.stateCode,
          county: course.county,
          website: sanitizeExternalUrl(course.website),
          bookingUrl: sanitizeExternalUrl(course.detectedBookingUrl),
          eligibility: course.automationEligibility,
          profileStatus: course.profile?.status ?? "MISSING",
          reviewDueAt: course.profile?.reviewDueAt ?? null,
          failureReason: summarize(course.profile?.failureReason ?? null)
        })),
        activeSearches: activeSearches.map((search) => ({
          id: search.id,
          trafficClass: search.trafficClass,
          syntheticMultiCycle: search.syntheticMultiCycle,
          user: redactEmail(search.user.email),
          date: search.date.toISOString().slice(0, 10),
          window: `${search.startTime}-${search.endTime}`,
          players: search.players,
          checkStatus: search.checkStatus,
          workflowRunId: search.workflowRunId,
          nextCheckAt: search.nextCheckAt,
          lastCheckedAt: search.lastCheckedAt,
          lastCheckOutcome: summarize(search.lastCheckOutcome),
          matchCount: search.matches.length,
          availableMatchCount: search.matches.filter(
            (match) => match.availabilityStatus === "AVAILABLE"
          ).length,
          preferences: search.preferences.map((preference) => ({
            rank: preference.rank,
            courseId: preference.course.id,
            name: preference.course.name,
            platform: preference.course.detectedPlatform,
            eligibility: preference.course.automationEligibility,
            bookingMethod: preference.course.bookingMethod,
            automationReason: preference.course.automationReason,
            intelligenceVerifiedAt: preference.course.intelligenceVerifiedAt,
            intelligenceReviewAt: preference.course.intelligenceReviewAt,
            hasBookingMetadata: preference.course.bookingMetadata !== null
          }))
          })),
        courseIntelligenceReviews: courseIntelligenceReviews.map((course) => ({
          courseId: course.id,
          name: course.name,
          bookingMethod: course.bookingMethod,
          eligibility: course.automationEligibility,
          automationReason: course.automationReason,
          intelligenceVerifiedAt: course.intelligenceVerifiedAt,
          intelligenceReviewAt: course.intelligenceReviewAt,
          evidence: summarize(course.policyNotes)
        })),
        probeCounts: {
          hours: RECENT_HOURS,
          outcomes: Object.fromEntries(
            probeCounts.map((probe) => [probe.outcome, probe._count._all])
          )
        },
        recentActionableProbes: currentActionableProbes.map((probe) => ({
          id: probe.id,
          observedAt: probe.observedAt,
          outcome: probe.outcome,
          course: probe.course.name,
          platform: probe.course.detectedPlatform,
          eligibility: probe.course.automationEligibility,
          bookingMethod: probe.course.bookingMethod,
          automationReason: probe.course.automationReason,
          user: redactEmail(probe.teeSearch.user.email),
          searchId: probe.teeSearchId,
          trafficClass: probe.teeSearch.trafficClass,
          syntheticMultiCycle: probe.teeSearch.syntheticMultiCycle,
          automationRunId: probe.automationRunId,
          automationRunOutcome: probe.automationRun?.outcome ?? null,
          message: summarize(probe.message)
        })),
        openCourseSupportIncidents: openCourseSupportIncidents.map((incident) => ({
          id: incident.id,
          status: incident.status,
          kind: incident.kind,
          course: incident.course.name,
          platform: incident.course.detectedPlatform,
          cycle: incident.cycle,
          firstAffectedSearchId: incident.firstAffectedSearchId,
          affectedSearchCount: incident.affectedSearchCount,
          occurrenceCount: incident.occurrenceCount,
          engineeringOnly: incident.engineeringOnly,
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: incident.lastSeenAt,
          ownerNotifiedAt: incident.ownerNotifiedAt,
          escalatedAt: incident.escalatedAt,
          latestMessage: summarize(incident.latestMessage),
          nextAction: summarize(incident.nextAction),
          activeDemandTrafficClasses: [
            ...new Set(
              incident.course.preferences.map(
                (preference) =>
                  `${preference.teeSearch.trafficClass}:${preference.teeSearch.syntheticMultiCycle ? "MULTI_CYCLE" : "STANDARD"}`
              )
            )
          ].sort()
        })),
        recentNotableProbes: recentNotableProbes.map((probe) => ({
          id: probe.id,
          observedAt: probe.observedAt,
          outcome: probe.outcome,
          course: probe.course.name,
          platform: probe.course.detectedPlatform,
          eligibility: probe.course.automationEligibility,
          bookingMethod: probe.course.bookingMethod,
          automationReason: probe.course.automationReason,
          user: redactEmail(probe.teeSearch.user.email),
          searchId: probe.teeSearchId,
          trafficClass: probe.teeSearch.trafficClass,
          automationRunId: probe.automationRunId,
          automationRunOutcome: probe.automationRun?.outcome ?? null,
          message: summarize(probe.message)
        })),
        recentMatches: recentMatches.map((match) => ({
          id: match.id,
          course: match.course.name,
          user: redactEmail(match.teeSearch.user.email),
          startsAt: match.startsAt,
          alertStatus: match.alertStatus,
          availabilityStatus: match.availabilityStatus,
          lastConfirmedAt: match.lastConfirmedAt,
          firstSeenAt: match.firstSeenAt,
          sourceId: match.sourceId
        })),
        pendingAlerts: pendingMatches.map((match) => ({
          id: match.id,
          course: match.course.name,
          user: redactEmail(match.teeSearch.user.email),
          startsAt: match.startsAt,
          firstSeenAt: match.firstSeenAt,
          sourceId: match.sourceId
        })),
        recentBrowserDiscoveries: recentBrowserDiscoveries.map((discovery) => ({
          id: discovery.id,
          course: discovery.course.name,
          status: discovery.status,
          platform: discovery.detectedPlatform,
          confidence: discovery.confidence,
          sourceUrl: sanitizeExternalUrl(discovery.sourceUrl),
          bookingUrl: sanitizeExternalUrl(discovery.bookingUrl),
          apiEndpoint: sanitizeExternalUrl(discovery.apiEndpoint),
          createdAt: discovery.createdAt
        })),
        recentWebsiteEvents: recentWebsiteEvents.map((event) => ({
          id: event.id,
          name: event.name,
          page: sanitizePagePath(event.page),
          metadata: sanitizeWebsiteEventMetadata(event.metadata),
          trafficClass: event.trafficClass,
          createdAt: event.createdAt
        })),
        websiteFunnel: {
          hours: WEBSITE_FUNNEL_HOURS,
          byTrafficClass: summarizeWebsiteEventCounts(websiteEventCounts),
          courseDiscoveryOutcomes:
            summarizeCourseDiscoveryOutcomes(courseDiscoveryEvents)
        },
        unresolvedWebsiteFeedback: unresolvedWebsiteFeedback.map((feedback) => ({
          id: feedback.id,
          sentiment: feedback.sentiment,
          message: summarize(feedback.message),
          page: sanitizePagePath(feedback.page),
          contactEmail: feedback.contactEmail ? redactEmail(feedback.contactEmail) : null,
          trafficClass: feedback.trafficClass,
          createdAt: feedback.createdAt
        }))
      },
      null,
      2
    )
  );
}

function summarize(notes: string | null) {
  return notes?.replace(/\s+/g, " ").trim().slice(0, 300) ?? null;
}

function extractImprovementRunMemory(notes: string | null) {
  const fallback = {
    lifecycle: null,
    branch: null,
    candidateSummary: null,
    selectedCategory: null,
    candidateRanking: [] as string[],
    evidenceTrackResults: {} as Record<string, string>,
    coverageBlockers: [] as string[],
    commitSha: null,
    deploymentId: null,
    changedBehavior: null,
    measuredResult: null,
    learning: [] as string[],
    blockers: [] as string[],
    nextRotationTargets: [] as string[],
    fallbackSummary: summarize(notes)
  };

  if (!notes) {
    return fallback;
  }

  try {
    const record = JSON.parse(notes) as unknown;
    if (!isRecord(record)) {
      return fallback;
    }

    const audit = isRecord(record.audit) ? record.audit : {};
    const provenance = isRecord(record.provenance) ? record.provenance : {};
    const candidate = isRecord(record.candidate) ? record.candidate : {};

    return {
      lifecycle: boundedString(record.lifecycle),
      branch: boundedString(provenance.branch),
      candidateSummary: boundedString(candidate.summary),
      selectedCategory: boundedString(audit.selectedCategory),
      candidateRanking: boundedStringArray(audit.candidateRanking),
      evidenceTrackResults: boundedStringRecord(audit.evidenceTrackResults),
      coverageBlockers: boundedStringArray(audit.coverageBlockers),
      commitSha: boundedString(audit.commitSha),
      deploymentId: boundedString(audit.deploymentId),
      changedBehavior: boundedString(audit.changedBehavior),
      measuredResult: boundedString(audit.measuredResult),
      learning: boundedStringArray(audit.learning),
      blockers: boundedStringArray(audit.blockers),
      nextRotationTargets: boundedStringArray(audit.nextRotationTargets),
      fallbackSummary: null
    };
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1200) : null;
}

function boundedStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => boundedString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 20);
}

function boundedStringRecord(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, boundedString(item)] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .slice(0, 20)
  );
}

function sanitizeWebsiteEventMetadata(metadata: Prisma.JsonValue | null) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata;
  }

  const safeMetadata = { ...metadata };
  delete safeMetadata.searchId;
  return safeMetadata;
}

function sanitizeExternalUrl(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function latestCurrentActionableProbes<
  T extends {
    teeSearchId: string;
    courseId: string;
    outcome: string;
    course: {
      automationEligibility: string;
    };
  }
>(probes: T[]) {
  const latestBySearchCourse = new Map<string, T>();

  for (const probe of probes) {
    const key = `${probe.teeSearchId}:${probe.courseId}`;
    if (!latestBySearchCourse.has(key)) {
      latestBySearchCourse.set(key, probe);
    }
  }

  return [...latestBySearchCourse.values()].filter(
    (probe) =>
      probe.course.automationEligibility !== "BLOCKED" &&
      probe.outcome !== "NO_MATCH" &&
      probe.outcome !== "MATCH_FOUND"
  );
}

function summarizeWebsiteEventCounts<
  T extends {
    trafficClass: string;
    name: string;
    _count: { _all: number };
  }
>(counts: T[]) {
  const byTrafficClass: Record<string, Record<string, number>> = {};

  for (const count of [...counts].sort((left, right) =>
    `${left.trafficClass}:${left.name}`.localeCompare(`${right.trafficClass}:${right.name}`)
  )) {
    byTrafficClass[count.trafficClass] ??= {};
    byTrafficClass[count.trafficClass][count.name] = count._count._all;
  }

  return byTrafficClass;
}

function summarizeCourseDiscoveryOutcomes<
  T extends {
    trafficClass: string;
    name: string;
    metadata: Prisma.JsonValue | null;
  }
>(events: T[]) {
  type Summary = {
    completedWithResults: number;
    completedEmpty: number;
    demoCompletions: number;
    failedGeocode: number;
    failedDiscovery: number;
    failureStatuses: Record<string, number>;
  };

  const byTrafficClass: Record<string, Summary> = {};

  for (const event of events) {
    if (!event.metadata || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      continue;
    }

    const summary = (byTrafficClass[event.trafficClass] ??= {
      completedWithResults: 0,
      completedEmpty: 0,
      demoCompletions: 0,
      failedGeocode: 0,
      failedDiscovery: 0,
      failureStatuses: {}
    });

    if (event.name === "course_discovery_completed") {
      if (event.metadata.resultCount === 0) {
        summary.completedEmpty += 1;
      } else if (
        typeof event.metadata.resultCount === "number" &&
        event.metadata.resultCount > 0
      ) {
        summary.completedWithResults += 1;
      }

      if (event.metadata.demo === true) {
        summary.demoCompletions += 1;
      }
      continue;
    }

    if (event.name !== "course_discovery_failed") {
      continue;
    }

    const stage = event.metadata.stage;
    if (stage === "GEOCODE") {
      summary.failedGeocode += 1;
    } else if (stage === "DISCOVERY") {
      summary.failedDiscovery += 1;
    } else {
      continue;
    }

    const status =
      typeof event.metadata.responseStatus === "number" &&
      Number.isInteger(event.metadata.responseStatus)
        ? event.metadata.responseStatus
        : "unknown";
    const statusKey = `${stage}:${status}`;
    summary.failureStatuses[statusKey] =
      (summary.failureStatuses[statusKey] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(byTrafficClass)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([trafficClass, summary]) => [
        trafficClass,
        {
          ...summary,
          failureStatuses: Object.fromEntries(
            Object.entries(summary.failureStatuses).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          )
        }
      ])
  );
}

function redactEmail(email: string) {
  const [localPart, domain = ""] = email.split("@");
  const visible = localPart.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(localPart.length - 2, 1))}@${domain}`;
}

export {
  activeSearchInspectionQuery,
  extractImprovementRunMemory,
  latestCurrentActionableProbes,
  summarizeCourseDiscoveryOutcomes,
  summarizeWebsiteEventCounts
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
