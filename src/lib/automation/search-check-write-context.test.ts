import { describe, expect, it, vi } from "vitest";

const transaction = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  $queryRawUnsafe: vi.fn(),
}));

const prisma = vi.hoisted(() => ({
  $transaction: vi.fn(async (work: (transaction: typeof transaction) => Promise<unknown>) =>
    work(transaction)),
}));

vi.mock("@/lib/prisma", () => ({ prisma }));

import {
  runSerializedCourseMonitoringWrite,
  runSerializedCourseMonitoringWrites,
} from "./course-monitoring";
import { withSearchCheckWriteContext } from "./search-check-write-context";

describe("search check result writes", () => {
  it("rolls back monitoring work when the lease expires before commit", async () => {
    transaction.$queryRaw.mockReset()
      .mockResolvedValueOnce([{ id: "search-1" }])
      .mockResolvedValueOnce([]);
    const write = vi.fn(async () => "candidate match");

    await expect(withSearchCheckWriteContext(
      { searchId: "search-1", scheduleVersion: 7, leaseToken: "lease-1" },
      () => runSerializedCourseMonitoringWrite("course-1", write),
    )).rejects.toThrow("Search check lease changed");
    expect(write).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("does not hold the search row while a delivery callback renews its own authority", async () => {
    transaction.$queryRaw.mockReset();
    transaction.$queryRawUnsafe.mockReset().mockResolvedValue([{ locked: true }]);
    const send = vi.fn(async () => "accepted");

    await expect(withSearchCheckWriteContext(
      { searchId: "search-1", scheduleVersion: 7, leaseToken: "lease-1" },
      () => runSerializedCourseMonitoringWrites(
        ["course-1"],
        send,
        { skipSearchCheckWriteFence: true, retryWorker: false },
      ),
    )).resolves.toBe("accepted");
    expect(send).toHaveBeenCalledOnce();
    expect(transaction.$queryRawUnsafe).toHaveBeenCalledOnce();
    expect(transaction.$queryRaw).not.toHaveBeenCalled();
  });
});
