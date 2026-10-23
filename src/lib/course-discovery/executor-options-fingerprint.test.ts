// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, recipeExecutionDiagnostic } from "./executor";
import { accessExecutionDiagnosticSchema, parseAccessRecipe } from "./recipe";
import { publicHeaderFailureDiagnosticSchema } from "./public-header-diagnostic";
import { readDiscoveryControllerCheckpoint } from "../../../scripts/automation/course-discovery-worker.mjs";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const apiOrigin = "https://api.membersports.com", hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const apiOriginHash = "07d5b602615adc5f5bfe294da649ad8ea2bc56435231b8f0778cd4aeb73a667e";
const pathname = "/api/v1/account/PRIVATE_PATH_SENTINEL", url = apiOrigin + pathname + "?token=PRIVATE_QUERY_SENTINEL#PRIVATE_FRAGMENT_SENTINEL";
const fingerprint = { originSha256: apiOriginHash, pathnameSha256: hash(pathname) };
function restore(diagnostic: unknown) {
  return readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://venue.example.org/", observedNavigationUrls: [],
    lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "UNSCOPED_REQUEST", diagnostic } } } }, "https://venue.example.org/")?.lastFailure?.details?.diagnostic;
}
describe("bounded MemberSports OPTIONS failure fingerprints", () => {
  it.each(["xhr", "fetch"])("hashes only origin/path for omitted-URL OPTIONS %s without admitting the request", resourceType => {
    expect(hash(apiOrigin)).toBe(apiOriginHash);
    const diagnostic = recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url, method: "OPTIONS", resourceType });
    expect(diagnostic).toEqual({ code: "UNSCOPED_REQUEST", method: "OPTIONS", resourceType, requestUrlFingerprint: fingerprint });
    expect(recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url: url.replace("PRIVATE_QUERY_SENTINEL", "DIFFERENT_QUERY").replace("PRIVATE_FRAGMENT_SENTINEL", "DIFFERENT_FRAGMENT"), method: "OPTIONS", resourceType })).toEqual(diagnostic);
    expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", earlierRequestFailure: diagnostic }).success).toBe(true);
    const restored = restore({ ...diagnostic, earlierRequestFailure: diagnostic });
    expect(restored).toEqual({ ...diagnostic, earlierRequestFailure: diagnostic });
    expect(JSON.stringify(restored)).not.toMatch(/PRIVATE_|account|membersports|token|rawPath|headers|fragment/u);
  });
  it.each([
    { method: "GET" }, { method: "HEAD" }, { method: "POST" }, { resourceType: "document" }, { resourceType: "image" },
    { resourceType: "script" }, { resourceType: "stylesheet" }, { resourceType: "other" },
    { url: url.replace("api.membersports.com", "other.example.org") }, { url: url.replace("api.membersports.com", "api.membersports.com.evil.example") },
    { url: url.replace("https:", "http:") }, { url: url.replace("api.membersports.com", "u:p@api.membersports.com") },
    { url: url.replace("api.membersports.com", "api.membersports.com:444") }, { url: "not a URL" }, { url: url + "x".repeat(2048) },
    { url: apiOrigin + "/api/v1/golfClubs/golfCourseImage/15654" },
  ])("does not add the new producer context outside its exact bounds (%j)", change => {
    expect(recipeExecutionDiagnostic("UNSCOPED_REQUEST", { url, method: "OPTIONS", resourceType: "xhr", ...change })).not.toHaveProperty("requestUrlFingerprint");
  });
  it.each([
    { method: "GET" }, { method: "HEAD" }, { method: "POST" }, { resourceType: "document" }, { resourceType: "other" },
    { url: "https://venue.example.org/public" }, { requestUrlFingerprint: { ...fingerprint, originSha256: hash("https://other.example.org") } },
    { requestUrlFingerprint: { ...fingerprint, originSha256: "A".repeat(64) } }, { requestUrlFingerprint: { originSha256: apiOriginHash } },
    { requestUrlFingerprint: { ...fingerprint, pathnameSha256: "x".repeat(64) } }, { requestUrlFingerprint: { ...fingerprint, rawPath: "PRIVATE_SENTINEL" } },
    { requestUrlFingerprint: Object.create(fingerprint) },
  ])("schema and durable worker reject counterfeits for primary/earlier fingerprints (%j)", change => {
    const diagnostic = { code: "UNSCOPED_REQUEST", method: "OPTIONS", resourceType: "xhr", requestUrlFingerprint: fingerprint, ...change };
    expect(accessExecutionDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "STEP_TIMEOUT", earlierRequestFailure: diagnostic }).success).toBe(false);
    const restored = restore({ ...diagnostic, earlierRequestFailure: diagnostic });
    expect(restored).not.toHaveProperty("requestUrlFingerprint"); expect(restored.earlierRequestFailure).not.toHaveProperty("requestUrlFingerprint");
    expect(restored.code).toBe("UNSCOPED_REQUEST"); expect(JSON.stringify(restored)).not.toContain("PRIVATE_SENTINEL");
  });
});

const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe.runIf(existsSync(chrome))("owned denied OPTIONS caller fingerprint", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps actual header-denial stage with opaque unknown path and zero target dispatch", async () => {
    // Synthetic native adapter/OPTIONS, real isolated Chrome and in-memory
    // replies only. This proves no new caller permission or request admission.
    const origin = "https://options-diagnostic.example.org", entry = origin + "/tee-times", target = apiOrigin + pathname;
    const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME", target: { courseId: "options-fingerprint-fixture", kind: "OUTDOOR" },
      source: { officialUrl: origin + "/", bookingUrl: entry, venueName: "Public Example Golf", providerFamily: "UNVERIFIED", timeZone: input.timeZone }, pageUrl: entry, steps: [],
      permittedRoutes: [{ origin, path: "/tee-times", methods: ["GET"], queryKeys: [] }, { origin, path: "/availability", methods: ["GET"], queryKeys: ["date"] }],
      availabilityResponse: { url: origin + "/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, players: { selector: "#players", attribute: "value" }, complete: { selector: "#ready" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } } });
    let pending = 0, leaseCalls = 0, denied = 0; const dispatched: string[] = [];
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
      allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({ prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
      get pendingReads() { return pending; }, releasePlaywrightRoute: async route => {
        pending++;
        try {
          const raw = route.request(), isTarget = raw.url() === target;
          if (![entry, target].includes(raw.url())) { await route.abort(); throw Error("UNEXPECTED_FIXTURE_URL"); }
          const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => isTarget ? "OPTIONS" : raw.method(),
            headers: () => isTarget ? { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization,content-type,x-api-key,x-ms-device-id,x-ms-client-session-id,x-ms-request-id" } : raw.headers(),
            postData: () => null, resourceType: () => isTarget ? "xhr" : raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() };
          await handler({ request: () => request, continue: options => route.continue(options), abort: async code => { if (isTarget) denied++; await route.abort(code); }, fulfill: options => route.fulfill(options) });
        } finally { pending--; }
      } }));
    vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const url = route.request().url(); if (url !== entry) throw Error("TARGET_MUST_NOT_DISPATCH"); dispatched.push(url);
      const body = Buffer.from(`<h1 id="venue">Public Example Golf</h1><input id="date" value="2026-10-23"><input id="players" value="2"><p id="ready">Ready</p>
        <div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>
        <script>fetch(${JSON.stringify(target)},{headers:{authorization:'Bearer null','x-api-key':'PRIVATE_KEY_SENTINEL'}}).catch(()=>{});</script>`), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, body, headers }); return { url, status: 200, headers, body };
    });
    const fetcher = vi.fn(async () => { throw Error("PINNED_FETCH_MUST_NOT_RUN"); });
    const result = await executeAccessRecipe(recipe, input, { now: () => new Date("2026-10-20T12:00:00Z"), fetch: fetcher,
      launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), requestLease: async (_family, work) => { leaseCalls++; return { acquired: true, value: await work() }; } });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { diagnostic: { code: "UNSCOPED_REQUEST", method: "OPTIONS", resourceType: "xhr", requestUrlFingerprint: fingerprint,
      publicHeaderDiagnostic: { stage: "HEADER_PROOF_MISSING", requestedPreflightMethod: "GET", privateProofFailureReason: "UNOBSERVED", requestedAuthorization: true, requestedApiKey: true } } } });
    expect(accessExecutionDiagnosticSchema.safeParse(result.evidence.diagnostic).success).toBe(true);
    expect(publicHeaderFailureDiagnosticSchema.safeParse(result.evidence.diagnostic?.publicHeaderDiagnostic).success).toBe(true);
    expect(restore(result.evidence.diagnostic)).toMatchObject({ requestUrlFingerprint: fingerprint, publicHeaderDiagnostic: { stage: "HEADER_PROOF_MISSING" } });
    expect(dispatched).toEqual([entry]); expect(leaseCalls).toBe(1); expect(pending).toBe(0); expect(denied).toBe(1); expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|account|membersports|rawPath|PRIVATE_KEY/u);
  }, 15_000);
});
