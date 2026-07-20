import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  assertAutomationRequest: vi.fn(),
  hasDatabaseConfig: vi.fn(),
  markMatchAlertSent: vi.fn()
}));

vi.mock("@/lib/api/automation-auth", () => ({
  assertAutomationRequest: mocks.assertAutomationRequest
}));

vi.mock("@/lib/automation/db-service", () => ({
  markMatchAlertSent: mocks.markMatchAlertSent
}));

vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("POST /api/automation/alerts/[id]/sent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertAutomationRequest.mockReturnValue(null);
    mocks.hasDatabaseConfig.mockReturnValue(false);
    mocks.markMatchAlertSent.mockResolvedValue({
      id: "match-1",
      availabilityCycle: 2,
      alertStatus: "SENT"
    });
  });

  it("returns 503 before updating alert state when the database is unavailable", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/automation/alerts/match-1/sent", {
        method: "POST"
      }),
      { params: Promise.resolve({ id: "match-1" }) }
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Alert status updates are temporarily unavailable."
    });
    expect(mocks.markMatchAlertSent).not.toHaveBeenCalled();
  });

  it("requires an exact non-negative availability cycle", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    const response = await POST(
      new NextRequest("http://localhost/api/automation/alerts/match-1/sent", {
        method: "POST",
        body: JSON.stringify({ availabilityCycle: -1 })
      }),
      { params: Promise.resolve({ id: "match-1" }) }
    );

    expect(response.status).toBe(400);
    expect(mocks.markMatchAlertSent).not.toHaveBeenCalled();
  });

  it("marks only the requested availability cycle sent", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    const response = await POST(
      new NextRequest("http://localhost/api/automation/alerts/match-1/sent", {
        method: "POST",
        body: JSON.stringify({ availabilityCycle: 2 })
      }),
      { params: Promise.resolve({ id: "match-1" }) }
    );

    expect(response.status).toBe(200);
    expect(mocks.markMatchAlertSent).toHaveBeenCalledWith({
      matchId: "match-1",
      availabilityCycle: 2
    });
    await expect(response.json()).resolves.toEqual({
      match: {
        id: "match-1",
        availabilityCycle: 2,
        alertStatus: "SENT"
      }
    });
  });

  it("rejects a delayed update after the match cycle changes", async () => {
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.markMatchAlertSent.mockResolvedValue(null);
    const response = await POST(
      new NextRequest("http://localhost/api/automation/alerts/match-1/sent", {
        method: "POST",
        body: JSON.stringify({ availabilityCycle: 1 })
      }),
      { params: Promise.resolve({ id: "match-1" }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "The alert is no longer pending for that availability cycle."
    });
  });
});
