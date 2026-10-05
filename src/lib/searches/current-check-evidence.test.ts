import { describe, expect, it } from "vitest";

import { projectCurrentCheckEvidence } from "./current-check-evidence";
import { getDashboardAvailabilityView, readDashboardAvailabilitySnapshot } from "./dashboard-availability";
import { buildAlertGenerationStartMarker } from "./generation-clock";

const startedAt = new Date("2026-09-30T03:51:32.423Z");
const search = {
  alertGeneration: 3,
  createdAt: new Date("2026-09-30T03:21:52.387Z"),
  statusEmailSnapshot: buildAlertGenerationStartMarker({ alertGeneration: 3, generationStartedAt: startedAt }),
  lastCheckedAt: new Date("2026-09-30T03:31:59.691Z"),
  lastCheckOutcome: "MATCH_FOUND",
  preferences: [{ course: { id: "course-1" } }],
};
function success(observedAt: Date, providerObservedAt = observedAt, courseId = "course-1") {
  return {
    courseId, observedAt, outcome: "MATCH_FOUND",
    rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: providerObservedAt.toISOString(), visibleSlotCount: 17, playerEligibleSlotCount: 17 },
  };
}

describe("current saved-request check evidence", () => {
  it("retains simulator proof for the current offering without an outdoor execution marker", () => {
    const observedAt = new Date("2026-09-30T03:55:01Z");
    const probe = { courseId: "course-1", offeringId: "simulator-1", observedAt, outcome: "NO_MATCH",
      rawSummary: { mode: "SIMULATOR", providerObservedAt: observedAt.toISOString() } };
    const simulator = { ...search, mode: "SIMULATOR", preferences: [{ course: { id: "course-1" }, offeringId: "simulator-1" }], probes: [probe] };
    expect(projectCurrentCheckEvidence(simulator).probes).toEqual([probe]);
    expect(projectCurrentCheckEvidence({ ...simulator, probes: [{ ...probe, offeringId: "another-simulator" }] }).probes).toEqual([]);
    expect(projectCurrentCheckEvidence({ ...simulator, probes: [{ ...probe, rawSummary: { mode: "OUTDOOR", providerObservedAt: observedAt.toISOString() } }] }).probes).toEqual([]);
  });
  it("removes the former date's totals and checked timestamp without mutating stored history", () => {
    const oldProbe = success(new Date("2026-09-30T03:31:59.787Z"));
    const stored = { ...search, probes: [oldProbe] };
    const projected = projectCurrentCheckEvidence(stored);

    expect(projected.probes).toEqual([]);
    expect(projected.lastCheckedAt).toBeNull();
    expect(projected.lastCheckOutcome).toBeNull();
    expect(projected.probes.reduce((count, probe) => count + (readDashboardAvailabilitySnapshot(probe.rawSummary)?.visibleSlotCount ?? 0), 0)).toBe(0);
    expect(getDashboardAvailabilityView({ alertStatus: "PAUSED", qualifyingMatchCount: 0, players: 2, startTime: "10:00", endTime: "14:00" }).detail).toContain("Resume it");
    expect(stored.probes).toEqual([oldProbe]);
    expect(stored.lastCheckOutcome).toBe("MATCH_FOUND");
  });

  it("keeps a new successful check for the saved settings", () => {
    const completedAt = new Date("2026-09-30T03:55:03.000Z");
    const probe = success(completedAt, new Date("2026-09-30T03:55:01.000Z"));
    const projected = projectCurrentCheckEvidence({ ...search, lastCheckedAt: completedAt, probes: [probe] });
    expect(projected.probes).toEqual([probe]);
    expect(projected.lastCheckedAt).toEqual(completedAt);
    expect(projected.lastCheckOutcome).toBe("MATCH_FOUND");
  });

  it("rejects a reader result newly persisted after the edit when its provider observation predates it", () => {
    const probe = success(new Date("2026-09-30T03:52:00.000Z"), new Date("2026-09-30T03:50:00.000Z"));
    probe.rawSummary.providerExecution = "LOCAL_BROWSER_READER";
    expect(projectCurrentCheckEvidence({ ...search, probes: [probe] }).probes).toEqual([]);
  });

  it.each(["MATCH_FOUND", "NO_MATCH"])("does not turn source-only %s evidence into current availability", (outcome) => {
    const probe = { courseId: "course-1", observedAt: startedAt, outcome, rawSummary: { visibleSlotCount: 17, playerEligibleSlotCount: 17 } };
    expect(projectCurrentCheckEvidence({ ...search, probes: [probe] }).probes).toEqual([]);
  });

  it("keeps current unsupported outcomes without inventing provider success", () => {
    const probe = { courseId: "course-1", observedAt: startedAt, outcome: "NEEDS_ADAPTER" };
    expect(projectCurrentCheckEvidence({ ...search, probes: [probe] }).probes).toEqual([probe]);
  });

  it("reads the preserved clock from a sent status envelope", () => {
    const probe = success(startedAt);
    const snapshot = { ...search.statusEmailSnapshot, kind: "ALERT_GENERATION_STATUS", courseSnapshot: [] };
    expect(projectCurrentCheckEvidence({ ...search, statusEmailSnapshot: snapshot, probes: [probe] }).probes).toEqual([probe]);
  });

  it.each([null, { ...search.statusEmailSnapshot, alertGeneration: 2 }, { ...search.statusEmailSnapshot, generationStartedAt: "invalid" }])("fails closed on missing, mismatched, or malformed legacy clocks", (statusEmailSnapshot) => {
    expect(projectCurrentCheckEvidence({ ...search, statusEmailSnapshot, probes: [success(startedAt)] }).probes).toEqual([]);
  });

  it("uses creation time for the first alert generation", () => {
    const probe = success(startedAt);
    expect(projectCurrentCheckEvidence({ ...search, alertGeneration: 0, statusEmailSnapshot: null, probes: [probe] }).probes).toEqual([probe]);
  });

  it("ignores a course removed from the selected request", () => {
    expect(projectCurrentCheckEvidence({ ...search, probes: [success(startedAt, startedAt, "removed-course")] }).probes).toEqual([]);
  });

  it.each([new Date("invalid"), new Date("2026-09-30T03:52:01.000Z"), new Date("2026-09-30T03:20:00.000Z")])("rejects malformed, future, and excessively lagged provider time", (providerObservedAt) => {
    const probe = success(new Date("2026-09-30T03:52:00.000Z"));
    probe.rawSummary.providerObservedAt = Number.isFinite(providerObservedAt.getTime()) ? providerObservedAt.toISOString() : "invalid";
    expect(projectCurrentCheckEvidence({ ...search, probes: [probe] }).probes).toEqual([]);
  });
});
