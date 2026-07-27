import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertLocalReaderRequest: vi.fn(),
  completeLocalReaderJob: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));
vi.mock("@/lib/local-reader/auth", () => ({
  assertLocalReaderRequest: mocks.assertLocalReaderRequest
}));
vi.mock("@/lib/local-reader/service", () => ({
  completeLocalReaderJob: mocks.completeLocalReaderJob
}));
vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
}));

import { POST } from "./route";

const result = {
  jobId: "job-1",
  courseKey: "grassy-hill",
  status: "NO_AVAILABILITY",
  observedAt: "2026-07-27T16:00:00.000Z",
  pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
  pageTitle: "Grassy Hill Country Club",
  slots: [],
  readerVersion: "1.3.3"
};

function request() {
  return new NextRequest("https://teetimespot.com/api/local-reader/jobs/job-1/result", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-reader-lease": "lease-1"
    },
    body: JSON.stringify(result)
  });
}

describe("local reader result route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertLocalReaderRequest.mockReturnValue(null);
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.completeLocalReaderJob.mockResolvedValue({
      searchId: "search-1",
      completedAt: new Date("2026-07-27T16:00:00.000Z")
    });
    mocks.startSearchSchedule.mockResolvedValue({ runId: "run-1" });
  });

  it("resumes the owning search after durable result completion", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ id: "job-1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "COMPLETED",
      completedAt: "2026-07-27T16:00:00.000Z"
    });
    expect(mocks.startSearchSchedule).toHaveBeenCalledWith("search-1");
  });

  it("keeps a completed result durable when workflow restart is temporarily unavailable", async () => {
    mocks.startSearchSchedule.mockRejectedValue(new Error("workflow unavailable"));

    const response = await POST(request(), {
      params: Promise.resolve({ id: "job-1" })
    });

    expect(response.status).toBe(200);
    expect(mocks.completeLocalReaderJob).toHaveBeenCalledOnce();
  });
});
