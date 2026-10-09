// @vitest-environment node
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSimulatorOfferingSourceFingerprint } from "@/lib/simulators/source-fingerprint";
import { createSimulatorSupportIntentDigest, SIMULATOR_SUPPORT_SOURCE_SELECT } from "./simulator-support-policy";
import { listSimulatorSupportDispatchCandidates, reconcileSimulatorCapabilityWakeups } from "./simulator-support-incidents";

const url = process.env.SIMULATOR_TEST_DATABASE_URL;
const ids = { users: [] as string[], courses: [] as string[], runs: [] as string[] };
let client: PrismaClient;

describe.skipIf(!url)("simulator capability wakeup in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/simulator_preview")
      throw new Error("Only the isolated local simulator_preview database is permitted.");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    await client.$connect();
  });
  afterEach(async () => {
    await client.automationRun.deleteMany({ where: { id: { in: ids.runs } } });
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    ids.users.length = 0; ids.courses.length = 0; ids.runs.length = 0;
  });
  afterAll(async () => { if (client) await client.$disconnect(); });

  async function fixture(future: boolean) {
    const suffix = randomUUID();
    const now = new Date();
    const completedAt = new Date(now.getTime() - 60_000);
    const claimedAt = new Date(now.getTime() - 3 * 60_000);
    const bookingUrl = "https://clients.uschedule.com/stingers-golf/booking";
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const course = await client.course.create({ data: { googlePlaceId: suffix, name: "Wakeup fixture", address: "1 Test Street",
      website: bookingUrl, latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true } }); ids.courses.push(course.id);
    const offering = await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR",
      publicAccessStatus: "UNVERIFIED", bookingUrl } });
    const search = await client.teeSearch.create({ data: { userId: user.id, mode: "SIMULATOR", durationMinutes: 60,
      date: new Date(now.getTime() + 2 * 86_400_000), startTime: "09:00", endTime: "18:00", userTimeZone: "UTC",
      players: 4, trafficClass: "PUBLIC", cadenceMinutes: 15,
      preferences: { create: [{ offeringId: offering.id, courseId: course.id, rank: 1 }] } },
      select: SIMULATOR_SUPPORT_SOURCE_SELECT });
    const incident = await client.simulatorSupportIncident.create({ data: { offeringId: offering.id,
      reason: "NEEDS_ADAPTER", retryAt: new Date(now.getTime() + (future ? 60 * 60_000 : -60_000)) } });
    const fingerprint = getSimulatorOfferingSourceFingerprint(offering);
    const audit = { schemaVersion: 1, tickRef: "fixture", assignmentRef: `assignment-${suffix}`,
      state: "CONSUMED", ownerThreadId: "parent", childThreadId: "worker", baseSha: "a".repeat(40),
      reservedAt: claimedAt.toISOString(), launchStartedAt: claimedAt.toISOString(),
      boundAt: claimedAt.toISOString(), consumedAt: claimedAt.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      target: { mode: "SIMULATOR", offeringId: offering.id, offeringSourceFingerprint: fingerprint,
        incidentId: incident.id, courseId: course.id, cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING",
        failureFingerprint: fingerprint, updatedAt: incident.updatedAt.toISOString(), trafficClass: "REAL",
        searchRefs: [{ id: search.id, scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration,
          intentDigest: createSimulatorSupportIntentDigest(search) }] },
      simulatorClaim: { token: suffix, revision: 1, phase: "CLAIMED", claimedAt: claimedAt.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + 12 * 60_000).toISOString(), sourceFingerprint: fingerprint,
        originalSourceFingerprint: fingerprint, offeringRevision: offering.monitoringRevision, plannedPaths: [],
        releaseSha: null, branch: "feature/simulator-alerts", deployment: null, recheckQueuedAt: null, verificationCycle: 0 },
      simulatorResearch: { version: 1, sourceFingerprint: fingerprint, readCount: 1, history: [{
        source: "booking", requestedUrl: bookingUrl, sourceUrl: bookingUrl, sourceFingerprint: fingerprint,
        observedAt: completedAt.toISOString(), httpStatus: 200, rendered: false, outcome: "READ",
        requestId: randomUUID(), researchImplementationVersion: "public-calendar-passive-method-shapes-v4",
        publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true, accessControls: [], method: "HTTP" },
      }], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null } };
    const run = await client.automationRun.create({ data: { kind: "OTHER", status: "COMPLETED",
      promptVersion: "course-support-course-dispatch-v1", outcome: "simulator_retryable_failed", startedAt: claimedAt, completedAt,
      audit: audit as Prisma.InputJsonValue } }); ids.runs.push(run.id);
    return { incident, run };
  }

  it("advances the future retry once while keeping an ordinary due incident visible", async () => {
    const future = await fixture(true);
    const due = await fixture(false);
    const before = await client.$transaction(tx => listSimulatorSupportDispatchCandidates(new Date(), tx));
    expect(before.map(row => row.incidentId)).toContain(due.incident.id);
    expect(before.map(row => row.incidentId)).not.toContain(future.incident.id);
    const original = await client.automationRun.findUniqueOrThrow({ where: { id: future.run.id } });
    const advanced = await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    expect(advanced).toBe(1);
    const after = await client.$transaction(tx => listSimulatorSupportDispatchCandidates(new Date(), tx));
    expect(after.map(row => row.incidentId)).toEqual(expect.arrayContaining([due.incident.id, future.incident.id]));
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx))).toBe(0);
    expect(await client.automationRun.findUniqueOrThrow({ where: { id: future.run.id } })).toEqual(original);
  });

  it("leaves a future retry parked when 127 raw due incidents fill the due-reader window", async () => {
    const future = await fixture(true);
    const rows = Array.from({ length: 127 }, () => ({ courseId: randomUUID(), offeringId: randomUUID(), placeId: randomUUID() }));
    ids.courses.push(...rows.map(row => row.courseId));
    await client.course.createMany({ data: rows.map(row => ({ id: row.courseId, googlePlaceId: row.placeId,
      name: "Due queue fixture", address: "1 Test Street", website: "https://official.example.test",
      latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true })) });
    await client.courseOffering.createMany({ data: rows.map(row => ({ id: row.offeringId,
      courseId: row.courseId, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED" })) });
    await client.simulatorSupportIncident.createMany({ data: rows.map(row => ({ offeringId: row.offeringId,
      reason: "NEEDS_ADAPTER", retryAt: new Date(0) })) });
    const due = await client.$transaction(tx => listSimulatorSupportDispatchCandidates(new Date(), tx),
      { timeout: 30_000 });
    expect(due).toEqual([]); // Raw rows count even when no current search survives filtering.
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })).toBe(0);
    expect((await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: future.incident.id } })).retryAt)
      .toEqual(future.incident.retryAt);
  });

  it("keeps a future retry parked after the source intent ends", async () => {
    const f = await fixture(true);
    const audit = (await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } })).audit as Record<string, unknown>;
    const target = audit.target as { searchRefs: Array<{ id: string }> };
    await client.teeSearch.update({ where: { id: target.searchRefs[0].id }, data: { status: "COMPLETED" } });
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx))).toBe(0);
    expect((await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).retryAt)
      .toEqual(f.incident.retryAt);
  });

  it("keeps a future retry parked when the latest attempt already used the known reader", async () => {
    const f = await fixture(true);
    const prior = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = prior.audit as Record<string, unknown>;
    const research = audit.simulatorResearch as { history: Array<Record<string, unknown>> };
    research.history[0].researchImplementationVersion = "public-calendar-known-readers-passive-method-shapes-v3";
    await client.automationRun.update({ where: { id: f.run.id }, data: { audit: audit as Prisma.InputJsonValue } });
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx))).toBe(0);
    expect((await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).retryAt)
      .toEqual(f.incident.retryAt);
  });

  it("keeps a future retry parked while a live owner remains", async () => {
    const f = await fixture(true);
    const prior = await client.automationRun.findUniqueOrThrow({ where: { id: f.run.id } });
    const audit = prior.audit as Record<string, unknown>;
    const live = await client.automationRun.create({ data: { kind: "OTHER", status: "RUNNING",
      promptVersion: "course-support-course-dispatch-v1", audit: { ...audit, state: "RESERVED" } as Prisma.InputJsonValue } });
    ids.runs.push(live.id);
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx))).toBe(0);
    expect((await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).retryAt)
      .toEqual(f.incident.retryAt);
  });

  it("does not search behind a newer failed dispatch for an old positive receipt", async () => {
    const f = await fixture(true);
    const prior = await client.automationRun.update({ where: { id: f.run.id },
      data: { startedAt: new Date(Date.now() - 5 * 60_000) } });
    const newer = await client.automationRun.create({ data: { kind: "OTHER", status: "FAILED",
      promptVersion: "course-support-course-dispatch-v1", outcome: "worker_failed",
      audit: prior.audit as Prisma.InputJsonValue } });
    ids.runs.push(newer.id);
    expect(await client.$transaction(tx => reconcileSimulatorCapabilityWakeups(new Date(), tx))).toBe(0);
    expect((await client.simulatorSupportIncident.findUniqueOrThrow({ where: { id: f.incident.id } })).retryAt)
      .toEqual(f.incident.retryAt);
  });
});
