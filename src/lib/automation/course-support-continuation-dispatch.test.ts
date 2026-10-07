import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { COURSE_SUPPORT_CONTINUATION_POLICY_VERSION } from "./course-support-continuation";

const state = vi.hoisted(() => {
  type Run = { id: string; promptVersion: string; status: string; audit: CourseDispatchAudit };
  const runs: Run[] = [];
  let tail = Promise.resolve();
  const now = new Date("2026-10-07T08:01:00.000Z");
  const context = vi.fn(async () => ({ currentSource: true, currentClaimRevision: 2,
    providerReadInFlight: false, checkpoint: { kind: "SETTLED_FAILURE", observedAt: "2026-10-07T08:00:00.000Z",
      readCount: 1, requestId: null, failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" },
      allowedResearchRouteCount: 1 } }));
  const tx = {
    $queryRaw: vi.fn(async () => [{ now }]),
    courseSupportBatch: { findMany: vi.fn(async () => []) },
    course: { findMany: vi.fn(async () => []) },
    coursePreference: { findMany: vi.fn(async () => []) },
    automationRun: {
      findMany: vi.fn(async () => runs.filter(run => run.status === "RUNNING")),
      findFirst: vi.fn(async (args: { where: { audit: { path: string[]; equals?: string; array_contains?: { tickRef: string }[] } } }) => {
        const filter = args.where.audit;
        return filter.path[0] === "assignmentRef" ? runs.find(run => run.audit.assignmentRef === filter.equals) ?? null :
          runs.find(run => run.audit.simulatorContinuation?.receipts.some(receipt => receipt.tickRef === filter.array_contains?.[0].tickRef)) ?? null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: { audit: CourseDispatchAudit } }) => {
        const row = runs.find(run => run.id === args.where.id);
        if (!row) throw new Error("Missing test assignment");
        row.audit = args.data.audit;
        return row;
      }),
    },
  };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
  const lease = async (operation: () => Promise<unknown>) => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return { acquired: true, value: await operation() }; } finally { release(); }
  };
  return { runs, tx, transaction, lease, context, now, reset: () => { tail = Promise.resolve(); } };
});
vi.mock("@/lib/prisma", () => ({ prisma: { ...state.tx, $transaction: state.transaction } }));
vi.mock("./course-support-batches", () => ({ runWithCourseSupportWriterTransitionLease: state.lease,
  withCourseSupportWriteConflictRetry: (operation: () => Promise<unknown>) => operation(),
  MAX_CONCURRENT_COURSE_SUPPORT_BATCHES: 15, listCourseSupportDispatchCandidates: vi.fn(async () => []),
}));
vi.mock("./simulator-support-incidents", () => ({ listSimulatorSupportDispatchCandidates: vi.fn(async () => []) }));
vi.mock("./simulator-support-ownership", () => ({ readSimulatorSupportContinuationContext: state.context }));

import { planCourseSupportCourseDispatch, recordCourseSupportContinuationSent, reserveCourseSupportContinuation } from "./course-support-course-dispatch";

const baseSha = "a".repeat(40);
function audit(assignmentRef = "assignment-original", childThreadId = "original-child"): CourseDispatchAudit {
  return { schemaVersion: 1, tickRef: "course-original", assignmentRef, state: "CONSUMED", ownerThreadId: "original-parent",
    childThreadId, baseSha, reservedAt: state.now.toISOString(), expiresAt: state.now.toISOString(),
    target: { mode: "SIMULATOR", offeringId: "original-offering", offeringSourceFingerprint: "b".repeat(64),
      incidentId: "original-incident", courseId: "original-course", cycle: 1, providerFamilyKey: "SIM", failureFingerprint: "b".repeat(64),
      updatedAt: state.now.toISOString(), trafficClass: "SYNTHETIC", searchRefs: [{ id: "original-search", scheduleVersion: 0, alertGeneration: 0 }] },
    simulatorClaim: { token: "unchanged-owner-token", revision: 2, phase: "CLAIMED", claimedAt: state.now.toISOString(),
      leaseExpiresAt: state.now.toISOString(), sourceFingerprint: "b".repeat(64), originalSourceFingerprint: "b".repeat(64),
      offeringRevision: 0, plannedPaths: [], releaseSha: null, branch: "automation/course-support-original",
      deployment: null, recheckQueuedAt: null, verificationCycle: 0 },
  };
}
function request(assignmentRef = "assignment-original", child = "original-child") {
  return { ownerThreadId: "new-orchestrator-parent", assignmentRef, policyVersion: COURSE_SUPPORT_CONTINUATION_POLICY_VERSION,
    currentMainSha: baseSha, nativeCompletion: { version: 1, source: "codex_app.wait_threads", threadId: child,
      observedAt: state.now.toISOString(), cursor: "cursor:1", threadStatus: "notLoaded",
      latestTurn: { id: `turn-${child}`, status: "completed", error: null }, activeTurnId: null, approvalRequestCount: 0 },
    readiness: { version: 1, source: "original_native_launcher_receipt", threadId: child,
      observedAt: state.now.toISOString(), launcherReceiptDigest: "c".repeat(64), checkoutIdentityDigest: "d".repeat(64),
      privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access", nativeIdentityVerified: true,
      noApprovalRequired: true, sameProfile: true, runtimeReady: true, toolingReleaseSha: baseSha },
  };
}

describe("durable continuation reservation boundaries", () => {
  beforeEach(() => {
    state.runs.length = 0; state.reset(); vi.clearAllMocks();
    state.runs.push({ id: "original-run", promptVersion: "course-support-course-dispatch-v1", status: "RUNNING", audit: audit() });
    state.context.mockResolvedValue({ currentSource: true, currentClaimRevision: 2, providerReadInFlight: false,
      checkpoint: { kind: "SETTLED_FAILURE", observedAt: "2026-10-07T08:00:00.000Z", readCount: 1, requestId: null,
        failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" }, allowedResearchRouteCount: 1 } });
  });

  it("returns private same-worker candidates from the original plan without another launch or state transition", async () => {
    const original = structuredClone(state.runs[0]);
    const result = await planCourseSupportCourseDispatch({ ownerThreadId: "new-orchestrator-parent", baseSha, now: state.now });
    expect(result).toMatchObject({ acquired: true, value: { reservedCount: 1, occupiedCourseCount: 1,
      launchItems: [], continuationEligibleCount: 1, continuationAttentionCount: 0,
      continuationItems: [{ mode: "SIMULATOR", assignmentRef: "assignment-original", threadId: "original-child",
        originalParentThreadId: "original-parent", branch: "automation/course-support-original", baseSha }] } });
    expect(state.tx.automationRun.findMany).toHaveBeenCalledTimes(1);
    expect(state.runs).toEqual([original]);
    expect(state.tx.automationRun.update).not.toHaveBeenCalled();
  });

  it("keeps source errors as continuation attention while preserving the occupied slot", async () => {
    state.context.mockRejectedValueOnce(new Error("Source changed"));
    const result = await planCourseSupportCourseDispatch({ ownerThreadId: "new-orchestrator-parent", baseSha, now: state.now });
    expect(result).toMatchObject({ acquired: true, value: { reservedCount: 1, occupiedCourseCount: 1,
      continuationItems: [], continuationEligibleCount: 0, continuationAttentionCount: 1 } });
    expect(state.tx.automationRun.update).not.toHaveBeenCalled();
  });

  it("does not repeatedly report a SENT checkpoint as an eligible continuation", async () => {
    const reserved = await reserveCourseSupportContinuation(request());
    if (!reserved.acquired || !reserved.value.reserved) throw new Error("Expected reservation");
    await recordCourseSupportContinuationSent({ ownerThreadId: "new-orchestrator-parent", assignmentRef: "assignment-original",
      continuationKey: reserved.value.continuationKey, childThreadId: "original-child",
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: "original-child", accepted: true } });
    vi.clearAllMocks();
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "later-orchestrator", baseSha, now: state.now });
    expect(plan).toMatchObject({ acquired: true, value: { continuationItems: [], continuationEligibleCount: 0,
      continuationAttentionCount: 1, reservedCount: 1, occupiedCourseCount: 1 } });
    expect(state.tx.automationRun.update).not.toHaveBeenCalled();
  });

  it("keeps an exhausted source in attention even when it has a different latest checkpoint", async () => {
    const reserved = await reserveCourseSupportContinuation(request());
    if (!reserved.acquired || !reserved.value.reserved) throw new Error("Expected reservation");
    const receipt = state.runs[0].audit.simulatorContinuation!.receipts[0];
    state.runs[0].audit.simulatorContinuation = { version: 1, receipts: [
      { ...receipt, status: "SENT", sentAt: state.now.toISOString() },
      { ...receipt, key: "f".repeat(64), checkpointDigest: "e".repeat(64), nativeCompletionDigest: "d".repeat(64),
        attempt: 2, status: "SENT", sentAt: state.now.toISOString() },
    ] };
    state.context.mockResolvedValue({ currentSource: true, currentClaimRevision: 2, providerReadInFlight: false,
      checkpoint: { kind: "SETTLED_FAILURE", observedAt: "2026-10-07T08:00:30.000Z", readCount: 3, requestId: null,
        failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" }, allowedResearchRouteCount: 1 } });
    vi.clearAllMocks();
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: "later-orchestrator", baseSha, now: state.now });
    expect(plan).toMatchObject({ acquired: true, value: { continuationItems: [], continuationEligibleCount: 0,
      continuationAttentionCount: 1, reservedCount: 1, occupiedCourseCount: 1 } });
    expect(state.tx.automationRun.update).not.toHaveBeenCalled();
  });

  it("serializes competing recurring parents and reserves exactly one original-worker message", async () => {
    const original = structuredClone(state.runs[0].audit);
    const results = await Promise.all([reserveCourseSupportContinuation(request()),
      reserveCourseSupportContinuation({ ...request(), ownerThreadId: "another-recurring-parent" })]);
    expect(results.filter(result => result.acquired && result.value.reserved)).toHaveLength(1);
    expect(state.runs[0].audit.simulatorContinuation?.receipts).toHaveLength(1);
    expect(state.runs[0].audit.simulatorClaim).toEqual(original.simulatorClaim);
    expect(state.runs[0].audit.simulatorResearch).toEqual(original.simulatorResearch);
    expect(state.runs[0].audit.target).toEqual(original.target);
    expect(state.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it("counts a completed older dispatch continuation against the same tick", async () => {
    const result = await reserveCourseSupportContinuation(request());
    expect(result.acquired && result.value.reserved).toBe(true);
    state.runs[0].status = "COMPLETED";
    state.runs.push({ id: "second-run", promptVersion: "course-support-course-dispatch-v1", status: "RUNNING",
      audit: audit("second-assignment", "second-child") });
    const second = await reserveCourseSupportContinuation(request("second-assignment", "second-child"));
    expect(second).toMatchObject({ acquired: true, value: { reserved: false, reason: "TICK_CONTINUATION_BUDGET_EXHAUSTED" } });
    expect(state.runs[1].audit.simulatorContinuation).toBeUndefined();
  });

  it("records the accepted send even if the native worker finished immediately", async () => {
    const result = await reserveCourseSupportContinuation(request());
    if (!result.acquired || !result.value.reserved) throw new Error("Expected reservation");
    state.runs[0].status = "COMPLETED";
    const saved = await recordCourseSupportContinuationSent({ ownerThreadId: "new-orchestrator-parent",
      assignmentRef: "assignment-original", continuationKey: result.value.continuationKey, childThreadId: "original-child",
      toolReceipt: { source: "codex_app.send_message_to_thread", threadId: "original-child", accepted: true } });
    expect(saved).toMatchObject({ acquired: true, value: { monitoringVerified: false } });
    expect(state.runs[0].status).toBe("COMPLETED");
    expect(state.runs[0].audit.simulatorContinuation?.receipts[0].status).toBe("SENT");
  });

  it("preserves the audit when current source, exact owner or native proof cannot be established", async () => {
    const original = structuredClone(state.runs[0].audit);
    state.context.mockRejectedValueOnce(new Error("Simulator source demand changed; preserve ownership and stop."));
    await expect(reserveCourseSupportContinuation(request())).rejects.toThrow();
    expect(state.runs[0].audit).toEqual(original);
    expect(await reserveCourseSupportContinuation({ ...request(), nativeCompletion: { status: "RUNNING" } })).toMatchObject({
      acquired: true, value: { reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" } });
    expect(state.runs[0].audit).toEqual(original);
  });
});
