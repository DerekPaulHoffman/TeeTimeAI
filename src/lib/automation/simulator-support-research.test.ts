// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Route } from "@playwright/test";
import { fetchYourGolfBookingAvailability } from "@/lib/simulators/providers/your-golf-booking";
import { projectAcuityPublicConfiguration } from "@/lib/simulators/providers/acuity";
import { projectGolfBookPublicConfiguration } from "@/lib/simulators/providers/golfbook";
import { collectSimulatorSupportResearch, detectSimulatorResearchAccessControls, extractSimulatorPublicCalendar, summarizeSimulatorPublicJsonShape, summarizeSimulatorSupportPublicHtml, type SimulatorResearchDependencies } from "./simulator-support-research";
import { classifySimulatorSupportFailure, type SimulatorResearchFailurePhase } from "./simulator-support-failure";
import { readSimulatorResearchState } from "./simulator-support-research-policy";

const source = "https://venue.example.test";
const booking = "https://booking.trackmangolf.com/venues/golf-oasis/booking/bays";
const instant = new Date("2026-10-06T16:00:00Z");
const lease = vi.fn(async (_host: string, worker: () => Promise<unknown>) => ({ acquired: true as const, value: await worker() })) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
const response = (body: string, status = 200, type = "text/html") => new Response(body, { status, headers: { "content-type": type } });
const persistedDiagnostic = (configurationDiagnostic: unknown) => {
  const fingerprint = "a".repeat(64);
  return readSimulatorResearchState({ version: 1, sourceFingerprint: fingerprint, readCount: 1,
    history: [{ source: "booking", requestedUrl: booking, sourceUrl: booking, observedAt: instant.toISOString(),
      httpStatus: 200, rendered: true, outcome: "READ", configurationDiagnostic }],
    links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null }, fingerprint).history[0].configurationDiagnostic;
};

function publishedConfig(patch: Record<string, unknown> = {}) {
  const config = {
    venue: { id: 1357, slug: "golf-oasis", timezone: "America/New_York", status: "live", maintenanceMode: false, owner: { email: "secret@example.test" } },
    ranges: { items: [{ id: 1397, venue: 1357, slug: "bays", bookable: true, slotDuration: 30, slotInterval: 30, slotIntervalStart: 0, assumeOpen: true, bookingUi: "standard", customerBookingUi: "slots", maxBookAheadValue: 2, maxBookAheadUnit: "week", openingTimes: [], openingHours: "Mo 09:00-20:00 open" }] },
    bays: { items: [{ id: 9224, venue: 1357, range: 1397, type: "simulator", bookable: true, options: [21451, 9999], appliedOptions: [21451], restrictedTimes: [] }],
      bayOptions: [{ id: 21451, venue: 1357, name: "Public Rate", adminOnly: false, disabled: false, waitlisted: false, type: "simulator", category: "baytime", duration: 1, durationType: "slot", minBookingDuration: 1, maxBookingDuration: 8, minPlayers: 1, maxPlayers: 4, bufferPeriodMinutes: 0, restrictions: [], appliedRequiredPerks: [] },
        { id: 9999, name: "Private Member", adminOnly: true, customerEmail: "secret@example.test" }] },
    user: { token: "never-return-this", email: "secret@example.test" },
    ...patch,
  };
  return `<h1>Hourly simulator bays</h1><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialReduxState: config } } })}</script>`;
}

const acuitySource = "https://app.acuityscheduling.com/schedule/2991fba2";
const golfBookSource = "https://public-bays.golfbook.in/calendar.php";
const uscheduleSource = "https://clients.uschedule.com/syntheticvenue/booking";
const uscheduleHtml = `<select id="select_service"><option value="29547" selected>Simulator Rental</option></select>
  <select id="select_length"><option value="60" selected>1 hour</option></select>
  <div class="next_avail_results"><div class="next_avail_item" data-time="101020261600" data-empid="0">Public start</div></div>
  <a id="more_next_avail">Show more</a><script>var lastAvailTime = '101020261600';</script>
  <input name="customerEmail" value="secret@example.test"><input name="sessionToken" value="never-persist-this">`;
const tenantRoot = "https://onegolfhaven.as.me/";
function publishedBootstrap(options: { navigationUrl?: string | null; navigationTitle?: string; buttonUrl?: string; buttonHidden?: boolean; bannerHidden?: boolean } = {}) {
  const state: Record<string, unknown> = { siteData: { snapshot: { properties: { navigation: options.navigationUrl === null ? [] : [
    { tab: false, link: { external: options.navigationUrl ?? tenantRoot }, type: "external", title: options.navigationTitle ?? "BOOK A TEE TIME", children: [] },
  ] } }, page: { properties: { contentAreas: { banner: { hidden: options.bannerHidden ?? false, content: { type: "block", layout: "banner-text-below",
    purpose: "banner@^1.2.2", elements: [{ purpose: "text-1", properties: { label: "Welcome" } },
      { purpose: "text-2", properties: { label: "Public golf" } },
      { purpose: "button-1", properties: { hidden: options.buttonHidden ?? false, label: "BOOK NOW\n", link: {
        tab: false, type: "external", link: { shopAll: true, external: options.buttonUrl ?? tenantRoot, squareAppointment: "" },
      } } }] } } } } } } };
  return `<div id='app'></div><script>window.__BOOTSTRAP_STATE__ = ${JSON.stringify(state)};</script>`;
}
function acuityConfig(patch: Record<string, unknown> = {}) {
  const business = { id: 34536426, ownerKey: "2991fba2", timezone: "America/New_York", includesAdminOnly: false, isExpired: false,
    description: "Up to 6 People Per Bay", calendars: { "Private-name-must-not-return": [{ id: 11388341, name: "Bay 1", timezone: "America/New_York" }] },
    appointmentTypes: { "Private-group-must-not-return": [
      { id: 73234482, name: "Simulator Booking 1 HR", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341], price: "70.00" },
      { id: 9999, name: "Simulator Member Booking", duration: 60, active: true, private: true, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] },
    ] }, client: { email: "secret@example.test", token: "private-token" }, ...patch };
  return `<h1>Public hourly rentals</h1><script>var BUSINESS = ${JSON.stringify(business)}; var CLIENT_INFO = { token: "private-client-token" };</script>`;
}
function golfBookConfig() {
  return '<input id="waitlist_date" value="2026-10-10"><input id="waitlist_template" value="53"><input id="template_min_booking_mins" value="60"><input id="template_max_booking_mins" value="360"><input id="template_booking_increment_mins" value="30"><input id="csrf_token" value="private-token"><input name="customerEmail" value="secret@example.test"><table id="bookingsheet"><thead><tr><th id="th_1">Private bay name</th><th id="th_20">Private second name</th></tr></thead><tbody><tr><td class="status_1" onclick="redirect(\'reserve\',\'private-reserve-values\')">Free</td></tr></tbody></table>';
}

type RequestFixture = { url: string; method?: string; headers?: Record<string, string>; headersFailure?: unknown; requestFailure?: unknown; kind?: string; frame?: "main" | "child" | "popup" };
function renderedBrowser(requests: RequestFixture[], html = "<h1>Public rentals</h1><a href='/booking'>Book hourly</a>", concurrentSecondary = false) {
  let handler!: (route: Route) => Promise<void>;
  let socketHandler!: (socket: { close: (options: unknown) => Promise<void> }) => Promise<unknown>;
  const mainFrame = {}, childFrame = {}, popupFrame = {};
  const routes: Array<{ abort: ReturnType<typeof vi.fn>; fulfill: ReturnType<typeof vi.fn> }> = [];
  const page = {
    mainFrame: () => mainFrame, url: () => requests[0].url,
    content: vi.fn(async () => html),
    goto: vi.fn(async () => {
      const run = async (request: RequestFixture) => {
        const entry = { abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined) }; routes.push(entry);
        await handler({ ...entry, request: () => {
          if (request.requestFailure !== undefined) throw request.requestFailure;
          return { url: () => request.url, method: () => request.method ?? "GET", allHeaders: async () => {
          if (request.headersFailure !== undefined) throw request.headersFailure;
          return request.headers ?? { "user-agent": "Public research browser" };
        },
          isNavigationRequest: () => !request.kind || request.kind === "document", resourceType: () => request.kind ?? "document",
           frame: () => request.frame === "child" ? childFrame : request.frame === "popup" ? popupFrame : mainFrame };
        } } as unknown as Route);
      };
      if (concurrentSecondary) { await run(requests[0]); await Promise.all(requests.slice(1).map(run)); }
      else for (const request of requests) await run(request);
      return { status: () => 200 };
    }),
  };
  const context = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined),
    route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }),
    routeWebSocket: vi.fn(async (_pattern: string, callback: typeof socketHandler) => { socketHandler = callback; }),
  };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => undefined) };
  return { page, context, browser, routes, socket: async () => { const close = vi.fn(async () => undefined); await socketHandler({ close }); return close; },
    factory: async () => browser as unknown as Awaited<ReturnType<NonNullable<SimulatorResearchDependencies["browser"]>>> };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("owned known-reader public configuration", () => {
  it("projects only the structural USchedule tenant, selected public service and verified default hour", async () => {
    const fetch = vi.fn(async () => response(uscheduleHtml));
    const result = await collectSimulatorSupportResearch({ url: uscheduleSource }, { fetch, lease, now: () => instant });
    expect(result.publicConfiguration).toEqual({ family: "USCHEDULE", tenant: "syntheticvenue", serviceId: "29547",
      durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    expect(result.publicConfiguration).not.toHaveProperty("durationOptionsMinutes");
    expect(JSON.stringify(result.publicConfiguration)).not.toMatch(/secret@example|never-persist-this|customer|session/u);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("returns inert Acuity rental metadata from one existing owned read without private fields", async () => {
    const fetch = vi.fn(async () => response(acuityConfig()));
    const result = await collectSimulatorSupportResearch({ url: acuitySource }, { fetch, lease, now: () => instant });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.publicConfiguration).toEqual({ family: "ACUITY", ownerKey: "2991fba2", businessId: "34536426", timeZone: "America/New_York", maxPartySize: 6,
      rentals: [{ id: "73234482", durationMinutes: 60, calendarIds: ["11388341"] }], resources: [{ id: "11388341", timeZone: "America/New_York" }] });
    expect(JSON.stringify(result)).not.toMatch(/secret@example|private-token|private-client-token|Private-name|Private-group|Simulator Booking|9999|70\.00/u);
  });
  it.each([acuitySource, golfBookSource])("retains known public facts in the existing rendered packet: %s", async url => {
    const html = url === acuitySource ? acuityConfig() : golfBookConfig();
    const view = renderedBrowser([{ url }], html), fetch = vi.fn(async () => response(html));
    const result = await collectSimulatorSupportResearch({ url, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.publicConfiguration?.family).toBe(url === acuitySource ? "ACUITY" : "GOLFBOOK");
    expect(result).toMatchObject({ renderComplete: true, contentProvenance: "RENDERED_DOM" });
  });
  it("projects only GolfBook settings and resource IDs, never form credentials or transaction actions", async () => {
    const result = await collectSimulatorSupportResearch({ url: golfBookSource }, { fetch: vi.fn(async () => response(golfBookConfig())), lease });
    expect(result.publicConfiguration).toEqual({ family: "GOLFBOOK", templateId: "53", date: "2026-10-10", minDurationMinutes: 60, maxDurationMinutes: 360, incrementMinutes: 30, resourceIds: ["1", "20"] });
    expect(JSON.stringify(result.publicConfiguration)).not.toMatch(/secret@example|private-token|csrf|Private|reserve/u);
  });
  it.each([
    { ownerKey: "other123" }, { includesAdminOnly: true }, { isExpired: true }, { timezone: "Invalid/Zone" },
    { appointmentTypes: { "": [{ id: 42, name: "Simulator Lesson Booking", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] }] } },
    { calendars: { "": [{ id: 11388341, name: "Lesson Room", timezone: "America/New_York" }] } },
  ])("omits mismatched, restricted or unsupported Acuity configuration", async patch => {
    expect((await collectSimulatorSupportResearch({ url: acuitySource }, { fetch: vi.fn(async () => response(acuityConfig(patch))), lease })).publicConfiguration).toBeUndefined();
  });
  it.each([
    '<script>var BUSINESS = (() => { throw new Error("never execute") })();</script>',
    `${acuityConfig()}${acuityConfig()}`,
    acuityConfig().replace('"id":73234482', '"id":"private-token"'),
  ])("never evaluates script or projects malformed/ambiguous Acuity state", async html => {
    expect((await collectSimulatorSupportResearch({ url: acuitySource }, { fetch: vi.fn(async () => response(html)), lease })).publicConfiguration).toBeUndefined();
  });
  it.each([
    golfBookConfig().replace('id="waitlist_template" value="53"', 'id="waitlist_template" value="private-token"'),
    `${golfBookConfig()}<input id="waitlist_template" value="54">`,
    golfBookConfig().replace('id="template_booking_increment_mins" value="30"', 'id="template_booking_increment_mins" value="15"'),
    golfBookConfig().replace('id="th_20"', 'id="th_1"'),
    golfBookConfig().replace('value="2026-10-10"', 'value="2026-02-30"'),
  ])("omits invalid or ambiguous GolfBook settings", async html => {
    expect((await collectSimulatorSupportResearch({ url: golfBookSource }, { fetch: vi.fn(async () => response(html)), lease })).publicConfiguration).toBeUndefined();
  });
  it.each([acuitySource, golfBookSource])("does not expose known configuration through an account challenge: %s", async url => {
    const html = `<h1>Sign in to continue</h1>${url === acuitySource ? acuityConfig() : golfBookConfig()}`;
    const result = await collectSimulatorSupportResearch({ url }, { fetch: vi.fn(async () => response(html)), lease });
    expect(result.accessControls).toContain("ACCOUNT_REQUIRED"); expect(result.publicConfiguration).toBeUndefined();
  });
  it.each([acuitySource, golfBookSource])("clears known configuration on rendered access control and unsuccessful HTTP: %s", async url => {
    const html = `<h1>Verify you are human</h1><div class="cf-turnstile"></div>${url === acuitySource ? acuityConfig() : golfBookConfig()}`;
    const view = renderedBrowser([{ url }], html);
    const result = await collectSimulatorSupportResearch({ url, render: true }, { fetch: vi.fn(async () => response(html)), lease, browser: view.factory });
    expect(result.accessControls).toContain("CAPTCHA_OR_CHALLENGE"); expect(result.publicConfiguration).toBeUndefined();
    expect((await collectSimulatorSupportResearch({ url }, { fetch: vi.fn(async () => response(html, 403)), lease })).publicConfiguration).toBeUndefined();
  });
  it.each([
    "http://app.acuityscheduling.com/schedule/2991fba2", "https://app.acuityscheduling.com.attacker.example/schedule/2991fba2",
    `${acuitySource}?owner=1234`, `${acuitySource}#reserve`, acuitySource.replace("https://", "https://user:pass@"),
    "https://app.acuityscheduling.com/api/scheduling/v1/appointments",
  ])("rejects an unproven Acuity source without interpreting its payload: %s", url => {
    expect(projectAcuityPublicConfiguration(acuityConfig(), url)).toBeUndefined();
  });
  it.each([
    "http://public-bays.golfbook.in/calendar.php", "https://public-bays.golfbook.in.attacker.example/calendar.php",
    `${golfBookSource}?date=2026-10-10`, `${golfBookSource}#reserve`, golfBookSource.replace("https://", "https://user:pass@"),
    "https://public-bays.golfbook.in/reserve.php", "https://public-bays.golfbook.in/bookingsheet.php?date=2026-10-10&lang=en&token=secret",
  ])("rejects an unproven GolfBook source without interpreting its payload: %s", url => {
    expect(projectGolfBookPublicConfiguration(golfBookConfig(), url)).toBeUndefined();
  });
  it.each([acuityConfig(), golfBookConfig()])("does not project a known shape on an unrelated source", async html => {
    expect((await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(html)), lease })).publicConfiguration).toBeUndefined();
  });
  it("corroborates the observed GolfBook sheet date without admitting another route", async () => {
    const url = "https://public-bays.golfbook.in/bookingsheet.php?date=2026-10-10&lang=en";
    const fetch = vi.fn(async () => response(golfBookConfig()));
    expect((await collectSimulatorSupportResearch({ url }, { fetch, lease })).publicConfiguration?.family).toBe("GOLFBOOK");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await collectSimulatorSupportResearch({ url: url.replace("2026-10-10", "2026-10-11") }, { fetch, lease })).publicConfiguration).toBeUndefined();
  });
});

describe("bounded owned simulator public research transport", () => {
  it("returns exact public configuration facts without user, member, session or raw script payloads", () => {
    const result = extractSimulatorPublicCalendar(publishedConfig(), booking);
    expect(result.calendar).toMatchObject({ family: "YOUR_GOLF_BOOKING", venue: { id: "1357", slug: "golf-oasis", timeZone: "America/New_York" },
      ranges: [{ id: "1397", openingHours: "Mo 09:00-20:00 open", hasOpeningTimeRestrictions: false }],
      rentals: [{ id: "21451", name: "Public Rate", maxPlayers: 4, requiresPerks: false }], resources: [{ id: "9224", optionIds: ["21451"], appliedOptionIds: ["21451"] }] });
    expect(result.calendar?.rentals).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/secret@example|never-return|Private Member|customerEmail|owner|__NEXT_DATA__/u);
    expect(result.jsonShape).toBeUndefined();
  });
  it("does not authorize arbitrary hosts, wrong venue identity, duplicate state or executable script content", () => {
    expect(extractSimulatorPublicCalendar(publishedConfig(), "https://unrecognized.example.test/venues/golf-oasis/booking").calendar).toBeUndefined();
    expect(extractSimulatorPublicCalendar(publishedConfig({ venue: { id: 1357, slug: "other-venue" } }), booking).calendar).toBeUndefined();
    expect(extractSimulatorPublicCalendar(`${publishedConfig()}${publishedConfig()}`, booking)).toEqual({});
    expect(extractSimulatorPublicCalendar("<script id='__NEXT_DATA__' type='application/json'>window.alert('run')</script>", booking)).toEqual({});
  });
  it.each([null, true])("retains observed maintenance mode %j as configuration facts without normalizing it to false", value => {
    const html = publishedConfig().replace('"maintenanceMode":false', `"maintenanceMode":${JSON.stringify(value)}`);
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar?.venue).toEqual({ id: "1357", slug: "golf-oasis", timeZone: "America/New_York", status: "live", maintenanceMode: value });
    expect(result.calendar?.ranges).toHaveLength(1); expect(result.calendar?.resources).toHaveLength(1); expect(result.calendar?.rentals).toHaveLength(1);
    expect(result.configurationDiagnostic).toBeUndefined(); expect(result.jsonShape).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/secret@example|never-return|Private Member|owner|availableSlots|complete/u);
  });
  it.each([
    ["missing", "", "MISSING"],
    ["string", '"maintenanceMode":"private-maintenance-value",', "INVALID"]
  ])("rejects %s maintenance mode with only a closed venue diagnostic", (_name, replacement, state) => {
    const html = publishedConfig().replace('"maintenanceMode":false,', replacement);
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toEqual({ phase: "VENUE", reason: "CONFIG_BOOLEAN", maintenanceModeState: state });
    expect(result.jsonShape).toBeDefined();
    expect(JSON.stringify(result)).not.toMatch(/private-maintenance-value|secret@example|never-return|Private Member|owner/u);
  });
  it.each([
    ["VENUE", "CONFIG_IDENTITY", '"slug":"golf-oasis"', '"slug":"different-venue"'],
    ["RANGES", "CONFIG_BOOLEAN", '"bookable":true', '"bookable":null'],
    ["RENTALS", "CONFIG_BOOLEAN", '"disabled":false', '"disabled":null'],
    ["RESOURCES", "CONFIG_IDENTITY", '"range":1397', '"range":9999']
  ])("keeps strict %s validation with the closed %s reason even when maintenance is null", (phase, reason, before, after) => {
    const html = publishedConfig().replace('"maintenanceMode":false', '"maintenanceMode":null').replace(before, after);
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toEqual({ phase, reason, maintenanceModeState: "NULL" });
    expect(JSON.stringify(result.configurationDiagnostic)).not.toMatch(/9999|different-venue|http|@/);
  });
  it("does not fabricate a maintenance state when the inert configuration object is missing", () => {
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialReduxState: null } } })}</script>`;
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toEqual({ phase: "CONFIG", reason: "CONFIG_SHAPE", field: { path: "initialReduxState", expectedType: "OBJECT", actualType: "NULL" } });
  });

  it.each([
    [undefined, "ranges", "OBJECT", "MISSING"],
    [null, "ranges", "OBJECT", "NULL"],
    [[], "ranges", "OBJECT", "ARRAY"],
    [{}, "ranges.items", "ARRAY", "MISSING"],
    [{ items: null }, "ranges.items", "ARRAY", "NULL"],
    [{ items: [null] }, "ranges.items[]", "OBJECT", "NULL"],
  ])("distinguishes incomplete public configuration at a fixed path without returning values", (ranges, path, expectedType, actualType) => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    if (ranges === undefined) delete parsed.props.pageProps.initialReduxState.ranges;
    else parsed.props.pageProps.initialReduxState.ranges = ranges;
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ phase: "RANGES", reason: expectedType === "ARRAY" ? "CONFIG_ARRAY" : "CONFIG_SHAPE", field: { path, expectedType, actualType } });
    expect(JSON.stringify(result.configurationDiagnostic)).not.toMatch(/1357|secret|never-return|Private Member|http|@/u);
  });
  it.each([
    ["restrictions", undefined, "MISSING"],
    ["restrictions", null, "NULL"],
    ["appliedRequiredPerks", "private-perk-value", "STRING"],
    ["appliedRequiredPerks", Array.from({ length: 21 }, () => ({})), "ARRAY"],
  ])("locates a malformed public rental %s array without retaining its value", (field, value, actualType) => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.venue.maintenanceMode = null;
    const row = config.bays.bayOptions[0];
    if (value === undefined) delete row[field];
    else row[field] = value;
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`;
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toEqual({
      phase: "RENTALS", reason: "CONFIG_ARRAY", maintenanceModeState: "NULL",
      field: { path: `bays.bayOptions[].${field}`, expectedType: "ARRAY", actualType },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-perk-value|secret@example|never-return|Private Member/u);
  });
  it("explains each excluded public rental option without admitting one as a calendar", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.venue.maintenanceMode = null;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = [
      { ...base, id: 901, adminOnly: true, name: "Private Member", privateKey: "never-return" },
      { ...base, id: 902, type: "golf_sim", name: "private@example.test" },
      { ...base, id: 903, category: "driving-range", name: "hidden course" },
      { ...base, id: 904, venue: 999, name: "wrong venue" },
      { ...base, id: 905, adminOnly: null, name: "unknown state" },
      { ...base, id: 906, adminOnly: undefined, type: "private@example.test", name: "missing state" },
      { ...base, id: 907, adminOnly: "false", name: "invalid state" },
      { ...base, id: 908, type: "private@example.test", name: "unsafe type token" },
    ];
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`;
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toEqual({
      phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS", maintenanceModeState: "NULL",
      optionCount: 8, rejectedRentalOptionsTruncated: false,
      rejectedRentalOptions: [
        { adminOnlyState: "TRUE", reason: "ADMIN_ONLY_NOT_FALSE" },
        { adminOnlyState: "FALSE", publicOptionId: "902", typeToken: "golf_sim", categoryToken: "baytime", reason: "TYPE_NOT_SIMULATOR" },
        { adminOnlyState: "FALSE", publicOptionId: "903", typeToken: "simulator", categoryToken: "driving-range", categoryState: "TOKEN", reason: "CATEGORY_NOT_BAYTIME" },
        { adminOnlyState: "FALSE", publicOptionId: "904", typeToken: "simulator", categoryToken: "baytime", reason: "VENUE_MISMATCH" },
        { adminOnlyState: "NULL", reason: "ADMIN_ONLY_NOT_FALSE" },
        { adminOnlyState: "MISSING", reason: "ADMIN_ONLY_NOT_FALSE" },
        { adminOnlyState: "INVALID", reason: "ADMIN_ONLY_NOT_FALSE" },
        { adminOnlyState: "FALSE", publicOptionId: "908", categoryToken: "baytime", reason: "TYPE_NOT_SIMULATOR" },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/Private Member|private@example|never-return|hidden course|wrong venue|unknown state|missing state|invalid state|unsafe type token/u);
  });
  it("retains exact bounded public candidate metadata after a null-category rejection, without admitting a calendar", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.venue.maintenanceMode = null;
    config.bays.bayOptions[0].category = null;
    config.bays.bayOptions[0].customerEmail = "private@example.test";
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS",
      maintenanceModeState: "NULL", optionCount: 2, rejectedRentalOptionsTruncated: false,
      rejectedRentalOptions: [{ adminOnlyState: "FALSE", publicOptionId: "21451", typeToken: "simulator", categoryState: "NULL", reason: "CATEGORY_NOT_BAYTIME" },
        { adminOnlyState: "TRUE", reason: "ADMIN_ONLY_NOT_FALSE" }],
      candidateMetadata: {
        venueId: "1357",
        candidateCount: 1, candidatesTruncated: false,
        candidates: [{ publicOptionId: "21451", nameMatchesPublicRate: true, disabled: false, waitlisted: false,
          duration: 1, durationTypeToken: "slot", minDurationSlots: 1, maxDurationSlots: 8,
          minPlayers: 1, maxPlayers: 4, bufferMinutes: 0, hasRestrictions: false, requiresPerks: false }],
        resourceCount: 1, resourcesTruncated: false,
        resources: [{ id: "9224", rangeId: "1397", optionIds: ["21451"], appliedOptionIds: ["21451"], hasRestrictedTimes: false }],
        rangeCount: 1, rangesTruncated: false,
        ranges: [{ id: "1397", slugIsBays: true, bookable: true, slotDurationMinutes: 30,
          slotIntervalMinutes: 30, slotIntervalStart: 0, assumeOpen: true, bookingUiIsStandard: true,
          customerBookingUiIsSlots: true, maxBookAheadValue: 2, maxBookAheadUnitToken: "week",
          hasOpeningTimeRestrictions: false }],
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Private Member|private@example|secret@example|never-return-this|Mo 09:00|__NEXT_DATA__|Public Rate/u);
    expect(persistedDiagnostic(result.configurationDiagnostic)).toEqual(result.configurationDiagnostic);
  });
  it("keeps the original rental rejection and omits extra metadata when candidate or resource facts are invalid", () => {
    const malformed = ["candidate-venue", "disabled", "restrictions", "duration-bounds", "duplicate-private-id",
      "resource-options", "resource-range", "duplicate-applied-option"] as const;
    for (const change of malformed) {
      const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
      const config = parsed.props.pageProps.initialReduxState;
      config.bays.bayOptions[0].category = null;
      if (change === "candidate-venue") config.bays.bayOptions[0].venue = "private-venue";
      else if (change === "disabled") config.bays.bayOptions[0].disabled = null;
      else if (change === "restrictions") config.bays.bayOptions[0].restrictions = null;
      else if (change === "duration-bounds") config.bays.bayOptions[0].minBookingDuration = 9;
      else if (change === "duplicate-private-id") config.bays.bayOptions[1].id = config.bays.bayOptions[0].id;
      else if (change === "resource-options") config.bays.items[0].options = null;
      else if (change === "resource-range") config.bays.items[0].range = 9999;
      else config.bays.items[0].appliedOptions = [21451, 21451];
      const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
      expect(result.calendar).toBeUndefined();
      expect(result.configurationDiagnostic).toMatchObject({ phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS",
        rejectedRentalOptions: [{ categoryState: "NULL", reason: "CATEGORY_NOT_BAYTIME" },
          { adminOnlyState: "TRUE", reason: "ADMIN_ONLY_NOT_FALSE" }] });
      expect(result.configurationDiagnostic?.candidateMetadata).toBeUndefined();
      expect(persistedDiagnostic(result.configurationDiagnostic)).toEqual(result.configurationDiagnostic);
    }
  });
  it("separates actual resource option and applied-option links and bounds candidate and resource rows", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = Array.from({ length: 10 }, (_, index) => ({ ...base, id: 21451 + index, category: null }));
    config.bays.items = Array.from({ length: 11 }, (_, index) => ({ ...config.bays.items[0], id: 9224 + index,
      options: [21451, 21452], appliedOptions: [21451] }));
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 10,
      rejectedRentalOptionsTruncated: true, candidateMetadata: {
        candidateCount: 10, candidatesTruncated: true, resourceCount: 11, resourcesTruncated: true,
        rangeCount: 1, rangesTruncated: false } });
    const metadata = result.configurationDiagnostic?.candidateMetadata;
    expect(metadata?.candidates).toHaveLength(8);
    expect(metadata?.resources).toHaveLength(8);
    expect(metadata?.ranges).toHaveLength(1);
    expect(metadata?.resources[0]).toMatchObject({ optionIds: ["21451", "21452"], appliedOptionIds: ["21451"] });
    expect(metadata && metadata.resources.every(row => metadata.ranges.some(range => range.id === row.rangeId))).toBe(true);
  });
  it.each([
    ["", "EMPTY"], ["Mo 09:00-21:00 open;Tu off", "WEEKLY_OR_DATED"],
    ["Mo 09:00-21:00 open;Mo off", "OTHER"],
    ["private@example.test secret-hours", "OTHER"],
  ])("retains a closed opening-hours distinction after rental rejection: %j", (openingHours, openingHoursFormat) => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.bays.bayOptions[0].category = null;
    config.ranges.items[0].openingHours = openingHours;
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic?.reason).toBe("CONFIG_NO_ELIGIBLE_RENTALS");
    expect(result.configurationDiagnostic?.candidateMetadata?.ranges[0]).toHaveProperty("openingHoursFormat", openingHoursFormat);
    expect(persistedDiagnostic(result.configurationDiagnostic)).toEqual(result.configurationDiagnostic);
    expect(JSON.stringify(result.configurationDiagnostic)).not.toMatch(/private@example|secret-hours/u);
  });
  it("does not project a candidate outside the first eight rejected rows", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = [
      ...Array.from({ length: 8 }, (_, index) => ({ ...base, id: 1000 + index, adminOnly: true, name: "Private Member" })),
      { ...base, id: 21451, category: null },
    ];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.configurationDiagnostic).toMatchObject({ reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 9,
      rejectedRentalOptionsTruncated: true });
    expect(result.configurationDiagnostic?.rejectedRentalOptions).toHaveLength(8);
    expect(result.configurationDiagnostic?.candidateMetadata).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Private Member");
  });
  it("omits bounded metadata when a bookable resource links only to a valid candidate beyond the rejected prefix", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = [{ ...base, category: null },
      ...Array.from({ length: 7 }, (_, index) => ({ id: 3000 + index, adminOnly: true })),
      { ...base, id: 21452, category: null }];
    config.bays.items[0].options = [21452];
    config.bays.items[0].appliedOptions = [21452];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS",
      optionCount: 9, rejectedRentalOptionsTruncated: true });
    expect(result.configurationDiagnostic?.candidateMetadata).toBeUndefined();
    expect(persistedDiagnostic(result.configurationDiagnostic)).toEqual(result.configurationDiagnostic);
  });
  it("omits metadata when a hidden null-category candidate has invalid duration bounds", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = [{ ...base, category: null },
      ...Array.from({ length: 7 }, (_, index) => ({ id: 3000 + index, adminOnly: true })),
      { ...base, id: 21452, category: null, minBookingDuration: 9 }];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS",
      optionCount: 9, rejectedRentalOptionsTruncated: true });
    expect(result.configurationDiagnostic?.candidateMetadata).toBeUndefined();
    expect(persistedDiagnostic(result.configurationDiagnostic)).toEqual(result.configurationDiagnostic);
  });
  it.each([
    [undefined, "MISSING"], [null, "NULL"], [42, "NON_STRING"],
    [{ secret: "private-category-value" }, "NON_STRING"],
    ["private@example.test", "FILTERED_STRING"], ["", "FILTERED_STRING"],
    ["driving-range", "TOKEN"],
  ])("distinguishes a rejected category without exposing its raw value: %j", (category, categoryState) => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.bays.bayOptions = [{ ...config.bays.bayOptions[0], category }];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({ reason: "CONFIG_NO_ELIGIBLE_RENTALS",
      rejectedRentalOptions: [{ reason: "CATEGORY_NOT_BAYTIME", categoryState }] });
    const row = result.configurationDiagnostic?.rejectedRentalOptions?.[0];
    expect(row?.categoryToken).toBe(categoryState === "TOKEN" ? category : undefined);
    expect(JSON.stringify(result.configurationDiagnostic)).not.toMatch(/private@example|private-category-value|secret/u);
  });
  it("omits a malformed public option identifier from rejected-rental evidence", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.bays.bayOptions = [{ ...config.bays.bayOptions[0], id: "never-retain-id", type: "golf_sim" }];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({
      reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 1,
      rejectedRentalOptions: [{ adminOnlyState: "FALSE", typeToken: "golf_sim", reason: "TYPE_NOT_SIMULATOR" }],
    });
    expect(result.configurationDiagnostic?.rejectedRentalOptions?.[0].publicOptionId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("never-retain-id");
  });
  it.each([
    [{ adminOnly: true }, "ADMIN_ONLY_NOT_FALSE"],
    [{ type: "golf_sim" }, "TYPE_NOT_SIMULATOR"],
    [{ category: "driving-range" }, "CATEGORY_NOT_BAYTIME"],
    [{}, null],
  ] as const)("preserves the original venue-validation short circuit after %j", (patch, rejection) => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    config.bays.bayOptions = [{ ...config.bays.bayOptions[0], ...patch, venue: "never-retain-venue" }];
    const result = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(result.calendar).toBeUndefined();
    if (rejection) {
      expect(result.configurationDiagnostic).toMatchObject({
        reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 1,
        rejectedRentalOptions: [{ reason: rejection }],
      });
    } else {
      expect(result.configurationDiagnostic).toEqual({ phase: "RENTALS", reason: "CONFIG_NUMBER", maintenanceModeState: "FALSE" });
    }
    expect(JSON.stringify(result)).not.toContain("never-retain-venue");
  });
  it("bounds excluded rental evidence while recording the validated total", () => {
    const parsed = JSON.parse(publishedConfig().match(/<script[^>]*>([\s\S]*?)<\/script>/u)![1]);
    const config = parsed.props.pageProps.initialReduxState;
    const base = config.bays.bayOptions[0];
    config.bays.bayOptions = Array.from({ length: 9 }, (_, index) => ({ ...base, id: 100 + index, adminOnly: true }));
    const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`;
    const result = extractSimulatorPublicCalendar(html, booking);
    expect(result.calendar).toBeUndefined();
    expect(result.configurationDiagnostic).toMatchObject({
      phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 9,
      rejectedRentalOptionsTruncated: true,
    });
    expect(result.configurationDiagnostic?.rejectedRentalOptions).toHaveLength(8);
    expect(result.configurationDiagnostic?.rejectedRentalOptions?.every(row => row.adminOnlyState === "TRUE" && !row.publicOptionId && !row.typeToken && !row.categoryToken)).toBe(true);
    config.bays.bayOptions = Array.from({ length: 100 }, (_, index) => ({ ...base, id: 100 + index, adminOnly: true }));
    const atCap = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(atCap.configurationDiagnostic).toMatchObject({ reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 100,
      rejectedRentalOptionsTruncated: true });
    expect(atCap.configurationDiagnostic?.rejectedRentalOptions).toHaveLength(8);
    config.bays.bayOptions.push({ ...base, id: 200, adminOnly: true });
    const overCap = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(overCap.configurationDiagnostic).toEqual({ phase: "RENTALS", reason: "CONFIG_ARRAY",
      field: { path: "bays.bayOptions", expectedType: "ARRAY", actualType: "ARRAY" }, maintenanceModeState: "FALSE" });
    config.bays.bayOptions = [];
    const empty = extractSimulatorPublicCalendar(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(parsed)}</script>`, booking);
    expect(empty.configurationDiagnostic).toMatchObject({ reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 0,
      rejectedRentalOptions: [], rejectedRentalOptionsTruncated: false });
  });
  it("does not adopt an unrelated exception merely because its message matches a configuration reason", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementationOnce(function () { throw new Error("CONFIG_BOOLEAN"); });
    const result = extractSimulatorPublicCalendar(publishedConfig(), booking);
    expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeDefined(); expect(result.configurationDiagnostic).toBeUndefined();
  });
  it("admits only the bounded anonymous occupancy research for an exact live venue with an observed null maintenance flag", async () => {
    const root = "https://yourgolfbooking.com/venues/golf-oasis/booking";
    const html = publishedConfig().replace('"maintenanceMode":false', '"maintenanceMode":null');
    const occupancy = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-10T00%3A00%3A00Z&start_lte=2026-10-11T00%3A00%3A00Z";
    const forbidden: RequestFixture[] = [
      { url: occupancy, kind: "fetch", method: "POST" },
      { url: occupancy, kind: "fetch", headers: { Cookie: "private-session" } },
      { url: occupancy + "&extra=value", kind: "fetch" },
      { url: occupancy.replace("2026-10-11", "2026-10-14"), kind: "fetch" },
      { url: occupancy.replace("/golf-oasis/", "/different-venue/"), kind: "fetch" },
      { url: occupancy.replace("api.yourgolfbooking.com", "unobserved.example.test"), kind: "fetch" },
      { url: "https://api.yourgolfbooking.com/login?token=private", kind: "fetch" },
    ];
    const view = renderedBrowser([{ url: root }, ...forbidden, { url: occupancy, kind: "fetch" }], html);
    const payload = [{ start: "private-date", bayId: "private-id", user: { email: "private@example.test" }, sessionToken: "never-return-this" }];
    const fetch = vi.fn(async (url: unknown) => String(url) === root ? response(html) : response(JSON.stringify(payload), 200, "application/json"));
    const result = await collectSimulatorSupportResearch({ url: root, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual([root, occupancy]);
    expect(result.calendar?.venue.maintenanceMode).toBeNull();
    expect(result.bookingLinks).toEqual([root + "/bays"]);
    expect(result.responseContracts).toEqual([{ pathShape: "/venue/:value/bookings/public", queryKeys: ["start_gte", "start_lte"], httpStatus: 200,
      shape: [{ path: "$", type: "array", count: 1 }, { path: "$[]", type: "object" }, { path: "$[].start", type: "string" }, { path: "$[].bayId", type: "string" }] }]);
    expect(result).toMatchObject({ admittedRequests: 2, blockedRequests: forbidden.length });
    expect(JSON.stringify(result)).not.toMatch(/private-|private@example|never-return-this|sessionToken/u);
    for (const route of view.routes.slice(1, -1)) { expect(route.abort).toHaveBeenCalledOnce(); expect(route.fulfill).not.toHaveBeenCalled(); }
    const runtimeFetch = vi.fn<typeof globalThis.fetch>(async () => response(html));
    await expect(fetchYourGolfBookingAvailability({ offering: { id: "research-offering", courseId: "research-venue", bookingUrl: booking.replace(/\/bays$/u, ""), providerFamilyKey: "YOUR_GOLF_BOOKING",
      providerMetadata: { venueSlug: "golf-oasis", venueId: "1357", rangeId: "1397", publicOptionId: "21451" }, maxPartySize: 4, supportedDurationsMinutes: [60] },
      date: "2026-10-10", durationMinutes: 60, partySize: 1, timeZone: "America/New_York" }, runtimeFetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });
  it.each([true, undefined, "invalid"])("does not admit YourGolfBooking occupancy with maintenance mode %j", async value => {
    const root = "https://yourgolfbooking.com/venues/golf-oasis/booking";
    const html = value === undefined ? publishedConfig().replace('"maintenanceMode":false,', "")
      : publishedConfig().replace('"maintenanceMode":false', `"maintenanceMode":${JSON.stringify(value)}`);
    const occupancy = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-10T00%3A00%3A00Z&start_lte=2026-10-11T00%3A00%3A00Z";
    const view = renderedBrowser([{ url: root }, { url: occupancy, kind: "fetch" }], html);
    const fetch = vi.fn(async () => response(html));
    const result = await collectSimulatorSupportResearch({ url: root, render: true }, { fetch, lease, browser: view.factory });
    if (value === true) expect(result.calendar?.venue.maintenanceMode).toBe(true);
    else expect(result.calendar).toBeUndefined();
    expect(result.bookingLinks).toBeUndefined(); expect(result.responseContracts).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce(); expect(view.routes[1].abort).toHaveBeenCalledOnce();
    const runtimeFetch = vi.fn<typeof globalThis.fetch>(async () => response(html));
    await expect(fetchYourGolfBookingAvailability({ offering: { id: "research-offering", courseId: "research-venue", bookingUrl: booking.replace(/\/bays$/u, ""), providerFamilyKey: "YOUR_GOLF_BOOKING",
      providerMetadata: { venueSlug: "golf-oasis", venueId: "1357", rangeId: "1397", publicOptionId: "21451" }, maxPartySize: 4, supportedDurationsMinutes: [60] },
      date: "2026-10-10", durationMinutes: 60, partySize: 1, timeZone: "America/New_York" }, runtimeFetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtimeFetch).toHaveBeenCalledOnce();
  });
  it("does not admit nullable occupancy research when the published venue identity, live status or access controls fail", async () => {
    const root = "https://yourgolfbooking.com/venues/golf-oasis/booking";
    const occupancy = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-10T00%3A00%3A00Z&start_lte=2026-10-11T00%3A00%3A00Z";
    const original = publishedConfig().replace('"maintenanceMode":false', '"maintenanceMode":null');
    for (const html of [original.replace('"slug":"golf-oasis"', '"slug":"different-venue"'),
      original.replace('"status":"live"', '"status":"inactive"'), original + "<h1>Verify you are human</h1>"]) {
      const view = renderedBrowser([{ url: root }, { url: occupancy, kind: "fetch" }], html);
      const fetch = vi.fn(async () => response(html));
      const result = await collectSimulatorSupportResearch({ url: root, render: true }, { fetch, lease, browser: view.factory });
      expect(fetch).toHaveBeenCalledOnce(); expect(view.routes[1].abort).toHaveBeenCalledOnce();
      expect(result.responseContracts).toBeUndefined(); expect(result.bookingLinks).toBeUndefined();
      if (html.includes("Verify you are human")) {
        expect(result).toMatchObject({ accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
        expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeUndefined(); expect(result.configurationDiagnostic).toBeUndefined();
      }
      vi.clearAllMocks();
    }
  });
  it.each([false, true])("scrubs configuration diagnostics when positive access controls are observed (rendered: %s)", async render => {
    const html = publishedConfig().replace('"maintenanceMode":false', '"maintenanceMode":"private-value"') + "<h1>Verify you are human</h1>";
    expect(extractSimulatorPublicCalendar(html, booking).configurationDiagnostic).toEqual({ phase: "VENUE", reason: "CONFIG_BOOLEAN", maintenanceModeState: "INVALID" });
    const view = renderedBrowser([{ url: booking }], html);
    const result = await collectSimulatorSupportResearch({ url: booking, render }, { fetch: vi.fn(async () => response(html)), lease, browser: view.factory });
    expect(result).toMatchObject({ accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
    expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeUndefined(); expect(result.configurationDiagnostic).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/private-value|secret@example|CONFIG_BOOLEAN|Hourly simulator bays/);
  });
  it("reports restriction presence without retaining restriction/perk payloads or declaring availability", () => {
    const html = publishedConfig().replace('"restrictions":[]', '"restrictions":[{"email":"private@example.test"}]').replace('"appliedRequiredPerks":[]', '"appliedRequiredPerks":[{"secret":"private-perk"}]');
    expect(extractSimulatorPublicCalendar(html, booking).calendar?.rentals[0]).toMatchObject({ hasRestrictions: true, requiresPerks: true });
    expect(JSON.stringify(extractSimulatorPublicCalendar(html, booking))).not.toMatch(/private@example|private-perk|availableSlots/u);
  });
  it("returns bounded key/type shape rather than JSON values or sensitive fields", () => {
    const shape = summarizeSimulatorPublicJsonShape({ slots: [{ startsAt: "private-time", resourceId: "private-id", user: { email: "secret" } }], sessionToken: "secret", cookie: "secret", "person@example.test": "secret", status: true });
    expect(shape).toContainEqual({ path: "$.slots[].startsAt", type: "string" });
    expect(JSON.stringify(shape)).not.toMatch(/private-|secret|session|cookie|person@example/u);
    expect(summarizeSimulatorPublicJsonShape(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field_${index}`, { value: index }]))).length).toBeLessThanOrEqual(80);
  });
  it("omits interactive surfaces, credentials, forms and scripts from text/link output", () => {
    expect(summarizeSimulatorSupportPublicHtml("<p>Hourly bays</p><form>Private form</form><script>secret</script><a href='/booking'>Book</a><a href='/checkout'>Pay</a><a href='http://127.0.0.1'>Local</a><a href='/rates?token=secret'>Token</a>", source))
      .toEqual({ text: "Hourly bays Book Pay Local Token", links: [`${source}/booking`] });
  });
  it("treats a bare HTTP 403 as unresolved public-source evidence, not a final limitation", async () => {
    const fetch = vi.fn(async () => response("Forbidden", 403));
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch, lease, now: () => instant });
    expect(result).toMatchObject({ requestedUrl: `${source}/`, httpStatus: 403, text: "", links: [], method: "HTTP" });
    expect(result).toMatchObject({ accessControlsObserved: true, accessControls: [] });
    expect(fetch).toHaveBeenCalledWith(`${source}/`, expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual" }));
    expect(lease).toHaveBeenCalledWith("venue.example.test", expect.any(Function));
  });
  it("follows only safe same-official-host redirects and resolves relative anchors at the effective landing", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://www.venue.example.test/simulators/" } })).mockResolvedValueOnce(response("<a href='book'>Book hourly</a>"));
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch, lease });
    expect(result).toMatchObject({ url: "https://www.venue.example.test/simulators/", links: ["https://www.venue.example.test/simulators/book"] });
    expect(lease).toHaveBeenNthCalledWith(2, "www.venue.example.test", expect.any(Function));
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://unrelated.example.test" } })), lease })).rejects.toThrow("DESTINATION_CHANGED");
  });
  it.each(["http://127.0.0.1", "https://venue.example.test/login", "https://venue.example.test/cart", "https://venue.example.test/?token=secret"])("rejects unsafe input %s without I/O", async url => {
    const fetch = vi.fn(); await expect(collectSimulatorSupportResearch({ url }, { fetch, lease })).rejects.toThrow("UNSAFE_URL"); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([403, 404, 429, 500, 503])("preserves initial main HTTP %i and blocks an oversized decorative script without another read", async status => {
    const main = publishedConfig() + "<a href='/booking'>Book a bay</a>";
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/decoration.js`, kind: "script" }], "<h1>Unproven DOM</h1>");
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(main, status)
      : new Response("large decoration", { headers: { "content-length": "1500001", "content-type": "text/javascript" } }));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory, now: () => instant });
    expect(fetch).toHaveBeenCalledOnce(); expect(lease).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ httpStatus: status, url: `${source}/`, observedAt: instant.toISOString(), method: "BROWSER", text: "", links: [],
      admittedRequests: 1, blockedRequests: 1, renderComplete: false, renderWarning: "MAIN_DOCUMENT_HTTP_ERROR", contentProvenance: "MAIN_DOCUMENT_HTTP", accessControls: [] });
    expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeUndefined(); expect(result.configurationDiagnostic).toBeUndefined();
    expect(result.bookingLinks).toBeUndefined(); expect(result.responseContracts).toBeUndefined();
    expect(view.routes[0].fulfill).toHaveBeenCalledWith({ status, body: "", headers: { "content-type": "text/plain" } });
    expect(view.routes[1].abort).toHaveBeenCalledOnce(); expect(view.routes[1].fulfill).not.toHaveBeenCalled(); expect(view.page.content).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it.each([200, 503])("follows legitimate main redirects before observing terminal status %i", async status => {
    const landing = `${source}/landing`;
    const view = renderedBrowser([{ url: `${source}/` }, { url: landing }, { url: `${source}/public.js`, kind: "script" }], "<h1>Rendered public facts</h1>");
    view.page.url = () => landing;
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? new Response(null, { status: 302, headers: { location: landing } })
      : String(url) === landing ? response("<h1>Main public facts</h1>", status) : response("public script", 200, "text/javascript"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ url: landing, httpStatus: status });
    expect(fetch).toHaveBeenCalledTimes(status === 200 ? 3 : 2);
    if (status === 200) {
      expect(result).toMatchObject({ renderComplete: true, contentProvenance: "RENDERED_DOM", text: "Rendered public facts" });
      expect(result.renderWarning).toBeUndefined(); expect(view.page.content).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ renderComplete: false, renderWarning: "MAIN_DOCUMENT_HTTP_ERROR", contentProvenance: "MAIN_DOCUMENT_HTTP", text: "", links: [] });
      expect(view.page.content).not.toHaveBeenCalled();
    }
  });
  it("records positive access controls from an HTTP error without loading or returning its page decoration", async () => {
    const occupancy = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-10T00%3A00%3A00Z&start_lte=2026-10-11T00%3A00%3A00Z";
    const view = renderedBrowser([{ url: booking }, { url: occupancy, kind: "fetch" }]);
    const fetch = vi.fn(async () => response(publishedConfig() + "<h1>Verify you are human</h1>", 403));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ httpStatus: 403, accessControls: ["CAPTCHA_OR_CHALLENGE"], renderComplete: false, renderWarning: "MAIN_DOCUMENT_HTTP_ERROR", text: "", links: [] });
    expect(fetch).toHaveBeenCalledOnce(); expect(view.routes[0].fulfill).toHaveBeenCalledWith({ status: 403, body: "", headers: { "content-type": "text/plain" } });
    expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeUndefined(); expect(result.configurationDiagnostic).toBeUndefined(); expect(result.responseContracts).toBeUndefined();
  });
  it("retains a bounded terminal HTTP observation after an expected navigation abort, but keeps an unknown navigation error hard", async () => {
    for (const expectedAbort of [true, false]) {
      const view = renderedBrowser([{ url: `${source}/` }]);
      const originalGoto = view.page.goto.getMockImplementation()!;
      const error = new Error(expectedAbort ? "page.goto: net::ERR_ABORTED at public destination" : "Unrelated browser invariant");
      view.page.goto.mockImplementation(async () => { await originalGoto(); throw error; });
      const task = collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("Main error", 403)), lease, browser: view.factory });
      if (expectedAbort) await expect(task).resolves.toMatchObject({ httpStatus: 403, renderWarning: "MAIN_DOCUMENT_HTTP_ERROR", renderComplete: false });
      else await expect(task).rejects.toBe(error);
      expect(view.page.content).not.toHaveBeenCalled();
    }
  });
  it("keeps main body limits and final browser/source URL guards hard before terminal HTTP fallback", async () => {
    const oversized = renderedBrowser([{ url: `${source}/` }]);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => new Response("Main error", { status: 403, headers: { "content-type": "text/html", "content-length": "1500001" } })),
      lease, browser: oversized.factory })).rejects.toThrow("BODY_LIMIT");
    for (const changedBrowser of [false, true]) {
      const view = renderedBrowser([{ url: `${source}/` }]);
      const changed = "https://unobserved.example.test/";
      if (changedBrowser) view.page.url = () => changed;
      const rejected = changedBrowser ? response("Main error", 403) : Object.defineProperty(response("Main error", 403), "url", { value: changed });
      await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => rejected), lease, browser: view.factory })).rejects.toThrow("DESTINATION_CHANGED");
    }
  });
  it("settles an already-started unknown data failure and prevents later queued main reads", async () => {
    const data = "https://www.venue.example.test/public-data", unknown = new Error("Unrelated data invariant");
    const view = renderedBrowser([{ url: `${source}/` }]);
    let handler!: (route: Route) => Promise<void>;
    let rejectData!: (error: Error) => void;
    const pendingData = new Promise<Response>((_resolve, reject) => { rejectData = reject; });
    const fetch = vi.fn(async (url: unknown) => String(url) === data ? pendingData : response("<h1>Safe main</h1>"));
    view.context.route.mockImplementation(async (_pattern, callback) => { handler = callback; });
    const run = (url: string, kind: string) => handler({ abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined),
      request: () => ({ url: () => url, method: () => "GET", allHeaders: async () => ({ "user-agent": "Public research browser" }),
        resourceType: () => kind, isNavigationRequest: () => kind === "document", frame: () => view.page.mainFrame() }) } as unknown as Route);
    let dataWork: Promise<void> | undefined;
    view.page.goto.mockImplementation(async () => {
      await run(`${source}/`, "document"); dataWork = run(data, "xhr");
      const laterMainWork = run(`${source}/later-main`, "document");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      rejectData(unknown); await Promise.all([dataWork, laterMainWork]);
      throw new Error("page.goto: net::ERR_ABORTED at public destination");
    });
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toBe(unknown);
    await dataWork; expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.some(call => String(call[0]).includes("later-main"))).toBe(false);
    expect(view.page.content).not.toHaveBeenCalled(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("keeps aggregate overflow from separately hosted queued responses hard", async () => {
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 4 }, (_, index) => ({ url: `https://www.venue.example.test/large-${index}.css`, kind: "stylesheet" }))];
    const view = renderedBrowser(requests, "<h1>Unproven rendered output</h1>", true);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>") : response("x".repeat(1_500_000), 200, "text/css"));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toThrow("BODY_LIMIT");
    expect(fetch).toHaveBeenCalledTimes(5); expect(view.page.content).not.toHaveBeenCalled();
  });
  it("renders through a fresh context and one coordinated public browser request, without repeating a static GET", async () => {
    const view = renderedBrowser([{ url: `${source}/` }]);
    const fetch = vi.fn(async () => response("<h1>Public rentals</h1>"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ method: "BROWSER", httpStatus: 200, links: [`${source}/booking`], blockedRequests: 0 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(view.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: "block", storageState: { cookies: [], origins: [] }, acceptDownloads: false }));
    expect(await view.socket()).toHaveBeenCalledWith(expect.objectContaining({ code: 1008 }));
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
    expect(view.routes[0].fulfill.mock.calls[0][0].headers).not.toHaveProperty("set-cookie");
  });
  it("projects only the observed inert bootstrap navigation and visible button booking role once", async () => {
    const html = publishedBootstrap();
    const fetch = vi.fn(async () => response(html));
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch, lease });
    expect(result.links).toEqual([tenantRoot]);
    expect(result.bookingLinks).toEqual([tenantRoot]);
    expect(result.publicConfiguration).toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/shopAll|squareAppointment|BOOK NOW|__BOOTSTRAP_STATE__/u);
    const escaped = publishedBootstrap().replaceAll(tenantRoot, tenantRoot.replaceAll("/", "\\/"));
    expect((await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(escaped)), lease })).bookingLinks)
      .toEqual([tenantRoot]);
  });
  it("retains a projected booking CTA within the 30-link cap and keeps every role linked", async () => {
    const anchors = Array.from({ length: 30 }, (_, index) => `<a href='/book-${index}'>Book bays</a>`).join("");
    const html = publishedBootstrap().replace("<div id='app'></div>", `<div id='app'></div>${anchors}`);
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(html)), lease });
    expect(result.links).toHaveLength(30);
    expect(result.links[0]).toBe(tenantRoot);
    expect(result.links).not.toContain(`${source}/book-29`);
    expect(result.bookingLinks).toContain(tenantRoot);
    expect(result.bookingLinks?.every(link => result.links.includes(link))).toBe(true);
    expect(result.bookingLinks).not.toContain(`${source}/book-29`);
  });
  it("does not promote hidden, conflicting, unrelated or unsafe bootstrap fields", async () => {
    const assignment = publishedBootstrap().match(/<script>([\s\S]*?)<\/script>/u)?.[1];
    if (!assignment) throw new Error("Missing synthetic bootstrap assignment.");
    const cases = [
      publishedBootstrap({ navigationUrl: null, buttonHidden: true }),
      publishedBootstrap({ navigationUrl: null, bannerHidden: true }),
      publishedBootstrap({ navigationTitle: "About", buttonHidden: true }),
      publishedBootstrap({ buttonUrl: "https://other.example.test/book" }),
      publishedBootstrap({ navigationUrl: "https://127.0.0.1/book", buttonHidden: true }),
      publishedBootstrap({ navigationUrl: "https://onegolfhaven.as.me/checkout", buttonHidden: true }),
      publishedBootstrap({ navigationUrl: "https://onegolfhaven.as.me/login", buttonHidden: true }),
      publishedBootstrap({ navigationUrl: null, buttonUrl: "https://onegolfhaven.as.me/?token=secret" }),
      publishedBootstrap().replace("window.__BOOTSTRAP_STATE__ =", "window.__BOOTSTRAP_STATE__ = (() => { throw new Error('never execute') })(); window.other ="),
      `${publishedBootstrap()}<script>window.__BOOTSTRAP_STATE__ = {};</script>`,
      `<div id='app'></div><script>/* ${assignment} */</script>`,
      `<div id='app'></div><script>const note = \`${assignment}\`;</script>`,
      `<div id='app'></div><script>(() => { ${assignment} })();</script>`,
      `<div id='app'></div><script>if (true) { ${assignment} }</script>`,
    ];
    for (const html of cases) {
      const result = await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(html)), lease });
      expect(result.links).toEqual([]);
      expect(result.bookingLinks).toBeUndefined();
    }
  });
  it("projects a proven tenant scheduler only after a guarded same-host public redirect", async () => {
    const root = "https://onegolfhaven.as.me/", schedule = "https://onegolfhaven.as.me/schedule/a66e63ac";
    const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: schedule } }))
      .mockResolvedValueOnce(response(acuityConfig({ ownerKey: "a66e63ac" })));
    const result = await collectSimulatorSupportResearch({ url: root }, { fetch, lease });
    expect(result.url).toBe(schedule);
    expect(result.publicConfiguration).toMatchObject({ family: "ACUITY", ownerKey: "a66e63ac" });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(collectSimulatorSupportResearch({ url: root }, { fetch: vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://other.as.me/schedule/a66e63ac" } })), lease }))
      .rejects.toThrow("DESTINATION_CHANGED");
  });
  it("does not call an empty client app complete when an undeclared website chunk was blocked", async () => {
    const main = publishedBootstrap();
    const view = renderedBrowser([{ url: `${source}/` },
      { url: "https://cdn3.editmysite.com/app/website/js/home-page.example.js", kind: "script" }], main);
    const fetch = vi.fn(async () => response(main));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledOnce();
    expect(view.routes[1].abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ text: "", links: [tenantRoot], bookingLinks: [tenantRoot], blockedRequests: 1,
      renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" });
    expect(result.renderWarning).toBeUndefined();
  });
  it("does not count page-title metadata as a completed client app render", async () => {
    const main = publishedBootstrap().replace("<div id='app'></div>", "<head><title>Public golf venue</title></head><div id='app'></div>");
    const view = renderedBrowser([{ url: `${source}/` },
      { url: "https://cdn3.editmysite.com/app/website/js/home-page.example.js", kind: "script" }], main);
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: vi.fn(async () => response(main)), lease, browser: view.factory,
    });
    expect(view.routes[1].abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ links: [tenantRoot], bookingLinks: [tenantRoot], blockedRequests: 1, renderComplete: false,
      contentProvenance: "MAIN_DOCUMENT_HTTP" });
  });
  it("keeps a declared capped stylesheet warning and admitted JSON shape with an empty client app", async () => {
    const stylesheet = `${source}/large.css`, data = `${source}/public/state`;
    const main = `${publishedBootstrap()}<link rel='stylesheet' href='/large.css'>`;
    const view = renderedBrowser([{ url: `${source}/` }, { url: stylesheet, kind: "stylesheet" }, { url: data, kind: "xhr" },
      { url: `${source}/booking/changefield?secret=never-persist-this`, kind: "fetch", method: "POST" }], main);
    const fetch = vi.fn(async (url: unknown) => String(url) === stylesheet
      ? new Response("", { headers: { "content-type": "text/css", "content-length": "1500001" } })
      : String(url) === data ? response('{"publicAvailable":true}', 200, "application/json") : response(main));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ links: [tenantRoot], bookingLinks: [tenantRoot], blockedRequests: 2,
      renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP", renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED",
      bodyLimitDiagnostics: [{ resourceKind: "SECONDARY_STYLESHEET", phase: "COLLECTOR_HEADERS", observedSizeBand: "OVER_LIMIT_UP_TO_2X", count: 1 }],
      blockedRequestDiagnostics: [{ state: "NOT_EXECUTED", method: "POST", pathShape: "/booking/changefield", count: 1 }],
      responseContracts: [{ pathShape: "/public/:value", httpStatus: 200 }] });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("covers child frames and popups while blocking mutations, credentials, access flows and unscoped hosts before reads", async () => {
    const requests: RequestFixture[] = [{ url: `${source}/` }, { url: `${source}/frame`, frame: "child" }, { url: `${source}/popup`, frame: "popup" },
      { url: `${source}/reserve`, method: "POST" }, { url: `${source}/data`, headers: { Cookie: "session=secret" } }, { url: `${source}/data`, headers: { Authorization: "Bearer secret" } },
      { url: `${source}/login` }, { url: "https://unrelated.example.test" }];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(3); expect(result.blockedRequests).toBe(5);
    for (const route of view.routes.slice(3)) expect(route.abort).toHaveBeenCalledOnce();
    for (const [, options] of fetch.mock.calls) expect(options).toMatchObject({ credentials: "omit", method: "GET" });
  });
  it("retains only a bounded NOT_EXECUTED shape for same-origin blocked XHR/fetch methods", async () => {
    const privateUrl = `${source}/booking/changefield?email=secret@example.test&token=never-persist-this`;
    const requests: RequestFixture[] = [{ url: `${source}/` },
      { url: privateUrl, kind: "fetch", method: "POST", headers: { Cookie: "private-session" } },
      { url: privateUrl, kind: "fetch", method: "POST" },
      { url: `${source}/customer-9273/private-token`, kind: "xhr", method: "PATCH" },
      { url: "https://unrelated.example.test/booking/changefield", kind: "fetch", method: "POST" },
      { url: `${source}/booking/changefield`, kind: "script", method: "POST" }];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("<h1>Public page</h1>"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.blockedRequests).toBe(5);
    expect(result.blockedRequestDiagnostics).toEqual([
      { state: "NOT_EXECUTED", resourceKind: "FETCH", method: "POST", reason: "METHOD_NOT_ALLOWED", pathShape: "/booking/changefield", count: 2 },
      { state: "NOT_EXECUTED", resourceKind: "XHR", method: "PATCH", reason: "METHOD_NOT_ALLOWED", pathShape: "/:value/:value", count: 1 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret@example|never-persist-this|private-session|customer-9273|private-token|unrelated\.example/u);
    for (const route of view.routes.slice(1)) expect(route.abort).toHaveBeenCalledOnce();
  });
  it("bounds and deduplicates blocked-method diagnostics independently of the admitted-read cap", async () => {
    const requests: RequestFixture[] = [{ url: `${source}/` },
      ...Array.from({ length: 40 }, () => ({ url: `${source}/booking/changefield?secret=private`, kind: "fetch", method: "POST" }))];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("<h1>Public page</h1>"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.blockedRequests).toBe(40);
    expect(result.blockedRequestDiagnostics).toEqual([{ state: "NOT_EXECUTED", resourceKind: "FETCH", method: "POST",
      reason: "METHOD_NOT_ALLOWED", pathShape: "/booking/changefield", count: 32 }]);
    expect(result.blockedRequestDiagnosticsTruncated).toBe(true);
  });
  it("retains no more than eight distinct blocked-method shapes", async () => {
    const shapes = ["api", "booking", "changefield", "availability", "calendar", "times", "public", "schedule", "slots"];
    const view = renderedBrowser([{ url: `${source}/` }, ...shapes.map(part => ({ url: `${source}/${part}?private=never-persist-this`,
      kind: "xhr", method: "POST" }))]);
    const fetch = vi.fn(async () => response("<h1>Public page</h1>"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.blockedRequestDiagnostics).toHaveLength(8);
    expect(result.blockedRequestDiagnosticsTruncated).toBe(true);
    expect(result.blockedRequestDiagnostics?.reduce((sum, row) => sum + row.count, 0)).toBe(8);
    expect(JSON.stringify(result)).not.toContain("never-persist-this");
  });
  it("does not execute initial challenge scripts or return challenge payloads", async () => {
    const html = "<h1>Verify you are human</h1><div class='cf-turnstile'></div><script>runChallenge()</script>";
    const view = renderedBrowser([{ url: `${source}/` }], html);
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response(html, 403)), lease, browser: view.factory });
    expect(result).toMatchObject({ httpStatus: 403, accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
    expect(String(view.routes[0].fulfill.mock.calls[0][0].body)).not.toContain("runChallenge");
    expect(view.page.content).not.toHaveBeenCalled();
    expect(detectSimulatorResearchAccessControls("<p>Sign in to continue</p>")).toContain("ACCOUNT_REQUIRED");
    expect(detectSimulatorResearchAccessControls("<p>You are in a queue</p>")).toContain("QUEUE");
  });
  it("returns only sanitized XHR response shapes, path templates and query keys", async () => {
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/venue/golf-oasis/availability?start_gte=private-date`, kind: "fetch" }]);
    const fetch = vi.fn(async (url: unknown) => String(url).includes("availability") ? response(JSON.stringify({ slots: [{ id: 9273, startsAt: "private-date", userEmail: "secret@example.test" }] }), 200, "application/json") : response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result.responseContracts?.[0]).toMatchObject({ pathShape: "/venue/:value/availability", queryKeys: ["start_gte"], httpStatus: 200 });
    expect(JSON.stringify(result.responseContracts)).not.toMatch(/golf-oasis|private-date|9273|secret@example/u);
  });
  it("permits only exact CDN script/style assets declared by the first safe public document", async () => {
    const html = "<h1>Public rentals</h1><script src='https://cdn.example.test/app.js'></script><link rel='stylesheet' href='https://styles.example.test/site.css'><script src='https://cdn.example.test/captcha.js'></script>";
    const view = renderedBrowser([{ url: `${source}/` }, { url: "https://cdn.example.test/app.js", kind: "script" }, { url: "https://styles.example.test/site.css", kind: "stylesheet" },
      { url: "https://cdn.example.test/unproven.js", kind: "script" }, { url: "https://cdn.example.test/api", kind: "fetch" }, { url: "https://cdn.example.test/captcha.js", kind: "script" }, { url: "https://cdn.example.test/app.js", kind: "fetch" }], html);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(html) : response("public asset", 200, "text/javascript"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(3); expect(result.blockedRequests).toBe(4);
    expect(lease).toHaveBeenNthCalledWith(2, "cdn.example.test", expect.any(Function));
    expect(lease).toHaveBeenNthCalledWith(3, "styles.example.test", expect.any(Function));
    for (const route of view.routes.slice(3)) expect(route.abort).toHaveBeenCalledOnce();
  });
  it("exposes the existing fixed read-only bays route for an exact published Trackman booking root", async () => {
    const root = "https://booking.trackmangolf.com/venues/golf-oasis/booking";
    const result = await collectSimulatorSupportResearch({ url: root }, { fetch: vi.fn(async () => response("<h1>Public golf calendar</h1>")), lease });
    expect(result.links).toEqual([booking]);
    expect(result.bookingLinks).toEqual([booking]);
    expect(result.calendar).toBeUndefined();
    expect((await collectSimulatorSupportResearch({ url: root.replace("booking.trackmangolf.com", "yourgolfbooking.com") }, { fetch: vi.fn(async () => response("<h1>Public venue</h1>")), lease })).links).toEqual([]);
  });
  it("gives booking roles only to explicit bounded Book/Reserve/Appointment anchor labels", async () => {
    const html = "<a href='https://marketing.example.test/simulators'>Our simulators</a><a href='https://calendar.example.test/public' aria-label='Reserve a bay'>Calendar</a><a href='/schedule' title='Appointments'>Schedule</a><a href='/booking'>BookNow</a><a href='/checkout'>Book checkout</a>";
    const result = await collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response(html)), lease });
    expect(result.links).toContain("https://marketing.example.test/simulators");
    expect(result.bookingLinks).toEqual(["https://calendar.example.test/public", `${source}/schedule`, `${source}/booking`]);
    expect(JSON.stringify(result.bookingLinks)).not.toContain("Reserve a bay");
    expect(summarizeSimulatorSupportPublicHtml("<a href='/booking'>Book</a>", source)).toEqual({ text: "Book", links: [`${source}/booking`] });
  });
  it("observes only the exact anonymous same-venue occupancy API, without expanding other cross-origin data authority", async () => {
    const query = "?start_gte=2026-10-09T04%3A00%3A00Z&start_lte=2026-10-10T23%3A59%3A59-04%3A00";
    const api = `https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public${query}`;
    const view = renderedBrowser([{ url: booking }, { url: api, kind: "fetch", headers: { origin: "https://booking.trackmangolf.com" } },
      { url: api.replace("golf-oasis", "other-venue"), kind: "fetch" }, { url: api.replace("bookings/public", "customers"), kind: "fetch" }, { url: api, kind: "fetch", method: "POST" },
      { url: `${api}&extra=1`, kind: "fetch" }, { url: api, kind: "fetch", headers: { Cookie: "secret" } }], publishedConfig());
    const fetch = vi.fn(async (url: unknown) => String(url) === booking ? response(publishedConfig()) : new Response(JSON.stringify([{ id: 123, start: "private-time", customerEmail: "secret@example.test" }]), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } }));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(2); expect(result.blockedRequests).toBe(5);
    expect(lease).toHaveBeenNthCalledWith(2, "api.yourgolfbooking.com", expect.any(Function));
    expect(result.responseContracts?.[0]).toMatchObject({ pathShape: "/venue/:value/bookings/public", queryKeys: ["start_gte", "start_lte"] });
    expect(JSON.stringify(result.responseContracts)).not.toMatch(/private-time|secret@example|123|golf-oasis/u);
    expect(view.routes[1].fulfill.mock.calls[0][0].headers).toHaveProperty("access-control-allow-origin", "*");
  });
  it("recognizes YourGolfBooking research and its anonymous API only after exact published venue confirmation", async () => {
    const root = "https://yourgolfbooking.com/venues/golf-oasis/booking";
    const api = "https://api.yourgolfbooking.com/venue/golf-oasis/bookings/public?start_gte=2026-10-09T04%3A00%3A00Z&start_lte=2026-10-10T23%3A59%3A59Z";
    for (const confirmed of [false, true]) {
      const html = confirmed ? publishedConfig() : "<h1>Venue page</h1>";
      const view = renderedBrowser([{ url: root }, { url: api, kind: "fetch" }], html);
      const fetch = vi.fn(async (url: unknown) => String(url) === root ? response(html) : response("[]", 200, "application/json"));
      const result = await collectSimulatorSupportResearch({ url: root, render: true }, { fetch, lease, browser: view.factory });
      expect(fetch).toHaveBeenCalledTimes(confirmed ? 2 : 1);
      if (confirmed) expect(result.calendar).toMatchObject({ family: "YOUR_GOLF_BOOKING", venue: { slug: "golf-oasis" } });
      else expect(result.calendar).toBeUndefined();
      expect(result.responseContracts?.length ?? 0).toBe(confirmed ? 1 : 0);
    }
  });
  it.each(["https://yourgolfbooking.com", "https://www.yourgolfbooking.com"])("projects a changed public regular-bay contract on %s without claiming runtime support", async origin => {
    const root = `${origin}/venues/back9-golf/booking`;
    const html = publishedConfig().replaceAll("golf-oasis", "back9-golf").replace('"slug":"bays"', '"slug":"regular"').replace('"maxBookAheadValue":2', '"maxBookAheadValue":13').replace('"maxBookAheadUnit":"week"', '"maxBookAheadUnit":"day"')
      .replace('"name":"Public Rate"', '"name":"Regular Bay Rate"').replace('"minBookingDuration":1', '"minBookingDuration":2').replace('"maxBookingDuration":8', '"maxBookingDuration":10');
    const fetch = vi.fn(async () => response(html));
    const result = await collectSimulatorSupportResearch({ url: root }, { fetch, lease });
    expect(result.calendar).toMatchObject({ venue: { id: "1357", slug: "back9-golf" }, ranges: [{ id: "1397", slug: "regular", maxBookAheadValue: 13, maxBookAheadUnit: "day", slotDurationMinutes: 30 }],
      rentals: [{ id: "21451", name: "Regular Bay Rate", minDurationSlots: 2, maxDurationSlots: 10 }] });
    expect(result.bookingLinks).toEqual([`${root}/bays`]);
    expect(JSON.stringify(result)).not.toMatch(/never-return|secret@example|Private Member/u);
    const runtimeFetch = vi.fn<typeof globalThis.fetch>();
    await expect(fetchYourGolfBookingAvailability({ offering: { id: "research-offering", courseId: "research-venue", bookingUrl: root, providerFamilyKey: "YOUR_GOLF_BOOKING",
      providerMetadata: { venueSlug: "back9-golf", venueId: "1357", rangeId: "1397", publicOptionId: "21451" }, maxPartySize: 4, supportedDurationsMinutes: [60] },
      date: "2026-10-10", durationMinutes: 60, partySize: 1, timeZone: "America/New_York" }, runtimeFetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(runtimeFetch).not.toHaveBeenCalled();
  });
  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"])("normalizes only a recognized provider network failure %s", async code => {
    const network = new TypeError("fetch failed", { cause: Object.assign(new Error("Public request failed"), { code }) });
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => { throw network; }), lease })).rejects.toThrow("SIMULATOR_RESEARCH_NETWORK_FAILED");
  });
  it("normalizes a recognized Playwright navigation network error but preserves programming and persistence errors", async () => {
    const view = renderedBrowser([{ url: `${source}/` }]);
    view.page.goto.mockRejectedValueOnce(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at public destination"));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease, browser: view.factory })).rejects.toThrow("SIMULATOR_RESEARCH_NETWORK_FAILED");
    const programming = new Error("Parser programming invariant failed");
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => { throw programming; }), lease })).rejects.toBe(programming);
    const persistence = Object.assign(new Error("Lease persistence failed"), { code: "ECONNREFUSED" });
    const brokenLease = (async () => { throw persistence; }) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(), lease: brokenLease })).rejects.toBe(persistence);
    const rendered = renderedBrowser([{ url: `${source}/` }]);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease: brokenLease, browser: rendered.factory })).rejects.toBe(persistence);
  });
  it("does not spend the public request budget on more than 32 forbidden requests", async () => {
    const forbidden: RequestFixture[] = Array.from({ length: 10 }, (_, index) => [
      { url: `${source}/mutation-${index}`, method: "POST", kind: "fetch" },
      { url: `${source}/private-${index}`, headers: { Cookie: "private-session" }, kind: "fetch" },
      { url: `${source}/login` },
      { url: `https://tracker.example.test/${index}`, kind: "fetch" },
    ]).flat();
    const requests = [{ url: `${source}/` }, ...forbidden, { url: `${source}/public.js`, kind: "script" }, { url: `${source}/availability`, kind: "fetch" }];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(3); expect(lease).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ blockedRequests: 40, admittedRequests: 3, renderComplete: true, contentProvenance: "RENDERED_DOM" });
    expect(result.renderWarning).toBeUndefined();
    for (const route of view.routes.slice(1, 41)) expect(route.abort).toHaveBeenCalledOnce();
    expect(view.routes[42].fulfill).toHaveBeenCalledOnce();
  });
  it("aborts decorative image, font, media and other resources without provider I/O", async () => {
    const requests = [{ url: `${source}/` }, ...["image", "font", "media", "other"].map(kind => ({ url: `${source}/${kind}`, kind }))];
    const view = renderedBrowser(requests), fetch = vi.fn(async () => response("public"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledOnce(); expect(lease).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ blockedRequests: 4, admittedRequests: 1, renderComplete: true });
    for (const route of view.routes.slice(1)) expect(route.abort).toHaveBeenCalledOnce();
  });
  it("hard-bounds admitted reads at 32 while retaining only safe main HTTP facts with an incomplete-render diagnostic", async () => {
    const requests = [{ url: booking }, ...Array.from({ length: 39 }, (_, index) => ({ url: `${new URL(booking).origin}/public-${index}`, kind: "fetch" }))];
    const main = `${publishedConfig()}<a href='/venues/golf-oasis/booking'>Book a bay</a>`;
    const view = renderedBrowser(requests, "<h1>Unproven rendered output</h1><a href='/different'>Reserve</a>");
    const fetch = vi.fn(async (url: unknown) => String(url) === booking ? response(main) : response('{"slots":[{"startsAt":"private-time"}]}', 200, "application/json"));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory, now: () => instant });
    expect(fetch).toHaveBeenCalledTimes(32); expect(lease).toHaveBeenCalledTimes(32);
    expect(result).toMatchObject({ requestedUrl: booking, url: booking, observedAt: instant.toISOString(), httpStatus: 200, admittedRequests: 32, blockedRequests: 8,
      renderComplete: false, renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED", contentProvenance: "MAIN_DOCUMENT_HTTP", method: "BROWSER",
      calendar: { venue: { id: "1357" }, rentals: [{ id: "21451" }] }, links: ["https://booking.trackmangolf.com/venues/golf-oasis/booking"] });
    expect(result.text).toBe("Hourly simulator bays Book a bay");
    expect(result.responseContracts).toBeUndefined();
    expect(view.page.content).not.toHaveBeenCalled();
    for (const route of view.routes.slice(32)) { expect(route.abort).toHaveBeenCalledOnce(); expect(route.fulfill).not.toHaveBeenCalled(); }
    expect(JSON.stringify(result)).not.toMatch(/Unproven|private-time|secret@example|availableSlots/u);
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("serializes concurrent admitted assets per hostname before the shared lease without relaxing the 32-read cap", async () => {
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 35 }, (_, index) => ({ url: `${source}/asset-${index}`, kind: index % 2 ? "script" : "stylesheet" }))];
    const view = renderedBrowser(requests, "<h1>Rendered page</h1>", true);
    let active = 0, maximum = 0, busy = 0;
    const exclusiveLease = vi.fn(async (_host: string, worker: () => Promise<unknown>) => {
      if (active) { busy += 1; return { acquired: false as const }; }
      active += 1; maximum = Math.max(maximum, active);
      try { return { acquired: true as const, value: await worker() }; } finally { active -= 1; }
    }) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
    const fetch = vi.fn(async (url: unknown) => {
      if (String(url) !== `${source}/`) await new Promise(resolve => setTimeout(resolve, 1));
      return response(String(url) === `${source}/` ? "<h1>Safe main page</h1>" : "public asset");
    });
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease: exclusiveLease, browser: view.factory });
    expect(maximum).toBe(1); expect(busy).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(32); expect(exclusiveLease).toHaveBeenCalledTimes(32);
    expect(result).toMatchObject({ text: "Safe main page", admittedRequests: 32, blockedRequests: 4, renderComplete: false, renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" });
    for (const route of view.routes.slice(32)) expect(route.abort).toHaveBeenCalledOnce();
  });
  it("preserves partial HTTP facts after a budget-caused navigation abort but never masks unrelated browser errors", async () => {
    for (const expectedAbort of [true, false]) {
      const view = renderedBrowser([{ url: `${source}/` }, ...Array.from({ length: 32 }, (_, index) => ({ url: `${source}/script-${index}`, kind: "script" }))]);
      const original = view.page.goto.getMockImplementation()!;
      const failure = new Error(expectedAbort ? "page.goto: net::ERR_ABORTED at public destination" : "Browser programming invariant failed");
      view.page.goto.mockImplementation(async () => { await original(); throw failure; });
      const task = collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("<h1>Safe public page</h1>")), lease, browser: view.factory });
      if (expectedAbort) expect(await task).toMatchObject({ text: "Safe public page", admittedRequests: 32, renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP" });
      else await expect(task).rejects.toBe(failure);
      expect(view.page.content).not.toHaveBeenCalled();
    }
  });
  it("does not convert an owned lease failure or interactive-access response into partial successful research", async () => {
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 32 }, (_, index) => ({ url: `${source}/script-${index}`, kind: "script" }))];
    const failure = Object.assign(new Error("Lease persistence failed"), { code: "ECONNREFUSED" });
    let calls = 0;
    const brokenLease = (async (_host: string, worker: () => Promise<unknown>) => {
      if (++calls === 2) throw failure;
      return { acquired: true as const, value: await worker() };
    }) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
    const view = renderedBrowser(requests);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("<h1>Safe public page</h1>")), lease: brokenLease, browser: view.factory })).rejects.toBe(failure);
    const challenged = renderedBrowser(requests);
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("<h1>Verify you are human</h1>")), lease, browser: challenged.factory });
    expect(result).toMatchObject({ accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [], renderComplete: false });
    expect(result.renderWarning).toBeUndefined(); expect(result.calendar).toBeUndefined();
  });
  it.each([false, true])("renders an admitted three-megabyte secondary script within the shared budget (streamed=%s)", async streamed => {
    const asset = new URL("/public-app.js", booking).href, marker = "private-large-script-marker";
    const body = marker + "x".repeat(3_000_001 - marker.length);
    const main = `<h1>Safe public rentals</h1><script src='${asset}'></script>`;
    const view = renderedBrowser([{ url: booking }, { url: asset, kind: "script" }], publishedConfig());
    const fetch = vi.fn(async (url: unknown) => String(url) === booking ? response(main)
      : streamed ? new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(Buffer.from(body.slice(0, 1_500_001))); controller.enqueue(Buffer.from(body.slice(1_500_001))); controller.close();
        } }), { headers: { "content-type": "text/javascript" } })
        : new Response(body, { headers: { "content-type": "text/javascript", "content-length": String(body.length) } }));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ renderComplete: true, contentProvenance: "RENDERED_DOM", admittedRequests: 2, blockedRequests: 0 });
    expect(result.renderWarning).toBeUndefined(); expect(result.bodyLimitDiagnostics).toBeUndefined();
    expect(result.calendar).toEqual(extractSimulatorPublicCalendar(publishedConfig(), booking).calendar);
    expect(fetch).toHaveBeenCalledTimes(2); expect(view.routes[1].fulfill).toHaveBeenCalledOnce();
    expect(view.routes[1].fulfill.mock.calls[0][0].body).toHaveLength(body.length);
    expect(JSON.stringify(result)).not.toMatch(/private-large-script-marker|secret@example|never-return-this/);
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("serializes admitted scripts across hosts before spending the remaining rendered-body budget", async () => {
    const first = "https://first-cdn.example.test/app.js", second = "https://second-cdn.example.test/app.js";
    const main = `<h1>Safe public page</h1><script src='${first}'></script><script src='${second}'></script>`;
    const view = renderedBrowser([{ url: `${source}/` }, { url: first, kind: "script" }, { url: second, kind: "script" }], "<h1>Unproven output</h1>", true);
    let releaseFirst!: (value: Response) => void;
    const pendingFirst = new Promise<Response>(resolve => { releaseFirst = resolve; });
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(main)
      : String(url) === first ? pendingFirst : new Response("not-served", { headers: { "content-length": "3000001", "content-type": "text/javascript" } }));
    const collection = collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    const outcome = collection.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await vi.waitFor(() => expect(fetch.mock.calls.some(call => String(call[0]) === first)).toBe(true));
    await new Promise(resolve => setTimeout(resolve, 0));
    const secondStartedBeforeRelease = fetch.mock.calls.some(call => String(call[0]) === second);
    releaseFirst(new Response("x".repeat(3_000_001), { headers: { "content-length": "3000001", "content-type": "text/javascript" } }));
    const settled = await outcome;
    expect(secondStartedBeforeRelease).toBe(false);
    expect(classifySimulatorSupportFailure(settled.error, "PUBLIC_READ")).toMatchObject({ category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchResourceKind: "SECONDARY_SCRIPT" });
    expect(settled.value).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(3);
    expect(view.routes[1].fulfill).toHaveBeenCalledOnce(); expect(view.routes[2].fulfill).not.toHaveBeenCalled();
    expect(view.page.content).not.toHaveBeenCalled(); expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("accepts a script at the exact remaining six-megabyte budget without reading a later body", async () => {
    const main = "<h1>Safe main</h1>", remaining = 6_000_000 - Buffer.byteLength(main);
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/exact.js`, kind: "script" }, { url: `${source}/never-read-data`, kind: "xhr" }]);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(main)
      : new Response("x".repeat(remaining), { headers: { "content-length": String(remaining), "content-type": "text/javascript" } }));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toThrow("BODY_LIMIT");
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.some(call => String(call[0]).includes("never-read-data"))).toBe(false);
    expect(view.routes[1].fulfill.mock.calls[0][0].body).toHaveLength(remaining); expect(view.routes[2].fulfill).not.toHaveBeenCalled();
    expect(view.page.content).not.toHaveBeenCalled(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it.each([false, true])("rejects a script that exceeds the remaining aggregate budget without a partial success (streamed=%s)", async streamed => {
    const main = "<h1>Safe main</h1>", remaining = 6_000_000 - Buffer.byteLength(main), cancel = vi.fn();
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/over-remaining.js`, kind: "script" }]);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(main)
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(remaining)); controller.enqueue(new Uint8Array(1)); }, cancel }),
        { headers: { "content-type": "text/javascript", ...(streamed ? {} : { "content-length": String(remaining + 1) }) } }));
    let thrown: unknown;
    try { await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }); }
    catch (error) { thrown = error; }
    expect(classifySimulatorSupportFailure(thrown, "PUBLIC_READ")).toMatchObject({ category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchResourceKind: "SECONDARY_SCRIPT" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(view.routes[1].fulfill).not.toHaveBeenCalled();
    if (streamed) expect(cancel).toHaveBeenCalledOnce();
    expect(view.page.content).not.toHaveBeenCalled(); expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("keeps per-response and total body limits fatal and cleans up the browser", async () => {
    await expect(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => response("x".repeat(1_500_001))), lease })).rejects.toThrow("BODY_LIMIT");
    const view = renderedBrowser([{ url: `${source}/` }, ...Array.from({ length: 4 }, (_, index) => ({ url: `${source}/asset-${index}`, kind: "script" }))]);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("x".repeat(1_500_000), 200, "text/javascript")), lease, browser: view.factory })).rejects.toThrow("BODY_LIMIT");
    expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it.each(["redirect", "response"])("aborts only an unsafe stylesheet %s URL and continues queued safe script and public data reads", async seam => {
    const asset = new URL("/public.css", booking).href;
    const unsafe = new URL("/login?token=private", booking).href;
    const data = new URL("/public/data?date=2026-10-06", booking).href;
    const requests = [{ url: booking }, { url: asset, kind: "stylesheet" },
      ...Array.from({ length: 6 }, (_, index) => ({ url: new URL(`/asset-${index}.js`, booking).href, kind: "script" })),
      { url: data, kind: "xhr" }];
    const main = publishedConfig() + "<a href='/public-destination'>Book a bay</a>";
    const dom = publishedConfig() + "<h2>Observed rendered rental options</h2><a href='/rendered-destination'>Book a bay</a>";
    const view = renderedBrowser(requests, dom, true);
    const rejected = seam === "redirect" ? new Response(null, { status: 302, headers: { location: unsafe } })
      : Object.defineProperty(response("Rejected stylesheet", 200, "text/css"), "url", { value: unsafe });
    const fetch = vi.fn(async (url: unknown) => String(url) === booking ? response(main)
      : String(url) === asset ? rejected
        : String(url) === data ? response('{"ranges":[{"id":1397,"name":"private-value","customerEmail":"secret@example.test"}],"token":"never-return-this"}', 200, "application/json")
          : response("public queued script", 200, "text/javascript"));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory, now: () => instant });
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(requests.map(request => request.url));
    expect(fetch.mock.calls.every(call => String(call[0]) !== unsafe)).toBe(true);
    expect(lease).toHaveBeenCalledTimes(9);
    expect(result).toMatchObject({ requestedUrl: booking, url: booking, observedAt: instant.toISOString(),
      text: "Hourly simulator bays Observed rendered rental options Book a bay", links: [new URL("/rendered-destination", booking).href],
      admittedRequests: 9, blockedRequests: 1, renderComplete: false,
      renderWarning: "SECONDARY_STYLESHEET_URL_REJECTED", contentProvenance: "RENDERED_DOM" });
    expect(result.calendar).toEqual(extractSimulatorPublicCalendar(dom, booking).calendar);
    expect(result.responseContracts).toMatchObject([{ pathShape: "/public/:value", queryKeys: ["date"], httpStatus: 200,
      shape: expect.arrayContaining([{ path: "$", type: "object" }, { path: "$.ranges", type: "array", count: 1 }]) }]);
    expect(JSON.stringify(result)).not.toMatch(/private-value|secret@example|never-return-this|login/);
    expect(view.page.content).toHaveBeenCalledOnce();
    expect(view.routes[1].abort).toHaveBeenCalledOnce(); expect(view.routes[1].fulfill).not.toHaveBeenCalled();
    for (const route of view.routes.slice(2)) { expect(route.abort).not.toHaveBeenCalled(); expect(route.fulfill).toHaveBeenCalledOnce(); }
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("charges the rejected stylesheet response cap and keeps aggregate overflow hard", async () => {
    const rejected = `${source}/rejected.css`;
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 3 }, (_, index) => ({ url: `${source}/large-${index}.css`, kind: "stylesheet" })),
      { url: rejected, kind: "stylesheet" }];
    const view = renderedBrowser(requests);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>")
      : String(url) === rejected ? new Response("x".repeat(1_500_000), { status: 302, headers: { location: `${source}/login`, "content-type": "text/css" } })
        : response("x".repeat(1_500_000), 200, "text/css"));
    let error: unknown;
    try { await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }); }
    catch (caught) { error = caught; }
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchResourceKind: "SECONDARY_STYLESHEET" });
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.every(call => !String(call[0]).includes("/login"))).toBe(true);
    expect(view.routes[4].abort).toHaveBeenCalledOnce(); expect(view.routes[4].fulfill).not.toHaveBeenCalled();
    expect(view.page.content).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("keeps an unsafe stylesheet response hard without a successful main HTML document", async () => {
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/public.css`, kind: "stylesheet" }]);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("No safe main", 200, "application/json")
      : new Response(null, { status: 302, headers: { location: `${source}/login` } }));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toThrow("SIMULATOR_RESEARCH_UNSAFE_URL");
    expect(fetch).toHaveBeenCalledTimes(2); expect(view.page.content).not.toHaveBeenCalled();
  });
  it.each(["script", "fetch", "document"])("keeps an unsafe admitted %s response hard", async kind => {
    const main = kind === "document";
    const target = main ? `${source}/` : `${source}/public-resource`;
    const view = renderedBrowser(main ? [{ url: target }] : [{ url: `${source}/` }, { url: target, kind }]);
    const fetch = vi.fn(async (url: unknown) => String(url) === target
      ? new Response(null, { status: 302, headers: { location: `${source}/login` } }) : response("<h1>Safe main</h1>"));
    let error: unknown;
    try { await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }); }
    catch (caught) { error = caught; }
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "ACCESS", code: "UNSAFE_PUBLIC_URL",
      researchResourceKind: main ? "MAIN_DOCUMENT" : kind === "script" ? "SECONDARY_SCRIPT" : "XHR_OR_FETCH" });
    expect(fetch.mock.calls.every(call => !String(call[0]).includes("/login"))).toBe(true);
    expect(view.page.content).not.toHaveBeenCalled();
  });
  it.each(["transport", "headers"])("does not treat a spoofed unsafe-URL %s error as a collector-owned stylesheet rejection", async seam => {
    const spoofed = new Error("SIMULATOR_RESEARCH_UNSAFE_URL");
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/public.css`, kind: "stylesheet", ...(seam === "headers" ? { headersFailure: spoofed } : {}) }]);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>") : Promise.reject(spoofed));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toBe(spoofed);
    expect(view.page.content).not.toHaveBeenCalled();
  });
  it("does not hide an already-started unknown script failure behind a rejected stylesheet", async () => {
    const script = "https://cdn.example.test/public.js", unknown = new Error("Unrelated transport invariant");
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/public.css`, kind: "stylesheet" }, { url: script, kind: "script" }], "<h1>Unproven DOM</h1>", true);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response(`<h1>Safe main</h1><script src='${script}'></script>`)
      : String(url) === script ? new Promise<Response>((_resolve, reject) => setTimeout(() => reject(unknown), 0))
        : new Response(null, { status: 302, headers: { location: `${source}/login` } }));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toBe(unknown);
    expect(fetch).toHaveBeenCalledTimes(3); expect(view.page.content).not.toHaveBeenCalled();
  });
  it("settles an already-started access-control response and scrubs fallback after a stylesheet rejection aborts navigation", async () => {
    const asset = new URL("/public.css", booking).href;
    const subframe = "https://www.booking.trackmangolf.com/access-frame";
    const view = renderedBrowser([{ url: booking }]);
    let handler!: (route: Route) => Promise<void>;
    let releaseSubframe!: (value: Response) => void;
    const pendingSubframe = new Promise<Response>(resolve => { releaseSubframe = resolve; });
    view.context.route.mockImplementation(async (_pattern, callback) => { handler = callback; });
    const routes: Array<{ abort: ReturnType<typeof vi.fn>; fulfill: ReturnType<typeof vi.fn> }> = [];
    const run = (url: string, kind: string, frame: object) => {
      const route = { abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined) }; routes.push(route);
      return handler({ ...route, request: () => ({ url: () => url, method: () => "GET", allHeaders: async () => ({ "user-agent": "Public research browser" }),
        resourceType: () => kind, isNavigationRequest: () => kind === "document", frame: () => frame }) } as unknown as Route);
    };
    let frameWork: Promise<void> | undefined;
    view.page.goto.mockImplementation(async () => {
      await run(booking, "document", view.page.mainFrame());
      const assetWork = run(asset, "stylesheet", view.page.mainFrame());
      frameWork = run(subframe, "document", {});
      await assetWork;
      setTimeout(() => releaseSubframe(response("<h1>Verify you are human</h1>")), 0);
      throw new Error("page.goto: net::ERR_ABORTED at public destination");
    });
    const fetch = vi.fn(async (url: unknown) => String(url) === subframe ? pendingSubframe
      : String(url) === asset ? new Response(null, { status: 302, headers: { location: new URL("/login", booking).href } })
        : response(publishedConfig() + "<a href='/public-destination'>Book a bay</a>"));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    await frameWork;
    expect(fetch).toHaveBeenCalledTimes(3); expect(routes[1].abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ renderComplete: false, contentProvenance: "MAIN_DOCUMENT_HTTP", accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
    expect(result.renderWarning).toBeUndefined(); expect(result.calendar).toBeUndefined(); expect(result.jsonShape).toBeUndefined(); expect(result.responseContracts).toBeUndefined();
    expect(result.bookingLinks).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("Hourly simulator bays");
    expect(view.page.content).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("keeps a concurrent XHR failure hard when it arrives during stylesheet-rejection navigation settlement", async () => {
    const asset = new URL("/public.css", booking).href;
    const data = "https://www.booking.trackmangolf.com/public-data";
    const original = Object.assign(new Error("Public data DNS failure"), { code: "ENOTFOUND" });
    const view = renderedBrowser([{ url: booking }]);
    let handler!: (route: Route) => Promise<void>;
    let rejectData!: (error: Error) => void;
    const pendingData = new Promise<Response>((_resolve, reject) => { rejectData = reject; });
    view.context.route.mockImplementation(async (_pattern, callback) => { handler = callback; });
    const run = (url: string, kind: string) => handler({
      abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined),
      request: () => ({ url: () => url, method: () => "GET", allHeaders: async () => ({ "user-agent": "Public research browser" }),
        resourceType: () => kind, isNavigationRequest: () => kind === "document", frame: () => view.page.mainFrame() }) } as unknown as Route);
    let dataWork: Promise<void> | undefined;
    view.page.goto.mockImplementation(async () => {
      await run(booking, "document");
      const assetWork = run(asset, "stylesheet");
      dataWork = run(data, "xhr");
      await assetWork;
      setTimeout(() => rejectData(original), 0);
      throw new Error("page.goto: net::ERR_ABORTED at public destination");
    });
    const fetch = vi.fn(async (url: unknown) => String(url) === data ? pendingData
      : String(url) === asset ? new Response(null, { status: 302, headers: { location: new URL("/login", booking).href } })
        : response("<h1>Safe main</h1>"));
    let error: unknown;
    try { await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory }); }
    catch (caught) { error = caught; }
    await dataWork;
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "NETWORK", code: "PUBLIC_NETWORK_FAILED", researchResourceKind: "XHR_OR_FETCH" });
    expect(error).toMatchObject({ cause: original });
    expect(fetch).toHaveBeenCalledTimes(3); expect(view.page.content).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("retains bounded observed DOM with an incomplete warning after an oversized secondary stylesheet", async () => {
    const kind = "stylesheet";
    for (const streamed of [false, true]) {
      const asset = `${source}/large-${kind}`;
      const view = renderedBrowser([{ url: `${source}/` }, { url: asset, kind }], "<h1>Observed rendered page</h1>");
      const fetch = vi.fn(async (url: unknown) => String(url) === asset
        ? new Response("x".repeat(1_500_001), { headers: {
            "content-type": "text/css",
            ...(streamed ? {} : { "content-length": "1500001" }) } })
        : response("<h1>Safe initial public page</h1><a href='/booking'>Book a bay</a>"));
      const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory, now: () => instant });
      expect(fetch).toHaveBeenCalledTimes(2); expect(lease).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ method: "BROWSER", contentProvenance: "RENDERED_DOM", renderComplete: false,
        renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED", admittedRequests: 2, blockedRequests: 1,
        text: "Observed rendered page", observedAt: instant.toISOString() });
      expect(result.bodyLimitDiagnostics).toEqual([{ resourceKind: "SECONDARY_STYLESHEET",
        phase: streamed ? "COLLECTOR_BODY" : "COLLECTOR_HEADERS", observedSizeBand: "OVER_LIMIT_UP_TO_2X", count: 1 }]);
      expect(result.bodyLimitDiagnosticsTruncated).toBeUndefined();
      expect(result.responseContracts).toBeUndefined(); expect(view.page.content).toHaveBeenCalledOnce();
      expect(view.routes[1].abort).toHaveBeenCalledOnce(); expect(view.routes[1].fulfill).not.toHaveBeenCalled();
      expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
      vi.clearAllMocks();
    }
  });
  it("deduplicates owned capped leaves into closed kind, phase, size band and count only", async () => {
    const requests = [{ url: `${source}/` }, { url: `${source}/first.css`, kind: "stylesheet" },
      { url: `${source}/second.css`, kind: "stylesheet" }, { url: `${source}/large.css`, kind: "stylesheet" }];
    const view = renderedBrowser(requests, "<h1>Observed page</h1>");
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>") :
      new Response("secret-body", { headers: { "content-length": String(String(url).endsWith("large.css") ? 6_000_001 : 3_000_001) } }));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result.bodyLimitDiagnostics).toEqual([
      { resourceKind: "SECONDARY_STYLESHEET", phase: "COLLECTOR_HEADERS", observedSizeBand: "OVER_2X_UP_TO_4X", count: 2 },
      { resourceKind: "SECONDARY_STYLESHEET", phase: "COLLECTOR_HEADERS", observedSizeBand: "OVER_4X", count: 1 },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/first\.css|second\.css|large\.css|secret-body/u);
    expect(view.routes.slice(1).every(route => route.fulfill.mock.calls.length === 0)).toBe(true);
  });
  it("keeps a capped stylesheet diagnostic when a rejected stylesheet owns the displayed warning", async () => {
    const requests = [{ url: `${source}/` }, { url: `${source}/public.css`, kind: "stylesheet" },
      { url: `${source}/large.css`, kind: "stylesheet" }];
    const view = renderedBrowser(requests, "<h1>Partial rendered page</h1>");
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>") :
      String(url).endsWith("public.css") ? new Response(null, { status: 302, headers: { location: `${source}/login` } }) :
        new Response("secret-stylesheet", { headers: { "content-length": "1500001" } }));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(result).toMatchObject({ renderWarning: "SECONDARY_STYLESHEET_URL_REJECTED", renderComplete: false,
      bodyLimitDiagnostics: [{ resourceKind: "SECONDARY_STYLESHEET", phase: "COLLECTOR_HEADERS",
        observedSizeBand: "OVER_LIMIT_UP_TO_2X", count: 1 }] });
    expect(JSON.stringify(result)).not.toMatch(/large\.css|secret-stylesheet/u);
    expect(view.routes[2].fulfill).not.toHaveBeenCalled();
  });
  it("keeps main, XHR, subframe, lease and unrelated asset failures hard", async () => {
    for (const request of [{ url: `${source}/`, kind: "document" },
      { url: `${source}/public-data`, kind: "xhr" }, { url: `${source}/frame`, kind: "document", frame: "child" }]) {
      const main = request.url === `${source}/`;
      const view = renderedBrowser(main ? [request] : [{ url: `${source}/` }, request]);
      const fetch = vi.fn(async (url: unknown) => String(url) === request.url
        ? new Response("x", { headers: { "content-length": "1500001" } }) : response("<h1>Safe initial page</h1>"));
      let thrown: unknown;
      try { await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }); }
      catch (error) { thrown = error; }
      expect(classifySimulatorSupportFailure(thrown, "PUBLIC_READ")).toMatchObject({ category: "BUDGET", code: "PUBLIC_BODY_LIMIT",
        researchResourceKind: main ? "MAIN_DOCUMENT" : request.kind === "xhr" ? "XHR_OR_FETCH" : "SECONDARY_DOCUMENT" });
      expect(view.browser.close).toHaveBeenCalledOnce();
      vi.clearAllMocks();
    }
    const leaseError = Object.assign(new Error("private lease failure"), { code: "OFFICIAL_SITE_BODY_LIMIT" });
    let leaseCalls = 0;
    const brokenLease = vi.fn(async (_host: string, worker: () => Promise<unknown>) => {
      if (++leaseCalls === 2) throw leaseError;
      return { acquired: true as const, value: await worker() };
    }) as unknown as NonNullable<SimulatorResearchDependencies["lease"]>;
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/asset`, kind: "script" }]);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(async () => response("<h1>Safe</h1>")),
      lease: brokenLease, browser: view.factory })).rejects.toBe(leaseError);
    expect(view.routes[1].fulfill).not.toHaveBeenCalled();
  });
  it("does not relax the exact per-response cap or the total six-megabyte render cap", async () => {
    const exact = renderedBrowser([{ url: `${source}/` }, { url: `${source}/exact.css`, kind: "stylesheet" }]);
    const exactResult = await collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: vi.fn(async (url: unknown) => String(url).endsWith("exact.css")
        ? response("x".repeat(1_500_000), 200, "text/css") : response("<h1>Public page</h1>")),
      lease, browser: exact.factory });
    expect(exactResult).toMatchObject({ renderComplete: true, admittedRequests: 2 });
    expect(exactResult.renderWarning).toBeUndefined();
    expect(exact.routes[1].fulfill).toHaveBeenCalledOnce();
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 5 }, (_, index) => ({ url: `${source}/asset-${index}.css`, kind: "stylesheet" }))];
    const aggregate = renderedBrowser(requests);
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Public page</h1>")
        : response("x".repeat(1_500_000), 200, "text/css")), lease, browser: aggregate.factory })).rejects.toThrow("BODY_LIMIT");
    expect(aggregate.browser.close).toHaveBeenCalledOnce();
  });
  it.each(["stylesheet"])("continues queued safe scripts and public XHR after a capped %s without serving oversized bytes", async kind => {
    const large = `${source}/large-${kind}`, script = `${source}/public.js`, data = `${source}/public/data`;
    const requests = [{ url: `${source}/` }, { url: large, kind }, { url: script, kind: "script" }, { url: data, kind: "xhr" }];
    const view = renderedBrowser(requests, "<h1>Observed public rentals</h1>", true);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>")
      : String(url) === large ? new Response("oversize-never-served", { headers: { "content-length": "1500001", "content-type": kind === "script" ? "text/javascript" : "text/css" } })
        : String(url) === data ? response('{"ranges":[{"id":1397,"name":"private-value"}],"customerEmail":"secret@example.test"}', 200, "application/json")
          : response("public queued script", 200, "text/javascript"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch.mock.calls.map(call => String(call[0]))).toEqual(requests.map(request => request.url));
    expect(lease).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ text: "Observed public rentals", admittedRequests: 4, blockedRequests: 1,
      renderComplete: false, renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED", contentProvenance: "RENDERED_DOM",
      responseContracts: [{ pathShape: "/public/:value", queryKeys: [], httpStatus: 200 }] });
    expect(JSON.stringify(result)).not.toMatch(/private-value|secret@example|oversize-never-served/);
    expect(view.page.content).toHaveBeenCalledOnce();
    expect(view.routes[1].abort).toHaveBeenCalledOnce(); expect(view.routes[1].fulfill).not.toHaveBeenCalled();
    for (const route of view.routes.slice(2)) { expect(route.abort).not.toHaveBeenCalled(); expect(route.fulfill).toHaveBeenCalledOnce(); }
  });
  it.each(["SECONDARY_STYLESHEET_URL_REJECTED", "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED"])("retains only safe main facts after %s when navigation times out or aborts", async warning => {
    for (const failure of [Object.assign(new Error("Navigation timed out"), { name: "TimeoutError" }), new Error("page.goto: net::ERR_ABORTED at public destination")]) {
      const asset = `${source}/public.css`, data = `${source}/public/data`;
      const view = renderedBrowser([{ url: `${source}/` }, { url: asset, kind: "stylesheet" }, { url: data, kind: "fetch" }], "<h1>Never observed DOM</h1>");
      const original = view.page.goto.getMockImplementation()!;
      view.page.goto.mockImplementation(async () => { await original(); throw failure; });
      const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main facts</h1>")
        : String(url) === data ? response('{"ranges":[{"id":1397}]}', 200, "application/json")
          : warning === "SECONDARY_STYLESHEET_URL_REJECTED" ? new Response(null, { status: 302, headers: { location: `${source}/login` } })
            : new Response("oversize-never-served", { headers: { "content-length": "1500001", "content-type": "text/css" } }));
      const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({ text: "Safe main facts", renderComplete: false, renderWarning: warning, contentProvenance: "MAIN_DOCUMENT_HTTP" });
      expect(result.responseContracts).toBeUndefined(); expect(view.page.content).not.toHaveBeenCalled();
      expect(view.routes[1].fulfill).not.toHaveBeenCalled(); expect(view.routes[2].fulfill).toHaveBeenCalledOnce();
      expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
      vi.clearAllMocks();
    }
  });
  it("charges both rejected and capped leaf responses and preserves fatal aggregate overflow", async () => {
    const requests = [{ url: `${source}/` }, { url: `${source}/rejected.css`, kind: "stylesheet" },
      ...Array.from({ length: 3 }, (_, index) => ({ url: `${source}/capped-${index}.css`, kind: "stylesheet" })),
      { url: `${source}/never-read-data`, kind: "xhr" }];
    const view = renderedBrowser(requests);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>")
      : String(url).endsWith("rejected.css") ? new Response(null, { status: 302, headers: { location: `${source}/login` } })
        : new Response("oversize-never-served", { headers: { "content-length": "1500001", "content-type": "text/css" } }));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory })).rejects.toThrow("BODY_LIMIT");
    expect(fetch).toHaveBeenCalledTimes(5); expect(lease).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.every(call => !/login|never-read-data/u.test(String(call[0])))).toBe(true);
    expect(view.page.content).not.toHaveBeenCalled();
    for (const route of view.routes.slice(1)) expect(route.fulfill).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it.each(["SECONDARY_STYLESHEET_URL_REJECTED", "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED"])("does not refund the leaf read or relax the 32-request limit after %s", async renderWarning => {
    const asset = `${source}/public.css`;
    const requests = [{ url: `${source}/` }, { url: asset, kind: "stylesheet" },
      ...Array.from({ length: 35 }, (_, index) => ({ url: `${source}/public/data-${index}`, kind: "xhr" }))];
    const view = renderedBrowser(requests, "<h1>Never observed DOM</h1>", true);
    const fetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main facts</h1>")
      : String(url) === asset ? renderWarning === "SECONDARY_STYLESHEET_URL_REJECTED"
        ? new Response(null, { status: 302, headers: { location: `${source}/login` } })
        : new Response("oversize-never-served", { headers: { "content-length": "1500001", "content-type": "text/css" } })
      : response('{"ranges":[{"id":1397}]}', 200, "application/json"));
    const result = await collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory });
    expect(fetch).toHaveBeenCalledTimes(32); expect(lease).toHaveBeenCalledTimes(32);
    expect(result).toMatchObject({ admittedRequests: 32, blockedRequests: 6, text: "Safe main facts", renderComplete: false,
      renderWarning, contentProvenance: "MAIN_DOCUMENT_HTTP" });
    expect(result.responseContracts).toBeUndefined(); expect(view.page.content).not.toHaveBeenCalled();
    expect(view.routes[1].fulfill).not.toHaveBeenCalled();
    for (const route of view.routes.slice(32)) expect(route.fulfill).not.toHaveBeenCalled();
  });
  it("keeps an aggregate-cap breach and an already-started unrelated asset error hard", async () => {
    const requests = [{ url: `${source}/` }, ...Array.from({ length: 4 }, (_, index) => ({ url: `${source}/large-${index}.css`, kind: "stylesheet" }))];
    const overTotal = renderedBrowser(requests);
    const totalFetch = vi.fn(async (url: unknown) => String(url) === `${source}/` ? response("<h1>Safe main</h1>")
      : String(url).endsWith("large-3.css")
        ? new Response("x", { headers: { "content-length": "1500001", "content-type": "text/css" } })
        : response("x".repeat(1_500_000), 200, "text/css"));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: totalFetch, lease, browser: overTotal.factory })).rejects.toThrow("BODY_LIMIT");
    expect(totalFetch).toHaveBeenCalledTimes(5);
    const external = "https://cdn.example.test/broken.js";
    const simultaneous = renderedBrowser([{ url: `${source}/` }, { url: `${source}/large.js`, kind: "script" },
      { url: external, kind: "script" }], "<h1>Unproven rendered output</h1>", true);
    const unknown = new Error("Private unrelated transport failure");
    const mixedFetch = vi.fn(async (url: unknown) => String(url) === `${source}/`
      ? response(`<h1>Safe main</h1><script src='${external}'></script>`)
      : String(url) === external ? Promise.reject(unknown)
        : new Response("x", { headers: { "content-length": "1500001", "content-type": "text/javascript" } }));
    await expect(collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: mixedFetch, lease, browser: simultaneous.factory })).rejects.toBe(unknown);
    expect(mixedFetch).toHaveBeenCalledTimes(3);
  });
  it("preserves access controls arriving while an asset-limit navigation abort settles", async () => {
    const asset = new URL("/oversized.css", booking).href;
    const subframe = "https://www.booking.trackmangolf.com/access-frame";
    const view = renderedBrowser([{ url: booking }]);
    let handler!: (route: Route) => Promise<void>;
    let releaseSubframe!: (value: Response) => void;
    let navigationAborted = false, releasedAfterAbort = false;
    let subframeWork: Promise<void> | undefined;
    const pendingSubframe = new Promise<Response>(resolve => { releaseSubframe = resolve; });
    view.context.route.mockImplementation(async (_pattern, callback) => { handler = callback; });
    const run = (url: string, kind: string, frame: object) => handler({
      request: () => ({ url: () => url, method: () => "GET",
        allHeaders: async () => ({ "user-agent": "Public research browser" }),
        resourceType: () => kind, isNavigationRequest: () => kind === "document", frame: () => frame }),
      abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => undefined),
    } as unknown as Route);
    view.page.goto.mockImplementation(async () => {
      await run(booking, "document", view.page.mainFrame());
      const cappedAsset = run(asset, "stylesheet", view.page.mainFrame());
      subframeWork = run(subframe, "document", {});
      await cappedAsset;
      // The response is already admitted on a different hostname. It arrives
      // after goto rejects, while the collector settles its active routes.
      setTimeout(() => {
        releasedAfterAbort = navigationAborted;
        releaseSubframe(response("<h1>Verify you are human</h1>"));
      }, 0);
      navigationAborted = true;
      throw new Error("page.goto: net::ERR_ABORTED at public destination");
    });
    const fetch = vi.fn(async (url: unknown) => String(url) === subframe ? pendingSubframe
      : String(url) === asset
        ? new Response("x", { headers: { "content-length": "1500001", "content-type": "text/css" } })
        : response("<h1>Initial safe facts</h1>" + publishedConfig() + "<a href='/public-destination'>Book a bay</a>"));
    const result = await collectSimulatorSupportResearch({ url: booking, render: true }, { fetch, lease, browser: view.factory });
    await subframeWork;
    expect(releasedAfterAbort).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ method: "BROWSER", contentProvenance: "MAIN_DOCUMENT_HTTP",
      renderComplete: false, accessControls: ["CAPTCHA_OR_CHALLENGE"], text: "", links: [] });
    expect(result.renderWarning).toBeUndefined();
    expect(result.calendar).toBeUndefined(); expect(result.bookingLinks).toBeUndefined();
    expect(result.jsonShape).toBeUndefined(); expect(result.responseContracts).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("Initial safe facts");
    expect(view.page.content).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
  it("ends a hung render at the deadline and still closes its isolated context", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const view = renderedBrowser([{ url: `${source}/` }]);
    view.page.goto.mockImplementation(async () => new Promise<never>(() => undefined));
    const task = collectSimulatorSupportResearch({ url: source, render: true }, { fetch: vi.fn(), lease, browser: view.factory });
    const assertion = expect(task).rejects.toThrow("DEADLINE");
    await vi.waitFor(() => expect(view.page.goto).toHaveBeenCalledOnce());
    controller.abort();
    await assertion;
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });
});

describe("trusted source-research failure phases", () => {
  async function rejected(task: Promise<unknown>) {
    const result = await task.then(() => ({ rejected: false, error: undefined }), error => ({ rejected: true, error }));
    expect(result.rejected).toBe(true);
    return result.error;
  }

  const phases: SimulatorResearchFailurePhase[] = ["HTTP_READ", "BROWSER_LAUNCH", "BROWSER_CONTEXT", "BROWSER_ROUTE_SETUP",
    "BROWSER_REQUEST", "BROWSER_NAVIGATION", "BROWSER_DOCUMENT"];
  it.each(phases)("identifies %s without altering a sealed unknown error or its category", async phase => {
    const original = Object.seal(new Error("private URL and browser details must stay out of the diagnostic"));
    const properties = Object.getOwnPropertyNames(original);
    const view = renderedBrowser([{ url: `${source}/`, ...(phase === "BROWSER_REQUEST" ? { headersFailure: original } : {}) }]);
    const fetch = vi.fn(async () => response("<h1>Public rentals</h1>"));
    let browser = view.factory;
    if (phase === "HTTP_READ") fetch.mockImplementation(async () => { throw original; });
    if (phase === "BROWSER_LAUNCH") browser = async () => { throw original; };
    if (phase === "BROWSER_CONTEXT") view.browser.newContext.mockRejectedValueOnce(original);
    if (phase === "BROWSER_ROUTE_SETUP") view.context.routeWebSocket.mockRejectedValueOnce(original);
    if (phase === "BROWSER_NAVIGATION") view.page.goto.mockRejectedValueOnce(original);
    if (phase === "BROWSER_DOCUMENT") view.page.content.mockRejectedValueOnce(original);
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: phase !== "HTTP_READ" }, { fetch, lease, browser }));
    expect(error).toBe(original);
    expect(Object.getOwnPropertyNames(original)).toEqual(properties);
    const diagnostic = classifySimulatorSupportFailure(error, "PUBLIC_READ");
    expect(diagnostic).toMatchObject({ stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: phase });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private URL|browser details/u);
    if (phase !== "HTTP_READ" && phase !== "BROWSER_LAUNCH") expect(view.browser.close).toHaveBeenCalledOnce();
  });

  it("tags a synchronous launch failure before any browser or provider work", async () => {
    const original = Object.freeze(new Error("launch invariant"));
    const fetch = vi.fn();
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease,
      browser: () => { throw original; } }));
    expect(error).toBe(original);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN", researchPhase: "BROWSER_LAUNCH" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["newPage", "route"] as const)("tags the exact %s seam and still closes the browser", async method => {
    const original = new Error("browser invariant");
    const view = renderedBrowser([{ url: `${source}/` }]);
    view.context[method].mockRejectedValueOnce(original);
    const fetch = vi.fn();
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }));
    expect(error).toBe(original);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN",
      researchPhase: method === "newPage" ? "BROWSER_CONTEXT" : "BROWSER_ROUTE_SETUP" });
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tags HTTP response-body failures without treating them as network or browser failures", async () => {
    const original = Object.freeze(new Error("response body invariant"));
    const body = new ReadableStream({ start(controller) { controller.error(original); } });
    const error = await rejected(collectSimulatorSupportResearch({ url: source }, { fetch: vi.fn(async () => new Response(body)), lease }));
    expect(error).toBe(original);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN", researchPhase: "HTTP_READ" });
  });

  it("retains the first concurrent route failure ahead of a later navigation error", async () => {
    const first = Object.freeze(new Error("first route invariant")), second = new Error("second route invariant"), navigation = new Error("navigation after routing");
    const view = renderedBrowser([{ url: `${source}/` }, { url: `${source}/first.js`, kind: "script", headersFailure: first },
      { url: `${source}/second.js`, kind: "script", headersFailure: second }], "<h1>Public rentals</h1>", true);
    const originalGoto = view.page.goto.getMockImplementation()!;
    view.page.goto.mockImplementation(async () => { await originalGoto(); throw navigation; });
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: vi.fn(async () => response("<h1>Public rentals</h1>")), lease, browser: view.factory }));
    expect(error).toBe(first);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN", researchPhase: "BROWSER_REQUEST" });
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });

  it("retains an early request() exception when navigation rejects before route settlement", async () => {
    const original = Object.freeze(new Error("request retrieval invariant"));
    const view = renderedBrowser([{ url: `${source}/`, requestFailure: original }]);
    const originalGoto = view.page.goto.getMockImplementation()!;
    view.page.goto.mockImplementation(async () => {
      await originalGoto().catch(() => undefined);
      throw new Error("navigation failed after its route handler rejected");
    });
    const fetch = vi.fn();
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: true }, { fetch, lease, browser: view.factory }));
    expect(error).toBe(original);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_REQUEST" });
    expect(fetch).not.toHaveBeenCalled();
    expect(view.context.close).toHaveBeenCalledOnce(); expect(view.browser.close).toHaveBeenCalledOnce();
  });

  it.each(["HTTP_READ", "BROWSER_NAVIGATION"] as const)("preserves recognized network normalization and the original %s phase", async phase => {
    const original = phase === "HTTP_READ" ? Object.assign(new Error("public network"), { code: "ECONNRESET" }) :
      new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at public destination");
    const view = renderedBrowser([{ url: `${source}/` }]);
    if (phase === "BROWSER_NAVIGATION") view.page.goto.mockRejectedValueOnce(original);
    const fetch = vi.fn(async () => { throw original; });
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: phase === "BROWSER_NAVIGATION" }, { fetch, lease, browser: view.factory }));
    expect(error).toMatchObject({ message: "SIMULATOR_RESEARCH_NETWORK_FAILED", cause: original });
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "NETWORK", code: "PUBLIC_NETWORK_FAILED", researchPhase: phase });
  });

  it("keeps the inner HTTP phase when a rendered request also fails navigation", async () => {
    const original = Object.freeze(new Error("HTTP implementation invariant"));
    const view = renderedBrowser([{ url: `${source}/` }]);
    const originalGoto = view.page.goto.getMockImplementation()!;
    view.page.goto.mockImplementation(async () => { await originalGoto(); throw new Error("navigation after HTTP failure"); });
    const error = await rejected(collectSimulatorSupportResearch({ url: source, render: true }, {
      fetch: vi.fn(async () => { throw original; }), lease, browser: view.factory }));
    expect(error).toBe(original);
    expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({ category: "UNKNOWN", researchPhase: "HTTP_READ" });
  });
});
