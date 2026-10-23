// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAccessRecipe, venueProofMatches, type AccessExecutorDependencies } from "./executor";
import { inspectSevenRoomsPublicProtocol, sevenRoomsPublicRequests, sevenRoomsPublicRows } from "./sevenrooms-public-direct";
import { accessRecipeSchema, hashAccessRecipe, isSafeRecipeUrl, parseAccessRecipe, recipeAllowsRequest, type AccessExecutionInput } from "./recipe";

const input: AccessExecutionInput = { date: "2030-10-23", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00", timeZone: "America/New_York" };
const source = { officialUrl: "https://examplegolf.org/", bookingUrl: "https://www.sevenrooms.com/reservations/examplegolf?duration-picker=true",
  venueName: "Example Indoor Golf & Bar", venueAddress: "123 Fairway Dr, Orlando, FL 32819, USA", providerFamily: "SEVENROOMS", timeZone: input.timeZone };
const metadata = () => ({ status: 200, data: { venue_info: { name: source.venueName, url_key: "examplegolf", timezone: input.timeZone,
  address: "123 Fairway Drive", city: "Orlando", state: "FL", postal_code: "32819", country: "United States", country_code: "US" } } });
const rental = (label = "Peak Rental", extra: Record<string, unknown> = {}) => ({ type: "book", public_time_slot_description: label,
  duration: 60, time_iso: "2030-10-23T17:00:00-04:00", access_persistent_id: label, ...extra });
const availability = (rows: unknown[] = [rental("Happy Hour Rental"), rental()]) => ({ status: 200, data: { availability: { [input.date]: [{ times: rows }] } } });
function recipe() {
  const protocol = sevenRoomsPublicRequests(source.bookingUrl);
  return parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS",
    target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, permittedRoutes: protocol.permittedRoutes,
    request: { url: protocol.rangeTemplate, method: "GET" }, metadataRequest: { url: protocol.metadataUrl },
    responseRows: sevenRoomsPublicRows(["Happy Hour Rental", "Peak Rental"]),
    proof: { venue: { publicVenueMetadata: true }, date: { availabilityDateKey: true }, complete: { availabilityResponse: true } } });
}
function dependencies(meta: unknown = metadata(), rows: unknown = availability()) {
  const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    expect(init).toMatchObject({ credentials: "omit", redirect: "manual" });
    return new Response(JSON.stringify(String(url).includes("/venue_info?") ? meta : rows), { status: 200, headers: { "content-type": "application/json" } });
  });
  const launchBrowser = vi.fn(async () => { throw Error("BROWSER_MUST_NOT_LAUNCH"); });
  const requestLease = vi.fn(async (_family: string, work: () => Promise<unknown>) => ({ acquired: true as const, value: await work() }));
  return { fetch, launchBrowser, requestLease, now: () => new Date("2030-10-20T12:00:00Z") } as AccessExecutorDependencies & {
    fetch: typeof fetch; launchBrowser: typeof launchBrowser; requestLease: typeof requestLease;
  };
}

describe("direct public rental learning and saved execution", () => {
  it("exports the same input schema used by unattended model sessions with both rental-label alternatives", () => {
    const schema = JSON.stringify(z.toJSONSchema(accessRecipeSchema, { io: "input", unrepresentable: "any" }));
    expect(schema).toContain('"HTTP_JSON"'); expect(schema).toContain('"publicVenueMetadata"');
    expect(schema).toContain('"expectedRentalLabel"'); expect(schema).toContain('"expectedRentalLabels"');
  });
  it("derives the saved protocol from two public reads and every original row", async () => {
    const reads: string[] = [];
    const result = await inspectSevenRoomsPublicProtocol(source, input, async url => {
      reads.push(url); return { body: url.includes("/venue_info?") ? metadata() : availability([rental("Happy Hour Rental"), { type: "request" }, rental()]), status: 200 };
    }, venueProofMatches, isSafeRecipeUrl);
    expect(reads).toHaveLength(2);
    expect(reads[0]).toBe(sevenRoomsPublicRequests(source.bookingUrl).metadataUrl);
    expect(reads[1]).toContain("time_slot=12:00&party_size=2&halo_size_interval=64&start_date=10-23-2030&num_days=1");
    expect(result.observation).toMatchObject({ completeRequestedDate: true, availableRentalRows: 2, observedRentalLabels: ["Happy Hour Rental", "Peak Rental"], publicRequests: 2 });
    expect(result.identity.venueName).toBe(source.venueName);
    const fields = Object.fromEntries(Object.entries(result).filter(([key]) => !["identity", "observation"].includes(key)));
    expect(parseAccessRecipe({ ...recipe(), ...fields })).toBeDefined();
  });
  it("independently rechecks venue, participant/date/duration, and both labels without starting a browser", async () => {
    const deps = dependencies();
    const result = await executeAccessRecipe(recipe(), input, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, durationVerified: true, capacityVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(2);
    expect(result.slots.every(slot => slot.availableSpots === 1 && slot.startsAt === "2030-10-23T21:00:00.000Z" && slot.endsAt === "2030-10-23T22:00:00.000Z")).toBe(true);
    expect(deps.fetch).toHaveBeenCalledTimes(2); expect(deps.requestLease).toHaveBeenCalledTimes(2); expect(deps.launchBrowser).not.toHaveBeenCalled();
    for (const [, init] of deps.fetch.mock.calls) expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect(result.evidence.recipeHash).toBe(hashAccessRecipe(recipe()));
  });
  it("reuses the exact saved recipe with changed date, attendees and duration", async () => {
    const changed = { ...input, date: "2030-10-24", players: 3, durationMinutes: 120, startTime: "11:00", endTime: "19:00" };
    const rows = { status: 200, data: { availability: { [changed.date]: [{ times: [rental("Peak Rental", { time_iso: "2030-10-24T12:00:00-04:00", duration: 120 })] }] } } };
    const deps = dependencies(metadata(), rows), result = await executeAccessRecipe(recipe(), changed, deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true });
    expect(result.slots[0]).toMatchObject({ startsAt: "2030-10-24T16:00:00.000Z", endsAt: "2030-10-24T18:00:00.000Z" });
    expect(String(deps.fetch.mock.calls[1][0])).toContain("party_size=3&halo_size_interval=64&start_date=10-24-2030");
    expect(String(deps.fetch.mock.calls[1][0])).toContain("picked_duration=120");
    expect(result.evidence.recipeHash).toBe(hashAccessRecipe(recipe()));
  });
  it.each(["name", "url_key", "timezone", "address", "city", "state", "postal_code", "country_code"])("rejects fresh metadata identity mismatch before inventory: %s", async field => {
    const body = metadata(); Reflect.set(body.data.venue_info, field, "WRONG");
    const deps = dependencies(body), result = await executeAccessRecipe(recipe(), input, deps);
    expect(result.complete).toBe(false); expect(result.slots).toEqual([]); expect(deps.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([availability([]), availability([{ type: "request" }]), availability([rental("Unknown Rental")]),
    availability([rental(), { type: "held" }]), availability([rental(), null]), availability([rental(), rental("Peak Rental", { duration: 90 })]),
    { status: 200, data: { availability: { "2030-10-24": [{ times: [rental()] }] } } }, { ...availability(), status: 500 }])("never converts incomplete or unknown inventory to empty", async body => {
    const result = await executeAccessRecipe(recipe(), input, dependencies(metadata(), body));
    expect(result.complete).toBe(false); expect(result.status).not.toBe("EMPTY"); expect(result.slots).toEqual([]);
  });
  it("requires both HTTP and application success on metadata and never falls back after a public denial", async () => {
    const deps = dependencies({ ...metadata(), status: 500 });
    expect((await executeAccessRecipe(recipe(), input, deps)).complete).toBe(false); expect(deps.fetch).toHaveBeenCalledTimes(1);
    for (const status of [302, 401, 403, 429, 500]) {
      const denied = dependencies(); denied.fetch.mockImplementation(async () => new Response("{}", { status, headers: { "content-type": "application/json" } }));
      const result = await executeAccessRecipe(recipe(), input, denied);
      expect(result.complete).toBe(false); expect(denied.fetch).toHaveBeenCalledTimes(1); expect(denied.launchBrowser).not.toHaveBeenCalled();
      if (status === 429) expect(result.evidence.diagnostic?.code).toBe("HTTP_429");
    }
  });
  it("rejects modified plans, additional read roles and participant bindings outside the closed protocol", () => {
    for (const mutate of [
      (r: Record<string, unknown>) => { r.target = { courseId: "course", kind: "OUTDOOR" }; },
      (r: Record<string, unknown>) => { r.metadataRequest = { url: sevenRoomsPublicRequests(source.bookingUrl).metadataUrl.replace("examplegolf", "othergolf") }; },
      (r: Record<string, unknown>) => { r.request = { url: sevenRoomsPublicRequests(source.bookingUrl).rangeTemplate.replace("12:00", "20:00"), method: "GET" }; },
      (r: Record<string, unknown>) => { r.permittedRoutes = [...sevenRoomsPublicRequests(source.bookingUrl).permittedRoutes, { origin: "https://examplegolf.org", path: "/extra", methods: ["GET"], queryKeys: [] }]; },
      (r: Record<string, unknown>) => { r.responseRows = { ...sevenRoomsPublicRows(["Peak Rental"]), availableTypes: ["book", "held"] }; },
    ]) { const value: Record<string, unknown> = JSON.parse(JSON.stringify(recipe())); mutate(value); expect(() => parseAccessRecipe(value)).toThrow(); }
    expect(() => parseAccessRecipe({ ...recipe(), requestBinding: undefined })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe(), responseRows: { ...sevenRoomsPublicRows(["Peak Rental"]), expectedRentalLabel: "Peak Rental" } })).toThrow();
    expect(() => sevenRoomsPublicRows(["Peak Rental", "Peak Rental"])).toThrow();
    expect(() => sevenRoomsPublicRows(["Members only Rental"])).toThrow();
  });
  it("grants only the saved typed public reads and never navigation, POST or foreign routes", () => {
    const value = recipe(), metadataUrl = sevenRoomsPublicRequests(source.bookingUrl).metadataUrl;
    expect(recipeAllowsRequest(value, metadataUrl, "GET", "fetch")).toBe(true);
    expect(recipeAllowsRequest(value, metadataUrl, "GET", "document")).toBe(false);
    expect(recipeAllowsRequest(value, metadataUrl, "POST", "fetch")).toBe(false);
    expect(recipeAllowsRequest(value, metadataUrl.replace("examplegolf", "othergolf"), "GET", "fetch")).toBe(false);
    expect(recipeAllowsRequest(value, metadataUrl.replace("www.sevenrooms.com", "other.example"), "GET", "fetch")).toBe(false);
  });
  it("inspection rejects malformed rows rather than deriving a plan from the usable sample", async () => {
    const bad = availability([rental(), { type: "book", public_time_slot_description: "Peak Rental" }]);
    await expect(inspectSevenRoomsPublicProtocol(source, input, async url => ({ status: 200, body: url.includes("/venue_info?") ? metadata() : bad }), venueProofMatches, isSafeRecipeUrl)).rejects.toThrow();
  });
  it.each(["Rental for customer@example.com", "Rental 4242 4242 4242 4242", "Rental 555-123-4567", "<b>Rental</b>", "Rental " + "a".repeat(25), "Rental account details"])("does not expose private-shaped labels through new direct inspection: %s", async label => {
    expect(() => sevenRoomsPublicRows([label])).toThrow("RENTAL_LABELS_UNVERIFIED");
    await expect(inspectSevenRoomsPublicProtocol(source, input, async url => ({ status: 200, body: url.includes("/venue_info?") ? metadata() : availability([rental(label)]) }), venueProofMatches, isSafeRecipeUrl)).rejects.toThrow();
  });
});
