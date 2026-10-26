// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { parseTeeItUpBookingConfiguration } from "./teeitup-booking-configuration";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { venueProofMatches, recipeTimeToInstant } from "./executor";
const source = { officialUrl: "https://example.org/", bookingUrl: "https://new-public-name.book.teeitup.com/", venueName: "Example Golf Club",
  venueAddress: "10 Example Road, Example, NY 12345, USA", timeZone: "America/New_York", providerFamily: "TEEITUP" };
const row = { id: 11, courseId: "provider-11", name: source.venueName, address: source.venueAddress, timeZone: source.timeZone, isSimulator: false };
const config = { alias: "older-public-api-name", gnFacilityIds: [11], name: source.venueName };
const html = (values: unknown[] = [config]) => `<html><script>self.__next_f.push(${JSON.stringify([1, values.map((v, i) => `${i}:${JSON.stringify(v)}`).join("\n") + "\n"])})</script></html>`;
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
const deps = { requestLease: lease, venueMatches: venueProofMatches };
function transport(configuration = html(), directory: unknown = [row]) {
  return vi.fn<typeof fetch>(async (value, init) => {
    const url = new URL(String(value)), headers = new Headers(init?.headers);
    if (url.origin === new URL(source.bookingUrl).origin) {
      expect(url.href).toBe(source.bookingUrl); expect(headers.has("x-be-alias")).toBe(false);
      return new Response(configuration, { headers: { "content-type": "text/html" } });
    }
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(headers.get("origin")).toBe(new URL(source.bookingUrl).origin); expect(headers.get("referer")).toBe(source.bookingUrl);
    if (url.pathname === "/alias/new-public-name/facilities") { expect(headers.get("x-be-alias")).toBe("new-public-name"); return new Response("not found", { status: 404 }); }
    expect(headers.get("x-be-alias")).toBe(config.alias);
    if (url.pathname === `/alias/${config.alias}/facilities`) return Response.json(directory);
    expect(url.pathname).toBe("/v2/tee-times"); expect(url.searchParams.get("facilityIds")).toBe("11");
    const day = url.searchParams.get("date")!;
    return Response.json([{ courseId: row.courseId, teetimes: [{ courseId: row.courseId, teetime: `${day}T15:00:00Z`, rates: [{ allowedPlayers: [2, 3, 4], holes: 18 }] }] }]);
  });
}
describe("strict public TeeItUp alias configuration", () => {
  it("reads literal published routing facts only and ignores changing ancillary data", () => {
    const expected = { apiAlias: config.alias, facilityIds: [11] };
    expect(parseTeeItUpBookingConfiguration(html(), source.venueName)).toEqual(expected);
    expect(parseTeeItUpBookingConfiguration(html([{ ...config, nonce: "new", date: "2030-10-28", rates: [{ private: "IGNORED" }] }]), source.venueName)).toEqual(expected);
  });
  it("handles an independently framed root chunk after a non-newline Flight record", () => {
    const prefixed = `<script>self.__next_f.push(${JSON.stringify([1, "1:T4,text"])})</script>` + html();
    expect(parseTeeItUpBookingConfiguration(prefixed, source.venueName)).toEqual({ apiAlias: config.alias, facilityIds: [11] });
  });
  it.each([{}, { ...config, name: "Foreign Golf Club" }, { ...config, alias: "../../foreign" }, { ...config, gnFacilityIds: [11, 11] },
    { ...config, gnFacilityIds: ["11"] }, { ...config, gnFacilityIds: [] }])("rejects invalid or unbound literal configuration %#", value => {
    expect(() => parseTeeItUpBookingConfiguration(html([value]), source.venueName)).toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
  });
  it("rejects conflicting tenants and executable/nonliteral payloads", () => {
    expect(() => parseTeeItUpBookingConfiguration(html([config, { ...config, alias: "foreign" }]), source.venueName)).toThrow();
    expect(() => parseTeeItUpBookingConfiguration('<script>self.__next_f.push(globalThis.secret())</script>', source.venueName)).toThrow();
    expect(() => parseTeeItUpBookingConfiguration("x".repeat(600001), source.venueName)).toThrow();
  });
  it("after an owned exact directory404 fetches the public page then real remapped directory; source URL stays exact", async () => {
    const fetch = transport(), result = await inspectExistingAdapter(source, { ...deps, fetch });
    expect(result.adapter).toEqual({ family: "TEEITUP", alias: "new-public-name", facilityIds: [11], publicBookingConfiguration: { apiAlias: config.alias, facilityIds: [11] } });
    expect(fetch.mock.calls.map(c => new URL(String(c[0])).pathname)).toEqual(["/alias/new-public-name/facilities", "/", `/alias/${config.alias}/facilities`]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("one serialized method rederives the mapping and proves two fresh dates/parties using full directory identity", async () => {
    const inspected = await inspectExistingAdapter(source, { ...deps, fetch: transport() });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "example", kind: "OUTDOOR" }, source, adapter: inspected.adapter });
    for (const [date, players] of [["2030-10-27", 2], ["2030-10-28", 3]] as const) {
      const fetch = transport(), input = { date, players, timeZone: source.timeZone, startTime: "08:00", endTime: "18:00" };
      const result = await executeExistingAdapterRecipe(recipe as Parameters<typeof executeExistingAdapterRecipe>[0], input,
        { ...deps, fetch, now: () => new Date("2030-10-26T00:00:00Z"), recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant });
      expect(result).toMatchObject({ complete: true, status: "AVAILABLE", evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].bookingUrl).toContain(new URL(source.bookingUrl).hostname);
      expect(result.slots[0].bookingUrl).toContain(`date=${date}`);
      expect(fetch.mock.calls.map(c => new URL(String(c[0])).pathname)).toEqual(["/", `/alias/${config.alias}/facilities`, "/v2/tee-times"]);
    }
  });
  it.each([503, 403, 302])("does not treat HTTP%i as an alias fallback invitation", async status => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status }));
    await expect(inspectExistingAdapter(source, { ...deps, fetch })).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([[{ id: 11, timeZone: source.timeZone }], [{ ...row, address: "Example, NY 12345, US" }], [{ ...row, address: "99 Foreign Road, Example, NY 12345, US" }]])("does not fabricate or waive directory identity %#", async directory => {
    await expect(inspectExistingAdapter(source, { ...deps, fetch: transport(html(), directory) })).rejects.toThrow();
  });
  it("fails a changed warm mapping before any API request", async () => {
    const inspected = await inspectExistingAdapter(source, { ...deps, fetch: transport() });
    const recipe = { schemaVersion: 1 as const, engine: "EXISTING_ADAPTER" as const, target: { courseId: "example", kind: "OUTDOOR" as const }, source, adapter: inspected.adapter };
    const fetch = transport(html([{ ...config, alias: "changed-api-name" }]));
    const result = await executeExistingAdapterRecipe(recipe, { date: "2030-10-27", players: 2, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone },
      { ...deps, fetch, recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant, now: () => new Date("2030-10-26T00:00:00Z") });
    expect(result.complete).toBe(false); expect(result.evidence.reason).toBe("ADAPTER_CONFIGURATION_CHANGED"); expect(fetch).toHaveBeenCalledOnce();
  });
});
