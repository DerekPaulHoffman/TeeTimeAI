import { afterEach, describe, expect, it, vi } from "vitest";

import { trackWebsiteEvent } from "./client";

describe("trackWebsiteEvent", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "webdriver");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to keepalive fetch when sendBeacon declines the payload", async () => {
    const sendBeacon = vi.fn().mockReturnValue(false);
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      value: sendBeacon
    });
    Object.defineProperty(navigator, "webdriver", {
      configurable: true,
      value: false
    });
    window.history.replaceState({}, "", "/search?email=golfer@example.com#results");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    trackWebsiteEvent({ name: "page_viewed" });
    await Promise.resolve();

    expect(sendBeacon).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/analytics/events",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        body: JSON.stringify({
          name: "page_viewed",
          page: "/search",
          trafficClass: "PUBLIC"
        })
      })
    );
  });
});
