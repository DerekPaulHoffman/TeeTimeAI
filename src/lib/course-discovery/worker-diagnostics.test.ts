import { describe, expect, it } from "vitest";
import { bindDiscoveryRecipeIdentity, discoveryBrowserFeedback, noVerifiedRecipeDiagnostic, readDiscoveryControllerCheckpoint } from "../../../scripts/automation/course-discovery-worker.mjs";
import { safeBrowserActionIssues } from "../../../scripts/automation/course-discovery-diagnostics.mjs";

describe("durable discovery browser diagnostics", () => {
  it("retains sanitized adapter identity evidence without interpreting an unverified result as a tool crash or access wall", () => {
    const feedback = discoveryBrowserFeedback({ url: "https://venue.example/times?date=2026-10-23", requests: [] }, "inspect_adapter",
      { code: "ADAPTER_IDENTITY_MISMATCH", message: "secret raw provider response" });
    const diagnostic = noVerifiedRecipeDiagnostic(feedback);
    expect(diagnostic).toEqual({ code: "NO_VERIFIED_RECIPE", reason: "ADAPTER_IDENTITY_MISMATCH", evidence: {
      code: "DISCOVERY_BROWSER_INCOMPLETE", details: { action: "inspect_adapter", failure: {
        code: "ADAPTER_IDENTITY_MISMATCH", url: "https://venue.example/times" }, requests: [] } } });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/",
      observedNavigationUrls: [], lastFailure: feedback } }, "https://venue.example/");
    expect(noVerifiedRecipeDiagnostic(restored.lastFailure)).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|2026|ACCESS_REQUIRED|TOOL_FAILURE/);
    expect(noVerifiedRecipeDiagnostic({ code: "injected", details: { reason: "PRIVATE_VALUE" } }))
      .toEqual({ code: "NO_VERIFIED_RECIPE", reason: "NO_RECIPE_VERIFIED" });
    expect(noVerifiedRecipeDiagnostic(discoveryBrowserFeedback({ loading: true, pendingRequestCount: 1, requests: [] }, "observe")))
      .toEqual({ code: "NO_VERIFIED_RECIPE", reason: "NO_RECIPE_VERIFIED" });
  });
  it("preserves bounded argument schema issues without rejected values or unknown property names", () => {
    const issues = [{ path: ["target"], code: "invalid_type", input: "private-value", message: "private-value" },
      { path: [], code: "unrecognized_keys", keys: ["selector", "private@example.org"] }];
    const sanitized = safeBrowserActionIssues(issues);
    expect(safeBrowserActionIssues(sanitized)).toEqual(sanitized);
    const feedback = discoveryBrowserFeedback(undefined, "click", { code: "BROWSER_ACTION_SCHEMA_INVALID", details: { issues } });
    expect(feedback.details.issues).toEqual([{ path: "target", code: "invalid_type" },
      { path: "", code: "unrecognized_keys", keys: ["selector", "field"] }]);
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example/", observedNavigationUrls: [], lastFeedback: feedback } }, "https://venue.example/");
    expect(restored.lastFeedback).toEqual(feedback);
    expect(JSON.stringify(feedback)).not.toMatch(/private|input|message/);
  });
  it("binds adapter address evidence to trusted demand and discards a model-supplied address when demand has none", () => {
    const proposed = { source: { venueAddress: "Untrusted address", bookingUrl: "https://venue.example/booking" } };
    const job = { request: { target: { courseId: "course" }, identity: { name: "Public course", officialUrl: "https://venue.example/", address: "12 Public Road" }, input: { timeZone: "America/New_York" } } };
    expect(bindDiscoveryRecipeIdentity(proposed, job).source.venueAddress).toBe("12 Public Road");
    const withoutAddress = { ...job, request: { ...job.request, identity: { ...job.request.identity, address: undefined } } };
    expect(bindDiscoveryRecipeIdentity(proposed, withoutAddress).source).not.toHaveProperty("venueAddress");
  });
  it("copies an alternate-address proof only from the current exact controller observation", () => {
    const job = { id: "job-1", request: { target: { courseId: "course" }, identity: { name: "Public course", officialUrl: "https://venue.example/" }, input: { timeZone: "UTC" } } };
    const proposed = { source: { bookingUrl: "https://public.book.teeitup.com/" },
      adapter: { family: "TEEITUP", alias: "public", facilityIds: [7], officialIdentityProof: { forged: true } } };
    const observed = { jobId: job.id, officialUrl: job.request.identity.officialUrl, bookingUrl: proposed.source.bookingUrl,
      adapter: { family: "TEEITUP", alias: "public", facilityIds: [7], officialIdentityProof: { source: "https://venue.example/", digest: "trusted" } } };
    expect(bindDiscoveryRecipeIdentity(proposed, job).adapter).not.toHaveProperty("officialIdentityProof");
    expect(bindDiscoveryRecipeIdentity(proposed, job, observed).adapter.officialIdentityProof).toEqual(observed.adapter.officialIdentityProof);
    for (const mismatch of [
      { ...observed, jobId: "another-job" },
      { ...observed, officialUrl: "https://other.example/" },
      { ...observed, bookingUrl: "https://other.book.teeitup.com/" },
      { ...observed, adapter: { ...observed.adapter, alias: "other" } },
      { ...observed, adapter: { ...observed.adapter, facilityIds: [8] } },
      { ...observed, adapter: { ...observed.adapter, officialIdentityProof: "malformed" } },
    ]) expect(bindDiscoveryRecipeIdentity(proposed, job, mismatch).adapter).not.toHaveProperty("officialIdentityProof");
    expect(proposed.adapter.officialIdentityProof).toEqual({ forged: true });
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
