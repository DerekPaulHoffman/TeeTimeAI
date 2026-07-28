import { describe, expect, it, vi } from "vitest";

import { runCourseSupportLeaseWatch } from "@/lib/automation/course-support-lease-watch";

describe("runCourseSupportLeaseWatch", () => {
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
