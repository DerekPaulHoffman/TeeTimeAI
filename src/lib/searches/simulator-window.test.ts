import { describe, expect, it } from "vitest";
import { assertSimulatorSessionFitsWindow } from "./simulator-window";

describe("simulator search window", () => {
  it("requires a full session at every venue, including after timezone conversion", () => {
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-08", startTime: "14:00",
      endTime: "15:00", durationMinutes: 120, timeZones: ["America/Chicago"] })).toThrow(/long enough/);
    expect(() => assertSimulatorSessionFitsWindow({ date: "2026-10-08", startTime: "14:00",
      endTime: "16:00", durationMinutes: 120, timeZones: ["America/Chicago", "America/New_York"] })).not.toThrow();
  });
});
