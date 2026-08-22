import type {
  CourseSupportIncidentKind,
  CourseSupportIncidentStatus,
  ProbeOutcome,
  WebsiteTrafficClass
} from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

import { loadOperatorCourseSupportCampaign } from "./course-support-campaign";
import { loadOperatorCourseFleet } from "./course-fleet";
import { formatOperatorDayKey, getOperatorDateRange, type OperatorDateRange } from "./time";

export { buildOperatorDiscoverySummary } from "./course-fleet";

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

export function buildCourseSupportResponderAlert(input: {
  now: Date;
  openIncidentCount: number;
  worker?: {
    desiredState: string;
    lastOutcome?: string | null;
    monitoringStartedAt: Date | null;
    nextExpectedAt: Date | null;
    graceSeconds: number;
  };
}) {
  if (input.openIncidentCount === 0) {
    return null;
  }
  const worker = input.worker;
  if (!worker) {
    return {
      status: "MISSING" as const,
      title: "Course investigations are not reporting",
      detail: `${input.openIncidentCount} open course investigations have no responder health record.`
    };
  }
  if (worker.desiredState === "PAUSED") {
    return {
      status: "PAUSED" as const,
      title: "Course investigations are paused",
      detail: `${input.openIncidentCount} open course investigations will wait until the responder is resumed.`
    };
  }
  if (isFailedAutomationWorkerOutcome(worker.lastOutcome)) {
    return {
      status: "FAILED" as const,
      title: "Course investigation responder failed",
      detail: `${input.openIncidentCount} open course investigations are waiting after the latest scheduled responder run failed.`
    };
  }
  const overdue = Boolean(
    worker.desiredState === "ACTIVE" &&
      worker.monitoringStartedAt &&
      worker.nextExpectedAt &&
      worker.nextExpectedAt.getTime() + worker.graceSeconds * 1000 <= input.now.getTime()
  );
  if (!overdue) {
    return null;
  }
  return {
    status: "OVERDUE" as const,
    title: "Course investigations are stalled",
    detail: `${input.openIncidentCount} open course investigations are waiting because the responder missed its expected run.`
  };
}

export function isFailedAutomationWorkerOutcome(value: string | null | undefined) {
  return typeof value === "string" && value.endsWith("_failed");
}

export async function loadOperatorOverview(input: { days: 7 | 30; now?: Date }) {
  const now = input.now ?? new Date();
  const range = getOperatorDateRange(input.days, now);
  const recentProbeSince = new Date(now.getTime() - RECENT_PROBE_HOURS * 60 * 60 * 1000);
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
    recentResolvedIncidents,
    unresolvedFeedback,
    recentUsers,
    problemSearches,
    problemDeliveries,
    probeCounts,
    courseFleet,
    courseSupportCampaign
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
        reference: true,
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
            status: true,
            leaseExpiresAt: true
          }
        }
      }
    }),
    prisma.courseSupportIncident.findMany({
      where: {
        status: "RESOLVED",
        resolvedAt: { gte: range.start, lt: range.end }
      },
      orderBy: [{ resolvedAt: "desc" }, { lastSeenAt: "desc" }],
      take: 20,
      select: {
        id: true,
        reference: true,
        kind: true,
        providerFamilyKey: true,
        resolution: true,
        resolutionMessage: true,
        firstSeenAt: true,
        resolvedAt: true,
        course: {
          select: {
            name: true
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
        kind: { in: ["SETUP", "DAILY", "MATCH"] },
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
    }),
    loadOperatorCourseFleet({ now }),
    loadOperatorCourseSupportCampaign({ now })
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
  const latestProbeByCourse = new Map(latestProbes.map((probe) => [probe.courseId, probe]));
  const operatorWorkIncidents = filterOperatorWorkIncidents(openIncidents, courseFleet.courses);

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
  const [
    workerStates,
    recentAutomationRuns,
    activePublicSearches,
    activeTestSearches,
    pendingDeliveries
  ] = await Promise.all([
    prisma.automationWorkerState.findMany({
      orderBy: { workerKey: "asc" },
      select: {
        workerKey: true,
        desiredState: true,
        graceSeconds: true,
        lastHeartbeatAt: true,
        lastCompletedAt: true,
        lastOutcome: true,
        monitoringStartedAt: true,
        nextExpectedAt: true,
        overdueSince: true,
        runtimeVersion: true
      }
    }),
    prisma.automationRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 12,
      select: {
        kind: true,
        status: true,
        outcome: true,
        startedAt: true,
        completedAt: true,
        runtimeVersion: true
      }
    }),
    prisma.teeSearch.count({
      where: { status: "ACTIVE", trafficClass: "PUBLIC" }
    }),
    prisma.teeSearch.count({
      where: { status: "ACTIVE", trafficClass: "TEST" }
    }),
    prisma.searchEmailDelivery.count({
      where: { status: { in: ["PENDING", "SENDING"] } }
    })
  ]);
  const courseSupportWorker = workerStates.find(
    (worker) => worker.workerKey === "course-support-responder"
  );
  const courseSupportAlert = buildCourseSupportResponderAlert({
    now,
    openIncidentCount: operatorWorkIncidents.length,
    worker: courseSupportWorker
  });

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
      openIssues: operatorWorkIncidents.length,
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
      realDemandIncidents: openIncidents.filter((incident) => incident.activeRealSearchCount > 0)
        .length,
      problemSearches: problemSearches.map((search) => ({
        ...search,
        user: { email: "[redacted]" }
      })),
      problemDeliveries: problemDeliveries.map((delivery) => ({
        ...delivery,
        lastError: delivery.lastError ? "Retry pending" : null,
        teeSearch: { user: { email: "[redacted]" } }
      })),
      brokenFeedback: unresolvedFeedback.filter((feedback) => feedback.sentiment === "BROKEN")
    },
    topCourses: topCourses.map((course) => ({
      ...course,
      latestProbe: latestProbeByCourse.get(course.id) ?? null
    })),
    courseFleet,
    incidents: operatorWorkIncidents,
    resolvedIncidents: recentResolvedIncidents,
    recentUsers: recentUsers.map((user) => ({
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      totalAlerts: user.teeSearches.length,
      activeAlerts: user.teeSearches.filter((search) => search.status === "ACTIVE").length,
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
    operations: {
      workers: workerStates,
      courseSupportAlert,
      courseSupportCampaign,
      recentRuns: recentAutomationRuns,
      activeSearches: {
        public: activePublicSearches,
        test: activeTestSearches
      },
      pendingDeliveries
    },
    health: {
      probeHours: RECENT_PROBE_HOURS,
      ...probeHealth,
      problemSearchCount: problemSearches.length,
      problemDeliveryCount: problemDeliveries.length,
      unresolvedFeedbackCount: unresolvedFeedback.length
    }
  };
}

export function filterOperatorWorkIncidents<
  TIncident extends { courseId: string },
  TCourse extends { id: string; priorityGroup: string }
>(incidents: TIncident[], courses: TCourse[]) {
  const waitingForEvidenceCourseIds = new Set(
    courses
      .filter((course) => course.priorityGroup === "PARKED")
      .map((course) => course.id)
  );
  return incidents.filter(
    (incident) => !waitingForEvidenceCourseIds.has(incident.courseId)
  );
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
  const counts = Object.fromEntries(EVENT_NAMES.map((name) => [name, 0])) as Record<
    TrackedEventName,
    number
  >;
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

function summarizeProbeHealth(groups: Array<{ outcome: ProbeOutcome; _count: { _all: number } }>) {
  const byOutcome = Object.fromEntries(
    groups.map((group) => [group.outcome, group._count._all])
  ) as Partial<Record<ProbeOutcome, number>>;
  const successful = (byOutcome.MATCH_FOUND ?? 0) + (byOutcome.NO_MATCH ?? 0);
  const total = Object.values(byOutcome).reduce((sum, count) => sum + (count ?? 0), 0);

  return {
    successfulProbes: successful,
    failedProbes: Math.max(total - successful, 0),
    totalProbes: total,
    successRate: total > 0 ? Math.round((successful / total) * 100) : null,
    probeCounts: byOutcome
  };
}
