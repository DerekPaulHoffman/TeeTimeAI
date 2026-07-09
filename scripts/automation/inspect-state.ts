import "./load-local-env";

import { prisma } from "@/lib/prisma";

const RECENT_HOURS = 6;

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const recentSince = new Date(Date.now() - RECENT_HOURS * 60 * 60 * 1000);

  const [
    runs,
    activeSearches,
    probeCounts,
    recentNotableProbes,
    recentMatches,
    pendingMatches
  ] =
    await Promise.all([
      prisma.automationRun.findMany({
        orderBy: { startedAt: "desc" },
        take: 8
      }),
      prisma.teeSearch.findMany({
        where: {
          status: "ACTIVE",
          date: {
            gte: today
          }
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
      }),
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
          matchCount: search.matches.length,
          preferences: search.preferences.map((preference) => ({
            rank: preference.rank,
            courseId: preference.course.id,
            name: preference.course.name,
            platform: preference.course.detectedPlatform,
            eligibility: preference.course.automationEligibility,
            hasBookingMetadata: preference.course.bookingMetadata !== null
          }))
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
          user: redactEmail(probe.teeSearch.user.email),
          searchId: probe.teeSearchId,
          automationRunId: probe.automationRunId,
          automationRunOutcome: probe.automationRun?.outcome ?? null,
          message: summarize(probe.message)
        })),
        recentNotableProbes: recentNotableProbes.map((probe) => ({
          id: probe.id,
          observedAt: probe.observedAt,
          outcome: probe.outcome,
          course: probe.course.name,
          platform: probe.course.detectedPlatform,
          eligibility: probe.course.automationEligibility,
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

function latestCurrentActionableProbes<
  T extends {
    teeSearchId: string;
    courseId: string;
    outcome: string;
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
    (probe) => probe.outcome !== "NO_MATCH" && probe.outcome !== "MATCH_FOUND"
  );
}

function redactEmail(email: string) {
  const [localPart, domain = ""] = email.split("@");
  const visible = localPart.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(localPart.length - 2, 1))}@${domain}`;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
