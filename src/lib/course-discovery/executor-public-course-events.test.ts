// @vitest-environment node
// Synthetic caller-policy fixture in local Chrome. Explicit proof spies and an
// injected OPTIONS test composition, not native branding or provider access.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://app.membersports.com", pageUrl = origin + "/tee-times/123/456/0";
const event = "https://api.membersports.com/api/v1/Events/eventsByDateForCourses/golfClubId/123/searchDate/2026-10-23?golfCourseIds=456";
const inventory = origin + "/public-inventory?date=2026-10-23", key = "synthetic-public-literal";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
type Mode = "inventory" | "events only" | "missing event route";
function recipe(mode: Mode) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "public-event-fixture", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: pageUrl, venueName: "Public Event Course", providerFamily: "FIXTURE", timeZone: input.timeZone },
    pageUrl, steps: [], permittedRoutes: [
      { origin, path: "/tee-times/123/456/0", methods: ["GET"], queryKeys: [] },
      { origin, path: "/public-inventory", methods: ["GET"], queryKeys: ["date"] },
      ...(mode === "missing event route" ? [] : [{ origin: "https://api.membersports.com",
        path: "/api/v1/Events/eventsByDateForCourses/golfClubId/123/searchDate/*", methods: ["GET"], queryKeys: ["golfCourseIds"] }]),
    ],
    availabilityResponse: { url: origin + "/public-inventory?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, players: { selector: "#players" }, complete: { availabilityResponse: true } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
  });
}

describe.runIf(existsSync(chrome))("public course events native caller boundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["inventory", "events only", "missing event route"])("keeps ancillary event reads separate from inventory proof: %s", async mode => {
    let pending = 0, optionsSent = 0, eventSent = 0, inventorySent = 0;
    const proof = Object.freeze({}) as NonNullable<Awaited<ReturnType<typeof nativeRouting.authorizePublicClientReadHeaders>>>;
    vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request => request.url() === event ? proof : null);
    vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(value => value === proof);
    vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockImplementation((request, value) =>
      request.url() === event && request.method() === "OPTIONS" && value === proof ? "GET" : null);
    const html = `<h1 id="venue">Public Event Course</h1><p id="date">2026-10-23</p><p id="players">2</p>
      <div class="slot"><span class="start">10:00</span><span class="capacity">4</span><span class="holes">18</span></div><script>
      (async()=>{await fetch(${JSON.stringify(event)},{headers:{authorization:'Bearer null','x-api-key':${JSON.stringify(key)}}});
      ${mode === "inventory" ? `await fetch(${JSON.stringify(inventory)});` : ""}})().catch(()=>{});</script>`;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
      allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined, get pendingReads() { return pending; },
      releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), headers = await raw.allHeaders();
          if (![pageUrl, event, inventory].includes(raw.url())) throw Error("UNEXPECTED_FIXTURE_URL");
          const request = (): nativeRouting.NativeReadRequest => ({ url: () => raw.url(), method: () => raw.method(), headers: () => ({ ...headers }),
            postData: () => raw.postData(), resourceType: () => raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(),
            frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() });
          if (raw.url() === event && raw.method() === "GET") {
            let completed = false, denied = false;
            await handler({ request: () => ({ ...request(), method: () => "OPTIONS", resourceType: () => "other", postData: () => null,
              headers: () => ({ origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-api-key" }) }),
            continue: async () => { throw Error("SYNTHETIC_OPTIONS_USES_OWN_CONTINUATION"); }, abort: async () => { denied = true; },
            fulfill: async options => { expect(options.status).toBe(204); completed = true; } });
            if (denied || !completed) { await route.abort("blockedbyclient"); return; }
          }
          await handler({ request, continue: options => route.continue(options), abort: code => route.abort(code), fulfill: options => route.fulfill(options) });
        } finally { pending--; }
      },
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const request = route.request(), url = request.url();
      if (url === event && request.method() === "OPTIONS") {
        optionsSent++; await route.fulfill({ status: 204, body: "" });
        return { url, status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      if (request.method() !== "GET" || ![pageUrl, event, inventory].includes(url)) throw Error("UNEXPECTED_FIXTURE_DISPATCH");
      if (url === event) { eventSent++; expect(request.postData()).toBeNull(); expect(request.headers()["x-api-key"]).toBe(key); }
      if (url === inventory) inventorySent++;
      const data = Buffer.from(url === pageUrl ? html : '{"ok":true,"date":"2026-10-23","slots":[{"capacity":4}]}');
      const headers = { "content-type": url === pageUrl ? "text/html" : "application/json", "access-control-allow-origin": origin };
      await route.fulfill({ status: 200, headers, body: data }); return { url, status: 200, headers, body: data };
    });
    const fetcher = vi.fn(async () => { throw Error("NO_PINNED_OR_EXTERNAL_FETCH"); });
    const result = await executeAccessRecipe(recipe(mode), input, { now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: fetcher,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
    if (mode === "inventory") {
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true }); expect(result.slots).toHaveLength(1);
      expect(inventorySent).toBe(1);
    } else {
      expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] }); expect(inventorySent).toBe(0);
    }
    expect(eventSent).toBe(mode === "missing event route" ? 0 : 1); expect(optionsSent).toBe(mode === "missing event route" ? 0 : 1);
    expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0); expect(JSON.stringify(result)).not.toContain(key);
  }, 20_000);
});
