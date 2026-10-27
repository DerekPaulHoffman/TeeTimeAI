import { describe, expect, it } from "vitest";
import { simulatorDurationMatches, simulatorDurationsForSearch } from "./simulator-duration";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";

describe("Any simulator duration", () => {
  it("selects every valid published length that fits the requested window", () => {
    expect(simulatorDurationsForSearch(null, [120, 60, 90, 60, 180, 0, 35, 600], "10:00", "12:00"))
      .toEqual([60, 90, 120]);
    expect(simulatorDurationsForSearch(120, [60, 90, 120], "10:00", "12:00")).toEqual([120]);
    expect(simulatorDurationsForSearch(120, [60, 90, 120], "10:00", "11:00")).toEqual([]);
  });
  it("accepts multiple actual session lengths while retaining full-window and same-bay requirements", () => {
    const search = { date: "2030-10-03", startTime: "10:00", endTime: "13:00", players: 4,
      durationMinutes: null, preferredOfferings: [{ offeringId: "sim", rank: 1 }] };
    const base = { offeringId: "sim", sourceId: "one", resourceId: "bay", capacity: 4,
      startsAt: "2030-10-03T10:00", endsAt: "2030-10-03T11:00", bookingUrl: "https://official.example/book" };
    const sessions = [base, { ...base, sourceId: "two", endsAt: "2030-10-03T12:00" },
      { ...base, sourceId: "late", endsAt: "2030-10-03T14:00" },
      { ...base, sourceId: "invalid", endsAt: base.startsAt },
      { ...base, sourceId: "combined", resourceId: "" }];
    expect(filterSimulatorSessionsForSearch(search, sessions, "America/New_York").map(row => row.sourceId)).toEqual(["one", "two"]);
    expect(filterSimulatorSessionsForSearch({ ...search, durationMinutes: 120 }, sessions, "America/New_York").map(row => row.sourceId)).toEqual(["two"]);
    expect(simulatorDurationMatches(null, NaN)).toBe(false);
  });
});
