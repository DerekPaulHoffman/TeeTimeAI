import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  assertAutomationRequest: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  listActiveSearchesForAutomation: vi.fn()
}));

vi.mock("@/lib/api/automation-auth", () => ({
  assertAutomationRequest: mocks.assertAutomationRequest
}));

vi.mock("@/lib/automation/db-service", () => ({
  listActiveSearchesForAutomation: mocks.listActiveSearchesForAutomation
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("GET /api/automation/active-searches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAutomationRequest.mockReturnValue(null);
    mocks.hasDatabaseConfig.mockReturnValue(false);
  });

  it("returns 503 before reading searches when the database is unavailable", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/automation/active-searches")
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Automation searches are temporarily unavailable."
    });
    expect(mocks.listActiveSearchesForAutomation).not.toHaveBeenCalled();
  });
});
