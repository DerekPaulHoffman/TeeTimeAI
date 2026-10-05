import { describe, expect, it } from "vitest";
import { calculateNextSimulatorCheckAt } from "@/lib/automation/search-schedule-execution";
import { getSimulatorBookingOpening } from "./booking-window";

const offering = { bookingWindowDaysAhead: 7, bookingReleaseTimeLocal: "09:00", verifiedAt: new Date("2026-10-01T12:00:00Z"), evidenceUrl: "https://official.example/sim" };
describe("simulator booking-window scheduling", () => {
  it("uses verified offering-local release time, including winter offset", () => {
    expect(getSimulatorBookingOpening("2026-11-15", offering, "America/New_York")?.toISOString()).toBe("2026-11-08T14:00:00.000Z");
    expect(getSimulatorBookingOpening("2026-11-15", { ...offering, evidenceUrl: null }, "America/New_York")).toBeNull();
  });
  it("sleeps to release when all simulator calendars are closed", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    expect(calculateNextSimulatorCheckAt({ date: new Date("2026-10-15T00:00:00Z"), now, checkStartedAt: now, cadenceMinutes: 5,
      searchExpiresAt: new Date("2026-10-16T00:00:00Z"), preferences: [{ course: { timeZone: "America/New_York" }, offering }] })?.toISOString()).toBe("2026-10-08T13:00:00.000Z");
  });
  it("keeps other venues checking and catches a release crossed during a check", () => {
    const input = { date: new Date("2026-10-15T00:00:00Z"), now: new Date("2026-10-05T12:00:00Z"), checkStartedAt: new Date("2026-10-05T12:00:00Z"), cadenceMinutes: 5,
      searchExpiresAt: new Date("2026-10-16T00:00:00Z"), preferences: [{ course: { timeZone: "America/New_York" }, offering }, { course: { timeZone: "America/Los_Angeles" }, offering: null }] };
    expect(calculateNextSimulatorCheckAt(input)?.toISOString()).toBe("2026-10-05T12:05:00.000Z");
    expect(calculateNextSimulatorCheckAt({ ...input, checkStartedAt: new Date("2026-10-08T12:59:00Z"), now: new Date("2026-10-08T13:01:00Z") })?.toISOString()).toBe("2026-10-08T13:01:00.000Z");
  });
});
