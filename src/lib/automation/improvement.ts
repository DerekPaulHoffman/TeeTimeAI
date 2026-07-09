type PendingAlertInput = {
  id: string;
  courseName: string;
  firstSeenAt: string;
};

type ActionableProbeInput = {
  id: string;
  outcome:
    | "BLOCKED_POLICY"
    | "BLOCKED_AUTH"
    | "BLOCKED_TOOLING"
    | "FETCH_FAILED"
    | "NEEDS_ADAPTER";
  courseName: string;
  platform: string;
  observedAt: string;
  message?: string | null;
};

export type ImprovementCandidateInput = {
  activeSearchCount: number;
  pendingAlerts: PendingAlertInput[];
  actionableProbes: ActionableProbeInput[];
};

export type ImprovementCandidate = {
  outcome:
    | "success"
    | "no_op"
    | "needs_adapter"
    | "blocked_policy"
    | "blocked_auth"
    | "blocked_tooling"
    | "blocked_env"
    | "needs_human";
  kind:
    | "pending_alert"
    | "adapter_gap"
    | "policy_blocker"
    | "auth_blocker"
    | "tooling_blocker"
    | "fetch_failure"
    | "ui_smoke"
    | "empty_queue";
  summary: string;
  referenceId?: string;
};

export type ImprovementCheckpoints = {
  queue_confirmed: boolean;
  candidate_selected: boolean;
  tool_research_done: boolean;
  ui_smoke_done: boolean;
  verification_done: boolean;
  outcome_recorded: boolean;
};

export function selectImprovementCandidate(
  input: ImprovementCandidateInput
): ImprovementCandidate {
  if (input.pendingAlerts.length > 0) {
    const [oldestAlert] = input.pendingAlerts;
    return {
      outcome: "success",
      kind: "pending_alert",
      summary: `Drain ${input.pendingAlerts.length} pending tee-time alert before selecting new product work.`,
      referenceId: oldestAlert.id
    };
  }

  const [probe] = input.actionableProbes;
  if (probe) {
    return candidateFromProbe(probe);
  }

  if (input.activeSearchCount === 0) {
    return {
      outcome: "no_op",
      kind: "empty_queue",
      summary: "No active tee-time searches need polling or improvement work."
    };
  }

  return {
    outcome: "needs_human",
    kind: "ui_smoke",
    summary:
      "Active searches have no current adapter or alert blockers; run UI smoke and select the strongest verified UX or access issue."
  };
}

export function buildImprovementCheckpoints(input: {
  queueConfirmed: boolean;
  candidateSelected: boolean;
  toolResearchDone?: boolean;
  uiSmokeDone?: boolean;
  verificationDone?: boolean;
  outcomeRecorded?: boolean;
}): ImprovementCheckpoints {
  return {
    queue_confirmed: input.queueConfirmed,
    candidate_selected: input.candidateSelected,
    tool_research_done: input.toolResearchDone ?? false,
    ui_smoke_done: input.uiSmokeDone ?? false,
    verification_done: input.verificationDone ?? false,
    outcome_recorded: input.outcomeRecorded ?? false
  };
}

function candidateFromProbe(probe: ActionableProbeInput): ImprovementCandidate {
  switch (probe.outcome) {
    case "NEEDS_ADAPTER":
      return {
        outcome: "needs_adapter",
        kind: "adapter_gap",
        summary: `${probe.courseName} needs a ${probe.platform} adapter before it can be polled.`,
        referenceId: probe.id
      };
    case "BLOCKED_POLICY":
      return {
        outcome: "blocked_policy",
        kind: "policy_blocker",
        summary: `${probe.courseName} is blocked by policy review or terms.`,
        referenceId: probe.id
      };
    case "BLOCKED_AUTH":
      return {
        outcome: "blocked_auth",
        kind: "auth_blocker",
        summary: `${probe.courseName} requires auth or human account setup before automation can proceed.`,
        referenceId: probe.id
      };
    case "BLOCKED_TOOLING":
      return {
        outcome: "blocked_tooling",
        kind: "tooling_blocker",
        summary: `${probe.courseName} is blocked by missing or failing automation tooling.`,
        referenceId: probe.id
      };
    case "FETCH_FAILED":
      return {
        outcome: "needs_human",
        kind: "fetch_failure",
        summary: `${probe.courseName} fetch failed and needs adapter or endpoint diagnosis.`,
        referenceId: probe.id
      };
  }
}
