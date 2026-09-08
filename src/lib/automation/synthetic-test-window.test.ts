import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getSyntheticMultiCycleExpiresAt,
  SYNTHETIC_MULTI_CYCLE_LIFETIME_MS,
} from "./synthetic-test-window";

describe("bounded synthetic multi-cycle test window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T13:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  const createdAt = new Date("2026-07-01T12:00:00.000Z");
  const originalExpiresAt = new Date("2026-07-02T06:00:00.000Z");
  const timing = { createdAt, trafficClass: "TEST" as const, syntheticMultiCycle: true, alertGeneration: 7 };
  const window = {
    schemaVersion: 1,
    alertGeneration: 7,
    activatedAt: "2026-07-15T12:00:00.000Z",
    expiresAt: "2026-07-16T06:00:00.000Z",
  };

  it("retains the original eighteen-hour lifetime without an explicit window", () => {
    expect(SYNTHETIC_MULTI_CYCLE_LIFETIME_MS).toBe(18 * 60 * 60 * 1000);
    for (const syntheticTestWindow of [undefined, null]) {
      expect(getSyntheticMultiCycleExpiresAt({ ...timing, syntheticTestWindow })).toEqual(originalExpiresAt);
    }
  });

  it.each(["TEST", "AUTOMATION"] as const)("uses a matching explicit window for %s without changing original creation time", (trafficClass) => {
    const input = { ...timing, trafficClass, syntheticTestWindow: window };
    expect(getSyntheticMultiCycleExpiresAt(input)).toEqual(new Date(window.expiresAt));
    expect(input.createdAt).toEqual(createdAt);
    expect(input.syntheticTestWindow).toEqual(window);
  });

  it("accepts generation zero and a shorter positive bounded duration", () => {
    expect(getSyntheticMultiCycleExpiresAt({
      ...timing, alertGeneration: 0,
      syntheticTestWindow: { ...window, alertGeneration: 0, expiresAt: "2026-07-15T12:00:00.001Z" },
    })).toEqual(new Date("2026-07-15T12:00:00.001Z"));
  });

  it.each([undefined, 6, 8])("does not renew the original lifetime when current generation is %s", (alertGeneration) => {
    expect(getSyntheticMultiCycleExpiresAt({ ...timing, alertGeneration, syntheticTestWindow: window })).toEqual(originalExpiresAt);
  });

  it("requires valid chronology before applying a mismatched generation fallback", () => {
    expect(getSyntheticMultiCycleExpiresAt({
      ...timing, alertGeneration: 8,
      syntheticTestWindow: { ...window, activatedAt: "2026-07-16T12:00:00.000Z", expiresAt: "2026-07-16T13:00:00.000Z" },
    })).toEqual(new Date(0));
  });

  it("rejects activation before creation and after the caller's clock", () => {
    expect(getSyntheticMultiCycleExpiresAt({
      ...timing, createdAt: new Date("2026-07-15T12:00:00.001Z"), syntheticTestWindow: window,
    })).toEqual(new Date(0));
    expect(getSyntheticMultiCycleExpiresAt({ ...timing, syntheticTestWindow: window }, new Date("2026-07-15T11:59:59.999Z"))).toEqual(new Date(0));
    expect(getSyntheticMultiCycleExpiresAt({ ...timing, syntheticTestWindow: window }, new Date(window.activatedAt))).toEqual(new Date(window.expiresAt));
  });

  it("fails closed for invalid creation or caller clocks", () => {
    for (const syntheticTestWindow of [null, window]) {
      expect(getSyntheticMultiCycleExpiresAt({ ...timing, createdAt: new Date(NaN), syntheticTestWindow })).toEqual(new Date(0));
      expect(getSyntheticMultiCycleExpiresAt({ ...timing, syntheticTestWindow }, new Date(NaN))).toEqual(new Date(0));
    }
  });

  it.each(["PUBLIC", "UNCLASSIFIED"] as const)("does not impose synthetic expiry on %s traffic", (trafficClass) => {
    for (const syntheticTestWindow of [undefined, window, { invalid: true }]) {
      expect(getSyntheticMultiCycleExpiresAt({ ...timing, trafficClass, syntheticTestWindow })).toBeNull();
    }
  });

  it.each(["TEST", "AUTOMATION"] as const)("does not turn a one-check %s search into multi-cycle work", (trafficClass) => {
    expect(getSyntheticMultiCycleExpiresAt({ ...timing, trafficClass, syntheticMultiCycle: false, syntheticTestWindow: window })).toBeNull();
  });

  const malformed = [
    { name: "primitive", value: "window" },
    { name: "array", value: [] },
    { name: "missing fields", value: {} },
    { name: "unknown schema", value: { ...window, schemaVersion: 2 } },
    { name: "unknown field", value: { ...window, renew: true } },
    { name: "negative generation", value: { ...window, alertGeneration: -1 } },
    { name: "fractional generation", value: { ...window, alertGeneration: 7.5 } },
    { name: "missing generation", value: { ...window, alertGeneration: undefined } },
    { name: "string generation", value: { ...window, alertGeneration: "7" } },
    { name: "invalid activation", value: { ...window, activatedAt: "not-a-time" } },
    { name: "invalid expiry", value: { ...window, expiresAt: "not-a-time" } },
    { name: "noncanonical activation", value: { ...window, activatedAt: "2026-07-15T08:00:00.000-04:00" } },
    { name: "noncanonical expiry", value: { ...window, expiresAt: "2026-07-16T06:00:00Z" } },
    { name: "activation whitespace", value: { ...window, activatedAt: ` ${window.activatedAt}` } },
    { name: "zero duration", value: { ...window, expiresAt: window.activatedAt } },
    { name: "reversed duration", value: { ...window, expiresAt: "2026-07-15T11:59:59.999Z" } },
    { name: "over eighteen hours", value: { ...window, expiresAt: "2026-07-16T06:00:00.001Z" } },
  ];
  it.each(malformed)("fails closed for $name rather than falling back to a live original window", ({ value }) => {
    expect(getSyntheticMultiCycleExpiresAt({
      ...timing, createdAt: new Date(window.activatedAt), syntheticTestWindow: value,
    })).toEqual(new Date(0));
  });
});
