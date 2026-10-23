import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { automaticDiscoveryPilot } from "./config";
import { enrollDiscoveryPilotInTransaction } from "./enrollment";

const env = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_OWNER_USER_ID: "owner-1",
  COURSE_DISCOVERY_PILOT_TARGET_KEYS: "course:a,course:b,offering:c" };
const search = (id: string, courseId = "a") => ({ id, userId: "owner-1", mode: "OUTDOOR", trafficClass: "PUBLIC", syntheticMultiCycle: false, preferences: [{ courseId }] });
type Receipt = { searchId: string; cohortId: string; ownerUserId: string; targetKey: string; slot: number };
function database() {
  const rows: Receipt[] = [];
  const events: string[] = [];
  let tail = Promise.resolve();
  const transaction = () => {
    let release: (() => void) | undefined;
    const tx = { $queryRaw: vi.fn(async () => {
      const before = tail;
      tail = new Promise<void>(done => { release = done; });
      await before; events.push("lock"); return [{ id: "owner-1" }];
    }), courseDiscoveryPilotEnrollment: {
      findUnique: vi.fn(async ({ where }: { where: { searchId?: string; cohortId_targetKey?: { cohortId: string; targetKey: string } } }) => {
        events.push("read"); return rows.find(row => where.searchId ? row.searchId === where.searchId :
          row.cohortId === where.cohortId_targetKey!.cohortId && row.targetKey === where.cohortId_targetKey!.targetKey) ?? null;
      }), count: vi.fn(async ({ where }: { where: { cohortId: string } }) => rows.filter(row => row.cohortId === where.cohortId).length),
      create: vi.fn(async ({ data }: { data: Receipt }) => { events.push("create"); rows.push(data); return data; }),
    } };
    return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, release: () => release?.() };
  };
  return { rows, events, transaction };
}
describe("atomic ordinary-alert pilot enrollment", () => {
  it("does not touch storage for a non-owner, synthetic search, unconfigured target or multi-target alert", async () => {
    const db = database(); const tx = db.transaction();
    const cases = [{ ...search("a"), userId: "another-owner" }, { ...search("a"), trafficClass: "TEST" },
      { ...search("a"), syntheticMultiCycle: true }, search("a", "unconfigured"),
      { ...search("a"), preferences: [{ courseId: "a" }, { courseId: "b" }] }];
    for (const input of cases) expect(await enrollDiscoveryPilotInTransaction(tx.tx, input, env)).toBe(false);
    expect(tx.raw.$queryRaw).not.toHaveBeenCalled();
  });
  it("locks the owner before allocating one durable slot and retains idempotence", async () => {
    const db = database();
    const one = db.transaction();
    expect(await enrollDiscoveryPilotInTransaction(one.tx, search("first"), env)).toBe(true); one.release();
    expect(db.events[0]).toBe("lock");
    const again = db.transaction();
    expect(await enrollDiscoveryPilotInTransaction(again.tx, search("first"), env)).toBe(true); again.release();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ searchId: "first", targetKey: "course:a", slot: 1, cohortId: automaticDiscoveryPilot(env)!.cohortId });
  });
  it("serializes concurrent creations and admits only one alert for each of three targets", async () => {
    const db = database();
    const candidates = [search("first", "a"), search("second", "b"),
      { ...search("third", "venue"), mode: "SIMULATOR", preferences: [{ courseId: "venue", offeringId: "c" }] }, search("fourth", "a")];
    const results = await Promise.all(candidates.map(async candidate => {
      const tx = db.transaction();
      try { return await enrollDiscoveryPilotInTransaction(tx.tx, candidate, env); } finally { tx.release(); }
    }));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(db.rows.map(row => row.slot)).toEqual([1, 2, 3]);
    expect(new Set(db.rows.map(row => row.targetKey)).size).toBe(3);
  });
  it("does not refund quota when its saved search has been deleted", async () => {
    const db = database(); const first = db.transaction();
    await enrollDiscoveryPilotInTransaction(first.tx, search("deleted-search"), env); first.release();
    // Search deletion does not alter this independent append-only receipt.
    const replacement = db.transaction();
    expect(await enrollDiscoveryPilotInTransaction(replacement.tx, search("replacement"), env)).toBe(false); replacement.release();
    expect(db.rows).toHaveLength(1);
  });
  it("retains old enrollment receipts and independently bounds an explicitly named new experiment", async () => {
    const db = database();
    const candidates = [search("old-a", "a"), search("old-b", "b"),
      { ...search("old-c", "venue"), mode: "SIMULATOR", preferences: [{ courseId: "venue", offeringId: "c" }] }];
    const enroll = async (candidate: typeof candidates[number], settings: typeof env & { COURSE_DISCOVERY_PILOT_RUN_ID?: string }) => {
      const tx = db.transaction();
      try { return await enrollDiscoveryPilotInTransaction(tx.tx, candidate, settings); } finally { tx.release(); }
    };
    for (const candidate of candidates) expect(await enroll(candidate, env)).toBe(true);
    const oldReceipts = structuredClone(db.rows);
    expect(await enroll(search("deleted-replacement"), env)).toBe(false);
    const next = { ...env, COURSE_DISCOVERY_PILOT_RUN_ID: "sol-replay-20261023-1" };
    expect(await enroll(candidates[0], next)).toBe(false);
    for (const candidate of candidates) expect(await enroll({ ...candidate, id: candidate.id.replace("old-", "new-") }, next)).toBe(true);
    expect(await enroll(search("fourth"), next)).toBe(false);
    expect(db.rows.slice(0, 3)).toEqual(oldReceipts);
    expect(db.rows.slice(3).map(row => row.slot)).toEqual([1, 2, 3]);
    expect(new Set(db.rows.map(row => row.cohortId)).size).toBe(2);
  });
  it("retains the legacy explicit-ID rollout rather than opening another auto cohort", async () => {
    const db = database(); const tx = db.transaction();
    expect(await enrollDiscoveryPilotInTransaction(tx.tx, search("first"), { ...env, COURSE_DISCOVERY_PILOT_SEARCH_IDS: "legacy" })).toBe(false);
    expect(tx.raw.$queryRaw).not.toHaveBeenCalled();
  });
  it("enrolls a newly persisted ordinary preference using its preconfigured place identity", async () => {
    const db = database(); const tx = db.transaction();
    const placeEnv = { ...env, COURSE_DISCOVERY_PILOT_TARGET_KEYS: "place:ChIJ_new:OUTDOOR,place:ChIJ_two:SIMULATOR,place:ChIJ_three:OUTDOOR" };
    const created = { ...search("new-search", "newly-generated-course-id"),
      preferences: [{ courseId: "newly-generated-course-id", course: { googlePlaceId: "ChIJ_new" } }] };
    expect(await enrollDiscoveryPilotInTransaction(tx.tx, created, placeEnv)).toBe(true); tx.release();
    expect(db.rows[0]).toMatchObject({ searchId: "new-search", targetKey: "place:ChIJ_new:OUTDOOR", slot: 1 });
  });
  it("rejects one preference matching both a configured place and internal identity", async () => {
    const db = database(); const tx = db.transaction();
    const created = { ...search("new-search", "a"), preferences: [{ courseId: "a", course: { googlePlaceId: "ChIJ_new" } }] };
    expect(await enrollDiscoveryPilotInTransaction(tx.tx, created, { ...env,
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: "place:ChIJ_new:OUTDOOR,course:a,course:third" })).toBe(false);
    expect(tx.raw.$queryRaw).not.toHaveBeenCalled();
  });
});
