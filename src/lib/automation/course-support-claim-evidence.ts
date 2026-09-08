import { createHash } from "node:crypto";

import { AUTOMATION_PLAYBOOK_STAGES, type AutomationPlaybookStage } from "./course-monitoring-playbook";
import {
  COURSE_SUPPORT_REMEDIATION_WORK_MODES,
  type ActionableCourseSupportRemediationWorkMode,
  type CourseSupportRemediationAttemptSignature,
} from "./course-support-remediation-routing";
import { MONITORING_STRATEGY_ACTIONS, type MonitoringStrategyAction } from "./monitoring-strategy";
import {
  courseSupportActionPlanAllows,
  courseSupportActionPlanMatchesRoute,
  parseCourseSupportClaimActionPlan,
  type CourseSupportClaimActionPlan,
} from "./course-support-action-plan";
import {
  parseCourseSupportProviderContractEvidenceMarker,
  type CourseSupportProviderContractEvidenceMarker,
} from "./course-support-provider-contract-evidence";

// Pure shared claim parsing must not import batch ownership or monitoring state.

export type CourseSupportRemediationClaimAttempt = {
  courseRef: string;
  providerSnapshotFingerprint: string;
  failureFingerprint: string;
  playbookEventCountAtClaim: number;
  approach: CourseSupportRemediationAttemptSignature;
  actionPlan: CourseSupportClaimActionPlan | null;
  providerContractEvidence: CourseSupportProviderContractEvidenceMarker | null;
  exhaustedDiscoveryImplementationHandoff: boolean;
};

export function createCourseSupportRemediationCourseRef(courseId: string) {
  return createHash("sha256").update(courseId).digest("hex").slice(0, 24);
}

export function parseCourseSupportRemediationApproach(
  value: unknown
): CourseSupportRemediationAttemptSignature | null {
  const approach = asJsonObject(value);
  const workMode = approach.workMode;
  const strategyAction = approach.strategyAction;
  const playbookStage = approach.playbookStage;
  if (
    typeof workMode !== "string" ||
    workMode === "WAIT_FOR_MATERIAL_CHANGE" ||
    !COURSE_SUPPORT_REMEDIATION_WORK_MODES.includes(
      workMode as (typeof COURSE_SUPPORT_REMEDIATION_WORK_MODES)[number]
    ) ||
    typeof strategyAction !== "string" ||
    !MONITORING_STRATEGY_ACTIONS.includes(
      strategyAction as (typeof MONITORING_STRATEGY_ACTIONS)[number]
    ) ||
    !(
      playbookStage === null ||
      (typeof playbookStage === "string" &&
        AUTOMATION_PLAYBOOK_STAGES.includes(
          playbookStage as (typeof AUTOMATION_PLAYBOOK_STAGES)[number]
        ))
    )
  ) {
    return null;
  }
  return {
    workMode: workMode as ActionableCourseSupportRemediationWorkMode,
    strategyAction: strategyAction as MonitoringStrategyAction,
    playbookStage: playbookStage as AutomationPlaybookStage | null
  };
}

export function readCourseSupportRemediationClaimAttempt(input: {
  summary: unknown;
  courseId: string;
  expectedAttemptCount: number;
}): CourseSupportRemediationClaimAttempt | null {
  const remediation = asJsonObject(asJsonObject(input.summary).remediation);
  if (
    !Array.isArray(remediation.attempts) ||
    remediation.attempts.length !== input.expectedAttemptCount ||
    input.expectedAttemptCount < 1
  ) {
    return null;
  }
  const courseRef = createCourseSupportRemediationCourseRef(input.courseId);
  const matches = remediation.attempts.filter(
    (candidate) => asJsonObject(candidate).courseRef === courseRef
  );
  const courseRefs = remediation.attempts.map(
    (candidate) => asJsonObject(candidate).courseRef
  );
  const uniqueCourseRefs = new Set(courseRefs);
  if (
    matches.length !== 1 ||
    !courseRefs.every(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^[a-f0-9]{24}$/u.test(candidate)
    ) ||
    uniqueCourseRefs.size !== remediation.attempts.length
  ) {
    return null;
  }
  const attempt = asJsonObject(matches[0]);
  const approachRecord = asJsonObject(attempt.approach);
  const approach = parseCourseSupportRemediationApproach(attempt.approach);
  const actionPlan = parseCourseSupportClaimActionPlan(attempt.actionPlan);
  const providerContractEvidence =
    attempt.providerContractEvidence === undefined ||
    attempt.providerContractEvidence === null
      ? null
      : parseCourseSupportProviderContractEvidenceMarker(
          attempt.providerContractEvidence
        );
  const exhaustedDiscoveryImplementationHandoff = Boolean(
    approach?.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      approach.playbookStage === null &&
      attempt.reason === "EXHAUSTED_DISCOVERY_IMPLEMENTATION_HANDOFF" &&
      actionPlan?.primaryAction === "IMPLEMENT_REUSABLE_SUPPORT" &&
      courseSupportActionPlanAllows(actionPlan, "INSPECT_PROVIDER_CONTRACT"),
  );
  const providerContractEvidenceAllowed = Boolean(
    approach?.workMode === "IMPLEMENT_REUSABLE_SUPPORT" &&
      (approach.playbookStage === "BROWSER_ADAPTER_RETRY" ||
        exhaustedDiscoveryImplementationHandoff),
  );
  const exactApproachKeys = ["workMode", "strategyAction", "playbookStage"];
  if (
    typeof attempt.providerSnapshotFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(attempt.providerSnapshotFingerprint) ||
    typeof attempt.failureFingerprint !== "string" ||
    attempt.failureFingerprint.length < 1 ||
    attempt.failureFingerprint.length > 160 ||
    !Number.isSafeInteger(attempt.playbookEventCountAtClaim) ||
    (attempt.playbookEventCountAtClaim as number) < 0 ||
    !approach ||
    (providerContractEvidence !== null && !providerContractEvidenceAllowed) ||
    (attempt.providerContractEvidence !== undefined &&
      attempt.providerContractEvidence !== null &&
      !providerContractEvidence) ||
    (attempt.actionPlan !== undefined &&
      (!actionPlan ||
        !courseSupportActionPlanMatchesRoute({
          plan: actionPlan,
          workMode: approach.workMode,
          strategyAction: approach.strategyAction,
          playbookStage: approach.playbookStage
        }))) ||
    Object.keys(approachRecord).length !== exactApproachKeys.length ||
    !exactApproachKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(approachRecord, key)
    )
  ) {
    return null;
  }
  return {
    courseRef,
    providerSnapshotFingerprint: attempt.providerSnapshotFingerprint,
    failureFingerprint: attempt.failureFingerprint,
    playbookEventCountAtClaim: attempt.playbookEventCountAtClaim as number,
    approach,
    actionPlan,
    providerContractEvidence,
    exhaustedDiscoveryImplementationHandoff,
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
