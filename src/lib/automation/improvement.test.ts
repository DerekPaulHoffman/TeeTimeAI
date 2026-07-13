import { describe, expect, it } from "vitest";

import {
  assessDirtyWorktreeRecovery,
  buildHourlyImprovementRunProvenance,
  buildImprovementCheckpoints,
  hasCompletePreEditProvenance,
  isHourlyImprovementClaimWindowOpen,
  markImprovementOutcomeRecorded,
  sanitizeAutomationText,
  selectImprovementCandidate,
  validateAdapterRemediationCloseout,
  validateHourlyCloseoutAudit,
  validateHourlyRunCommitTopology
} from "./improvement";

describe("hourly closeout boundaries", () => {
  it("allows claims before minute 40 and rejects them at the boundary", () => {
    const startedAt = new Date("2026-07-13T12:00:00.000Z");

    expect(
      isHourlyImprovementClaimWindowOpen({
        startedAt,
        now: new Date("2026-07-13T12:39:59.999Z")
      })
    ).toBe(true);
    expect(
      isHourlyImprovementClaimWindowOpen({
        startedAt,
        now: new Date("2026-07-13T12:40:00.000Z")
      })
    ).toBe(false);
  });

  it("accepts one owner commit rebased over upstream changes", () => {
    expect(
      validateHourlyRunCommitTopology({
        startingSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        parentShas: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
        startingShaIsAncestorOfParent: true
      })
    ).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("rejects merge commits as ambiguous owner deltas", () => {
    expect(() =>
      validateHourlyRunCommitTopology({
        startingSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headSha: "cccccccccccccccccccccccccccccccccccccccc",
        parentShas: [
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "dddddddddddddddddddddddddddddddddddddddd"
        ],
        startingShaIsAncestorOfParent: true
      })
    ).toThrow("one non-merge owner commit");
  });
});

describe("automation evidence redaction", () => {
  it("redacts signed URL and credential variants without removing the route", () => {
    const evidence = sanitizeAutomationText(
      "GET https://example.com/private/report?access_token=access-value&api_key=api-value&X-Amz-Signature=aws-value&sig=sas-value then /oauth/callback?code=oauth-value with idempotency-key: idem-value"
    );

    expect(evidence).toContain("https://example.com/private/report");
    expect(evidence).not.toMatch(
      /access-value|api-value|aws-value|sas-value|oauth-value|idem-value/
    );
    expect(evidence.match(/redacted/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("buildImprovementCheckpoints", () => {
  it("tracks git and production handoff independently from code verification", () => {
    expect(
      buildImprovementCheckpoints({
        queueConfirmed: true,
        candidateSelected: true,
        verificationDone: true,
        gitCommitted: true,
        gitPushed: true,
        productionVerified: false
      })
    ).toEqual({
      queue_confirmed: true,
      candidate_selected: true,
      provenance_recorded: false,
      tool_research_done: false,
      ui_smoke_done: false,
      verification_done: true,
      git_committed: true,
      git_pushed: true,
      production_verified: false,
      outcome_recorded: false
    });
  });

  it("marks outcome_recorded only in the closeout copy", () => {
    const active = buildImprovementCheckpoints({
      queueConfirmed: true,
      candidateSelected: true,
      provenanceRecorded: true
    });

    const closed = markImprovementOutcomeRecorded(active);

    expect(active.outcome_recorded).toBe(false);
    expect(closed.outcome_recorded).toBe(true);
  });
});

describe("selectImprovementCandidate", () => {
  it("selects pending alerts before broader improvement work", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 3,
      pendingAlerts: [
        {
          id: "match-1",
          courseName: "Tashua Knolls",
          firstSeenAt: "2026-07-09T12:00:00.000Z"
        }
      ],
      actionableProbes: [],
      learningSignals: []
    });

    expect(candidate).toEqual({
      outcome: "success",
      kind: "pending_alert",
      summary: "Drain 1 pending tee-time alert before selecting new product work.",
      referenceId: "match-1"
    });
  });

  it("maps adapter probes to a needs_adapter terminal outcome", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 1,
      pendingAlerts: [],
      actionableProbes: [
        {
          id: "probe-1",
          outcome: "NEEDS_ADAPTER",
          courseName: "Example Golf",
          platform: "GOLFNOW",
          observedAt: "2026-07-09T12:00:00.000Z",
          message: "No supported adapter yet for GOLFNOW"
        }
      ],
      learningSignals: []
    });

    expect(candidate).toMatchObject({
      outcome: "needs_adapter",
      kind: "adapter_gap",
      referenceId: "probe-1"
    });
  });

  it("prioritizes an open adapter incident even when repeated browser discovery is stale", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 2,
      pendingAlerts: [],
      supportIncidents: [
        {
          id: "incident-1",
          status: "AUTO_INVESTIGATING",
          kind: "NEEDS_ADAPTER",
          courseName: "Dennis Pines",
          platform: "UNKNOWN",
          lastSeenAt: "2026-07-13T20:00:00.000Z",
          message: "Official site discovery did not learn a reusable adapter."
        }
      ],
      actionableProbes: [],
      learningSignals: [
        {
          key: "adapter:Dennis Pines",
          kind: "adapter_gap",
          summary: "Dennis Pines was inspected twice with no reusable adapter learned.",
          lastSeenAt: "2026-07-13T20:00:00.000Z",
          repeats: 3,
          status: "stale"
        }
      ]
    });

    expect(candidate).toMatchObject({
      outcome: "needs_adapter",
      kind: "adapter_remediation",
      referenceId: "incident-1",
      summary: expect.stringContaining("Build or extend a reusable provider adapter")
    });
  });

  it("skips repeated stale adapter gaps and follows a living learning signal", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 2,
      pendingAlerts: [],
      actionableProbes: [
        {
          id: "probe-1",
          outcome: "NEEDS_ADAPTER",
          courseName: "Longshore Golf Course",
          platform: "UNKNOWN",
          observedAt: "2026-07-09T12:00:00.000Z",
          message: "No supported adapter yet for UNKNOWN"
        }
      ],
      learningSignals: [
        {
          key: "adapter:Longshore Golf Course",
          kind: "adapter_gap",
          summary: "Longshore was inspected twice with no reusable adapter learned.",
          lastSeenAt: "2026-07-09T12:00:00.000Z",
          repeats: 3,
          status: "stale",
          nextAction: "Only revisit if a new booking URL or platform signal appears."
        },
        {
          key: "research:waitlist-ux",
          kind: "research",
          summary: "Compare current tee-time waitlist products for onboarding friction.",
          lastSeenAt: "2026-07-09T12:00:00.000Z",
          repeats: 1,
          status: "open",
          nextAction: "Ship one measurable UX improvement if research finds a gap."
        }
      ]
    });

    expect(candidate).toMatchObject({
      outcome: "success",
      kind: "learning_followup",
      referenceId: "research:waitlist-ux"
    });
  });

  it("requires broader exploration when there is no active queue", () => {
    const candidate = selectImprovementCandidate({
      activeSearchCount: 0,
      pendingAlerts: [],
      actionableProbes: [],
      learningSignals: []
    });

    expect(candidate).toEqual({
      outcome: "exploration_required",
      kind: "exploration_required",
      summary:
        "Initial queue evidence is empty; broaden ZIP, device, route, feedback, course-coverage, accessibility, performance, security, metadata, and current-practice exploration until a safe valuable improvement or concrete blocker is found.",
      researchDirective:
        "Rotate to the least-recently covered evidence surfaces. An empty first pass is not a terminal outcome."
    });
  });
});

describe("adapter remediation closeout", () => {
  const candidate = selectImprovementCandidate({
    activeSearchCount: 1,
    pendingAlerts: [],
    supportIncidents: [
      {
        id: "incident-1",
        status: "AUTO_INVESTIGATING",
        kind: "NEEDS_ADAPTER",
        courseName: "Dennis Pines",
        platform: "UNKNOWN",
        lastSeenAt: "2026-07-13T20:00:00.000Z"
      }
    ],
    actionableProbes: []
  });

  it("rejects needs_adapter as a terminal result", () => {
    expect(() =>
      validateAdapterRemediationCloseout({
        candidate,
        outcome: "needs_adapter",
        evidence: null
      })
    ).toThrow("cannot close as needs_adapter");
  });

  it("allows owner escalation only with concrete automated-attempt evidence", () => {
    expect(() =>
      validateAdapterRemediationCloseout({
        candidate,
        outcome: "needs_human",
        evidence: { incidentId: "incident-1" }
      })
    ).toThrow("requires adapterRemediation evidence");

    expect(
      validateAdapterRemediationCloseout({
        candidate,
        outcome: "needs_human",
        evidence: {
          incidentId: "incident-1",
          attempts: ["Inspected the public booking flow and provider network requests."],
          evidence: ["Official provider terms require a signed data-access agreement."],
          result: "No policy-safe unauthenticated retrieval path exists.",
          requiredExternalAction: "Approve or decline the provider data-access agreement."
        }
      })
    ).toEqual({
      escalate: true,
      incidentId: "incident-1",
      message: "No policy-safe unauthenticated retrieval path exists.",
      nextAction: "Approve or decline the provider data-access agreement."
    });
  });
});

describe("hourly dirty-worktree recovery", () => {
  const ownerRunId = "run-123";
  const ownerThreadId = "thread-123";
  const branch = "automation/hourly-20260713-120000";
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const provenance = buildHourlyImprovementRunProvenance({
    ownerRunId,
    ownerThreadId,
    branch,
    startingSha: headSha,
    plannedPaths: [
      "src/lib/automation/improvement.ts",
      "src/lib/automation/improvement.test.ts"
    ]
  });
  const checkpoints = buildImprovementCheckpoints({
    queueConfirmed: true,
    candidateSelected: true,
    provenanceRecorded: true
  });

  it("recognizes complete pre-edit provenance", () => {
    expect(hasCompletePreEditProvenance(provenance)).toBe(true);
  });

  it("keeps provenance incomplete until a real owner thread is recorded", () => {
    expect(
      hasCompletePreEditProvenance({
        ...provenance,
        ownerThreadId: null
      })
    ).toBe(false);
  });

  it("rejects planned paths that escape the repository", () => {
    expect(
      hasCompletePreEditProvenance({
        ...provenance,
        plannedPaths: ["../other-worktree/file.ts"]
      })
    ).toBe(false);
  });

  it("resumes only the immediately preceding unfinished owned paths", () => {
    expect(
      assessDirtyWorktreeRecovery({
        recoveryOfRunId: ownerRunId,
        currentOwnerThreadId: ownerThreadId,
        currentBranch: branch,
        currentHeadSha: headSha,
        dirtyPaths: ["src\\lib\\automation\\improvement.ts"],
        immediatelyPrevious: {
          isImmediatelyPreceding: true,
          completedAt: null,
          provenance,
          checkpoints
        }
      })
    ).toEqual({
      action: "resume_owned_work",
      ownerRunId
    });
  });

  it.each([
    {
      name: "a different branch",
      currentBranch: "automation/hourly-20260713-130000",
      currentHeadSha: headSha,
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      recoveryOfRunId: ownerRunId,
      isImmediatelyPreceding: true
    },
    {
      name: "a different HEAD",
      currentBranch: branch,
      currentHeadSha: "abcdef0123456789abcdef0123456789abcdef01",
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      recoveryOfRunId: ownerRunId,
      isImmediatelyPreceding: true
    },
    {
      name: "an unplanned path",
      currentBranch: branch,
      currentHeadSha: headSha,
      dirtyPaths: ["src/app/page.tsx"],
      recoveryOfRunId: ownerRunId,
      isImmediatelyPreceding: true
    },
    {
      name: "a non-immediate run",
      currentBranch: branch,
      currentHeadSha: headSha,
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      recoveryOfRunId: ownerRunId,
      isImmediatelyPreceding: false
    },
    {
      name: "an unclaimed owner run",
      currentBranch: branch,
      currentHeadSha: headSha,
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      recoveryOfRunId: "run-other",
      isImmediatelyPreceding: true
    },
    {
      name: "a different owner thread",
      currentBranch: branch,
      currentHeadSha: headSha,
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      recoveryOfRunId: ownerRunId,
      currentOwnerThreadId: "thread-other",
      isImmediatelyPreceding: true
    }
  ])("blocks $name", (input) => {
    const decision = assessDirtyWorktreeRecovery({
      recoveryOfRunId: input.recoveryOfRunId,
      currentOwnerThreadId: input.currentOwnerThreadId ?? ownerThreadId,
      currentBranch: input.currentBranch,
      currentHeadSha: input.currentHeadSha,
      dirtyPaths: input.dirtyPaths,
      immediatelyPrevious: {
        isImmediatelyPreceding: input.isImmediatelyPreceding,
        completedAt: null,
        provenance,
        checkpoints
      }
    });

    expect(decision.action).toBe("blocked_dirty_worktree");
  });

  it("blocks a run that already closed", () => {
    const decision = assessDirtyWorktreeRecovery({
      recoveryOfRunId: ownerRunId,
      currentOwnerThreadId: ownerThreadId,
      currentBranch: branch,
      currentHeadSha: headSha,
      dirtyPaths: ["src/lib/automation/improvement.ts"],
      immediatelyPrevious: {
        isImmediatelyPreceding: true,
        completedAt: "2026-07-13T12:30:00.000Z",
        provenance,
        checkpoints: markImprovementOutcomeRecorded(checkpoints)
      }
    });

    expect(decision).toMatchObject({ action: "blocked_dirty_worktree" });
  });
});

describe("hourly closeout audit", () => {
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  const completeAudit = {
    branch: "automation/hourly-20260713-120000",
    startingSha: "abcdef0123456789abcdef0123456789abcdef01",
    commitSha: headSha,
    pushResult: "origin/main parity 0 0",
    migration: "not required",
    deploymentId: "dpl_example",
    productionVerification: "Ready, aliases and production smoke verified",
    zipLocationsExplored: [],
    devicesExplored: [],
    routesExplored: [],
    scenariosExplored: [],
    errorLogFindings: [],
    feedbackDispositions: [],
    discordCoverage: "invite health only",
    missingCourseResearch: [],
    researchSources: [],
    rejectedCandidates: [],
    learning: [],
    changedBehavior: "Example improvement",
    measuredResult: "Focused verification passed",
    nextRotationTargets: [],
    blockers: []
  };

  it("accepts a complete successful audit", () => {
    expect(() =>
      validateHourlyCloseoutAudit({
        audit: completeAudit,
        outcome: "success",
        deploymentRequired: true,
        currentHeadSha: headSha
      })
    ).not.toThrow();
  });

  it("requires every owner-report audit field", () => {
    const incompleteAudit: Record<string, unknown> = { ...completeAudit };
    delete incompleteAudit.researchSources;

    expect(() =>
      validateHourlyCloseoutAudit({
        audit: incompleteAudit,
        outcome: "success",
        deploymentRequired: true,
        currentHeadSha: headSha
      })
    ).toThrow("researchSources");
  });

  it("requires parseable array fields for owner reporting", () => {
    expect(() =>
      validateHourlyCloseoutAudit({
        audit: { ...completeAudit, routesExplored: "search" },
        outcome: "success",
        deploymentRequired: true,
        currentHeadSha: headSha
      })
    ).toThrow("routesExplored must be an array");
  });

  it("requires the successful commit to identify HEAD", () => {
    expect(() =>
      validateHourlyCloseoutAudit({
        audit: { ...completeAudit, commitSha: "abcdef0" },
        outcome: "success",
        deploymentRequired: true,
        currentHeadSha: headSha
      })
    ).toThrow("checked-out HEAD");
  });
});
