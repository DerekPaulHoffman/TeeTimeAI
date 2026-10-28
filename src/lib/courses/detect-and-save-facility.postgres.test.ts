// @vitest-environment node
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DetectedFacility } from "./shared-facility-detection";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
let detectAndSave: typeof import("./detect-and-save-facility").detectAndSaveFacilityCourses;
const ids: string[] = [], users: string[] = [];
const metadata = { scheduleId: 6654, bookingClassId: 14910, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017/6654#/teetimes" };
const childId = (id: string, sheet = 6463) => `public-course-${createHash("sha256").update(`${id}|${sheet}`).digest("hex").slice(0, 24)}`;
const proof = (): DetectedFacility => ({ method: "FOREUP_PUBLIC_CATALOG", sourceUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
  observedAt: new Date().toISOString(), primaryKey: "6654", courses: [
    { key: "6654", name: "Tashua Knolls Golf Course", publicAccess: "PUBLIC", url: metadata.bookingBaseUrl, foreup: metadata },
    { key: "6463", name: "Tashua Glen Golf Course", publicAccess: "PUBLIC", url: "https://foreupsoftware.com/index.php/booking/21017/6463#/teetimes",
      foreup: { scheduleId: 6463, bookingClassId: 14911, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017/6463#/teetimes" } },
  ] });

describe.skipIf(!url)("automatic facility registration in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test") throw new Error("An isolated local test database is required");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5000 }) });
    await client.$connect();
    detectAndSave = (await import("./detect-and-save-facility")).detectAndSaveFacilityCourses;
  });
  afterEach(async () => {
    await client.teeSearch.deleteMany({ where: { userId: { in: users } } });
    await client.course.deleteMany({ where: { id: { in: ids } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    ids.length = 0; users.length = 0;
  });
  afterAll(async () => { if (client) await client.$disconnect(); });
  async function fixture() {
    const id = `facility-test-${randomUUID()}`;
    ids.push(id, childId(id), childId(id, 7777));
    return client.course.create({ data: { id, name: "Tashua Knolls Golf Course", googlePlaceId: `place-${id}`, isPublic: true,
      latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", website: "https://official.example/knolls",
      providerFamilyKey: "FOREUP", detectedPlatform: "FOREUP", detectedBookingUrl: metadata.bookingBaseUrl, bookingMetadata: metadata,
      layoutHoleCounts: [18], layoutHolesVerifiedAt: new Date(), policyNotes: "Preserve root evidence" } });
  }
  it("creates independent courses automatically and preserves existing customer demand and recipients", async () => {
    const root = await fixture();
    const user = await client.user.create({ data: { clerkUserId: `fixture-${randomUUID()}`, email: `fixture-${randomUUID()}@example.invalid` } }); users.push(user.id);
    const alert = await client.teeSearch.create({ data: { userId: user.id, date: new Date("2030-10-29"), startTime: "08:00", endTime: "12:00", players: 3,
      additionalEmails: ["friend@example.invalid"], preferences: { create: { courseId: root.id, rank: 1 } } } });
    const result = await detectAndSave(root.id, proof());
    expect(result?.map(row => row.courseId)).toEqual([root.id, childId(root.id)]);
    const savedRoot = await client.course.findUniqueOrThrow({ where: { id: root.id } });
    const child = await client.course.findUniqueOrThrow({ where: { id: childId(root.id) } });
    expect(savedRoot.googlePlaceId).toBe(root.googlePlaceId); expect(savedRoot.policyNotes).toBe(root.policyNotes);
    expect(child).toMatchObject({ googlePlaceId: null, layoutHoleCounts: [], intelligenceVerifiedAt: null, activeAccessRecipeId: null, isPublic: true });
    const savedAlert = await client.teeSearch.findUniqueOrThrow({ where: { id: alert.id }, include: { preferences: true } });
    expect(savedAlert.additionalEmails).toEqual(["friend@example.invalid"]);
    expect(savedAlert.preferences.map(row => row.courseId)).toEqual([root.id]);
    await detectAndSave(root.id, proof());
    expect(await client.course.count({ where: { id: { in: ids } } })).toBe(2);
  });
  it("concurrent detections create only one canonical child and do not promote a child into a new root", async () => {
    const root = await fixture();
    await Promise.all([detectAndSave(root.id, proof()), detectAndSave(root.id, proof())]);
    expect(await client.course.count({ where: { id: { in: ids } } })).toBe(2);
    const childProof = proof(); childProof.primaryKey = "6463";
    expect((await detectAndSave(childId(root.id), childProof))?.map(row => row.courseId)).toEqual([root.id, childId(root.id)]);
  });
  it("reuses an existing canonical sibling and preserves its physical layout evidence", async () => {
    const root = await fixture(), id = `existing-glen-${randomUUID()}`; ids.push(id);
    await client.course.create({ data: { id, name: "Tashua Glen Golf Course", isPublic: true, googlePlaceId: `glen-${id}`,
      latitude: root.latitude, longitude: root.longitude, providerFamilyKey: "FOREUP", bookingMetadata: proof().courses[1].foreup,
      layoutHoleCounts: [9], layoutHolesVerifiedAt: new Date() } });
    expect((await detectAndSave(root.id, proof()))?.map(row => row.courseId)).toEqual([root.id, id]);
    expect((await client.course.findUniqueOrThrow({ where: { id } })).layoutHoleCounts).toEqual([9]);
    expect(await client.course.count({ where: { id: { in: ids } } })).toBe(2);
  });
  it("rolls back earlier sibling creation when another sibling conflicts with protected identity", async () => {
    const root = await fixture();
    await client.course.create({ data: { id: childId(root.id, 7777), name: "Private Course", latitude: root.latitude, longitude: root.longitude, isPublic: false } });
    const detection = proof(); detection.courses.push({ key: "7777", name: "Another Golf Course", publicAccess: "PUBLIC",
      url: "https://foreupsoftware.com/index.php/booking/21017/7777#/teetimes", foreup: { scheduleId: 7777, bookingClassId: 19999, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017/7777#/teetimes" } });
    expect(await detectAndSave(root.id, detection)).toBeUndefined();
    expect(await client.course.findUnique({ where: { id: childId(root.id) } })).toBeNull();
    expect((await client.course.findUniqueOrThrow({ where: { id: root.id } })).bookingMetadata).toEqual(metadata);
  });
  it("removes automatic membership after an authoritative single-course catalog without deleting courses or demand", async () => {
    const root = await fixture(); await detectAndSave(root.id, proof());
    const single = proof(); single.courses = single.courses.slice(0, 1);
    expect(await detectAndSave(root.id, single)).toEqual([]);
    const courses = await client.course.findMany({ where: { id: { in: ids } } });
    expect(courses).toHaveLength(2);
    for (const course of courses) expect(course.bookingMetadata).not.toHaveProperty("sharedFacility");
  });
  it("rejects stale, wrong-facility and changed-root observations before applying membership", async () => {
    const root = await fixture();
    const stale = proof(); stale.observedAt = new Date(Date.now() - 600_000).toISOString();
    expect(await detectAndSave(root.id, stale)).toBeUndefined();
    const foreign = proof(); foreign.sourceUrl = foreign.sourceUrl.replace("21017", "88888");
    expect(await detectAndSave(root.id, foreign)).toBeUndefined();
    await client.course.update({ where: { id: root.id }, data: { isPublic: false } });
    expect(await detectAndSave(root.id, proof())).toBeUndefined();
    expect(await client.course.count({ where: { id: { in: ids } } })).toBe(1);
  });
  it("registers provider-independent official courses as pending, without copying access or monitoring", async () => {
    const root = await fixture(), key = "https://official.example/glen";
    const id = `public-course-${createHash("sha256").update(`${root.id}|OFFICIAL|${key}`).digest("hex").slice(0, 24)}`; ids.push(id);
    const detection: DetectedFacility = { method: "OFFICIAL_CONTAINS_PLACE", sourceUrl: "https://official.example/courses", observedAt: new Date().toISOString(), primaryKey: root.website!,
      courses: [{ key: root.website!, name: root.name, url: root.website!, latitude: root.latitude, longitude: root.longitude, publicAccess: "PENDING" },
        { key, name: "Tashua Glen Golf Course", url: key, latitude: 41.241, longitude: -73.2, publicAccess: "PENDING" }] };
    const members = await detectAndSave(root.id, detection);
    expect(members?.[1]).toMatchObject({ publicAccessStatus: "UNVERIFIED", courseId: id });
    expect(await client.course.findUniqueOrThrow({ where: { id } })).toMatchObject({ isPublic: null, automationEligibility: "UNKNOWN", bookingAccessMode: "UNKNOWN", layoutHoleCounts: [] });
  });
});
