import "./load-local-env";

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  closeHourlyImprovementRun,
  runWithHourlyImprovementLease,
  startAutomationRun,
  updateHourlyImprovementRunState
} from "@/lib/automation/db-service";
import {
  assessDirtyWorktreeRecovery,
  buildImprovementCheckpoints,
  buildHourlyImprovementRunProvenance,
  HOURLY_IMPROVEMENT_AUTOMATION_ID,
  isHourlyImprovementClaimWindowOpen,
  parseHourlyImprovementRunRecord,
  sanitizeAutomationText,
  validateAdapterRemediationCloseout,
  validateHourlyCloseoutAudit,
  validateHourlyRunCommitTopology,
  type HourlyImprovementRunRecord,
  type ImprovementCandidateInput,
  selectImprovementCandidate
} from "@/lib/automation/improvement";
import { escalateCourseSupportIncident } from "@/lib/automation/support-incidents";
import { startOfUtcCalendarDay } from "@/lib/automation/date-boundary";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-improvement-loop-v10";
const PROMPT_VERSION_PREFIX = "tee-time-spot-improvement-loop-v";
const ACTIVE_RUN_STALE_AFTER_MS = 55 * 60 * 1000;

const loopPrompt = `
You are improving Tee Time Spot, a Next.js + Postgres tee-time alert POC.

Every run:
1. Before edits, fetch \`origin/main\` and create a unique named branch such as \`automation/hourly-YYYYMMDD-HHmmss\` from \`origin/main\`. Never work or commit on \`main\`, and never remain detached. Then run \`npm run automation:preflight\`, require the clean task branch to be synchronized with \`origin/main\`, and record the starting SHA and reported \`git push origin HEAD:main\` command. Stop with blocked_dirty_worktree or blocked_git instead of touching unrelated work. A dirty checkout may be resumed only when the immediately preceding unfinished run for this exact automation recorded the same branch, expected HEAD, owner run, owner thread, and every dirty path in its pre-edit plan; otherwise block it.
2. After preflight passes, run \`npm install\` only when lockfile-declared dependencies are unavailable, then run \`npm run automation:inspect\` and read recent AutomationRun, CourseProbe, TeeTimeMatch, active TeeSearch, pending alert, WebsiteEvent, WebsiteFeedback, deployment, and recent Vercel log state.
3. Read recent AutomationRun notes and CourseAutomationDiscovery records as loop memory. Do not repeat a stale candidate unless new evidence changed.
4. Before browser exploration, set sessionStorage key \`tee-time-spot:traffic-class\` to \`AUTOMATION\` (or \`TEST\` only for an explicit manual test). Confirm analytics requests carry that aggregate marker. Never create a persistent visitor/session identifier, and never let unmarked automation traffic persist as public funnel activity.
5. Run \`npm run ui:smoke\` as a baseline desktop/mobile UI and access check. Treat legitimate failures as first-class candidates.
6. Confirm checkpoints: queue_confirmed, candidate_selected, provenance_recorded, tool_research_done, ui_smoke_done, verification_done, git_committed, git_pushed, production_verified, outcome_recorded. Keep outcome_recorded false until the same database write that sets completedAt and the terminal outcome.
7. Rank the highest-leverage evidence-backed improvements. Drain already-found pending alerts first, then treat every open CourseSupportIncident affecting an active search as urgent autonomous remediation ahead of exploratory product work. Prefer real-user blockers, alert failures, adapter gaps, funnel regressions, repeated feedback, and verified UI/access failures after those incidents. An empty initial queue is the nonterminal state exploration_required: broaden least-recently tested ZIP, device, route, feedback, course-coverage, accessibility, performance, security, metadata, and current-practice evidence until at least one safe valuable improvement or a concrete blocker is found. no_op is not an hourly outcome.
8. Before the first file edit, update this exact AutomationRun with the owner run/thread, branch, starting and expected HEAD SHA, exact planned paths, and provenance_recorded=true. If the plan expands, persist the added paths before editing them.
9. Implement every compatible selected improvement that can be completed safely as one coherent batch. An adapter-remediation candidate must be carried through provider discovery, reusable adapter implementation or conclusive direct-booking classification, focused tests, and an affected-search verification; do not stop at another unsupported observation. Add or update focused tests and behavior documentation. Preserve alert-only boundaries and never enter checkout, payment, login, captcha, or verification-code flows.
10. Use current official research or stronger design tools only when they materially change the selected implementation; do not perform generic hourly research.
11. Enter closeout no later than 40 minutes after the run starts or whenever only 20 minutes remain before the next scheduled launch. Start no new exploration or file edits after that point; reserve the closeout budget for verification, diff review, commit, rebase, push, deployment, production verification, and the durable final record. Never exit with unexplained residue.
12. Run focused verification plus \`npm run test:run\`, \`npm run lint\`, \`npm run build\`, \`npm run ui:smoke\`, and \`git diff --check\` for code changes.
13. Inspect the final diff, stage only files owned by this run, create one clear commit on the run's task branch, record its SHA, fetch and rebase onto current \`origin/main\` when needed, rerun affected verification, and fast-forward main with \`git push origin HEAD:main\`. Never check out or commit on \`main\`, force-push, or absorb unrelated changes.
14. For safe additive Prisma migrations, apply production migrations before the app deploy. Destructive or irreversible data work requires fresh user approval.
15. For live-impacting commits, let the verified \`git push origin HEAD:main\` trigger the only normal production deployment. Run \`npm run deployment:wait -- --sha <commitSha>\` to require the Git integration deployment for that exact commit, Ready state, and both production aliases; never follow a normal Git push with \`npx vercel --prod --yes\` because that creates a duplicate deployment. Then run \`$env:UI_SMOKE_BASE_URL="https://teetimespot.com"; npm run ui:smoke; Remove-Item Env:\\UI_SMOKE_BASE_URL\`, targeted route/API checks, and recent Vercel error-log inspection. Use a direct CLI production deploy only as an explicitly chosen recovery action.
16. If production verification fails because of this release, stop with incident. Roll back only when it is safe and no incompatible migration or irreversible state change exists.
17. Confirm the working tree is clean and the checked-out \`HEAD\` matches \`origin/main\` after the push.
18. Atomically close this exact AutomationRun with evidence, decision, changed files, tests, commit SHA, deployment ID, production verification, learning, blockers, terminal outcome, completedAt, and outcome_recorded=true. Update repo deployment notes only for material changes or deployments.

UI smoke expectations:
- The smoke must cover desktop and mobile.
- It must flag same-origin failed requests, 4xx/5xx responses, console errors, page errors, horizontal overflow, too-small interactive targets, broken typed-location discovery, broken 1-to-5 course ranking, disabled/enabled save-control mistakes, and unclear dashboard access/setup states.
- If the smoke finds a legitimate product issue, fix it and rerun the smoke instead of marking ui_smoke_done.
- If the smoke is blocked by missing browser binaries, provider env, auth, or network, fix that setup when authorized or stop with blocked_tooling, blocked_env, or blocked_auth and the exact unblock step.

Operational authority:
- You have broad access to make Tee Time Spot work end to end.
- You may create and configure project resources in Vercel, Neon, Clerk, Google Cloud/Places, Resend, Figma/Figma Make, v0, GitHub repo settings, monitoring tools, and replacement tools discovered during research.
- You may use already-authenticated browser sessions and CLI auth for Tee Time Spot project setup.
- You may update code, env examples, docs, database schema, seed data, deployment config, GitHub branches, and automation scripts.
- You are explicitly authorized to create a unique task branch for each run, create coherent commits on that branch, fast-forward \`origin/main\` with \`git push origin HEAD:main\`, apply safe additive migrations, and deploy verified live-impacting work to Vercel.
- Never commit secrets. Store credentials only in local env files, provider dashboards, GitHub/Vercel env vars, or the appropriate secret manager.
- Record created/updated accounts, projects, callback URLs, webhooks, deploy targets, and key names with secret values redacted.
- Prefer free tiers or already-approved plans. Paid upgrades, payment methods, legal commitments, production data deletion, ownership transfer, or domain purchases require fresh explicit user approval.
- If a service requires identity, billing, phone verification, captcha, or unavailable credentials, stop with blocked_auth, blocked_env, or needs_human and record the exact unblock step.

Tool research requirements:
- Look up current official docs or product pages before adopting a new design/automation tool.
- Compare at least two options when the current approach is weak or the UI smoke keeps finding the same class of issue.
- Prefer tools that can produce code or concrete design artifacts the repo can verify.

Loop engineering requirements:
- Use stable idempotency keys for notifications and external side effects.
- Acquire the short transaction-scoped initialization/state-update lease before selecting candidates, claiming paths, or closeout. It serializes those database transitions; the single unfinished owner AutomationRun is the durable rest-of-run guard. Treat an unfinished, non-stale run as blocked_concurrent.
- Never start implementation in a dirty or diverged checkout, never stage another task's files, and never force-push.
- Resume owned dirty work only under the exact immediately-preceding same-automation branch, owner-run, owner-thread, expected-HEAD, and planned-path provenance contract. Any mismatch is blocked_dirty_worktree.
- Maintain a living learning ledger in AutomationRun notes: open signals, stale repeated work, successful patterns, failed assumptions, research links, and next action.
- If the same non-incident course/tool/UI issue has been inspected repeatedly without new evidence, mark it stale or blocked and rotate to the next highest-signal improvement. Never stale or rotate away from an open adapter-remediation incident; resolve it, classify it, or prove a concrete blocker.
- Stop with a normalized terminal outcome: success, incident, needs_adapter, blocked_policy, blocked_auth, blocked_tooling, blocked_env, blocked_dirty_worktree, blocked_git, blocked_concurrent, or needs_human. exploration_required is nonterminal, and no_op is prohibited for this hourly workflow.

Adapter remediation requirements:
- Treat the incident as an engineering queue item, never as a request for the owner to research or implement provider support.
- Group courses by provider and build or extend reusable platform adapters instead of one-off course scrapers.
- Inspect current official booking and policy surfaces, then observe only public unauthenticated network behavior. Never use account sessions or bypass access controls.
- When retrieval is allowed, implement metadata discovery, normalized availability retrieval, booking-window evidence when available, focused adapter tests, and a focused runSearchCheck for the affected search before closeout.
- When retrieval is prohibited or no online booking exists, persist the evidence-backed direct-booking classification and resolve the incident so it does not requeue.
- needs_adapter is not a terminal closeout for an adapter-remediation candidate. Only needs_human after concrete automated attempts prove that one exact external action is unavoidable; include adapterRemediation audit evidence with the incident id, attempts, sources, result, and requiredExternalAction. That closeout is the only path that may notify the owner.

Hard boundaries:
- Alert only; never book, hold, pay, bypass controls, or solve account-specific course flows.
- Respect terms/policy blockers and mark courses blocked when automation is prohibited.
- Keep per-course observations separate.
- Only alert on newly matching slots.
`;

async function main() {
  const command = process.argv[2] ?? "prepare";
  const worker =
    command === "claim"
      ? claimImprovementRun
      : command === "closeout"
        ? closeoutImprovementRun
        : prepareImprovementRun;
  const lease = await runWithHourlyImprovementLease(worker);
  if (!lease.acquired) {
    console.warn(
      JSON.stringify(
        {
          outcome: "blocked_concurrent",
          reason:
            "Another hourly improvement initialization/state-update command currently holds the database lease."
        },
        null,
        2
      )
    );
    process.exitCode = 2;
  }
}

async function claimImprovementRun() {
  const args = process.argv.slice(3);
  const runId = requireOption(args, "--run-id");
  const ownerThreadId = resolveOwnerThreadId(args);
  if (!ownerThreadId) {
    throw new Error(
      "claim requires CODEX_THREAD_ID or an explicit --owner-thread value"
    );
  }

  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  const latest = await prisma.automationRun.findFirst({
    where: {
      promptVersion: { startsWith: PROMPT_VERSION_PREFIX },
      completedAt: null
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true }
  });
  const record = parseHourlyImprovementRunRecord(run?.notes);
  if (!run || run.completedAt || !record || latest?.id !== runId) {
    throw new Error("claim requires an active structured hourly AutomationRun");
  }
  if (!isHourlyImprovementClaimWindowOpen({ startedAt: run.startedAt })) {
    throw new Error(
      "claim window closed after 40 minutes; enter closeout without starting new edits"
    );
  }
  if (record.owner.threadId && record.owner.threadId !== ownerThreadId) {
    throw new Error("claim owner thread does not match the prepared hourly run");
  }

  const git = readGitRunState();
  if (
    git.branch !== record.provenance.branch ||
    git.headSha !== record.provenance.expectedHeadSha
  ) {
    throw new Error("claim branch or HEAD does not match prepared provenance");
  }

  const existingPaths = new Set(record.provenance.plannedPaths);
  const unownedDirtyPaths = git.dirtyPaths.filter((path) => !existingPaths.has(path));
  if (unownedDirtyPaths.length > 0) {
    throw new Error(
      `claim found dirty paths outside the prior plan: ${unownedDirtyPaths.join(", ")}`
    );
  }

  const requestedPaths = readOptions(args, "--path");
  if (requestedPaths.length === 0) {
    throw new Error("claim requires at least one repeated --path argument");
  }
  const candidateSummary = sanitizeAutomationString(
    readOption(args, "--candidate-summary") ?? ""
  );
  const candidate = candidateSummary
    ? {
        outcome: "success" as const,
        kind: "learning_followup" as const,
        summary: candidateSummary
      }
    : record.candidate;
  if (!candidate || candidate.kind === "exploration_required") {
    throw new Error(
      "an exploration_required handoff needs --candidate-summary before paths can be claimed"
    );
  }

  const provenance = buildHourlyImprovementRunProvenance({
    ownerRunId: runId,
    ownerThreadId,
    branch: record.provenance.branch,
    startingSha: record.provenance.startingSha,
    expectedHeadSha: record.provenance.expectedHeadSha,
    plannedPaths: [...existingPaths, ...requestedPaths]
  });
  const claimedRecord: HourlyImprovementRunRecord = {
    ...record,
    lifecycle: "candidate_selected",
    owner: {
      ...record.owner,
      threadId: ownerThreadId
    },
    provenance,
    candidate,
    checkpoints: {
      ...record.checkpoints,
      candidate_selected: true,
      provenance_recorded: true,
      outcome_recorded: false
    }
  };
  const updated = await updateHourlyImprovementRunState(runId, claimedRecord);
  if (!updated) {
    throw new Error("claim lost ownership because the hourly run already closed");
  }

  writeHandoff({
    automationRunId: runId,
    state: "claimed",
    ownerThreadId,
    plannedPaths: provenance.plannedPaths,
    checkpoints: claimedRecord.checkpoints
  });
}

type HourlyCloseoutPayload = {
  outcome: string;
  checkpoints?: Partial<HourlyImprovementRunRecord["checkpoints"]>;
  changedFiles?: string[];
  deploymentRequired?: boolean;
  audit?: Record<string, unknown>;
  blockerReasons?: string[];
  errors?: unknown;
};

async function closeoutImprovementRun() {
  const args = process.argv.slice(3);
  const runId = requireOption(args, "--run-id");
  const ownerThreadId = resolveOwnerThreadId(args);
  if (!ownerThreadId) {
    throw new Error(
      "closeout requires CODEX_THREAD_ID or an explicit --owner-thread value"
    );
  }
  const payload = readCloseoutPayload();
  const terminalOutcomes = new Set([
    "success",
    "incident",
    "needs_adapter",
    "blocked_policy",
    "blocked_auth",
    "blocked_tooling",
    "blocked_env",
    "blocked_dirty_worktree",
    "blocked_git",
    "blocked_concurrent",
    "needs_human"
  ]);
  if (!terminalOutcomes.has(payload.outcome)) {
    throw new Error(
      "closeout outcome must be terminal; no_op and exploration_required are not allowed"
    );
  }

  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  const latest = await prisma.automationRun.findFirst({
    where: {
      promptVersion: { startsWith: PROMPT_VERSION_PREFIX },
      completedAt: null
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true }
  });
  const record = parseHourlyImprovementRunRecord(run?.notes);
  if (!run || run.completedAt || !record || latest?.id !== runId) {
    throw new Error("closeout requires an active structured hourly AutomationRun");
  }
  if (
    record.owner.threadId !== ownerThreadId ||
    record.provenance.ownerThreadId !== ownerThreadId
  ) {
    throw new Error("closeout owner thread does not match durable provenance");
  }

  validateCheckpointUpdate(payload.checkpoints, record.checkpoints);
  const claimedChangedFiles = normalizePaths(payload.changedFiles ?? []);
  const git = readGitRunState();
  let committedPaths: string[] = [];
  let commitTopologyError: string | null = null;
  if (git.headSha !== record.provenance.startingSha) {
    const [, ...parentShas] = runGit(["rev-list", "--parents", "-n", "1", "HEAD"])
      .split(/\s+/)
      .filter(Boolean);
    const startingShaIsAncestorOfParent =
      parentShas.length === 1 &&
      runGit(["merge-base", record.provenance.startingSha, parentShas[0]]) ===
        record.provenance.startingSha;

    try {
      validateHourlyRunCommitTopology({
        startingSha: record.provenance.startingSha,
        headSha: git.headSha,
        parentShas,
        startingShaIsAncestorOfParent
      });
      committedPaths = normalizePaths(
        runGit([
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "HEAD"
        ]).split(/\r?\n/)
      );
    } catch (error) {
      commitTopologyError =
        error instanceof Error ? error.message : "Owner commit topology could not be verified";
    }
  }
  const actualStatePaths = normalizePaths([...committedPaths, ...git.dirtyPaths]);
  const plannedPaths = new Set(record.provenance.plannedPaths);
  const unplannedChanges = actualStatePaths.filter((path) => !plannedPaths.has(path));

  const checkpoints = {
    ...record.checkpoints,
    ...(payload.checkpoints ?? {}),
    outcome_recorded: false
  };
  const sanitizedBlockerReasons = sanitizeStringArray(payload.blockerReasons ?? []);
  if (payload.outcome === "success") {
    const requiredCheckpoints = [
      "queue_confirmed",
      "candidate_selected",
      "provenance_recorded",
      "tool_research_done",
      "ui_smoke_done",
      "verification_done",
      "git_committed",
      "git_pushed"
    ] as const;
    const missingCheckpoints: string[] = requiredCheckpoints.filter(
      (checkpoint) => !checkpoints[checkpoint]
    );
    if (payload.deploymentRequired !== false && !checkpoints.production_verified) {
      missingCheckpoints.push("production_verified");
    }
    if (missingCheckpoints.length > 0) {
      throw new Error(
        `successful closeout is missing checkpoints: ${missingCheckpoints.join(", ")}`
      );
    }
    if (record.provenance.startingSha === git.headSha) {
      throw new Error("successful hourly closeout requires a real committed diff");
    }
    if (commitTopologyError) {
      throw new Error(commitTopologyError);
    }
    if (committedPaths.length === 0) {
      throw new Error("successful hourly closeout requires a non-empty owner commit");
    }
    if (!sameStringSet(claimedChangedFiles, committedPaths)) {
      throw new Error(
        "successful closeout changedFiles must exactly match the Git-derived committed paths"
      );
    }
    if (unplannedChanges.length > 0) {
      throw new Error(
        `Git-derived changes were not claimed before editing: ${unplannedChanges.join(", ")}`
      );
    }
    if (
      git.branch !== record.provenance.branch ||
      git.dirtyPaths.length > 0 ||
      git.aheadOfOriginMain !== 0 ||
      git.behindOriginMain !== 0
    ) {
      throw new Error(
        "successful closeout requires a clean tree with HEAD matching origin/main"
      );
    }
  } else if (sanitizedBlockerReasons.length === 0) {
    throw new Error("a blocked or incident closeout requires blockerReasons");
  }

  const sanitizedAudit = sanitizeCloseoutAudit(payload.audit ?? {});
  const remediationEscalation = validateAdapterRemediationCloseout({
    candidate: record.candidate,
    outcome: payload.outcome,
    evidence: sanitizedAudit.adapterRemediation
  });
  if (commitTopologyError) {
    sanitizedBlockerReasons.push(`Owner commit verification failed: ${commitTopologyError}`);
  }
  if (unplannedChanges.length > 0) {
    sanitizedBlockerReasons.push(
      `Unplanned checkout residue at closeout: ${unplannedChanges.join(", ")}`
    );
  }
  const audit: Record<string, unknown> = {
    ...(record.audit ?? {}),
    ...sanitizedAudit,
    branch: record.provenance.branch,
    startingSha: record.provenance.startingSha,
    committedPaths,
    dirtyPathsAtCloseout: git.dirtyPaths,
    unplannedResidue: unplannedChanges,
    blockers:
      payload.outcome === "success"
        ? (sanitizedAudit.blockers ?? [])
        : sanitizedBlockerReasons,
    deploymentRequired: payload.deploymentRequired ?? true
  };
  validateHourlyCloseoutAudit({
    audit,
    outcome: payload.outcome,
    deploymentRequired: payload.deploymentRequired ?? true,
    currentHeadSha: git.headSha
  });

  const closeoutRecord: HourlyImprovementRunRecord = {
    ...record,
    lifecycle: payload.outcome === "success" ? "closeout" : "blocked",
    checkpoints,
    blocker:
      payload.outcome === "success"
        ? undefined
        : {
            outcome: payload.outcome,
            reasons: sanitizedBlockerReasons
          },
    audit
  };
  const closed = await closeHourlyImprovementRun(runId, {
    outcome: payload.outcome,
    record: closeoutRecord,
    changedFiles: actualStatePaths as never,
    errors: sanitizeCloseoutErrors(payload.errors) as never
  });
  if (!closed) {
    throw new Error("closeout lost ownership because the hourly run already closed");
  }
  if (remediationEscalation.escalate) {
    await escalateCourseSupportIncident({
      incidentId: remediationEscalation.incidentId,
      message: remediationEscalation.message,
      nextAction: remediationEscalation.nextAction
    });
  }

  writeHandoff({
    automationRunId: runId,
    outcome: payload.outcome,
    checkpoints: {
      ...checkpoints,
      outcome_recorded: true
    }
  });
}

async function prepareImprovementRun() {
  const git = readGitRunState();
  const ownerThreadId = resolveOwnerThreadId(process.argv.slice(2));
  const previous = await prisma.automationRun.findFirst({
    where: {
      promptVersion: {
        startsWith: PROMPT_VERSION_PREFIX
      }
    },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }]
  });
  const previousRecord = parseHourlyImprovementRunRecord(previous?.notes);
  const previousActiveAgeMs =
    previous && previous.completedAt === null
      ? Date.now() - previous.startedAt.getTime()
      : null;
  const requestedRecoveryRunId = readOption(
    process.argv.slice(2),
    "--recover-run"
  );

  if (git.dirtyPaths.length > 0) {
    const exactSameThreadRecoveryClaim = Boolean(
      previous &&
        previousRecord &&
        requestedRecoveryRunId === previous.id &&
        ownerThreadId &&
        ownerThreadId === previousRecord.provenance.ownerThreadId
    );
    if (
      previous &&
      previous.completedAt === null &&
      previousActiveAgeMs !== null &&
      previousActiveAgeMs < ACTIVE_RUN_STALE_AFTER_MS &&
      !exactSameThreadRecoveryClaim
    ) {
      writeHandoff({
        automationRunId: previous.id,
        state: "blocked_concurrent",
        reason:
          "The immediately preceding hourly run still owns the dirty checkout inside its active lease window."
      });
      process.exitCode = 2;
      return;
    }

    const recovery = assessDirtyWorktreeRecovery({
      recoveryOfRunId: requestedRecoveryRunId,
      currentOwnerThreadId: ownerThreadId,
      currentBranch: git.branch,
      currentHeadSha: git.headSha,
      dirtyPaths: git.dirtyPaths,
      immediatelyPrevious:
        previous && previousRecord
          ? {
              isImmediatelyPreceding: true,
              completedAt: previous.completedAt?.toISOString() ?? null,
              provenance: previousRecord.provenance,
              checkpoints: previousRecord.checkpoints
            }
          : null
    });

    if (recovery.action === "resume_owned_work" && previous && previousRecord) {
      const resumedRecord: HourlyImprovementRunRecord = {
        ...previousRecord,
        lifecycle: "editing",
        owner: {
          runId: previous.id,
          threadId: ownerThreadId,
          recoveryOfRunId: previous.id
        }
      };
      await updateHourlyImprovementRunState(previous.id, resumedRecord);
      writeHandoff({
        automationRunId: previous.id,
        state: "resume_owned_work",
        checkpoints: resumedRecord.checkpoints,
        candidate: resumedRecord.candidate
      });
      return;
    }

    if (previous && previous.completedAt === null && previousRecord) {
      const reasons =
        recovery.action === "blocked_dirty_worktree"
          ? recovery.reasons
          : ["The working tree is dirty before candidate selection."];
      const blockedRecord: HourlyImprovementRunRecord = {
        ...previousRecord,
        lifecycle: "blocked",
        blocker: {
          outcome: "blocked_dirty_worktree",
          reasons
        }
      };
      await closeHourlyImprovementRun(previous.id, {
        outcome: "blocked_dirty_worktree",
        record: blockedRecord,
        changedFiles: git.dirtyPaths as never,
        errors: {
          code: "DIRTY_RECOVERY_MISMATCH",
          reasons: sanitizeStringArray(reasons)
        }
      });
      writeHandoff({
        automationRunId: previous.id,
        state: "blocked_dirty_worktree",
        blocker: blockedRecord.blocker,
        outcomeRecorded: true,
        nextAction:
          "Resolve the recorded checkout residue before the next hourly run; this owner run is terminal and cannot be resumed."
      });
      process.exitCode = 2;
      return;
    }

    const blockedRun = await startAutomationRun(PROMPT_VERSION);
    const blockedRecord = buildRunRecord({
      runId: blockedRun.id,
      ownerThreadId,
      git,
      lifecycle: "blocked",
      checkpoints: buildImprovementCheckpoints({
        queueConfirmed: false,
        candidateSelected: false
      }),
      blocker: {
        outcome: "blocked_dirty_worktree",
        reasons:
          recovery.action === "blocked_dirty_worktree"
            ? recovery.reasons
            : ["The working tree is dirty before candidate selection."]
      }
    });
    await closeHourlyImprovementRun(blockedRun.id, {
      outcome: "blocked_dirty_worktree",
      record: blockedRecord,
      errors: {
        code: "UNOWNED_DIRTY_WORKTREE",
        reasons: blockedRecord.blocker?.reasons ?? []
      }
    });
    writeHandoff({
      automationRunId: blockedRun.id,
      state: "blocked_dirty_worktree",
      checkpoints: {
        ...blockedRecord.checkpoints,
        outcome_recorded: true
      },
      blocker: blockedRecord.blocker
    });
    process.exitCode = 2;
    return;
  }

  if (previous && previous.completedAt === null) {
    if (
      previousActiveAgeMs !== null &&
      previousActiveAgeMs < ACTIVE_RUN_STALE_AFTER_MS
    ) {
      writeHandoff({
        automationRunId: previous.id,
        state: "blocked_concurrent",
        reason: "The immediately preceding hourly run is still active."
      });
      process.exitCode = 2;
      return;
    }

    const interruptedRecord = previousRecord ??
      buildRunRecord({
        runId: previous.id,
        ownerThreadId: null,
        git,
        lifecycle: "blocked",
        checkpoints: buildImprovementCheckpoints({
          queueConfirmed: false,
          candidateSelected: false
        })
      });
    interruptedRecord.blocker = {
      outcome: "blocked_env",
      reasons: [
        "The prior hourly run exceeded the 55-minute lease window without closeout and left no resumable dirty work."
      ]
    };
    await closeHourlyImprovementRun(previous.id, {
      outcome: "blocked_env",
      record: interruptedRecord,
      errors: {
        code: "INTERRUPTED_WITHOUT_CLOSEOUT"
      }
    });
  }

  if (
    !git.branch.startsWith("automation/hourly-") ||
    git.aheadOfOriginMain !== 0 ||
    git.behindOriginMain !== 0
  ) {
    const blockedRun = await startAutomationRun(PROMPT_VERSION);
    const reasons = [
      ...(!git.branch.startsWith("automation/hourly-")
        ? ["The checkout is not on a named automation/hourly-* task branch."]
        : []),
      ...(git.aheadOfOriginMain !== 0 || git.behindOriginMain !== 0
        ? [
            `HEAD and origin/main are not synchronized (${git.aheadOfOriginMain} ahead, ${git.behindOriginMain} behind).`
          ]
        : [])
    ];
    const blockedRecord = buildRunRecord({
      runId: blockedRun.id,
      ownerThreadId,
      git,
      lifecycle: "blocked",
      checkpoints: buildImprovementCheckpoints({
        queueConfirmed: false,
        candidateSelected: false
      }),
      blocker: {
        outcome: "blocked_git",
        reasons
      }
    });
    await closeHourlyImprovementRun(blockedRun.id, {
      outcome: "blocked_git",
      record: blockedRecord,
      errors: {
        code: "INVALID_HOURLY_BRANCH_STATE",
        reasons
      }
    });
    writeHandoff({
      automationRunId: blockedRun.id,
      state: "blocked_git",
      blocker: blockedRecord.blocker
    });
    process.exitCode = 2;
    return;
  }

  const run = await startAutomationRun(PROMPT_VERSION);
  let record = buildRunRecord({
    runId: run.id,
    ownerThreadId,
    git,
    lifecycle: "prepared",
    checkpoints: buildImprovementCheckpoints({
      queueConfirmed: false,
      candidateSelected: false
    })
  });
  await updateHourlyImprovementRunState(run.id, record);

  try {
    const snapshot = await loadImprovementSnapshot();
    const candidate = selectImprovementCandidate(snapshot);
    const checkpoints = buildImprovementCheckpoints({
      queueConfirmed: true,
      candidateSelected: candidate.kind !== "exploration_required"
    });
    record = {
      ...record,
      lifecycle:
        candidate.kind === "exploration_required"
          ? "exploration_required"
          : "candidate_selected",
      checkpoints,
      candidate,
      snapshot: {
        activeSearchCount: snapshot.activeSearchCount,
        pendingAlertCount: snapshot.pendingAlerts.length,
        actionableProbeCount:
          snapshot.actionableProbes.length + (snapshot.supportIncidents?.length ?? 0),
        learningSignalCount: snapshot.learningSignals?.length ?? 0
      },
      nextPrompt: buildNextPrompt(run.id)
    };
    await updateHourlyImprovementRunState(run.id, record);
    writeHandoff({
      automationRunId: run.id,
      state: candidate.outcome,
      checkpoints,
      candidate,
      nextPrompt: record.nextPrompt
    });
  } catch (error) {
    record = {
      ...record,
      lifecycle: "blocked",
      blocker: {
        outcome: "blocked_env",
        reasons: ["Hourly improvement preparation failed before candidate handoff."]
      }
    };
    await closeHourlyImprovementRun(run.id, {
      outcome: "blocked_env",
      record,
      errors: serializeAutomationError(error)
    });
    throw error;
  }
}

function buildRunRecord(input: {
  runId: string;
  ownerThreadId: string | null;
  git: GitRunState;
  lifecycle: HourlyImprovementRunRecord["lifecycle"];
  checkpoints: HourlyImprovementRunRecord["checkpoints"];
  blocker?: HourlyImprovementRunRecord["blocker"];
}): HourlyImprovementRunRecord {
  return {
    schemaVersion: 1,
    automationId: HOURLY_IMPROVEMENT_AUTOMATION_ID,
    promptVersion: PROMPT_VERSION,
    lifecycle: input.lifecycle,
    owner: {
      runId: input.runId,
      threadId: input.ownerThreadId
    },
    provenance: buildHourlyImprovementRunProvenance({
      ownerRunId: input.runId,
      ownerThreadId: input.ownerThreadId,
      branch: input.git.branch,
      startingSha: input.git.headSha
    }),
    checkpoints: input.checkpoints,
    blocker: input.blocker
  };
}

type GitRunState = {
  branch: string;
  headSha: string;
  dirtyPaths: string[];
  aheadOfOriginMain: number;
  behindOriginMain: number;
};

function readGitRunState(): GitRunState {
  const dirtyPaths = new Set<string>();
  for (const args of [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"]
  ]) {
    for (const path of runGit(args).split(/\r?\n/)) {
      if (path.trim()) {
        dirtyPaths.add(path.trim().replaceAll("\\", "/"));
      }
    }
  }

  const [aheadOfOriginMain, behindOriginMain] = runGit([
    "rev-list",
    "--left-right",
    "--count",
    "HEAD...origin/main"
  ])
    .split(/\s+/)
    .map(Number);

  return {
    branch: runGit(["branch", "--show-current"]),
    headSha: runGit(["rev-parse", "HEAD"]),
    dirtyPaths: [...dirtyPaths].sort((left, right) => left.localeCompare(right)),
    aheadOfOriginMain,
    behindOriginMain
  };
}

function runGit(args: string[]) {
  return execFileSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function buildNextPrompt(runId: string) {
  return [
    `Use AutomationRun ${runId} as the sole durable owner/lease for this hourly run.`,
    `Before editing, claim exact paths with: npm run automation:improve -- claim --run-id ${runId} --path <repo-relative-path> [--path <another-path>] [--candidate-summary "<selected evidence-backed candidate>"] [--owner-thread <CODEX thread id>].`,
    `At terminal closeout, pipe one JSON object to: npm run automation:improve -- closeout --run-id ${runId} [--owner-thread <CODEX thread id>]. The JSON must contain outcome, boolean checkpoints, changedFiles, deploymentRequired, blockerReasons/errors when blocked, and the full structured owner-audit fields listed in docs/codex-automation-loop.md. The command derives committed/dirty paths from Git, redacts and bounds audit/error values, adds branch/start SHA, and atomically writes completedAt and outcome_recorded=true.`,
    loopPrompt.trim()
  ].join("\n\n");
}

function readOption(args: string[], name: string) {
  const index = args.lastIndexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value.trim() : undefined;
}

function requireOption(args: string[], name: string) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptions(args: string[], name: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (value && !value.startsWith("--")) {
      values.push(value.trim());
    }
  }
  return values.filter(Boolean);
}

function resolveOwnerThreadId(args: string[]) {
  return readOption(args, "--owner-thread") ?? process.env.CODEX_THREAD_ID?.trim() ?? null;
}

function readCloseoutPayload(): HourlyCloseoutPayload {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) {
    throw new Error("closeout requires one JSON object on stdin");
  }

  const parsed = JSON.parse(raw) as HourlyCloseoutPayload;
  if (!parsed || typeof parsed !== "object" || typeof parsed.outcome !== "string") {
    throw new Error("closeout stdin must be a JSON object with an outcome");
  }
  return parsed;
}

function normalizePaths(paths: string[]) {
  return [...new Set(paths.map((path) => path.trim().replaceAll("\\", "/")).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function sameStringSet(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCheckpointUpdate(
  update: HourlyCloseoutPayload["checkpoints"],
  current: HourlyImprovementRunRecord["checkpoints"]
) {
  if (!update) {
    return;
  }
  const allowed = new Set(Object.keys(current));
  for (const [key, value] of Object.entries(update)) {
    if (!allowed.has(key) || typeof value !== "boolean") {
      throw new Error(`closeout checkpoint ${key} must be a known boolean field`);
    }
  }
}

const CLOSEOUT_AUDIT_FIELDS = new Set([
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
  "adapterRemediation",
  "nextRotationTargets"
]);

function sanitizeCloseoutAudit(input: Record<string, unknown>) {
  const unknownFields = Object.keys(input).filter(
    (field) => !CLOSEOUT_AUDIT_FIELDS.has(field)
  );
  if (unknownFields.length > 0) {
    throw new Error(`closeout audit contains unsupported fields: ${unknownFields.join(", ")}`);
  }

  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      sanitizeAutomationValue(value, key, 0)
    ])
  );
}

function sanitizeCloseoutErrors(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return { message: sanitizeAutomationString(String(value)) };
  }

  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    ["name", "code", "message", "reasons"]
      .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
      .map((key) => [key, sanitizeAutomationValue(source[key], key, 0)])
  );
}

function sanitizeStringArray(values: string[]) {
  return values.slice(0, 100).map(sanitizeAutomationString).filter(Boolean);
}

function sanitizeAutomationValue(value: unknown, key: string, depth: number): unknown {
  if (/token|secret|password|authorization|cookie|signature|idempotency/i.test(key)) {
    return "[redacted]";
  }
  if (depth >= 6) {
    return "[truncated]";
  }
  if (typeof value === "string") {
    return sanitizeAutomationString(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => sanitizeAutomationValue(item, key, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, childValue]) => [
          childKey,
          sanitizeAutomationValue(childValue, childKey, depth + 1)
        ])
    );
  }
  return String(value).slice(0, 200);
}

function sanitizeAutomationString(value: string) {
  return sanitizeAutomationText(value).slice(0, 2_000);
}

function serializeAutomationError(error: unknown) {
  const name = error instanceof Error ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = sanitizeAutomationString(rawMessage).slice(0, 1_000);

  return { name, message };
}

function writeHandoff(value: object) {
  console.warn(JSON.stringify(value, null, 2));
}

async function loadImprovementSnapshot(): Promise<ImprovementCandidateInput> {
  const recentSince = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const today = startOfUtcCalendarDay();

  const [
    activeSearchCount,
    pendingAlerts,
    probes,
    openSupportIncidents,
    recentRuns,
    recentDiscoveries
  ] = await Promise.all([
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        date: {
          gte: today
        }
      }
    }),
    prisma.teeTimeMatch.findMany({
      where: {
        alertStatus: "PENDING",
        teeSearch: {
          status: "ACTIVE"
        }
      },
      orderBy: {
        firstSeenAt: "asc"
      },
      take: 10,
      include: {
        course: true
      }
    }),
    prisma.courseProbe.findMany({
      where: {
        observedAt: {
          gte: recentSince
        },
        outcome: {
          in: [
            "BLOCKED_POLICY",
            "BLOCKED_AUTH",
            "BLOCKED_TOOLING",
            "FETCH_FAILED",
            "NEEDS_ADAPTER"
          ]
        }
      },
      orderBy: {
        observedAt: "desc"
      },
      take: 25,
      include: {
        course: true
      }
    }),
    prisma.courseSupportIncident.findMany({
      where: {
        status: { not: "RESOLVED" },
        course: {
          preferences: {
            some: {
              teeSearch: {
                status: "ACTIVE",
                date: { gte: today }
              }
            }
          }
        }
      },
      orderBy: [{ affectedSearchCount: "desc" }, { firstSeenAt: "asc" }],
      include: { course: true }
    }),
    prisma.automationRun.findMany({
      orderBy: {
        startedAt: "desc"
      },
      take: 12
    }),
    prisma.courseAutomationDiscovery.findMany({
      orderBy: {
        createdAt: "desc"
      },
      take: 25,
      include: {
        course: true
      }
    })
  ]);

  const incidentCourseIds = new Set(openSupportIncidents.map((incident) => incident.courseId));
  const probeCandidates = latestProbePerCourseSearch(probes).flatMap((probe) => {
    const outcome = probe.outcome;
    if (
      incidentCourseIds.has(probe.courseId) ||
      probe.course.automationEligibility === "BLOCKED" ||
      !isActionableProbeOutcome(outcome)
    ) {
      return [];
    }

    return [
      {
        id: probe.id,
        outcome,
        courseName: probe.course.name,
        platform: probe.course.detectedPlatform,
        observedAt: probe.observedAt.toISOString(),
        message: probe.message
      }
    ];
  });

  return {
    activeSearchCount,
    pendingAlerts: pendingAlerts.map((alert) => ({
      id: alert.id,
      courseName: alert.course.name,
      firstSeenAt: alert.firstSeenAt.toISOString()
    })),
    supportIncidents: openSupportIncidents.map((incident) => ({
      id: incident.id,
      status:
        incident.status === "NEEDS_HUMAN" ? "NEEDS_HUMAN" : "AUTO_INVESTIGATING",
      kind: incident.kind,
      courseName: incident.course.name,
      platform: incident.course.detectedPlatform,
      lastSeenAt: incident.lastSeenAt.toISOString(),
      message:
        incident.latestMessage ??
        incident.initialMessage ??
        "Course monitoring incident remains unresolved."
    })),
    actionableProbes: probeCandidates,
    learningSignals: buildLearningSignals(recentRuns, recentDiscoveries)
  };
}

function buildLearningSignals(
  recentRuns: Array<{
    outcome: string | null;
    notes: string | null;
    startedAt: Date;
  }>,
  recentDiscoveries: Array<{
    status: string;
    detectedPlatform: string;
    confidence: number;
    bookingUrl: string | null;
    createdAt: Date;
    course: {
      name: string;
    };
  }>
) {
  const signals = new Map<
    string,
    {
      key: string;
      kind: "adapter_gap" | "ui_smoke" | "provider_config" | "tooling" | "research";
      summary: string;
      lastSeenAt: string;
      repeats: number;
      nextAction?: string;
      status?: "open" | "learned" | "blocked" | "stale";
    }
  >();

  for (const discovery of recentDiscoveries) {
    if (discovery.status !== "INSPECTED") {
      continue;
    }

    const key = `adapter:${discovery.course.name}`;
    const existing = signals.get(key);
    signals.set(key, {
      key,
      kind: "adapter_gap",
      summary: `${discovery.course.name} browser probe inspected ${discovery.bookingUrl ?? "course site"} but did not learn reusable ${discovery.detectedPlatform} metadata.`,
      lastSeenAt: latestIso(existing?.lastSeenAt, discovery.createdAt),
      repeats: (existing?.repeats ?? 0) + 1,
      status: (existing?.repeats ?? 0) + 1 >= 2 ? "stale" : "open",
      nextAction:
        (existing?.repeats ?? 0) + 1 >= 2
          ? "Do not rerun the same probe until a new booking URL, platform clue, or policy source appears."
          : "Inspect current official booking surface and policy evidence."
    });
  }

  for (const run of recentRuns) {
    const notes = run.notes ?? "";
    if (/ui smoke/i.test(notes) && /fail|failed|blocked/i.test(notes)) {
      const key = "ui_smoke:recent_failure";
      const existing = signals.get(key);
      signals.set(key, {
        key,
        kind: "ui_smoke",
        summary: "Recent UI smoke failure or blockage should be reviewed before polish work.",
        lastSeenAt: latestIso(existing?.lastSeenAt, run.startedAt),
        repeats: (existing?.repeats ?? 0) + 1,
        status: "open",
        nextAction: "Inspect trace/screenshot evidence, fix the root cause, and rerun smoke."
      });
    }

    if (/research|best practice|compare|current tool/i.test(notes)) {
      const key = "research:recent_strategy";
      const existing = signals.get(key);
      signals.set(key, {
        key,
        kind: "research",
        summary: "Recent loop used external research; verify whether it produced a measurable product change.",
        lastSeenAt: latestIso(existing?.lastSeenAt, run.startedAt),
        repeats: (existing?.repeats ?? 0) + 1,
        status: "open",
        nextAction: "Record the research source, decision, shipped change, or reason it was rejected."
      });
    }
  }

  return [...signals.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

function latestIso(current: string | undefined, next: Date) {
  const nextIso = next.toISOString();
  if (!current || nextIso > current) {
    return nextIso;
  }

  return current;
}

function isActionableProbeOutcome(
  outcome: string
): outcome is ImprovementCandidateInput["actionableProbes"][number]["outcome"] {
  return (
    outcome === "BLOCKED_POLICY" ||
    outcome === "BLOCKED_AUTH" ||
    outcome === "BLOCKED_TOOLING" ||
    outcome === "FETCH_FAILED" ||
    outcome === "NEEDS_ADAPTER"
  );
}

function latestProbePerCourseSearch<
  T extends {
    teeSearchId: string;
    courseId: string;
  }
>(probes: T[]) {
  const latest = new Map<string, T>();

  for (const probe of probes) {
    const key = `${probe.teeSearchId}:${probe.courseId}`;
    if (!latest.has(key)) {
      latest.set(key, probe);
    }
  }

  return [...latest.values()];
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
