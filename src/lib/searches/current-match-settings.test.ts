import { describe, expect, it } from "vitest";

import { matchesCurrentSearchSettings, type CurrentMatchSearchSettings, type CurrentMatchSettings } from "./current-match-settings";

const search: CurrentMatchSearchSettings = {
  date: new Date("2026-09-30T00:00:00.000Z"),
  startTime: "10:00", endTime: "14:00", players: 2,
  requestedLayoutHoles: null,
  preferences: [{ rank: 1, course: { id: "selected" } }],
};
const match: CurrentMatchSettings = {
  startsAt: new Date("2026-09-30T14:00:00.000Z"), availableSpots: 2,
  course: {
    id: "selected", timeZone: "America/New_York", layoutHoleCounts: [18],
    layoutHolesVerifiedAt: new Date("2026-09-01T12:00:00.000Z"),
  },
};

describe("current persisted search match settings", () => {
  it("hides an old-date match after a paused alert date edit", () => {
    expect(matchesCurrentSearchSettings(search, { ...match, startsAt: new Date("2026-10-01T14:00:00.000Z") })).toBe(false);
    expect(matchesCurrentSearchSettings(search, match)).toBe(true);
  });

  it.each([
    ["2026-09-30T13:59:00.000Z", false],
    ["2026-09-30T14:00:00.000Z", true],
    ["2026-09-30T17:59:59.000Z", true],
    ["2026-09-30T18:00:00.000Z", false],
  ])("retains the native matcher boundary for %s", (startsAt, expected) => {
    expect(matchesCurrentSearchSettings(search, { ...match, startsAt: new Date(startsAt) })).toBe(expected);
  });

  it("uses the course-local date when the slot falls on the next UTC day", () => {
    expect(matchesCurrentSearchSettings({ ...search, startTime: "21:00", endTime: "23:00" }, {
      ...match, startsAt: new Date("2026-10-01T02:00:00.000Z"),
    })).toBe(true);
  });

  it("hides insufficient player capacity after a player-count edit", () => {
    expect(matchesCurrentSearchSettings({ ...search, players: 3 }, match)).toBe(false);
  });

  it("hides a course that is no longer selected", () => {
    expect(matchesCurrentSearchSettings({ ...search, preferences: [{ rank: 1, course: { id: "different" } }] }, match)).toBe(false);
  });

  it("uses physical layout compatibility and allows unknown layout", () => {
    const nineHoleRequest = { ...search, requestedLayoutHoles: 9 };
    expect(matchesCurrentSearchSettings(nineHoleRequest, match)).toBe(false);
    expect(matchesCurrentSearchSettings(nineHoleRequest, { ...match, course: { ...match.course, layoutHoleCounts: [] } })).toBe(true);
    expect(matchesCurrentSearchSettings(nineHoleRequest, { ...match, course: { ...match.course, layoutHoleCounts: [9, 18] } })).toBe(true);
  });

  it("keeps unverified layout counts eligible as the native monitor does", () => {
    expect(matchesCurrentSearchSettings({ ...search, requestedLayoutHoles: 18 }, {
      ...match, course: { ...match.course, layoutHoleCounts: [9], layoutHolesVerifiedAt: null },
    })).toBe(true);
  });

  it("does not infer physical course layout from the purchasable round holes", () => {
    const nineHoleRoundAtEighteenHoleCourse = { ...match, holes: 9 };
    expect(matchesCurrentSearchSettings({ ...search, requestedLayoutHoles: 18 }, nineHoleRoundAtEighteenHoleCourse)).toBe(true);
  });

  it.each([
    { date: undefined }, { date: new Date("invalid") }, { date: new Date("2026-09-30T12:00:00.000Z") },
    { startTime: undefined }, { endTime: "24:00" }, { endTime: "09:00" },
    { players: undefined }, { players: 0 }, { players: 5 },
    { preferences: undefined }, { preferences: [{ rank: 1, course: {} }] },
    { requestedLayoutHoles: 27 },
  ])("fails closed for invalid persisted search settings %j", (invalid) => {
    expect(matchesCurrentSearchSettings({ ...search, ...invalid } as never, match)).toBe(false);
  });

  it.each([
    { startsAt: undefined }, { startsAt: new Date("invalid") }, { availableSpots: undefined },
    { availableSpots: -1 }, { course: { ...match.course, timeZone: undefined } },
    { course: { ...match.course, timeZone: "invalid" } }, { course: { ...match.course, layoutHoleCounts: undefined } },
  ])("fails closed for invalid persisted slot settings %j", (invalid) => {
    expect(matchesCurrentSearchSettings(search, { ...match, ...invalid } as never)).toBe(false);
  });
});
