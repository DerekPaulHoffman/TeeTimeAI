import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { activeDiscoveryPilotSearchIds, automaticDiscoveryPilot, isCourseDiscoveryEnabled, isDiscoveryPilotSearch, isGeneralDiscoveryEnabled } from "./config";

const general = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_ROLLOUT_MODE: "GENERAL" };
const pilot = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_SEARCH_IDS: "a,b,c" };
function reader() {
  const findFirst = vi.fn(async () => ({ id: "normal-demand" }));
  const findMany = vi.fn(async () => [{ id: "a" }, { id: "b" }]);
  const enrollments = { findUnique: vi.fn(), findMany: vi.fn() };
  return { findFirst, findMany, enrollments, client: { teeSearch: { findFirst, findMany }, courseDiscoveryPilotEnrollment: enrollments } as unknown as Prisma.TransactionClient };
}

describe("explicit normal responder rollout", () => {
  it("retains pilot admission until the explicit general switch", async () => {
    expect(isCourseDiscoveryEnabled({ COURSE_DISCOVERY_ENABLED: "true" })).toBe(false);
    expect(isGeneralDiscoveryEnabled(pilot)).toBe(false);
    expect(isCourseDiscoveryEnabled(pilot)).toBe(true);
    expect(await isDiscoveryPilotSearch("d", pilot)).toBe(false);
  });
  it("requires the main switch and exact general mode, including when stale pilot IDs exist", async () => {
    for (const mode of ["general", "", "*", "UNREVIEWED"]) {
      const env = { ...pilot, COURSE_DISCOVERY_ROLLOUT_MODE: mode };
      expect(isCourseDiscoveryEnabled(env)).toBe(false);
      expect(await isDiscoveryPilotSearch("a", env)).toBe(false);
      expect(await activeDiscoveryPilotSearchIds(env)).toEqual([]);
    }
    expect(isCourseDiscoveryEnabled({ ...general, COURSE_DISCOVERY_ENABLED: "false" })).toBe(false);
    expect(isCourseDiscoveryEnabled(general)).toBe(true);
  });
  it("checks real persisted demand instead of treating arbitrary IDs as enrolled", async () => {
    const r = reader();
    expect(await isDiscoveryPilotSearch("normal-demand", general, r.client)).toBe(true);
    expect(r.findFirst).toHaveBeenCalledWith({ where: { id: "normal-demand", trafficClass: { notIn: ["TEST", "AUTOMATION"] },
      syntheticMultiCycle: false, mode: { in: ["OUTDOOR", "SIMULATOR"] } }, select: { id: true } });
    r.findFirst.mockResolvedValueOnce(null as never);
    expect(await isDiscoveryPilotSearch("missing-demand", general, r.client)).toBe(false);
    expect(await isDiscoveryPilotSearch("*", general, r.client)).toBe(false);
    expect(r.enrollments.findUnique).not.toHaveBeenCalled();
  });
  it("selects active real searches for legacy exclusion without consuming pilot quota", async () => {
    const r = reader();
    expect(await activeDiscoveryPilotSearchIds(general, r.client)).toEqual(["a", "b"]);
    expect(r.findMany).toHaveBeenCalledWith({ where: { status: "ACTIVE", trafficClass: { notIn: ["TEST", "AUTOMATION"] },
      syntheticMultiCycle: false, mode: { in: ["OUTDOOR", "SIMULATOR"] } }, select: { id: true } });
    expect(r.enrollments.findMany).not.toHaveBeenCalled();
    expect(automaticDiscoveryPilot({ ...general, COURSE_DISCOVERY_PILOT_OWNER_USER_ID: "owner",
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:a,course:b,course:c" })).toBeNull();
  });
  it("rollback disables both new admission and saved-method selection", async () => {
    const r = reader();
    const off = { ...general, COURSE_DISCOVERY_ENABLED: "false" };
    expect(await isDiscoveryPilotSearch("normal-demand", off, r.client)).toBe(false);
    expect(await activeDiscoveryPilotSearchIds(off, r.client)).toEqual([]);
    expect(r.findFirst).not.toHaveBeenCalled();
    expect(r.findMany).not.toHaveBeenCalled();
  });
});
