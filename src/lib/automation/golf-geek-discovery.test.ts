import { describe, expect, it, vi } from "vitest";
import type { BrowserDiscovery, BrowserDiscoveryEvidence } from "./browser-discovery";
import { enrichGolfGeekDiscovery } from "./golf-geek-discovery";
import { isProviderMetadataReady, resolveProviderCapability } from "./provider-capabilities";

const providerId = "092c858d-68a5-4206-91e0-132f3bd0bb61";
const bookingUrl = "https://booking.gatewaynational.com/";
const profile = { data: {
  id: providerId, name: "Gateway National Golf Links", city: "Madison", state: "IL",
  website: "https://gatewaynational.com", subdomain: bookingUrl,
  bookingAllowedDays: 14
} };
const discovery: BrowserDiscovery = {
  courseId: "saved-course", status: "INSPECTED", detectedPlatform: "UNKNOWN",
  sourceUrl: "https://www.gatewaynational.com/", confidence: 0,
  evidence: { observedUrls: ["https://www.gatewaynational.com/"], learnedFrom: "official-site" }
};
const sourceEvidence: BrowserDiscoveryEvidence = {
  courseId: "saved-course", courseName: "Gateway National Golf Links",
  sourceUrl: discovery.sourceUrl,
  observedUrls: ["https://booking.gatewaynational.com/?utm_source=NavigationButton"],
  linkCandidates: [{ url: bookingUrl, label: "Book a tee time" }]
};

function inputs(profileResponse = profile) {
  const publicFetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === bookingUrl) return new Response(
      '<title>Golf Booking System</title><script src="/static/js/main.b03cc881.chunk.js"></script>',
      { status: 200 }
    );
    if (url === `${bookingUrl}static/js/main.b03cc881.chunk.js`) return new Response(
      `var r="${providerId}",i="https://gatewaynational.com";var api="xq8v7un6ad.execute-api.us-east-1.amazonaws.com";`,
      { status: 200 }
    );
    throw new Error(`Unexpected public source: ${url}`);
  });
  const apiFetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(input.toString()).toBe(
      `https://xq8v7un6ad.execute-api.us-east-1.amazonaws.com/prod/courses/${providerId}`
    );
    return new Response(JSON.stringify(profileResponse), { status: 200 });
  });
  return {
    discovery, sourceEvidence, courseName: "Gateway National Golf Links",
    courseCity: "Madison", courseState: "IL",
    officialWebsite: "https://www.gatewaynational.com/",
    publicFetch: publicFetch as typeof fetch, apiFetch: apiFetch as typeof fetch
  };
}

describe("Golf Geek official-source discovery", () => {
  it("learns reusable metadata only after the signed-out provider profile confirms identity", async () => {
    const result = await enrichGolfGeekDiscovery(inputs());
    expect(result.status).toBe("LEARNED");
    expect(result.bookingUrl).toBe(bookingUrl);
    expect(result.apiMetadata).toMatchObject({
      provider: "GOLF_GEEK", courseId: providerId, bookingWindowDaysAhead: 14
    });
    expect(isProviderMetadataReady("GOLF_GEEK", result.apiMetadata)).toBe(true);
    expect(resolveProviderCapability({
      detectedBookingUrl: result.bookingUrl,
      bookingMetadata: result.apiMetadata
    }).isRunnable).toBe(true);
  });

  it("rejects a course-name mismatch and never treats arbitrary booking hosts as Golf Geek", async () => {
    const mismatch = inputs({ data: { ...profile.data, name: "Another Golf Club" } });
    expect(await enrichGolfGeekDiscovery(mismatch)).toBe(discovery);
    const untrusted = inputs();
    untrusted.sourceEvidence = {
      ...sourceEvidence, observedUrls: ["https://booking.othercourse.com/"], linkCandidates: []
    };
    expect(await enrichGolfGeekDiscovery(untrusted)).toBe(discovery);
    expect(vi.mocked(untrusted.publicFetch)).not.toHaveBeenCalled();
  });
});
