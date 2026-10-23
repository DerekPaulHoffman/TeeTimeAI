// @vitest-environment node
// Caller budget regression: real isolated Chrome and in-memory replies, with
// synthetic native continuation/OPTIONS. No provider, database or native CDP
// ownership/actual CORS-wire proof is claimed by this fixture.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://request-budget.example.org", entry = origin + "/tee-times";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
function recipe() {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "request-budget-fixture", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: entry, venueName: "Public Example Golf", providerFamily: "UNVERIFIED", timeZone: input.timeZone },
    pageUrl: entry, steps: [{ action: "waitFor", selector: "#done" }],
    permittedRoutes: [{ origin, path: "/tee-times", methods: ["GET"], queryKeys: [] },
      { origin, path: "/static/*", methods: ["GET"], queryKeys: [] }, { origin, path: "/data", methods: ["GET"], queryKeys: ["index"] },
      { origin, path: "/availability", methods: ["GET"], queryKeys: ["date"] }, { origin, path: "/overflow", methods: ["GET"], queryKeys: [] }],
    availabilityResponse: { url: origin + "/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "code", equals: 200 } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, players: { selector: "#players", attribute: "value" },
      complete: { availabilityResponse: true }, empty: { selector: "#empty" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } } });
}
async function run(overflow: boolean) {
  let pending = 0, leaseCalls = 0, activeLeases = 0, peakLeases = 0;
  const handled: string[] = [], dispatched: string[] = [], denied: string[] = [];
  const html = `<h1 id="venue">Public Example Golf</h1><input id="date" value="2026-10-23"><input id="players" value="2">
    <div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>` +
    Array.from({ length: 85 }, (_, index) => `<script src="/static/${index}.js"></script>`).join("") + `<script>
    (async()=>{for(let index=0;index<52;index++)await fetch('/data?index='+index).catch(()=>{});
    await fetch('/availability?date=2026-10-23').catch(()=>{});${overflow ? "await fetch('/overflow').catch(()=>{});" : ""}
    const done=document.createElement('p');done.id='done';done.textContent='Public reads settled';document.body.append(done)})();</script>`;
  vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
    allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
  vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
    prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try {
        const raw = route.request(), url = new URL(raw.url());
        if (url.origin !== origin || !/^\/(?:tee-times|static\/\d+\.js|data|availability|overflow)$/u.test(url.pathname)) {
          await route.abort(); throw Error("UNEXPECTED_FIXTURE_URL");
        }
        if (["/data", "/availability"].includes(url.pathname)) {
          let aborted = false, completed = false;
          const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => "OPTIONS",
            headers: () => ({ origin, "access-control-request-method": "GET", "access-control-request-headers": "content-type" }),
            postData: () => null, resourceType: () => "other", isNavigationRequest: () => false, frame: () => raw.frame(), redirectedFrom: () => null, response: async () => null };
          handled.push("OPTIONS " + url.pathname);
          await handler({ request: () => request, continue: async () => { throw Error("SYNTHETIC_OPTIONS_MUST_NOT_REACH_WIRE"); },
            abort: async () => { aborted = true; denied.push("OPTIONS " + url.pathname); },
            fulfill: async response => { expect(response.status).toBe(204); completed = true; } });
          if (aborted || !completed) { await route.abort(); return; }
        }
        handled.push(raw.method() + " " + url.pathname);
        await handler({ request: () => raw, continue: options => route.continue(options),
          abort: async code => { denied.push(raw.method() + " " + url.pathname); await route.abort(code); }, fulfill: response => route.fulfill(response) });
      } finally { pending--; }
    },
  }));
  vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
    const request = route.request(), url = new URL(request.url());
    dispatched.push(request.method() + " " + url.pathname);
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, body: "" }); return { url: url.href, status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    const contentType = url.pathname === "/tee-times" ? "text/html" : url.pathname.startsWith("/static/") ? "text/javascript" : "application/json";
    const body = Buffer.from(url.pathname === "/tee-times" ? html : url.pathname.startsWith("/static/") ? "/* public static resource */" : '{"code":200}');
    const headers = { "content-type": contentType }; await route.fulfill({ status: 200, headers, body });
    return { url: url.href, status: 200, headers, body };
  });
  const fetcher = vi.fn(async () => { throw Error("PINNED_FETCH_MUST_NOT_RUN"); });
  const result = await executeAccessRecipe(recipe(), input, { now: () => new Date("2026-10-20T12:00:00Z"), fetch: fetcher,
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), requestLease: async (_family, work) => {
      leaseCalls++; activeLeases++; peakLeases = Math.max(peakLeases, activeLeases);
      try { return { acquired: true, value: await work() }; } finally { activeLeases--; }
    } });
  expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0); expect(activeLeases).toBe(0); expect(peakLeases).toBe(1);
  return { result, handled, dispatched, denied, leaseCalls };
}
describe.runIf(existsSync(chrome))("executor finite public request budget", () => {
  afterEach(() => vi.restoreAllMocks());
  it("allows exactly192 counted document/assets/data/OPTIONS requests including the last availability GET", async () => {
    const { result, handled, dispatched, denied, leaseCalls } = await run(false);
    expect(dispatched).toHaveLength(192); expect(handled).toHaveLength(192); expect(leaseCalls).toBe(192); expect(denied).toEqual([]);
    expect(dispatched.filter(value => value.startsWith("OPTIONS "))).toHaveLength(53);
    expect(dispatched.filter(value => value.startsWith("GET /static/"))).toHaveLength(85);
    expect(dispatched.at(-1)).toBe("GET /availability");
    expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true }); expect(result.slots).toHaveLength(1);
  }, 25_000);
  it("aborts request193 before provider lease/native dispatch and cannot certify previously observed availability", async () => {
    const { result, handled, dispatched, denied, leaseCalls } = await run(true);
    expect(dispatched).toHaveLength(192); expect(handled).toHaveLength(193); expect(leaseCalls).toBe(192);
    expect(handled.at(-1)).toBe("GET /overflow"); expect(dispatched).not.toContain("GET /overflow"); expect(denied).toEqual(["GET /overflow"]);
    expect(result).toMatchObject({ complete: false, slots: [], evidence: { diagnostic: { code: "REQUEST_LIMIT" } } });
    expect(result.status).not.toBe("EMPTY");
  }, 25_000);
});
