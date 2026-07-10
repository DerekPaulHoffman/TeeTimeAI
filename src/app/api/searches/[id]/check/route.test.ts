import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  getRequiredAppUser: vi.fn(),
  getTeeSearchForUser: vi.fn(),
  hasClerkConfig: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("@/lib/auth/current-user", () => ({
  getRequiredAppUser: mocks.getRequiredAppUser
}));
vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
}));
vi.mock("@/lib/env", () => ({
  hasClerkConfig: mocks.hasClerkConfig,
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));
vi.mock("@/lib/searches/service", () => ({
  getTeeSearchForUser: mocks.getTeeSearchForUser
}));

describe("POST /api/searches/[id]/check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseConfig.mockReturnValue(true);
  });

  it("does not expose the POC check path when account auth is unavailable", async () => {
    mocks.hasClerkConfig.mockReturnValue(false);

    const response = await POST(new NextRequest("http://localhost/api/searches/search-2/check"), {
      params: Promise.resolve({ id: "search-2" })
    });

    expect(response.status).toBe(503);
    expect(mocks.getRequiredAppUser).not.toHaveBeenCalled();
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
  });

  it("looks up the search through the authenticated owner's user id", async () => {
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockResolvedValue({ id: "user-1" });
    mocks.getTeeSearchForUser.mockResolvedValue(null);

    const response = await POST(new NextRequest("http://localhost/api/searches/search-2/check"), {
      params: Promise.resolve({ id: "search-2" })
    });

    expect(response.status).toBe(404);
    expect(mocks.getTeeSearchForUser).toHaveBeenCalledWith("user-1", "search-2");
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
  });
});
