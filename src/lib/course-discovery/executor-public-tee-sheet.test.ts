// @vitest-environment node
// Local Chrome with a synthetic native continuation and explicitly stubbed
// private proof methods. This tests caller composition, not native branding,
// actual preflight wire behavior, or a provider/public-key qualification.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import * as recipeModule from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://app.membersports.com", pageUrl = origin + "/tee-times/123/456/0";
const endpoint = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const publicBody = { configurationTypeId: 0, date: "2026-10-23", golfClubGroupId: 0, golfClubId: 123, golfCourseId: 456, groupSheetTypeId: 0 };
const publicKey = "synthetic-public-literal";
type Mode = "proved" | "missing POST route" | "missing private proof";
function recipe(mode: Mode) {
  return recipeModule.parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "public-tee-sheet-fixture", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: pageUrl, venueName: "Public Tee Sheet Course", providerFamily: "FIXTURE", timeZone: input.timeZone },
    pageUrl, steps: [], permittedRoutes: [
      { origin, path: "/tee-times/123/456/0", methods: ["GET"], queryKeys: [] },
      { origin: "https://api.membersports.com", path: "/api/v1/golfclubs/onlineBookingTeeTimes", methods: mode === "missing POST route" ? ["GET"] : ["POST"], queryKeys: [] },
    ],
    availabilityResponse: { url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "date" }, success: { path: "ok", equals: true } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, players: { selector: "#players" }, complete: { availabilityResponse: true } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
  });
}

describe.runIf(existsSync(chrome))("public tee-sheet fixed replay native caller boundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["proved", "missing POST route", "missing private proof"])("keeps OPTIONS/effective POST and actual POST authority separate: %s", async mode => {
    const posts: Array<{ url: string; headers: Record<string, string>; body: string | null }> = [];
    let pending = 0, preflightCompleted = 0, preflightAborted = 0, rawPostFulfilled = 0;
    const proof = Object.freeze({}) as NonNullable<Awaited<ReturnType<typeof nativeRouting.authorizePublicClientReadHeaders>>>;
    // Synthetic seams deliberately do not claim the controller's private brand.
    const authorize = vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request =>
      request.url() === endpoint && mode !== "missing private proof" ? proof : null);
    vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(value => value === proof && mode !== "missing private proof");
    vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockImplementation((request, value) =>
      request.url() === endpoint && request.method() === "OPTIONS" && value === proof && mode !== "missing private proof" ? "POST" : null);
    const routeChecks = vi.spyOn(recipeModule, "recipeAllowsRequest");
    const html = `<h1 id="venue">Public Tee Sheet Course</h1><p id="date">2026-10-23</p><p id="players">2</p>
      <div class="slot"><span class="start">10:00</span><span class="capacity">4</span><span class="holes">18</span></div><script>
      fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer null','x-api-key':${JSON.stringify(publicKey)}},body:JSON.stringify(${JSON.stringify(publicBody)})}).catch(()=>{});
      </script>`;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
      allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined, get pendingReads() { return pending; },
      releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), headers = await raw.allHeaders();
          if (![pageUrl, endpoint].includes(raw.url())) throw new Error("UNEXPECTED_FIXTURE_URL");
          const wrapped: nativeRouting.NativeReadRoute = { request: () => ({ url: () => raw.url(), method: () => raw.method(),
            headers: () => ({ ...headers }), postData: () => raw.postData(), resourceType: () => raw.resourceType(),
            isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() }),
          continue: options => route.continue(options), abort: code => route.abort(code), fulfill: options => route.fulfill(options) };
          if (raw.url() === endpoint && raw.method() === "POST") {
            let denied = false, fulfilled = false;
            // Inject exactly one OPTIONS before its actual POST. Its fulfillment
            // is owned/no-op: it must never fulfill the underlying POST route.
            const options: nativeRouting.NativeReadRoute = { request: () => ({ url: () => raw.url(), method: () => "OPTIONS",
              headers: () => ({ origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-api-key" }),
              postData: () => null, resourceType: () => "other", isNavigationRequest: () => false, frame: () => raw.frame(),
              redirectedFrom: () => null, response: async () => null }),
            continue: async () => { throw new Error("SYNTHETIC_OPTIONS_MUST_USE_CONTINUATION"); },
            abort: async () => { denied = true; preflightAborted++; },
            fulfill: async value => { expect(value.status).toBe(204); fulfilled = true; preflightCompleted++; } };
            await handler(options);
            if (denied || !fulfilled) { await route.abort("blockedbyclient"); return; }
          }
          await handler(wrapped);
        } finally { pending--; }
      },
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const request = route.request();
      if (request.url() === endpoint && request.method() === "OPTIONS") {
        await route.fulfill({ status: 204, body: "" });
        return { url: endpoint, status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      if (!((request.url() === pageUrl && request.method() === "GET") || (request.url() === endpoint && request.method() === "POST")))
        throw new Error("UNEXPECTED_FIXTURE_DISPATCH");
      const isPost = request.method() === "POST", data = Buffer.from(isPost ? '{"ok":true}' : html);
      const responseHeaders = { "content-type": isPost ? "application/json" : "text/html", "access-control-allow-origin": origin };
      if (isPost) { posts.push({ url: request.url(), headers: request.headers(), body: request.postData() }); rawPostFulfilled++; }
      await route.fulfill({ status: 200, headers: responseHeaders, body: data });
      return { url: request.url(), status: 200, headers: responseHeaders, body: data };
    });
    const fetcher = vi.fn(async () => { throw new Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
    const result = await executeAccessRecipe(recipe(mode), input, { now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: fetcher,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
    if (mode === "proved") {
      expect(preflightCompleted).toBe(1); expect(preflightAborted).toBe(0); expect(rawPostFulfilled).toBe(1); expect(posts).toHaveLength(1);
      expect(posts[0].headers.origin).toBe(origin); expect(posts[0].headers.authorization).toBe("Bearer null"); expect(posts[0].headers["x-api-key"]).toBe(publicKey);
      expect(JSON.parse(posts[0].body!)).toEqual(publicBody);
      expect(routeChecks.mock.calls.filter(([, url, method, kind]) => url === endpoint && method === "POST" && kind === "fetch")).toHaveLength(2);
      expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].availableSpots).toBe(4);
    } else {
      expect(preflightCompleted).toBe(0); expect(preflightAborted).toBe(1); expect(rawPostFulfilled).toBe(0); expect(posts).toEqual([]);
      expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    }
    expect(authorize.mock.calls.some(([request]) => request.method() === "OPTIONS" && request.resourceType() === "other")).toBe(true);
    expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0); expect(JSON.stringify(result)).not.toContain(publicKey);
  }, 20_000);
});
