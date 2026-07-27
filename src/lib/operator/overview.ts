import type {
  CourseSupportIncidentKind,
  CourseSupportIncidentStatus,
  ProbeOutcome,
  WebsiteTrafficClass
} from "@prisma/client";

import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { classifyProviderCoverage } from "@/lib/automation/provider-coverage";
import {
  getLocalReaderCourseKey,
  isLocalReaderCandidateUrl
} from "@/lib/local-reader/course-key";
import { localReaderResultSchema } from "@/lib/local-reader/contracts";
import { prisma } from "@/lib/prisma";

import {
  formatOperatorDayKey,
  getOperatorDateRange,
  type OperatorDateRange
} from "./time";
import {
  buildCourseInventory,
  summarizeCourseInventory
} from "./course-status";

const NON_SYNTHETIC_TRAFFIC: { notIn: WebsiteTrafficClass[] } = {
  notIn: [...syntheticWebsiteTrafficClasses]
};
const OVERDUE_SEARCH_GRACE_MS = 10 * 60 * 1000;
const RECENT_PROBE_HOURS = 24;
const RECENT_LOCAL_READER_DAYS = 30;
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
  const recentLocalReaderSince = new Date(
    now.getTime() - RECENT_LOCAL_READER_DAYS * 24 * 60 * 60 * 1000
  );

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
    probeCounts,
    allCourses
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
    }),
    prisma.course.findMany({
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
        profile: {
          select: {
            canonicalSlug: true,
            status: true
          }
        },
        supportIncident: {
          select: {
            id: true,
            status: true,
            kind: true,
            activeRealSearchCount: true,
            firstSeenAt: true,
            resolvedAt: true,
            resolution: true,
            engineeringOnly: true,
            latestMessage: true,
            nextAction: true,
            failureClass: true,
            attemptCount: true
          }
        },
        localReaderJobs: {
          where: {
            status: "COMPLETED",
            completedAt: { gte: recentLocalReaderSince }
          },
          orderBy: { completedAt: "desc" },
          take: 1,
          select: {
            completedAt: true,
            readerVersion: true,
            result: true
          }
        }
      }
    })
  ]);

  const topCourses = buildTopCourses(rangePreferences);
  const topCourseIds = topCourses.map((course) => course.id);
  const allCourseIds = allCourses.map((course) => course.id);
  const [latestProbes, allLatestProbes, selectionCounts, activeAlertCounts] =
    await Promise.all([
      topCourseIds.length > 0
        ? prisma.courseProbe.findMany({
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
        : [],
      allCourseIds.length > 0
        ? prisma.courseProbe.findMany({
            where: {
              courseId: { in: allCourseIds }
            },
            orderBy: { observedAt: "desc" },
            distinct: ["courseId"],
            select: {
              courseId: true,
              outcome: true,
              observedAt: true,
              message: true,
              evidenceUrl: true
            }
          })
        : [],
      prisma.coursePreference.groupBy({
        by: ["courseId"],
        where: {
          teeSearch: {
            trafficClass: NON_SYNTHETIC_TRAFFIC
          }
        },
        _count: {
          _all: true
        }
      }),
      prisma.coursePreference.groupBy({
        by: ["courseId"],
        where: {
          teeSearch: {
            status: "ACTIVE",
            trafficClass: NON_SYNTHETIC_TRAFFIC
          }
        },
        _count: {
          _all: true
        }
      })
    ]);
  const latestProbeByCourse = new Map(
    latestProbes.map((probe) => [probe.courseId, probe])
  );
  const allLatestProbeByCourse = new Map(
    allLatestProbes.map((probe) => [probe.courseId, probe])
  );
  const selectionCountByCourse = new Map(
    selectionCounts.map((group) => [group.courseId, group._count._all])
  );
  const activeAlertCountByCourse = new Map(
    activeAlertCounts.map((group) => [group.courseId, group._count._all])
  );
  const courseInventory = buildCourseInventory(
    allCourses.map((course) => {
      const latestProbe = allLatestProbeByCourse.get(course.id);
      const latestLocalReaderJob = course.localReaderJobs[0];
      const latestLocalReaderResult = localReaderResultSchema.safeParse(
        latestLocalReaderJob?.result
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
                  observedAt: latestProbe.observedAt
                }
              ]
            : [],
          supportIncident: course.supportIncident
        },
        now
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
          course.detectedBookingUrl
        ),
        localReaderVerifiedAt: localReaderVerified
          ? (latestLocalReaderJob?.completedAt ?? null)
          : null,
        localReaderVersion: localReaderVerified
          ? (latestLocalReaderJob?.readerVersion ?? null)
          : null,
        activeAlertCount: activeAlertCountByCourse.get(course.id) ?? 0,
        selectionCount: selectionCountByCourse.get(course.id) ?? 0,
        incident: course.supportIncident,
        latestProbe: latestProbe
          ? {
              ...latestProbe,
              evidenceUrl: sanitizeOperatorUrl(latestProbe.evidenceUrl)
            }
          : null,
        coverageCategory,
        profileSlug:
          course.profile?.status === "PUBLISHED"
            ? course.profile.canonicalSlug
            : null
      };
    }),
    now
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
        lastHeartbeatAt: true,
        lastCompletedAt: true,
        lastOutcome: true,
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
      problemSearches: problemSearches.map((search) => ({
        ...search,
        user: { email: "[redacted]" }
      })),
      problemDeliveries: problemDeliveries.map((delivery) => ({
        ...delivery,
        lastError: delivery.lastError ? "Retry pending" : null,
        teeSearch: { user: { email: "[redacted]" } }
      })),
      brokenFeedback: unresolvedFeedback.filter(
        (feedback) => feedback.sentiment === "BROKEN"
      )
    },
    topCourses: topCourses.map((course) => ({
      ...course,
      latestProbe: latestProbeByCourse.get(course.id) ?? null
    })),
    courseFleet: {
      courses: courseInventory,
      counts: summarizeCourseInventory(courseInventory)
    },
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
    operations: {
      workers: workerStates,
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
