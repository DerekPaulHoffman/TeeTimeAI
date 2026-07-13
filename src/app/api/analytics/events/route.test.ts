import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  createWebsiteEvent: vi.fn(),
  hasDatabaseConfig: vi.fn()
}));

vi.mock("@/lib/engagement/engagement", () => ({
  createWebsiteEvent: mocks.createWebsiteEvent
}));
vi.mock("@/lib/env", () => ({
  hasDatabaseConfig: mocks.hasDatabaseConfig
}));

describe("POST /api/analytics/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasDatabaseConfig.mockReturnValue(true);
    mocks.createWebsiteEvent.mockResolvedValue({ id: "event-1" });
  });

  it("derives the stored page from a same-origin referrer", async () => {
    const response = await POST(
      eventRequest("http://localhost/search?email=golfer@example.com#courses")
    );

    expect(response.status).toBe(201);
    expect(mocks.createWebsiteEvent).toHaveBeenCalledWith({
      name: "page_viewed",
      page: "/search",
      trafficClass: "PUBLIC"
    });
  });

  it("does not trust a submitted page when the referrer is cross-origin", async () => {
    await POST(eventRequest("https://example.com/search?token=private"));

    expect(mocks.createWebsiteEvent).toHaveBeenCalledWith({
      name: "page_viewed",
      page: undefined,
      trafficClass: "PUBLIC"
    });
  });
});

function eventRequest(referer: string) {
  return new NextRequest("http://localhost/api/analytics/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      referer
    },
    body: JSON.stringify({
      name: "page_viewed",
      page: "/submitted?email=golfer@example.com",
      trafficClass: "PUBLIC"
    })
  });
}
