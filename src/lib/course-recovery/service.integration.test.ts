// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { retainRecoveryRequest, claimRecoveryRequest, completeRecoveryAttempt, failRecoveryAttempt, readRecoveryView, RecoveryAdmissionError } from "./service";
import { saveRecoveryDemandForUser, activateVerifiedRecoveryDemands, cancelRecoveryDemandForUser, getRecoveryDemandForUser, listPendingRecoveryDemandsForUser, RecoveryDemandNotFoundError } from "./demand";
import type { RecoveryInvestigation } from "./contracts";
import { reportCourseSupportIssue } from "@/lib/automation/support-incidents";
import { createTeeSearchForUser } from "@/lib/searches/service";

const mocks = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("@/lib/automation/search-scheduler", () => ({ startSearchSchedule: mocks.schedule }));
vi.mock("./investigate", () => ({ investigateCourseRecovery: vi.fn(() => { throw new Error("No live provider reads in integration tests"); }) }));

const enabled = Boolean(process.env.COURSE_RECOVERY_TEST_DATABASE_URL);
const verified: RecoveryInvestigation = { status: "VERIFIED", course: {
  googlePlaceId: "recovery-fixture-harbor", name: "Recovery Fixture Harbor Dunes Golf Course",
  address: "37 Fairway Drive, Harborville, CT", city: "Harborville", stateCode: "CT",
  latitude: 41.3, longitude: -72.9, timeZone: "America/New_York",
  website: "https://harbor.example", publicAccessStatus: "PUBLIC",
}, bookingUrl: "https://harbor.example/tee-times", evidenceUrl: "https://harbor.example",
  evidenceSummary: "Synthetic official identity, street address, public play and booking link corroborated." };

describe.skipIf(!enabled)("missing-course recovery isolated Postgres journey", () => {
  beforeAll(() => {
    const url = new URL(process.env.COURSE_RECOVERY_TEST_DATABASE_URL!);
    if (url.hostname !== "127.0.0.1" || url.port !== "55439" || url.pathname !== "/course_recovery_test" || process.env.DATABASE_URL !== url.toString()) {
      throw new Error("Isolated synthetic database fence failed.");
    }
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.schedule.mockResolvedValue({ runId: "synthetic-workflow" });
    // This is the dedicated task-owned synthetic database, never a hosted URL.
    await prisma.courseRecoveryDemand.deleteMany();
    await prisma.courseRecoveryAttempt.deleteMany();
    await prisma.courseRecoveryRequest.deleteMany();
    await prisma.courseRecoveryAdmission.deleteMany();
    await prisma.googlePlaceReview.deleteMany({ where: { googlePlaceId: { startsWith: "recovery-fixture" } } });
    await prisma.user.deleteMany({ where: { clerkUserId: { startsWith: "recovery-fixture" } } });
    await prisma.course.deleteMany({ where: { googlePlaceId: { startsWith: "recovery-fixture" } } });
  });
  afterAll(async () => { await prisma.$disconnect(); });

  it("deduplicates concurrent repeated requests without charging or restarting them", async () => {
    const results = await Promise.all([
      retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville, CT" }, "source-a"),
      retainRecoveryRequest({ name: " harbor   DUNES ", town: "HARBORVILLE CT" }, "source-b"),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect(results.filter(row => row.created)).toHaveLength(1);
    expect(await prisma.courseRecoveryRequest.count()).toBe(1);
    expect((await prisma.courseRecoveryAdmission.findMany()).filter(row => row.key.startsWith("global:"))[0].count).toBe(1);
    const before = await prisma.courseRecoveryRequest.findUniqueOrThrow({ where: { id: results[0].id } });
    await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville, CT", latitude: 40, longitude: -74 }, "source-a");
    const after = await prisma.courseRecoveryRequest.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.deadlineAt).toEqual(before.deadlineAt);
    expect(after.revision).toBe(before.revision);
    expect(after.attemptCount).toBe(0);
  });

  it("bounds new anonymous work while keeping existing receipts usable", async () => {
    for (let i = 0; i < 10; i++) await retainRecoveryRequest({ name: `Recovery Fixture ${i}`, town: "Harborville CT" }, "source-a");
    await expect(retainRecoveryRequest({ name: "Eleventh Fixture", town: "Harborville CT" }, "source-a")).rejects.toBeInstanceOf(RecoveryAdmissionError);
    await expect(retainRecoveryRequest({ name: "Recovery Fixture 0", town: "Harborville CT" }, "source-a")).resolves.toMatchObject({ created: false });
    expect(await prisma.courseRecoveryRequest.count()).toBe(10);
  });

  it("rejects an expired worker and atomically publishes one verified reusable identity", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const old = (await claimRecoveryRequest(id))!;
    await prisma.courseRecoveryRequest.update({ where: { id }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } });
    const current = (await claimRecoveryRequest(id))!;
    expect(current.revision).toBe(old.revision + 1);
    expect(await completeRecoveryAttempt(old, verified)).toBe(false);
    expect(await prisma.course.count({ where: { googlePlaceId: "recovery-fixture-harbor" } })).toBe(0);
    expect(await completeRecoveryAttempt(current, verified)).toBe(true);
    expect(await completeRecoveryAttempt(current, verified)).toBe(false);
    const view = await readRecoveryView(id);
    expect(view).toMatchObject({ status: "VERIFIED", course: { publicAccessStatus: "PUBLIC", monitoringSupport: "UNCONFIRMED" } });
    expect(await prisma.courseRecoveryAttempt.count({ where: { requestId: id } })).toBe(1);
    expect(await prisma.courseSupportIncident.count()).toBe(0);
  });

  it("keeps fictional empty evidence unresolved and creates no playable course or human endpoint", async () => {
    const { id } = await retainRecoveryRequest({ name: "Fictional Lunar Fairway", town: "Harborville CT" }, "source-a");
    const claim = (await claimRecoveryRequest(id))!;
    expect(await completeRecoveryAttempt(claim, { status: "UNRESOLVED", reason: "No corroborated identity found.", evidenceSummary: "Both bounded source searches were empty." })).toBe(true);
    const row = await prisma.courseRecoveryRequest.findUniqueOrThrow({ where: { id } });
    expect(row.courseId).toBeNull();
    expect(row.humanRequiredAt).toBeNull();
    expect((await readRecoveryView(id))?.message).toContain("does not mean it doesn't exist");
  });

  it("does not override a newly rejected exact review", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const claim = (await claimRecoveryRequest(id))!;
    await prisma.googlePlaceReview.create({ data: { googlePlaceId: "recovery-fixture-harbor", name: "Private control", classification: "PRIVATE", evidenceUrl: "https://private.example", reviewedAt: new Date(), accessOverride: "VERIFIED_PRIVATE" } });
    await expect(completeRecoveryAttempt(claim, verified)).rejects.toThrow("access evidence changed");
    expect(await prisma.courseRecoveryAttempt.count()).toBe(0);
    expect((await readRecoveryView(id))?.course).toBeNull();
  });

  it("retains bounded automatic retries across workers and does not extend the deadline", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const claim = (await claimRecoveryRequest(id))!;
    expect(await failRecoveryAttempt(claim)).toBe(true);
    const row = await prisma.courseRecoveryRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("RETRY_WAIT");
    expect(row.leaseToken).toBeNull();
    expect(await claimRecoveryRequest(id)).toBeNull();
    const retry = (await claimRecoveryRequest(id, row.nextAttemptAt))!;
    expect(retry.revision).toBe(claim.revision + 1);
    expect(await failRecoveryAttempt(claim)).toBe(false);
  });

  it("promotes authorized pending demand once, with the current owner email and existing scheduler", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner-old@example.test" } });
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const pending = await saveRecoveryDemandForUser(id, { id: owner.id, email: "ignored@example.test" }, {
      date, startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2,
      cadenceMinutes: 15, additionalEmails: ["extra@example.test"],
    }, "TEST");
    expect(pending?.status).toBe("WAITING");
    await prisma.user.update({ where: { id: owner.id }, data: { email: "owner-current@example.test", clerkUserUpdatedAt: new Date() } });
    await completeRecoveryAttempt((await claimRecoveryRequest(id))!, verified);
    const runs = await Promise.all([activateVerifiedRecoveryDemands(id), activateVerifiedRecoveryDemands(id)]);
    expect(runs.reduce((sum, run) => sum + run.activated, 0)).toBe(1);
    const active = await getRecoveryDemandForUser(id, owner.id);
    expect(active?.status).toBe("ACTIVATED");
    const search = await prisma.teeSearch.findUniqueOrThrow({ where: { id: active!.teeSearchId! }, include: { preferences: true } });
    expect(search.alertEmail).toBe("owner-current@example.test");
    expect(search.additionalEmails).toEqual(["extra@example.test"]);
    expect(search.preferences).toHaveLength(1);
    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(await getRecoveryDemandForUser(id, "another-owner")).toBeNull();
  });

  it("waits through a primary-email transition and never restarts a removed activated alert", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner-old@example.test" } });
    await saveRecoveryDemandForUser(id, owner, {
      date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2,
      cadenceMinutes: 15, additionalEmails: [],
    }, "TEST");
    await prisma.user.update({ where: { id: owner.id }, data: {
      pendingEmail: "owner-current@example.test", pendingEmailObservedAt: new Date(),
    } });
    await completeRecoveryAttempt((await claimRecoveryRequest(id))!, verified);
    expect((await activateVerifiedRecoveryDemands(id)).activated).toBe(0);
    expect((await getRecoveryDemandForUser(id, owner.id))?.status).toBe("WAITING");
    expect(await prisma.teeSearch.count({ where: { userId: owner.id } })).toBe(0);
    await prisma.user.update({ where: { id: owner.id }, data: {
      email: "owner-current@example.test", clerkUserUpdatedAt: new Date(),
      pendingEmail: null, pendingEmailObservedAt: null,
    } });
    expect((await activateVerifiedRecoveryDemands(id)).activated).toBe(1);
    const demand = await getRecoveryDemandForUser(id, owner.id);
    expect((await prisma.teeSearch.findUniqueOrThrow({ where: { id: demand!.teeSearchId! } })).alertEmail).toBe("owner-current@example.test");
    await prisma.teeSearch.delete({ where: { id: demand!.teeSearchId! } });
    expect(await getRecoveryDemandForUser(id, owner.id)).toMatchObject({ status: "ACTIVATED", teeSearchId: null,
      message: "This alert was removed from your dashboard. It will not start again automatically." });
    expect((await activateVerifiedRecoveryDemands(id)).activated).toBe(0);
    expect(await prisma.teeSearch.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("serializes concurrent regular alert creation and pending demand within the same three slots", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner@example.test" } });
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const details = { date, startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2, cadenceMinutes: 15, additionalEmails: [] };
    await prisma.teeSearch.createMany({ data: ["ACTIVE", "PAUSED"].map(status => ({
      userId: owner.id, date: new Date(`${date}T00:00:00Z`), startTime: "08:00", endTime: "12:00", players: 2,
      status: status as "ACTIVE" | "PAUSED", trafficClass: "TEST" as const,
    })) });
    const outcomes = await Promise.allSettled([
      saveRecoveryDemandForUser(id, owner, details, "TEST"),
      createTeeSearchForUser(owner.id, { ...details, alertEmail: owner.email, courses: [{
        googlePlaceId: "recovery-fixture-new-returned", name: "Recovery Fixture Newly Returned Course", rank: 1,
        latitude: 42.1, longitude: -73.1, publicAccessStatus: "PUBLIC",
      }] }, "TEST"),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    const active = await prisma.teeSearch.count({ where: { userId: owner.id, status: { in: ["ACTIVE", "PAUSED"] } } });
    const pending = await prisma.courseRecoveryDemand.count({ where: { userId: owner.id, status: "WAITING", expiresAt: { gt: new Date() } } });
    expect(active + pending).toBe(3);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("never promotes cancelled demand even after identity becomes selectable", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner@example.test" } });
    await saveRecoveryDemandForUser(id, owner, { date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2, cadenceMinutes: 15, additionalEmails: [] }, "TEST");
    await cancelRecoveryDemandForUser(id, owner.id);
    await completeRecoveryAttempt((await claimRecoveryRequest(id))!, verified);
    expect((await activateVerifiedRecoveryDemands(id)).activated).toBe(0);
    expect(await prisma.teeSearch.count({ where: { userId: owner.id } })).toBe(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("retains every owner pending alert across lookup replacement and frees only the cancelled request's slot", async () => {
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner@example.test" } });
    const other = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-other", email: "other@example.test" } });
    const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const laterDate = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
    const detailsA = { date, startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2, cadenceMinutes: 15, additionalEmails: [] };
    const detailsB = { ...detailsA, date: laterDate, startTime: "13:00", endTime: "15:00", players: 3 };
    const requestA = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const pendingA = (await saveRecoveryDemandForUser(requestA.id, owner, detailsA, "TEST"))!;
    const requestB = await retainRecoveryRequest({ name: "Estuary Links", town: "Riverton CT" }, "source-a");
    const pendingB = (await saveRecoveryDemandForUser(requestB.id, owner, detailsB, "TEST"))!;
    expect(requestB.id).not.toBe(requestA.id);

    const repeatedB = await retainRecoveryRequest({ name: " estuary  LINKS ", town: "RIVERTON, CT" }, "source-a");
    expect(repeatedB).toMatchObject({ id: requestB.id, created: false });
    expect(await saveRecoveryDemandForUser(repeatedB.id, owner, detailsB, "TEST")).toEqual(pendingB);
    const firstList = await listPendingRecoveryDemandsForUser(owner.id);
    expect(firstList).toHaveLength(2);
    expect(firstList).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...pendingA, requestId: requestA.id, courseName: "Harbor Dunes", town: "Harborville CT", date, startTime: "08:00", endTime: "12:00", players: 2 }),
      expect.objectContaining({ ...pendingB, requestId: requestB.id, courseName: "Estuary Links", town: "Riverton CT", date: laterDate, startTime: "13:00", endTime: "15:00", players: 3 }),
    ]));
    expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(firstList);

    const otherPendingB = (await saveRecoveryDemandForUser(requestB.id, other, { ...detailsA, players: 4 }, "TEST"))!;
    const otherList = await listPendingRecoveryDemandsForUser(other.id);
    expect(otherList).toHaveLength(1);
    expect(otherList[0]).toMatchObject({ id: otherPendingB.id, requestId: requestB.id, players: 4 });
    expect(otherList[0].id).not.toBe(pendingB.id);
    expect(await getRecoveryDemandForUser(requestA.id, other.id)).toBeNull();
    await expect(cancelRecoveryDemandForUser(requestA.id, other.id)).rejects.toBeInstanceOf(RecoveryDemandNotFoundError);
    expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(firstList);

    const requestC = await retainRecoveryRequest({ name: "Recovery Fixture Meadow Links", town: "Harborville CT" }, "source-a");
    await saveRecoveryDemandForUser(requestC.id, owner, detailsA, "TEST");
    const fullList = await listPendingRecoveryDemandsForUser(owner.id);
    expect(fullList).toHaveLength(3);
    expect(fullList.every(demand => demand.status === "WAITING")).toBe(true);
    const requestD = await retainRecoveryRequest({ name: "Recovery Fixture Cove Links", town: "Harborville CT" }, "source-a");
    await expect(saveRecoveryDemandForUser(requestD.id, owner, detailsA, "TEST")).rejects.toThrow("including pending course alerts");

    expect(await cancelRecoveryDemandForUser(requestA.id, owner.id)).toMatchObject({ id: pendingA.id, status: "CANCELLED", teeSearchId: null });
    expect(await getRecoveryDemandForUser(requestB.id, owner.id)).toEqual(pendingB);
    expect(await getRecoveryDemandForUser(requestB.id, other.id)).toEqual(otherPendingB);
    const afterCancellation = await listPendingRecoveryDemandsForUser(owner.id);
    expect(afterCancellation.map(demand => demand.requestId).sort()).toEqual([requestB.id, requestC.id].sort());
    expect((await saveRecoveryDemandForUser(requestD.id, owner, detailsA, "TEST"))?.status).toBe("WAITING");
    const refilled = await listPendingRecoveryDemandsForUser(owner.id);
    expect(refilled.map(demand => demand.requestId).sort()).toEqual([requestB.id, requestC.id, requestD.id].sort());

    expect(await completeRecoveryAttempt((await claimRecoveryRequest(requestA.id))!, verified)).toBe(true);
    expect((await activateVerifiedRecoveryDemands(requestA.id)).activated).toBe(0);
    expect(await getRecoveryDemandForUser(requestA.id, owner.id)).toMatchObject({ status: "CANCELLED", teeSearchId: null });
    expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(refilled);
    expect(await prisma.teeSearch.count({ where: { userId: owner.id } })).toBe(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("reconciles expired and terminal pending alerts without dropping a healthy request or revising it on reload", async () => {
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "owner@example.test" } });
    const other = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-other", email: "other@example.test" } });
    const details = { date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2, cadenceMinutes: 15, additionalEmails: [] };
    const expiring = await retainRecoveryRequest({ name: "Recovery Fixture Expiring Links", town: "Harborville CT" }, "source-a");
    const expired = (await saveRecoveryDemandForUser(expiring.id, owner, details, "TEST"))!;
    const otherExpired = (await saveRecoveryDemandForUser(expiring.id, other, details, "TEST"))!;
    const healthy = await retainRecoveryRequest({ name: "Recovery Fixture Healthy Links", town: "Harborville CT" }, "source-a");
    const healthyDemand = (await saveRecoveryDemandForUser(healthy.id, owner, details, "TEST"))!;
    await prisma.courseRecoveryDemand.updateMany({ where: { id: { in: [expired.id, otherExpired.id] } }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const healthyList = await listPendingRecoveryDemandsForUser(owner.id);
    expect(healthyList).toHaveLength(1);
    expect(healthyList[0]).toMatchObject({ ...healthyDemand, requestId: healthy.id });
    const expiredRow = await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: expired.id } });
    expect(expiredRow).toMatchObject({ status: "EXPIRED", revision: expired.revision + 1, teeSearchId: null });
    expect((await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: otherExpired.id } })).status).toBe("WAITING");

    for (const status of ["NEEDS_DETAILS", "NOT_PUBLIC", "UNRESOLVED", "ACCESS_LIMITED"] as const) {
      const terminal = await retainRecoveryRequest({ name: `Recovery Fixture ${status} Links`, town: "Harborville CT" }, "source-a");
      const demand = (await saveRecoveryDemandForUser(terminal.id, owner, details, "TEST"))!;
      expect(await completeRecoveryAttempt((await claimRecoveryRequest(terminal.id))!, {
        status, reason: "Synthetic identity evidence requires a different course or further details.",
        evidenceSummary: "Synthetic terminal identity outcome, with no provider reads.",
      })).toBe(true);
      expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(healthyList);
      const actionRequired = await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: demand.id } });
      expect(actionRequired).toMatchObject({ status: "ACTION_REQUIRED", revision: demand.revision + 1, teeSearchId: null });
      expect(await listPendingRecoveryDemandsForUser(owner.id)).toEqual(healthyList);
      expect((await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: demand.id } })).revision).toBe(actionRequired.revision);
    }
    expect((await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: expired.id } })).revision).toBe(expiredRow.revision);
    expect(await listPendingRecoveryDemandsForUser(other.id)).toEqual([]);
    expect((await prisma.courseRecoveryDemand.findUniqueOrThrow({ where: { id: otherExpired.id } })).status).toBe("EXPIRED");
    expect(await prisma.teeSearch.count({ where: { userId: { in: [owner.id, other.id] } } })).toBe(0);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it("returns the verified canonical alias and preserves reusable support", async () => {
    const alias = await prisma.course.create({ data: { googlePlaceId: "recovery-fixture-alias", name: "Old Alias Golf", latitude: 41.3, longitude: -72.9,
      website: "https://harbor.example", detectedBookingUrl: "https://harbor.example/tee-times", providerFamilyKey: "KNOWN_REUSABLE_FAMILY" } });
    await prisma.googlePlaceReview.create({ data: { googlePlaceId: "recovery-fixture-alias", name: "Alias", classification: "CANONICAL_ALIAS",
      evidenceUrl: "https://harbor.example", reviewedAt: new Date(), canonicalPlaceId: "recovery-fixture-harbor", canonicalName: "Recovery Fixture Harbor Dunes Golf Course" } });
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const result = { ...verified, course: { ...verified.course, courseId: alias.id } };
    await completeRecoveryAttempt((await claimRecoveryRequest(id))!, result);
    const view = await readRecoveryView(id);
    expect(view?.course).toMatchObject({ courseId: alias.id, googlePlaceId: "recovery-fixture-harbor", name: verified.course.name, city: "Harborville" });
    expect(await prisma.course.count({ where: { name: { startsWith: "Recovery Fixture Harbor" } } })).toBe(1);
    expect((await prisma.course.findUniqueOrThrow({ where: { id: alias.id } })).providerFamilyKey).toBe("KNOWN_REUSABLE_FAMILY");
  });

  it("hands saved owner demand to the existing causal course-support incident path", async () => {
    const { id } = await retainRecoveryRequest({ name: "Harbor Dunes", town: "Harborville CT" }, "source-a");
    const owner = await prisma.user.create({ data: { clerkUserId: "recovery-fixture-owner", email: "synthetic-owner@example.test" } });
    await saveRecoveryDemandForUser(id, owner, { date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), startTime: "08:00", endTime: "12:00", userTimeZone: "America/New_York", players: 2, cadenceMinutes: 15, additionalEmails: [] }, "PUBLIC");
    await completeRecoveryAttempt((await claimRecoveryRequest(id))!, verified);
    await activateVerifiedRecoveryDemands(id);
    const demand = await getRecoveryDemandForUser(id, owner.id);
    const course = await prisma.course.findUniqueOrThrow({ where: { googlePlaceId: verified.course.googlePlaceId } });
    const observedAt = new Date();
    const result = await reportCourseSupportIssue({ course, searchId: demand!.teeSearchId!, kind: "NEEDS_ADAPTER",
      message: "Synthetic reusable public provider coverage is missing.", failureObservedAt: observedAt, now: observedAt });
    expect(result.incidentId).not.toBeNull();
    const incident = await prisma.courseSupportIncident.findUniqueOrThrow({ where: { courseId: course.id } });
    expect(incident.activeRealSearchCount).toBe(1);
    expect(incident.engineeringOnly).toBe(false);
    expect(incident.status).toBe("AUTO_INVESTIGATING");
    expect(await prisma.courseSupportIncident.count({ where: { courseId: course.id } })).toBe(1);
  });
});
