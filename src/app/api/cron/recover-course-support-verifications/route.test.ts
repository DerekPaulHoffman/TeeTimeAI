import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasDatabaseConfig: vi.fn(),
  recoverDueCourseSupportVerificationRequests: vi.fn(),
  expireOverdueDiscoveryJobs: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.hasDatabaseConfig }));
vi.mock("@/lib/automation/course-support-verification-scheduler", () => ({
  recoverDueCourseSupportVerificationRequests: mocks.recoverDueCourseSupportVerificationRequests
}));
vi.mock("@/lib/course-discovery/service", () => ({ expireOverdueDiscoveryJobs: mocks.expireOverdueDiscoveryJobs }));

import { GET } from "./route";

const originalCronSecret = process.env.CRON_SECRET;

describe("GET /api/cron/recover-course-support-verifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "test-cron-secret";
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.expireOverdueDiscoveryJobs.mockResolvedValue({ queueTimedOut: 1, executionTimedOut: 2 });
    mocks.recoverDueCourseSupportVerificationRequests.mockResolvedValue({
      considered: 2,
      started: 1,
      skipped: 1,
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

  it("rejects requests without the cron authority", async () => {
    const response = await GET(
      new Request("http://localhost/api/cron/recover-course-support-verifications")
    );

    expect(response.status).toBe(401);
    expect(mocks.hasDatabaseConfig).not.toHaveBeenCalled();
    expect(mocks.recoverDueCourseSupportVerificationRequests).not.toHaveBeenCalled();
    expect(mocks.expireOverdueDiscoveryJobs).not.toHaveBeenCalled();
  });

  it("fails closed when database configuration is unavailable", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(false);

    const response = await authorizedRequest();

    expect(response.status).toBe(503);
    expect(mocks.recoverDueCourseSupportVerificationRequests).not.toHaveBeenCalled();
  });

  it("dispatches only due detached verification work", async () => {
    const response = await authorizedRequest();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      considered: 2,
      started: 1,
      skipped: 1,
      failed: 0,
      discoveryDeadlines: { queueTimedOut: 1, executionTimedOut: 2 },
    });
    expect(mocks.recoverDueCourseSupportVerificationRequests).toHaveBeenCalledTimes(1);
  });

  it("returns a failing cron status when any detached workflow start fails", async () => {
    mocks.recoverDueCourseSupportVerificationRequests.mockResolvedValue({
      considered: 2,
      started: 1,
      skipped: 0,
      failed: 1,
    });

    const response = await authorizedRequest();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      considered: 2,
      started: 1,
      skipped: 0,
      failed: 1,
      discoveryDeadlines: { queueTimedOut: 1, executionTimedOut: 2 },
    });
  });

  it("reports an isolated discovery sweep failure while still dispatching verification", async () => {
    mocks.expireOverdueDiscoveryJobs.mockRejectedValueOnce(new Error("private error"));
    const response = await authorizedRequest();
    expect(response.status).toBe(503);
    expect(mocks.recoverDueCourseSupportVerificationRequests).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({ started: 1, discoveryDeadlines: { failed: true } });
  });

  it("returns a generic 503 when detached dispatch cannot inspect durable work", async () => {
    mocks.recoverDueCourseSupportVerificationRequests.mockRejectedValue(
      new Error("database detail must not escape")
    );

    const response = await authorizedRequest();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Course-support verification recovery is temporarily unavailable."
    });
  });

  it("configures the dedicated dispatcher every minute", () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), "vercel.json"), "utf8")) as {
      crons?: Array<{ path: string; schedule: string }>;
    };

    expect(config.crons).toContainEqual({
      path: "/api/cron/recover-course-support-verifications",
      schedule: "* * * * *"
    });
  });
});

function authorizedRequest() {
  return GET(
    new Request("http://localhost/api/cron/recover-course-support-verifications", {
      headers: { authorization: "Bearer test-cron-secret" }
    })
  );
}
