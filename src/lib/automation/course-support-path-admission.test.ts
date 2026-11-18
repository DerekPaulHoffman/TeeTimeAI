import { describe, expect, it, vi } from "vitest";
import { waitForCourseSupportPathAdmission } from "./course-support-path-admission";
const busy = { outcome: "deferred_busy", pathRecorded: false, reasonCode: "EXCLUSIVE_IMPLEMENTATION_AUTHORITY_HELD" };
describe("owned implementation admission", () => {
  it("waits for a confirmed mutex release within one command", async () => {
    let clock = 0;
    const ready = { outcome: "ready", pathRecorded: true };
    const attempt = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValue(ready);
    const wait = vi.fn(async (ms: number) => { clock += ms; });
    expect(await waitForCourseSupportPathAdmission(attempt, { now: () => clock, wait, budgetMs: 90_000 })).toBe(ready);
    expect(attempt).toHaveBeenCalledTimes(3); expect(wait).toHaveBeenCalledTimes(2);
  });
  it("keeps a bounded busy outcome instead of transferring the other owner's claim", async () => {
    let clock = 0; const attempt = vi.fn(async () => busy);
    expect(await waitForCourseSupportPathAdmission(attempt, { now: () => clock, budgetMs: 45_000,
      wait: async ms => { clock += ms; } })).toBe(busy);
    expect(clock).toBe(45_000); expect(attempt).toHaveBeenCalledTimes(3);
  });
  it.each([{ outcome: "recovery_required", pathRecorded: false }, { ...busy, reasonCode: "SOURCE_CHANGED" },
    { ...busy, pathRecorded: true }, { outcome: "command_failed" }])("does not retry another result %j", async result => {
    const attempt = vi.fn(async () => result), wait = vi.fn();
    expect(await waitForCourseSupportPathAdmission(attempt, { wait })).toBe(result);
    expect(attempt).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
  });
  it("never retries a failed mutation or lost heartbeat authority", async () => {
    const attempt = vi.fn(async () => { throw Error("unknown mutation result"); });
    await expect(waitForCourseSupportPathAdmission(attempt)).rejects.toThrow("unknown mutation");
    expect(attempt).toHaveBeenCalledTimes(1);
    const controller = new AbortController(), waiting = vi.fn(async () => busy);
    await expect(waitForCourseSupportPathAdmission(waiting, { signal: controller.signal,
      wait: async () => { controller.abort(Error("ownership lost")); } })).rejects.toThrow("ownership lost");
    expect(waiting).toHaveBeenCalledTimes(1);
  });
});
