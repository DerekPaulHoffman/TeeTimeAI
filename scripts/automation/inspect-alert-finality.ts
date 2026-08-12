import "./load-local-env";

import type { Prisma } from "@prisma/client";

import {
  getCustomerMonitoringStatus,
  type CustomerMonitoringStatus
} from "@/lib/customer-monitoring-status";
import { isAutomationHumanReviewProofCurrentOrPrior } from "@/lib/automation/course-monitoring-playbook";
import { prisma } from "@/lib/prisma";

const DEFAULT_LIMIT = 20;
const MAX_PROBES_PER_SEARCH = 500;
const MAX_STATUS_DELIVERIES_PER_SEARCH = 100;
const MAX_DELIVERY_QUERY_CONCURRENCY = 5;
export const SETUP_REPORT_TARGET_MS = 10 * 60 * 1000;
export const CURRENT_ENDPOINT_TARGET_MS = 30 * 60 * 1000;
// Backward-compatible name for operators that already consume the original
// ten-minute setup-report target.
export const FINALITY_TARGET_MS = SETUP_REPORT_TARGET_MS;

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
  alertGeneration?: number;
  preferences: Array<{
    courseId: string;
    course: {
      monitoringStatus: {
        state: string;
        stateChangedAt: Date;
      } | null;
      supportIncident: {
        id: string;
        cycle: number;
        attemptLedger?: Prisma.JsonValue | null;
        status: string;
        humanReviewReason?: string | null;
        firstAffectedSearchId: string | null;
        firstSeenAt: Date;
        lastSeenAt: Date;
        confirmedAt?: Date | null;
        escalationDeadlineAt?: Date | null;
        escalatedAt?: Date | null;
        resolvedAt?: Date | null;
      } | null;
    };
  }>;
  probes: Array<{ courseId: string; outcome: string; observedAt: Date }>;
  emailDeliveries: Array<{
    alertGeneration?: number;
    createdAt?: Date;
    kind?: string;
    status: string;
    sentAt: Date | null;
    payload: Prisma.JsonValue;
  }>;
};

type DeliveredCourseStatus = {
  status: CustomerMonitoringStatus;
  deliveredAt: Date;
  kind: string;
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
  if (
    incident.firstAffectedSearchId === input.searchId &&
    incident.firstSeenAt >= input.searchCreatedAt
  ) {
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

function getLatestDeliveredStatusByCourse(
  deliveries: AlertFinalitySearch["emailDeliveries"]
) {
  const latest = new Map<string, DeliveredCourseStatus>();
  const sent = deliveries
    .filter(
      (delivery): delivery is typeof delivery & { sentAt: Date } =>
        delivery.sentAt !== null && delivery.status === "SENT"
    )
    .sort(
      (left, right) =>
        left.sentAt.getTime() - right.sentAt.getTime() ||
        (left.createdAt?.getTime() ?? 0) -
          (right.createdAt?.getTime() ?? 0)
    );
  for (const delivery of sent) {
    const payload = optionalRecord(delivery.payload);
    if (
      delivery.kind === "MATCH" &&
      payload?.satisfiesStatusReport !== true
    ) {
      continue;
    }
    const reports = readSetupCourseReports(delivery.payload);
    const visibleCourseIds = readVisibleCourseIds(
      delivery.payload,
      delivery.kind
    );
    for (const report of reports) {
      if (!report.courseId) continue;
      latest.set(report.courseId, {
        status:
          report.customerStatus ??
          getCustomerMonitoringStatus({
            outcome: report.outcome,
            monitoringDisposition: isMonitoringDisposition(
              report.monitoringDisposition
            )
              ? report.monitoringDisposition
              : null,
            supportStatus:
              report.supportStatus === "IN_OPERATOR_QUEUE" ||
              report.supportStatus === "NEEDS_HUMAN_REVIEW"
                ? report.supportStatus
                : null
          }),
        deliveredAt: delivery.sentAt,
        kind: delivery.kind ?? "SETUP"
      });
    }
    for (const [courseId, status] of readStatusSnapshot(delivery.payload)) {
      if (!visibleCourseIds.has(courseId)) continue;
      latest.set(courseId, {
        status,
        deliveredAt: delivery.sentAt,
        kind: delivery.kind ?? "SETUP"
      });
    }
  }
  return latest;
}

function readStatusSnapshot(payload: Prisma.JsonValue) {
  const statuses = new Map<string, CustomerMonitoringStatus>();
  const record = optionalRecord(payload);
  const snapshot = Array.isArray(record?.statusSnapshot)
    ? record.statusSnapshot
    : [];
  for (const value of snapshot) {
    const row = optionalRecord(value);
    const courseId = optionalString(row?.courseId);
    const status = parseCustomerMonitoringStatus(row?.customerStatus);
    if (courseId && status) {
      statuses.set(courseId, status);
    }
  }
  return statuses;
}

function readVisibleCourseIds(
  payload: Prisma.JsonValue,
  kind: string | undefined
) {
  const record = optionalRecord(payload);
  const report = optionalRecord(
    kind === "MATCH" ? record?.matchReport : record?.statusReport
  );
  const rows = Array.isArray(
    kind === "MATCH" ? report?.matches : report?.courses
  )
    ? (kind === "MATCH" ? report?.matches : report?.courses) as unknown[]
    : [];
  return new Set(
    rows.flatMap((value) => {
      const courseId = optionalString(optionalRecord(value)?.courseId);
      return courseId ? [courseId] : [];
    })
  );
}

function readDeliveryCheckedAt(payload: Prisma.JsonValue) {
  const checkedAt = optionalString(optionalRecord(payload)?.checkedAt);
  if (!checkedAt) return null;
  const timestamp = Date.parse(checkedAt);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function getCurrentGenerationDeliveries(search: AlertFinalitySearch) {
  const generation = search.alertGeneration ?? 0;
  return search.emailDeliveries.filter(
    (delivery) => (delivery.alertGeneration ?? generation) === generation
  );
}

function getCurrentEvidenceBoundary(
  search: AlertFinalitySearch,
  deliveries: AlertFinalitySearch["emailDeliveries"]
) {
  if ((search.alertGeneration ?? 0) === 0) {
    return search.createdAt;
  }
  return earliestDate(
    deliveries.flatMap((delivery) => {
      const checkedAt = readDeliveryCheckedAt(delivery.payload);
      return checkedAt ? [checkedAt] : [];
    })
  );
}

function getCurrentCourseAssessment(input: {
  search: AlertFinalitySearch;
  preference: AlertFinalitySearch["preferences"][number];
  evidenceBoundary: Date | null;
}) {
  const { search, preference } = input;
  const incident = preference.course.supportIncident;
  const currentIncident = input.evidenceBoundary
    ? isCurrentIncidentCycleForSearch({
        searchId: search.id,
        searchCreatedAt: input.evidenceBoundary,
        incident,
        probes: search.probes,
        courseId: preference.courseId
      })
    : false;
  const courseProbes = [...search.probes]
    .filter(
      (probe) =>
        probe.courseId === preference.courseId &&
        input.evidenceBoundary !== null &&
        probe.observedAt >= input.evidenceBoundary
    )
    .sort(
      (left, right) => left.observedAt.getTime() - right.observedAt.getTime()
    );
  const latestProbe = courseProbes.at(-1);
  const monitoringStatus = preference.course.monitoringStatus;
  const monitoringState = isMonitoringState(monitoringStatus?.state)
    ? monitoringStatus.state
    : null;
  const monitoringStateMatchesCurrentCycle = Boolean(
    monitoringStatus &&
      input.evidenceBoundary !== null &&
      monitoringStatus.stateChangedAt >= input.evidenceBoundary
  );
  const monitoringStateIsCurrent = Boolean(
    monitoringStatus &&
      (monitoringStateMatchesCurrentCycle ||
        monitoringState === "FINAL_MANUAL" ||
        monitoringState === "FINAL_IDENTITY")
  );
  const incidentStatus =
    currentIncident &&
    (incident?.status === "AUTO_INVESTIGATING" ||
      incident?.status === "NEEDS_HUMAN" ||
      incident?.status === "RESOLVED")
      ? incident.status
      : null;
  const finalMonitoringState =
    monitoringStateIsCurrent &&
    (monitoringState === "FINAL_MANUAL" ||
      monitoringState === "FINAL_TECHNICAL" ||
      monitoringState === "FINAL_IDENTITY");
  const currentProbeOutcome =
    latestProbe?.outcome === "BLOCKED_AUTH" && !finalMonitoringState
      ? currentIncident
        ? "FETCH_FAILED"
        : null
      : latestProbe?.outcome ?? null;
  const status = getCustomerMonitoringStatus({
    outcome: currentProbeOutcome,
    monitoringState: monitoringStateIsCurrent ? monitoringState : null,
    monitoringStateChangedAt: monitoringStateIsCurrent
      ? monitoringStatus?.stateChangedAt ?? null
      : null,
    outcomeObservedAt: latestProbe?.observedAt ?? null,
    incidentStatus,
    humanReviewReason: currentIncident
      ? incident?.humanReviewReason ?? null
      : null,
    incidentEscalatedAt: currentIncident ? incident?.escalatedAt ?? null : null,
    automationPlaybookExhausted:
      currentIncident && incident
        ? isAutomationHumanReviewProofCurrentOrPrior(
            incident.attemptLedger ?? null,
            incident.cycle
          )
        : null
  });

  const observedAtCandidates: Date[] = [];
  if (status === "FINAL_DIRECT_ACTION") {
    const persistedFinalAt =
      monitoringStatus &&
      monitoringStateIsCurrent &&
      (monitoringState === "FINAL_MANUAL" ||
        monitoringState === "FINAL_TECHNICAL" ||
        monitoringState === "FINAL_IDENTITY")
        ? monitoringStatus.stateChangedAt
        : null;
    if (persistedFinalAt) {
      observedAtCandidates.push(persistedFinalAt);
    } else {
      const finalRunStartedAt = getContiguousProbeRunStart(courseProbes, [
        "MANUAL_DIRECT",
        "IDENTITY_FINAL",
        "BLOCKED_AUTH"
      ]);
      if (finalRunStartedAt) {
        observedAtCandidates.push(finalRunStartedAt);
      }
      if (currentIncident && incident?.resolvedAt) {
        observedAtCandidates.push(incident.resolvedAt);
      }
    }
  } else if (status === "NEEDS_HUMAN_REVIEW") {
    if (
      monitoringStatus &&
      monitoringStateIsCurrent &&
      monitoringState === "ENGINEERING_VERIFICATION_NEEDED"
    ) {
      observedAtCandidates.push(monitoringStatus.stateChangedAt);
    }
    if (currentIncident && incident) {
      if (incident.escalatedAt) {
        observedAtCandidates.push(incident.escalatedAt);
      }
    }
  } else if (status === "MONITORED") {
    const persistedHealthyAt =
      monitoringStatus &&
      monitoringStateIsCurrent &&
      monitoringState === "HEALTHY"
        ? monitoringStatus.stateChangedAt
        : null;
    if (persistedHealthyAt) {
      observedAtCandidates.push(persistedHealthyAt);
    } else {
      const healthyRunStartedAt = getContiguousProbeRunStart(courseProbes, [
        "MATCH_FOUND",
        "NO_MATCH"
      ]);
      if (healthyRunStartedAt) {
        observedAtCandidates.push(healthyRunStartedAt);
      }
    }
  } else if (status === "RETRYING_AUTOMATICALLY") {
    if (
      monitoringStatus &&
      monitoringStateIsCurrent &&
      (monitoringState === "DEGRADED_RETRYING" ||
        monitoringState === "AUTO_INVESTIGATING" ||
        monitoringState === "REVALIDATING_FINAL")
    ) {
      observedAtCandidates.push(monitoringStatus.stateChangedAt);
    }
    if (currentIncident && incident) {
      observedAtCandidates.push(incident.lastSeenAt);
    }
    if (
      latestProbe &&
      ["NEEDS_ADAPTER", "FETCH_FAILED", "BLOCKED_TOOLING"].includes(
        latestProbe.outcome
      )
    ) {
      observedAtCandidates.push(latestProbe.observedAt);
    }
  }

  const observedAt = latestDate(observedAtCandidates);
  return { status, observedAt, currentIncident };
}

function latestDate(values: Date[]) {
  return values.length === 0
    ? null
    : values.reduce((latest, value) => (value > latest ? value : latest));
}

function earliestDate(values: Date[]) {
  return values.length === 0
    ? null
    : values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function getContiguousProbeRunStart(
  probes: AlertFinalitySearch["probes"],
  outcomes: string[]
) {
  const allowed = new Set(outcomes);
  let startedAt: Date | null = null;
  for (let index = probes.length - 1; index >= 0; index -= 1) {
    const probe = probes[index];
    if (!allowed.has(probe.outcome)) break;
    startedAt = probe.observedAt;
  }
  return startedAt;
}

function durationSeconds(start: Date, end: Date | null) {
  return end
    ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 100) / 10)
    : null;
}

export function buildAlertFinalityReport(
  search: AlertFinalitySearch,
  generatedAt = new Date()
) {
  const currentGenerationDeliveries = getCurrentGenerationDeliveries(search);
  const evidenceBoundary = getCurrentEvidenceBoundary(
    search,
    currentGenerationDeliveries
  );
  const userTimingEligible = (search.alertGeneration ?? 0) === 0;
  const timingStartedAt = userTimingEligible ? search.createdAt : evidenceBoundary;
  const setupDeliveries = currentGenerationDeliveries.filter(
    (candidate) => !candidate.kind || candidate.kind === "SETUP"
  );
  const setupDelivery = setupDeliveries.find(
    (candidate) => candidate.sentAt !== null && candidate.status === "SENT"
  );
  const deliveredCourses = setupDelivery
    ? readSetupCourseReports(setupDelivery.payload)
    : [];
  const preferenceByCourse = new Map(
    search.preferences.map((preference) => [preference.courseId, preference])
  );
  const setupCustomerStatuses = deliveredCourses.map((course) => {
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
            searchCreatedAt: evidenceBoundary ?? search.createdAt,
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
    const currentMonitoringStatus = preference?.course.monitoringStatus;
    const monitoringStateMatchesCurrentCycle = Boolean(
      currentMonitoringStatus &&
        evidenceBoundary !== null &&
        currentMonitoringStatus.stateChangedAt >= evidenceBoundary
    );
    const monitoringStateRelevantToDeliveredStatus =
      currentMonitoringState === "FINAL_MANUAL" ||
      currentMonitoringState === "FINAL_IDENTITY" ||
      (monitoringStateMatchesCurrentCycle &&
        currentMonitoringState !== "HEALTHY")
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
      monitoringStateChangedAt:
        monitoringStateRelevantToDeliveredStatus && currentMonitoringStatus
          ? currentMonitoringStatus.stateChangedAt
          : null,
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
      incidentEscalatedAt: currentIncident
        ? preference?.course.supportIncident?.escalatedAt ?? null
        : null,
      automationPlaybookExhausted:
        currentIncident && preference?.course.supportIncident
          ? isAutomationHumanReviewProofCurrentOrPrior(
              preference.course.supportIncident.attemptLedger ?? null,
              preference.course.supportIncident.cycle
            )
          : null,
      supportStatus:
        course.supportStatus === "IN_OPERATOR_QUEUE" ||
        course.supportStatus === "NEEDS_HUMAN_REVIEW"
          ? course.supportStatus
          : null
    });
  });
  const setupStatusCounts = countStatuses(setupCustomerStatuses);
  const deliveredStatusByCourse = getLatestDeliveredStatusByCourse(
    currentGenerationDeliveries
  );
  const currentAssessments = search.preferences.map((preference) =>
    getCurrentCourseAssessment({
      search,
      preference,
      evidenceBoundary
    })
  );
  const currentStatusCounts = countStatuses(
    currentAssessments.map((assessment) => assessment.status)
  );
  const deliveredCurrentStatusCounts = countStatuses(
    search.preferences.map(
      (preference) =>
        deliveredStatusByCourse.get(preference.courseId)?.status ?? "CHECKING"
    )
  );
  const selectedCourseCount = search.preferences.length;
  const deliveredCourseCount = deliveredCourses.length;
  const reportDeliveryComplete =
    selectedCourseCount > 0 && deliveredCourseCount === selectedCourseCount;
  const customerStatusComplete =
    reportDeliveryComplete && setupStatusCounts.CHECKING === 0;
  const deliveredInMs = setupDelivery?.sentAt && timingStartedAt
    ? setupDelivery.sentAt.getTime() - timingStartedAt.getTime()
    : null;
  const currentIssueCourseIds = new Set(
    search.preferences.flatMap((preference) =>
      evidenceBoundary &&
      isCurrentIncidentCycleForSearch({
          searchId: search.id,
          searchCreatedAt: evidenceBoundary,
          incident: preference.course.supportIncident,
          probes: search.probes,
          courseId: preference.courseId
        })
        ? [preference.courseId]
        : []
      )
  );
  const setupIssueCourseIds = new Set(
    deliveredCourses.flatMap((course, index) =>
      course.courseId &&
      (setupCustomerStatuses[index] === "RETRYING_AUTOMATICALLY" ||
        setupCustomerStatuses[index] === "NEEDS_HUMAN_REVIEW")
        ? [course.courseId]
        : []
    )
  );
  const currentIssueStatusCourseIds = new Set(
    currentAssessments.flatMap((assessment, index) =>
      assessment.status === "RETRYING_AUTOMATICALLY" ||
      assessment.status === "NEEDS_HUMAN_REVIEW"
        ? [search.preferences[index].courseId]
        : []
    )
  );
  const issueStatusCourseIds = new Set([
    ...setupIssueCourseIds,
    ...currentIssueStatusCourseIds
  ]);
  const hasUnmappedSetupIssue = deliveredCourses.some(
    (course, index) =>
      !course.courseId &&
      (setupCustomerStatuses[index] === "RETRYING_AUTOMATICALLY" ||
        setupCustomerStatuses[index] === "NEEDS_HUMAN_REVIEW")
  );
  const effectiveOrFactualCount =
    setupStatusCounts.MONITORED + setupStatusCounts.FINAL_DIRECT_ACTION;
  const currentEndpointObservedAt = currentAssessments.map(
    (assessment) => assessment.observedAt
  );
  const currentEndpointStateComplete =
    selectedCourseCount > 0 &&
    currentStatusCounts.CHECKING === 0 &&
    currentStatusCounts.RETRYING_AUTOMATICALLY === 0 &&
    currentEndpointObservedAt.every(
      (observedAt): observedAt is Date => observedAt !== null
    );
  const currentEndpointStateSeconds =
    currentEndpointStateComplete && timingStartedAt
      ? Math.max(
          ...currentEndpointObservedAt.map(
            (observedAt) => durationSeconds(timingStartedAt, observedAt) ?? 0
          )
        )
      : null;
  const matchingCurrentDeliveries = currentAssessments.map(
    (assessment, index) => {
      const deliveredStatus = deliveredStatusByCourse.get(
        search.preferences[index].courseId
      );
      if (
        !assessment.observedAt ||
        !deliveredStatus ||
        deliveredStatus.status !== assessment.status ||
        deliveredStatus.deliveredAt < assessment.observedAt
      ) {
        return null;
      }
      return deliveredStatus.deliveredAt;
    }
  );
  const currentEndpointComplete =
    currentEndpointStateComplete &&
    matchingCurrentDeliveries.every(
      (deliveredAt): deliveredAt is Date => deliveredAt !== null
    );
  const currentEndpointSeconds = currentEndpointComplete && timingStartedAt
    ? Math.max(
        ...matchingCurrentDeliveries.map(
          (deliveredAt) => durationSeconds(timingStartedAt, deliveredAt) ?? 0
        )
      )
    : null;
  const transitionDeliveries = currentGenerationDeliveries.filter(
    (candidate) =>
      candidate.sentAt !== null &&
      candidate.status === "SENT" &&
      candidate.kind !== undefined &&
      candidate.kind !== "SETUP" &&
      (candidate.kind !== "MATCH" ||
        optionalRecord(candidate.payload)?.satisfiesStatusReport === true)
  );
  const latestStatusDelivery = [...transitionDeliveries].sort(
    (left, right) =>
      (right.sentAt?.getTime() ?? 0) - (left.sentAt?.getTime() ?? 0)
  )[0];

  return {
    createdAt: search.createdAt,
    alertGeneration: search.alertGeneration ?? 0,
    timingStartedAt,
    timingOrigin: userTimingEligible
      ? "SEARCH_CREATED"
      : timingStartedAt
        ? "FIRST_CURRENT_GENERATION_CHECK"
        : "UNAVAILABLE",
    userTimingEligible,
    selectedCourseCount,
    firstCourseResultCount: new Set(
      search.probes
        .filter(
          (probe) =>
            evidenceBoundary !== null && probe.observedAt >= evidenceBoundary
        )
        .map((probe) => probe.courseId)
    ).size,
    deliveredCourseCount,
    courseOutcomeCounts: countOutcomes(
      deliveredCourses.map((course) => course.outcome)
    ),
    customerStatusCounts: setupStatusCounts,
    effectiveMonitoringCourseCount: setupStatusCounts.MONITORED,
    factualFinalityCourseCount: setupStatusCounts.FINAL_DIRECT_ACTION,
    automaticRetryCourseCount: setupStatusCounts.RETRYING_AUTOMATICALLY,
    humanReviewCourseCount: setupStatusCounts.NEEDS_HUMAN_REVIEW,
    checkingCourseCount: setupStatusCounts.CHECKING,
    currentCustomerStatusCounts: currentStatusCounts,
    currentEffectiveMonitoringCourseCount: currentStatusCounts.MONITORED,
    currentFactualFinalityCourseCount:
      currentStatusCounts.FINAL_DIRECT_ACTION,
    currentAutomaticRetryCourseCount:
      currentStatusCounts.RETRYING_AUTOMATICALLY,
    currentHumanReviewCourseCount: currentStatusCounts.NEEDS_HUMAN_REVIEW,
    currentCheckingCourseCount: currentStatusCounts.CHECKING,
    deliveredCurrentCustomerStatusCounts: deliveredCurrentStatusCounts,
    currentIncidentCycleCourseCount: currentIssueCourseIds.size,
    issueRecordingComplete:
      !hasUnmappedSetupIssue &&
      [...issueStatusCourseIds].every((courseId) =>
        currentIssueCourseIds.has(courseId)
      ),
    setupDeliveryStatus:
      setupDelivery?.status ?? setupDeliveries[0]?.status ?? null,
    deliveredSeconds:
      deliveredInMs === null ? null : Math.round(deliveredInMs / 100) / 10,
    reportDeliveryComplete,
    customerStatusComplete,
    effectiveOrFactualFinalityComplete:
      reportDeliveryComplete && effectiveOrFactualCount === selectedCourseCount,
    currentEndpointStateComplete,
    currentEndpointStateSeconds,
    currentEndpointComplete,
    currentEndpointSeconds,
    metThirtyMinuteEndpointTarget:
      userTimingEligible &&
      currentEndpointComplete &&
      currentEndpointSeconds !== null &&
      currentEndpointSeconds <= CURRENT_ENDPOINT_TARGET_MS / 1000,
    endpointStuck:
      userTimingEligible &&
      generatedAt.getTime() - search.createdAt.getTime() >
        CURRENT_ENDPOINT_TARGET_MS && !currentEndpointComplete,
    transitionDeliveryCount: transitionDeliveries.length,
    monitoringStatusUpdateDeliveryCount: transitionDeliveries.filter(
      (candidate) => candidate.kind === "MONITORING_STATUS_UPDATE"
    ).length,
    latestStatusDeliveryKind: latestStatusDelivery?.kind ?? null,
    latestStatusDeliverySeconds: durationSeconds(
      timingStartedAt ?? search.createdAt,
      latestStatusDelivery?.sentAt ?? null
    ),
    metTenMinuteReportTarget:
      userTimingEligible &&
      customerStatusComplete &&
      deliveredInMs !== null &&
      deliveredInMs <= FINALITY_TARGET_MS,
    metTenMinuteEffectiveOrFactualTarget:
      userTimingEligible &&
      reportDeliveryComplete &&
      effectiveOrFactualCount === selectedCourseCount &&
      deliveredInMs !== null &&
      deliveredInMs <= FINALITY_TARGET_MS,
    stuck:
      userTimingEligible &&
      generatedAt.getTime() - search.createdAt.getTime() >
        FINALITY_TARGET_MS &&
      !customerStatusComplete,
    // Backward-compatible aggregate aliases for existing operators.
    finalCourseCount: deliveredCourseCount - setupStatusCounts.CHECKING,
    complete: customerStatusComplete,
    metTenMinuteTarget:
      userTimingEligible &&
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
    report.userTimingEligible &&
    report.customerStatusComplete &&
    report.deliveredSeconds !== null
      ? [report.deliveredSeconds]
      : []
  );
  const currentEndpointDurations = reports.flatMap((report) =>
    report.userTimingEligible &&
    report.currentEndpointComplete &&
    report.currentEndpointSeconds !== null
      ? [report.currentEndpointSeconds]
      : []
  );
  const currentEndpointStateDurations = reports.flatMap((report) =>
    report.currentEndpointStateComplete &&
    report.userTimingEligible &&
    report.currentEndpointStateSeconds !== null
      ? [report.currentEndpointStateSeconds]
      : []
  );
  return {
    generatedAt,
    targetSeconds: FINALITY_TARGET_MS / 1000,
    setupReportTargetSeconds: SETUP_REPORT_TARGET_MS / 1000,
    currentEndpointTargetSeconds: CURRENT_ENDPOINT_TARGET_MS / 1000,
    observedAlertCount: reports.length,
    userTimingEligibleAlertCount: reports.filter(
      (report) => report.userTimingEligible
    ).length,
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
    currentEndpointCompleteCount: reports.filter(
      (report) => report.currentEndpointComplete
    ).length,
    currentEndpointStateCompleteCount: reports.filter(
      (report) => report.currentEndpointStateComplete
    ).length,
    currentEffectiveMonitoringAlertCount: reports.filter(
      (report) => report.currentEffectiveMonitoringCourseCount > 0
    ).length,
    currentFactualFinalityAlertCount: reports.filter(
      (report) => report.currentFactualFinalityCourseCount > 0
    ).length,
    currentAutomaticRetryAlertCount: reports.filter(
      (report) => report.currentAutomaticRetryCourseCount > 0
    ).length,
    currentHumanReviewAlertCount: reports.filter(
      (report) => report.currentHumanReviewCourseCount > 0
    ).length,
    thirtyMinuteEndpointSuccessCount: reports.filter(
      (report) => report.metThirtyMinuteEndpointTarget
    ).length,
    endpointStuckAlertCount: reports.filter(
      (report) => report.endpointStuck
    ).length,
    monitoringStatusUpdateDeliveryCount: reports.reduce(
      (count, report) => count + report.monitoringStatusUpdateDeliveryCount,
      0
    ),
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
    currentEndpointSeconds: {
      p50: percentile(currentEndpointDurations, 0.5),
      p95: percentile(currentEndpointDurations, 0.95),
      maximum:
        currentEndpointDurations.length > 0
          ? Math.max(...currentEndpointDurations)
          : null
    },
    currentEndpointStateSeconds: {
      p50: percentile(currentEndpointStateDurations, 0.5),
      p95: percentile(currentEndpointStateDurations, 0.95),
      maximum:
        currentEndpointStateDurations.length > 0
          ? Math.max(...currentEndpointStateDurations)
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
      alertGeneration: true,
      preferences: {
        select: {
          courseId: true,
          course: {
            select: {
              monitoringStatus: {
                select: { state: true, stateChangedAt: true }
              },
              supportIncident: {
                select: {
                  id: true,
                  cycle: true,
                  attemptLedger: true,
                  status: true,
                  humanReviewReason: true,
                  firstAffectedSearchId: true,
                  firstSeenAt: true,
                  lastSeenAt: true,
                  confirmedAt: true,
                  escalationDeadlineAt: true,
                  escalatedAt: true,
                  resolvedAt: true
                }
              }
            }
          }
        }
      },
      probes: {
        orderBy: { observedAt: "desc" },
        take: MAX_PROBES_PER_SEARCH,
        select: { courseId: true, outcome: true, observedAt: true }
      }
    }
  });

  const searchesWithCurrentDeliveries: Array<
    (typeof searches)[number] & {
      emailDeliveries: AlertFinalitySearch["emailDeliveries"];
    }
  > = [];
  for (
    let index = 0;
    index < searches.length;
    index += MAX_DELIVERY_QUERY_CONCURRENCY
  ) {
    const batch = await Promise.all(
      searches
        .slice(index, index + MAX_DELIVERY_QUERY_CONCURRENCY)
        .map(async (search) => {
          const deliverySelect = {
            alertGeneration: true,
            createdAt: true,
            kind: true,
            status: true,
            sentAt: true,
            payload: true
          } as const;
          const [setupDeliveries, statusDeliveries] = await Promise.all([
            prisma.searchEmailDelivery.findMany({
              where: {
                teeSearchId: search.id,
                alertGeneration: search.alertGeneration,
                isOwnerRecipient: true,
                kind: "SETUP"
              },
              orderBy: { createdAt: "desc" },
              take: 10,
              select: deliverySelect
            }),
            prisma.searchEmailDelivery.findMany({
              where: {
                teeSearchId: search.id,
                alertGeneration: search.alertGeneration,
                isOwnerRecipient: true,
                status: "SENT",
                OR: [
                  {
                    kind: {
                      in: [
                        "MONITORING_STATUS_UPDATE",
                        "MONITORING_OUTAGE",
                        "MONITORING_RECOVERY"
                      ]
                    }
                  },
                  {
                    kind: "MATCH",
                    payload: {
                      path: ["satisfiesStatusReport"],
                      equals: true
                    }
                  }
                ]
              },
              orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
              take: MAX_STATUS_DELIVERIES_PER_SEARCH,
              select: deliverySelect
            })
          ]);
          return {
            ...search,
            emailDeliveries: [...setupDeliveries, ...statusDeliveries]
          };
        })
    );
    searchesWithCurrentDeliveries.push(...batch);
  }

  console.log(
    JSON.stringify(
      buildAlertFinalitySummary(
        searchesWithCurrentDeliveries as unknown as AlertFinalitySearch[],
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
