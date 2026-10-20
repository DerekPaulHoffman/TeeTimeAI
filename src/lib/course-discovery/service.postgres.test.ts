// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
const pilotSearchIds = new Set<string>();
vi.mock("./config", () => ({ isDiscoveryPilotSearch: (id: string) => pilotSearchIds.has(id), activeDiscoveryPilotSearchIds: async () => [...pilotSearchIds] }));
let service: typeof import("./service");
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
const fixtureIds = { users: [] as string[], courses: [] as string[], batches: [] as string[] };

describe.skipIf(!url)("course discovery in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test") {
      throw new Error("Only the isolated local course_discovery_test database is permitted.");
    }
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5_000 }) });
    await client.$connect();
    service = await import("./service");
  });
  afterEach(async () => {
    if (!client) return;
    await client.courseSupportBatch.deleteMany({ where: { id: { in: fixtureIds.batches } } });
    await client.course.deleteMany({ where: { id: { in: fixtureIds.courses } } });
    await client.user.deleteMany({ where: { id: { in: fixtureIds.users } } });
    fixtureIds.courses.length = 0; fixtureIds.users.length = 0; fixtureIds.batches.length = 0;
    pilotSearchIds.clear();
  });
  afterAll(async () => { if (client) await client.$disconnect(); });

  async function fixture() {
    const suffix = randomUUID();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    fixtureIds.users.push(user.id);
    const course = await client.course.create({ data: { name: "Example Golf", latitude: 41, longitude: -73, timeZone: "UTC",
      website: "https://golf.example.com/", detectedBookingUrl: "https://golf.example.com/times", providerFamilyKey: "EXAMPLE", isPublic: true } });
    fixtureIds.courses.push(course.id);
    const targetDate = new Date(); targetDate.setUTCDate(targetDate.getUTCDate() + 2); targetDate.setUTCHours(0, 0, 0, 0);
    const search = await client.teeSearch.create({ data: { userId: user.id, date: targetDate, startTime: "09:00", endTime: "17:00", players: 1,
      userTimeZone: "UTC", trafficClass: "PUBLIC", preferences: { create: { courseId: course.id, rank: 1 } } } });
    pilotSearchIds.add(search.id);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { courseId: course.id, kind: "OUTDOOR" },
      source: { officialUrl: course.website, bookingUrl: course.detectedBookingUrl, venueName: course.name, providerFamily: "EXAMPLE", timeZone: "UTC" },
      request: { url: "https://golf.example.com/times?date={{date}}", method: "GET" },
      permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "spots" } } });
    return { course, search, recipe, ensure: () => service.ensureDiscoveryJob({ courseId: course.id, searchId: search.id }) };
  }
  async function verified(f: Awaited<ReturnType<typeof fixture>>, sourceEvidence?: { officialUrl: string; observedBookingUrl: string }) {
    const created = await f.ensure();
    const owner = await service.claimNextDiscoveryJob(`worker-${randomUUID()}`);
    expect(owner?.id).toBe(created?.id);
    const candidate = await service.proposeDiscoveryRecipe(owner!.id, owner!.leaseToken!, f.recipe, sourceEvidence);
    for (const challenge of candidate.challenges) {
      await service.recordDiscoveryVerification({ jobId: owner!.id, leaseToken: owner!.leaseToken!, challengeId: challenge.id,
        recipeHash: candidate.recipeHash, input: challenge.input, result: {
          status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(), sourceUrl: f.recipe.source.bookingUrl,
          slots: [{ sourceId: "slot1", startsAt: `${challenge.input.date}T10:00:00.000Z`, availableSpots: 4, bookingUrl: f.recipe.source.bookingUrl }],
          evidence: { recipeHash: hashAccessRecipe(f.recipe), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true },
        } });
    }
    return owner!;
  }

  it("deduplicates concurrent new demand and grants only one live lease", async () => {
    const f = await fixture();
    const jobs = await Promise.all([f.ensure(), f.ensure(), f.ensure()]);
    expect(new Set(jobs.map(job => job?.id)).size).toBe(1);
    const claims = await Promise.all([service.claimNextDiscoveryJob("first-worker"), service.claimNextDiscoveryJob("second-worker")]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
  });

  it("keeps a pilot lease usable behind one hundred older non-pilot alerts", async () => {
    const f = await fixture();
    const ids = Array.from({ length: 100 }, () => randomUUID());
    await client.teeSearch.createMany({ data: ids.map(id => ({ id, userId: f.search.userId, date: f.search.date,
      startTime: f.search.startTime, endTime: f.search.endTime, players: 1, userTimeZone: "UTC", trafficClass: "PUBLIC" as const,
      createdAt: new Date(f.search.createdAt.getTime() - 60_000) })) });
    await client.coursePreference.createMany({ data: ids.map(teeSearchId => ({ teeSearchId, courseId: f.course.id, rank: 1 })) });
    expect(await client.coursePreference.count({ where: { courseId: f.course.id } })).toBe(101);
    await f.ensure();
    const owner = (await service.claimNextDiscoveryJob("only-pilot-worker"))!;
    expect((owner.request as { demand: { searchId: string } }).demand.searchId).toBe(f.search.id);
    await expect(service.heartbeatDiscoveryJob(owner.id, owner.leaseToken!)).resolves.toMatchObject({ id: owner.id, status: "RUNNING" });
    await expect(service.proposeDiscoveryRecipe(owner.id, owner.leaseToken!, f.recipe)).resolves.toMatchObject({ challenges: expect.any(Array) });
  });

  it("atomically adopts an observed booking-link correction and retains its evidence", async () => {
    const f = await fixture();
    await client.course.update({ where: { id: f.course.id }, data: { detectedBookingUrl: f.recipe.source.officialUrl } });
    const sourceEvidence = { officialUrl: f.recipe.source.officialUrl, observedBookingUrl: f.recipe.source.bookingUrl };
    const owner = await verified(f, sourceEvidence);
    const activated = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    const stored = await client.courseAccessRecipe.findUniqueOrThrow({ where: { id: activated.recipeId } });
    expect((await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).detectedBookingUrl).toBe(f.recipe.source.bookingUrl);
    expect(stored.verification).toMatchObject({ sourceEvidence });
    expect(stored.sourceFingerprint).not.toBe(owner.sourceFingerprint);
    expect((await service.getActiveAccessRecipe({ courseId: f.course.id }))?.record.id).toBe(stored.id);
  });

  it("recovers an expired lease once without extending the first deadline", async () => {
    const f = await fixture(); await f.ensure();
    const first = (await service.claimNextDiscoveryJob("first-worker"))!;
    await client.courseDiscoveryJob.update({ where: { id: first.id }, data: { leaseExpiresAt: new Date(0) } });
    const second = (await service.claimNextDiscoveryJob("second-worker"))!;
    expect(second.deadlineAt).toEqual(first.deadlineAt);
    expect(second.firstPickedUpAt).toEqual(first.firstPickedUpAt);
    expect(second.attempts).toBe(2);
    await expect(service.heartbeatDiscoveryJob(first.id, first.leaseToken!)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    await client.courseDiscoveryJob.update({ where: { id: first.id }, data: { leaseExpiresAt: new Date(0) } });
    expect(await service.claimNextDiscoveryJob("third-worker")).toBeNull();
    expect((await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("FAILED");
  });

  it("does not reset exhausted attempts on ordinary checks or scheduler changes", async () => {
    const f = await fixture(); await f.ensure();
    const first = (await service.claimNextDiscoveryJob("first-worker"))!;
    await service.failDiscoveryJob(first.id, first.leaseToken!, "TOOL_FAILURE", true);
    const second = (await service.claimNextDiscoveryJob("second-worker"))!;
    await service.failDiscoveryJob(second.id, second.leaseToken!, "TOOL_FAILURE", true);
    await client.teeSearch.update({ where: { id: f.search.id }, data: { scheduleVersion: { increment: 1 } } });
    for (let index = 0; index < 3; index++) {
      const unchanged = await f.ensure();
      expect(unchanged?.id).toBe(first.id);
      expect(unchanged?.attempts).toBe(2);
      expect(unchanged?.deadlineAt).toEqual(first.deadlineAt);
      expect(unchanged?.status).toBe("FAILED");
    }
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
    await client.teeSearch.update({ where: { id: f.search.id }, data: { alertGeneration: { increment: 1 } } });
    const renewed = await f.ensure();
    expect(renewed?.id).not.toBe(first.id);
    expect(renewed?.firstPickedUpAt).toBeNull();
  });

  it("rejects a delayed result after customer cancellation", async () => {
    const f = await fixture(); const owner = await verified(f);
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED", scheduleVersion: { increment: 1 } } });
    await expect(service.activateDiscoveryRecipe(owner.id, owner.leaseToken!)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    expect(await client.courseAccessRecipe.count({ where: { courseId: f.course.id } })).toBe(0);
  });

  it("atomically activates two verified replays and handles an ambiguous repeated activation", async () => {
    const f = await fixture(); const owner = await verified(f);
    const first = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    const repeated = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    expect(repeated).toEqual(first);
    expect(await client.courseAccessRecipe.count({ where: { courseId: f.course.id } })).toBe(1);
    const active = await service.getActiveAccessRecipe({ courseId: f.course.id });
    expect(active?.record.id).toBe(first.recipeId);
    expect(active?.recipe).toEqual(f.recipe);
    expect((await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: owner.id } })).activeTargetKey).toBeNull();
  });

  it("rejects old proof after a canonical source change and never replaces the newer source", async () => {
    const f = await fixture(); const owner = await verified(f);
    await client.course.update({ where: { id: f.course.id }, data: { detectedBookingUrl: "https://golf.example.com/new-times" } });
    await expect(service.activateDiscoveryRecipe(owner.id, owner.leaseToken!)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    expect(await client.courseAccessRecipe.count({ where: { courseId: f.course.id } })).toBe(0);
    expect((await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).detectedBookingUrl).toBe("https://golf.example.com/new-times");
  });

  it("keeps proof immutable when a second process tries to replace a completed challenge", async () => {
    const f = await fixture(); const owner = await verified(f);
    const job = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: owner.id } });
    const proof = job.verification as unknown as { challenges: Array<{ id: string; input: import("./recipe").AccessExecutionInput; result: import("./recipe").AccessExecutionResult }> };
    const challenge = proof.challenges[0];
    const changed = { ...challenge.result, observedAt: new Date().toISOString() };
    await expect(service.recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: hashAccessRecipe(f.recipe), input: challenge.input, result: changed })).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    expect((await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: owner.id } })).verification).toEqual(job.verification as Prisma.JsonValue);
  });

  it("does not steal an expired legacy implementation claim", async () => {
    const f = await fixture();
    const incident = await client.courseSupportIncident.create({ data: { reference: randomUUID(), courseId: f.course.id, kind: "NEEDS_ADAPTER",
      courseNameSnapshot: f.course.name, platformSnapshot: "UNKNOWN" } });
    const batch = await client.courseSupportBatch.create({ data: { reference: randomUUID(), providerFamilyKey: "EXAMPLE", failureFingerprint: "fixture",
      status: "IMPLEMENTING", leaseToken: randomUUID(), leaseExpiresAt: new Date(0), heartbeatAt: new Date(0), baseSha: "a".repeat(40),
      incidents: { create: { incidentId: incident.id, courseId: f.course.id, cycle: 1 } } } });
    fixtureIds.batches.push(batch.id);
    expect(await f.ensure()).toBeNull();
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(0);
    expect((await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe("IMPLEMENTING");
  });

  it("rediscovers after source drift while retaining immutable recipe history", async () => {
    const f = await fixture(); const owner = await verified(f);
    const activated = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    await client.course.update({ where: { id: f.course.id }, data: { detectedBookingUrl: "https://golf.example.com/new-times" } });
    const next = await f.ensure();
    expect(next?.id).not.toBe(owner.id);
    expect(next?.baseRecipeId).toBeNull();
    expect((await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).activeAccessRecipeId).toBeNull();
    expect(await client.courseAccessRecipe.findUnique({ where: { id: activated.recipeId } })).not.toBeNull();
  });

  it("adopts only verified simulator facts and binds the recipe to their final snapshot", async () => {
    const f = await fixture();
    await client.course.update({ where: { id: f.course.id }, data: { isPublic: false } });
    const offering = await client.courseOffering.create({ data: { courseId: f.course.id, kind: "SIMULATOR", bookingUrl: f.recipe.source.officialUrl } });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { mode: "SIMULATOR", durationMinutes: 60, players: 4 } });
    await client.coursePreference.updateMany({ where: { teeSearchId: f.search.id }, data: { offeringId: offering.id } });
    const proposedRecipe = parseAccessRecipe({ ...f.recipe, target: { courseId: f.course.id, offeringId: offering.id, kind: "SIMULATOR" },
      proof: { ...f.recipe.proof, durationMinutes: { path: "durationMinutes" } }, slots: { ...f.recipe.slots, endsAt: { path: "end" } } });
    const created = await service.ensureDiscoveryJob({ courseId: f.course.id, offeringId: offering.id, searchId: f.search.id });
    const owner = (await service.claimNextDiscoveryJob("simulator-worker"))!;
    expect(owner.id).toBe(created?.id);
    const candidate = await service.proposeDiscoveryRecipe(owner.id, owner.leaseToken!, proposedRecipe,
      { officialUrl: proposedRecipe.source.officialUrl, observedBookingUrl: proposedRecipe.source.bookingUrl });
    expect(candidate.challenges[1].input.date).not.toBe(candidate.challenges[0].input.date);
    expect(candidate.challenges[1].input.players).toBe(candidate.challenges[0].input.players);
    for (const challenge of candidate.challenges) await service.recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!,
      challengeId: challenge.id, recipeHash: candidate.recipeHash, input: challenge.input, result: {
        status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(), sourceUrl: proposedRecipe.source.bookingUrl,
        slots: [{ sourceId: "slot1", startsAt: `${challenge.input.date}T10:00:00.000Z`, endsAt: `${challenge.input.date}T11:00:00.000Z`, availableSpots: 1, capacity: null, bookingUrl: proposedRecipe.source.bookingUrl }],
        evidence: { recipeHash: candidate.recipeHash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true },
      } });
    const adopted = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    const stored = await client.courseOffering.findUniqueOrThrow({ where: { id: offering.id } });
    expect(stored).toMatchObject({ publicAccessStatus: "PUBLIC", evidenceUrl: proposedRecipe.source.officialUrl,
      bookingUrl: proposedRecipe.source.bookingUrl, supportedDurationsMinutes: [60], maxPartySize: null, activeAccessRecipeId: adopted.recipeId });
    expect(stored.verifiedAt).not.toBeNull();
    expect((await service.getActiveAccessRecipe({ courseId: f.course.id, offeringId: offering.id }))?.record.id).toBe(adopted.recipeId);
  });
});
