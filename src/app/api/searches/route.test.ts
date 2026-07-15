import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  createTeeSearchForUser: vi.fn(),
  getRequiredAppUser: vi.fn(),
  hasClerkConfig: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  listTeeSearchesForUser: vi.fn(),
  queuePendingCourseProfiles: vi.fn(),
  startSearchSchedule: vi.fn()
}));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: mocks.after
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
vi.mock("@/lib/course-profiles/service", () => ({
  queuePendingCourseProfiles: mocks.queuePendingCourseProfiles
}));
vi.mock("@/lib/searches/service", () => ({
  createTeeSearchForUser: mocks.createTeeSearchForUser,
  listTeeSearchesForUser: mocks.listTeeSearchesForUser
}));

describe("POST /api/searches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.after.mockImplementation((callback: () => unknown) => callback());
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to create alerts when account auth is unavailable", async () => {
    mocks.hasClerkConfig.mockReturnValue(false);

    const response = await POST(searchRequest());

    expect(response.status).toBe(503);
    expect(mocks.getRequiredAppUser).not.toHaveBeenCalled();
    expect(mocks.createTeeSearchForUser).not.toHaveBeenCalled();
  });

  it("refuses unsigned alert creation instead of creating a guest owner", async () => {
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockRejectedValue(new Error("Unauthorized"));

    const response = await POST(searchRequest());

    expect(response.status).toBe(401);
    expect(mocks.createTeeSearchForUser).not.toHaveBeenCalled();
  });

  it("owns the alert with the authenticated account and ignores a submitted primary email", async () => {
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockResolvedValue({
      id: "app-user-1",
      email: "owner@example.com"
    });
    mocks.createTeeSearchForUser.mockResolvedValue({
      id: "search-1",
      preferences: [{ courseId: "course-1" }]
    });
    mocks.startSearchSchedule.mockResolvedValue({ id: "schedule-1" });

    const response = await POST(searchRequest("different-person@example.com", "TEST"));

    expect(response.status).toBe(201);
    expect(mocks.createTeeSearchForUser).toHaveBeenCalledWith(
      "app-user-1",
      expect.objectContaining({ alertEmail: "owner@example.com" }),
      "TEST",
      false
    );
    expect(mocks.startSearchSchedule).toHaveBeenCalledWith("search-1");
    expect(mocks.queuePendingCourseProfiles).toHaveBeenCalledWith(["course-1"]);
  });

  it("fails closed to unclassified provenance for an unknown traffic label", async () => {
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockResolvedValue({
      id: "app-user-1",
      email: "owner@example.com"
    });
    mocks.createTeeSearchForUser.mockResolvedValue({ id: "search-1", preferences: [] });
    mocks.startSearchSchedule.mockResolvedValue({ id: "schedule-1" });

    const response = await POST(searchRequest("owner@example.com", "visitor-123"));

    expect(response.status).toBe(201);
    expect(mocks.createTeeSearchForUser).toHaveBeenCalledWith(
      "app-user-1",
      expect.any(Object),
      "UNCLASSIFIED",
      false
    );
  });

  it("allows only synthetic searches to opt into recurring checks", async () => {
    mocks.hasClerkConfig.mockReturnValue(true);
    mocks.getRequiredAppUser.mockResolvedValue({
      id: "app-user-1",
      email: "owner@example.com"
    });
    mocks.createTeeSearchForUser.mockResolvedValue({ id: "search-1", preferences: [] });
    mocks.startSearchSchedule.mockResolvedValue({ id: "schedule-1" });

    await POST(searchRequest("owner@example.com", "TEST", true));
    await POST(searchRequest("owner@example.com", "PUBLIC", true));

    expect(mocks.createTeeSearchForUser).toHaveBeenNthCalledWith(
      1,
      "app-user-1",
      expect.any(Object),
      "TEST",
      true
    );
    expect(mocks.createTeeSearchForUser).toHaveBeenNthCalledWith(
      2,
      "app-user-1",
      expect.any(Object),
      "PUBLIC",
      false
    );
  });
});

function searchRequest(
  alertEmail = "golfer@example.com",
  trafficClass?: string,
  syntheticMultiCycle = false
) {
  return new NextRequest("http://localhost/api/searches", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(trafficClass ? { "x-tee-time-spot-traffic-class": trafficClass } : {}),
      ...(syntheticMultiCycle
        ? { "x-tee-time-spot-synthetic-multi-cycle": "true" }
        : {})
    },
    body: JSON.stringify({
      date: futureDate(),
      startTime: "09:00",
      endTime: "14:00",
      players: 2,
      cadenceMinutes: 5,
      alertEmail,
      courses: [
        {
          googlePlaceId: "place-1",
          name: "Tashua Knolls Golf Course",
          rank: 1,
          latitude: 41.25,
          longitude: -73.2
        }
      ]
    })
  });
}

function futureDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
