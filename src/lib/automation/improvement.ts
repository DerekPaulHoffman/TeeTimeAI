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

type LearningSignalInput = {
  key: string;
  kind: "adapter_gap" | "ui_smoke" | "provider_config" | "tooling" | "research";
  summary: string;
  lastSeenAt: string;
  repeats: number;
  nextAction?: string;
  status?: "open" | "learned" | "blocked" | "stale";
};

export type ImprovementCandidateInput = {
  activeSearchCount: number;
  pendingAlerts: PendingAlertInput[];
  actionableProbes: ActionableProbeInput[];
  learningSignals?: LearningSignalInput[];
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
    | "learning_followup"
    | "empty_queue";
  summary: string;
  referenceId?: string;
  researchDirective?: string;
};

export type ImprovementCheckpoints = {
  queue_confirmed: boolean;
  candidate_selected: boolean;
  tool_research_done: boolean;
  ui_smoke_done: boolean;
  verification_done: boolean;
  git_committed: boolean;
  git_pushed: boolean;
  production_verified: boolean;
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

  const probe = selectFreshProbe(input.actionableProbes, input.learningSignals ?? []);
  if (probe) {
    return candidateFromProbe(probe);
  }

  const learningFollowup = selectLearningFollowup(input.learningSignals ?? []);
  if (learningFollowup) {
    return {
      outcome: learningFollowup.status === "blocked" ? "needs_human" : "success",
      kind: "learning_followup",
      summary: learningFollowup.nextAction
        ? `${learningFollowup.summary} Next: ${learningFollowup.nextAction}`
        : learningFollowup.summary,
      referenceId: learningFollowup.key,
      researchDirective:
        "Refresh current product/tooling research before changing strategy, then record whether the follow-up learned, shipped, blocked, or went stale."
    };
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
      "Active searches have no fresh adapter or alert blockers; run UI smoke, compare current product/tooling best practices, and select the strongest verified UX or access issue.",
    researchDirective:
      "Use current external research only when it can produce a concrete, verifiable repo or provider improvement."
  };
}

export function buildImprovementCheckpoints(input: {
  queueConfirmed: boolean;
  candidateSelected: boolean;
  toolResearchDone?: boolean;
  uiSmokeDone?: boolean;
  verificationDone?: boolean;
  gitCommitted?: boolean;
  gitPushed?: boolean;
  productionVerified?: boolean;
  outcomeRecorded?: boolean;
}): ImprovementCheckpoints {
  return {
    queue_confirmed: input.queueConfirmed,
    candidate_selected: input.candidateSelected,
    tool_research_done: input.toolResearchDone ?? false,
    ui_smoke_done: input.uiSmokeDone ?? false,
    verification_done: input.verificationDone ?? false,
    git_committed: input.gitCommitted ?? false,
    git_pushed: input.gitPushed ?? false,
    production_verified: input.productionVerified ?? false,
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
        referenceId: probe.id,
        researchDirective:
          "Inspect current official booking surface and policy evidence before implementing; if unsupported after repeated inspection, record a blocked or stale learning instead of repeating the same probe."
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

function selectFreshProbe(
  probes: ActionableProbeInput[],
  learningSignals: LearningSignalInput[]
) {
  const staleAdapterKeys = new Set(
    learningSignals
      .filter(
        (signal) =>
          signal.kind === "adapter_gap" &&
          signal.repeats >= 2 &&
          (signal.status === "stale" || signal.status === "blocked" || /no reusable adapter/i.test(signal.summary))
      )
      .map((signal) => normalizeKey(signal.key))
  );

  return probes.find((probe) => {
    if (probe.outcome !== "NEEDS_ADAPTER") {
      return true;
    }

    const courseKey = normalizeKey(`adapter:${probe.courseName}`);
    return !staleAdapterKeys.has(courseKey);
  });
}

function selectLearningFollowup(signals: LearningSignalInput[]) {
  return signals
    .filter((signal) => signal.status !== "stale")
    .sort((a, b) => {
      const statusScore = learningStatusScore(b.status) - learningStatusScore(a.status);
      if (statusScore !== 0) {
        return statusScore;
      }

      return b.repeats - a.repeats;
    })[0];
}

function learningStatusScore(status: LearningSignalInput["status"]) {
  switch (status) {
    case "open":
      return 4;
    case "blocked":
      return 3;
    case "learned":
      return 2;
    case "stale":
      return 1;
    default:
      return 0;
  }
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}
