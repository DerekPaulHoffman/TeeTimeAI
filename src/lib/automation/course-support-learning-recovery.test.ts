import { describe, expect, it, vi } from "vitest";
import { watchOwnedLearningRecovery } from "./course-support-learning-recovery";

function fixture() {
  const controller = new AbortController();
  const job = { outcome: "created" as const, jobId: "child", originalJobId: "failed", releaseSha: "a".repeat(40), runtimeVersion: "b".repeat(40) };
  const method = { state: "METHOD_SAVED" as const, recipeId: "recipe", recipeHash: "c".repeat(64), runtimeVersion: job.runtimeVersion,
    originalFirstPickedUpAt: "2030-01-01T12:00:00Z", originalDeadlineAt: "2030-01-01T12:15:00Z" };
  const pending = { state: "PENDING" as const, firstPickedUpAt: null, deadlineAt: null, attempts: 0, runtimeVersion: job.runtimeVersion };
  return { controller, job, method, pending, prepareRuntime: vi.fn(async () => {}), admit: vi.fn(async () => job),
    read: vi.fn(async () => method as typeof method | typeof pending | { state: "OBSOLETE" }),
    readHandoff: vi.fn(async () => ({ durableCloseoutRecorded: true })), signal: controller.signal };
}
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
});
