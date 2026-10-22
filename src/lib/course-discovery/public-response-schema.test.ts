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
  it("retains closed success envelope scalars before a large nested inventory consumes the schema budget", () => {
    const inventory = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`column${index}`, {
      data: { value: "arbitrary public or private text", nested: { quantity: 9 } },
    }]));
    const result = publicResponseSchema({ TeeTimeData: [inventory], ErrorMessage: "", status: "SUCCESS", success: true });
    expect(result.truncated).toBe(true);
    expect(result.fields).toContainEqual({ path: "ErrorMessage", type: "string", examples: [""] });
    expect(result.fields).toContainEqual({ path: "status", type: "string", examples: ["SUCCESS"] });
    expect(result.fields).toContainEqual({ path: "success", type: "boolean", examples: [true] });
    expect(result.kind).toBe("SAMPLED_SCHEMA_ONLY");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(12000);
  });
  it("never exposes arbitrary status or nonempty error text as scalar examples", () => {
    const result = publicResponseSchema({ status: "Jane Doe", errorMessage: "Jane: jane@example.com", message: "OK",
      customer: { status: "SUCCESS", ErrorMessage: "" }, data: { status: "ok", ErrorMessage: "", statusCode: 200 } });
    expect(result.fields.find(field => field.path === "status")?.examples).toBeUndefined();
    expect(result.fields.find(field => field.path === "errorMessage")?.examples).toBeUndefined();
    expect(result.fields.find(field => field.path === "message")?.examples).toBeUndefined();
    expect(result.fields).toContainEqual({ path: "data.status", type: "string", examples: ["ok"] });
    expect(result.fields).toContainEqual({ path: "data.ErrorMessage", type: "string", examples: [""] });
    expect(result.fields).toContainEqual({ path: "data.statusCode", type: "number", examples: [200] });
    for (const text of ["Jane", "jane@example.com", "customer.status"]) expect(JSON.stringify(result)).not.toContain(text);
  });
  it("shows observed public time and flag scalars without interpreting their availability semantics", () => {
    const result = publicResponseSchema({ time_iso: "2026-10-23T17:15:00", utc_datetime: "2026-10-23T21:15:00Z",
      real_datetime_of_slot: "2026-10-23 17:15:00", is_held: true, is_requestable: false, type: "PERSONAL TEXT",
      account: { time_iso: "2026-10-23T12:00:00" }, errorMessage: "" });
    for (const path of ["time_iso", "utc_datetime", "real_datetime_of_slot", "is_held", "is_requestable"]) {
      expect(result.fields.find(field => field.path === path)?.examples).toHaveLength(1);
    }
    expect(JSON.stringify(result)).not.toContain("PERSONAL TEXT");
    expect(JSON.stringify(result)).not.toContain("12:00:00");
    expect(result.kind).toBe("SAMPLED_SCHEMA_ONLY");
  });
  it("samples only the closed book/request type words without assuming they occur or imply availability", () => {
    const value = { rows: [{ type: "request" }, { type: "book" }, { type: "Jane" }],
      account: { type: "book" }, other: { type: "arbitrary_unknown_type" } };
    const result = publicResponseSchema(value);
    expect(result.fields.find(field => field.path === "rows[].type")?.examples).toEqual(["request", "book"]);
    expect(result.fields.find(field => field.path === "other.type")?.examples).toBeUndefined();
    for (const text of ["Jane", "arbitrary_unknown_type", "account.type"]) expect(JSON.stringify(result)).not.toContain(text);
    expect(publicResponseSchema({ rows: [{ type: "something_else" }] }).fields.find(field => field.path === "rows[].type")?.examples).toBeUndefined();
    expect(result.kind).toBe("SAMPLED_SCHEMA_ONLY");
  });
});
