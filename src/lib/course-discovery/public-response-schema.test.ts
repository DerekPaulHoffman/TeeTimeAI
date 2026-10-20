// @vitest-environment node
import { describe, expect, it } from "vitest";
import { publicResponseSchema } from "./public-response-schema";

describe("bounded public JSON schema evidence", () => {
  it("exposes deep availability field paths and observed array counts without claiming complete inventory", () => {
    const value = { data: { node: { agendas: { edges: [{ node: { availableTimes: Array.from({ length: 41 }, () => ({
      startTime: "2026-10-23T10:00:00-04:00", durationMinutes: 60, available: true, resourceId: "private-or-public-id", __typename: "AvailableTime",
    })) } }] } } } };
    const result = publicResponseSchema(value);
    expect(result.kind).toBe("SAMPLED_SCHEMA_ONLY");
    expect(result.truncated).toBe(true);
    expect(result.fields).toContainEqual({ path: "data.node.agendas.edges[].node.availableTimes", type: "array", arrayLengths: [41] });
    expect(result.fields).toContainEqual({ path: "data.node.agendas.edges[].node.availableTimes[].startTime", type: "string", examples: ["2026-10-23T10:00:00-04:00"] });
    expect(result.fields).toContainEqual({ path: "data.node.agendas.edges[].node.availableTimes[].resourceId", type: "opaque-identifier" });
    expect(JSON.stringify(result)).not.toContain("private-or-public-id");
  });
  it("suppresses private subtrees, arbitrary values, identifier values, query documents and unsafe keys", () => {
    const value = JSON.parse('{"session":{"token":"SECRET"},"customer":{"name":"Jane"},"query":"query Booking { secret }","id":"123456","title":"PERSONAL TEXT","email@example.com":"PRIVATE","__proto__":{"unsafe":"LEAK"},"data":{"__typename":"Agenda","complete":true,"date":"2026-10-23"}}');
    const text = JSON.stringify(publicResponseSchema(value));
    for (const secret of ["SECRET", "Jane", "query Booking", "123456", "PERSONAL TEXT", "email@example.com", "PRIVATE", "LEAK"]) expect(text).not.toContain(secret);
    expect(text).toContain("Agenda"); expect(text).toContain("2026-10-23");
  });
  it("bounds deep, wide and large-array responses", () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, { value: "x".repeat(1000) }]));
    const deep: Record<string, unknown> = {}; let cursor = deep;
    for (let i = 0; i < 100; i++) { const child = {}; cursor.next = child; cursor = child; }
    for (const value of [wide, deep, Array.from({ length: 10000 }, () => wide)]) {
      const result = publicResponseSchema(value);
      expect(result.truncated).toBe(true); expect(result.fields.length).toBeLessThanOrEqual(120);
      expect(result.nodesVisited).toBeLessThanOrEqual(2000); expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
    }
  });
  it("omits account subtrees and out-of-range numeric examples", () => {
    const result = publicResponseSchema({ account: { date: "2026-10-23", capacity: 4 }, durationMinutes: 600000,
      players: -1, month: 99, year: 9999, data: { durationMinutes: 90, availableSpots: 4 } });
    expect(result.fields.find(field => field.path === "account")).toEqual({ path: "account", type: "redacted" });
    for (const path of ["durationMinutes", "players", "month", "year"]) expect(result.fields.find(field => field.path === path)?.examples).toBeUndefined();
    expect(result.fields.find(field => field.path === "data.durationMinutes")?.examples).toEqual([90]);
  });
});
