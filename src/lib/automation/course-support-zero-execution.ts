import { createHash } from "node:crypto";

import type {
  CourseSupportFailureClass,
  CourseSupportVerificationStatus,
  ProbeOutcome,
} from "@prisma/client";

import { stableCourseProviderExecutionEvidenceValue } from "./course-provider-execution-evidence";

export type CourseSupportZeroExecutionRequestEvidence = {
  id: string;
  releaseSha: string;
  status: CourseSupportVerificationStatus;
  revision: number;
  attemptCount: number;
  workflowRunId: string | null;
  startedAt: Date | null;
  outcome: ProbeOutcome | null;
  failureClass: CourseSupportFailureClass | null;
  evidence: unknown;
  lastError?: string | null;
};

export type CourseSupportZeroExecutionBatchEvidence = {
  id: string;
  cycle: number;
  result: string;
  batch: {
    baseSha: string;
    releaseSha: string | null;
    completedAt: Date | null;
    summary: unknown;
  };
  verificationRequests: CourseSupportZeroExecutionRequestEvidence[];
};

export type CourseSupportZeroExecutionHistory = {
  historyDigest: string;
  batchCount: number;
  requestCount: number;
  requestFences: Array<{
    id: string;
    batchIncidentId: string;
    releaseSha: string;
    status: CourseSupportVerificationStatus;
    revision: number;
    attemptCount: number;
    outcome: ProbeOutcome | null;
    failureClass: CourseSupportFailureClass | null;
    lastError: string | null;
  }>;
  absentRequestFences: Array<{
    batchIncidentId: string;
    releaseSha: string;
  }>;
};

export type CourseSupportCompletedAttemptEntry = {
  cycle: number;
  batch: { summary: unknown };
};

export type CourseSupportReleaseExecutionEvidence = {
  changedReleaseDeploymentEver: boolean;
  providerExecutionEverForCourse: boolean;
  providerExecutionAttemptEverForCourse: boolean;
  terminalExecutionEverForCourse: boolean;
};

export type CourseSupportExecutionEverInput = {
  summary: unknown;
  baseSha: string;
  courseRef?: string;
  legacyOrdinal?: number;
};

export type CourseSupportExecutionEverUpdateInput = {
  summary: unknown;
  baseSha: string;
  previousReleaseSha: string;
  previousDeployedAt: Date | null;
  previousIncidentVerifications: Array<{
    ordinal: number;
    courseRef: string;
    providerExecutionRecorded: boolean;
    providerExecutionAttemptRecorded: boolean;
    terminalExecutionRecorded: boolean;
  }>;
};

const COURSE_SUPPORT_ORCHESTRATION_RETRY_BASE_MS = 15 * 60 * 1000;
const COURSE_SUPPORT_ORCHESTRATION_RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const COURSE_SUPPORT_EXECUTION_EVER_SCHEMA_VERSION = 2;
const COURSE_SUPPORT_EXECUTION_REF_PATTERN = /^[a-f0-9]{24}$/u;

export function readCourseSupportReleaseExecutionEvidence(
  input: CourseSupportExecutionEverInput,
): CourseSupportReleaseExecutionEvidence {
  const summary = asRecord(input.summary);
  const executionEver = asRecord(summary.executionEver);
  const providerExecutionCourseRefs = readCourseRefs(
    executionEver.providerExecutionCourseRefs,
  );
  const providerExecutionAttemptCourseRefs = readCourseRefs(
    executionEver.providerExecutionAttemptCourseRefs,
  );
  const terminalExecutionCourseRefs = readCourseRefs(
    executionEver.terminalExecutionCourseRefs,
  );
  let changedReleaseDeploymentEver =
    executionEver.changedReleaseDeploymentRecorded === true;
  let providerExecutionEverForCourse = input.courseRef
    ? providerExecutionCourseRefs.has(input.courseRef)
    : providerExecutionCourseRefs.size > 0;
  let providerExecutionAttemptEverForCourse = input.courseRef
    ? providerExecutionCourseRefs.has(input.courseRef) ||
      providerExecutionAttemptCourseRefs.has(input.courseRef)
    : providerExecutionCourseRefs.size > 0 ||
      providerExecutionAttemptCourseRefs.size > 0;
  let terminalExecutionEverForCourse = input.courseRef
    ? terminalExecutionCourseRefs.has(input.courseRef)
    : terminalExecutionCourseRefs.size > 0;

  const releaseHistory = Array.isArray(summary.releaseHistory)
    ? summary.releaseHistory.slice(-20)
    : [];
  for (const rawRelease of releaseHistory) {
    const release = asRecord(rawRelease);
    const releaseSha =
      typeof release.releaseSha === "string" ? release.releaseSha : null;
    if (!releaseSha) continue;
    const releaseDispatchStartedAt =
      typeof release.recheckDispatchStartedAt === "string" &&
      isValidEvidenceDate(release.recheckDispatchStartedAt)
        ? new Date(release.recheckDispatchStartedAt)
        : null;
    if (
      releaseSha !== input.baseSha &&
      typeof release.deployedAt === "string" &&
      isValidEvidenceDate(release.deployedAt)
    ) {
      changedReleaseDeploymentEver = true;
    }
    const verifications = Array.isArray(release.incidentVerifications)
      ? release.incidentVerifications.slice(0, 20)
      : [];
    for (const rawVerification of verifications) {
      const verification = asRecord(rawVerification);
      const matchesCourse = input.courseRef
        ? verification.courseRef === input.courseRef ||
          (verification.courseRef === undefined &&
            input.legacyOrdinal !== undefined &&
            verification.ordinal === input.legacyOrdinal)
        : true;
      if (!matchesCourse) continue;
      const proof = asRecord(verification.proofSnapshot);
      const proofRuntime =
        typeof proof.releaseSha === "string"
          ? proof.releaseSha
          : typeof proof.runtimeVersion === "string"
            ? proof.runtimeVersion
            : null;
      const proofObservedAt =
        typeof proof.observedAt === "string" &&
        isValidEvidenceDate(proof.observedAt)
          ? new Date(proof.observedAt)
          : null;
      if (
        proof.providerExecution === true &&
        proofObservedAt &&
        (proofRuntime === releaseSha ||
          (releaseDispatchStartedAt &&
            proofObservedAt.getTime() >= releaseDispatchStartedAt.getTime()))
      ) {
        providerExecutionAttemptEverForCourse = true;
      }
      if (
        proof.providerExecution === true &&
        proofRuntime === releaseSha &&
        proofObservedAt
      ) {
        providerExecutionEverForCourse = true;
      }
      if (
        (verification.result === "RESTORED" ||
          verification.result === "FINAL_DISPOSITION") &&
        typeof verification.verifiedAt === "string" &&
        isValidEvidenceDate(verification.verifiedAt) &&
        typeof proof.kind === "string"
      ) {
        terminalExecutionEverForCourse = true;
      }
    }
  }

  return {
    changedReleaseDeploymentEver,
    providerExecutionEverForCourse,
    providerExecutionAttemptEverForCourse,
    terminalExecutionEverForCourse,
  };
}

export function buildCourseSupportExecutionEverSummary(
  input: CourseSupportExecutionEverUpdateInput,
) {
  const summary = asRecord(input.summary);
  const executionEver = asRecord(summary.executionEver);
  const providerExecutionCourseRefs = readCourseRefs(
    executionEver.providerExecutionCourseRefs,
  );
  const providerExecutionAttemptCourseRefs = readCourseRefs(
    executionEver.providerExecutionAttemptCourseRefs,
  );
  for (const courseRef of providerExecutionCourseRefs) {
    providerExecutionAttemptCourseRefs.add(courseRef);
  }
  const terminalExecutionCourseRefs = readCourseRefs(
    executionEver.terminalExecutionCourseRefs,
  );
  let changedReleaseDeploymentRecorded =
    readCourseSupportReleaseExecutionEvidence({
      summary: input.summary,
      baseSha: input.baseSha,
    }).changedReleaseDeploymentEver;

  for (const verification of input.previousIncidentVerifications.slice(0, 20)) {
    const retained = readCourseSupportReleaseExecutionEvidence({
      summary: input.summary,
      baseSha: input.baseSha,
      courseRef: verification.courseRef,
      legacyOrdinal: verification.ordinal,
    });
    if (
      retained.providerExecutionEverForCourse ||
      verification.providerExecutionRecorded
    ) {
      providerExecutionCourseRefs.add(verification.courseRef);
    }
    if (
      retained.providerExecutionAttemptEverForCourse ||
      verification.providerExecutionRecorded ||
      verification.providerExecutionAttemptRecorded
    ) {
      providerExecutionAttemptCourseRefs.add(verification.courseRef);
    }
    if (
      retained.terminalExecutionEverForCourse ||
      verification.terminalExecutionRecorded
    ) {
      terminalExecutionCourseRefs.add(verification.courseRef);
    }
  }
  if (
    input.previousReleaseSha !== input.baseSha &&
    input.previousDeployedAt !== null
  ) {
    changedReleaseDeploymentRecorded = true;
  }

  return {
    schemaVersion: COURSE_SUPPORT_EXECUTION_EVER_SCHEMA_VERSION,
    changedReleaseDeploymentRecorded,
    providerExecutionCourseRefs: [...providerExecutionCourseRefs]
      .sort()
      .slice(0, 20),
    providerExecutionAttemptCourseRefs: [...providerExecutionAttemptCourseRefs]
      .sort()
      .slice(0, 20),
    terminalExecutionCourseRefs: [...terminalExecutionCourseRefs]
      .sort()
      .slice(0, 20),
  };
}

export function isCourseSupportCompletedBatchOrchestrationOnly(input: {
  courseId: string;
  summary: unknown;
  allowValidatedLegacy?: boolean;
}) {
  const summary = asRecord(input.summary);
  const closeout = asRecord(summary.closeout);
  const courseRef = createHash("sha256")
    .update(input.courseId)
    .digest("hex")
    .slice(0, 24);
  if (
    closeout.orchestrationOnly === true ||
    (Array.isArray(closeout.orchestrationOnlyCourseRefs) &&
      closeout.orchestrationOnlyCourseRefs.includes(courseRef))
  ) {
    return true;
  }
  const attempts = Array.isArray(closeout.remediationAttempts)
    ? closeout.remediationAttempts
    : [];
  const attempt = asRecord(
    attempts.find((candidate) => asRecord(candidate).courseRef === courseRef),
  );
  if (attempt.consumed !== false) return false;
  if (
    attempt.countsTowardOperationalNoProgress !== false &&
    !(
      input.allowValidatedLegacy &&
      attempt.countsTowardOperationalNoProgress === undefined
    )
  ) {
    return false;
  }
  const execution = asRecord(attempt.executionEvidence);
  return ![
    "deploymentRecorded",
    "postProbeRecorded",
    "providerAttemptRecorded",
    "providerExecutionAttemptRecorded",
    "playbookAttemptRecorded",
    "terminalResultRecorded",
    "providerExecutionStarted",
  ].some((key) => execution[key] === true);
}

export function areCourseSupportCompletedAttemptsOrchestrationOnly(input: {
  courseId: string;
  cycle: number;
  entries: readonly CourseSupportCompletedAttemptEntry[];
  allowEmpty?: boolean;
  allowValidatedLegacy?: boolean;
}) {
  const entries = input.entries.filter((entry) => entry.cycle === input.cycle);
  return (
    (entries.length > 0 || input.allowEmpty === true) &&
    entries.every((entry) =>
      isCourseSupportCompletedBatchOrchestrationOnly({
        courseId: input.courseId,
        summary: entry.batch.summary,
        allowValidatedLegacy: input.allowValidatedLegacy,
      }),
    )
  );
}

export function countCourseSupportCompletedOrchestrationOnlyAttempts(input: {
  courseId: string;
  cycle: number;
  entries: readonly CourseSupportCompletedAttemptEntry[];
  allowValidatedLegacy?: boolean;
}) {
  return input.entries.filter(
    (entry) =>
      entry.cycle === input.cycle &&
      isCourseSupportCompletedBatchOrchestrationOnly({
        courseId: input.courseId,
        summary: entry.batch.summary,
        allowValidatedLegacy: input.allowValidatedLegacy,
      }),
  ).length;
}

export function getCourseSupportOrchestrationRetrySchedule(input: {
  now: Date;
  priorAttemptCount: number;
}) {
  const priorAttemptCount = Math.max(0, Math.floor(input.priorAttemptCount));
  const delayMs = Math.min(
    COURSE_SUPPORT_ORCHESTRATION_RETRY_MAX_MS,
    COURSE_SUPPORT_ORCHESTRATION_RETRY_BASE_MS *
      2 ** Math.min(priorAttemptCount, 10),
  );
  return {
    attemptNumber: priorAttemptCount + 1,
    delayMs,
    retryAt: new Date(input.now.getTime() + delayMs),
  };
}

export function assessCourseSupportZeroExecutionHistory(input: {
  courseId: string;
  cycle: number;
  campaignRunId: string;
  campaignMembershipDigest: string;
  currentRuntimeVersion: string;
  entries: readonly CourseSupportZeroExecutionBatchEvidence[];
}): CourseSupportZeroExecutionHistory | null {
  const courseRef = createHash("sha256")
    .update(input.courseId)
    .digest("hex")
    .slice(0, 24);
  const entries = input.entries.filter((entry) => entry.cycle === input.cycle);
  if (entries.length === 0) return null;

  let campaignProvenanceFound = false;
  let operationalRetryEvidenceFound = false;
  let requestCount = 0;
  const canonicalEntries: Array<Record<string, unknown>> = [];
  const requestFences: CourseSupportZeroExecutionHistory["requestFences"] = [];
  const absentRequestFences: CourseSupportZeroExecutionHistory["absentRequestFences"] =
    [];

  for (const entry of entries) {
    const runtimeVersion = entry.batch.releaseSha ?? entry.batch.baseSha;
    const summary = asRecord(entry.batch.summary);
    const closeout = asRecord(summary.closeout);
    const remediationAttempts = Array.isArray(closeout.remediationAttempts)
      ? closeout.remediationAttempts
      : [];
    const attempt = asRecord(
      remediationAttempts.find(
        (candidate) => asRecord(candidate).courseRef === courseRef,
      ),
    );
    const execution = asRecord(attempt.executionEvidence);
    const operationalRetry = asRecord(attempt.operationalRetry);
    const campaign = asRecord(summary.campaign);
    const campaignAttempts = Array.isArray(campaign.attempts)
      ? campaign.attempts
      : [];
    if (
      campaignAttempts.some((candidate) => {
        const value = asRecord(candidate);
        return (
          value.courseRef === courseRef &&
          value.runId === input.campaignRunId &&
          value.membershipDigest === input.campaignMembershipDigest &&
          value.cycle === input.cycle
        );
      })
    ) {
      campaignProvenanceFound = true;
    }
    if (
      (operationalRetry.reason === "OPERATIONAL_RETRY_AVAILABLE" ||
        operationalRetry.reason === "OPERATIONAL_RETRY_BUDGET_EXHAUSTED") &&
      Number.isInteger(operationalRetry.attemptsCompleted)
    ) {
      operationalRetryEvidenceFound = true;
    }
    if (
      !entry.batch.completedAt ||
      !["RETRY_SCHEDULED", "NEEDS_HUMAN", "STALE_EVIDENCE"].includes(
        entry.result,
      ) ||
      !runtimeVersion ||
      runtimeVersion === input.currentRuntimeVersion ||
      attempt.consumed !== false ||
      attempt.runtimeVersion !== runtimeVersion ||
      attempt.countsTowardOperationalNoProgress === true ||
      execution.deploymentRecorded === true ||
      execution.providerAttemptRecorded === true ||
      execution.providerExecutionAttemptRecorded === true ||
      execution.playbookAttemptRecorded === true ||
      execution.terminalResultRecorded === true ||
      execution.providerExecutionStarted === true
    ) {
      return null;
    }

    const requests = [...entry.verificationRequests].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (requests.length === 0) {
      absentRequestFences.push({
        batchIncidentId: entry.id,
        releaseSha: runtimeVersion,
      });
    }
    for (const request of requests) {
      if (
        request.releaseSha !== runtimeVersion ||
        !isCourseSupportVerificationRequestUnstarted(request)
      ) {
        return null;
      }
      requestFences.push({
        id: request.id,
        batchIncidentId: entry.id,
        releaseSha: request.releaseSha,
        status: request.status,
        revision: request.revision,
        attemptCount: request.attemptCount,
        outcome: request.outcome,
        failureClass: request.failureClass,
        lastError: request.lastError ?? null,
      });
    }
    requestCount += requests.length;
    canonicalEntries.push({
      batchIncidentId: entry.id,
      cycle: entry.cycle,
      result: entry.result,
      runtimeVersion,
      completedAt: entry.batch.completedAt.toISOString(),
      requests: requests.map((request) => ({
        id: request.id,
        releaseSha: request.releaseSha,
        status: request.status,
        revision: request.revision,
        attemptCount: request.attemptCount,
        workflowAttached: request.workflowRunId !== null,
        started: false,
        startFailure: request.outcome === "FETCH_FAILED",
      })),
    });
  }

  if (
    !campaignProvenanceFound ||
    !operationalRetryEvidenceFound ||
    requestCount === 0
  ) {
    return null;
  }
  canonicalEntries.sort((left, right) =>
    String(left.batchIncidentId).localeCompare(String(right.batchIncidentId)),
  );
  requestFences.sort((left, right) => left.id.localeCompare(right.id));
  absentRequestFences.sort((left, right) =>
    left.batchIncidentId.localeCompare(right.batchIncidentId),
  );
  return {
    historyDigest: createHash("sha256")
      .update(stableCourseProviderExecutionEvidenceValue(canonicalEntries))
      .digest("hex"),
    batchCount: entries.length,
    requestCount,
    requestFences,
    absentRequestFences,
  };
}

export function isCourseSupportVerificationRequestUnstarted(input: {
  startedAt: Date | null;
  outcome: ProbeOutcome | null;
  failureClass: CourseSupportFailureClass | null;
  evidence: unknown;
  lastError?: string | null;
}) {
  if (input.startedAt !== null) return false;
  if (
    input.outcome === null &&
    input.failureClass === null &&
    isEmptyEvidence(input.evidence)
  ) {
    return true;
  }
  const evidence = asRecord(input.evidence);
  return (
    input.outcome === "FETCH_FAILED" &&
    input.failureClass === "UNKNOWN" &&
    evidence.providerExecution === false &&
    input.lastError === "Workflow start failed before verification execution."
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isEmptyEvidence(value: unknown) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

function readCourseRefs(value: unknown) {
  return new Set(
    Array.isArray(value)
      ? value
          .filter(
            (candidate): candidate is string =>
              typeof candidate === "string" &&
              COURSE_SUPPORT_EXECUTION_REF_PATTERN.test(candidate),
          )
          .slice(0, 20)
      : [],
  );
}

function isValidEvidenceDate(value: string) {
  return Number.isFinite(new Date(value).getTime());
}
