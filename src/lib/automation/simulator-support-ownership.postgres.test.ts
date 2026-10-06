// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT } from "./simulator-support-policy";

const coreMocks = vi.hoisted(() => ({ fetch: vi.fn(), sendMatch: vi.fn(), sendStatus: vi.fn() }));
vi.mock("@/lib/simulators/providers", () => ({ fetchSimulatorAvailability: coreMocks.fetch }));
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
  afterAll(async () => {
    if (client) {
      const probes = await client.courseProbe.findMany({ where: { courseId: { in: ids.courses }, automationRunId: { not: null } }, select: { automationRunId: true } });
      ids.runs.push(...probes.flatMap(probe => probe.automationRunId ? [probe.automationRunId] : []));
      await client.automationRun.deleteMany({ where: { id: { in: ids.runs } } });
      await client.course.deleteMany({ where: { id: { in: ids.courses } } });
      await client.user.deleteMany({ where: { id: { in: ids.users } } });
      await client.$disconnect();
    }
    vi.unstubAllEnvs();
  });

  async function fixture(cadenceMinutes = 15, mixed = false) {
    const suffix = randomUUID(), now = new Date();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: suffix, name: "Support fixture", address: "1 Test Street", website: "https://official.example.test", latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }); ids.courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED" } });
    const peerCourse = mixed ? await client.course.create({ data: { googlePlaceId: `${suffix}-peer`, name: "Peer simulator fixture", address: "2 Test Street", website: "https://peer.example.test", latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }) : null;
    if (peerCourse) ids.courses.push(peerCourse.id);
    const peer = peerCourse ? await client.courseOffering.create({ data: { courseId: peerCourse.id, kind: "SIMULATOR", publicAccessStatus: "PUBLIC", supportedDurationsMinutes: [60], verifiedAt: now,
      evidenceUrl: "https://peer.example.test", bookingUrl: "https://peer.example.test/book", providerFamilyKey: "GOLFBOOK" } }) : null;
    const search = await client.teeSearch.create({ data: { userId: user.id, mode: "SIMULATOR", durationMinutes: 60, date: new Date(Date.now() + 2 * 86_400_000), startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, trafficClass: "PUBLIC", cadenceMinutes,
      preferences: { create: [{ offeringId: offering.id, courseId: course.id, rank: 1 }, ...(peer ? [{ offeringId: peer.id, courseId: peer.courseId, rank: 2 }] : [])] } }, select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const incident = await client.simulatorSupportIncident.create({ data: { offeringId: offering.id, reason: "NEEDS_ADAPTER", retryAt: now } });
    const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
    await client.courseProbe.create({ data: { courseId: course.id, offeringId: offering.id, teeSearchId: search.id, outcome: "NEEDS_ADAPTER", rawSummary: { mode: "SIMULATOR", sourceFingerprint: fingerprint } } });
    const assignmentRef = `course-assignment-${suffix}`, child = `child-${suffix}`;
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING", promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION, ownerThreadId: "parent", audit: {
      schemaVersion: 1, tickRef: "fixture", assignmentRef, state: "BOUND", ownerThreadId: "parent", childThreadId: child, baseSha,
      reservedAt: now.toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(), target: { mode: "SIMULATOR", offeringId: offering.id, offeringSourceFingerprint: fingerprint,
        incidentId: incident.id, courseId: course.id, cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING", failureFingerprint: fingerprint, updatedAt: incident.updatedAt.toISOString(), trafficClass: "REAL",
        searchRefs: [{ id: search.id, scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(search) }] },
    } } }); ids.runs.push(run.id);
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: child, baseSha, branch: `automation/course-support-${suffix}` });
    if (!claimed.acquired) throw new Error("Fixture writer transition was busy.");
    return { course, offering, peer, search, incident, run, owner: { assignmentRef, ownerThreadId: child, token: claimed.value.token, revision: claimed.value.revision }, fingerprint };
  }

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
    const registered = await lane.registerSimulatorSupportRelease({ ...owner, releaseSha, branch, committedPaths: ["src/lib/simulators/providers/new-reader.ts"], descendantVerified: true });
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
    expect(plan.value.launchItems).toHaveLength(2);
    expect(plan.value.launchItems.every(item => item.mode === "SIMULATOR")).toBe(true);
    expect(plan.value.reservedCount).toBe(2);
    const created = await client.automationRun.findMany({ where: { promptVersion: dispatcher.COURSE_DISPATCH_PROMPT_VERSION }, select: { id: true } });
    ids.runs.push(...created.filter(row => !before.has(row.id)).map(row => row.id));
    const assignmentRef = plan.value.launchItems[0].assignmentRef;
    await dispatcher.beginCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", assignmentRef });
    await dispatcher.bindCourseSupportCourseDispatch({ ownerThreadId: "mixed-parent", assignmentRef, childThreadId: "mixed-child" });
    expect(await dispatcher.getCourseSupportCourseDispatchAssignment({ assignmentRef, childThreadId: "mixed-child" })).toMatchObject({ outcome: "bound", mode: "SIMULATOR" });
    await expect(dispatcher.loadBoundCourseSupportDispatchAssignment({ assignmentRef, childThreadId: "mixed-child" })).rejects.toThrow();
    const claimed = await lane.claimSimulatorSupportAssignment({ assignmentRef, ownerThreadId: "mixed-child", baseSha, branch: "automation/course-support-mixed" });
    expect(claimed.acquired).toBe(true);
    expect((await dispatcher.listLiveCourseSupportDispatchReservations(client)).filter(entry => entry.audit.target.mode === "SIMULATOR")).toHaveLength(2);
    if (claimed.acquired) await lane.retrySimulatorSupport({ assignmentRef, ownerThreadId: "mixed-child", token: claimed.value.token, revision: claimed.value.revision, retryMinutes: 15 });
    const remaining = plan.value.launchItems[1].assignmentRef;
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
    const release = await lane.registerSimulatorSupportRelease({ ...owner, revision: adopted.value.revision, releaseSha: baseSha, branch: `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`, descendantVerified: true, committedPaths: [] });
    expect(release.acquired).toBe(true);
    expect(await client.course.findUniqueOrThrow({ where: { id: f.course.id } })).toEqual(outdoorBefore);
    if (release.acquired) await lane.retrySimulatorSupport({ ...owner, revision: release.value.revision, retryMinutes: 15 });
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
      branch: `automation/course-support-${owner.ownerThreadId.replace("child-", "")}`, descendantVerified: true, committedPaths: [] });
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
    expect(read.acquired).toBe(true); expect(fetchImpl).toHaveBeenCalledWith(f.course.website, expect.objectContaining({ method: "GET", credentials: "omit" }));
    if (!read.acquired) throw new Error("Source read failed.");
    expect(read.value.publicSource.text).toBe("Public hourly bays Rates");
    let owner = { ...f.owner, revision: read.value.revision };
    const redirected = vi.fn(async () => {
      const response = new Response("<a href='book'>Book hourly rentals</a>");
      Object.defineProperty(response, "url", { value: "https://official.example.test/simulators/" });
      return response;
    });
    const landing = await lane.readSimulatorSupportSource({ ...owner, source: "official" }, redirected);
    if (!landing.acquired) throw new Error("Redirected source read failed."); owner = { ...owner, revision: landing.value.revision };
    expect(landing.value.publicSource).toMatchObject({ requestedUrl: f.course.website, url: "https://official.example.test/simulators/", links: ["https://official.example.test/simulators/book"] });
    expect((await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit).toMatchObject({ simulatorResearch: { requestedUrl: f.course.website, sourceUrl: "https://official.example.test/simulators/" } });
    const pausedDuringRead = vi.fn(async () => { await client.teeSearch.update({ where: { id: f.search.id }, data: { status: "PAUSED" } }); return new Response("public"); });
    await expect(lane.readSimulatorSupportSource({ ...owner, source: "official" }, pausedDuringRead)).rejects.toThrow("source demand changed");
    await lane.retireSimulatorSupport(owner);
  });
});
