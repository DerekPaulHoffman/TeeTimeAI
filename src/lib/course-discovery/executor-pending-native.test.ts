// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, type AccessExecutorDependencies } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));

const chromePath = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2026-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const recipe = () => parseAccessRecipe({
  schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
  target: { courseId: "pending-fixture", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/golf", bookingUrl: "https://example.org/tee-times",
    venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/tee-times", steps: [],
  permittedRoutes: [
    { origin: "https://example.org", path: "/tee-times", methods: ["GET"], queryKeys: [] },
    { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] },
    { origin: "https://example.org", path: "/held-read", methods: ["GET"], queryKeys: [] },
  ],
  availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET",
    date: { source: "QUERY", path: "date" }, success: { path: "code", equals: 200 } },
  proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" },
    complete: { availabilityResponse: true }, empty: { selector: "#empty" }, players: { selector: "#players", attribute: "value" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" },
    availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe.runIf(existsSync(chromePath))("native executor pending reads", () => {
  it.each(["AVAILABLE", "EMPTY"] as const)("cannot certify %s while the native controller still owns a pending read", async expected => {
    const held = deferred(), release = deferred();
    const dispatched: string[] = [];
    let pendingCountReads = 0, bindingReleased = false, settled = false, pendingReads = 0;
    const html = `<!doctype html><html><body><h1 id="venue">Example Golf</h1>
      <input id="date" value="2026-10-22"><input id="players" value="2">
      ${expected === "AVAILABLE"
        ? '<div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>'
        : '<p id="empty">No tee times</p>'}
      <script>fetch('/availability?date=2026-10-22').then(()=>fetch('/held-read')).then(response=>response.text()).then(()=>{
        const start=document.querySelector('.start');if(start)start.textContent='10:00';
      });</script></body></html>`;
    const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({
      // All requests are fulfilled below; an accidental unhandled request cannot
      // leave through a real provider transport or a configured credential.
      server: "http://127.0.0.1:9", close: async () => {}, allowHostConnections: () => {},
      cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }),
    });
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
      get pendingReads() { if (pendingReads) pendingCountReads++; return pendingReads; },
      // This fixture drives the controller's policy callback separately from
      // the Playwright wrapper. Actual CDP dispatch/capture is exercised by the
      // native transport's TLS integration tests.
      releasePlaywrightRoute: async route => {
        pendingReads++;
        try {
          if (new URL(route.request().url()).pathname === "/held-read") {
            held.resolve();
            await release.promise;
            bindingReleased = true;
          }
          await handler(route);
        } finally { pendingReads--; }
      },
    }));
    const transport = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const url = new URL(route.request().url());
      dispatched.push(url.pathname);
      if (url.origin !== "https://example.org" || !["/tee-times", "/availability", "/held-read"].includes(url.pathname)) {
        await route.abort(); throw new Error("UNEXPECTED_FIXTURE_REQUEST");
      }
      const body = Buffer.from(url.pathname === "/tee-times" ? html : '{"code":200}');
      const headers = { "content-type": url.pathname === "/tee-times" ? "text/html" : "application/json" };
      await route.fulfill({ status: 200, headers, body });
      return { url: url.href, status: 200, headers, body };
    });
    const deps: AccessExecutorDependencies = {
      now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath: chromePath, headless: true }),
      fetch: vi.fn(async () => { throw new Error("UNEXPECTED_HTTP_TRANSPORT"); }) as typeof fetch,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    };
    const execution = executeAccessRecipe(recipe(), input, deps);
    void execution.then(() => { settled = true; });
    try {
      await Promise.race([held.promise, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("FIXTURE_NATIVE_READ_NOT_REACHED")), 5_000))]);
      // Longer than the ordinary 600ms quiet + 750ms snapshot + 600ms quiet
      // path: a recipe with only otherwise-complete DOM would already finish.
      await new Promise(resolve => setTimeout(resolve, 3_000));
      expect(bindingReleased).toBe(false);
      expect(pendingCountReads).toBeGreaterThan(0);
      expect(dispatched).toEqual(["/tee-times", "/availability"]);
      expect(settled).toBe(false);
      release.resolve();
      const result = await execution;
      expect(result).toMatchObject({ status: expected, complete: true });
      expect(dispatched).toEqual(["/tee-times", "/availability", "/held-read"]);
      expect(deps.fetch).not.toHaveBeenCalled();
      if (expected === "AVAILABLE") expect(result.slots[0].startsAt).toBe("2026-10-22T14:00:00.000Z");
      else expect(result.slots).toEqual([]);
    } finally {
      release.resolve();
      await execution;
      transport.mockRestore(); routing.mockRestore(); proxy.mockRestore();
    }
  }, 20_000);
});
