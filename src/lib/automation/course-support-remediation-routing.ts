import type {
  AutomationPlaybookAssessment,
  AutomationPlaybookStage,
  AutomationPlaybookStageAssessment,
} from "./course-monitoring-playbook";
import {
  selectMonitoringStrategy,
  type MonitoringStrategyAction,
  type MonitoringStrategyDecision,
  type MonitoringStrategyInput,
} from "./monitoring-strategy";
import {
  SOURCE_MISSING_PROVIDER_FAMILY,
  type CourseSupportFailureClass,
} from "./provider-capabilities";

export const COURSE_SUPPORT_REMEDIATION_WORK_MODES = [
  "VERIFY_TRANSIENT",
  "ADVANCE_DISCOVERY",
  "IMPLEMENT_REUSABLE_SUPPORT",
  "COMPLETE_CLASSIFICATION",
  "WAIT_FOR_MATERIAL_CHANGE",
] as const;

export type CourseSupportRemediationWorkMode =
  (typeof COURSE_SUPPORT_REMEDIATION_WORK_MODES)[number];

export type ActionableCourseSupportRemediationWorkMode = Exclude<
  CourseSupportRemediationWorkMode,
  "WAIT_FOR_MATERIAL_CHANGE"
>;

export const DEFAULT_COURSE_SUPPORT_TRANSIENT_RETRY_BUDGET = 4;

export type CourseSupportMaterialChangeIndicators = {
  providerSnapshotChanged?: boolean;
  failureFingerprintChanged?: boolean;
  relevantRuntimeChanged?: boolean;
  readerCapabilityChanged?: boolean;
  operatorRequested?: boolean;
};

export type CourseSupportRemediationAttemptSignature = {
  workMode: ActionableCourseSupportRemediationWorkMode;
  strategyAction: MonitoringStrategyAction;
  playbookStage: AutomationPlaybookStage | null;
};

export type CourseSupportRemediationDirective = {
  workMode: CourseSupportRemediationWorkMode;
  strategyAction: MonitoringStrategyAction;
  playbookStage: AutomationPlaybookStage | null;
};

export type CourseSupportRemediationRetryBudget = {
  maximumAttempts: number;
  attemptsCompleted: number;
  attemptsRemaining: number;
  exhausted: boolean;
};

export type CourseSupportRemediationRoutingReason =
  | "EXISTING_SUPPORT_READY"
  | "TRANSIENT_RETRY_AVAILABLE"
  | "TRANSIENT_RETRY_BUDGET_EXHAUSTED"
  | "PLAYBOOK_STAGE_PENDING"
  | "PLAYBOOK_EXHAUSTED"
  | "NO_PLAYBOOK_STAGE_AVAILABLE"
  | "IMPLEMENTATION_REQUIRED"
  | "CLASSIFICATION_READY"
  | "UNCHANGED_ATTEMPT_ALREADY_RECORDED"
  | "OPERATIONAL_RETRY_BUDGET_EXHAUSTED"
  | "MATERIAL_CHANGE_REOPENED";

export type CourseSupportRemediationRoutingInput = MonitoringStrategyInput & {
  /** Number of completed attempts for the current unchanged incident signature. */
  attemptCount: number;
  playbookAssessment: Pick<
    AutomationPlaybookAssessment,
    "conclusion" | "nextStage"
  >;
  priorUnchangedAttempt?: CourseSupportRemediationAttemptSignature | null;
  materialChanges?: CourseSupportMaterialChangeIndicators;
  transientRetryBudget?: number;
};

export type CourseSupportRemediationRoute = {
  workMode: CourseSupportRemediationWorkMode;
  resumeWorkMode: ActionableCourseSupportRemediationWorkMode | null;
  allowUnchangedRuntime: boolean;
  requiresImplementationPath: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
  reason: CourseSupportRemediationRoutingReason;
  strategy: MonitoringStrategyDecision;
  materialChangeDetected: boolean;
  attemptSignature: CourseSupportRemediationAttemptSignature | null;
};

type AssignedDetachedStageDirective = {
  workMode?: unknown;
  strategyAction?: unknown;
  playbookStage?: unknown;
  allowUnchangedRuntime?: unknown;
  requiresImplementationPath?: unknown;
  retryBudget?: unknown;
};

const ASSIGNED_LOCAL_READER_STRATEGY_ACTIONS =
  new Set<MonitoringStrategyAction>([
    "DISCOVER_WITH_HTTP",
    "DISCOVER_WITH_BROWSER",
    "VERIFY_TECHNICAL_CONSTRAINT",
    "REPAIR_PROVIDER_ADAPTER",
  ]);

export function isExactAssignedDetachedStageDirective(input: {
  remediationDirective: AssignedDetachedStageDirective | null;
  stage: AutomationPlaybookStage;
}) {
  const directive = input.remediationDirective;
  if (
    !directive ||
    directive.playbookStage !== input.stage ||
    directive.allowUnchangedRuntime !== true ||
    directive.requiresImplementationPath !== false
  ) {
    return false;
  }

  if (input.stage === "BROWSER_ADAPTER_RETRY") {
    return (
      (directive.workMode === "VERIFY_TRANSIENT" &&
        directive.strategyAction === "RUN_TYPED_ADAPTER") ||
      (directive.workMode === "ADVANCE_DISCOVERY" &&
        directive.strategyAction === "REPAIR_PROVIDER_ADAPTER")
    );
  }

  return (
    input.stage === "LOCAL_READER" &&
    directive.workMode === "ADVANCE_DISCOVERY" &&
    ASSIGNED_LOCAL_READER_STRATEGY_ACTIONS.has(
      directive.strategyAction as MonitoringStrategyAction,
    )
  );
}

export function isAssignedDetachedStageProgression(input: {
  remediationDirective: AssignedDetachedStageDirective | null;
  playbookConclusion: AutomationPlaybookAssessment["conclusion"];
  nextPlaybookStage: AutomationPlaybookStage | null;
  nextPlaybookStageStatus?: AutomationPlaybookStageAssessment["status"];
  nextPlaybookStageAttemptCount?: number;
}) {
  const stage = input.nextPlaybookStage;
  if (
    !stage ||
    input.playbookConclusion !== "INCOMPLETE" ||
    !isExactAssignedDetachedStageDirective({
      remediationDirective: input.remediationDirective,
      stage,
    })
  ) {
    return false;
  }

  if (
    input.nextPlaybookStageStatus === "PENDING" &&
    input.nextPlaybookStageAttemptCount === 0
  ) {
    return hasAvailableAssignedRetryBudget(
      input.remediationDirective?.retryBudget,
      true,
    );
  }

  return Boolean(
    input.nextPlaybookStageStatus === "FAILED_RETRYABLE" &&
    Number.isInteger(input.nextPlaybookStageAttemptCount) &&
    (input.nextPlaybookStageAttemptCount as number) > 0 &&
    hasAvailableAssignedRetryBudget(
      input.remediationDirective?.retryBudget,
      false,
    ),
  );
}

function hasAvailableAssignedRetryBudget(
  value: unknown,
  allowUnbudgeted: boolean,
) {
  if (value === null || value === undefined) {
    return allowUnbudgeted;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const retryBudget = value as Record<string, unknown>;
  return Boolean(
    Number.isInteger(retryBudget.maximumAttempts) &&
    Number.isInteger(retryBudget.attemptsCompleted) &&
    Number.isInteger(retryBudget.attemptsRemaining) &&
    (retryBudget.maximumAttempts as number) > 0 &&
    (retryBudget.attemptsCompleted as number) >= 0 &&
    (retryBudget.attemptsRemaining as number) ===
      Math.max(
        0,
        (retryBudget.maximumAttempts as number) -
          (retryBudget.attemptsCompleted as number),
      ) &&
    retryBudget.exhausted === false &&
    (retryBudget.attemptsRemaining as number) > 0,
  );
}

const TRANSIENT_FAILURES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
]);

const STRUCTURAL_FAILURES = new Set<CourseSupportFailureClass>([
  "MISSING_SOURCE",
  "MISSING_METADATA",
  "UNSUPPORTED_FAMILY",
  "READER_PARSER_MISSING",
  "AUTH",
  "CHALLENGE",
  "NOT_FOUND",
  "SCHEMA",
  "UNKNOWN",
]);

const TERMINAL_PLAYBOOK_CONCLUSIONS = new Set<
  AutomationPlaybookAssessment["conclusion"]
>(["MONITORING_RESTORED", "FACTUAL_FINAL", "TECHNICAL_FINAL"]);

const CLASSIFICATION_ACTIONS = new Set<MonitoringStrategyAction>([
  "FINAL_TECHNICAL_CONSTRAINT",
  "FINAL_MANUAL_BOOKING",
  "FINAL_PRIVATE_OR_INVALID",
]);

const DISCOVERY_ACTIONS = new Set<MonitoringStrategyAction>([
  "DISCOVER_WITH_HTTP",
  "DISCOVER_WITH_BROWSER",
  "VERIFY_TECHNICAL_CONSTRAINT",
]);

const SOURCE_FREE_DISCOVERY_STAGES = new Set<AutomationPlaybookStage>([
  "OFFICIAL_IDENTITY",
  "TYPED_ADAPTER",
  "OFFICIAL_HTTP_DISCOVERY",
  "HTTP_ADAPTER_RETRY",
  "RENDERED_BROWSER_DISCOVERY",
]);

// TenFore's public tee sheet is intentionally not a server-runnable provider:
// its availability request is challenge-bound, while the allowlisted rendered
// reader already supplies the reusable safe path. Keep its current-cycle
// ordered stages moving toward that reader instead of repeatedly requesting a
// server adapter implementation that cannot safely execute.
const RENDERED_READER_PROVIDER_FAMILIES = new Set(["TENFORE"]);

export function routeCourseSupportRemediation(
  input: CourseSupportRemediationRoutingInput,
): CourseSupportRemediationRoute {
  assertNonnegativeInteger(input.attemptCount, "attemptCount");
  const maximumAttempts =
    input.transientRetryBudget ??
    DEFAULT_COURSE_SUPPORT_TRANSIENT_RETRY_BUDGET;
  assertPositiveInteger(maximumAttempts, "transientRetryBudget");

  const strategy = selectMonitoringStrategy(input);
  const materialChangeDetected = hasMaterialChange(input.materialChanges);
  const failureClass = input.failureClass ?? null;

  if (TERMINAL_PLAYBOOK_CONCLUSIONS.has(input.playbookAssessment.conclusion)) {
    return actionableRoute({
      workMode: "COMPLETE_CLASSIFICATION",
      reason: "CLASSIFICATION_READY",
      strategy,
      materialChangeDetected,
      playbookStage: input.playbookAssessment.nextStage,
      retryBudget: null,
    });
  }

  if (
    input.playbookAssessment.conclusion === "UNRESOLVED_EXHAUSTED" &&
    !materialChangeDetected
  ) {
    return waitingRoute({
      reason: "PLAYBOOK_EXHAUSTED",
      strategy,
      materialChangeDetected,
      retryBudget: null,
      resumeWorkMode: null,
    });
  }

  if (CLASSIFICATION_ACTIONS.has(strategy.action)) {
    return actionableRoute({
      workMode: "COMPLETE_CLASSIFICATION",
      reason: "CLASSIFICATION_READY",
      strategy,
      materialChangeDetected,
      playbookStage: input.playbookAssessment.nextStage,
      retryBudget: null,
    });
  }

  const retryBudget = TRANSIENT_FAILURES.has(failureClass as CourseSupportFailureClass)
    ? buildRetryBudget(
        materialChangeDetected ? 0 : input.attemptCount,
        maximumAttempts,
      )
    : null;

  let candidate = selectActionableRoute({
    strategy,
    failureClass,
    playbookAssessment: input.playbookAssessment,
    materialChangeDetected,
    retryBudget,
    sourceFreeProvider:
      strategy.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
      input.website === null &&
      input.detectedBookingUrl === null,
  });

  if (candidate.workMode === "WAIT_FOR_MATERIAL_CHANGE") {
    return candidate;
  }

  const attemptSignature: CourseSupportRemediationAttemptSignature = {
    workMode: candidate.workMode,
    strategyAction: strategy.action,
    playbookStage: input.playbookAssessment.nextStage,
  };
  const repeatsUnchangedAttempt =
    !materialChangeDetected &&
    isSameAttempt(input.priorUnchangedAttempt, attemptSignature);

  if (
    repeatsUnchangedAttempt &&
    !(strategy.action === "RETRY_PROVIDER" && retryBudget && !retryBudget.exhausted)
  ) {
    return waitingRoute({
      reason: "UNCHANGED_ATTEMPT_ALREADY_RECORDED",
      strategy,
      materialChangeDetected,
      retryBudget,
      resumeWorkMode: candidate.workMode,
      attemptSignature,
    });
  }

  if (
    materialChangeDetected &&
    (input.playbookAssessment.conclusion === "UNRESOLVED_EXHAUSTED" ||
      input.priorUnchangedAttempt)
  ) {
    candidate = {
      ...candidate,
      reason: "MATERIAL_CHANGE_REOPENED",
    };
  }

  return {
    ...candidate,
    attemptSignature,
  };
}

export function isTransientCourseSupportFailure(
  failureClass: CourseSupportFailureClass | null | undefined,
) {
  return Boolean(failureClass && TRANSIENT_FAILURES.has(failureClass));
}

export function isStructuralCourseSupportFailure(
  failureClass: CourseSupportFailureClass | null | undefined,
) {
  return Boolean(failureClass && STRUCTURAL_FAILURES.has(failureClass));
}

export function getCourseSupportRemediationDirective(
  route: CourseSupportRemediationRoute,
): CourseSupportRemediationDirective {
  return {
    workMode: route.workMode,
    strategyAction: route.strategy.action,
    playbookStage: route.attemptSignature?.playbookStage ?? null,
  };
}

function selectActionableRoute(input: {
  strategy: MonitoringStrategyDecision;
  failureClass: CourseSupportFailureClass | null;
  playbookAssessment: Pick<
    AutomationPlaybookAssessment,
    "conclusion" | "nextStage"
  >;
  materialChangeDetected: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
  sourceFreeProvider: boolean;
}): CourseSupportRemediationRoute {
  // A genuinely source-free course has no provider contract to retry or
  // implement, even when its incident retains a transient failure class from
  // an earlier observation. Keep only the pre-provider stages through rendered
  // discovery on unchanged runtime; every later or unrelated stage remains on
  // the fail-closed implementation route.
  if (input.sourceFreeProvider) {
    if (
      input.playbookAssessment.nextStage !== null &&
      SOURCE_FREE_DISCOVERY_STAGES.has(input.playbookAssessment.nextStage)
    ) {
      // The transient budget describes provider retries, not the ordered
      // source-discovery ladder. Dropping it here keeps a new safe stage
      // executable even when an older provider retry budget was exhausted.
      return discoveryRoute({ ...input, retryBudget: null });
    }
    return implementationRoute(input);
  }

  if (
    RENDERED_READER_PROVIDER_FAMILIES.has(input.strategy.providerFamilyKey) &&
    input.playbookAssessment.nextStage !== null
  ) {
    return discoveryRoute({ ...input, retryBudget: null });
  }

  if (input.strategy.action === "RETRY_PROVIDER") {
    if (!isTransientCourseSupportFailure(input.failureClass)) {
      return routeStructuralFailure(input);
    }
    if (input.retryBudget?.exhausted && !input.materialChangeDetected) {
      return waitingRoute({
        reason: "TRANSIENT_RETRY_BUDGET_EXHAUSTED",
        strategy: input.strategy,
        materialChangeDetected: input.materialChangeDetected,
        retryBudget: input.retryBudget,
        resumeWorkMode: "VERIFY_TRANSIENT",
      });
    }
    return actionableRoute({
      workMode: "VERIFY_TRANSIENT",
      reason: "TRANSIENT_RETRY_AVAILABLE",
      strategy: input.strategy,
      materialChangeDetected: input.materialChangeDetected,
      playbookStage: input.playbookAssessment.nextStage,
      retryBudget: input.retryBudget,
    });
  }

  // An incident can retain the failure class captured before reusable support
  // shipped. Prefer the registry's current runnable capability so sibling
  // courses verify that shared adapter once instead of opening another repair.
  if (
    input.strategy.action === "RUN_TYPED_ADAPTER" &&
    input.failureClass !== "READER_PARSER_MISSING"
  ) {
    return actionableRoute({
      workMode: "VERIFY_TRANSIENT",
      reason: "EXISTING_SUPPORT_READY",
      strategy: input.strategy,
      materialChangeDetected: input.materialChangeDetected,
      playbookStage: input.playbookAssessment.nextStage,
      retryBudget: input.retryBudget,
    });
  }

  if (isStructuralCourseSupportFailure(input.failureClass)) {
    return routeStructuralFailure(input);
  }

  if (
    input.playbookAssessment.nextStage === "LOCAL_READER" &&
    input.failureClass !== "READER_PARSER_MISSING"
  ) {
    return actionableRoute({
      workMode: "ADVANCE_DISCOVERY",
      reason: "PLAYBOOK_STAGE_PENDING",
      strategy: input.strategy,
      materialChangeDetected: input.materialChangeDetected,
      playbookStage: input.playbookAssessment.nextStage,
      retryBudget: input.retryBudget,
    });
  }

  if (input.strategy.action === "REPAIR_PROVIDER_ADAPTER") {
    return implementationRoute(input);
  }

  if (DISCOVERY_ACTIONS.has(input.strategy.action)) {
    return discoveryRoute(input);
  }

  return actionableRoute({
    workMode: "VERIFY_TRANSIENT",
    reason: "EXISTING_SUPPORT_READY",
    strategy: input.strategy,
    materialChangeDetected: input.materialChangeDetected,
    playbookStage: input.playbookAssessment.nextStage,
    retryBudget: input.retryBudget,
  });
}

function routeStructuralFailure(input: {
  strategy: MonitoringStrategyDecision;
  failureClass: CourseSupportFailureClass | null;
  playbookAssessment: Pick<
    AutomationPlaybookAssessment,
    "conclusion" | "nextStage"
  >;
  materialChangeDetected: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
}) {
  if (input.strategy.action === "REPAIR_PROVIDER_ADAPTER") {
    return implementationRoute(input);
  }
  if (DISCOVERY_ACTIONS.has(input.strategy.action)) {
    return discoveryRoute(input);
  }
  if (
    input.failureClass === "MISSING_METADATA" ||
    input.failureClass === "AUTH" ||
    input.failureClass === "CHALLENGE"
  ) {
    return discoveryRoute(input);
  }
  return implementationRoute(input);
}

function discoveryRoute(input: {
  strategy: MonitoringStrategyDecision;
  playbookAssessment: Pick<
    AutomationPlaybookAssessment,
    "conclusion" | "nextStage"
  >;
  materialChangeDetected: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
}) {
  if (!input.playbookAssessment.nextStage && !input.materialChangeDetected) {
    return waitingRoute({
      reason: "NO_PLAYBOOK_STAGE_AVAILABLE",
      strategy: input.strategy,
      materialChangeDetected: input.materialChangeDetected,
      retryBudget: input.retryBudget,
      resumeWorkMode: "ADVANCE_DISCOVERY",
    });
  }
  return actionableRoute({
    workMode: "ADVANCE_DISCOVERY",
    reason: "PLAYBOOK_STAGE_PENDING",
    strategy: input.strategy,
    materialChangeDetected: input.materialChangeDetected,
    playbookStage: input.playbookAssessment.nextStage,
    retryBudget: input.retryBudget,
  });
}

function implementationRoute(input: {
  strategy: MonitoringStrategyDecision;
  playbookAssessment: Pick<
    AutomationPlaybookAssessment,
    "conclusion" | "nextStage"
  >;
  materialChangeDetected: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
}) {
  return actionableRoute({
    workMode: "IMPLEMENT_REUSABLE_SUPPORT",
    reason: "IMPLEMENTATION_REQUIRED",
    strategy: input.strategy,
    materialChangeDetected: input.materialChangeDetected,
    playbookStage: input.playbookAssessment.nextStage,
    retryBudget: input.retryBudget,
  });
}

function actionableRoute(input: {
  workMode: ActionableCourseSupportRemediationWorkMode;
  reason: CourseSupportRemediationRoutingReason;
  strategy: MonitoringStrategyDecision;
  materialChangeDetected: boolean;
  playbookStage: AutomationPlaybookStage | null;
  retryBudget: CourseSupportRemediationRetryBudget | null;
}): CourseSupportRemediationRoute {
  return {
    workMode: input.workMode,
    resumeWorkMode: input.workMode,
    allowUnchangedRuntime:
      input.workMode === "VERIFY_TRANSIENT" ||
      input.workMode === "ADVANCE_DISCOVERY" ||
      input.workMode === "COMPLETE_CLASSIFICATION",
    requiresImplementationPath:
      input.workMode === "IMPLEMENT_REUSABLE_SUPPORT",
    retryBudget: input.retryBudget,
    reason: input.reason,
    strategy: input.strategy,
    materialChangeDetected: input.materialChangeDetected,
    attemptSignature: {
      workMode: input.workMode,
      strategyAction: input.strategy.action,
      playbookStage: input.playbookStage,
    },
  };
}

function waitingRoute(input: {
  reason: CourseSupportRemediationRoutingReason;
  strategy: MonitoringStrategyDecision;
  materialChangeDetected: boolean;
  retryBudget: CourseSupportRemediationRetryBudget | null;
  resumeWorkMode: ActionableCourseSupportRemediationWorkMode | null;
  attemptSignature?: CourseSupportRemediationAttemptSignature;
}): CourseSupportRemediationRoute {
  return {
    workMode: "WAIT_FOR_MATERIAL_CHANGE",
    resumeWorkMode: input.resumeWorkMode,
    allowUnchangedRuntime: false,
    requiresImplementationPath: false,
    retryBudget: input.retryBudget,
    reason: input.reason,
    strategy: input.strategy,
    materialChangeDetected: input.materialChangeDetected,
    attemptSignature: input.attemptSignature ?? null,
  };
}

function buildRetryBudget(
  attemptsCompleted: number,
  maximumAttempts: number,
): CourseSupportRemediationRetryBudget {
  return {
    maximumAttempts,
    attemptsCompleted,
    attemptsRemaining: Math.max(0, maximumAttempts - attemptsCompleted),
    exhausted: attemptsCompleted >= maximumAttempts,
  };
}

function hasMaterialChange(
  indicators: CourseSupportMaterialChangeIndicators | undefined,
) {
  return Boolean(indicators && Object.values(indicators).some(Boolean));
}

function isSameAttempt(
  prior: CourseSupportRemediationAttemptSignature | null | undefined,
  current: CourseSupportRemediationAttemptSignature,
) {
  return Boolean(
    prior &&
      prior.workMode === current.workMode &&
      prior.strategyAction === current.strategyAction &&
      prior.playbookStage === current.playbookStage,
  );
}

function assertNonnegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
}

function assertPositiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
