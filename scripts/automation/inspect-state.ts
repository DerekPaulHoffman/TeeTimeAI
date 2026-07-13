import "./load-local-env";

import { pathToFileURL } from "node:url";
import type { Prisma } from "@prisma/client";

import { isCourseIntelligenceReviewDue } from "@/lib/courses/intelligence";
import { sanitizePagePath } from "@/lib/engagement/page-path";
import { prisma } from "@/lib/prisma";

const RECENT_HOURS = 6;
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

  const [
    runs,
    activeSearches,
    probeCounts,
    recentNotableProbes,
    openCourseSupportIncidents,
    recentMatches,
    pendingMatches,
    recentBrowserDiscoveries,
    recentWebsiteEvents,
    unresolvedWebsiteFeedback
  ] =
    await Promise.all([
      prisma.automationRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 8
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
        include: { course: true }
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
      prisma.websiteFeedback.findMany({
        where: { resolvedAt: null },
        orderBy: { createdAt: "desc" },
        take: 20
      })
    ]);

  const activeSearchIds = activeSearches.map((search) => search.id);
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
  const currentActionableProbes = latestCurrentActionableProbes(recentActiveProbes);
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
        activeSearches: activeSearches.map((search) => ({
          id: search.id,
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
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: incident.lastSeenAt,
          ownerNotifiedAt: incident.ownerNotifiedAt,
          escalatedAt: incident.escalatedAt,
          latestMessage: summarize(incident.latestMessage),
          nextAction: summarize(incident.nextAction)
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

function redactEmail(email: string) {
  const [localPart, domain = ""] = email.split("@");
  const visible = localPart.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(localPart.length - 2, 1))}@${domain}`;
}

export { activeSearchInspectionQuery, latestCurrentActionableProbes };

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
