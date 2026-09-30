import { describe, expect, it } from "vitest";
import {
  buildInventoryHorizonSnapshot,
  getObservedInventoryReleaseForTargetDate,
  inferLearnedInventoryHorizon
} from "./inventory-horizon";

const evidenceUrl = "https://course.example/tee-times";

describe("observed inventory horizons", () => {
  it("requires visible inventory followed by at least two consecutive empty dates", () => {
    expect(
      buildInventoryHorizonSnapshot({
        observedLocalDate: "2026-09-30",
        observedAt: new Date("2026-09-30T16:00:00.000Z"),
        evidenceUrl,
        observations: [
          { targetDate: "2026-10-03", status: "NO_AVAILABILITY" },
          { targetDate: "2026-10-05", status: "AVAILABLE" },
          { targetDate: "2026-10-10", status: "AVAILABLE" },
          { targetDate: "2026-10-11", status: "NO_AVAILABILITY" },
          { targetDate: "2026-10-12", status: "NO_AVAILABILITY" }
        ]
      })
    ).toMatchObject({
      inventoryThroughDate: "2026-10-10",
      daysAhead: 10,
      trailingUnavailableDays: 2
    });
  });

  it("does not treat one empty date as a booking boundary", () => {
    expect(
      buildInventoryHorizonSnapshot({
        observedLocalDate: "2026-09-30",
        observedAt: new Date("2026-09-30T16:00:00.000Z"),
        evidenceUrl,
        observations: [
          { targetDate: "2026-10-10", status: "AVAILABLE" },
          { targetDate: "2026-10-11", status: "NO_AVAILABILITY" }
        ]
      })
    ).toBeNull();
  });

  it("learns only after the frontier advances consistently for three local days", () => {
    const snapshots = [
      ["2026-09-30", "2026-10-10"],
      ["2026-10-01", "2026-10-11"],
      ["2026-10-02", "2026-10-12"]
    ].map(([observedLocalDate, inventoryThroughDate]) => ({
      observedLocalDate,
      inventoryThroughDate,
      daysAhead: 10,
      trailingUnavailableDays: 2,
      observedAt: new Date(`${observedLocalDate}T16:00:00.000Z`),
      evidenceUrl
    }));

    expect(inferLearnedInventoryHorizon(snapshots.slice(0, 2))).toBeNull();
    expect(inferLearnedInventoryHorizon(snapshots)).toMatchObject({
      daysAhead: 10,
      confidence: 0.8,
      sampleCount: 3
    });
  });

  it("calculates the expected inventory release independently from published policy", () => {
    const release = getObservedInventoryReleaseForTargetDate("2026-10-17", {
      timeZone: "America/New_York",
      observedInventoryHorizonDaysAhead: 10,
      observedInventoryHorizonConfidence: 0.8,
      observedInventoryHorizonSampleCount: 3,
      observedInventoryHorizonObservedAt: new Date("2026-10-02T16:00:00.000Z")
    });

    expect(release).toMatchObject({
      releaseDate: "2026-10-07",
      source: "OBSERVED_INVENTORY",
      sampleCount: 3
    });
  });
});
