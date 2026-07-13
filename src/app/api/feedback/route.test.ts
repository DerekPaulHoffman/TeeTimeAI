import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  hasDatabaseConfig: vi.fn(),
  submitWebsiteFeedback: vi.fn()
}));

vi.mock("@/lib/engagement/engagement", () => ({
  submitWebsiteFeedback: mocks.submitWebsiteFeedback
}));
vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("POST /api/feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.submitWebsiteFeedback.mockResolvedValue({ id: "feedback-1" });
  });

  it("replaces the submitted URL with a same-origin referrer pathname", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          referer: "http://localhost/alerts/stop?token=signed-secret"
        },
        body: JSON.stringify({
          sentiment: "like",
          page: "/submitted?email=golfer@example.com",
          trafficClass: "TEST"
        })
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.submitWebsiteFeedback).toHaveBeenCalledWith({
      sentiment: "like",
      page: "/alerts/stop",
      trafficClass: "TEST"
    });
  });
});
