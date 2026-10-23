// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createPassfactoryPublicReadPolicy, isIncidentalBrowserRequest, isNonEvidenceBrowserResource } from "./passfactory-public-read-policy";

describe("observed PassFactory public widget reads", () => {
  const headers = new Headers({ origin: "https://passfactory.com", "content-type": "application/json" });
  const resource = { facility_code: "Public123", start_date: "2026-10-01", end_date: "2026-10-31", type: 2 };
  const ready = () => { const policy = createPassfactoryPublicReadPolicy(); policy.observeWidgetUrl("https://passfactory.com/ftbb/Public123/?sc=Hall456"); return policy; };
  const allows = (path: string, body: unknown, policy = ready(), h = headers) => policy.allows(new URL(`https://api.passfactory.io/api/v1/${path}`), h, JSON.stringify(body));

  it("admits only the exact display contracts for a previously observed widget", () => {
    expect(allows("availability-widget/get-business-info", { facility_code: "Public123" })).toBe(true);
    expect(allows("availability-widget/get-business-info", { hall_code: "Hall456" })).toBe(true);
    expect(allows("availability/get-month-tickets", resource)).toBe(true);
    expect(allows("availability-widget/facility-widget", resource)).toBe(true);
    const range = { start_date: resource.start_date, end_date: resource.end_date, type: resource.type };
    expect(allows("availability-widget/hall-widget", { ...range, hall_code: "Hall456" })).toBe(true);
    expect(allows("availability-widget/facility-widget", resource, createPassfactoryPublicReadPolicy())).toBe(false);
  });

  it("rejects foreign venues, origins, endpoint variants and extra fields", () => {
    expect(allows("availability-widget/facility-widget", { ...resource, facility_code: "Other" })).toBe(false);
    expect(allows("availability-widget/facility-widget", resource, ready(), new Headers({ origin: "https://evil.test", "content-type": "application/json" }))).toBe(false);
    for (const path of ["auth/login", "booking/create", "payment/checkout", "availability-widget/my-assigned", "availability-widget/facility-widget?extra=true"])
      expect(allows(path, resource)).toBe(false);
    for (const key of ["token", "email", "customer_id", "reservation", "action", "hall_code", "query"])
      expect(allows("availability-widget/facility-widget", { ...resource, [key]: "injected" })).toBe(false);
    expect(allows("availability-widget/get-business-info", resource)).toBe(false);
    expect(allows("availability-widget/hall-widget", resource)).toBe(false);
  });

  it("bounds dates, types, payload format, URL identity and duplicate keys", () => {
    for (const patch of [{ type: 1 }, { type: "2" }, { start_date: "2026-02-30" }, { end_date: "2026-01-01" }, { end_date: "2027-01-01" }])
      expect(allows("availability/get-month-tickets", { ...resource, ...patch })).toBe(false);
    const policy = ready(), url = new URL("https://api.passfactory.io/api/v1/availability-widget/get-business-info");
    expect(policy.allows(url, headers, '{"facility_code":"Other","facility_code":"Public123"}')).toBe(false);
    expect(policy.allows(url, headers, '["Public123"]')).toBe(false);
    expect(policy.allows(new URL(url.href.replace("api.passfactory.io", "api.passfactory.io.evil.test")), headers, '{"facility_code":"Public123"}')).toBe(false);
    expect(policy.allows(url, new Headers({ origin: "https://passfactory.com", "content-type": "text/plain" }), '{"facility_code":"Public123"}')).toBe(false);
    expect(policy.allows(url, new Headers({ origin: "https://passfactory.com", "content-type": "application/json", authorization: "Bearer private" }), '{"facility_code":"Public123"}')).toBe(false);
    const untrusted = createPassfactoryPublicReadPolicy(); untrusted.observeWidgetUrl("https://passfactory.com.evil.test/ftbb/Public123/?sc=Hall456");
    expect(allows("availability-widget/get-business-info", { facility_code: "Public123" }, untrusted)).toBe(false);
  });
});

it("exempts only exact incidental telemetry destinations from completeness", () => {
  expect(isIncidentalBrowserRequest("https://r.stripe.com/b")).toBe(true);
  expect(isIncidentalBrowserRequest("https://analytics.google.com/g/collect?v=2")).toBe(true);
  expect(isIncidentalBrowserRequest("https://www.google-analytics.com/analytics.js")).toBe(true);
  expect(isIncidentalBrowserRequest("https://www.google-analytics.com/j/collect?v=1")).toBe(true);
  expect(isIncidentalBrowserRequest("https://www.google-analytics.com.evil.test/analytics.js")).toBe(false);
  expect(isIncidentalBrowserRequest("https://passfactory.com/favicon/favicon-96x96.png")).toBe(true);
  expect(isIncidentalBrowserRequest("https://example.org/favicon.ico")).toBe(true);
  expect(isIncidentalBrowserRequest("https://example.org/apple-touch-icon-precomposed.png")).toBe(true);
  expect(isIncidentalBrowserRequest("https://example.org/api/availability.png")).toBe(false);
  expect(isIncidentalBrowserRequest("https://connect.facebook.net/en_US/fbevents.js")).toBe(true);
  expect(isIncidentalBrowserRequest("https://js-na2.hs-scripts.com/242014557.js")).toBe(true);
  expect(isIncidentalBrowserRequest("https://js-na2.hs-scripts.com/availability.js")).toBe(false);
  expect(isIncidentalBrowserRequest("https://maps.googleapis.com/maps/api/js?key=public-key")).toBe(true);
  expect(isIncidentalBrowserRequest("https://maps.googleapis.com/$rpc/google.internal.maps.mapsjs.v1.MapsJsInternalService/GetViewportInfo")).toBe(true);
  expect(isIncidentalBrowserRequest("https://forms-na2.hscollectedforms.net/collected-forms/v1/config/json?portalId=123")).toBe(true);
  expect(isIncidentalBrowserRequest("https://track-na2.hubspot.com/__ptc.gif?utk=tracking")).toBe(true);
  expect(isIncidentalBrowserRequest("https://www.googletagmanager.com/gtag/js?id=G-PUBLIC")).toBe(true);
  expect(isIncidentalBrowserRequest("https://www.googletagmanager.com/gtm.js?id=GTM-PUBLIC")).toBe(true);
  expect(isIncidentalBrowserRequest("https://js.stripe.com/dahlia/stripe.js")).toBe(true);
  expect(isIncidentalBrowserRequest("https://js.stripe.com/terminal/v1")).toBe(true);
  expect(isIncidentalBrowserRequest("https://js.stripe.com.evil.test/dahlia/stripe.js")).toBe(false);
  expect(isIncidentalBrowserRequest("https://api.stripe.com/v1/payment_intents")).toBe(false);
  for (const url of ["https://www.googletagmanager.com/gtag/availability", "https://www.googletagmanager.com.evil.test/gtag/js", "http://www.googletagmanager.com/gtag/js", "https://u:p@www.googletagmanager.com/gtag/js"])
    expect(isIncidentalBrowserRequest(url)).toBe(false);
  for (const url of ["https://api.passfactory.io/api/v1/availability-widget/hall-widget", "https://api.stripe.com/v1/payment_intents", "https://r.stripe.com/checkout", "https://r.stripe.com.evil.test/b", "https://other.test/g/collect"])
    expect(isIncidentalBrowserRequest(url)).toBe(false);
  for (const url of ["https://forms-na2.hscollectedforms.net/collected-forms/submit", "https://forms-na2.hscollectedforms.net.evil.test/collected-forms/v1/config/json", "http://forms-na2.hscollectedforms.net/collected-forms/v1/config/json", "https://track-na2.hubspot.com/submit", "https://track-na2.hubspot.com.evil.test/__ptc.gif"])
    expect(isIncidentalBrowserRequest(url)).toBe(false);
});

it("aborts decorative preloads reported as other without hiding application reads", () => {
  expect(isNonEvidenceBrowserResource("https://example.org/uploads/photo.png", "other")).toBe(true);
  expect(isNonEvidenceBrowserResource("https://example.org/static/type.woff2", "other")).toBe(true);
  expect(isNonEvidenceBrowserResource("https://example.org/api/availability", "fetch")).toBe(false);
  expect(isNonEvidenceBrowserResource("https://example.org/api/availability.json", "other")).toBe(false);
  expect(isNonEvidenceBrowserResource("https://example.org/static/app.js", "script")).toBe(false);
  expect(isNonEvidenceBrowserResource("https://example.org/api/times.png", "fetch")).toBe(false);
});

it("quietly denies only the exact optional Google sign-in script without an account or availability grant", () => {
  const client = "https://accounts.google.com/gsi/client";
  expect(isNonEvidenceBrowserResource(client, "script")).toBe(true);
  expect(isIncidentalBrowserRequest(client)).toBe(false);
  for (const type of ["document", "xhr", "fetch", "other", "stylesheet"])
    expect(isNonEvidenceBrowserResource(client, type)).toBe(false);
  for (const url of ["https://accounts.google.com/gsi/client?mode=signin", "https://accounts.google.com/gsi/client#signin",
    "https://accounts.google.com/gsi/other", "https://accounts.google.com/gsi/client/", "https://accounts.google.com/gsi/%63lient",
    "https://accounts.google.com/login", "https://accounts.google.com/", "https://accounts.google.com.evil.test/gsi/client",
    "https://other.example/gsi/client", "http://accounts.google.com/gsi/client", "https://u:p@accounts.google.com/gsi/client",
    "https://accounts.google.com:444/gsi/client"])
    expect(isNonEvidenceBrowserResource(url, "script")).toBe(false);
});

it("quietly denies only the exact Datacap card-tokenization script without a payment or availability grant", () => {
  const client = "https://token.dcap.com/v1/client";
  expect(isNonEvidenceBrowserResource(client, "script")).toBe(true);
  expect(isIncidentalBrowserRequest(client)).toBe(false);
  for (const type of ["document", "xhr", "fetch", "other", "stylesheet"])
    expect(isNonEvidenceBrowserResource(client, type)).toBe(false);
  for (const url of [client + "?mode=payment", client + "#payment", client + "/", "https://token.dcap.com/v1/%63lient",
    "https://token.dcap.com/v1/token", "https://token.dcap.com/v1/charge", "https://token.dcap.com/checkout", "https://token.dcap.com/",
    "https://token.dcap.com.evil.test/v1/client", "https://other.example/v1/client", "http://token.dcap.com/v1/client",
    "https://u:p@token.dcap.com/v1/client", "https://token.dcap.com:444/v1/client"])
    expect(isNonEvidenceBrowserResource(url, "script")).toBe(false);
});

it("quietly denies observed analytics without hiding availability or an access wall", () => {
  for (const url of [
    "https://e.clarity.ms/collect", "https://q.clarity.ms/collect",
    "https://o17585.ingest.us.sentry.io/api/6350689/envelope/?sentry_key=public",
    "https://example.org/cdn-cgi/zaraz/s.js?z=opaque",
  ]) {
    expect(isIncidentalBrowserRequest(url)).toBe(true);
    expect(isNonEvidenceBrowserResource(url, "script")).toBe(true);
  }
  // This exact injected detector is aborted, never executed or treated as
  // proof of access. Visible challenge pages still use the access-wall guard.
  expect(isNonEvidenceBrowserResource("https://example.org/cdn-cgi/challenge-platform/scripts/jsd/main.js", "script")).toBe(true);
  for (const url of [
    "https://e.clarity.ms/availability", "https://e.clarity.ms.evil.test/collect",
    "https://o17585.ingest.us.sentry.io/api/6350689/availability/",
    "https://o17585.ingest.us.sentry.io.evil.test/api/6350689/envelope/",
    "https://example.org/cdn-cgi/zaraz/availability", "http://example.org/cdn-cgi/zaraz/s.js",
    "https://user:password@example.org/cdn-cgi/zaraz/s.js",
    "https://example.org:444/cdn-cgi/zaraz/s.js",
  ]) expect(isIncidentalBrowserRequest(url)).toBe(false);
  for (const [url, kind] of [
    ["https://example.org/cdn-cgi/challenge-platform/scripts/jsd/main.js", "fetch"],
    ["https://example.org/cdn-cgi/challenge-platform/scripts/jsd/main.js", "document"],
    ["https://example.org/cdn-cgi/challenge-platform/scripts/jsd/api.js", "script"],
    ["http://example.org/cdn-cgi/challenge-platform/scripts/jsd/main.js", "script"],
    ["https://example.org/api/availability", "fetch"],
  ]) expect(isNonEvidenceBrowserResource(url, kind)).toBe(false);
});
