import { describe, expect, it } from "vitest";

import { getNextSaturdayDateInputValue } from "./local-date";

describe("getNextSaturdayDateInputValue", () => {
  it.each([
    ["Saturday", new Date(2026, 6, 11, 12), "2026-07-18"],
    ["Sunday", new Date(2026, 6, 12, 12), "2026-07-18"],
    ["Friday", new Date(2026, 6, 17, 12), "2026-07-18"]
  ])("returns the strictly upcoming Saturday from %s", (_, from, expected) => {
    expect(getNextSaturdayDateInputValue(from)).toBe(expected);
  });
});
