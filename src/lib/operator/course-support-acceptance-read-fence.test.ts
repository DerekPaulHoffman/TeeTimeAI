import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTANCE_READ_BOUNDARIES, ACCEPTANCE_READ_PHASES, parseAcceptanceReadFenceDetails,
} from "./course-support-acceptance-read-fence";

describe("fixed aggregate acceptance read-fence details", () => {
  it("accepts every fixed phase/boundary pair without adding other evidence", () => {
    for (const phase of ACCEPTANCE_READ_PHASES) {
      for (const boundary of ACCEPTANCE_READ_BOUNDARIES) {
        expect(parseAcceptanceReadFenceDetails({ phase, boundary })).toEqual({ phase, boundary });
      }
    }
    expect(Object.isFrozen(ACCEPTANCE_READ_BOUNDARIES)).toBe(true);
    expect(Object.isFrozen(ACCEPTANCE_READ_PHASES)).toBe(true);
  });

  it.each([
    null, undefined, [], "private-course", {}, { phase: "FLEET" }, { boundary: "TOP_LEVEL_ROWS" },
    { phase: "private-course", boundary: "TOP_LEVEL_ROWS" }, { phase: "FLEET", boundary: "private-course" },
    { phase: "FLEET", boundary: "TOP_LEVEL_ROWS", count: 4 },
    { phase: "FLEET", boundary: "TOP_LEVEL_ROWS", sql: "private-provider-query" },
    { phase: 1, boundary: "TOP_LEVEL_ROWS" }, { phase: "FLEET", boundary: null },
    Object.assign(Object.create({ inherited: "private-course" }), { phase: "FLEET", boundary: "TOP_LEVEL_ROWS" }),
    { phase: "FLEET", boundary: "TOP_LEVEL_ROWS", [Symbol("private-course")]: 1 },
  ])("rejects malformed, non-fixed, or extra evidence case %s", (value) => {
    expect(parseAcceptanceReadFenceDetails(value)).toBeNull();
  });

  it("does not execute getters or expose hostile inspection errors", () => {
    const getter = vi.fn(() => { throw new Error("private-query-details"); });
    const accessor = { boundary: "TOP_LEVEL_ROWS", get phase() { return getter(); } };
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("private-query-details"); } });
    expect(parseAcceptanceReadFenceDetails(accessor)).toBeNull();
    expect(parseAcceptanceReadFenceDetails(hostile)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns an immutable detached pair and supports own null-prototype data", () => {
    const input = { phase: "FLEET", boundary: "TOP_LEVEL_ROWS" };
    const parsed = parseAcceptanceReadFenceDetails(input);
    input.phase = "private-course";
    expect(parsed).toEqual({ phase: "FLEET", boundary: "TOP_LEVEL_ROWS" });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseAcceptanceReadFenceDetails(Object.assign(Object.create(null), {
      phase: "FLEET", boundary: "TOP_LEVEL_ROWS",
    }))).toEqual(parsed);
  });
});
