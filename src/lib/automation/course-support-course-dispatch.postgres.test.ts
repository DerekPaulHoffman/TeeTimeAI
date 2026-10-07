// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient, type SearchStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createCourseDispatchIntentDigest } from "./course-support-dispatch-intent";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT, type SimulatorSupportSource } from "./simulator-support-policy";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ prisma: client }));
const routing = vi.hoisted(() => ({ outdoorCandidates: [] as Array<{
  incidentId: string; courseId: string; cycle: number; providerFamilyKey: string;
  failureFingerprint: string; updatedAt: string; activeRealSearchCount: number; engineeringOnly: boolean;
}> }));
// Outdoor remediation routing is independent of the cohort budget. Keep its
// fixtures bounded while exercising the real writer lease and serializable planner.
vi.mock("./course-support-batches", async importOriginal => ({
  ...(await importOriginal<typeof import("./course-support-batches")>()),
  listCourseSupportDispatchCandidates: async () => routing.outdoorCandidates,
}));

const databaseUrl = process.env.SIMULATOR_TEST_DATABASE_URL;
const baseSha = "a".repeat(40);
const owner = `isolated-planner-${randomUUID()}`;
const ids = { users: [] as string[], courses: [] as string[], searches: [] as string[], runs: [] as string[], batches: [] as string[] };
let dispatcher: typeof import("./course-support-course-dispatch");

describe.skipIf(!databaseUrl)("course dispatcher context budgets in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/simulator_preview" ||
        !["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("Only isolated localhost simulator_preview is permitted.");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl!, connectionTimeoutMillis: 5_000 }) });
    await client.$connect();
    dispatcher = await import("./course-support-course-dispatch");
    if (await client.automationRun.count({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, status: "RUNNING" } }) ||
        await client.courseSupportBatch.count({ where: { status: { in: ["CLAIMED", "IMPLEMENTING", "VERIFYING"] } } })) {
      throw new Error("The isolated planner harness contains unrelated occupied work; do not remove or replace it.");
    }
  });

  async function cleanup() {
    if (!client) return;
    await client.courseSupportBatch.deleteMany({ where: { id: { in: ids.batches } } });
    // Include reservations made before a failed assertion: they are scoped by
    // fixture course identity, never by global dispatcher status or timestamp.
    if (ids.runs.length || ids.courses.length) await client.automationRun.deleteMany({ where: {
      OR: [{ id: { in: ids.runs } }, ...ids.courses.map(courseId => ({
        promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        audit: { path: ["target", "courseId"], equals: courseId },
      }))],
    } });
    await client.teeSearch.deleteMany({ where: { id: { in: ids.searches } } });
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    Object.values(ids).forEach(list => { list.length = 0; });
    routing.outdoorCandidates.length = 0;
  }
  afterEach(cleanup);
  afterAll(async () => { await cleanup(); if (client) await client.$disconnect(); });

  async function venue() {
    const suffix = randomUUID();
    const course = await client.course.create({ data: {
      googlePlaceId: suffix, name: `Isolated planner ${suffix}`, latitude: 41, longitude: -73,
      timeZone: "America/New_York", website: "https://official.example.test", isPublic: true,
    } }); ids.courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED" } });
    const incident = await client.simulatorSupportIncident.create({ data: { offeringId: offering.id, reason: "NEEDS_ADAPTER", retryAt: new Date(0) } });
    return { course, offering, incident };
  }

  async function demand(venues: Awaited<ReturnType<typeof venue>>[], now: Date, options: { mode?: "OUTDOOR" | "SIMULATOR"; synthetic?: boolean } = {}) {
    const suffix = randomUUID();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const search = await client.teeSearch.create({ data: {
      userId: user.id, mode: options.mode ?? "SIMULATOR", durationMinutes: options.mode === "OUTDOOR" ? null : 60,
      date: new Date(now.getTime() + 2 * 86_400_000), startTime: "09:00", endTime: "18:00", players: 1,
      userTimeZone: "America/New_York", status: "ACTIVE", trafficClass: options.synthetic ? "TEST" : "PUBLIC",
      syntheticMultiCycle: options.synthetic ?? false,
      preferences: { create: venues.map((v, index) => ({ courseId: v.course.id,
        offeringId: options.mode === "OUTDOOR" ? null : v.offering.id, rank: index + 1 })) },
    }, select: SIMULATOR_SUPPORT_SOURCE_SELECT }); ids.searches.push(search.id);
    return search;
  }

  async function starting(v: Awaited<ReturnType<typeof venue>>, search: SimulatorSupportSource, now: Date, sameTick = false) {
    const time = sameTick ? now : new Date(now.getTime() - 3_600_000);
    const simulator = search.mode === "SIMULATOR";
    const fingerprint = getSimulatorOfferingSourceFingerprint(v.offering);
    const incident = simulator ? v.incident : await client.courseSupportIncident.create({ data: {
      reference: randomUUID(), courseId: v.course.id, kind: "NEEDS_ADAPTER", status: "NEEDS_HUMAN",
      providerFamilyKey: "TEST_ROUTING", failureFingerprint: "TEST", courseNameSnapshot: v.course.name, platformSnapshot: "UNKNOWN",
    } });
    const audit: import("./course-support-course-dispatch").CourseDispatchAudit = {
      schemaVersion: 1, tickRef: `course-${Math.floor(time.getTime() / 600_000)}`, assignmentRef: `course-assignment-${randomUUID()}`,
      state: "STARTING", ownerThreadId: owner, childThreadId: null, baseSha,
      reservedAt: time.toISOString(), expiresAt: new Date(time.getTime() + 600_000).toISOString(), launchStartedAt: time.toISOString(),
      target: { ...(simulator ? { mode: "SIMULATOR" as const, offeringId: v.offering.id, offeringSourceFingerprint: fingerprint } : {}),
        incidentId: incident.id, courseId: v.course.id, cycle: 1, providerFamilyKey: simulator ? "SIMULATOR_SOURCE_PENDING" : "TEST_ROUTING",
        failureFingerprint: simulator ? fingerprint : "TEST", updatedAt: incident.updatedAt.toISOString(), trafficClass: search.syntheticMultiCycle ? "SYNTHETIC" : "REAL",
        searchRefs: [{ id: search.id, scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration,
          intentDigest: simulator ? createSimulatorSupportIntentDigest(search) : createCourseDispatchIntentDigest(search) }] },
    };
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
      ownerThreadId: owner, runtimeVersion: baseSha, auditSchemaVersion: 1, audit: audit as unknown as Prisma.InputJsonValue, startedAt: time } });
    ids.runs.push(run.id); return run;
  }

  async function freshContexts(now: Date) {
    const sources = [];
    for (let i = 0; i < 3; i++) { const v = await venue(); sources.push(await demand([v], now)); }
    return sources;
  }

  async function selectedSearchIds() {
    const runs = await client.automationRun.findMany({ where: { ownerThreadId: owner, promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION } });
    return runs.flatMap(run => { const audit = dispatcher.parseCourseDispatchAudit(run.audit); return audit?.state === "RESERVED" ? audit.target.searchRefs.map(ref => ref.id) : []; });
  }

  async function planAt(now: Date) {
    const result = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: owner, baseSha, now });
    expect(result.acquired).toBe(true);
    if (!result.acquired) throw new Error("The isolated planner writer lease was unexpectedly busy.");
    return result.value;
  }

  it("frees ended, cancelled, completed and expired-synthetic contexts without releasing their STARTING slots", async () => {
    const now = new Date(); const preserved = [];
    for (const state of ["COMPLETED", "CANCELLED", "WINDOW_ENDED", "SYNTHETIC_EXPIRED"] as const) {
      const v = await venue(); const search = await demand([v], now, { synthetic: state === "SYNTHETIC_EXPIRED" });
      if (state === "WINDOW_ENDED") await client.teeSearch.update({ where: { id: search.id }, data: { date: new Date(now.getTime() - 2 * 86_400_000) } });
      if (state === "SYNTHETIC_EXPIRED") await client.teeSearch.update({ where: { id: search.id }, data: { createdAt: new Date(now.getTime() - 20 * 3_600_000) } });
      const current = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
      preserved.push(await starting(v, current, now));
      if (state === "COMPLETED" || state === "CANCELLED") await client.teeSearch.update({ where: { id: search.id }, data: { status: state as SearchStatus } });
    }
    const fresh = await freshContexts(now);
    const plan = await planAt(now);
    expect(plan.launchItems).toHaveLength(3);
    expect(new Set(await selectedSearchIds())).toEqual(new Set(fresh.map(search => search.id)));
    expect(plan.attention.startingCount).toBe(4);
    expect(plan.occupiedCourseCount).toBe(7);
    for (const run of preserved) expect(await client.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
  });

  it("retains the three-context cap for current active-future STARTING sources", async () => {
    const now = new Date(); const preserved = [];
    for (let i = 0; i < 3; i++) { const v = await venue(); preserved.push(await starting(v, await demand([v], now), now)); }
    const fourth = await venue(); await demand([fourth], now);
    const plan = await planAt(now);
    expect(plan.launchItems).toHaveLength(0);
    expect(plan.occupiedCourseCount).toBe(3);
    expect(plan.attention.startingCount).toBe(3);
    for (const run of preserved) expect(await client.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
  });

  it("keeps fifteen uncertain physical slots occupied even when every source has ended", async () => {
    const now = new Date(); const preserved = [];
    for (let i = 0; i < 15; i++) {
      const v = await venue(); const search = await demand([v], now);
      preserved.push(await starting(v, search, now));
      await client.teeSearch.update({ where: { id: search.id }, data: { status: "CANCELLED" } });
    }
    await freshContexts(now);
    const plan = await planAt(now);
    expect(plan.launchItems).toHaveLength(0);
    expect(plan.attention.startingCount).toBe(15);
    expect(plan.occupiedCourseCount).toBe(15);
    for (const run of preserved) expect(await client.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
  });

  it("excludes changed intent, generation and selected venue while preserving all prior assignments", async () => {
    const now = new Date(); const preserved = [];
    for (const change of ["INTENT", "GENERATION", "RESELECTION", "OUTDOOR_DESELECTION"] as const) {
      const v = await venue(); const search = await demand([v], now, { mode: change === "OUTDOOR_DESELECTION" ? "OUTDOOR" : "SIMULATOR" });
      preserved.push(await starting(v, search, now));
      if (change === "INTENT") await client.teeSearch.update({ where: { id: search.id }, data: { startTime: "10:00" } });
      if (change === "GENERATION") await client.teeSearch.update({ where: { id: search.id }, data: { alertGeneration: { increment: 1 } } });
      if (change === "RESELECTION" || change === "OUTDOOR_DESELECTION") await client.coursePreference.deleteMany({ where: { teeSearchId: search.id } });
    }
    const fresh = await freshContexts(now);
    const plan = await planAt(now);
    expect(plan.launchItems).toHaveLength(3);
    expect(new Set(await selectedSearchIds())).toEqual(new Set(fresh.map(search => search.id)));
    expect(plan.occupiedCourseCount).toBe(7);
    for (const run of preserved) expect(await client.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(run);
  });

  it("deduplicates live, same-tick and batch course/search pairs so a selected fifth venue can start", async () => {
    const now = new Date(); const venues = [];
    for (let i = 0; i < 5; i++) venues.push(await venue());
    const search = await demand(venues, now, { mode: "OUTDOOR" });
    const prior = await starting(venues[0], search, now, true);
    const refs = (dispatcher.parseCourseDispatchAudit(prior.audit))!.target.searchRefs;
    const batch = await client.courseSupportBatch.create({ data: { reference: randomUUID(), providerFamilyKey: "TEST_ROUTING",
      failureFingerprint: "TEST", status: "CLAIMED", leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 600_000),
      heartbeatAt: now, baseSha, summary: { dispatchSourceSearchRefs: refs } } }); ids.batches.push(batch.id);
    for (const v of venues.slice(0, 4)) {
      const incident = await client.courseSupportIncident.upsert({ where: { courseId: v.course.id }, update: {},
        create: { reference: randomUUID(), courseId: v.course.id, kind: "NEEDS_ADAPTER", status: "RESOLVED",
          courseNameSnapshot: v.course.name, platformSnapshot: "UNKNOWN" } });
      await client.courseSupportBatchIncident.create({ data: { batchId: batch.id, incidentId: incident.id, courseId: v.course.id, cycle: 1 } });
    }
    const nextIncident = await client.courseSupportIncident.create({ data: { reference: randomUUID(), courseId: venues[4].course.id,
      kind: "NEEDS_ADAPTER", providerFamilyKey: "TEST_ROUTING", failureFingerprint: "TEST",
      courseNameSnapshot: venues[4].course.name, platformSnapshot: "UNKNOWN" } });
    routing.outdoorCandidates.push({ incidentId: nextIncident.id, courseId: venues[4].course.id, cycle: 1,
      providerFamilyKey: "TEST_ROUTING", failureFingerprint: "TEST", updatedAt: nextIncident.updatedAt.toISOString(), activeRealSearchCount: 1, engineeringOnly: false });
    const plan = await planAt(now);
    expect(plan.launchItems.map(item => item.state).sort()).toEqual(["RESERVED", "STARTING"]);
    expect(await selectedSearchIds()).toEqual([search.id]);
    expect(plan.occupiedCourseCount).toBe(5);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: prior.id } })).toEqual(prior);
    expect(await client.courseSupportBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(batch);
  });
});
