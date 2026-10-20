// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotDiscoveryPilotTarget, excludeDiscoveryPilotTargets, hasLegacyDiscoveryOwner } from "./legacy-exclusion";

const now = new Date("2030-01-01T12:00:00.000Z");
const preferences = vi.fn();
const reader = { coursePreference: { findMany: preferences } } as unknown as Prisma.TransactionClient;
function row(courseId: string, offeringId: string | null = null, date = "2030-01-02") {
  return { courseId, offeringId, course: { timeZone: "UTC" }, teeSearch: { status: "ACTIVE", mode: offeringId ? "SIMULATOR" : "OUTDOOR", date: new Date(`${date}T00:00:00Z`),
    endTime: "17:00", userTimeZone: "UTC", createdAt: now, trafficClass: "PUBLIC", syntheticMultiCycle: false, syntheticTestWindow: null, alertGeneration: 0 } };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("COURSE_DISCOVERY_ENABLED", "true");
  vi.stubEnv("COURSE_DISCOVERY_PILOT_SEARCH_IDS", "search-one");
});
afterEach(() => vi.unstubAllEnvs());

describe("pilot ownership boundary", () => {
  it("does not change legacy selection or issue extra reads while disabled", async () => {
    vi.stubEnv("COURSE_DISCOVERY_ENABLED", "false");
    const candidates = [{ courseId: "ordinary" }];
    expect(await excludeDiscoveryPilotTargets(candidates, reader, now)).toBe(candidates);
    await assertNotDiscoveryPilotTarget(reader, candidates[0], now);
    expect(preferences).not.toHaveBeenCalled();
  });
  it("excludes only currently active enrolled target kinds", async () => {
    preferences.mockResolvedValue([row("pilot"), row("venue", "rental"), row("expired", null, "2029-12-31")]);
    const candidates = [{ courseId: "ordinary" }, { courseId: "pilot" }, { courseId: "venue" }, { courseId: "venue", offeringId: "rental" }, { courseId: "expired" }];
    expect(await excludeDiscoveryPilotTargets(candidates, reader, now)).toEqual([candidates[0], candidates[2], candidates[4]]);
    expect(preferences.mock.calls[0][0].where.teeSearchId).toEqual({ in: ["search-one"] });
  });
  it("rejects a new legacy claim after enrollment but does not mutate existing work", async () => {
    preferences.mockResolvedValue([row("venue", "rental")]);
    await expect(assertNotDiscoveryPilotTarget(reader, { courseId: "venue", offeringId: "rental" }, now)).rejects.toThrow("assigned to the course discovery pilot");
    await expect(assertNotDiscoveryPilotTarget(reader, { courseId: "ordinary" }, now)).resolves.toBeUndefined();
  });
  it("preserves an existing legacy batch owner before admitting discovery", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "batch" }), findMany = vi.fn();
    const ownerReader = { courseSupportBatch: { findFirst }, automationRun: { findMany } } as unknown as Prisma.TransactionClient;
    expect(await hasLegacyDiscoveryOwner(ownerReader, { courseId: "venue" })).toBe(true);
    expect(findMany).not.toHaveBeenCalled();
  });
  it("preserves a bound simulator reservation even before its worker claims", async () => {
    const findFirst = vi.fn().mockResolvedValue(null), findMany = vi.fn().mockResolvedValue([{ audit: { state: "BOUND", target: { courseId: "venue", offeringId: "rental" } } }]);
    const ownerReader = { courseSupportBatch: { findFirst }, automationRun: { findMany } } as unknown as Prisma.TransactionClient;
    expect(await hasLegacyDiscoveryOwner(ownerReader, { courseId: "venue", offeringId: "rental" })).toBe(true);
  });
});
