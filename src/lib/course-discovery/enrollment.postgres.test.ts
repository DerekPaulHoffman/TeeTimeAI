// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activeDiscoveryPilotSearchIds, isDiscoveryPilotSearch } from "./config";
import { enrollDiscoveryPilotInTransaction } from "./enrollment";

const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
let client: PrismaClient;
const owners: string[] = [];
const courses: string[] = [];

describe.skipIf(!url)("durable three-alert automatic enrollment", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test")
      throw new Error("An isolated local test database is required");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5000 }) });
    await client.$connect();
  });
  afterEach(async () => {
    if (!client) return;
    await client.courseDiscoveryPilotEnrollment.deleteMany({ where: { ownerUserId: { in: owners } } });
    await client.course.deleteMany({ where: { id: { in: courses } } });
    await client.user.deleteMany({ where: { id: { in: owners } } });
    owners.length = 0; courses.length = 0;
  });
  afterAll(async () => { if (client) await client.$disconnect(); });

  async function fixture() {
    const identity = randomUUID();
    const user = await client.user.create({ data: { clerkUserId: `enrollment-${identity}`, email: `${identity}@example.test` } });
    owners.push(user.id);
    const targets = await Promise.all([0, 1, 2, 3].map(async ordinal => {
      const course = await client.course.create({ data: { name: `Enrollment fixture ${ordinal}`, latitude: 41, longitude: -73,
        isPublic: ordinal !== 2, timeZone: "UTC", website: "https://golf.example.com/" } });
      courses.push(course.id);
      const offering = ordinal === 2 ? await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR",
        active: true, publicAccessStatus: "UNVERIFIED", bookingUrl: "https://golf.example.com/times" } }) : undefined;
      return { course, offering };
    }));
    const env = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_OWNER_USER_ID: user.id,
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: targets.slice(0, 3).map(target => target.offering ? `offering:${target.offering.id}` : `course:${target.course.id}`).join(",") };
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
    const create = (ordinal: number, abort = false) => client.$transaction(async tx => {
      const target = targets[ordinal];
      // This is the same ordinary-search creation transaction boundary used
      // by searches/service.ts, without any provider or email operation.
      const search = await tx.teeSearch.create({ data: { userId: user.id, date, trafficClass: "PUBLIC",
        mode: target.offering ? "SIMULATOR" : "OUTDOOR", durationMinutes: target.offering ? 60 : null,
        startTime: "09:00", endTime: "17:00", userTimeZone: "UTC", players: 4,
        preferences: { create: { courseId: target.course.id, offeringId: target.offering?.id, rank: 1 } } }, include: { preferences: true } });
      const enrolled = await enrollDiscoveryPilotInTransaction(tx, search, env);
      if (abort) throw new Error("fixture rollback");
      return { search, enrolled };
    }, { timeout: 10_000 });
    return { user, targets, env, create };
  }

  it("serializes concurrent creations and retains quota after deletion or target edits", async () => {
    const f = await fixture();
    const created = await Promise.all([f.create(0), f.create(1), f.create(2), f.create(0)]);
    expect(created.filter(item => item.enrolled)).toHaveLength(3);
    const receipts = await client.courseDiscoveryPilotEnrollment.findMany({ where: { ownerUserId: f.user.id }, orderBy: { slot: "asc" } });
    expect(receipts.map(row => row.slot)).toEqual([1, 2, 3]);
    expect(new Set(receipts.map(row => row.targetKey)).size).toBe(3);
    const removed = created.find(item => item.enrolled && item.search.mode === "OUTDOOR")!;
    const replacementOrdinal = removed.search.preferences[0].courseId === f.targets[0].course.id ? 0 : 1;
    await client.teeSearch.delete({ where: { id: removed.search.id } });
    expect(await isDiscoveryPilotSearch(removed.search.id, f.env, client)).toBe(false);
    expect((await f.create(replacementOrdinal)).enrolled).toBe(false);
    expect(await client.courseDiscoveryPilotEnrollment.count({ where: { ownerUserId: f.user.id } })).toBe(3);
    const edited = created.find(item => item.enrolled && item.search.id !== removed.search.id && item.search.mode === "OUTDOOR")!;
    await client.coursePreference.update({ where: { id: edited.search.preferences[0].id }, data: { courseId: f.targets[3].course.id } });
    expect(await isDiscoveryPilotSearch(edited.search.id, f.env, client)).toBe(false);
    const active = await activeDiscoveryPilotSearchIds(f.env, client);
    expect(active).toEqual([created.find(item => item.enrolled && item.search.mode === "SIMULATOR")!.search.id]);
  });

  it("rolls back enrollment with failed search creation without consuming a slot", async () => {
    const f = await fixture();
    await expect(f.create(0, true)).rejects.toThrow("fixture rollback");
    expect(await client.courseDiscoveryPilotEnrollment.count({ where: { ownerUserId: f.user.id } })).toBe(0);
    expect(await client.teeSearch.count({ where: { userId: f.user.id } })).toBe(0);
    expect((await f.create(0)).enrolled).toBe(true);
    expect((await client.courseDiscoveryPilotEnrollment.findFirstOrThrow({ where: { ownerUserId: f.user.id } })).slot).toBe(1);
  });

  it("enrolls by a configured place before course creation and revokes after a place retarget", async () => {
    const identity = randomUUID();
    const user = await client.user.create({ data: { clerkUserId: `place-enrollment-${identity}`, email: `${identity}@example.test` } });
    owners.push(user.id);
    const placeId = `ChIJ_${identity.replace(/-/gu, "_")}`;
    const env = { COURSE_DISCOVERY_ENABLED: "true", COURSE_DISCOVERY_PILOT_OWNER_USER_ID: user.id,
      COURSE_DISCOVERY_PILOT_TARGET_KEYS: `place:${placeId}:OUTDOOR,place:ChIJ_other_${identity}:SIMULATOR,place:ChIJ_third_${identity}:OUTDOOR` };
    expect(await client.course.findUnique({ where: { googlePlaceId: placeId } })).toBeNull();
    const saved = await client.$transaction(async tx => {
      const course = await tx.course.create({ data: { googlePlaceId: placeId, name: "New place enrollment fixture", latitude: 41,
        longitude: -73, isPublic: true, timeZone: "UTC", website: "https://golf.example.com/" } });
      courses.push(course.id);
      const date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
      const search = await tx.teeSearch.create({ data: { userId: user.id, date, trafficClass: "PUBLIC", mode: "OUTDOOR",
        startTime: "09:00", endTime: "17:00", userTimeZone: "UTC", players: 4,
        preferences: { create: { courseId: course.id, rank: 1 } } }, include: { preferences: { include: { course: true } } } });
      expect(await enrollDiscoveryPilotInTransaction(tx, search, env)).toBe(true);
      return search;
    });
    const receipt = await client.courseDiscoveryPilotEnrollment.findUniqueOrThrow({ where: { searchId: saved.id } });
    expect(receipt.targetKey).toBe(`place:${placeId}:OUTDOOR`);
    expect(await isDiscoveryPilotSearch(saved.id, env, client)).toBe(true);
    await client.course.update({ where: { id: saved.preferences[0].courseId }, data: { googlePlaceId: `changed_${identity}` } });
    expect(await isDiscoveryPilotSearch(saved.id, env, client)).toBe(false);
    expect(await activeDiscoveryPilotSearchIds(env, client)).toEqual([]);
    expect(await client.courseDiscoveryPilotEnrollment.count({ where: { ownerUserId: user.id } })).toBe(1);
  });
});
