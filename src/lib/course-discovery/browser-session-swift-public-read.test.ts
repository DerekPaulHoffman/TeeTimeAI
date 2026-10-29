// @vitest-environment node
// Every admitted read is a local fixture and the proxy is unreachable. No
// provider, account, production database or model is used by these tests.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://book.runswiftapp.com", entry = origin + "/facilities/example-labs/rentals";
const price = origin + "/api/public/price?facilityId=123&serviceId=456&packageId=&membershipId=&userId=";
const slots = origin + "/api/booking/availableSlots?startTime=2026-10-31T04:00:00.000Z&endTime=2026-11-01T03:59:59.999Z&duration=60&serviceId=456";
describe.runIf(existsSync(chrome))("Swift signed-out native dispatch", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(["valid", "real bearer", "real session cookie"])("preserves anonymous price/calendar reads only: %s", async mode => {
    const dispatched: Array<{ url: string; headers: Record<string, string> }> = [];
    let browser: Browser | undefined, pending = 0;
    const html = '<html><body><h1>Example public golf rental catalogue</h1><a href="/times">View tee times</a><script>' +
      `Promise.all(${JSON.stringify([price, slots])}.map(url=>fetch(url,{headers:{authorization:${JSON.stringify(mode === "real bearer" ? "Bearer private-test-credential" : "Bearer null")}}}).catch(()=>{}))).finally(()=>{window.fixtureDone=true});</script></body></html>`;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
      allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
      get pendingReads() { return pending; }, releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), actualHeaders = await raw.allHeaders();
          // This is a synthetic native Fetch seam. Playwright's earlier pause
          // can omit browser-added cookies; supply the two observed header
          // shapes here rather than treating their omission as anonymous proof.
          if (raw.url() !== entry) actualHeaders.cookie = mode === "real session cookie" ? "__session=private-test-session" : "__client_uat=0; __client_uat_a1b2C3D4=0";
          await handler({ request: () => ({ url: () => raw.url(), method: () => raw.method(), headers: () => ({ ...actualHeaders }),
            postData: () => raw.postData(), resourceType: () => raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(),
            frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() }),
          continue: options => route.continue(options), abort: code => route.abort(code), fulfill: options => route.fulfill(options) });
        } finally { pending--; }
      },
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const request = route.request(), url = request.url();
      if (![entry, price, slots].includes(url)) throw Error("UNEXPECTED_FIXTURE_DISPATCH");
      dispatched.push({ url, headers: request.headers() });
      const body = Buffer.from(url === entry ? html : url === price ? '{"price":70}' : '{"slots":[]}');
      const headers = { "content-type": url === entry ? "text/html" : "application/json" };
      await route.fulfill({ status: 200, headers, body });
      return { url, status: 200, headers, body };
    });
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], venueOfficialUrl: entry,
      deadlineAt: new Date(Date.now() + 20_000), venueName: "Example public golf rental catalogue", timeZone: "America/New_York" }, {
      browserTransport: "NATIVE_CHROME", launchBrowser: async () => browser = await chromium.launch({ executablePath: chrome, headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: entry });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { fixtureDone?: boolean }).fixtureDone));
      const last = await session.execute({ id: 2, action: "observe" }), reads = dispatched.filter(row => row.url !== entry);
      if (mode === "valid") {
        expect(reads.map(row => row.url).sort()).toEqual([price, slots].sort());
        expect(reads.every(row => row.headers.authorization === "Bearer null")).toBe(true);
        expect([...first.responses, ...last.responses]).toContainEqual(expect.objectContaining({ url: slots, status: 200 }));
        expect([...first.responses, ...last.responses].some(row => row.url === price)).toBe(false);
      } else {
        expect(reads).toEqual([]);
        expect(last.requestFailures).toContainEqual(expect.objectContaining({ reason: "CREDENTIAL_HEADERS" }));
      }
      for (const url of [price, slots]) await expect(session.execute({ id: url, action: "open", url })).rejects.toThrow();
    } finally { await session.close(); }
  }, 30_000);
});
