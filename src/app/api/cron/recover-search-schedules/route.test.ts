import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  hasDatabaseConfig: vi.fn(),
  listSearchesNeedingScheduleRecovery: vi.fn(),
  checkAutomationWorkerHealth: vi.fn(),
  expireOverdueLocalReaderJobs: vi.fn(),
  revalidateHumanReviewCoursesForDeployment: vi.fn(),
  runCourseMonitoringWatchdog: vi.fn(),
  recoverPendingClerkEmailUpdates: vi.fn(),
  consumeSearchScheduleQueueMessage: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => ({
  listSearchesNeedingScheduleRecovery: mocks.listSearchesNeedingScheduleRecovery
}));

vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
}));

vi.mock("@/lib/automation/search-schedule-consumer", () => ({
  consumeSearchScheduleQueueMessage:
    mocks.consumeSearchScheduleQueueMessage
}));

vi.mock("@/lib/automation/worker-state", () => ({
  checkAutomationWorkerHealth: mocks.checkAutomationWorkerHealth
}));

vi.mock("@/lib/local-reader/service", () => ({
  expireOverdueLocalReaderJobs: mocks.expireOverdueLocalReaderJobs
}));

vi.mock("@/lib/automation/course-monitoring", () => ({
  revalidateHumanReviewCoursesForDeployment:
    mocks.revalidateHumanReviewCoursesForDeployment,
  runCourseMonitoringWatchdog: mocks.runCourseMonitoringWatchdog
}));

vi.mock("@/lib/users/pending-email", () => ({
  recoverPendingClerkEmailUpdates: mocks.recoverPendingClerkEmailUpdates
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

const originalCronSecret = process.env.CRON_SECRET;
const originalDeploymentSha = process.env.VERCEL_GIT_COMMIT_SHA;

describe("GET /api/cron/recover-search-schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.VERCEL_GIT_COMMIT_SHA = "a".repeat(40);
    mocks.hasDatabaseConfig.mockReturnValue(false);
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 0,
      applied: 0,
      deferred: 0,
      failed: 0
    });
    mocks.checkAutomationWorkerHealth.mockResolvedValue({
      considered: 2,
      overdue: 0,
      notified: 0,
      recovered: 0
    });
    mocks.expireOverdueLocalReaderJobs.mockResolvedValue({
      considered: 0,
      expired: 0,
      notified: 0
    });
    mocks.runCourseMonitoringWatchdog.mockResolvedValue({
      checked: 0,
      scheduled: 0,
      escalated: 0,
      remindersSent: 0,
      failed: 0
    });
    mocks.revalidateHumanReviewCoursesForDeployment.mockResolvedValue({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0
    });
    mocks.consumeSearchScheduleQueueMessage.mockResolvedValue({
      outcome: "started"
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    if (originalDeploymentSha === undefined) {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
    } else {
      process.env.VERCEL_GIT_COMMIT_SHA = originalDeploymentSha;
    }
  });

  it("returns 503 before finding schedules when the database is unavailable", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Search schedule recovery is temporarily unavailable."
    });
    expect(mocks.listSearchesNeedingScheduleRecovery).not.toHaveBeenCalled();
    expect(mocks.recoverPendingClerkEmailUpdates).not.toHaveBeenCalled();
    expect(mocks.expireOverdueLocalReaderJobs).not.toHaveBeenCalled();
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
  });

  it("restarts every eligible schedule independently", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 3,
      applied: 2,
      deferred: 1,
      failed: 0
    });
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      { id: "search-1" },
      { id: "search-2" },
      { id: "search-3" }
    ]);
    mocks.startSearchSchedule
      .mockResolvedValueOnce({ runId: "run-1" })
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValueOnce({ runId: "run-3" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pendingEmailRecovery: {
        considered: 3,
        applied: 2,
        deferred: 1,
        failed: 0
      },
      automationWorkerHealth: {
        considered: 2,
        overdue: 0,
        notified: 0,
        recovered: 0,
        failed: 0
      },
      localReaderJobDeadlines: {
        considered: 0,
        expired: 0,
        notified: 0,
        failed: 0
      },
      deploymentCourseRevalidation: {
        considered: 0,
        requeued: 0,
        retainedAuthoritativeFinals: 0,
        failed: 0
      },
      courseMonitoring: {
        checked: 0,
        scheduled: 0,
        escalated: 0,
        remindersSent: 0,
        failed: 0
      },
      considered: 3,
      restarted: 2,
      failed: 1
    });
    expect(mocks.startSearchSchedule).toHaveBeenCalledTimes(3);
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(1, "search-1");
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(2, "search-2");
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(3, "search-3");
    expect(mocks.recoverPendingClerkEmailUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.expireOverdueLocalReaderJobs).toHaveBeenCalledTimes(1);
    expect(mocks.revalidateHumanReviewCoursesForDeployment).toHaveBeenCalledWith({
      deploymentSha: "a".repeat(40)
    });
  });

  it("recovers a queued workflow loss on the same schedule version", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      {
        id: "search-queued",
        scheduleVersion: 7,
        checkStatus: "QUEUED",
        workflowRunId: null
      }
    ]);

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeSearchScheduleQueueMessage).toHaveBeenCalledWith({
      searchId: "search-queued",
      scheduleVersion: 7,
      trigger: "START_FAILED"
    });
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
  });

  it("restarts a just-escalated waiting workflow only from its observed state", async () => {
    vi.useFakeTimers();
    const observedAt = new Date("2026-08-11T20:28:01.000Z");
    vi.setSystemTime(observedAt);
    const updatedAt = new Date("2026-08-11T20:28:00.000Z");
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      {
        id: "search-waiting-escalated",
        scheduleVersion: 6,
        checkStatus: "WAITING",
        workflowRunId: "workflow-sleeping",
        nextCheckAt: new Date("2026-08-11T20:33:00.000Z"),
        updatedAt
      }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({
      runId: "workflow-replacement",
      scheduleVersion: 7,
      reused: false
    });

    try {
      const response = await GET(
        new Request("http://localhost/api/cron/recover-search-schedules", {
          headers: { authorization: "Bearer test-cron-secret" }
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.listSearchesNeedingScheduleRecovery).toHaveBeenCalledWith(
        observedAt
      );
      expect(mocks.startSearchSchedule).toHaveBeenCalledWith(
        "search-waiting-escalated",
        {
          expectedState: {
            scheduleVersion: 6,
            updatedAt,
            observedAt,
            checkStatus: "WAITING",
            workflowRunId: "workflow-sleeping"
          }
        }
      );
      expect(mocks.consumeSearchScheduleQueueMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a replacement at T+27 when an attached T+28 endpoint wake may be lost", async () => {
    vi.useFakeTimers();
    const observedAt = new Date("2026-08-11T20:27:00.000Z");
    const updatedAt = new Date("2026-08-11T20:20:00.000Z");
    vi.setSystemTime(observedAt);
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      {
        id: "search-phase-offset",
        scheduleVersion: 7,
        checkStatus: "WAITING",
        workflowRunId: "workflow-may-be-lost",
        nextCheckAt: new Date("2026-08-11T20:28:00.000Z"),
        updatedAt,
        endpointRecoveryDispatchKey: "endpoint-deadline:incident-1:3"
      }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({
      runId: "workflow-replacement",
      scheduleVersion: 8,
      reused: false
    });

    try {
      const response = await GET(
        new Request("http://localhost/api/cron/recover-search-schedules", {
          headers: { authorization: "Bearer test-cron-secret" }
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.startSearchSchedule).toHaveBeenCalledWith(
        "search-phase-offset",
        {
          expectedState: {
            scheduleVersion: 7,
            updatedAt,
            observedAt,
            checkStatus: "WAITING",
            workflowRunId: "workflow-may-be-lost",
            recoveryDispatchKey: "endpoint-deadline:incident-1:3"
          }
        }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a just-escalated attached queued workflow with an exact-state guard", async () => {
    vi.useFakeTimers();
    const observedAt = new Date("2026-08-11T20:28:01.000Z");
    vi.setSystemTime(observedAt);
    const updatedAt = new Date("2026-08-11T20:28:00.000Z");
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      {
        id: "search-queued-attached",
        scheduleVersion: 9,
        checkStatus: "QUEUED",
        workflowRunId: "workflow-sleeping",
        nextCheckAt: observedAt,
        updatedAt,
        endpointRecoveryDispatchKey: "endpoint-deadline:incident-1:3"
      }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({
      runId: "workflow-replacement",
      scheduleVersion: 10,
      reused: false
    });

    try {
      const response = await GET(
        new Request("http://localhost/api/cron/recover-search-schedules", {
          headers: { authorization: "Bearer test-cron-secret" }
        })
      );

      expect(response.status).toBe(200);
      expect(mocks.startSearchSchedule).toHaveBeenCalledWith(
        "search-queued-attached",
        {
          expectedState: {
            scheduleVersion: 9,
            updatedAt,
            observedAt,
            checkStatus: "QUEUED",
            workflowRunId: "workflow-sleeping",
            recoveryDispatchKey: "endpoint-deadline:incident-1:3"
          }
        }
      );
      expect(mocks.consumeSearchScheduleQueueMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles course deadlines before selecting and starting due searches", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      { id: "search-deadline" }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-deadline" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.runCourseMonitoringWatchdog).toHaveBeenCalledTimes(1);
    expect(mocks.listSearchesNeedingScheduleRecovery).toHaveBeenCalledTimes(1);
    expect(
      mocks.runCourseMonitoringWatchdog.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.listSearchesNeedingScheduleRecovery.mock.invocationCallOrder[0]
    );
    expect(
      mocks.listSearchesNeedingScheduleRecovery.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.startSearchSchedule.mock.invocationCallOrder[0]);
  });

  it("continues recovery when deployment course revalidation fails", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.revalidateHumanReviewCoursesForDeployment.mockRejectedValue(
      new Error("deployment revalidation unavailable")
    );
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([{ id: "search-1" }]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    await expect(response.json()).resolves.toMatchObject({
      deploymentCourseRevalidation: { failed: 1 },
      restarted: 1
    });
  });

  it("continues every customer recovery path when worker health fails", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.checkAutomationWorkerHealth.mockRejectedValue(new Error("worker health unavailable"));
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 1,
      applied: 1,
      deferred: 0,
      failed: 0
    });
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([{ id: "search-1" }]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pendingEmailRecovery: { applied: 1 },
      automationWorkerHealth: { failed: 1 },
      restarted: 1
    });
  });

  it("continues every other recovery path when the reader deadline sweep fails", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.expireOverdueLocalReaderJobs.mockRejectedValue(new Error("reader sweep unavailable"));
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 1,
      applied: 1,
      deferred: 0,
      failed: 0
    });
    mocks.revalidateHumanReviewCoursesForDeployment.mockResolvedValue({
      considered: 0,
      requeued: 0,
      retainedAuthoritativeFinals: 0
    });
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([{ id: "search-1" }]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pendingEmailRecovery: { applied: 1 },
      automationWorkerHealth: { failed: 0 },
      localReaderJobDeadlines: {
        considered: 0,
        expired: 0,
        notified: 0,
        failed: 1
      },
      restarted: 1
    });
  });

  it("continues customer, email, and provider recovery when course monitoring fails", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.runCourseMonitoringWatchdog.mockRejectedValue(new Error("course lifecycle unavailable"));
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 1,
      applied: 1,
      deferred: 0,
      failed: 0
    });
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([{ id: "search-1" }]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      pendingEmailRecovery: { applied: 1 },
      courseMonitoring: { failed: 1 },
      restarted: 1
    });
  });

  it("configures general recovery every five minutes", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };

    expect(config.crons).toContainEqual({
      path: "/api/cron/recover-search-schedules",
      schedule: "*/5 * * * *"
    });
  });
});
