// @vitest-environment node
// Real isolated Chrome plus synthetic native caller-policy seams. The native
// protocol suite separately proves private identities, response ACKs and key
// witnesses. This file proves executor-owned gotos start that lifecycle.
import { existsSync } from "node:fs";
import { chromium, type Frame } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import type { PublicClientReadHeaderProof } from "./public-client-read-headers";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const origin = "https://boundary.example.org", entry = origin + "/tee-times", availability = origin + "/availability?date=2026-10-23";
const official = origin + "/rates", bookingOrigin = "https://app.membersports.com", booking = bookingOrigin + "/tee-times/123/456/0";
const api = "https://api.membersports.com", endpoint = api + "/api/v1/golfclubs/onlineBookingTeeTimes";
const courses = api + "/api/v1/golfclubs/123/coursesslim";
const parameters = api + "/api/v1/golfclubs/123/golfCourses/456/types/0/teesheetparameters";
const counts = api + "/api/v1/teesheets/golfclubs/123/courses/456/types/0/dates/2026-10-23/2026-10-23/1046/profiles/0/bookingCounts";
const literal = "synthetic-public-boundary-literal";

function savedRecipe(memberSports: boolean) {
  if (!memberSports) return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME",
    target: { courseId: "native-document-boundary", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: entry, venueName: "Public Example Golf", providerFamily: "UNVERIFIED", timeZone: input.timeZone },
    pageUrl: entry, steps: [], permittedRoutes: [{ origin, path: "/tee-times", methods: ["GET"], queryKeys: [] },
      { origin, path: "/availability", methods: ["GET"], queryKeys: ["date"] }],
    availabilityResponse: { url: origin + "/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "code", equals: 200 } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, players: { selector: "#players", attribute: "value" },
      complete: { availabilityResponse: true }, empty: { selector: "#empty" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } } });
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_JSON", browserTransport: "NATIVE_CHROME", requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET",
    target: { courseId: "native-official-booking-boundary", kind: "OUTDOOR" },
    source: { officialUrl: origin + "/", bookingUrl: booking, venueName: "Canonical Example Golf", venueAddress: "1005 Richardson Dr, Groveport, OH 43125, USA",
      providerFamily: "MEMBERSPORTS", timeZone: input.timeZone }, pageUrl: official,
    steps: [{ action: "openOfficialBooking", addressSelector: "#address", bookingLinkSelector: "#booking" }, { action: "waitFor", selector: ".teeTimes" }],
    permittedRoutes: [{ origin, path: "/rates", methods: ["GET"], queryKeys: [] }, { origin: bookingOrigin, path: "/tee-times/123/456/0", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/onlineBookingTeeTimes", methods: ["POST"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/123/coursesslim", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/123/golfCourses/456/types/0/teesheetparameters", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/teesheets/golfclubs/123/courses/456/types/0/dates/*", methods: ["GET"], queryKeys: [] }],
    availabilityResponse: { url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "date" } },
    proof: { venue: { officialBookingLink: true }, date: { availabilityRequestDate: true }, complete: { publicTeeSheet: true } } });
}

async function run(memberSports: boolean) {
  let pending = 0, epoch = 0, activeDocument = "";
  const events: Array<{ kind: "BEGIN" | "DOCUMENT" | "PROOF"; epoch: number; url?: string }> = [];
  const proofs = new Map<PublicClientReadHeaderProof, number>();
  const publicBody = `<h1 id="venue">Public Example Golf</h1><input id="date" value="2026-10-23"><input id="players" value="2">
    <div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>
    <script>fetch('/availability?date=2026-10-23',{headers:{Authorization:'Bearer null','x-api-key':'${literal}'}}).catch(()=>{});</script>`;
  const officialBody = `<h1>Example Municipal Golf</h1><p id="address">1005 Richardson Dr<br>Groveport, OH 43125</p>
    <a id="booking" target="_blank" href="${booking}">BOOK A TEE TIME</a>`;
  const postBody = { configurationTypeId: 0, date: input.date, golfClubGroupId: 0, golfClubId: 123, golfCourseId: 456, groupSheetTypeId: 0 };
  const bookingBody = `<p class="dateFormat">Fri, Oct 23, 2026</p><div class="teeTimes"><div class="teeTime"><div class="timeCol">1:30 PM</div><div class="availableBookings">
    <app-tee-time-card class="bookingCard"><div class="teeTimeCard"><div class="name">Front</div><div class="rightCells">
    <div class="iconCell first"><span>1-4</span></div><div class="iconCell"><div class="holes9"></div></div></div></div></app-tee-time-card></div></div></div><script>
    Promise.all(${JSON.stringify([courses, parameters, counts])}.map(url=>fetch(url).then(r=>r.json()))).then(()=>fetch(${JSON.stringify(endpoint)},
    {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer null','x-api-key':'${literal}'},body:JSON.stringify(${JSON.stringify(postBody)})})).catch(()=>{});</script>`;
  const payloads = new Map<string, unknown>([
    [entry, publicBody], [official, officialBody], [booking, bookingBody], [availability, { code: 200 }],
    [courses, [{ golfCourseId: 456, name: "Example Municipal Course", holes: 18 }]],
    [parameters, [{ configurationTypeId: 0, allowFivesomes: false, onlyClubMembersCanReserve: false, minimumNumberOfPlayers: 1,
      allowSinglesToBookOnline: true, alwaysShowBackNine: false, enableMaximumDailyTeeTimes: false }]],
    [counts, { hasCustomTeeTimeLimit: false, enableMaximumTeeTimes: false, limitTeeTimesPerMembership: false }],
    [endpoint, [{ teeTime: 810, items: [{ teeTimeId: 1, golfClubId: 123, golfCourseId: 456, configurationTypeId: 0, rotationNumber: 1,
      teeTime: 810, isBackNine: false, playerCount: 0, backNinePlayerCount: 0, minimumNumberOfPlayers: 1, holesRequirementTypeId: 1,
      threeWayHolesRequirementTypeId: 0, allowSinglesToBookOnline: true, ruleOverridesMinimumPlayer: false, bookingNotAllowed: false,
      hide: false, hasBackNineEvent: false, availableCount: 0 }] }]],
  ]);
  vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
    allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
  vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request => {
    const expected = memberSports ? booking : entry;
    if (!epoch || activeDocument !== expected || request.url() !== (memberSports ? endpoint : availability)) return null;
    const proof = Object.freeze({}) as PublicClientReadHeaderProof;
    proofs.set(proof, epoch); events.push({ kind: "PROOF", epoch, url: request.url() }); return proof;
  });
  vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(proof => proofs.get(proof) === epoch);
  vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (page, handler) => ({
    prepare: () => {}, close: async () => {}, lastFailure: undefined,
    beginDocumentNavigation: async (frame: Frame) => { expect(frame).toBe(page.mainFrame()); epoch++; activeDocument = ""; events.push({ kind: "BEGIN", epoch }); },
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try {
        const raw = route.request(), headers = await raw.allHeaders();
        if (!payloads.has(raw.url())) { await route.abort(); throw Error("UNEXPECTED_FIXTURE_URL"); }
        if (raw.isNavigationRequest() && raw.resourceType() === "document") {
          activeDocument = raw.url(); events.push({ kind: "DOCUMENT", epoch, url: activeDocument });
        }
        const request: nativeRouting.NativeReadRequest = { url: () => raw.url(), method: () => raw.method(), headers: () => ({ ...headers }), postData: () => raw.postData(),
          resourceType: () => raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(), redirectedFrom: () => null, response: () => raw.response() };
        await handler({ request: () => request, continue: options => route.continue(options), abort: code => route.abort(code), fulfill: options => route.fulfill(options) });
      } finally { pending--; }
    },
  }));
  vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
    const url = route.request().url();
    if (!payloads.has(url)) throw Error("UNEXPECTED_FIXTURE_DISPATCH");
    const payload = payloads.get(url), body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
    const headers = { "content-type": typeof payload === "string" ? "text/html" : "application/json", "access-control-allow-origin": bookingOrigin };
    await route.fulfill({ status: 200, body, headers }); return { url, status: 200, headers, body };
  });
  const fetcher = vi.fn(async () => { throw Error("PINNED_FETCH_MUST_NOT_RUN"); });
  const result = await executeAccessRecipe(savedRecipe(memberSports), input, { now: () => new Date("2026-10-20T12:00:00Z"),
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: fetcher,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0); expect(JSON.stringify(result)).not.toContain(literal);
  return { result, events, proofs };
}

describe.runIf(existsSync(chrome))("executor native document lifecycle caller boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  it("begins native tracking before the initial document and can consume its header proof", async () => {
    const { result, events, proofs } = await run(false);
    expect(events.slice(0, 2)).toEqual([{ kind: "BEGIN", epoch: 1 }, { kind: "DOCUMENT", epoch: 1, url: entry }]);
    expect(proofs.size).toBe(1);
    expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(1);
  }, 20_000);
  it("starts a fresh native boundary before the exact officially attested booking navigation", async () => {
    const { result, events, proofs } = await run(true);
    expect(events.filter(event => event.kind !== "PROOF")).toEqual([{ kind: "BEGIN", epoch: 1 }, { kind: "DOCUMENT", epoch: 1, url: official },
      { kind: "BEGIN", epoch: 2 }, { kind: "DOCUMENT", epoch: 2, url: booking }]);
    expect(proofs.size).toBe(1); expect([...proofs.values()]).toEqual([2]);
    expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(1);
  }, 20_000);
});
