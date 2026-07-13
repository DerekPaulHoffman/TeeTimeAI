import { afterEach, describe, expect, it } from "vitest";

import { WEBSITE_TRAFFIC_CLASS_STORAGE_KEY } from "@/lib/engagement/traffic-class";

import { sanitizeObservabilityEvent, SiteObservability } from "./site-observability";

describe("site observability privacy", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it("does not request Vercel-only scripts in non-Vercel local builds", () => {
    expect(SiteObservability({ enabled: false })).toBeNull();
  });

  it("keeps public same-origin paths while removing query strings and fragments", () => {
    const origin = window.location.origin;

    expect(
      sanitizeObservabilityEvent({
        type: "pageview",
        url: `${origin}/search?email=golfer@example.com#results`
      })
    ).toEqual({
      type: "pageview",
      url: `${origin}/search`
    });
  });

  it("rejects synthetic and cross-origin telemetry", () => {
    window.sessionStorage.setItem(WEBSITE_TRAFFIC_CLASS_STORAGE_KEY, "AUTOMATION");
    expect(
      sanitizeObservabilityEvent({ type: "pageview", url: `${window.location.origin}/search` })
    ).toBeNull();

    window.sessionStorage.clear();
    expect(
      sanitizeObservabilityEvent({ type: "pageview", url: "https://example.com/search" })
    ).toBeNull();
  });
});
