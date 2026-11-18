import { describe, expect, it, vi } from "vitest";
import { settleCourseSupportRecoveryFence } from "./course-support-recovery-progress";

const adopted = (revision: number) => ({ outcome: "recovery_required", recovered: false,
  safelyRequeued: false, durableCloseoutRecorded: false,
  recoveryProgress: { kind: "COMMITTED_SEARCH_EXECUTION_FENCE_ADOPTION", revision } });
describe("single recovery invocation fence settlement", () => {
  it("settles acknowledged progress with fresh authority checks, without model replay", async () => {
    const closed = { outcome: "retryable_failed", safelyRequeued: true };
    const operation = vi.fn().mockResolvedValueOnce(adopted(7)).mockResolvedValueOnce(adopted(8)).mockResolvedValue(closed);
    const revalidate = vi.fn();
    expect(await settleCourseSupportRecoveryFence(operation, revalidate)).toEqual(closed);
    expect(operation).toHaveBeenCalledTimes(3); expect(revalidate).toHaveBeenCalledTimes(2);
  });
  it.each([{}, { outcome: "command_failed" }, { ...adopted(4), recoveryProgress: undefined },
    { ...adopted(4), recovered: true }, { ...adopted(4), recoveryProgress: { kind: "UNKNOWN", revision: 4 } }])(
    "does not retry an unacknowledged result %j", async result => {
      const operation = vi.fn(async () => result), revalidate = vi.fn();
      expect(await settleCourseSupportRecoveryFence(operation, revalidate)).toBe(result);
      expect(operation).toHaveBeenCalledTimes(1); expect(revalidate).not.toHaveBeenCalled();
    });
  it("preserves thrown/ambiguous mutations and authority drift without another operation", async () => {
    const failed = vi.fn(async () => { throw Error("unknown mutation result"); });
    await expect(settleCourseSupportRecoveryFence(failed, vi.fn())).rejects.toThrow("unknown mutation");
    expect(failed).toHaveBeenCalledTimes(1);
    const operation = vi.fn(async () => adopted(2));
    await expect(settleCourseSupportRecoveryFence(operation, () => { throw Error("Git authority drift"); })).rejects.toThrow("Git authority drift");
    expect(operation).toHaveBeenCalledTimes(1);
  });
  it("bounds advancing churn and refuses a repeated revision", async () => {
    let revision = 0; const operation = vi.fn(async () => adopted(++revision));
    expect(await settleCourseSupportRecoveryFence(operation, vi.fn())).toEqual(adopted(3));
    expect(operation).toHaveBeenCalledTimes(3);
    const repeated = vi.fn(async () => adopted(2));
    expect(await settleCourseSupportRecoveryFence(repeated, vi.fn())).toEqual(adopted(2));
    expect(repeated).toHaveBeenCalledTimes(2);
  });
});
