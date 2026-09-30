import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a course-local tomorrow edit to the owned service after UTC midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T03:16:30.000Z"));
    mocks.updateTeeSearchForUser.mockResolvedValue({ id: "search-1", status: "ACTIVE" });
    const input = { date: "2026-09-30", startTime: "10:00", endTime: "14:00", players: 2 };

    const response = await PATCH(
      new NextRequest("http://localhost/api/searches/search-1", {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      }),
      { params: Promise.resolve({ id: "search-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.updateTeeSearchForUser).toHaveBeenCalledWith("user-1", "search-1", expect.objectContaining(input));
    expect(mocks.startSearchSchedule).toHaveBeenCalledWith("search-1");
  });

  it("returns a canonical course-local date rejection as a 400 without changing the schedule", async () => {
    mocks.updateTeeSearchForUser.mockRejectedValue(new Error("Search date must be in the future for every selected course"));

    const response = await PATCH(
      new NextRequest("http://localhost/api/searches/search-1", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-09-30", startTime: "10:00", endTime: "14:00", players: 2 }),
      }),
      { params: Promise.resolve({ id: "search-1" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Search date must be in the future for every selected course" });
    expect(mocks.startSearchSchedule).not.toHaveBeenCalled();
    expect(mocks.stopSearchSchedule).not.toHaveBeenCalled();
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
