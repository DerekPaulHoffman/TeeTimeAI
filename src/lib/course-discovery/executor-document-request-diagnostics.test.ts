// @vitest-environment node
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium, type Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, recipeExecutionDiagnostic, type AccessExecutorDependencies } from "./executor";
import { accessExecutionDiagnosticSchema, parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const official = "https://example.org/official", booking = "https://example.org/booking";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
  target: { kind: "OUTDOOR", courseId: "synthetic-course" },
  source: { officialUrl: official, bookingUrl: booking, venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: official, permittedRoutes: [{ origin: "https://example.org", path: "/official", methods: ["GET"] },
    { origin: "https://example.org", path: "/booking", methods: ["GET"] },
    { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] },
    { origin: "https://late.example.org", path: "/data", methods: ["GET"] },
    { origin: "https://current.example.org", path: "/data", methods: ["GET"] }],
  steps: [{ action: "waitFor", selector: "#booking" }, { action: "followLink", selector: "#booking", text: "View tee times" },
    { action: "waitFor", selector: "#missing-calendar" }],
  availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#ready" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".players" } },
});
const html = (body: string) => new Response(`<!doctype html><html><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });

/** Real isolated Chrome, but every wire response and lease is in-memory. Only
 * fixture Locator waits are shortened; no provider or native-controller claim. */
function fixture(fetch: typeof globalThis.fetch, onClose = () => {}) {
  let page: Page;
  const deps: AccessExecutorDependencies = { fetch, now: () => new Date("2026-10-20T12:00:00Z"),
    requestLease: async (_host, work) => ({ acquired: true, value: await work() }), launchBrowser: async () => {
      const browser = await chromium.launch({ executablePath: chrome, headless: true }), newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, "newContext").mockImplementation(async options => {
        const context = await newContext(options), newPage = context.newPage.bind(context), close = context.close.bind(context);
        vi.spyOn(context, "newPage").mockImplementation(async () => {
          page = await newPage(); const setTimeout = page.setDefaultTimeout.bind(page);
          vi.spyOn(page, "setDefaultTimeout").mockImplementation(value => setTimeout(Math.min(value, 500)));
          return page;
        });
        vi.spyOn(context, "close").mockImplementation(async (...args) => { onClose(); await close(...args); });
        return context;
      });
      return browser;
    } };
  return { deps, page: () => page };
}

describe("bounded current-document request diagnostic schema", () => {
  it("accepts exact bounded counts or an honest overflow sentinel and rejects unknown state", () => {
    for (const count of [0, 1024, "OVER_LIMIT"])
      expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", requestState: { pendingReads: count, currentDocumentPendingHandlers: count } }).success).toBe(true);
    for (const count of [-1, 1025, 0.5, "private", null])
      expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", requestState: { pendingReads: count, currentDocumentPendingHandlers: 0 } }).success).toBe(false);
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", requestState: { pendingReads: 0, currentDocumentPendingHandlers: 0, body: "private" } }).success).toBe(false);
  });
});

describe("opaque unavailable asset URL diagnostic fingerprints", () => {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const url = "https://PRIVATE.internal/account/%2Fopaque-Path?token=private-query#private-fragment";
  const requestUrlFingerprint = { originSha256: hash("https://private.internal"), pathnameSha256: hash("/account/%2Fopaque-Path") };
  it.each(["script", "stylesheet"])("hashes only the parsed origin and exact pathname for a denied GET %s", resourceType => {
    const diagnostic = recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url, method: "GET", resourceType });
    expect(diagnostic).toEqual({ code: "UNSCOPED_REQUEST", method: "GET", resourceType, requestUrlFingerprint });
    expect(recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url: url.replace("private-query", "different-query").replace("private-fragment", "different-fragment"), method: "GET", resourceType })).toEqual(diagnostic);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|account|opaque|token|query|fragment|%2F/);
    expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", earlierRequestFailure: diagnostic }).success).toBe(true);
  });
  it.each([
    { method: "HEAD" }, { method: "POST" }, { method: "OPTIONS" }, { resourceType: "document" }, { resourceType: "xhr" },
    { resourceType: "fetch" }, { resourceType: "image" }, { resourceType: "other" },
    { url: url.replace("https:", "http:") }, { url: url.replace("PRIVATE.internal", "u:p@PRIVATE.internal") },
    { url: url.replace("PRIVATE.internal", "PRIVATE.internal:444") }, { url: "invalid" }, { url: url + "x".repeat(2048) },
    { url: "https://example.org/public.js" },
  ])("omits fingerprints outside the exact bounded missing-URL asset context (%j)", change => {
    expect(recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url, method: "GET", resourceType: "script", ...change })).not.toHaveProperty("requestUrlFingerprint");
  });
  it.each([
    { method: "HEAD" }, { method: "POST" }, { resourceType: "fetch" }, { url: "https://example.org/public.js" },
    { requestUrlFingerprint: { ...requestUrlFingerprint, rawPath: "private" } },
    { requestUrlFingerprint: { ...requestUrlFingerprint, pathnameSha256: "A".repeat(64) } },
    { requestUrlFingerprint: { originSha256: "a".repeat(64) } },
    { requestUrlFingerprint: Object.create(requestUrlFingerprint) },
  ])("rejects malformed or ineligible primary and one-level fingerprints (%j)", change => {
    const diagnostic = { code: "UNSCOPED_REQUEST", method: "GET", resourceType: "script", requestUrlFingerprint, ...change };
    expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", earlierRequestFailure: diagnostic }).success).toBe(false);
  });
});

describe.runIf(existsSync(chrome))("request failures belong to their captured main document", () => {
  it.each([true, false])("does not promote an official dependency failure into the booking document (%s)", async bookingFails => {
    const fetch = vi.fn(async url => String(url) === official
      ? html(`<a id="booking" href="${booking}">View tee times</a><script src="https://unscoped.example.org/official.js"></script>`)
      : html(`<h1>Booking page</h1>${bookingFails ? '<script src="https://unscoped.example.org/booking.js"></script>' : ""}`)) as typeof globalThis.fetch;
    const { deps } = fixture(fetch), result = await executeAccessRecipe(recipe(), input, deps);
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: { reason: "STEP_TIMEOUT", diagnostic: { code: "STEP_TIMEOUT", stepIndex: 2,
      requestState: { pendingReads: 0, currentDocumentPendingHandlers: 0 } } } });
    expect(result.evidence.diagnostic?.earlierRequestFailure).toEqual(bookingFails
      ? { code: "UNSCOPED_REQUEST", url: "https://unscoped.example.org/booking.js", method: "GET", resourceType: "script" } : undefined);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("unscoped"))).toBe(true);
  }, 15_000);

  it("keeps an earlier document's global blocked outcome even when the booking document has a valid read", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw Error("fixture");
    selected.steps.pop();
    const fetch = vi.fn(async url => String(url) === official
      ? html(`<a id="booking" href="${booking}">View tee times</a><script src="https://unscoped.example.org/official.js"></script>`)
      : String(url).includes("/availability?") ? new Response('{"ok":true}', { headers: { "content-type": "application/json" } })
        : html('<h1>Example Golf</h1><p id="date">2026-10-23</p><p id="ready">Ready</p><div class="slot"><span class="time">09:00</span><span class="players">4</span></div><script>fetch("/availability?date=2026-10-23")</script>')) as typeof globalThis.fetch;
    const { deps } = fixture(fetch), result = await executeAccessRecipe(selected, input, deps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: {
      diagnostic: { code: "UNSCOPED_REQUEST", url: "https://unscoped.example.org/official.js" } } });
    expect(result.evidence.diagnostic?.earlierRequestFailure).toBeUndefined();
  }, 15_000);

  it.each([true, false])("keeps late and still-pending old-document work separate from the current handler count (%s)", async oldFailsBeforeTerminal => {
    let rejectOld: (error: Error) => void = () => {}, releaseCurrent: (value: Response) => void = () => {};
    const old = new Promise<Response>((_resolve, reject) => { rejectOld = reject; });
    const current = new Promise<Response>(resolve => { releaseCurrent = resolve; });
    const fetch = vi.fn(async url => {
      if (String(url) === official) return html(`<a id="booking" hidden href="${booking}">View tee times</a><script>fetch('https://late.example.org/data').catch(()=>{})</script>`);
      if (String(url) === "https://late.example.org/data") {
        await control.page().locator("#booking").evaluate(node => { (node as HTMLElement).hidden = false; });
        return old;
      }
      if (String(url) === booking) {
        // The new document handler has already captured its own generation.
        if (oldFailsBeforeTerminal) rejectOld(new Error("LATE_OLD_READ_FAILED"));
        return html("<h1>Booking</h1><script>fetch('https://current.example.org/data').catch(()=>{})</script>");
      }
      return current;
    }) as typeof globalThis.fetch;
    const control: ReturnType<typeof fixture> = fixture(fetch, () => { rejectOld(new Error("LATE_OLD_READ_FAILED")); releaseCurrent(new Response("ready")); });
    try {
      const result = await executeAccessRecipe(recipe(), input, control.deps);
      expect(result).toMatchObject({ status: "FAILED", complete: false, evidence: { reason: "STEP_TIMEOUT", diagnostic: { code: "STEP_TIMEOUT", stepIndex: 2,
        requestState: { pendingReads: oldFailsBeforeTerminal ? 1 : 2, currentDocumentPendingHandlers: 1 } } } });
      expect(result.evidence.diagnostic?.earlierRequestFailure).toBeUndefined();
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([official, booking, "https://late.example.org/data", "https://current.example.org/data"]));
    } finally { releaseCurrent(new Response("ready")); }
  }, 15_000);
});
