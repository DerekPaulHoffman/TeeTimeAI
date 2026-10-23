// @vitest-environment node
// Complete local-Chrome executor composition with explicitly synthetic native
// continuation/private-header proofs. No provider, real preflight wire, private
// proof branding, public-key qualification or distributed database lease proof.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const official = "https://example.org/rates", origin = "https://app.membersports.com";
const booking = origin + "/tee-times/123/456/0", api = "https://api.membersports.com";
const endpoint = api + "/api/v1/golfclubs/onlineBookingTeeTimes";
const coursesUrl = api + "/api/v1/golfclubs/123/coursesslim";
const parametersUrl = api + "/api/v1/golfclubs/123/golfCourses/456/types/0/teesheetparameters";
const publicKey = "synthetic-public-literal";
const baseline = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
type Mode = "valid" | "missing-address" | "wrong-link" | "missing-post-route" | "profile-body" | "metadata-date" | "new-document" | "malformed-row" | "dom-parity" | "restricted" | "latest-500" | "latest-429" | "later-wrong-date" | "overlap-wrong-date";

function countsUrl(date: string) { return `${api}/api/v1/teesheets/golfclubs/123/courses/456/types/0/dates/${date}/${date}/1046/profiles/0/bookingCounts`; }
function body(date: string) { return { configurationTypeId: 0, date, golfClubGroupId: 0, golfClubId: 123, golfCourseId: 456, groupSheetTypeId: 0 }; }
function recipe(mode: Mode) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_JSON", browserTransport: "NATIVE_CHROME",
    target: { courseId: "public-tee-sheet-fixture", kind: "OUTDOOR" },
    source: { officialUrl: "https://example.org/", bookingUrl: booking, venueName: "Canonical Example Golf", venueAddress: "1005 Richardson Drive, Groveport, OH 43125, USA", providerFamily: "MEMBERSPORTS", timeZone: baseline.timeZone },
    pageUrl: official, steps: [{ action: "openOfficialBooking", addressSelector: "#address", bookingLinkSelector: "#booking" }, { action: "waitFor", selector: ".teeTimes" }],
    permittedRoutes: [
      { origin: "https://example.org", path: "/rates", methods: ["GET"], queryKeys: [] },
      { origin, path: "/tee-times/123/456/0", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/onlineBookingTeeTimes", methods: mode === "missing-post-route" ? ["GET"] : ["POST"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/123/coursesslim", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/golfclubs/123/golfCourses/456/types/0/teesheetparameters", methods: ["GET"], queryKeys: [] },
      { origin: api, path: "/api/v1/teesheets/golfclubs/123/courses/456/types/0/dates/*", methods: ["GET"], queryKeys: [] },
    ],
    requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET",
    availabilityResponse: { url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "date" } },
    proof: { venue: { officialBookingLink: true }, date: { availabilityRequestDate: true }, complete: { publicTeeSheet: true } },
  });
}
function response(mode: Mode) {
  const item: Record<string, unknown> = { teeTimeId: 1, golfClubId: 123, golfCourseId: 456, configurationTypeId: 0, rotationNumber: 1,
    teeTime: 810, isBackNine: false, playerCount: 0, backNinePlayerCount: 0, minimumNumberOfPlayers: 1,
    holesRequirementTypeId: 1, threeWayHolesRequirementTypeId: 0, allowSinglesToBookOnline: true, ruleOverridesMinimumPlayer: false,
    bookingNotAllowed: mode === "restricted", hide: false, hasBackNineEvent: false, availableCount: 0 };
  if (mode === "malformed-row") delete item.allowSinglesToBookOnline;
  return [{ teeTime: 810, items: [item] }];
}
function dom(date: string, mode: Mode) {
  const day = new Date(`${date}T00:00:00Z`), weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dateText = `${weekdays[day.getUTCDay()]}, Oct ${day.getUTCDate()}, ${day.getUTCFullYear()}`;
  return `<p class="dateFormat">${dateText}</p><div class="teeTimes"><div class="teeTime"><div class="timeCol">1:30 PM</div><div class="availableBookings">
    <app-tee-time-card class="bookingCard"><div class="teeTimeCard${mode === "restricted" ? " restricted" : ""}"><div class="name">Front</div>
    <div class="rightCells"><div class="iconCell first"><span>1-${mode === "dom-parity" ? "3" : "4"}</span></div><div class="iconCell holes9"></div></div>
    </div></app-tee-time-card></div></div></div>`;
}

async function run(mode: Mode, input = baseline) {
  let pending = 0, postCount = 0, bookingDocuments = 0, optionsCompleted = 0;
  let laterPostEntered = false, firstResponseHeld = false;
  let releaseFirst: () => void = () => {};
  const laterPost = new Promise<void>(resolve => { releaseFirst = resolve; });
  const dispatched: string[] = [], posts: Array<{ headers: Record<string, string>; body: string | null }> = [];
  const proof = Object.freeze({}) as NonNullable<Awaited<ReturnType<typeof nativeRouting.authorizePublicClientReadHeaders>>>;
  // These spies deliberately provide no evidence about the private native brand.
  vi.spyOn(nativeRouting, "authorizePublicClientReadHeaders").mockImplementation(async request => request.url() === endpoint ? proof : null);
  vi.spyOn(nativeRouting, "isCurrentPublicClientReadHeaders").mockImplementation(value => value === proof);
  vi.spyOn(nativeRouting, "nativePublicClientPreflightMethod").mockImplementation((request, value) =>
    request.url() === endpoint && request.method() === "OPTIONS" && value === proof ? "POST" : null);
  vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: async () => {},
    allowHostConnections: () => {}, cancelHostConnections: async () => {}, stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
  const counts = countsUrl(mode === "metadata-date" ? "2026-10-22" : input.date);
  const allowed = new Set([official, booking, coursesUrl, parametersUrl, counts, endpoint]);
  vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({ prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, lastFailure: undefined,
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try {
        const raw = route.request(), headers = await raw.allHeaders();
        if (!allowed.has(raw.url())) throw Error("UNEXPECTED_FIXTURE_URL");
        const wrapped: nativeRouting.NativeReadRoute = { request: () => ({ url: () => raw.url(), method: () => raw.method(), headers: () => ({ ...headers }),
          postData: () => raw.postData(), resourceType: () => raw.resourceType(), isNavigationRequest: () => raw.isNavigationRequest(), frame: () => raw.frame(),
          redirectedFrom: () => null, response: () => raw.response() }),
        continue: options => route.continue(options), abort: code => route.abort(code), fulfill: options => route.fulfill(options) };
        // The second concurrent POST uses an already completed synthetic
        // preflight. This controls response-order composition, not wire/cache
        // behavior, and still runs the complete actual POST handler.
        const wrongLaterDate = raw.url() === endpoint && raw.method() === "POST" && JSON.parse(raw.postData() ?? "{}").date !== input.date;
        if (raw.url() === endpoint && raw.method() === "POST" && !(mode === "overlap-wrong-date" && wrongLaterDate && optionsCompleted > 0)) {
          let denied = false, fulfilled = false;
          const options: nativeRouting.NativeReadRoute = { request: () => ({ url: () => endpoint, method: () => "OPTIONS",
            headers: () => ({ origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-api-key" }),
            postData: () => null, resourceType: () => "other", isNavigationRequest: () => false, frame: () => raw.frame(), redirectedFrom: () => null, response: async () => null }),
          continue: async () => { throw Error("SYNTHETIC_OPTIONS_MUST_NOT_DISPATCH_RAW_POST"); }, abort: async () => { denied = true; },
          fulfill: async result => { expect(result.status).toBe(204); fulfilled = true; optionsCompleted++; } };
          await handler(options);
          if (denied || !fulfilled) { await route.abort("blockedbyclient"); return; }
        }
        const handling = handler(wrapped);
        if (mode === "overlap-wrong-date" && wrongLaterDate) { laterPostEntered = true; releaseFirst(); }
        await handling;
      } finally { pending--; }
    },
  }));
  vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
    const request = route.request(), url = request.url();
    if (url === endpoint && request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, body: "" });
      return { url, status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    if (!allowed.has(url)) throw Error("UNEXPECTED_FIXTURE_DISPATCH");
    dispatched.push(url);
    let payload: unknown, contentType = "application/json", status = 200;
    if (url === official) {
      contentType = "text/html";
      payload = `<h1>Example Municipal Golf</h1>${mode === "missing-address" ? "" : '<p id="address">1005 Richardson Dr<br>Groveport, OH 43125</p>'}
        <a id="booking" target="_blank" href="${mode === "wrong-link" ? booking.replace("/456/", "/457/") : booking}">BOOK A TEE TIME</a>`;
    } else if (url === booking) {
      bookingDocuments++;
      contentType = "text/html";
      const postBody = { ...body(input.date), ...(mode === "profile-body" ? { memberProfileId: 0 } : {}) };
      const postRequest = (value: unknown) => `fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer null','x-api-key':${JSON.stringify(publicKey)}},body:JSON.stringify(${JSON.stringify(value)})})`;
      const post = postRequest(postBody);
      const wrong = postRequest({ ...postBody, date: "2026-10-24" });
      const following = mode === "latest-500" || mode === "latest-429" ? `.then(()=>${post})`
        : mode === "later-wrong-date" ? `.then(()=>${wrong})` : mode === "new-document" ? ".then(()=>location.reload())" : "";
      const requests = mode === "overlap-wrong-date" ? `Promise.all([${post},${wrong}])` : post;
      payload = dom(input.date, mode) + (mode === "new-document" && bookingDocuments > 1 ? "" : `<script>
        Promise.all([${JSON.stringify([coursesUrl, parametersUrl, counts])}.map(url=>fetch(url).then(r=>r.json()))]).then(()=>${requests})${following}.catch(()=>{});
        </script>`);
    } else if (url === coursesUrl) payload = [{ golfCourseId: 456, name: "Example Municipal Course", holes: 18 }];
    else if (url === parametersUrl) payload = [{ configurationTypeId: 0, allowFivesomes: false, onlyClubMembersCanReserve: false, minimumNumberOfPlayers: 1,
      allowSinglesToBookOnline: true, alwaysShowBackNine: false, enableMaximumDailyTeeTimes: false }];
    else if (url === counts) payload = { hasCustomTeeTimeLimit: false, enableMaximumTeeTimes: false, limitTeeTimesPerMembership: false };
    else {
      if (request.method() !== "POST") throw Error("UNEXPECTED_FIXTURE_METHOD");
      postCount++; posts.push({ headers: request.headers(), body: request.postData() });
      if (mode === "overlap-wrong-date" && postCount === 1) { firstResponseHeld = true; await laterPost; }
      payload = response(mode);
      if (postCount > 1 && mode === "latest-500") status = 500;
      if (postCount > 1 && mode === "latest-429") status = 429;
    }
    const data = Buffer.from(contentType === "text/html" ? String(payload) : JSON.stringify(payload));
    const headers = { "content-type": contentType, "access-control-allow-origin": origin };
    await route.fulfill({ status, headers, body: data });
    return { url, status, headers, body: data };
  });
  const fetcher = vi.fn(async () => { throw Error("PINNED_TRANSPORT_MUST_NOT_RUN"); });
  const now = new Date("2026-10-20T12:00:00Z");
  const result = await executeAccessRecipe(recipe(mode), input, { now: () => now, deadlineAt: new Date(now.getTime() + 6500),
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: fetcher,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  expect(fetcher).not.toHaveBeenCalled(); expect(pending).toBe(0); expect(JSON.stringify(result)).not.toContain(publicKey);
  return { result, posts, dispatched, optionsCompleted, laterPostEntered, firstResponseHeld };
}

describe.runIf(existsSync(chrome))("MemberSports browser JSON complete executor composition", () => {
  afterEach(() => vi.restoreAllMocks());
  it("proves the baseline and a changed date/P3 in separate fresh executions", async () => {
    for (const input of [baseline, { ...baseline, date: "2026-10-24", players: 3 }]) {
      const { result, posts, optionsCompleted } = await run("valid", input);
      expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0]).toMatchObject({ startsAt: `${input.date}T17:30:00.000Z`, availableSpots: 4, holes: 9 });
      expect(posts).toHaveLength(1); expect(JSON.parse(posts[0].body!)).toEqual(body(input.date));
      expect(posts[0].headers.origin).toBe(origin); expect(optionsCompleted).toBe(1);
      vi.restoreAllMocks();
    }
  }, 20_000);
  it("requires the actual official address and exact observed booking link before provider navigation", async () => {
    for (const mode of ["missing-address", "wrong-link"] as const) {
      const { result, posts, dispatched } = await run(mode);
      expect(result).toMatchObject({ complete: false, slots: [], evidence: { reason: "OFFICIAL_BOOKING_IDENTITY_UNVERIFIED" } });
      expect(posts).toEqual([]); expect(dispatched).toEqual([official]); vi.restoreAllMocks();
    }
  }, 20_000);
  it.each<Mode>(["missing-post-route", "profile-body"])("does not dispatch the public POST without full permission: %s", async mode => {
    const { result, posts } = await run(mode);
    expect(result.complete).toBe(false); expect(result.slots).toEqual([]); expect(posts).toEqual([]);
  }, 12_000);
  it.each<Mode>(["metadata-date", "new-document", "malformed-row", "dom-parity", "restricted"])("never certifies incomplete or changed evidence: %s", async mode => {
    const { result } = await run(mode);
    expect(result.complete, JSON.stringify(result.evidence)).toBe(false); expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
  }, 12_000);
  it("does not reuse a successful POST after a later failed or throttled POST", async () => {
    for (const mode of ["latest-500", "latest-429"] as const) {
      const { result, posts } = await run(mode);
      expect(posts).toHaveLength(2); expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
      if (mode === "latest-429") expect(result.evidence.reason).toBe("PROVIDER_THROTTLED");
      vi.restoreAllMocks();
    }
  }, 20_000);
  it("invalidates an old requested-date result when a later same-endpoint POST selects another valid date", async () => {
    for (const mode of ["later-wrong-date", "overlap-wrong-date"] as const) {
      const { result, posts, firstResponseHeld, laterPostEntered } = await run(mode);
      expect(posts).toHaveLength(2);
      expect(posts.map(post => JSON.parse(post.body!).date)).toEqual([baseline.date, "2026-10-24"]);
      expect(result.complete, JSON.stringify(result.evidence)).toBe(false); expect(result.slots).toEqual([]);
      if (mode === "overlap-wrong-date") { expect(firstResponseHeld).toBe(true); expect(laterPostEntered).toBe(true); }
      vi.restoreAllMocks();
    }
  }, 20_000);
  it("returns complete EMPTY when all valid nonempty source offers lie outside the alert window", async () => {
    const { result, posts } = await run("valid", { ...baseline, endTime: "12:00" });
    expect(posts).toHaveLength(1);
    expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "EMPTY", complete: true, slots: [], evidence: {
      venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true,
    } });
  }, 12_000);
});
