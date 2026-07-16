import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  hasDatabaseConfig: vi.fn(),
  listSearchesNeedingScheduleRecovery: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/automation/db-service", () => ({
  listSearchesNeedingScheduleRecovery: mocks.listSearchesNeedingScheduleRecovery
}));

vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
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
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
  });

  it("restarts every eligible schedule independently", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
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
      considered: 3,
      restarted: 2,
      failed: 1
    });
    expect(mocks.startSearchSchedule).toHaveBeenCalledTimes(3);
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(1, "search-1");
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(2, "search-2");
    expect(mocks.startSearchSchedule).toHaveBeenNthCalledWith(3, "search-3");
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
