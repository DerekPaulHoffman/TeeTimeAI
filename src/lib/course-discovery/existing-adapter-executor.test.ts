import { describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { existingAdapterMetadataSchema, type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { deriveTeeItUpOfficialIdentityProof } from "./teeitup-official-identity";

const input = { date: "2030-10-22", timeZone: "America/New_York", players: 2, startTime: "10:00", endTime: "20:00" };
const now = () => new Date("2030-10-20T12:00:00Z");
const deps = { now, recipeHash: "a".repeat(64), venueMatches: venueProofMatches, toInstant: recipeTimeToInstant,
  requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
const foreup: ExistingAdapterRecipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://foreupsoftware.com/index.php/booking/123/456",
    venueName: "Example Golf", providerFamily: "FOREUP", timeZone: input.timeZone },
  adapter: { family: "FOREUP", facilityId: 123, scheduleId: 456, bookingClassId: 789 } };
const acuity: ExistingAdapterRecipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "sim", offeringId: "offering", kind: "SIMULATOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.as.me/schedule/owner123",
    venueName: "Example Simulator", providerFamily: "ACUITY", timeZone: input.timeZone },
  adapter: { family: "ACUITY", ownerKey: "owner123", businessId: "345", rentalProductIds: ["67"] } };
const teeitup: ExistingAdapterRecipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "harbor", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://harbor.book.teeitup.com/?course=11,22&date=2030-10-22",
    venueName: "Harbor Golf Club", venueAddress: "10 Harbor Drive, Example, NY 12345, USA", providerFamily: "TEEITUP", timeZone: input.timeZone },
  adapter: { family: "TEEITUP", alias: "harbor", facilityIds: [11, 22] } };
const teeitupDirectory = [11, 22].map((id, index) => ({ id, courseId: `provider-${id}`, name: `Harbor Golf Club - ${index ? "South" : "North"}`,
  address: "10 Harbor Dr., Example, NY 12345, US", timeZone: input.timeZone, isSimulator: false }));
function teeitupReads(payload: unknown, directory: unknown = teeitupDirectory) {
  return vi.fn<typeof fetch>(async value => Response.json(new URL(String(value)).pathname.includes("/facilities") ? directory : payload));
}
const foreupHtml = () => `<script>SCHEDULES = ${JSON.stringify([{ title: "Example Golf", course_id: 123, teesheet_id: 456,
  booking_classes: [{ teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 789 }] }])};</script>`;
function acuityHtml(overrides: Record<string, unknown> = {}) {
  return `<script>var BUSINESS = ${JSON.stringify({ name: "Example Simulator", id: 345, ownerKey: "owner123", timezone: input.timeZone,
    includesAdminOnly: false, isExpired: false, description: "", calendars: { "Example Simulator": [{ id: 89, name: "Bay 1", timezone: input.timeZone }] },
    appointmentTypes: { "": [{ id: 67, name: "Simulator Rental", duration: 60, active: true, private: false, type: "service",
      classSize: null, canChooseQuantity: false, calendarIDs: [89] }] }, ...overrides })};</script>`;
}
function reads(recipe: ExistingAdapterRecipe, payload: unknown, html?: string) {
  return vi.fn<typeof fetch>(async value => {
    const url = new URL(String(value));
    const document = url.pathname.startsWith("/index.php/booking/") || url.pathname.startsWith("/schedule/");
    return new Response(document ? html ?? (recipe.adapter.family === "FOREUP" ? foreupHtml() : acuityHtml()) : JSON.stringify(payload), {
      headers: { "content-type": document ? "text/html" : "application/json" },
    });
  });
}

describe("fixed existing adapter recipes", () => {
  it("retains strict data-only metadata", () => {
    expect(existingAdapterMetadataSchema.safeParse({ ...foreup.adapter, code: "fetch(...)" }).success).toBe(false);
    expect(existingAdapterMetadataSchema.safeParse({ ...acuity.adapter, rentalProductIds: ["67", "67"] }).success).toBe(false);
    expect(parseAccessRecipe(teeitup).engine).toBe("EXISTING_ADAPTER");
    expect(() => parseAccessRecipe({ ...teeitup, source: { ...teeitup.source, venueAddress: undefined } })).toThrow();
  });
  it("independently discovers existing ForeUP configuration", async () => {
    const fetch = reads(foreup, []);
    expect(await inspectExistingAdapter(foreup.source, { ...deps, fetch })).toEqual({ adapter: foreup.adapter });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("normalizes real ForeUP adapter output and applies date/window/player predicates", async () => {
    const fetch = reads(foreup, [
      { time: "2030-10-22 09:00", available_spots: 4 }, { time: "2030-10-22 11:00", available_spots: 4, holes: "9/18" },
      { time: "2030-10-22 12:00", available_spots: 1 }, { time: "2030-10-22 20:00", available_spots: 4 },
    ]);
    const lease = vi.fn(deps.requestLease);
    const result = await executeExistingAdapterRecipe(foreup, input, { ...deps, fetch, requestLease: lease });
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-10-22T15:00:00.000Z", availableSpots: 4 }] });
    expect(result.slots).toHaveLength(1);
    expect(lease.mock.calls.every(([family]) => family === "foreup")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("distinguishes a validated empty array from an unknown ForeUP response", async () => {
    expect((await executeExistingAdapterRecipe(foreup, input, { ...deps, fetch: reads(foreup, []) })).status).toBe("EMPTY");
    expect(await executeExistingAdapterRecipe(foreup, input, { ...deps, fetch: reads(foreup, false) })).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it.each([
    { time: "2030-10-23 11:00", available_spots: 4 },
    { time: "2030-10-22 11:00", available_spots: 4, schedule_id: 999 },
    { time: "2030-10-22 11:00", available_spots: "4" },
  ])("rejects malformed or mismatched ForeUP rows without false empty", async row => {
    const result = await executeExistingAdapterRecipe(foreup, input, { ...deps, fetch: reads(foreup, [row]) });
    expect(result.status).toBe("INCOMPLETE"); expect(result.complete).toBe(false);
  });
  it("rejects a changed ForeUP public class before reading requested availability", async () => {
    const changed = { ...foreup, adapter: { ...foreup.adapter, bookingClassId: 222 } } as ExistingAdapterRecipe;
    expect((await executeExistingAdapterRecipe(changed, input, { ...deps, fetch: reads(foreup, []) })).status).toBe("INCOMPLETE");
  });
  it("independently discovers Acuity identity and rental identifiers", async () => {
    const fetch = reads(acuity, {});
    expect(await inspectExistingAdapter(acuity.source, { ...deps, fetch })).toEqual({ adapter: acuity.adapter });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("discovers and replays the exact independently verified TeeItUp facility set", async () => {
    const fetch = teeitupReads([{ teetimes: [
      { courseId: "provider-11", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: [1, 2, 3, 4], holes: 18 }] },
      { courseId: "provider-22", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: [1, 2], holes: 9 }] },
      { courseId: "provider-11", teetime: "2030-10-22T16:00:00Z", rates: [{ allowedPlayers: [1], holes: 18 }] },
    ] }]);
    expect(await inspectExistingAdapter(teeitup.source, { ...deps, fetch })).toEqual({ adapter: teeitup.adapter });
    const result = await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch });
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true });
    expect(result.slots.map(row => [row.resourceId, row.availableSpots])).toEqual([["teeitup-facility:11", 4], ["teeitup-facility:22", 2]]);
    expect(fetch.mock.calls.at(-1)?.[0].toString()).toBe("https://phx-api-be-east-1b.kenna.io/v2/tee-times?date=2030-10-22&facilityIds=11%2C22&returnPromotedRates=true");
  });
  it.each([false, {}, [{ teetimes: [{ courseId: "other", teetime: "2030-10-22T15:00:00Z", rates: [] }] }],
    [{ teetimes: [{ courseId: "provider-11", teetime: "2030-10-23T15:00:00Z", rates: [] }] }],
    [{ teetimes: [{ courseId: "provider-11", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: "4" }] }] }]])
    ("rejects malformed or wrong-scope TeeItUp response without false empty", async payload => {
      expect(await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch: teeitupReads(payload) })).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    });
  it("proves TeeItUp empty only after current directory and exact scoped array reads", async () => {
    expect(await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch: teeitupReads([]) })).toMatchObject({ status: "EMPTY", complete: true });
    const fetch = teeitupReads([], [teeitupDirectory[0], { ...teeitupDirectory[1], address: "11 Harbor Drive, Example, NY 12345, US" }]);
    expect(await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch })).toMatchObject({ status: "INCOMPLETE", complete: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("uses a browser-corroborated official alternate address without changing the canonical address, and freshly validates every replay", async () => {
    const source = { ...teeitup.source, bookingUrl: "https://harbor.book.teeitup.com/" };
    const html = '<html><head><title>Harbor Golf Course | Public Golf</title></head><body><h1>Harbor Golf Course</h1>' +
      '<p>20 Harbor Road, Example, NY 12345, US</p><a href="https://harbor.book.teeitup.com/">Tee Times</a></body></html>';
    const officialIdentityPage = { url: source.officialUrl, html, visibleEvidence: { title: "Harbor Golf Course | Public Golf",
      headings: ["Harbor Golf Course"], addressTexts: ["20 Harbor Road, Example, NY 12345, US"], linkUrls: [source.bookingUrl] } };
    const directory = [{ ...teeitupDirectory[0], name: "Harbor Golf Club", address: "20 Harbor Rd, Example, NY 12345, USA" }];
    const fetch = vi.fn<typeof globalThis.fetch>(async value => {
      const url = new URL(String(value));
      return url.origin === new URL(source.officialUrl).origin ? new Response(html, { headers: { "content-type": "text/html" } }) :
        Response.json(url.pathname.endsWith("/facilities") ? directory : [{ teetimes: [{ courseId: "provider-11", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: [1, 2] }] }] }]);
    });
    await expect(inspectExistingAdapter(source, { ...deps, fetch })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch, officialIdentityPage });
    expect(adapter).toMatchObject({ family: "TEEITUP", facilityIds: [11], officialIdentityProof: { kind: "OFFICIAL_SOURCE_ADDRESS" } });
    const recipe = parseAccessRecipe({ ...teeitup, source, adapter }) as ExistingAdapterRecipe;
    for (let pass = 0; pass < 2; pass++) expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch })).toMatchObject({ status: "AVAILABLE", complete: true });
    expect(fetch.mock.calls.filter(([url]) => String(url) === source.officialUrl)).toHaveLength(2);
    expect(recipe.source.venueAddress).toBe("10 Harbor Drive, Example, NY 12345, USA");
  });
  it.each(["link", "address", "markup", "off-origin", "ambiguous-directory"])("fails closed before availability when fresh official evidence changes: %s", async mutation => {
    const source = { ...teeitup.source, bookingUrl: "https://harbor.book.teeitup.com/" };
    const html = '<html><head><title>Harbor Golf Club</title></head><body><h1>Harbor Golf Club</h1>' +
      '<p>20 Harbor Road, Example, NY 12345, US</p><a href="https://harbor.book.teeitup.com/">Tee Times</a></body></html>';
    const proof = deriveTeeItUpOfficialIdentityProof(source, { url: source.officialUrl, html });
    const recipe = parseAccessRecipe({ ...teeitup, source, adapter: { family: "TEEITUP", alias: "harbor", facilityIds: [11], officialIdentityProof: proof } }) as ExistingAdapterRecipe;
    const row = { ...teeitupDirectory[0], name: "Harbor Golf Club", address: "20 Harbor Road, Example, NY 12345, US" };
    const fetch = vi.fn<typeof globalThis.fetch>(async value => {
      const url = new URL(String(value));
      if (url.origin === new URL(source.officialUrl).origin) {
        const changed = mutation === "link" ? html.replace('href="https://harbor.book', 'href="https://other.book') :
          mutation === "address" ? html.replace("20 Harbor", "21 Harbor") : mutation === "markup" ? html.replace("<p>", '<p class="changed">') : html;
        const response = new Response(changed, { headers: { "content-type": "text/html" } });
        if (mutation === "off-origin") Object.defineProperty(response, "url", { value: "https://other.example.org/" });
        return response;
      }
      return Response.json(mutation === "ambiguous-directory" ? [row, { ...row, id: 33, courseId: "other" }] : [row]);
    });
    const result = await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(fetch.mock.calls.some(([value]) => String(value).includes("/v2/tee-times"))).toBe(false);
  });
  it("accepts directory order changes without changing the exact facility set or requested booking date", async () => {
    const fetch = teeitupReads([], [...teeitupDirectory].reverse());
    expect((await executeExistingAdapterRecipe(teeitup, { ...input, date: "2030-10-23" }, { ...deps, fetch })).status).toBe("EMPTY");
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.get("facilityIds")).toBe("22,11");
    const available = teeitupReads([{ teetimes: [{ courseId: "provider-11", teetime: "2030-10-23T15:00:00Z", rates: [{ allowedPlayers: [1, 2] }] }] }]);
    const result = await executeExistingAdapterRecipe(teeitup, { ...input, date: "2030-10-23" }, { ...deps, fetch: available });
    expect(new URL(result.slots[0].bookingUrl).searchParams.get("date")).toBe("2030-10-23");
  });
  it("requires exact allowed party membership rather than maximum remaining spots", async () => {
    const fetch = teeitupReads([{ teetimes: [
      { courseId: "provider-11", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: [3, 4], holes: 18 }] },
      { courseId: "provider-11", teetime: "2030-10-22T15:10:00Z", rates: [{ allowedPlayers: [1, 3], holes: 18 }] },
      { courseId: "provider-22", teetime: "2030-10-22T15:20:00Z", rates: [{ allowedPlayers: [2, 4], holes: 9 }, { allowedPlayers: [3, 4], holes: 18 }] },
    ] }]);
    const result = await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch });
    expect(result).toMatchObject({ status: "AVAILABLE", slots: [{ startsAt: "2030-10-22T15:20:00.000Z", availableSpots: 4, holes: 9 }] });
    expect(result.slots).toHaveLength(1);
  });
  it("uses exact date-keyed full-duration Acuity slots while saved players remain context", async () => {
    const fetch = reads(acuity, { [input.date]: [{ time: "2030-10-22T11:00:00-0400", slotsAvailable: 1 }] });
    const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60, players: 20 }, { ...deps, fetch });
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-10-22T15:00:00.000Z",
      endsAt: "2030-10-22T16:00:00.000Z", availableSpots: 1, capacity: null, resourceId: "ANY", productId: "67" }] });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetch.mock.calls.at(-1)![0])).searchParams.has("players")).toBe(false);
  });
  it.each([{ name: "Another Simulator" }, { ownerKey: "another123" }, { id: 999 }, { timezone: "America/Chicago" }])(
    "requires current Acuity venue/tenant/timezone identity", async overrides => {
      const fetch = reads(acuity, {}, acuityHtml(overrides));
      expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch })).status).toBe("INCOMPLETE");
      expect(fetch).toHaveBeenCalledOnce();
    });
  it("rejects unoffered duration and wrong-date payloads rather than reporting empty", async () => {
    expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 90 }, { ...deps, fetch: reads(acuity, {}) })).status).toBe("INCOMPLETE");
    expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps,
      fetch: reads(acuity, { "2030-10-23": [] }) })).status).toBe("INCOMPLETE");
    expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps,
      fetch: reads(acuity, { [input.date]: [] }) })).status).toBe("EMPTY");
  });
  it("allows exact next-midnight sessions and removes longer ones", async () => {
    const fetch = reads(acuity, { [input.date]: [{ time: "2030-10-22T23:00:00-0400", slotsAvailable: 1 },
      { time: "2030-10-22T23:30:00-0400", slotsAvailable: 1 }] });
    const result = await executeExistingAdapterRecipe(acuity, { ...input, startTime: "23:00", endTime: "24:00", durationMinutes: 60 }, { ...deps, fetch });
    expect(result.slots).toHaveLength(1); expect(result.slots[0].endsAt).toBe("2030-10-23T04:00:00.000Z");
  });
  it.each(["https://127.0.0.1/private", "https://foreupsoftware.com/account", "https://other.example.org/schedule/owner123",
    "https://example.as.me/schedule/owner123?token=secret", "https://example.as.me/schedule/owner123#login"])("rejects unsafe or unsupported source %s without I/O", async bookingUrl => {
    const fetch = reads(acuity, {});
    await expect(inspectExistingAdapter({ ...acuity.source, bookingUrl }, { ...deps, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps 403 unavailable instead of empty and rejects redirected provider bodies", async () => {
    const denied = vi.fn<typeof fetch>(async () => new Response("denied", { status: 403 }));
    expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch: denied })).status).toBe("ACCESS_REQUIRED");
    const moved = new Response(acuityHtml(), { headers: { "content-type": "text/html" } });
    Object.defineProperty(moved, "url", { value: "https://other.example.org/" });
    expect((await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps,
      fetch: vi.fn<typeof fetch>(async () => moved) })).status).toBe("INCOMPLETE");
  });
  it.each([foreup, acuity])("classifies 429 as transient provider throttling without empty or access-wall claims", async recipe => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("rate limited", { status: 429 }));
    const result = await executeExistingAdapterRecipe(recipe, { ...input, durationMinutes: 60 }, { ...deps, fetch });
    expect(result).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: { reason: "PROVIDER_THROTTLED" } });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
