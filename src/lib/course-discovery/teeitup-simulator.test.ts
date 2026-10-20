import { describe, expect, it } from "vitest";
import { parseTeeItUpSimulatorAvailability, teeItUpSimulatorDuration } from "./teeitup-simulator";

const facility = { id: 10, courseId: "venue-1", name: "Example Swing Studio", address: "100 Main Rd Suite A, Example, NY 12345, US",
  timeZone: "America/New_York", isSimulator: true };
const input = { date: "2030-10-23", timeZone: facility.timeZone, players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const source = "https://example.book.teeitup.com/";
const rate = { _id: -1, name: "Simulator - 1 hr", allowedPlayers: [1], holes: 18, isSimulator: false,
  golfnow: { GolfCourseId: 55, GolfFacilityId: facility.id } };
const slot = { courseId: facility.courseId, teetime: "2030-10-23T15:00:00.000Z", minPlayers: 1, maxPlayers: 1, bookedPlayers: 3, rates: [rate] };
const parse = (value: unknown) => parseTeeItUpSimulatorAvailability(value, [facility], input, source);

describe("TeeItUp public simulator availability", () => {
  it("uses explicit duration and stable resource identity, preserving unknown human capacity", () => {
    const slots = parse([{ teetimes: [slot, { ...slot, teetime: "2030-10-23T16:00:00.000Z", rates: [{ ...rate, _id: -999 }] }] }]);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ startsAt: slot.teetime, endsAt: "2030-10-23T16:00:00.000Z", availableSpots: 1, capacity: null,
      resourceId: "teeitup-facility:10:simulator:55", productId: "teeitup-duration:60" });
    expect(slots[0]).not.toHaveProperty("holes");
    expect(slots[1].resourceId).toBe(slots[0].resourceId);
    expect(parse([{ teetimes: [{ ...slot, rates: [{ ...rate, _id: -111 }] }] }])[0].sourceId).toBe(slots[0].sourceId);
  });
  it("does not bind saved party size into one-bay availability or infer duration from holes", () => {
    expect(parseTeeItUpSimulatorAvailability([{ teetimes: [slot] }], [facility], { ...input, players: 4 }, source)).toEqual(parse([{ teetimes: [slot] }]));
    expect(parse([{ teetimes: [{ ...slot, rates: [{ ...rate, name: "Simulator - 2 hours" }] }] }])).toEqual([]);
    expect(() => parse([{ teetimes: [{ ...slot, rates: [{ ...rate, name: "Simulator NaN hr" }] }] }])).toThrow();
  });
  it.each(["1 hr", "Simulator - NaN hr", "Simulator - 18 holes", "Simulator - 1 hr lesson", "Golf - 1 hr", "Simulator - 0 hr", "Simulator - 9 hours"])
    ("rejects unproved duration %s", value => { expect(teeItUpSimulatorDuration(value)).toBeUndefined(); });
  it.each([
    { ...rate, allowedPlayers: [1, 2] }, { ...rate, allowedPlayers: [] }, { ...rate, golfnow: undefined },
    { ...rate, golfnow: { ...rate.golfnow, GolfCourseId: 1.5 } }, { ...rate, golfnow: { ...rate.golfnow, GolfFacilityId: 20 } },
    { ...rate, name: "Golf Lesson - 1 hr" }, { ...rate, isSimulator: "false" },
  ])("rejects ambiguous or malformed rate %#", value => { expect(() => parse([{ teetimes: [{ ...slot, rates: [value] }] }])).toThrow(); });
  it.each([
    { ...slot, courseId: "another-venue" }, { ...slot, courseId: undefined }, { ...slot, teetime: "2030-10-24T15:00:00Z" },
    { ...slot, teetime: "2030-10-23T15:00:00" }, { ...slot, maxPlayers: 2 }, { ...slot, rates: undefined },
  ])("rejects incomplete or mismatched slot %#", value => { expect(() => parse([{ teetimes: [value] }])).toThrow(); });
  it("validates every returned row, including rows outside the requested duration", () => {
    expect(() => parse([{ teetimes: [slot, { ...slot, teetime: "2030-10-24T16:00:00Z", rates: [{ ...rate, name: "Simulator - 2 hours" }] }] }])).toThrow();
    expect(() => parse([{ teetimes: [slot, slot] }])).toThrow();
    expect(() => parse([{ message: "Unavailable", teetimes: [] }])).toThrow();
    expect(parse([{ teetimes: [] }])).toEqual([]);
  });
  it("requires any reported tee-time total to match the complete returned collection", () => {
    expect(parse([{ teetimes: [slot], totalAvailableTeetimes: 1 }])).toHaveLength(1);
    expect(parse([{ teetimes: [], totalAvailableTeetimes: 0 }])).toEqual([]);
    for (const total of [0, 2, -1, 501, 1.5, "1", null])
      expect(() => parse([{ teetimes: [slot], totalAvailableTeetimes: total }])).toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    expect(() => parse([{ teetimes: [], totalAvailableTeetimes: 1 }])).toThrow("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
  });
  it("requires a positively identified simulator directory", () => {
    for (const rows of [[], [facility, facility], [{ ...facility, isSimulator: false }], [{ ...facility, timeZone: "America/Chicago" }]])
      expect(() => parseTeeItUpSimulatorAvailability([{ teetimes: [slot] }], rows, input, source)).toThrow();
  });
});
