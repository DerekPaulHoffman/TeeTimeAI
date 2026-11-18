import { describe, expect, it, vi } from "vitest";

import { runCourseSupportLeaseWatch } from "@/lib/automation/course-support-lease-watch";

describe("runCourseSupportLeaseWatch", () => {
  it("returns the exact initial no-write path precondition instead of claiming ownership loss or retrying it", async () => {
    const correction = { outcome: "implementation_path_required", heartbeatRecorded: false, stateChanged: false,
      requiredAction: "CLAIM_IMPLEMENTATION_PATH" };
    const renew = vi.fn(async () => correction), sleep = vi.fn(async () => {}), onRenewed = vi.fn();
    expect(await runCourseSupportLeaseWatch({ maxMinutes: 5, renew, sleep, onRenewed }))
      .toMatchObject({ ...correction, renewalCount: 0 });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onRenewed).not.toHaveBeenCalled();
  });

  it.each([{ stateChanged: true, requiredAction: "CLAIM_IMPLEMENTATION_PATH" },
    { stateChanged: false, requiredAction: "RETRY_WRITE" }])("rejects uncertain correction receipts: %j", async correction => {
    await expect(runCourseSupportLeaseWatch({ maxMinutes: 5,
      renew: async () => ({ outcome: "implementation_path_required", heartbeatRecorded: false, ...correction }) }))
      .rejects.toThrow("lost durable batch ownership");
  });
  it("renews immediately and at a bounded cadence", async () => {
    let now = 0;
    const renew = vi.fn(async () => ({
      heartbeatRecorded: true,
      leaseExpiresAt: new Date(now + 15 * 60_000).toISOString()
    }));

    const result = await runCourseSupportLeaseWatch({
      maxMinutes: 10,
      intervalMs: 4 * 60_000,
      renew,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      }
    });

    expect(result.renewalCount).toBe(3);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("stops immediately when durable ownership is lost", async () => {
    await expect(
      runCourseSupportLeaseWatch({
        maxMinutes: 5,
        renew: async () => ({ heartbeatRecorded: false }),
        sleep: async () => undefined
      })
    ).rejects.toThrow("lost durable batch ownership");
  });
});
