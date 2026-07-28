import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationWorkerState: {
      findMany: mocks.findMany,
      update: mocks.update
    }
  }
}));

import {
  AUTOMATION_WORKERS,
  checkAutomationWorkerHealth,
  getNextExpectedWorkerRun,
  isAutomationWorkerOverdue
} from "./worker-state";

describe("automation worker state", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
  });

  it("calculates the next expected run from the configured cadence", () => {
    expect(
      getNextExpectedWorkerRun(now, AUTOMATION_WORKERS.COURSE_SUPPORT).toISOString()
    ).toBe("2026-07-27T12:10:00.000Z");
  });

  it("does not monitor a worker until its first heartbeat starts monitoring", () => {
    expect(
      isAutomationWorkerOverdue(
        {
          desiredState: "ACTIVE",
          monitoringStartedAt: null,
          nextExpectedAt: new Date("2026-07-27T11:00:00.000Z"),
          graceSeconds: 60
        } as never,
        now
      )
    ).toBe(false);
  });

  it("honors desired state and the grace interval", () => {
    const worker = {
      desiredState: "ACTIVE" as const,
      monitoringStartedAt: new Date("2026-07-27T11:00:00.000Z"),
      nextExpectedAt: new Date("2026-07-27T11:49:59.000Z"),
      graceSeconds: 10 * 60
    };
    expect(isAutomationWorkerOverdue(worker as never, now)).toBe(true);
    expect(
      isAutomationWorkerOverdue({ ...worker, desiredState: "PAUSED" } as never, now)
    ).toBe(false);
  });

  it("deduplicates overdue alerts for the same expected interval", async () => {
    mocks.findMany.mockResolvedValue([
      {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE",
        monitoringStartedAt: new Date("2026-07-27T10:00:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T11:00:00.000Z"),
        graceSeconds: 600,
        overdueSince: new Date("2026-07-27T11:10:00.000Z"),
        overdueNotifiedFor: new Date("2026-07-27T11:00:00.000Z"),
        recoveredNotifiedAt: null
      }
    ]);

    await expect(checkAutomationWorkerHealth(now)).resolves.toMatchObject({
      overdue: 1,
      notified: 0
    });
  });

  it("records a newly overdue interval without sending email", async () => {
    mocks.findMany.mockResolvedValue([
      {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE",
        monitoringStartedAt: new Date("2026-07-27T10:00:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T11:00:00.000Z"),
        graceSeconds: 600,
        overdueSince: null,
        overdueNotifiedFor: new Date("2026-07-27T10:00:00.000Z"),
        recoveredNotifiedAt: new Date("2026-07-27T10:20:00.000Z")
      }
    ]);

    await expect(checkAutomationWorkerHealth(now)).resolves.toMatchObject({
      overdue: 1,
      notified: 0
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recoveredNotifiedAt: null
        })
      })
    );
  });

  it("records recovery without sending email", async () => {
    mocks.findMany.mockResolvedValue([
      {
        workerKey: "product-improvement",
        desiredState: "ACTIVE",
        monitoringStartedAt: new Date("2026-07-27T01:00:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T18:00:00.000Z"),
        graceSeconds: 1800,
        overdueSince: new Date("2026-07-27T08:00:00.000Z"),
        overdueNotifiedFor: new Date("2026-07-27T07:00:00.000Z"),
        recoveredNotifiedAt: null
      }
    ]);

    await expect(checkAutomationWorkerHealth(now)).resolves.toMatchObject({
      recovered: 1
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overdueSince: null,
          overdueNotifiedFor: null
        })
      })
    );
  });

  it("records recovery for a newer overdue interval after an earlier recovery", async () => {
    mocks.findMany.mockResolvedValue([
      {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE",
        monitoringStartedAt: new Date("2026-07-27T01:00:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T12:10:00.000Z"),
        graceSeconds: 600,
        overdueSince: new Date("2026-07-27T11:40:00.000Z"),
        overdueNotifiedFor: new Date("2026-07-27T11:30:00.000Z"),
        recoveredNotifiedAt: new Date("2026-07-27T08:00:00.000Z")
      }
    ]);

    await expect(checkAutomationWorkerHealth(now)).resolves.toMatchObject({
      recovered: 1
    });
  });
});
