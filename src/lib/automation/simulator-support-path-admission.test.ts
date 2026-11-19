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
    now: () => clock, sleep: vi.fn(async milliseconds => { clock += milliseconds; }), maximumWaitMs: 30_000 };
}
describe("owned simulator implementation capacity", () => {
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
      phase: "CLAIMED", revision: 6, deferredBusy: true, outcome: "implementation_deferred_busy" } });
    expect(f.claim).toHaveBeenCalledTimes(2);
    expect(f.heartbeat).toHaveBeenCalledTimes(2);
    expect(f.now()).toBe(30_000);
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
