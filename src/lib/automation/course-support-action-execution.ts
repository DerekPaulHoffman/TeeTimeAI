import type { CourseSupportClaimAction } from "./course-support-action-plan";

export const COURSE_SUPPORT_ACTION_EXECUTION_SCHEMA_VERSION = 1;

export const COURSE_SUPPORT_ACTION_EXECUTION_STATES = [
  "EXECUTED",
  "NOT_EXECUTED",
  "UNAVAILABLE",
] as const;

export const COURSE_SUPPORT_ACTION_EXECUTION_REASONS = [
  "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
  "CURRENT_RUNTIME_PROOF_RECORDED",
  "CURRENT_CLASSIFICATION_PROOF_RECORDED",
  "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS",
  "SUPERSEDED_BY_MATERIAL_CHANGE",
  "SUPERSEDED_BY_AUTHORITATIVE_TERMINAL_RESULT",
  "IMPLEMENTATION_PROOF_MISSING",
  "CURRENT_RUNTIME_PROOF_MISSING",
  "CURRENT_CLASSIFICATION_PROOF_MISSING",
  "EXACT_ACTION_MARKER_UNAVAILABLE",
] as const;

export type CourseSupportActionExecutionState =
  (typeof COURSE_SUPPORT_ACTION_EXECUTION_STATES)[number];

export type CourseSupportActionExecutionReason =
  (typeof COURSE_SUPPORT_ACTION_EXECUTION_REASONS)[number];

export type CourseSupportActionExecution = {
  schemaVersion: typeof COURSE_SUPPORT_ACTION_EXECUTION_SCHEMA_VERSION;
  action: CourseSupportClaimAction;
  state: CourseSupportActionExecutionState;
  reason: CourseSupportActionExecutionReason;
};

export function buildCourseSupportActionExecution(input: {
  action: CourseSupportClaimAction;
  strictImplementationProofRecorded: boolean;
  authoritativeSuccessSuperseded: boolean;
  materialChangeSuperseded: boolean;
  authoritativeTerminalResultSuperseded: boolean;
  currentRuntimeProofRecorded: boolean;
  currentClassificationProofRecorded: boolean;
}): CourseSupportActionExecution {
  switch (input.action) {
    case "IMPLEMENT_REUSABLE_SUPPORT":
      if (input.strictImplementationProofRecorded) {
        return actionExecution(
          input.action,
          "EXECUTED",
          "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
        );
      }
      if (input.authoritativeSuccessSuperseded) {
        return actionExecution(
          input.action,
          "NOT_EXECUTED",
          "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS",
        );
      }
      if (input.materialChangeSuperseded) {
        return actionExecution(
          input.action,
          "NOT_EXECUTED",
          "SUPERSEDED_BY_MATERIAL_CHANGE",
        );
      }
      if (input.authoritativeTerminalResultSuperseded) {
        return actionExecution(
          input.action,
          "NOT_EXECUTED",
          "SUPERSEDED_BY_AUTHORITATIVE_TERMINAL_RESULT",
        );
      }
      return actionExecution(
        input.action,
        "NOT_EXECUTED",
        "IMPLEMENTATION_PROOF_MISSING",
      );
    case "VERIFY_CURRENT_RUNTIME":
      return input.currentRuntimeProofRecorded
        ? actionExecution(
            input.action,
            "EXECUTED",
            "CURRENT_RUNTIME_PROOF_RECORDED",
          )
        : actionExecution(
            input.action,
            "NOT_EXECUTED",
            "CURRENT_RUNTIME_PROOF_MISSING",
          );
    case "COMPLETE_CLASSIFICATION":
      return input.currentClassificationProofRecorded
        ? actionExecution(
            input.action,
            "EXECUTED",
            "CURRENT_CLASSIFICATION_PROOF_RECORDED",
          )
        : actionExecution(
            input.action,
            "NOT_EXECUTED",
            "CURRENT_CLASSIFICATION_PROOF_MISSING",
          );
    case "SEARCH_FOR_OFFICIAL_SOURCE":
    case "INSPECT_PROVIDER_CONTRACT":
    case "WAIT_FOR_MATERIAL_CHANGE":
      return actionExecution(
        input.action,
        "UNAVAILABLE",
        "EXACT_ACTION_MARKER_UNAVAILABLE",
      );
  }
}

export function parseCourseSupportActionExecution(
  value: unknown,
): CourseSupportActionExecution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const execution = value as Record<string, unknown>;
  if (
    Object.keys(execution).length !== 4 ||
    execution.schemaVersion !== COURSE_SUPPORT_ACTION_EXECUTION_SCHEMA_VERSION ||
    typeof execution.action !== "string" ||
    typeof execution.state !== "string" ||
    typeof execution.reason !== "string"
  ) {
    return null;
  }
  const action = execution.action as CourseSupportClaimAction;
  const state = execution.state as CourseSupportActionExecutionState;
  const reason = execution.reason as CourseSupportActionExecutionReason;
  if (
    !isCourseSupportActionExecutionState(state) ||
    !isCourseSupportActionExecutionReason(reason) ||
    !isValidCourseSupportActionExecutionCombination({ action, state, reason })
  ) {
    return null;
  }
  return {
    schemaVersion: COURSE_SUPPORT_ACTION_EXECUTION_SCHEMA_VERSION,
    action,
    state,
    reason,
  };
}

function actionExecution(
  action: CourseSupportClaimAction,
  state: CourseSupportActionExecutionState,
  reason: CourseSupportActionExecutionReason,
): CourseSupportActionExecution {
  return {
    schemaVersion: COURSE_SUPPORT_ACTION_EXECUTION_SCHEMA_VERSION,
    action,
    state,
    reason,
  };
}

function isValidCourseSupportActionExecutionCombination(
  execution: Pick<CourseSupportActionExecution, "action" | "state" | "reason">,
) {
  switch (execution.reason) {
    case "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF":
      return (
        execution.action === "IMPLEMENT_REUSABLE_SUPPORT" &&
        execution.state === "EXECUTED"
      );
    case "CURRENT_RUNTIME_PROOF_RECORDED":
      return (
        execution.action === "VERIFY_CURRENT_RUNTIME" &&
        execution.state === "EXECUTED"
      );
    case "CURRENT_CLASSIFICATION_PROOF_RECORDED":
      return (
        execution.action === "COMPLETE_CLASSIFICATION" &&
        execution.state === "EXECUTED"
      );
    case "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS":
    case "SUPERSEDED_BY_MATERIAL_CHANGE":
    case "SUPERSEDED_BY_AUTHORITATIVE_TERMINAL_RESULT":
    case "IMPLEMENTATION_PROOF_MISSING":
      return (
        execution.action === "IMPLEMENT_REUSABLE_SUPPORT" &&
        execution.state === "NOT_EXECUTED"
      );
    case "CURRENT_RUNTIME_PROOF_MISSING":
      return (
        execution.action === "VERIFY_CURRENT_RUNTIME" &&
        execution.state === "NOT_EXECUTED"
      );
    case "CURRENT_CLASSIFICATION_PROOF_MISSING":
      return (
        execution.action === "COMPLETE_CLASSIFICATION" &&
        execution.state === "NOT_EXECUTED"
      );
    case "EXACT_ACTION_MARKER_UNAVAILABLE":
      return (
        execution.state === "UNAVAILABLE" &&
        [
          "SEARCH_FOR_OFFICIAL_SOURCE",
          "INSPECT_PROVIDER_CONTRACT",
          "WAIT_FOR_MATERIAL_CHANGE",
        ].includes(execution.action)
      );
  }
}

function isCourseSupportActionExecutionState(
  value: string,
): value is CourseSupportActionExecutionState {
  return COURSE_SUPPORT_ACTION_EXECUTION_STATES.includes(
    value as CourseSupportActionExecutionState,
  );
}

function isCourseSupportActionExecutionReason(
  value: string,
): value is CourseSupportActionExecutionReason {
  return COURSE_SUPPORT_ACTION_EXECUTION_REASONS.includes(
    value as CourseSupportActionExecutionReason,
  );
}
