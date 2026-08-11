import { createHash } from "node:crypto";

import type {
  CourseMonitoringEventSource,
  CourseSupportIncidentStatus
} from "@prisma/client";

import { recordCourseMonitoringPlaybookTransition } from "./course-monitoring";
import {
  assessAutomationPlaybook,
  type AutomationPlaybookAssessment,
  type AutomationPlaybookEventInput,
  type AutomationPlaybookLedger,
  type AutomationPlaybookStage,
  type AutomationPlaybookTransition
} from "./course-monitoring-playbook";
import { getCourseMonitoringPlaybookContext } from "./db-service";

export const SEARCH_PLAYBOOK_RUNTIME_VERSION = "search-workflow-v1";

export const SEARCH_PLAYBOOK_FINGERPRINTS = {
  OFFICIAL_IDENTITY_CURRENT: "OFFICIAL_IDENTITY:CURRENT",
  OFFICIAL_IDENTITY_MISSING: "OFFICIAL_IDENTITY:MISSING_SOURCE",
  OFFICIAL_IDENTITY_MANUAL_FINAL: "OFFICIAL_IDENTITY:MANUAL_FINAL",
  OFFICIAL_IDENTITY_IDENTITY_FINAL: "OFFICIAL_IDENTITY:IDENTITY_FINAL",
  TYPED_ADAPTER_ATTEMPT: "TYPED_ADAPTER:ATTEMPT",
  OFFICIAL_HTTP_DISCOVERY: "OFFICIAL_HTTP:DISCOVERY",
  HTTP_ADAPTER_RETRY: "HTTP_ADAPTER:RETRY",
  BROWSER_ADAPTER_RETRY: "BROWSER_ADAPTER:RETRY",
  LOCAL_READER_ATTEMPT: "LOCAL_READER:ATTEMPT",
  LOCAL_READER_CHALLENGE: "LOCAL_READER:CHALLENGE",
  LOCAL_READER_TERMINAL: "LOCAL_READER:TERMINAL",
  STAGE_NOT_APPLICABLE: "PLAYBOOK_STAGE:NOT_APPLICABLE"
} as const;

type PlaybookContext = {
  id: string;
  cycle: number;
  status: CourseSupportIncidentStatus;
  attemptLedger: unknown;
};

export type SearchPlaybookRuntime = {
  courseId: string;
  incidentId: string;
  cycle: number;
  source: CourseMonitoringEventSource;
  runtimeVersion: string;
  ledger: AutomationPlaybookLedger | null;
  assessment: AutomationPlaybookAssessment;
};

type SearchPlaybookTransitionInput = Omit<
  AutomationPlaybookEventInput,
  "cycle" | "observedAt" | "runtimeVersion"
> & {
  attemptOrdinal?: number;
  observedAt?: Date;
};

export async function loadSearchPlaybookRuntime(input: {
  courseId: string;
  incidentId?: string | null;
  runtimeVersion?: string | null;
  source?: CourseMonitoringEventSource;
  context?: PlaybookContext | null;
}): Promise<SearchPlaybookRuntime | null> {
  const context =
    input.context !== undefined
      ? input.context
      : await getCourseMonitoringPlaybookContext(input.courseId);
  if (
    !context ||
    context.status === "RESOLVED" ||
    (input.incidentId && input.incidentId !== context.id)
  ) {
    return null;
  }
  return {
    courseId: input.courseId,
    incidentId: context.id,
    cycle: context.cycle,
    source: input.source ?? "SEARCH_WORKFLOW",
    runtimeVersion: normalizeSearchPlaybookRuntimeVersion(input.runtimeVersion),
    ledger: context.attemptLedger as AutomationPlaybookLedger | null,
    assessment: assessAutomationPlaybook(context.attemptLedger, context.cycle)
  };
}

export async function recordSearchPlaybookTransition(
  runtime: SearchPlaybookRuntime,
  input: SearchPlaybookTransitionInput
) {
  const stage = runtime.assessment.stages.find(
    (candidate) => candidate.stage === input.stage
  );
  const attemptOrdinal =
    input.attemptOrdinal ??
    Math.max(
      1,
      stage?.attemptCount ?? 0,
      input.transition === "STARTED" ? (stage?.attemptCount ?? 0) + 1 : 0
    );
  const recorded = await recordCourseMonitoringPlaybookTransition({
    courseId: runtime.courseId,
    incidentId: runtime.incidentId,
    source: runtime.source,
    idempotencyKey: buildSearchPlaybookIdempotencyKey({
      incidentId: runtime.incidentId,
      cycle: runtime.cycle,
      stage: input.stage,
      transition: input.transition,
      attemptOrdinal
    }),
    stage: input.stage,
    transition: input.transition,
    readPath: input.readPath,
    evidenceKind: input.evidenceKind,
    failureFingerprint: input.failureFingerprint,
    runtimeVersion: runtime.runtimeVersion,
    failureClass: input.failureClass,
    skipReason: input.skipReason,
    factualDisposition: input.factualDisposition,
    technicalReason: input.technicalReason,
    note: input.note,
    now: input.observedAt
  });
  if (!recorded) {
    return runtime;
  }
  runtime.ledger = recorded.ledger as AutomationPlaybookLedger;
  runtime.assessment = recorded.assessment;
  return runtime;
}

export async function recordSearchPlaybookAttempt(
  runtime: SearchPlaybookRuntime,
  input: Omit<SearchPlaybookTransitionInput, "transition" | "attemptOrdinal"> & {
    transition: Exclude<AutomationPlaybookTransition, "STARTED">;
  }
) {
  if (runtime.assessment.nextStage !== input.stage) {
    throw new Error(
      `The search playbook expected ${runtime.assessment.nextStage ?? "no stage"}, not ${input.stage}.`
    );
  }
  const stage = runtime.assessment.stages.find(
    (candidate) => candidate.stage === input.stage
  );
  const attemptOrdinal = (stage?.attemptCount ?? 0) + 1;
  await recordSearchPlaybookTransition(runtime, {
    stage: input.stage,
    transition: "STARTED",
    readPath: input.readPath,
    evidenceKind: input.evidenceKind,
    failureFingerprint: input.failureFingerprint,
    note: input.note,
    attemptOrdinal
  });
  return recordSearchPlaybookTransition(runtime, {
    ...input,
    attemptOrdinal
  });
}

export async function recordSearchPlaybookAttemptResult(
  runtime: SearchPlaybookRuntime,
  input: Omit<SearchPlaybookTransitionInput, "attemptOrdinal"> & {
    transition: Exclude<AutomationPlaybookTransition, "STARTED">;
  }
) {
  if (runtime.assessment.nextStage !== input.stage) {
    throw new Error(
      `The search playbook expected ${runtime.assessment.nextStage ?? "no stage"}, not ${input.stage}.`
    );
  }
  const stage = runtime.assessment.stages.find(
    (candidate) => candidate.stage === input.stage
  );
  if (stage?.status === "STARTED" && stage.attemptCount > 0) {
    return recordSearchPlaybookTransition(runtime, {
      ...input,
      attemptOrdinal: stage.attemptCount
    });
  }
  return recordSearchPlaybookAttempt(runtime, input);
}

export async function skipSearchPlaybookStage(
  runtime: SearchPlaybookRuntime,
  input: Omit<
    SearchPlaybookTransitionInput,
    "transition" | "attemptOrdinal" | "failureClass"
  > & {
    stage: AutomationPlaybookStage;
    skipReason: NonNullable<SearchPlaybookTransitionInput["skipReason"]>;
  }
) {
  if (runtime.assessment.nextStage !== input.stage) {
    return runtime;
  }
  return recordSearchPlaybookTransition(runtime, {
    ...input,
    transition: "NOT_APPLICABLE"
  });
}

export async function ensureSearchPlaybookOfficialIdentity(
  runtime: SearchPlaybookRuntime
) {
  if (runtime.assessment.nextStage !== "OFFICIAL_IDENTITY") {
    return runtime;
  }
  return recordSearchPlaybookAttempt(runtime, {
    stage: "OFFICIAL_IDENTITY",
    transition: "COMPLETED",
    readPath: "OFFICIAL_IDENTITY",
    evidenceKind: "OFFICIAL_SOURCE",
    failureFingerprint: SEARCH_PLAYBOOK_FINGERPRINTS.OFFICIAL_IDENTITY_CURRENT,
    note: "Current official course identity and booking destination were checked."
  });
}

export function normalizeSearchPlaybookRuntimeVersion(value?: string | null) {
  const normalized = value
    ?.trim()
    .replace(/[^A-Za-z0-9:._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
  return normalized || SEARCH_PLAYBOOK_RUNTIME_VERSION;
}

export function buildSearchPlaybookIdempotencyKey(input: {
  incidentId: string;
  cycle: number;
  stage: AutomationPlaybookStage;
  transition: AutomationPlaybookTransition;
  attemptOrdinal: number;
}) {
  const digest = createHash("sha256")
    .update(
      [
        input.incidentId,
        input.cycle,
        input.stage,
        input.transition,
        input.attemptOrdinal
      ].join(":")
    )
    .digest("hex")
    .slice(0, 40);
  return `search-playbook-${digest}`;
}
