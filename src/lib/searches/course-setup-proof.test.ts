import { describe, expect, it } from "vitest";
import { classifyCourseSetupProbe } from "./course-setup-proof";

const targetDate = "2026-11-30";
const setupStartedAt = new Date("2026-11-27T22:00:00.000Z");
const providerObservedAt = new Date("2026-11-27T22:01:00.000Z");
const observedAt = new Date("2026-11-27T22:01:01.000Z");
const recordedAt = new Date("2026-11-27T22:01:02.000Z");
const sha256 = "a".repeat(64);

function classify(outcome: string, rawSummary: unknown, options: {
  mode?: "OUTDOOR" | "SIMULATOR";
  observedAt?: Date;
  recordedAt?: Date;
} = {}) {
  return classifyCourseSetupProbe({
    mode: options.mode ?? "OUTDOOR", targetDate, setupStartedAt,
    recordedAt: options.recordedAt ?? recordedAt,
    probe: { outcome, observedAt: options.observedAt ?? observedAt, rawSummary },
  });
}

const sheet = {
  providerExecution: "RUNNABLE_PROVIDER_CHECK",
  providerObservedAt: providerObservedAt.toISOString(),
  publicAvailability: { date: targetDate, confirmedAt: providerObservedAt.toISOString(), times: [] },
};
const recipe = {
  providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: providerObservedAt.toISOString(),
  recipeId: "recipe", recipeHash: sha256, recipeExecutionId: "execution", complete: true,
  observedAt: providerObservedAt.toISOString(),
};
const simulator = {
  mode: "SIMULATOR", sourceFingerprint: sha256, providerObservedAt: observedAt.toISOString(),
  matchingSessions: 0, durationMinutes: 60,
};

describe("setup proof from committed checks", () => {
  it("recognizes an exact outdoor tee sheet with no matching openings and a local-reader match", () => {
    expect(classify("NO_MATCH", sheet)).toEqual({ outcome: "NO_OPENINGS", evidenceAt: providerObservedAt });
    const result = classify("MATCH_FOUND", { ...sheet, providerExecution: "LOCAL_BROWSER_READER",
      publicAvailability: { ...sheet.publicAvailability, times: [{ startsAt: "2026-11-30T14:00:00.000Z" }] },
    });
    expect(result).toEqual({ outcome: "MATCHES_AVAILABLE", evidenceAt: providerObservedAt });
  });

  it("requires a complete, attributable recipe execution", () => {
    expect(classify("MATCH_FOUND", recipe)).toEqual({ outcome: "MATCHES_AVAILABLE", evidenceAt: providerObservedAt });
    expect(classify("NO_MATCH", recipe)).toEqual({ outcome: "NO_OPENINGS", evidenceAt: providerObservedAt });
    expect(classify("MATCH_FOUND", { ...recipe, complete: false })).toBeNull();
    expect(classify("MATCH_FOUND", { ...recipe, recipeHash: "report" })).toBeNull();
    expect(classify("MATCH_FOUND", { ...recipe, observedAt: observedAt.toISOString() })).toBeNull();
  });

  it("rejects status-only, out-of-scope and temporally invalid observations", () => {
    expect(classify("NO_MATCH", { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: providerObservedAt.toISOString() })).toBeNull();
    expect(classify("NO_MATCH", { ...sheet, publicAvailability: { ...sheet.publicAvailability, date: "2026-11-29" } })).toBeNull();
    expect(classify("MATCH_FOUND", sheet)).toBeNull();
    expect(classify("NO_MATCH", { ...sheet, providerObservedAt: "2026-11-27T21:59:00.000Z" })).toBeNull();
    expect(classify("NO_MATCH", sheet, { recordedAt: providerObservedAt })).toBeNull();
    expect(classify("NO_MATCH", sheet, { observedAt: new Date("bad clock") })).toBeNull();
  });

  it("distinguishes a verified published outdoor release from guesses and an already open window", () => {
    const waiting = {
      targetDate, bookingWindow: { opensAt: "2026-11-29T15:00:00.000Z", source: "PROVIDER_MESSAGE", evidenceUrl: "https://golf.example/calendar" },
    };
    expect(classify("NO_MATCH", waiting)).toEqual({ outcome: "BOOKING_NOT_OPEN", evidenceAt: observedAt });
    expect(classify("NO_MATCH", { ...waiting, targetDate: "2026-11-29" })).toBeNull();
    expect(classify("NO_MATCH", { ...waiting, bookingWindow: { ...waiting.bookingWindow, source: "OBSERVED_INVENTORY" } })).toBeNull();
    expect(classify("NO_MATCH", { ...waiting, bookingWindow: { ...waiting.bookingWindow, evidenceUrl: "http://localhost/calendar" } })).toBeNull();
    expect(classify("NO_MATCH", waiting, { recordedAt: new Date(waiting.bookingWindow.opensAt) })).toBeNull();
  });

  it("accepts only signed-off factual direct actions and no tooling or access errors", () => {
    expect(classify("MANUAL_DIRECT", { monitoringDisposition: "MANUAL_FINAL" })).toEqual({ outcome: "DIRECT_ACTION", evidenceAt: observedAt });
    expect(classify("IDENTITY_FINAL", { monitoringDisposition: "IDENTITY_FINAL" })).toEqual({ outcome: "DIRECT_ACTION", evidenceAt: observedAt });
    expect(classify("BLOCKED_AUTH", { monitoringDisposition: "TECHNICAL_FINAL" })).toBeNull();
    expect(classify("BLOCKED_TOOLING", { monitoringDisposition: "MANUAL_FINAL" })).toBeNull();
    expect(classify("NEEDS_ADAPTER", sheet)).toBeNull();
  });

  it("requires committed simulator evidence with a matching count and exact observation clock", () => {
    const options = { mode: "SIMULATOR" } as const;
    expect(classify("NO_MATCH", simulator, options)).toEqual({ outcome: "NO_OPENINGS", evidenceAt: observedAt });
    expect(classify("MATCH_FOUND", { ...simulator, matchingSessions: 2, durationMinutes: null }, options)).toEqual({ outcome: "MATCHES_AVAILABLE", evidenceAt: observedAt });
    expect(classify("NO_MATCH", { ...simulator, matchingSessions: 2 }, options)).toBeNull();
    expect(classify("MATCH_FOUND", { ...simulator, matchingSessions: 2.5 }, options)).toBeNull();
    expect(classify("NO_MATCH", { ...simulator, sourceFingerprint: "unverified" }, options)).toBeNull();
    expect(classify("NO_MATCH", { ...simulator, providerObservedAt: providerObservedAt.toISOString() }, options)).toBeNull();
    expect(classify("NO_MATCH", { ...simulator, targetDate: "2026-11-28" }, options)).toBeNull();
    expect(classify("NO_MATCH", simulator)).toBeNull();
  });

  it("requires a verified simulator booking window or factual disposition", () => {
    const options = { mode: "SIMULATOR" } as const;
    const source = { mode: "SIMULATOR", sourceFingerprint: sha256 };
    const waiting = { ...source, bookingNotOpen: true, opensAt: "2026-11-29T15:00:00.000Z", targetDate };
    expect(classify("NO_MATCH", waiting, options)).toBeNull();
    expect(classify("NO_MATCH", { ...waiting, bookingWindowVerified: true }, options)).toEqual({ outcome: "BOOKING_NOT_OPEN", evidenceAt: observedAt });
    expect(classify("NO_MATCH", { ...waiting, bookingWindowVerified: true }, { ...options, recordedAt: new Date(waiting.opensAt) })).toBeNull();
    const direct = { ...source, officialSiteOnly: true };
    expect(classify("MANUAL_DIRECT", direct, options)).toBeNull();
    expect(classify("IDENTITY_FINAL", { ...direct, monitoringDisposition: "IDENTITY_FINAL" }, options)).toEqual({ outcome: "DIRECT_ACTION", evidenceAt: observedAt });
    expect(classify("MANUAL_DIRECT", { ...direct, monitoringDisposition: "TECHNICAL_FINAL" }, options)).toBeNull();
  });
});
