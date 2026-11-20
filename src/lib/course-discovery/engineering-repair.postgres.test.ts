// @vitest-environment node
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT } from "@/lib/automation/simulator-support-policy";
import { createCourseSupportRemediationCourseRef } from "@/lib/automation/course-support-claim-evidence";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { appendAutomationPlaybookEvent } from "@/lib/automation/course-monitoring-playbook";
import { COURSE_DISPATCH_SOURCE_SELECT, createCourseDispatchIntentDigest } from "@/lib/automation/course-support-dispatch-intent";
let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
const ids = new Set<string>();
vi.mock("./config", () => ({ isCourseDiscoveryEnabled: () => true, isGeneralDiscoveryEnabled: () => true,
  isDiscoveryPilotSearch: async (id: string) => ids.has(id), activeDiscoveryPilotSearchIds: async () => [...ids] }));
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
let service: typeof import("./service"), engineering: typeof import("./engineering-repair");
const users: string[] = [], courses: string[] = [];
const runs: string[] = [];
const batchOwners: string[] = [];
describe.skipIf(!url)("engineering handoff in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test" ||
        process.env.DATABASE_URL !== url) throw new Error("Only the isolated local discovery test database is permitted.");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5_000 }) });
    await client.$connect(); service = await import("./service"); engineering = await import("./engineering-repair");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (!client) return;
    const ownedRuns = await client.automationRun.findMany({ where: { ownerThreadId: { in: batchOwners } }, select: { id: true } });
    runs.push(...ownedRuns.map(run => run.id));
    await client.courseSupportBatch.deleteMany({ where: { ownerThreadId: { in: batchOwners } } }); batchOwners.length = 0;
    await client.automationRun.deleteMany({ where: { id: { in: runs } } }); runs.length = 0;
    await client.course.deleteMany({ where: { id: { in: courses } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    courses.length = 0; users.length = 0; ids.clear();
  });
  afterAll(async () => { if (client) await client.$disconnect(); });
  it("persists a verified Any-duration method with its published length and original cold deadline", async () => {
    const suffix = randomUUID(), user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: `ChIJ${suffix.replaceAll("-", "")}`, name: "Public rental fixture",
      latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true, website: "https://golf.example.com/" } });
    courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", supportedDurationsMinutes: [] } });
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
    const search = await client.teeSearch.create({ data: { userId: user.id, date, startTime: "09:00", endTime: "18:00", players: 2,
      mode: "SIMULATOR", durationMinutes: null, userTimeZone: "UTC", trafficClass: "PUBLIC",
      preferences: { create: { courseId: course.id, offeringId: offering.id, rank: 1 } } } });
    ids.add(search.id);
    const target = { courseId: course.id, offeringId: offering.id };
    await service.ensureDiscoveryJob({ ...target, searchId: search.id });
    const owner = (await service.claimNextDiscoveryJob("fixture-sol-any-duration"))!;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { ...target, kind: "SIMULATOR" },
      source: { venueName: course.name, officialUrl: course.website, bookingUrl: "https://golf.example.com/times", timeZone: "UTC", providerFamily: "EXAMPLE" },
      request: { url: "https://golf.example.com/times?date={{date}}&duration={{durationMinutes}}", method: "GET" },
      permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date", "duration"] }],
      proof: { venue: { path: "venue" }, date: { path: "date" }, durationMinutes: { path: "duration" }, complete: { path: "complete" }, empty: { path: "empty" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, endsAt: { path: "end" }, availableSpots: { path: "spots" } } });
    const proposed = await service.proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe, undefined, 55);
    expect(proposed.challenges.map(c => c.input.durationMinutes)).toEqual([55, 55]);
    for (const challenge of proposed.challenges) await service.recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!,
      challengeId: challenge.id, recipeHash: proposed.recipeHash, input: challenge.input, result: { status: "AVAILABLE", complete: true,
        observedAt: new Date().toISOString(), sourceUrl: recipe.source.bookingUrl,
        slots: [{ sourceId: `fixture-${challenge.input.date}`, startsAt: `${challenge.input.date}T10:00:00.000Z`,
          endsAt: `${challenge.input.date}T10:55:00.000Z`, availableSpots: 1, bookingUrl: recipe.source.bookingUrl }],
        evidence: { recipeHash: proposed.recipeHash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } } });
    const activation = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: offering.id } })).toMatchObject({
      activeAccessRecipeId: activation.recipeId, publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [55] });
    const finished = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: owner.id } });
    expect(finished).toMatchObject({ status: "SUCCEEDED", firstPickedUpAt: owner.firstPickedUpAt, deadlineAt: owner.deadlineAt, attempts: 1 });
    expect(finished.deadlineAt!.getTime() - finished.firstPickedUpAt!.getTime()).toBe(900_000);
    expect(await service.getActiveAccessRecipe(target)).toMatchObject({ record: { id: activation.recipeId, hash: activation.hash },
      recipe: { target: { ...target, kind: "SIMULATOR" } } });
  });
  async function failed(simulator = false, savedMethod = false) {
    const suffix = randomUUID(), user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: `ChIJ${suffix.replaceAll("-", "")}`, name: "Public repair fixture", latitude: 41, longitude: -73,
      address: "1 Test Street, Example, CT 06000", city: "Example", stateCode: "CT", countryCode: "US",
      timeZone: "UTC", isPublic: true, automationEligibility: "ALLOWED", website: "https://golf.example.com/" } });
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
  async function deployedReaderRepair() {
    const f = await failed();
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    await client.courseSupportIncident.update({ where: { courseId: f.course.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const ownerThreadId = `reader-recovery-${randomUUID()}`; batchOwners.push(ownerThreadId);
    const lane = await import("@/lib/automation/course-support-batches");
    expect(await lane.claimCourseSupportBatch({ ownerThreadId, branch: "automation/course-support-reader-recovery",
      baseSha: "a".repeat(40), maxCourses: 1 })).toMatchObject({ outcome: "ready" });
    const batch = await client.courseSupportBatch.findFirstOrThrow({ where: { ownerThreadId } });
    expect(await lane.appendCourseSupportBatchPath({ batchId: batch.id, leaseToken: batch.leaseToken, ownerThreadId,
      path: "src/lib/course-discovery/example-public-reader.ts" })).toMatchObject({ pathRecorded: true });
    // External Git/CI/deployment are not performed by a persistence fixture.
    // Their verified server-owned state is supplied here; production admission
    // still obtains it from the exact owned batch, never a caller checkpoint.
    const releaseSha = "b".repeat(40);
    await client.courseSupportBatch.update({ where: { id: batch.id }, data: {
      status: "VERIFYING", releaseSha, deployedAt: batch.createdAt } });
    return { ...f, batch, input: { batchId: batch.id, leaseToken: batch.leaseToken, ownerThreadId, releaseSha, runtimeVersion: releaseSha } };
  }

  // This end-to-end database fixture includes cold tooling imports on hosted
  // runners. Its harness budget is separate from the asserted worker deadlines.
  it.each(["live-original-owner", "foreign-native-owner", "expired-owner-lease"])(
    "reconciles an interrupted pre-deployment wait without changing durable effects: %s", async scenario => {
      const f = await deployedReaderRepair();
      // This is the real persisted boundary after a release heartbeat and an
      // interrupted read-only deployment wait, before its proof was recorded.
      await client.courseSupportBatch.update({ where: { id: f.batch.id }, data: { deployedAt: null,
        ...(scenario === "expired-owner-lease" ? { leaseExpiresAt: new Date(Date.now() - 1000) } : {}) } });
      const snapshot = async () => ({
        batch: await client.courseSupportBatch.findUniqueOrThrow({ where: { id: f.batch.id } }),
        jobs: await client.courseDiscoveryJob.findMany({ where: { courseId: f.course.id }, orderBy: { id: "asc" } }),
        recipes: await client.courseAccessRecipe.findMany({ where: { courseId: f.course.id }, orderBy: { id: "asc" } }),
        search: await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } }),
      });
      const before = await snapshot();
      vi.stubEnv("CODEX_THREAD_ID", scenario === "foreign-native-owner" ? `foreign-${randomUUID()}` : f.input.ownerThreadId);
      const { recoverLearning } = await import("../../../scripts/automation/course-support");
      const noHttp = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("NO_PUBLIC_OR_DEPLOYMENT_READ_ALLOWED"));
      try {
        const pending = recoverLearning(["--batch-ref", f.batch.reference]);
        if (scenario === "live-original-owner") {
          const result = await pending;
          expect(result).toMatchObject({ outcome: "release_verification_required", stateChanged: false,
            requiredAction: "VERIFY_REGISTERED_RELEASE", releaseSha: f.input.releaseSha,
            deploymentVerified: false, monitoringVerified: false, deliveryVerified: false, durableCloseoutRecorded: false });
          expect(result).toHaveProperty("nextAction", expect.stringContaining("interrupted deployment wait"));
        } else await expect(pending).rejects.toThrow();
        expect(noHttp).not.toHaveBeenCalled();
        expect(await snapshot()).toEqual(before);
      } finally { noHttp.mockRestore(); }
    }, 20_000);

  it.each(["live-owner", "expired-original-owner"])("returns a repaired reader to replay and normal monitoring with %s", async scenario => {
    const f = await deployedReaderRepair();
    const admission = await service.requestOwnedOutdoorLearningRecovery(f.input);
    expect(admission).toMatchObject({ outcome: "created", originalJobId: f.job.id, releaseSha: f.input.releaseSha });
    if (!("jobId" in admission)) throw Error("Missing recovery fixture");
    const progress = { ...f.input, originalJobId: f.job.id, jobId: admission.jobId };
    expect(await service.ownedOutdoorLearningRecoveryProgress(progress)).toMatchObject({ state: "PENDING", attempts: 0 });
    expect(await service.requestOwnedOutdoorLearningRecovery(f.input)).toMatchObject({ outcome: "existing", jobId: admission.jobId });
    expect(await service.claimNextDiscoveryJob("old-runtime", "a".repeat(40))).toBeNull();
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: admission.jobId } }))
      .toMatchObject({ status: "QUEUED", attempts: 0, firstPickedUpAt: null, deadlineAt: null });
    const child = await service.claimNextDiscoveryJob("repaired-runtime", f.input.releaseSha);
    expect(child?.id).toBe(admission.jobId);
    expect(child?.attempts).toBe(1);
    if (scenario === "expired-original-owner") await client.courseSupportBatch.update({ where: { id: f.batch.id },
      data: { leaseExpiresAt: new Date(0) } });
    await service.heartbeatDiscoveryJob(child!.id, child!.leaseToken!);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { ...f.target, kind: "OUTDOOR" },
      source: { venueName: f.course.name, officialUrl: f.course.website, bookingUrl: "https://golf.example.com/times", providerFamily: "EXAMPLE", timeZone: "UTC" },
      request: { url: "https://golf.example.com/times?date={{date}}", method: "GET" },
      permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "spots" } } });
    const proposed = await service.proposeDiscoveryRecipe(child!.id, child!.leaseToken!, recipe);
    await expect(service.activateDiscoveryRecipe(child!.id, child!.leaseToken!)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    for (const challenge of proposed.challenges) await service.recordDiscoveryVerification({ jobId: child!.id, leaseToken: child!.leaseToken!,
      challengeId: challenge.id, recipeHash: proposed.recipeHash, input: challenge.input, result: {
        status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(), sourceUrl: recipe.source.bookingUrl,
        slots: [{ sourceId: "fixture", startsAt: `${challenge.input.date}T10:00:00.000Z`, availableSpots: 4, bookingUrl: recipe.source.bookingUrl }],
        evidence: { recipeHash: proposed.recipeHash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true },
      } });
    const activated = await service.activateDiscoveryRecipe(child!.id, child!.leaseToken!);
    expect(await service.ownedOutdoorLearningRecoveryProgress(progress)).toMatchObject({ state: "METHOD_SAVED",
      recipeId: activated.recipeId, recipeHash: activated.hash, runtimeVersion: f.input.runtimeVersion,
      originalFirstPickedUpAt: f.job.firstPickedUpAt!.toISOString(), originalDeadlineAt: f.job.deadlineAt!.toISOString() });
    expect(await service.getActiveAccessRecipe(f.target)).toMatchObject({ record: { id: activated.recipeId,
      verification: { executionRuntimeVersion: f.input.releaseSha, challenges: expect.any(Array) } } });
    const original = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    for (const key of ["status", "outcome", "attempts", "firstPickedUpAt", "deadlineAt", "completedAt", "sourceFingerprint"] as const)
      expect(original[key]).toEqual(f.job[key]);
    expect(original.result).toMatchObject({ learningRecoveries: [{ jobId: child!.id, originalJobId: original.id,
      kind: "LATE_ENGINEERING_RECOVERY", batchId: f.batch.id, releaseSha: f.input.releaseSha }] });
    expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: f.batch.id } }))
      .toMatchObject({ ownerThreadId: f.input.ownerThreadId, status: "PARTIAL", completedAt: expect.any(Date) });
    const handoff = await service.handoffOwnedLearningRecipeToMonitoring(progress);
    expect(handoff).toMatchObject({ outcome: "learning_recipe_handoff", durableCloseoutRecorded: true,
      monitoringVerified: false, deliveryVerified: false,
      handoff: { phase: "METHOD_REPLAYED_MONITORING_PENDING", recipeId: activated.recipeId } });
    expect(await service.handoffOwnedLearningRecipeToMonitoring(progress)).toEqual(handoff);
    expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: f.batch.id } }))
      .toMatchObject({ ownerThreadId: f.input.ownerThreadId, status: "PARTIAL", completedAt: expect.any(Date) });
    expect(await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } }))
      .toMatchObject({ status: "AUTO_INVESTIGATING", activeBatchId: null, resolution: null });
    expect(await client.courseProbe.count({ where: { courseId: f.course.id } })).toBe(0);
    expect(await client.teeTimeMatch.count({ where: { courseId: f.course.id } })).toBe(0);
    // The existing normal observation path, not the coding handoff, owns the
    // actual monitoring resolution. This fixture performs no email operation.
    const { recordCourseMonitoringSuccess } = await import("@/lib/automation/course-monitoring");
    await recordCourseMonitoringSuccess({ courseId: f.course.id, outcome: "MATCH_FOUND",
      providerObservedAt: new Date(), runtimeVersion: f.input.runtimeVersion });
    expect(await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } }))
      .toMatchObject({ status: "RESOLVED", activeBatchId: null, resolution: "MONITORING_RESTORED" });
  }, 20_000);

  it("binds a published shared execution prefix without replacing implementation provenance", async () => {
    const f = await deployedReaderRepair(), runtimeVersion = "c".repeat(40);
    const admission = await service.requestOwnedOutdoorLearningRecovery({ ...f.input, runtimeVersion });
    if (!("jobId" in admission)) throw Error("Missing recovery fixture");
    expect(await service.claimNextDiscoveryJob("old-implementation-runtime", f.input.releaseSha)).toBeNull();
    expect(await service.claimNextDiscoveryJob("current-execution-runtime", runtimeVersion)).toMatchObject({ id: admission.jobId });
    expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: f.batch.id } }))
      .toMatchObject({ releaseSha: f.input.releaseSha, baseSha: f.batch.baseSha });
    expect((await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).result)
      .toMatchObject({ learningRecoveries: [{ releaseSha: f.input.releaseSha, runtimeVersion }] });
  });

  it("requires a different registered repair before another recovery budget is admitted", async () => {
    const f = await deployedReaderRepair(), admission = await service.requestOwnedOutdoorLearningRecovery(f.input);
    if (!("jobId" in admission)) throw Error("Missing recovery fixture");
    const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
    for (let n = 0; n < 2; n++) {
      const child = await service.claimNextDiscoveryJob("repaired-runtime", f.input.releaseSha);
      expect(child?.id).toBe(admission.jobId);
      await service.failDiscoveryJob(child!.id, child!.leaseToken!, "TOOL_FAILURE", true);
    }
    const exhausted = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: admission.jobId } });
    expect(await service.requestOwnedOutdoorLearningRecovery(f.input)).toMatchObject({ outcome: "existing", jobId: exhausted.id });
    expect(await service.claimNextDiscoveryJob("unchanged-runtime", f.input.releaseSha)).toBeNull();
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(2);
    const next = { ...f.input, releaseSha: "c".repeat(40), runtimeVersion: "c".repeat(40) };
    await client.courseSupportBatch.update({ where: { id: f.batch.id }, data: { releaseSha: next.releaseSha } });
    const repaired = await service.requestOwnedOutdoorLearningRecovery(next);
    expect(repaired).toMatchObject({ outcome: "created", originalJobId: f.job.id });
    expect(await service.claimNextDiscoveryJob("old-runtime", f.input.releaseSha)).toBeNull();
    expect(await service.claimNextDiscoveryJob("new-runtime", next.releaseSha)).toMatchObject({ attempts: 1 });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: exhausted.id } })).toMatchObject({
      status: "FAILED", attempts: 2, firstPickedUpAt: exhausted.firstPickedUpAt, deadlineAt: exhausted.deadlineAt });
    expect((await client.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } })).attemptLedger).toEqual(incident.attemptLedger);
  });

  it.each(["valid", "malformed", "wrong-assignment", "wrong-native-owner"])("shares only the exact %s consumed dispatch lane", async scenario => {
    const f = await deployedReaderRepair(), assignmentRef = `course-assignment-${randomUUID()}`;
    const batch = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: f.batch.id } });
    const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
    await client.courseSupportBatch.update({ where: { id: batch.id },
      data: { summary: { ...(batch.summary as Prisma.JsonObject), dispatchAssignmentRef: assignmentRef } } });
    const audit = { schemaVersion: 1, tickRef: "course-fixture", assignmentRef: scenario === "wrong-assignment" ? `course-assignment-${randomUUID()}` : assignmentRef,
      state: "CONSUMED", ownerThreadId: "parent-fixture", childThreadId: scenario === "wrong-native-owner" ? "foreign-owner" : f.input.ownerThreadId,
      baseSha: batch.baseSha, reservedAt: batch.createdAt.toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(),
      consumedAt: batch.createdAt.toISOString(), target: { incidentId: incident.id, courseId: f.course.id, cycle: incident.cycle,
        providerFamilyKey: batch.providerFamilyKey, failureFingerprint: batch.failureFingerprint, updatedAt: incident.updatedAt.toISOString(),
        trafficClass: "REAL", searchRefs: scenario === "malformed" ? [] : [{ id: f.search.id, scheduleVersion: f.search.scheduleVersion, alertGeneration: f.search.alertGeneration }] } };
    const run = await client.automationRun.create({ data: { promptVersion: "course-support-course-dispatch-v1", audit } }); runs.push(run.id);
    if (scenario === "valid") {
      const admission = await service.requestOwnedOutdoorLearningRecovery(f.input);
      if (!("jobId" in admission)) throw Error("Missing recovery fixture");
      expect(await service.claimNextDiscoveryJob("repaired-runtime", f.input.releaseSha)).toMatchObject({ id: admission.jobId });
    } else {
      await expect(service.requestOwnedOutdoorLearningRecovery(f.input)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
      expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
    }
  });

  it("does not share a different active coding batch", async () => {
    const f = await deployedReaderRepair();
    const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
    const other = `foreign-${randomUUID()}`; batchOwners.push(other);
    await client.courseSupportBatch.create({ data: { reference: randomUUID(), ownerThreadId: other, leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 900000), heartbeatAt: new Date(), baseSha: "d".repeat(40), providerFamilyKey: f.batch.providerFamilyKey,
      failureFingerprint: "e".repeat(64), incidents: { create: { incidentId: incident.id, courseId: f.course.id, cycle: incident.cycle } } } });
    await expect(service.requestOwnedOutdoorLearningRecovery(f.input)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
  });

  it.each(["owner", "token", "release", "undeployed", "no-code"])("rejects an unauthorized %s repaired-learning handoff", async scenario => {
    const f = await deployedReaderRepair(), input = { ...f.input };
    if (scenario === "owner") input.ownerThreadId = "foreign-owner";
    if (scenario === "token") input.leaseToken = randomUUID();
    if (scenario === "release") input.releaseSha = "c".repeat(40);
    if (scenario === "undeployed") await client.courseSupportBatch.update({ where: { id: f.batch.id }, data: { deployedAt: null } });
    if (scenario === "no-code") await client.courseSupportBatch.update({ where: { id: f.batch.id },
      data: { summary: { ...(f.batch.summary as Prisma.JsonObject), plannedPaths: [] } } });
    await expect(service.requestOwnedOutdoorLearningRecovery(input)).rejects.toBeInstanceOf(service.DiscoveryConflictError);
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
    expect((await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).result)
      .not.toHaveProperty("learningRecoveries");
  });

  it.each(["expired-owner", "changed-native-owner", "forged-link", "cancelled-alert", "changed-source"])("cancels an unstarted recovery after %s", async scenario => {
    const f = await deployedReaderRepair(), admission = await service.requestOwnedOutdoorLearningRecovery(f.input);
    if (!("jobId" in admission)) throw Error("Missing recovery fixture");
    if (scenario === "expired-owner") await client.courseSupportBatch.update({ where: { id: f.batch.id }, data: { leaseExpiresAt: new Date(0) } });
    if (scenario === "changed-native-owner") {
      const other = `changed-native-${randomUUID()}`; batchOwners.push(other);
      await client.courseSupportBatch.update({ where: { id: f.batch.id }, data: { ownerThreadId: other } });
    }
    if (scenario === "forged-link") await client.courseDiscoveryJob.update({ where: { id: admission.jobId }, data: {
      result: { learningRecoveryOf: { version: 1, jobId: admission.jobId, checkpointOnly: true } } } });
    if (scenario === "cancelled-alert") await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED" } });
    if (scenario === "changed-source") await client.course.update({ where: { id: f.course.id }, data: { website: "https://changed.example.com/" } });
    expect(await service.claimNextDiscoveryJob("repaired-runtime", f.input.releaseSha)).toBeNull();
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: admission.jobId } }))
      .toMatchObject({ status: "CANCELLED", attempts: 0, firstPickedUpAt: null, deadlineAt: null, activeTargetKey: null });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
  });

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
  it("opens owned outdoor research from a current learning handoff without legacy monitoring proof", async () => {
    const f = await failed(), now = new Date();
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    const owner = `learning-research-${randomUUID()}`; batchOwners.push(owner);
    const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
    const route = { workMode: "ADVANCE_DISCOVERY", strategyAction: "DISCOVER_WITH_HTTP", playbookStage: "OFFICIAL_IDENTITY" } as const;
    const actionPlan = { schemaVersion: 1, primaryAction: "VERIFY_CURRENT_RUNTIME", allowedActions: ["VERIFY_CURRENT_RUNTIME"], route };
    const batch = await client.courseSupportBatch.create({ data: { reference: randomUUID(), providerFamilyKey: incident.providerFamilyKey,
      failureFingerprint: incident.failureFingerprint, status: "CLAIMED", ownerThreadId: owner, leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 900_000), heartbeatAt: now, baseSha: "a".repeat(40), summary: { remediation: {
        ...route, allowUnchangedRuntime: true, requiresImplementationPath: false, reason: "PLAYBOOK_STAGE_PENDING", retryBudget: null,
        attempts: [{ courseRef: createCourseSupportRemediationCourseRef(f.course.id), providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(f.course),
          failureFingerprint: incident.failureFingerprint, playbookEventCountAtClaim: 0, approach: route, actionPlan }] } },
      incidents: { create: { incidentId: incident.id, courseId: f.course.id, cycle: incident.cycle } } } });
    await client.courseSupportIncident.update({ where: { id: incident.id }, data: { activeBatchId: batch.id } });
    await client.courseMonitoringStatus.update({ where: { courseId: f.course.id }, data: { state: "AUTO_INVESTIGATING" } });
    const { getOwnedCourseSupportResearchContext } = await import("@/lib/automation/course-support-research-context");
    const context = await getOwnedCourseSupportResearchContext({ batchId: batch.id, leaseToken: batch.leaseToken,
      ownerThreadId: owner, ordinal: 1 });
    expect(context).toMatchObject({ outcome: "ready" });
    expect(context).toMatchObject({ researchContextV1: { monitoringProofRecorded: false, availabilityContract: { signedOutReadOnlyConfirmed: false } } });
    expect((await client.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } })).attemptLedger)
      .toEqual({ version: 1, events: [] });
    expect(await client.courseProbe.count({ where: { courseId: f.course.id } })).toBe(0);
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
  });
  it("claims a real failed outdoor learner as a full repair, preserving its demand and failed clock", async () => {
    const f = await failed();
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    const owner = `full-repair-${randomUUID()}`; batchOwners.push(owner);
    // This isolated fixture exercises a due scheduled claim, after the normal
    // first-failure delay. Do not alter the original learner clock or demand.
    await client.courseSupportIncident.update({ where: { courseId: f.course.id },
      data: { nextAttemptAt: new Date(Date.now() - 1_000) } });
    const lane = await import("@/lib/automation/course-support-batches");
    const claimed = await lane.claimCourseSupportBatch({ ownerThreadId: owner,
      branch: "automation/course-support-full-repair", baseSha: "a".repeat(40), maxCourses: 1 });
    expect(claimed).toMatchObject({ outcome: "ready" });
    const batch = await client.courseSupportBatch.findFirstOrThrow({ where: { ownerThreadId: owner } });
    expect(await lane.getCourseSupportBatchPacket({ batchId: batch.id, leaseToken: batch.leaseToken, ownerThreadId: owner }))
      .toMatchObject({ outcome: "ready", remediation: { reason: "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" },
        courses: [{ actionPlan: { primaryAction: "IMPLEMENT_REUSABLE_SUPPORT",
          allowedActions: expect.arrayContaining(["INVESTIGATE_PUBLIC_SOURCE"]) } }] });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ status: "FAILED", attempts: f.job.attempts,
        firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } }))
      .toMatchObject({ status: "ACTIVE", alertGeneration: 0 });
  });
  it.each(["automatic", "operator", "claimed-code", "consumed", "no-recovery", "changed-source", "cancelled"])(
    "retains only the acknowledged unconsumed %s runtime-recovery handoff before legacy deadline review", async scenario => {
      const f = await failed(); await engineering.reconcileDiscoveryEngineeringHandoffs();
      await client.courseSupportIncident.update({ where: { courseId: f.course.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      const owner = randomUUID(), baseSha = "a".repeat(40); batchOwners.push(owner);
      const lane = await import("@/lib/automation/course-support-batches");
      const monitoring = await import("@/lib/automation/course-monitoring");
      await lane.claimCourseSupportBatch({ ownerThreadId: owner, branch: "automation/course-support-runtime-repair", baseSha, maxCourses: 1 });
      const batch = await client.courseSupportBatch.findFirstOrThrow({ where: { ownerThreadId: owner } });
      const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
      const now = new Date(Date.now() + 120_000), completedAt = new Date(now.getTime() - 90_000);
      const endpointAt = new Date(now.getTime() - 60_000), deadline = new Date(endpointAt.getTime() - 30_000);
      const retryAt = monitoring.getHumanReviewRetryAt(endpointAt, 1);
      let ledger: ReturnType<typeof appendAutomationPlaybookEvent> | null = null;
      const steps = [
        ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY", "COMPLETED"], ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER", "NOT_APPLICABLE"],
        ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP", "COMPLETED"], ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NOT_APPLICABLE"],
        ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER", "COMPLETED"], ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER", "NOT_APPLICABLE"],
        ["LOCAL_READER", "LOCAL_READER", "NOT_APPLICABLE"], ["INDEPENDENT_CONFIRMATION", "INDEPENDENT_CONFIRMATION", "COMPLETED"],
      ] as const;
      for (const [index, [stage, readPath, transition]] of steps.entries()) ledger = appendAutomationPlaybookEvent(ledger, {
        cycle: incident.cycle, stage, readPath, transition, evidenceKind: "TOOLING", failureFingerprint: "PLAYBOOK:FIXTURE:COMPLETE",
        ...(transition === "NOT_APPLICABLE" ? { skipReason: "NO_RUNNABLE_ADAPTER" as const } : {}),
        runtimeVersion: baseSha, observedAt: new Date(batch.createdAt.getTime() + 1000 + index),
      });
      const closeout = { outcome: "retryable_failed", failureDomain: "GIT", remediationAttemptConsumed: scenario === "consumed" };
      await client.courseSupportBatch.update({ where: { id: batch.id }, data: { status: "RETRYABLE_FAILED", releaseSha: baseSha,
        deployedAt: new Date(batch.createdAt.getTime() + 1000), completedAt, summary: { ...(batch.summary as Prisma.JsonObject), closeout,
          plannedPaths: scenario === "claimed-code" ? ["src/lib/adapters/fixture.ts"] : [],
          ...(scenario === "no-recovery" ? {} : { supersededRuntimeRecovery: { previousSha: baseSha,
            deployment: { commitSha: "b".repeat(40), deploymentId: "dpl_IsolatedFixture" } } }),
        } } });
      await client.courseSupportBatchIncident.updateMany({ where: { batchId: batch.id }, data: { result: "RETRY_SCHEDULED" } });
      await client.courseSupportIncident.update({ where: { id: incident.id }, data: { status: "NEEDS_HUMAN", activeBatchId: null,
        humanReviewReason: "OTHER_TECHNICAL_LIMITATION", escalatedAt: endpointAt, escalationDeadlineAt: deadline,
        confirmedAt: batch.createdAt, activeRealSearchCount: 1, nextAttemptAt: retryAt, attemptLedger: ledger! } });
      await client.courseMonitoringStatus.update({ where: { courseId: f.course.id }, data: { state: "ENGINEERING_VERIFICATION_NEEDED",
        stateChangedAt: endpointAt, failureFingerprint: incident.failureFingerprint, nextAutomaticAttemptAt: retryAt,
        revalidationRequestedAt: null } });
      await client.courseMonitoringEvent.create({ data: { courseId: f.course.id, incidentId: incident.id,
        eventType: "HUMAN_REVIEW_REQUESTED", source: "SEARCH_WORKFLOW", fromState: "AUTO_INVESTIGATING", toState: "ENGINEERING_VERIFICATION_NEEDED",
        failureFingerprint: incident.failureFingerprint, message: "The bounded automated playbook ended without fresh runnable proof.",
        operatorActorId: scenario === "operator" ? "fixture-operator" : null, occurredAt: endpointAt,
        audit: { cycle: incident.cycle, playbookVersion: 1, playbookConclusion: "UNRESOLVED_EXHAUSTED", playbookExhausted: true,
          automationStalled: false, nextStage: null, automaticRecheckHours: 6, escalationDeadlineAt: deadline.toISOString() } } });
      if (scenario === "changed-source") await client.course.update({ where: { id: f.course.id }, data: { website: "https://changed.example.com/" } });
      if (scenario === "cancelled") await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED" } });
      const originalJob = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
      // Exercise the normal five-minute recovery entry, including parked rows
      // whose legacy nextAttemptAt is still six hours in the future.
      expect(await monitoring.reconcileCourseMonitoringDeadlines({ courseIds: [f.course.id], source: "RECOVERY_CRON", now }))
        .toMatchObject({ checked: 1, retrying: scenario === "automatic" ? 1 : 0 });
      expect(await client.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } })).toMatchObject({
        status: scenario === "automatic" ? "AUTO_INVESTIGATING" : "NEEDS_HUMAN", cycle: incident.cycle,
        attemptCount: incident.attemptCount, attemptLedger: ledger, activeBatchId: null,
      });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } }))
        .toMatchObject({ status: "RETRYABLE_FAILED", ownerThreadId: owner, completedAt, summary: { closeout } });
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(originalJob);
      if (scenario === "automatic") {
        const nextParent = randomUUID(); batchOwners.push(nextParent);
        const dispatcher = await import("@/lib/automation/course-support-course-dispatch");
        expect(await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha: "b".repeat(40), maxStarts: 1, now }))
          .toMatchObject({ acquired: true, value: { launchItems: [expect.objectContaining({ assignmentRef: expect.any(String) })] } });
      }
      await monitoring.reconcileCourseMonitoringDeadlines({ courseIds: [f.course.id], source: "RECOVERY_CRON", now });
      expect(await client.courseMonitoringEvent.count({ where: { incidentId: incident.id,
        audit: { path: ["action"], equals: "unused_completed_discovery_implementation_deadline_continuation" } } }))
        .toBe(scenario === "automatic" ? 1 : 0);
    });

  it.each(["data-only", "claimed-code", "cancelled", "changed-source"])("corrects only the unowned misclassified %s full repair, preserving prior evidence", async scenario => {
    const f = await failed();
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    await client.courseSupportIncident.update({ where: { courseId: f.course.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const owner = `data-only-recovery-${randomUUID()}`; batchOwners.push(owner);
    const lane = await import("@/lib/automation/course-support-batches");
    await lane.claimCourseSupportBatch({ ownerThreadId: owner, branch: "automation/course-support-data-only", baseSha: "a".repeat(40), maxCourses: 1 });
    const batch = await client.courseSupportBatch.findFirstOrThrow({ where: { ownerThreadId: owner } });
    const incident = await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } });
    const closeout = { outcome: "needs_human", reason: "expired_implementation_stopped_without_proof", remediationAttemptConsumed: false };
    // Exact historical bug shape; production correction must preserve this.
    await client.courseSupportBatch.update({ where: { id: batch.id }, data: { status: "PARTIAL", completedAt: new Date(),
      releaseSha: batch.baseSha, summary: { ...(batch.summary as Prisma.JsonObject), closeout,
        plannedPaths: scenario === "claimed-code" ? ["src/lib/adapters/claimed.ts"] : [] } } });
    await client.courseSupportBatchIncident.updateMany({ where: { batchId: batch.id }, data: { result: "NEEDS_HUMAN" } });
    await client.courseSupportIncident.update({ where: { id: incident.id }, data: { status: "NEEDS_HUMAN", activeBatchId: null,
      humanReviewReason: "AUTOMATION_STALLED", nextAttemptAt: null } });
    await client.courseMonitoringStatus.update({ where: { courseId: f.course.id }, data: { state: "ENGINEERING_VERIFICATION_NEEDED" } });
    if (scenario === "cancelled") await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED" } });
    if (scenario === "changed-source") await client.course.update({ where: { id: f.course.id }, data: { website: "https://changed.example.com/" } });
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    expect(await client.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } }))
      .toMatchObject({ status: scenario === "data-only" ? "AUTO_INVESTIGATING" : "NEEDS_HUMAN", cycle: incident.cycle,
        attemptCount: incident.attemptCount, attemptLedger: incident.attemptLedger, activeBatchId: null });
    const preserved = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(preserved).toMatchObject({ status: "PARTIAL", ownerThreadId: owner, summary: { closeout } });
    expect((preserved.summary as Prisma.JsonObject).dataOnlyFullRepairCorrectionV1 !== undefined).toBe(scenario === "data-only");
    expect(await client.courseSupportBatchIncident.findFirstOrThrow({ where: { batchId: batch.id } })).toMatchObject({ result: "NEEDS_HUMAN" });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "FAILED",
      attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt, completedAt: f.job.completedAt });
    const eventCount = await client.courseMonitoringEvent.count({ where: { incidentId: incident.id, eventType: "REVALIDATION_REQUESTED" } });
    expect(eventCount).toBe(scenario === "data-only" ? 1 : 0);
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    expect(await client.courseMonitoringEvent.count({ where: { incidentId: incident.id, eventType: "REVALIDATION_REQUESTED" } })).toBe(eventCount);
  });
  it.each(["data-only", "published-code", "unpublished-code", "claimed-path", "pending-stopped", "pending-no-checkpoint", "registered-expired"])("keeps failed verification evidence and offers only its original %s Desktop owner a continuation", async scenario => {
    const f = await failed();
    await engineering.reconcileDiscoveryEngineeringHandoffs();
    await client.courseSupportIncident.update({ where: { courseId: f.course.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const parent = randomUUID(), owner = randomUUID(); batchOwners.push(parent, owner);
    const dispatcher = await import("@/lib/automation/course-support-course-dispatch");
    const lane = await import("@/lib/automation/course-support-batches");
    const research = await import("@/lib/automation/course-support-research-context");
    const baseSha = "a".repeat(40);
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: parent, baseSha, maxStarts: 1 });
    if (!plan.acquired || plan.value.launchItems.length !== 1) throw new Error("Expected one real fixture dispatch");
    const assignmentRef = plan.value.launchItems[0].assignmentRef;
    await dispatcher.beginCourseSupportCourseDispatch({ ownerThreadId: parent, assignmentRef });
    await dispatcher.bindCourseSupportCourseDispatch({ ownerThreadId: parent, assignmentRef, childThreadId: owner,
      launcherReceiptPath: join(tmpdir(), randomUUID(), "launcher.receipt.private.json") });
    // This process models the bound child's test session, rather than the
    // previous parent. Runtime identity validation remains enabled.
    vi.stubEnv("CODEX_THREAD_ID", owner);
    expect(await lane.claimCourseSupportBatch({ ownerThreadId: owner, branch: `automation/course-support-${randomUUID()}`,
      baseSha, maxCourses: 1, dispatchAssignmentRef: assignmentRef })).toMatchObject({ outcome: "ready" });
    const batch = await client.courseSupportBatch.findFirstOrThrow({ where: { ownerThreadId: owner } });
    // Exact observed post-verification boundary. Source, cycle, playbook and
    // failed learner clock remain unchanged in this isolated database fixture.
    const code = scenario !== "data-only";
    const claimed = scenario === "claimed-path";
    const registered = scenario === "registered-expired";
    const pending = scenario.startsWith("pending-") || registered;
    const plannedPath = "src/lib/adapters/example.ts";
    await client.courseSupportBatch.update({ where: { id: batch.id }, data: { status: claimed ? "IMPLEMENTING" : "VERIFYING", releaseSha: code && !claimed ? "c".repeat(40) : baseSha,
      deployedAt: scenario === "published-code" || pending && !registered || claimed ? batch.createdAt : null,
      summary: { ...(batch.summary as Prisma.JsonObject), plannedPaths: registered
        ? [plannedPath, ...Array.from({ length: 37 }, (_, index) => `src/lib/previous-fix-${index}.ts`)] : code ? [plannedPath] : [],
        ...(registered ? { searchExecutionFence: null, recheckDispatch: null, releaseProvenance: { schemaVersion: 1,
          fromSha: baseSha, toSha: "c".repeat(40), branch: (batch.summary as Prisma.JsonObject).branch,
          committedPaths: [plannedPath], descendantVerified: true } } : {}),
        ...(scenario === "pending-stopped" ? { ownerFailureCheckpoints: [{ schemaVersion: 1, stage: "VERIFICATION",
          failureDomain: "PRODUCTION_VERIFICATION", reasonCode: "VERIFICATION_TOOLING_FAILED", recordedAt: new Date().toISOString() }] } : {}) } } });
    await client.courseSupportBatchIncident.updateMany({ where: { batchId: batch.id }, data: { result: pending ? "PENDING" : "STALE_EVIDENCE", verifiedAt: new Date() } });
    if (scenario === "data-only") {
      const before = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(await lane.heartbeatCourseSupportBatch({ batchId: batch.id, leaseToken: batch.leaseToken,
        ownerThreadId: owner, status: "IMPLEMENTING" })).toMatchObject({ outcome: "implementation_path_required",
          stateChanged: false, heartbeatRecorded: false, requiredAction: "CLAIM_IMPLEMENTATION_PATH" });
      const after = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(after).toEqual(before);
    }
    expect(await research.getOwnedCourseSupportResearchContext({ batchId: batch.id, leaseToken: batch.leaseToken,
      ownerThreadId: owner, ordinal: 1 })).toMatchObject({ outcome: "ready", researchContextV1: { monitoringProofRecorded: false } });
    const leaseExpiresAt = registered ? new Date(Date.now() - 1000) : batch.leaseExpiresAt;
    if (registered) {
      const live = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: parent, baseSha, maxStarts: 1 });
      expect(live).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [] } });
      await client.courseSupportBatch.update({ where: { id: batch.id }, data: { leaseExpiresAt } });
    }
    const nextParent = randomUUID(); batchOwners.push(nextParent);
    const next = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
    expect(next).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: ["unpublished-code", "pending-no-checkpoint"].includes(scenario) ? [] : [{ threadId: owner,
      assignmentRef, batchReference: batch.reference, kind: "OWNED_OUTDOOR_FULL_REPAIR",
      continuationMode: registered ? "REGISTERED_IMPLEMENTATION" : claimed ? "CLAIMED_IMPLEMENTATION" : code ? "PUBLISHED_IMPLEMENTATION" : "DATA_ONLY",
      ...(claimed || registered ? { plannedPaths: [plannedPath] } : {}),
      continuationTrigger: "UNFINISHED_FULL_REPAIR" }] } });
    expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } }))
      .toMatchObject({ ownerThreadId: owner, leaseToken: batch.leaseToken, leaseExpiresAt });
    expect(await client.courseSupportBatchIncident.findFirstOrThrow({ where: { batchId: batch.id } }))
      .toMatchObject({ result: pending ? "PENDING" : "STALE_EVIDENCE" });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
      .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
    if (claimed) {
      await client.courseSupportBatch.update({ where: { id: batch.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      expect(await lane.recoverCourseSupportBatch({ batchId: batch.id, requestingThreadId: owner,
        currentBranch: String((batch.summary as Prisma.JsonObject).branch), currentHeadSha: "d".repeat(40), dirtyPaths: [],
        releaseIsPublished: true, currentHeadIsPublished: true, baseIsAncestor: true, releaseIsAncestor: true,
        releaseCommittedPaths: ["src/lib/automation/shared-runtime.ts"] })).toMatchObject({ outcome: "ready", recovered: true });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        ownerThreadId: owner, releaseSha: baseSha, summary: { plannedPaths: ["src/lib/adapters/example.ts"],
          publishedRuntimeRecoveryV1: { runtimeSha: "d".repeat(40), registeredReleaseSha: baseSha, implementationProofChanged: false } },
      });
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
    }
    if (scenario === "published-code") {
      await client.courseSupportBatch.update({ where: { id: batch.id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      const waiting = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } });
      const competingOwner = randomUUID(); batchOwners.push(competingOwner);
      const competing = await client.courseSupportBatch.create({ data: {
        reference: randomUUID(), ownerThreadId: competingOwner, providerFamilyKey: "OTHER_PROVIDER",
        failureFingerprint: "OTHER_SOURCE", status: "IMPLEMENTING", leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 900_000), heartbeatAt: new Date(), baseSha,
        summary: { plannedPaths: ["src/lib/adapters/another-provider.ts"],
          dispatchAssignmentRef: `course-assignment-${randomUUID()}`, dispatchCourseDigest: "e".repeat(64) },
      } });
      // The actual planner must not spend this runtime's one-use Desktop intent
      // while the original owner's recovery would only return deferred_busy.
      const busy = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
      expect(busy).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [] } });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(waiting);
      await client.courseSupportBatch.update({ where: { id: competing.id }, data: { status: "PARTIAL", completedAt: new Date() } });
      const freed = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
      expect(freed).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [{ threadId: owner,
        assignmentRef, batchReference: batch.reference, continuationMode: "PUBLISHED_IMPLEMENTATION" }] } });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(waiting);
      expect(await lane.recoverCourseSupportBatch({ batchId: batch.id, requestingThreadId: owner,
        currentBranch: String((batch.summary as Prisma.JsonObject).branch), currentHeadSha: "d".repeat(40), dirtyPaths: [],
        releaseIsPublished: true, currentHeadIsPublished: true, baseIsAncestor: true, releaseIsAncestor: true,
        releaseCommittedPaths: ["src/lib/automation/shared-runtime.ts"] })).toMatchObject({ outcome: "ready", recovered: true });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toMatchObject({
        ownerThreadId: owner, releaseSha: "c".repeat(40), summary: { publishedRuntimeRecoveryV1: {
          runtimeSha: "d".repeat(40), registeredReleaseSha: "c".repeat(40), implementationProofChanged: false,
        } },
      });
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
      const recovered = await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } });
      const admission = await service.requestOwnedOutdoorLearningRecovery({ batchId: batch.id, leaseToken: recovered.leaseToken,
        ownerThreadId: owner, releaseSha: "c".repeat(40), runtimeVersion: "d".repeat(40) });
      if (!("jobId" in admission)) throw Error("Expected a distinct owned late learning child");
      for (let attempt = 0; attempt < 2; attempt++) {
        const child = await service.claimNextDiscoveryJob("progress-fixture", "d".repeat(40));
        expect(child?.id).toBe(admission.jobId);
        await service.failDiscoveryJob(child!.id, child!.leaseToken!, "TOOL_FAILURE", true);
      }
      // No tooling checkpoint and no new release: this actual reciprocal failed
      // child is sufficient to wake diagnosis, never another learning budget.
      await client.courseSupportBatchIncident.updateMany({ where: { batchId: batch.id }, data: { result: "PENDING" } });
      const failedChild = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: admission.jobId } });
      const progressed = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
      expect(progressed).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [{ threadId: owner,
        failedLearningProgress: { version: 1, jobId: failedChild.id, completedAt: failedChild.completedAt!.toISOString(),
          fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) } }] } });
      expect(await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 }))
        .toMatchObject({ acquired: true, value: { fullRepairContinuationItems: progressed.acquired ? progressed.value.fullRepairContinuationItems : [] } });
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: failedChild.id } })).toEqual(failedChild);
      expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(2);
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } }))
        .toMatchObject({ status: "FAILED", attempts: f.job.attempts, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
    }
    if (registered) {
      const retiredSearch = await client.teeSearch.update({ where: { id: f.search.id },
        data: { status: "COMPLETED", date: new Date(Date.now() - 2 * 86_400_000) }, select: COURSE_DISPATCH_SOURCE_SELECT });
      // Model an alert whose bound date has elapsed; keep its original intent
      // digest and all learning-attempt evidence intact during closeout.
      const originalRun = await client.automationRun.findFirstOrThrow({
        where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, audit: { path: ["assignmentRef"], equals: assignmentRef } },
      });
      const audit = dispatcher.parseCourseDispatchAudit(originalRun.audit)!;
      audit.target.searchRefs[0].intentDigest = createCourseDispatchIntentDigest(retiredSearch);
      await client.automationRun.update({ where: { id: originalRun.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
      const withdrawn = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
      expect(withdrawn).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [{
        threadId: owner, assignmentRef, continuationMode: "REGISTERED_IMPLEMENTATION", expiredDemandRecoveryOnly: true,
      }] } });
      const close = { ownerThreadId: owner, batchRef: batch.reference, registeredReleaseSha: "c".repeat(40) };
      vi.stubEnv("CODEX_THREAD_ID", nextParent);
      await expect(dispatcher.closeExpiredCourseSupportDemand({ ...close, ownerThreadId: nextParent }))
        .rejects.toThrow("EXPIRED_COURSE_DEMAND_PROOF_REQUIRED");
      vi.stubEnv("CODEX_THREAD_ID", owner);
      const oldJob = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
      const currentSearch = await client.teeSearch.create({ data: { userId: f.search.userId, mode: "OUTDOOR",
        date: f.search.date, startTime: f.search.startTime, endTime: f.search.endTime, players: f.search.players,
        userTimeZone: "UTC", trafficClass: "PUBLIC", preferences: { create: { courseId: f.course.id, rank: 1 } } } });
      ids.add(currentSearch.id);
      expect(await service.ensureDiscoveryJob({ ...f.target, searchId: currentSearch.id })).toBeNull();
      expect(await dispatcher.closeExpiredCourseSupportDemand(close)).toMatchObject({ acquired: true, value: {
        outcome: "expired_demand_released", durableCloseoutRecorded: true, monitoringVerified: false, deliveryVerified: false,
      } });
      expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } }))
        .toMatchObject({ status: "RETRYABLE_FAILED", ownerThreadId: owner, releaseSha: close.registeredReleaseSha, leaseExpiresAt });
      expect(await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } }))
        .toMatchObject({ status: "AUTO_INVESTIGATING", activeBatchId: null, resolution: null });
      expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(oldJob);
      expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id }, select: COURSE_DISPATCH_SOURCE_SELECT }))
        .toEqual(retiredSearch);
      expect(await client.teeTimeMatch.count({ where: { courseId: f.course.id } })).toBe(0);
      expect(await service.ensureDiscoveryJob({ ...f.target, searchId: currentSearch.id }))
        .toMatchObject({ status: "QUEUED", firstPickedUpAt: null, deadlineAt: null,
          request: { demand: { searchId: currentSearch.id } } });
      await expect(dispatcher.closeExpiredCourseSupportDemand(close)).rejects.toThrow("EXPIRED_COURSE_DEMAND_PROOF_REQUIRED");
      return;
    }
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED" } });
    const cancelled = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: nextParent, baseSha, maxStarts: 1 });
    expect(cancelled).toMatchObject({ acquired: true, value: { fullRepairContinuationItems: [] } });
  });
  it.each([["database-null", Prisma.DbNull], ["json-null", Prisma.JsonNull]] as const)("initializes an older unowned %s ledger while preserving its receipt and original failed clock", async (_kind, emptyLedger) => {
    const f = await failed(); await engineering.reconcileDiscoveryEngineeringHandoffs();
    const before = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    await client.courseSupportIncident.update({ where: { courseId: f.course.id }, data: { attemptLedger: emptyLedger } });
    expect(await engineering.reconcileDiscoveryEngineeringHandoffs()).toEqual({ examined: 1, queued: 0 });
    expect((await client.courseSupportIncident.findUniqueOrThrow({ where: { courseId: f.course.id } })).attemptLedger)
      .toEqual({ version: 1, events: [] });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(before);
    expect(await engineering.reconcileDiscoveryEngineeringHandoffs()).toEqual({ examined: 0, queued: 0 });
  });
  it("routes a simulator to exactly its offering incident", async () => {
    const f = await failed(true);
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    expect(await client.simulatorSupportIncident.findUnique({ where: { offeringId: f.offering!.id } }))
      .toMatchObject({ status: "AUTO_INVESTIGATING", reason: "DISCOVERY_CODE_REPAIR" });
    expect(await client.courseSupportIncident.count({ where: { courseId: f.course.id } })).toBe(0);
  });
  async function boundSimulatorHandoff(fullRepair = false) {
    const f = await failed(true);
    expect((await engineering.reconcileDiscoveryEngineeringHandoffs()).queued).toBe(1);
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { offeringId: f.offering!.id } });
    const fingerprint = getSimulatorOfferingSourceFingerprint(f.offering!), now = new Date(), baseSha = "a".repeat(40);
    const demand = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const repair = fullRepair ? await (await import("@/lib/automation/simulator-full-repair")).currentSimulatorFullRepair(client, {
      courseId: f.course.id, offeringId: f.offering!.id, incidentId: incident.id, offeringSourceFingerprint: fingerprint }, now) : null;
    if (fullRepair) expect(repair).not.toBeNull();
    const assignmentRef = `course-assignment-${randomUUID()}`, child = `handoff-child-${randomUUID()}`;
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: "course-support-course-dispatch-v1",
      ownerThreadId: "handoff-parent", audit: { schemaVersion: 1, tickRef: "fixture", assignmentRef, state: "BOUND", ownerThreadId: "handoff-parent",
        childThreadId: child, baseSha, reservedAt: now.toISOString(), launchStartedAt: now.toISOString(), boundAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 600_000).toISOString(), target: { mode: "SIMULATOR", offeringId: f.offering!.id,
          offeringSourceFingerprint: fingerprint, ...(repair ? { fullRepair: repair } : {}), incidentId: incident.id, courseId: f.course.id, cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING",
          failureFingerprint: fingerprint, updatedAt: incident.updatedAt.toISOString(), trafficClass: "REAL", searchRefs: [{ id: f.search.id,
            scheduleVersion: f.search.scheduleVersion, alertGeneration: f.search.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(demand) }] } } } });
    runs.push(run.id);
    const lane = await import("@/lib/automation/simulator-support-ownership");
    return { ...f, incident, run, assignmentRef, child, claim: () => lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha,
      branch: "automation/course-support-discovery-claim" }) };
  }

  it.each(["RESEARCH", "SETTLED_READ_FAILURE"] as const)("projects a stopped simulator %s without replacing its assignment or holding a deployed writer", async mode => {
    const f = await boundSimulatorHandoff(true);
    const { parseCourseDispatchAudit, planCourseSupportCourseDispatch, hasSimulatorSupportImplementationOwnership } =
      await import("@/lib/automation/course-support-course-dispatch");
    const claimed = await f.claim();
    if (!claimed.acquired) throw Error("Simulator ownership unavailable in fixture.");
    const row = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = parseCourseDispatchAudit(row.audit)!, claim = audit.simulatorClaim!;
    const requestId = randomUUID(), failed = mode === "SETTLED_READ_FAILURE", releaseSha = "b".repeat(40);
    audit.launcherReceiptPath = join(tmpdir(), "original-simulator", "launcher.receipt.private.json");
    claim.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    if (failed) Object.assign(claim, { phase: "VERIFYING", releaseSha,
      plannedPaths: ["src/lib/course-discovery/test-reader.ts"], deployment: { source: "git", state: "READY", branch: "main",
        commitSha: releaseSha, deploymentId: "dpl_fixture", deploymentUrl: "https://fixture.vercel.app",
        aliases: ["teetimespot.com", "www.teetimespot.com"], deployedAt: new Date().toISOString() },
    });
    audit.simulatorResearch = { version: 1, sourceFingerprint: claim.sourceFingerprint, readCount: 1,
      links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null, history: [{ source: "official",
        requestedUrl: f.course.website, sourceUrl: f.course.website, sourceFingerprint: claim.sourceFingerprint,
        observedAt: new Date().toISOString(), requestId, rendered: true,
        ...(failed ? { outcome: "HARD_FAILED", httpStatus: 0, failure: { stage: "PUBLIC_READ", category: "ACCESS",
          code: "PUBLIC_REDIRECT_NOT_ELIGIBLE", researchPhase: "BROWSER_REQUEST" } } : { outcome: "READ", httpStatus: 200 }) }] };
    const persisted = await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    expect(await client.$transaction(tx => hasSimulatorSupportImplementationOwnership(tx))).toBe(false);
    const parent = `resume-parent-${randomUUID()}`;
    batchOwners.push(parent);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: parent, baseSha: "c".repeat(40), maxStarts: 1 });
    expect(plan).toMatchObject({ acquired: true, value: { launchItems: [], continuationItems: [{
      threadId: f.child, assignmentRef: f.assignmentRef, simulatorOwnedRecovery: mode,
      checkpoint: { claimLeaseExpired: true, providerReadInFlight: false, readCount: 1, requestId: failed ? requestId : null,
        ownedStage: { phase: failed ? "VERIFYING" : "CLAIMED", fullRepair: { failedJobId: f.job.id } } },
    }] } });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: row.id } })).audit).toEqual(persisted.audit);
    expect(await client.courseDiscoveryJob.count({ where: { offeringId: f.offering!.id } })).toBe(1);
  });

  it.each(["replayed", "failed", "prepared", "registered"])("keeps the same original simulator owner through a %s repair", async scenario => {
    const f = await boundSimulatorHandoff(true);
    const lane = await import("@/lib/automation/simulator-support-ownership");
    const { parseCourseDispatchAudit, planCourseSupportCourseDispatch } = await import("@/lib/automation/course-support-course-dispatch");
    const claimed = await f.claim();
    if (!claimed.acquired) throw Error("Simulator ownership unavailable in fixture.");
    const current = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = parseCourseDispatchAudit(current.audit)!;
    const registeredRelease = "b".repeat(40), runtimeVersion = "c".repeat(40);
    // Release proof comes from the Git deployment boundary in production.
    audit.launcherReceiptPath = join(tmpdir(), "original-simulator", "launcher.receipt.private.json");
    Object.assign(audit.simulatorClaim!, { phase: "VERIFYING", releaseSha: registeredRelease,
      leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
      plannedPaths: ["src/lib/course-discovery/test-reader.ts"],
      deployment: scenario === "registered" ? null : { source: "git", state: "READY", branch: "main", commitSha: registeredRelease,
        deploymentId: "dpl_fixture", deploymentUrl: "https://fixture.vercel.app",
        aliases: ["teetimespot.com", "www.teetimespot.com"], deployedAt: new Date().toISOString() } });
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const scheduler = `recovery-parent-${randomUUID()}`;
    batchOwners.push(scheduler);
    const plan = await planCourseSupportCourseDispatch({ ownerThreadId: scheduler, baseSha: runtimeVersion, maxStarts: 1 });
    if (scenario === "registered") {
      expect(plan).toMatchObject({ acquired: true, value: { continuationItems: [{
        assignmentRef: f.assignmentRef, threadId: f.child, simulatorRegisteredRelease: true, releaseSha: registeredRelease,
        checkpoint: { kind: "EXPIRED_OWNED_STAGE", providerReadInFlight: false, ownedStage: {
          phase: "VERIFYING", deployment: null, leaseExpiresAt: audit.simulatorClaim!.leaseExpiresAt, fullRepair: { failedJobId: f.job.id },
        } },
      }], launchItems: [] } });
      expect(await client.courseDiscoveryJob.count({ where: { offeringId: f.offering!.id } })).toBe(1);
      return;
    }
    expect(plan).toMatchObject({ acquired: true, value: {
      continuationItems: [{ assignmentRef: f.assignmentRef, threadId: f.child, simulatorLearningRecovery: true,
        checkpoint: { kind: "EXPIRED_OWNED_STAGE", providerReadInFlight: false, ownedStage: {
          phase: "VERIFYING", leaseExpiresAt: audit.simulatorClaim!.leaseExpiresAt, releaseSha: registeredRelease,
          deployment: { commitSha: registeredRelease }, fullRepair: { failedJobId: f.job.id },
        } } }],
      launchItems: [],
    } });
    const resumed = await lane.recoverSimulatorSupport({ assignmentRef: f.assignmentRef, ownerThreadId: f.child,
      token: claimed.value.token, revision: claimed.value.revision });
    if (!resumed.acquired) throw Error("Original simulator could not resume its expired lease.");
    const owner = { assignmentRef: f.assignmentRef, ownerThreadId: f.child, token: resumed.value.token, revision: resumed.value.revision,
      registeredRelease, runtimeVersion };
    await expect(lane.requestSimulatorLearningRecovery({ ...owner, ownerThreadId: "different-chat" })).rejects.toThrow();
    expect(await service.ensureDiscoveryJob({ ...f.target, searchId: f.search.id })).toBeNull();
    const admitted = await lane.requestSimulatorLearningRecovery(owner);
    if (!admitted.acquired || admitted.value.outcome !== "created") throw Error("Expected one late learner.");
    expect(await lane.requestSimulatorLearningRecovery(owner)).toMatchObject({ acquired: true,
      value: { outcome: "existing", jobId: admitted.value.jobId } });
    expect(await service.claimNextDiscoveryJob("stale-runtime", registeredRelease)).toBeNull();
    const pickedUp = await service.claimNextDiscoveryJob("fixture-sol-simulator", runtimeVersion);
    expect(pickedUp).toMatchObject({ id: admitted.value.jobId, offeringId: f.offering!.id, attempts: 1 });
    if (scenario === "prepared") {
      await service.failDiscoveryJob(pickedUp!.id, pickedUp!.leaseToken!, "TOOL_FAILURE", false);
      const currentRun = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
      const snapshot = parseCourseDispatchAudit(currentRun.audit)!;
      const fingerprint = snapshot.simulatorClaim!.sourceFingerprint, bookingUrl = "https://golf.example.com/rentals";
      const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", target: { ...f.target, kind: "SIMULATOR" },
        source: { venueName: f.course.name, officialUrl: f.course.website, bookingUrl, timeZone: "UTC", providerFamily: "EXAMPLE" },
        pageUrl: bookingUrl, steps: [],
        permittedRoutes: [{ origin: "https://golf.example.com", path: "/rentals", methods: ["GET"], queryKeys: [] },
          { origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
        availabilityResponse: { url: "https://golf.example.com/times?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
        proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#loaded" }, durationMinutes: { selector: "#duration" } },
        slots: { scope: { selector: "article.resource", label: { selector: "h2" }, expectedLabel: "Golf Simulator" },
          collection: { selector: ".slot" }, startsAt: { selector: ".start" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
      await expect(lane.requestSimulatorLearningRecovery({ ...owner, preparedMethod: { recipe } }))
        .rejects.toThrow("SIMULATOR_PREPARED_PUBLIC_SOURCE_REQUIRED");
      snapshot.simulatorResearch = { version: 1, sourceFingerprint: fingerprint, readCount: 1, links: [], bookingLinks: [],
        linkBaseUrl: null, inFlight: null, history: [{ source: "booking", requestedUrl: bookingUrl, sourceUrl: bookingUrl,
          sourceFingerprint: fingerprint, observedAt: new Date().toISOString(), requestId: randomUUID(), httpStatus: 200,
          rendered: true, outcome: "READ", publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true,
            accessControls: [], method: "BROWSER", renderComplete: true } }] };
      await client.automationRun.update({ where: { id: f.run.id }, data: { audit: snapshot as unknown as Prisma.InputJsonValue } });
      const prepared = await lane.requestSimulatorLearningRecovery({ ...owner, preparedMethod: { recipe } });
      if (!prepared.acquired || prepared.value.outcome !== "created") throw Error("The prepared method did not reach independent replay.");
      expect(await lane.requestSimulatorLearningRecovery({ ...owner, preparedMethod: { recipe } })).toMatchObject({
        acquired: true, value: { outcome: "existing", jobId: prepared.value.jobId } });
      const verifier = (await service.claimNextDiscoveryJob("recipe-verifier", runtimeVersion))!;
      expect(verifier.result).toMatchObject({ learningRecoveryOf: { preparedRecipeHash: hashAccessRecipe(recipe) } });
      await expect(service.proposeDiscoveryRecipe(verifier.id, verifier.leaseToken!, { ...recipe, steps: [{ action: "waitFor", selector: ".other" }] },
        { officialUrl: f.course.website, observedBookingUrl: bookingUrl })).rejects.toBeInstanceOf(service.DiscoveryConflictError);
      const proposal = await service.proposeDiscoveryRecipe(verifier.id, verifier.leaseToken!, recipe,
        { officialUrl: f.course.website, observedBookingUrl: bookingUrl });
      expect(proposal.challenges).toHaveLength(2);
      expect(await client.courseOffering.findUnique({ where: { id: f.offering!.id } })).toMatchObject({ activeAccessRecipeId: null });
      expect(await client.courseDiscoveryJob.findUnique({ where: { id: f.job.id } })).toMatchObject({ status: f.job.status,
        firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
      return;
    }
    if (scenario === "failed") {
      const beforeFailure = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: pickedUp!.id } });
      const terminalDiagnostic = { version: 1, failureCode: "DISCOVERY_MODEL_CATALOG_UNAVAILABLE", frameworkPhase: "GENERIC_FALLBACK", errorName: "Error" };
      await service.failDiscoveryJob(pickedUp!.id, pickedUp!.leaseToken!, "TOOL_FAILURE", false, terminalDiagnostic);
      const afterFailure = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: pickedUp!.id } });
      expect(afterFailure.checkpoint).toEqual(beforeFailure.checkpoint);
      expect(afterFailure.firstPickedUpAt).toEqual(beforeFailure.firstPickedUpAt); expect(afterFailure.deadlineAt).toEqual(beforeFailure.deadlineAt);
      expect(afterFailure.result).toMatchObject({ ...(beforeFailure.result as object), workerFailure: { terminal: true, diagnostic: terminalDiagnostic } });
      expect(engineering.discoveryFailureDiagnosis(afterFailure)).toMatchObject({ failureCode: terminalDiagnostic.failureCode, phase: "GENERIC_FALLBACK" });
      expect(await lane.requestSimulatorLearningRecovery(owner)).toMatchObject({ acquired: true,
        value: { outcome: "existing", jobId: pickedUp!.id } });
      const settled = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
      const expired = parseCourseDispatchAudit(settled.audit)!;
      expired.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
      await client.automationRun.update({ where: { id: f.run.id }, data: { audit: expired as unknown as Prisma.InputJsonValue } });
      const next = await planCourseSupportCourseDispatch({ ownerThreadId: scheduler, baseSha: runtimeVersion, maxStarts: 1 });
      expect(next).toMatchObject({ acquired: true, value: { continuationItems: [{
        assignmentRef: f.assignmentRef, threadId: f.child, releaseSha: registeredRelease, simulatorLearningRecovery: true,
        failedLearningProgress: { jobId: pickedUp!.id, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
          simulatorExecutionRuntime: runtimeVersion, simulatorRequestedAt: expect.any(String) },
      }], launchItems: [] } });
      expect(await client.courseDiscoveryJob.count({ where: { offeringId: f.offering!.id } })).toBe(2);
      expect(await client.courseDiscoveryJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
        status: f.job.status, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt });
      return;
    }
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target: { ...f.target, kind: "SIMULATOR" },
      source: { venueName: f.course.name, officialUrl: f.course.website, bookingUrl: "https://golf.example.com/times",
        timeZone: "UTC", providerFamily: "EXAMPLE" },
      request: { url: "https://golf.example.com/times?date={{date}}&duration={{durationMinutes}}", method: "GET" },
      permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date", "duration"] }],
      proof: { venue: { path: "venue" }, date: { path: "date" }, durationMinutes: { path: "duration" },
        complete: { path: "complete" }, empty: { path: "empty" } },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, endsAt: { path: "end" }, availableSpots: { path: "spots" } } });
    const proposed = await service.proposeDiscoveryRecipe(pickedUp!.id, pickedUp!.leaseToken!, recipe);
    await expect(service.activateDiscoveryRecipe(pickedUp!.id, pickedUp!.leaseToken!)).rejects.toThrow();
    for (const challenge of proposed.challenges) await service.recordDiscoveryVerification({ jobId: pickedUp!.id,
      leaseToken: pickedUp!.leaseToken!, challengeId: challenge.id, recipeHash: proposed.recipeHash, input: challenge.input,
      result: { status: "AVAILABLE", complete: true, observedAt: new Date().toISOString(), sourceUrl: recipe.source.bookingUrl,
        slots: [{ sourceId: `fixture-${challenge.input.date}`, startsAt: `${challenge.input.date}T10:00:00.000Z`,
          endsAt: `${challenge.input.date}T11:00:00.000Z`, availableSpots: 1, bookingUrl: recipe.source.bookingUrl }],
        evidence: { recipeHash: proposed.recipeHash, venueVerified: true, dateVerified: true, capacityVerified: true,
          durationVerified: true, completeVerified: true } } });
    const method = await service.activateDiscoveryRecipe(pickedUp!.id, pickedUp!.leaseToken!);
    expect(await service.getActiveAccessRecipe(f.target)).toMatchObject({ record: { id: method.recipeId, hash: method.hash } });
    expect(await client.automationRun.findUnique({ where: { id: f.run.id } })).toMatchObject({ status: "COMPLETED",
      outcome: "simulator_method_replayed", audit: { learningRecoveryHandoff: { recipeId: method.recipeId,
        phase: "METHOD_REPLAYED_MONITORING_PENDING", recovery: { originalJobId: f.job.id, jobId: pickedUp!.id } } } });
    expect(await client.courseDiscoveryJob.findUnique({ where: { id: f.job.id } })).toMatchObject({
      status: f.job.status, firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt, completedAt: f.job.completedAt,
      attempts: f.job.attempts, outcome: f.job.outcome });
    expect(await client.simulatorSupportIncident.findUnique({ where: { id: f.incident.id } }))
      .toMatchObject({ status: "AUTO_INVESTIGATING" });
  }, 25_000);

  it("keeps a full simulator repair through a denied read, retry, and expired executor without resetting the failed learner", async () => {
    const f = await boundSimulatorHandoff(true), lane = await import("@/lib/automation/simulator-support-ownership");
    const originalJob = await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } });
    const { parseCourseDispatchAudit } = await import("@/lib/automation/course-support-course-dispatch");
    const admission = await f.claim();
    expect(admission.acquired).toBe(true);
    if (!admission.acquired) throw new Error("Fixture did not acquire source ownership");
    const claimed = admission.value;
    const owner = { assignmentRef: f.assignmentRef, ownerThreadId: f.child, token: claimed.token, revision: claimed.revision };
    expect(claimed).toMatchObject({ fullRepair: { failedJobId: f.job.id }, fullRepairActions: expect.arrayContaining(["IMPLEMENT_REUSABLE_SUPPORT"]) });
    await expect(lane.readSimulatorSupportSource({ ...owner, source: "official", rendered: true }, {
      browser: async () => { throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED"); },
    })).rejects.toThrow("SIMULATOR_RESEARCH_HARD_FAILED");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = parseCourseDispatchAudit(stored.audit)!;
    expect(stored).toMatchObject({ status: "RUNNING", completedAt: null });
    expect(audit.simulatorResearch!.history.at(-1)).toMatchObject({ outcome: "HARD_FAILED", failure: { code: "PUBLIC_DESTINATION_CHANGED" } });
    expect(await lane.retrySimulatorSupport({ ...owner, revision: audit.simulatorClaim!.revision, retryMinutes: 15 }))
      .toMatchObject({ acquired: true, value: { outcome: "repair_required", ownershipRetained: true, monitoringVerified: false, deliveryVerified: false } });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(stored);
    const browser = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...owner, revision: audit.simulatorClaim!.revision, source: "official", rendered: true }, { browser })).rejects.toThrow();
    expect(browser).not.toHaveBeenCalled();
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    await lane.reconcileExpiredSimulatorResearchExecutions(client, new Date(), [{ id: f.run.id, status: "RUNNING", parsed: audit }]);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "RUNNING" });
    const context = await lane.readSimulatorSupportContinuationContext(client, audit, new Date());
    expect(context.checkpoint).toMatchObject({ kind: "EXPIRED_OWNED_STAGE", ownedStage: { phase: "CLAIMED", fullRepair: { failedJobId: f.job.id } } });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toEqual(originalJob);
    const candidates = await (await import("@/lib/automation/simulator-support-incidents")).listSimulatorSupportDispatchCandidates(new Date(), client);
    expect(candidates.filter(row => row.offeringId === f.offering!.id)).toEqual([]);
  });
  it.each(["paused", "changed-source", "withdrawn-handoff", "reader-only"])("rejects stale full simulator repair authority: %s", async reason => {
    const f = await boundSimulatorHandoff(true);
    if (reason === "paused") await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } });
    if (reason === "changed-source") await client.courseOffering.update({ where: { id: f.offering!.id }, data: { bookingUrl: "https://changed.example.com/" } });
    if (reason === "withdrawn-handoff") await client.courseDiscoveryJob.update({ where: { id: f.job.id }, data: { result: { unavailable: true } } });
    if (reason === "reader-only") await client.course.update({ where: { id: f.course.id }, data: { monitoringMode: "LOCAL_READER_ONLY" } });
    await expect(f.claim()).rejects.toThrow();
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({ state: "BOUND" });
  });
  it("admits full simulator repair after exhausted legacy research while preserving its denied routes and deduplicating the failed learner", async () => {
    const f = await boundSimulatorHandoff(), lane = await import("@/lib/automation/simulator-support-ownership");
    const incidents = await import("@/lib/automation/simulator-support-incidents");
    const { parseCourseDispatchAudit } = await import("@/lib/automation/course-support-course-dispatch");
    const admission = await f.claim();
    if (!admission.acquired) throw new Error("Fixture did not acquire legacy source");
    await expect(lane.readSimulatorSupportSource({ assignmentRef: f.assignmentRef, ownerThreadId: f.child,
      token: admission.value.token, revision: admission.value.revision, source: "official", rendered: true }, {
      browser: async () => { throw new Error("SIMULATOR_RESEARCH_DESTINATION_CHANGED"); },
    })).rejects.toThrow("SIMULATOR_RESEARCH_HARD_FAILED");
    const previous = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(previous).toMatchObject({ status: "COMPLETED", outcome: "simulator_research_failed" });
    await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(Date.now() - 1000) } });
    const [candidate] = (await incidents.listSimulatorSupportDispatchCandidates(new Date(), client)).filter(row => row.offeringId === f.offering!.id);
    expect(candidate).toMatchObject({ fullRepair: { failedJobId: f.job.id, incidentId: f.incident.id } });
    const priorAudit = parseCourseDispatchAudit(previous.audit)!;
    const assignmentRef = `new-repair-${randomUUID()}`, child = `new-original-${randomUUID()}`, now = new Date();
    const nextAudit = { ...priorAudit, assignmentRef, state: "BOUND" as const, childThreadId: child,
      simulatorClaim: undefined, simulatorResearch: undefined, simulatorResearchPriorFailures: undefined,
      consumedAt: undefined, reservedAt: now.toISOString(), launchStartedAt: now.toISOString(), boundAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 600_000).toISOString(),
      target: { ...priorAudit.target, updatedAt: candidate.updatedAt, fullRepair: candidate.fullRepair } };
    const next = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: previous.promptVersion,
      ownerThreadId: previous.ownerThreadId, audit: JSON.parse(JSON.stringify(nextAudit)) as Prisma.InputJsonValue } });
    runs.push(next.id);
    const granted = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha: priorAudit.baseSha,
      branch: "automation/course-support-full-repair-fixture" });
    expect(granted).toMatchObject({ acquired: true, value: { fullRepair: candidate.fullRepair } });
    const consumed = parseCourseDispatchAudit((await client.automationRun.findUniqueOrThrow({ where: { id: next.id } })).audit)!;
    expect(consumed.simulatorResearchPriorFailures).toMatchObject({ routes: [{ url: f.course.website, rendered: true,
      failure: { code: "PUBLIC_DESTINATION_CHANGED" } }] });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(previous);
    expect((await incidents.listSimulatorSupportDispatchCandidates(new Date(), client)).filter(row => row.offeringId === f.offering!.id)).toEqual([]);
    // Even a previously bound duplicate cannot claim after this owner finishes.
    await client.automationRun.update({ where: { id: next.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const duplicate = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: previous.promptVersion,
      ownerThreadId: previous.ownerThreadId, audit: JSON.parse(JSON.stringify({ ...nextAudit, assignmentRef: `${assignmentRef}-duplicate` })) as Prisma.InputJsonValue } });
    runs.push(duplicate.id);
    await expect(lane.claimSimulatorSupportAssignment({ assignmentRef: `${assignmentRef}-duplicate`, ownerThreadId: child,
      baseSha: priorAudit.baseSha, branch: "automation/course-support-full-repair-fixture" })).rejects.toThrow("original consumed owner");
  });
  it.each(["cancelled", "source-changed", "recovered"])("retires only the ungranted full simulator repair when %s", async reason => {
    const f = await boundSimulatorHandoff(true), lane = await import("@/lib/automation/simulator-support-ownership");
    const { parseCourseDispatchAudit } = await import("@/lib/automation/course-support-course-dispatch");
    expect((await f.claim()).acquired).toBe(true);
    const audit = parseCourseDispatchAudit((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit)!;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    if (reason === "cancelled") await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "CANCELLED" } });
    if (reason === "source-changed") await client.courseOffering.update({ where: { id: f.offering!.id }, data: { bookingUrl: "https://changed.example.com/" } });
    if (reason === "recovered") await client.courseProbe.create({ data: { teeSearchId: f.search.id, courseId: f.course.id,
      offeringId: f.offering!.id, outcome: "MATCH_FOUND" } });
    if (reason === "recovered") expect(await lane.readSimulatorSupportContinuationContext(client, audit, new Date()))
      .toMatchObject({ checkpoint: null, leaseValid: false });
    else await expect(lane.readSimulatorSupportContinuationContext(client, audit, new Date())).rejects.toThrow();
    await lane.reconcileExpiredSimulatorResearchExecutions(client, new Date(), [{ id: f.run.id, status: "RUNNING", parsed: audit }]);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "COMPLETED",
      outcome: reason === "cancelled" ? "simulator_source_withdrawn" : "simulator_source_changed", audit: { simulatorClaim: { plannedPaths: [] } } });
    expect(await client.courseDiscoveryJob.findUniqueOrThrow({ where: { id: f.job.id } })).toMatchObject({ status: "FAILED",
      firstPickedUpAt: f.job.firstPickedUpAt, deadlineAt: f.job.deadlineAt, attempts: f.job.attempts });
  });
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
