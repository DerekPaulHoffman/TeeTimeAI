import { describe, expect, it } from "vitest";

import {
  getMinimumSearchDateInputValue,
  getNextSaturdayDateInputValue,
  reconcileFutureSearchDateInputValue
} from "./local-date";

describe("getNextSaturdayDateInputValue", () => {
  it.each([
    ["Saturday", new Date(2026, 6, 11, 12), "2026-07-18"],
    ["Sunday", new Date(2026, 6, 12, 12), "2026-07-18"],
    ["Friday", new Date(2026, 6, 17, 12), "2026-07-18"]
  ])("returns the strictly upcoming Saturday from %s", (_, from, expected) => {
    expect(getNextSaturdayDateInputValue(from)).toBe(expected);
  });
});

describe("search date rollover", () => {
  const fridayNight = new Date(2026, 6, 31, 23, 59, 30);
  const saturdayMorning = new Date(2026, 7, 1, 0, 1);

  it("moves the minimum date forward with the local calendar day", () => {
    expect(getMinimumSearchDateInputValue(fridayNight)).toBe("2026-08-01");
    expect(getMinimumSearchDateInputValue(saturdayMorning)).toBe("2026-08-02");
  });

  it("replaces a stale untouched date with the next upcoming Saturday", () => {
    expect(reconcileFutureSearchDateInputValue("2026-08-01", saturdayMorning)).toBe(
      "2026-08-08"
    );
  });

  it("preserves a date that remains inside the valid future range", () => {
    expect(reconcileFutureSearchDateInputValue("2026-08-15", saturdayMorning)).toBe(
      "2026-08-15"
    );
  });
});
