import { describe, expect, it } from "vitest";
import { assertSimulatorSessionFitsWindow } from "./simulator-window";

describe("simulator search window", () => {
  it("requires a full session at every venue, including after timezone conversion", () => {
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-08", startTime: "14:00",
      endTime: "15:00", durationMinutes: 120, timeZones: ["America/Chicago"] },
    new Date("2026-10-01T00:00:00.000Z"))).toThrow(/long enough/);
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-08", startTime: "14:00",
      endTime: "16:00", durationMinutes: 120, timeZones: ["America/Chicago", "America/New_York"] },
    new Date("2026-10-01T00:00:00.000Z"))).not.toThrow();
  });
  it("accepts tonight through exact next local midnight, including the last full hour", () => {
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-09", startTime: "18:00",
      endTime: "24:00", durationMinutes: 60, timeZones: ["America/New_York"] },
    new Date("2026-10-10T03:00:00.000Z"))).not.toThrow();
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-09", startTime: "18:00",
      endTime: "23:59", durationMinutes: 60, timeZones: ["America/New_York"] },
    new Date("2026-10-10T03:00:00.000Z"))).toThrow(/complete session still available/);
  });
  it("rejects elapsed and insufficient windows for every canonical venue", () => {
    const input = { date: "2026-10-09", startTime: "18:00", endTime: "24:00",
      durationMinutes: 60, timeZones: ["America/New_York", "America/Los_Angeles"] };
    expect(() => assertSimulatorSessionFitsWindow(input, new Date("2026-10-10T02:00:00.000Z"))).not.toThrow();
    expect(() => assertSimulatorSessionFitsWindow(input, new Date("2026-10-10T03:00:00.001Z")))
      .toThrow(/every venue/);
    expect(() => assertSimulatorSessionFitsWindow(input, new Date("2026-10-10T07:00:00.000Z")))
      .toThrow(/every venue/);
  });
  it.each([
    ["spring", "2026-03-08", "2026-03-09T03:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["fall", "2026-11-01", "2026-11-02T04:00:00.000Z", "2026-11-02T05:00:00.000Z"],
  ])("uses next local midnight across the %s DST boundary", (_name, date, lastHour, midnight) => {
    const input = { date, startTime: "18:00", endTime: "24:00", durationMinutes: 60,
      timeZones: ["America/New_York"] };
    expect(() => assertSimulatorSessionFitsWindow(input, new Date(lastHour))).not.toThrow();
    expect(() => assertSimulatorSessionFitsWindow(input, new Date(midnight))).toThrow(/complete session/);
  });
});
