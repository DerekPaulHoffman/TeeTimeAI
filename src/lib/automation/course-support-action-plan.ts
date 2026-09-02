import type { CourseSupportIncidentKind } from "@prisma/client";

import {
  AUTOMATION_PLAYBOOK_STAGES,
  type AutomationPlaybookStage,
} from "./course-monitoring-playbook";
import {
  COURSE_SUPPORT_REMEDIATION_WORK_MODES,
  isExactAssignedDetachedStageDirective,
  type CourseSupportRemediationRoute,
  type CourseSupportRemediationWorkMode,
} from "./course-support-remediation-routing";
import {
  MONITORING_STRATEGY_ACTIONS,
  type MonitoringStrategyAction,
} from "./monitoring-strategy";
import {
  isExactSourceMissingProviderState,
  KNOWN_PROVIDER_FAMILIES,
  normalizeProviderFamilyKey,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY,
  type ProviderCourseInput,
} from "./provider-capabilities";

export const COURSE_SUPPORT_ACTION_PLAN_SCHEMA_VERSION = 1;

export const COURSE_SUPPORT_CLAIM_ACTIONS = [
  "VERIFY_CURRENT_RUNTIME",
  "SEARCH_FOR_OFFICIAL_SOURCE",
  "INSPECT_PROVIDER_CONTRACT",
  "IMPLEMENT_REUSABLE_SUPPORT",
  "COMPLETE_CLASSIFICATION",
  "WAIT_FOR_MATERIAL_CHANGE",
] as const;

export type CourseSupportClaimAction =
  (typeof COURSE_SUPPORT_CLAIM_ACTIONS)[number];

export type CourseSupportClaimActionPlan = {
  schemaVersion: typeof COURSE_SUPPORT_ACTION_PLAN_SCHEMA_VERSION;
  primaryAction: CourseSupportClaimAction;
  allowedActions: CourseSupportClaimAction[];
  route: {
    workMode: CourseSupportRemediationWorkMode;
    strategyAction: MonitoringStrategyAction;
    playbookStage: AutomationPlaybookStage | null;
  };
};

const PROVIDER_CONTRACT_STAGES = new Set<AutomationPlaybookStage>([
  "TYPED_ADAPTER",
  "OFFICIAL_HTTP_DISCOVERY",
  "HTTP_ADAPTER_RETRY",
  "RENDERED_BROWSER_DISCOVERY",
  "BROWSER_ADAPTER_RETRY",
]);

const PROVIDER_CONTRACT_INCIDENT_KINDS = new Set<CourseSupportIncidentKind>([
  "NEEDS_ADAPTER",
  "FETCH_FAILED",
  "BLOCKED_TOOLING",
]);

const KNOWN_PROVIDER_FAMILY_SET = new Set<string>(KNOWN_PROVIDER_FAMILIES);

type CourseSupportActionPlanCourse = ProviderCourseInput & {
  monitoringMode?: string | null;
};

export function buildCourseSupportClaimActionPlan(input: {
  route: CourseSupportRemediationRoute;
  incidentKind: CourseSupportIncidentKind;
  incidentProviderFamilyKey: string;
  course: CourseSupportActionPlanCourse;
}): CourseSupportClaimActionPlan {
  const route = {
    workMode: input.route.workMode,
    strategyAction: input.route.strategy.action,
    playbookStage: input.route.attemptSignature?.playbookStage ?? null,
  };
  const exhaustedDiscoveryImplementationHandoff = Boolean(
    input.route.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      route.playbookStage === null &&
      input.route.reason === "EXHAUSTED_DISCOVERY_IMPLEMENTATION_HANDOFF" &&
      !input.route.allowUnchangedRuntime &&
      input.route.requiresImplementationPath,
  );
  const sourceSearchEligible = isCourseSupportSourceSearchActionEligible({
    workMode: route.workMode,
    playbookStage: route.playbookStage,
    incidentProviderFamilyKey: input.incidentProviderFamilyKey,
    course: input.course,
  });
  const providerContractEligible =
    isCourseSupportProviderContractActionEligible({
      workMode: route.workMode,
      playbookStage: route.playbookStage,
      allowUnchangedRuntime: input.route.allowUnchangedRuntime,
      requiresImplementationPath: input.route.requiresImplementationPath,
      incidentKind: input.incidentKind,
      incidentProviderFamilyKey: input.incidentProviderFamilyKey,
      courseProviderFamilyKey: input.course.providerFamilyKey,
      resolvedProviderFamilyKey: input.route.strategy.providerFamilyKey,
      exhaustedDiscoveryImplementationHandoff,
    });
  const assignedBrowserAdapterRetry = Boolean(
    route.workMode === "ADVANCE_DISCOVERY" &&
      isExactAssignedDetachedStageDirective({
        remediationDirective: {
          ...route,
          allowUnchangedRuntime: input.route.allowUnchangedRuntime,
          requiresImplementationPath: input.route.requiresImplementationPath,
          retryBudget: input.route.retryBudget,
        },
        stage: "BROWSER_ADAPTER_RETRY",
      }),
  );

  if (route.workMode === "WAIT_FOR_MATERIAL_CHANGE") {
    return actionPlan(route, "WAIT_FOR_MATERIAL_CHANGE");
  }
  if (route.workMode === "COMPLETE_CLASSIFICATION") {
    return actionPlan(route, "COMPLETE_CLASSIFICATION");
  }
  if (sourceSearchEligible) {
    return actionPlan(route, "SEARCH_FOR_OFFICIAL_SOURCE");
  }
  if (route.workMode === "IMPLEMENT_REUSABLE_SUPPORT") {
    return actionPlan(
      route,
      "IMPLEMENT_REUSABLE_SUPPORT",
      providerContractEligible ? ["INSPECT_PROVIDER_CONTRACT"] : [],
    );
  }
  if (assignedBrowserAdapterRetry) {
    return actionPlan(route, "VERIFY_CURRENT_RUNTIME");
  }
  if (providerContractEligible) {
    return actionPlan(route, "INSPECT_PROVIDER_CONTRACT", [
      "VERIFY_CURRENT_RUNTIME",
    ]);
  }
  return actionPlan(route, "VERIFY_CURRENT_RUNTIME");
}

export function isCourseSupportSourceSearchActionEligible(input: {
  workMode: CourseSupportRemediationWorkMode;
  playbookStage: AutomationPlaybookStage | null;
  incidentProviderFamilyKey: string;
  course: CourseSupportActionPlanCourse;
}) {
  return Boolean(
    input.workMode === "ADVANCE_DISCOVERY" &&
    input.playbookStage === "RENDERED_BROWSER_DISCOVERY" &&
    input.incidentProviderFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY &&
    input.course.monitoringMode !== "LOCAL_READER_ONLY" &&
    isExactSourceMissingProviderState(input.course),
  );
}

export function isCourseSupportProviderContractActionEligible(input: {
  workMode: CourseSupportRemediationWorkMode;
  playbookStage: AutomationPlaybookStage | null;
  allowUnchangedRuntime: boolean;
  requiresImplementationPath: boolean;
  incidentKind: CourseSupportIncidentKind;
  incidentProviderFamilyKey: string;
  courseProviderFamilyKey?: string | null;
  resolvedProviderFamilyKey: string;
  exhaustedDiscoveryImplementationHandoff?: boolean;
}) {
  const incidentProviderFamily = normalizeActionProviderFamily(
    input.incidentProviderFamilyKey,
  );
  const courseProviderFamily = normalizeActionProviderFamily(
    input.courseProviderFamilyKey,
  );
  const resolvedProviderFamily = normalizeActionProviderFamily(
    input.resolvedProviderFamilyKey,
  );
  const courseProjectionIsExplicitlySourceMissing =
    input.courseProviderFamilyKey?.trim().toUpperCase() ===
    SOURCE_MISSING_PROVIDER_FAMILY;
  const implementationContext =
    input.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
    input.requiresImplementationPath &&
    !input.allowUnchangedRuntime;
  const discoveryContext =
    input.workMode === "ADVANCE_DISCOVERY" && !input.requiresImplementationPath;
  const providerContractStageEligible = Boolean(
    (input.playbookStage && PROVIDER_CONTRACT_STAGES.has(input.playbookStage)) ||
      (implementationContext &&
        input.playbookStage === null &&
        input.exhaustedDiscoveryImplementationHandoff === true),
  );
  const resolvedProviderMatchesIncident = Boolean(
    resolvedProviderFamily === incidentProviderFamily ||
    (incidentProviderFamily === "CUSTOM" &&
      resolvedProviderFamily !== SOURCE_MISSING_PROVIDER_FAMILY &&
      resolvedProviderFamily !== SOURCE_CONFLICT_PROVIDER_FAMILY &&
      !KNOWN_PROVIDER_FAMILY_SET.has(resolvedProviderFamily)),
  );

  return Boolean(
    PROVIDER_CONTRACT_INCIDENT_KINDS.has(input.incidentKind) &&
    incidentProviderFamily !== SOURCE_MISSING_PROVIDER_FAMILY &&
    incidentProviderFamily !== SOURCE_CONFLICT_PROVIDER_FAMILY &&
    (incidentProviderFamily === courseProviderFamily ||
      courseProjectionIsExplicitlySourceMissing) &&
    resolvedProviderMatchesIncident &&
    providerContractStageEligible &&
    (implementationContext || discoveryContext),
  );
}

export function parseCourseSupportClaimActionPlan(
  value: unknown,
): CourseSupportClaimActionPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const plan = value as Record<string, unknown>;
  if (
    plan.schemaVersion !== COURSE_SUPPORT_ACTION_PLAN_SCHEMA_VERSION ||
    !isCourseSupportClaimAction(plan.primaryAction) ||
    !Array.isArray(plan.allowedActions) ||
    plan.allowedActions.length < 1 ||
    plan.allowedActions.length > COURSE_SUPPORT_CLAIM_ACTIONS.length ||
    !plan.allowedActions.every(isCourseSupportClaimAction) ||
    new Set(plan.allowedActions).size !== plan.allowedActions.length ||
    !plan.allowedActions.includes(plan.primaryAction)
  ) {
    return null;
  }
  const route = asRecord(plan.route);
  if (
    typeof route.workMode !== "string" ||
    !COURSE_SUPPORT_REMEDIATION_WORK_MODES.includes(
      route.workMode as CourseSupportRemediationWorkMode,
    ) ||
    typeof route.strategyAction !== "string" ||
    !MONITORING_STRATEGY_ACTIONS.includes(
      route.strategyAction as MonitoringStrategyAction,
    ) ||
    !(
      route.playbookStage === null ||
      (typeof route.playbookStage === "string" &&
        AUTOMATION_PLAYBOOK_STAGES.includes(
          route.playbookStage as AutomationPlaybookStage,
        ))
    )
  ) {
    return null;
  }
  return {
    schemaVersion: COURSE_SUPPORT_ACTION_PLAN_SCHEMA_VERSION,
    primaryAction: plan.primaryAction,
    allowedActions: [...plan.allowedActions],
    route: {
      workMode: route.workMode as CourseSupportRemediationWorkMode,
      strategyAction: route.strategyAction as MonitoringStrategyAction,
      playbookStage: route.playbookStage as AutomationPlaybookStage | null,
    },
  };
}

export function courseSupportActionPlanAllows(
  plan: CourseSupportClaimActionPlan | null | undefined,
  action: CourseSupportClaimAction,
) {
  return Boolean(plan?.allowedActions.includes(action));
}

export function courseSupportActionPlanMatchesRoute(input: {
  plan: CourseSupportClaimActionPlan;
  workMode: CourseSupportRemediationWorkMode;
  strategyAction: MonitoringStrategyAction;
  playbookStage: AutomationPlaybookStage | null;
}) {
  return (
    input.plan.route.workMode === input.workMode &&
    input.plan.route.strategyAction === input.strategyAction &&
    input.plan.route.playbookStage === input.playbookStage
  );
}

function actionPlan(
  route: CourseSupportClaimActionPlan["route"],
  primaryAction: CourseSupportClaimAction,
  additionalActions: CourseSupportClaimAction[] = [],
): CourseSupportClaimActionPlan {
  return {
    schemaVersion: COURSE_SUPPORT_ACTION_PLAN_SCHEMA_VERSION,
    primaryAction,
    allowedActions: [primaryAction, ...additionalActions],
    route,
  };
}

function isCourseSupportClaimAction(
  value: unknown,
): value is CourseSupportClaimAction {
  return (
    typeof value === "string" &&
    COURSE_SUPPORT_CLAIM_ACTIONS.includes(value as CourseSupportClaimAction)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeActionProviderFamily(value?: string | null) {
  const normalized = normalizeProviderFamilyKey(value);
  if (normalized !== SOURCE_MISSING_PROVIDER_FAMILY) return normalized;
  const bounded = value?.trim().toUpperCase() ?? "";
  return /^[A-Z][A-Z0-9_-]{1,63}$/u.test(bounded)
    ? bounded
    : SOURCE_MISSING_PROVIDER_FAMILY;
}
