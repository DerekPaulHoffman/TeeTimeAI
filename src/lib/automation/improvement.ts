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

type SupportIncidentInput = {
  id: string;
  status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN";
  kind: "NEEDS_ADAPTER" | "FETCH_FAILED" | "BLOCKED_AUTH" | "BLOCKED_TOOLING";
  courseName: string;
  platform: string;
  lastSeenAt: string;
  message?: string | null;
  engineeringOnly?: boolean;
};

type LearningSignalInput = {
  key: string;
  kind: "adapter_gap" | "ui_smoke" | "provider_config" | "tooling" | "research";
  category?: ImprovementCategory;
  summary: string;
  lastSeenAt: string;
  repeats: number;
  nextAction?: string;
  status?: "open" | "learned" | "blocked" | "stale";
};

export const IMPROVEMENT_CATEGORIES = [
  "operations_incidents",
  "search_discovery",
  "ui_ux",
  "accessibility",
  "dashboard_auth",
  "email_alerts",
  "reliability_security",
  "performance",
  "metadata_seo",
  "analytics_observability",
  "test_developer_tooling"
] as const;

export type ImprovementCategory = (typeof IMPROVEMENT_CATEGORIES)[number];

export const IMPROVEMENT_EVIDENCE_TRACKS = [
  "operations_errors",
  "browser_location",
  "feedback_discord_behavior",
  "missing_course_search",
  "current_practice_research",
  "product_quality"
] as const;

export type ImprovementEvidenceTrack = (typeof IMPROVEMENT_EVIDENCE_TRACKS)[number];

export function hasCourseSupportWriterConflict(input: {
  activeBatchCount: number;
  dueIncidentCount: number;
}) {
  return input.activeBatchCount > 0;
}

export type PortfolioCandidateInput = {
  id: string;
  category: ImprovementCategory;
  source:
    | "feedback"
    | "funnel"
    | "browser"
    | "email"
    | "performance"
    | "metadata"
    | "security"
    | "coverage"
    | "research";
  summary: string;
  observedAt: string;
  priority: number;
  evidence: string[];
  outcome?: "success" | "blocked_auth" | "blocked_tooling" | "needs_human";
  diversityOverride?: boolean;
};

export type ImprovementCategoryHistoryInput = {
  category: ImprovementCategory;
  selectedAt: string;
  incidentOverride?: boolean;
};

type PortfolioRunInput = {
  outcome: string | null;
  completedAt: Date | string | null;
  notes: string | null;
};

type FeedbackPortfolioInput = {
  id: string;
  sentiment: "LIKE" | "DISLIKE" | "BROKEN";
  message: string | null;
  page: string | null;
  trafficClass: string;
  createdAt: Date | string;
};

type FunnelEventCountInput = {
  name: string;
  count: number;
};

export type ImprovementCandidateInput = {
  activeSearchCount: number;
  pendingAlerts: PendingAlertInput[];
  supportIncidents?: SupportIncidentInput[];
  actionableProbes: ActionableProbeInput[];
  learningSignals?: LearningSignalInput[];
  portfolioCandidates?: PortfolioCandidateInput[];
  categoryHistory?: ImprovementCategoryHistoryInput[];
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
    | "adapter_remediation"
    | "adapter_gap"
    | "policy_blocker"
    | "auth_blocker"
    | "tooling_blocker"
    | "fetch_failure"
    | "ui_smoke"
    | "learning_followup"
    | "portfolio_signal"
    | "coverage_blocker"
    | "exploration_required";
  summary: string;
  referenceId?: string;
  researchDirective?: string;
  category?: ImprovementCategory;
  priority?: number;
  selectionReason?: string;
  evidence?: string[];
  engineeringOnly?: boolean;
};

export type AdapterRemediationCloseoutEvidence = {
  incidentId: string;
  attempts: string[];
  evidence: string[];
  result: string;
  requiredExternalAction: string;
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

const ACTIONABLE_PROBE_OUTCOMES = new Set<ActionableProbeInput["outcome"]>([
  "BLOCKED_POLICY",
  "BLOCKED_AUTH",
  "BLOCKED_TOOLING",
  "FETCH_FAILED",
  "NEEDS_ADAPTER"
]);

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
    portfolioCandidateCount?: number;
    dueCategory?: ImprovementCategory | null;
    recentCategories?: ImprovementCategory[];
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
      referenceId: oldestAlert.id,
      category: "email_alerts",
      priority: 120,
      selectionReason: "Pending customer delivery work has absolute priority."
    };
  }

  const supportIncident = input.supportIncidents?.[0];
  if (supportIncident) {
    return candidateFromSupportIncident(supportIncident);
  }

  const rankedPortfolio = rankPortfolioCandidates(
    input.portfolioCandidates ?? [],
    input.categoryHistory ?? []
  );
  const selectablePortfolio = rankedPortfolio.filter(
    (candidate) => candidate.source !== "coverage"
  );
  const urgentPortfolioCandidate = selectablePortfolio.find(
    (candidate) => candidate.adjustedPriority >= 95
  );
  if (urgentPortfolioCandidate) {
    return candidateFromPortfolioSignal(urgentPortfolioCandidate);
  }

  const probe = selectFreshProbe(input.actionableProbes, input.learningSignals ?? []);
  if (probe) {
    return candidateFromProbe(probe);
  }

  const portfolioCandidate = selectablePortfolio[0];
  if (portfolioCandidate) {
    return candidateFromPortfolioSignal(portfolioCandidate);
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
      category: learningFollowup.category ?? categoryFromLearningKind(learningFollowup.kind),
      priority: 55,
      selectionReason: "No fresher operational or portfolio signal outranked this living follow-up.",
      researchDirective:
        "Refresh current product/tooling research before changing strategy, then record whether the follow-up learned, shipped, blocked, or went stale."
    };
  }

  return {
    outcome: "exploration_required",
    kind: "exploration_required",
    summary:
      input.activeSearchCount === 0
        ? "Initial queue evidence is empty; broaden ZIP, device, route, feedback, course-coverage, accessibility, performance, security, metadata, and current-practice exploration until a safe valuable improvement or concrete blocker is found."
        : "Active searches have no current delivery, incident, probe, or shippable portfolio blocker; broaden ZIP, device, route, feedback, course-coverage, accessibility, performance, security, metadata, and current-practice exploration until a safe valuable improvement or concrete blocker is found.",
    researchDirective:
      "Rotate to the least-recently covered evidence surfaces. A healthy first pass is not a terminal outcome."
  };
}

type RankedPortfolioCandidate = PortfolioCandidateInput & {
  adjustedPriority: number;
  selectionReason: string;
};

export function rankPortfolioCandidates(
  candidates: PortfolioCandidateInput[],
  categoryHistory: ImprovementCategoryHistoryInput[]
): RankedPortfolioCandidate[] {
  const normalizedHistory = [...categoryHistory].sort((left, right) =>
    right.selectedAt.localeCompare(left.selectedAt)
  );
  const recentCategories = normalizedHistory.slice(0, 3).map((entry) => entry.category);
  const searchStreak = countLeadingCategory(normalizedHistory, "search_discovery");
  const latestCategory = normalizedHistory[0]?.category;
  const latestCategoryStreak = latestCategory
    ? countLeadingCategory(normalizedHistory, latestCategory)
    : 0;
  const lastSelectedAt = new Map<ImprovementCategory, string>();
  for (const entry of normalizedHistory) {
    if (!lastSelectedAt.has(entry.category)) {
      lastSelectedAt.set(entry.category, entry.selectedAt);
    }
  }

  const eligible = candidates.filter(
    (candidate) =>
      candidate.evidence.some((item) => item.trim()) &&
      candidate.summary.trim() &&
      !(
        candidate.category === "search_discovery" &&
        searchStreak >= 2 &&
        !candidate.diversityOverride
      )
  );
  const dueCategory = selectDuePortfolioCategory(
    eligible.map((candidate) => candidate.category),
    lastSelectedAt
  );

  return eligible
    .map((candidate) => {
      let adjustedPriority = candidate.priority;
      const reasons = [`base priority ${candidate.priority}`];
      if (candidate.category === dueCategory) {
        adjustedPriority += 25;
        reasons.push("least-recently shipped eligible category +25");
      }
      if (!recentCategories.includes(candidate.category)) {
        adjustedPriority += 10;
        reasons.push("absent from the last three successful selections +10");
      }
      if (candidate.category === latestCategory && latestCategoryStreak > 0) {
        const repetitionPenalty = Math.min(latestCategoryStreak * 12, 36);
        adjustedPriority -= repetitionPenalty;
        reasons.push(`repeated-category penalty -${repetitionPenalty}`);
      }
      if (candidate.diversityOverride) {
        reasons.push("real-user or incident evidence overrides the discretionary cap");
      }

      return {
        ...candidate,
        adjustedPriority,
        selectionReason: reasons.join("; ")
      };
    })
    .sort((left, right) => {
      if (left.adjustedPriority !== right.adjustedPriority) {
        return right.adjustedPriority - left.adjustedPriority;
      }
      return right.observedAt.localeCompare(left.observedAt);
    });
}

export function selectDuePortfolioCategory(
  categories: ImprovementCategory[],
  lastSelectedAt: ReadonlyMap<ImprovementCategory, string>
): ImprovementCategory | null {
  const diversityOrder: ImprovementCategory[] = [
    "dashboard_auth",
    "email_alerts",
    "analytics_observability",
    "performance",
    "metadata_seo",
    "accessibility",
    "ui_ux",
    "reliability_security",
    "test_developer_tooling",
    "search_discovery",
    "operations_incidents"
  ];
  const uniqueCategories = [...new Set(categories)];
  if (uniqueCategories.length === 0) {
    return null;
  }

  return uniqueCategories.sort((left, right) => {
    const leftDate = lastSelectedAt.get(left);
    const rightDate = lastSelectedAt.get(right);
    if (!leftDate && rightDate) {
      return -1;
    }
    if (leftDate && !rightDate) {
      return 1;
    }
    if (leftDate && rightDate && leftDate !== rightDate) {
      return leftDate.localeCompare(rightDate);
    }
    return diversityOrder.indexOf(left) - diversityOrder.indexOf(right);
  })[0];
}

export function buildFeedbackPortfolioCandidates(
  feedback: FeedbackPortfolioInput[]
): PortfolioCandidateInput[] {
  return feedback.flatMap((item) => {
    if (
      item.sentiment === "LIKE" ||
      (item.trafficClass !== "PUBLIC" && item.trafficClass !== "UNCLASSIFIED")
    ) {
      return [];
    }
    const category = categoryFromFeedback(item.page, item.message);
    const page = item.page?.trim() || "unknown page";
    const detail = item.message?.replace(/\s+/g, " ").trim().slice(0, 240);
    const broken = item.sentiment === "BROKEN";
    return [
      {
        id: `feedback:${item.id}`,
        category,
        source: "feedback" as const,
        summary: `${broken ? "Reproduce and resolve" : "Investigate repeated friction from"} ${item.sentiment} feedback on ${page}${detail ? `: ${detail}` : "."}`,
        observedAt: toIsoString(item.createdAt),
        priority: broken ? 100 : 82,
        diversityOverride: broken,
        evidence: [
          `WebsiteFeedback ${item.id}`,
          `sentiment=${item.sentiment}`,
          `page=${page}`
        ]
      }
    ];
  });
}

export function buildFunnelPortfolioCandidates(
  counts: FunnelEventCountInput[],
  observedAt: Date | string
): PortfolioCandidateInput[] {
  const eventCounts = new Map(counts.map((entry) => [entry.name, entry.count]));
  const pageViews = eventCounts.get("page_viewed") ?? 0;
  const starts = eventCounts.get("start_search_clicked") ?? 0;
  const discoveries = eventCounts.get("course_discovery_completed") ?? 0;
  const selections = eventCounts.get("course_selection_started") ?? 0;
  const signIns = eventCounts.get("alert_sign_in_clicked") ?? 0;
  const submissions = eventCounts.get("search_submitted") ?? 0;
  const candidates: PortfolioCandidateInput[] = [];
  const createdAt = toIsoString(observedAt);

  if (pageViews >= 50 && starts / pageViews < 0.02) {
    candidates.push({
      id: "funnel:homepage-to-search",
      category: "ui_ux",
      source: "funnel",
      summary: "Investigate a low PUBLIC start-search rate before changing discovery behavior.",
      observedAt: createdAt,
      priority: 70,
      evidence: [`PUBLIC page_viewed=${pageViews}`, `PUBLIC start_search_clicked=${starts}`]
    });
  }
  if (starts >= 20 && discoveries / starts < 0.6) {
    candidates.push({
      id: "funnel:search-to-discovery",
      category: "reliability_security",
      source: "funnel",
      summary: "Investigate a material PUBLIC drop between starting search and completing discovery.",
      observedAt: createdAt,
      priority: 80,
      evidence: [
        `PUBLIC start_search_clicked=${starts}`,
        `PUBLIC course_discovery_completed=${discoveries}`
      ]
    });
  }
  if (selections >= 20 && signIns / selections < 0.25) {
    candidates.push({
      id: "funnel:selection-to-sign-in",
      category: "analytics_observability",
      source: "funnel",
      summary: "Investigate measurable PUBLIC abandonment between course selection and alert sign-in.",
      observedAt: createdAt,
      priority: 76,
      evidence: [
        `PUBLIC course_selection_started=${selections}`,
        `PUBLIC alert_sign_in_clicked=${signIns}`
      ]
    });
  }
  if (signIns >= 20 && submissions / signIns < 0.4) {
    candidates.push({
      id: "funnel:sign-in-to-submit",
      category: "dashboard_auth",
      source: "funnel",
      summary: "Investigate measurable PUBLIC loss between alert sign-in and saved-search submission.",
      observedAt: createdAt,
      priority: 88,
      evidence: [
        `PUBLIC alert_sign_in_clicked=${signIns}`,
        `PUBLIC search_submitted=${submissions}`
      ]
    });
  }

  return candidates;
}

export function buildPortfolioCategoryHistory(
  runs: PortfolioRunInput[]
): ImprovementCategoryHistoryInput[] {
  return runs.flatMap((run) => {
    if (run.outcome !== "success" || !run.completedAt) {
      return [];
    }
    const record = parseHourlyImprovementRunRecord(run.notes);
    if (!record) {
      return [];
    }
    const category = readImprovementCategory(record.audit?.selectedCategory) ??
      record.candidate?.category ??
      inferHistoricalCategory(record);
    if (!category) {
      return [];
    }
    return [
      {
        category,
        selectedAt: toIsoString(run.completedAt),
        incidentOverride: record.candidate?.kind === "adapter_remediation"
      }
    ];
  });
}

export function buildRepeatedCoveragePortfolioCandidates(
  runs: PortfolioRunInput[]
): PortfolioCandidateInput[] {
  const grouped = new Map<
    string,
    {
      category: ImprovementCategory;
      label: string;
      action: string;
      observedAt: string;
      evidence: string[];
    }
  >();

  for (const run of runs) {
    if (run.outcome !== "success" || !run.completedAt) {
      continue;
    }
    const record = parseHourlyImprovementRunRecord(run.notes);
    if (!record?.audit) {
      continue;
    }
    const blockers = [
      ...readStringArray(record.audit.blockers),
      ...readStringArray(record.audit.coverageBlockers)
    ];
    const seenInRun = new Set<string>();
    for (const blocker of blockers) {
      const classification = classifyCoverageBlocker(blocker);
      if (!classification || seenInRun.has(classification.key)) {
        continue;
      }
      seenInRun.add(classification.key);
      const observedAt = toIsoString(run.completedAt);
      const existing = grouped.get(classification.key);
      grouped.set(classification.key, {
        ...classification,
        observedAt:
          existing && existing.observedAt > observedAt ? existing.observedAt : observedAt,
        evidence: [...(existing?.evidence ?? []), blocker].slice(-6)
      });
    }
  }

  return [...grouped.entries()].flatMap(([key, value]) => {
    if (value.evidence.length < 3) {
      return [];
    }
    return [
      {
        id: `coverage:${key}`,
        category: value.category,
        source: "coverage" as const,
        summary: `${value.label} has been unavailable in ${value.evidence.length} recent successful runs. ${value.action}`,
        observedAt: value.observedAt,
        priority: 55,
        outcome: "needs_human" as const,
        evidence: value.evidence
      }
    ];
  });
}

export function selectLatestActionableProbes<
  T extends {
    teeSearchId: string;
    courseId: string;
    outcome: string;
  }
>(probesNewestFirst: readonly T[]): Array<T & { outcome: ActionableProbeInput["outcome"] }> {
  const latest = new Map<string, T>();

  for (const probe of probesNewestFirst) {
    const key = `${probe.teeSearchId}:${probe.courseId}`;
    if (!latest.has(key)) {
      latest.set(key, probe);
    }
  }

  return [...latest.values()].filter(
    (probe): probe is T & { outcome: ActionableProbeInput["outcome"] } =>
      ACTIONABLE_PROBE_OUTCOMES.has(probe.outcome as ActionableProbeInput["outcome"])
  );
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

export function validateAdapterRemediationCloseout(input: {
  candidate: ImprovementCandidate | undefined;
  outcome: string;
  evidence: unknown;
}) {
  if (input.candidate?.kind !== "adapter_remediation") {
    return { escalate: false } as const;
  }
  if (input.outcome === "needs_adapter") {
    throw new Error(
      "adapter remediation cannot close as needs_adapter; complete the adapter, classify a current technical-access or direct-booking outcome, or record a concrete blocker"
    );
  }
  if (input.outcome !== "needs_human") {
    return { escalate: false } as const;
  }
  if (input.candidate.engineeringOnly) {
    throw new Error(
      "engineering-only adapter remediation cannot escalate to an owner; persist a runnable or conclusive final disposition"
    );
  }

  const evidence = input.evidence as Partial<AdapterRemediationCloseoutEvidence> | null;
  const referenceId = input.candidate.referenceId;
  if (
    !evidence ||
    !referenceId ||
    evidence.incidentId !== referenceId ||
    !Array.isArray(evidence.attempts) ||
    evidence.attempts.filter(isNonEmptyString).length === 0 ||
    !Array.isArray(evidence.evidence) ||
    evidence.evidence.filter(isNonEmptyString).length === 0 ||
    !isNonEmptyString(evidence.result) ||
    !isNonEmptyString(evidence.requiredExternalAction)
  ) {
    throw new Error(
      "needs_human adapter closeout requires adapterRemediation evidence with the incident id, automated attempts, sources, result, and exact external action"
    );
  }

  return {
    escalate: true,
    incidentId: referenceId,
    message: evidence.result.trim(),
    nextAction: evidence.requiredExternalAction.trim()
  } as const;
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
  candidateCategory?: ImprovementCategory;
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
    "selectedCategory",
    "candidateRanking",
    "evidenceTrackResults",
    "coverageBlockers",
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
    "candidateRanking",
    "coverageBlockers",
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

  if (input.outcome !== "success" && input.outcome !== "no_action_healthy") {
    return;
  }

  if (input.outcome === "success") {
    const selectedCategory = readImprovementCategory(input.audit.selectedCategory);
    if (!selectedCategory) {
      throw new Error("successful closeout requires a valid selectedCategory");
    }
    if (input.candidateCategory && selectedCategory !== input.candidateCategory) {
      throw new Error(
        `successful closeout selectedCategory must match the claimed candidate category ${input.candidateCategory}`
      );
    }
  }
  if (readStringArray(input.audit.candidateRanking).length === 0) {
    throw new Error("successful closeout requires a non-empty candidateRanking");
  }
  const evidenceTrackResults = input.audit.evidenceTrackResults;
  if (!isRecordObject(evidenceTrackResults)) {
    throw new Error("successful closeout evidenceTrackResults must be an object");
  }
  const missingEvidenceTracks = IMPROVEMENT_EVIDENCE_TRACKS.filter(
    (track) => !isNonEmptyString(evidenceTrackResults[track])
  );
  if (missingEvidenceTracks.length > 0) {
    throw new Error(
      `successful closeout is missing evidence-track results: ${missingEvidenceTracks.join(", ")}`
    );
  }
  if (!isNonEmptyString(input.audit.changedBehavior)) {
    throw new Error("successful closeout requires non-empty changedBehavior evidence");
  }
  if (!isNonEmptyString(input.audit.measuredResult)) {
    throw new Error("healthy closeout requires non-empty measuredResult evidence");
  }

  if (input.outcome === "no_action_healthy") {
    if (input.audit.commitSha !== null || input.audit.deploymentId !== null) {
      throw new Error(
        "no_action_healthy closeout cannot record a commit or deployment"
      );
    }
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
        category: "search_discovery",
        priority: 84,
        selectionReason:
          "Fresh real-demand or explicit multi-cycle coverage evidence outranks discretionary work.",
        researchDirective:
          "Inspect current official booking surface and policy evidence before implementing; if unsupported after repeated inspection, record a blocked or stale learning instead of repeating the same probe."
      };
    case "BLOCKED_POLICY":
      return {
        outcome: "needs_adapter",
        kind: "adapter_gap",
        summary: `${probe.courseName} has a legacy policy block that requires a fresh public read-only access check.`,
        referenceId: probe.id,
        category: "search_discovery",
        priority: 90,
        selectionReason:
          "Legacy policy-only evidence on real demand must be re-verified and cannot remain a terminal monitoring disposition.",
        researchDirective:
          "Inspect the current signed-out public booking surface. Implement reusable read-only monitoring when technically accessible; record only a present technical access blocker, contact-only method, or identity disposition."
      };
    case "BLOCKED_AUTH":
      return {
        outcome: "blocked_auth",
        kind: "auth_blocker",
        summary: `${probe.courseName} requires auth or human account setup before automation can proceed.`,
        referenceId: probe.id,
        category: "operations_incidents",
        priority: 90,
        selectionReason: "A current authentication blocker on real demand requires disposition."
      };
    case "BLOCKED_TOOLING":
      return {
        outcome: "blocked_tooling",
        kind: "tooling_blocker",
        summary: `${probe.courseName} is blocked by missing or failing automation tooling.`,
        referenceId: probe.id,
        category: "operations_incidents",
        priority: 90,
        selectionReason: "A current tooling blocker on real demand requires disposition."
      };
    case "FETCH_FAILED":
      return {
        outcome: "needs_human",
        kind: "fetch_failure",
        summary: `${probe.courseName} fetch failed and needs adapter or endpoint diagnosis.`,
        referenceId: probe.id,
        category: "operations_incidents",
        priority: 92,
        selectionReason: "A fresh provider failure on real demand outranks discretionary work."
      };
  }
}

function candidateFromSupportIncident(
  incident: SupportIncidentInput
): ImprovementCandidate {
  const action =
    incident.kind === "FETCH_FAILED"
      ? "Repair the existing provider integration or replace the failing public endpoint"
      : incident.kind === "BLOCKED_TOOLING"
        ? "Repair the automation tooling and complete the provider integration"
        : incident.kind === "BLOCKED_AUTH"
          ? "Find a public signed-out read-only retrieval path or conclusively classify the current technical access requirement"
          : "Build or extend a reusable provider adapter";
  return {
    outcome: "needs_adapter",
    kind: "adapter_remediation",
    summary: `${action} for ${incident.courseName} (${incident.platform}) and verify the affected active search end to end.`,
    referenceId: incident.id,
    engineeringOnly: incident.engineeringOnly,
    category: "operations_incidents",
    priority: 110,
    selectionReason: incident.engineeringOnly
      ? "An engineering-only multi-cycle coverage incident has priority until it receives a runnable or final disposition."
      : "An open support incident affecting real active demand has priority.",
    researchDirective: incident.engineeringOnly
      ? "Start from the current official booking surface, inspect public signed-out provider traffic, implement reusable metadata discovery and read-only retrieval when technically accessible, add focused tests, and rerun the affected search. Persist a conclusive technical-access, contact, or identity disposition when public monitoring is not possible; do not escalate synthetic coverage to the owner."
      : "Start from the current official booking surface, inspect public signed-out provider traffic, implement reusable metadata discovery and read-only retrieval when technically accessible, add focused tests, and rerun the affected search. Booking or transaction policy text alone is never terminal. Do not ask the owner to research or code the adapter. Only use needs_human after concrete automated attempts prove an exact external action is unavoidable."
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function candidateFromPortfolioSignal(
  candidate: RankedPortfolioCandidate
): ImprovementCandidate {
  return {
    outcome: candidate.outcome ?? "success",
    kind: candidate.source === "coverage" ? "coverage_blocker" : "portfolio_signal",
    summary: candidate.summary,
    referenceId: candidate.id,
    category: candidate.category,
    priority: candidate.adjustedPriority,
    selectionReason: candidate.selectionReason,
    evidence: candidate.evidence
  };
}

function countLeadingCategory(
  history: ImprovementCategoryHistoryInput[],
  category: ImprovementCategory
) {
  let count = 0;
  for (const entry of history) {
    if (entry.category !== category || entry.incidentOverride) {
      break;
    }
    count += 1;
  }
  return count;
}

function categoryFromLearningKind(
  kind: LearningSignalInput["kind"]
): ImprovementCategory {
  switch (kind) {
    case "adapter_gap":
    case "provider_config":
      return "search_discovery";
    case "ui_smoke":
      return "ui_ux";
    case "tooling":
      return "test_developer_tooling";
    case "research":
      return "metadata_seo";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
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

function categoryFromFeedback(
  page: string | null,
  message: string | null
): ImprovementCategory {
  const haystack = `${page ?? ""} ${message ?? ""}`.toLowerCase();
  if (/dashboard|pause|resume|recipient|check now|sign[ -]?in|account/.test(haystack)) {
    return "dashboard_auth";
  }
  if (/email|alert|stop link|unsubscribe/.test(haystack)) {
    return "email_alerts";
  }
  if (/missing course|course result|private course|duplicate course|search result/.test(haystack)) {
    return "search_discovery";
  }
  if (/keyboard|screen reader|contrast|focus|accessible|accessibility/.test(haystack)) {
    return "accessibility";
  }
  return "ui_ux";
}

function inferHistoricalCategory(
  record: HourlyImprovementRunRecord
): ImprovementCategory | null {
  switch (record.candidate?.kind) {
    case "pending_alert":
      return "email_alerts";
    case "adapter_remediation":
      return "operations_incidents";
    case "adapter_gap":
    case "policy_blocker":
    case "fetch_failure":
      return "search_discovery";
    case "auth_blocker":
      return "dashboard_auth";
    case "tooling_blocker":
      return "test_developer_tooling";
    case "ui_smoke":
      return "ui_ux";
  }

  const learning = readStringArray(record.audit?.learning).join(" ");
  const changedBehavior =
    typeof record.audit?.changedBehavior === "string"
      ? record.audit.changedBehavior
      : "";
  const text = `${record.candidate?.summary ?? ""} ${learning} ${changedBehavior}`.toLowerCase();
  const patterns: Array<[RegExp, ImprovementCategory]> = [
    [/operations?\/incidents?|active incident|support incident/, "operations_incidents"],
    [/clerk|dashboard|authentication|auth management/, "dashboard_auth"],
    [/email|deliverability|recipient|alert rendering/, "email_alerts"],
    [/accessibility|wcag|contrast|screen reader|keyboard/, "accessibility"],
    [/analytics|observability|traffic provenance|funnel/, "analytics_observability"],
    [/performance|cache|core web vital|lcp|speed insights/, "performance"],
    [/metadata|seo|canonical|structured data|social preview/, "metadata_seo"],
    [/security|reliability|workflow lifetime|synthetic search/, "reliability_security"],
    [/developer tooling|inspector|test tooling/, "test_developer_tooling"],
    [/search\/discovery|course identity|place id|registry|course filter/, "search_discovery"],
    [/ui\/ux|loading status|placeholder|copy/, "ui_ux"]
  ];
  return patterns.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function classifyCoverageBlocker(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.includes("discord") && /unavailable|without.*session|member session/.test(normalized)) {
    return {
      key: "discord-history",
      category: "test_developer_tooling" as const,
      label: "Authenticated Discord feedback coverage",
      action: "Provide or reconnect a read-only server-member session, then advance the durable cursor."
    };
  }
  if (
    /dashboard|clerk/.test(normalized) &&
    /credential|matched pair|test identity|reserved synthetic/.test(normalized)
  ) {
    return {
      key: "dashboard-auth-test",
      category: "dashboard_auth" as const,
      label: "Authenticated synthetic dashboard coverage",
      action: "Configure a matched reserved Clerk test identity before repeating signed-out-only checks."
    };
  }
  if (/speed insights|core web vitals|field data/.test(normalized) && /unavailable|insufficient|blocked/.test(normalized)) {
    return {
      key: "field-performance",
      category: "performance" as const,
      label: "Field performance evidence",
      action: "Restore read access or wait for the documented minimum PUBLIC sample before another field-vitals audit."
    };
  }
  if (/mailbox|inbox|email delivery/.test(normalized) && /unavailable|credential|blocked/.test(normalized)) {
    return {
      key: "email-inbox",
      category: "email_alerts" as const,
      label: "Test-inbox delivery evidence",
      action: "Configure a reserved test mailbox or provider delivery-event read path."
    };
  }
  return null;
}

function readImprovementCategory(value: unknown): ImprovementCategory | null {
  return typeof value === "string" &&
    IMPROVEMENT_CATEGORIES.includes(value as ImprovementCategory)
    ? (value as ImprovementCategory)
    : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}
