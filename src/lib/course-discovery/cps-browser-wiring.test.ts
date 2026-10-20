// @vitest-environment node
// Offline wiring tests: real isolated Chrome request/redirect objects, with all
// responses supplied by a loopback-only TLS fixture (or injected pinned read).
// No provider, database, or model is contacted.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserContext } from "@playwright/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import * as nativeBrowser from "./native-public-browser";
import { parseAccessRecipe } from "./recipe";

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
  let discoveryFailures: string[];
  let server: Server;
  let respond: (url: string, context: BrowserContext) => { status?: number; location?: string; body?: string };
  beforeEach(async () => {
    browsers = []; nativeSeen = []; serverSeen = []; pinnedSeen = []; failedRequests = [];
    responseEvents = []; requestEvents = [];
    discoveryFailures = [];
    const start = Date.now(), push = responseEvents.push.bind(responseEvents);
    responseEvents.push = (...values) => push(...values.map(value => `${Date.now() - start}ms ${value}`));
    respond = url => ({ body: html(new URL(url).searchParams.get("Date") ?? date) });
    const requestContexts = new Map<string, BrowserContext[]>(), redirectedContexts = new Map<string, BrowserContext>();
    server = createServer({ cert: fixtureCertificate, key: fixtureKey }, (request, response) => {
      const url = `https://${request.headers.host}${request.url}`;
      serverSeen.push(url);
      const context = requestContexts.get(url)?.shift() ?? redirectedContexts.get(url);
      if (!context || !["official.example.org", "sc.cps.golf"].includes(request.headers.host ?? "")) {
        response.writeHead(500); response.end("Unbound offline request"); return;
      }
      const reply = respond(url, context);
      if (reply.location) redirectedContexts.set(reply.location, context);
      response.writeHead(reply.status ?? 200, { "content-type": "text/html", ...(reply.location ? { location: reply.location } : {}) });
      response.end(reply.body ?? "");
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
    const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--ignore-certificate-errors"] });
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation(async options => {
      const context = await newContext({ ...options, ignoreHTTPSErrors: true });
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

  it("binds a repeated initial URL to its new request instead of historical records", async () => {
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

  it.each(["https://official.example.org/frame", "https://frame.example.org/frame"])("fails closed before unguarded iframe transport %s", async frameUrl => {
    respond = () => ({ body: `<html><body><h1>Public golf</h1><iframe src="${frameUrl}"></iframe></body></html>` });
    const session = await openDiscovery();
    try {
      await session.execute({ id: 1, action: "open", url: official }).catch(() => {});
      expect(nativeSeen).not.toContain(frameUrl);
      expect(serverSeen).not.toContain(frameUrl);
    } finally { await session.close(); }
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
