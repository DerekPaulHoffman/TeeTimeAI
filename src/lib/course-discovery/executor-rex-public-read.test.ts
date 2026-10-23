// @vitest-environment node
// Local Chrome + synthetic native continuation; not a provider/wire proof.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://public-rental.reservewithrex.com";
const input = { date: "2026-10-23", timeZone: "America/Los_Angeles", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const publicBody = { venueId: "11111111-2222-3333-4444-555555555555", packageId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  date: input.date, guests: 2, duration: 2, lanes: 1, resourceIds: [], guestsWithAgeGroups: [] };
const secret = "fixture-credential-MUST-NOT-LEAK";
type Mode = "valid" | "real bearer" | "cookie" | "anonymous cookie" | "anonymous token" | "unsafe body" | "unscoped route" | "wrong frame";
function recipe(mode: Mode) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "rex-fixture", offeringId: "public-rental", kind: "SIMULATOR" },
    source: { officialUrl: origin + "/", bookingUrl: origin + "/package", venueName: "Public Golf Rentals", providerFamily: "REX", timeZone: input.timeZone },
    pageUrl: origin + (mode === "wrong frame" ? "/public" : "/package"), steps: [],
    permittedRoutes: [{ origin, path: "/package", methods: ["GET"], queryKeys: [] },
      { origin, path: "/public", methods: ["GET"], queryKeys: [] },
      { origin, path: "/api/venue/get-venue-with-package", methods: mode === "unscoped route" ? ["GET"] : ["POST"], queryKeys: [] }],
    availabilityResponse: { url: origin + "/api/venue/get-venue-with-package", method: "POST",
      date: { source: "JSON_BODY", path: "date" }, success: { path: "ok", equals: true } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, complete: { availabilityResponse: true },
      durationMinutes: { selector: "#duration" }, empty: { selector: "#empty" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { selector: ".end" },
      scope: { selector: ".resource", label: { selector: "h2" }, expectedLabel: "Golf Simulator" } },
  });
}
describe.runIf(existsSync(chrome))("REX fixed replay native policy boundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["valid", "real bearer", "cookie", "anonymous cookie", "anonymous token", "unsafe body", "unscoped route", "wrong frame"])
  ("requires both provider and recipe authority: %s", async mode => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: string | null }> = [];
    let pending = 0;
    const anonymous = mode === "anonymous cookie" || mode === "anonymous token";
    const headers = { "content-type": "application/json", ...(!anonymous ? { authorization: mode === "real bearer" ? `bearer ${secret}` : "bearer null" } : {}),
      ...(mode === "anonymous token" ? { "x-auth-token": secret } : {}) };
    const body = { ...publicBody, ...(mode === "unsafe body" ? { selectedPackageSlot: "10:00" } : {}) };
    const html = `<html><body><h1 id='venue'>Public Golf Rentals</h1><p id='date'>2026-10-23</p><p id='duration'>60</p>
      <section class='resource'><h2>Golf Simulator</h2>${mode === "valid"
        ? "<div class='slot'><span class='start'>11:00</span><span class='end'>12:00</span></div>"
        : "<p id='empty'>No available times</p>"}</section><script>
      ${mode === "cookie" || mode === "anonymous cookie" ? `document.cookie='account=${secret}; Secure; SameSite=Lax';` : ""}
      fetch('/api/venue/get-venue-with-package',{method:'POST',headers:${JSON.stringify(headers)},body:JSON.stringify(${JSON.stringify(body)})}).catch(()=>{});
      </script></body></html>`;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9",
      close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {},
      stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined, get pendingReads() { return pending; },
      releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), actualHeaders = await raw.allHeaders();
          const wrapped: nativeRouting.NativeReadRoute = { request: () => ({ url: () => raw.url(), method: () => raw.method(),
            headers: () => ({ ...actualHeaders }), postData: () => raw.postData(), resourceType: () => raw.resourceType(),
            isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(), redirectedFrom: () => null,
            response: () => raw.response() }), continue: options => route.continue(options), abort: code => route.abort(code),
          fulfill: options => route.fulfill(options) };
          await handler(wrapped);
        } finally { pending--; }
      },
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !["/package", "/public", "/api/venue/get-venue-with-package"].includes(url.pathname))
        throw new Error("UNEXPECTED_FIXTURE_DISPATCH");
      if (request.method() === "POST") posts.push({ url: request.url(), headers: request.headers(), body: request.postData() });
      const data = Buffer.from(request.method() === "GET" ? html : '{"ok":true}');
      const responseHeaders = { "content-type": request.method() === "GET" ? "text/html" : "application/json" };
      await route.fulfill({ status: 200, headers: responseHeaders, body: data });
      return { url: request.url(), status: 200, headers: responseHeaders, body: data };
    });
    const fetcher = vi.fn(async () => { throw new Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
    const result = await executeAccessRecipe(recipe(mode), input, { now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: fetcher,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
    if (mode === "valid") {
      expect(posts).toHaveLength(1); expect(posts[0].headers.authorization).toBe("bearer null"); expect(JSON.parse(posts[0].body!)).toEqual(publicBody);
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].availableSpots).toBe(1);
    } else { expect(posts).toEqual([]); expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] }); }
    expect(JSON.stringify(result)).not.toContain(secret); expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0);
  }, 20_000);
});
