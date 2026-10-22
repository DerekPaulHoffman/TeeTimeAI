import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, matchesAvailabilityResponse, parseObservedCalendarDate, recipeExecutionDiagnostic, recipeTimeToInstant, venueProofMatches, type AccessExecutorDependencies } from "./executor";
import { parseAccessRecipe } from "./recipe";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";
import * as publicReadPolicy from "@/lib/automation/passfactory-public-read-policy";
import * as pinnedTransport from "@/lib/automation/address-pinned-public-fetch";
import * as passfactoryDuration from "./passfactory-client-duration";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
vi.mock("@/lib/automation/simulator-interactive-browser", () => ({ isAnonymousBrowserReadPost: () => false }));
const httpRecipe = () => ({
  schemaVersion: 1 as const, engine: "HTTP_JSON" as const,
  target: { courseId: "course-1", kind: "OUTDOOR" as const },
  source: { officialUrl: "https://example.org/golf", bookingUrl: "https://example.org/tee-times",
    venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: "America/New_York" },
  permittedRoutes: [{ origin: "https://example.org", path: "/api/availability", methods: ["GET" as const], queryKeys: ["date", "players", "zone"] }],
  request: { url: "https://example.org/api/availability?date={{date}}&players={{players}}&zone={{timeZone}}", method: "GET" as const },
  proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" }, players: { path: "players" } },
  slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "capacity" }, holes: { path: "holes" } },
});
const executionInput = { date: "2026-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };

const now = () => new Date("2026-10-20T12:00:00Z");
const payload = () => ({ venue: "Example Golf", date: executionInput.date, complete: true, empty: false, players: 2,
  slots: [{ start: "09:00", capacity: 4, holes: 18 }] });
/** These executor-policy fixtures synthesize a browser response. Real native
 * dispatch/body identity belongs to the separate offline TLS test lane. */
function nativeControllerFixture() {
  let pending = 0;
  return vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
    prepare: () => {}, close: async () => {}, lastFailure: undefined,
    get pendingReads() { return pending; },
    releasePlaywrightRoute: async route => {
      pending++;
      try { await handler(route); }
      finally { pending--; }
    },
  }));
}
function dependencies(body: unknown, status = 200): AccessExecutorDependencies {
  return { now, fetch: vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }) };
}
describe("deterministic course recipe execution", () => {
  it("binds an explicit public month-day-year response date without accepting an implicit format", () => {
    const base = { ...httpRecipe() }; Reflect.deleteProperty(base, "request");
    const url = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=publicrental&time_slot=12:00&party_size=1&halo_size_interval=16&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en";
    const recipe = parseAccessRecipe({ ...base, engine: "BROWSER_DOM", pageUrl: "https://example.org/tee-times", steps: [],
      proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, complete: { selector: "#ready" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } },
      availabilityResponse: { url, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" } } });
    if (recipe.engine !== "BROWSER_DOM") throw Error("browser fixture");
    const actual = url.replace("{{dateMdy}}", "10-22-2026");
    expect(matchesAvailabilityResponse(recipe, executionInput, { url: actual, method: "GET" }, 200)).toBe(true);
    expect(matchesAvailabilityResponse(recipe, executionInput, { url: actual.replace("10-22-2026", "10-23-2026"), method: "GET" }, 200)).toBe(false);
    expect(matchesAvailabilityResponse(recipe, executionInput, { url: actual, method: "GET" }, 500)).toBe(false);
    expect(matchesAvailabilityResponse({ ...recipe, availabilityResponse: { ...recipe.availabilityResponse, date: { source: "QUERY", path: "start_date" } } },
      executionInput, { url: actual, method: "GET" }, 200)).toBe(false);
  });

  it("verifies abbreviated public date labels and rejects contradictory weekdays", async () => {
    for (const date of ["Thu, Oct 22, 2026", "Thursday, October 22, 2026", "Thursday, October22,2026"]) {
      const result = await executeAccessRecipe(httpRecipe(), executionInput, dependencies({ ...payload(), date }));
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true } });
    }
    for (const date of ["Fri, Oct 22, 2026", "Friday, October 22, 2026", "Friday, October22,2026", "Thu, Feb 30, 2026"]) {
      const result = await executeAccessRecipe(httpRecipe(), executionInput, dependencies({ ...payload(), date }));
      expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, evidence: { dateVerified: false } });
    }
  });

  it("normalizes only standalone ampersand conjunctions while keeping the whole venue and location", () => {
    expect(venueProofMatches("COR-Golf Cafe and Lounge", "COR Golf Cafe & Lounge")).toBe(true);
    expect(venueProofMatches("COR Golf Cafe & Lounge", "COR-Golf Cafe and Lounge")).toBe(true);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "COR Golf Cafe \t&\n Lounge")).toBe(true);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "COR Golf Cafe&Lounge")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "COR Golf Cafe &amp; Lounge")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe R and D Lounge", "COR Golf Cafe R&D Lounge")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "COR Golf Cafe & Lounge Denver")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe and Lounge Denver", "COR Golf Cafe & Lounge Boulder")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "Golf Cafe & Lounge")).toBe(false);
    expect(venueProofMatches("COR Golf Cafe and Lounge", "COR Golf Cafe & and Lounge")).toBe(false);
  });
  it("normalizes public venue category suffixes only for a distinctive matching core", () => {
    expect(venueProofMatches("Tashua Knolls", "Tashua Knolls Golf Course")).toBe(true);
    expect(venueProofMatches("Tashua Knolls", "TashuaKnollsGolfCourse")).toBe(true);
    expect(venueProofMatches("Tashua Knolls Golf Club", "Tashua-Knolls")).toBe(true);
    expect(venueProofMatches("Tashua Knolls", "Tashua Glen Golf Course")).toBe(false);
    expect(venueProofMatches("Tashua Knolls", "Tashua Hills Golf Club")).toBe(false);
    expect(venueProofMatches("Pine", "Pine Golf Course")).toBe(false);
    expect(venueProofMatches("Golf Course", "Golf Course Golf Club")).toBe(false);
    expect(venueProofMatches("The", "The Golf Club")).toBe(false);
  });
  it("constructs dates only from complete observed month/year and numeric day", () => {
    expect(parseObservedCalendarDate("October 2026", "22")).toBe("2026-10-22");
    expect(parseObservedCalendarDate("October", "22")).toBeUndefined();
    expect(parseObservedCalendarDate("February 2026", "30")).toBeUndefined();
    expect(parseObservedCalendarDate("October 2026", "22 Thursday")).toBeUndefined();
    expect(parseObservedCalendarDate("{{year}} October", "22")).toBeUndefined();
  });
  it("uses the actual request host rather than the recipe label for provider leases", async () => {
    const recipe = httpRecipe(); recipe.source.providerFamily = "MODEL_SELECTED_LABEL";
    const deps = dependencies(payload());
    const families: string[] = [];
    deps.requestLease = async (family, work) => { families.push(family); return { acquired: true, value: await work() }; };
    expect((await executeAccessRecipe(parseAccessRecipe(recipe), executionInput, deps)).status).toBe("AVAILABLE");
    expect(families).toEqual(["example.org"]);
  });
  it("reports a bounded failure step or public route without query values or raw error text", () => {
    expect(recipeExecutionDiagnostic(new Error('locator.selectOption: Timeout 10000ms secret-value'), {
      stepIndex: 2, url: "https://example.org/times?token=secret-value#private", method: "GET", resourceType: "document",
    })).toEqual({ code: "STEP_TIMEOUT", stepIndex: 2, url: "https://example.org/times", method: "GET", resourceType: "document" });
    expect(recipeExecutionDiagnostic(new Error("unsafe secret-value"), { url: "https://u:p@example.org/" })).toEqual({ code: "EXECUTION_FAILED" });
  });
  it.each(["PINNED_HTTP", "NATIVE_CHROME"])("classifies unavailable %s Chrome separately from source access or empty results", async browserTransport => {
    const base = { ...httpRecipe() }; Reflect.deleteProperty(base, "request");
    const recipe = parseAccessRecipe({ ...base, engine: "BROWSER_DOM", browserTransport, pageUrl: "https://example.org/tee-times", steps: [],
      availabilityResponse: { url: "https://example.org/api/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, complete: { selector: "#loaded" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } } });
    const result = await executeAccessRecipe(recipe, executionInput, { ...dependencies(payload()),
      launchBrowser: vi.fn(async () => { throw new Error("Executable does not exist"); }) });
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: { reason: "BROWSER_UNAVAILABLE" } });
  });
  it("never treats public bootstrap metadata as the dated availability response", () => {
    const base = { ...httpRecipe() }; Reflect.deleteProperty(base, "request");
    const selected = parseAccessRecipe({ ...base, engine: "BROWSER_DOM", pageUrl: "https://example.org/tee-times", steps: [],
      availabilityResponse: { url: "https://example.org/api/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
      proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, complete: { selector: "#loaded" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } } });
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    // Defense in depth for callers holding an unparsed object: parseAccessRecipe
    // independently rejects these URLs as an availability fence.
    for (const url of ["https://example.org/App/GlobalTenantSettings?date={{date}}",
      "https://example.org/AuthenticationSettings?AuthenticationType=&date={{date}}",
      "https://example.org/api/venue_info?venue_url_key=public-golf-club&date={{date}}"] ) {
      selected.availabilityResponse.url = url;
      const request = { url: url.replace("{{date}}", executionInput.date), method: "GET" };
      expect(matchesAvailabilityResponse(selected, executionInput, request, 200, JSON.stringify({ complete: true, empty: true }))).toBe(false);
      expect(() => parseAccessRecipe(selected)).toThrow();
    }
  });
  it("excludes a tee time exactly at the end boundary, matching server acceptance", async () => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput,
      dependencies({ ...payload(), slots: [{ start: "12:00", capacity: 4, holes: 18 }] }));
    expect(result.status).toBe("EMPTY"); expect(result.slots).toEqual([]);
  });
  it("executes two independent reads with deterministic normalized slots", async () => {
    const deps = dependencies(payload()); const recipe = parseAccessRecipe(httpRecipe());
    const one = await executeAccessRecipe(recipe, executionInput, deps);
    const two = await executeAccessRecipe(recipe, executionInput, deps);
    expect(one.status).toBe("AVAILABLE"); expect(one.slots).toEqual(two.slots);
    expect(one.slots[0].startsAt).toBe("2026-10-22T13:00:00.000Z");
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(one.evidence).toMatchObject({ venueVerified: true, dateVerified: true, completeVerified: true, capacityVerified: true });
  });
  it.each([
    ["wrong venue", { venue: "Different Golf" }], ["wrong date", { date: "2026-10-21" }],
    ["incomplete", { complete: false }], ["wrong party", { players: 1 }],
    ["absent rows", { slots: null }], ["missing capacity", { slots: [{ start: "09:00", holes: 18 }] }],
    ["bad date", { slots: [{ start: "2026-10-21T09:00:00", capacity: 4, holes: 18 }] }],
  ])("rejects %s", async (_name, changes) => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies({ ...payload(), ...changes }));
    expect(result.status).toBe("INCOMPLETE"); expect(result.slots).toEqual([]);
  });
  it("filters actual capacity and the requested window without inventing slots", async () => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies({ ...payload(),
      slots: [{ start: "09:00", capacity: 1, holes: 18 }, { start: "13:00", capacity: 4, holes: 18 }] }));
    expect(result.status).toBe("EMPTY"); expect(result.complete).toBe(true);
  });
  it("requires an explicit empty-state and party proof when there are no cards", async () => {
    const recipe = parseAccessRecipe(httpRecipe());
    expect((await executeAccessRecipe(recipe, executionInput, dependencies({ ...payload(), empty: false, slots: [] }))).status).toBe("INCOMPLETE");
    expect((await executeAccessRecipe(recipe, executionInput, dependencies({ ...payload(), empty: true, slots: [] }))).status).toBe("EMPTY");
  });
  it("rejects stale dates and changed timezone before calling transport", async () => {
    const deps = dependencies(payload()); const recipe = parseAccessRecipe(httpRecipe());
    expect((await executeAccessRecipe(recipe, { ...executionInput, date: "2026-10-19" }, deps)).status).toBe("INCOMPLETE");
    expect((await executeAccessRecipe(recipe, { ...executionInput, timeZone: "UTC" }, deps)).status).toBe("INCOMPLETE");
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403])("classifies access responses %i without leaking body", async status => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies({ secret: "do-not-copy" }, status));
    expect(result.status).toBe("ACCESS_REQUIRED"); expect(JSON.stringify(result)).not.toContain("do-not-copy");
  });
  it("preserves HTTP throttling as retryable rather than access-required", async () => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies({ secret: "do-not-copy" }, 429));
    expect(result).toMatchObject({ status: "FAILED", complete: false, evidence: { reason: "PROVIDER_THROTTLED", diagnostic: { code: "HTTP_429" } } });
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
  });
  it("reports transport failure and never treats it as empty availability", async () => {
    const deps = dependencies(null); deps.fetch = vi.fn(async () => { throw new Error("token=private"); }) as unknown as typeof fetch;
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, deps);
    expect(result.status).toBe("FAILED"); expect(result.complete).toBe(false); expect(JSON.stringify(result)).not.toContain("private");
  });
  it("rejects redirects and a credential-free but unapproved POST operation", async () => {
    const redirect = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies(null, 302));
    expect(redirect.status).toBe("FAILED");
    const base = httpRecipe();
    const recipe = parseAccessRecipe({ ...base, permittedRoutes: [{ ...base.permittedRoutes[0], methods: ["POST"] }],
      request: { url: "https://example.org/api/availability", method: "POST", body: { operation: "book" } } });
    const deps = dependencies(payload());
    expect((await executeAccessRecipe(recipe, executionInput, deps)).status).toBe("FAILED"); expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("requires exact simulator duration and records resource/product identity", async () => {
    const base = httpRecipe();
    const recipe = parseAccessRecipe({ ...base, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" },
      request: { ...base.request, url: base.request.url.replace("&players={{players}}", "") },
      proof: { ...base.proof, durationMinutes: { path: "duration" } }, slots: { ...base.slots, endsAt: { path: "end" }, resourceId: { path: "bay" }, productId: { path: "product" } } });
    const body = { ...payload(), duration: 60, slots: [{ start: "09:00", end: "10:00", capacity: 4, holes: 18, bay: "bay-1", product: "hour" }] };
    const result = await executeAccessRecipe(recipe, { ...executionInput, durationMinutes: 60 }, dependencies(body));
    expect(result.status).toBe("AVAILABLE"); expect(result.slots[0]).toMatchObject({ endsAt: "2026-10-22T14:00:00.000Z", resourceId: "bay-1", productId: "hour" });
    body.slots[0].end = "09:30";
    expect((await executeAccessRecipe(recipe, { ...executionInput, durationMinutes: 60 }, dependencies(body))).status).toBe("INCOMPLETE");
  });
  it("rejects contradictory repeated slot evidence", async () => {
    const result = await executeAccessRecipe(parseAccessRecipe(httpRecipe()), executionInput, dependencies({ ...payload(),
      slots: [{ start: "09:00", capacity: 2, holes: 18 }, { start: "09:00", capacity: 4, holes: 18 }] }));
    expect(result.status).toBe("INCOMPLETE");
  });
  it("returns a full one-bay simulator session for four players with unknown capacity", async () => {
    const base = httpRecipe();
    const recipe = parseAccessRecipe({ ...base, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" },
      request: { ...base.request, url: base.request.url.replace("&players={{players}}", "") },
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" }, durationMinutes: { path: "duration" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, endsAt: { path: "end" }, resourceId: { path: "bay" }, capacity: { path: "capacity" } } });
    const body = { ...payload(), players: 1, duration: 60, slots: [{ start: "09:00", end: "10:00", bay: "bay-1" }] };
    const result = await executeAccessRecipe(recipe, { ...executionInput, players: 4, durationMinutes: 60 }, dependencies(body));
    expect(result.status).toBe("AVAILABLE");
    expect(result.slots[0]).toMatchObject({ availableSpots: 1, capacity: null, resourceId: "bay-1", endsAt: "2026-10-22T14:00:00.000Z" });
    expect(result.slots[0].holes).toBeUndefined();
    const smallCapacity = await executeAccessRecipe(recipe, { ...executionInput, players: 4, durationMinutes: 60 }, dependencies({ ...body,
      slots: [{ ...body.slots[0], capacity: 2 }] }));
    expect(smallCapacity.status).toBe("AVAILABLE"); expect(smallCapacity.slots[0].capacity).toBe(2);
    expect((await executeAccessRecipe(recipe, { ...executionInput, players: 4, durationMinutes: 60 }, dependencies({ ...body, slots: [], empty: true }))).status).toBe("EMPTY");
    expect((await executeAccessRecipe(recipe, { ...executionInput, players: 4, durationMinutes: 60 }, dependencies({ ...body,
      slots: [{ ...body.slots[0], end: "09:30" }] }))).status).toBe("INCOMPLETE");
  });
  it("accepts a session ending at 24:00 and excludes sessions extending into the next day", async () => {
    const base = httpRecipe();
    const recipe = parseAccessRecipe({ ...base, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" },
      request: { ...base.request, url: base.request.url.replace("&players={{players}}", "") },
      proof: { ...base.proof, durationMinutes: { path: "duration" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, endsAt: { path: "end" }, resourceId: { path: "bay" } } });
    const input = { ...executionInput, startTime: "22:00", endTime: "24:00", players: 4, durationMinutes: 60 };
    const result = await executeAccessRecipe(recipe, input, dependencies({ ...payload(), duration: 60,
      slots: [{ start: "23:00", end: "2026-10-23T00:00:00", bay: "one-bay" }] }));
    expect(result.status).toBe("AVAILABLE"); expect(result.slots[0].endsAt).toBe("2026-10-23T04:00:00.000Z");
    const exceeds = await executeAccessRecipe(recipe, input, dependencies({ ...payload(), duration: 60,
      slots: [{ start: "23:30", end: "2026-10-23T00:30:00", bay: "one-bay" }] }));
    expect(exceeds.status).toBe("EMPTY");
    const nextMorning = await executeAccessRecipe(recipe, { ...input, durationMinutes: 480 }, dependencies({ ...payload(), duration: 480,
      slots: [{ start: "22:00", end: "2026-10-23T06:00:00", bay: "one-bay" }] }));
    expect(nextMorning.status).toBe("EMPTY");
  });
  it("rejects DST gaps and overlaps while accepting a disambiguated timestamp", () => {
    expect(() => recipeTimeToInstant("2026-03-08T02:30:00", executionInput)).toThrow();
    expect(() => recipeTimeToInstant("2026-11-01T01:30:00", executionInput)).toThrow();
    expect(recipeTimeToInstant("2026-11-01T01:30:00-04:00", executionInput).toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });
  it("reads exact public local space-separated timestamps through the existing timezone round trip", () => {
    const input = { ...executionInput, date: "2026-10-23" };
    for (const value of ["2026-10-23 14:00", "2026-10-23 14:00:00"])
      expect(recipeTimeToInstant(value, input).toISOString()).toBe("2026-10-23T18:00:00.000Z");
    expect(recipeTimeToInstant("2026-10-24 21:15:00", { ...input, date: "2026-10-24" }).toISOString()).toBe("2026-10-25T01:15:00.000Z");
    expect(recipeTimeToInstant("2026-10-23 14:00:00.123456789", input).toISOString()).toBe("2026-10-23T18:00:00.123Z");
    expect(recipeTimeToInstant("2026-10-23 14:00:00.1", input).toISOString()).toBe("2026-10-23T18:00:00.100Z");
  });
  it.each(["2026-03-08 02:30:00", "2026-11-01 01:30:00", "2026-02-30 14:00:00", "2026-13-01 14:00:00",
    "2026-10-23 24:00:00", "2026-10-23 14:60:00", "2026-10-23 14:00:60", "2026-10-23  14:00:00", "2026-10-23\t14:00:00",
    " 2026-10-23 14:00:00", "2026-10-23 14:00:00 ", "2026-10-23 14:00:00Z", "2026-10-23 14:00:00-04:00", "10/23/2026 14:00:00",
    "2026-10-23 14:00:00.1234567890"])("rejects ambiguous, invalid or non-exact space-separated timestamp %s", value => {
    expect(() => recipeTimeToInstant(value, executionInput)).toThrow();
  });
});

const chromeExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
// This fixture never contacts a provider: every browser request is intercepted
// and supplied by the injected in-memory transport, in a fresh Chrome profile.
describe.runIf(existsSync(chromeExecutable))("isolated browser recipe replay", () => {
  const recipe = () => {
    const base = { ...httpRecipe() }; Reflect.deleteProperty(base, "request");
    return parseAccessRecipe({
    ...base, engine: "BROWSER_DOM",
    pageUrl: "https://example.org/tee-times",
    availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
    permittedRoutes: [{ origin: "https://example.org", path: "/tee-times", methods: ["GET"], queryKeys: [] },
      { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] }],
    steps: [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" }],
    proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" },
      complete: { selector: "#loaded" }, empty: { selector: "#empty" }, players: { selector: "#players", attribute: "value" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
  }); };
  const html = '<!doctype html><html><body><h1 id="venue">Example Golf</h1><input id="date" value="2026-10-22">' +
    '<select id="players" name="players"><option value="1">1</option><option value="2">2</option></select>' +
    '<p id="loaded">Ready</p><div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div></body></html>';
  const browserHtml = (page: string) => page + '<script>function fence(){let value=document.querySelector("#date")?.value||"2026-10-22"; if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)){value=new Date(value.replace(/([A-Za-z])(\\d)/g,"$1 $2")).toISOString().slice(0,10)}fetch("/availability?date="+value)}document.addEventListener("change",fence);document.addEventListener("click",()=>queueMicrotask(fence));setTimeout(fence,0);</script>';
  const browserDeps = (page: string, injectFence = true): AccessExecutorDependencies => ({
    now, launchBrowser: () => chromium.launch({ executablePath: chromeExecutable, headless: true }),
    fetch: vi.fn(async () => new Response(injectFence ? browserHtml(page) : page, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
  });
  it("replays a safe select and extracts visible proof in a fresh real browser", async () => {
    const result = await executeAccessRecipe(recipe(), executionInput, browserDeps(html));
    expect(result.status).toBe("AVAILABLE"); expect(result.slots[0].startsAt).toBe("2026-10-22T13:00:00.000Z");
  }, 20_000);
  it.each(["2026-10-22", "2026-10-23"])("replays a saved language-bearing range for %s", async date => {
    const range = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=publicrental&time_slot=12:00&party_size=1&halo_size_interval=16&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration=60";
    const selected = parseAccessRecipe({ ...recipe(), steps: [],
      permittedRoutes: [{ origin: "https://example.org", path: "/tee-times", methods: ["GET"], queryKeys: [] },
        { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"],
          queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "selected_lang_code", "picked_duration"] }],
      availabilityResponse: { url: range, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" }, success: { path: "status", equals: "success" } },
    });
    const actual = range.replace("{{dateMdy}}", date.slice(5, 7) + "-" + date.slice(8) + "-" + date.slice(0, 4));
    const fixture = `<h1 id="venue">Example Golf</h1><input id="date" value="${date}"><select id="players"><option selected value="2">2</option></select><p id="loaded">Loading</p><div id="times"></div>` +
      `<script>fetch(${JSON.stringify(actual)}).then(r=>r.json()).then(v=>{if(v.status==='success'){document.querySelector('#loaded').textContent='Ready';document.querySelector('#times').innerHTML='<div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>'}})</script>`;
    const deps = browserDeps(fixture, false), originalFetch = deps.fetch!;
    deps.fetch = vi.fn(async (url, init) => String(url) === actual
      ? new Response(JSON.stringify({ status: "success" }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } })
      : originalFetch(url, init)) as typeof fetch;
    const result = await executeAccessRecipe(selected, { ...executionInput, date }, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true } });
    expect(result.slots[0].startsAt).toBe(date + "T13:00:00.000Z");
    expect(vi.mocked(deps.fetch!).mock.calls.some(([url]) => String(url) === actual)).toBe(true);
  }, 20_000);
  it("replays a readonly date opener and an explicitly labelled numeric calendar day", async () => {
    const selected = parseAccessRecipe({ ...recipe(), steps: [
      { action: "clickFilter", selector: "#date", text: "Choose date", purpose: "OPEN_DATE_PICKER" },
      { action: "selectDateChoice", selector: "#calendar button" },
      { action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" },
    ] });
    const fixture = html.replace('<input id="date" value="2026-10-22">',
      '<input id="date" readonly placeholder="Choose date" aria-haspopup="dialog" value="Wed, Oct 21, 2026" onclick="document.querySelector(\'#calendar\').hidden=false">' +
      '<table id="calendar" role="grid" hidden><tr><td role="gridcell"><button aria-label="Wed, Oct 21, 2026">21</button></td>' +
      '<td role="gridcell"><button aria-label="Thu, Oct 22, 2026" onclick="let d=document.querySelector(\'#date\');d.value=\'Thu, Oct 22, 2026\';d.dispatchEvent(new Event(\'change\',{bubbles:true}));document.querySelector(\'#calendar\').hidden=true">22</button></td></tr></table>');
    const result = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true } });
    expect(result.slots[0].startsAt).toBe("2026-10-22T13:00:00.000Z");
  }, 20_000);
  it.each([true, false])("replays ancillary setup only inside its saved route scope (%s)", async scoped => {
    const selected = recipe();
    const bootstrap = "https://example.org/App/GlobalTenantSettings";
    if (scoped) selected.permittedRoutes.push({ origin: "https://example.org", path: "/App/GlobalTenantSettings", methods: ["GET"], queryKeys: [] });
    const fixture = html.replace("</body>", '<script>fetch("/App/GlobalTenantSettings").then(r=>r.json()).then(()=>document.querySelector("#loaded").textContent="Ready").catch(()=>{});</script></body>');
    const deps = browserDeps(fixture), originalFetch = deps.fetch!;
    deps.fetch = vi.fn(async (url, init) => String(url) === bootstrap
      ? new Response(JSON.stringify({ settings: "public", complete: true, empty: true }), { headers: { "content-type": "application/json" } })
      : originalFetch(url, init)) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, deps);
    expect(result.status).toBe(scoped ? "AVAILABLE" : "INCOMPLETE");
    const read = vi.mocked(deps.fetch!).mock.calls.some(([url]) => String(url) === bootstrap);
    expect(read).toBe(scoped);
    if (!scoped) expect(result.slots).toEqual([]);
  }, 20_000);
  it.each(["HEAD", "GET"] as const)("replays a public HEAD only with its explicit saved method (%s)", async allowedMethod => {
    const selected = parseAccessRecipe({ ...recipe(), permittedRoutes: [...recipe().permittedRoutes,
      { origin: "https://example.org", path: "/public-resource", methods: [allowedMethod], queryKeys: [] }] });
    const fixture = html.replace("</body>", '<script>fetch("/public-resource",{method:"HEAD"}).catch(()=>{});</script></body>');
    const deps = browserDeps(fixture), originalFetch = deps.fetch!;
    deps.fetch = vi.fn(async (url, init) => String(url) === "https://example.org/public-resource"
      ? new Response(null, { status: 200 }) : originalFetch(url, init)) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, deps);
    expect(result.status).toBe(allowedMethod === "HEAD" ? "AVAILABLE" : "INCOMPLETE");
    const calls = vi.mocked(deps.fetch!).mock.calls.filter(([url]) => String(url) === "https://example.org/public-resource");
    expect(calls).toHaveLength(allowedMethod === "HEAD" ? 1 : 0);
    if (calls.length) expect(calls[0][1]?.method).toBe("HEAD");
    if (allowedMethod !== "HEAD") expect(result.slots).toEqual([]);
  }, 20_000);
  it.each((['inventory', 'empty'] as const).flatMap(outcome =>
    (["healthy", "denied-script", "denied-resource-kind", "unknown-fatal"] as const).map(mode => ({ mode, outcome }))))(
    "keeps native $mode $outcome replay honest without inventing its initiating document", async ({ mode, outcome }) => {
    const rejected = { code: mode === "denied-resource-kind" ? "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED" : "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED",
      url: "https://cdn.example.net/public.js?build=42",
      method: "GET" as const, resourceType: "script" as const };
    const fixture = outcome === "empty" ? html.replace(/<div class="slot">.*?<\/div>/u, '<div id="empty">No tee times available</div>') : html;
    const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler, options) => {
      if (mode === "denied-script" || mode === "denied-resource-kind") options?.onRequestRejected?.(rejected);
      else if (mode === "unknown-fatal") options?.onFailure?.("NATIVE_REDIRECT_PROVENANCE_REJECTED");
      return { prepare: () => {}, close: async () => {}, lastFailure: undefined, pendingReads: 0,
        releasePlaywrightRoute: route => handler(route) };
    });
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from(browserHtml(fixture)), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { url: route.request().url(), status: 200, headers, body };
    });
    try {
      const selected = recipe();
      if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
      selected.browserTransport = "NATIVE_CHROME";
      const result = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
      expect(native).toHaveBeenCalled();
      if (mode === "healthy") {
        expect(result).toMatchObject({ status: outcome === "empty" ? "EMPTY" : "AVAILABLE", complete: true });
        expect(result.slots).toHaveLength(outcome === "empty" ? 0 : 1);
        return;
      }
      expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
      expect(result.evidence.diagnostic).toEqual(mode === "denied-script" || mode === "denied-resource-kind"
        ? { code: rejected.code, url: "https://cdn.example.net/public.js", method: "GET", resourceType: "script" }
        : { code: "NATIVE_REDIRECT_PROVENANCE_REJECTED" });
    } finally { native.mockRestore(); routing.mockRestore(); }
  }, 20_000);
  it("matches only a successful exact date-bound query or JSON availability response", () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    const request = { url: "https://example.org/availability?date=2026-10-22", method: "GET" };
    expect(matchesAvailabilityResponse(selected, executionInput, request, 200)).toBe(true);
    expect(matchesAvailabilityResponse(selected, executionInput, { ...request, url: request.url.replace("22", "21") }, 200)).toBe(false);
    expect(matchesAvailabilityResponse(selected, executionInput, request, 503)).toBe(false);
    const post = { ...selected, availabilityResponse: { url: "https://example.org/availability", method: "POST" as const,
      date: { source: "JSON_BODY" as const, path: "range.start" }, endDatePath: "range.end" } };
    expect(matchesAvailabilityResponse(post, executionInput, { url: "https://example.org/availability", method: "POST", body: JSON.stringify({ range: { start: executionInput.date, end: executionInput.date } }) }, 200)).toBe(true);
    expect(matchesAvailabilityResponse(post, executionInput, { url: "https://example.org/availability", method: "POST", body: JSON.stringify({ range: { start: executionInput.date, end: "2026-10-23" } }) }, 200)).toBe(false);
  });
  it.each(["success", "failed", "aborted"] as const)("waits for the date response started after the old quiet interval (%s)", async mode => {
    const selected = recipe();
    const fixture = html.replace("</body>", '<script>document.querySelector("#players").addEventListener("change",()=>setTimeout(async()=>{try{const response=await fetch("/availability?date=2026-10-22");if(response.ok){await response.text();document.querySelector(".start").textContent="10:00";}}catch{}},2600));</script></body>');
    const deps = browserDeps(fixture, false);
    deps.fetch = vi.fn(async url => {
      if (String(url).includes("/availability?")) {
        if (mode === "aborted") throw new Error("public read aborted");
        return new Response("current", { status: mode === "failed" ? 503 : 200 });
      }
      return new Response(fixture, { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, deps);
    if (mode === "success") { expect(result.status).toBe("AVAILABLE"); expect(result.slots[0].startsAt).toBe("2026-10-22T14:00:00.000Z"); }
    else { expect(result.complete).toBe(false); expect(result.slots).toEqual([]); }
  }, 20_000);
  it("does not treat arbitrary body presence as complete proof after a fresh response", async () => {
    const selected = recipe(); selected.proof.complete = { selector: "body" };
    const result = await executeAccessRecipe(selected, executionInput, browserDeps(html));
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, evidence: { reason: "SOURCE_PROOF_MISMATCH" } });
    selected.proof.complete = { availabilityResponse: true };
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.availabilityResponse.success = { path: "code", equals: 200 };
    const deps = browserDeps(html);
    const original = deps.fetch!;
    deps.fetch = vi.fn(async (url, init) => String(url).includes("/availability?")
      ? new Response('{"code":200}', { headers: { "content-type": "application/json" } }) : original(url, init)) as typeof fetch;
    expect((await executeAccessRecipe(selected, executionInput, deps)).status).toBe("AVAILABLE");
    deps.fetch = vi.fn(async (url, init) => String(url).includes("/availability?")
      ? new Response('{"code":400,"message":"failed"}', { headers: { "content-type": "application/json" } }) : original(url, init)) as typeof fetch;
    expect(await executeAccessRecipe(selected, executionInput, deps)).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "AVAILABILITY_RESPONSE_FAILED" } });
  }, 20_000);
  it("does not reuse a successful fence after the matching refresh returns an HTTP 200 error", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.proof.complete = { availabilityResponse: true };
    selected.availabilityResponse.success = { path: "code", equals: 200 };
    const fixture = html.replace("</body>", '<script>document.querySelector("#players").addEventListener("change",()=>{fetch("/availability?date=2026-10-22");setTimeout(()=>fetch("/availability?date=2026-10-22"),200)});</script></body>');
    let read = 0;
    const deps = browserDeps(fixture, false);
    deps.fetch = vi.fn(async url => String(url).includes("/availability?") ? new Response(JSON.stringify({ code: ++read === 1 ? 200 : 400 }), { headers: { "content-type": "application/json" } })
      : new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, deps);
    expect(read).toBe(2); expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
  }, 20_000);
  it.each([500, 429])("rejects a required resource failure after the first stable snapshot (%s)", async status => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.permittedRoutes.push({ origin: "https://example.org", path: "/required-data", methods: ["GET"], queryKeys: [] });
    const fixture = html.replace("</body>", '<script>document.querySelector("#players").addEventListener("change",()=>setTimeout(()=>fetch("/required-data"),1000));</script></body>');
    const deps = browserDeps(fixture), original = deps.fetch!;
    let failedRead = false;
    deps.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("/required-data")) { failedRead = true; return new Response("unavailable", { status }); }
      return original(url, init);
    }) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, deps);
    expect(failedRead).toBe(true); expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
    if (status === 429) expect(result.evidence.reason).toBe("PROVIDER_THROTTLED");
  }, 20_000);
  it.each(["local", "new-success", "new-success-late-wrong-date", "new-wrong-date", "new-error", "new-abort", "late-error", "unknown-client", "wrong-duration"] as const)(
    "keeps the inspected PassFactory local-duration exception bound to source and fresh reads (%s)", async mode => {
      const base = recipe();
      if (base.engine !== "BROWSER_DOM") throw new Error("fixture");
      const pageUrl = "https://passfactory.com/ftbb/facility1/?sc=hall1";
      const apiUrl = "https://api.passfactory.io/api/v1/availability-widget/hall-widget";
      const clientPaths = passfactoryDuration.PASSFACTORY_DURATION_CLIENTS.map(client => client.path);
      const selected = parseAccessRecipe({ ...base, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" },
        source: { ...base.source, bookingUrl: pageUrl, providerFamily: "PASSFACTORY" }, pageUrl,
        permittedRoutes: [{ origin: "https://passfactory.com", path: "/ftbb/facility1/", methods: ["GET"], queryKeys: ["sc"] },
          ...clientPaths.map(path => ({ origin: "https://passfactory.com", path, methods: ["GET"], queryKeys: [] })),
          { origin: "https://api.passfactory.io", path: "/api/v1/availability-widget/hall-widget", methods: ["POST"], queryKeys: [] }],
        availabilityResponse: { url: apiUrl, method: "POST", date: { source: "JSON_BODY", path: "start_date" }, endDatePath: "end_date", success: { path: "code", equals: 200 } },
        steps: [{ action: "fill", selector: "#date", value: "{{date}}", purpose: "DATE" },
          { action: "select", selector: "#duration", value: "{{durationMinutes}}", purpose: "DURATION" }],
        proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, complete: { availabilityResponse: true },
          durationMinutes: { selector: "#duration", attribute: "value", format: "INTEGER" } },
        slots: { collection: { selector: ".slot" }, scope: { selector: "article", label: { selector: "h2" }, expectedLabel: "Golf Simulator" },
          startsAt: { selector: ".start" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
      const fixture = `<!doctype html><html><body><h1 id="venue">Example Golf</h1><input id="date" type="date" value="2026-10-20">
        <select id="duration" name="duration"><option value="">Duration</option><option value="30">30 minutes</option><option value="60">1 hour</option></select>
        <article><h2>Golf Simulator</h2><div class="slot"><span class="start">09:00</span></div></article>
        ${clientPaths.map(path => `<script src="${path}"></script>`).join("")}<script>
        function load(date){return fetch('${apiUrl}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({start_date:date,end_date:date,hall_code:'hall1',type:2})}).then(r=>r.json())}
        let loadedDate='';document.querySelector('#date').addEventListener('change',()=>{const date=document.querySelector('#date').value;if(date===loadedDate)return;loadedDate=date;document.querySelector('#duration').value='';load(date)});
        document.querySelector('#duration').addEventListener('change',()=>{
          if('${mode}'==='wrong-duration')document.querySelector('#duration').value='30';
          if('${mode}'.startsWith('new-'))load('${mode}'==='new-wrong-date'?'2026-10-23':document.querySelector('#date').value).catch(()=>{});
          if('${mode}'==='new-success-late-wrong-date')setTimeout(()=>load('2026-10-23').catch(()=>{}),1100);
          if('${mode}'==='late-error')setTimeout(()=>load(document.querySelector('#date').value).catch(()=>{}),1100);
        });</script></body></html>`;
      let reads = 0;
      const observedClients = new Set<string>();
      // The fixture has its own harmless client body; the separate capability
      // unit tests assert the real inspected URL/hash pin cannot be substituted.
      const client = vi.spyOn(passfactoryDuration, "isInspectedPassfactoryDurationClient").mockImplementation(url => {
        const known = clientPaths.some(path => url === `https://passfactory.com${path}`);
        if (known) observedClients.add(url);
        return known && mode !== "unknown-client";
      });
      const deps = browserDeps(fixture, false);
      deps.fetch = vi.fn(async url => {
        if (String(url) === apiUrl) {
          reads++;
          if (reads > 1 && mode === "new-abort") throw new Error("fixture abort");
          return new Response(JSON.stringify({ code: reads > 1 && ["new-error", "late-error"].includes(mode) ? 400 : 200 }), { headers: { "content-type": "application/json" } });
        }
        if (clientPaths.some(path => String(url).endsWith(path))) return new Response("window.harmlessFixture=true;", { headers: { "content-type": "text/javascript" } });
        return new Response(fixture, { headers: { "content-type": "text/html" } });
      }) as typeof fetch;
      try {
        const result = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, deps);
        expect(observedClients.size).toBe(2);
        if (["local", "new-success"].includes(mode)) { expect(result.status).toBe("AVAILABLE"); expect(result.slots).toHaveLength(1); }
        else { expect(result.complete).toBe(false); expect(result.slots).toEqual([]); }
        if (mode === "local") expect(reads).toBe(1);
        if (["new-wrong-date", "new-error", "new-abort", "late-error"].includes(mode)) expect(reads).toBe(2);
        if (mode === "new-success-late-wrong-date") expect(reads).toBe(3);
        if (mode === "unknown-client") expect(result.evidence.reason).toBe("UNVERIFIED_CLIENT_DURATION");
      } finally { client.mockRestore(); }
    }, 20_000);
  it.each([
    ["October 2026", "22", "active day", "AVAILABLE"],
    ["October 2026", "21", "active day", "INCOMPLETE"],
    ["September 2026", "22", "active day", "INCOMPLETE"],
    ["October 2025", "22", "active day", "INCOMPLETE"],
    ["October 2026", "22", "day", "INCOMPLETE"],
  ])("proves visible calendar date parts %s/%s with %s", async (monthYear, day, classes, expected) => {
    const selected = recipe();
    selected.proof.date = { kind: "DATE_PARTS", monthYear: { selector: "#month-year" }, day: { selector: "#selected-day" } };
    const fixture = html.replace('<input id="date" value="2026-10-22">',
      `<table><thead><tr><th id="month-year">${monthYear}</th></tr></thead><tbody><tr><td id="selected-day" class="${classes}">${day}</td></tr></tbody></table>`);
    const result = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
    expect(result.status).toBe(expected);
    expect(result.evidence.dateVerified).toBe(expected === "AVAILABLE");
  }, 20_000);
  it.each([
    ["October 2026", "22", "button", "days daySelected", "AVAILABLE"],
    ["October 2026", "21", "button", "days daySelected", "INCOMPLETE"],
    ["September 2026", "22", "button", "days daySelected", "INCOMPLETE"],
    ["October 2025", "22", "button", "days daySelected", "INCOMPLETE"],
    ["October 2026", "22", "button", "days", "INCOMPLETE"],
    ["October 2026", "22", "button", "daySelected", "INCOMPLETE"],
    ["October 2026", "22", "button", "days daySelectedOther", "INCOMPLETE"],
    ["October 2026", "22", "span", "days daySelected", "INCOMPLETE"],
  ])("proves observed button calendar selected-state %s/%s in %s.%s", async (monthYear, day, tag, classes, expected) => {
    const selected = recipe();
    selected.proof.date = { kind: "DATE_PARTS", monthYear: { selector: "#month-year" }, day: { selector: "#selected-day" } };
    const fixture = html.replace('<input id="date" value="2026-10-22">',
      `<div class="calendar"><div id="month-year">${monthYear}</div><${tag} id="selected-day" class="${classes}">${day}</${tag}></div>`);
    const result = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
    expect(result.status).toBe(expected);
    expect(result.evidence.dateVerified).toBe(expected === "AVAILABLE");
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("allows a bounded large %s public build script while retaining smaller data caps", async browserTransport => {
    const controller = nativeControllerFixture();
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.browserTransport = browserTransport;
    const assetPath = "/_next/static/0123456789abcdef0123456789abcdef/_buildManifest.js";
    selected.permittedRoutes.push({ origin: "https://example.org", path: assetPath, methods: ["GET"], queryKeys: [] });
    const page = html.replace("</body>", `<script src="${assetPath}"></script></body>`);
    const scriptBody = `/*${"x".repeat(14_500_000)}*/`;
    const limits: Array<{ kind: string; limit: number | undefined }> = [];
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async (route, _signal, limit) => {
      const script = route.request().resourceType() === "script";
      const body = Buffer.from(script ? scriptBody : browserHtml(page));
      const headers = { "content-type": script ? "text/javascript" : "text/html" };
      limits.push({ kind: route.request().resourceType(), limit });
      await route.fulfill({ status: 200, headers, body });
      return { url: route.request().url(), status: 200, headers, body };
    });
    const pinned = vi.spyOn(pinnedTransport, "createAddressPinnedPublicFetchTransport").mockImplementation(options => {
      const script = options.maxResponseBytes === 16_000_000;
      limits.push({ kind: script ? "script" : "document", limit: options.maxResponseBytes });
      expect(() => options.parseUrl(`https://unscoped.example.org${assetPath}`)).toThrow();
      if (script) expect(options.parseUrl(`https://example.org${assetPath}`).pathname).toBe(assetPath);
      return vi.fn(async () => new Response(script ? scriptBody : browserHtml(page), { headers: { "content-type": script ? "text/javascript" : "text/html" } })) as typeof fetch;
    });
    try {
      const deps = browserDeps(page); delete deps.fetch;
      const families: string[] = [];
      deps.requestLease = async (family, work) => { families.push(family); return { acquired: true, value: await work() }; };
      const result = await executeAccessRecipe(selected, executionInput, deps);
      expect(result.status).toBe("AVAILABLE");
      expect(families.length).toBeGreaterThanOrEqual(2);
      expect(new Set(families)).toEqual(new Set(["example.org"]));
      expect(limits).toContainEqual({ kind: "script", limit: 16_000_000 });
      expect(limits).toContainEqual({ kind: "document", limit: 2_000_000 });
    } finally { native.mockRestore(); pinned.mockRestore(); controller.mockRestore(); }
  }, 20_000);
  it("observes a recipe-permitted SPA frame URL before its public read policy", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.permittedRoutes.push({ origin: "https://example.org", path: "/widget/resource-1", methods: ["GET"], queryKeys: [] },
      { origin: "https://example.org", path: "/fresh-times", methods: ["GET"], queryKeys: [] });
    const observe = vi.fn();
    const original = publicReadPolicy.createPassfactoryPublicReadPolicy;
    const policy = vi.spyOn(publicReadPolicy, "createPassfactoryPublicReadPolicy").mockImplementation(() => {
      const rules = original();
      return { ...rules, observeWidgetUrl: (value: string) => { observe(value); rules.observeWidgetUrl(value); } };
    });
    const fixture = html.replace("</body>", '<script>history.replaceState(null,"","/widget/resource-1");fetch("/fresh-times");</script></body>');
    try {
      const result = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
      expect(result.status).toBe("AVAILABLE");
      expect(observe).toHaveBeenCalledWith("https://example.org/widget/resource-1");
    } finally { policy.mockRestore(); }
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("removes only the approved public ForeUP API key before %s transport", async browserTransport => {
    const controller = nativeControllerFixture();
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.browserTransport = browserTransport;
    selected.permittedRoutes.push({ origin: "https://foreupsoftware.com", path: "/index.php/api/booking/times", methods: ["GET"], queryKeys: ["date"] });
    const fixture = html.replace("</body>", '<script>fetch("https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-22&api_key=PUBLIC_KEY");</script></body>');
    const seen: string[] = [];
    const deps = browserDeps(fixture);
    deps.fetch = vi.fn(async url => { seen.push(String(url)); return new Response(browserHtml(fixture), { headers: { "content-type": "text/html" } }); }) as typeof fetch;
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async (route, _signal, _limit, _abort, canonicalUrl) => {
      seen.push(canonicalUrl ?? route.request().url());
      const body = Buffer.from(browserHtml(fixture)), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, headers, body });
      return { url: canonicalUrl ?? route.request().url(), status: 200, headers, body };
    });
    try {
      expect((await executeAccessRecipe(selected, executionInput, deps)).status).toBe("AVAILABLE");
      expect(seen).toContain("https://foreupsoftware.com/index.php/api/booking/times?date=2026-10-22");
      expect(seen.some(url => url.includes("api_key"))).toBe(false);
    } finally { native.mockRestore(); controller.mockRestore(); }
  }, 20_000);
  it.each([
    ['<div id="players-choice">Players <a data-value="2" id="choice">2</a></div>', "AVAILABLE"],
    ['<div id="players-choice">Players <a href="/reserve" data-value="2" id="choice">2</a></div>', "FAILED"],
    ['<div id="unrelated">Menu <a data-value="2" id="choice">2</a></div>', "FAILED"],
    ['<div id="players-choice">Players <a data-value="2" aria-disabled="true" id="choice">2</a></div>', "FAILED"],
  ])("accepts only a bounded public data-value filter choice: %s", async (control, expected) => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps.push({ action: "clickFilter", selector: "#choice", text: "2", purpose: "SELECT_FILTER" });
    const fixture = html.replace("</body>", `${control}<script>document.querySelector("#choice").onclick=()=>document.querySelector("#players").value="2";</script></body>`);
    expect((await executeAccessRecipe(selected, executionInput, browserDeps(fixture))).status).toBe(expected);
  }, 20_000);
  it("allows a public calendar table header to move to the next month", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps.push({ action: "clickFilter", selector: "#next-month", text: ">", purpose: "NEXT_MONTH" });
    const fixture = html.replace("</body>", '<table class="datepicker"><thead><tr><th id="next-month">&gt;</th></tr></thead></table></body>');
    expect((await executeAccessRecipe(selected, executionInput, browserDeps(fixture))).status).toBe("AVAILABLE");
  }, 20_000);
  it("reuses one bounded day selector for two requested dates and rejects duplicate visible days", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps.push({ action: "clickFilter", selector: "button.day", text: "{{day}}", purpose: "SELECT_DATE" });
    const calendar = '<div class="calendar"><button class="day">22</button><button class="day">23</button></div>';
    const fixture = html.replace("</body>", `${calendar}<script>document.querySelectorAll("button.day").forEach(button=>button.onclick=()=>document.querySelector("#date").value="2026-10-"+button.textContent);</script></body>`);
    const first = await executeAccessRecipe(selected, executionInput, browserDeps(fixture));
    const second = await executeAccessRecipe(selected, { ...executionInput, date: "2026-10-23" }, browserDeps(fixture));
    expect(first.status).toBe("AVAILABLE"); expect(second.status).toBe("AVAILABLE");
    expect(second.slots[0].startsAt).toBe("2026-10-23T13:00:00.000Z");
    const duplicate = await executeAccessRecipe(selected, executionInput, browserDeps(fixture.replace('<button class="day">23</button>', '<button class="day">22</button>')));
    expect(duplicate.status).toBe("FAILED"); expect(duplicate.evidence.reason).toBe("AMBIGUOUS_CONTROL");
  }, 30_000);
  it("reuses a selectDate action across months while requiring the final source date", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps.push({ action: "selectDate", monthYearSelector: "#month-year", nextSelector: "#next-month", previousSelector: "#previous-month", daySelector: "button.day" });
    const calendar = '<div class="calendar"><span id="month-year">October 2026</span><button id="next-month">Next month</button><button id="previous-month">Previous month</button><button class="day">22</button></div>';
    const fixture = html.replace("</body>", `${calendar}<script>let month=10;document.querySelector("#next-month").onclick=()=>{month++;document.querySelector("#month-year").textContent="November 2026"};document.querySelector("button.day").onclick=()=>document.querySelector("#date").value="2026-"+month+"-22";</script></body>`);
    const result = await executeAccessRecipe(selected, { ...executionInput, date: "2026-11-22" }, browserDeps(fixture));
    expect(result.status).toBe("AVAILABLE");
    expect(result.slots[0].startsAt).toBe("2026-11-22T14:00:00.000Z");
    const stale = await executeAccessRecipe(selected, { ...executionInput, date: "2026-11-22" }, browserDeps(fixture.replace('"2026-"+month+"-22"', '"2026-10-22"')));
    // The stale selected date prevents the required November response before DOM proof is considered.
    expect(stale.status).toBe("INCOMPLETE"); expect(stale.slots).toEqual([]);
    expect(stale.evidence.reason).toBe("AVAILABILITY_RESPONSE_UNCONFIRMED");
  }, 30_000);
  it("waits for delayed availability reads before accepting visible slot proof", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.permittedRoutes.push({ origin: "https://example.org", path: "/fresh-times", methods: ["GET"], queryKeys: [] });
    const fixture = html.replace("</body>", '<script>document.querySelector("#players").addEventListener("change",async()=>{' +
      'const response=await fetch("/fresh-times");await response.text();document.querySelector(".start").textContent="10:00";});</script></body>');
    const dependencies = browserDeps(fixture);
    dependencies.fetch = vi.fn(async url => {
      if (String(url).endsWith("/fresh-times")) {
        await new Promise(resolve => setTimeout(resolve, 2200));
        return new Response("ready", { headers: { "content-type": "text/plain" } });
      }
      return new Response(browserHtml(fixture), { headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const result = await executeAccessRecipe(selected, executionInput, dependencies);
    expect(result.status).toBe("AVAILABLE");
    expect(result.slots[0].startsAt).toBe("2026-10-22T14:00:00.000Z");
  }, 20_000);
  it("runs browser date handling in the verified course timezone", async () => {
    const selected = recipe();
    selected.source.timeZone = "America/Los_Angeles";
    const fixture = html.replace("</body>", '<script>if(Intl.DateTimeFormat().resolvedOptions().timeZone!=="America/Los_Angeles")document.querySelector("#venue").textContent="Wrong timezone";</script></body>');
    const result = await executeAccessRecipe(selected, { ...executionInput, timeZone: "America/Los_Angeles" }, browserDeps(fixture));
    expect(result.status).toBe("AVAILABLE"); expect(result.slots[0].startsAt).toBe("2026-10-22T16:00:00.000Z");
  }, 20_000);
  it("rejects a reservation control even when labelled as a filter step", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps = [{ action: "clickFilter", selector: "#book", text: "Book Now", purpose: "RUN_SEARCH" }];
    const result = await executeAccessRecipe(selected, executionInput, browserDeps(html.replace("</body>", '<button id="book">Book Now</button></body>')));
    expect(result.status).toBe("FAILED"); expect(result.evidence.reason).toBe("UNSAFE_CONTROL");
    expect(result.evidence.diagnostic).toMatchObject({ code: "UNSAFE_CONTROL", stepIndex: 0 });
  }, 20_000);
  it("fails incomplete when a required unscoped request occurs", async () => {
    const result = await executeAccessRecipe(recipe(), executionInput, browserDeps(html.replace("</body>", '<script src="https://unscoped.example.org/slots.js"></script></body>')));
    expect(result.status).toBe("INCOMPLETE"); expect(result.slots).toEqual([]);
    expect(result.evidence.diagnostic).toEqual({ code: "UNSCOPED_REQUEST", url: "https://unscoped.example.org/slots.js", method: "GET", resourceType: "script" });
  }, 20_000);
  it("reports the terminal control step when an earlier resource also failed", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.steps = [{ action: "select", selector: "#missing-players", value: "{{players}}", purpose: "PLAYERS" }];
    const deps = browserDeps(html.replace("</body>", '<script src="https://unscoped.example.org/slots.js"></script></body>'));
    const result = await executeAccessRecipe(selected, executionInput, deps);
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: {
      reason: "AMBIGUOUS_CONTROL", diagnostic: { code: "AMBIGUOUS_CONTROL", stepIndex: 0,
        url: "https://example.org/tee-times", method: "GET", resourceType: "document" },
    } });
    expect(vi.mocked(deps.fetch!).mock.calls.every(([url]) => !String(url).includes("unscoped.example.org"))).toBe(true);
  }, 20_000);
  it("skips decorative images without classifying complete DOM evidence as blocked", async () => {
    const result = await executeAccessRecipe(recipe(), executionInput, browserDeps(html.replace("</body>", '<img src="https://unscoped.example.org/map.png"></body>')));
    expect(result.status).toBe("AVAILABLE");
  }, 20_000);
  it("ignores exact Google telemetry scripts without making an unscoped network request", async () => {
    const deps = browserDeps(html.replace("</body>", '<script src="https://www.googletagmanager.com/gtag/js?id=G-PUBLIC"></script></body>'));
    expect((await executeAccessRecipe(recipe(), executionInput, deps)).status).toBe("AVAILABLE");
    expect(vi.mocked(deps.fetch!).mock.calls.every(([url]) => !String(url).includes("googletagmanager"))).toBe(true);
  }, 20_000);
  it("ignores payment-client scripts that cannot contribute read-only availability", async () => {
    const deps = browserDeps(html.replace("</body>", '<script src="https://js.stripe.com/dahlia/stripe.js"></script><script src="https://js.stripe.com/terminal/v1"></script></body>'));
    expect((await executeAccessRecipe(recipe(), executionInput, deps)).status).toBe("AVAILABLE");
    expect(vi.mocked(deps.fetch!).mock.calls.every(([url]) => !String(url).includes("stripe.com"))).toBe(true);
  }, 20_000);
  it("reports ambiguous display proof instead of claiming empty availability", async () => {
    const result = await executeAccessRecipe(recipe(), executionInput, browserDeps(html.replace('</body>', '<p id="loaded">Other container</p></body>')));
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "AMBIGUOUS_PROOF_FIELD" } });
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("preserves %s throttling as a retryable transport result", async browserTransport => {
    const controller = nativeControllerFixture();
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.browserTransport = browserTransport;
    const deps = browserDeps(html); deps.fetch = vi.fn(async () => new Response("limited", { status: 429 })) as typeof fetch;
    const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
      const body = Buffer.from("limited"), headers = { "content-type": "text/plain" };
      await route.fulfill({ status: 429, headers, body });
      return { url: route.request().url(), status: 429, headers, body };
    });
    try {
      expect(await executeAccessRecipe(selected, executionInput, deps)).toMatchObject({ status: "FAILED", complete: false,
        evidence: { reason: "PROVIDER_THROTTLED", diagnostic: { code: "HTTP_429" } } });
    } finally { native.mockRestore(); controller.mockRestore(); }
  }, 20_000);
  it("requires actual empty-state text rather than an arbitrary visible container", async () => {
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    selected.proof.empty = { selector: "#empty" };
    const noRows = html.replace(/<div class="slot">.*?<\/div>/u, '<div id="empty">Calendar</div>');
    const unproven = await executeAccessRecipe(selected, executionInput, browserDeps(noRows));
    expect(unproven.status).toBe("INCOMPLETE");
    const proven = await executeAccessRecipe(selected, executionInput, browserDeps(noRows.replace(">Calendar<", ">No tee times available<")));
    expect(proven.status).toBe("EMPTY");
  }, 25_000);
  it("selects an exact public rental product and derives only its proven duration", async () => {
    const base = recipe();
    if (base.engine !== "BROWSER_DOM") throw new Error("fixture");
    const selected = parseAccessRecipe({ ...base, target: { ...base.target, kind: "SIMULATOR", offeringId: "offering-1" },
      steps: [{ action: "selectProduct", selector: "#choose", productSelector: "#product" }],
      slots: { ...base.slots, scope: { selector: "#rental", label: { selector: "h2" }, expectedLabel: "Golf simulator" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
    const fixture = html.replace('<p id="loaded">Ready</p>', '<article id="product"><h2>Golf simulator rental</h2>1 hour<button id="choose">Book</button></article><p id="loaded" hidden>Ready</p>')
      .replace(/(<div class="slot">.*?<\/div>)/u, '<article id="rental"><h2>Golf simulator</h2>$1</article>')
      .replace('value="2026-10-22"', 'value="Thursday, October22,2026"')
      .replace("</body>", '<script>document.querySelector("#choose").addEventListener("click",()=>{document.querySelector("#loaded").hidden=false;document.querySelector("#product").hidden=true;});</script></body>');
    const result = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(fixture));
    expect(result.status).toBe("AVAILABLE");
    expect(result.slots[0].endsAt).toBe("2026-10-22T14:00:00.000Z");
    expect(result.evidence.durationVerified).toBe(true);
    const wrong = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 120 }, browserDeps(fixture));
    expect(wrong.status).toBe("FAILED"); expect(wrong.evidence.reason).toBe("UNSAFE_PRODUCT_SELECTION");
  }, 30_000);
  it("replays a duration-price product within the exact public bay card", async () => {
    const base = recipe();
    if (base.engine !== "BROWSER_DOM") throw new Error("fixture");
    const selected = parseAccessRecipe({ ...base, target: { ...base.target, kind: "SIMULATOR", offeringId: "offering-1" },
      steps: [{ action: "selectProduct", selector: "#choose", productSelector: "#product" }],
      slots: { ...base.slots, scope: { selector: "#rental", label: { selector: "h2" }, expectedLabel: "Golf simulator" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
    const fixture = html.replace('<p id="loaded">Ready</p>', '<article id="product"><h2>Bay 1 Reservation</h2><div><button id="choose">1 hour $40</button><button>2 hours $80</button></div></article><p id="loaded" hidden>Ready</p>')
      .replace(/(<div class="slot">.*?<\/div>)/u, '<article id="rental"><h2>Golf simulator</h2>$1</article>')
      .replace('value="2026-10-22"', 'value="Thursday, October22,2026"')
      .replace("</body>", '<script>document.querySelector("#choose").addEventListener("click",()=>{document.querySelector("#loaded").hidden=false;document.querySelector("#product").hidden=true;});</script></body>');
    const result = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(fixture));
    expect(result.status).toBe("AVAILABLE");
    expect(result.evidence.durationVerified).toBe(true);
    expect(result.slots[0].endsAt).toBe("2026-10-22T14:00:00.000Z");
    const wrongCard = parseAccessRecipe({ ...selected, steps: [{ action: "selectProduct", selector: "#choose", productSelector: "body" }] });
    const rejected = await executeAccessRecipe(wrongCard, { ...executionInput, durationMinutes: 60 }, browserDeps(fixture));
    expect(rejected.status).toBe("FAILED");
    expect(rejected.evidence.reason).toBe("UNSAFE_PRODUCT_SELECTION");
  }, 30_000);
  it("binds simulator rows to the exact observed resource label across card reordering", async () => {
    const base = recipe();
    if (base.engine !== "BROWSER_DOM") throw new Error("fixture");
    const selected = parseAccessRecipe({ ...base, target: { ...base.target, kind: "SIMULATOR", offeringId: "offering-1" }, steps: [],
      proof: { ...base.proof, durationMinutes: { selector: "#duration" } },
      slots: { ...base.slots, scope: { selector: "article.resource", label: { selector: "h2" }, expectedLabel: "Golf Simulator" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
    const slot = /<div class="slot">.*?<\/div>/u.exec(html)![0];
    const golf = `<article class="resource"><h2>Golf Simulator</h2>${slot}</article>`;
    const other = `<article class="resource"><h2>Multi-Sport</h2>${slot.replace("09:00", "10:00")}</article>`;
    const build = (cards: string) => html.replace(slot, `<p id="duration">60</p>${cards}`);
    const resourceIds: string[] = [];
    for (const cards of [golf + other, other + golf]) {
      const result = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(build(cards)));
      expect(result.status).toBe("AVAILABLE"); expect(result.slots).toHaveLength(1);
      expect(result.slots[0].startsAt).toBe("2026-10-22T13:00:00.000Z");
      expect(result.slots[0].resourceId).toMatch(/^dom-label:[a-f0-9]{64}$/u);
      resourceIds.push(result.slots[0].resourceId!);
    }
    expect(new Set(resourceIds).size).toBe(1);
    if (selected.engine !== "BROWSER_DOM" || !selected.slots.scope) throw new Error("fixture");
    const secondRecipe = parseAccessRecipe({ ...selected, slots: { ...selected.slots, scope: { ...selected.slots.scope, expectedLabel: "Golf Simulator B" } } });
    const secondResource = await executeAccessRecipe(secondRecipe, { ...executionInput, durationMinutes: 60 }, browserDeps(build(golf.replace("Golf Simulator", "Golf Simulator B"))));
    expect(secondResource.status).toBe("AVAILABLE"); expect(secondResource.slots[0].resourceId).not.toBe(resourceIds[0]);
    const missing = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(build(other)));
    expect(missing).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "RESOURCE_IDENTITY_MISMATCH" } });
    const ambiguous = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(build(golf + golf)));
    expect(ambiguous).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "AMBIGUOUS_RESOURCE_SCOPE" } });
    const emptyGolf = '<article class="resource"><h2>Golf Simulator</h2></article>';
    const otherEmpty = '<article class="resource"><h2>Multi-Sport</h2><p id="empty">No sessions available</p></article>';
    const wrongEmpty = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(build(emptyGolf + otherEmpty)));
    expect(wrongEmpty).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "EMPTY_NOT_PROVEN" } });
    const correctEmpty = await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(build(emptyGolf.replace('</article>', '<p id="empty">No sessions available</p></article>') + otherEmpty)));
    expect(correctEmpty).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
  }, 30_000);
  it("rejects a broad wrapper or nested resource cards even when a nested Golf label is unique", async () => {
    const base = recipe();
    if (base.engine !== "BROWSER_DOM") throw new Error("fixture");
    const slot = /<div class="slot">.*?<\/div>/u.exec(html)![0];
    const selected = parseAccessRecipe({ ...base, target: { ...base.target, kind: "SIMULATOR", offeringId: "offering-1" }, steps: [],
      proof: { ...base.proof, durationMinutes: { selector: "#duration" } },
      slots: { ...base.slots, scope: { selector: ".widget", label: { selector: "#golf-label" }, expectedLabel: "Golf Simulator" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
    const cards = `<article><h2 id="golf-label">Golf Simulator</h2>${slot}</article><article><h2>Multi-Sport</h2>${slot}</article>`;
    const fixture = html.replace(slot, `<p id="duration">60</p><div class="widget">${cards}</div>`);
    expect(await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(fixture)))
      .toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "RESOURCE_SCOPE_NOT_CARD" } });
    const nested = html.replace(slot, `<p id="duration">60</p><div class="widget"><h2 id="golf-label">Golf Simulator</h2><div class="widget">${slot}</div></div>`);
    expect(await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(nested)))
      .toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "RESOURCE_SCOPE_NOT_CARD" } });
    if (selected.engine !== "BROWSER_DOM" || !selected.slots.scope) throw new Error("fixture");
    selected.slots.scope.label = { selector: ":scope > h2" };
    const directHeadingWrapper = html.replace(slot, `<p id="duration">60</p><div class="widget"><h2>Golf Simulator</h2><article class="golf-panel"><div>Golf Simulator</div>${slot}</article><section class="sport-panel"><div>Multi-Sport</div>${slot}</section></div>`);
    expect(await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(directHeadingWrapper)))
      .toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "RESOURCE_SCOPE_NOT_CARD" } });
    const emptyMixedPanels = directHeadingWrapper.replaceAll(slot, "");
    expect(await executeAccessRecipe(selected, { ...executionInput, durationMinutes: 60 }, browserDeps(emptyMixedPanels)))
      .toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "RESOURCE_SCOPE_NOT_CARD" } });
  }, 20_000);
});
