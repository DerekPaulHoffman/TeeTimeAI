import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assessCourseSupportContinuationCheckpoint, confirmCourseSupportContinuationSent,
  buildCourseSupportContinuationRequest, projectCourseSupportNativeCompletion,
  projectCourseSupportContinuationReadiness,
  projectCourseSupportInventoryNativeCompletion, COURSE_SUPPORT_INVENTORY_COMPLETION_SOURCE,
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
  it("identifies an expired owned implementation stage without renewing its immutable checkpoint", () => {
    const stage: CourseSupportContinuationCheckpoint = { ...checkpoint, kind: "EXPIRED_OWNED_STAGE",
      failure: null, requestId: null, readCount: 0, allowedResearchRouteCount: 0, claimLeaseExpired: true,
      ownedStage: { phase: "IMPLEMENTING", claimedAt: "2026-10-07T07:30:00.000Z", plannedPaths: ["src/lib/simulators/provider.ts"],
        releaseSha: null, deployment: null, recheckQueuedAt: null, verificationCycle: 0,
        sourceFingerprint: input().sourceFingerprint, originalSourceFingerprint: input().sourceFingerprint,
        offeringRevision: 1, branch: "automation/course-support-original" } };
    const assessment = assessCourseSupportContinuationCheckpoint({ checkpoint: stage, currentMainSha: releaseSha, now });
    expect(assessment).toMatchObject({ eligible: true, scope: "RESUME_ORIGINAL_OWNED_STAGE" });
    expect(assessCourseSupportContinuationCheckpoint({ checkpoint: { ...stage, claimLeaseExpired: false },
      currentMainSha: releaseSha, now })).toMatchObject({ eligible: false });
    expect(assessCourseSupportContinuationCheckpoint({ checkpoint: { ...stage, providerReadInFlight: true },
      currentMainSha: releaseSha, now })).toMatchObject({ eligible: false });
    const stageDigest = assessment.eligible ? assessment.checkpointDigest : "";
    const terminal = { version: 1, source: "codex_app.list_threads+codex_native.terminal_turn",
      threadId: child, observedAt: now.toISOString(), threadStatus: "notLoaded", hostId: "local", projectId: "project", inventoryUpdatedAt: 1,
      launcherReceiptDigest: "c".repeat(64), checkoutIdentityDigest: "d".repeat(64), observationDigest: "e".repeat(64),
      latestTurn: { id: "stopped-native-turn", status: "failed", error: { message: "native failure" } } };
    const readiness = { ...input().readiness, source: "original_native_stopped_launcher_receipt",
      originalTurnId: "stopped-native-turn", ownedStageDigest: stageDigest };
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stage })).toMatchObject({ reserved: false });
    const first = reserved({ ...input(), checkpoint: stage, nativeCompletion: terminal, readiness });
    expect(first.receipt.scope).toBe("RESUME_ORIGINAL_OWNED_STAGE");
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stage, nativeCompletion: terminal,
      readiness, ledger: delivered(first) })).toMatchObject({ reserved: false,
        reason: "ORIGINAL_NATIVE_TURN_LINEAGE_UNPROVED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stage, nativeCompletion: terminal, readiness, ledger: first.ledger }))
      .toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    const secondTurn = "second-native-turn";
    const priorReceiptPath = "C:\\private\\continuation.receipt.private.json";
    const sent = confirmCourseSupportContinuationSent({ ledger: first.ledger, key: first.receipt.key,
      parentThreadId: "current-orchestrator", childThreadId: child, now,
      toolReceipt: { source: "codex_native.turn_start", threadId: child, turnId: secondTurn,
        receiptPath: priorReceiptPath, accepted: true } });
    const later = { ...input(), now: new Date("2026-10-07T08:11:00.000Z"), checkpoint: stage,
      ledger: sent, readiness: { ...readiness, observedAt: "2026-10-07T08:11:00.000Z" },
      nativeCompletion: { ...terminal, observedAt: "2026-10-07T08:11:00.000Z",
        priorContinuationTurnId: secondTurn, priorContinuationKey: first.receipt.key,
        priorContinuationReceiptDigest: "f".repeat(64), latestTurn: { id: secondTurn, status: "interrupted", error: null } } };
    expect(reserveCourseSupportContinuationReceipt(later)).toMatchObject({ reserved: true,
      receipt: { attempt: 2, scope: "RESUME_ORIGINAL_OWNED_STAGE" } });
    expect(reserveCourseSupportContinuationReceipt({ ...later, nativeCompletion: terminal }))
      .toMatchObject({ reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" });
  });
  it("permits one different-route diagnosis for the recorded transport script cap after a newer release", () => {
    const capped: CourseSupportContinuationCheckpoint = { ...checkpoint, readCount: 2,
      requestId: "11111111-2222-4333-8444-555555555555", claimLeaseExpired: true, researchOnlyClaim: true,
      failure: { stage: "PUBLIC_READ", category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchPhase: "HTTP_READ",
        researchResourceKind: "SECONDARY_SCRIPT", sourceLocation: "src/lib/automation/address-pinned-public-fetch.ts:49" } };
    const repair = { policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, releaseSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"], deployedAt: "2026-10-07T08:00:30.000Z" };
    const first = reserved({ ...input(), checkpoint: capped, reviewedToolingRepair: repair });
    expect(first.receipt.scope).toBe("DIAGNOSE_REVIEWED_TOOLING_UPDATE");
    for (const changed of [
      { ...capped, claimLeaseExpired: false }, { ...capped, researchOnlyClaim: false }, { ...capped, requestId: null },
      { ...capped, readCount: 6 }, { ...capped, allowedResearchRouteCount: 0 }, { ...capped, providerReadInFlight: true },
      ...[undefined, "BROWSER_REQUEST", "BROWSER_DOCUMENT"].map(researchPhase => ({ ...capped, failure: { ...capped.failure!, researchPhase } })),
      ...[undefined, "MAIN_DOCUMENT", "XHR_OR_FETCH", "SECONDARY_STYLESHEET"].map(researchResourceKind => ({ ...capped, failure: { ...capped.failure!, researchResourceKind } })),
      ...[undefined, "src/lib/automation/address-pinned-public-fetch.ts:50", "src/lib/automation/simulator-support-research.ts:517"].map(sourceLocation => ({ ...capped, failure: { ...capped.failure!, sourceLocation } })),
      { ...capped, failure: { ...capped.failure!, category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" } },
    ]) expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: changed as CourseSupportContinuationCheckpoint,
      reviewedToolingRepair: repair })).toMatchObject({ reserved: false });
    for (const deployedAt of ["2026-10-07T07:59:00.000Z", capped.observedAt, "2026-10-07T08:02:00.000Z"]) {
      expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: capped, reviewedToolingRepair: { ...repair, deployedAt } })).toMatchObject({ reserved: false });
    }
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: capped })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: capped, currentSource: false, reviewedToolingRepair: repair })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: capped, ledger: first.ledger, reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: capped, ledger: delivered(first), reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false, reason: "CHECKPOINT_ALREADY_REQUESTED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: { ...capped, readCount: 3, requestId: "22222222-2222-4333-8444-555555555555" },
      ledger: delivered(first), nativeCompletion: { ...input().nativeCompletion, latestTurn: { id: "later", status: "completed", error: null } }, reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false, reason: "CONTINUATION_BUDGET_EXHAUSTED" });
  });
  it("permits one different-route stylesheet diagnosis only after a newer reviewed release and expired research claim", () => {
    const stylesheet: CourseSupportContinuationCheckpoint = { ...checkpoint, requestId: "11111111-2222-4333-8444-555555555555",
      claimLeaseExpired: true, researchOnlyClaim: true,
      failure: { stage: "PUBLIC_READ", category: "ACCESS", code: "UNSAFE_PUBLIC_URL", researchResourceKind: "SECONDARY_STYLESHEET" } };
    const repair = { policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION, releaseSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"],
      deployedAt: "2026-10-07T08:00:30.000Z" };
    const first = reserved({ ...input(), checkpoint: stylesheet, reviewedToolingRepair: repair });
    expect(first.receipt.scope).toBe("DIAGNOSE_REVIEWED_TOOLING_UPDATE");
    for (const changed of [
      { ...stylesheet, claimLeaseExpired: false }, { ...stylesheet, claimLeaseExpired: undefined },
      { ...stylesheet, researchOnlyClaim: false }, { ...stylesheet, requestId: null },
      { ...stylesheet, readCount: 6 }, { ...stylesheet, allowedResearchRouteCount: 0 },
      { ...stylesheet, providerReadInFlight: true },
      ...[undefined, "SECONDARY_SCRIPT", "MAIN_DOCUMENT", "XHR_OR_FETCH", "UNKNOWN"].map(researchResourceKind => ({ ...stylesheet,
        failure: { ...stylesheet.failure!, researchResourceKind } })),
      { ...stylesheet, failure: { ...stylesheet.failure!, code: "UNCLASSIFIED_FAILURE" } },
    ]) expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: changed as CourseSupportContinuationCheckpoint,
      reviewedToolingRepair: repair })).toMatchObject({ reserved: false });
    for (const deployedAt of ["2026-10-07T07:59:00.000Z", stylesheet.observedAt, "2026-10-07T08:02:00.000Z"]) {
      expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stylesheet, reviewedToolingRepair: { ...repair, deployedAt } }))
        .toMatchObject({ reserved: false });
    }
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stylesheet })).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stylesheet, currentSource: false, reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stylesheet, ledger: first.ledger, reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: stylesheet, ledger: delivered(first), reviewedToolingRepair: repair }))
      .toMatchObject({ reserved: false, reason: "CHECKPOINT_ALREADY_REQUESTED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: { ...stylesheet, readCount: 2, requestId: "22222222-2222-4333-8444-555555555555" },
      ledger: delivered(first), nativeCompletion: { ...input().nativeCompletion, latestTurn: { id: "later", status: "completed", error: null } },
      reviewedToolingRepair: repair })).toMatchObject({ reserved: false, reason: "CONTINUATION_BUDGET_EXHAUSTED" });
  });
  it("resumes one expired settled public read without relabeling it as a failure or replaying its checkpoint", () => {
    const settled: CourseSupportContinuationCheckpoint = { ...checkpoint, kind: "EXPIRED_SETTLED_PUBLIC_READ", failure: null,
      requestId: "11111111-2222-4333-8444-555555555555", publicReadEvidence: { sourceFingerprint: input().sourceFingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP", httpStatus: 200 } };
    const first = reserved({ ...input(), checkpoint: settled });
    expect(first.receipt.scope).toBe("RESUME_ALLOWED_RESEARCH");
    expect(reserveCourseSupportContinuationReceipt({ ...input(), sourceFingerprint: "e".repeat(64), checkpoint: settled })).toMatchObject({ reserved: false, reason: "ORIGINAL_SOURCE_OR_OWNER_NOT_CURRENT" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: settled, ledger: delivered(first),
      nativeCompletion: { ...input().nativeCompletion, latestTurn: { id: "later-completed-turn", status: "completed", error: null } },
    })).toMatchObject({ reserved: false, reason: "CHECKPOINT_ALREADY_REQUESTED" });
    for (const changed of [
      { ...settled, publicReadEvidence: undefined }, { ...settled, readCount: 6 }, { ...settled, allowedResearchRouteCount: 0 },
      { ...settled, providerReadInFlight: true }, { ...settled, observedAt: "2026-10-07T07:00:00.000Z" },
      { ...settled, failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" } },
      { ...settled, publicReadEvidence: { ...settled.publicReadEvidence!, accessControls: ["ACCOUNT_REQUIRED" as const] } },
      { ...settled, publicReadEvidence: { ...settled.publicReadEvidence!, method: "BROWSER" as const, renderComplete: false } },
    ]) expect(assessCourseSupportContinuationCheckpoint({ checkpoint: changed, currentMainSha: releaseSha, now })).toMatchObject({ eligible: false });
  });
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

function inventoryInput() {
  const { nativeSnapshot, ...original } = observedInput();
  const receipt = { ...JSON.parse(original.launcherReceiptBytes), cliVersion: "codex-cli 0.160.1" };
  const launcherReceiptBytes = JSON.stringify(receipt);
  const receiptDigest = createHash("sha256").update(launcherReceiptBytes).digest("hex");
  const thread = { id: child, kind: "codex", hostId: "local", projectId: "original-project",
    cwd: checkout, status: "notLoaded", updatedAt: 1791359940 };
  const snapshot = { schemaVersion: 4, pinnedThreads: [], threads: [thread], unavailableHosts: [], unavailableSources: [] };
  const processes = [{ pid: 100, state: "absent" }, { pid: 101, state: "absent" }];
  return { ...original, launcherReceiptBytes, nativeInventoryObservation: {
    expectedProjectId: "original-project",
    inventoryBefore: { source: "codex_app.list_threads", observedAt: "2026-10-07T08:00:58.000Z", snapshot: structuredClone(snapshot) },
    inventoryAfter: { source: "codex_app.list_threads", observedAt: "2026-10-07T08:00:59.500Z", snapshot: structuredClone(snapshot) },
    nativeObservation: { version: 1, source: "original_codex_read_only_observer", phase: "READ_ONLY_OBSERVATION_COMPLETE",
      observedAt: "2026-10-07T08:00:58.100Z", finishedAt: "2026-10-07T08:00:59.000Z", threadId: child,
      cliVersion: "codex-cli 0.160.1", cliExecutableDigest: "9e7c59c05cc1ce5677b1f94e835b2ac038ca3be14504e78d558eacdb0ea3f55d",
      launcherReceiptDigestBefore: receiptDigest, launcherReceiptDigestAfter: receiptDigest, observerApprovalRequestCount: 0,
      processObservationBefore: { observedAt: "2026-10-07T08:00:58.200Z", processes: structuredClone(processes) },
      processObservationAfter: { observedAt: "2026-10-07T08:00:58.800Z", processes: structuredClone(processes) },
      rpcCalls: [
        { method: "initialize", params: { clientInfo: { name: "course_support_worker_launcher", version: "1.0" }, capabilities: { experimentalApi: true } }, result: {} },
        { method: "permissionProfile/list", params: { cwd: checkout }, result: { data: [{ id: ":danger-full-access", allowed: true }] } },
        { method: "thread/read", params: { threadId: child, includeTurns: false }, result: { thread: {
          id: child, cwd: checkout, updatedAt: thread.updatedAt, projectId: null, status: { type: "notLoaded" },
          ephemeral: false, cliVersion: "0.160.1", turns: [] } } },
        { method: "thread/turns/list", params: { threadId: child, limit: 1, itemsView: "notLoaded", sortDirection: "desc" }, result: {
          data: [{ id: nativeSnapshot.latestTurn.id, status: "completed", error: null, itemsView: "notLoaded", items: [] }],
          nextCursor: "actual-older-history-cursor", backwardsCursor: "actual-reverse-cursor" } },
      ],
    },
  } };
}
function inventoryProjection(value = inventoryInput()) {
  return projectCourseSupportInventoryNativeCompletion({ ...value.nativeInventoryObservation,
    launcherReceiptBytes: value.launcherReceiptBytes, expectedThreadId: child, expectedCheckout: checkout, now: value.now });
}

describe("bracketed supported inventory and read-only durable native history", () => {
  it("accepts a completed original native turn when its owned implementation remains unresolved", () => {
    const value = inventoryInput();
    const initialTurn = "11111111-2222-7333-8444-555555555555";
    const original = { ...JSON.parse(value.launcherReceiptBytes), status: "COMPLETED", turnStatus: "completed", turnId: initialTurn };
    value.launcherReceiptBytes = JSON.stringify(original);
    const native = value.nativeInventoryObservation.nativeObservation;
    Object.assign(native, { terminalFailure: true });
    native.launcherReceiptDigestBefore = createHash("sha256").update(value.launcherReceiptBytes).digest("hex");
    native.launcherReceiptDigestAfter = native.launcherReceiptDigestBefore;
    const turn = (native.rpcCalls[3].result as { data: Array<Record<string, unknown>> }).data[0];
    Object.assign(turn, { id: initialTurn, status: "completed", error: null });
    const owned: CourseSupportContinuationCheckpoint = { ...checkpoint, kind: "EXPIRED_OWNED_STAGE", failure: null,
      requestId: null, readCount: 0, allowedResearchRouteCount: 0, claimLeaseExpired: true,
      ownedStage: { phase: "VERIFYING", claimedAt: "2026-10-07T07:30:00.000Z",
        plannedPaths: ["src/lib/simulators/provider.ts"], releaseSha: "b".repeat(40), deployment: null,
        recheckQueuedAt: null, verificationCycle: 0, sourceFingerprint: input().sourceFingerprint,
        originalSourceFingerprint: input().sourceFingerprint, offeringRevision: 1, branch: original.branch } };
    Object.assign(value.runtimeObservation.inspection.guards, { clean: false, nativeIdentityPresent: false });
    const request = buildCourseSupportContinuationRequest({ ...value, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"] });
    expect(request.nativeCompletion).toMatchObject({ source: "codex_app.list_threads+codex_native.terminal_turn",
      latestTurn: { id: initialTurn, status: "completed", error: null } });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: owned, ...request })).toMatchObject({ reserved: true });
    Object.assign(turn, { error: { message: "failed" } });
    expect(() => buildCourseSupportContinuationRequest({ ...value, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"] })).toThrow();
  });
  it("projects a stopped owned implementation only from an exact terminal native turn and registered dirty paths", () => {
    const value = inventoryInput();
    const turnId = "11111111-2222-7333-8444-555555555555";
    const stopped = { ...JSON.parse(value.launcherReceiptBytes), status: "STOPPED", turnStatus: undefined, turnId };
    value.launcherReceiptBytes = JSON.stringify(stopped);
    const native = value.nativeInventoryObservation.nativeObservation;
    Object.assign(native, { terminalFailure: true });
    native.launcherReceiptDigestBefore = createHash("sha256").update(value.launcherReceiptBytes).digest("hex");
    native.launcherReceiptDigestAfter = native.launcherReceiptDigestBefore;
    const turn = (native.rpcCalls[3].result as { data: Array<Record<string, unknown>> }).data[0];
    Object.assign(turn, { id: turnId, status: "failed", error: { message: "native failed" } });
    const owned: CourseSupportContinuationCheckpoint = { ...checkpoint, kind: "EXPIRED_OWNED_STAGE", failure: null,
      requestId: null, readCount: 0, allowedResearchRouteCount: 0, claimLeaseExpired: true,
      ownedStage: { phase: "IMPLEMENTING", claimedAt: "2026-10-07T07:30:00.000Z", plannedPaths: ["src/lib/simulators/provider.ts"],
        releaseSha: null, deployment: null, recheckQueuedAt: null, verificationCycle: 0,
        sourceFingerprint: input().sourceFingerprint, originalSourceFingerprint: input().sourceFingerprint,
        offeringRevision: 1, branch: stopped.branch } };
    const runtime = value.runtimeObservation;
    Object.assign(runtime.inspection.guards, { clean: false, nativeIdentityPresent: false });
    const request = buildCourseSupportContinuationRequest({ ...value, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"], expectedClaim: { token: "11111111-2222-4333-8444-555555555555", revision: 7 } });
    expect(request.nativeCompletion).toMatchObject({ source: "codex_app.list_threads+codex_native.terminal_turn",
      latestTurn: { id: turnId, status: "failed" } });
    expect(request.readiness).toMatchObject({ source: "original_native_stopped_launcher_receipt", originalTurnId: turnId });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), checkpoint: owned, ...request })).toMatchObject({ reserved: true });
    const repeated = structuredClone(value);
    const priorTurnId = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff";
    const prior = { turnId: priorTurnId, key: "f".repeat(64), receiptPath: "C:\\private\\continuation.receipt.private.json" };
    const repeatedNative = repeated.nativeInventoryObservation.nativeObservation;
    const repeatedTurn = (repeatedNative.rpcCalls[3].result as { data: Array<Record<string, unknown>> }).data[0];
    Object.assign(repeatedTurn, { id: priorTurnId, status: "interrupted", error: null });
    Object.assign(repeatedNative, { priorContinuationTurnId: priorTurnId, priorContinuationKey: prior.key,
      priorContinuationReceiptPath: prior.receiptPath, priorContinuationReceiptDigestBefore: "a".repeat(64),
      priorContinuationReceiptDigestAfter: "a".repeat(64) });
    for (const observed of [repeatedNative.processObservationBefore, repeatedNative.processObservationAfter]) {
      observed.processes.push({ pid: 303, state: "absent" }, { pid: 304, state: "absent" });
    }
    const resumed = buildCourseSupportContinuationRequest({ ...repeated, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"], expectedTerminalTurnId: priorTurnId,
      expectedNativeContinuation: prior });
    expect(resumed.nativeCompletion).toMatchObject({ priorContinuationTurnId: priorTurnId,
      priorContinuationKey: prior.key, latestTurn: { id: priorTurnId, status: "interrupted" } });
    repeatedNative.priorContinuationReceiptDigestAfter = "b".repeat(64);
    expect(() => buildCourseSupportContinuationRequest({ ...repeated, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"], expectedTerminalTurnId: priorTurnId,
      expectedNativeContinuation: prior })).toThrow();
    expect(() => buildCourseSupportContinuationRequest({ ...value, stoppedStage: owned,
      changedPaths: ["src/lib/unknown.ts"] })).toThrow();
    const active = structuredClone(value);
    active.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].status = "active";
    expect(() => buildCourseSupportContinuationRequest({ ...active, stoppedStage: owned,
      changedPaths: ["src/lib/simulators/provider.ts"] })).toThrow();
  });
  it("matches pinned creation-time metadata to the actual latest turn completion without rewriting timestamps", () => {
    const value = inventoryInput();
    const observation = value.nativeInventoryObservation;
    const completedAt = observation.inventoryAfter.snapshot.threads[0].updatedAt;
    const native = observation.nativeObservation.rpcCalls[2].result as { thread: { updatedAt: number } };
    const turns = observation.nativeObservation.rpcCalls[3].result as { data: Array<Record<string, unknown>> };
    native.thread.updatedAt = completedAt - 246;
    Object.assign(turns.data[0], { startedAt: completedAt - 211, completedAt });
    expect(inventoryProjection(value)).toMatchObject({ inventoryUpdatedAt: completedAt, nativeUpdatedAt: completedAt - 246,
      nativeLatestTurnCompletedAt: completedAt, completionTimestampSource: "NATIVE_LATEST_COMPLETED_TURN" });
    for (const mutation of [
      { completedAt: completedAt - 1 }, { completedAt: undefined }, { startedAt: undefined },
      { startedAt: completedAt + 1 }, { completedAt: Math.floor(value.now.getTime() / 1000) + 1 },
    ]) {
      const changed = structuredClone(value);
      Object.assign((changed.nativeInventoryObservation.nativeObservation.rpcCalls[3].result as { data: Array<Record<string, unknown>> }).data[0], mutation);
      expect(() => inventoryProjection(changed)).toThrow();
    }
    const changedMetadata = structuredClone(value);
    (changedMetadata.nativeInventoryObservation.nativeObservation.rpcCalls[2].result as { thread: { updatedAt: number } }).thread.updatedAt = completedAt - 1;
    expect(() => inventoryProjection(changedMetadata)).toThrow();
  });
  it("uses actual app status/project identity and durable latest-turn proof without claiming omitted capabilities", () => {
    const request = buildCourseSupportContinuationRequest(inventoryInput());
    expect(request.nativeCompletion).toMatchObject({ source: COURSE_SUPPORT_INVENTORY_COMPLETION_SOURCE,
      threadStatus: "notLoaded", projectId: "original-project", latestTurn: { id: "real-completed-turn", status: "completed", error: null } });
    expect(request.nativeCompletion).not.toHaveProperty("cursor");
    expect(request.nativeCompletion).not.toHaveProperty("activeTurnId");
    expect(request.nativeCompletion).not.toHaveProperty("approvalRequestCount");
    expect(request.nativeCompletion).not.toHaveProperty("canAcceptDirectInput");
    expect(JSON.stringify(request)).not.toContain(checkout);
    expect(request.readiness).toMatchObject({ approvalPolicy: "never", sandboxMode: "danger-full-access", sameProfile: true });
  });

  it("rejects compact selected entries that cannot prove the complete inventory's unique original identity", () => {
    const value = inventoryInput();
    for (const observation of [value.nativeInventoryObservation.inventoryBefore, value.nativeInventoryObservation.inventoryAfter]) {
      const snapshot = observation.snapshot;
      observation.snapshot = { schemaVersion: snapshot.schemaVersion, thread: snapshot.threads[0],
        unavailableHosts: snapshot.unavailableHosts, unavailableSources: snapshot.unavailableSources } as unknown as typeof snapshot;
    }
    expect(() => inventoryProjection(value)).toThrow("complete supported app inventory");
  });

  it("rejects absent, duplicate, different-host/project/checkout and changed global inventory identity", () => {
    const mutations: ((value: ReturnType<typeof inventoryInput>) => void)[] = [
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads = []; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads.push(structuredClone(value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0])); },
      value => { Object.assign(value.nativeInventoryObservation.inventoryAfter.snapshot, { pinnedThreads: [structuredClone(value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0])] }); },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].id = "another-native-worker"; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].hostId = "another-host"; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].projectId = "another-project"; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].cwd = "C:/dev/TeeTimeAI"; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].updatedAt += 1; },
      value => { value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0].status = "active"; },
      value => { Object.assign(value.nativeInventoryObservation.inventoryAfter.snapshot.threads[0], { pendingApproval: { id: "approval" } }); },
      value => { Object.assign(value.nativeInventoryObservation.inventoryAfter.snapshot, { queuedMessages: ["queued"] }); },
    ];
    for (const mutate of mutations) { const value = inventoryInput(); mutate(value); expect(() => inventoryProjection(value)).toThrow(); }
  });

  it("rejects stale, future, approximate-format and unbracketed observations", () => {
    for (const observedAt of ["2026-10-07T07:58:59.000Z", "2026-10-07T08:01:01.000Z", "2026-10-07 08:00:58 UTC", "2026-10-07T08:00:58.500Z"]) {
      const value = inventoryInput(); value.nativeInventoryObservation.inventoryBefore.observedAt = observedAt;
      expect(() => inventoryProjection(value)).toThrow();
    }
    const value = inventoryInput(); value.nativeInventoryObservation.inventoryAfter.observedAt = "2026-10-07T08:00:58.500Z";
    expect(() => inventoryProjection(value)).toThrow();
    const qualification = inventoryInput(); Object.assign(qualification.nativeInventoryObservation.inventoryBefore, { observedAtNote: "Approximate call interval; qualification only" });
    expect(() => inventoryProjection(qualification)).toThrow();
  });

  it("rejects changed original receipt/processes, approval/error, unqualified CLI and wrong native RPC semantics", () => {
    const mutations: ((value: ReturnType<typeof inventoryInput>) => void)[] = [
      value => { value.nativeInventoryObservation.nativeObservation.launcherReceiptDigestAfter = "f".repeat(64); },
      value => { value.nativeInventoryObservation.nativeObservation.processObservationAfter.processes[1].state = "present"; },
      value => { value.nativeInventoryObservation.nativeObservation.observerApprovalRequestCount = 1; },
      value => { value.nativeInventoryObservation.nativeObservation.phase = "STOPPED"; },
      value => { value.nativeInventoryObservation.nativeObservation.cliVersion = "codex-cli 0.160.0"; },
      value => { value.nativeInventoryObservation.nativeObservation.rpcCalls[2].params.includeTurns = true; },
      value => { value.nativeInventoryObservation.nativeObservation.rpcCalls[3].params.sortDirection = "asc"; },
      value => { value.nativeInventoryObservation.nativeObservation.rpcCalls[3].method = "thread/resume"; },
      value => { Object.assign(value.nativeInventoryObservation.nativeObservation.rpcCalls[2].result, { thread: { id: child, cwd: checkout, updatedAt: 1, status: { type: "notLoaded" }, ephemeral: false, cliVersion: "0.160.1" } }); },
      value => { Object.assign(value.nativeInventoryObservation.nativeObservation.rpcCalls[3].result, { data: [{ id: "live-turn", status: "inProgress", error: null, itemsView: "notLoaded", items: [] }] }); },
      value => { Object.assign(value.nativeInventoryObservation.nativeObservation.rpcCalls[3].result, { data: [{ id: "failed-turn", status: "completed", error: { code: "failure" }, itemsView: "notLoaded", items: [] }] }); },
    ];
    for (const mutate of mutations) { const value = inventoryInput(); mutate(value); expect(() => inventoryProjection(value)).toThrow(); }
  });

  it("binds completion to original readiness and deduplicates the same turn across completion sources", () => {
    const request = buildCourseSupportContinuationRequest(inventoryInput());
    const initial = { ...input(), ...request };
    const result = reserved(initial);
    expect(reserveCourseSupportContinuationReceipt({ ...initial, readiness: { ...request.readiness, launcherReceiptDigest: "f".repeat(64) } }))
      .toMatchObject({ reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" });
    expect(reserveCourseSupportContinuationReceipt({ ...initial, readiness: { ...request.readiness, checkoutIdentityDigest: "f".repeat(64) } }))
      .toMatchObject({ reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" });
    expect(reserveCourseSupportContinuationReceipt({ ...input(), ledger: delivered(result), checkpoint: { ...checkpoint, readCount: 2 },
      nativeCompletion: { ...input().nativeCompletion, latestTurn: request.nativeCompletion.latestTurn } }))
      .toMatchObject({ reserved: false, reason: "CHECKPOINT_ALREADY_REQUESTED" });
  });

  it("preserves owner/source/research, one-per-tick, two-attempt and ambiguous-send fences for the new source", () => {
    const request = buildCourseSupportContinuationRequest(inventoryInput());
    const initial = { ...input(), ...request };
    for (const changed of [
      { ...initial, currentSource: false }, { ...initial, originalPrivateChild: false },
      { ...initial, checkpoint: { ...checkpoint, providerReadInFlight: true } },
      { ...initial, checkpoint: { ...checkpoint, allowedResearchRouteCount: 0 } },
      { ...initial, checkpoint: { ...checkpoint, readCount: 6 } },
      { ...initial, checkpoint: { ...checkpoint, failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" } } },
    ]) expect(reserveCourseSupportContinuationReceipt(changed)).toMatchObject({ reserved: false });
    expect(reserveCourseSupportContinuationReceipt({ ...initial, tickAlreadyUsed: true }))
      .toMatchObject({ reserved: false, reason: "TICK_CONTINUATION_BUDGET_EXHAUSTED" });
    const first = reserved(initial);
    expect(reserveCourseSupportContinuationReceipt({ ...initial, ledger: first.ledger }))
      .toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    const later = { ...initial, ledger: delivered(first), now: new Date("2026-10-07T08:12:00.000Z"),
      nativeCompletion: { ...request.nativeCompletion, observedAt: "2026-10-07T08:12:00.000Z", latestTurn: { id: "new-durable-turn", status: "completed" as const, error: null } },
      readiness: { ...request.readiness, observedAt: "2026-10-07T08:12:00.000Z" },
      checkpoint: { ...checkpoint, readCount: 2, observedAt: "2026-10-07T08:11:00.000Z" } };
    const second = reserved(later);
    const ledger = confirmCourseSupportContinuationSent({ ledger: second.ledger, key: second.receipt.key,
      parentThreadId: initial.parentThreadId, childThreadId: child, now: later.now,
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: child, accepted: true } });
    expect(reserveCourseSupportContinuationReceipt({ ...later, ledger, now: new Date("2026-10-07T08:22:00.000Z"),
      nativeCompletion: { ...later.nativeCompletion, observedAt: "2026-10-07T08:22:00.000Z", latestTurn: { id: "third-durable-turn", status: "completed", error: null } },
      readiness: { ...later.readiness, observedAt: "2026-10-07T08:22:00.000Z" },
      checkpoint: { ...later.checkpoint, readCount: 3, observedAt: "2026-10-07T08:21:00.000Z" } }))
      .toMatchObject({ reserved: false, reason: "CONTINUATION_BUDGET_EXHAUSTED" });
  });
});
