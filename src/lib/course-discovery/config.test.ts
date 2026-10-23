import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { activeDiscoveryPilotSearchIds, automaticDiscoveryPilot, discoveryPilotSearchIds, isCourseDiscoveryEnabled, isDiscoveryPilotSearch, matchingDiscoveryPilotTargetKey } from "./config";

describe("explicit three-alert rollout", () => {
  it("requires enabled mode and an exact pilot search id", async () => {
    expect(await isDiscoveryPilotSearch("a", {})).toBe(false);
    expect(await isDiscoveryPilotSearch("a", { COURSE_DISCOVERY_ENABLED: "true" })).toBe(false);
    const env = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_SEARCH_IDS: "a,b,c" };
    expect(await isDiscoveryPilotSearch("a", env)).toBe(true);
    expect(await isDiscoveryPilotSearch("ab", env)).toBe(false);
  });
  it("fails closed for oversized or malformed pilot configuration", () => {
    expect(discoveryPilotSearchIds({ COURSE_DISCOVERY_PILOT_SEARCH_IDS: "a,b,c,d" })).toEqual([]);
    expect(discoveryPilotSearchIds({ COURSE_DISCOVERY_PILOT_SEARCH_IDS: "*" })).toEqual([]);
    expect(discoveryPilotSearchIds({ COURSE_DISCOVERY_PILOT_SEARCH_IDS: " a,a " })).toEqual(["a"]);
  });
});

const autoEnv = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_OWNER_USER_ID: "owner-1",
  COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:a,offering:b,course:c" };
describe("automatic pilot configuration and enrollment reads", () => {
  it("requires exactly three distinct typed targets and one exact owner", () => {
    expect(automaticDiscoveryPilot(autoEnv)).toMatchObject({ ownerUserId: "owner-1", targetKeys: ["course:a", "course:c", "offering:b"] });
    expect(isCourseDiscoveryEnabled(autoEnv)).toBe(true);
    for (const change of [{ COURSE_DISCOVERY_ENABLED: "false" }, { COURSE_DISCOVERY_PILOT_OWNER_USER_ID: "*" },
      { COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:a,course:b" }, { COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:a,course:a,course:c" },
      { COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:*,course:b,course:c" }]) expect(automaticDiscoveryPilot({ ...autoEnv, ...change })).toBeNull();
  });
  it("retains one stable cohort for reordered targets and disables auto mode for legacy IDs", () => {
    expect(automaticDiscoveryPilot(autoEnv)?.cohortId).toBe(automaticDiscoveryPilot({ ...autoEnv,
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:c,course:a,offering:b" })?.cohortId);
    expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_SEARCH_IDS: "legacy" })).toBeNull();
  });
  it("preserves legacy cohort hashes and requires an explicit valid name for a new experiment", () => {
    const legacy = automaticDiscoveryPilot(autoEnv)!;
    expect(legacy.cohortId).toBe(createHash("sha256").update(JSON.stringify({ ownerUserId: "owner-1", targetKeys: ["course:a", "course:c", "offering:b"] })).digest("hex"));
    expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_RUN_ID: "  " })).toEqual(legacy);
    const named = automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_RUN_ID: "sol-replay-20261023-1" })!;
    expect(named.runId).toBe("sol-replay-20261023-1");
    expect(named.cohortId).not.toBe(legacy.cohortId);
    expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_RUN_ID: named.runId,
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:c,course:a,offering:b" })).toEqual(named);
    for (const invalid of ["*", "two runs", "UPPERCASE", "a".repeat(65), "../run"])
      expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_RUN_ID: invalid })).toBeNull();
  });
  it("accepts place identities before internal rows exist, bound to the exact search mode", () => {
    const keys = ["place:ChIJ_new_one:OUTDOOR", "place:ChIJ_new_two:SIMULATOR", "place:ChIJ_new_three:OUTDOOR"];
    expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_TARGET_KEYS: keys.join(",") })?.targetKeys).toEqual([...keys].sort());
    const selected = { mode: "OUTDOOR", preferences: [{ courseId: "server-created-later", course: { googlePlaceId: "ChIJ_new_one" } }] };
    expect(matchingDiscoveryPilotTargetKey(selected, keys)).toBe(keys[0]);
    expect(matchingDiscoveryPilotTargetKey({ ...selected, mode: "SIMULATOR", preferences: [{ ...selected.preferences[0], offeringId: "new-offering" }] }, keys)).toBeNull();
    expect(matchingDiscoveryPilotTargetKey(selected, [...keys.slice(0, 2), "course:server-created-later"])).toBeNull();
    expect(automaticDiscoveryPilot({ ...autoEnv, COURSE_DISCOVERY_PILOT_TARGET_KEYS: "place:ChIJ_one:ANY,course:b,course:c" })).toBeNull();
  });
  it("rechecks persisted place identity and rejects retargets or ambiguous configured aliases", async () => {
    const env = { ...autoEnv, COURSE_DISCOVERY_PILOT_TARGET_KEYS: "place:ChIJ_one:OUTDOOR,place:ChIJ_two:SIMULATOR,place:ChIJ_three:OUTDOOR" };
    const config = automaticDiscoveryPilot(env)!;
    const findUnique = vi.fn().mockResolvedValue({ cohortId: config.cohortId, ownerUserId: config.ownerUserId, targetKey: "place:ChIJ_one:OUTDOOR" });
    const selected = { id: "saved-search", mode: "OUTDOOR", preferences: [{ courseId: "generated-after-config", offeringId: null, course: { googlePlaceId: "ChIJ_one" } }] };
    const findFirst = vi.fn().mockResolvedValue(selected);
    const findMany = vi.fn().mockResolvedValue([{ searchId: "saved-search", targetKey: "place:ChIJ_one:OUTDOOR" }]);
    const searches = vi.fn().mockResolvedValue([selected]);
    const reader = { courseDiscoveryPilotEnrollment: { findUnique, findMany }, teeSearch: { findFirst, findMany: searches } } as unknown as Prisma.TransactionClient;
    expect(await isDiscoveryPilotSearch("saved-search", env, reader)).toBe(true);
    expect(await activeDiscoveryPilotSearchIds(env, reader)).toEqual(["saved-search"]);
    const changed = { ...selected, preferences: [{ ...selected.preferences[0], course: { googlePlaceId: "ChIJ_other" } }] };
    findFirst.mockResolvedValue(changed); searches.mockResolvedValue([changed]);
    expect(await isDiscoveryPilotSearch("saved-search", env, reader)).toBe(false);
    expect(await activeDiscoveryPilotSearchIds(env, reader)).toEqual([]);
    const ambiguousEnv = { ...env, COURSE_DISCOVERY_PILOT_TARGET_KEYS: "place:ChIJ_one:OUTDOOR,course:generated-after-config,course:third" };
    const ambiguousConfig = automaticDiscoveryPilot(ambiguousEnv)!;
    findUnique.mockResolvedValue({ cohortId: ambiguousConfig.cohortId, ownerUserId: config.ownerUserId, targetKey: "place:ChIJ_one:OUTDOOR" });
    findFirst.mockResolvedValue(selected);
    expect(await isDiscoveryPilotSearch("saved-search", ambiguousEnv, reader)).toBe(false);
  });
  it("recognizes only the current cohort and a still-existing owner-scoped ordinary search", async () => {
    const config = automaticDiscoveryPilot(autoEnv)!;
    const findUnique = vi.fn().mockResolvedValue({ cohortId: config.cohortId, ownerUserId: config.ownerUserId, targetKey: "course:a" });
    const findFirst = vi.fn().mockResolvedValue({ id: "saved-search", mode: "OUTDOOR", preferences: [{ courseId: "a", offeringId: null }] });
    const reader = { courseDiscoveryPilotEnrollment: { findUnique }, teeSearch: { findFirst } } as unknown as Prisma.TransactionClient;
    expect(await isDiscoveryPilotSearch("saved-search", autoEnv, reader)).toBe(true);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ id: "saved-search", userId: "owner-1", trafficClass: { notIn: ["TEST", "AUTOMATION"] } });
    findFirst.mockResolvedValue(null);
    expect(await isDiscoveryPilotSearch("deleted-search", autoEnv, reader)).toBe(false);
    findUnique.mockResolvedValue({ cohortId: "old-cohort", ownerUserId: config.ownerUserId, targetKey: "course:a" });
    findFirst.mockClear();
    expect(await isDiscoveryPilotSearch("saved-search", autoEnv, reader)).toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });
  it("stops enrollment after a preference edit without refunding the receipt", async () => {
    const config = automaticDiscoveryPilot(autoEnv)!;
    const findUnique = vi.fn().mockResolvedValue({ cohortId: config.cohortId, ownerUserId: config.ownerUserId, targetKey: "course:a" });
    const findFirst = vi.fn().mockResolvedValue({ id: "saved-search", mode: "OUTDOOR", preferences: [{ courseId: "fourth", offeringId: null }] });
    const reader = { courseDiscoveryPilotEnrollment: { findUnique }, teeSearch: { findFirst } } as unknown as Prisma.TransactionClient;
    expect(await isDiscoveryPilotSearch("saved-search", autoEnv, reader)).toBe(false);
    findFirst.mockResolvedValue({ id: "saved-search", mode: "OUTDOOR", preferences: [{ courseId: "a", offeringId: null }, { courseId: "fourth", offeringId: null }] });
    expect(await isDiscoveryPilotSearch("saved-search", autoEnv, reader)).toBe(false);
  });
  it("lists only existing searches for legacy exclusion and does not fall back on database errors", async () => {
    const findMany = vi.fn().mockResolvedValue([{ searchId: "exists", targetKey: "course:a" }, { searchId: "deleted", targetKey: "course:c" }, { searchId: "changed", targetKey: "offering:b" }]);
    const searches = vi.fn().mockResolvedValue([{ id: "exists", mode: "OUTDOOR", preferences: [{ courseId: "a", offeringId: null }] },
      { id: "changed", mode: "SIMULATOR", preferences: [{ courseId: "any-venue", offeringId: "fourth" }] }]);
    const reader = { courseDiscoveryPilotEnrollment: { findMany }, teeSearch: { findMany: searches } } as unknown as Prisma.TransactionClient;
    expect(await activeDiscoveryPilotSearchIds(autoEnv, reader)).toEqual(["exists"]);
    findMany.mockRejectedValue(new Error("database unavailable"));
    await expect(activeDiscoveryPilotSearchIds(autoEnv, reader)).rejects.toThrow("database unavailable");
  });
});
