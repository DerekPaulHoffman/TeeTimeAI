import { describe, expect, it, vi } from "vitest";
import { isQualifiedCourseSupportLearningRuntime, readCourseSupportLearningRuntimeReadyReceipt, watchOwnedLearningRecovery } from "./course-support-learning-recovery";
import { CourseSupportRuntimeUpdateFailure } from "./course-support-runtime-update";
class StateConflict extends Error {}

function fixture() {
  const controller = new AbortController();
  const job = { outcome: "created" as const, jobId: "child", originalJobId: "failed", releaseSha: "a".repeat(40), runtimeVersion: "b".repeat(40) };
  const method = { state: "METHOD_SAVED" as const, recipeId: "recipe", recipeHash: "c".repeat(64), runtimeVersion: job.runtimeVersion,
    originalFirstPickedUpAt: "2030-01-01T12:00:00Z", originalDeadlineAt: "2030-01-01T12:15:00Z" };
  const pending = { state: "PENDING" as const, firstPickedUpAt: null, deadlineAt: null, attempts: 0, runtimeVersion: job.runtimeVersion };
  return { controller, job, method, pending, runtimeVersion: job.runtimeVersion,
    prepareRuntime: vi.fn(async () => {}), admit: vi.fn(async () => job),
    read: vi.fn(async () => method as typeof method | typeof pending | { state: "OBSOLETE" }),
    readHandoff: vi.fn(async () => ({ durableCloseoutRecorded: true, method })),
    isStateConflict: (error: unknown) => error instanceof StateConflict, signal: controller.signal };
}
const noMutation = { schemaVersion: 1, outcome: "blocked", reasonCode: "MANAGED_RUNTIME_CHECKOUT_MISSING",
  phase: "VALIDATE_MANAGED_CHECKOUT", apply: true, stateChanged: false, mutationAttempted: false, drainAttempted: false,
  taskStopAttempted: false, runtimeUpdateAttempted: false, taskStartAttempted: false, activationWriteAttempted: false,
  taskStartRequests: 0, firstStoppedTaskResult: null, acceptanceRestartProof: false };

describe("original coding owner returning a repair to the learner", () => {
  it("prepares the exact runtime before admission; method handoff is not email success", async () => {
    const f = fixture();
    const result = await watchOwnedLearningRecovery(f);
    expect(f.prepareRuntime.mock.invocationCallOrder[0]).toBeLessThan(f.admit.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({ outcome: "learning_recipe_handoff", durableCloseoutRecorded: true,
      method: f.method, monitoringVerified: false, deliveryVerified: false });
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it("never admits work when runtime preparation fails", async () => {
    const f = fixture(); f.prepareRuntime.mockRejectedValue(Error("runtime not current"));
    await expect(watchOwnedLearningRecovery(f)).rejects.toThrow("runtime not current");
    expect(f.admit).not.toHaveBeenCalled();
  });
  it.each([
    ["MANAGED_RUNTIME_CHECKOUT_MISSING", "VALIDATE_MANAGED_CHECKOUT"],
    ["DEPENDENCY_SCHEMA_OR_INSTALLED_READER_ROLLOUT_REQUIRED", "VALIDATE_SOURCE"],
  ])("passes through `%s` before admission only when the updater proves no mutation", async (reasonCode, phase) => {
    const f = fixture();
    const failure = new CourseSupportRuntimeUpdateFailure(JSON.stringify({ ...noMutation, reasonCode, phase,
      privatePath: "must not be forwarded" }));
    f.prepareRuntime.mockRejectedValue(failure);
    const result = await watchOwnedLearningRecovery(f);
    expect(result).toMatchObject({ outcome: "runtime_blocked_before_admission", error: failure, blocker: {
      kind: "WINDOWS_RUNTIME_BLOCKED", runtimeVersion: f.runtimeVersion, observedAt: expect.any(Date),
      diagnostic: { attributed: true, reasonCode, phase, mutationAttempted: false, taskStartRequests: 0 },
    } });
    expect(JSON.stringify(result)).not.toContain("must not be forwarded");
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([{ phase: "VALIDATE_SOURCE" }, { reasonCode: "DIRTY_MANAGED_RUNTIME" }, { apply: false },
    { taskStopAttempted: true }, { mutationAttempted: true }, { taskStartRequests: 1 }, { firstStoppedTaskResult: 1 },
    { runtimeUpdateAttempted: undefined }])("preserves the existing stop without a blocker receipt for %o", async patch => {
    const f = fixture();
    const failure = new CourseSupportRuntimeUpdateFailure(JSON.stringify({ ...noMutation, ...patch }));
    f.prepareRuntime.mockRejectedValue(failure);
    await expect(watchOwnedLearningRecovery(f)).rejects.toBe(failure);
    expect(f.admit).not.toHaveBeenCalled();
  });
  it("retains an obsolete failure and does not try another budget", async () => {
    const f = fixture(); f.read.mockResolvedValue({ state: "OBSOLETE" });
    expect(await watchOwnedLearningRecovery(f)).toMatchObject({ outcome: "repair_required", durableCloseoutRecorded: false });
    expect(f.admit).toHaveBeenCalledTimes(1); expect(f.readHandoff).not.toHaveBeenCalled();
  });
  it("accepts a heartbeat-closeout race only with the actual saved-method marker", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(f.pending);
    const wait = vi.fn(async () => { f.controller.abort(Error("owner closed")); throw f.signal.reason; });
    expect(await watchOwnedLearningRecovery({ ...f, wait })).toMatchObject({ outcome: "learning_recipe_handoff", durableCloseoutRecorded: true });
    const lost = fixture(); lost.read.mockResolvedValue(lost.pending);
    await expect(watchOwnedLearningRecovery({ ...lost, wait: async () => { lost.controller.abort(Error("owner lost")); throw lost.signal.reason; } })).rejects.toThrow("owner lost");
    expect(lost.readHandoff).not.toHaveBeenCalled();
  });
  it("bounds queued observation without restarting the job or its clock", async () => {
    const f = fixture(); f.read.mockResolvedValue(f.pending); let time = 0;
    expect(await watchOwnedLearningRecovery({ ...f, now: () => time, wait: async () => { time += 18 * 60_000; } }))
      .toMatchObject({ outcome: "learning_recovery_pending", durableCloseoutRecorded: false });
    expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it("reconciles a typed state conflict only against the exact completed coding-phase marker", async () => {
    const f = fixture(); f.read.mockRejectedValue(new StateConflict("state changed after activation"));
    expect(await watchOwnedLearningRecovery(f)).toMatchObject({ outcome: "learning_recipe_handoff", method: f.method,
      durableCloseoutRecorded: true, monitoringVerified: false, deliveryVerified: false });
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.admit).toHaveBeenCalledTimes(1);
    expect(f.prepareRuntime).toHaveBeenCalledTimes(1); expect(f.readHandoff).toHaveBeenCalledTimes(1);
  });
  it("preserves a state conflict when no matching durable marker or method facts exist", async () => {
    for (const marker of [{ durableCloseoutRecorded: false }, { durableCloseoutRecorded: true }]) {
      const f = fixture(), error = new StateConflict("ownership or source changed"); f.read.mockRejectedValue(error);
      await expect(watchOwnedLearningRecovery({ ...f, readHandoff: async () => marker })).rejects.toBe(error);
      expect(f.read).toHaveBeenCalledTimes(1); expect(f.admit).toHaveBeenCalledTimes(1);
    }
  });
  it("never turns an unknown read failure into success from a completed marker", async () => {
    const f = fixture(), error = Error("unknown read failure"); f.read.mockRejectedValue(error);
    await expect(watchOwnedLearningRecovery(f)).rejects.toBe(error);
    expect(f.readHandoff).not.toHaveBeenCalled(); expect(f.admit).toHaveBeenCalledTimes(1);
  });
  it("preserves a state conflict when the completed method belongs to another runtime", async () => {
    const f = fixture(), error = new StateConflict("runtime changed"); f.read.mockRejectedValue(error);
    f.readHandoff.mockResolvedValue({ durableCloseoutRecorded: true, method: { ...f.method, runtimeVersion: "d".repeat(40) } });
    await expect(watchOwnedLearningRecovery(f)).rejects.toBe(error);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.admit).toHaveBeenCalledTimes(1);
  });
});

describe("exact ready evidence for a held Windows verification", () => {
  const runtimeVersion = "b".repeat(40);
  const heartbeatAt = new Date("2030-01-01T12:00:00.000Z");
  const observedAt = new Date("2030-01-01T12:00:11.000Z");
  const inspect = { action: "Inspect", apply: false, taskName: "Tee Time Spot Course Discovery", taskPath: "\\TeeTimeSpot\\",
    exists: true, state: "Running", ready: true, restartPrerequisites: "PRESENT", workerMode: "STAGEHAND_SOL", pollStatus: "completed",
    heartbeatStatus: "fresh", activeOperations: 0, runtimeVersion, lastHeartbeatAt: "2030-01-01T12:00:00.0000000+00:00",
    logDirectory: "private" };

  it("requires already-current updater proof for the exact runtime", () => {
    const qualified = { outcome: "already_current", runtimeVersion, acceptanceRestartProof: false };
    expect(isQualifiedCourseSupportLearningRuntime(JSON.stringify(qualified), runtimeVersion)).toBe(true);
    expect(isQualifiedCourseSupportLearningRuntime(JSON.stringify({ ...qualified, outcome: "ready_to_update" }), runtimeVersion)).toBe(false);
    expect(isQualifiedCourseSupportLearningRuntime(JSON.stringify({ ...qualified, runtimeVersion: "a".repeat(40) }), runtimeVersion)).toBe(false);
  });

  it("projects a bounded fresh exact-host receipt with no local paths", () => {
    expect(readCourseSupportLearningRuntimeReadyReceipt(JSON.stringify(inspect), runtimeVersion, observedAt))
      .toEqual({ kind: "WINDOWS_RUNTIME_READY", runtimeVersion, observedAt, heartbeatAt });
  });

  it.each([{ action: "Start" }, { apply: true }, { taskName: "another task" }, { taskPath: "\\" }, { state: "Ready" },
    { ready: false }, { restartPrerequisites: "MANAGED_RUNTIME_CHECKOUT_MISSING" }, { workerMode: "NATIVE_SOL" },
    { heartbeatStatus: "stale" }, { pollStatus: "failed" }, { activeOperations: 1 }, { runtimeVersion: "a".repeat(40) },
    { drained: true }, { drainNonce: "another-operation" },
    { lastHeartbeatAt: "2030-01-01T12:01:00Z" }, { lastHeartbeatAt: "2030-01-01T11:58:00Z" }])("rejects %o even when other task fields look ready", patch => {
    expect(readCourseSupportLearningRuntimeReadyReceipt(JSON.stringify({ ...inspect, ...patch }), runtimeVersion, observedAt)).toBeNull();
  });
});
