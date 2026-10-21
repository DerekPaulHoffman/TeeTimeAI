import { describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

const input = { date: "2030-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const base = () => ({ schemaVersion: 1, engine: "HTTP_JSON", target: { kind: "OUTDOOR", courseId: "course" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  request: { url: "https://example.org/times?date={{date}}", method: "GET" },
  permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
  proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, players: { path: "players" } },
  slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "capacity" }, minimumPlayers: { path: "minimum" } },
});
const run = (capacity: unknown, players = 2, minimum?: unknown, extraRow?: unknown) => executeAccessRecipe(parseAccessRecipe(base()), { ...input, players }, {
  now: () => new Date("2030-10-20T12:00:00Z"),
  fetch: async () => new Response(JSON.stringify({ venue: "Example Golf", date: input.date, complete: true, players,
    slots: [{ start: "09:00", capacity, ...(minimum === undefined ? {} : { minimum }) }, ...(extraRow === undefined ? [] : [extraRow])] }),
  { headers: { "content-type": "application/json" } }),
  requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
});

describe("public party options in deterministic execution", () => {
  it.each([
    ["1 player", 1, 1], ["1 to 4 players", 2, 4], ["2 to 4 players", 4, 4],
    ["1 or 4 players", 1, 4], ["1 or 4 players", 4, 4], ["2 or 4 players", 2, 4], ["4 players", 4, 4],
  ])("accepts an explicitly offered party: %s / %s", async (label, players, max) => {
    expect(await run(label, players)).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: max }] });
  });
  it.each([["1 player", 2], ["2 to 4 players", 1], ["1 or 4 players", 2], ["1 or 4 players", 3], ["4 players", 2]])(
    "does not fill discrete gaps or treat labelled singles as capacity counts: %s / %s", async (label, players) => {
      expect(await run(label, players)).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
    });
  it("keeps numeric capacity counts and their separate minimum unchanged", async () => {
    expect(await run(4, 2)).toMatchObject({ status: "AVAILABLE", slots: [{ availableSpots: 4 }] });
    expect(await run("4", 2, "2")).toMatchObject({ status: "AVAILABLE", slots: [{ availableSpots: 4 }] });
    expect(await run(4, 1, 2)).toMatchObject({ status: "EMPTY", complete: true, slots: [] });
  });
  it("accepts equal explicit minimum and rejects contradictory minimum instead of overriding it", async () => {
    expect(await run("2 or 4 players", 4, 2)).toMatchObject({ status: "AVAILABLE", slots: [{ availableSpots: 4 }] });
    for (const minimum of [1, 3, 4])
      expect(await run("2 or 4 players", 4, minimum)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "INVALID_CAPACITY_RANGE" } });
  });
  it.each(["$1 to $4 players", "1 to 4 minutes", "0 players", "101 players", "1 or 2 or 4 players", "2.5 players", "1 to 4 players left", "4 to 1 players"])(
    "keeps malformed or other-unit capacity incomplete: %s", async label => {
      expect(await run(label)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    });
  it("rejects the full result when any row has ambiguous party evidence", async () => {
    expect(await run(4, 2, undefined, { start: "10:00", capacity: "1 to 4 players or $20" }))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it("does not change one-bay simulator quantity or capacity context", async () => {
    const recipe = parseAccessRecipe({ ...base(), target: { kind: "SIMULATOR", courseId: "course", offeringId: "rental" },
      proof: { ...base().proof, durationMinutes: { path: "duration" } },
      slots: { ...base().slots, endsAt: { path: "end" } } });
    const result = await executeAccessRecipe(recipe, { ...input, players: 4, durationMinutes: 60 }, {
      now: () => new Date("2030-10-20T12:00:00Z"),
      fetch: async () => new Response(JSON.stringify({ venue: "Example Golf", date: input.date, complete: true, duration: 60,
        slots: [{ start: "09:00", end: "10:00", capacity: "1 player", minimum: "unparsed context" }] }), { headers: { "content-type": "application/json" } }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 1, capacity: null }] });
  });
});
