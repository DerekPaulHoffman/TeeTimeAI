// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Route } from "@playwright/test";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT } from "./simulator-support-policy";
import { SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION } from "./simulator-support-research-policy";

const coreMocks = vi.hoisted(() => ({ fetch: vi.fn(), sendMatch: vi.fn(), sendStatus: vi.fn() }));
vi.mock("@/lib/simulators/providers", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/simulators/providers")>()), fetchSimulatorAvailability: coreMocks.fetch,
}));
vi.mock("./simulator-source-check", () => ({ checkSimulatorOfficialSource: vi.fn(() => { throw new Error("Unexpected real source request in isolated test."); }) }));
vi.mock("@/lib/email/alerts", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/email/alerts")>()),
  sendTeeTimeAlert: coreMocks.sendMatch,
  sendSimulatorStatusEmail: coreMocks.sendStatus,
  sendSearchStatusEmail: vi.fn(() => { throw new Error("Unexpected outdoor email in simulator test."); }),
}));

const url = process.env.SIMULATOR_TEST_DATABASE_URL;
let client: PrismaClient;
let dispatcher: typeof import("./course-support-course-dispatch");
let lane: typeof import("./simulator-support-ownership");
let incidents: typeof import("./simulator-support-incidents");
const ids = { users: [] as string[], courses: [] as string[], runs: [] as string[] };
const baseSha = "a".repeat(40);

describe.skipIf(!url)("simulator support ownership in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/simulator_preview") throw new Error("Only the isolated local simulator_preview database is permitted.");
    vi.stubEnv("DATABASE_URL", url!); vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    await client.$connect();
    dispatcher = await import("./course-support-course-dispatch"); lane = await import("./simulator-support-ownership"); incidents = await import("./simulator-support-incidents");
  });
  async function cleanupFixtureRows() {
    if (!client) return;
    const probes = await client.courseProbe.findMany({ where: { courseId: { in: ids.courses }, automationRunId: { not: null } }, select: { automationRunId: true } });
    ids.runs.push(...probes.flatMap(probe => probe.automationRunId ? [probe.automationRunId] : []));
    if (ids.courses.length) {
      const dispatches = await client.automationRun.findMany({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        OR: ids.courses.map(courseId => ({ audit: { path: ["target", "courseId"], equals: courseId } })) }, select: { id: true } });
      ids.runs.push(...dispatches.map(run => run.id));
    }
    await client.automationRun.deleteMany({ where: { id: { in: ids.runs } } });
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    ids.runs.length = 0; ids.courses.length = 0; ids.users.length = 0;
  }
  afterEach(cleanupFixtureRows);
  afterAll(async () => { await cleanupFixtureRows(); if (client) await client.$disconnect(); vi.unstubAllEnvs(); });

  async function fixture(cadenceMinutes = 15, mixed = false, bookingUrl?: string, evidenceUrl?: string, synthetic = false) {
    const suffix = randomUUID(), now = new Date();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: suffix, name: "Support fixture", address: "1 Test Street", website: "https://official.example.test", latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }); ids.courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED", bookingUrl, evidenceUrl } });
    const peerCourse = mixed ? await client.course.create({ data: { googlePlaceId: `${suffix}-peer`, name: "Peer simulator fixture", address: "2 Test Street", website: "https://peer.example.test", latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }) : null;
    if (peerCourse) ids.courses.push(peerCourse.id);
    const peer = peerCourse ? await client.courseOffering.create({ data: { courseId: peerCourse.id, kind: "SIMULATOR", publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60], verifiedAt: now,
      evidenceUrl: "https://peer.example.test", bookingUrl: "https://peer.example.test/book", providerFamilyKey: "GOLFBOOK" } }) : null;
    const search = await client.teeSearch.create({ data: { userId: user.id, mode: "SIMULATOR", durationMinutes: 60, date: new Date(Date.now() + 2 * 86_400_000), startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, trafficClass: synthetic ? "TEST" : "PUBLIC", syntheticMultiCycle: synthetic, cadenceMinutes,
      preferences: { create: [{ offeringId: offering.id, courseId: course.id, rank: 1 }, ...(peer ? [{ offeringId: peer.id, courseId: peer.courseId, rank: 2 }] : [])] } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const incident = await client.simulatorSupportIncident.create({ data: { offeringId: offering.id, reason: "NEEDS_ADAPTER", retryAt: now } });
    const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
    await client.courseProbe.create({ data: { courseId: course.id, offeringId: offering.id, teeSearchId: search.id, outcome: "NEEDS_ADAPTER", rawSummary: { mode: "SIMULATOR", sourceFingerprint: fingerprint } } });
    const assignmentRef = `course-assignment-${suffix}`, child = `child-${suffix}`;
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, ownerThreadId: "parent", audit: {
      schemaVersion: 1, tickRef: "fixture", assignmentRef, state: "BOUND", ownerThreadId: "parent", childThreadId: child, baseSha,
      reservedAt: now.toISOString(), launchStartedAt: now.toISOString(), boundAt: now.toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), target: { mode: "SIMULATOR", offeringId: offering.id, offeringSourceFingerprint: fingerprint,
        incidentId: incident.id, courseId: course.id, cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING", failureFingerprint: fingerprint, updatedAt: incident.updatedAt.toISOString(), trafficClass: synthetic ? "SYNTHETIC" : "REAL",
        searchRefs: [{ id: search.id, scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(search) }] },
    } } }); ids.runs.push(run.id);
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: `automation/course-support-${suffix}` });
    if (!claimed.acquired) throw new Error("Fixture writer transition was busy.");
    return { course, offering, peer, search, incident, run, owner: { assignmentRef, ownerThreadId: child, token: claimed.value.token, revision: claimed.value.revision }, fingerprint };
  }
  beforeEach(() => { Object.values(coreMocks).forEach(mock => mock.mockReset()); });

  async function engineeringFixture(boundOnly = false, bookingUrl?: string) {
    const f = await fixture(15, false, bookingUrl, undefined, true);
    let researchOwner = f.owner;
    if (bookingUrl) {
      const read = await lane.readSimulatorSupportSource({ ...researchOwner, source: "booking" },
        { fetch: vi.fn(async () => new Response("Provider capacity", { status: 429 })) });
      if (!read.acquired) throw new Error("Engineering seed read was busy.");
      researchOwner = { ...researchOwner, revision: read.value.revision };
    }
    await lane.retrySimulatorSupport({ ...researchOwner, retryMinutes: 15 });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "COMPLETED", checkStatus: "STOPPED", nextCheckAt: null,
      workflowRunId: null, alertGeneration: { increment: 1 } } });
    await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
    const before = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "engineering-parent", baseSha });
    if (!plan.acquired) throw new Error("Engineering plan writer was busy.");
    const assignment = plan.value.launchItems.find(item => item.state === "RESERVED");
    if (!assignment) throw new Error("Historical engineering incident was not admitted.");
    const child = `engineering-child-${randomUUID()}`;
    await dispatcher.beginCourseSupportCourseDispatch({ ownerThreadId: "engineering-parent", assignmentRef: assignment.assignmentRef });
    await dispatcher.bindCourseSupportCourseDispatch({ ownerThreadId: "engineering-parent", assignmentRef: assignment.assignmentRef, childThreadId: child });
    const run = await client.automationRun.findFirstOrThrow({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
      audit: { path: ["assignmentRef"], equals: assignment.assignmentRef } } }); ids.runs.push(run.id);
    if (boundOnly) return { ...f, before, engineeringRun: run,
      engineeringOwner: { assignmentRef: assignment.assignmentRef, ownerThreadId: child, token: "unclaimed-fixture", revision: 0 } };
    const claim = await lane.claimSimulatorSupportAssignment({ assignmentRef: assignment.assignmentRef, ownerThreadId: child, baseSha, branch: "engineering-worker" });
    if (!claim.acquired) throw new Error("Engineering claim writer was busy.");
    return { ...f, before, engineeringRun: run, engineeringOwner: { assignmentRef: assignment.assignmentRef, ownerThreadId: child, token: claim.value.token, revision: claim.value.revision } };
  }

  async function readyEngineeringFixture() {
    const f = await engineeringFixture();
    let owner = f.engineeringOwner;
    const manifest = { googlePlaceId: f.course.googlePlaceId, name: f.course.name, address: f.course.address!, latitude: 41, longitude: -73,
      website: f.course.website!, bookingUrl: "https://official.example.test/book", evidenceUrl: f.course.website!, verifiedAt: new Date().toISOString(),
      publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60], providerFamilyKey: "GOLFBOOK" };
    const configured = await lane.configureSimulatorSupportOffering({ ...owner, manifest, apply: true,
      expectedFingerprint: f.fingerprint, expectedOfferingRevision: f.offering.monitoringRevision });
    if (!configured.acquired || configured.value.mode !== "applied") throw new Error("Engineering configuration failed.");
    owner = { ...owner, revision: configured.value.revision };
    const adopted = await lane.adoptSimulatorSupportSource({ ...owner, expectedFingerprint: configured.value.sourceFingerprint,
      expectedOfferingRevision: configured.value.offeringRevision });
    if (!adopted.acquired) throw new Error("Engineering source adoption failed."); owner = { ...owner, revision: adopted.value.revision };
    const registered = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: baseSha, branch: "engineering-worker",
      trustedUpstreamSha: baseSha, upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [] });
    if (!registered.acquired) throw new Error("Engineering metadata release failed."); owner = { ...owner, revision: registered.value.revision };
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: baseSha,
      deployedAt: new Date(Date.now() - 5_000).toISOString(), deploymentId: "dpl_engine_fixture", deploymentUrl: "https://engine-fixture.vercel.app", source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Engineering deployment failed."); owner = { ...owner, revision: deployed.value.revision };
    const runtime = { runtimeVersion: baseSha, deploymentId: proof.deploymentId, deploymentUrl: proof.deploymentUrl, environment: "production", host: "teetimespot.com" };
    return { ...f, engineeringOwner: owner, proof, runtime };
  }

  it("verifies two deployed engineering reads through the real writer envelope and completes without any customer state", async () => {
    const f = await readyEngineeringFixture();
    const { runSimulatorEngineeringVerification } = await import("./simulator-support-engineering-verification");
    const before = { probes: await client.courseProbe.count({ where: { teeSearchId: f.search.id } }), matches: await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } }),
      deliveries: await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id } }), operator: await client.operatorNotificationDelivery.count({ where: { sourceSearchId: f.search.id } }) };
    coreMocks.fetch.mockImplementation(async () => ({ complete: true, observedAt: new Date(), evidenceUrl: f.course.website!, slots: [] }));
    let owner = f.engineeringOwner;
    await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("SIMULATOR_ENGINEERING_VERIFICATION_REQUIRED");
    for (let cycle = 1; cycle <= 2; cycle++) {
      const priorRevision = owner.revision;
      const result = await runSimulatorEngineeringVerification(owner, f.runtime);
      expect(result).toMatchObject({ complete: true, outcome: "NO_MATCH", engineeringOnly: true, customerAcceptance: false, freshSuccessfulChecks: cycle, revision: priorRevision + 2 });
      owner = { ...owner, revision: result.revision };
      const progress = await lane.readSimulatorSupportProgress(owner);
      if (!progress.acquired) throw new Error("Engineering progress was busy.");
      expect(progress.value).toMatchObject({ verificationKind: "ENGINEERING_ONLY", customerAcceptance: false,
        freshSuccessfulChecks: cycle, readyForCompletion: cycle === 2, nextAction: cycle === 2 ? "COMPLETE" : "VERIFY_ENGINEERING" });
    }
    const completed = await lane.completeSimulatorSupport({ ...owner, currentDeployment: f.proof });
    if (!completed.acquired) throw new Error("Engineering completion was busy.");
    expect(completed.value).toMatchObject({ outcome: "success", verificationKind: "ENGINEERING_ONLY", customerAcceptance: false });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
    expect({ probes: await client.courseProbe.count({ where: { teeSearchId: f.search.id } }), matches: await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } }),
      deliveries: await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id } }), operator: await client.operatorNotificationDelivery.count({ where: { sourceSearchId: f.search.id } }) }).toEqual(before);
    const saved = await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } });
    expect(saved).toMatchObject({ status: "COMPLETED", outcome: "simulator_engineering_monitoring_verified" });
    expect(saved.audit).toMatchObject({ simulatorEngineeringCompletion: { engineeringOnly: true, customerAcceptance: false,
      engineeringObservationIds: [expect.any(String), expect.any(String)] } });
    expect((saved.audit as Prisma.JsonObject).simulatorVerification).toBeUndefined();
    expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("cannot release engineering ownership during its existing provider reservation", async () => {
    const f = await readyEngineeringFixture();
    const { runSimulatorEngineeringVerification } = await import("./simulator-support-engineering-verification");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    coreMocks.fetch.mockImplementation(async () => { entered(); await gate; return { complete: true, observedAt: new Date(), evidenceUrl: f.course.website!, slots: [] }; });
    const checking = runSimulatorEngineeringVerification(f.engineeringOwner, f.runtime);
    await started;
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.engineeringOwner.assignmentRef, ownerThreadId: f.engineeringOwner.ownerThreadId });
    const owner = { ...f.engineeringOwner, revision: current.revision };
    try {
      await expect(lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: f.proof, releaseCheckoutVerified: true })).rejects.toThrow("bounded simulator read");
      await expect(lane.retireSimulatorSupport(owner)).rejects.toThrow("engineering verification read");
      await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: f.proof })).rejects.toThrow("engineering verification read");
    } finally { release(); }
    await checking;
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
  });

  it("does no provider work and does not advance the claim when the actual writer lease is busy", async () => {
    const f = await readyEngineeringFixture();
    const { runSimulatorEngineeringVerification } = await import("./simulator-support-engineering-verification");
    const { runWithCourseSupportWriterTransitionLease } = await import("./course-support-batches");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const held = runWithCourseSupportWriterTransitionLease(async () => { entered(); await gate; });
    await started;
    const before = await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } });
    const readCount = coreMocks.fetch.mock.calls.length;
    try { await expect(runSimulatorEngineeringVerification(f.engineeringOwner, f.runtime)).rejects.toThrow("SIMULATOR_ENGINEERING_WRITER_BUSY"); }
    finally { release(); await held; }
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } })).toEqual(before);
    expect(coreMocks.fetch.mock.calls.length).toBe(readCount);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
  }, 30_000);

  it("records customer demand arriving during a detached read as failed engineering evidence and yields safely", async () => {
    const f = await readyEngineeringFixture();
    const { runSimulatorEngineeringVerification } = await import("./simulator-support-engineering-verification");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    coreMocks.fetch.mockImplementation(async () => { entered(); await gate; return { complete: true, observedAt: new Date(), evidenceUrl: f.course.website!, slots: [] }; });
    const checking = runSimulatorEngineeringVerification(f.engineeringOwner, f.runtime);
    await started;
    const real = await client.teeSearch.create({ data: { userId: f.search.userId, mode: "SIMULATOR", durationMinutes: 60, date: f.search.date,
      startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, trafficClass: "PUBLIC",
      preferences: { create: [{ courseId: f.course.id, offeringId: f.offering.id, rank: 1 }] } } });
    release();
    const settled = await checking;
    expect(settled).toMatchObject({ complete: false, outcome: "FETCH_FAILED", failureCode: "NORMAL_CUSTOMER_CHECK_REQUIRED", customerAcceptance: false });
    const owner = { ...f.engineeringOwner, revision: settled.revision };
    const progress = await lane.readSimulatorSupportProgress(owner);
    if (!progress.acquired) throw new Error("Customer-priority engineering progress was busy.");
    expect(progress.value).toMatchObject({ nextAction: "RETRY_ENGINEERING", readyForCompletion: false, customerAcceptance: false });
    await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: f.proof })).rejects.toThrow("CUSTOMER_CHECK_REQUIRED");
    const closed = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: f.proof, releaseCheckoutVerified: true });
    if (!closed.acquired) throw new Error("Engineering priority yield was busy.");
    expect(closed.value).toMatchObject({ outcome: "customer_check_required" });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: real.id } })).toEqual(real);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING", resolvedAt: null });
  });

  it("preserves a bound engineering assignment across the next normal plan without reviving its ended source", async () => {
    const f = await engineeringFixture(true);
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "engineering-next-tick", baseSha });
    if (!plan.acquired) throw new Error("Next engineering plan was busy.");
    expect(plan.value.launchItems).toContainEqual(expect.objectContaining({ assignmentRef: f.engineeringOwner.assignmentRef, state: "BOUND" }));
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } })).toEqual(f.engineeringRun);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
  });

  it.each(["SOURCE", "REAL"] as const)("revokes only unclaimed engineering authority when %s changes before claim", async change => {
    const f = await engineeringFixture(true);
    if (change === "SOURCE") await client.courseOffering.update({ where: { id: f.offering.id }, data: { bookingUrl: "https://official.example.test/new-source" } });
    if (change === "REAL") await client.teeSearch.create({ data: { userId: f.search.userId, mode: "SIMULATOR", durationMinutes: 60, date: f.search.date,
      startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, trafficClass: "PUBLIC",
      preferences: { create: [{ courseId: f.course.id, offeringId: f.offering.id, rank: 1 }] } } });
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "engineering-next-tick", baseSha });
    if (!plan.acquired) throw new Error("Stale engineering plan was busy.");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } })).toMatchObject({ status: "COMPLETED", outcome: "stale_simulator_assignment" });
    const freshRuns = await client.automationRun.findMany({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
      audit: { path: ["target", "courseId"], equals: f.course.id } }, select: { id: true } });
    ids.runs.push(...freshRuns.map(run => run.id));
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
  });

  it("researches and retries an ended opted-in engineering incident without changing its stopped search or sending", async () => {
    const f = await engineeringFixture();
    expect((await lane.readSimulatorSupportClaim({ assignmentRef: f.engineeringOwner.assignmentRef, ownerThreadId: f.engineeringOwner.ownerThreadId })).supportAuthority).toBe("ENGINEERING_INCIDENT");
    const read = await lane.readSimulatorSupportSource({ ...f.engineeringOwner, source: "official" }, { fetch: vi.fn(async () => new Response("<h1>Public simulator rental details</h1>", { headers: { "content-type": "text/html" } })) });
    if (!read.acquired) throw new Error("Engineering public read was busy.");
    await lane.retrySimulatorSupport({ ...f.engineeringOwner, revision: read.value.revision, retryMinutes: 60 });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING", resolvedAt: null });
    expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
    const count = await client.automationRun.count({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, status: "RUNNING" } });
    expect(count).toBe(0);
  });

  it("lets an engineering research owner yield to new real demand while preserving both searches", async () => {
    const f = await engineeringFixture();
    const real = await client.teeSearch.create({ data: { userId: f.search.userId, mode: "SIMULATOR", durationMinutes: 60, date: f.search.date,
      startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, trafficClass: "PUBLIC",
      preferences: { create: [{ courseId: f.course.id, offeringId: f.offering.id, rank: 1 }] } } });
    await expect(lane.withSimulatorEngineeringVerificationTransition({ assignmentRef: f.engineeringOwner.assignmentRef,
      token: f.engineeringOwner.token, revision: f.engineeringOwner.revision, runtimeVersion: baseSha }, async () => { throw new Error("Must not execute provider work."); }))
      .rejects.toThrow("SIMULATOR_ENGINEERING_CUSTOMER_CHECK_REQUIRED");
    const closed = await lane.retrySimulatorSupport({ ...f.engineeringOwner, retryMinutes: 15 });
    if (!closed.acquired) throw new Error("Customer-priority closeout was busy.");
    expect(closed.value).toMatchObject({ outcome: "customer_check_required", durableCloseoutRecorded: true });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: real.id } })).toEqual(real);
    const next = await client.$transaction(tx => incidents.listSimulatorSupportDispatchCandidates(new Date(), tx));
    expect(next).toMatchObject([{ activeRealSearchCount: 1, sources: [{ id: real.id }] }]);
    expect(next[0].engineeringAuthority).toBeUndefined();
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING", resolvedAt: null });
  });

  async function seedExpiredUnfinishedRead(f: Awaited<ReturnType<typeof fixture>>) {
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const requestId = randomUUID();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 1, history: [], links: [], bookingLinks: [], linkBaseUrl: null,
      inFlight: { requestId, startedAt: new Date(Date.now() - 90_000).toISOString(), expiresAt: new Date(Date.now() - 30_000).toISOString(),
        source: "official", url: f.course.website!, rendered: true } };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    return requestId;
  }

  it("reads only the original saved same-origin evidence page under the original reservation", async () => {
    const evidenceUrl = "https://official.example.test/faqs";
    const f = await fixture(15, false, undefined, evidenceUrl);
    const before = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(before.researchGuide.suggestedReads).toContainEqual({ source: "evidence", rendered: false });
    const fetch = vi.fn(async () => new Response("<h1>Public simulator rentals</h1>", { status: 200, headers: { "content-type": "text/html" } }));
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "evidence" }, { fetch });
    expect(read.acquired).toBe(true);
    expect(fetch).toHaveBeenCalledWith(evidenceUrl, expect.objectContaining({ method: "GET", credentials: "omit" }));
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research).toMatchObject({ readCount: 1, inFlight: null, sourceFingerprint: f.fingerprint,
      history: [{ source: "evidence", requestedUrl: evidenceUrl, outcome: "READ" }] });
    await expect(lane.readSimulatorSupportSource({ ...f.owner, revision: current.revision, source: "evidence" }, { fetch })).rejects.toThrow("identical");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reserve or read a saved evidence page on another origin", async () => {
    const f = await fixture(15, false, undefined, "https://other.example.test/faqs");
    const fetch = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "evidence" }, { fetch })).rejects.toThrow("official website origin");
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.revision).toBe(f.owner.revision);
    expect(current.research.readCount).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists known public rental facts and returns them from the owned inspect guide without another source read", async () => {
    const bookingUrl = "https://app.acuityscheduling.com/schedule/2991fba2";
    const f = await fixture(15, false, bookingUrl);
    const business = { id: 34536426, ownerKey: "2991fba2", timezone: "America/New_York", includesAdminOnly: false, isExpired: false,
      description: "Up to 6 People Per Bay", calendars: { "": [{ id: 11388341, name: "Bay 1", timezone: "America/New_York" }] },
      appointmentTypes: { "": [{ id: 73234482, name: "Simulator Booking 1 HR", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] }] },
      client: { email: "secret@example.test", token: "never-persist-this" } };
    const fetch = vi.fn(async () => new Response(`<script>var BUSINESS = ${JSON.stringify(business)};</script>`, { headers: { "content-type": "text/html" } }));
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "booking" }, { fetch });
    expect(read.acquired).toBe(true);
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.revision).toBeGreaterThan(f.owner.revision);
    expect(current.research.history[0].publicConfiguration).toMatchObject({ family: "ACUITY", ownerKey: "2991fba2", rentals: [{ id: "73234482", durationMinutes: 60 }] });
    expect(current.researchGuide.publicConfigurations).toMatchObject([{ source: "booking", rendered: false, configuration: { family: "ACUITY", ownerKey: "2991fba2" } }]);
    expect(current.researchGuide.readsRemaining).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(1);
    const saved = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id }, select: { audit: true } });
    expect(JSON.stringify(saved.audit)).not.toMatch(/never-persist-this|secret@example|Simulator Booking|CLIENT_INFO/u);
    expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });
  it.each(["SECONDARY_STYLESHEET_URL_REJECTED", "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED"])("persists only typed incomplete rendered discovery facts after %s under the real claim", async renderWarning => {
    const bookingUrl = "https://app.acuityscheduling.com/schedule/2991fba2";
    const f = await fixture(15, false, bookingUrl);
    const before = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const business = { id: 34536426, ownerKey: "2991fba2", timezone: "America/New_York", includesAdminOnly: false, isExpired: false,
      description: "Up to 6 People Per Bay", calendars: { "": [{ id: 11388341, name: "Bay 1", timezone: "America/New_York" }] },
      appointmentTypes: { "": [{ id: 73234482, name: "Simulator Booking 1 HR", duration: 60, active: true, private: false, type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] }] },
      client: { email: "secret@example.test", token: "never-persist-this" } };
    const html = `<h1>Observed public rentals</h1><script>var BUSINESS = ${JSON.stringify(business)};</script>`;
    const asset = new URL("/public.css", bookingUrl).href, script = new URL("/public.js", bookingUrl).href, data = new URL("/public/data", bookingUrl).href;
    let handler!: (route: Route) => Promise<void>;
    const frame = {}, fulfilled: string[] = [];
    const page = { mainFrame: () => frame, url: () => bookingUrl, content: vi.fn(async () => html), goto: vi.fn(async () => {
      for (const [url, kind] of [[bookingUrl, "document"], [asset, "stylesheet"], [script, "script"], [data, "xhr"]]) {
        await handler({ request: () => ({ url: () => url, method: () => "GET", allHeaders: async () => ({}),
          resourceType: () => kind, isNavigationRequest: () => kind === "document", frame: () => frame }),
          abort: vi.fn(async () => undefined), fulfill: vi.fn(async () => { fulfilled.push(url); }) } as unknown as Route);
      }
      return { status: () => 200 };
    }) };
    const context = { newPage: async () => page, close: vi.fn(async () => undefined), routeWebSocket: vi.fn(async () => undefined),
      route: vi.fn(async (_pattern: string, callback: typeof handler) => { handler = callback; }) };
    const fetch = vi.fn(async (url: unknown) => String(url) === bookingUrl ? new Response("<h1>Safe initial HTML</h1>", { headers: { "content-type": "text/html" } })
      : String(url) === asset ? renderWarning === "SECONDARY_STYLESHEET_URL_REJECTED"
        ? new Response(null, { status: 302, headers: { location: new URL("/login", bookingUrl).href } })
        : new Response("oversize-never-served", { headers: { "content-length": "1500001", "content-type": "text/css" } })
      : String(url) === data ? new Response('{"ranges":[{"id":1}],"email":"secret@example.test"}', { headers: { "content-type": "application/json" } })
        : new Response("public queued script", { headers: { "content-type": "text/javascript" } }));
    const lease = (async (_host: string, worker: () => Promise<unknown>) => ({ acquired: true as const, value: await worker() })) as NonNullable<import("./simulator-support-research").SimulatorResearchDependencies["lease"]>;
    const browser = async () => ({ newContext: async () => context, close: vi.fn(async () => undefined) }) as unknown as Awaited<ReturnType<NonNullable<import("./simulator-support-research").SimulatorResearchDependencies["browser"]>>>;
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "booking", rendered: true }, { fetch, lease, browser });
    if (!read.acquired) throw new Error("Fixture source settlement was busy.");
    expect(read.value.publicSource).toMatchObject({ renderComplete: false, renderWarning, contentProvenance: "RENDERED_DOM", admittedRequests: 4, blockedRequests: 1,
      publicConfiguration: { family: "ACUITY", ownerKey: "2991fba2" }, responseContracts: [{ pathShape: "/public/:value", httpStatus: 200 }] });
    expect(fulfilled).toEqual([bookingUrl, script, data]); expect(fetch).toHaveBeenCalledTimes(4);
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research.history[0]).toMatchObject({ renderWarning, rendered: true, outcome: "READ", publicReadEvidence: { renderComplete: false, accessControls: [] },
      publicConfiguration: { family: "ACUITY", ownerKey: "2991fba2" } });
    if (renderWarning === "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED") {
      const diagnostic = [{ resourceKind: "SECONDARY_STYLESHEET", phase: "COLLECTOR_HEADERS", observedSizeBand: "OVER_LIMIT_UP_TO_2X", count: 1 }];
      expect(read.value.publicSource.bodyLimitDiagnostics).toEqual(diagnostic);
      expect(current.research.history[0].bodyLimitDiagnostics).toEqual(diagnostic);
    } else {
      expect(current.research.history[0].bodyLimitDiagnostics).toBeUndefined();
    }
    expect(current.researchGuide.publicConfigurations).toMatchObject([{ source: "booking", rendered: true, configuration: { family: "ACUITY", ownerKey: "2991fba2" } }]);
    expect(current.researchGuide.readsRemaining).toBe(5);
    const { readSettledSimulatorPublicCheckpoint } = await import("./simulator-support-research-policy");
    expect(readSettledSimulatorPublicCheckpoint(current.research, new Date())).toBeNull();
    const saved = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id }, select: { audit: true } });
    expect(JSON.stringify(saved.audit)).not.toMatch(/never-persist-this|secret@example|Private bay name|oversize-never-served|responseContracts|RENDERED_DOM/u);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(before);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } })).toBe(0);
    expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  function continuationEvidence(f: Awaited<ReturnType<typeof fixture>>, parent = "parent") {
    const currentMainSha = "c".repeat(40);
    const observedAt = new Date(Date.now() - 15_000).toISOString();
    return { ownerThreadId: parent, assignmentRef: f.owner.assignmentRef,
      policyVersion: "same-native-worker-recovery-v1" as const, currentMainSha,
      nativeCompletion: { version: 1, source: "codex_app.wait_threads", threadId: f.owner.ownerThreadId,
        observedAt, cursor: `cursor-${f.run.id}`, threadStatus: "idle", latestTurn: { id: `turn-${f.run.id}`, status: "completed", error: null },
        activeTurnId: null, approvalRequestCount: 0 },
      readiness: { version: 1, source: "original_native_launcher_receipt", threadId: f.owner.ownerThreadId,
        observedAt, launcherReceiptDigest: "d".repeat(64), checkoutIdentityDigest: "e".repeat(64),
        privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access",
        nativeIdentityVerified: true, noApprovalRequired: true, sameProfile: true, runtimeReady: true, toolingReleaseSha: currentMainSha },
      reviewedToolingRepair: { policyVersion: "same-native-worker-recovery-v1" as const, releaseSha: currentMainSha,
        source: "git" as const, state: "READY" as const, branch: "main" as const,
        aliases: ["teetimespot.com", "www.teetimespot.com"], deployedAt: new Date(Date.now() - 60_000).toISOString() },
    };
  }

  it("reads the current platform booking root as a second owned destination after both saved bays modes fail", async () => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays";
    const root = "https://yourgolfbooking.com/venues/owned-simulator/booking";
    const f = await fixture(15, false, bays);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 2, history: [false, true].map(rendered => ({
      source: "booking" as const, requestedUrl: bays, sourceUrl: bays, observedAt: new Date().toISOString(),
      httpStatus: 403, rendered, outcome: "READ" as const, requestId: randomUUID(),
    })), links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.researchGuide.suggestedReads[0]).toEqual({ source: "booking-root", rendered: false });
    const fetch = vi.fn(async (url: unknown) => { expect(String(url)).toBe(root); return new Response("<h1>Public booking page</h1>", { headers: { "content-type": "text/html" } }); });
    const result = await lane.readSimulatorSupportSource({ ...f.owner, source: "booking-root" }, { fetch });
    expect(result.value).toMatchObject({ publicSource: { requestedUrl: root, httpStatus: 200, method: "HTTP" } });
    expect(fetch).toHaveBeenCalledOnce();
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research.readCount).toBe(3);
    expect(current.research.history[2]).toMatchObject({ source: "booking-root", requestedUrl: root, httpStatus: 200 });
    const savedOffering = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    expect(savedOffering.bookingUrl).toBe(bays);
    await expect(lane.readSimulatorSupportSource({ ...f.owner, revision: current.revision, source: "booking-root" }, { fetch })).rejects.toThrow("identical");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves same-source prior hard-failed bays routes without quarantining transient or older-source observations", async () => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays";
    const root = "https://yourgolfbooking.com/venues/owned-simulator/booking";
    const f = await fixture(15, false, bays);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const observedAt = new Date().toISOString();
    const priorAudit = { ...audit, assignmentRef: `${f.owner.assignmentRef}-previous`, simulatorResearch: {
      version: 1, sourceFingerprint: f.fingerprint, readCount: 5, history: [
        { source: "booking", requestedUrl: bays, sourceUrl: bays, observedAt, httpStatus: 403, rendered: false, outcome: "READ", requestId: randomUUID() },
        { source: "booking", requestedUrl: bays, sourceUrl: bays, observedAt, httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId: randomUUID(),
          failure: { stage: "PUBLIC_READ", category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchPhase: "HTTP_READ", researchResourceKind: "SECONDARY_SCRIPT", sourceLocation: "src/lib/automation/address-pinned-public-fetch.ts:49" } },
        { source: "booking-root", requestedUrl: root, sourceUrl: root, observedAt, httpStatus: 0, rendered: false, outcome: "NETWORK_FAILED", requestId: randomUUID(),
          failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" } },
        { source: "booking-root", requestedUrl: root, sourceUrl: root, observedAt, httpStatus: 0, rendered: true, outcome: "CAPACITY_BUSY", requestId: randomUUID() },
        { source: "official", requestedUrl: f.course.website!, sourceUrl: f.course.website!, observedAt, httpStatus: 429, rendered: false, outcome: "READ", requestId: randomUUID() },
      ], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null,
    } };
    const previous = await client.automationRun.create({ data: { kind: "OTHER", status: "COMPLETED", completedAt: new Date(),
      promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, outcome: "simulator_retryable_failed", audit: priorAudit as unknown as Prisma.InputJsonValue } });
    ids.runs.push(previous.id);
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.research.readCount).toBe(0);
    expect(inspected.researchGuide.priorBlockedRoutes).toEqual([
      { url: bays, rendered: true, httpStatus: 0, failure: priorAudit.simulatorResearch.history[1].failure,
        observedAt, requestId: priorAudit.simulatorResearch.history[1].requestId },
      { url: bays, rendered: false, httpStatus: 403, observedAt, outcome: "READ",
        requestId: priorAudit.simulatorResearch.history[0].requestId },
    ]);
    expect(inspected.researchGuide.suggestedReads.slice(0, 2)).toEqual([
      { source: "booking-root", rendered: false }, { source: "booking-root", rendered: true },
    ]);
    expect(inspected.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: false });
    expect(inspected.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
    expect(inspected.researchGuide.suggestedReads).toContainEqual({ source: "official", rendered: false });
    const fetch = vi.fn(async () => new Response("unreachable"));
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "booking", rendered: true }, { fetch })).rejects.toThrow("structural");
    expect(fetch).not.toHaveBeenCalled();
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.revision).toBe(f.owner.revision); expect(current.research.readCount).toBe(0);
    const olderFingerprint = "b".repeat(64);
    await client.automationRun.update({ where: { id: previous.id }, data: { audit: { ...priorAudit,
      target: { ...priorAudit.target, offeringSourceFingerprint: olderFingerprint },
      simulatorClaim: { ...priorAudit.simulatorClaim!, sourceFingerprint: olderFingerprint, originalSourceFingerprint: olderFingerprint },
      simulatorResearch: { ...priorAudit.simulatorResearch, sourceFingerprint: olderFingerprint },
    } as unknown as Prisma.InputJsonValue } });
    const differentSource = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(differentSource.researchGuide.priorBlockedRoutes).toEqual([]);
    expect(differentSource.researchGuide.suggestedReads[0]).toEqual({ source: "booking", rendered: false });
    expect(differentSource.researchGuide.suggestedReads).toContainEqual({ source: "booking", rendered: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps current source and three-destination fences before any derived-root I/O", async () => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays";
    const f = await fixture(15, false, bays);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 3, history: [1,2,3].map(index => ({
      source: "booking" as const, requestedUrl: `https://calendar.example.test/page-${index}`, sourceUrl: `https://calendar.example.test/page-${index}`,
      observedAt: new Date().toISOString(), httpStatus: 200, rendered: false, outcome: "READ" as const, requestId: randomUUID(),
    })), links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const fetch = vi.fn(async () => new Response("unreachable"));
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "booking-root" }, { fetch })).rejects.toThrow("destination budget");
    expect(fetch).not.toHaveBeenCalled();
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research.readCount).toBe(3); expect(current.revision).toBe(f.owner.revision);
    await client.courseOffering.update({ where: { id: f.offering.id }, data: { bookingUrl: "https://yourgolfbooking.com/venues/changed-simulator/booking/bays" } });
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "booking-root" }, { fetch })).rejects.toThrow("source changed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reserves one original-worker stylesheet diagnosis only after natural lease expiry and a newer release", async () => {
    const f = await fixture(15, false, "https://calendar.example.test/booking", "https://official.example.test/faqs");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const failedAt = new Date(Date.now() - 120_000).toISOString();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 1, history: [{
      source: "official", requestedUrl: f.course.website!, sourceUrl: f.course.website!, observedAt: failedAt,
      httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId: randomUUID(),
      failure: { stage: "PUBLIC_READ", category: "ACCESS", code: "UNSAFE_PUBLIC_URL", researchResourceKind: "SECONDARY_STYLESHEET" },
    }], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const proof = continuationEvidence(f);
    const repair = { policyVersion: proof.policyVersion, releaseSha: proof.currentMainSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"],
      deployedAt: new Date(Date.now() - 60_000).toISOString() };
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair }))
      .toMatchObject({ acquired: true, value: { reserved: false } });
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const result = await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair });
    expect(result).toMatchObject({ acquired: true, value: { reserved: true, threadId: f.owner.ownerThreadId, scope: "DIAGNOSE_REVIEWED_TOOLING_UPDATE" } });
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair }))
      .toMatchObject({ acquired: true, value: { reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" } });
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research.history[0]).toMatchObject({ outcome: "HARD_FAILED", failure: { code: "UNSAFE_PUBLIC_URL" } });
    expect(current.research.readCount).toBe(1);
    expect(current.revision).toBe(f.owner.revision);
  });

  it("reserves a transport script-cap diagnosis on the original expired research-only owner without changing its reads", async () => {
    const f = await fixture(15, false, "https://calendar.example.test/booking", "https://official.example.test/faqs");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const failedAt = new Date(Date.now() - 120_000).toISOString();
    const requestId = randomUUID();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 2, history: [
      { source: "booking", requestedUrl: "https://calendar.example.test/booking", sourceUrl: "https://calendar.example.test/booking",
        observedAt: new Date(Date.now() - 130_000).toISOString(), httpStatus: 403, rendered: false, outcome: "READ", requestId: randomUUID() },
      { source: "booking", requestedUrl: "https://calendar.example.test/booking", sourceUrl: "https://calendar.example.test/booking",
        observedAt: failedAt, httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId,
        failure: { stage: "PUBLIC_READ", category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchPhase: "HTTP_READ",
          researchResourceKind: "SECONDARY_SCRIPT", sourceLocation: "src/lib/automation/address-pinned-public-fetch.ts:49" } },
    ], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
    const save = () => client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    await save();
    const proof = continuationEvidence(f);
    const repair = { policyVersion: proof.policyVersion, releaseSha: proof.currentMainSha, source: "git" as const,
      state: "READY" as const, branch: "main" as const, aliases: ["teetimespot.com", "www.teetimespot.com"],
      deployedAt: new Date(Date.now() - 60_000).toISOString() };
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair })).toMatchObject({ acquired: true, value: { reserved: false } });
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    audit.simulatorClaim!.plannedPaths = ["src/lib/simulators/providers/your-golf-booking.ts"];
    await save();
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair })).toMatchObject({ acquired: true, value: { reserved: false } });
    audit.simulatorClaim!.plannedPaths = [];
    audit.simulatorClaim!.releaseSha = "c".repeat(40);
    await save();
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair })).toMatchObject({ acquired: true, value: { reserved: false } });
    audit.simulatorClaim!.releaseSha = null;
    await save();
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: { ...repair, deployedAt: failedAt } })).toMatchObject({ acquired: true, value: { reserved: false } });
    const result = await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair });
    expect(result).toMatchObject({ acquired: true, value: { reserved: true, threadId: f.owner.ownerThreadId, scope: "DIAGNOSE_REVIEWED_TOOLING_UPDATE" } });
    expect(await dispatcher.reserveCourseSupportContinuation({ ...proof, reviewedToolingRepair: repair })).toMatchObject({ acquired: true, value: { reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" } });
    const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(current.research.history[1]).toMatchObject({ requestId, outcome: "HARD_FAILED", failure: { category: "BUDGET", code: "PUBLIC_BODY_LIMIT", researchResourceKind: "SECONDARY_SCRIPT" } });
    expect(current.research.readCount).toBe(2);
    expect(current.revision).toBe(f.owner.revision);
  });

  it("atomically consumes one bound assignment and prevents duplicate or stale owner work", async () => {
    const f = await fixture();
    const beforeCourse = await client.course.findUniqueOrThrow({ where: { id: f.course.id } });
    expect(await dispatcher.listLiveCourseSupportDispatchReservations(client)).toEqual(expect.arrayContaining([expect.objectContaining({ runId: f.run.id, audit: expect.objectContaining({ state: "CONSUMED" }) })]));
    await expect(lane.claimSimulatorSupportAssignment({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId, baseSha, branch: "worker" })).rejects.toThrow();
    await expect(lane.heartbeatSimulatorSupport({ ...f.owner, revision: 0 })).rejects.toThrow();
    await client.$transaction(tx => incidents.reconcileSimulatorSupportIncidentFailure(tx, { offeringId: f.offering.id, reason: "FETCH_FAILED", now: new Date(), eligible: true }));
    await client.$transaction(tx => incidents.resolveUnownedSimulatorSupportIncident(tx, { offeringId: f.offering.id, now: new Date() }));
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(f.incident);
    expect(await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).toEqual(beforeCourse);
    const stopped = await lane.retrySimulatorSupport({ ...f.owner, retryMinutes: 15 }); expect(stopped.acquired).toBe(true);
  });

  it("fences pause, source drift and expired ownership without freeing its capacity", async () => {
    const f = await fixture();
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } });
    await expect(lane.heartbeatSimulatorSupport(f.owner)).rejects.toThrow("source demand changed");
    await expect(lane.retireSimulatorSupport({ ...f.owner, ownerThreadId: "replacement" })).rejects.toThrow();
    const retired = await lane.retireSimulatorSupport(f.owner); expect(retired.acquired).toBe(true);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING" });
    const second = await fixture();
    await client.courseOffering.update({ where: { id: second.offering.id }, data: { bookingUrl: "https://changed.example.test" } });
    await expect(lane.heartbeatSimulatorSupport(second.owner)).rejects.toThrow("source changed");
    await expect(lane.retireSimulatorSupport(second.owner)).rejects.toThrow("retirement requires");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: second.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await client.automationRun.update({ where: { id: second.run.id }, data: { audit: JSON.parse(JSON.stringify(audit)) } });
    await expect(lane.heartbeatSimulatorSupport(second.owner)).rejects.toThrow("lease is stale");
    expect((await dispatcher.listLiveCourseSupportDispatchReservations(client)).some(entry => entry.runId === second.run.id)).toBe(true);
    await expect(lane.recoverSimulatorSupport({ ...second.owner, ownerThreadId: "replacement" })).rejects.toThrow();
    const recovered = await lane.recoverSimulatorSupport(second.owner); expect(recovered.acquired).toBe(true);
    if (!recovered.acquired) throw new Error("Recovery failed.");
    const recoveredOwner = { ...second.owner, revision: recovered.value.revision };
    await expect(lane.heartbeatSimulatorSupport(recoveredOwner)).rejects.toThrow("source changed");
    const repaired = await client.courseOffering.update({ where: { id: second.offering.id }, data: { publicAccessStatus: "PUBLIC", verifiedAt: new Date(), evidenceUrl: second.course.website, supportedDurationsMinutes: [60], monitoringRevision: { increment: 1 } } });
    const adopted = await lane.adoptSimulatorSupportSource({ ...recoveredOwner, expectedFingerprint: getSimulatorOfferingSourceFingerprint(repaired), expectedOfferingRevision: repaired.monitoringRevision });
    if (!adopted.acquired) throw new Error("Recovered source adoption failed.");
    await lane.retrySimulatorSupport({ ...recoveredOwner, revision: adopted.value.revision, retryMinutes: 15 });
  });

  it("requires exact deployed rechecks and two distinct current successful runs to close", async () => {
    const f = await fixture(120);
    const releaseSha = "b".repeat(40);
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: releaseSha, deployedAt: new Date(Date.now() - 5000).toISOString(), deploymentId: "dpl_fixture", deploymentUrl: "https://fixture.vercel.app", source: "git" as const, state: "READY" as const };
    await expect(lane.completeSimulatorSupport({ ...f.owner, currentDeployment: proof })).rejects.toThrow();
    let owner = f.owner;
    const path = await lane.claimSimulatorSupportPath({ ...owner, path: "src/lib/simulators/providers/new-reader.ts" });
    if (!path.acquired) throw new Error("Path claim failed."); owner = { ...owner, revision: path.value.revision };
    const offering = await client.courseOffering.update({ where: { id: f.offering.id }, data: { publicAccessStatus: "PUBLIC", evidenceUrl: "https://official.example.test", verifiedAt: new Date(), supportedDurationsMinutes: [60], bookingUrl: "https://official.example.test/book", monitoringState: "HEALTHY", automationEligibility: "ALLOWED", monitoringRevision: { increment: 1 } } });
    const adopted = await lane.adoptSimulatorSupportSource({ ...owner, expectedFingerprint: getSimulatorOfferingSourceFingerprint(offering), expectedOfferingRevision: offering.monitoringRevision });
    if (!adopted.acquired) throw new Error("Adoption failed."); owner = { ...owner, revision: adopted.value.revision };
    const branch = `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`;
    const registered = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha, branch,
      trustedUpstreamSha: baseSha, upstreamDescendantVerified: true, committedPaths: ["src/lib/simulators/providers/new-reader.ts"], descendantVerified: true });
    if (!registered.acquired) throw new Error("Release failed."); owner = { ...owner, revision: registered.value.revision };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof: { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: releaseSha, deployedAt: new Date(Date.now() - 5000).toISOString(), deploymentId: "dpl_fixture", deploymentUrl: "https://fixture.vercel.app", source: "git", state: "READY" } });
    if (!deployed.acquired) throw new Error("Deployment failed."); owner = { ...owner, revision: deployed.value.revision };
    const sealedOffering = await client.courseOffering.findUniqueOrThrow({ where: { id: offering.id } });
    await expect(lane.configureSimulatorSupportOffering({ ...owner, manifest: { googlePlaceId: f.course.googlePlaceId, name: f.course.name, address: f.course.address!, latitude: 41, longitude: -73,
      website: f.course.website!, bookingUrl: offering.bookingUrl!, evidenceUrl: offering.evidenceUrl!, verifiedAt: new Date().toISOString(), publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60] },
      apply: true, expectedFingerprint: getSimulatorOfferingSourceFingerprint(offering), expectedOfferingRevision: offering.monitoringRevision })).rejects.toThrow("sealed");
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: offering.id } })).toEqual(sealedOffering);
    const queued = await lane.queueSimulatorSupportRechecks(owner); if (!queued.acquired) throw new Error("Recheck failed."); owner = { ...owner, revision: queued.value.revision };
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toMatchObject({ checkStatus: "QUEUED", workflowRunId: null, scheduleVersion: f.search.scheduleVersion + 1 });
    for (let index = 0; index < 3; index++) {
      const observedAt = new Date();
      const run = await client.automationRun.create({ data: { kind: "SEARCH_CHECK", status: "COMPLETED", completedAt: observedAt, outcome: "success", promptVersion: "simulator-lane-test" } }); ids.runs.push(run.id);
      await client.courseProbe.create({ data: { courseId: f.course.id, offeringId: offering.id, teeSearchId: f.search.id, automationRunId: run.id, observedAt, runtimeVersion: releaseSha, outcome: "NO_MATCH", rawSummary: { mode: "SIMULATOR", sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering), providerObservedAt: observedAt.toISOString() } } });
      await client.teeSearch.update({ where: { id: f.search.id }, data: { checkStatus: "WAITING", checkLeaseToken: null, checkLeaseExpiresAt: null, lastCheckedAt: observedAt, nextCheckAt: new Date(Date.now() + 120 * 60_000) } });
      if (index < 2) await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("two distinct");
      if (index === 0) {
        const second = await lane.queueSimulatorSupportRechecks(owner); if (!second.acquired) throw new Error("Second verification check failed."); owner = { ...owner, revision: second.value.revision };
        expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toMatchObject({ checkStatus: "QUEUED", scheduleVersion: f.search.scheduleVersion + 2, cadenceMinutes: 120 });
        const failedRun = await client.automationRun.create({ data: { kind: "SEARCH_CHECK", promptVersion: "simulator-lane-test" } }); ids.runs.push(failedRun.id);
        await client.courseProbe.create({ data: { courseId: f.course.id, offeringId: offering.id, teeSearchId: f.search.id, automationRunId: failedRun.id, runtimeVersion: releaseSha, outcome: "FETCH_FAILED", rawSummary: { mode: "SIMULATOR", sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering), providerObservedAt: new Date().toISOString() } } });
      }
    }
    const complete = await lane.completeSimulatorSupport({ ...owner, currentDeployment: proof }); expect(complete.acquired).toBe(true);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "RESOLVED" });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "COMPLETED", outcome: "simulator_monitoring_restored" });
  });

  it("selects due unknown simulator demand in the sole dispatcher and binds one exact child", async () => {
    const first = await fixture(), second = await fixture();
    await client.automationRun.updateMany({ where: { id: { in: [first.run.id, second.run.id] } }, data: { status: "COMPLETED" } });
    const before = new Set((await client.automationRun.findMany({ select: { id: true } })).map(row => row.id));
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", baseSha });
    if (!plan.acquired) throw new Error("Dispatcher transition was busy.");
    const created = await client.automationRun.findMany({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION }, select: { id: true } });
    ids.runs.push(...created.filter(row => !before.has(row.id)).map(row => row.id));
    expect(plan.value.launchItems).toHaveLength(2);
    expect(plan.value.launchItems.every(item => item.mode === "SIMULATOR")).toBe(true);
    expect(plan.value.reservedCount).toBeGreaterThanOrEqual(2);
    const assignmentRef = plan.value.launchItems[0].assignmentRef, remaining = plan.value.launchItems[1].assignmentRef;
    await dispatcher.beginCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", assignmentRef });
    await dispatcher.bindCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", assignmentRef, childThreadId: "mixed-child" });
    expect(await dispatcher.getCourseSupportCourseDispatchAssignment({ assignmentRef, childThreadId: "mixed-child" })).toMatchObject({ outcome: "bound", mode: "SIMULATOR" });
    await expect(dispatcher.loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "mixed-child" })).rejects.toThrow();
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: "mixed-child", baseSha, branch: "automation/course-support-mixed" });
    expect(claimed.acquired).toBe(true);
    expect((await dispatcher.listLiveCourseSupportDispatchReservations(client)).filter(entry => [assignmentRef, remaining].includes(entry.audit.assignmentRef))).toHaveLength(2);
    if (claimed.acquired) await lane.retrySimulatorSupport({ assignmentRef, ownerThreadId: "mixed-child", token: claimed.value.token, revision: claimed.value.revision, retryMinutes: 15 });
    await dispatcher.cancelCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", assignmentRef: remaining, confirmedNotCreated: true });
  });

  it("reviews and configures only the owned simulator offering before metadata-only adoption", async () => {
    const f = await fixture();
    const outdoorBefore = await client.course.findUniqueOrThrow({ where: { id: f.course.id } });
    const manifest = { googlePlaceId: f.course.googlePlaceId, name: f.course.name, address: f.course.address!, latitude: f.course.latitude, longitude: f.course.longitude,
      website: f.course.website!, bookingUrl: "https://official.example.test/book", evidenceUrl: f.course.website!, verifiedAt: new Date().toISOString(), publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60], providerFamilyKey: "GOLFBOOK" };
    const input = { ...f.owner, manifest, expectedFingerprint: f.fingerprint, expectedOfferingRevision: f.offering.monitoringRevision };
    const before = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    const dry = await lane.configureSimulatorSupportOffering({ ...input, apply: false }); expect(dry.acquired && dry.value.mode).toBe("dry-run");
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).toEqual(before);
    await expect(lane.configureSimulatorSupportOffering({ ...input, manifest: { ...manifest, googlePlaceId: "wrong-venue" }, apply: true })).rejects.toThrow("exact owned venue");
    await expect(lane.configureSimulatorSupportOffering({ ...input, manifest: { ...manifest, bookingUrl: "http://127.0.0.1/book" }, apply: true })).rejects.toThrow("safe public URLs");
    const applied = await lane.configureSimulatorSupportOffering({ ...input, apply: true });
    if (!applied.acquired || applied.value.mode !== "applied") throw new Error("Config apply failed.");
    const owner = { ...f.owner, revision: applied.value.revision };
    await expect(lane.heartbeatSimulatorSupport(owner)).rejects.toThrow("source changed");
    const adopted = await lane.adoptSimulatorSupportSource({ ...owner, expectedFingerprint: applied.value.sourceFingerprint, expectedOfferingRevision: applied.value.offeringRevision });
    if (!adopted.acquired) throw new Error("Metadata adoption failed.");
    const release = await lane.registerSimulatorSupportRelease({ ...owner, revision: adopted.value.revision, releaseSha: baseSha, branch: `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`,
      trustedUpstreamSha: "c".repeat(40), upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [] });
    expect(release.acquired).toBe(true);
    expect(await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).toEqual(outdoorBefore);
    if (release.acquired) await expect(lane.retrySimulatorSupport({ ...owner, revision: release.value.revision, retryMinutes: 15 })).rejects.toThrow("unfinished simulator implementation");
  });

  it("requires fresh official factual evidence for terminal classification, queues status and cannot be reopened by stale failure", async () => {
    const f = await fixture();
    const outdoorBefore = await client.course.findUniqueOrThrow({ where: { id: f.course.id } });
    const evidence = { reason: "MEMBERS_ONLY", evidenceUrl: f.course.website!, observedAt: new Date().toISOString(), publicSignedOut: true, summary: "The official FAQ permits only membership rentals and excludes public hourly visits." };
    const dry = await lane.classifySimulatorSupportOffering({ ...f.owner, evidence, apply: false }); expect(dry.acquired && dry.value.mode).toBe("dry-run");
    await expect(lane.classifySimulatorSupportOffering({ ...f.owner, evidence: { ...evidence, evidenceUrl: "https://unrelated.example.test" }, apply: true })).rejects.toThrow("exact official-source evidence");
    await expect(lane.classifySimulatorSupportOffering({ ...f.owner, evidence: { ...evidence, observedAt: new Date(Date.now() + 60_000).toISOString() }, apply: true })).rejects.toThrow();
    const applied = await lane.classifySimulatorSupportOffering({ ...f.owner, evidence, apply: true }); expect(applied.acquired).toBe(true);
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).toMatchObject({ publicAccessStatus: "NOT_PUBLIC", monitoringState: "FINAL_IDENTITY", automationEligibility: "BLOCKED" });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toMatchObject({ checkStatus: "QUEUED", scheduleVersion: f.search.scheduleVersion + 1 });
    await client.$transaction(tx => incidents.reconcileSimulatorSupportIncidentFailure(tx, { offeringId: f.offering.id, reason: "NEEDS_ADAPTER", now: new Date(), eligible: true }));
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "RESOLVED", reason: "MEMBERS_ONLY" });
    expect(await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).toEqual(outdoorBefore);
  });

  it("runs both queued verification stages through the normal scheduled check and closes from its actual simulator probes", async () => {
    const f = await fixture(120, true);
    const outdoorBefore = await client.course.findUniqueOrThrow({ where: { id: f.course.id } });
    const offering = await client.courseOffering.update({ where: { id: f.offering.id }, data: {
      publicAccessStatus: "PUBLIC", verifiedAt: new Date(), evidenceUrl: f.course.website,
      bookingUrl: "https://official.example.test/book", providerFamilyKey: "GOLFBOOK",
      supportedDurationsMinutes: [60], monitoringRevision: { increment: 1 },
    } });
    let owner = f.owner;
    const adopted = await lane.adoptSimulatorSupportSource({ ...owner,
      expectedFingerprint: getSimulatorOfferingSourceFingerprint(offering), expectedOfferingRevision: offering.monitoringRevision });
    if (!adopted.acquired) throw new Error("Core-cycle source adoption failed."); owner = { ...owner, revision: adopted.value.revision };
    const release = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: baseSha,
      branch: `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`, trustedUpstreamSha: baseSha,
      upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [] });
    if (!release.acquired) throw new Error("Core-cycle release failed."); owner = { ...owner, revision: release.value.revision };
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: baseSha,
      deployedAt: new Date(Date.now() - 5_000).toISOString(), deploymentId: "dpl_core_fixture", deploymentUrl: "https://core-fixture.vercel.app", source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Core-cycle deployment failed."); owner = { ...owner, revision: deployed.value.revision };
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", baseSha);
    let activeStage = 1;
    coreMocks.fetch.mockImplementation(async ({ offering: requested }: { offering: { id: string; evidenceUrl: string } }) => {
      if (requested.id === f.peer!.id && activeStage === 1) throw new Error("Intercepted independent peer-provider failure.");
      return { complete: true, observedAt: new Date(), evidenceUrl: requested.evidenceUrl, slots: [] };
    });
    coreMocks.sendMatch.mockResolvedValue({ deliveryStatus: "sent", id: "intercepted-local-test" });
    coreMocks.sendStatus.mockResolvedValue({ deliveryStatus: "sent", id: "intercepted-local-test" });
    const { executeScheduledSearchCheck } = await import("./search-schedule-execution");
    const originalFingerprint = getSimulatorOfferingSourceFingerprint(offering);
    for (let stage = 1; stage <= 2; stage++) {
      activeStage = stage;
      const queued = await lane.queueSimulatorSupportRechecks(owner);
      if (!queued.acquired) throw new Error("Core-cycle queue was busy."); owner = { ...owner, revision: queued.value.revision };
      const scheduled = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
      expect(scheduled).toMatchObject({ checkStatus: "QUEUED", remediationDispatchVersion: scheduled.scheduleVersion, cadenceMinutes: 120 });
      expect(scheduled.remediationDispatchKey).toMatch(new RegExp(`:verification-${stage}$`));
      const waiting = await lane.readSimulatorSupportProgress(owner);
      expect(waiting.acquired).toBe(true);
      if (waiting.acquired) expect(waiting.value).toMatchObject({ nextAction: "WAIT_FOR_CHECK", readyForCompletion: false, revision: owner.revision });
      let releaseDelivery!: () => void, deliveryEntered!: () => void;
      const deliveryGate = new Promise<void>(resolve => { releaseDelivery = resolve; });
      const startedDelivery = new Promise<void>(resolve => { deliveryEntered = resolve; });
      coreMocks.sendStatus.mockImplementationOnce(async () => { deliveryEntered(); await deliveryGate; return { deliveryStatus: "sent", id: "intercepted-local-test" }; });
      const runningCheck = executeScheduledSearchCheck(f.search.id, scheduled.scheduleVersion);
      await startedDelivery;
      try {
        const inFlight = await client.courseProbe.findFirstOrThrow({ where: { offeringId: offering.id, automationRunId: { not: null } }, include: { automationRun: true }, orderBy: { observedAt: "desc" } });
        expect(inFlight.automationRun).toMatchObject({ kind: "SEARCH_CHECK", status: "RUNNING" });
        expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toMatchObject({ checkStatus: "CHECKING" });
        const progress = await lane.readSimulatorSupportProgress(owner);
        if (!progress.acquired) throw new Error("Progress read was busy.");
        expect(progress.value).toMatchObject({ nextAction: "WAIT_FOR_CHECK", firstCheckReady: false, revision: owner.revision });
        if (stage === 1) await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("finished scheduled check");
        await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("two distinct");
      } finally { releaseDelivery(); }
      const result = await runningCheck;
      expect(result).toMatchObject({ outcome: stage === 1 ? "failed" : "success", availableMatches: 0,
        courseResults: [{ courseId: f.course.id, outcome: "NO_MATCH" }, { courseId: f.peer!.courseId, outcome: stage === 1 ? "FETCH_FAILED" : "NO_MATCH" }] });
      const finished = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
      expect(finished).toMatchObject({ status: "ACTIVE", checkStatus: "WAITING", checkLeaseToken: null, checkLeaseExpiresAt: null, cadenceMinutes: 120 });
      expect(finished.lastCheckedAt).toBeInstanceOf(Date);
      expect(finished.nextCheckAt!.getTime() - finished.lastCheckedAt!.getTime()).toBeGreaterThan((stage === 1 ? 14 : 119) * 60_000);
      const probe = await client.courseProbe.findFirstOrThrow({ where: { offeringId: offering.id, automationRunId: { not: null } }, orderBy: { observedAt: "desc" } });
      expect(probe).toMatchObject({ runtimeVersion: baseSha, outcome: "NO_MATCH", rawSummary: expect.objectContaining({ mode: "SIMULATOR", sourceFingerprint: originalFingerprint }) });
      expect(await client.automationRun.findUniqueOrThrow({ where: { id: probe.automationRunId! } })).toMatchObject({ status: "COMPLETED", outcome: stage === 1 ? "failed" : "success" });
      expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING" });
      const progress = await lane.readSimulatorSupportProgress(owner);
      if (!progress.acquired) throw new Error("Finished progress read was busy.");
      expect(progress.value).toMatchObject({ nextAction: stage === 1 ? "RECHECK_SECOND" : "COMPLETE", freshSuccessfulChecks: stage, readyForCompletion: stage === 2 });
      expect(progress.value).not.toHaveProperty("qualifyingProbeIds");
      if (stage === 1) await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("two distinct");
    }
    const actualProbes = await client.courseProbe.findMany({ where: { offeringId: offering.id, automationRunId: { not: null } } });
    expect(actualProbes).toHaveLength(2);
    expect(new Set(actualProbes.map(probe => probe.automationRunId)).size).toBe(2);
    expect(coreMocks.fetch).toHaveBeenCalledTimes(4);
    expect(coreMocks.sendMatch).not.toHaveBeenCalled();
    expect(coreMocks.sendStatus).toHaveBeenCalledTimes(2);
    expect(await client.courseProbe.count({ where: { courseId: f.course.id, offeringId: null } })).toBe(0);
    expect(await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).toEqual(outdoorBefore);
    const complete = await lane.completeSimulatorSupport({ ...owner, currentDeployment: proof });
    expect(complete.acquired).toBe(true);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "RESOLVED" });
  });

  it("reads only an owned source through shared provider capacity and rechecks demand after network I/O", async () => {
    const f = await fixture();
    const fetchImpl = vi.fn(async () => new Response("<h1>Public hourly bays</h1><script>secret token</script><form><input value='credential'>Hidden account state</form><a href='/rates'>Rates</a>", { headers: { "content-type": "text/html" } }));
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, fetchImpl);
    expect(read.acquired).toBe(true); expect(fetchImpl).toHaveBeenCalledWith(new URL(f.course.website!).href, expect.objectContaining({ method: "GET", credentials: "omit" }));
    if (!read.acquired) throw new Error("Source read failed.");
    expect(read.value.publicSource.text).toBe("Public hourly bays Rates");
    let owner = { ...f.owner, revision: read.value.revision };
    const redirected = vi.fn(async () => {
      const response = new Response("<a href='book'>Book hourly rentals</a>", { headers: { "content-type": "text/html" } });
      Object.defineProperty(response, "url", { value: "https://official.example.test/simulators/" });
      return response;
    });
    const landing = await lane.readSimulatorSupportSource({ ...owner, linkIndex: 1 }, redirected);
    if (!landing.acquired) throw new Error("Redirected source read failed."); owner = { ...owner, revision: landing.value.revision };
    expect(landing.value.publicSource).toMatchObject({ requestedUrl: "https://official.example.test/rates", url: "https://official.example.test/simulators/", links: ["https://official.example.test/simulators/book"] });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({ simulatorResearch: { version: 1, readCount: 2, linkBaseUrl: "https://official.example.test/simulators/" } });
    const pausedDuringRead = vi.fn(async () => { await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } }); return new Response("public"); });
    await expect(lane.readSimulatorSupportSource({ ...owner, linkIndex: 1 }, pausedDuringRead)).rejects.toThrow("source demand changed");
    const interrupted = await lane.readSimulatorSupportClaim(owner);
    await lane.retireSimulatorSupport({ ...owner, revision: interrupted.revision });
  });

  it("persists a fresh bootstrap booking role and researches only its same-host Acuity schedule", async () => {
    const f = await fixture();
    const before = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const root = "https://onegolfhaven.as.me/", schedule = "https://onegolfhaven.as.me/schedule/a66e63ac";
    const bootstrap = { siteData: { snapshot: { properties: { navigation: [
      { tab: false, link: { external: root }, type: "external", title: "BOOK A TEE TIME", children: [] },
    ] } }, page: { properties: { contentAreas: { banner: { hidden: false, content: { type: "block", elements: [
      { purpose: "button-1", properties: { hidden: false, label: "BOOK NOW\n", link: {
        tab: false, type: "external", link: { shopAll: true, external: root, squareAppointment: "" },
      } } },
    ] } } } } } } };
    const ordinaryAnchors = Array.from({ length: 30 }, (_, index) => `<a href="/details-${index}">Details</a>`).join("");
    const html = `<div id="app"></div>${ordinaryAnchors}<script type="application/javascript" data-cookie-consent="ignore">window.__BOOTSTRAP_STATE__ = ${JSON.stringify(bootstrap)};</script>`;
    const officialFetch = vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    const first = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, { fetch: officialFetch });
    if (!first.acquired) throw new Error("Official fixture read was busy.");
    const owner = { ...f.owner, revision: first.value.revision };
    const firstClaim = await lane.readSimulatorSupportClaim(owner);
    expect(first.value.publicSource).toMatchObject({ httpStatus: 200, bookingLinks: [root] });
    expect(first.value.publicSource.links).toHaveLength(30);
    expect(first.value.publicSource.links[0]).toBe(root);
    expect(first.value.publicSource.links).not.toContain("https://official.example.test/details-29");
    expect(firstClaim.research).toMatchObject({ readCount: 1, inFlight: null, sourceFingerprint: f.fingerprint,
      bookingLinks: [root], bookingLinkRoles: [{ url: root, observedAt: first.value.publicSource.observedAt }],
      history: [{ source: "official", sourceFingerprint: f.fingerprint, outcome: "READ", httpStatus: 200 }] });
    expect(firstClaim.research.links).toHaveLength(30);
    expect(firstClaim.research.links).toContain(root);
    expect(firstClaim.research.bookingLinks.every((link: string) => firstClaim.research.links.includes(link))).toBe(true);
    expect(firstClaim.researchGuide.suggestedReads).toContainEqual({ linkIndex: 1, rendered: false });
    expect(officialFetch).toHaveBeenCalledTimes(1);

    const business = { id: 34536426, ownerKey: "a66e63ac", timezone: "America/New_York", includesAdminOnly: false, isExpired: false,
      description: "Up to 6 People Per Bay", calendars: { "": [{ id: 11388341, name: "Bay 1", timezone: "America/New_York" }] },
      appointmentTypes: { "": [{ id: 73234482, name: "Simulator Booking 1 HR", duration: 60, active: true, private: false,
        type: "service", classSize: null, canChooseQuantity: false, calendarIDs: [11388341] }] } };
    const bookingFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: schedule } }))
      .mockResolvedValueOnce(new Response(`<script>var BUSINESS = ${JSON.stringify(business)};</script>`, { headers: { "content-type": "text/html" } }));
    const second = await lane.readSimulatorSupportSource({ ...owner, linkIndex: 1 }, { fetch: bookingFetch });
    if (!second.acquired) throw new Error("Booking fixture read was busy.");
    const finalClaim = await lane.readSimulatorSupportClaim({ ...owner, revision: second.value.revision });
    expect(bookingFetch).toHaveBeenCalledTimes(2);
    expect(bookingFetch).toHaveBeenNthCalledWith(1, root, expect.objectContaining({ method: "GET", credentials: "omit" }));
    expect(second.value.publicSource).toMatchObject({ requestedUrl: root, url: schedule,
      publicConfiguration: { family: "ACUITY", ownerKey: "a66e63ac", rentals: [{ id: "73234482", calendarIds: ["11388341"] }],
        resources: [{ id: "11388341" }] } });
    expect(finalClaim.research).toMatchObject({ readCount: 2, inFlight: null, sourceFingerprint: f.fingerprint,
      history: [{ source: "official", sourceFingerprint: f.fingerprint }, { source: "link", requestedUrl: root,
        sourceUrl: schedule, sourceFingerprint: f.fingerprint, publicConfiguration: { family: "ACUITY", ownerKey: "a66e63ac" } }] });
    expect(finalClaim.researchGuide.publicConfigurations).toContainEqual(expect.objectContaining({
      configuration: expect.objectContaining({ family: "ACUITY", ownerKey: "a66e63ac" }),
    }));
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(before);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } })).toBe(0);
    expect(coreMocks.fetch).not.toHaveBeenCalled();
    expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("records exact current-upstream reuse as metadata-only without claiming a reader fix", async () => {
    const f = await fixture();
    const trustedUpstreamSha = "c".repeat(40);
    const branch = `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`;
    await expect(lane.registerSimulatorSupportRelease({ ...f.owner, branch, releaseSha: "b".repeat(40),
      trustedUpstreamSha, upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [] })).rejects.toThrow("provenance");
    const release = await lane.registerSimulatorSupportRelease({ ...f.owner, branch, releaseSha: trustedUpstreamSha,
      trustedUpstreamSha, upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [] });
    if (!release.acquired) throw new Error("Metadata reuse was busy.");
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({
      baseSha, simulatorClaim: { releaseSha: trustedUpstreamSha, plannedPaths: [] },
      simulatorReleaseProvenance: { originalBaseSha: baseSha, trustedUpstreamSha,
        releaseSha: trustedUpstreamSha, metadataOnlyReuse: true, metadataReuseKind: "TRUSTED_UPSTREAM", committedPaths: [] },
    });
    await expect(lane.retrySimulatorSupport({ ...f.owner, revision: release.value.revision, retryMinutes: 15 })).rejects.toThrow("unfinished simulator implementation");
  });

  it("retains fresh successful links when another owned destination fails", async () => {
    const f = await fixture();
    const landing = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response("<a href='/book-one'>Book bays</a><a href='/book-two'>Book another calendar</a>", { headers: { "content-type": "text/html" } })));
    if (!landing.acquired) throw new Error("Landing source read failed.");
    let owner = { ...f.owner, revision: landing.value.revision };
    const failed = await lane.readSimulatorSupportSource({ ...owner, linkIndex: 1 }, vi.fn(async () => new Response("forbidden", { status: 403 })));
    if (!failed.acquired) throw new Error("Failed destination was not recorded.");
    owner = { ...owner, revision: failed.value.revision };
    const inspected = await lane.readSimulatorSupportClaim(owner);
    expect(inspected.research).toMatchObject({ readCount: 2, linkBaseUrl: "https://official.example.test/", links: ["https://official.example.test/book-one", "https://official.example.test/book-two"] });
    expect(inspected.researchGuide.suggestedReads).toContainEqual({ linkIndex: 2, rendered: false });
    const alternative = vi.fn(async () => new Response("<p>Public calendar</p>", { headers: { "content-type": "text/html" } }));
    const result = await lane.readSimulatorSupportSource({ ...owner, linkIndex: 2 }, alternative);
    if (!result.acquired) throw new Error("Alternative source read failed.");
    expect(alternative).toHaveBeenCalledWith("https://official.example.test/book-two", expect.objectContaining({ method: "GET" }));
    expect(result.value.publicSource.httpStatus).toBe(200);
    await lane.retrySimulatorSupport({ ...owner, revision: result.value.revision, retryMinutes: 15 });
  });

  it("refuses owned retry without mutation while a fresh booking-role link survives a later page", async () => {
    const f = await fixture(15, false, "https://booking.example.test/calendar");
    const initial = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = initial.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const interruptedRequestId = randomUUID();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 2, links: [], bookingLinks: [], linkBaseUrl: null,
      lastRecoveredFailureRequestId: interruptedRequestId, inFlight: null, history: [
        { source: "booking", requestedUrl: f.offering.bookingUrl!, sourceUrl: f.offering.bookingUrl!, observedAt: new Date().toISOString(), httpStatus: 403, rendered: false, outcome: "READ" },
        { source: "booking", requestedUrl: f.offering.bookingUrl!, sourceUrl: f.offering.bookingUrl!, observedAt: new Date().toISOString(), httpStatus: 0, rendered: true,
          outcome: "HARD_FAILED", requestId: interruptedRequestId, failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" } },
      ] };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const first = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response(
      "<a href='/venue'>Book public hourly bays</a><a href='/details'>Venue details</a>", { headers: { "content-type": "text/html" } })));
    if (!first.acquired) throw new Error("Official read failed.");
    const firstRole = (await lane.readSimulatorSupportClaim(f.owner)).research.bookingLinkRoles?.[0];
    expect(firstRole).toMatchObject({ url: "https://official.example.test/venue" });
    const second = await lane.readSimulatorSupportSource({ ...f.owner, revision: first.value.revision, linkIndex: 2 }, vi.fn(async () => new Response(
      "<a href='/venue'>Rental details</a>", { headers: { "content-type": "text/html" } })));
    if (!second.acquired) throw new Error("Details read failed.");
    const owner = { ...f.owner, revision: second.value.revision };
    const inspected = await lane.readSimulatorSupportClaim(owner);
    expect(inspected.research.bookingLinks).toContain("https://official.example.test/venue");
    expect(inspected.research.bookingLinkRoles).toEqual([firstRole]);
    const runBefore = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const incidentBefore = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    const refused = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 60 });
    expect(refused.acquired).toBe(true);
    if (!refused.acquired) throw new Error("Retry guard writer was busy.");
    expect(refused.value).toMatchObject({ outcome: "booking_research_required", revision: owner.revision,
      nextEligibleBookingRead: { linkIndex: 1, rendered: false } });
    expect(refused.value.researchGuide.suggestedReads).toContainEqual({ linkIndex: 1, rendered: false });
    expect(refused.value.researchGuide.readsRemaining).toBe(2);
    expect(refused.value.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: false });
    expect(refused.value.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(runBefore);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(incidentBefore);
  });

  it.each(["stale", "unlinked"])("drops %s booking-role evidence on a later successful page", async kind => {
    const f = await fixture();
    const first = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response(
      "<a href='/venue'>Book public hourly bays</a><a href='/details'>Venue details</a>", { headers: { "content-type": "text/html" } })));
    if (!first.acquired) throw new Error("Official read failed.");
    if (kind === "stale") {
      const run = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
      const audit = run.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
      const research = audit.simulatorResearch as import("./simulator-support-research-policy").SimulatorResearchState;
      research.bookingLinkRoles = [{ url: "https://official.example.test/venue", observedAt: new Date(Date.now() - 31 * 60_000).toISOString() }];
      await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    }
    const second = await lane.readSimulatorSupportSource({ ...f.owner, revision: first.value.revision, linkIndex: 2 }, vi.fn(async () => new Response(
      kind === "stale" ? "<a href='/venue'>Rental details</a>" : "<a href='/other'>Other details</a>",
      { headers: { "content-type": "text/html" } })));
    if (!second.acquired) throw new Error("Details read failed.");
    const inspected = await lane.readSimulatorSupportClaim({ ...f.owner, revision: second.value.revision });
    expect(inspected.research.bookingLinks).toEqual([]);
    expect(inspected.research.bookingLinkRoles).toEqual([]);
  });

  it("allows a durable retry when both saved calendar variants were attempted", async () => {
    const f = await fixture(15, false, "https://booking.example.test/calendar");
    const run = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = run.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 2, links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null,
      history: [
        { source: "booking", requestedUrl: f.offering.bookingUrl!, sourceUrl: f.offering.bookingUrl!, observedAt: new Date().toISOString(), httpStatus: 403, rendered: false, outcome: "READ" },
        { source: "booking", requestedUrl: f.offering.bookingUrl!, sourceUrl: f.offering.bookingUrl!, observedAt: new Date().toISOString(), httpStatus: 0, rendered: true,
          outcome: "HARD_FAILED", requestId: randomUUID(), failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" } },
      ] };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const retry = await lane.retrySimulatorSupport({ ...f.owner, retryMinutes: 60 });
    expect(retry.acquired && retry.value.outcome).toBe("retryable_failed");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "COMPLETED", outcome: "simulator_retryable_failed" });
  });

  it("allows provider-capacity backoff despite a still-linked booking role", async () => {
    const f = await fixture();
    const first = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response(
      "<a href='/venue'>Book public hourly bays</a>", { headers: { "content-type": "text/html" } })));
    if (!first.acquired) throw new Error("Official read failed.");
    const busy = await lane.readSimulatorSupportSource({ ...f.owner, revision: first.value.revision, linkIndex: 1 },
      vi.fn(async () => { throw new Error("SIMULATOR_RESEARCH_PROVIDER_BUSY"); }));
    if (!busy.acquired) throw new Error("Capacity observation failed.");
    expect(busy.value.researchOutcome).toBe("CAPACITY_BUSY");
    const retry = await lane.retrySimulatorSupport({ ...f.owner, revision: busy.value.revision, retryMinutes: 60 });
    expect(retry.acquired && retry.value.outcome).toBe("retryable_failed");
  });

  it("fences retry against research navigation from a different source fingerprint", async () => {
    const f = await fixture();
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorResearch = { version: 1, sourceFingerprint: "f".repeat(64), readCount: 0, history: [], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const runBefore = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const incidentBefore = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    await expect(lane.retrySimulatorSupport({ ...f.owner, retryMinutes: 60 })).rejects.toThrow("older source");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(runBefore);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(incidentBefore);
  });

  it("reserves a source read before network work and blocks an overlapping same-revision read", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const startedRead = new Promise<void>(resolve => { started = resolve; });
    const finishRead = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async () => { started(); await finishRead; return new Response("<p>Public bays</p>", { headers: { "content-type": "text/html" } }); });
    const first = lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, fetchImpl);
    await startedRead;
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, fetchImpl)).rejects.toThrow("revision or lease");
    release();
    const result = await first;
    expect(result.acquired).toBe(true); expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({ simulatorResearch: { readCount: 1, inFlight: null } });
  });

  it("requires a distinct booking investigation after a failed homepage and keeps the incident open", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response("forbidden", { status: 403 })));
    if (!read.acquired) throw new Error("Source read failed.");
    let owner = { ...f.owner, revision: read.value.revision };
    const guided = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 15 });
    expect(guided.acquired).toBe(true);
    if (!guided.acquired) throw new Error("Booking fallback guide was busy.");
    expect(guided.value).toMatchObject({ outcome: "booking_research_required", revision: owner.revision,
      nextEligibleBookingRead: { source: "booking", rendered: false } });
    const booking = await lane.readSimulatorSupportSource({ ...owner, source: "booking" }, vi.fn(async () => new Response("<p>Calendar needs support</p>", { headers: { "content-type": "text/html" } })));
    if (!booking.acquired) throw new Error("Booking research failed.");
    owner = { ...owner, revision: booking.value.revision };
    const stillGuided = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 15 });
    expect(stillGuided.acquired && stillGuided.value.outcome).toBe("booking_research_required");
    if (!stillGuided.acquired || stillGuided.value.outcome !== "booking_research_required") throw new Error("Rendered booking guide was unavailable.");
    expect(stillGuided.value.nextEligibleBookingRead).toEqual({ source: "booking", rendered: true });
    const busy = await lane.readSimulatorSupportSource({ ...owner, source: "booking", rendered: true }, {
      browser: async () => { throw new Error("SIMULATOR_RESEARCH_PROVIDER_BUSY"); },
    });
    if (!busy.acquired) throw new Error("Provider backoff observation failed.");
    owner = { ...owner, revision: busy.value.revision };
    const closed = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 15 });
    expect(closed.acquired && closed.value.outcome).toBe("retryable_failed");
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING" });
    const incident = await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
    const previous = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = previous.audit as Prisma.JsonObject;
    const target = audit.target as Prisma.JsonObject;
    const assignmentRef = `assignment-${randomUUID()}`, child = `child-${randomUUID()}`;
    const next = await client.automationRun.create({ data: { promptVersion: "course-support-course-dispatch-v1", kind: "OTHER", status: "RUNNING", auditSchemaVersion: 1,
      audit: { schemaVersion: 1, tickRef: "course-1", assignmentRef, state: "BOUND", ownerThreadId: "parent", childThreadId: child,
        baseSha, reservedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
        target: { ...target, updatedAt: incident.updatedAt.toISOString() } } } });
    ids.runs.push(next.id);
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: "automation/course-support-next-research" });
    if (!claimed.acquired) throw new Error("Next research claim was busy.");
    expect(claimed.value.researchGuide.suggestedReads[0]).toEqual({ source: "booking", rendered: false });
    expect(claimed.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: f.course.website, rendered: false, httpStatus: 403 }));
    expect(claimed.value.researchGuide.suggestedReads).not.toContainEqual({ source: "official", rendered: false });
  });

  it("rejects a tests-only release instead of calling it reusable calendar implementation", async () => {
    const f = await fixture();
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/new-reader.test.ts" });
    if (!planned.acquired) throw new Error("Test-only path fixture was busy.");
    await expect(lane.registerSimulatorSupportRelease({ ...f.owner, revision: planned.value.revision, releaseSha: "b".repeat(40),
      branch: `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`, trustedUpstreamSha: baseSha,
      upstreamDescendantVerified: true, committedPaths: ["src/lib/simulators/providers/new-reader.test.ts"], descendantVerified: true })).rejects.toThrow("provenance");
    await expect(lane.retrySimulatorSupport({ ...f.owner, revision: planned.value.revision, retryMinutes: 15 })).rejects.toThrow("unfinished simulator implementation");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "RUNNING",
      audit: { simulatorClaim: { phase: "IMPLEMENTING", plannedPaths: ["src/lib/simulators/providers/new-reader.test.ts"] } } });
  });

  it("accepts claimed runtime work after reviewed upstream advances and rejects unclaimed or unproved candidate deltas", async () => {
    const f = await fixture();
    const path = "src/lib/simulators/providers/new-reader.ts";
    const claimed = await lane.claimSimulatorSupportPath({ ...f.owner, path });
    if (!claimed.acquired) throw new Error("Path claim failed.");
    const owner = { ...f.owner, revision: claimed.value.revision };
    const input = { ...owner, releaseSha: "b".repeat(40), trustedUpstreamSha: "c".repeat(40),
      upstreamDescendantVerified: true, descendantVerified: true, branch: `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`,
      committedPaths: [path] };
    await expect(lane.registerSimulatorSupportRelease({ ...input, upstreamDescendantVerified: false })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...input, descendantVerified: false })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...input, releaseSha: input.trustedUpstreamSha })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...input, releaseSha: baseSha })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...input, committedPaths: [] })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...input, committedPaths: ["src/lib/simulators/providers/unclaimed.ts"] })).rejects.toThrow("provenance");
    const registered = await lane.registerSimulatorSupportRelease(input);
    expect(registered.acquired).toBe(true);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({
      baseSha, simulatorReleaseProvenance: { originalBaseSha: baseSha, trustedUpstreamSha: input.trustedUpstreamSha,
        releaseSha: input.releaseSha, metadataOnlyReuse: false, committedPaths: [path] },
    });
    await expect(lane.retrySimulatorSupport({ ...owner, revision: registered.value.revision, retryMinutes: 15 })).rejects.toThrow("unfinished simulator implementation");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "RUNNING",
      audit: { simulatorClaim: { releaseSha: input.releaseSha, plannedPaths: [path], deployment: null } } });
  });

  it.each(["REAL", "ENGINEERING"] as const)("continues eligible booking research after a published diagnostic repair for %s demand", async authority => {
    const bookingUrl = "https://official.example.test/booking";
    const f = authority === "ENGINEERING" ? await engineeringFixture(false, bookingUrl) : await fixture(15, false, bookingUrl);
    let owner = "engineeringOwner" in f ? f.engineeringOwner : f.owner;
    const runId = "engineeringRun" in f ? f.engineeringRun.id : f.run.id;
    const branch = authority === "ENGINEERING" ? "engineering-worker" : `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`;
    const path = "src/lib/automation/simulator-support-research.ts", releaseSha = "b".repeat(40);
    const planned = await lane.claimSimulatorSupportPath({ ...owner, path });
    if (!planned.acquired) throw new Error("Diagnostic path fixture was busy."); owner = { ...owner, revision: planned.value.revision };
    const registered = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha, trustedUpstreamSha: baseSha,
      upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [path], branch });
    if (!registered.acquired) throw new Error("Diagnostic release fixture was busy."); owner = { ...owner, revision: registered.value.revision };
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: releaseSha,
      deployedAt: new Date(Date.now() - 5_000).toISOString(), deploymentId: "dpl_diagnostic_fixture",
      deploymentUrl: "https://diagnostic-fixture.vercel.app", source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Diagnostic deployment fixture was busy."); owner = { ...owner, revision: deployed.value.revision };
    const beforeRun = await client.automationRun.findUniqueOrThrow({ where: { id: runId } });
    const beforeIncident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    const beforeSearch = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const retry = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: proof, releaseCheckoutVerified: true });
    if (!retry.acquired) throw new Error("Diagnostic retry fixture was busy.");
    expect(retry.value).toMatchObject({ outcome: "booking_research_required", revision: owner.revision,
      nextEligibleBookingRead: { source: "booking", rendered: false }, researchGuide: { readsRemaining: 6 } });
    expect(retry.value).not.toHaveProperty("durableCloseoutRecorded");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: runId } })).toEqual(beforeRun);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(beforeIncident);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(beforeSearch);

    const fetch = vi.fn(async () => new Response("Provider capacity", { status: 429 }));
    const read = await lane.readSimulatorSupportSource({ ...owner, source: "booking" }, { fetch });
    if (!read.acquired) throw new Error("Diagnostic follow-up read was busy."); owner = { ...owner, revision: read.value.revision };
    expect(fetch).toHaveBeenCalledTimes(1);
    const closed = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: proof, releaseCheckoutVerified: true });
    if (!closed.acquired) throw new Error("Provider backoff closeout was busy.");
    expect(closed.value).toMatchObject({ outcome: "retryable_failed", durableCloseoutRecorded: true });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ status: "COMPLETED", outcome: "simulator_retryable_failed" });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(beforeSearch);
    expect(coreMocks.fetch).not.toHaveBeenCalled(); expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("waits for the writer during final source-read settlement without fetching twice", async () => {
    const evidenceUrl = "https://official.example.test/faqs";
    const f = await fixture(15, false, undefined, evidenceUrl);
    const { runWithCourseSupportWriterTransitionLease } = await import("./course-support-batches");
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let held: Promise<unknown> | undefined;
    const fetch = vi.fn(async () => {
      held = runWithCourseSupportWriterTransitionLease(async () => { entered(); await gate; });
      await started;
      setTimeout(release, 3_300);
      return new Response("<h1>Public simulator rentals</h1>", { status: 200, headers: { "content-type": "text/html" } });
    });
    try {
      const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "evidence" }, { fetch });
      expect(read.acquired).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const current = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
      expect(current.research).toMatchObject({ readCount: 1, inFlight: null,
        history: [{ source: "evidence", outcome: "READ" }] });
    } finally { release?.(); if (held) await held; }
  }, 15_000);

  it("preserves published retry for a configured PUBLIC offering with an eligible booking route", async () => {
    const f = await readyEngineeringFixture();
    const packet = await lane.readSimulatorSupportClaim({ assignmentRef: f.engineeringOwner.assignmentRef,
      ownerThreadId: f.engineeringOwner.ownerThreadId });
    expect(packet.researchGuide.suggestedReads).toContainEqual({ source: "booking", rendered: false });
    const closed = await lane.retrySimulatorSupport({ ...f.engineeringOwner, retryMinutes: 60,
      currentDeployment: f.proof, releaseCheckoutVerified: true });
    if (!closed.acquired) throw new Error("Public configured retry was busy.");
    expect(closed.value).toMatchObject({ outcome: "retryable_failed", durableCloseoutRecorded: true });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.engineeringRun.id } })).toMatchObject({ status: "COMPLETED" });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(f.before);
    expect(coreMocks.fetch).not.toHaveBeenCalled(); expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("allows honest real-demand retry only after the owned committed release has fresh exact Ready deployment proof", async () => {
    const f = await fixture();
    const path = "src/lib/simulators/providers/owned-reader.ts", releaseSha = "b".repeat(40);
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path });
    if (!planned.acquired) throw new Error("Real retry path fixture was busy.");
    let owner = { ...f.owner, revision: planned.value.revision };
    const registered = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha,
      trustedUpstreamSha: baseSha, upstreamDescendantVerified: true, descendantVerified: true, committedPaths: [path],
      branch: `automation/course-support-${owner.ownerThreadId.replace("child-", "")}` });
    if (!registered.acquired) throw new Error("Real retry release fixture was busy."); owner = { ...owner, revision: registered.value.revision };
    await expect(lane.retrySimulatorSupport({ ...owner, retryMinutes: 60 })).rejects.toThrow("unfinished simulator implementation");
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: releaseSha,
      deployedAt: new Date(Date.now() - 5_000).toISOString(), deploymentId: "dpl_real_retry_fixture", deploymentUrl: "https://real-retry-fixture.vercel.app", source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Real retry deployment fixture was busy."); owner = { ...owner, revision: deployed.value.revision };
    const beforeSearch = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const beforeRun = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    await expect(lane.retrySimulatorSupport({ ...owner, retryMinutes: 60 })).rejects.toThrow("clean committed checkout");
    await expect(lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: proof, releaseCheckoutVerified: false })).rejects.toThrow("clean committed checkout");
    await expect(lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: { ...proof, deploymentId: "dpl_wrong" }, releaseCheckoutVerified: true })).rejects.toThrow("same current production deployment");
    const retried = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 60, currentDeployment: proof, releaseCheckoutVerified: true });
    if (!retried.acquired) throw new Error("Real published retry was busy.");
    expect(retried.value).toMatchObject({ outcome: "retryable_failed", durableCloseoutRecorded: true });
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(beforeSearch);
    const after = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(after).toMatchObject({ status: "COMPLETED", outcome: "simulator_retryable_failed" });
    expect((after.audit as Prisma.JsonObject).simulatorClaim).toEqual((beforeRun.audit as Prisma.JsonObject).simulatorClaim);
    expect(after.audit).toMatchObject({ simulatorPublishedReleaseRetry: { releaseSha, deploymentId: proof.deploymentId, sourceFingerprint: f.fingerprint } });
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING", resolvedAt: null });
    expect(coreMocks.fetch).not.toHaveBeenCalled(); expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("does not erase older actual hard, HTTP or access denials with a later complete rendered page", async () => {
    const f = await fixture();
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const base = new Date(Date.now() - 120_000);
    const denied = [401, 403, 404, 0, 200, 200].map((httpStatus, index) => {
      const sourceUrl = `https://calendar.example.test/denied-${index}`;
      return { source: "booking" as const, requestedUrl: sourceUrl, sourceUrl, sourceFingerprint: f.fingerprint,
        observedAt: new Date(base.getTime() + index).toISOString(), httpStatus, rendered: true,
        outcome: httpStatus === 0 ? "HARD_FAILED" as const : "READ" as const, requestId: randomUUID(),
        ...(httpStatus === 0 ? { failure: { stage: "PUBLIC_READ" as const, category: "UNKNOWN" as const, code: "UNCLASSIFIED_FAILURE" as const } } : {}),
        ...(index >= 4 ? { publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
          accessControls: [index === 4 ? "CAPTCHA_OR_CHALLENGE" as const : "QUEUE" as const], method: "BROWSER" as const } } : {}) };
    });
    const history = (entries: typeof denied) => ({ version: 1, sourceFingerprint: f.fingerprint, readCount: 6,
      history: entries, links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null });
    const createPrior = async (entries: typeof denied, completedAt: Date) => {
      const run = await client.automationRun.create({ data: { kind: "OTHER", status: "COMPLETED", completedAt,
        promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, outcome: "simulator_retryable_failed",
        audit: { ...audit, assignmentRef: `course-assignment-${randomUUID()}`,
          simulatorResearch: history(entries) } as unknown as Prisma.InputJsonValue } });
      ids.runs.push(run.id);
    };
    await createPrior(denied, new Date(base.getTime() + 60_000));
    const complete = denied.map(entry => ({ ...entry, observedAt: new Date().toISOString(), httpStatus: 200, outcome: "READ" as const,
      failure: undefined, publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
        accessControls: [], method: "BROWSER" as const, renderComplete: true } }));
    await createPrior(complete, new Date());
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.researchGuide.priorBlockedRoutes).toHaveLength(6);
    expect(inspected.researchGuide.priorBlockedRoutes.map(route => route.httpStatus).sort((a, b) => a - b)).toEqual([0, 200, 200, 401, 403, 404]);
    expect(inspected.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ accessControls: ["CAPTCHA_OR_CHALLENGE"] }));
    expect(inspected.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ accessControls: ["QUEUE"] }));
  });

  it("carries timed secondary revalidation across zero-read retries and renews cooldown from the newest actual read", async () => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays";
    const f = await fixture(15, false, bays);
    const first = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const original = first.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const oldAt = new Date(Date.now() - 61 * 60_000).toISOString();
    const incomplete = (observedAt: string) => ({ source: "booking" as const, requestedUrl: bays, sourceUrl: bays,
      sourceFingerprint: f.fingerprint, observedAt, httpStatus: 200, rendered: true, outcome: "READ" as const,
      requestId: randomUUID(), researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" as const,
      publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
        accessControls: [], method: "BROWSER" as const, renderComplete: false } });
    await client.automationRun.update({ where: { id: f.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...original, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
        history: [incomplete(oldAt)], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } } as unknown as Prisma.InputJsonValue } });
    const replacement = async (previous: import("./course-support-course-dispatch").CourseDispatchAudit) => {
      const due = await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
      const assignmentRef = `course-assignment-${randomUUID()}`, child = `child-${randomUUID()}`;
      const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        audit: { ...previous, assignmentRef, childThreadId: child, state: "BOUND", boundAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(), simulatorClaim: undefined,
          simulatorResearch: undefined, simulatorResearchPriorFailures: undefined,
          target: { ...previous.target, updatedAt: due.updatedAt.toISOString() } } as unknown as Prisma.InputJsonValue } });
      ids.runs.push(run.id);
      const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha,
        branch: `automation/course-support-${randomUUID()}` });
      if (!claimed.acquired) throw new Error("Replacement claim was busy.");
      const saved = await client.automationRun.findUniqueOrThrow({ where: { id: run.id } });
      return { run, audit: saved.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit,
        owner: { assignmentRef, ownerThreadId: child }, claimed: claimed.value };
    };
    const second = await replacement(original);
    expect(second.claimed.researchGuide.priorBlockedRoutes).toEqual([]);
    expect(second.claimed.researchGuide.suggestedReads).toContainEqual({ source: "booking", rendered: true });
    // Emulate an old copied checkpoint: its optional timing/access fields are absent,
    // but the exact original owned observation is still in bounded history.
    const legacyRoutes = second.audit.simulatorResearchPriorFailures!.routes.map(route => ({ url: route.url,
      rendered: route.rendered, httpStatus: route.httpStatus, renderWarning: route.renderWarning,
      researchImplementationVersion: route.researchImplementationVersion }));
    await client.automationRun.update({ where: { id: second.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...second.audit, simulatorResearchPriorFailures: { version: 1, sourceFingerprint: f.fingerprint, routes: legacyRoutes } } as unknown as Prisma.InputJsonValue } });
    const third = await replacement(second.audit);
    expect(third.claimed.researchGuide.priorBlockedRoutes).toEqual([]);
    expect(third.audit.simulatorResearchPriorFailures!.routes).toContainEqual(expect.objectContaining({ url: bays, rendered: true,
      observedAt: oldAt, accessControlsObserved: true, accessControls: [], renderComplete: false }));
    await client.automationRun.update({ where: { id: third.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...third.audit, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
        history: [incomplete(new Date().toISOString())], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } } as unknown as Prisma.InputJsonValue } });
    const fourth = await replacement(third.audit);
    expect(fourth.claimed.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: bays, rendered: true,
      observedAt: expect.any(String), accessControls: [] }));
    expect(fourth.claimed.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
    const complete = { ...incomplete(new Date().toISOString()), renderWarning: undefined,
      publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
        accessControls: [], method: "BROWSER" as const, renderComplete: true } };
    await client.automationRun.update({ where: { id: fourth.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...fourth.audit, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
        history: [complete], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } } as unknown as Prisma.InputJsonValue } });
    const fifth = await replacement(fourth.audit);
    expect(fifth.claimed.researchGuide.priorBlockedRoutes).toEqual([]);
    expect(fifth.claimed.researchGuide.suggestedReads).toContainEqual({ source: "booking", rendered: true });
    const challenged = { ...incomplete(new Date().toISOString()),
      publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
        accessControls: ["ACCOUNT_REQUIRED" as const], method: "BROWSER" as const, renderComplete: false } };
    await client.automationRun.update({ where: { id: fifth.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...fifth.audit, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
        history: [challenged], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } } as unknown as Prisma.InputJsonValue } });
    const sixth = await replacement(fifth.audit);
    expect(sixth.claimed.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: bays, rendered: true,
      accessControls: ["ACCOUNT_REQUIRED"] }));
    expect(sixth.claimed.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
    await client.automationRun.update({ where: { id: sixth.run.id }, data: { status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(),
      audit: { ...sixth.audit, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
        history: [complete], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } } as unknown as Prisma.InputJsonValue } });
    const seventh = await replacement(sixth.audit);
    expect(seventh.claimed.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: bays, rendered: true,
      accessControls: ["ACCOUNT_REQUIRED"] }));
    expect(seventh.claimed.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
  });

  it("keeps a newer copied cooldown clock over older matching history", async () => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays";
    const f = await fixture(15, false, bays);
    const original = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const earlier = new Date(Date.now() - 61 * 60_000).toISOString(), later = new Date(Date.now() - 10 * 60_000).toISOString();
    const requestId = randomUUID();
    const route = { url: bays, rendered: true, httpStatus: 200, observedAt: later, requestId, outcome: "READ" as const,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
      renderWarning: "SECONDARY_REQUEST_BUDGET_EXHAUSTED" as const,
      accessControlsObserved: true as const, accessControls: [], renderComplete: false };
    const historical = { ...original, assignmentRef: `course-assignment-${randomUUID()}`,
      simulatorResearchPriorFailures: { version: 1 as const, sourceFingerprint: f.fingerprint, routes: [route] },
      simulatorResearch: { version: 1 as const, sourceFingerprint: f.fingerprint, readCount: 1, links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null,
        history: [{ source: "booking" as const, requestedUrl: bays, sourceUrl: bays, sourceFingerprint: f.fingerprint,
          observedAt: earlier, httpStatus: 200, rendered: true, outcome: "READ" as const, requestId,
          researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION,
          renderWarning: route.renderWarning,
          publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true as const,
            accessControls: [], method: "BROWSER" as const, renderComplete: false } }] } };
    const prior = await client.automationRun.create({ data: { kind: "OTHER", status: "COMPLETED", completedAt: new Date(),
      promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, outcome: "simulator_retryable_failed", audit: historical as unknown as Prisma.InputJsonValue } });
    ids.runs.push(prior.id);
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ observedAt: later }));
    expect(inspected.researchGuide.suggestedReads).not.toContainEqual({ source: "booking", rendered: true });
  });

  it("supersedes only a descendant owned release and invalidates old deployment and recheck proof", async () => {
    const f = await fixture();
    const path = "src/lib/simulators/providers/new-reader.ts";
    const claimed = await lane.claimSimulatorSupportPath({ ...f.owner, path });
    if (!claimed.acquired) throw new Error("Path claim failed.");
    let owner = { ...f.owner, revision: claimed.value.revision };
    const branch = `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`;
    const firstSha = "b".repeat(40), repairedSha = "c".repeat(40), newerMainSha = "d".repeat(40);
    const first = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: firstSha, trustedUpstreamSha: baseSha,
      branch, committedPaths: [path], upstreamDescendantVerified: true, descendantVerified: true });
    if (!first.acquired) throw new Error("First release failed."); owner = { ...owner, revision: first.value.revision };
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: firstSha,
      deployedAt: new Date(Date.now() - 5000).toISOString(), deploymentId: "dpl_old", deploymentUrl: "https://old.vercel.app",
      source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Old deployment fixture failed."); owner = { ...owner, revision: deployed.value.revision };
    const oldQueued = await lane.queueSimulatorSupportRechecks(owner);
    if (!oldQueued.acquired) throw new Error("Old first recheck fixture failed."); owner = { ...owner, revision: oldQueued.value.revision };
    const previousScheduleVersion = (await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).scheduleVersion;
    const row = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = row.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.recheckQueuedAt = new Date(Date.now() - 1000).toISOString();
    audit.simulatorClaim!.verificationCycle = 2;
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: JSON.parse(JSON.stringify(audit)) } });
    const repairing = await lane.claimSimulatorSupportPath({ ...owner, path });
    if (!repairing.acquired) throw new Error("Original-owner repair did not open."); owner = { ...owner, revision: repairing.value.revision };
    const opened = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      import("./course-support-course-dispatch").CourseDispatchAudit & { simulatorRepairPending: Record<string, unknown> };
    expect(opened.simulatorClaim).toMatchObject({ phase: "IMPLEMENTING", releaseSha: firstSha, deployment: null,
      recheckQueuedAt: null, verificationCycle: 0 });
    expect(opened.simulatorRepairPending).toMatchObject({ releaseSha: firstSha, deployment: { commitSha: firstSha },
      verificationCycle: 2 });
    await expect(lane.recordSimulatorSupportDeployment({ ...owner, proof })).rejects.toThrow("current owner release");
    await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("verified exact production deployment");
    await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("deployed rechecks");
    const replacement = { ...owner, releaseSha: repairedSha, trustedUpstreamSha: newerMainSha, branch,
      committedPaths: [path], upstreamDescendantVerified: true, descendantVerified: true,
      priorReleaseDescendantVerified: true };
    await expect(lane.registerSimulatorSupportRelease({ ...replacement, priorReleaseDescendantVerified: false })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...replacement, committedPaths: ["src/lib/simulators/providers/foreign.ts"] })).rejects.toThrow("provenance");
    await expect(lane.registerSimulatorSupportRelease({ ...replacement, ownerThreadId: "replacement" })).rejects.toThrow();
    const changed = await lane.registerSimulatorSupportRelease(replacement);
    if (!changed.acquired) throw new Error("Owned supersession failed.");
    owner = { ...owner, revision: changed.value.revision };
    const stored = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      import("./course-support-course-dispatch").CourseDispatchAudit & { simulatorReleaseHistory: Array<Record<string, unknown>>;
        simulatorRepairPending: null };
    expect(stored.simulatorClaim).toMatchObject({ releaseSha: repairedSha, deployment: null, recheckQueuedAt: null,
      verificationCycle: 0, phase: "VERIFYING" });
    expect(stored.simulatorReleaseHistory).toMatchObject([{ releaseSha: firstSha, deployment: { commitSha: firstSha },
      verificationCycle: 2, supersededBySha: repairedSha }]);
    expect(stored.simulatorRepairPending).toBeNull();
    await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("verified exact production deployment");
    await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("deployed rechecks");
    const same = await lane.registerSimulatorSupportRelease({ ...replacement, revision: owner.revision });
    expect(same).toMatchObject({ acquired: true, value: { revision: owner.revision } });
    const unchanged = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      { simulatorReleaseHistory: unknown[] };
    expect(unchanged.simulatorReleaseHistory).toHaveLength(1);
    const newProof = { ...proof, commitSha: repairedSha, deploymentId: "dpl_repaired",
      deploymentUrl: "https://repaired.vercel.app" };
    const newlyDeployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof: newProof });
    if (!newlyDeployed.acquired) throw new Error("New deployment registration failed.");
    owner = { ...owner, revision: newlyDeployed.value.revision };
    const newQueued = await lane.queueSimulatorSupportRechecks(owner);
    if (!newQueued.acquired) throw new Error("New first verification dispatch failed.");
    owner = { ...owner, revision: newQueued.value.revision };
    expect((await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).scheduleVersion)
      .toBe(previousScheduleVersion + 1);
    await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("first fresh successful observation");
    expect((await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).scheduleVersion)
      .toBe(previousScheduleVersion + 1);
    const refreshed = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: newerMainSha,
      trustedUpstreamSha: newerMainSha, branch, committedPaths: [], upstreamDescendantVerified: true,
      descendantVerified: true, priorReleaseDescendantVerified: true });
    expect(refreshed).toMatchObject({ acquired: true, value: { phase: "VERIFYING" } });
  });

  it("repairs reviewed offering metadata on the same reader release and invalidates old verification", async () => {
    const f = await fixture();
    const manifest = { googlePlaceId: f.course.googlePlaceId, name: f.course.name, address: f.course.address!,
      latitude: f.course.latitude, longitude: f.course.longitude, website: f.course.website!,
      bookingUrl: "https://official.example.test/book", evidenceUrl: f.course.website!,
      verifiedAt: new Date().toISOString(), publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60],
      providerFamilyKey: "GOLFBOOK" };
    const configured = await lane.configureSimulatorSupportOffering({ ...f.owner, manifest, apply: true,
      expectedFingerprint: f.fingerprint, expectedOfferingRevision: f.offering.monitoringRevision });
    if (!configured.acquired || configured.value.mode !== "applied") throw new Error("Initial metadata fixture failed.");
    let owner = { ...f.owner, revision: configured.value.revision };
    const adopted = await lane.adoptSimulatorSupportSource({ ...owner,
      expectedFingerprint: configured.value.sourceFingerprint, expectedOfferingRevision: configured.value.offeringRevision });
    if (!adopted.acquired) throw new Error("Initial source adoption failed.");
    owner = { ...owner, revision: adopted.value.revision };
    const path = "src/lib/simulators/providers/new-reader.ts";
    const planned = await lane.claimSimulatorSupportPath({ ...owner, path });
    if (!planned.acquired) throw new Error("Reader path fixture failed.");
    owner = { ...owner, revision: planned.value.revision };
    const branch = `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`;
    const readerSha = "b".repeat(40);
    const released = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: readerSha,
      trustedUpstreamSha: baseSha, upstreamDescendantVerified: true, descendantVerified: true,
      branch, committedPaths: [path] });
    if (!released.acquired) throw new Error("Reader release fixture failed.");
    owner = { ...owner, revision: released.value.revision };
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: readerSha,
      deployedAt: new Date(Date.now() - 5_000).toISOString(), deploymentId: "dpl_old", deploymentUrl: "https://old.vercel.app",
      source: "git" as const, state: "READY" as const };
    const deployed = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    if (!deployed.acquired) throw new Error("Reader deployment fixture failed.");
    owner = { ...owner, revision: deployed.value.revision };
    const queued = await lane.queueSimulatorSupportRechecks(owner);
    if (!queued.acquired) throw new Error("First verification fixture failed.");
    owner = { ...owner, revision: queued.value.revision };
    const current = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    const corrected = { ...manifest, verifiedAt: new Date().toISOString(), bookingUrl: "https://official.example.test/corrected-book" };
    await expect(lane.configureSimulatorSupportOffering({ ...owner, manifest: corrected, apply: true,
      expectedFingerprint: getSimulatorOfferingSourceFingerprint(current), expectedOfferingRevision: current.monitoringRevision }))
      .rejects.toThrow("sealed");
    const repair = await lane.configureSimulatorSupportOffering({ ...owner, manifest: corrected, apply: true, repair: true,
      expectedFingerprint: getSimulatorOfferingSourceFingerprint(current), expectedOfferingRevision: current.monitoringRevision });
    if (!repair.acquired || repair.value.mode !== "applied") throw new Error("Metadata repair failed.");
    owner = { ...owner, revision: repair.value.revision };
    const invalidated = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      import("./course-support-course-dispatch").CourseDispatchAudit & { simulatorMetadataRepairHistory: Array<Record<string, unknown>> };
    expect(invalidated.simulatorClaim).toMatchObject({ releaseSha: readerSha, deployment: null,
      recheckQueuedAt: null, verificationCycle: 0, phase: "VERIFYING" });
    expect(invalidated.simulatorMetadataRepairHistory).toMatchObject([{ releaseSha: readerSha,
      deployment: { commitSha: readerSha }, replacementSourceFingerprint: repair.value.sourceFingerprint }]);
    await expect(lane.recordSimulatorSupportDeployment({ ...owner, proof })).rejects.toThrow("source changed");
    const readopted = await lane.adoptSimulatorSupportSource({ ...owner,
      expectedFingerprint: repair.value.sourceFingerprint, expectedOfferingRevision: repair.value.offeringRevision });
    if (!readopted.acquired) throw new Error("Corrected source adoption failed.");
    owner = { ...owner, revision: readopted.value.revision };
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({
      simulatorClaim: { releaseSha: readerSha, deployment: null, recheckQueuedAt: null, verificationCycle: 0 } });
    await expect(lane.queueSimulatorSupportRechecks(owner)).rejects.toThrow("verified exact production deployment");
    await expect(lane.completeSimulatorSupport({ ...owner, currentDeployment: proof })).rejects.toThrow("deployed rechecks");
    const sameRelease = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha: readerSha,
      trustedUpstreamSha: baseSha, upstreamDescendantVerified: true, descendantVerified: true,
      branch, committedPaths: [] });
    expect(sameRelease).toMatchObject({ acquired: true, value: { revision: owner.revision } });
    const freshProof = await lane.recordSimulatorSupportDeployment({ ...owner, proof });
    expect(freshProof).toMatchObject({ acquired: true });
  });

  it("preserves implementation provenance on an unknown read failure instead of automatically closing it", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/repair.test.ts" });
    if (!planned.acquired) throw new Error("Implementation test path was busy.");
    f.owner.revision = planned.value.revision;
    const raw = "sensitive browser detail https://secret.example.test/token";
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official", rendered: true }, {
      browser: async () => { throw new Error(raw); },
    })).rejects.toThrow("SIMULATOR_RESEARCH_HARD_FAILED");
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.revision).toBe(f.owner.revision + 2);
    expect(inspected.research).toMatchObject({ readCount: 1, inFlight: null, history: [{ outcome: "HARD_FAILED", httpStatus: 0,
      failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_LAUNCH" } }] });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "RUNNING", outcome: "simulator_research_hard_failed" });
    expect(JSON.stringify(inspected.research)).not.toContain(raw);
    expect(inspected.failedRead).toMatchObject({ revision: inspected.revision, readsUsed: 1, readsRemaining: 5,
      failure: { stage: "PUBLIC_READ", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_LAUNCH" } });
    expect(inspected.researchGuide.suggestedReads).toContainEqual({ source: "booking", rendered: false });
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context).toMatchObject({ currentSource: true, currentClaimRevision: inspected.revision, providerReadInFlight: false,
      checkpoint: { kind: "EXPIRED_OWNED_STAGE", readCount: 1, requestId: null,
        ownedStage: { phase: "IMPLEMENTING", plannedPaths: ["src/lib/simulators/providers/repair.test.ts"] } } });
    expect(context.checkpoint!.allowedResearchRouteCount).toBeGreaterThan(0);
    await expect(lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: "replacement" })).rejects.toThrow("not owned");
    await expect(lane.recoverSimulatorSupport({ ...f.owner, ownerThreadId: "replacement", revision: inspected.revision })).rejects.toThrow();
    const recovered = await lane.recoverSimulatorSupport({ ...f.owner, revision: inspected.revision });
    if (!recovered.acquired) throw new Error("Original-owner recovery was busy.");
    expect(recovered.value.revision).toBe(inspected.revision + 1);
    const after = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(after.research).toMatchObject({ readCount: 1, inFlight: null });
    expect(after.research.lastRecoveredFailureRequestId).toBe(after.research.history[0].requestId);
    expect(after.failedRead).toBeNull();
    const recoveredAudit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect((await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, recoveredAudit, new Date()))).checkpoint).toBeNull();
    await expect(lane.recoverSimulatorSupport({ ...f.owner, revision: recovered.value.revision })).rejects.toThrow("lease expires");
    const booking = await lane.readSimulatorSupportSource({ ...f.owner, revision: recovered.value.revision, source: "booking" },
      vi.fn(async () => new Response("<p>Public rental calendar</p>", { headers: { "content-type": "text/html" } })));
    if (!booking.acquired) throw new Error("Alternate bounded route was busy.");
    expect(booking.value.readsRemaining).toBe(4);
    await expect(lane.retrySimulatorSupport({ ...f.owner, revision: booking.value.revision, retryMinutes: 15 })).rejects.toThrow("unfinished simulator implementation");
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "RUNNING",
      audit: { simulatorClaim: { phase: "IMPLEMENTING", plannedPaths: ["src/lib/simulators/providers/repair.test.ts"] } } });
  });

  it("closes a research-only hard failure and automatically fences the old executor without sending or rechecking", async () => {
    const matchSendsBefore = coreMocks.sendMatch.mock.calls.length, statusSendsBefore = coreMocks.sendStatus.mock.calls.length;
    const f = await fixture(15, false, "https://official.example.test/booking");
    const offeringBefore = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    const searchBefore = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const browser = vi.fn(async () => { throw new Error("Unknown collector detail must remain private"); });
    let failure: unknown;
    try { await lane.readSimulatorSupportSource({ ...f.owner, source: "official", rendered: true }, { browser }); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ message: "SIMULATOR_RESEARCH_HARD_FAILED", durableCloseoutRecorded: true, revision: f.owner.revision + 2, retryAt: expect.any(String) });
    const closed = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = closed.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(closed).toMatchObject({ status: "COMPLETED", outcome: "simulator_research_failed", completedAt: expect.any(Date) });
    expect(audit.simulatorResearch).toMatchObject({ readCount: 1, inFlight: null, history: [{ outcome: "HARD_FAILED", httpStatus: 0, requestId: expect.any(String) }] });
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    expect(incident).toMatchObject({ status: "AUTO_INVESTIGATING", resolvedAt: null });
    expect(incident.retryAt!.getTime() - closed.completedAt!.getTime()).toBe(15 * 60_000);
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).toEqual(offeringBefore);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(searchBefore);
    const oldOwner = { ...f.owner, revision: audit.simulatorClaim!.revision };
    const fetch = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...oldOwner, source: "booking" }, { fetch })).rejects.toThrow("unavailable");
    await expect(lane.claimSimulatorSupportPath({ ...oldOwner, path: "src/lib/simulators/providers/late.ts" })).rejects.toThrow("unavailable");
    await expect(lane.queueSimulatorSupportRechecks(oldOwner)).rejects.toThrow("unavailable");
    await expect(lane.recoverSimulatorSupport(oldOwner)).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled(); expect(browser).toHaveBeenCalledOnce();
    expect(coreMocks.sendMatch).toHaveBeenCalledTimes(matchSendsBefore); expect(coreMocks.sendStatus).toHaveBeenCalledTimes(statusSendsBefore);
    // Only the isolated fixture's clock is advanced to model the normal due tick.
    const due = await client.simulatorSupportIncident.update({ where: { id: incident.id }, data: { retryAt: new Date(0) } });
    const child = `replacement-${randomUUID()}`, assignmentRef = `course-assignment-${randomUUID()}`;
    const next = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
      ownerThreadId: "next-parent", audit: { ...audit, assignmentRef, ownerThreadId: "next-parent", childThreadId: child, state: "BOUND", boundAt: new Date().toISOString(),
        simulatorClaim: undefined, simulatorResearch: undefined, simulatorResearchPriorFailures: undefined, target: { ...audit.target, updatedAt: due.updatedAt.toISOString() } } as unknown as Prisma.InputJsonValue } });
    ids.runs.push(next.id);
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: "automation/course-support-new-execution" });
    if (!claimed.acquired) throw new Error("Replacement execution was busy.");
    expect(claimed.value.token).not.toBe(f.owner.token);
    expect(claimed.value.researchGuide.suggestedReads).not.toContainEqual({ source: "official", rendered: true });
    expect(claimed.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: f.course.website, rendered: true, httpStatus: 0,
      failure: expect.objectContaining({ stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_LAUNCH" }) }));
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(closed);
  });

  it("rejects a simulator claim after its finite startup deadline without altering source or incident", async () => {
    const f = await fixture();
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    const unclaimed = { ...audit, state: "BOUND", reservedAt: old, boundAt: old, simulatorClaim: undefined, simulatorResearchPriorFailures: undefined };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: unclaimed as unknown as Prisma.InputJsonValue } });
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    await expect(lane.claimSimulatorSupportAssignment({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId, baseSha, branch: "automation/course-support-late" })).rejects.toThrow("expired");
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(incident);
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({ state: "BOUND", boundAt: old });
  });

  it("automatically closes a crashed research executor on the ordinary planner while retaining its spent request", async () => {
    const f = await fixture(); const requestId = await seedExpiredUnfinishedRead(f);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const offeringBefore = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    const now = new Date();
    const planned = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "automatic-recovery-parent", baseSha, now });
    expect(planned.acquired).toBe(true);
    const closed = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(closed).toMatchObject({ status: "COMPLETED", outcome: "simulator_research_failed" });
    expect(closed.audit).toMatchObject({ simulatorClaim: { token: f.owner.token, revision: f.owner.revision },
      simulatorResearch: { readCount: 1, inFlight: null, history: [{ requestId, httpStatus: 0, outcome: "HARD_FAILED",
        failure: { category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" } }] },
      simulatorFailureRecovery: { reason: "EXECUTOR_LEASE_EXPIRED", readsUsed: 1 } });
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    expect(incident.retryAt!.getTime()).toBe(now.getTime() + 15 * 60_000);
    expect(incident.status).toBe("AUTO_INVESTIGATING");
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).toEqual(offeringBefore);
    await expect(lane.recoverSimulatorSupport(f.owner)).rejects.toThrow("unavailable");
    const fetch = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, { fetch })).rejects.toThrow("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not reclaim a still-bounded read or an expired implementation executor", async () => {
    const f = await fixture(); await seedExpiredUnfinishedRead(f);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    audit.simulatorResearch!.inFlight!.expiresAt = new Date(Date.now() + 30_000).toISOString();
    const bounded = await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "recovery-parent", baseSha });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(bounded);
    audit.simulatorResearch!.inFlight!.expiresAt = new Date(Date.now() - 30_000).toISOString();
    audit.simulatorClaim!.phase = "IMPLEMENTING";
    audit.simulatorClaim!.plannedPaths = ["src/lib/simulators/providers/owned.ts"];
    const implementing = await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "recovery-parent", baseSha });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(implementing);
  });

  it("ends an expired research executor when its demand is withdrawn without reviving or retrying that demand", async () => {
    const f = await fixture();
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } });
    const incidentBefore = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } });
    await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "recovery-parent", baseSha });
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toMatchObject({ status: "COMPLETED", outcome: "simulator_source_withdrawn" });
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toEqual(incidentBefore);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toMatchObject({ status: "PAUSED" });
  });

  it.each(["range-shape", "rental-filter"] as const)("carries all denied routes and %s diagnostics across more than four retries, including withdrawn research", async diagnosticKind => {
    const bays = "https://yourgolfbooking.com/venues/owned-simulator/booking/bays", root = bays.replace(/\/bays$/u, "");
    const f = await fixture(15, false, bays);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const initial = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    await client.automationRun.update({ where: { id: f.run.id }, data: { status: "COMPLETED", outcome: "fixture_preparation", completedAt: new Date() } });
    const denied = [{ url: f.course.website!, rendered: false }, { url: f.course.website!, rendered: true },
      { url: bays, rendered: false }, { url: bays, rendered: true }, { url: root, rendered: false }, { url: root, rendered: true }];
    const configurationDiagnostic = diagnosticKind === "range-shape"
      ? { phase: "RANGES", reason: "CONFIG_SHAPE", field: { path: "ranges", expectedType: "OBJECT", actualType: "MISSING" } }
      : { phase: "RENTALS", reason: "CONFIG_NO_ELIGIBLE_RENTALS", optionCount: 3,
          rejectedRentalOptionsTruncated: false, maintenanceModeState: "NULL",
          rejectedRentalOptions: [
            { adminOnlyState: "FALSE", publicOptionId: "321", typeToken: "golf_sim", categoryToken: "baytime", reason: "TYPE_NOT_SIMULATOR" },
            { adminOnlyState: "TRUE", reason: "ADMIN_ONLY_NOT_FALSE" },
            { adminOnlyState: "MISSING", reason: "ADMIN_ONLY_NOT_FALSE" },
          ] };
    for (const [index, route] of denied.entries()) {
      const observedAt = new Date(Date.now() - (denied.length - index) * 60_000).toISOString();
      const hard = { outcome: "HARD_FAILED", httpStatus: 0, requestId: randomUUID(), failure: {
        stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_DOCUMENT" } };
      const incomplete = { outcome: "READ", httpStatus: 200, requestId: randomUUID(),
        publicReadEvidence: { sourceFingerprint: f.fingerprint, accessControlsObserved: true, accessControls: [], method: "BROWSER", renderComplete: false },
        researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION, renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED",
        bodyLimitDiagnostics: [{ resourceKind: "SECONDARY_SCRIPT", phase: "TRANSPORT_HEADERS", observedSizeBand: "OVER_2X_UP_TO_4X", count: 1 }],
        configurationDiagnostic };
      const historical = { ...initial, assignmentRef: `course-assignment-${randomUUID()}`, childThreadId: `legacy-${randomUUID()}`,
        simulatorResearchPriorFailures: undefined, simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: 1, inFlight: null, links: [], bookingLinks: [], linkBaseUrl: null,
          history: [{ source: "booking", requestedUrl: route.url, sourceUrl: route.url, observedAt, rendered: route.rendered, httpStatus: 403, outcome: "READ",
            ...(index < 2 ? hard : index === 3 ? incomplete : {}) }] } };
      const run = await client.automationRun.create({ data: { kind: "OTHER", status: "COMPLETED", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        startedAt: new Date(observedAt), completedAt: new Date(observedAt), outcome: index === 1 ? "simulator_source_withdrawn" : "simulator_retryable_failed", audit: historical as unknown as Prisma.InputJsonValue } });
      ids.runs.push(run.id);
    }
    for (let index = 0; index < 6; index++) {
      const due = await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
      const assignmentRef = `course-assignment-${randomUUID()}`, child = `current-${randomUUID()}`;
      const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        audit: { ...initial, assignmentRef, childThreadId: child, state: "BOUND", boundAt: new Date().toISOString(), simulatorClaim: undefined,
          simulatorResearchPriorFailures: undefined, target: { ...initial.target, updatedAt: due.updatedAt.toISOString() } } as unknown as Prisma.InputJsonValue } });
      ids.runs.push(run.id);
      const claim = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: `automation/course-support-retry-${index}` });
      if (!claim.acquired) throw new Error("Owned retry test was busy.");
      expect(claim.value.researchGuide.priorBlockedRoutes).toHaveLength(6);
      expect(claim.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: f.course.website, rendered: true,
        failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_DOCUMENT" } }));
      expect(claim.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: bays, rendered: true,
        configurationDiagnostic,
        bodyLimitDiagnostics: [{ resourceKind: "SECONDARY_SCRIPT", phase: "TRANSPORT_HEADERS", observedSizeBand: "OVER_2X_UP_TO_4X", count: 1 }] }));
      expect(claim.value.researchGuide.suggestedReads).toEqual([]);
      const owner = { assignmentRef, ownerThreadId: child, token: claim.value.token, revision: claim.value.revision };
      const fetch = vi.fn();
      await expect(lane.readSimulatorSupportSource({ ...owner, source: "official" }, { fetch })).rejects.toThrow("structural source failure");
      expect(fetch).not.toHaveBeenCalled();
      const retry = await lane.retrySimulatorSupport({ ...owner, retryMinutes: 15 });
      expect(retry.acquired && retry.value.durableCloseoutRecorded).toBe(true);
      expect((await client.automationRun.findUniqueOrThrow({ where: { id: run.id } })).audit).toMatchObject({ simulatorResearchPriorFailures: { sourceFingerprint: f.fingerprint, routes: expect.any(Array) } });
    }
  });

  it.each(["recovered", "legacy-recovered", "access-denied", "challenged", "foreign-source"] as const)("uses actual later partial recovery while preserving %s history and customer state", async scenario => {
    const bays = "https://yourgolfbooking.com/venues/public-golf/booking/bays";
    const f = await fixture(15, false, bays);
    const before = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const initial = before.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const earlier = new Date(Date.now() - 4 * 60 * 60_000).toISOString();
    const failedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const observedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const failure = { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "HTTP_READ" };
    const positiveFingerprint = scenario === "foreign-source" ? "b".repeat(64) : f.fingerprint;
    const history = [
      { source: "booking", requestedUrl: bays, sourceUrl: bays, sourceFingerprint: f.fingerprint,
        observedAt: earlier, httpStatus: scenario === "challenged" ? 503 : 403,
        rendered: scenario === "access-denied" || scenario === "challenged", outcome: "READ", requestId: randomUUID(),
        ...(scenario === "challenged" ? { publicReadEvidence: { sourceFingerprint: f.fingerprint,
          accessControlsObserved: true, accessControls: ["CAPTCHA_OR_CHALLENGE"], method: "BROWSER", renderComplete: false } } : {}) },
      { source: "booking", requestedUrl: bays, sourceUrl: bays, sourceFingerprint: f.fingerprint,
        observedAt: failedAt, httpStatus: 0, rendered: true, outcome: "HARD_FAILED", requestId: randomUUID(), failure },
      { source: "booking", requestedUrl: bays, sourceUrl: bays, sourceFingerprint: positiveFingerprint,
        observedAt, httpStatus: 200, rendered: true, outcome: "READ", requestId: randomUUID(),
        ...(scenario !== "legacy-recovered" ? { renderWarning: "SECONDARY_ASSET_BODY_LIMIT_EXCEEDED" } : {}), publicReadEvidence: { sourceFingerprint: positiveFingerprint,
          accessControlsObserved: true, accessControls: [], method: "BROWSER", renderComplete: false } },
    ];
    const legacyBudgetFailure = { stage: "PUBLIC_READ", category: "BUDGET", code: "PUBLIC_BODY_LIMIT",
      researchPhase: "HTTP_READ", researchResourceKind: "SECONDARY_SCRIPT" };
    if (scenario === "legacy-recovered") history.splice(2, 0, {
      source: "booking", requestedUrl: bays, sourceUrl: bays, sourceFingerprint: f.fingerprint,
      observedAt: new Date(Date.now() - 150 * 60_000).toISOString(), httpStatus: 0,
      rendered: true, outcome: "HARD_FAILED", requestId: randomUUID(), failure: legacyBudgetFailure,
    });
    const closed = await client.automationRun.update({ where: { id: f.run.id }, data: {
      status: "COMPLETED", outcome: "simulator_retryable_failed", completedAt: new Date(observedAt),
      audit: { ...initial, reservedAt: earlier, launchStartedAt: earlier, boundAt: earlier,
        consumedAt: earlier, simulatorClaim: { ...initial.simulatorClaim, claimedAt: earlier },
        simulatorResearch: { version: 1, sourceFingerprint: f.fingerprint, readCount: history.length, history,
          links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null },
        simulatorResearchPriorFailures: { version: 1, sourceFingerprint: f.fingerprint,
          routes: [{ url: bays, rendered: true, httpStatus: 0,
            failure: scenario === "legacy-recovered" ? legacyBudgetFailure : failure }] },
      } as unknown as Prisma.InputJsonValue,
    } });
    const searchBefore = await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } });
    const offeringBefore = await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } });
    const due = await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
    const child = `next-child-${randomUUID()}`, assignmentRef = `course-assignment-${randomUUID()}`;
    const next = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING",
      promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, ownerThreadId: "next-parent",
      audit: { ...initial, assignmentRef, ownerThreadId: "next-parent", childThreadId: child,
        state: "BOUND", consumedAt: undefined, boundAt: new Date().toISOString(), simulatorClaim: undefined,
        simulatorResearch: undefined, simulatorResearchPriorFailures: undefined,
        target: { ...initial.target, updatedAt: due.updatedAt.toISOString() },
      } as unknown as Prisma.InputJsonValue } }); ids.runs.push(next.id);
    const claim = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child,
      baseSha, branch: "automation/course-support-recovered-research" });
    if (!claim.acquired) throw new Error("Recovered research claim was busy.");
    const permitsPlain = claim.value.researchGuide.suggestedReads.some(route => route.source === "booking" && !route.rendered);
    expect(permitsPlain).toBe(scenario === "access-denied" || scenario === "challenged");
    const permitsRendered = claim.value.researchGuide.suggestedReads.some(route => route.source === "booking" && route.rendered);
    const permitsRecovery = scenario === "recovered" || scenario === "legacy-recovered";
    expect(permitsRendered).toBe(permitsRecovery);
    if (permitsRecovery) {
      expect(claim.value.researchGuide.priorBlockedRoutes).not.toContainEqual(expect.objectContaining({ rendered: true, failure }));
      expect(claim.value.researchGuide.priorBlockedRoutes).not.toContainEqual(expect.objectContaining({ url: bays, rendered: true }));
      expect(claim.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({ url: bays, rendered: false, httpStatus: 403 }));
    }
    if (scenario === "challenged") {
      const protectedRoute = { url: bays, rendered: true, httpStatus: 503,
        accessControlsObserved: true, accessControls: ["CAPTCHA_OR_CHALLENGE"], observedAt: earlier };
      expect(claim.value.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining(protectedRoute));
      expect((await client.automationRun.findUniqueOrThrow({ where: { id: next.id } })).audit)
        .toMatchObject({ simulatorResearchPriorFailures: { routes: expect.arrayContaining([expect.objectContaining(protectedRoute)]) } });
    }
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).toEqual(closed);
    expect(await client.teeSearch.findUniqueOrThrow({ where: { id: f.search.id } })).toEqual(searchBefore);
    expect(await client.courseOffering.findUniqueOrThrow({ where: { id: f.offering.id } })).toEqual(offeringBefore);
    expect(coreMocks.fetch).not.toHaveBeenCalled(); expect(coreMocks.sendMatch).not.toHaveBeenCalled(); expect(coreMocks.sendStatus).not.toHaveBeenCalled();
  });

  it("retains spent reads through adoption without carrying old-source failures into the replacement source", async () => {
    const f = await fixture();
    const before = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const initial = before.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, { fetch: vi.fn(async () => new Response("unavailable", { status: 403 })) });
    if (!read.acquired) throw new Error("Expected owned source observation.");
    const changed = await client.courseOffering.update({ where: { id: f.offering.id }, data: { publicAccessStatus: "PUBLIC", verifiedAt: new Date(),
      evidenceUrl: f.course.website, supportedDurationsMinutes: [60], monitoringRevision: { increment: 1 } } });
    const changedFingerprint = getSimulatorOfferingSourceFingerprint(changed);
    const adopted = await lane.adoptSimulatorSupportSource({ ...f.owner, revision: read.value.revision,
      expectedFingerprint: changedFingerprint, expectedOfferingRevision: changed.monitoringRevision });
    if (!adopted.acquired) throw new Error("Expected reviewed source adoption.");
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({
      simulatorResearch: { sourceFingerprint: changedFingerprint, readCount: 1, history: [{ sourceFingerprint: f.fingerprint, httpStatus: 403 }] } });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } });
    await lane.retireSimulatorSupport({ ...f.owner, revision: adopted.value.revision });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "ACTIVE" } });
    const fresh = async (fingerprint: string) => {
      const due = await client.simulatorSupportIncident.update({ where: { id: f.incident.id }, data: { retryAt: new Date(0) } });
      await client.courseProbe.create({ data: { courseId: f.course.id, offeringId: f.offering.id, teeSearchId: f.search.id,
        outcome: "NEEDS_ADAPTER", rawSummary: { mode: "SIMULATOR", sourceFingerprint: fingerprint } } });
      const assignmentRef = `course-assignment-${randomUUID()}`, child = `new-child-${randomUUID()}`;
      const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION,
        audit: { ...initial, assignmentRef, childThreadId: child, state: "BOUND", boundAt: new Date().toISOString(), simulatorClaim: undefined,
          simulatorResearch: undefined, simulatorResearchPriorFailures: undefined,
          target: { ...initial.target, offeringSourceFingerprint: fingerprint, updatedAt: due.updatedAt.toISOString() } } as unknown as Prisma.InputJsonValue } });
      ids.runs.push(run.id);
      const result = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: `automation/course-support-${randomUUID()}` });
      if (!result.acquired) throw new Error("Expected replacement claim.");
      return { result: result.value, owner: { assignmentRef, ownerThreadId: child, token: result.value.token, revision: result.value.revision } };
    };
    const replacement = await fresh(changedFingerprint);
    expect(replacement.result.researchGuide.priorBlockedRoutes).toEqual([]);
    expect(replacement.result.researchGuide.suggestedReads[0]).toEqual({ source: "official", rendered: false });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } });
    await lane.retireSimulatorSupport(replacement.owner);
    await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "ACTIVE" } });
    const returned = await client.courseOffering.update({ where: { id: f.offering.id }, data: { publicAccessStatus: f.offering.publicAccessStatus,
      verifiedAt: f.offering.verifiedAt, evidenceUrl: f.offering.evidenceUrl, supportedDurationsMinutes: f.offering.supportedDurationsMinutes } });
    expect(getSimulatorOfferingSourceFingerprint(returned)).toBe(f.fingerprint);
    const originalSource = await fresh(f.fingerprint);
    expect(originalSource.result.researchGuide.priorBlockedRoutes).toContainEqual(expect.objectContaining({
      url: f.course.website, rendered: false, httpStatus: 403, observedAt: read.value.publicSource.observedAt,
      requestId: expect.any(String), outcome: "READ", accessControlsObserved: true, accessControls: [],
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION }));
    const fetch = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...originalSource.owner, source: "official" }, { fetch })).rejects.toThrow("structural source failure");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not settle an unknown collector failure after the exact source changes", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official", rendered: true }, {
      browser: async () => {
        await client.courseOffering.update({ where: { id: f.offering.id }, data: { bookingUrl: "https://changed.example.test/book" } });
        throw new Error("untrusted browser failure");
      },
    })).rejects.toThrow("source changed");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    expect(stored.audit).toMatchObject({ simulatorClaim: { revision: f.owner.revision + 1 },
      simulatorResearch: { readCount: 1, history: [], inFlight: { source: "official", rendered: true } } });
    await expect(lane.recoverSimulatorSupport({ ...f.owner, revision: f.owner.revision + 1 })).rejects.toThrow("lease expires");
  });

  it("does not normalize an unrecognized research-prefixed collector exception as a network observation", async () => {
    const f = await fixture();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official", rendered: true }, {
      browser: async () => { throw new Error("SIMULATOR_RESEARCH_NEW_UNCLASSIFIED_FAILURE"); },
    })).rejects.toThrow("SIMULATOR_RESEARCH_HARD_FAILED");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const research = (stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit).simulatorResearch!;
    expect(research.history).toHaveLength(1);
    expect(research.history[0]).toMatchObject({ outcome: "HARD_FAILED", httpStatus: 0,
      failure: { category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" } });
  });

  it.each([
    ["SIMULATOR_RESEARCH_UNSAFE_URL", "ACCESS", "UNSAFE_PUBLIC_URL"],
    ["SIMULATOR_RESEARCH_DESTINATION_CHANGED", "ACCESS", "PUBLIC_DESTINATION_CHANGED"],
    ["SIMULATOR_RESEARCH_BODY_LIMIT", "BUDGET", "PUBLIC_BODY_LIMIT"],
    ["SIMULATOR_RESEARCH_REQUEST_LIMIT", "BUDGET", "PUBLIC_REQUEST_LIMIT"],
    ["SIMULATOR_RESEARCH_REDIRECT_LIMIT", "BUDGET", "PUBLIC_REDIRECT_LIMIT"],
  ])("records %s as a hard %s checkpoint rather than a network result", async (code, category, safeCode) => {
    const f = await fixture();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, source: "official", rendered: true }, {
      browser: async () => { throw new Error(code); },
    })).rejects.toThrow("SIMULATOR_RESEARCH_HARD_FAILED");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(audit.simulatorResearch!.history).toHaveLength(1);
    expect(audit.simulatorResearch!.history[0]).toMatchObject({ outcome: "HARD_FAILED", httpStatus: 0,
      failure: { stage: "PUBLIC_READ", category, code: safeCode } });
    expect(stored).toMatchObject({ status: "COMPLETED", outcome: "simulator_research_failed" });
    const browser = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, revision: audit.simulatorClaim!.revision, source: "official", rendered: true },
      { browser })).rejects.toThrow("unavailable");
    expect(browser).not.toHaveBeenCalled();
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).toMatchObject({ status: "AUTO_INVESTIGATING" });
  });

  it("reconciles an expired unfinished read as a hard interruption while retaining spent budget and saved navigation", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const requestId = randomUUID();
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 2,
      history: [{ source: "official", requestedUrl: f.course.website!, sourceUrl: f.course.website!,
        observedAt: new Date(Date.now() - 120_000).toISOString(), httpStatus: 200, rendered: false, outcome: "READ" }],
      links: ["https://official.example.test/rates"], bookingLinks: [], linkBaseUrl: f.course.website!,
      inFlight: { requestId, startedAt: new Date(Date.now() - 90_000).toISOString(), expiresAt: new Date(Date.now() - 30_000).toISOString(),
        source: "link", url: "https://official.example.test/rates", rendered: true } };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context).toMatchObject({ currentSource: true, leaseValid: false, providerReadInFlight: false,
      checkpoint: { kind: "EXPIRED_UNFINISHED_READ", requestId, readCount: 2 } });
    const recovered = await lane.recoverSimulatorSupport(f.owner);
    if (!recovered.acquired) throw new Error("Original-owner recovery was busy.");
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.research).toMatchObject({ readCount: 2, inFlight: null, links: ["https://official.example.test/rates"],
      linkBaseUrl: f.course.website, lastRecoveredFailureRequestId: requestId });
    expect(inspected.research.history).toHaveLength(2);
    expect(inspected.research.history[0].outcome).toBe("READ");
    expect(inspected.research.history[1]).toMatchObject({ outcome: "HARD_FAILED", requestId,
      failure: { code: "RESEARCH_RESERVATION_INTERRUPTED" } });
    expect(inspected.researchGuide.readsRemaining).toBe(4);
  });

  it("qualifies an expired owned implementation with an expired read, but fences its still-live reservation", async () => {
    const f = await fixture();
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/new-reader.ts" });
    if (!planned.acquired) throw new Error("Owned path fixture was busy.");
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    const requestId = randomUUID(), now = new Date();
    audit.simulatorClaim!.leaseExpiresAt = new Date(now.getTime() - 1_000).toISOString();
    audit.simulatorResearch = { version: 1, sourceFingerprint: f.fingerprint, readCount: 1,
      history: [], links: [], bookingLinks: [], linkBaseUrl: null,
      inFlight: { requestId, startedAt: new Date(now.getTime() - 90_000).toISOString(),
        expiresAt: new Date(now.getTime() - 30_000).toISOString(), source: "official", url: f.course.website!, rendered: false } };
    const expired = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, now));
    expect(expired).toMatchObject({ providerReadInFlight: false,
      checkpoint: { kind: "EXPIRED_OWNED_STAGE", requestId, readCount: 1, claimLeaseExpired: true } });
    audit.simulatorResearch.inFlight!.expiresAt = new Date(now.getTime() + 30_000).toISOString();
    const bounded = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, now));
    expect(bounded).toMatchObject({ providerReadInFlight: true, checkpoint: null });
  });

  it("reserves a second stopped owned-stage turn only from the last durable accepted native turn", async () => {
    const f = await fixture();
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/new-reader.ts" });
    if (!planned.acquired) throw new Error("Owned path fixture was busy.");
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    audit.launcherReceiptPath = "C:\\private\\launcher.receipt.private.json";
    const now = new Date();
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, now));
    expect(context).toMatchObject({ providerReadInFlight: false, checkpoint: { kind: "EXPIRED_OWNED_STAGE",
      claimLeaseExpired: true, ownedStage: { phase: "IMPLEMENTING", plannedPaths: ["src/lib/simulators/providers/new-reader.ts"] } } });
    if (!context.checkpoint) throw new Error("Missing owned stage checkpoint.");
    const { assessCourseSupportContinuationCheckpoint } = await import("./course-support-continuation");
    const mainSha = "c".repeat(40);
    const assessed = assessCourseSupportContinuationCheckpoint({ checkpoint: { ...context.checkpoint,
      providerReadInFlight: context.providerReadInFlight }, currentMainSha: mainSha, now });
    if (!assessed.eligible) throw new Error(`Missing owned checkpoint digest: ${assessed.reason}`);
    const priorTurn = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff", originalTurn = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const priorKey = "d".repeat(64), priorReceipt = "C:\\private\\continuation.receipt.private.json";
    const oldAt = new Date(now.getTime() - 11 * 60_000).toISOString();
    audit.simulatorContinuation = { version: 1, receipts: [{ version: 1,
      policyVersion: "same-native-worker-recovery-v1", key: priorKey,
      checkpointDigest: assessed.checkpointDigest, sourceFingerprint: f.fingerprint,
      nativeCompletionDigest: "e".repeat(64), readinessDigest: "f".repeat(64),
      parentThreadId: "parent", childThreadId: f.owner.ownerThreadId, attempt: 1,
      tickRef: `continuation-${Math.floor(now.getTime() / 600_000) - 1}`,
      requestedAt: oldAt, scope: "RESUME_ORIGINAL_OWNED_STAGE", status: "SENT", sentAt: oldAt,
      nativeTurnId: priorTurn, nativeReceiptPath: priorReceipt }] };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "parent", baseSha: mainSha, maxStarts: 1 });
    if (!plan.acquired) throw new Error("Continuation plan was busy.");
    expect(plan.value.continuationItems).toContainEqual(expect.objectContaining({ assignmentRef: f.owner.assignmentRef,
      expectedNativeContinuation: { turnId: priorTurn, key: priorKey, receiptPath: priorReceipt } }));
    const observedAt = new Date().toISOString();
    const terminal = { version: 1, source: "codex_app.list_threads+codex_native.terminal_turn",
      threadId: f.owner.ownerThreadId, observedAt, threadStatus: "notLoaded", hostId: "local", projectId: "project",
      inventoryUpdatedAt: 1, launcherReceiptDigest: "a".repeat(64), checkoutIdentityDigest: "b".repeat(64),
      observationDigest: "c".repeat(64), priorContinuationTurnId: priorTurn, priorContinuationKey: priorKey,
      priorContinuationReceiptDigest: "d".repeat(64), latestTurn: { id: priorTurn, status: "interrupted", error: null } };
    const readiness = { version: 1, source: "original_native_stopped_launcher_receipt", threadId: f.owner.ownerThreadId,
      observedAt, launcherReceiptDigest: "a".repeat(64), checkoutIdentityDigest: "b".repeat(64),
      privateOriginalChild: true, approvalPolicy: "never", sandboxMode: "danger-full-access",
      nativeIdentityVerified: true, noApprovalRequired: true, sameProfile: true, runtimeReady: true,
      toolingReleaseSha: mainSha, originalTurnId: originalTurn, ownedStageDigest: assessed.checkpointDigest };
    const input = { ownerThreadId: "parent", assignmentRef: f.owner.assignmentRef,
      policyVersion: "same-native-worker-recovery-v1" as const, currentMainSha: mainSha,
      expectedClaim: { token: f.owner.token, revision: planned.value.revision }, nativeCompletion: terminal, readiness };
    const stale = await dispatcher.reserveCourseSupportContinuation({ ...input,
      nativeCompletion: { ...terminal, latestTurn: { id: originalTurn, status: "failed", error: null } } });
    expect(stale).toMatchObject({ acquired: true, value: { reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" } });
    const reserved = await dispatcher.reserveCourseSupportContinuation(input);
    expect(reserved).toMatchObject({ acquired: true, value: { reserved: true, scope: "RESUME_ORIGINAL_OWNED_STAGE" } });
  });

  it("does not offer owned-stage continuation after the durable assignment run has completed", async () => {
    const f = await fixture();
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/new-reader.ts" });
    if (!planned.acquired) throw new Error("Owned path fixture was busy.");
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as
      import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1_000).toISOString();
    audit.launcherReceiptPath = "C:\\private\\launcher.receipt.private.json";
    await client.automationRun.update({ where: { id: f.run.id }, data: { status: "COMPLETED",
      completedAt: new Date(), outcome: "finished_fixture", audit: audit as unknown as Prisma.InputJsonValue } });
    const plan = await dispatcher.planCourseSupportCourseDispatch({ ownerThreadId: "parent", baseSha: "c".repeat(40), maxStarts: 1 });
    expect(plan).toMatchObject({ acquired: true, value: { continuationItems: [] } });
  });

  it("uses the newest expired reservation instead of an older settled network failure", async () => {
    const f = await fixture();
    const pendingRequestId = await seedExpiredUnfinishedRead(f);
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = stored.audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    audit.simulatorResearch = { ...audit.simulatorResearch!, readCount: 2, history: [{
      source: "booking", requestedUrl: "https://official.example.test/old-booking", sourceUrl: "https://official.example.test/old-booking",
      observedAt: new Date(Date.now() - 120_000).toISOString(), httpStatus: 0, rendered: false,
      outcome: "HARD_FAILED", requestId: randomUUID(),
      failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_NETWORK_FAILED" },
    }] };
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context.checkpoint).toMatchObject({ kind: "EXPIRED_UNFINISHED_READ", requestId: pendingRequestId,
      readCount: 2, failure: null });
  });

  it("reserves one same-worker continuation in Postgres without touching the claim and fences competing or stale proof", async () => {
    const first = await fixture();
    await seedExpiredUnfinishedRead(first);
    const before = (await client.automationRun.findUniqueOrThrow({ where: { id: first.run.id } })).audit as Prisma.JsonObject;
    const reserved = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(first));
    if (!reserved.acquired) throw new Error("Continuation writer lease was busy.");
    expect(reserved.value).toMatchObject({ reserved: true, assignmentRef: first.owner.assignmentRef,
      threadId: first.owner.ownerThreadId, scope: "DIAGNOSE_REVIEWED_TOOLING_UPDATE" });
    const after = (await client.automationRun.findUniqueOrThrow({ where: { id: first.run.id } })).audit as Prisma.JsonObject;
    expect(after.simulatorClaim).toEqual(before.simulatorClaim);
    expect(after.simulatorResearch).toEqual(before.simulatorResearch);
    expect(after.simulatorContinuation).toMatchObject({ receipts: [{ status: "PENDING", attempt: 1 }] });
    const competed = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(first, "competing-parent"));
    if (!competed.acquired) throw new Error("Competing writer lease was busy.");
    expect(competed.value).toMatchObject({ reserved: false, reason: "PRIOR_SEND_UNCONFIRMED" });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: first.run.id } })).audit).toEqual(after);

    await client.automationRun.update({ where: { id: first.run.id }, data: { status: "COMPLETED", completedAt: new Date(), outcome: "test_original_finished" } });
    const second = await fixture();
    await seedExpiredUnfinishedRead(second);
    const secondBefore = (await client.automationRun.findUniqueOrThrow({ where: { id: second.run.id } })).audit;
    const invalidProof = continuationEvidence(second);
    invalidProof.nativeCompletion.latestTurn.status = "inProgress";
    const rejectedProof = await dispatcher.reserveCourseSupportContinuation(invalidProof);
    if (!rejectedProof.acquired) throw new Error("Invalid-proof writer lease was busy.");
    expect(rejectedProof.value).toMatchObject({ reserved: false, reason: "NATIVE_COMPLETION_OR_READINESS_UNPROVED" });
    const sameTick = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(second));
    if (!sameTick.acquired) throw new Error("Same-tick writer lease was busy.");
    expect(sameTick.value).toMatchObject({ reserved: false, reason: "TICK_CONTINUATION_BUDGET_EXHAUSTED" });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: second.run.id } })).audit).toEqual(secondBefore);
    await client.courseOffering.update({ where: { id: second.offering.id }, data: { bookingUrl: "https://changed.example.test/book" } });
    await expect(dispatcher.reserveCourseSupportContinuation(continuationEvidence(second))).rejects.toThrow("source changed");
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: second.run.id } })).audit).toEqual(secondBefore);
    await client.automationRun.delete({ where: { id: first.run.id } });
  });

  it("persists a known acquired network diagnostic for eligible same-worker continuation while capacity stays attention", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
    const network = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" },
      vi.fn(async () => { throw new TypeError("fetch failed"); }));
    if (!network.acquired) throw new Error("Known network observation was busy.");
    expect(network.value).toMatchObject({ researchOutcome: "NETWORK_FAILED", readsRemaining: 5 });
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(audit.simulatorResearch?.history[0]).toMatchObject({ outcome: "NETWORK_FAILED", httpStatus: 0,
      failure: { stage: "PUBLIC_READ", category: "NETWORK", code: "PUBLIC_FETCH_FAILED" }, requestId: expect.any(String) });
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context.checkpoint).toMatchObject({ kind: "SETTLED_FAILURE", readCount: 1,
      failure: { category: "NETWORK", code: "PUBLIC_FETCH_FAILED" }, allowedResearchRouteCount: expect.any(Number) });
    expect(context.checkpoint!.allowedResearchRouteCount).toBeGreaterThan(0);
    const reserved = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(f));
    if (!reserved.acquired) throw new Error("Known-network continuation writer lease was busy.");
    expect(reserved.value).toMatchObject({ reserved: true, scope: "RESUME_ALLOWED_RESEARCH" });

    const capacity = await fixture();
    const busy = await lane.readSimulatorSupportSource({ ...capacity.owner, source: "official", rendered: true }, {
      browser: async () => { throw new Error("SIMULATOR_RESEARCH_PROVIDER_BUSY"); },
    });
    if (!busy.acquired) throw new Error("Known capacity observation was busy.");
    expect(busy.value.researchOutcome).toBe("CAPACITY_BUSY");
    const capacityAudit = (await client.automationRun.findUniqueOrThrow({ where: { id: capacity.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(capacityAudit.simulatorResearch?.history[0]).toMatchObject({ outcome: "CAPACITY_BUSY",
      failure: { category: "CAPACITY", code: "PROVIDER_CAPACITY_BUSY" } });
    const capacityReserve = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(capacity));
    if (!capacityReserve.acquired) throw new Error("Capacity continuation writer lease was busy.");
    expect(capacityReserve.value).toMatchObject({ reserved: false, reason: "FAILURE_REQUIRES_ATTENTION" });
    await client.automationRun.deleteMany({ where: { id: { in: [f.run.id, capacity.run.id] } } });
  });

  it("persists new public-read evidence and reserves an expired original worker without rewriting the read", async () => {
    const f = await fixture();
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response("<h1>Public rentals</h1><a href='/booking'>Book a bay</a>", { headers: { "content-type": "text/html" } })));
    if (!read.acquired) throw new Error("Public read was busy.");
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(audit.simulatorResearch?.history[0]).toMatchObject({ outcome: "READ", requestId: expect.any(String),
      publicReadEvidence: { accessControlsObserved: true, accessControls: [], method: "HTTP" } });
    expect((await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()))).checkpoint).toBeNull();
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as unknown as Prisma.InputJsonValue } });
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context.checkpoint).toMatchObject({ kind: "EXPIRED_SETTLED_PUBLIC_READ", failure: null, readCount: 1,
      publicReadEvidence: { accessControlsObserved: true, accessControls: [], httpStatus: 200 } });
    const reserved = await dispatcher.reserveCourseSupportContinuation(continuationEvidence(f));
    if (!reserved.acquired) throw new Error("Settled-public continuation was busy.");
    expect(reserved.value).toMatchObject({ reserved: true, scope: "RESUME_ALLOWED_RESEARCH" });
    const after = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(after.simulatorResearch).toEqual(audit.simulatorResearch);
    expect(after.simulatorClaim).toEqual(audit.simulatorClaim);
    expect(after.childThreadId).toBe(audit.childThreadId);
  });

  it("does not turn a new HTTP200 challenge or legacy read into an expired public checkpoint", async () => {
    const f = await fixture();
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => new Response("<h1>Verify you are human</h1>", { headers: { "content-type": "text/html" } })));
    if (!read.acquired) throw new Error("Challenge observation was busy.");
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as unknown as import("./course-support-course-dispatch").CourseDispatchAudit;
    expect(audit.simulatorResearch?.history[0]).toMatchObject({ httpStatus: 200, publicReadEvidence: { accessControlsObserved: true, accessControls: ["CAPTCHA_OR_CHALLENGE"] } });
    audit.simulatorClaim!.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
    expect((await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()))).checkpoint).toBeNull();
    delete audit.simulatorResearch!.history[0].publicReadEvidence;
    expect((await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()))).checkpoint).toBeNull();
  });

  it.each([new TypeError("fetch failed"), Object.assign(new Error("socket reset"), { code: "ECONNRESET" })])("records bounded network failure with an advanced revision and rejects malformed research: %s", async error => {
    const f = await fixture();
    const read = await lane.readSimulatorSupportSource({ ...f.owner, source: "official" }, vi.fn(async () => { throw error; }));
    if (!read.acquired) throw new Error("Source reservation failed.");
    expect(read.value).toMatchObject({ researchOutcome: "NETWORK_FAILED", readsRemaining: 5, publicSource: { httpStatus: 0 } });
    const stored = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    await client.automationRun.update({ where: { id: stored.id }, data: { audit: { ...(stored.audit as Prisma.JsonObject), simulatorResearch: { version: 1, readCount: 0 } } } });
    await expect(lane.readSimulatorSupportSource({ ...f.owner, revision: read.value.revision, source: "booking" }, vi.fn())).rejects.toThrow();
  });
});
