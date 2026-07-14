import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  assertAutomationRequest: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  recordTeeTimeMatch: vi.fn()
}));

vi.mock("@/lib/api/automation-auth", () => ({
  assertAutomationRequest: mocks.assertAutomationRequest
}));

vi.mock("@/lib/automation/db-service", () => ({
  recordTeeTimeMatch: mocks.recordTeeTimeMatch
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("POST /api/automation/matches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAutomationRequest.mockReturnValue(null);
    mocks.hasDatabaseConfig.mockReturnValue(false);
  });

  it("returns 503 before parsing or recording a match when the database is unavailable", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/automation/matches", { method: "POST" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Automation match recording is temporarily unavailable."
    });
    expect(mocks.recordTeeTimeMatch).not.toHaveBeenCalled();
  });
});
