import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  hasDatabaseConfig: vi.fn(),
  listSearchesNeedingScheduleRecovery: vi.fn(),
  recoverDueCourseSupportVerificationRequests: vi.fn(),
  recoverPendingClerkEmailUpdates: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => ({
  listSearchesNeedingScheduleRecovery: mocks.listSearchesNeedingScheduleRecovery
}));

vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
}));

vi.mock("@/lib/automation/course-support-verification-scheduler", () => ({
  recoverDueCourseSupportVerificationRequests:
    mocks.recoverDueCourseSupportVerificationRequests
}));

vi.mock("@/lib/users/pending-email", () => ({
  recoverPendingClerkEmailUpdates: mocks.recoverPendingClerkEmailUpdates
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

const originalCronSecret = process.env.CRON_SECRET;

describe("GET /api/cron/recover-search-schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    mocks.hasDatabaseConfig.mockReturnValue(false);
    mocks.recoverPendingClerkEmailUpdates.mockResolvedValue({
      considered: 0,
      applied: 0,
      deferred: 0,
      failed: 0
    });
    mocks.recoverDueCourseSupportVerificationRequests.mockResolvedValue({
      considered: 0,
      started: 0,
      skipped: 0,
      failed: 0
    });
  });

  afterEach(() => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
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
    expect(
      mocks.recoverDueCourseSupportVerificationRequests
    ).not.toHaveBeenCalled();
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
      courseSupportVerification: {
        considered: 0,
        started: 0,
        skipped: 0,
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
    expect(
      mocks.recoverDueCourseSupportVerificationRequests
    ).toHaveBeenCalledTimes(1);
  });

  it("continues customer schedule recovery when provider verification recovery fails", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.recoverDueCourseSupportVerificationRequests.mockRejectedValue(
      new Error("verification recovery unavailable")
    );
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      { id: "search-1" }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });

    const response = await GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      courseSupportVerification: {
        considered: 0,
        started: 0,
        skipped: 0,
        failed: 1
      },
      considered: 1,
      restarted: 1,
      failed: 0
    });
  });

  it("starts customer schedule recovery before awaiting detached verification", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.listSearchesNeedingScheduleRecovery.mockResolvedValue([
      { id: "search-1" }
    ]);
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });
    let releaseDetachedRecovery!: (value: {
      considered: number;
      started: number;
      skipped: number;
      failed: number;
    }) => void;
    mocks.recoverDueCourseSupportVerificationRequests.mockReturnValue(
      new Promise((resolve) => {
        releaseDetachedRecovery = resolve;
      })
    );

    const responsePromise = GET(
      new Request("http://localhost/api/cron/recover-search-schedules", {
        headers: { authorization: "Bearer test-cron-secret" }
      })
    );
    await vi.waitFor(() => {
      expect(mocks.startSearchSchedule).toHaveBeenCalledWith("search-1");
      expect(
        mocks.recoverDueCourseSupportVerificationRequests
      ).toHaveBeenCalledTimes(1);
    });

    releaseDetachedRecovery({
      considered: 0,
      started: 0,
      skipped: 0,
      failed: 0
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
  });

  it("configures a Pro recovery heartbeat every five minutes", () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")
    ) as {
      crons?: Array<{ path: string; schedule: string }>;
    };

    expect(config.crons).toContainEqual({
      path: "/api/cron/recover-search-schedules",
      schedule: "*/5 * * * *"
    });
  });
});
