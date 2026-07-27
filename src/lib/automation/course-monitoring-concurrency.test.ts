import { beforeEach, describe, expect, it, vi } from "vitest";

const transactionMocks = vi.hoisted(() => ({
  $queryRawUnsafe: vi.fn(),
  courseMonitoringEvent: {
    create: vi.fn()
  },
  courseMonitoringStatus: {
    update: vi.fn(),
    upsert: vi.fn()
  },
  courseSupportIncident: {
    findUnique: vi.fn()
  }
}));

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {},
  courseMonitoringStatus: {}
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import { recordCourseMonitoringSuccess } from "./course-monitoring";

describe("course monitoring write serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.$transaction
      .mockRejectedValueOnce(
        Object.assign(new Error("Transaction failed due to a write conflict"), {
          code: "P2034"
        })
      )
      .mockImplementation(async (worker) => worker(transactionMocks));
    transactionMocks.$queryRawUnsafe.mockResolvedValue([]);
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 7
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue(null);
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8
    });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1"
    });
  });

  it("retries a write conflict and serializes writes by course", async () => {
    await expect(
      recordCourseMonitoringSuccess({
        courseId: "course-1",
        outcome: "NO_MATCH",
        now: new Date("2026-07-27T15:45:00.000Z")
      })
    ).resolves.toMatchObject({
      courseId: "course-1",
      state: "HEALTHY",
      revision: 8
    });

    expect(prismaMocks.$transaction).toHaveBeenCalledTimes(2);
    expect(prismaMocks.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        isolationLevel: "ReadCommitted",
        timeout: 15_000
      })
    );
    expect(transactionMocks.$queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
      "course-monitoring:course-1"
    );
  });
});
