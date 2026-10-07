// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  async function cleanupFixtureRows() {
    if (!client) return;
    const probes = await client.courseProbe.findMany({ where: { courseId: { in: ids.courses }, automationRunId: { not: null } }, select: { automationRunId: true } });
    ids.runs.push(...probes.flatMap(probe => probe.automationRunId ? [probe.automationRunId] : []));
    await client.automationRun.deleteMany({ where: { id: { in: ids.runs } } });
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    ids.runs.length = 0; ids.courses.length = 0; ids.users.length = 0;
  }
  afterEach(cleanupFixtureRows);
  afterAll(async () => { await cleanupFixtureRows(); if (client) await client.$disconnect(); vi.unstubAllEnvs(); });

  async function fixture(cadenceMinutes = 15, mixed = false, bookingUrl?: string) {
    const suffix = randomUUID(), now = new Date();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: suffix, name: "Support fixture", address: "1 Test Street", website: "https://official.example.test", latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }); ids.courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED", bookingUrl } });
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
    await lane.retrySimulatorSupport({ ...f.owner, revision: release.value.revision, retryMinutes: 15 });
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
    expect(claimed.value.researchGuide.priorBlockedRoutes).toContainEqual({ url: f.course.website, rendered: false, httpStatus: 403 });
    expect(claimed.value.researchGuide.suggestedReads).not.toContainEqual({ source: "official", rendered: false });
  });

  it("rejects a tests-only release instead of calling it reusable calendar implementation", async () => {
    const f = await fixture();
    const planned = await lane.claimSimulatorSupportPath({ ...f.owner, path: "src/lib/simulators/providers/new-reader.test.ts" });
    if (!planned.acquired) throw new Error("Test-only path fixture was busy.");
    await expect(lane.registerSimulatorSupportRelease({ ...f.owner, revision: planned.value.revision, releaseSha: "b".repeat(40),
      branch: `automation/course-support-${f.owner.ownerThreadId.replace("child-", "")}`, trustedUpstreamSha: baseSha,
      upstreamDescendantVerified: true, committedPaths: ["src/lib/simulators/providers/new-reader.test.ts"], descendantVerified: true })).rejects.toThrow("provenance");
    await lane.retrySimulatorSupport({ ...f.owner, revision: planned.value.revision, retryMinutes: 15 });
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
    await lane.retrySimulatorSupport({ ...owner, revision: registered.value.revision, retryMinutes: 15 });
  });

  it("checkpoints an unknown rendered-read failure for the same owner without resetting navigation or budget", async () => {
    const f = await fixture(15, false, "https://official.example.test/booking");
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
    const context = await client.$transaction(tx => lane.readSimulatorSupportContinuationContext(tx, audit, new Date()));
    expect(context).toMatchObject({ currentSource: true, currentClaimRevision: inspected.revision, providerReadInFlight: false,
      checkpoint: { kind: "SETTLED_FAILURE", readCount: 1, allowedResearchRouteCount: expect.any(Number),
        failure: { stage: "PUBLIC_READ", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_LAUNCH" } } });
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
    expect((await lane.retrySimulatorSupport({ ...f.owner, revision: booking.value.revision, retryMinutes: 15 })).acquired).toBe(true);
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
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.research.history).toHaveLength(1);
    expect(inspected.research.history[0]).toMatchObject({ outcome: "HARD_FAILED", httpStatus: 0,
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
    const inspected = await lane.readSimulatorSupportClaim({ assignmentRef: f.owner.assignmentRef, ownerThreadId: f.owner.ownerThreadId });
    expect(inspected.research.history).toHaveLength(1);
    expect(inspected.research.history[0]).toMatchObject({ outcome: "HARD_FAILED", httpStatus: 0,
      failure: { stage: "PUBLIC_READ", category, code: safeCode } });
    expect(inspected.researchGuide.suggestedReads).not.toContainEqual({ source: "official", rendered: true });
    const browser = vi.fn();
    await expect(lane.readSimulatorSupportSource({ ...f.owner, revision: inspected.revision, source: "official", rendered: true },
      { browser })).rejects.toThrow("identical route");
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
