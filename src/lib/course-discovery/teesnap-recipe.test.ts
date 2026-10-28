// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { type ExistingAdapterRecipe } from "./existing-adapter-schema";
import { hashAccessRecipe, parseAccessRecipe, type AccessExecutionInput } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";

const source = { officialUrl: "https://cedar-fixture.teesnap.net/", bookingUrl: "https://cedar-fixture.teesnap.net/",
  venueName: "Cedar Fixture Golf Club", venueAddress: "731 Cedar Drive, Fairhaven, MA 02719, USA", timeZone: "America/New_York", providerFamily: "TEESNAP" };
const course = () => ({ id: 731, name: source.venueName, enabled: true, customer_enabled: true,
  course_type: "golf", holes_default: 18, addons_default: "off" });
const html = (courses: unknown = [course()], zone = source.timeZone) => `<!doctype html><html><head><title>${source.venueName} | Home</title></head><body>
  <h1>${source.venueName}</h1><address>731 Cedar Dr<br>Fairhaven, MA, 02719</address><script>window.courses = ${JSON.stringify(courses)};
  window.property = ${JSON.stringify({ id: 91, name: source.venueName, timezone: zone, enabled: true, customer_enabled: true })};</script></body></html>`;
const input = (date = "2030-05-17", players = 2): AccessExecutionInput => ({ date, players, timeZone: source.timeZone, startTime: "06:00", endTime: "18:00" });
const day = (date: string) => ({ teeTimes: { bookings: [{ bookingId: 11, golfers: [{ id: 1 }, { id: 2 }] }], teeTimes: [
  { teeTime: `${date}T12:30:00`, prices: [{ roundType: "EIGHTEEN_HOLE", price: "40.00" }], teeOffSections: [
    { teeOff: "FRONT_NINE", bookings: [11], isHeld: false }, { teeOff: "BACK_NINE", bookings: [], isHeld: false }] },
  { teeTime: `${date}T13:30:00`, teeOffSections: [{ teeOff: "FRONT_NINE", bookings: [], isHeld: true }] },
] } });
function session(options: { root?: string; availability?: (date: string) => Response } = {}) {
  const reads: string[] = [], families: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => {
    const url = new URL(String(value)); reads.push(url.href);
    expect(url.origin).toBe(source.bookingUrl.slice(0, -1)); expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual"); expect(init?.body).toBeUndefined();
    const headers = new Headers(init?.headers);
    for (const key of ["authorization", "proxy-authorization", "cookie", "x-api-key"]) expect(headers.has(key)).toBe(false);
    if (url.pathname === "/") { expect(url.search).toBe(""); return new Response(options.root ?? html(), { headers: { "content-type": "text/html" } }); }
    expect(url.pathname).toBe("/customer-api/teetimes-day");
    expect([...url.searchParams.keys()]).toEqual(["course", "date", "players", "holes", "addons", "profileId"]);
    expect(url.searchParams.get("course")).toBe("731"); expect(url.searchParams.get("holes")).toBe("18");
    expect(url.searchParams.get("addons")).toBe("off"); expect(url.searchParams.get("profileId")).toBe("");
    return options.availability?.(url.searchParams.get("date")!) ?? Response.json(day(url.searchParams.get("date")!));
  });
  const requestLease = async <T>(family: string, work: () => Promise<T>) => {
    families.push(family); return { acquired: true as const, value: await work() };
  };
  return { fetch, reads, families, requestLease };
}
async function savedRecipe() {
  const helper = session();
  const { adapter } = await inspectExistingAdapter(source, { ...helper, venueMatches: venueProofMatches });
  expect(helper.reads).toEqual([source.bookingUrl]);
  const inspected = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "synthetic-course", kind: "OUTDOOR" }, source, adapter });
  const hash = hashAccessRecipe(inspected), serialized = JSON.stringify(inspected);
  const recipe = parseAccessRecipe(JSON.parse(serialized)) as ExistingAdapterRecipe;
  expect(hashAccessRecipe(recipe)).toBe(hash);
  return { recipe, hash };
}
async function execute(recipe: ExistingAdapterRecipe, hash: string, helper: ReturnType<typeof session>, request = input()) {
  return executeExistingAdapterRecipe(recipe, request, { ...helper, recipeHash: hash, venueMatches: venueProofMatches,
    toInstant: recipeTimeToInstant, now: () => new Date("2030-05-16T00:00:00Z") });
}

describe("saved public Teesnap recipes", () => {
  it("inspects, serializes and hashes once, then refreshes identity and exact public inputs in two fresh sessions", async () => {
    const { recipe, hash } = await savedRecipe();
    for (const request of [input(), input("2030-05-18", 4)]) {
      const helper = session(), result = await execute(recipe, hash, helper, request);
      expect(result).toMatchObject({ complete: true, status: "AVAILABLE", evidence: { recipeHash: hash,
        venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true }, slots: [{
        sourceId: `teesnap-731-${request.date}T12:30:00`, startsAt: `${request.date}T16:30:00.000Z`, availableSpots: 4,
        bookingUrl: source.bookingUrl, holes: 18 }] });
      expect(result.slots).toHaveLength(1);
      expect(helper.reads).toHaveLength(2); expect(helper.reads[0]).toBe(source.bookingUrl);
      const api = new URL(helper.reads[1]);
      expect(api.searchParams.get("date")).toBe(request.date); expect(api.searchParams.get("players")).toBe(String(request.players));
      expect(helper.families).toEqual(["teesnap", "teesnap"]);
    }
  });

  it.each(["empty", "held", "capacity"])("proves %s zero without making a held or insufficient slot available", async mode => {
    const { recipe, hash } = await savedRecipe();
    const helper = session({ availability: date => {
      const value = day(date);
      if (mode === "empty") value.teeTimes.teeTimes = [];
      if (mode === "held") value.teeTimes.teeTimes.forEach(row => row.teeOffSections.forEach(section => { section.isHeld = true; }));
      if (mode === "capacity") value.teeTimes.teeTimes[0].teeOffSections[1].isHeld = true;
      return Response.json(value);
    } });
    expect(await execute(recipe, hash, helper, input("2030-05-17", 3))).toMatchObject({ complete: true, status: "EMPTY", slots: [], evidence: { completeVerified: true } });
  });

  it.each(["malformed", "partial", "not-open", "unknown-booking"])("keeps %s evidence incomplete rather than empty", async mode => {
    const { recipe, hash } = await savedRecipe();
    const helper = session({ availability: date => {
      if (mode === "malformed") return new Response('{"teeTimes":', { headers: { "content-type": "application/json" } });
      if (mode === "not-open") return Response.json({ errors: "date_not_allowed" }, { status: 400 });
      if (mode === "partial") return Response.json({ teeTimes: { bookings: [] } });
      const value = day(date); value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [99]; return Response.json(value);
    } });
    expect(await execute(recipe, hash, helper)).toMatchObject({ complete: false, status: "INCOMPLETE", slots: [], evidence: { completeVerified: false } });
    expect(helper.reads).toHaveLength(2);
  });

  it.each(["course-id", "catalog", "identity", "zone"])("rejects fresh %s changes before any availability read", async mode => {
    const { recipe, hash } = await savedRecipe();
    const current = course();
    if (mode === "course-id") current.id = 732;
    const root = mode === "identity" ? html().replaceAll(source.venueName, "Different Fixture Golf Club") :
      html(mode === "catalog" ? [current, { ...current, id: 732, name: "Cedar Fixture Practice Course" }] : [current], mode === "zone" ? "America/Chicago" : source.timeZone);
    const helper = session({ root }), result = await execute(recipe, hash, helper);
    expect(result).toMatchObject({ complete: false, status: "INCOMPLETE", slots: [] }); expect(helper.reads).toEqual([source.bookingUrl]);
  });

  it.each(["tenant", "saved-zone", "input-zone"])("rejects inconsistent %s before API traffic, including raw executor callers", async mode => {
    const { recipe, hash } = await savedRecipe();
    const changed = structuredClone(recipe);
    if (mode === "tenant") changed.source = { ...changed.source, officialUrl: "https://other-fixture.teesnap.net/", bookingUrl: "https://other-fixture.teesnap.net/" };
    if (mode === "saved-zone" && changed.adapter.family === "TEESNAP") changed.adapter.timeZone = "America/Chicago";
    if (mode !== "input-zone") expect(() => parseAccessRecipe(changed)).toThrow();
    const helper = session(), request = mode === "input-zone" ? { ...input(), timeZone: "America/Chicago" } : input();
    expect(await execute(changed, hash, helper, request)).toMatchObject({ complete: false, status: "INCOMPLETE", slots: [] });
    expect(helper.reads).toEqual([]);
  });
});
