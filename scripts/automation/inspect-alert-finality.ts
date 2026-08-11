import "./load-local-env";

import type { Prisma } from "@prisma/client";

import {
  getCustomerMonitoringStatus,
  type CustomerMonitoringStatus
} from "@/lib/customer-monitoring-status";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 20;
export const FINALITY_TARGET_MS = 10 * 60 * 1000;

type SetupCourseReport = {
  courseId: string | null;
  outcome: string;
  monitoringDisposition: string | null;
  supportStatus: string | null;
  customerStatus: CustomerMonitoringStatus | null;
};

type AlertFinalitySearch = {
  id: string;
  createdAt: Date;
  preferences: Array<{
    courseId: string;
    course: {
      monitoringStatus: { state: string } | null;
      supportIncident: {
        id: string;
        cycle: number;
        status: string;
        humanReviewReason?: string | null;
        firstAffectedSearchId: string | null;
        firstSeenAt: Date;
        lastSeenAt: Date;
      } | null;
    };
  }>;
  probes: Array<{ courseId: string; outcome: string; observedAt: Date }>;
  emailDeliveries: Array<{
    status: string;
    sentAt: Date | null;
    payload: Prisma.JsonValue;
  }>;
};

function readLimit() {
  const index = process.argv.indexOf("--limit");
  const raw = index >= 0 ? Number(process.argv[index + 1]) : DEFAULT_LIMIT;
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : DEFAULT_LIMIT;
}

export function readSetupCourseReports(
  payload: Prisma.JsonValue
): SetupCourseReport[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const payloadRecord = payload as Record<string, unknown>;
  const statusReport = optionalRecord(payloadRecord.statusReport);
  const statusSnapshot = Array.isArray(payloadRecord.statusSnapshot)
    ? payloadRecord.statusSnapshot
    : [];
  const snapshotStatusByCourse = new Map<string, CustomerMonitoringStatus>();
  for (const value of statusSnapshot) {
    const snapshot = optionalRecord(value);
    const courseId = optionalString(snapshot?.courseId);
    const customerStatus = parseCustomerMonitoringStatus(
      snapshot?.customerStatus
    );
    if (courseId && customerStatus) {
      snapshotStatusByCourse.set(courseId, customerStatus);
    }
  }
  if (!statusReport || !Array.isArray(statusReport.courses)) {
    return [];
  }
  return statusReport.courses.flatMap((value) => {
    const course = optionalRecord(value);
    const outcome = optionalString(course?.outcome);
    if (!course || !outcome) {
      return [];
    }
    const courseId = optionalString(course.courseId) ?? null;
    return [
      {
        courseId,
        outcome,
        monitoringDisposition:
          optionalString(course.monitoringDisposition) ?? null,
        supportStatus: optionalString(course.supportStatus) ?? null,
        customerStatus: courseId
          ? (snapshotStatusByCourse.get(courseId) ?? null)
          : null
      }
    ];
  });
}

function percentile(values: number[], fraction: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

function countOutcomes(outcomes: string[]) {
  return outcomes.reduce<Record<string, number>>((counts, outcome) => {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
}

function countStatuses(statuses: CustomerMonitoringStatus[]) {
  return statuses.reduce<Record<CustomerMonitoringStatus, number>>(
    (counts, status) => {
      counts[status] += 1;
      return counts;
    },
    {
      CHECKING: 0,
      MONITORED: 0,
      RETRYING_AUTOMATICALLY: 0,
      NEEDS_HUMAN_REVIEW: 0,
      FINAL_DIRECT_ACTION: 0
    }
  );
}

export function isCurrentIncidentCycleForSearch(input: {
  searchId: string;
  searchCreatedAt: Date;
  incident: AlertFinalitySearch["preferences"][number]["course"]["supportIncident"];
  probes: AlertFinalitySearch["probes"];
  courseId: string;
}) {
  const incident = input.incident;
  if (!incident) {
    return false;
  }
  if (incident.firstAffectedSearchId === input.searchId) {
    return true;
  }
  const issueProbe = [...input.probes]
    .filter(
      (probe) =>
        probe.courseId === input.courseId &&
        probe.observedAt >= input.searchCreatedAt &&
        probe.observedAt >= incident.firstSeenAt &&
        ["NEEDS_ADAPTER", "FETCH_FAILED", "BLOCKED_TOOLING"].includes(
          probe.outcome
        )
    )
    .sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())[0];
  return Boolean(issueProbe && incident.lastSeenAt >= issueProbe.observedAt);
}

export function buildAlertFinalityReport(
  search: AlertFinalitySearch,
  generatedAt = new Date()
) {
  const delivery = search.emailDeliveries.find(
    (candidate) => candidate.sentAt !== null
  );
  const deliveredCourses = delivery
    ? readSetupCourseReports(delivery.payload)
    : [];
  const preferenceByCourse = new Map(
    search.preferences.map((preference) => [preference.courseId, preference])
  );
  const customerStatuses = deliveredCourses.map((course) => {
    if (course.customerStatus) {
      return course.customerStatus;
    }
    const preference = course.courseId
      ? preferenceByCourse.get(course.courseId)
      : undefined;
    const currentIncident =
      preference && course.courseId
        ? isCurrentIncidentCycleForSearch({
            searchId: search.id,
            searchCreatedAt: search.createdAt,
            incident: preference.course.supportIncident,
            probes: search.probes,
            courseId: course.courseId
          })
        : false;
    const currentMonitoringState = isMonitoringState(
      preference?.course.monitoringStatus?.state
    )
      ? preference?.course.monitoringStatus?.state
      : null;
    const monitoringStateRelevantToDeliveredStatus =
      currentMonitoringState === "FINAL_MANUAL" ||
      currentMonitoringState === "FINAL_TECHNICAL" ||
      currentMonitoringState === "FINAL_IDENTITY" ||
      (currentIncident && currentMonitoringState !== "HEALTHY")
        ? currentMonitoringState
        : null;
    return getCustomerMonitoringStatus({
      outcome: course.outcome,
      monitoringDisposition: isMonitoringDisposition(
        course.monitoringDisposition
      )
        ? course.monitoringDisposition
        : null,
      monitoringState: monitoringStateRelevantToDeliveredStatus,
      incidentStatus:
        currentIncident &&
        (preference?.course.supportIncident?.status === "AUTO_INVESTIGATING" ||
          preference?.course.supportIncident?.status === "NEEDS_HUMAN" ||
          preference?.course.supportIncident?.status === "RESOLVED")
          ? preference.course.supportIncident.status
          : null,
      humanReviewReason: currentIncident
        ? preference?.course.supportIncident?.humanReviewReason ?? null
        : null,
      supportStatus:
        course.supportStatus === "IN_OPERATOR_QUEUE" ||
        course.supportStatus === "NEEDS_HUMAN_REVIEW"
          ? course.supportStatus
          : null
    });
  });
  const statusCounts = countStatuses(customerStatuses);
  const selectedCourseCount = search.preferences.length;
  const deliveredCourseCount = deliveredCourses.length;
  const reportDeliveryComplete =
    selectedCourseCount > 0 && deliveredCourseCount === selectedCourseCount;
  const customerStatusComplete =
    reportDeliveryComplete && statusCounts.CHECKING === 0;
  const deliveredInMs = delivery?.sentAt
    ? delivery.sentAt.getTime() - search.createdAt.getTime()
    : null;
  const currentIssueCourseIds = new Set(
    search.preferences.flatMap((preference) =>
      isCurrentIncidentCycleForSearch({
        searchId: search.id,
        searchCreatedAt: search.createdAt,
        incident: preference.course.supportIncident,
        probes: search.probes,
        courseId: preference.courseId
      })
        ? [preference.courseId]
        : []
    )
  );
  const issueStatusCourseCount =
    statusCounts.RETRYING_AUTOMATICALLY + statusCounts.NEEDS_HUMAN_REVIEW;
  const effectiveOrFactualCount =
    statusCounts.MONITORED + statusCounts.FINAL_DIRECT_ACTION;

  return {
    createdAt: search.createdAt,
    selectedCourseCount,
    firstCourseResultCount: new Set(
      search.probes
        .filter((probe) => probe.observedAt >= search.createdAt)
        .map((probe) => probe.courseId)
    ).size,
    deliveredCourseCount,
    courseOutcomeCounts: countOutcomes(
      deliveredCourses.map((course) => course.outcome)
    ),
    customerStatusCounts: statusCounts,
    effectiveMonitoringCourseCount: statusCounts.MONITORED,
    factualFinalityCourseCount: statusCounts.FINAL_DIRECT_ACTION,
    automaticRetryCourseCount: statusCounts.RETRYING_AUTOMATICALLY,
    humanReviewCourseCount: statusCounts.NEEDS_HUMAN_REVIEW,
    checkingCourseCount: statusCounts.CHECKING,
    currentIncidentCycleCourseCount: currentIssueCourseIds.size,
    issueRecordingComplete:
      currentIssueCourseIds.size >= issueStatusCourseCount,
    setupDeliveryStatus: delivery?.status ?? null,
    deliveredSeconds:
      deliveredInMs === null ? null : Math.round(deliveredInMs / 100) / 10,
    reportDeliveryComplete,
    customerStatusComplete,
    effectiveOrFactualFinalityComplete:
      reportDeliveryComplete && effectiveOrFactualCount === selectedCourseCount,
    metTenMinuteReportTarget:
      customerStatusComplete &&
      deliveredInMs !== null &&
      deliveredInMs <= FINALITY_TARGET_MS,
    metTenMinuteEffectiveOrFactualTarget:
      reportDeliveryComplete &&
      effectiveOrFactualCount === selectedCourseCount &&
      deliveredInMs !== null &&
      deliveredInMs <= FINALITY_TARGET_MS,
    stuck:
      generatedAt.getTime() - search.createdAt.getTime() >
        FINALITY_TARGET_MS &&
      !customerStatusComplete,
    // Backward-compatible aggregate aliases for existing operators.
    finalCourseCount: deliveredCourseCount - statusCounts.CHECKING,
    complete: customerStatusComplete,
    metTenMinuteTarget:
      customerStatusComplete &&
      deliveredInMs !== null &&
      deliveredInMs <= FINALITY_TARGET_MS
  };
}

export function buildAlertFinalitySummary(
  searches: AlertFinalitySearch[],
  generatedAt = new Date()
) {
  const reports = searches.map((search) =>
    buildAlertFinalityReport(search, generatedAt)
  );
  const completedDurations = reports.flatMap((report) =>
    report.customerStatusComplete && report.deliveredSeconds !== null
      ? [report.deliveredSeconds]
      : []
  );
  return {
    generatedAt,
    targetSeconds: FINALITY_TARGET_MS / 1000,
    observedAlertCount: reports.length,
    reportDeliveryCompleteCount: reports.filter(
      (report) => report.reportDeliveryComplete
    ).length,
    customerStatusCompleteCount: reports.filter(
      (report) => report.customerStatusComplete
    ).length,
    effectiveOrFactualFinalityCompleteCount: reports.filter(
      (report) => report.effectiveOrFactualFinalityComplete
    ).length,
    automaticRetryAlertCount: reports.filter(
      (report) => report.automaticRetryCourseCount > 0
    ).length,
    humanReviewAlertCount: reports.filter(
      (report) => report.humanReviewCourseCount > 0
    ).length,
    tenMinuteReportSuccessCount: reports.filter(
      (report) => report.metTenMinuteReportTarget
    ).length,
    tenMinuteEffectiveOrFactualSuccessCount: reports.filter(
      (report) => report.metTenMinuteEffectiveOrFactualTarget
    ).length,
    stuckAlertCount: reports.filter((report) => report.stuck).length,
    deliverySeconds: {
      p50: percentile(completedDurations, 0.5),
      p95: percentile(completedDurations, 0.95),
      maximum:
        completedDurations.length > 0
          ? Math.max(...completedDurations)
          : null
    },
    // Backward-compatible aggregate aliases for existing consumers.
    completeAlertCount: reports.filter((report) => report.complete).length,
    tenMinuteSuccessCount: reports.filter(
      (report) => report.metTenMinuteTarget
    ).length,
    alerts: reports
  };
}

async function main() {
  const generatedAt = new Date();
  const searches = await prisma.teeSearch.findMany({
    where: {
      trafficClass: "PUBLIC",
      syntheticMultiCycle: false,
      preferences: { some: {} }
    },
    orderBy: { createdAt: "desc" },
    take: readLimit(),
    select: {
      id: true,
      createdAt: true,
      preferences: {
        select: {
          courseId: true,
          course: {
            select: {
              monitoringStatus: { select: { state: true } },
              supportIncident: {
                select: {
                  id: true,
                  cycle: true,
                  status: true,
                  humanReviewReason: true,
                  firstAffectedSearchId: true,
                  firstSeenAt: true,
                  lastSeenAt: true
                }
              }
            }
          }
        }
      },
      probes: {
        orderBy: { observedAt: "asc" },
        select: { courseId: true, outcome: true, observedAt: true }
      },
      emailDeliveries: {
        where: { kind: "SETUP", isOwnerRecipient: true },
        orderBy: { createdAt: "desc" },
        select: { status: true, sentAt: true, payload: true }
      }
    }
  });

  console.log(
    JSON.stringify(
      buildAlertFinalitySummary(
        searches as unknown as AlertFinalitySearch[],
        generatedAt
      ),
      null,
      2
    )
  );
}

function optionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function parseCustomerMonitoringStatus(
  value: unknown
): CustomerMonitoringStatus | null {
  return value === "CHECKING" ||
    value === "MONITORED" ||
    value === "RETRYING_AUTOMATICALLY" ||
    value === "NEEDS_HUMAN_REVIEW" ||
    value === "FINAL_DIRECT_ACTION"
    ? value
    : null;
}

function isMonitoringDisposition(
  value: string | null
): value is
  | "ACTIONABLE"
  | "MANUAL_FINAL"
  | "TECHNICAL_FINAL"
  | "IDENTITY_FINAL"
  | "IDENTITY_RECHECK" {
  return (
    value === "ACTIONABLE" ||
    value === "MANUAL_FINAL" ||
    value === "TECHNICAL_FINAL" ||
    value === "IDENTITY_FINAL" ||
    value === "IDENTITY_RECHECK"
  );
}

function isMonitoringState(
  value: string | null | undefined
): value is
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED_RETRYING"
  | "AUTO_INVESTIGATING"
  | "ENGINEERING_VERIFICATION_NEEDED"
  | "REVALIDATING_FINAL"
  | "FINAL_MANUAL"
  | "FINAL_TECHNICAL"
  | "FINAL_IDENTITY" {
  return (
    value === "UNKNOWN" ||
    value === "HEALTHY" ||
    value === "DEGRADED_RETRYING" ||
    value === "AUTO_INVESTIGATING" ||
    value === "ENGINEERING_VERIFICATION_NEEDED" ||
    value === "REVALIDATING_FINAL" ||
    value === "FINAL_MANUAL" ||
    value === "FINAL_TECHNICAL" ||
    value === "FINAL_IDENTITY"
  );
}

if (process.env.NODE_ENV !== "test") {
  main()
    .catch((error) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Alert finality inspection failed"
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
