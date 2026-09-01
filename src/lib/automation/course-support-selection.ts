import type {
  CourseHumanReviewReason,
  CourseSupportFailureClass,
  CourseSupportIncidentKind,
} from "@prisma/client";

import {
  COURSE_SUPPORT_SYNTHETIC_AGING_MS,
  COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  clampCourseSupportBatchSize,
} from "./course-support-responder-policy";
import type { AutomationPlaybookStage } from "./course-monitoring-playbook";
import type {
  CourseSupportRemediationDirective,
  CourseSupportRemediationRoute,
} from "./course-support-remediation-routing";
import type { CourseSupportClaimActionPlan } from "./course-support-action-plan";
import type { DeferredFailureHandoffSignal } from "./course-support-deferred-failure-handoff";
import type { CourseSupportProviderContractEvidenceMarker } from "./course-support-provider-contract-evidence";

const NEAR_DATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CourseSupportCandidate = {
  id: string;
  courseId: string;
  cycle: number;
  kind: CourseSupportIncidentKind;
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  failureFingerprint: string;
  humanReviewReason: CourseHumanReviewReason | null;
  engineeringOnly: boolean;
  activeRealSearchCount: number;
  earliestTargetDate: Date | null;
  escalationDeadlineAt: Date | null;
  escalatedAt?: Date | null;
  endpointHumanReviewProven: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  attemptCount: number;
  updatedAt: Date;
  remediationDirective?: CourseSupportRemediationDirective;
  remediationRoute?: CourseSupportRemediationRoute;
  actionPlan?: CourseSupportClaimActionPlan;
  providerContractEvidence?: CourseSupportProviderContractEvidenceMarker;
  providerSnapshotFingerprint?: string;
  remediationCourseRef?: string;
  deferredFailureHandoff?: {
    signal: DeferredFailureHandoffSignal;
    sourceBatchIncidentId: string;
    sourceBatchId: string;
    expectedIncidentRevision: number;
    expectedMonitoringRevision: number;
    expectedMonitoringStateChangedAt: Date;
  };
  campaign?: {
    runId: string;
    membershipDigest: string;
    priorCycle: number;
    priorRevision: number;
    priorMonitoringRevision: number;
    capturedRevision: number;
    capturedMonitoringRevision: number;
    capturedCycle: number;
    capturedKind: string;
    capturedProviderFamilyKey: string;
    campaignCapturedAt: string;
    admissionMode:
      | "FRESH_CYCLE"
      | "ZERO_EXECUTION_RECOVERY"
      | "INCOMPLETE_PLAYBOOK_RECOVERY"
      | "FAILURE_REFINEMENT_INCOMPLETE_PLAYBOOK_RECOVERY"
      | "EXACT_RUNTIME_SOURCE_CYCLE_RECOVERY"
      | "POST_MARKER_INCOMPLETE_PLAYBOOK_RECOVERY"
      | "DESCENDANT_INCOMPLETE_PLAYBOOK_RECOVERY"
      | "PARKED_COHORT_REQUESTLESS_STALE_OWNERSHIP_RECOVERY"
      | "SAME_IDENTITY_MATERIAL_CHANGE_INCOMPLETE_PLAYBOOK_RECOVERY"
      | "CURRENT_CYCLE_ORCHESTRATION_RECOVERY";
    zeroExecutionHistoryDigest: string | null;
    sameCycleRecoveryHistoryDigest: string | null;
    playbookNextStage: AutomationPlaybookStage | null;
    playbookCompletedStageCount: number;
    expectedMonitoringFailureFingerprint: string | null;
    expectedKind: CourseSupportIncidentKind;
    expectedFailureClass: CourseSupportFailureClass;
    expectedProviderSnapshotFingerprint: string;
    expectedAttemptLedgerFingerprint: string;
    expectedPlaybookConclusion: string;
    expectedLatestProbeAt: string | null;
    expectedLatestDiscoveryAt: string | null;
    expectedLatestProbeId?: string | null;
    expectedLatestDiscoveryId?: string | null;
  };
};

export type RecentBatchFairnessEvidence = {
  includedEngineeringOnly: boolean;
  includedCriticalRealDemand: boolean;
  campaignSummaryState: CourseSupportCampaignSummaryState;
};

export type CourseSupportCampaignSummaryState =
  "CAMPAIGN" | "NON_CAMPAIGN" | "UNKNOWN";

export type CourseSupportAdmissionLane =
  | {
      lane: "PRIORITY";
      parkedCampaignReservation: false;
    }
  | {
      lane: "REQUESTLESS_PARKED_CAMPAIGN";
      parkedCampaignReservation: boolean;
    };

export type SelectedCourseSupportBatch = {
  providerFamilyKey: string;
  failureFingerprint: string;
  incidents: CourseSupportCandidate[];
  fairnessReason:
    | "PRIORITY"
    | "AGED_SYNTHETIC_RESERVATION"
    | "PARKED_CAMPAIGN_RESERVATION"
    | "TARGETED_RETRY";
  containsCriticalRealDemand: boolean;
  remediationDirective?: CourseSupportRemediationDirective;
};

export type CourseSupportGroupPriority = {
  pendingInitialEndpointCount: number;
  earliestPendingInitialEndpointDeadlineAt: Date | null;
  activeRealDemandCount: number;
  earliestEscalationDeadlineAt: Date | null;
};

export function classifyCourseSupportCampaignSummary(
  value: unknown,
): CourseSupportCampaignSummaryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "UNKNOWN";
  }
  const summary = value as Record<string, unknown>;
  if (summary.schemaVersion !== 1) {
    return "UNKNOWN";
  }
  if (!Object.prototype.hasOwnProperty.call(summary, "campaign")) {
    return "NON_CAMPAIGN";
  }
  const campaign = summary.campaign;
  if (!campaign || typeof campaign !== "object" || Array.isArray(campaign)) {
    return "UNKNOWN";
  }
  const campaignRecord = campaign as Record<string, unknown>;
  if (
    Object.keys(campaignRecord).length !== 2 ||
    campaignRecord.kind !== "PARKED_COHORT" ||
    !Array.isArray(campaignRecord.attempts) ||
    campaignRecord.attempts.length === 0 ||
    !campaignRecord.attempts.every((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
      }
      const attempt = value as Record<string, unknown>;
      return (
        Object.keys(attempt).length === 4 &&
        typeof attempt.courseRef === "string" &&
        /^[a-f0-9]{24}$/u.test(attempt.courseRef) &&
        typeof attempt.runId === "string" &&
        attempt.runId.trim().length > 0 &&
        typeof attempt.membershipDigest === "string" &&
        /^[a-f0-9]{64}$/u.test(attempt.membershipDigest) &&
        typeof attempt.cycle === "number" &&
        Number.isInteger(attempt.cycle) &&
        attempt.cycle > 0
      );
    })
  ) {
    return "UNKNOWN";
  }
  return "CAMPAIGN";
}

export function selectCourseSupportAdmissionLane(input: {
  priorityCandidateAvailable: boolean;
  requestlessParkedCampaignAvailable: boolean;
  hasCurrentActiveRealDemand: boolean;
  activeBatchCampaignSummaryStates?: readonly CourseSupportCampaignSummaryState[];
  recentBatches?: RecentBatchFairnessEvidence[];
}): CourseSupportAdmissionLane | null {
  const recentFairnessWindow = (input.recentBatches ?? []).slice(
    0,
    COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  );
  const parkedCampaignReservationDue = Boolean(
    input.priorityCandidateAvailable &&
    input.requestlessParkedCampaignAvailable &&
    !input.hasCurrentActiveRealDemand &&
    (input.activeBatchCampaignSummaryStates ?? []).every(
      (state) => state === "NON_CAMPAIGN",
    ) &&
    recentFairnessWindow.length >= COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW &&
    recentFairnessWindow.every(
      (batch) =>
        !batch.includedCriticalRealDemand &&
        batch.campaignSummaryState === "NON_CAMPAIGN",
    ),
  );

  if (parkedCampaignReservationDue) {
    return {
      lane: "REQUESTLESS_PARKED_CAMPAIGN",
      parkedCampaignReservation: true,
    };
  }
  if (input.priorityCandidateAvailable) {
    return { lane: "PRIORITY", parkedCampaignReservation: false };
  }
  if (input.requestlessParkedCampaignAvailable) {
    return {
      lane: "REQUESTLESS_PARKED_CAMPAIGN",
      parkedCampaignReservation: false,
    };
  }
  return null;
}

export function selectCourseSupportBatch(input: {
  candidates: CourseSupportCandidate[];
  recentBatches?: RecentBatchFairnessEvidence[];
  maxCourses?: number;
  now?: Date;
}): SelectedCourseSupportBatch | null {
  const now = input.now ?? new Date();
  const maxCourses = clampCourseSupportBatchSize(input.maxCourses);
  const groups = new Map<string, CourseSupportCandidate[]>();

  for (const candidate of input.candidates) {
    const key = courseSupportCandidateGroupKey(candidate);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const rankedGroups = [...groups.values()]
    .map((incidents) =>
      incidents.sort((left, right) =>
        compareCourseSupportCandidates(left, right, now),
      ),
    )
    .sort((left, right) => compareCourseSupportGroups(left, right, now));
  if (rankedGroups.length === 0) {
    return null;
  }

  const criticalGroups = rankedGroups.filter((group) =>
    group.some((candidate) => isCriticalRealDemand(candidate, now)),
  );
  const pendingInitialEndpointGroups = rankedGroups.filter(
    (group) => candidateGroupPriority(group).pendingInitialEndpointCount > 0,
  );
  const recentFairnessWindow = (input.recentBatches ?? []).slice(
    0,
    COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW,
  );
  const syntheticReservationDue =
    criticalGroups.length === 0 &&
    recentFairnessWindow.length >= COURSE_SUPPORT_SYNTHETIC_FAIRNESS_WINDOW &&
    recentFairnessWindow.every(
      (batch) =>
        !batch.includedEngineeringOnly && !batch.includedCriticalRealDemand,
    );
  const agedSyntheticGroup = rankedGroups
    .filter((group) =>
      group.some(
        (candidate) =>
          candidate.engineeringOnly &&
          now.getTime() - candidate.firstSeenAt.getTime() >=
            COURSE_SUPPORT_SYNTHETIC_AGING_MS,
      ),
    )
    .sort((left, right) => oldestSeenAt(left) - oldestSeenAt(right))[0];

  const selectedGroup =
    pendingInitialEndpointGroups[0] ??
    criticalGroups[0] ??
    (syntheticReservationDue ? agedSyntheticGroup : undefined) ??
    rankedGroups[0];
  const fairnessReason =
    selectedGroup === agedSyntheticGroup && syntheticReservationDue
      ? "AGED_SYNTHETIC_RESERVATION"
      : "PRIORITY";
  const containsCriticalRealDemand = selectedGroup.some((candidate) =>
    isCriticalRealDemand(candidate, now),
  );
  const selectedIncidents = containsCriticalRealDemand
    ? selectedGroup.slice(0, maxCourses)
    : reserveAgedSyntheticSlots(selectedGroup, maxCourses, now);

  return {
    providerFamilyKey: selectedGroup[0].providerFamilyKey,
    failureFingerprint: selectedGroup[0].failureFingerprint,
    incidents: selectedIncidents,
    fairnessReason,
    containsCriticalRealDemand,
    ...(selectedGroup[0].remediationDirective
      ? { remediationDirective: selectedGroup[0].remediationDirective }
      : {}),
  };
}

function courseSupportCandidateGroupKey(candidate: CourseSupportCandidate) {
  const directive = candidate.remediationDirective;
  const actionPlan = candidate.actionPlan;
  return [
    candidate.providerFamilyKey,
    candidate.failureFingerprint,
    directive?.workMode ?? "LEGACY",
    directive?.strategyAction ?? "LEGACY",
    directive?.playbookStage ?? "NONE",
    actionPlan ? JSON.stringify(actionPlan) : "LEGACY_ACTION_PLAN",
  ].join("\u0000");
}

export function compareCourseSupportCandidates(
  left: CourseSupportCandidate,
  right: CourseSupportCandidate,
  now: Date,
) {
  const groupPriority = compareCourseSupportGroupPriority(
    candidateGroupPriority([left]),
    candidateGroupPriority([right]),
  );
  if (groupPriority !== 0) {
    return groupPriority;
  }
  const priority = candidatePriority(left, now) - candidatePriority(right, now);
  if (priority !== 0) {
    return priority;
  }
  const target =
    (left.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER) -
    (right.earliestTargetDate?.getTime() ?? Number.MAX_SAFE_INTEGER);
  if (target !== 0) {
    return target;
  }
  const attempts = left.attemptCount - right.attemptCount;
  if (attempts !== 0) {
    return attempts;
  }
  return left.firstSeenAt.getTime() - right.firstSeenAt.getTime();
}

export function isCriticalRealDemand(
  candidate: CourseSupportCandidate,
  now: Date,
) {
  return Boolean(
    candidate.activeRealSearchCount > 0 &&
    candidate.kind === "FETCH_FAILED" &&
    candidate.earliestTargetDate &&
    candidate.earliestTargetDate.getTime() <=
      now.getTime() + NEAR_DATE_WINDOW_MS,
  );
}

function reserveAgedSyntheticSlots(
  incidents: CourseSupportCandidate[],
  maxCourses: number,
  now: Date,
) {
  const real = incidents.filter((candidate) => !candidate.engineeringOnly);
  const agedSynthetic = incidents.filter(
    (candidate) =>
      candidate.engineeringOnly &&
      now.getTime() - candidate.firstSeenAt.getTime() >=
        COURSE_SUPPORT_SYNTHETIC_AGING_MS,
  );
  if (real.length === 0 || agedSynthetic.length === 0 || maxCourses < 4) {
    return incidents.slice(0, maxCourses);
  }
  const reservedSyntheticSlots = Math.max(1, Math.floor(maxCourses / 4));
  const selected = [
    ...real.slice(0, maxCourses - reservedSyntheticSlots),
    ...agedSynthetic.slice(0, reservedSyntheticSlots),
  ];
  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  for (const candidate of incidents) {
    if (selected.length >= maxCourses) {
      break;
    }
    if (!selectedIds.has(candidate.id)) {
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  return selected.sort((left, right) =>
    compareCourseSupportCandidates(left, right, now),
  );
}

function compareCourseSupportGroups(
  left: CourseSupportCandidate[],
  right: CourseSupportCandidate[],
  now: Date,
) {
  const groupPriority = compareCourseSupportGroupPriority(
    candidateGroupPriority(left),
    candidateGroupPriority(right),
  );
  if (groupPriority !== 0) {
    return groupPriority;
  }
  const leadComparison = compareCourseSupportCandidates(left[0], right[0], now);
  if (leadComparison !== 0) {
    return leadComparison;
  }
  const leftDemand = left.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0,
  );
  const rightDemand = right.reduce(
    (sum, candidate) => sum + candidate.activeRealSearchCount,
    0,
  );
  return rightDemand - leftDemand || oldestSeenAt(left) - oldestSeenAt(right);
}

export function compareCourseSupportGroupPriority(
  left: CourseSupportGroupPriority,
  right: CourseSupportGroupPriority,
) {
  const leftHasPendingInitialEndpoint = left.pendingInitialEndpointCount > 0;
  const rightHasPendingInitialEndpoint = right.pendingInitialEndpointCount > 0;
  if (leftHasPendingInitialEndpoint !== rightHasPendingInitialEndpoint) {
    return leftHasPendingInitialEndpoint ? -1 : 1;
  }
  if (leftHasPendingInitialEndpoint) {
    const pendingDeadlineOrder =
      (left.earliestPendingInitialEndpointDeadlineAt?.getTime() ??
        Number.MAX_SAFE_INTEGER) -
      (right.earliestPendingInitialEndpointDeadlineAt?.getTime() ??
        Number.MAX_SAFE_INTEGER);
    if (pendingDeadlineOrder !== 0) {
      return pendingDeadlineOrder;
    }
    const pendingCountOrder =
      right.pendingInitialEndpointCount - left.pendingInitialEndpointCount;
    if (pendingCountOrder !== 0) {
      return pendingCountOrder;
    }
  }
  const leftHasRealDemand = left.activeRealDemandCount > 0;
  const rightHasRealDemand = right.activeRealDemandCount > 0;
  if (leftHasRealDemand !== rightHasRealDemand) {
    return leftHasRealDemand ? -1 : 1;
  }
  if (leftHasRealDemand) {
    const deadlineOrder =
      (left.earliestEscalationDeadlineAt?.getTime() ??
        Number.MAX_SAFE_INTEGER) -
      (right.earliestEscalationDeadlineAt?.getTime() ??
        Number.MAX_SAFE_INTEGER);
    if (deadlineOrder !== 0) {
      return deadlineOrder;
    }
    const demandOrder =
      right.activeRealDemandCount - left.activeRealDemandCount;
    if (demandOrder !== 0) {
      return demandOrder;
    }
  }
  return 0;
}

function candidateGroupPriority(
  candidates: readonly CourseSupportCandidate[],
): CourseSupportGroupPriority {
  const activeRealCandidates = candidates.filter(
    (candidate) => candidate.activeRealSearchCount > 0,
  );
  const pendingInitialEndpointCandidates = activeRealCandidates.filter(
    (candidate) => !candidate.endpointHumanReviewProven,
  );
  const pendingInitialEndpointDeadlines =
    pendingInitialEndpointCandidates.flatMap((candidate) =>
      candidate.escalationDeadlineAt
        ? [candidate.escalationDeadlineAt.getTime()]
        : [],
    );
  const deadlines = activeRealCandidates.flatMap((candidate) =>
    candidate.escalationDeadlineAt
      ? [candidate.escalationDeadlineAt.getTime()]
      : [],
  );
  return {
    pendingInitialEndpointCount: pendingInitialEndpointCandidates.length,
    earliestPendingInitialEndpointDeadlineAt:
      pendingInitialEndpointDeadlines.length > 0
        ? new Date(Math.min(...pendingInitialEndpointDeadlines))
        : null,
    activeRealDemandCount: activeRealCandidates.reduce(
      (sum, candidate) => sum + candidate.activeRealSearchCount,
      0,
    ),
    earliestEscalationDeadlineAt:
      deadlines.length > 0 ? new Date(Math.min(...deadlines)) : null,
  };
}

function candidatePriority(candidate: CourseSupportCandidate, now: Date) {
  if (isCriticalRealDemand(candidate, now)) {
    return 0;
  }
  if (
    candidate.activeRealSearchCount > 0 &&
    candidate.kind === "FETCH_FAILED"
  ) {
    return 1;
  }
  if (candidate.activeRealSearchCount > 0) {
    return 2;
  }
  if (!candidate.engineeringOnly) {
    return 3;
  }
  return 4;
}

function oldestSeenAt(candidates: CourseSupportCandidate[]) {
  return Math.min(
    ...candidates.map((candidate) => candidate.firstSeenAt.getTime()),
  );
}
