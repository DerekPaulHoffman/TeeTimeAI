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
    | "exploration_required"
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
    | "exploration_required";
  summary: string;
  referenceId?: string;
  researchDirective?: string;
};

export type ImprovementCheckpoints = {
  queue_confirmed: boolean;
  candidate_selected: boolean;
  provenance_recorded: boolean;
  tool_research_done: boolean;
  ui_smoke_done: boolean;
  verification_done: boolean;
  git_committed: boolean;
  git_pushed: boolean;
  production_verified: boolean;
  outcome_recorded: boolean;
};

export const HOURLY_IMPROVEMENT_AUTOMATION_ID =
  "teetimeai-hourly-product-improvement-loop";
export const HOURLY_IMPROVEMENT_CLAIM_WINDOW_MS = 40 * 60 * 1000;

const SENSITIVE_QUERY_PARAMETER_NAMES = new Set([
  "access_token",
  "api_key",
  "auth",
  "authorization",
  "code",
  "cookie",
  "credential",
  "id_token",
  "jwt",
  "key",
  "key_pair_id",
  "password",
  "policy",
  "refresh_token",
  "secret",
  "session",
  "sig",
  "signature",
  "token",
  "x_amz_credential",
  "x_amz_security_token",
  "x_amz_signature",
  "x_goog_credential",
  "x_goog_signature"
]);

export type HourlyImprovementRunProvenance = {
  automationId: string;
  ownerRunId: string;
  ownerThreadId: string | null;
  branch: string;
  startingSha: string;
  expectedHeadSha: string;
  plannedPaths: string[];
};

export type HourlyImprovementRunRecord = {
  schemaVersion: 1;
  automationId: string;
  promptVersion: string;
  lifecycle:
    | "prepared"
    | "candidate_selected"
    | "exploration_required"
    | "editing"
    | "verifying"
    | "closeout"
    | "blocked";
  owner: {
    runId: string;
    threadId: string | null;
    recoveryOfRunId?: string;
  };
  provenance: HourlyImprovementRunProvenance;
  checkpoints: ImprovementCheckpoints;
  candidate?: ImprovementCandidate;
  snapshot?: {
    activeSearchCount: number;
    pendingAlertCount: number;
    actionableProbeCount: number;
    learningSignalCount: number;
  };
  nextPrompt?: string;
  blocker?: {
    outcome: string;
    reasons: string[];
  };
  audit?: Record<string, unknown>;
};

export type DirtyWorktreeRecoveryDecision =
  | { action: "clean_start" }
  | { action: "resume_owned_work"; ownerRunId: string }
  | { action: "blocked_dirty_worktree"; reasons: string[] };

export function isHourlyImprovementClaimWindowOpen(input: {
  startedAt: Date;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return now.getTime() - input.startedAt.getTime() < HOURLY_IMPROVEMENT_CLAIM_WINDOW_MS;
}

export function validateHourlyRunCommitTopology(input: {
  startingSha: string;
  headSha: string;
  parentShas: string[];
  startingShaIsAncestorOfParent: boolean;
}) {
  if (input.headSha === input.startingSha) {
    throw new Error("successful hourly closeout requires a real committed diff");
  }
  if (input.parentShas.length !== 1) {
    throw new Error("successful hourly closeout requires one non-merge owner commit");
  }
  if (!input.startingShaIsAncestorOfParent) {
    throw new Error(
      "successful hourly closeout commit parent does not descend from the recorded starting SHA"
    );
  }

  return input.parentShas[0];
}

export function sanitizeAutomationText(value: string) {
  const redactUrl = (rawUrl: string) => {
    try {
      const parsed = new URL(rawUrl);
      let changed = false;
      for (const name of [...parsed.searchParams.keys()]) {
        if (isSensitiveQueryParameterName(name)) {
          parsed.searchParams.set(name, "[redacted]");
          changed = true;
        }
      }
      return changed ? parsed.toString() : rawUrl;
    } catch {
      return rawUrl;
    }
  };

  return value
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, redactUrl)
    .replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (match, separator, name) =>
      isSensitiveQueryParameterName(name)
        ? `${separator}${name}=[redacted]`
        : match
    )
    .replace(/(authorization:\s*)\S+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[redacted]")
    .replace(/(idempotency[-_ ]?key\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk|re)[_-][a-z0-9_-]{16,}\b/gi, "[redacted]")
    .replace(/\bAIza[a-z0-9_-]{20,}\b/g, "[redacted]");
}

function isSensitiveQueryParameterName(name: string) {
  const normalized = name.trim().toLowerCase().replaceAll("-", "_");
  return (
    SENSITIVE_QUERY_PARAMETER_NAMES.has(normalized) ||
    normalized.endsWith("_token") ||
    normalized.endsWith("_secret") ||
    normalized.endsWith("_signature") ||
    normalized.endsWith("_credential") ||
    normalized.endsWith("_password")
  );
}

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
      outcome: "exploration_required",
      kind: "exploration_required",
      summary:
        "Initial queue evidence is empty; broaden ZIP, device, route, feedback, course-coverage, accessibility, performance, security, metadata, and current-practice exploration until a safe valuable improvement or concrete blocker is found.",
      researchDirective:
        "Rotate to the least-recently covered evidence surfaces. An empty first pass is not a terminal outcome."
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
  provenanceRecorded?: boolean;
  toolResearchDone?: boolean;
  uiSmokeDone?: boolean;
  verificationDone?: boolean;
  gitCommitted?: boolean;
  gitPushed?: boolean;
  productionVerified?: boolean;
}): ImprovementCheckpoints {
  return {
    queue_confirmed: input.queueConfirmed,
    candidate_selected: input.candidateSelected,
    provenance_recorded: input.provenanceRecorded ?? false,
    tool_research_done: input.toolResearchDone ?? false,
    ui_smoke_done: input.uiSmokeDone ?? false,
    verification_done: input.verificationDone ?? false,
    git_committed: input.gitCommitted ?? false,
    git_pushed: input.gitPushed ?? false,
    production_verified: input.productionVerified ?? false,
    outcome_recorded: false
  };
}

export function markImprovementOutcomeRecorded(
  checkpoints: ImprovementCheckpoints
): ImprovementCheckpoints {
  return {
    ...checkpoints,
    outcome_recorded: true
  };
}

export function buildHourlyImprovementRunProvenance(input: {
  automationId?: string;
  ownerRunId: string;
  ownerThreadId: string | null;
  branch: string;
  startingSha: string;
  expectedHeadSha?: string;
  plannedPaths?: string[];
}): HourlyImprovementRunProvenance {
  return {
    automationId: input.automationId ?? HOURLY_IMPROVEMENT_AUTOMATION_ID,
    ownerRunId: input.ownerRunId,
    ownerThreadId: input.ownerThreadId,
    branch: input.branch.trim(),
    startingSha: input.startingSha.trim(),
    expectedHeadSha: (input.expectedHeadSha ?? input.startingSha).trim(),
    plannedPaths: normalizeOwnedPaths(input.plannedPaths ?? [])
  };
}

export function hasCompletePreEditProvenance(
  provenance: HourlyImprovementRunProvenance
) {
  return Boolean(
    provenance.automationId === HOURLY_IMPROVEMENT_AUTOMATION_ID &&
      provenance.ownerRunId.trim() &&
      provenance.ownerThreadId?.trim() &&
      provenance.branch.startsWith("automation/hourly-") &&
      provenance.startingSha.trim() &&
      provenance.expectedHeadSha.trim() &&
      provenance.plannedPaths.length > 0 &&
      provenance.plannedPaths.every(isRepoRelativeOwnedPath)
  );
}

export function assessDirtyWorktreeRecovery(input: {
  automationId?: string;
  recoveryOfRunId?: string;
  currentOwnerThreadId: string | null;
  currentBranch: string;
  currentHeadSha: string;
  dirtyPaths: string[];
  immediatelyPrevious:
    | {
        isImmediatelyPreceding: boolean;
        completedAt: string | null;
        provenance: HourlyImprovementRunProvenance;
        checkpoints: ImprovementCheckpoints;
      }
    | null;
}): DirtyWorktreeRecoveryDecision {
  const dirtyPaths = normalizeOwnedPaths(input.dirtyPaths);
  if (dirtyPaths.length === 0) {
    return { action: "clean_start" };
  }

  const reasons: string[] = [];
  const previous = input.immediatelyPrevious;
  const automationId = input.automationId ?? HOURLY_IMPROVEMENT_AUTOMATION_ID;

  if (!previous) {
    return {
      action: "blocked_dirty_worktree",
      reasons: ["No immediately preceding hourly run owns the dirty paths."]
    };
  }

  if (!previous.isImmediatelyPreceding) {
    reasons.push("The provenance record is not from the immediately preceding hourly run.");
  }
  if (previous.completedAt !== null) {
    reasons.push("The preceding run already recorded a terminal closeout.");
  }
  if (previous.provenance.automationId !== automationId) {
    reasons.push("The preceding run belongs to a different automation.");
  }
  if (input.recoveryOfRunId !== previous.provenance.ownerRunId) {
    reasons.push("Recovery did not explicitly claim the preceding owner run id.");
  }
  if (
    !input.currentOwnerThreadId ||
    input.currentOwnerThreadId !== previous.provenance.ownerThreadId
  ) {
    reasons.push("Recovery is not running in the recorded owner Codex thread.");
  }
  if (!hasCompletePreEditProvenance(previous.provenance)) {
    reasons.push("The preceding run did not persist complete pre-edit provenance.");
  }
  if (input.currentBranch.trim() !== previous.provenance.branch) {
    reasons.push("The current branch does not match the recorded owner branch.");
  }
  if (input.currentHeadSha.trim() !== previous.provenance.expectedHeadSha) {
    reasons.push("The current HEAD does not match the recorded expected HEAD.");
  }
  if (
    previous.checkpoints.git_committed ||
    previous.checkpoints.git_pushed ||
    previous.checkpoints.production_verified ||
    previous.checkpoints.outcome_recorded
  ) {
    reasons.push("The preceding checkpoint state is incompatible with uncommitted recovery.");
  }

  const plannedPaths = new Set(previous.provenance.plannedPaths);
  const unownedPaths = dirtyPaths.filter((path) => !plannedPaths.has(path));
  if (unownedPaths.length > 0) {
    reasons.push(`Dirty paths fall outside the recorded plan: ${unownedPaths.join(", ")}`);
  }

  if (reasons.length > 0) {
    return { action: "blocked_dirty_worktree", reasons };
  }

  return {
    action: "resume_owned_work",
    ownerRunId: previous.provenance.ownerRunId
  };
}

export function parseHourlyImprovementRunRecord(
  notes: string | null | undefined
): HourlyImprovementRunRecord | null {
  if (!notes) {
    return null;
  }

  try {
    const value = JSON.parse(notes) as Partial<HourlyImprovementRunRecord>;
    if (
      value.schemaVersion !== 1 ||
      value.automationId !== HOURLY_IMPROVEMENT_AUTOMATION_ID ||
      !value.owner ||
      !value.provenance ||
      !value.checkpoints
    ) {
      return null;
    }

    return value as HourlyImprovementRunRecord;
  } catch {
    return null;
  }
}

export function validateHourlyCloseoutAudit(input: {
  audit: Record<string, unknown>;
  outcome: string;
  deploymentRequired: boolean;
  currentHeadSha: string;
}) {
  const requiredFields = [
    "branch",
    "startingSha",
    "commitSha",
    "pushResult",
    "migration",
    "deploymentId",
    "productionVerification",
    "zipLocationsExplored",
    "devicesExplored",
    "routesExplored",
    "scenariosExplored",
    "errorLogFindings",
    "feedbackDispositions",
    "discordCoverage",
    "missingCourseResearch",
    "researchSources",
    "rejectedCandidates",
    "learning",
    "blockers",
    "changedBehavior",
    "measuredResult",
    "nextRotationTargets"
  ];
  const missingFields = requiredFields.filter(
    (field) => !Object.prototype.hasOwnProperty.call(input.audit, field)
  );
  if (missingFields.length > 0) {
    throw new Error(
      `closeout audit is missing structured fields: ${missingFields.join(", ")}`
    );
  }
  const arrayFields = [
    "zipLocationsExplored",
    "devicesExplored",
    "routesExplored",
    "scenariosExplored",
    "errorLogFindings",
    "feedbackDispositions",
    "missingCourseResearch",
    "researchSources",
    "rejectedCandidates",
    "learning",
    "blockers",
    "nextRotationTargets"
  ];
  for (const field of arrayFields) {
    if (!Array.isArray(input.audit[field])) {
      throw new Error(`closeout audit ${field} must be an array`);
    }
  }
  const nullableStringFields = [
    "commitSha",
    "pushResult",
    "migration",
    "deploymentId",
    "productionVerification",
    "discordCoverage",
    "changedBehavior",
    "measuredResult"
  ];
  for (const field of nullableStringFields) {
    if (input.audit[field] !== null && typeof input.audit[field] !== "string") {
      throw new Error(`closeout audit ${field} must be a string or null`);
    }
  }

  if (input.outcome !== "success") {
    return;
  }

  const commitSha =
    typeof input.audit.commitSha === "string" ? input.audit.commitSha.trim() : "";
  if (commitSha.length < 7 || !input.currentHeadSha.startsWith(commitSha)) {
    throw new Error("successful closeout commitSha must identify the checked-out HEAD");
  }
  if (
    typeof input.audit.pushResult !== "string" ||
    !input.audit.pushResult.trim()
  ) {
    throw new Error("successful closeout requires a structured pushResult");
  }
  if (
    typeof input.audit.productionVerification !== "string" ||
    !input.audit.productionVerification.trim()
  ) {
    throw new Error("successful closeout requires productionVerification evidence");
  }
  if (
    input.deploymentRequired &&
    (typeof input.audit.deploymentId !== "string" || !input.audit.deploymentId.trim())
  ) {
    throw new Error("live-impacting successful closeout requires a deploymentId");
  }
}

function normalizeOwnedPaths(paths: string[]) {
  return [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function isRepoRelativeOwnedPath(path: string) {
  const segments = path.split("/");
  return Boolean(
    path &&
      path !== "." &&
      !path.startsWith("/") &&
      !/^[a-z]:\//i.test(path) &&
      !segments.includes("..")
  );
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
