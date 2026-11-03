// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT } from "@/lib/automation/simulator-support-policy";
let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
const ids = new Set<string>();
vi.mock("./config", () => ({ isCourseDiscoveryEnabled: () => true, isGeneralDiscoveryEnabled: () => true,
  isDiscoveryPilotSearch: async (id: string) => ids.has(id), activeDiscoveryPilotSearchIds: async () => [...ids] }));
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
let service: typeof import("./service"), engineering: typeof import("./engineering-repair");
const users: string[] = [], courses: string[] = [];
const runs: string[] = [];
describe.skipIf(!url)("engineering handoff in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test" ||
        process.env.DATABASE_URL !== url) throw new Error("Only the isolated local discovery test database is permitted.");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5_000 }) });
    await client.$connect(); service = await import("./service"); engineering = await import("./engineering-repair");
  });
  afterEach(async () => {
    if (!client) return;
    await client.automationRun.deleteMany({ where: { id: { in: runs } } }); runs.length = 0;
    await client.course.deleteMany({ where: { id: { in: courses } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    courses.length = 0; users.length = 0; ids.clear();
  });
  afterAll(async () => { if (client) await client.$disconnect(); });
  async function failed(simulator = false, savedMethod = false) {
    const suffix = randomUUID(), user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    users.push(user.id);
    const course = await client.course.create({ data: { name: "Public repair fixture", latitude: 41, longitude: -73,
      timeZone: "UTC", isPublic: true, website: "https://golf.example.com/" } });
    courses.push(course.id);
    const offering = simulator ? await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", supportedDurationsMinutes: [60] } }) : null;
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
    const search = await client.teeSearch.create({ data: { userId: user.id, date, startTime: "09:00", endTime: "18:00", players: 2,
      mode: simulator ? "SIMULATOR" : "OUTDOOR", durationMinutes: simulator ? 60 : null, userTimeZone: "UTC", trafficClass: "PUBLIC",
      preferences: { create: { courseId: course.id, offeringId: offering?.id, rank: 1 } } } });
    ids.add(search.id);
    const target = { courseId: course.id, ...(offering ? { offeringId: offering.id } : {}) };
    let job = await service.ensureDiscoveryJob({ ...target, searchId: search.id });
    if (savedMethod) {
      const owner = await service.claimNextDiscoveryJob("fixture-sol-learning");
      const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { ...target, kind: "OUTDOOR" },
        source: { venueName: course.name, officialUrl: course.website, bookingUrl: "https://golf.example.com/times", providerFamily: "EXAMPLE", timeZone: "UTC" },
        request: { url: "https://golf.example.com/times?date={{date}}", method: "GET" },
        permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
        proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" } },
        slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "spots" } } });
      const proposed = await service.proposeDiscoveryRecipe(owner!.id, owner!.leaseToken!, recipe);
      for (const challenge of proposed.challenges) await service.recordDiscoveryVerification({ jobId: owner!.id, leaseToken: owner!.leaseToken!,
        challengeId: challenge.id, recipeHash: proposed.recipeHash, input: challenge.input, result: {
          status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(), sourceUrl: recipe.source.bookingUrl,
          slots: [{ sourceId: "fixture", startsAt: `${challenge.input.date}T10:00:00.000Z`, availableSpots: 4, bookingUrl: recipe.source.bookingUrl }],
          evidence: { recipeHash: hashAccessRecipe(recipe), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true },
        } });
      const activated = await service.activateDiscoveryRecipe(owner!.id, owner!.leaseToken!);
      job = await service.ensureDiscoveryJob({ ...target, searchId: search.id, failedRecipeId: activated.recipeId });
    }
    for (let n = 0; n < 2; n++) {
      const claimed = await service.claimNextDiscoveryJob("fixture-sol-worker");
      expect(claimed?.id).toBe(job?.id);
      await service.failDiscoveryJob(job!.id, claimed!.leaseToken!, "TOOL_FAILURE", n === 0);
    }
    return { target, course, offering, search, job: await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: job!.id } }) };
  }
  it("durably admits code repair once while preserving the failed attempts and deadline", async () => {
    const f = await failed();
    expect(await engineering.reconcileDiscoveryEngineeringHandoffs()).toEqual({ examined: 1, queued: 1 });
    const current = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    for (const key of ["status", "outcome", "attempts", "firstPickedUpAt", "deadlineAt", "completedAt", "sourceFingerprint"] as const)
      expect(current[key]).toEqual(f.job[key]);
    const receipt = engineering.discoveryEngineeringReceipt(current.result)!;
    expect(receipt.state).toBe("QUEUED");
    expect(await client.courseSupportIncident.findUnique({ where: { id: receipt.incidentId } }))
      .toMatchObject({ courseId: f.course.id, status: "AUTO_INVESTIGATING", firstAffectedSearchId: f.search.id });
    expect(await engineering.reconcileDiscoveryEngineeringHandoffs()).toEqual({ examined: 0, queued: 0 });
    const context = await engineering.discoveryEngineeringContext(client, f.target, receipt.incidentId,
      new Date(f.job.deadlineAt!.getTime() + 60_000));
    expect(context).toMatchObject({ jobId: f.job.id, attempts: 2, originalDeadlineExpired: true,
      originalDeadlineAt: f.job.deadlineAt!.toISOString() });
  });
  it("routes a simulator to exactly its offering incident", async () => {
    const f = await failed(true);
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    expect(await client.simulatorSupportIncident.findUnique({ where: { offeringId: f.offering!.id } }))
      .toMatchObject({ status: "AUTO_INVESTIGATING", reason: "DISCOVERY_CODE_REPAIR" });
    expect(await client.courseSupportIncident.count({ where: { courseId: f.course.id } })).toBe(0);
  });
  async function boundSimulatorHandoff() {
    const f = await failed(true);
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { offeringId: f.offering!.id } });
    const fingerprint = getSimulatorOfferingSourceFingerprint(f.offering!), now = new Date(), baseSha = "a".repeat(40);
    const demand = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const assignmentRef = `course-assignment-${randomUUID()}`, child = `handoff-child-${randomUUID()}`;
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: "course-support-course-dispatch-v1",
      ownerThreadId: "handoff-parent", audit: { schemaVersion: 1, tickRef: "fixture", assignmentRef, state: "BOUND", ownerThreadId: "handoff-parent",
        childThreadId: child, baseSha, reservedAt: now.toISOString(), launchStartedAt: now.toISOString(), boundAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(), target: { mode: "SIMULATOR", offeringId: f.offering!.id,
          offeringSourceFingerprint: fingerprint, incidentId: incident.id, courseId: f.course.id, cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING",
          failureFingerprint: fingerprint, updatedAt: incident.updatedAt.toISOString(), trafficClass: "REAL", searchRefs: [{ id: f.search.id,
            scheduleVersion: f.search.scheduleVersion, alertGeneration: f.search.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(demand) }] } } } });
    runs.push(run.id);
    const lane = await import("@/lib/automation/simulator-support-ownership");
    return { ...f, incident, run, claim: () => lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha,
      branch: "automation/course-support-discovery-claim" }) };
  }
  it("claims the exact simulator learning handoff without inventing a legacy failure probe", async () => {
    const f = await boundSimulatorHandoff();
    expect(await client.courseProbe.count({ where: { offeringId: f.offering!.id } })).toBe(0);
    const claimed = await f.claim(); expect(claimed.acquired).toBe(true);
    const run = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(run.audit).toMatchObject({ state: "CONSUMED", simulatorClaim: { phase: "CLAIMED" } });
    const job = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(job).toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt,
      deadlineAt: f.job.deadlineAt, completedAt: f.job.completedAt });
  });
  it("preserves claims authorized by a current legacy offering failure", async () => {
    const f = await boundSimulatorHandoff();
    await client.courseDiscoveryJob.update({ where: { id: f.job.id }, data: { result: { unavailable: true } } });
    await client.courseProbe.create({ data: { courseId: f.course.id, offeringId: f.offering!.id, teeSearchId: f.search.id,
      outcome: "NEEDS_ADAPTER", rawSummary: { mode: "SIMULATOR", sourceFingerprint: getSimulatorOfferingSourceFingerprint(f.offering!) } } });
    expect((await f.claim()).acquired).toBe(true);
  });
  it.each(["checkpoint-only", "wrong-incident", "recovered", "paused", "edited", "source-changed"])("rejects a %s simulator learning handoff at claim", async reason => {
    const f = await boundSimulatorHandoff();
    const stored = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    const receipt = engineering.discoveryEngineeringReceipt(stored.result)!;
    if (reason === "checkpoint-only") await client.courseDiscoveryJob.update({ where: { id: f.job.id }, data: {
      result: { unavailable: true }, checkpoint: { engineeringHandoff: receipt } } });
    if (reason === "wrong-incident") await client.courseDiscoveryJob.update({ where: { id: f.job.id }, data: {
      result: { engineeringHandoff: { ...receipt, incidentId: "another-incident" } } } });
    if (reason === "recovered") await client.courseProbe.create({ data: { courseId: f.course.id, offeringId: f.offering!.id,
      teeSearchId: f.search.id, outcome: "MATCH_FOUND", observedAt: new Date(stored.completedAt!.getTime() + 1) } });
    if (reason === "paused" || reason === "edited") await client.teeSearch.update({ where: { id: f.search.id }, data:
      reason === "paused" ? { status: "PAUSED" } : { alertGeneration: { increment: 1 } } });
    if (reason === "source-changed") await client.courseOffering.update({ where: { id: f.offering!.id }, data: { bookingUrl: "https://changed.example.com/book" } });
    await expect(f.claim()).rejects.toThrow();
    const run = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(run.audit).toMatchObject({ state: "BOUND" });
  });
  it("transfers a failing saved method to coding and restores learner ownership after recovery", async () => {
    const f = await failed(false, true);
    const { excludeDiscoveryPilotTargets } = await import("./legacy-exclusion");
    expect(await excludeDiscoveryPilotTargets([f.target], client, new Date())).toEqual([]);
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    expect(await excludeDiscoveryPilotTargets([f.target], client, new Date())).toEqual([f.target]);
    await client.courseProbe.create({ data: { courseId: f.course.id, teeSearchId: f.search.id, outcome: "MATCH_FOUND" } });
    expect(await excludeDiscoveryPilotTargets([f.target], client, new Date())).toEqual([]);
    const current = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(current).toMatchObject({ status: "FAILED", attempts: 2, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
  });
  it("preserves an existing simulator incident's future retry and reason", async () => {
    const f = await failed(true), retryAt = new Date(Date.now() + 86_400_000);
    const original = await client.simulatorSupportIncident.create({ data: { offeringId: f.offering!.id,
      reason: "ORIGINAL_FAILURE", retryAt } });
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    const current = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: original.id } });
    expect(current).toEqual(original);
  });
  it.each(["paused", "edited"])("does not repair %s demand", async reason => {
    const f = await failed();
    await client.teeSearch.update({ where: { id: f.search.id }, data: reason === "paused" ? { status: "PAUSED" } : { alertGeneration: { increment: 1 } } });
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(0);
    expect(await client.courseSupportIncident.count({ where: { courseId: f.course.id } })).toBe(0);
  });
  it("retires changed sources and successful recoveries without reopening the failed job", async () => {
    const f = await failed();
    await client.course.update({ where: { id: f.course.id }, data: { website: "https://changed.example.com/" } });
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(0);
    const stored = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    expect(stored.status).toBe("FAILED");
    expect(stored.result).toMatchObject({ engineeringHandoff: { state: "OBSOLETE" } });
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).examined).toBe(0);
  });
  it("does not open engineering work after the ordinary pipeline has already recovered", async () => {
    const f = await failed();
    await client.courseProbe.create({ data: { courseId: f.course.id, teeSearchId: f.search.id, outcome: "MATCH_FOUND",
      observedAt: new Date(f.job.completedAt!.getTime() + 1) } });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(0);
    expect(await client.courseSupportIncident.count({ where: { courseId: f.course.id } })).toBe(0);
  });
});
