import { createHash } from "node:crypto";

import {
  COURSE_SUPPORT_CLAIM_ACTIONS,
  type CourseSupportClaimAction,
} from "./course-support-action-plan";
import { readCourseSupportRemediationClaimAttempt } from "./course-support-batches";
import { isCourseSupportCompletedBatchOrchestrationOnly } from "./course-support-zero-execution";

export const COURSE_SUPPORT_ACTION_TELEMETRY_SCHEMA_VERSION = 1;
export const COURSE_SUPPORT_ACTION_TELEMETRY_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1_000;
const EXECUTION_EVIDENCE_KEYS = [
  "claimedImplementationPaths",
  "newReleaseRecorded",
  "deploymentRecorded",
  "postProbeRecorded",
  "providerAttemptRecorded",
  "providerExecutionAttemptRecorded",
  "playbookAttemptRecorded",
  "terminalResultRecorded",
  "providerExecutionStarted",
] as const;

type ExecutionEvidence = Record<
  (typeof EXECUTION_EVIDENCE_KEYS)[number],
  boolean
>;

export type CompletedCourseSupportActionTelemetryBatch = {
  completedAt: Date | null;
  summary: unknown;
  incidents: ReadonlyArray<{ courseId: string }>;
};

type MutableActionMetric = {
  selectedCount: number;
  confirmedExecutedCount: number;
  executionUnavailableCount: number;
  zeroExecutionCount: number;
  nonzeroExecutionCount: number;
  zeroExecutionUnavailableCount: number;
};

export type CourseSupportActionMetric = MutableActionMetric & {
  executedCount: number | null;
  executionAvailability: "available" | "partial" | "unavailable";
  zeroExecutionTotal: number | null;
};

export type CourseSupportActionTelemetry = {
  schemaVersion: typeof COURSE_SUPPORT_ACTION_TELEMETRY_SCHEMA_VERSION;
  windowDays: typeof COURSE_SUPPORT_ACTION_TELEMETRY_WINDOW_DAYS;
  windowStartedAt: string;
  windowEndedAt: string;
  completedBatchCount: number;
  completedEntryCount: number;
  selectedActionCount: number;
  selectedActionUnavailableCount: number;
  confirmedExecutedActionCount: number;
  executedActionCount: number | null;
  executionUnavailableCount: number;
  zeroExecutionCount: number;
  nonzeroExecutionCount: number;
  zeroExecutionTotal: number | null;
  zeroExecutionUnavailableCount: number;
  actions: Record<CourseSupportClaimAction, CourseSupportActionMetric>;
};

export function getCourseSupportActionTelemetryWindowStartedAt(now: Date) {
  return new Date(
    now.getTime() - COURSE_SUPPORT_ACTION_TELEMETRY_WINDOW_DAYS * DAY_MS,
  );
}

export function aggregateCourseSupportActionTelemetry(input: {
  now: Date;
  batches: readonly CompletedCourseSupportActionTelemetryBatch[];
}): CourseSupportActionTelemetry {
  const windowStartedAt = getCourseSupportActionTelemetryWindowStartedAt(
    input.now,
  );
  const batches = input.batches.filter(
    (batch) =>
      batch.completedAt !== null &&
      batch.completedAt >= windowStartedAt &&
      batch.completedAt <= input.now,
  );
  const mutableMetrics = Object.fromEntries(
    COURSE_SUPPORT_CLAIM_ACTIONS.map((action) => [
      action,
      emptyMutableMetric(),
    ]),
  ) as Record<CourseSupportClaimAction, MutableActionMetric>;

  let completedEntryCount = 0;
  let selectedActionCount = 0;
  let selectedActionUnavailableCount = 0;
  let confirmedExecutedActionCount = 0;
  let executionUnavailableCount = 0;
  let zeroExecutionCount = 0;
  let nonzeroExecutionCount = 0;
  let zeroExecutionUnavailableCount = 0;

  for (const batch of batches) {
    for (const incident of batch.incidents) {
      completedEntryCount += 1;
      const courseRef = courseSupportTelemetryCourseRef(incident.courseId);
      const selectedAction = readSelectedAction({
        summary: batch.summary,
        courseId: incident.courseId,
        expectedAttemptCount: batch.incidents.length,
      });
      const closeout = readExactCloseoutAttempt(batch.summary, courseRef);
      const zeroExecution = classifyZeroExecution({
        courseId: incident.courseId,
        summary: batch.summary,
        closeout,
      });

      if (zeroExecution === true) {
        zeroExecutionCount += 1;
      } else if (zeroExecution === false) {
        nonzeroExecutionCount += 1;
      } else {
        zeroExecutionUnavailableCount += 1;
      }

      if (!selectedAction) {
        selectedActionUnavailableCount += 1;
        executionUnavailableCount += 1;
        continue;
      }

      selectedActionCount += 1;
      const metric = mutableMetrics[selectedAction];
      metric.selectedCount += 1;
      if (zeroExecution === true) {
        metric.zeroExecutionCount += 1;
      } else if (zeroExecution === false) {
        metric.nonzeroExecutionCount += 1;
      } else {
        metric.zeroExecutionUnavailableCount += 1;
      }

      const actionExecution = classifySelectedActionExecution({
        action: selectedAction,
        closeout,
        zeroExecution,
      });
      if (actionExecution === true) {
        confirmedExecutedActionCount += 1;
        metric.confirmedExecutedCount += 1;
      } else if (actionExecution === null) {
        executionUnavailableCount += 1;
        metric.executionUnavailableCount += 1;
      }
    }
  }

  const actions = Object.fromEntries(
    COURSE_SUPPORT_CLAIM_ACTIONS.map((action) => {
      const metric = mutableMetrics[action];
      return [action, finalizeMetric(metric)];
    }),
  ) as Record<CourseSupportClaimAction, CourseSupportActionMetric>;

  return {
    schemaVersion: COURSE_SUPPORT_ACTION_TELEMETRY_SCHEMA_VERSION,
    windowDays: COURSE_SUPPORT_ACTION_TELEMETRY_WINDOW_DAYS,
    windowStartedAt: windowStartedAt.toISOString(),
    windowEndedAt: input.now.toISOString(),
    completedBatchCount: batches.length,
    completedEntryCount,
    selectedActionCount,
    selectedActionUnavailableCount,
    confirmedExecutedActionCount,
    executedActionCount:
      executionUnavailableCount === 0 ? confirmedExecutedActionCount : null,
    executionUnavailableCount,
    zeroExecutionCount,
    nonzeroExecutionCount,
    zeroExecutionTotal:
      zeroExecutionUnavailableCount === 0 ? zeroExecutionCount : null,
    zeroExecutionUnavailableCount,
    actions,
  };
}

function readSelectedAction(input: {
  summary: unknown;
  courseId: string;
  expectedAttemptCount: number;
}): CourseSupportClaimAction | null {
  const claimedAttempt = readCourseSupportRemediationClaimAttempt(input);
  const selectedAction = claimedAttempt?.actionPlan?.primaryAction;
  if (!claimedAttempt || !selectedAction) return null;
  return selectedActionMatchesClaimWorkMode({
    action: selectedAction,
    workMode: claimedAttempt.approach.workMode,
  })
    ? selectedAction
    : null;
}

function selectedActionMatchesClaimWorkMode(input: {
  action: CourseSupportClaimAction;
  workMode:
    | "VERIFY_TRANSIENT"
    | "ADVANCE_DISCOVERY"
    | "IMPLEMENT_REUSABLE_SUPPORT"
    | "COMPLETE_CLASSIFICATION";
}) {
  switch (input.workMode) {
    case "VERIFY_TRANSIENT":
      return input.action === "VERIFY_CURRENT_RUNTIME";
    case "ADVANCE_DISCOVERY":
      return (
        input.action === "VERIFY_CURRENT_RUNTIME" ||
        input.action === "SEARCH_FOR_OFFICIAL_SOURCE" ||
        input.action === "INSPECT_PROVIDER_CONTRACT"
      );
    case "IMPLEMENT_REUSABLE_SUPPORT":
      return input.action === "IMPLEMENT_REUSABLE_SUPPORT";
    case "COMPLETE_CLASSIFICATION":
      return input.action === "COMPLETE_CLASSIFICATION";
  }
}

type ExactCloseoutAttempt = {
  value: Record<string, unknown>;
  executionEvidence: ExecutionEvidence;
};

function readExactCloseoutAttempt(
  summaryValue: unknown,
  courseRef: string,
): ExactCloseoutAttempt | null {
  const summary = asRecord(summaryValue);
  const closeout = asRecord(summary.closeout);
  const attempts = Array.isArray(closeout.remediationAttempts)
    ? closeout.remediationAttempts
    : [];
  const matchingAttempts = attempts.filter(
    (attempt) => asRecord(attempt).courseRef === courseRef,
  );
  if (matchingAttempts.length !== 1) return null;
  const attempt = asRecord(matchingAttempts[0]);
  if (
    typeof attempt.consumed !== "boolean" ||
    typeof attempt.countsTowardOperationalNoProgress !== "boolean"
  ) {
    return null;
  }
  const executionEvidence = asRecord(attempt.executionEvidence);
  const evidenceKeys = Object.keys(executionEvidence);
  if (
    evidenceKeys.length !== EXECUTION_EVIDENCE_KEYS.length ||
    !EXECUTION_EVIDENCE_KEYS.every(
      (key) => typeof executionEvidence[key] === "boolean",
    )
  ) {
    return null;
  }
  return {
    value: attempt,
    executionEvidence: executionEvidence as ExecutionEvidence,
  };
}

function classifyZeroExecution(input: {
  courseId: string;
  summary: unknown;
  closeout: ExactCloseoutAttempt | null;
}): boolean | null {
  if (!input.closeout) return null;
  const { executionEvidence } = input.closeout;
  if (
    input.closeout.value.consumed === true ||
    input.closeout.value.countsTowardOperationalNoProgress === true ||
    EXECUTION_EVIDENCE_KEYS.some(
      (key) =>
        key !== "claimedImplementationPaths" &&
        key !== "newReleaseRecorded" &&
        key !== "providerExecutionStarted" &&
        executionEvidence[key] === true,
    )
  ) {
    return false;
  }
  if (
    isCourseSupportCompletedBatchOrchestrationOnly({
      courseId: input.courseId,
      summary: input.summary,
    })
  ) {
    return true;
  }
  return null;
}

function classifySelectedActionExecution(input: {
  action: CourseSupportClaimAction;
  closeout: ExactCloseoutAttempt | null;
  zeroExecution: boolean | null;
}): boolean | null {
  if (!input.closeout) return null;
  const evidence = input.closeout.executionEvidence;
  switch (input.action) {
    case "VERIFY_CURRENT_RUNTIME":
      if (
        evidence.postProbeRecorded ||
        evidence.providerAttemptRecorded ||
        evidence.providerExecutionAttemptRecorded ||
        evidence.terminalResultRecorded
      ) {
        return true;
      }
      return input.zeroExecution === true ? false : null;
    case "SEARCH_FOR_OFFICIAL_SOURCE":
      // The exact action is recorded as an OWNED_EXACT_SOURCE_SEARCH
      // CourseMonitoringEvent. Batch closeout exposes only a generic playbook
      // bit, which can be set by a different later stage and is not set for
      // every valid source-search result. Until that exact event is supplied
      // to this aggregate, execution must remain unavailable rather than be
      // inferred from unrelated batch evidence.
      return null;
    case "IMPLEMENT_REUSABLE_SUPPORT":
      if (evidence.newReleaseRecorded && evidence.deploymentRecorded) {
        return true;
      }
      return input.zeroExecution === true ? false : null;
    case "COMPLETE_CLASSIFICATION":
      if (evidence.terminalResultRecorded) return true;
      return input.zeroExecution === true ? false : null;
    case "INSPECT_PROVIDER_CONTRACT":
    case "WAIT_FOR_MATERIAL_CHANGE":
      // Completed-batch history has no action-specific marker for either
      // diagnostic inspection or waiting. Generic playbook/provider evidence
      // must not be relabeled as execution of the selected action.
      return null;
  }
}

function finalizeMetric(
  metric: MutableActionMetric,
): CourseSupportActionMetric {
  const executionAvailability =
    metric.executionUnavailableCount === 0
      ? "available"
      : metric.executionUnavailableCount === metric.selectedCount
        ? "unavailable"
        : "partial";
  return {
    ...metric,
    executedCount:
      metric.executionUnavailableCount === 0
        ? metric.confirmedExecutedCount
        : null,
    executionAvailability,
    zeroExecutionTotal:
      metric.zeroExecutionUnavailableCount === 0
        ? metric.zeroExecutionCount
        : null,
  };
}

function emptyMutableMetric(): MutableActionMetric {
  return {
    selectedCount: 0,
    confirmedExecutedCount: 0,
    executionUnavailableCount: 0,
    zeroExecutionCount: 0,
    nonzeroExecutionCount: 0,
    zeroExecutionUnavailableCount: 0,
  };
}

function courseSupportTelemetryCourseRef(courseId: string) {
  return createHash("sha256").update(courseId).digest("hex").slice(0, 24);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
