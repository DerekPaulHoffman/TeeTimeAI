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
});
