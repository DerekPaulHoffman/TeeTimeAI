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

import {
  recordCourseMonitoringFinalClassification,
  recordCourseMonitoringSuccess
} from "./course-monitoring";

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
      `WITH acquired AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
     )
     SELECT true AS locked FROM acquired`,
      "course-monitoring:course-1"
    );
  });

  it.each([
    ["manual", "FINAL_MANUAL", "MANUAL_DIRECT"],
    ["identity", "FINAL_IDENTITY", "IDENTITY_FINAL"]
  ] as const)(
    "does not rewrite or append a transition for an unchanged clean %s final",
    async (_label, state, outcome) => {
      prismaMocks.$transaction.mockReset();
      prismaMocks.$transaction.mockImplementation(async (worker) => worker(transactionMocks));
      transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
        courseId: "course-1",
        state,
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: 8
      });

      await expect(
        recordCourseMonitoringFinalClassification({
          courseId: "course-1",
          state,
          outcome,
          message: "Official evidence confirms the final classification.",
          now: new Date("2026-07-27T15:50:00.000Z")
        })
      ).resolves.toMatchObject({
        state,
        revision: 8
      });

      expect(transactionMocks.courseMonitoringStatus.update).not.toHaveBeenCalled();
      expect(transactionMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
    }
  );

  it("repairs a dirty final snapshot without recording a same-state transition", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) => worker(transactionMocks));
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 2,
      failureFingerprint: "PHONE_ONLY:STALE",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9
    });

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      now: new Date("2026-07-27T15:50:00.000Z")
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith({
      where: {
        courseId: "course-1",
        revision: 8
      },
      data: {
        state: "FINAL_MANUAL",
        consecutiveFailures: 0,
        failureFingerprint: null,
        firstDegradedAt: null,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
        revision: { increment: 1 }
      }
    });
    expect(transactionMocks.courseMonitoringEvent.create).not.toHaveBeenCalled();
  });

  it("records one transition when a course enters a manual final state", async () => {
    prismaMocks.$transaction.mockReset();
    prismaMocks.$transaction.mockImplementation(async (worker) => worker(transactionMocks));
    transactionMocks.courseMonitoringStatus.upsert.mockResolvedValue({
      courseId: "course-1",
      state: "AUTO_INVESTIGATING",
      consecutiveFailures: 3,
      failureFingerprint: "PHONE_ONLY:CONFIRMED",
      firstDegradedAt: new Date("2026-07-27T15:40:00.000Z"),
      nextAutomaticAttemptAt: new Date("2026-07-27T15:55:00.000Z"),
      revalidationRequestedAt: null,
      revision: 8
    });
    transactionMocks.courseMonitoringStatus.update.mockResolvedValue({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      consecutiveFailures: 0,
      revision: 9
    });
    const now = new Date("2026-07-27T15:50:00.000Z");

    await recordCourseMonitoringFinalClassification({
      courseId: "course-1",
      state: "FINAL_MANUAL",
      outcome: "MANUAL_DIRECT",
      message: "Official evidence confirms phone-only booking.",
      evidenceUrl: "https://course.example/booking",
      runtimeVersion: "release-sha",
      now
    });

    expect(transactionMocks.courseMonitoringStatus.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "FINAL_MANUAL",
          stateChangedAt: now
        })
      })
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledTimes(1);
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "STATE_CHANGED",
        fromState: "AUTO_INVESTIGATING",
        toState: "FINAL_MANUAL",
        outcome: "MANUAL_DIRECT",
        occurredAt: now
      })
    });
  });
});
