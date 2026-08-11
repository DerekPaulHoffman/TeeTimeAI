import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn()
}));
const emailMocks = vi.hoisted(() => ({
  sendAutomationWorkerHealthEmail: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationWorkerState: {
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      upsert: mocks.upsert,
      update: mocks.update,
      updateMany: mocks.updateMany
    }
  }
}));
vi.mock("@/lib/email/alerts", () => emailMocks);

import {
  AUTOMATION_WORKERS,
  checkAutomationWorkerHealth,
  getNextExpectedWorkerRun,
  heartbeatAutomationWorker,
  isAutomationWorkerExecutionAllowed,
  isAutomationWorkerOverdue,
  runWithAutomationWorkerHeartbeat,
  shouldRecordAutomationWorkerCycle
} from "./worker-state";

describe("automation worker state", () => {
  const now = new Date("2026-07-27T12:00:00.000Z");

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({
      desiredState: "ACTIVE",
      monitoringStartedAt: now,
      nextExpectedAt: getNextExpectedWorkerRun(now, AUTOMATION_WORKERS.COURSE_SUPPORT)
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    emailMocks.sendAutomationWorkerHealthEmail.mockResolvedValue({
      id: "operator-notice",
      deliveryStatus: "sent"
    });
  });

  it("calculates the next expected run from the configured cadence", () => {
    expect(getNextExpectedWorkerRun(now, AUTOMATION_WORKERS.COURSE_SUPPORT).toISOString()).toBe(
      "2026-07-27T12:10:00.000Z"
    );
  });

  it("detects course-support liveness at the durable 20-minute deadline", () => {
    const worker = {
      desiredState: "ACTIVE" as const,
      monitoringStartedAt: new Date("2026-07-27T11:00:00.000Z"),
      nextExpectedAt: new Date("2026-07-27T11:50:00.000Z"),
      graceSeconds: AUTOMATION_WORKERS.COURSE_SUPPORT.graceSeconds
    };
    expect(isAutomationWorkerOverdue(worker as never, new Date("2026-07-27T11:59:59.999Z"))).toBe(
      false
    );
    expect(isAutomationWorkerOverdue(worker as never, now)).toBe(true);
  });

  it("keeps a scheduled inspect healthy after it crosses the prior overdue deadline", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-27T11:50:00.000Z");
    vi.setSystemTime(startedAt);
    let finishInspect!: () => void;
    const inspect = new Promise<void>((resolve) => {
      finishInspect = resolve;
    });

    const running = runWithAutomationWorkerHeartbeat(
      AUTOMATION_WORKERS.COURSE_SUPPORT,
      () => inspect,
      { intervalMs: 4 * 60 * 1000 }
    );
    await vi.advanceTimersByTimeAsync(11 * 60 * 1000);

    expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE"
      },
      data: {
        lastHeartbeatAt: new Date("2026-07-27T11:58:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T12:08:00.000Z"),
        runtimeVersion: expect.any(String)
      }
    });
    expect(
      isAutomationWorkerOverdue(
        {
          desiredState: "ACTIVE",
          monitoringStartedAt: startedAt,
          nextExpectedAt: new Date("2026-07-27T12:08:00.000Z"),
          graceSeconds: AUTOMATION_WORKERS.COURSE_SUPPORT.graceSeconds
        } as never,
        new Date("2026-07-27T12:01:00.000Z")
      )
    ).toBe(false);

    finishInspect();
    await running;
  });

  it("moves the next expected time forward on start and heartbeat", async () => {
    await import("./worker-state").then(({ startAutomationWorker }) =>
      startAutomationWorker(AUTOMATION_WORKERS.COURSE_SUPPORT, { now })
    );
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          lastHeartbeatAt: now,
          nextExpectedAt: new Date("2026-07-27T12:10:00.000Z")
        })
      })
    );

    await heartbeatAutomationWorker(
      AUTOMATION_WORKERS.COURSE_SUPPORT,
      new Date("2026-07-27T12:04:00.000Z")
    );
    expect(mocks.updateMany).toHaveBeenLastCalledWith({
      where: {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE"
      },
      data: {
        lastHeartbeatAt: new Date("2026-07-27T12:04:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T12:14:00.000Z"),
        runtimeVersion: expect.any(String)
      }
    });
  });

  it("gives a compatible local reader a five-minute heartbeat deadline", () => {
    const nextExpectedAt = getNextExpectedWorkerRun(
      new Date("2026-07-27T11:55:00.000Z"),
      AUTOMATION_WORKERS.LOCAL_READER
    );
    expect(nextExpectedAt.toISOString()).toBe("2026-07-27T11:57:00.000Z");
    expect(
      isAutomationWorkerOverdue(
        {
          desiredState: "ACTIVE",
          monitoringStartedAt: new Date("2026-07-27T11:55:00.000Z"),
          nextExpectedAt,
          graceSeconds: AUTOMATION_WORKERS.LOCAL_READER.graceSeconds
        } as never,
        now
      )
    ).toBe(true);
  });

  it("records worker health only for the explicit scheduled inspect entrypoint", () => {
    expect(shouldRecordAutomationWorkerCycle({ command: "inspect", args: [] })).toBe(false);
    expect(shouldRecordAutomationWorkerCycle({ command: "coverage", args: [] })).toBe(false);
    expect(shouldRecordAutomationWorkerCycle({ command: "heartbeat", args: [] })).toBe(false);
    expect(
      shouldRecordAutomationWorkerCycle({
        command: "inspect",
        args: ["--scheduled-cycle"]
      })
    ).toBe(true);
    expect(() =>
      shouldRecordAutomationWorkerCycle({
        command: "heartbeat",
        args: ["--scheduled-cycle"]
      })
    ).toThrow("scheduled inspect entrypoint");
  });

  it("checks pause state without writing a manual-command heartbeat", async () => {
    mocks.findUnique.mockResolvedValue({ desiredState: "PAUSED" });

    await expect(
      isAutomationWorkerExecutionAllowed(AUTOMATION_WORKERS.COURSE_SUPPORT)
    ).resolves.toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { workerKey: "course-support-responder" },
      select: { desiredState: true }
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
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
    expect(isAutomationWorkerOverdue({ ...worker, desiredState: "PAUSED" } as never, now)).toBe(
      false
    );
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
    expect(emailMocks.sendAutomationWorkerHealthEmail).not.toHaveBeenCalled();
  });

  it("records one durable operator-visible notification for a newly overdue interval", async () => {
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
      notified: 1
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workerKey: "course-support-responder",
          nextExpectedAt: new Date("2026-07-27T11:00:00.000Z")
        }),
        data: expect.objectContaining({
          recoveredNotifiedAt: null
        })
      })
    );
    expect(emailMocks.sendAutomationWorkerHealthEmail).toHaveBeenCalledWith({
      workerKey: "course-support-responder",
      event: "overdue",
      expectedAt: new Date("2026-07-27T11:00:00.000Z"),
      observedAt: now
    });
  });

  it("records one deduplicated durable recovery notification", async () => {
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
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overdueSince: null,
          overdueNotifiedFor: null
        })
      })
    );
    expect(emailMocks.sendAutomationWorkerHealthEmail).toHaveBeenCalledWith({
      workerKey: "product-improvement",
      event: "recovered",
      expectedAt: new Date("2026-07-27T07:00:00.000Z"),
      observedAt: now
    });
  });

  it("leaves the overdue notification marker retryable when delivery fails", async () => {
    mocks.findMany.mockResolvedValue([
      {
        workerKey: "course-support-responder",
        desiredState: "ACTIVE",
        monitoringStartedAt: new Date("2026-07-27T10:00:00.000Z"),
        nextExpectedAt: new Date("2026-07-27T11:00:00.000Z"),
        graceSeconds: 600,
        overdueSince: null,
        overdueNotifiedFor: null,
        recoveredNotifiedAt: null
      }
    ]);
    emailMocks.sendAutomationWorkerHealthEmail.mockRejectedValue(
      new Error("operator delivery failed")
    );

    await expect(checkAutomationWorkerHealth(now)).rejects.toThrow("operator delivery failed");
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ overdueSince: null }),
        data: {
          overdueSince: new Date("2026-07-27T11:10:00.000Z")
        }
      })
    );
    expect(mocks.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          overdueNotifiedFor: expect.any(Date)
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
