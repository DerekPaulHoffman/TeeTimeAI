// @vitest-environment node
import { describe, expect, it } from "vitest";
import { selectCourseDiscoveryPilot } from "../../../scripts/automation/select-course-discovery-pilot.mjs";

const now = new Date("2030-01-01T12:00:00.000Z");
function candidate(id: string, kind = "OUTDOOR", providerFamily = "FOREUP") {
  return { id, name: `Public Venue ${id}`, kind, providerFamily, countryCode: "US", officialUrl: "https://golf.example.com/",
    unconfigured: true, inventoryVerified: true, inventoryEvidenceUrl: "https://golf.example.com/availability", inventoryObservedAt: "2030-01-01T11:30:00.000Z" };
}
const catalog = () => ({ schemaVersion: 1, candidates: [candidate("one"), candidate("two", "SIMULATOR", "ACUITY"), candidate("three", "OUTDOOR", "TEEITUP"),
  candidate("four", "SIMULATOR", "USCHEDULE"), candidate("five", "OUTDOOR", "CHRONOGOLF")] });

describe("observer-only pilot selection", () => {
  it("reproduces the complete draw from the same seed and catalog", () => {
    const first = selectCourseDiscoveryPilot(catalog(), { seed: "recorded-seed", now });
    const second = selectCourseDiscoveryPilot(catalog(), { seed: "recorded-seed", now });
    expect(first).toEqual(second);
    expect(first.status).toBe("SELECTED");
    expect(first.selected).toHaveLength(3);
    expect(new Set(first.selected.map((row: { providerFamily: string }) => row.providerFamily)).size).toBe(3);
    expect(new Set(first.selected.map((row: { kind: string }) => row.kind)).size).toBe(2);
    expect(first.orderedDraw).toHaveLength(5);
  });
  it("keeps the same eligible draw when the supplied catalog order changes", () => {
    const original = catalog();
    const shuffled = { ...original, candidates: [...original.candidates].reverse() };
    const draw = (value: typeof original) => selectCourseDiscoveryPilot(value, { seed: "fixed", now }).orderedDraw.map((row: { id: string }) => row.id);
    expect(draw(original)).toEqual(draw(shuffled));
  });
  it("accepts an observer-identified provider family without a preexisting adapter registry entry", () => {
    const value = { schemaVersion: 1, candidates: [candidate("one"), candidate("two", "SIMULATOR", "ACUITY"), candidate("new", "OUTDOOR", "BOOKING_VENDOR_NEW")] };
    const receipt = selectCourseDiscoveryPilot(value, { seed: "new-provider", now });
    expect(receipt.status).toBe("SELECTED");
    expect(receipt.selected.map((row: { providerFamily: string }) => row.providerFamily)).toContain("BOOKING_VENDOR_NEW");
    expect(receipt.constraints.distinctProviderFamilies).toBe(3);
  });
  it.each(["UNCLASSIFIED", "CUSTOM", "OTHER", "NONE", "SOURCE_MISSING", "UNKNOWN_VENDOR", "TBD", "vendor.example", "V".repeat(81)])("rejects a generic or malformed provider family %s", providerFamily => {
    const receipt = selectCourseDiscoveryPilot({ schemaVersion: 1, candidates: [candidate("one", "OUTDOOR", providerFamily)] }, { seed: "fixed", now });
    expect(receipt.excludedCandidates[0].reasons).toContain("UNKNOWN_PROVIDER_FAMILY");
  });
  it("records every excluded development case with normalized punctuation and case", () => {
    const value = catalog();
    value.candidates.push(...["GOLF-COVE", "One.Golf Haven", "Tashua Knolls", "Gölf Côve"].map((name, index) => ({ ...candidate(`dev-${index}`), name })));
    const receipt = selectCourseDiscoveryPilot(value, { seed: "fixed", now });
    expect(receipt.excludedCandidates).toHaveLength(4);
    expect(receipt.excludedCandidates.every((row: { reasons: string[] }) => row.reasons.includes("DEVELOPMENT_CASE"))).toBe(true);
    expect(receipt.orderedDraw).toHaveLength(value.candidates.length);
  });
  it("excludes unknown, configured, foreign, unverified and stale candidates with explicit reasons", () => {
    const candidates = [
      { ...candidate("unknown"), providerFamily: "UNKNOWN" }, { ...candidate("configured"), unconfigured: false },
      { ...candidate("foreign"), countryCode: "CA" }, { ...candidate("unverified"), inventoryVerified: false },
      { ...candidate("stale"), inventoryObservedAt: "2030-01-01T10:59:59.999Z" },
    ];
    const receipt = selectCourseDiscoveryPilot({ schemaVersion: 1, candidates }, { seed: "fixed", now });
    expect(receipt.status).toBe("NO_ELIGIBLE_TRIPLE");
    expect(receipt.excludedCandidates).toHaveLength(candidates.length);
    expect(receipt.excludedCandidates.flatMap((row: { reasons: string[] }) => row.reasons)).toEqual(expect.arrayContaining([
      "UNKNOWN_PROVIDER_FAMILY", "ALREADY_CONFIGURED", "NOT_US", "INVENTORY_UNVERIFIED", "INVENTORY_EVIDENCE_STALE",
    ]));
  });
  it("fails without rerolling when family or kind constraints cannot be met", () => {
    const value = { schemaVersion: 1, candidates: [candidate("one"), candidate("two"), candidate("three", "SIMULATOR", "ACUITY")] };
    const receipt = selectCourseDiscoveryPilot(value, { seed: "unchanged", now });
    expect(receipt.status).toBe("NO_ELIGIBLE_TRIPLE");
    expect(receipt.seed).toBe("unchanged");
    expect(receipt.selected).toEqual([]);
    expect(receipt.eligibleCount).toBe(3);
  });
  it("records explicit observer exclusions and rejects credential-bearing source URLs", () => {
    const value = catalog();
    value.candidates[0] = { ...candidate("one"), excludedReason: "No requested-window match" } as typeof value.candidates[number];
    value.candidates[1].officialUrl = "https://golf.example.com/?token=do-not-emit";
    const receipt = selectCourseDiscoveryPilot(value, { seed: "fixed", now });
    expect(receipt.excludedCandidates.find((row: { id: string }) => row.id === "one")?.reasons).toContain("OBSERVER_EXCLUDED");
    expect(receipt.excludedCandidates.find((row: { id: string }) => row.id === "two")?.officialUrl).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain("do-not-emit");
  });
  it("rejects duplicate identities and bounds the supplied seed", () => {
    const value = catalog(); value.candidates.push(candidate("one"));
    const receipt = selectCourseDiscoveryPilot(value, { seed: "fixed", now });
    expect(receipt.excludedCandidates.filter((row: { reasons: string[] }) => row.reasons.includes("DUPLICATE_ID"))).toHaveLength(2);
    for (const seed of ["", "x".repeat(129), "line\nbreak"]) expect(() => selectCourseDiscoveryPilot(catalog(), { seed, now })).toThrow("INVALID_SEED");
  });
  it("generates and records a cryptographic seed when none is supplied", () => {
    expect(selectCourseDiscoveryPilot(catalog(), { now }).seed).toMatch(/^[a-f0-9]{64}$/u);
  });
});
