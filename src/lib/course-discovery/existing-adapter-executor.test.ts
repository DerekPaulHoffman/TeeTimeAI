import { describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { existingAdapterMetadataSchema, type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { accessExecutionDiagnosticSchema, parseAccessRecipe } from "./recipe";
import { deriveTeeItUpOfficialIdentityProof } from "./teeitup-official-identity";
import { SimulatorAvailabilityError } from "@/lib/simulators/providers/types";
import * as acuityProvider from "@/lib/simulators/providers/acuity";

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
function pooledAcuityHtml() {
  return acuityHtml({ calendars: { "": [{ id: "any", name: "Any available", timezone: "" }] },
    appointmentTypes: { "": [{ id: 67, name: "Simulator Booking 1 Hour", duration: 60, active: true, private: false, type: "service",
      classSize: null, canChooseQuantity: false, calendarIDs: ["any"], paddingBefore: 0, paddingAfter: 0 }] } });
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
  it("rejects a fresh postal-code identity discrepancy before reading availability", async () => {
    const directory = teeitupDirectory.map(row => ({ ...row, address: row.address.replace("12345", "32801") }));
    const fetch = teeitupReads([], directory);
    const result = await executeExistingAdapterRecipe(teeitup, input, { ...deps, fetch });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [],
      evidence: { reason: "ADAPTER_IDENTITY_MISMATCH", venueVerified: false, completeVerified: false } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain("/facilities");
  });
  it.each(["/", "/teetimes", "/teetimes/"])("inspects and replays an observed V2 %s with exact identity, headers and edited party", async path => {
    const origin = "https://public.book-v2.teeitup.golf", source = { ...teeitup.source, bookingUrl: `${origin}${path}` };
    const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
      const url = new URL(String(value)); expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
      const headers = new Headers(init?.headers); expect(headers.get("origin")).toBe(origin); expect(headers.get("referer")).toBe(`${origin}/`); expect(headers.get("x-be-alias")).toBe("public");
      if (url.pathname.endsWith("/facilities")) return Response.json([teeitupDirectory[0]]);
      expect([...url.searchParams.keys()].sort()).toEqual(["date", "facilityIds", "returnPromotedRates"]);
      expect(url.searchParams.get("facilityIds")).toBe("11");
      return Response.json([{ teetimes: [{ courseId: "provider-11", teetime: `${url.searchParams.get("date")}T15:00:00Z`, rates: [{ allowedPlayers: [2, 4], holes: 9 }] },
        { courseId: "provider-11", teetime: `${url.searchParams.get("date")}T16:00:00Z`, rates: [{ allowedPlayers: [3, 4], holes: 18 }] }] }]);
    });
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch });
    expect(adapter).toEqual({ family: "TEEITUP", alias: "public", facilityIds: [11] });
    const recipe = parseAccessRecipe({ ...teeitup, source, adapter }) as ExistingAdapterRecipe;
    for (const request of [input, { ...input, date: "2030-10-23", players: 3 }]) {
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { completeVerified: true, capacityVerified: true, venueVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].holes).toBe(request.players === 2 ? 9 : 18);
      expect(result.slots[0].sourceId).toBe(`teeitup-11-provider-11-${request.date}T${request.players === 2 ? "15" : "16"}:00:00Z`);
      expect(result.slots[0].bookingUrl).toBe(`${origin}${path}?course=11&date=${request.date}`);
    }
    const mismatched = teeitupReads([], [{ ...teeitupDirectory[0], address: "99 Other Road, Example, NY 12345, USA" }]);
    await expect(inspectExistingAdapter(source, { ...deps, fetch: mismatched })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("does not probe an unrecognized external booking host as a self-hosted plugin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(inspectExistingAdapter({ ...acuity.source, bookingUrl: "https://other.example.org/calendar" }, { ...deps, fetch }))
      .rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("discovers and independently reuses a directory-proven simulator with explicit duration rates", async () => {
    const source = { ...teeitup.source, bookingUrl: "https://studio.book.teeitup.com/", venueName: "Example Swing Studio",
      venueAddress: "100 Main Road Ste A, Example, NY 12345, USA" };
    const directory = [{ id: 11, courseId: "studio-11", name: source.venueName, address: "100 Main Rd, Suite A, Example, NY 12345, US",
      timeZone: input.timeZone, isSimulator: true }];
    const lease = vi.fn(deps.requestLease);
    const fetch = vi.fn<typeof globalThis.fetch>(async value => {
      const url = new URL(String(value));
      if (url.pathname.endsWith("/facilities")) return Response.json(directory);
      expect([...url.searchParams.keys()].sort()).toEqual(["date", "facilityIds", "returnPromotedRates"]);
      return Response.json([{ teetimes: [{ courseId: "studio-11", teetime: `${url.searchParams.get("date")}T15:00:00.000Z`,
        minPlayers: 1, maxPlayers: 1, rates: [55, 56].map(resource => ({ name: "Simulator - 1 hr", allowedPlayers: [1],
          holes: 18, isSimulator: false, golfnow: { GolfCourseId: resource, GolfFacilityId: 11 } })) }] }]);
    });
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch, requestLease: lease });
    expect(adapter).toEqual({ family: "TEEITUP", alias: "studio", facilityIds: [11], offeringKind: "SIMULATOR" });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source,
      target: { courseId: "studio", offeringId: "rental", kind: "SIMULATOR" }, adapter }) as ExistingAdapterRecipe;
    for (const request of [{ ...input, durationMinutes: 60 }, { ...input, date: "2030-10-23", players: 4, durationMinutes: 60 }]) {
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch, requestLease: lease });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(2);
      expect(result.slots[0]).toMatchObject({ startsAt: `${request.date}T15:00:00.000Z`, endsAt: `${request.date}T16:00:00.000Z`,
        capacity: null, availableSpots: 1, resourceId: "teeitup-facility:11:simulator:55" });
      expect(result.slots[0]).not.toHaveProperty("holes");
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(new Set(lease.mock.calls.map(([family]) => family))).toEqual(new Set(["teeitup"]));
    expect(source.venueAddress).toBe("100 Main Road Ste A, Example, NY 12345, USA");
  });
  it("fails closed when a simulator becomes outdoor or loses explicit duration evidence", async () => {
    const source = { ...teeitup.source, bookingUrl: "https://studio.book.teeitup.com/", venueName: "Example Swing Studio",
      venueAddress: "100 Main Rd Suite A, Example, NY 12345, US" };
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source,
      target: { courseId: "studio", offeringId: "rental", kind: "SIMULATOR" },
      adapter: { family: "TEEITUP", alias: "studio", facilityIds: [11], offeringKind: "SIMULATOR" } }) as ExistingAdapterRecipe;
    for (const simulator of [false, true]) {
      const directory = [{ id: 11, courseId: "studio-11", name: source.venueName, address: source.venueAddress, timeZone: input.timeZone, isSimulator: simulator }];
      const fetch = teeitupReads([{ teetimes: [{ courseId: "studio-11", teetime: "2030-10-22T15:00:00Z", rates: [{ allowedPlayers: [1],
        name: "Simulator - NaN hr", golfnow: { GolfCourseId: 55, GolfFacilityId: 11 } }] }] }], directory);
      expect(await executeExistingAdapterRecipe(recipe, { ...input, durationMinutes: 60 }, { ...deps, fetch }))
        .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
      if (!simulator) expect(fetch).toHaveBeenCalledOnce();
    }
  });
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
  it("preserves an observed ForeUP entry while freshly resolving its canonical schedule for each replay", async () => {
    const source = { ...foreup.source, bookingUrl: "https://foreupsoftware.com/index.php/booking/123/111#teetimes" };
    const schedules = [{ title: "Other Golf", course_id: 123, teesheet_id: 111,
      booking_classes: [{ teesheet_id: 111, active: 1, hidden: 0, booking_class_id: 222, name: "Public" }] },
    { title: "Example Golf", course_id: 123, teesheet_id: 456,
      booking_classes: [{ teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 789, name: "Public" },
        { teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 790, name: "Members" }] }];
    const html = `<script>SCHEDULES = ${JSON.stringify(schedules)};</script>`;
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch: reads(foreup, [], html) });
    expect(adapter).toEqual(foreup.adapter);
    const saved = JSON.stringify(parseAccessRecipe({ ...foreup, source, adapter }));
    const recipe = parseAccessRecipe(JSON.parse(saved)) as ExistingAdapterRecipe;
    for (const request of [input, { ...input, date: "2030-10-23", players: 3 }]) {
      const fetch = reads(recipe, [{ time: `${request.date} 11:00`, available_spots: request.players,
        schedule_id: 456, booking_class_id: 789 }], html);
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, sourceUrl: source.bookingUrl,
        evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]).toMatchObject({ sourceId: `foreup-456-${request.date} 11:00`, bookingUrl: source.bookingUrl,
        availableSpots: request.players });
      expect(String(fetch.mock.calls[0][0])).toBe(source.bookingUrl.split("#")[0]);
      const api = fetch.mock.calls.slice(1).map(([url]) => new URL(String(url)));
      expect(api).toHaveLength(2);
      expect(api.every(url => url.searchParams.get("schedule_id") === "456" && url.searchParams.get("booking_class") === "789")).toBe(true);
      expect(api.at(-1)!.searchParams.get("players")).toBe(String(request.players));
      expect(JSON.stringify(recipe)).toBe(saved);
    }
  });
  it.each(["facility", "name", "schedule", "public class", "duplicate", "multiple public classes", "hidden", "inactive", "members only", "stored schedule", "stored public class"])
  ("rejects changed ForeUP %s configuration before requested-date availability despite a valid entry", async change => {
    const source = { ...foreup.source, bookingUrl: "https://foreupsoftware.com/index.php/booking/123/111#teetimes" };
    const recipe = parseAccessRecipe({ ...foreup, source }) as ExistingAdapterRecipe;
    const schedule = { title: "Example Golf", course_id: 123, teesheet_id: 456,
      booking_classes: [{ teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 789, name: "Public" }] };
    if (change === "facility") schedule.course_id = 999;
    if (change === "name") schedule.title = "Other Golf";
    if (change === "schedule") { schedule.teesheet_id = 457; schedule.booking_classes[0].teesheet_id = 457; }
    if (change === "public class") schedule.booking_classes[0].booking_class_id = 791;
    if (change === "hidden") schedule.booking_classes[0].hidden = 1;
    if (change === "inactive") schedule.booking_classes[0].active = 0;
    if (change === "members only") schedule.booking_classes[0].name = "Members";
    if (change === "multiple public classes") schedule.booking_classes.push({ ...schedule.booking_classes[0], booking_class_id: 791 });
    if (change === "stored schedule" && recipe.adapter.family === "FOREUP") recipe.adapter.scheduleId = 999;
    if (change === "stored public class" && recipe.adapter.family === "FOREUP") recipe.adapter.bookingClassId = 999;
    const html = `<script>SCHEDULES = ${JSON.stringify(change === "duplicate" ? [schedule, schedule] : [schedule])};</script>`;
    const fetch = reads(recipe, [], html);
    expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch }))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toBe(source.bookingUrl.split("#")[0]);
  });
  it("inspects and freshly replays an exact indexed ForeUP source with independent date/player inputs", async () => {
    const source = { ...foreup.source, bookingUrl: "https://foreupsoftware.com/index.php/booking/index/123#teetimes" };
    const publicPlayHtml = `<script>SCHEDULES = ${JSON.stringify([{ title: "Example Golf", course_id: 123, teesheet_id: 456,
      booking_classes: [{ teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 789, name: "Public Play" },
        { teesheet_id: 456, active: 1, hidden: 0, booking_class_id: 790, name: "Full Week Member" }] }])};</script>`;
    const fetch = reads(foreup, [{ time: "2030-10-22 11:00", available_spots: 4 }], publicPlayHtml);
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch });
    expect(adapter).toEqual(foreup.adapter);
    const recipe = parseAccessRecipe({ ...foreup, source, adapter }) as ExistingAdapterRecipe;
    expect(recipe.source.bookingUrl).toBe(source.bookingUrl);
    for (const request of [input, { ...input, date: "2030-10-23", players: 3 }]) {
      const replayFetch = reads(recipe, [{ time: `${request.date} 11:00`, available_spots: request.players }], publicPlayHtml);
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch: replayFetch });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, sourceUrl: source.bookingUrl,
        evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0]).toMatchObject({ bookingUrl: source.bookingUrl, availableSpots: request.players });
      expect(String(replayFetch.mock.calls[0][0])).toBe(source.bookingUrl.split("#")[0]);
      const availability = new URL(String(replayFetch.mock.calls.at(-1)![0]));
      expect(availability.searchParams.get("players")).toBe(String(request.players));
      expect(availability.searchParams.get("date")).toBe(request.date.split("-").slice(1).concat(request.date.slice(0, 4)).join("-"));
    }
    const changed = { ...recipe, adapter: { ...foreup.adapter, facilityId: 999 } } as ExistingAdapterRecipe;
    const noRead = reads(recipe, []);
    expect(await executeExistingAdapterRecipe(changed, input, { ...deps, fetch: noRead }))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_SOURCE_MISMATCH" } });
    expect(noRead).not.toHaveBeenCalled();
    expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch: reads(recipe, [], foreupHtml().replace('"course_id":123', '"course_id":999')) }))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it.each(["https://foreupsoftware.com/index.php/booking/index/0#teetimes",
    "https://foreupsoftware.com/index.php/booking/index/123/456#teetimes",
    "https://foreupsoftware.com/index.php/booking/index/123?tenant=other#teetimes",
    "https://other.example/index.php/booking/index/123#teetimes"])
  ("rejects unsupported indexed source %s without provider reads", async bookingUrl => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(inspectExistingAdapter({ ...foreup.source, bookingUrl }, { ...deps, fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
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
  it("inspects and independently executes a pooled public rental without inventing resource or player counts", async () => {
    const html = pooledAcuityHtml();
    const fetch = vi.fn<typeof globalThis.fetch>(async value => {
      const url = new URL(String(value));
      if (url.pathname.startsWith("/schedule/")) return new Response(html, { headers: { "content-type": "text/html" } });
      expect(url.pathname).toBe("/api/scheduling/v1/availability/times");
      expect(url.searchParams.get("calendarId")).toBe("any"); expect(url.searchParams.get("maxDays")).toBe("1");
      expect(url.searchParams.has("players")).toBe(false);
      const date = url.searchParams.get("startDate")!;
      return Response.json({ [date]: [{ time: `${date}T11:00:00-0400`, slotsAvailable: 6 }] });
    });
    const { adapter } = await inspectExistingAdapter(acuity.source, { ...deps, fetch });
    const recipe = parseAccessRecipe({ ...acuity, adapter }) as ExistingAdapterRecipe;
    for (const request of [{ ...input, durationMinutes: 60 }, { ...input, durationMinutes: 60, date: "2030-10-23", players: 4 }]) {
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 1, capacity: null, resourceId: "ANY",
        startsAt: `${request.date}T15:00:00.000Z`, endsAt: `${request.date}T16:00:00.000Z` }],
        evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1);
    }
    expect(fetch).toHaveBeenCalledTimes(7);
  });
  it.each([
    ["missing date", {}],
    ["other date", { "2030-10-23": [] }],
    ["extra date", { [input.date]: [], "2030-10-23": [] }],
    ["wrong local date", { [input.date]: [{ time: "2030-10-23T11:00:00-0400", slotsAvailable: 1 }] }],
    ["wrong timezone", { [input.date]: [{ time: "2030-10-22T11:00:00-0500", slotsAvailable: 1 }] }],
    ["unknown field", { [input.date]: [{ time: "2030-10-22T11:00:00-0400", slotsAvailable: 1, unknown: true }] }],
  ])("keeps pooled %s incomplete rather than empty", async (_label, payload) => {
    const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 },
      { ...deps, fetch: reads(acuity, payload, pooledAcuityHtml()) });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { completeVerified: false, dateVerified: false } });
  });
  it.each(["old multi-day mode", "other maxDays", "extra parameter", "other date", "other timezone"])(
    "denies pooled %s before transport dispatch", async mode => {
      const original = acuityProvider.fetchAcuitySimulatorAvailability;
      const spy = vi.spyOn(acuityProvider, "fetchAcuitySimulatorAvailability").mockImplementationOnce(async (providerInput, read = globalThis.fetch) =>
        original(providerInput, (async (value, init) => {
          const url = new URL(String(value));
          if (url.pathname.endsWith("/availability/times")) {
            if (mode === "old multi-day mode") url.searchParams.set("maxDays", "4");
            if (mode === "other maxDays") url.searchParams.set("maxDays", "2");
            if (mode === "extra parameter") url.searchParams.set("extra", "1");
            if (mode === "other date") url.searchParams.set("startDate", "2030-10-23");
            if (mode === "other timezone") url.searchParams.set("timezone", "America/Chicago");
          }
          return read(url, init);
        }) as typeof fetch));
      const fetch = reads(acuity, { [input.date]: [] }, pooledAcuityHtml());
      try {
        const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch });
        expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "UNSCOPED_ADAPTER_REQUEST" } });
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(fetch.mock.calls.every(([value]) => new URL(String(value)).pathname.startsWith("/schedule/"))).toBe(true);
      } finally { spy.mockRestore(); }
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
  it.each([
    [403, "ACCESS_REQUIRED", "ACCESS_REQUIRED", false],
    [429, "FAILED", "PROVIDER_THROTTLED", true],
    [503, "INCOMPLETE", "ADAPTER_TRANSPORT_FAILED", true],
  ] as const)("retains safe Acuity HTTP %s diagnostics and existing outcome semantics", async (status, outcome, reason, retryable) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("secret provider response", {
      status, headers: { "retry-after": "secret retry guidance" },
    }));
    const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch });
    expect(result).toMatchObject({ status: outcome, complete: false, slots: [], evidence: { reason,
      diagnostic: { code: "SIMULATOR_PROVIDER_ERROR", simulatorError: { code: "HTTP_ERROR", retryable, httpStatus: status } } } });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [{ name: "Another Simulator" }, "ADAPTER_IDENTITY_MISMATCH"],
    [{ id: 999 }, "ADAPTER_CONFIGURATION_CHANGED"],
  ] as const)("retains controller-owned Acuity configuration failure through the provider fetch catch", async (overrides, reason) => {
    const fetch = reads(acuity, {}, acuityHtml(overrides));
    const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, evidence: { reason,
      diagnostic: { code: "SIMULATOR_PROVIDER_ERROR", simulatorError: { code: "INVALID_SOURCE", retryable: false } } } });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("retains trusted unsupported-duration and availability-schema errors without prose", async () => {
    const unsupported = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 90 }, { ...deps, fetch: reads(acuity, {}) });
    expect(unsupported).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "UNSUPPORTED_DURATION",
      diagnostic: { simulatorError: { code: "UNSUPPORTED_DURATION", retryable: false } } } });
    const malformed = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps,
      fetch: reads(acuity, { [input.date]: [{ time: "2030-10-22T11:00:00-0400", slotsAvailable: -1 }] }) });
    expect(malformed).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { reason: "SCHEMA_CHANGED",
      diagnostic: { simulatorError: { code: "SCHEMA_CHANGED", retryable: false } } } });
  });
  it("projects only closed trusted error fields and rejects fake or mutated error authority", async () => {
    const trusted = new SimulatorAvailabilityError("HTTP_ERROR", "secret https://private.example/?token=secret", true, 503, "secret retry-after");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const run = (error: Error) => executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps, fetch,
      toInstant: () => { throw error; } });
    const result = await run(trusted);
    expect(result.evidence).toMatchObject({ reason: "HTTP_ERROR", diagnostic: { code: "SIMULATOR_PROVIDER_ERROR",
      simulatorError: { code: "HTTP_ERROR", retryable: true, httpStatus: 503 } } });
    expect(result.evidence.diagnostic).toEqual({ code: "SIMULATOR_PROVIDER_ERROR", simulatorError: { code: "HTTP_ERROR", retryable: true, httpStatus: 503 } });
    expect(JSON.stringify(result)).not.toContain("secret");
    const fake = Object.assign(new Error("HTTP_ERROR"), { code: "HTTP_ERROR", retryable: true, httpStatus: 503 });
    const mutated = new SimulatorAvailabilityError("HTTP_ERROR", "secret");
    Object.defineProperty(mutated, "code", { value: "SECRET_UNKNOWN_CODE" });
    for (const error of [fake, mutated, new Error("secret transport detail")]) {
      const failed = await run(error);
      expect(failed).toMatchObject({ status: "INCOMPLETE", evidence: { reason: "ADAPTER_READ_FAILED" } });
      expect(failed.evidence.diagnostic).toBeUndefined();
      expect(JSON.stringify(failed)).not.toContain("secret");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([99, 600, 503.5, "503"])("omits invalid typed HTTP status %s from replay diagnostics", async status => {
    const error = new SimulatorAvailabilityError("HTTP_ERROR", "secret", true);
    Object.defineProperty(error, "httpStatus", { value: status });
    const result = await executeExistingAdapterRecipe(acuity, { ...input, durationMinutes: 60 }, { ...deps,
      toInstant: () => { throw error; } });
    expect(result.evidence.diagnostic).toEqual({ code: "SIMULATOR_PROVIDER_ERROR", simulatorError: { code: "HTTP_ERROR", retryable: true } });
  });
  it("keeps fixed target failures independent of untrusted provider errors", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await executeExistingAdapterRecipe(acuity, input, { ...deps, fetch });
    expect(result.evidence.reason).toBe("ADAPTER_TARGET_MISMATCH");
    expect(result.evidence.diagnostic).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { code: "UNKNOWN", retryable: false }, { code: "HTTP_ERROR", retryable: "true" },
    { code: "HTTP_ERROR", retryable: true, httpStatus: 600 }, { code: "HTTP_ERROR", retryable: true, message: "secret" },
  ])("rejects unknown or extended simulator diagnostic payloads", simulatorError => {
    expect(accessExecutionDiagnosticSchema.safeParse({ code: "SIMULATOR_PROVIDER_ERROR", simulatorError }).success).toBe(false);
  });
});
