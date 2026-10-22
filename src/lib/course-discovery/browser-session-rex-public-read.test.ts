// @vitest-environment node
// Isolated local Chrome; native policy/dispatch seams are synthetic. No socket
// can reach a provider: every admitted read is fulfilled and the proxy is dead.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://public-rental.reservewithrex.com", entry = `${origin}/package?guests=2`;
const publicBody = { venueId: "11111111-2222-3333-4444-555555555555", packageId: "66666666-7777-8888-9999-aaaaaaaaaaaa",
  date: "2026-10-23", guests: 2, duration: 2, lanes: 1, resourceIds: [], guestsWithAgeGroups: [] };
const secret = "fixture-credential-MUST-NOT-LEAK";
type Mode = "valid" | "real bearer" | "cookie" | "anonymous cookie" | "anonymous token" | "csrf" | "unsafe body" | "unknown GraphQL";

describe.runIf(existsSync(chrome))("REX discovery native policy boundary", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["valid", "real bearer", "cookie", "anonymous cookie", "anonymous token", "csrf", "unsafe body", "unknown GraphQL"])
  ("dispatches only the exact public read: %s", async mode => {
    const dispatched: Array<{ url: string; method: string; headers: Record<string, string>; body: string | null }> = [];
    let browser: Browser | undefined, pending = 0, active = 0, maximum = 0;
    const anonymous = mode === "anonymous cookie" || mode === "anonymous token";
    const path = mode === "unknown GraphQL" ? "/graphql" : "/api/venue/get-venue-with-package";
    const headers: Record<string, string> = { "content-type": "application/json",
      ...(!anonymous ? { authorization: mode === "real bearer" ? `bearer ${secret}` : "bearer null" } : {}),
      ...(mode === "anonymous token" ? { "x-auth-token": secret } : {}), ...(mode === "csrf" ? { "x-csrf": secret } : {}) };
    const body = mode === "unknown GraphQL" ? { query: "{ slots { time } }" }
      : { ...publicBody, ...(mode === "unsafe body" ? { skipReservationId: "selected-reservation" } : {}) };
    const html = `<html><body><h1>Public Golf Rentals</h1><a href='/package?guests=2'>View availability</a><script>
      ${mode === "cookie" || mode === "anonymous cookie" ? `document.cookie='account=${secret}; Secure; SameSite=Lax';` : ""}
      fetch(${JSON.stringify(path)},{method:'POST',headers:${JSON.stringify(headers)},body:JSON.stringify(${JSON.stringify(body)})})
        .catch(()=>{}).finally(()=>{window.fixtureDone=true;});</script></body></html>`;
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9",
      close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {},
      stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
      get pendingReads() { return pending; }, releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), actualHeaders = await raw.allHeaders();
          // Actual CDP supplies all headers. Playwright's convenience headers()
          // can omit security headers, so the local seam uses allHeaders().
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
      if (url.origin !== origin || !["/package", "/api/venue/get-venue-with-package"].includes(url.pathname))
        throw new Error("UNEXPECTED_FIXTURE_DISPATCH");
      dispatched.push({ url: request.url(), method: request.method(), headers: request.headers(), body: request.postData() });
      const data = Buffer.from(request.method() === "GET" ? html : '{"ok":true,"slots":[]}');
      const responseHeaders = { "content-type": request.method() === "GET" ? "text/html" : "application/json" };
      await route.fulfill({ status: 200, headers: responseHeaders, body: data });
      return { url: request.url(), status: 200, headers: responseHeaders, body: data };
    });
    const fetcher = vi.fn(async () => { throw new Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], venueOfficialUrl: entry,
      deadlineAt: new Date(Date.now() + 15_000), timeZone: "America/Los_Angeles", venueName: "Public Golf Rentals" }, {
      browserTransport: "NATIVE_CHROME", fetch: fetcher,
      launchBrowser: async () => browser = await chromium.launch({ executablePath: chrome, headless: true }),
      requestLease: async (_family, work) => { active++; maximum = Math.max(maximum, active);
        try { return { acquired: true, value: await work() }; } finally { active--; } },
    });
    try {
      const initial = await session.execute({ id: 1, action: "open", url: entry });
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { fixtureDone?: boolean }).fixtureDone));
      const snapshot = await session.execute({ id: 2, action: "observe" });
      const posts = dispatched.filter(row => row.method === "POST");
      if (mode === "valid") {
        expect(posts).toHaveLength(1); expect(posts[0].headers.authorization).toBe("bearer null");
        expect(JSON.parse(posts[0].body!)).toEqual(publicBody); expect(posts[0].url).toBe(origin + path);
        expect([...initial.responses, ...snapshot.responses]).toContainEqual(expect.objectContaining({ url: origin + path, status: 200, method: "POST" }));
      } else {
        expect(posts).toEqual([]);
        expect([...initial.requests, ...snapshot.requests]).toContainEqual(expect.objectContaining({ method: "POST", blockedReason: "UNSAFE_METHOD" }));
      }
      expect(JSON.stringify([initial, snapshot])).not.toContain(secret); expect(fetcher).not.toHaveBeenCalled();
      expect(maximum).toBe(1); expect(active).toBe(0);
    } finally { await session.close(); }
  }, 20_000);
});
