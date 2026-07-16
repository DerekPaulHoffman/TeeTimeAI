import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  assertAutomationRequest: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  recordCourseProbe: vi.fn()
}));

vi.mock("@/lib/api/automation-auth", () => ({
  assertAutomationRequest: mocks.assertAutomationRequest
}));

vi.mock("@/lib/automation/db-service", () => ({
  recordCourseProbe: mocks.recordCourseProbe
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("POST /api/automation/probes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAutomationRequest.mockReturnValue(null);
    mocks.hasDatabaseConfig.mockReturnValue(false);
  });

  it("returns 503 before parsing or recording a probe when the database is unavailable", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/automation/probes", { method: "POST" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Automation probe recording is temporarily unavailable."
    });
    expect(mocks.recordCourseProbe).not.toHaveBeenCalled();
  });

  it("retains legacy BLOCKED_POLICY probe compatibility during remediation", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.recordCourseProbe.mockResolvedValue({ id: "probe-1" });

    const response = await POST(
      new NextRequest("http://localhost/api/automation/probes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          searchId: "search-1",
          courseId: "course-1",
          outcome: "BLOCKED_POLICY",
          message: "Legacy policy evidence requires revalidation."
        })
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.recordCourseProbe).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "BLOCKED_POLICY" })
    );
  });
});
