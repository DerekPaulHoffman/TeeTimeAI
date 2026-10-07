import { describe, expect, it } from "vitest";

import {
  assessCourseSupportContinuationCheckpoint, confirmCourseSupportContinuationSent,
  buildCourseSupportContinuationRequest, projectCourseSupportNativeCompletion,
  projectCourseSupportContinuationReadiness,
  COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, readCourseSupportContinuationLedger,
  reserveCourseSupportContinuationReceipt,
  type CourseSupportContinuationCheckpoint,
} from "./course-support-continuation";

const now = new Date("2026-10-07T08:01:00.000Z");
const releaseSha = "a".repeat(40);
const child = "original-native-child";
const checkpoint: CourseSupportContinuationCheckpoint = {
  kind: "SETTLED_FAILURE", observedAt: "2026-10-07T08:00:00.000Z", readCount: 1,
  requestId: null, failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" },
  allowedResearchRouteCount: 1, providerReadInFlight: false,
};
function input() {
  return {
    assignmentRef: "original-assignment", childThreadId: child, parentThreadId: "current-orchestrator",
    sourceFingerprint: "b".repeat(64), currentMainSha: releaseSha,
    currentSource: true, originalPrivateChild: true, checkpoint, ledger: undefined,
    tickAlreadyUsed: false, now,
    nativeCompletion: { version: 1, source: "codex_app.wait_threads", threadId: child,
      observedAt: now.toISOString(), cursor: "cursor:1", threadStatus: "notLoaded",
      latestTurn: { id: "completed-native-turn", status: "completed", error: null },
      activeTurnId: null, approvalRequestCount: 0 },
    readiness: { version: 1, source: "original_native_launcher_receipt", threadId: child,
      observedAt: now.toISOString(), launcherReceiptDigest: "c".repeat(64), checkoutIdentityDigest: "d".repeat(64),
      privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access",
      nativeIdentityVerified: true, noApprovalRequired: true, sameProfile: true, runtimeReady: true,
      toolingReleaseSha: releaseSha },
  };
}
function reserved(value: Parameters<typeof reserveCourseSupportContinuationReceipt>[0] = input()) {
  const result = reserveCourseSupportContinuationReceipt(value);
  expect(result.reserved).toBe(true);
  if (!result.reserved) throw new Error(result.reason);
  return result;
}
function delivered(value: ReturnType<typeof reserved>) {
  return confirmCourseSupportContinuationSent({ ledger: value.ledger, key: value.receipt.key,
    parentThreadId: "current-orchestrator", childThreadId: child, now,
    toolReceipt: { source: "codex_app.send_message_to_thread", threadId: child, accepted: true } });
}

describe("bounded same-original-native-worker continuation", () => {
  it("accepts a completed latest turn even when thread metadata is not loaded", () => {
    const result = reserved();
    expect(result.receipt).toMatchObject({ status: "PENDING", childThreadId: child,
      parentThreadId: "current-orchestrator", scope: "RESUME_ALLOWED_RESEARCH", attempt: 1,
      policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION });
  });

  it("rejects database RUNNING alone, missing latest turn, live turns and approval requests", () => {
    for (const changed of [
      { source: "database", status: "RUNNING" },
      { ...input().nativeCompletion, latestTurn: undefined },
      { ...input().nativeCompletion, latestTurn: { id: "live", status: "inProgress", error: null } },
      { ...input().nativeCompletion, latestTurn: { id: "failed", status: "completed", error: "unknown" } },
      { ...input().nativeCompletion, activeTurnId: "other-active-turn" },
      { ...input().nativeCompletion, approvalRequestCount: 1 },
      { ...input().nativeCompletion, threadStatus: "notLoaded", latestTurn: null },
    ]) expect(reserveCourseSupportContinuationReceipt({ ...input(), nativeCompletion: changed })).toMatchObject({ reserved: false });
  });

  it("requires fresh exact original identity, private checkout, profile and current tooling", () => {
    for (const changed of [
      { ...input().readiness, threadId: "replacement-child" },
      { ...input().readiness, privateOriginalChild: false },
      { ...input().readiness, sameProfile: false },
      { ...input().readiness, approvalPolicy: "on-request" },
      { ...input().readiness, toolingReleaseSha: "e".repeat(40) },
      { ...input().readiness, runtimeReady: false },
      { ...input().readiness, observedAt: "2026-10-07T07:58:59.000Z" },
    ]) expect(reserveCourseSupportContinuationReceipt({ ...input(), readiness: changed })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), currentSource: false })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), originalPrivateChild: false })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), nativeCompletion: {
      ...input().nativeCompletion, observedAt: "2026-10-07T08:01:01.000Z",
    } })).toMatchObject({ reserved: false });
  });

  it("keeps unknown, programming, database, ownership, access and budget failures in attention", () => {
    for (const category of ["UNKNOWN", "TOOLING", "DATABASE", "OWNERSHIP", "SOURCE", "ACCESS", "BUDGET", "BROWSER", "CAPACITY"] as const) {
      expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: { ...checkpoint,
        failure: { stage: "PUBLIC_READ", category, code: "UNCLASSIFIED_FAILURE" },
      } })).toMatchObject({ reserved: false, reason: "FAILURE_REQUIRES_ATTENTION" });
    }
    for (const changed of [
      { ...checkpoint, providerReadInFlight: true }, { ...checkpoint, readCount: 6 },
      { ...checkpoint, allowedResearchRouteCount: 0 },
      { ...checkpoint, failure: { stage: "PUBLIC_READ" as const, category: "NETWORK" as const, code: "UNREVIEWED_NETWORK_CODE" } },
    ]) expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: changed })).toMatchObject({ reserved: false });
  });

  it("permits one diagnostic-only legacy recovery only after an exact Ready reviewed tooling release", () => {
    const legacy = { ...checkpoint, kind: "EXPIRED_UNFINISHED_READ" as const, requestId: "original-request", failure: null };
    const repair = { policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, releaseSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"],
      deployedAt: "2026-10-07T07:59:00.000Z" };
    expect(assessCourseSupportContinuationCheckpoint({ checkpoint: legacy, currentMainSha: releaseSha, now })).toMatchObject({ eligible: false });
    expect(assessCourseSupportContinuationCheckpoint({ checkpoint: legacy, currentMainSha: releaseSha, now,
      reviewedToolingRepair: { ...repair, releaseSha: "f".repeat(40) } })).toMatchObject({ eligible: false });
    const result = reserved({ ...input(), checkpoint: legacy, reviewedToolingRepair: repair } as Parameters<typeof reserveCourseSupportContinuationReceipt>[0]);
    expect(result.receipt.scope).toBe("DIAGNOSE_REVIEWED_TOOLING_UPDATE");
    const later = { ...input(), ledger: delivered(result), checkpoint: { ...legacy, observedAt: "2026-10-07T08:12:00.000Z" },
      now: new Date("2026-10-07T08:12:01.000Z"), reviewedToolingRepair: repair };
    later.nativeCompletion = { ...later.nativeCompletion, observedAt: later.now.toISOString(), latestTurn: { id: "second-native-turn", status: "completed", error: null } };
    later.readiness = { ...later.readiness, observedAt: later.now.toISOString() };
    expect(reserveCourseSupportContinuationReceipt(later)).toMatchObject({ reserved: false, reason: "CONTINUATION_BUDGET_EXHAUSTED" });
  });

  it("keeps a located unknown browser failure in attention after a reviewed tooling release", () => {
    const repair = { policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, releaseSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"],
      deployedAt: "2026-10-07T07:59:00.000Z" };
    for (const researchPhase of ["BROWSER_LAUNCH", "BROWSER_NAVIGATION"] as const) {
      const located: CourseSupportContinuationCheckpoint = { ...checkpoint,
        failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase },
      };
      expect(assessCourseSupportContinuationCheckpoint({ checkpoint: located, currentMainSha: releaseSha, now,
        reviewedToolingRepair: repair })).toMatchObject({ eligible: false, reason: "FAILURE_REQUIRES_ATTENTION" });
      expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: located,
        reviewedToolingRepair: repair })).toMatchObject({ reserved: false, reason: "FAILURE_REQUIRES_ATTENTION" });
    }
  });

  it("never retries an ambiguous message, and rejects a send receipt for another child", () => {
    const result = reserved();
    expect(reserveCourseSupportContinuationReceipt({ ...input(), ledger: result.ledger })).toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    expect(() => confirmCourseSupportContinuationSent({ ledger: result.ledger, key: result.receipt.key,
      parentThreadId: "current-orchestrator", childThreadId: child, now,
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: "replacement-child", accepted: true },
    })).toThrow();
    expect(() => confirmCourseSupportContinuationSent({ ledger: result.ledger, key: result.receipt.key,
      parentThreadId: "another-parent", childThreadId: child, now,
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: child, accepted: true },
    })).toThrow();
    expect(delivered(result).receipts[0].status).toBe("SENT");
  });

  it("does not turn fresh wait metadata or changed guide counts into another attempt", () => {
    const result = reserved();
    const refreshed = input();
    refreshed.nativeCompletion = { ...refreshed.nativeCompletion, cursor: "cursor:2", observedAt: "2026-10-07T08:01:30.000Z" };
    expect(reserveCourseSupportContinuationReceipt({ ...refreshed, now: new Date("2026-10-07T08:01:30.000Z"),
      checkpoint: { ...checkpoint, allowedResearchRouteCount: 3 }, ledger: delivered(result),
    })).toMatchObject({ reserved: false, reason: "CHECKPOINT_ALREADY_REQUESTED" });
  });

  it("allows at most two different checkpoints per source and one continuation per tick", () => {
    const first = reserved();
    const nextInput = { ...input(), now: new Date("2026-10-07T08:12:00.000Z"), ledger: delivered(first),
      checkpoint: { ...checkpoint, readCount: 2, observedAt: "2026-10-07T08:11:00.000Z" },
    };
    nextInput.nativeCompletion = { ...nextInput.nativeCompletion, observedAt: nextInput.now.toISOString(), latestTurn: { id: "second-turn", status: "completed", error: null } };
    nextInput.readiness = { ...nextInput.readiness, observedAt: nextInput.now.toISOString() };
    expect(reserveCourseSupportContinuationReceipt({ ...nextInput, tickAlreadyUsed: true })).toMatchObject({ reserved: false, reason: "TICK_CONTINUATION_BUDGET_EXHAUSTED" });
    const second = reserved(nextInput);
    const ledger = confirmCourseSupportContinuationSent({ ledger: second.ledger, key: second.receipt.key,
      parentThreadId: "current-orchestrator", childThreadId: child, now: nextInput.now,
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: child, accepted: true },
    });
    expect(reserveCourseSupportContinuationReceipt({ ...nextInput, ledger, now: new Date("2026-10-07T08:22:00.000Z"),
      checkpoint: { ...nextInput.checkpoint, readCount: 3, observedAt: "2026-10-07T08:21:00.000Z" },
      nativeCompletion: { ...nextInput.nativeCompletion, observedAt: "2026-10-07T08:22:00.000Z", latestTurn: { id: "third-turn", status: "completed", error: null } },
      readiness: { ...nextInput.readiness, observedAt: "2026-10-07T08:22:00.000Z" },
    })).toMatchObject({ reserved: false, reason: "CONTINUATION_BUDGET_EXHAUSTED" });
  });

  it("fails closed on malformed or duplicate durable continuation receipts", () => {
    expect(() => readCourseSupportContinuationLedger({ version: 1, receipts: [{}] })).toThrow();
    const receipt = reserved().receipt;
    expect(() => readCourseSupportContinuationLedger({ version: 1, receipts: [receipt, receipt] })).toThrow();
  });

  it("refuses a ninth historical receipt instead of writing an invalid bounded audit", () => {
    const receipt = reserved().receipt;
    const ledger = { version: 1, receipts: Array.from({ length: 8 }, (_, index) => ({ ...receipt,
      key: index.toString(16).repeat(64), sourceFingerprint: (Math.floor(index / 2) + 1).toString(16).repeat(64),
      attempt: index % 2 + 1, status: "SENT", sentAt: now.toISOString(),
    })) };
    expect(readCourseSupportContinuationLedger(ledger).receipts).toHaveLength(8);
    expect(reserveCourseSupportContinuationReceipt({ ...input(), ledger })).toMatchObject({
      reserved: false, reason: "CONTINUATION_HISTORY_BOUND_EXCEEDED" });
  });
});

const checkout = "C:/Users/Example/.codex/worktrees/original-worker/TeeTimeAI";
function observedInput() {
  const original = { schemaVersion: 1, status: "COMPLETED", threadId: child, cwd: checkout,
    branch: "automation/course-support-original", baseSha: "e".repeat(40),
    nativeIdentityVerified: true, approvalRequests: 0, approvalPolicy: "never",
    sandbox: { type: "dangerFullAccess" }, activePermissionProfile: { id: ":danger-full-access" },
    turnStatus: "completed", launcherPid: 100, serverPid: 101 };
  return { launcherReceiptBytes: JSON.stringify(original), expectedThreadId: child, expectedCheckout: checkout,
    expectedBranch: original.branch, expectedOriginalBaseSha: original.baseSha, observedAt: now.toISOString(), now,
    nativeSnapshot: { cursor: "real-cursor:8", thread: { id: child, hostId: "local", status: { type: "notLoaded" } },
      latestTurn: { id: "real-completed-turn", status: "completed", error: null }, latestToolMarker: null },
    processObservation: { observedAt: now.toISOString(), processes: [{ pid: 100, state: "absent" }, { pid: 101, state: "absent" }] },
    runtimeObservation: { checkout, observedAt: now.toISOString(), browserSmoke: { checkout, observedAt: now.toISOString(), status: "current" },
      inspection: { mode: "inspect", observedAt: now.toISOString(), runtime: { status: "available", nodeVersion: "v22.14.0", npmVersion: "10.9.2" },
        client: { status: "current" }, browser: { moduleAvailable: true, executableAvailable: true, smoke: "not_run" },
        guards: { ownCurrentCheckout: true, nativeIdentityPresent: true, linkedWorktree: true, namedWorkerBranch: true,
          atLocalOriginMain: false, clean: true, selectedCheckoutDistinct: true, sameRepository: true, bindingMatches: true, dependenciesPrivate: true } } },
    upstreamObservation: { observedAt: now.toISOString(), originalBaseSha: original.baseSha, originMainSha: releaseSha, ancestorExitCode: 0 },
    toolingDeploymentProof: { source: "git", state: "READY", branch: "main", commitSha: releaseSha, deploymentId: "dpl-example",
      deploymentUrl: "https://example.vercel.app", aliases: ["teetimespot.com", "www.teetimespot.com"], deployedAt: "2026-10-07T08:00:00.000Z" },
    reviewedToolingDiagnosis: true,
  };
}

describe("deterministic projection of observed native continuation evidence", () => {
  it("projects the actual notLoaded/completed poll and ended private launcher with independently proved newer tooling", () => {
    const result = buildCourseSupportContinuationRequest(observedInput());
    expect(result.nativeCompletion).toMatchObject({ threadStatus: "notLoaded", latestTurn: { id: "real-completed-turn", status: "completed", error: null } });
    expect(result.readiness).toMatchObject({ runtimeReady: true, toolingReleaseSha: releaseSha, sameProfile: true });
    expect(result.reviewedToolingRepair?.releaseSha).toBe(releaseSha);
    expect(result.readiness.launcherReceiptDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(checkout);
  });

  it("rejects active, missing completed evidence, another native task and pending approvals", () => {
    const original = observedInput().nativeSnapshot;
    for (const snapshot of [
      { ...original, thread: { ...original.thread, status: { type: "active" } } },
      { ...original, latestTurn: null },
      { ...original, thread: { ...original.thread, id: "another-native-task" } },
      { ...original, pendingApproval: { id: "approval" } },
      { ...original, latestTurn: { ...original.latestTurn, error: { code: "error" } } },
      { ...original, thread: { ...original.thread, status: { type: "idle", activeFlags: ["waitingOnApproval"] } } },
      { ...original, latestToolMarker: { status: "completed" } },
    ]) expect(() => projectCourseSupportNativeCompletion({ snapshot, expectedThreadId: child, observedAt: now.toISOString(), now })).toThrow();
  });

  it("accepts the observed failed command marker only for its exact completed native turn", () => {
    const original = observedInput().nativeSnapshot;
    const marker = { id: "exec-11111111-2222-4333-8444-555555555555", turnId: original.latestTurn.id,
      type: "commandExecution", name: "commandExecution", status: "failed" };
    expect(projectCourseSupportNativeCompletion({ snapshot: { ...original, latestToolMarker: marker },
      expectedThreadId: child, observedAt: now.toISOString(), now })).toMatchObject({
      latestTurn: { id: original.latestTurn.id, status: "completed", error: null }, activeTurnId: null });
    for (const altered of [
      { ...marker, turnId: "another-turn" }, { ...marker, status: "inProgress" },
      { ...marker, status: "pending" }, { ...marker, status: "completed" },
      { ...marker, type: "unknownTool" }, { ...marker, name: "otherExecution" },
      { ...marker, id: "unknown-marker-id" }, { ...marker, approvalRequired: true },
    ]) expect(() => projectCourseSupportNativeCompletion({ snapshot: { ...original, latestToolMarker: altered },
      expectedThreadId: child, observedAt: now.toISOString(), now })).toThrow();
  });

  it("rejects a wrong launcher profile, owner, checkout or still-running original process", () => {
    const original = observedInput();
    const receipt = JSON.parse(original.launcherReceiptBytes);
    for (const altered of [
      { ...receipt, approvalPolicy: "on-request" }, { ...receipt, activePermissionProfile: { id: "other-profile" } },
      { ...receipt, nativeIdentityVerified: false }, { ...receipt, approvalRequests: 1 },
      { ...receipt, cwd: "C:/dev/TeeTimeAI" }, { ...receipt, threadId: "replacement-task" },
    ]) expect(() => projectCourseSupportContinuationReadiness({ ...original, launcherReceiptBytes: JSON.stringify(altered) })).toThrow();
    expect(() => projectCourseSupportContinuationReadiness({ ...original, processObservation: { observedAt: now.toISOString(),
      processes: [{ pid: 100, state: "absent" }, { pid: 101, state: "present" }] } })).toThrow();
  });

  it("rejects unavailable browser, private client, semantic binding and unobserved smoke", () => {
    const original = observedInput();
    const runtime = original.runtimeObservation;
    for (const altered of [
      { ...runtime, inspection: { ...runtime.inspection, client: { status: "stale" } } },
      { ...runtime, inspection: { ...runtime.inspection, guards: { ...runtime.inspection.guards, bindingMatches: false } } },
      { ...runtime, inspection: { ...runtime.inspection, guards: { ...runtime.inspection.guards, dependenciesPrivate: false } } },
      { ...runtime, browserSmoke: { ...runtime.browserSmoke, status: "not_run" } },
      { ...runtime, browserSmoke: undefined },
    ]) expect(() => projectCourseSupportContinuationReadiness({ ...original, runtimeObservation: altered })).toThrow();
  });

  it("rejects stale observations or unverified ancestry/current main/production aliases", () => {
    const original = observedInput();
    for (const changed of [
      { ...original, observedAt: "2026-10-07T07:58:00.000Z" },
      { ...original, upstreamObservation: { ...original.upstreamObservation, ancestorExitCode: 1 } },
      { ...original, upstreamObservation: { ...original.upstreamObservation, originMainSha: "f".repeat(40) } },
      { ...original, toolingDeploymentProof: { ...original.toolingDeploymentProof, aliases: ["teetimespot.com"] } },
      { ...original, toolingDeploymentProof: { ...original.toolingDeploymentProof, source: "cli" } },
    ]) expect(() => buildCourseSupportContinuationRequest(changed)).toThrow();
  });
});
