// @vitest-environment node
// Offline wiring tests: real isolated Chrome request/redirect objects, with all
// responses supplied by a loopback-only TLS fixture (or injected pinned read).
// No provider, database, or model is contacted.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo } from "node:net";
import type { Browser, BrowserContext } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import * as nativeBrowser from "./native-public-browser";
import { installNativeRedirectRouting, type NativeReadRoute } from "./native-redirect-routing";
import { launchPublicReadBrowser } from "./public-browser-launch";
import { parseAccessRecipe } from "./recipe";
import { readNativeOfficialIdentityPage } from "./native-official-page-reader";
import { bindCpsPostalConflictProof } from "./cps-postal-conflict-proof";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// Throwaway self-signed localhost fixture material. It grants no external access.
const fixtureCertificate = "-----BEGIN CERTIFICATE-----\nMIIDJzCCAg+gAwIBAgIUF6mb2Ji27vp9h9GBNYqmhzk+tcYwDQYJKoZIhvcNAQEL\nBQAwIjEgMB4GA1UEAwwXb2ZmbGluZS1maXh0dXJlLmludmFsaWQwIBcNMjYxMDIw\nMTkxMTAyWhgPMjEyNjA5MjYxOTExMDJaMCIxIDAeBgNVBAMMF29mZmxpbmUtZml4\ndHVyZS5pbnZhbGlkMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyhfo\nFYmMsS6Tophavdmig+oSa3PQKpYlBkKwtHgmt8bZDUe7Isb3rlVOXicIKUZiekhL\nQ5CX7J0Fa7Ua58hsMePbVYVBMplxIgQRCWqSrJs9VRpA0DXRA63s8R/131sicim0\nmRwy9i+ap1I4ZU8gw2gwW5wYR2jF/Slt747fliPyHbs1T5BrEY90AQhShu63jBSd\nKs/ARKOneQzrolRqtCOv0gNjNIqcfMefdrMhyDMCrSxdJe02mLk9SYICQocTyudM\ncI04+eLW9T/VxThmm9OvGyWxh3RnjDGrHfgeUXtKP5N/m0CMEIxx9YUMzSlJKCfN\nRSy2MrhfIV63/uvFpwIDAQABo1MwUTAdBgNVHQ4EFgQUDOkhBTxsI5z6UK6iGBc/\n7zTQcw0wHwYDVR0jBBgwFoAUDOkhBTxsI5z6UK6iGBc/7zTQcw0wDwYDVR0TAQH/\nBAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEADHgjmAC//a+RQDCg19tVTP4SZpLs\nIHj2L+9KCkEZkLub0DblCJ072aeDtI6ImwmjI08ZSJIzvUllC01KIm+miUbxNkW/\nIjN4imKZWUs4WFeku4OBOHF7Z3L5Y3XUxYuJsTtXq8+vSZ36Yt88yYo70j5RznQR\nSEKwkKuYpQQYRYZPPE280q1V56G+LbYtRkMA/yVYWKE5SQsJ/eF9EkxcecPJEqNO\nqbLw0IDFiiOETCuU36XUZXoukL0KfFxqAYnuoMyxM8E9OtENO+cw8daWwkCXXU3y\nhxc76Be2sOWjEw5cdFLZHUUATtfuzob7Mq43LR60wXR56OIpij94x3d/TA==\n-----END CERTIFICATE-----\n";
const fixtureKey = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDKF+gViYyxLpOi\nmFq92aKD6hJrc9AqliUGQrC0eCa3xtkNR7sixveuVU5eJwgpRmJ6SEtDkJfsnQVr\ntRrnyGwx49tVhUEymXEiBBEJapKsmz1VGkDQNdEDrezxH/XfWyJyKbSZHDL2L5qn\nUjhlTyDDaDBbnBhHaMX9KW3vjt+WI/IduzVPkGsRj3QBCFKG7reMFJ0qz8BEo6d5\nDOuiVGq0I6/SA2M0ipx8x592syHIMwKtLF0l7TaYuT1JggJChxPK50xwjTj54tb1\nP9XFOGab068bJbGHdGeMMasd+B5Re0o/k3+bQIwQjHH1hQzNKUkoJ81FLLYyuF8h\nXrf+68WnAgMBAAECggEAAj3npi2DcQe6PYiBITAD3IDBOY3sVjyaJoqg2S+oBkvf\nZoVQLx+T6cwqdWLrdUHBn+ejZhl5hfdr8vjsVnvjr13+teEniv8mwSDYa4lSHTYP\npR0IcQbXzbmlMjuPh63EIQ4TYcttSUvX5FlGJOGO1HwYZTvDDS+9WoSWIp0sH8c7\nQQ9v8FuF6QNhe0sSTfx1U78ko/odQd5pUxfvmCaAHuLXEe2BIUN6hiC0JTziRhhH\nk9ILIJ3o5s0NAwF/wM5j2jGC9GzJg7haN79dXCEfZUq9kcIeCJbYS1vQrJprsWja\n0JImpwO7NuOpL9NTgzmWp1GCugAYvW5E5VLRCyUv8QKBgQDpOYK8JmRPgFN6bpvq\nq7vjjf4Jbtq5/YavuRAB7DemNu7ilzUcLhIUoNnAy/Hgfz8lmsVzhr9VuoVvROFR\ne7lKFkNiXmHXbNGByTJtgsLwdvXeL+ZvGpG9xqIW0WbDualqCzihPgJVwQFcPdYM\nIjKyXnydmQrJoGeKjqOJE7D6XwKBgQDd1CGVwXuYYqZ/JRFYV5WquI12HOE4/aJb\nk+E0VT4f6ESpvwFQ93eMk09QbR8YF8+1mQzI/j3k1+F4yDu2p8QMZ79UFcgZ470x\n7HaoLHTsqqDyMiLPYaj0Wh880rJZmK7vjGZpC8PxEwU/czB32LRuU0tj9cpVrF7M\n+D8agjaJuQKBgAOZCoZChVugnCkQWcFmAtEA2MFmf2NNIO3HChMthLJAuLCwKnaT\n012UGafavZF8BQpcd91PX9Y/uV09D8jFAte8vi9fS10aZaT96JQ95yn0e9iAnqpq\nG4N08/0sH8y3KYDkSWxbW4fdIVs97PZk9KlBweRgfwUbP12o06cCscE7AoGBAMVA\ncGzeE605a5v7tiS8HRYl7YRtwcgPoWOVZ9hFRGzS+NuIQP9iTifuhcSag9/ErKpq\nYfgIO7lWTeQ9CPwuyiHNz1BR3hFHdWEDR6/beE1KnLtA4btOuBIwYT6QjI8nOcdB\nLX+TOrUPmMcHAr5PMII6Bvvn//eWwuW4iURlLWHhAoGAaUyMRkftlmljmwXzpGRX\nTIk07pJO+ANhJYitoyPo+cwW1owhigb8tLGpdlD1HL3plyXmJyoRl603aPzcrjfK\n/Vmsh+4FwlIDcOjHL4pmxBM9F97a8J5uwMlHAWyT2SjWBZPFGF3HXFeK5EnPAgD5\nK0UDSHv5hHNF7npW07Bwb6s=\n-----END PRIVATE KEY-----\n";
const official = "https://official.example.org/golf";
const entry = "https://sc.cps.golf/OfflineGolfV3/Home/nIndex?CourseId=7&Time=AnyTime&Player=99&Hole=Any";
const date = "2026-10-23", otherDate = "2026-10-24";
const copiedToken = "old123old123old123old123", firstToken = "new123new123new123new123", secondToken = "new456new456new456new456";
const input = { date, timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
const createRealProxy = nativeBrowser.createNativePublicBrowserProxy;
const continueRealNative = nativeBrowser.continueNativeBrowserRead;
function dated(value: string, requestedDate: string) { const url = new URL(value); url.searchParams.set("Date", requestedDate); return url.href; }
function sessionUrl(token: string, requestedDate = date) {
  const url = new URL(dated(entry, requestedDate)); url.pathname = `/OfflineGolfV3/(S(${token}))/Home/nIndex`; return url.href;
}
function html(requestedDate: string, nextUrl?: string) {
  return '<!doctype html><html><head><title>Offline Golf Course</title></head><body>' +
    '<h1 id="venue">Offline Golf Course</h1>' + `<p id="date">${requestedDate}</p><p id="players">2</p>` +
    '<div class="slot"><span class="start">09:00</span><span class="capacity">4</span></div>' +
    (nextUrl ? `<button aria-label="Next month" onclick='location.href=${JSON.stringify(nextUrl)}'>Next month</button>` : "") + '</body></html>';
}
function recipe(transport: "NATIVE_CHROME" | "PINNED_HTTP" = "NATIVE_CHROME") {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: transport,
    target: { courseId: "offline-course", kind: "OUTDOOR" },
    source: { officialUrl: official, bookingUrl: entry, venueName: "Offline Golf Course", providerFamily: "CPS", timeZone: input.timeZone },
    pageUrl: `${entry}&Date={{date}}`, steps: [],
    permittedRoutes: [{ origin: "https://sc.cps.golf", path: "/OfflineGolfV3/Home/nIndex", methods: ["GET"],
      queryKeys: ["CourseId", "Time", "Player", "Hole", "Date"] }],
    availabilityResponse: { kind: "SERVER_DOCUMENT", url: `${entry}&Date={{date}}`, method: "GET", date: { source: "QUERY", path: "Date" } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, players: { selector: "#players" }, complete: { serverDocument: true } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } },
  });
}

describe.runIf(existsSync(chrome))("offline CPS discovery and deterministic browser wiring", () => {
  let browsers: Browser[], nativeSeen: string[], serverSeen: string[], pinnedSeen: string[], failedRequests: string[];
  let responseEvents: string[], requestEvents: string[];
  let correlationEvents: object[];
  let discoveryFailures: string[];
  let server: Server;
  let respond: (url: string, context: BrowserContext) => { status?: number; location?: string; body?: string; contentType?: string; echoRequestBody?: boolean; networkFailure?: boolean };
  beforeEach(async () => {
    browsers = []; nativeSeen = []; serverSeen = []; pinnedSeen = []; failedRequests = [];
    responseEvents = []; requestEvents = []; correlationEvents = [];
    discoveryFailures = [];
    const start = Date.now(), push = responseEvents.push.bind(responseEvents);
    responseEvents.push = (...values) => push(...values.map(value => `${Date.now() - start}ms ${value}`));
    respond = url => ({ body: html(new URL(url).searchParams.get("Date") ?? date) });
    const requestContexts = new Map<string, BrowserContext[]>(), redirectedContexts = new Map<string, BrowserContext>(), networkFailureUrls = new Set<string>();
    server = createServer({ cert: fixtureCertificate, key: fixtureKey }, (request, response) => {
      const url = `https://${request.headers.host}${request.url}`;
      serverSeen.push(url);
      // Chrome may retry a failed script inside the same admitted request.
      // Keep the explicit fixture failure instead of replacing it with an
      // unbound-retry HTTP500, which would qualify a different response path.
      if (networkFailureUrls.has(url)) { request.socket.destroy(); return; }
      const context = requestContexts.get(url)?.shift() ?? redirectedContexts.get(url);
      if (!context || !["official.example.org", "sc.cps.golf"].includes(request.headers.host ?? "")) {
        response.writeHead(500); response.end("Unbound offline request"); return;
      }
      const reply = respond(url, context);
      if (reply.networkFailure) { networkFailureUrls.add(url); request.socket.destroy(); return; }
      if (reply.location) redirectedContexts.set(reply.location, context);
      response.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "text/html", ...(reply.location ? { location: reply.location } : {}) });
      if (reply.echoRequestBody) {
        let body = "";
        request.on("data", chunk => { body += chunk; });
        request.on("end", () => response.end(body));
      } else response.end(reply.body ?? "");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    // Exercise the real native CONNECT transport. Both DNS and the socket dial
    // are injected: every tunnel terminates at this loopback-only TLS fixture.
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockImplementation(config => createRealProxy(config, {
      resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
      connect: () => connect(port, "127.0.0.1"),
    }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async (route, signal, limit, abort, transportUrl) => {
      const url = route.request().url(); nativeSeen.push(url); expect(transportUrl).toBe(url);
      const pending = requestContexts.get(url) ?? [];
      pending.push(route.request().frame().page().context()); requestContexts.set(url, pending);
      return continueRealNative(route, signal, limit, abort, transportUrl);
    });
  });
  afterEach(async () => {
    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
  });
  const launchBrowser = async () => {
    const browser = await launchPublicReadBrowser({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] });
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation(async options => {
      const context = await newContext({ ...options, ignoreHTTPSErrors: true });
      const originalSession = context.newCDPSession.bind(context), originalRoute = context.route.bind(context);
      vi.spyOn(context, "newCDPSession").mockImplementation(async target => {
        const cdp = await originalSession(target);
        cdp.on("Fetch.requestPaused", event => correlationEvents.push({ event: "CDP", url: event.request.url, kind: event.resourceType,
          headers: event.request.headers }));
        return cdp;
      });
      vi.spyOn(context, "route").mockImplementation(async (pattern, handler, options) => originalRoute(pattern, async route => {
        const request = route.request(), allHeaders = request.allHeaders.bind(request);
        vi.spyOn(request, "allHeaders").mockImplementation(async () => {
          correlationEvents.push({ event: "PW_HEADERS_START", url: request.url(), kind: request.resourceType() });
          const values = await allHeaders(); correlationEvents.push({ event: "PW_HEADERS_END", url: request.url(), kind: request.resourceType(), headers: values });
          return values;
        });
        await handler(route, request);
      }, options));
      context.on("requestfailed", request => failedRequests.push(`${request.url()} ${request.failure()?.errorText}`));
      context.on("request", request => requestEvents.push(`${request.url()} FROM ${request.redirectedFrom()?.url() ?? "none"}`));
      context.on("response", response => responseEvents.push(`${response.url()} ${response.status()}`));
      return context;
    });
    browsers.push(browser); return browser;
  };
  const pinnedFetch: typeof fetch = async value => {
    const url = String(value); pinnedSeen.push(url);
    const response = respond(url, undefined as unknown as BrowserContext);
    return new Response(response.body ?? "", { status: response.status ?? 200,
      headers: { "content-type": "text/html", ...(response.location ? { location: response.location } : {}) } });
  };
  const nativeOwner = async (read: (route: NativeReadRoute) => Promise<void>) => {
    const proxy = await nativeBrowser.createNativePublicBrowserProxy({ signal: AbortSignal.timeout(30_000) });
    const browser = await launchBrowser();
    const context = await browser.newContext({ proxy: { server: proxy.server, bypass: "<-loopback>" }, serviceWorkers: "block" });
    const page = await context.newPage(), failures: string[] = [];
    const routing = await installNativeRedirectRouting(page, read, { onFailure: code => failures.push(code) });
    await context.route("**/*", route => routing.releasePlaywrightRoute(route));
    return { page, routing, failures, close: async () => { await routing.close(); await context.close(); await proxy.close(); } };
  };
  const openDiscovery = (browserTransport: "NATIVE_CHROME" | "PINNED_HTTP" = "NATIVE_CHROME") => createCourseDiscoveryBrowserSession({
    initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000), venueName: "Offline Golf Course", timeZone: input.timeZone,
  }, { launchBrowser, browserTransport, fetch: pinnedFetch, requestLease: lease,
    onRequestFailure: value => { discoveryFailures.push(value.reason); } });
  const officialBody = `<html><body><h1>Offline Golf Course official site</h1><a href="${sessionUrl(copiedToken, "2020-01-01")}">Book Your Tee Time</a></body></html>`;
  function normalResponses(nextUrl?: string) {
    respond = url => url === official ? { body: officialBody } : new URL(url).pathname.includes("/(S(")
      ? { body: html(new URL(url).searchParams.get("Date") ?? date, nextUrl) }
      : { status: 302, location: sessionUrl(firstToken, new URL(url).searchParams.get("Date") ?? date) };
  }
  async function followOfficial(session: Awaited<ReturnType<typeof openDiscovery>>) {
    const opened = await session.execute({ id: 1, action: "open", url: official });
    const link = opened.controls.find(control => control.name === "Book Your Tee Time")!;
    expect(link?.href).toBe(entry);
    expect(JSON.stringify(opened)).not.toContain(copiedToken);
    expect(JSON.stringify(opened)).not.toContain("2020-01-01");
    return session.execute({ id: 2, action: "click", target: link.target });
  }
  function expectGuardedServerDispatches(expected: string[]) {
    // Installed Chrome can issue this unrelated startup read before the test
    // context exists. The injected socket still reaches only this TLS fixture,
    // whose missing-context branch rejects it with HTTP 500; it is never page proof.
    // Keep every other URL in the exact dispatch assertion, including forbidden
    // destinations, instead of ignoring arbitrary hosts or unexpected reads.
    const startup = serverSeen.filter(value => new URL(value).origin === "https://www.google.com" && new URL(value).pathname === "/async/folae");
    expect(startup.length).toBeLessThanOrEqual(1);
    expect(startup.every(value => !nativeSeen.includes(value))).toBe(true);
    expect(serverSeen.filter(value => !startup.includes(value))).toEqual(expected);
  }

  it("captures an exact current official cross-host redirect from real Chrome and rejects direct reuse without fresh lineage", async () => {
    const destination = "https://sc.cps.golf/new-official-course", bookingUrl = "https://sc.cps.golf/onlineresweb/search-teetime";
    respond = url => url === official ? { status: 301, location: destination } : url === destination
      ? { body: `<html><head><title>Offline Golf Course</title><link rel="icon" href="data:,"></head><body><h1>Offline Golf Course</h1>` +
        `<ul><li class="widgetItem h-card"><h4 class="p-name">Unrelated Golf Course</h4><div class="p-tel">303-555-9999</div></li>` +
        `<li class="widgetItem h-card"><h4 class="widgetTitle field p-name">Offline Golf Course</h4><div class="field h-adr"><strong>Physical Address</strong>` +
        `<button>View Map</button><br><span class="p-street-address">10 Harbor Drive</span><br><span class="locality">Example</span>, ` +
        `<span class="p-region">NY</span> <span class="p-postal-code">54321</span></div><div class="field p-tel"><a href="tel:9165554653">(916) 555-4653</a></div></li></ul>` +
        `<a href="${bookingUrl}">Tee Times</a></body></html>` }
      : { status: 404, body: "Unexpected fixture path" };
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000),
      venueOfficialUrl: official, venueName: "Offline Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: input.timeZone },
    { launchBrowser, browserTransport: "NATIVE_CHROME", requestLease: lease, collectPublicCourseContacts: true });
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.url).toBe(destination);
      expect(snapshot.nativeDocumentRedirects).toEqual([{ fromUrl: official, toUrl: destination, status: 301, completed: true }]);
      expect(snapshot.officialSourceDiagnostic).toMatchObject({ rawOfficialCaptured: true, currentOfficialDocument: true, officialProvenance: true,
        renderedAddressesPresent: true, renderedLinksPresent: true });
      const fresh = await session.readOfficialIdentityPage();
      const diagnostic = session.diagnostics().officialIdentityReadDiagnostic!;
      expect(Object.values(diagnostic.gates).every(Boolean)).toBe(true);
      expect(diagnostic.captureAgeMs).toBeGreaterThanOrEqual(0);
      expect(diagnostic.captureAgeMs).toBeLessThanOrEqual(5000);
      expect(JSON.stringify(diagnostic)).not.toMatch(/https?:|html|Harbor|916|54321|timeOrigin/u);
      diagnostic.gates.capturedPagePresent = false;
      expect(session.diagnostics().officialIdentityReadDiagnostic?.gates.capturedPagePresent).toBe(true);
      expect(fresh.url).toBe(destination); expect(fresh.html).toContain("10 Harbor Drive");
      expect(fresh.visibleEvidence?.headings).toContain("Offline Golf Course");
      expect(fresh.visibleEvidence?.publicContactBlocks).toEqual([{ venueName: "Offline Golf Course", street: "10 Harbor Drive", locality: "Example",
        region: "NY", postalCode: "54321", country: "US", phone: "(916) 555-4653" }]);
      const source = { officialUrl: official, bookingUrl, venueName: "Offline Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: input.timeZone };
      // The owned reader obtains a new actual DOM/raw capture from this same
      // isolated native session. A serialized snapshot alone cannot mint proof.
      const attested = await readNativeOfficialIdentityPage(source, official, new Date(Date.now() + 20_000), {
        createSession: async () => ({ execute: async () => snapshot, readOfficialIdentityPage: () => session.readOfficialIdentityPage(), close: async () => {} }),
      });
      expect(bindCpsPostalConflictProof(source, attested, "+19165554653", { tenant: "sc", courseIds: [7], catalogHash: "a".repeat(64) }, "Offline Golf")).toMatchObject({
        canonicalPostalCode: "12345", officialPostalCode: "54321", canonicalCoursePhone: "+19165554653", requiredCapability: "LOCAL_CHROME",
      });
      const replay = await session.execute({ id: 2, action: "open", url: destination });
      expect(replay.nativeDocumentRedirects).toBeUndefined();
      expect(replay.officialSourceDiagnostic?.rawOfficialCaptured).toBe(false);
      await expect(session.readOfficialIdentityPage()).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
      expect(session.diagnostics().officialIdentityReadDiagnostic).toMatchObject({ captureAgeMs: null,
        gates: { capturedPagePresent: false, captureFreshWithin5s: false, officialDocumentVerified: false } });
      const ownedPage = browsers.flatMap(browser => browser.contexts()).flatMap(context => context.pages()).find(page => page.url() === destination)!;
      const failedSnapshot = vi.spyOn(ownedPage, "evaluate").mockRejectedValueOnce(new Error("OFFLINE_SNAPSHOT_FAILED"));
      await expect(session.readOfficialIdentityPage()).rejects.toThrow("OFFLINE_SNAPSHOT_FAILED");
      expect(session.diagnostics().officialIdentityReadDiagnostic).toBeUndefined();
      failedSnapshot.mockRestore();
      expect(nativeSeen).toEqual([official, destination, destination]); expect(pinnedSeen).toEqual([]);
    } finally { await session.close(); }
  }, 30_000);

  it("keeps private identity fresh while the unchanged general inventory is slow and rejects newly hidden identity", async () => {
    const bookingUrl = "https://sc.cps.golf/onlineresweb/search-teetime";
    respond = url => url === official ? { body: `<html><head><title>Offline Golf Course</title></head><body><h1>Offline Golf Course</h1><p>10 Harbor Drive, Example, NY 12345</p><a href="${bookingUrl}">Tee Times</a></body></html>` } : { status: 404, body: "Unexpected path" };
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000),
      venueOfficialUrl: official, venueName: "Offline Golf Course", venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: input.timeZone },
    { launchBrowser, browserTransport: "NATIVE_CHROME", requestLease: lease });
    try {
      await session.execute({ id: 1, action: "open", url: official });
      const ownedPage = browsers.flatMap(browser => browser.contexts()).flatMap(context => context.pages()).find(page => page.url() === official)!;
      const locate = ownedPage.locator.bind(ownedPage);
      let delayedInventoryReads = 0;
      vi.spyOn(ownedPage, "locator").mockImplementation((selector, options) => {
        const locator = locate(selector, options);
        if (selector !== "body *") return locator;
        return new Proxy(locator, { get(target, key) {
          if (key === "evaluateAll") return async (...args: unknown[]) => {
            delayedInventoryReads++;
            const result = await Reflect.apply(target.evaluateAll, target, args);
            // Delay only the bounded inventory after its fresh identity capture.
            await new Promise(resolve => setTimeout(resolve, 5100)); return result;
          };
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
        } });
      });
      const fresh = await session.readOfficialIdentityPage();
      expect(fresh.visibleEvidence?.addressTexts.some(text => text.includes("10 Harbor Drive"))).toBe(true);
      expect(delayedInventoryReads).toBe(0);
      const diagnostic = session.diagnostics().officialIdentityReadDiagnostic!;
      expect(diagnostic.captureAgeMs).toBeLessThanOrEqual(5000);
      expect(Object.values(diagnostic.gates).every(Boolean)).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toMatch(/https?:|html|Harbor|12345|timeOrigin/u);
      const before = Date.now(), general = await session.execute({ id: 2, action: "observe" });
      expect(Date.now() - before).toBeGreaterThanOrEqual(5100);
      expect(delayedInventoryReads).toBe(1);
      expect(general.controls.some(control => control.name === "Tee Times")).toBe(true);
      // A new private read must recapture visibility, not restamp the old page.
      await ownedPage.locator("p").evaluate(node => { (node as HTMLElement).style.display = "none"; });
      await expect(session.readOfficialIdentityPage()).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
      expect(delayedInventoryReads).toBe(1);
      expect(session.diagnostics().officialIdentityReadDiagnostic?.gates.visibleAddressesPresent).toBe(false);
    } finally { await session.close(); }
  }, 30_000);

  it("follows an observed cross-host HTTP document redirect with a separate serialized lease for every hop", async () => {
    const observedEntry = "https://official.example.org/public-tee-times";
    const landing = "https://sc.cps.golf/public-availability?date=2026-10-23";
    let active = 0, maxActive = 0, tail = Promise.resolve();
    const leased: string[] = [], serverLeaseCounts: number[] = [];
    const serializedLease = async <T>(family: string, work: () => Promise<T>) => {
      const prior = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await prior;
      active++; maxActive = Math.max(maxActive, active); leased.push(family);
      try { return { acquired: true as const, value: await work() }; } finally { active--; release(); }
    };
    respond = url => {
      serverLeaseCounts.push(active);
      return url === official ? { body: `<html><body><a href="${observedEntry}">Public tee times</a></body></html>` }
        : url === observedEntry ? { status: 302, location: landing }
          : { body: html(date) };
    };
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000),
      venueName: "Offline Golf Course", timeZone: input.timeZone }, { launchBrowser, browserTransport: "NATIVE_CHROME", requestLease: serializedLease });
    try {
      const root = await session.execute({ id: 1, action: "open", url: official });
      const link = root.controls.find(control => control.name === "Public tee times")!;
      expect(link?.href).toBe(observedEntry);
      const result = await session.execute({ id: 2, action: "click", target: link.target });
      expect(result.url).toBe(landing); expect(result.text).toContain(date);
      expect(result.requests).toContainEqual(expect.objectContaining({ url: observedEntry, status: 302, resourceType: "document" }));
      expect(result.requests).toContainEqual(expect.objectContaining({ url: landing, status: 200, resourceType: "document" }));
      expect(nativeSeen).toEqual([official, observedEntry, landing]); expectGuardedServerDispatches(nativeSeen);
      expect(leased).toHaveLength(3); expect(serverLeaseCounts).toEqual([1, 1, 1]); expect(maxActive).toBe(1);
      expect(active).toBe(0); expect(result.loading).toBe(false); expect(discoveryFailures).toEqual([]); expect(pinnedSeen).toEqual([]);
    } finally { await session.close(); }
  }, 40_000);

  it.each(["script-only", "200-Location"] as const)("does not fabricate cross-host redirect authority from %s navigation", async kind => {
    const denied = "https://sc.cps.golf/unobserved-document";
    respond = url => url === official ? { status: 200, ...(kind === "200-Location" ? { location: denied } : {}),
      body: `<html><body><h1>Offline Golf Course</h1><script>location.href=${JSON.stringify(denied)}</script></body></html>` } : { body: html(date) };
    const session = await openDiscovery();
    try {
      await session.execute({ id: 1, action: "open", url: official }).catch(() => {});
      await vi.waitFor(() => expect(discoveryFailures.length).toBeGreaterThan(0));
      expectGuardedServerDispatches([official]); expect(nativeSeen).toEqual([official]); expect(pinnedSeen).toEqual([]);
      await expect(session.execute({ id: 2, action: "open", url: denied })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(serverSeen).not.toContain(denied);
    } finally { await session.close(); }
  }, 40_000);

  it("does not promote a real redirected destination into authority for a different same-origin document", async () => {
    const landing = "https://sc.cps.golf/public-availability", mismatch = "https://sc.cps.golf/different-unobserved-document";
    respond = url => url === official ? { status: 302, location: landing } : url === landing
      ? { body: `<html><body><h1>Offline Golf Course</h1><script>location.href=${JSON.stringify(mismatch)}</script></body></html>` }
      : { body: html(date) };
    const session = await openDiscovery();
    try {
      await session.execute({ id: 1, action: "open", url: official }).catch(() => {});
      await vi.waitFor(() => expect(discoveryFailures).toContain("UNOBSERVED_NAVIGATION"));
      expect(nativeSeen).toEqual([official, landing]); expectGuardedServerDispatches(nativeSeen);
      expect(serverSeen).not.toContain(mismatch); expect(nativeSeen).not.toContain(mismatch);
    } finally { await session.close(); }
  }, 40_000);

  it.each(["https://127.0.0.1/availability", "https://10.0.0.1/availability", "https://sc.cps.golf/checkout", sessionUrl(copiedToken)])(
    "denies an actual cross-host Location before dispatch when URL or CPS scope is not admitted: %s", async denied => {
      respond = url => url === official ? { status: 302, location: denied } : { body: html(date) };
      const session = await openDiscovery();
      try {
        await session.execute({ id: 1, action: "open", url: official }).catch(() => {});
        await vi.waitFor(() => expect(discoveryFailures.length).toBeGreaterThan(0));
        expect(nativeSeen).toEqual([official]); expectGuardedServerDispatches([official]); expect(pinnedSeen).toEqual([]);
        expect(serverSeen).not.toContain(denied);
      } finally { await session.close(); }
    }, 40_000);

  it("retains the official document and independent public availability after an optional script network failure", async () => {
    const optional = "https://official.example.org/optional.js", availability = `https://official.example.org/availability?date=${date}`;
    respond = url => url === optional ? { networkFailure: true } : url === availability ? { contentType: "application/json", body: JSON.stringify({ date, slots: ["10:00"] }) } :
      { body: `<html><body><h1>Offline Golf Course</h1><script src="${optional}"></script><script>fetch(${JSON.stringify(availability)}).then(r=>r.json()).then(()=>document.title='public data ready');</script></body></html>` };
    const session = await openDiscovery();
    try {
      const opened = await session.execute({ id: 1, action: "open", url: official });
      const observed = await session.execute({ id: 2, action: "observe" });
      const responses = [...opened.responses, ...observed.responses], requests = [...opened.requests, ...observed.requests];
      expect(observed.url).toBe(official); expect(observed.text).toContain("Offline Golf Course");
      expect(responses, JSON.stringify({ opened, observed, serverSeen, nativeSeen, failedRequests, responseEvents })).toContainEqual(expect.objectContaining({ url: availability, status: 200, body: { date, slots: ["10:00"] } }));
      expect(observed.requestFailures).toContainEqual(expect.objectContaining({ reason: "NATIVE_REDIRECT_NETWORK_FAILED", url: optional, resourceType: "script" }));
      expect(requests).toContainEqual(expect.objectContaining({ url: official, status: 200 }));
      expect(requests).toContainEqual(expect.objectContaining({ url: availability, status: 200 }));
      expect(observed.loading).toBe(false); expect(discoveryFailures.every(code => code === "NATIVE_REDIRECT_NETWORK_FAILED")).toBe(true);
    } finally { await session.close(); }
  }, 40_000);

  it("denies an actual cross-host Script→Script redirect without losing the document, availability or provider lanes", async () => {
    const optional = "https://official.example.org/optional.js", destination = "https://sc.cps.golf/denied-cdn.js";
    const availability = `https://official.example.org/availability?date=${date}`;
    let active = 0, maxActive = 0, tail = Promise.resolve();
    const leased: string[] = [], serverLeaseCounts: number[] = [];
    const serializedLease = async <T>(family: string, work: () => Promise<T>) => {
      const prior = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await prior;
      active++; maxActive = Math.max(maxActive, active); leased.push(family);
      try { return { acquired: true as const, value: await work() }; } finally { active--; release(); }
    };
    respond = url => {
      serverLeaseCounts.push(active);
      return url === optional ? { status: 307, location: destination, contentType: "application/javascript" }
        : url === availability ? { contentType: "application/json", body: JSON.stringify({ date, slots: ["10:00"] }) }
          : { body: `<html><body><h1>Offline Golf Course</h1><script src="${optional}"></script><script>fetch(${JSON.stringify(availability)}).then(r=>r.json()).then(()=>document.title='public data ready');</script></body></html>` };
    };
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000),
      venueName: "Offline Golf Course", timeZone: input.timeZone }, { launchBrowser, browserTransport: "NATIVE_CHROME", requestLease: serializedLease,
      onRequestFailure: value => { discoveryFailures.push(value.reason); } });
    try {
      const opened = await session.execute({ id: 1, action: "open", url: official });
      const observed = await session.execute({ id: 2, action: "observe" });
      expect(observed.url).toBe(official); expect(observed.text).toContain("Offline Golf Course"); expect(observed.loading).toBe(false);
      expect([...opened.responses, ...observed.responses]).toContainEqual(expect.objectContaining({ url: availability, status: 200, body: { date, slots: ["10:00"] } }));
      expect([...opened.requests, ...observed.requests]).toContainEqual(expect.objectContaining({ url: official, status: 200, resourceType: "document" }));
      expect(observed.requestFailures).toContainEqual(expect.objectContaining({ reason: "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", url: destination, resourceType: "script" }));
      expect(discoveryFailures).toContain("NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED");
      expect(discoveryFailures.every(code => ["UNSAFE_REDIRECT", "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED"].includes(code))).toBe(true);
      expect(session.diagnostics().nativeFirstFatal).toBeUndefined(); expect(observed.pendingRequestCount).toBe(0);
      expect(nativeSeen).toEqual([official, optional, availability]); expectGuardedServerDispatches(nativeSeen);
      expect(serverSeen).not.toContain(destination); expect(nativeSeen).not.toContain(destination); expect(pinnedSeen).toEqual([]);
      expect(leased).toHaveLength(3); expect(serverLeaseCounts).toEqual([1, 1, 1]); expect(maxActive).toBe(1); expect(active).toBe(0);
      await expect(session.execute({ id: 3, action: "open", url: destination })).rejects.toThrow("UNOBSERVED_NAVIGATION");
      expect(serverSeen).not.toContain(destination);
    } finally { await session.close(); }
  }, 40_000);

  it("propagates an actual root navigation network failure without returning document evidence", async () => {
    respond = () => ({ networkFailure: true });
    const session = await openDiscovery();
    try {
      await expect(session.execute({ id: 1, action: "open", url: official })).rejects.toThrow();
      await vi.waitFor(() => expect(session.diagnostics().requestFailures).toContainEqual(expect.objectContaining({ reason: "NATIVE_REDIRECT_NETWORK_FAILED", resourceType: "document" })));
      expect(session.diagnostics().requests.some(row => row.status !== undefined)).toBe(false);
      expect(serverSeen).toContain(official); expect(discoveryFailures).toContain("NATIVE_REDIRECT_NETWORK_FAILED");
    } finally { await session.close(); }
  }, 40_000);

  it("exposes only the canonical official link, then uses a fresh native session and retains dated response evidence", async () => {
    normalResponses(sessionUrl(firstToken, otherDate));
    const session = await openDiscovery();
    try {
      const opened = await followOfficial(session);
      expect(opened.url, JSON.stringify({ requests: opened.requests, nativeSeen, serverSeen, failedRequests })).toBe(entry);
      expect(opened.text).toContain(date);
      expect(opened.requests).toContainEqual(expect.objectContaining({ url: dated(entry, date), status: 200 }));
      expect(JSON.stringify(opened)).not.toContain(firstToken);
      const next = opened.controls.find(control => control.name === "Next month")!;
      const changed = await session.execute({ id: 3, action: "click", target: next.target });
      expect(changed.text).toContain(otherDate);
      expect(changed.requests).toContainEqual(expect.objectContaining({ url: dated(entry, otherDate), status: 200 }));
      expect(nativeSeen).toContain(sessionUrl(firstToken, otherDate));
      expect(JSON.stringify(changed)).not.toContain(firstToken);
      expect(pinnedSeen).toEqual([]);
    } finally { await session.close(); }
  }, 40_000);

  it.each(["prefetch", "prerender", "link-prefetch"])("prevents speculative %s before dispatch while retaining explicit guarded navigation", async action => {
    const unobserved = "https://official.example.org/checkout";
    const rule = action === "link-prefetch" ? `<link rel="prefetch" href="${unobserved}">`
      : `<script type="speculationrules">${JSON.stringify({ [action]: [{ source: "list", urls: [unobserved], eagerness: "eager" }] })}</script>`;
    normalResponses(); const original = respond;
    respond = (url, context) => {
      const reply = original(url, context);
      return { ...reply, ...(reply.body ? { body: reply.body.replace("</body>", `${rule}</body>`) } : {}) };
    };
    const session = await openDiscovery();
    try {
      const reached = await followOfficial(session);
      expect(reached.text).toContain(date);
      expect(serverSeen).not.toContain(unobserved); expect(nativeSeen).not.toContain(unobserved);
      expect(nativeSeen).toContain(entry); expect(serverSeen).toContain(entry);
      if (action === "link-prefetch") {
        expect(discoveryFailures.length, JSON.stringify({ correlationEvents, requestEvents, responseEvents, nativeSeen, serverSeen, reached })).toBeGreaterThan(0);
        // Native prefetch resource kinds are denied before generic URL routing.
        expect(discoveryFailures.every(reason => reason === "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED"), JSON.stringify(discoveryFailures)).toBe(true);
      } else expect(discoveryFailures).toEqual([]);
    } finally { await session.close(); }
    const replay = await executeAccessRecipe(recipe(), input, { launchBrowser, fetch: pinnedFetch, requestLease: lease,
      now: () => new Date("2026-10-20T12:00:00Z") });
    if (action === "link-prefetch") { expect(replay.complete).toBe(false); expect(replay.status).not.toBe("EMPTY"); }
    else expect(replay).toMatchObject({ complete: true, status: "AVAILABLE" });
    expect(serverSeen).not.toContain(unobserved); expect(nativeSeen).not.toContain(unobserved);
  }, 40_000);

  it.each(["tenant", "course"] as const)("rejects a fresh redirect crossing the admitted %s", async kind => {
    const bad = kind === "tenant" ? sessionUrl(firstToken).replace("OfflineGolfV3", "OtherGolfV3") : sessionUrl(firstToken).replace("CourseId=7", "CourseId=8");
    normalResponses(); const original = respond;
    respond = (url, context) => url === entry ? { status: 302, location: bad } : original(url, context);
    const session = await openDiscovery();
    try {
      await followOfficial(session).catch(() => {});
      expect(discoveryFailures.length).toBeGreaterThan(0);
      expect(nativeSeen).not.toContain(bad);
      expect(serverSeen).not.toContain(bad);
    } finally { await session.close(); }
  }, 40_000);

  it("does not let a second anonymous context borrow the first context's session", async () => {
    const contexts = new Map<BrowserContext, string>();
    respond = (url, context) => {
      if (url === official) return { body: officialBody };
      if (!contexts.has(context)) contexts.set(context, contexts.size === 0 ? firstToken : secondToken);
      const token = contexts.get(context)!;
      return new URL(url).pathname.includes("/(S(") ? { body: html(date, sessionUrl(firstToken, otherDate)) }
        : { status: 302, location: sessionUrl(token) };
    };
    const first = await openDiscovery(), second = await openDiscovery();
    try {
      expect((await followOfficial(first)).text).toContain(date);
      const initialSecond = await followOfficial(second);
      expect(initialSecond.text).toContain(date);
      const count = nativeSeen.filter(url => url === sessionUrl(firstToken, otherDate)).length;
      await second.execute({ id: 3, action: "click", target: initialSecond.controls.find(control => control.name === "Next month")!.target }).catch(() => {});
      expect(discoveryFailures.length).toBeGreaterThan(0);
      expect(nativeSeen.filter(url => url === sessionUrl(firstToken, otherDate))).toHaveLength(count);
    } finally { await first.close(); await second.close(); }
  }, 40_000);

  it("refuses pinned discovery session redirects instead of stripping their transport state", async () => {
    normalResponses();
    const session = await openDiscovery("PINNED_HTTP");
    try {
      await followOfficial(session).catch(() => {});
      const state = await session.execute({ id: 3, action: "observe" });
      expect(state.blockedRequests).toBeGreaterThan(0);
      expect(pinnedSeen[0]).toBe(official);
      // Chrome may retry a refused navigation once; neither attempt may carry
      // copied or fresh session state into the pinned HTTP transport.
      expect(pinnedSeen.length).toBeGreaterThanOrEqual(2);
      expect(pinnedSeen.length).toBeLessThanOrEqual(3);
      expect(pinnedSeen.slice(1).every(url => url === entry)).toBe(true);
      expect(nativeSeen).toEqual([]);
    } finally { await session.close(); }
  }, 40_000);

  it("reads a repeated initial URL independently without borrowing a prior response", async () => {
    normalResponses();
    const session = await openDiscovery();
    try {
      await session.execute({ id: 1, action: "open", url: official });
      const reopened = await session.execute({ id: 2, action: "open", url: official });
      const link = reopened.controls.find(control => control.name === "Book Your Tee Time")!;
      const reached = await session.execute({ id: 3, action: "click", target: link.target });
      expect(reached.text).toContain(date);
      expect(nativeSeen.filter(url => url === official)).toHaveLength(2);
      expect(serverSeen).toContain(sessionUrl(firstToken));
    } finally { await session.close(); }
  }, 40_000);

  it("correlates actual hover prefetch and same-URL anchor navigation independently of provider scheduling", async () => {
    const destination = "https://official.example.org/calendar";
    respond = url => ({ body: url === official
      ? `<html><body><h1>Offline Golf Course</h1><a href="${destination}" onmouseover="fetch(this.href).catch(()=>{})" onclick="return true">Book a Bay</a></body></html>`
      : html(date) });
    const proxy = await nativeBrowser.createNativePublicBrowserProxy({ signal: AbortSignal.timeout(30_000) });
    const browser = await launchBrowser();
    const context = await browser.newContext({ proxy: { server: proxy.server, bypass: "<-loopback>" }, serviceWorkers: "block" });
    const page = await context.newPage();
    const failures: string[] = [];
    const read = async (route: NativeReadRoute) => {
      if (![official, destination].includes(route.request().url()) || route.request().method() !== "GET") { await route.abort(); return; }
      try { await nativeBrowser.continueNativeBrowserRead(route, AbortSignal.timeout(10_000), 2_000_000, undefined, route.request().url()); }
      catch (error) { failures.push(String(error)); await route.abort().catch(() => {}); }
    };
    const routing = await installNativeRedirectRouting(page, read, { onFailure: code => failures.push(code) });
    await context.route("**/*", route => routing.releasePlaywrightRoute(route));
    try {
      await page.goto(official, { waitUntil: "domcontentloaded" });
      await page.getByText("Book a Bay", { exact: true }).click();
      expect(await page.locator("body").innerText(), JSON.stringify({ nativeSeen, serverSeen, failures })).toContain(date);
      expect(nativeSeen.filter(url => url === destination), JSON.stringify({ nativeSeen, serverSeen, failures, requestEvents, responseEvents })).toHaveLength(2);
      expect(serverSeen.filter(url => url === destination), JSON.stringify({ nativeSeen, serverSeen, failures, requestEvents, responseEvents })).toHaveLength(2);
      expect(failures).toEqual([]);
    } finally { await routing.close(); await context.close(); await proxy.close(); }
  }, 40_000);

  it("owns actual simultaneous script and fetch reads by exact Chrome request IDs", async () => {
    const destination = "https://official.example.org/shared.js";
    respond = url => url === official ? { body: `<html><body><h1>Offline Golf Course</h1><script>fetch(${JSON.stringify(destination)}).catch(()=>{})</script><script defer src="${destination}"></script></body></html>` }
      : { body: "globalThis.offlineFixture=true;", contentType: "application/javascript" };
    const proxy = await nativeBrowser.createNativePublicBrowserProxy({ signal: AbortSignal.timeout(30_000) });
    const browser = await launchBrowser();
    const context = await browser.newContext({ proxy: { server: proxy.server, bypass: "<-loopback>" }, serviceWorkers: "block" });
    const page = await context.newPage(), failures: string[] = [], queued: NativeReadRoute[] = [], evidence: object[] = [];
    const completed: Array<{ url: string; kind: string; status: number; body: string }> = [];
    let handled: Promise<void[]> | undefined;
    const read = async (route: NativeReadRoute) => {
      if (![official, destination].includes(route.request().url()) || route.request().method() !== "GET") { await route.abort(); return; }
      try {
        const result = await nativeBrowser.continueNativeBrowserRead(route, AbortSignal.timeout(10_000), 2_000_000, undefined, route.request().url());
        completed.push({ url: route.request().url(), kind: route.request().resourceType(), status: result.status, body: result.body.toString("utf8") });
      }
      catch (error) { failures.push(String(error)); await route.abort().catch(() => {}); }
    };
    const routing = await installNativeRedirectRouting(page, async route => {
      if (route.request().url() !== destination) { await read(route); return; }
      queued.push(route);
      evidence.push({ event: "CHROME_ROUTE", kind: route.request().resourceType(), headers: route.request().headers() });
      if (queued.length === 2 && !handled) { handled = Promise.all(queued.map(read)); await handled; }
    }, { onFailure: code => failures.push(code) });
    await context.route("**/*", route => routing.releasePlaywrightRoute(route));
    try {
      await page.goto(official, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await handled;
      await vi.waitFor(() => expect(serverSeen.filter(url => url === destination), JSON.stringify({ evidence, completed, failures, nativeSeen, serverSeen })).toHaveLength(2));
      expect(queued.map(route => route.request().resourceType()).sort()).toEqual(["script", "xhr"]);
      expect(nativeSeen.filter(url => url === destination)).toHaveLength(2);
      const completedReads = completed.filter(row => row.url === destination);
      expect(completedReads).toHaveLength(2);
      expect(completedReads.every(row => row.status === 200 && row.body === "globalThis.offlineFixture=true;")).toBe(true);
      expect(completedReads.filter(row => row.kind === "script")).toHaveLength(1);
      expect(completedReads.filter(row => ["xhr", "fetch"].includes(row.kind))).toHaveLength(1);
      expect(failures, JSON.stringify({ correlationEvents, evidence, completed, nativeSeen, serverSeen, requestEvents, responseEvents })).toEqual([]);
    } finally { await routing.close(); await context.close(); await proxy.close(); }
  }, 40_000);

  it.each([false, true])("captures two deferred-consumption %s reads under one provider lease without mixing exact bodies", async post => {
    const destination = "https://official.example.org/availability", dates = [date, otherDate];
    const calls = dates.map(value => `fetch(${JSON.stringify(destination)}${post ? `,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:${JSON.stringify(value)}})}` : ""})`);
    // This valid consumer waits for both responses before reading either body.
    // Network.loadingFinished cannot be used to serialize these provider reads.
    respond = url => url === official ? { body: `<html><body><script>Promise.all([${calls.join(",")}]).then(x=>Promise.all(x.map(r=>r.text()))).then(x=>document.title=x.join('|'));</script></body></html>` }
      : { body: "actual public body", echoRequestBody: post, contentType: post ? "application/json" : "text/plain" };
    let tail = Promise.resolve(), active = 0, maxActive = 0, batch: Promise<void[]> | undefined;
    const queued: NativeReadRoute[] = [], completed: Array<{ requestBody: string | null; responseBody: string; status: number }> = [];
    const read = async (route: NativeReadRoute) => {
      const request = route.request();
      if (![official, destination].includes(request.url()) || request.method() !== (request.url() === destination && post ? "POST" : "GET")) { await route.abort(); return; }
      if (post && request.url() === destination) expect(dates).toContain(JSON.parse(request.postData()!).date);
      const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
      active++; maxActive = Math.max(maxActive, active);
      try {
        const result = await nativeBrowser.continueNativeBrowserRead(route, AbortSignal.timeout(10_000), 2_000_000, undefined, request.url());
        if (request.url() === destination) completed.push({ requestBody: request.postData(), responseBody: result.body.toString(), status: result.status });
      } finally { active--; release(); }
    };
    const owner = await nativeOwner(async route => {
      if (route.request().url() !== destination) { await read(route); return; }
      queued.push(route);
      if (queued.length === 2 && !batch) { batch = Promise.all(queued.map(read)); await batch; }
    });
    try {
      await owner.page.goto(official, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await owner.page.waitForFunction(() => document.title.includes("|"), undefined, { timeout: 10_000 });
      await batch;
      expect(queued).toHaveLength(2); expect(maxActive).toBe(1); expect(completed).toHaveLength(2);
      expect(completed.every(value => value.status === 200 && value.responseBody === (post ? value.requestBody : "actual public body"))).toBe(true);
      expect(serverSeen.filter(url => url === destination)).toHaveLength(2); expect(nativeSeen.filter(url => url === destination)).toHaveLength(2);
      expect(owner.failures).toEqual([]); await vi.waitFor(() => expect(owner.routing.pendingReads).toBe(0));
    } finally { await owner.close(); }
  }, 40_000);

  it("keeps initial and redirect response bodies serialized by one provider lease", async () => {
    normalResponses(); let tail = Promise.resolve(), active = 0, maxActive = 0;
    const serializedLease = async <T>(_family: string, work: () => Promise<T>) => {
      const previous = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; }); await previous;
      active++; maxActive = Math.max(maxActive, active);
      try { return { acquired: true as const, value: await work() }; } finally { active--; release(); }
    };
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [official], deadlineAt: new Date(Date.now() + 30_000), venueName: "Offline Golf Course", timeZone: input.timeZone },
      { launchBrowser, browserTransport: "NATIVE_CHROME", requestLease: serializedLease });
    try {
      expect((await followOfficial(session)).text).toContain(date); expect(maxActive).toBe(1);
      expect(serverSeen).toContain(entry); expect(serverSeen).toContain(sessionUrl(firstToken));
    } finally { await session.close(); }
  }, 40_000);

  it("denies a later same-host transaction even when its native tunnel was already used", async () => {
    const denied = "https://official.example.org/checkout";
    respond = () => ({ body: `<html><body><script>fetch(${JSON.stringify(denied)}).catch(()=>document.title='denied');</script></body></html>` });
    const owner = await nativeOwner(async route => {
      if (route.request().url() !== official) { await route.abort(); return; }
      await nativeBrowser.continueNativeBrowserRead(route, AbortSignal.timeout(10_000), 2_000_000, undefined, official);
    });
    try {
      await owner.page.goto(official, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await owner.page.waitForFunction(() => document.title === "denied", undefined, { timeout: 10_000 });
      expect(serverSeen).toContain(official); expect(nativeSeen).toContain(official);
      expect(serverSeen).not.toContain(denied); expect(nativeSeen).not.toContain(denied); expect(owner.failures).toEqual([]);
    } finally { await owner.close(); }
  }, 40_000);

  it("ignores local data and blob image metadata without treating it as availability evidence", async () => {
    normalResponses(); const original = respond;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>';
    respond = (url, context) => url === official ? { body: officialBody.replace('</body>',
      `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}">` +
      `<script>const image=new Image();image.src=URL.createObjectURL(new Blob([${JSON.stringify(svg)}],{type:'image/svg+xml'}));document.body.append(image);</script></body>`) }
      : original(url, context);
    const session = await openDiscovery();
    try {
      const opened = await followOfficial(session);
      expect(opened.text).toContain(date);
      expect(opened.requests.some(value => /^(?:data|blob):/u.test(value.url))).toBe(false);
      expect(nativeSeen).toContain(sessionUrl(firstToken));
    } finally { await session.close(); }
  }, 40_000);

  it.each(["https://official.example.org/frame", "https://frame.example.org/frame"])("denies iframe first/redirect URLs while retaining main content %s", async frameUrl => {
    const redirected = `${frameUrl}-redirected`;
    respond = url => url === frameUrl ? { status: 302, location: redirected }
      : { body: `<html><body><h1>Public golf</h1><iframe src="${frameUrl}"></iframe></body></html>` };
    const session = await openDiscovery();
    try {
      const snapshot = await session.execute({ id: 1, action: "open", url: official });
      expect(snapshot.text).toContain("Public golf");
      expect(snapshot.capabilityDiagnostics).toContainEqual(expect.objectContaining({ code: "SUBFRAME_UNSUPPORTED", resourceType: "document" }));
      expect(nativeSeen).not.toContain(frameUrl);
      expect(serverSeen).not.toContain(frameUrl);
      expect(nativeSeen).not.toContain(redirected);
      expect(serverSeen).not.toContain(redirected);
      expect(snapshot.requestFailures).toEqual([]);
      await expect(session.execute({ id: 2, action: "open", url: frameUrl })).rejects.toThrow("UNOBSERVED_NAVIGATION");
    } finally { await session.close(); }
  }, 40_000);

  it.each([false, true])("keeps main-frame completeness independent of denied subframes (wrong date: %s)", async wrongDate => {
    const frame = "https://frame.example.org/availability", redirected = `${frame}-redirected`;
    respond = url => url === frame ? { status: 302, location: redirected }
      : new URL(url).pathname.includes("/(S(") ? { body: html(wrongDate ? otherDate : date).replace("</body>", `<iframe src="${frame}"></iframe></body>`) }
      : { status: 302, location: sessionUrl(firstToken) };
    const result = await executeAccessRecipe(recipe(), input, { launchBrowser, fetch: pinnedFetch, requestLease: lease,
      now: () => new Date("2026-10-20T12:00:00Z") });
    if (wrongDate) {
      expect(result.complete).toBe(false); expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
    } else expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true, completeVerified: true } });
    expect(serverSeen).not.toContain(frame); expect(serverSeen).not.toContain(redirected);
    expect(nativeSeen).not.toContain(frame); expect(nativeSeen).not.toContain(redirected);
  }, 40_000);

  it("replays independently with fresh sessions and verifies each actual requested date", async () => {
    const contexts = new Map<BrowserContext, string>();
    respond = (url, context) => {
      if (!contexts.has(context)) contexts.set(context, contexts.size === 0 ? firstToken : secondToken);
      const requestedDate = new URL(url).searchParams.get("Date")!;
      return new URL(url).pathname.includes("/(S(") ? { body: html(requestedDate) }
        : { status: 302, location: sessionUrl(contexts.get(context)!, requestedDate) };
    };
    for (const requestedDate of [date, otherDate]) {
      const result = await executeAccessRecipe(recipe(), { ...input, date: requestedDate }, { launchBrowser, fetch: pinnedFetch, requestLease: lease,
        now: () => new Date("2026-10-20T12:00:00Z") });
      expect(result, JSON.stringify({ result, nativeSeen, serverSeen, failedRequests })).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true, venueVerified: true, completeVerified: true } });
      expect(result.slots[0].startsAt).toBe(`${requestedDate}T13:00:00.000Z`);
      expect(JSON.stringify(result)).not.toMatch(/\(S\(|new123|new456/u);
    }
    expect(contexts.size).toBe(2);
    expect(nativeSeen).toContain(sessionUrl(firstToken, date));
    expect(nativeSeen).toContain(sessionUrl(secondToken, otherDate));
    expect(pinnedSeen).toEqual([]);
  }, 40_000);

  it.each(["tenant", "course", "session", "pinned", "wrong-date"] as const)("keeps invalid %s execution incomplete", async kind => {
    const bad = kind === "tenant" ? sessionUrl(firstToken).replace("OfflineGolfV3", "OtherGolfV3")
      : kind === "course" ? sessionUrl(firstToken).replace("CourseId=7", "CourseId=8") : sessionUrl(firstToken);
    respond = url => new URL(url).pathname.includes("/(S(") ? { body: html(kind === "wrong-date" ? otherDate : date) }
      : kind === "session" ? { body: html(date) + `<script>location.href=${JSON.stringify(bad)}</script>` } : { status: 302, location: bad };
    const result = await executeAccessRecipe(recipe(kind === "pinned" ? "PINNED_HTTP" : "NATIVE_CHROME"), input,
      { launchBrowser, fetch: pinnedFetch, requestLease: lease, now: () => new Date("2026-10-20T12:00:00Z") });
    expect(result.complete).toBe(false);
    expect(result.slots).toEqual([]);
    expect(result.status).not.toBe("EMPTY");
    expect(result.status).not.toBe("ACCESS_REQUIRED");
    expect(JSON.stringify(result)).not.toMatch(/\(S\(|new123|new456/u);
    if (kind !== "wrong-date") {
      expect(nativeSeen).not.toContain(bad);
      expect(serverSeen).not.toContain(bad);
    }
    if (kind === "pinned") expect(pinnedSeen).toEqual([dated(entry, date)]);
  }, 40_000);

});
