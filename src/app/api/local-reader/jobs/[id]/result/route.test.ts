import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertLocalReaderRequest: vi.fn(),
  completeLocalReaderJob: vi.fn(),
  hasDatabaseConfig: vi.fn()
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

import { POST } from "./route";

const result = {
  jobId: "job-1",
  courseKey: "cps:grassyhill.cps.golf",
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
      "x-local-reader-lease": "lease-1",
      "x-local-reader-timestamp": String(
        Date.parse("2026-07-27T16:00:00.000Z")
      )
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
      completedAt: new Date("2026-07-27T16:00:00.000Z"),
      resumeScheduleVersion: 8
    });
  });

  it("acknowledges only after result completion durably queues the owning search", async () => {
    const response = await POST(request(), {
      params: Promise.resolve({ id: "job-1" })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "COMPLETED",
      completedAt: "2026-07-27T16:00:00.000Z"
    });
    expect(mocks.completeLocalReaderJob).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseToken: "lease-1",
      result,
      receivedAt: expect.any(Date),
      deviceRequestAt: new Date("2026-07-27T16:00:00.000Z")
    });
  });

  it("does not perform a second best-effort scheduler mutation after durable completion", async () => {

    const response = await POST(request(), {
      params: Promise.resolve({ id: "job-1" })
    });

    expect(response.status).toBe(200);
    expect(mocks.completeLocalReaderJob).toHaveBeenCalledOnce();
  });
});
