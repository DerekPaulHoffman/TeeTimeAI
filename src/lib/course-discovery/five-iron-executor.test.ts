import { describe, expect, it, vi } from "vitest";
import { bindFiveIronLocation, parseFiveIronSource } from "./five-iron-source";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";

const source = { officialUrl: "https://fiveirongolf.com/locations/exampletown-downtown", venueName: "Five Iron Golf",
  venueAddress: "100 Public Links Rd, Exampletown, CT 06854, USA", timeZone: "America/New_York",
  providerFamily: "FIVE_IRON", bookingUrl: "https://booking.fiveirongolf.com/select-experience?location=exampletown&experience=simulator" };
const location = { id: "11111111-1111-4111-8111-111111111111", name: "Exampletown - Downtown", urlSlug: "exampletown",
  timezone: source.timeZone, experiences: ["Golf"], ignoredPrivateConfiguration: "MUST_NOT_PERSIST" };
const input = { date: "2026-11-05", timeZone: source.timeZone, players: 2, durationMinutes: 60, startTime: "09:00", endTime: "18:00" };
const row = (date = input.date) => ({ time: date + "T10:00:00.000Z", scheduleStep: 30,
  availabilities: [1, 2].map(staffId => ({ staffId, staffLetter: String(staffId), durations: [{ duration: 30, cost: 30 }, { duration: 60, cost: 60 }] })) });
function context(rows: unknown = [row()], locations: unknown = [location], status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>(async value => {
    const u = new URL(String(value));
    if (u.origin !== "https://api.booking.fiveirongolf.com") throw Error("UNEXPECTED_HOST");
    if (u.pathname === "/locations") return Response.json(locations);
    if (u.pathname === "/appointments/available/simulator") return Response.json(rows, { status });
    throw Error("UNEXPECTED_ROUTE");
  });
  return { fetch, now: () => new Date("2026-11-02T12:00:00Z"), venueMatches: venueProofMatches,
    toInstant: recipeTimeToInstant, recipeHash: "a".repeat(64),
    requestLease: async <T,>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source,
  target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, adapter: bindFiveIronLocation(source, [location]) });

describe("Five Iron anonymous simulator rentals", () => {
  it("learns the exact official branch without retaining unrelated catalog fields", async () => {
    const result = await inspectExistingAdapter(source, context());
    expect(result.adapter).toEqual({ family: "FIVE_IRON", locationId: location.id, locationSlug: "exampletown",
      locationName: location.name, timeZone: source.timeZone });
    expect(JSON.stringify(result)).not.toContain("MUST_NOT_PERSIST");
  });
  it("ignores an unrelated branch with an explicitly absent booking slug", () => {
    expect(bindFiveIronLocation(source, [location, { ...location, id: "22222222-2222-4222-8222-222222222222", name: "Unbookable branch", urlSlug: null }]).locationId).toBe(location.id);
    expect(() => bindFiveIronLocation(source, [{ ...location, urlSlug: null }])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["http://booking.fiveirongolf.com/select-experience?location=exampletown&experience=simulator",
    source.bookingUrl + "&location=other", source.bookingUrl + "&email=someone@example.org",
    source.bookingUrl.replace("simulator", "lesson"), source.bookingUrl.replace("select-experience", "payment-details")])("rejects unrelated or credential-bearing source %s", url => {
    expect(parseFiveIronSource(url)).toBeNull();
  });
  it.each(["name", "city", "timezone", "slug", "official", "experience", "duplicate"])("rejects a conflicting %s identity", change => {
    const s = { ...source }, l = { ...location }, rows = [l];
    if (change === "name") s.venueName = "Other Golf";
    if (change === "city") s.venueAddress = source.venueAddress.replace("Exampletown", "Elsewhere");
    if (change === "timezone") l.timezone = "America/Chicago";
    if (change === "slug") l.urlSlug = "elsewhere";
    if (change === "official") s.officialUrl = source.officialUrl.replace("exampletown", "elsewhere");
    if (change === "experience") l.experiences = ["Bowling"];
    if (change === "duplicate") rows.push({ ...l });
    expect(() => bindFiveIronLocation(s, rows)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each([["2026-11-05", "15:00:00.000Z"], ["2027-06-05", "14:00:00.000Z"]])("converts provider wall time using venue DST on %s", async (date, utc) => {
    const deps = context([row(date)]), result = await executeExistingAdapterRecipe(recipe(), { ...input, date }, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: {
      venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ startsAt: date + "T" + utc, availableSpots: 1, capacity: null });
    expect(Date.parse(result.slots[0].endsAt!) - Date.parse(result.slots[0].startsAt)).toBe(3_600_000);
    const [url, request] = deps.fetch.mock.calls[1];
    expect(new URL(String(url)).searchParams.get("partySize")).toBe("1");
    expect(request).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect(new Headers(request?.headers).has("authorization")).toBe(false);
  });
  it("replays serialized metadata with changed golfers and date using no discovery state", async () => {
    const saved = JSON.parse(JSON.stringify(recipe()));
    const first = await executeExistingAdapterRecipe(saved, input, context());
    const second = await executeExistingAdapterRecipe(saved, { ...input, players: 4 }, context());
    expect(second.slots).toEqual(first.slots);
    const next = { ...input, date: "2026-11-06" };
    expect((await executeExistingAdapterRecipe(saved, next, context([row(next.date)]))).slots[0].startsAt).toBe("2026-11-06T15:00:00.000Z");
  });
  it("does not join half-hour intervals or separate bays into a full hour", async () => {
    const half = row(); half.availabilities.forEach(a => { a.durations = [{ duration: 30, cost: 30 }]; });
    const result = await executeExistingAdapterRecipe(recipe(), input, context([half, { ...half, time: input.date + "T10:30:00.000Z" }]));
    expect(result).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
  });
  it.each(["wrongDate", "duplicateTime", "duplicateBay", "malformed"])("keeps %s extraction incomplete", async change => {
    const r = row(); let rows: unknown = [r];
    if (change === "wrongDate") r.time = "2026-11-06T10:00:00.000Z";
    if (change === "duplicateTime") rows = [r, r];
    if (change === "duplicateBay") r.availabilities[1].staffId = r.availabilities[0].staffId;
    if (change === "malformed") rows = { error: "not availability" };
    expect(await executeExistingAdapterRecipe(recipe(), input, context(rows))).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it.each([401, 403, 429, 500])("keeps HTTP %i distinct from no inventory", async status => {
    const result = await executeExistingAdapterRecipe(recipe(), input, context([], [location], status));
    expect(result.complete).toBe(false); expect(result.status).not.toBe("EMPTY");
  });
});
