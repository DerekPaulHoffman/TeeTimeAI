// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ prisma: client }));

const databaseUrl = process.env.SIMULATOR_TEST_DATABASE_URL;
const releaseSha = "a".repeat(40);
const ownerThreadId = `verification-deadline-${randomUUID()}`;
const ids = {
  courses: [] as string[],
  batches: [] as string[],
  incidents: [] as string[],
  users: [] as string[],
  searches: [] as string[],
};
let schedule: typeof import("./course-support-verification").scheduleCourseSupportVerificationRequests;
let getPacket: typeof import("./course-support-batches").getCourseSupportBatchPacket;

describe.skipIf(!databaseUrl)("owned engineering verification deadline in isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      parsed.pathname !== "/simulator_preview" ||
      !["postgres:", "postgresql:"].includes(parsed.protocol)
    ) {
      throw new Error("Only isolated localhost simulator_preview is permitted.");
    }
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl!, connectionTimeoutMillis: 5_000 }),
    });
    await client.$connect();
    ({ scheduleCourseSupportVerificationRequests: schedule } = await import("./course-support-verification"));
    ({ getCourseSupportBatchPacket: getPacket } = await import("./course-support-batches"));
  });

  async function cleanup() {
    if (!client) return;
    await client.teeSearch.deleteMany({ where: { id: { in: ids.searches } } });
    await client.courseSupportBatch.deleteMany({ where: { id: { in: ids.batches } } });
    await client.courseSupportIncident.deleteMany({ where: { id: { in: ids.incidents } } });
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    Object.values(ids).forEach((list) => { list.length = 0; });
  }
  afterEach(cleanup);
  afterAll(async () => { await cleanup(); if (client) await client.$disconnect(); });

  async function fixture(now: Date) {
    const suffix = randomUUID();
    const historical = new Date(now.getTime() - 3 * 86_400_000);
    const lease = new Date(now.getTime() + 15 * 60_000);
    const course = await client.course.create({ data: {
      googlePlaceId: suffix,
      name: `Isolated verification ${suffix}`,
      latitude: 41,
      longitude: -73,
      timeZone: "America/New_York",
      isPublic: true,
      website: "https://official.example.test",
      detectedBookingUrl: "https://book.example.test/tee-times",
      detectedPlatform: "CUSTOM",
      providerFamilyKey: "CPS",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      bookingMetadata: { provider: "CPS", facilityId: `isolated-${suffix}` },
    } });
    ids.courses.push(course.id);
    const batch = await client.courseSupportBatch.create({ data: {
      reference: suffix,
      providerFamilyKey: "CPS",
      failureFingerprint: `isolated-${suffix}`,
      status: "VERIFYING",
      ownerThreadId,
      leaseToken: suffix,
      leaseExpiresAt: lease,
      heartbeatAt: now,
      baseSha: releaseSha,
      releaseSha,
      deployedAt: now,
    } });
    ids.batches.push(batch.id);
    const incident = await client.courseSupportIncident.create({ data: {
      reference: randomUUID(),
      courseId: course.id,
      kind: "NEEDS_ADAPTER",
      status: "AUTO_INVESTIGATING",
      providerFamilyKey: "CPS",
      failureFingerprint: batch.failureFingerprint,
      courseNameSnapshot: course.name,
      platformSnapshot: "CUSTOM",
      engineeringOnly: true,
      activeRealSearchCount: 0,
      earliestTargetDate: null,
      escalationDeadlineAt: historical,
      activeBatchId: batch.id,
      firstSeenAt: historical,
    } });
    ids.incidents.push(incident.id);
    await client.courseMonitoringStatus.create({ data: {
      courseId: course.id,
      reference: randomUUID(),
      state: "AUTO_INVESTIGATING",
      failureFingerprint: batch.failureFingerprint,
    } });
    const member = await client.courseSupportBatchIncident.create({ data: {
      batchId: batch.id,
      incidentId: incident.id,
      courseId: course.id,
      cycle: incident.cycle,
      result: "PENDING",
      verifiedIncidentUpdatedAt: incident.updatedAt,
    } });
    const packet = await getPacket({
      batchId: batch.id,
      leaseToken: batch.leaseToken,
      ownerThreadId,
      now,
    });
    expect(packet.outcome).toBe("ready");
    if (packet.outcome !== "ready") throw new Error("The isolated batch lost ownership.");
    const snapshot = {
      leaseToken: batch.leaseToken,
      ownerThreadId,
      capturedAt: new Date(packet.verificationLeaseCapturedAt),
      deadlineAt: new Date(packet.ownedLeaseSnapshotAt),
      eligibleBatchIncidentIds: packet.verificationLeaseEligibleBatchIncidentIds,
    };
    return { course, batch, member, incident, historical, lease, snapshot, packet };
  }

  it("persists one fixed request, then preserves its spent identity after a heartbeat", async () => {
    const now = new Date();
    const { batch, member, incident, historical, lease, snapshot, packet } = await fixture(now);
    expect(packet.verificationLeaseEligibleBatchIncidentIds).toEqual([member.id]);
    expect(packet.courses[0].escalationDeadlineAt).toBe(historical.toISOString());
    const first = await schedule({ batchId: batch.id, releaseSha, now, ownedLeaseSnapshot: snapshot });
    expect(first.createdCount).toBe(1);
    const request = await client.courseSupportVerificationRequest.findUniqueOrThrow({
      where: { batchIncidentId_releaseSha: { batchIncidentId: member.id, releaseSha } },
    });
    expect(request.deadlineAt).toEqual(new Date(lease.getTime() - 60_000));
    await client.courseSupportVerificationRequest.update({ where: { id: request.id }, data: {
      status: "STALE", attemptCount: 1,
    } });
    await client.courseSupportBatch.update({ where: { id: batch.id }, data: {
      leaseExpiresAt: new Date(now.getTime() + 30 * 60_000),
    } });
    const repeated = await schedule({ batchId: batch.id, releaseSha,
      now: new Date(now.getTime() + 30_000), ownedLeaseSnapshot: snapshot });
    expect(repeated.createdCount).toBe(0);
    const persisted = await client.courseSupportVerificationRequest.findUniqueOrThrow({ where: { id: request.id } });
    expect(persisted).toMatchObject({ id: request.id, status: "STALE", attemptCount: 1,
      deadlineAt: request.deadlineAt });
    expect((await client.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } })).escalationDeadlineAt)
      .toEqual(historical);
  });

  it("rejects a captured engineering exception when live demand appears before scheduling", async () => {
    const now = new Date();
    const { course, batch, snapshot } = await fixture(now);
    const suffix = randomUUID();
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    ids.users.push(user.id);
    const search = await client.teeSearch.create({ data: {
      userId: user.id,
      mode: "OUTDOOR",
      date: new Date(now.getTime() + 2 * 86_400_000),
      startTime: "09:00", endTime: "18:00", players: 1,
      status: "ACTIVE",
      preferences: { create: { courseId: course.id, rank: 1 } },
    } });
    ids.searches.push(search.id);
    const result = await schedule({ batchId: batch.id, releaseSha, now,
      ownedLeaseSnapshot: snapshot });
    expect(result.createdCount).toBe(0);
    expect(result.ineligibleReasonCounts).toMatchObject({ request_horizon_exceeded: 1 });
    expect(await client.courseSupportVerificationRequest.count({ where: { batchIncident: { batchId: batch.id } } }))
      .toBe(0);
  });

  it("keeps a future historical endpoint when it expires after packet capture", async () => {
    const now = new Date();
    const { batch, member, incident } = await fixture(now);
    const futureAtCapture = new Date(now.getTime() + 30_000);
    await client.courseSupportIncident.update({ where: { id: incident.id }, data: {
      escalationDeadlineAt: futureAtCapture,
    } });
    const packet = await getPacket({ batchId: batch.id, leaseToken: batch.leaseToken,
      ownerThreadId, now });
    expect(packet.outcome).toBe("ready");
    if (packet.outcome !== "ready") throw new Error("The isolated batch lost ownership.");
    expect(packet.verificationLeaseEligibleBatchIncidentIds).not.toContain(member.id);
    const result = await schedule({ batchId: batch.id, releaseSha,
      now: new Date(now.getTime() + 40_000),
      ownedLeaseSnapshot: {
        leaseToken: batch.leaseToken,
        ownerThreadId,
        capturedAt: new Date(packet.verificationLeaseCapturedAt),
        deadlineAt: new Date(packet.ownedLeaseSnapshotAt),
        eligibleBatchIncidentIds: packet.verificationLeaseEligibleBatchIncidentIds,
      },
    });
    expect(result.createdCount).toBe(0);
    expect(await client.courseSupportVerificationRequest.count({ where: {
      batchIncidentId: member.id,
    } })).toBe(0);
  });
});
