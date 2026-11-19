import { describe, expect, it, vi } from "vitest";
import { SIMULATOR_IMPLEMENTATION_BUSY, waitForSimulatorSupportPath } from "./simulator-support-path-admission";

const input = { assignmentRef: "assignment", ownerThreadId: "original-owner", token: "private-test-token", revision: 4,
  path: "src/lib/automation/simulator-interactive-browser.ts" };
const claim = { assignmentRef: input.assignmentRef, token: input.token, revision: 5, phase: "CLAIMED" as const,
  leaseExpiresAt: "2026-11-19T08:00:00.000Z" };
function fixture() {
  let clock = 0;
  return { claim: vi.fn().mockImplementation(async owner => ({ acquired: true, value: { ...claim, phase: "IMPLEMENTING", revision: owner.revision + 1 } })),
    heartbeat: vi.fn().mockImplementation(async owner => ({ acquired: true, value: { ...claim, revision: owner.revision + 1 } })),
    defer: vi.fn().mockImplementation(async owner => ({ acquired: true, value: { ...claim, phase: "WAITING_IMPLEMENTATION",
      revision: owner.revision + 1, pendingImplementation: { version: 1, path: owner.path,
        requestedAt: "2026-11-19T07:40:00.000Z", sourceFingerprint: "a".repeat(64), offeringRevision: 0 } } })),
    now: () => clock, sleep: vi.fn(async milliseconds => { clock += milliseconds; }), maximumWaitMs: 30_000 };
}
describe("owned simulator implementation capacity", () => {
  it("persists the ungranted repair before a busy wait can return to the research guide", async () => {
    const f = fixture(); f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    const defer = vi.fn(async owner => ({ acquired: true as const, value: { ...claim,
      phase: "WAITING_IMPLEMENTATION" as const, revision: owner.revision + 1,
      pendingImplementation: { version: 1 as const, path: input.path, requestedAt: "2026-11-19T07:40:00.000Z",
        sourceFingerprint: "a".repeat(64), offeringRevision: 0 } } }));
    const result = await waitForSimulatorSupportPath(input, { ...f, defer });
    expect(result).toMatchObject({ acquired: true, value: { phase: "WAITING_IMPLEMENTATION", revision: 7,
      deferredBusy: true, stopWorker: true, pendingImplementation: { path: input.path } } });
    expect(defer).toHaveBeenCalledExactlyOnceWith({ ...input, revision: 6 });
    expect(f.claim).toHaveBeenCalledTimes(2);
  });
  it("keeps one command and renews the original claim while a definite implementation refusal clears", async () => {
    const f = fixture();
    f.claim.mockRejectedValueOnce(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    expect(await waitForSimulatorSupportPath(input, f)).toMatchObject({ acquired: true, value: { phase: "IMPLEMENTING" } });
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(f.claim.mock.calls[1][0]).toEqual({ ...input, revision: 5 });
    expect(f.heartbeat).toHaveBeenCalledTimes(1);
    expect(input.revision).toBe(4);
  });
  it("returns a bounded explicit dependency without claiming a path when capacity stays occupied", async () => {
    const f = fixture(); f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    expect(await waitForSimulatorSupportPath(input, f)).toMatchObject({ acquired: true, value: {
      phase: "WAITING_IMPLEMENTATION", revision: 7, deferredBusy: true, outcome: "implementation_deferred_busy" } });
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    expect(f.now()).toBe(30_000);
  });
  it.each(["phase", "path", "token", "revision"])("does not report saved intent after an invalid deferred %s", async field => {
    const f = fixture(); f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    f.defer.mockImplementation(async owner => ({ acquired: true, value: { ...claim,
      phase: field === "phase" ? "CLAIMED" : "WAITING_IMPLEMENTATION",
      token: field === "token" ? "changed" : owner.token,
      revision: field === "revision" ? owner.revision : owner.revision + 1,
      pendingImplementation: { version: 1, path: field === "path" ? "different.ts" : owner.path,
        requestedAt: "2026-11-19T07:40:00.000Z", sourceFingerprint: "a".repeat(64), offeringRevision: 0 } } }));
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toThrow("WAIT_NOT_PERSISTED");
    expect(f.defer).toHaveBeenCalledTimes(1); expect(f.claim).toHaveBeenCalledTimes(2);
  });
  it("does not turn refused persistence admission into a saved dependency", async () => {
    const f = fixture(); f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    f.defer.mockResolvedValue({ acquired: false });
    expect(await waitForSimulatorSupportPath(input, f)).toEqual({ acquired: false });
    expect(f.defer).toHaveBeenCalledTimes(1);
  });
  it("does not retry an uncertain persistence failure", async () => {
    const f = fixture(), error = new Error("unknown persistence result");
    f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY)); f.defer.mockRejectedValue(error);
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toBe(error);
    expect(f.defer).toHaveBeenCalledTimes(1);
  });
  it.each(["unknown failure", "owner, revision or lease is stale", "source changed"])("does not retry %s", async message => {
    const f = fixture(), error = new Error(message); f.claim.mockRejectedValue(error);
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toBe(error);
    expect(f.claim).toHaveBeenCalledTimes(1); expect(f.heartbeat).not.toHaveBeenCalled();
  });
  it("does not repeat a writer-admission refusal or extend an unconfirmed owner", async () => {
    const f = fixture(); f.claim.mockResolvedValue({ acquired: false });
    expect(await waitForSimulatorSupportPath(input, f)).toEqual({ acquired: false });
    expect(f.claim).toHaveBeenCalledTimes(1); expect(f.heartbeat).not.toHaveBeenCalled();
  });
  it.each(["phase", "token", "revision", "assignmentRef"])("does not accept an unconfirmed path result with a changed %s", async field => {
    const f = fixture();
    f.claim.mockResolvedValue({ acquired: true, value: { ...claim, phase: "IMPLEMENTING",
      [field]: field === "phase" ? "CLAIMED" : field === "revision" ? input.revision : "changed" } });
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toThrow("PATH_NOT_CONFIRMED");
    expect(f.claim).toHaveBeenCalledTimes(1); expect(f.heartbeat).not.toHaveBeenCalled();
  });
  it.each(["token", "revision"])("stops before another claim after an invalid heartbeat %s", async field => {
    const f = fixture(); f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY));
    f.heartbeat.mockResolvedValue({ acquired: true, value: { ...claim, [field]: field === "token" ? "changed" : input.revision } });
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toThrow("OWNERSHIP_UNCONFIRMED");
    expect(f.claim).toHaveBeenCalledTimes(1);
  });
  it("does not continue when source validation fails during renewal", async () => {
    const f = fixture(), error = new Error("Source validation failed");
    f.claim.mockRejectedValue(new Error(SIMULATOR_IMPLEMENTATION_BUSY)); f.heartbeat.mockRejectedValue(error);
    await expect(waitForSimulatorSupportPath(input, f)).rejects.toBe(error);
    expect(f.claim).toHaveBeenCalledTimes(1);
  });
});
