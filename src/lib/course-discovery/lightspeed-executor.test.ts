// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";
import { lightspeedCatalogSchema, lightspeedFlightObjects, lightspeedMetadata, parseLightspeedSource, verifyLightspeedOfficialPage } from "./lightspeed-source";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = { officialUrl: "https://example.org/", bookingUrl: `https://booking.lightspeed.app/${id(1)}`,
  venueName: "Example Golf", venueAddress: "100 Fairway Rd, Example City, OR 97030", providerFamily: "LIGHTSPEED", timeZone: "America/Los_Angeles" };
const official = `<title>Example Golf</title><h2>Example Golf</h2><address>100 Fairway Road<br>Example City, OR 97030</address><a href="${source.bookingUrl}">Book a tee time</a>`;
const service = (n: number) => ({ id: id(10 + n), companyId: id(1), name: `Bay ${n + 1} Reservation`, acceptsOnlineBooking: true, bookable: true,
  employmentIds: [], locationIds: [id(20 + n)], availableDurations: [60, 120], variations: [60, 120].map((duration, index) => ({ id: id(100 + n * 10 + index),
    companyId: id(1), parentId: id(10 + n), duration, acceptsOnlineBooking: true, bookable: false, employmentId: null, locationId: null })) });
const catalog = () => ({ companyId: id(1), facilityId: id(2), services: Array.from({ length: 4 }, (_, n) => service(n)) });
function documentHtml(url: string, props: unknown, extra = "") {
  const u = new URL(url), stream = `0:${JSON.stringify({ c: `${u.pathname}${u.search}`.split("/") })}\na:${JSON.stringify(["$", "$L1", null, props])}\n`;
  return `<title>Book a reservation</title>${extra}<script>self.__next_f.push(${JSON.stringify([1, stream])})</script>`;
}
type Mutation = (props: Record<string, unknown>, url: URL) => void;
function dependencies(mutate?: Mutation) {
  const reads: string[] = [], families: string[] = [];
  const fetch = vi.fn(async (value: string | URL | Request) => {
    const url = new URL(String(value)); reads.push(url.href);
    if (url.href === source.officialUrl) return new Response(official, { headers: { "content-type": "text/html" } });
    if (url.href === source.bookingUrl) return new Response(documentHtml(url.href, catalog()), { headers: { "content-type": "text/html" } });
    const selected = catalog().services.find(row => row.id === url.searchParams.get("serviceId"));
    if (!selected || url.pathname !== `/${id(1)}/time`) throw new Error("UNEXPECTED_READ");
    const date = url.searchParams.get("date")!;
    const props: Record<string, unknown> = { companyId: id(1), variationId: url.searchParams.get("variationId"), duration: url.searchParams.get("duration"),
      timeZone: source.timeZone, hasSession: false, service: selected, slots: [{ time: `${date}T19:00:00Z`, employmentIds: [], locationIds: selected.locationIds }] };
    mutate?.(props, url);
    return new Response(documentHtml(url.href, props, Array.isArray(props.slots) && props.slots.length === 0 ? "There are no available time slots" : "12:00 – 1:00 PM"), { headers: { "content-type": "text/html" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, reads, families, now: () => new Date("2026-10-20T12:00:00Z"),
    requestLease: async <T>(family: string, work: () => Promise<T>) => { families.push(family); return { acquired: true as const, value: await work() }; } };
}
const input = { date: "2026-10-23", durationMinutes: 60, timeZone: source.timeZone, players: 4, startTime: "10:00", endTime: "20:00" };
async function recipe(deps = dependencies()) {
  const observed = await inspectExistingAdapter(source, { ...deps, venueMatches: (a, b) => a === b });
  return parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "example-course", offeringId: "example-offering" }, source, ...observed });
}
describe("Lightspeed whole-rental public reader", () => {
  it("decodes literal Flight JSON without executing code or following React references", () => {
    const parsed = lightspeedFlightObjects(documentHtml(source.bookingUrl, catalog()));
    expect(parsed.some(value => value.companyId === id(1))).toBe(true);
    expect(() => lightspeedFlightObjects('<script>self.__next_f.push(globalThis.secret())</script>')).toThrow("ADAPTER_FLIGHT_MISSING");
    expect(() => lightspeedFlightObjects('<script>self.__next_f.push([1,evil()])</script>')).toThrow("ADAPTER_FLIGHT_INVALID");
  });
  it("accepts only the exact public company entry", () => {
    expect(parseLightspeedSource(source.bookingUrl)?.companyId).toBe(id(1));
    for (const value of [source.bookingUrl + "/time", source.bookingUrl + "?token=x", source.bookingUrl.replace("booking.lightspeed.app", "evil.example.org")]) expect(parseLightspeedSource(value)).toBeNull();
  });
  it("binds the official name, complete address and sole exact provider link", () => {
    expect(() => verifyLightspeedOfficialPage(source, official)).not.toThrow();
    for (const html of [official.replace("<title>Example Golf</title>", "<title>Other Golf</title>"), official.replace("100 Fairway Road", "102 Fairway Road"),
      official.replace(source.bookingUrl, `https://booking.lightspeed.app/${id(99)}`), official.replace("<address>", '<address hidden>'),
      official.replace("100 Fairway Road", "2100 Fairway Road"), official.replace("<address>", "<address>Mailing address: ")])
      expect(() => verifyLightspeedOfficialPage(source, html)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["hidden", "d-none", "invisible", "visually-hidden", "sr-only", "screen-reader-only", "screen-reader-text", "hide"])
    ("rejects concealed old address, company link and title in .%s", className => {
      const hiddenAddress = official.replace("<address>", `<address class="old ${className} metadata">`);
      const hiddenLink = official.replace(`<a href="${source.bookingUrl}">`, `<section class="${className}"><a href="${source.bookingUrl}">`).replace("</a>", "</a></section>");
      const hiddenTitle = official.replace("<title>", `<title class="${className}">`);
      for (const html of [hiddenAddress, hiddenLink, hiddenTitle]) expect(() => verifyLightspeedOfficialPage(source, html)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    });
  it("ignores hidden obsolete identity blocks while retaining visible corroboration", () => {
    const old = `<section class="sr-only"><address>200 Old Rd, Other City, OR 97031</address><a href="https://booking.lightspeed.app/${id(999)}">Old booking link</a></section>`;
    expect(() => verifyLightspeedOfficialPage(source, official + old)).not.toThrow();
  });
  it("preserves visible duration variations even when their child bookable flag is false", () => {
    expect(lightspeedMetadata(lightspeedCatalogSchema.parse(catalog())).services).toHaveLength(4);
  });
  it.each(["duplicate", "membership", "cross-company", "multi-resource", "unbookable-rental"])("rejects ambiguous catalog %s", mode => {
    const value = catalog();
    if (mode === "duplicate") value.services[0].variations.push(value.services[0].variations[0]);
    if (mode === "membership") value.services.forEach(row => { row.name = "Member Simulator Rental"; });
    if (mode === "cross-company") value.services[0].companyId = id(90);
    if (mode === "multi-resource") value.services[0].locationIds.push(id(99));
    if (mode === "unbookable-rental") value.services[0].bookable = false;
    expect(() => lightspeedMetadata(lightspeedCatalogSchema.parse(value))).toThrow();
  });
  it("reads every bay and reuses one immutable recipe for a changed date/duration", async () => {
    const deps = dependencies(), selected = await recipe(deps), hash = hashAccessRecipe(selected);
    for (const parameters of [input, { ...input, date: "2026-10-24", durationMinutes: 120 }]) {
      const result = await executeAccessRecipe(selected, parameters, deps);
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hash, dateVerified: true, durationVerified: true } });
      expect(result.slots).toHaveLength(4);
      expect(new Set(result.slots.map(slot => slot.resourceId)).size).toBe(4);
      expect(result.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null)).toBe(true);
      expect(new Date(result.slots[0].endsAt!).getTime() - new Date(result.slots[0].startsAt).getTime()).toBe(parameters.durationMinutes * 60_000);
    }
    expect(deps.reads.filter(url => url.includes("/time?"))).toHaveLength(8);
    expect(deps.families.filter(family => family === "booking.lightspeed.app")).toHaveLength(11); // inspection plus two complete reads
  });
  it.each(["wrong-date", "wrong-zone", "wrong-resource", "missing-slots", "failed-bay", "duplicate-slot", "session"])
    ("never publishes a partial result after %s", async mode => {
      const deps = dependencies((props, url) => {
        if (url.searchParams.get("serviceId") !== id(13)) return;
        const slots = props.slots as Array<{ time: string; locationIds: string[] }>;
        if (mode === "wrong-date") slots[0].time = "2026-10-22T19:00:00Z";
        if (mode === "wrong-zone") props.timeZone = "America/New_York";
        if (mode === "wrong-resource") slots[0].locationIds = [id(999)];
        if (mode === "missing-slots") delete props.slots;
        if (mode === "failed-bay") throw new Error("source read failed");
        if (mode === "duplicate-slot") slots.push(slots[0]);
        if (mode === "session") props.hasSession = true;
      });
      const result = await executeAccessRecipe(await recipe(), input, deps);
      expect(result.complete).toBe(false); expect(result.slots).toEqual([]); expect(result.status).toBe("INCOMPLETE");
    });
  it("returns EMPTY only after every public product returned an explicit empty list", async () => {
    const deps = dependencies(props => { props.slots = []; });
    const result = await executeAccessRecipe(await recipe(), input, deps);
    expect(result).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
    expect(deps.reads.filter(url => url.includes("/time?"))).toHaveLength(4);
  });
  it.each([202, 206])("rejects incomplete HTTP %s even when its Flight payload parses", async status => {
    const deps = dependencies(), fetch = deps.fetch;
    deps.fetch = (async (url, init) => {
      const response = await fetch(url, init);
      return String(url).includes("/time?") ? new Response(await response.text(), { status, headers: response.headers }) : response;
    }) as typeof globalThis.fetch;
    const result = await executeAccessRecipe(await recipe(), input, deps);
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_TRANSPORT_FAILED" } });
  });
});
