import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, discoveryBrowserFeedback, readDiscoveryControllerCheckpoint } from "../../../scripts/automation/course-discovery-worker.mjs";

describe("durable discovery browser diagnostics", () => {
  it("binds adapter address evidence to trusted demand and discards a model-supplied address when demand has none", () => {
    const proposed = { source: { venueAddress: "Untrusted address", bookingUrl: "https://venue.example/booking" } };
    const job = { request: { target: { courseId: "course" }, identity: { name: "Public course", officialUrl: "https://venue.example/", address: "12 Public Road" }, input: { timeZone: "America/New_York" } } };
    expect(bindDiscoveryRecipeIdentity(proposed, job).source.venueAddress).toBe("12 Public Road");
    const withoutAddress = { ...job, request: { ...job.request, identity: { ...job.request.identity, address: undefined } } };
    expect(bindDiscoveryRecipeIdentity(proposed, withoutAddress).source).not.toHaveProperty("venueAddress");
  });
  it("retains public bootstrap failures across a checkpoint without retaining bodies, query values or page text", () => {
    const feedback = discoveryBrowserFeedback({ url: "https://venue.example/", text: "do not retain this text",
      loading: true, pendingRequestCount: 2, requests: [{ url: "https://api.example/services?site=private-value",
        method: "POST", resourceType: "fetch", blockedReason: "UNSAFE_METHOD", body: { email: "private@example.org" }, headers: { secret: "private-key" } }] }, "open");
    const checkpoint = { controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } };
    expect(readDiscoveryControllerCheckpoint(checkpoint, "https://venue.example/").lastFeedback).toEqual({
      code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "open", loading: true, pendingRequestCount: 2,
        requests: [{ code: "UNSAFE_METHOD", url: "https://api.example/services", method: "POST", resourceType: "fetch" }] } });
    expect(JSON.stringify(feedback)).not.toMatch(/private|retain this|headers|email/);
  });

  it("retains a failed navigation with only the last public path", () => {
    expect(discoveryBrowserFeedback({ url: "https://venue.example/times?date=2026-10-23", requests: [] }, "click",
      { code: "BROWSER_NAVIGATION_FAILED", message: "sensitive details" })).toEqual({ code: "DISCOVERY_BROWSER_INCOMPLETE", details: {
      action: "click", failure: { code: "BROWSER_NAVIGATION_FAILED", url: "https://venue.example/times" }, requests: [] } });
  });

  it("bounds hostile diagnostic collections and discards arbitrary fields", () => {
    const requests = Array.from({ length: 100 }, () => ({ url: "https://venue.example/api", method: "POST", resourceType: "fetch",
      blockedReason: "UNSAFE_METHOD", body: { secret: "must not survive" } }));
    const feedback = discoveryBrowserFeedback({ loading: true, pendingRequestCount: 99_999, requests }, "untrusted-action");
    expect(feedback.details).toMatchObject({ action: "observe", pendingRequestCount: 1024 });
    expect(feedback.details.requests).toHaveLength(8);
    expect(JSON.stringify(feedback)).not.toContain("secret");
  });

  it("does not treat successful completed reads or denied incidental media as failed availability", () => {
    expect(discoveryBrowserFeedback({ loading: false, pendingRequestCount: 0, requests: [
      { url: "https://venue.example/times", method: "GET", resourceType: "fetch", status: 200 },
      { url: "https://venue.example/image", method: "GET", resourceType: "image", blockedReason: "DENIED" },
    ] }, "observe")).toBeUndefined();
  });
});
