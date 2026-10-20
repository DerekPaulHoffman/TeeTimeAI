// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CHRONOGOLF_READ_CLIENTS, chronogolfRecipeBookingUrl } from "./chronogolf-source";
import { hashAccessRecipe, parseAccessRecipe, type AccessExecutionResult } from "./recipe";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
const pilotIds = new Set<string>();
vi.mock("./config", () => ({ isDiscoveryPilotSearch: (id: string) => pilotIds.has(id),
  activeDiscoveryPilotSearchIds: async () => [...pilotIds], isCourseDiscoveryEnabled: () => false }));
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
const fixtures = { users: [] as string[], courses: [] as string[] };
let service: typeof import("./service"), runtime: typeof import("./runtime");
const resource = "0bae7da1-b55e-4203-ac78-92b750f9c2d0", slotId = "fecd4d39-bb67-478f-91fc-a0523a864491";

describe.skipIf(!url)("Chronogolf canonical links through isolated persistence", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test")
      throw new Error("Only the isolated local course_discovery_test database is permitted");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5000 }) });
    await client.$connect(); service = await import("./service"); runtime = await import("./runtime");
  });
  afterEach(async () => {
    if (!client) return;
    await client.course.deleteMany({ where: { id: { in: fixtures.courses } } });
    await client.user.deleteMany({ where: { id: { in: fixtures.users } } });
    fixtures.courses.length = 0; fixtures.users.length = 0; pilotIds.clear();
  });
  afterAll(async () => { if (client) await client.$disconnect(); });

  async function fixture() {
    const suffix = randomUUID(), date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); fixtures.users.push(user.id);
    const course = await client.course.create({ data: { name: `Example Golf ${suffix}`, latitude: 47, longitude: -122,
      address: "100 Fairway Blvd, Example City, WA 98275, USA", timeZone: "UTC", isPublic: true,
      website: "https://golf.example.com/", detectedBookingUrl: "https://chronogolf.com/club/1234", providerFamilyKey: "CHRONOGOLF" } });
    fixtures.courses.push(course.id);
    const search = await client.teeSearch.create({ data: { userId: user.id, date, startTime: "09:00", endTime: "17:00", players: 2,
      userTimeZone: "UTC", trafficClass: "PUBLIC", preferences: { create: { courseId: course.id, rank: 1 } } } }); pilotIds.add(search.id);
    const target = { courseId: course.id, kind: "OUTDOOR" as const };
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target,
      source: { officialUrl: course.website, bookingUrl: course.detectedBookingUrl, venueName: course.name, venueAddress: course.address,
        providerFamily: "CHRONOGOLF", timeZone: "UTC" },
      adapter: { family: "CHRONOGOLF", clubId: 1234, profileUrl: "https://www.chronogolf.com/club/example-golf-club",
        timeZone: "UTC", publicPlayerTypeId: 56, courses: [{ id: 5678, uuid: resource, name: "Example North", layoutHoles: 18, bookableHoles: [9, 18] }],
        clients: CHRONOGOLF_READ_CLIENTS, catalogHash: "a".repeat(64) } });
    if (recipe.engine !== "EXISTING_ADAPTER" || recipe.adapter.family !== "CHRONOGOLF") throw new Error("Wrong fixture recipe");
    const result = (requestedDate: string): AccessExecutionResult => ({ status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(),
      sourceUrl: recipe.source.bookingUrl, slots: [{ sourceId: `chronogolf-${slotId}`, startsAt: `${requestedDate}T10:00:00Z`, availableSpots: 4,
        resourceId: `chronogolf-course:${resource}`, bookingUrl: chronogolfRecipeBookingUrl(recipe.source.bookingUrl, recipe.adapter, requestedDate) }],
      evidence: { recipeHash: hashAccessRecipe(recipe), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
    await service.ensureDiscoveryJob({ courseId: course.id, searchId: search.id });
    const owner = (await service.claimNextDiscoveryJob(`chronogolf-${suffix}`))!;
    const proposed = await service.proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    return { course, search, target, recipe, result, owner, proposed };
  }

  it("verifies a canonical dated link from the observed numeric alias and reuses it after a parameter change", async () => {
    const f = await fixture();
    for (const challenge of f.proposed.challenges) {
      const valid = f.result(challenge.input.date), slot = valid.slots[0];
      for (const bookingUrl of [slot.bookingUrl.replace("example-golf-club", "unrelated-club"), `${slot.bookingUrl}&extra=1`,
        slot.bookingUrl.replace(challenge.input.date, "2001-01-01")])
        await expect(service.recordDiscoveryVerification({ jobId: f.owner.id, leaseToken: f.owner.leaseToken!, challengeId: challenge.id,
          recipeHash: f.proposed.recipeHash, input: challenge.input, result: { ...valid, slots: [{ ...slot, bookingUrl }] } })).rejects.toThrow();
      await service.recordDiscoveryVerification({ jobId: f.owner.id, leaseToken: f.owner.leaseToken!, challengeId: challenge.id,
        recipeHash: f.proposed.recipeHash, input: challenge.input, result: valid });
    }
    const activated = await service.activateDiscoveryRecipe(f.owner.id, f.owner.leaseToken!);
    const original = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.owner.id } });
    const date = f.search.date.toISOString().slice(0, 10), next = new Date(f.search.date); next.setUTCDate(next.getUTCDate() + 1);
    for (const [index, requestedDate] of [date, next.toISOString().slice(0, 10)].entries()) {
      const players = index ? 3 : 2;
      if (index) await client.teeSearch.update({ where: { id: f.search.id }, data: { date: next, players,
        scheduleVersion: { increment: 1 }, alertGeneration: { increment: 1 } } });
      const input = { date: requestedDate, timeZone: "UTC", players, startTime: "09:00", endTime: "17:00" };
      expect(await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input })).toMatchObject({ state: "pending" });
      const claim = (await runtime.claimNextRecipeExecution(`canonical-reader-${index}`))!;
      expect(claim).toBeTruthy(); const result = f.result(requestedDate), slot = result.slots[0];
      await expect(runtime.completeRecipeExecution(claim.id, claim.leaseToken, { ...result,
        slots: [{ ...slot, bookingUrl: `${slot.bookingUrl}&unobserved=1` }] })).rejects.toThrow("Invalid recipe slot");
      await runtime.completeRecipeExecution(claim.id, claim.leaseToken, result);
      await runtime.completeRecipeExecution(claim.id, claim.leaseToken, result);
      expect(await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input })).toMatchObject({ state: "ready" });
    }
    const current = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.owner.id } });
    expect(current.attempts).toBe(original.attempts); expect(current.firstPickedUpAt).toEqual(original.firstPickedUpAt);
    expect(current.deadlineAt).toEqual(original.deadlineAt);
    expect((await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).activeAccessRecipeId).toBe(activated.recipeId);
    expect(await client.courseAccessRecipe.count({ where: { courseId: f.course.id } })).toBe(1);
  });
});
