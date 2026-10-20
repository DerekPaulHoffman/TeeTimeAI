// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AMELIA_CLIENT_HASHES, ameliaMetadataSchema, parseAmeliaBookingPage, parseAmeliaEntities, parseAmeliaPublicClient,
  verifyAmeliaClients, verifyAmeliaOfficialPage, type AmeliaIdentitySource } from "./amelia-source";

// Keep these tests small: the real inspected clients are hash-pinned in code,
// while these exact inert fixtures stand in for those reviewed bytes only.
const clients = vi.hoisted(() => ({ public: 'import{x}from"./stepForm-abcdef01.js";import{y}from"./eventBooking-abcdef02.js";', step: "reviewed-step-fixture", event: "reviewed-event-fixture" }));
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const pins = new Map([[clients.public, "eeca0eb849ccf96ced5cd7b253bd1721df1775f6e426a4acd435f0d1c3381d5b"],
    [clients.step, "e1958107085afec8d43216af542b5ab656ee6ccdcff601be7b07590012ad0d1e"],
    [clients.event, "494abf35444be17abb264766c4a712ffededaafb37b982bd1e7da087d6add42c"]]);
  return { ...actual, createHash: (algorithm: string) => {
    let content = "";
    return { update(value: string) { content += value; return this; }, digest(encoding: "hex") { return pins.get(content) ?? actual.createHash(algorithm).update(content).digest(encoding); } };
  } };
});

const source: AmeliaIdentitySource = { officialUrl: "https://rental.example.org/", bookingUrl: "https://rental.example.org/book/",
  venueName: "Eagles Nest Golf LLC", venueAddress: "29 E Powell Blvd, Gresham, OR 97030, USA", timeZone: "America/Los_Angeles" };
const settings = { wordpress: { timezone: "America/Los_Angeles", startOfWeek: 0 }, general: { showClientTimeZone: true, timeSlotLength: 1800 },
  appointments: { bringingAnyoneLogic: "additional", bookMultipleTimes: false, employeeSelection: "random", isGloballyBusySlot: false } };
const shortcode = { hasApiCall: false, trigger: "", trigger_type: "", triggered_form: "sbsNew", in_dialog: "", show: "", counter: "1000",
  category: "", service: "", employee: "", location: "", package: "", layout: "", ivy: "" };
const urls = { wpAmeliaUseUploadsAmeliaPath: "1", wpAmeliaPluginURL: "/wp-content/plugins/ameliabooking/", wpAmeliaPluginAjaxURL: "/wp-admin/admin-ajax.php?action=wpamelia_api&call=" };
function booking(overrides: { shortcode?: Record<string, unknown>; settings?: unknown; urls?: unknown; extra?: string } = {}) {
  return `<div id="amelia-v2-booking-1000" class="amelia-v2-booking"></div><script>var wpAmeliaSettings=${JSON.stringify(overrides.settings ?? settings)};
var wpAmeliaUrls=${JSON.stringify(overrides.urls ?? urls)};ameliaShortcodeData.push(${JSON.stringify({ ...shortcode, ...overrides.shortcode })});</script>
<script type="module" src="/wp-content/plugins/ameliabooking/v3/public/assets/public.js?ver=9.8.1"></script>${overrides.extra ?? ""}`;
}
function official() { return `<title>Eagle’s Nest Golf | Public rentals</title><h1>Eagle’s Nest Golf</h1><a href="/book/">Book tee time</a>
<address>29 East Powell Boulevard<br>Gresham, OR 97030</address>`; }
const rental = { id: 1, name: "Golf Simulator", duration: 3600, minCapacity: 1, maxCapacity: 4, bringingAnyone: true, show: true, status: "visible",
  timeBefore: null, timeAfter: 1800, aggregatedPrice: false, mandatoryExtra: false, recurringCycle: "disabled", extras: [{ id: 2, name: "Additional hour", duration: 3600, maxQuantity: 4, type: "extra" }] };
function entities() { return { message: "Successfully retrieved entities", data: { categories: [{ id: 1, status: "visible", serviceList: [structuredClone(rental)] }],
  locations: [], entitiesRelations: { "3": { "1": [null] } } as Record<string, Record<string, (number | null)[]>>, employees: [{ id: 3, type: "provider", status: "visible", serviceList: [structuredClone(rental)] }] } }; }
function context() {
  const page = parseAmeliaBookingPage(booking(), source.bookingUrl, source), witness = parseAmeliaPublicClient(clients.public, page.publicClientUrl);
  return { ...page, ...verifyAmeliaClients(page, witness, { step: clients.step, event: clients.event }) };
}
afterEach(() => vi.restoreAllMocks());

describe("strong same-origin Amelia source identity", () => {
  it("accepts full possessive name, terminal LLC, directional and street-type equivalents", () => expect(() => verifyAmeliaOfficialPage(source, official())).not.toThrow());
  it("accepts the exact source name plus a simulator title descriptor only with exact heading", () => {
    expect(() => verifyAmeliaOfficialPage(source, official().replace("Eagle’s Nest Golf |", "Eagle’s Nest Golf Simulator |"))).not.toThrow();
    for (const suffix of ["Academy", "Other Golf", "Portland", "Simulators Academy"])
      expect(() => verifyAmeliaOfficialPage(source, official().replace("Eagle’s Nest Golf |", `Eagle’s Nest Golf ${suffix} |`))).toThrow();
    expect(() => verifyAmeliaOfficialPage(source, official().replace("<h1>Eagle’s Nest Golf</h1>", "<h1>Eagle’s Nest Golf Simulator</h1>"))).toThrow();
  });
  it.each([
    ["street number", official().replace("29 East", "129 East")],
    ["different city", official().replace("Gresham", "Portland")],
    ["different postal code", official().replace("97030", "97031")],
    ["different direction", official().replace("East Powell", "West Powell")],
    ["different name", official().replaceAll("Eagle’s Nest Golf", "Eagle’s Nest Golf Academy")],
    ["hidden address", official().replace("<address>", '<address class="d-none">')],
    ["hidden title", official().replace("<title>", '<title hidden>')],
    ["hidden link", official().replace("<a href", '<a style="opacity:0" href')],
    ["mailing address", official().replace("<address>", '<section aria-label="Mailing address"><address>') + "</section>"],
    ["wrong booking link", official().replace('href="/book/"', 'href="/other-book/"')],
  ])("rejects %s", (_name, html) => expect(() => verifyAmeliaOfficialPage(source, html)).toThrow("ADAPTER_IDENTITY_MISMATCH"));
  it("rejects origin substitution and short generic identity", () => {
    expect(() => verifyAmeliaOfficialPage(source, official(), "https://other.example.org/")).toThrow();
    expect(() => verifyAmeliaOfficialPage({ ...source, venueName: "Golf LLC" }, official())).toThrow();
  });
});

describe("inert bootstrap and reviewed client witnesses", () => {
  it("reads only supported public shortcode, endpoint and explicit timezone settings", () => {
    const page = parseAmeliaBookingPage(booking(), source.bookingUrl, source);
    expect(page).toMatchObject({ apiUrl: "https://rental.example.org/wp-admin/admin-ajax.php", timeZone: source.timeZone,
      settings: { timeZone: source.timeZone, bringingAnyoneLogic: "additional", startOfWeek: 0 }, shortcode: { form: "sbsNew", service: null } });
  });
  it.each(["category", "service", "employee", "location", "package", "show", "in_dialog", "trigger", "ivy"])("rejects narrowed or triggered shortcode %s", key =>
    expect(() => parseAmeliaBookingPage(booking({ shortcode: { [key]: "1" } }), source.bookingUrl, source)).toThrow("ADAPTER_SHORTCODE_SCOPE_UNSUPPORTED"));
  it("rejects duplicate widgets/bootstrap and source endpoint substitution", () => {
    expect(() => parseAmeliaBookingPage(booking({ extra: '<div class="amelia-v2-booking" id="amelia-v2-booking-2000"></div>' }), source.bookingUrl, source)).toThrow();
    expect(() => parseAmeliaBookingPage(booking() + booking(), source.bookingUrl, source)).toThrow();
    expect(() => parseAmeliaBookingPage(booking({ urls: { ...urls, wpAmeliaPluginAjaxURL: "https://other.example.org/api" } }), source.bookingUrl, source)).toThrow("ADAPTER_ENDPOINT_UNVERIFIED");
  });
  it("never evaluates shortcode expressions", () => {
    const html = booking().replace('"service":""', '"service":globalThis.__unsafe()');
    expect(() => parseAmeliaBookingPage(html, source.bookingUrl, source)).toThrow();
    expect((globalThis as Record<string, unknown>).__unsafe).toBeUndefined();
  });
  it("rejects timezone, attendee, grid and grouped-booking semantic drift", () => {
    for (const changed of [{ ...settings, wordpress: { ...settings.wordpress, timezone: "America/New_York" } },
      { ...settings, wordpress: { ...settings.wordpress, startOfWeek: 1 } },
      { ...settings, appointments: { ...settings.appointments, bringingAnyoneLogic: "total" } },
      { ...settings, appointments: { ...settings.appointments, bookMultipleTimes: true } }])
      expect(() => parseAmeliaBookingPage(booking({ settings: changed }), source.bookingUrl, source)).toThrow();
  });
  it("accepts only all three reviewed client hashes and same-directory imports", () => {
    expect(createHash("sha256").update(clients.public).digest("hex")).toBe(AMELIA_CLIENT_HASHES.public);
    const page = parseAmeliaBookingPage(booking(), source.bookingUrl, source), witness = parseAmeliaPublicClient(clients.public, page.publicClientUrl);
    expect(verifyAmeliaClients(page, witness, { step: clients.step, event: clients.event })).toMatchObject({ publicClientSha256: AMELIA_CLIENT_HASHES.public, eventClientSha256: AMELIA_CLIENT_HASHES.event });
    expect(() => parseAmeliaPublicClient(`${clients.public} `, page.publicClientUrl)).toThrow("ADAPTER_CLIENT_UNSUPPORTED");
    expect(() => verifyAmeliaClients(page, witness, { step: `${clients.step} `, event: clients.event })).toThrow("ADAPTER_CLIENT_UNSUPPORTED");
    expect(() => verifyAmeliaClients(page, { ...witness, stepClientUrl: "https://other.example.org/stepForm-abcdef01.js" }, { step: clients.step, event: clients.event })).toThrow();
  });
});

describe("complete public service/provider projection", () => {
  it("normalizes all eligible resources without staff PII and preserves base versus buffer", () => {
    const data = entities(); Object.assign(data.data.employees[0], { email: "private@example.org", firstName: "Private" });
    const parsed = parseAmeliaEntities(data, context());
    expect(parsed.services).toEqual([{ id: 1, name: "Golf Simulator", durationSeconds: 3600, timeBeforeSeconds: 0, timeAfterSeconds: 1800,
      minCapacity: 1, maxCapacity: 4, bringingAnyone: true, aggregatedPrice: false, hasDurationExtras: true, providerIds: [3] }]);
    expect(parsed.providers).toEqual([{ id: 3, serviceIds: [1] }]); expect(JSON.stringify(parsed)).not.toContain("private@example");
    expect(ameliaMetadataSchema.safeParse({ ...parsed, staffEmail: "x" }).success).toBe(false);
  });
  it("supports multiple rental products/providers with deterministic ordering and hashes", () => {
    const data = entities(); data.data.categories[0].serviceList.push({ ...rental, id: 4, name: "Golf Bay Rental" });
    data.data.employees[0].serviceList.push({ ...rental, id: 4, name: "Golf Bay Rental" });
    data.data.employees.push({ ...data.data.employees[0], id: 5, serviceList: [...data.data.employees[0].serviceList] });
    data.data.entitiesRelations = { "3": { "1": [null], "4": [null] }, "5": { "1": [null], "4": [null] } };
    const first = parseAmeliaEntities(data, context()); data.data.categories[0].serviceList.reverse(); data.data.employees.reverse();
    for (const employee of data.data.employees) employee.serviceList.reverse();
    expect(parseAmeliaEntities(data, context())).toEqual(first); expect(first.services[0].providerIds).toEqual([3, 5]);
  });
  it.each(["Golf Lessons", "Golf Membership", "Golf Tournament", "Member Simulator Rental", "Golf Simulator Party", "Golf Simulator Parties"])("excludes explicit nonpublic rental product %s", name => {
    const data = entities(); data.data.categories[0].serviceList.push({ ...rental, id: 4, name });
    expect(parseAmeliaEntities(data, context()).services).toHaveLength(1);
  });
  it("rejects ambiguous golf products instead of silently dropping them", () => {
    const data = entities(); data.data.categories[0].serviceList.push({ ...rental, id: 4, name: "Golf Session" });
    expect(() => parseAmeliaEntities(data, context())).toThrow("ADAPTER_RENTAL_UNVERIFIED");
  });
  it.each(["Simulator Rental", "Bay Rental", "Baseball Simulator Rental", "Flight Simulator Rental", "Multi-Sport Simulator Rental", "Golf and Baseball Simulator Rental", "Golf MultiSport Simulator", "Disc Golf Simulator"])("rejects unbound or mixed rental resource %s", name => {
    const data = entities(); data.data.categories[0].serviceList[0].name = name; data.data.employees[0].serviceList[0].name = name;
    expect(() => parseAmeliaEntities(data, context())).toThrow("ADAPTER_RENTAL_UNVERIFIED");
  });
  it.each(["locations", "missing providers", "different provider duration", "required extras", "recurring rental", "duplicate resource", "partial schema"])("rejects %s", scenario => {
    const data = entities();
    if (scenario === "locations") Object.assign(data.data, { locations: [{ id: 1 }] });
    if (scenario === "missing providers") data.data.employees = [];
    if (scenario === "different provider duration") data.data.employees[0].serviceList[0].duration = 7200;
    if (scenario === "required extras") data.data.categories[0].serviceList[0].mandatoryExtra = true;
    if (scenario === "recurring rental") data.data.categories[0].serviceList[0].recurringCycle = "daily";
    if (scenario === "duplicate resource") data.data.employees.push(structuredClone(data.data.employees[0]));
    if (scenario === "partial schema") Object.assign(data, { data: { categories: [] } });
    expect(() => parseAmeliaEntities(data, context())).toThrow();
  });
  it("changes immutable metadata when a visible rental/provider or optional extra changes", () => {
    const data = entities(), first = parseAmeliaEntities(data, context());
    data.data.categories[0].serviceList[0].extras[0].duration = 7200;
    expect(parseAmeliaEntities(data, context()).catalogHash).not.toBe(first.catalogHash);
    data.data.employees[0].id = 9; data.data.entitiesRelations = { "9": { "1": [null] } }; expect(parseAmeliaEntities(data, context()).providers[0].id).toBe(9);
  });
  it("accepts actual JSON-encoded person pricing without advertising dormant duration choices", () => {
    const pricing = JSON.stringify({ enabled: "person", durations: { "7200": { price: 60, rules: [] } }, persons: { "2": { price: 40, rules: [] } }, periods: { default: [], custom: [] } });
    const data = entities(); Object.assign(data.data.categories[0].serviceList[0], { customPricing: pricing }); Object.assign(data.data.employees[0].serviceList[0], { customPricing: pricing });
    const parsed = parseAmeliaEntities(data, context()); expect(parsed.services[0].durationSeconds).toBe(3600);
    expect(parsed.services[0]).not.toHaveProperty("durations"); expect(parsed.services[0].hasDurationExtras).toBe(true);
  });
  it.each([true, "duration", "period", "unknown"])("rejects unsupported global/provider custom duration mode %s", enabled => {
    for (const provider of [false, true]) {
      const data = entities(), service = provider ? data.data.employees[0].serviceList[0] : data.data.categories[0].serviceList[0];
      Object.assign(service, { customPricing: JSON.stringify({ enabled, durations: {}, persons: {}, periods: { default: [], custom: [] } }) });
      expect(() => parseAmeliaEntities(data, context())).toThrow("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
    }
  });
  it("rejects malformed pricing, nonempty rules/periods and duplicate extra IDs", () => {
    for (const customPricing of ["not-json", JSON.stringify({ enabled: "person", durations: {}, persons: { "2": { price: 40, rules: [1] } }, periods: { default: [], custom: [] } }),
      JSON.stringify({ enabled: "person", durations: {}, persons: {}, periods: { default: [1], custom: [] } })]) {
      const data = entities(); Object.assign(data.data.categories[0].serviceList[0], { customPricing });
      expect(() => parseAmeliaEntities(data, context())).toThrow("ADAPTER_CUSTOM_PRICING_UNSUPPORTED");
    }
    const data = entities(); data.data.categories[0].serviceList[0].extras.push({ ...data.data.categories[0].serviceList[0].extras[0] });
    expect(() => parseAmeliaEntities(data, context())).toThrow("ADAPTER_CATALOG_AMBIGUOUS");
  });
  it.each(["category", "excluded service", "hidden provider", "provider service", "unknown service"])("rejects ambiguous IDs in %s", scenario => {
    const data = entities();
    if (scenario === "category") data.data.categories.push({ ...data.data.categories[0], serviceList: [] });
    if (scenario === "excluded service") data.data.categories[0].serviceList.push({ ...rental, name: "Golf Lessons" });
    if (scenario === "hidden provider") data.data.employees.push({ ...data.data.employees[0], status: "hidden" });
    if (scenario === "provider service") data.data.employees[0].serviceList.push({ ...rental });
    if (scenario === "unknown service") data.data.employees[0].serviceList.push({ ...rental, id: 999 });
    expect(() => parseAmeliaEntities(data, context())).toThrow();
  });
  it.each(["missing", "empty membership", "location ID", "duplicate null", "unknown provider", "unknown service", "noncanonical ID"])("rejects unproven relation %s", scenario => {
    const data = entities();
    if (scenario === "missing") data.data.entitiesRelations = {};
    if (scenario === "empty membership") data.data.entitiesRelations["3"]["1"] = [];
    if (scenario === "location ID") data.data.entitiesRelations["3"]["1"] = [1];
    if (scenario === "duplicate null") data.data.entitiesRelations["3"]["1"] = [null, null];
    if (scenario === "unknown provider") data.data.entitiesRelations["4"] = { "1": [null] };
    if (scenario === "unknown service") data.data.entitiesRelations["3"]["9"] = [null];
    if (scenario === "noncanonical ID") data.data.entitiesRelations["03"] = { "1": [null] };
    expect(() => parseAmeliaEntities(data, context())).toThrow();
  });
  it("retains known non-rental relation IDs without treating them as rental products", () => {
    const data = entities(); data.data.categories[0].serviceList.push({ ...rental, id: 2, name: "Golf Lessons" });
    data.data.employees[0].serviceList.push({ ...rental, id: 2, name: "Golf Lessons" }); data.data.entitiesRelations["3"]["2"] = [null];
    const parsed = parseAmeliaEntities(data, context()); expect(parsed.services.map(value => value.id)).toEqual([1]);
    const originalHash = parsed.catalogHash; delete data.data.entitiesRelations["3"]["2"];
    expect(parseAmeliaEntities(data, context()).catalogHash).not.toBe(originalHash);
  });
});

describe("bootstrap mutation and inert-source rejection", () => {
  it.each(["let", "const"])("rejects lexical-only %s bootstrap that does not create window globals", kind =>
    expect(() => parseAmeliaBookingPage(booking().replaceAll("var wpAmelia", `${kind} wpAmelia`), source.bookingUrl, source)).toThrow());
  it.each(["text/plain", "application/json", "module"])("rejects non-global bootstrap script type %s", type =>
    expect(() => parseAmeliaBookingPage(booking().replace("<script>", `<script type="${type}">`), source.bookingUrl, source)).toThrow());
  it.each([
    'wpAmeliaSettings.wordpress.timezone="UTC";',
    'wpAmeliaUrls={};',
    'Object.assign(wpAmeliaSettings,{wordpress:{timezone:"UTC"}});',
    'window["wpAmeliaSettings"]={};',
    'globalThis.wpAmeliaUrls={};',
    'ameliaShortcodeData[0].service="1";',
  ])("rejects later protected mutation %s", suffix => expect(() => parseAmeliaBookingPage(booking({ extra: `<script>${suffix}</script>` }), source.bookingUrl, source)).toThrow());
  it.each([
    '"wordpress":{"timezone":"America/Los_Angeles","startOfWeek":0},...overrides',
    '"wordpress":{"timezone":"America/Los_Angeles","startOfWeek":0},["wordpress"]:overrides',
    '"wordpress":{"timezone":"America/Los_Angeles","startOfWeek":0},get wordpress(){return overrides}',
    '"wordpress":{"timezone":"America/Los_Angeles","startOfWeek":0},"wordpress":{}',
  ])("rejects overriding object forms", replacement => {
    const html = booking().replace('"wordpress":{"timezone":"America/Los_Angeles","startOfWeek":0}', replacement);
    expect(() => parseAmeliaBookingPage(html, source.bookingUrl, source)).toThrow();
  });
  it("rejects ignored executable fields and shortcode computed overrides", () => {
    expect(() => parseAmeliaBookingPage(booking().replace('"ivy":""', '"ivy":"",["service"]:"1"'), source.bookingUrl, source)).toThrow();
    expect(() => parseAmeliaBookingPage(booking().replace('"timeSlotLength":1800', '"timeSlotLength":1800,"ignored":sideEffect()'), source.bookingUrl, source)).toThrow();
  });
  it("accepts only the observed side-effect-free hasApiCall expression", () => {
    const html = booking().replace('"hasApiCall":false', '"hasApiCall":(typeof hasAmeliaEntitiesApiCall !== "undefined") && hasAmeliaEntitiesApiCall');
    expect(() => parseAmeliaBookingPage(html, source.bookingUrl, source)).not.toThrow();
    expect(() => parseAmeliaBookingPage(booking().replace('"hasApiCall":false', '"hasApiCall":performRead()'), source.bookingUrl, source)).toThrow();
  });
});
