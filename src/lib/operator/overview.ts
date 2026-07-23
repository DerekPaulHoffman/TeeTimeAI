import type {
  CourseSupportIncidentKind,
  CourseSupportIncidentStatus,
  ProbeOutcome,
  WebsiteTrafficClass
} from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import {
  formatOperatorDayKey,
  getOperatorDateRange,
  type OperatorDateRange
} from "./time";

const NON_SYNTHETIC_TRAFFIC: { notIn: WebsiteTrafficClass[] } = {
  notIn: [...syntheticWebsiteTrafficClasses]
};
const OVERDUE_SEARCH_GRACE_MS = 10 * 60 * 1000;
const RECENT_PROBE_HOURS = 24;
const EVENT_NAMES = [
  "page_viewed",
  "start_search_clicked",
  "course_discovery_completed",
  "course_selection_started",
  "alert_sign_in_clicked",
  "search_submitted",
  "search_submission_failed"
] as const;

type TrackedEventName = (typeof EVENT_NAMES)[number];

export type OperatorOverview = Awaited<ReturnType<typeof loadOperatorOverview>>;

export async function loadOperatorOverview(input: {
  days: 7 | 30;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const range = getOperatorDateRange(input.days, now);
  const recentProbeSince = new Date(
    now.getTime() - RECENT_PROBE_HOURS * 60 * 60 * 1000
  );
  const overdueBefore = new Date(now.getTime() - OVERDUE_SEARCH_GRACE_MS);

  const [
    events,
    rangeSearches,
    rangePreferences,
    newUserCount,
    activeAlertCount,
    matchesFoundToday,
    matchEmailsSentToday,
    openIncidents,
    unresolvedFeedback,
    recentUsers,
    problemSearches,
    problemDeliveries,
    probeCounts
  ] = await Promise.all([
    prisma.websiteEvent.findMany({
      where: {
        createdAt: { gte: range.start, lt: range.end },
        trafficClass: NON_SYNTHETIC_TRAFFIC,
        name: { in: [...EVENT_NAMES] }
      },
      orderBy: { createdAt: "asc" },
      select: {
        name: true,
        createdAt: true
      }
    }),
    prisma.teeSearch.findMany({
      where: {
        createdAt: { gte: range.start, lt: range.end },
        trafficClass: NON_SYNTHETIC_TRAFFIC
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userId: true,
        createdAt: true
      }
    }),
    prisma.coursePreference.findMany({
      where: {
        createdAt: { gte: range.start, lt: range.end },
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC
        }
      },
      select: {
        courseId: true,
        teeSearch: {
          select: {
            id: true,
            userId: true,
            status: true,
            date: true
          }
        },
        course: {
          select: {
            id: true,
            name: true,
            providerFamilyKey: true,
            supportIncident: {
              select: {
                id: true,
                status: true,
                kind: true,
                activeRealSearchCount: true
              }
            }
          }
        }
      }
    }),
    prisma.user.count({
      where: {
        createdAt: { gte: range.todayStart, lt: range.end },
        OR: [
          {
            teeSearches: {
              some: { trafficClass: NON_SYNTHETIC_TRAFFIC }
            }
          },
          {
            teeSearches: { none: {} }
          }
        ]
      }
    }),
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        trafficClass: NON_SYNTHETIC_TRAFFIC
      }
    }),
    prisma.teeTimeMatch.count({
      where: {
        firstSeenAt: { gte: range.todayStart, lt: range.end },
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC
        }
      }
    }),
    prisma.searchEmailDelivery.count({
      where: {
        kind: "MATCH",
        status: "SENT",
        sentAt: { gte: range.todayStart, lt: range.end },
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC
        }
      }
    }),
    prisma.courseSupportIncident.findMany({
      where: {
        status: { not: "RESOLVED" }
      },
      orderBy: [
        { activeRealSearchCount: "desc" },
        { earliestTargetDate: "asc" },
        { firstSeenAt: "asc" }
      ],
      select: {
        id: true,
        courseId: true,
        status: true,
        kind: true,
        providerFamilyKey: true,
        failureClass: true,
        latestMessage: true,
        nextAction: true,
        affectedSearchCount: true,
        activeRealSearchCount: true,
        engineeringOnly: true,
        earliestTargetDate: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastAttemptAt: true,
        firstSeenAt: true,
        lastSeenAt: true,
        activeBatchId: true,
        course: {
          select: {
            name: true
          }
        },
        activeBatch: {
          select: {
            reference: true,
            status: true
          }
        }
      }
    }),
    prisma.websiteFeedback.findMany({
      where: {
        resolvedAt: null,
        trafficClass: NON_SYNTHETIC_TRAFFIC
      },
      orderBy: [{ sentiment: "asc" }, { createdAt: "desc" }],
      take: 20,
      select: {
        id: true,
        sentiment: true,
        message: true,
        page: true,
        contactEmail: true,
        createdAt: true
      }
    }),
    prisma.user.findMany({
      where: {
        OR: [
          {
            teeSearches: {
              some: { trafficClass: NON_SYNTHETIC_TRAFFIC }
            }
          },
          {
            teeSearches: { none: {} }
          }
        ]
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        email: true,
        createdAt: true,
        teeSearches: {
          where: {
            trafficClass: NON_SYNTHETIC_TRAFFIC
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            createdAt: true,
            preferences: {
              orderBy: { rank: "asc" },
              select: {
                course: {
                  select: { name: true }
                }
              }
            }
          }
        }
      }
    }),
    prisma.teeSearch.findMany({
      where: {
        status: "ACTIVE",
        trafficClass: NON_SYNTHETIC_TRAFFIC,
        OR: [
          { checkStatus: "FAILED" },
          {
            nextCheckAt: { lt: overdueBefore },
            checkStatus: { in: ["QUEUED", "CHECKING", "WAITING"] }
          }
        ]
      },
      orderBy: [{ checkStatus: "asc" }, { nextCheckAt: "asc" }],
      take: 20,
      select: {
        id: true,
        checkStatus: true,
        nextCheckAt: true,
        lastCheckedAt: true,
        lastCheckOutcome: true,
        date: true,
        user: {
          select: {
            email: true
          }
        },
        preferences: {
          orderBy: { rank: "asc" },
          select: {
            course: {
              select: { name: true }
            }
          }
        }
      }
    }),
    prisma.searchEmailDelivery.findMany({
      where: {
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC
        },
        OR: [
          { status: "FAILED" },
          {
            status: "PENDING",
            nextAttemptAt: { lte: now }
          }
        ]
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: 20,
      select: {
        id: true,
        status: true,
        kind: true,
        attemptCount: true,
        nextAttemptAt: true,
        lastError: true,
        createdAt: true,
        teeSearch: {
          select: {
            id: true,
            user: {
              select: {
                email: true
              }
            }
          }
        }
      }
    }),
    prisma.courseProbe.groupBy({
      by: ["outcome"],
      where: {
        observedAt: { gte: recentProbeSince, lte: now },
        teeSearch: {
          trafficClass: NON_SYNTHETIC_TRAFFIC
        }
      },
      _count: {
        _all: true
      }
    })
  ]);

  const topCourses = buildTopCourses(rangePreferences);
  const topCourseIds = topCourses.map((course) => course.id);
  const latestProbes =
    topCourseIds.length > 0
      ? await prisma.courseProbe.findMany({
          where: {
            courseId: { in: topCourseIds },
            teeSearch: {
              trafficClass: NON_SYNTHETIC_TRAFFIC
            }
          },
          orderBy: { observedAt: "desc" },
          distinct: ["courseId"],
          select: {
            courseId: true,
            outcome: true,
            observedAt: true
          }
        })
      : [];
  const latestProbeByCourse = new Map(
    latestProbes.map((probe) => [probe.courseId, probe])
  );

  const dailyActivity = buildDailyActivity({
    range,
    events,
    searches: rangeSearches
  });
  const eventTotals = countEvents(events);
  const todayKey = range.dayKeys.at(-1);
  const todayActivity = dailyActivity.find((day) => day.key === todayKey);
  const brokenFeedbackCount = unresolvedFeedback.filter(
    (feedback) => feedback.sentiment === "BROKEN"
  ).length;
  const probeHealth = summarizeProbeHealth(probeCounts);

  return {
    generatedAt: now,
    range,
    today: {
      newUsers: newUserCount,
      newAlerts: todayActivity?.savedAlerts ?? 0,
      activeAlerts: activeAlertCount,
      pageViews: todayActivity?.pageViews ?? 0,
      matchesFound: matchesFoundToday,
      matchEmailsSent: matchEmailsSentToday,
      openIssues: openIncidents.length,
      brokenFeedback: brokenFeedbackCount
    },
    funnel: {
      pageViews: eventTotals.page_viewed,
      searchStarts: eventTotals.start_search_clicked,
      discoveries: eventTotals.course_discovery_completed,
      selections: eventTotals.course_selection_started,
      signInClicks: eventTotals.alert_sign_in_clicked,
      submissions: eventTotals.search_submitted,
      submissionFailures: eventTotals.search_submission_failed,
      savedAlerts: rangeSearches.length
    },
    dailyActivity,
    attention: {
      realDemandIncidents: openIncidents.filter(
        (incident) => incident.activeRealSearchCount > 0
      ).length,
      problemSearches,
      problemDeliveries,
      brokenFeedback: unresolvedFeedback.filter(
        (feedback) => feedback.sentiment === "BROKEN"
      )
    },
    topCourses: topCourses.map((course) => ({
      ...course,
      latestProbe: latestProbeByCourse.get(course.id) ?? null
    })),
    incidents: openIncidents,
    recentUsers: recentUsers.map((user) => ({
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      totalAlerts: user.teeSearches.length,
      activeAlerts: user.teeSearches.filter(
        (search) => search.status === "ACTIVE"
      ).length,
      latestAlertAt: user.teeSearches[0]?.createdAt ?? null,
      courseNames: [
        ...new Set(
          user.teeSearches.flatMap((search) =>
            search.preferences.map((preference) => preference.course.name)
          )
        )
      ]
    })),
    unresolvedFeedback,
    health: {
      probeHours: RECENT_PROBE_HOURS,
      ...probeHealth,
      problemSearchCount: problemSearches.length,
      problemDeliveryCount: problemDeliveries.length,
      unresolvedFeedbackCount: unresolvedFeedback.length
    }
  };
}

type CoursePreferenceSummary = {
  courseId: string;
  teeSearch: {
    id: string;
    userId: string;
    status: string;
    date: Date;
  };
  course: {
    id: string;
    name: string;
    providerFamilyKey: string;
    supportIncident: {
      id: string;
      status: CourseSupportIncidentStatus;
      kind: CourseSupportIncidentKind;
      activeRealSearchCount: number;
    } | null;
  };
};

export function buildTopCourses(preferences: CoursePreferenceSummary[]) {
  const courses = new Map<
    string,
    {
      id: string;
      name: string;
      providerFamilyKey: string;
      selectionCount: number;
      ownerIds: Set<string>;
      activeSearchIds: Set<string>;
      nearestRequestedDate: Date | null;
      incident: CoursePreferenceSummary["course"]["supportIncident"];
    }
  >();

  for (const preference of preferences) {
    const current = courses.get(preference.courseId) ?? {
      id: preference.course.id,
      name: preference.course.name,
      providerFamilyKey: preference.course.providerFamilyKey,
      selectionCount: 0,
      ownerIds: new Set<string>(),
      activeSearchIds: new Set<string>(),
      nearestRequestedDate: null,
      incident: preference.course.supportIncident
    };
    current.selectionCount += 1;
    current.ownerIds.add(preference.teeSearch.userId);
    if (preference.teeSearch.status === "ACTIVE") {
      current.activeSearchIds.add(preference.teeSearch.id);
      if (
        !current.nearestRequestedDate ||
        preference.teeSearch.date < current.nearestRequestedDate
      ) {
        current.nearestRequestedDate = preference.teeSearch.date;
      }
    }
    courses.set(preference.courseId, current);
  }

  return [...courses.values()]
    .sort(
      (left, right) =>
        right.selectionCount - left.selectionCount ||
        right.activeSearchIds.size - left.activeSearchIds.size ||
        left.name.localeCompare(right.name)
    )
    .slice(0, 10)
    .map((course) => ({
      id: course.id,
      name: course.name,
      providerFamilyKey: course.providerFamilyKey,
      selectionCount: course.selectionCount,
      ownerCount: course.ownerIds.size,
      activeAlertCount: course.activeSearchIds.size,
      nearestRequestedDate: course.nearestRequestedDate,
      incident: course.incident
    }));
}

export function countEvents(events: Array<{ name: string }>) {
  const counts = Object.fromEntries(
    EVENT_NAMES.map((name) => [name, 0])
  ) as Record<TrackedEventName, number>;
  for (const event of events) {
    if (EVENT_NAMES.includes(event.name as TrackedEventName)) {
      counts[event.name as TrackedEventName] += 1;
    }
  }
  return counts;
}

function buildDailyActivity(input: {
  range: OperatorDateRange;
  events: Array<{ name: string; createdAt: Date }>;
  searches: Array<{ createdAt: Date }>;
}) {
  const days = new Map(
    input.range.dayKeys.map((key) => [
      key,
      {
        key,
        pageViews: 0,
        searchStarts: 0,
        discoveries: 0,
        submissions: 0,
        savedAlerts: 0
      }
    ])
  );

  for (const event of input.events) {
    const day = days.get(formatOperatorDayKey(event.createdAt));
    if (!day) continue;
    if (event.name === "page_viewed") day.pageViews += 1;
    if (event.name === "start_search_clicked") day.searchStarts += 1;
    if (event.name === "course_discovery_completed") day.discoveries += 1;
    if (event.name === "search_submitted") day.submissions += 1;
  }
  for (const search of input.searches) {
    const day = days.get(formatOperatorDayKey(search.createdAt));
    if (day) day.savedAlerts += 1;
  }

  return [...days.values()];
}

function summarizeProbeHealth(
  groups: Array<{ outcome: ProbeOutcome; _count: { _all: number } }>
) {
  const byOutcome = Object.fromEntries(
    groups.map((group) => [group.outcome, group._count._all])
  ) as Partial<Record<ProbeOutcome, number>>;
  const successful =
    (byOutcome.MATCH_FOUND ?? 0) + (byOutcome.NO_MATCH ?? 0);
  const total = Object.values(byOutcome).reduce(
    (sum, count) => sum + (count ?? 0),
    0
  );

  return {
    successfulProbes: successful,
    failedProbes: Math.max(total - successful, 0),
    totalProbes: total,
    successRate: total > 0 ? Math.round((successful / total) * 100) : null,
    probeCounts: byOutcome
  };
}
