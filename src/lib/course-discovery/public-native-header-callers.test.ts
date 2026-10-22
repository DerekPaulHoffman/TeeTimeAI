// @vitest-environment node
// Synthetic caller-policy fixture with real isolated Chrome and in-memory
// replies. Native identity/ACK/public-literal proofs are mocked here; actual
// protocol correlation is covered separately by native-redirect-routing tests.
import { existsSync } from "node:fs";
import { chromium, type Browser } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import type { PublicClientReadHeaderProof } from "./public-client-read-headers";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://public-calendar.example.org", entry = origin + "/tee-times";
const dataUrl = origin + "/availability?date=2026-10-23";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
type Mode = "proof" | "missing proof" | "revoked in queue" | "unscoped recipe" | "linked OPTIONS";
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function recipe(unscoped: boolean) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "header-caller-fixture", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: entry, venueName: "Public Example Golf", providerFamily: "UNVERIFIED", timeZone: input.timeZone },
    pageUrl: entry, steps: [], permittedRoutes: [{ origin, path: "/tee-times", methods: ["GET"], queryKeys: [] },
      { origin, path: unscoped ? "/other-read" : "/availability", methods: ["GET"], queryKeys: ["date"] }],
    availabilityResponse: { url: origin + "/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" },
      success: { path: "code", equals: 200 } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" },
      players: { selector: "#players", attribute: "value" }, complete: { availabilityResponse: true }, empty: { selector: "#empty" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" },
      availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
  });
}

function fixture(mode: Mode) {
  const held = deferred(), release = deferred(), proofs = new WeakMap<object, PublicClientReadHeaderProof>();
  const linked = new WeakSet<object>(), issued: PublicClientReadHeaderProof[] = [], reads: string[] = [];
  const proofRequests: nativeRouting.NativeReadRequest[] = [];
  let pending = 0, live = true, leases = 0, active = 0, maximum = 0;
  const html = `<html><body><h1 id="venue">Public Example Golf</h1><input id="date" value="2026-10-23"><input id="players" value="2">
    <div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>
    <script>fetch('/availability?date=2026-10-23',{headers:{Authorization:'Bearer null','x-api-key':'public-display-literal'}})
      .catch(()=>{}).finally(()=>{window.fixtureDone=true;});</script></body></html>`;
  vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9",
    close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {},
    stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
  const authorize = vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request => {
    proofRequests.push(request);
    if (mode === "missing proof" || request.url() !== dataUrl) return null;
    const proof = Object.freeze({}) as PublicClientReadHeaderProof;
    proofs.set(request, proof); issued.push(proof); return proof;
  });
  const current = vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(proof => live && issued.includes(proof));
  const preflight = vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockImplementation((request, proof) =>
    linked.has(request) && proofs.get(request) === proof && live ? "GET" : null);
  vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
    prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try {
        const raw = route.request(), headers = await raw.allHeaders();
        const wrap = (method: string, actualHeaders: Record<string, string>, kind: string): nativeRouting.NativeReadRoute => {
          const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => method, headers: () => ({ ...actualHeaders }),
            postData: () => null, resourceType: () => kind, isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(),
            redirectedFrom: () => null, response: () => raw.response() };
          return { request: () => request, continue: options => route.continue(options), abort: code => route.abort(code),
            fulfill: options => route.fulfill(options) };
        };
        const actual = wrap(raw.method(), headers, raw.resourceType());
        if (mode === "linked OPTIONS" && raw.url() === dataUrl) {
          // A synthetic separately correlated pause exercises caller fallback;
          // this is not an actual browser CORS/preflight wire experiment.
          const options = wrap("OPTIONS", { origin, "access-control-request-method": "GET",
            "access-control-request-headers": "authorization,x-api-key" }, "other");
          linked.add(options.request()); await handler(options);
        }
        await handler(actual);
      } finally { pending--; }
    },
  }));
  vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
    const request = route.request(), value = new URL(request.url());
    if (value.origin !== origin || !["/tee-times", "/availability"].includes(value.pathname)) {
      await route.abort(); throw new Error("UNEXPECTED_FIXTURE_DISPATCH");
    }
    reads.push(`${request.method()} ${request.url()}`);
    if (request.method() === "OPTIONS") return { url: request.url(), status: 204, headers: {}, body: Buffer.alloc(0) };
    const body = Buffer.from(value.pathname === "/tee-times" ? html : '{"code":200}');
    const responseHeaders = { "content-type": value.pathname === "/tee-times" ? "text/html" : "application/json" };
    await route.fulfill({ status: 200, headers: responseHeaders, body });
    return { url: request.url(), status: 200, headers: responseHeaders, body };
  });
  const requestLease = async <T,>(_family: string, work: () => Promise<T>) => {
    leases++; active++; maximum = Math.max(maximum, active);
    try {
      if (mode === "revoked in queue" && leases === 2) { held.resolve(); await release.promise; }
      return { acquired: true as const, value: await work() };
    } finally { active--; }
  };
  const revokeQueued = async () => {
    if (mode !== "revoked in queue") return;
    await Promise.race([held.promise, new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("FIXTURE_LEASE_NOT_REACHED")), 5_000); timer.unref();
    })]);
    expect(issued).toHaveLength(1);
    expect(reads.filter(value => value.endsWith(dataUrl))).toEqual([]);
    live = false; release.resolve();
  };
  const assert = () => {
    expect(reads.filter(value => value === `GET ${entry}`)).toHaveLength(1);
    const successful = mode === "proof" || mode === "linked OPTIONS";
    expect(reads.filter(value => value === `GET ${dataUrl}`)).toHaveLength(successful ? 1 : 0);
    expect(authorize).toHaveBeenCalled();
    if (mode !== "missing proof") expect(proofRequests.every(value => proofs.has(value))).toBe(true);
    if (successful || mode === "revoked in queue") expect(current).toHaveBeenCalledWith(issued[0]);
    if (mode === "linked OPTIONS") {
      expect(reads.filter(value => value === `OPTIONS ${dataUrl}`)).toHaveLength(1);
      expect(preflight).toHaveBeenCalledWith(proofRequests[0], issued[0]);
    }
    expect(active).toBe(0); expect(maximum).toBe(1); expect(pending).toBe(0);
  };
  return { requestLease, revokeQueued, release, assert };
}

describe.runIf(existsSync(chrome))("synthetic native public-header caller policy with isolated Chrome", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["proof", "missing proof", "revoked in queue", "linked OPTIONS"])("discovery consumes only an exact live private proof: %s", async mode => {
    const f = fixture(mode), fetcher = vi.fn(async () => { throw new Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
    let browser: Browser | undefined;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], venueOfficialUrl: entry,
      deadlineAt: new Date(Date.now() + 15_000), timeZone: input.timeZone, venueName: "Public Example Golf" }, {
      browserTransport: "NATIVE_CHROME", fetch: fetcher, requestLease: f.requestLease,
      launchBrowser: async () => browser = await chromium.launch({ executablePath: chrome, headless: true }),
    });
    try {
      const opening = session.execute({ id: 1, action: "open", url: entry });
      await f.revokeQueued(); const initial = await opening;
      await browser!.contexts()[0].pages()[0].waitForFunction(() => Boolean((window as Window & { fixtureDone?: boolean }).fixtureDone));
      const snapshot = await session.execute({ id: 2, action: "observe" }); f.assert();
      const denied = [...initial.requests, ...snapshot.requests].filter(row => row.url === dataUrl && row.blockedReason);
      if (mode === "missing proof" || mode === "revoked in queue") expect(denied).toContainEqual(expect.objectContaining({ blockedReason: "CREDENTIAL_HEADERS" }));
      else expect(denied).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
      expect(JSON.stringify([initial, snapshot])).not.toContain("public-display-literal");
    } finally { f.release.resolve(); await session.close(); }
  }, 20_000);

  it.each<Mode>(["proof", "missing proof", "revoked in queue", "unscoped recipe", "linked OPTIONS"])(
    "fixed replay also requires the saved route and live proof: %s", async mode => {
      const f = fixture(mode), fetcher = vi.fn(async () => { throw new Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
      try {
        const execution = executeAccessRecipe(recipe(mode === "unscoped recipe"), input, {
          now: () => new Date("2026-10-20T12:00:00Z"), requestLease: f.requestLease, fetch: fetcher,
          launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
        });
        await f.revokeQueued(); const result = await execution; f.assert();
        if (mode === "proof" || mode === "linked OPTIONS") {
          expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { completeVerified: true, venueVerified: true, dateVerified: true } });
          expect(result.slots).toHaveLength(1);
        } else expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
        expect(fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain("public-display-literal");
      } finally { f.release.resolve(); }
    }, 20_000);
});
