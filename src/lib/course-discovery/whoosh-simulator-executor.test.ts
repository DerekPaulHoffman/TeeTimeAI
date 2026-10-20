import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, venueProofMatches } from "./executor";
import { inspectWhooshSimulator, WHOOSH_SIMULATOR_AVAILABILITY_QUERY, WHOOSH_SIMULATOR_CONFIGURATION_QUERY } from "./whoosh-simulator-executor";
import { parseAccessRecipe, hashAccessRecipe } from "./recipe";

const id = (kind: string, value: string) => `${kind}:00000000-0000-0000-0000-${value.padStart(12, "0")}`;
const source = { bookingUrl: "https://app.whoosh.io/patron/club/golf-golf-golf/agenda/golf-golf-golf/today", officialUrl: "https://playgolfgolfgolf.com/",
  venueName: "Golf Golf Golf", providerFamily: "WHOOSH", timeZone: "America/New_York" };
const buckets = [{ id: id("CourseBucket", "3"), name: "Sims", courseIds: [id("Course", "4"), id("Course", "5")] }];
const metadata = { family: "WHOOSH", clubSlug: "golf-golf-golf", facilitySlug: "golf-golf-golf", clubId: id("Club", "1"), facilityId: id("Facility", "2"), courseBuckets: buckets };
const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" }, source, adapter: metadata });
function fixture(date = "2030-10-23", duration = 60) {
  const pageInfo = { hasNextPage: false, hasPreviousPage: false };
  const courses = { pageInfo, edges: buckets[0].courseIds.map((id, index) => ({ node: { id, name: `Course ${index}` } })) };
  const courseBuckets = { pageInfo, edges: [{ node: { id: buckets[0].id, name: "Sims", courses: buckets[0].courseIds.map(id => ({ id })) } }] };
  const club = { id: metadata.clubId, slug: metadata.clubSlug, name: source.venueName, supportsPublic: true, timeZone: source.timeZone };
  const facility = { id: metadata.facilityId, name: "Sims", slug: metadata.facilitySlug, type: "SIMULATOR", department: { type: "GOLF" },
    durations: [30, 60, 90, 120], publicBookingPermissionSet: { isFacilityVisible: true, isFacilityBookable: true }, club, courses, courseBuckets };
  const node = { ...facility, __typename: "Facility", agendas: { pageInfo, edges: [{ node: { id: id("Agenda", "6"), date,
    facility: { id: metadata.facilityId, durations: facility.durations }, blockingRestrictions: { edges: [] as unknown[] },
    availableTimes: [{ dateTime: `${date} 10:00:00`, time: "10:00:00", seriesLength: duration / 15, capacity: null,
      courseBucket: { id: buckets[0].id, name: "Sims" } }] } }] } };
  return { facility, node };
}
const deps = { now: () => new Date("2030-10-20T12:00:00Z"), requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
const input = { date: "2030-10-23", timeZone: source.timeZone, players: 4, durationMinutes: 60, startTime: "09:00", endTime: "18:00" };
const reads = (data: ReturnType<typeof fixture>, error?: unknown) => vi.fn<typeof fetch>(async (_url, init) => {
  const { query } = JSON.parse(String(init?.body));
  return Response.json(error ?? { data: query === WHOOSH_SIMULATOR_CONFIGURATION_QUERY ? { facility: data.facility } : { node: data.node } });
});
describe("fixed public Whoosh simulator recipe", () => {
  it("inspects exact public club, facility, timezone and resource membership", async () => {
    expect(await inspectWhooshSimulator(source, { ...deps, venueMatches: venueProofMatches, fetch: reads(fixture()) })).toEqual(metadata);
  });
  it("reuses one recipe across date and duration without model code or inferred player capacity", async () => {
    const firstRead = reads(fixture()), secondRead = reads(fixture("2030-10-24", 120));
    const first = await executeAccessRecipe(recipe, input, { ...deps, fetch: firstRead });
    const second = await executeAccessRecipe(recipe, { ...input, date: "2030-10-24", durationMinutes: 120 }, { ...deps, fetch: secondRead });
    for (const result of [first, second]) expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hashAccessRecipe(recipe), venueVerified: true, dateVerified: true, durationVerified: true },
      slots: [{ availableSpots: 1, capacity: null, resourceId: `whoosh-bucket:${buckets[0].id}` }] });
    expect(Date.parse(second.slots[0].endsAt!) - Date.parse(second.slots[0].startsAt)).toBe(120 * 60_000);
    expect(firstRead.mock.calls).toHaveLength(2);
    for (const [, init] of [...firstRead.mock.calls, ...secondRead.mock.calls]) {
      const body = JSON.parse(String(init?.body));
      expect([WHOOSH_SIMULATOR_CONFIGURATION_QUERY, WHOOSH_SIMULATOR_AVAILABILITY_QUERY]).toContain(body.query);
      expect(body.query).not.toMatch(/\b(?:session|profile|mutation)\b/iu);
      if (body.query === WHOOSH_SIMULATOR_AVAILABILITY_QUERY) expect(body.variables.groupSize).toBe(1);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
  });
  it.each(["errors", "missing", "wrongDate", "shortDuration", "wrongBucket", "unknownCourse", "wrongZone", "private", "restriction", "duplicate", "nextPage"])("fails incomplete proof without false empty: %s", async reason => {
    const data = fixture(); let error: unknown;
    if (reason === "errors") error = { errors: [{ message: "No" }], data: { node: data.node } };
    if (reason === "missing") data.node.agendas.edges = [];
    if (reason === "wrongDate") data.node.agendas.edges[0].node.availableTimes[0].dateTime = "2030-10-24 10:00:00";
    if (reason === "shortDuration") data.node.agendas.edges[0].node.availableTimes[0].seriesLength = 1;
    if (reason === "wrongBucket") data.node.agendas.edges[0].node.availableTimes[0].courseBucket.id = id("CourseBucket", "999");
    if (reason === "unknownCourse") data.facility.courseBuckets.edges[0].node.courses.push({ id: id("Course", "999") });
    if (reason === "wrongZone") data.facility.club.timeZone = "America/Los_Angeles";
    if (reason === "private") data.facility.publicBookingPermissionSet.isFacilityVisible = false;
    if (reason === "restriction") data.node.agendas.edges[0].node.blockingRestrictions.edges.push({});
    if (reason === "duplicate") data.node.agendas.edges[0].node.availableTimes.push(data.node.agendas.edges[0].node.availableTimes[0]);
    if (reason === "nextPage") data.node.agendas.pageInfo.hasNextPage = true;
    const result = await executeAccessRecipe(recipe, input, { ...deps, fetch: reads(data, error) });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it.each(["Golf Lessons", "Fittings", "Leagues"])("rejects non-rental resource pools: %s", async name => {
    const data = fixture(); data.facility.courseBuckets.edges[0].node.name = name;
    expect((await executeAccessRecipe(recipe, input, { ...deps, fetch: reads(data) })).complete).toBe(false);
  });
  it("permits empty only for a fully proved exact-day agenda", async () => {
    const data = fixture(); data.node.agendas.edges[0].node.availableTimes = [];
    expect(await executeAccessRecipe(recipe, input, { ...deps, fetch: reads(data) })).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
  });
  it("does not turn provider scheduling capacity into a golfer party limit", async () => {
    const data = fixture(); Object.assign(data.node.agendas.edges[0].node.availableTimes[0], { capacity: 6 });
    expect((await executeAccessRecipe(recipe, input, { ...deps, fetch: reads(data) })).slots[0].capacity).toBeNull();
  });
});
