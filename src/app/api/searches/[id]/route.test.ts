import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PATCH } from "./route";

const mocks = vi.hoisted(() => ({
  getRequiredAppUser: vi.fn(),
  hasClerkConfig: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  startSearchSchedule: vi.fn(),
  stopSearchSchedule: vi.fn(),
  updateTeeSearchForUser: vi.fn()
}));

vi.mock("@/lib/auth/current-user", () => ({
  getRequiredAppUser: mocks.getRequiredAppUser
}));
vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: mocks.startSearchSchedule
}));
vi.mock("@/lib/automation/db-service", () => ({
  stopSearchSchedule: mocks.stopSearchSchedule
}));
vi.mock("@/lib/env", () => ({
  hasClerkConfig: mocks.hasClerkConfig,
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));
vi.mock("@/lib/searches/service", () => ({
  deleteTeeSearchForUser: vi.fn(),
  updateTeeSearchForUser: mocks.updateTeeSearchForUser
}));

describe("PATCH /api/searches/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockResolvedValue({ id: "user-1" });
  });

  it("returns the customer-safe mutation projection after a newer course failure", async () => {
    // The service regression covers S0 at 14:00 followed by F1 at 14:01.
    // This route assertion protects the final authenticated JSON boundary.
    mocks.updateTeeSearchForUser.mockResolvedValue({
      id: "search-1",
      status: "PAUSED",
      alertGeneration: 4,
      matches: []
    });

    const response = await PATCH(
      new NextRequest("http://localhost/api/searches/search-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "PAUSED" })
      }),
      { params: Promise.resolve({ id: "search-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.updateTeeSearchForUser).toHaveBeenCalledWith(
      "user-1",
      "search-1",
      { status: "PAUSED" }
    );
    expect(mocks.stopSearchSchedule).toHaveBeenCalledWith("search-1");
    await expect(response.json()).resolves.toEqual({
      search: {
        id: "search-1",
        status: "PAUSED",
        alertGeneration: 4,
        matches: []
      },
      schedule: null
    });
  });
});
