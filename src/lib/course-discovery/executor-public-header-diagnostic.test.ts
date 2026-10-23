// @vitest-environment node
// Caller-only regression with isolated Chrome and in-memory replies. Native
// identity, ACK and public-literal witnesses are synthetic private seams here;
// native protocol ownership/liveness is covered by its separate protocol tests.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { accessExecutionDiagnosticSchema, parseAccessRecipe } from "./recipe";
import { publicHeaderFailureDiagnosticSchema } from "./public-header-diagnostic";
import type { PublicClientReadHeaderProof } from "./public-client-read-headers";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = "https://public-header-diagnostic.example.org", entry = origin + "/tee-times", data = origin + "/availability?date=2026-10-23";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
type Mode = "MISSING" | "REVOKED_BEFORE_QUEUE" | "REVOKED_AFTER_QUEUE";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const recipe = (terminalWait: boolean) => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
  target: { courseId: "public-header-diagnostic-fixture", kind: "OUTDOOR" },
  source: { officialUrl: origin + "/", bookingUrl: entry, venueName: "Public Example Golf", providerFamily: "UNVERIFIED", timeZone: input.timeZone },
  pageUrl: entry, steps: terminalWait ? [{ action: "waitFor", selector: "#never-arrives" }] : [],
  permittedRoutes: [{ origin, path: "/tee-times", methods: ["GET"], queryKeys: [] }, { origin, path: "/availability", methods: ["GET"], queryKeys: ["date"] }],
  availabilityResponse: { url: origin + "/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "code", equals: 200 } },
  proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, players: { selector: "#players", attribute: "value" },
    complete: { availabilityResponse: true }, empty: { selector: "#empty" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
});

function fixture(mode: Mode) {
  const held = deferred(), release = deferred(), issued: PublicClientReadHeaderProof[] = [], reads: string[] = [];
  let pending = 0, live = mode !== "REVOKED_BEFORE_QUEUE", leases = 0, active = 0;
  const html = `<html><body><h1 id="venue">Public Example Golf</h1><input id="date" value="2026-10-23"><input id="players" value="2">
    <div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>
    <script>fetch('/availability?date=2026-10-23',{headers:{Authorization:'Bearer null','x-api-key':'private-fixture-key-sentinel'}}).catch(()=>{});</script></body></html>`;
  vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
    allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
  vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request => {
    if (mode === "MISSING" || request.url() !== data) return null;
    const proof = Object.freeze({}) as PublicClientReadHeaderProof; issued.push(proof);return proof;
  });
  const current = vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(proof => live && issued.includes(proof));
  vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockImplementation((_request, proof) =>
    nativeRouting.isCurrentPublicClientReadHeaders(proof) ? "GET" : null);
  const firstFailure = vi.spyOn(nativeRouting, "publicClientReadHeaderProofFailure").mockImplementation(proof => issued.includes(proof) && !live ? {
    reason: "NATIVE_RECORD_NOT_CURRENT", nativeDocumentCurrent: true, nativeSourceFailed: true,
    nativeSourceFetchRecordPresent: false, nativeSourceLoadingFailedCanceledPresent: true, nativeSourceLoadingFailedCanceled: true,
    nativeSourceLoadingFailedErrorKind: "ABORTED", nativeSourceLoadingFailedCorsErrorPresent: false,
    headers: "private-header-sentinel", digest: "private-digest-sentinel", errorText: "private-error-sentinel",
  } as never : null);
  vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
    prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try {
        const raw = route.request();let denied = false;
        const isData = raw.url() === data;
        // A separately linked OPTIONS adapter exercises the actual caller's
        // sensitive-header fallback. It is not a Chrome preflight wire claim.
        const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => isData ? "OPTIONS" : raw.method(),
          headers: () => isData ? { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,x-api-key" } : raw.headers(),
          postData: () => null, resourceType: () => isData ? "xhr" : raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(),
          frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() };
        const wrapped: nativeRouting.NativeReadRoute = { request: () => request, continue: options => route.continue(options),
          abort: async () => { denied = true; }, fulfill: options => route.fulfill(options) };
        await handler(wrapped);
        if (isData && denied) await route.abort();
        else if (isData) throw new Error("DENIED_FIXTURE_PREFLIGHT_UNEXPECTEDLY_PASSED");
      } finally { pending--; }
    },
  }));
  vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
    const request = route.request();
    if (request.url() !== entry || request.method() !== "GET") { await route.abort();throw new Error("UNEXPECTED_FIXTURE_DISPATCH"); }
    reads.push(request.url());const body = Buffer.from(html), headers = { "content-type": "text/html" };
    await route.fulfill({ status: 200, headers, body });return { url: entry, status: 200, headers, body };
  });
  const requestLease = async <T,>(_family: string, work: () => Promise<T>) => {
    leases++;active++;
    try { if (mode === "REVOKED_AFTER_QUEUE" && leases === 2) { held.resolve();await release.promise; } return { acquired: true as const, value: await work() }; }
    finally { active--; }
  };
  const revoke = async () => {
    if (mode !== "REVOKED_AFTER_QUEUE") return;
    await Promise.race([held.promise, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(Error("FIXTURE_QUEUE_NOT_REACHED")), 5_000);timer.unref(); })]);
    expect(issued).toHaveLength(1);live = false;release.resolve();
  };
  return { requestLease, revoke, release, current, firstFailure,
    assert: () => { expect(reads).toEqual([entry]);expect(active).toBe(0);expect(pending).toBe(0);expect(leases).toBe(mode === "REVOKED_AFTER_QUEUE" ? 2 : 1); } };
}

describe.runIf(existsSync(chrome))("executor public-header denial diagnostic preservation", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each<Mode>(["MISSING", "REVOKED_BEFORE_QUEUE", "REVOKED_AFTER_QUEUE"])("keeps current-document closed facts and existing outcome for %s", async mode => {
    const f = fixture(mode), fetcher = vi.fn(async () => { throw Error("PINNED_FETCH_MUST_NOT_RUN"); });
    try {
      const execution = executeAccessRecipe(recipe(mode === "REVOKED_AFTER_QUEUE"), input, {
        now: () => new Date("2026-10-20T12:00:00Z"), requestLease: f.requestLease, fetch: fetcher,
        launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
      });
      await f.revoke();const result = await execution;f.assert();expect(result.slots).toEqual([]);expect(result.complete).toBe(false);expect(fetcher).not.toHaveBeenCalled();
      const diagnostic = result.evidence?.diagnostic;expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
      const requestFailure = mode === "REVOKED_AFTER_QUEUE" ? diagnostic?.earlierRequestFailure : diagnostic;
      expect(requestFailure).toMatchObject({ code: "UNSCOPED_REQUEST", method: "OPTIONS", resourceType: "xhr", url: origin + "/availability" });
      expect(requestFailure?.publicHeaderDiagnostic).toMatchObject({ stage: mode === "REVOKED_AFTER_QUEUE" ? "HEADER_PROOF_REVOKED_AFTER_QUEUE" : "HEADER_PROOF_MISSING",
        requestedPreflightMethod: "GET", ordinaryPreflightMethod: null, requestedAuthorization: true, requestedApiKey: true, requestedUnknownHeader: false });
      expect(publicHeaderFailureDiagnosticSchema.safeParse(requestFailure?.publicHeaderDiagnostic).success).toBe(true);
      if (mode === "MISSING") { expect(requestFailure?.publicHeaderDiagnostic?.privateProofFailureReason).toBe("UNOBSERVED");expect(f.firstFailure).not.toHaveBeenCalled(); }
      else { expect(requestFailure?.publicHeaderDiagnostic).toMatchObject({ privateProofFailureReason: "NATIVE_RECORD_NOT_CURRENT", nativeDocumentCurrent: true,
        nativeSourceFailed: true, nativeSourceFetchRecordPresent: false, nativeSourceLoadingFailedCanceled: true, nativeSourceLoadingFailedErrorKind: "ABORTED" });
        expect(f.firstFailure).toHaveBeenCalledOnce();expect(f.current).toHaveBeenCalled(); }
      if (mode === "REVOKED_AFTER_QUEUE") expect(result).toMatchObject({ status: "FAILED", evidence: { diagnostic: { code: "STEP_TIMEOUT", stepIndex: 0, requestState: { pendingReads: 0, currentDocumentPendingHandlers: 0 } } } });
      else expect(result).toMatchObject({ status: "INCOMPLETE", evidence: { diagnostic: { code: "UNSCOPED_REQUEST" } } });
      for (const value of ["private-fixture-key-sentinel", "private-header-sentinel", "private-digest-sentinel", "private-error-sentinel"])
        expect(JSON.stringify(result)).not.toContain(value);
    } finally { f.release.resolve(); }
  }, 20_000);
});
