import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let database: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return database; } }));
vi.mock("@/lib/automation/course-support-verification-scheduler", () => ({
  recoverDueCourseSupportVerificationRequests: async () => ({ considered: 0, started: 0, failed: 0 }),
}));

const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;

describe.skipIf(!url)("hosted course setup deadlines with isolated Postgres", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/course_discovery_test" || process.env.DATABASE_URL !== url) {
      throw new Error("The isolated loopback course_discovery_test database is required.");
    }
    database = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    await database.$connect();
  });

  afterAll(async () => { if (database) await database.$disconnect(); });

  it("settles saved course receipts once through checked writes and the hosted watchdog without any discovery job", async () => {
    const key = randomUUID();
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const courses = await Promise.all(["empty", "ambiguous", "restricted"].map(name => database.course.create({ data: {
      name: `${name} ${key}`, latitude: 41, longitude: -73, timeZone: "UTC",
      website: "https://course.example.test/", isPublic: true,
    } })));
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const { createTeeSearchForUser, listTeeSearchesForUser, updateTeeSearchForUser } = await import("@/lib/searches/service");
    const { recordCourseProbe } = await import("@/lib/automation/db-service");
    const { withSearchCheckWriteContext } = await import("@/lib/automation/search-check-write-context");
    const { GET } = await import("@/app/api/cron/recover-course-support-verifications/route");
    const network = vi.fn(async () => { throw new Error("NO_EXTERNAL_REQUESTS"); });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("CRON_SECRET", key);
    try {
      const search = await createTeeSearchForUser(user.id, {
        mode: "OUTDOOR", date: day, startTime: "10:00", endTime: "15:00", players: 2,
        userTimeZone: "UTC", cadenceMinutes: 5, additionalEmails: [],
        courses: courses.map((course, index) => ({ courseId: course.id, name: course.name, rank: index + 1,
          latitude: course.latitude, longitude: course.longitude })),
      }, "TEST", true);
      const scope = { preference: { teeSearchId: search.id } };
      const stored = () => database.courseSetupReceipt.findMany({ where: scope, orderBy: { startedAt: "asc" } });
      const initial = await stored();
      expect(initial).toHaveLength(3);
      expect(initial.every(row => row.outcome === null && row.deadlineAt.getTime() - row.startedAt.getTime() === 900_000)).toBe(true);
      const lease = { searchId: search.id, scheduleVersion: search.scheduleVersion, leaseToken: key };
      await database.teeSearch.update({ where: { id: search.id }, data: {
        checkStatus: "CHECKING", checkLeaseToken: key, checkLeaseExpiresAt: new Date(Date.now() + 120_000),
      } });
      const observedAt = new Date().toISOString();
      const evidence = { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: observedAt,
        publicAvailability: { date: day, confirmedAt: observedAt, times: [] } };
      const empty = await withSearchCheckWriteContext(lease, () => recordCourseProbe({
        searchId: search.id, courseId: courses[0].id, outcome: "NO_MATCH", rawSummary: evidence,
      }));
      const ambiguous = await withSearchCheckWriteContext(lease, () => recordCourseProbe({
        searchId: search.id, courseId: courses[1].id, outcome: "NEEDS_ADAPTER",
      }));
      const access = await withSearchCheckWriteContext(lease, () => recordCourseProbe({
        searchId: search.id, courseId: courses[2].id, outcome: "BLOCKED_AUTH",
        rawSummary: { monitoringDisposition: "TECHNICAL_FINAL", verifiedAccessRestriction: true },
      }));
      const byCourse = (rows: Awaited<ReturnType<typeof stored>>, index: number) => rows.find(row => row.courseId === courses[index].id)!;
      const onTime = await stored();
      expect(byCourse(onTime, 0)).toMatchObject({ outcome: "NO_OPENINGS", evidenceProbeId: empty.id });
      expect(byCourse(onTime, 0).closedAt!.getTime() - search.setupStartedAt!.getTime()).toBeLessThan(15_000);
      expect(byCourse(onTime, 2)).toMatchObject({ outcome: "DIRECT_ACTION", evidenceProbeId: access.id });
      expect(byCourse(onTime, 1).outcome).toBeNull();

      // Advance the quiet course to its cutoff without sleeping fifteen minutes.
      await database.courseSetupReceipt.update({ where: { id: byCourse(onTime, 1).id },
        data: { deadlineAt: new Date(Date.now() - 1) } });
      const tick = () => GET(new Request("http://localhost/api/cron/recover-course-support-verifications", {
        headers: { authorization: `Bearer ${key}` },
      }));
      const ticks = await Promise.all([tick(), tick()]);
      expect(ticks.map(result => result.status)).toEqual([200, 200]);
      const reports = await Promise.all(ticks.map(result => result.json()));
      expect(reports.reduce((total, report) => total + report.setupDeadlines.unconfirmed, 0)).toBe(1);
      const timedOut = byCourse(await stored(), 1);
      expect(timedOut).toMatchObject({ outcome: "UNCONFIRMED", evidenceProbeId: ambiguous.id });

      await withSearchCheckWriteContext(lease, () => recordCourseProbe({
        searchId: search.id, courseId: courses[1].id, outcome: "NO_MATCH", rawSummary: evidence,
      }));
      const [current] = await listTeeSearchesForUser(user.id);
      expect(current.probes.find(probe => probe.courseId === courses[1].id)?.outcome).toBe("NO_MATCH");
      expect(byCourse(await stored(), 1)).toEqual(timedOut);

      await updateTeeSearchForUser(user.id, search.id, { startTime: "11:00" });
      const all = await stored();
      expect(all).toHaveLength(6);
      expect(all.slice(3).every(row => row.outcome === null && row.startedAt > initial[0].startedAt)).toBe(true);
      expect(all.find(row => row.id === timedOut.id)).toEqual(timedOut);
      expect(await database.courseDiscoveryJob.count({ where: { courseId: { in: courses.map(course => course.id) } } })).toBe(0);
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: search.id } })).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    }
  }, 15_000);

  it("settles a materially edited migrated outdoor alert with a course-scoped probe", async () => {
    const key = randomUUID();
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const courses = await Promise.all(["Migrated outdoor", "Invalid outdoor alias"].map(name => database.course.create({ data: {
      name: `${name} ${key}`, latitude: 41, longitude: -73, timeZone: "UTC",
      website: "https://course.example.test/", isPublic: true,
    } })));
    try {
      const { updateTeeSearchForUser } = await import("@/lib/searches/service");
      const { recordCourseProbe } = await import("@/lib/automation/db-service");
      const { withSearchCheckWriteContext } = await import("@/lib/automation/search-check-write-context");
      const { readSavedCourseSetupDeadline } = await import("@/lib/searches/course-setup-receipts");
      const { ensureDiscoveryJob } = await import("./service");
      const offerings = await Promise.all(courses.map((course, index) => database.courseOffering.create({ data: {
        id: `outdoor-${course.id}`, courseId: course.id, kind: index === 0 ? "OUTDOOR" : "SIMULATOR",
      } })));
      const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const saved = await database.teeSearch.create({ data: {
        userId: user.id, mode: "OUTDOOR", date: new Date(day), startTime: "10:00", endTime: "15:00", players: 2,
        userTimeZone: "UTC", trafficClass: "TEST", syntheticMultiCycle: true, createdAt: new Date(Date.now() - 30 * 60_000),
        preferences: { create: courses.map((course, index) => ({
          courseId: course.id, offeringId: offerings[index].id, rank: index + 1,
        })) },
      } });
      const edited = await updateTeeSearchForUser(user.id, saved.id, { startTime: "11:00" });
      const lease = { searchId: saved.id, scheduleVersion: edited.scheduleVersion, leaseToken: key };
      await database.teeSearch.update({ where: { id: saved.id }, data: {
        checkStatus: "CHECKING", checkLeaseToken: key, checkLeaseExpiresAt: new Date(Date.now() + 120_000),
      } });
      for (const course of courses) {
        const observedAt = new Date().toISOString();
        const probe = await withSearchCheckWriteContext(lease, () => recordCourseProbe({
          searchId: saved.id, courseId: course.id, outcome: "NO_MATCH", rawSummary: {
            providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: observedAt,
            publicAvailability: { date: day, confirmedAt: observedAt, times: [] },
          },
        }));
        expect(probe.offeringId).toBeNull();
      }
      const receipts = await database.courseSetupReceipt.findMany({ where: { preference: { teeSearchId: saved.id } } });
      const outdoor = receipts.find(receipt => receipt.courseId === courses[0].id)!;
      expect(outdoor).toMatchObject({ outcome: "NO_OPENINGS", offeringId: offerings[0].id, legacy: false,
        evidenceProbeId: expect.any(String) });
      expect(receipts.find(receipt => receipt.courseId === courses[1].id)).toMatchObject({ outcome: null, evidenceProbeId: null });
      const deadlineFor = (courseId: string) => database.$transaction(transaction => readSavedCourseSetupDeadline(transaction, {
        searchId: saved.id, courseId, offeringId: null, startedAt: edited.setupStartedAt!,
      }));
      expect(await deadlineFor(courses[0].id)).toEqual(outdoor.deadlineAt);
      expect(await deadlineFor(courses[1].id)).toBeUndefined();
      vi.stubEnv("COURSE_DISCOVERY_ENABLED", "true");
      vi.stubEnv("COURSE_DISCOVERY_ROLLOUT_MODE", "PILOT");
      vi.stubEnv("COURSE_DISCOVERY_PILOT_SEARCH_IDS", saved.id);
      const admitted = await ensureDiscoveryJob({ courseId: courses[0].id, searchId: saved.id });
      expect(admitted).toMatchObject({ targetKey: `course:${courses[0].id}`, offeringId: null, status: "QUEUED",
        setupDeadlineAt: outdoor.deadlineAt });
      expect(await ensureDiscoveryJob({ courseId: courses[1].id, searchId: saved.id })).toBeNull();
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: saved.id } })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    }
  }, 15_000);

  it("parks repeated outdoor infrastructure misses through the dispatcher without reopening on the hosted watchdog", async () => {
    const now = new Date();
    const key = randomUUID();
    const releases = ["e".repeat(40), "f".repeat(40)];
    const course = await database.course.create({ data: {
      name: `Orchestration fixture ${key}`, latitude: 41, longitude: -73, timeZone: "America/New_York",
      website: "https://course.example.test/", detectedBookingUrl: "https://course.example.test/book",
      isPublic: true, detectedPlatform: "UNKNOWN", providerFamilyKey: "GENERIC_PUBLIC_FIXTURE",
    } });
    const incident = await database.courseSupportIncident.create({ data: {
      reference: key, courseId: course.id, courseNameSnapshot: course.name, platformSnapshot: course.detectedPlatform,
      providerFamilyKey: course.providerFamilyKey!, failureFingerprint: "v1:UNSUPPORTED_FAMILY:NEEDS_ADAPTER",
      kind: "NEEDS_ADAPTER", failureClass: "UNSUPPORTED_FAMILY", engineeringOnly: true,
      confirmedAt: new Date(now.getTime() - 120_000), firstSeenAt: new Date(now.getTime() - 120_000),
      nextAttemptAt: now, attemptCount: 2,
    } });
    const batchIds: string[] = [];
    try {
      await database.courseMonitoringStatus.create({ data: {
        courseId: course.id, reference: key, state: "AUTO_INVESTIGATING", nextAutomaticAttemptAt: now,
      } });
      const { buildCourseSupportProviderSnapshotFingerprint } = await import("@/lib/automation/course-support-verification");
      const { planCourseSupportCourseDispatch } = await import("@/lib/automation/course-support-course-dispatch");
      const { reconcileCourseMonitoringDeadline } = await import("@/lib/automation/course-monitoring");
      for (const [index, baseSha] of releases.entries()) {
        const completedAt = new Date(now.getTime() - (2 - index) * 1_000);
        const batch = await database.courseSupportBatch.create({ data: {
          reference: `${key}-${index}`, providerFamilyKey: incident.providerFamilyKey, failureFingerprint: incident.failureFingerprint,
          status: "RETRYABLE_FAILED", ownerThreadId: `fixture-owner-${index}`, leaseToken: randomUUID(),
          baseSha, leaseExpiresAt: completedAt, heartbeatAt: completedAt, completedAt,
          incidents: { create: { incidentId: incident.id, courseId: course.id, cycle: 1, result: "RETRY_SCHEDULED", createdAt: completedAt } },
          summary: { closeout: { orchestrationOnly: true, remediationAttempts: [{
            courseRef: createHash("sha256").update(course.id).digest("hex").slice(0, 24),
            providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course), failureFingerprint: incident.failureFingerprint,
            runtimeVersion: baseSha, activeRealSearchCount: 0, consumed: false, countsTowardOperationalNoProgress: false,
            approach: { workMode: "ADVANCE_DISCOVERY", strategyAction: "DISCOVER_WITH_HTTP", playbookStage: "OFFICIAL_IDENTITY" },
            executionEvidence: { claimedImplementationPaths: false, newReleaseRecorded: false, deploymentRecorded: false,
              postProbeRecorded: false, providerAttemptRecorded: false, providerExecutionAttemptRecorded: false,
              playbookAttemptRecorded: false, terminalResultRecorded: false, providerExecutionStarted: false },
          }] } },
        } });
        batchIds.push(batch.id);
      }
      const planner = () => planCourseSupportCourseDispatch({ ownerThreadId: "fixture-dispatcher", baseSha: "a".repeat(40), now });
      expect(await planner()).toMatchObject({ acquired: true, value: { launchItems: [], reservedCount: 0 } });
      expect(await reconcileCourseMonitoringDeadline({ courseId: course.id, source: "RECOVERY_CRON", now }))
        .toMatchObject({ outcome: "RETAINED_PARKED", incidentId: incident.id });
      expect(await planner()).toMatchObject({ acquired: true, value: { launchItems: [], reservedCount: 0 } });
      const parked = await database.courseSupportIncident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(parked).toMatchObject({ status: "NEEDS_HUMAN", nextAttemptAt: null, activeBatchId: null, attemptCount: 2 });
      const events = await database.courseMonitoringEvent.findMany({ where: { incidentId: incident.id } });
      expect(events).toHaveLength(1);
      expect(events[0]?.audit).toMatchObject({ reason: "ORCHESTRATION_RETRY_BUDGET_EXHAUSTED", operationalRetryBudgetExhausted: false });
      expect(await database.courseSupportBatch.count({ where: { id: { in: batchIds }, status: "RETRYABLE_FAILED" } })).toBe(2);
    } finally {
      await database.courseSupportBatch.deleteMany({ where: { id: { in: batchIds } } });
      await database.course.delete({ where: { id: course.id } });
    }
  }, 20_000);

  it("reconciles a legacy search without reopening or scheduling ended demand", async () => {
    const key = randomUUID();
    const old = new Date(Date.now() - 86_400_000);
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const course = await database.course.create({ data: {
      name: `Legacy fixture ${key}`, latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true,
    } });
    try {
      const [pending, ended] = await Promise.all((["ACTIVE", "CANCELLED"] as const).map(status => database.teeSearch.create({ data: {
        userId: user.id, createdAt: old, date: old, startTime: "09:00", endTime: "10:00", players: 2, status,
        trafficClass: "TEST", preferences: { create: { courseId: course.id, rank: 1 } },
      } })));
      const { recoverDueCourseSetupReceipts } = await import("@/lib/searches/course-setup-receipts");
      expect(await recoverDueCourseSetupReceipts()).toMatchObject({ registeredLegacy: 1, legacyUnverified: 1 });
      const oldReceipt = await database.courseSetupReceipt.findFirstOrThrow({ where: { preference: { teeSearchId: pending.id } } });
      expect(oldReceipt).toMatchObject({ legacy: true, startedAt: old, outcome: "LEGACY_UNVERIFIED", evidenceProbeId: null });
      expect(await recoverDueCourseSetupReceipts()).toMatchObject({ registeredLegacy: 0, legacyUnverified: 0 });
      expect(await database.courseSetupReceipt.count({ where: { preference: { teeSearchId: ended.id } } })).toBe(0);
      expect(await database.teeSearch.findUniqueOrThrow({ where: { id: ended.id } })).toMatchObject({
        status: "CANCELLED", workflowRunId: null, nextCheckAt: null,
      });
      expect(await database.courseDiscoveryJob.count({ where: { courseId: course.id } })).toBe(0);
    } finally {
      await database.user.delete({ where: { id: user.id } });
      await database.course.delete({ where: { id: course.id } });
    }
  });

  it("preserves already verified booking-window and direct-action facts even with no check", async () => {
    const key = randomUUID();
    const verifiedAt = new Date(Date.now() - 60_000);
    const day = new Date(Date.now() + 172_800_000).toISOString().slice(0, 10);
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const identity = { latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true,
      website: "https://course.example.test/" };
    const courses = await Promise.all([
      database.course.create({ data: { ...identity, name: `Published window ${key}`,
        bookingWindowDaysAhead: 0, bookingReleaseTimeLocal: "08:00", bookingWindowSource: "PROVIDER_CONFIG",
        bookingWindowConfidence: 1, bookingWindowObservedAt: verifiedAt,
        bookingWindowEvidenceUrl: "https://course.example.test/window" } }),
      database.course.create({ data: { ...identity, name: `Access restriction ${key}`,
        automationEligibility: "BLOCKED", automationReason: "ACCOUNT_REQUIRED", bookingAccessMode: "ACCOUNT_REQUIRED",
        intelligenceConfidence: 1, intelligenceVerifiedAt: verifiedAt, intelligenceReviewAt: new Date(Date.now() + 86_400_000) } }),
    ]);
    try {
      const { createTeeSearchForUser } = await import("@/lib/searches/service");
      const saved = await createTeeSearchForUser(user.id, {
        mode: "OUTDOOR", date: day, startTime: "10:00", endTime: "15:00", players: 2,
        userTimeZone: "UTC", cadenceMinutes: 5, additionalEmails: [],
        courses: courses.map((course, index) => ({ courseId: course.id, name: course.name, rank: index + 1,
          latitude: course.latitude, longitude: course.longitude })),
      }, "TEST", true);
      const rows = await database.courseSetupReceipt.findMany({ where: { preference: { teeSearchId: saved.id } } });
      expect(rows.find(row => row.courseId === courses[0].id)).toMatchObject({
        outcome: "BOOKING_NOT_OPEN", closedAt: saved.setupStartedAt, evidenceObservedAt: verifiedAt,
        request: { factsAtSave: { source: "PROVIDER_CONFIG", opensAt: `${day}T08:00:00.000Z` } },
      });
      expect(rows.find(row => row.courseId === courses[1].id)).toMatchObject({
        outcome: "DIRECT_ACTION", closedAt: saved.setupStartedAt, evidenceObservedAt: verifiedAt,
        request: { factsAtSave: { disposition: "TECHNICAL_FINAL", reason: "ACCOUNT_REQUIRED" } },
      });
      expect(await database.courseProbe.count({ where: { teeSearchId: saved.id } })).toBe(0);
    } finally {
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    }
  });

  it("settles five saved courses with the learner offline, fences late writes, and preserves a later verified result", async () => {
    const now = new Date();
    const savedAt = new Date(now.getTime() - 16 * 60_000);
    const deadline = new Date(savedAt.getTime() + 15 * 60_000);
    const playDate = new Date(now);
    playDate.setUTCDate(playDate.getUTCDate() + 2);
    playDate.setUTCHours(0, 0, 0, 0);
    const suffix = randomUUID();
    const user = await database.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } });
    const courses = await Promise.all(Array.from({ length: 5 }, (_, index) => database.course.create({ data: {
      name: `Isolated setup fixture ${suffix} ${index}`, latitude: 41, longitude: -73,
      timeZone: "America/New_York", website: "https://course.example.test/", isPublic: true,
    } })));
    const { GET } = await import("@/app/api/cron/recover-course-support-verifications/route");
    const { getDiscoverySourceFingerprint, heartbeatDiscoveryJob } = await import("./service");
    const { createTeeSearchForUser, listTeeSearchesForUser } = await import("@/lib/searches/service");
    const { getDashboardCourseStatus } = await import("@/lib/searches/dashboard-alert-summary");

    vi.stubEnv("CRON_SECRET", `fixture-${suffix}`);
    const network = vi.fn(async () => { throw new Error("NO_EXTERNAL_REQUESTS"); });
    vi.stubGlobal("fetch", network);
    try {
      const search = await createTeeSearchForUser(user.id, {
        mode: "OUTDOOR", date: playDate.toISOString().slice(0, 10), startTime: "10:00", endTime: "15:00", players: 2,
        userTimeZone: "America/New_York", cadenceMinutes: 5, additionalEmails: [],
        courses: courses.map((course, index) => ({ courseId: course.id, name: course.name, latitude: course.latitude,
          longitude: course.longitude, rank: index + 1 })),
      }, "TEST", true);
      expect(search.preferences).toHaveLength(5);
      // Use persisted times to simulate queue wait while keeping the actual save and read paths.
      await database.teeSearch.update({ where: { id: search.id }, data: { createdAt: savedAt, setupStartedAt: savedAt } });
      await database.courseSetupReceipt.updateMany({ where: { preference: { teeSearchId: search.id } },
        data: { startedAt: savedAt, deadlineAt: deadline, registeredAt: savedAt } });
      const jobs = await Promise.all([0, 1, 2].map(async index => {
        const course = courses[index];
        return database.courseDiscoveryJob.create({ data: {
          courseId: course.id, targetKey: `course:${course.id}`, activeTargetKey: `course:${course.id}`,
          sourceFingerprint: getDiscoverySourceFingerprint(course),
          createdAt: now,
          ...(index === 2 ? {} : { setupDeadlineAt: deadline }),
          ...(index === 1 ? { status: "RUNNING", attempts: 1, firstPickedUpAt: new Date(now.getTime() - 14 * 60_000),
            deadlineAt: new Date(now.getTime() + 60_000), leaseToken: suffix, leaseExpiresAt: new Date(now.getTime() + 60_000) } : {}),
          request: {},
        } });
      }));

      const probeAt = new Date(savedAt.getTime() + 60_000);
      const emptyProbe = (observedAt: Date) => ({
        outcome: "NO_MATCH" as const, observedAt, rawSummary: { visibleSlotCount: 0, playerEligibleSlotCount: 0,
          providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: observedAt.toISOString() },
      });
      await database.courseProbe.createMany({ data: [
        { teeSearchId: search.id, courseId: courses[3].id, ...emptyProbe(probeAt) },
        { teeSearchId: search.id, courseId: courses[4].id, outcome: "BLOCKED_AUTH", observedAt: probeAt },
      ] });

      const rowLabels = async (observedAt: Date) => {
        const [projected] = await listTeeSearchesForUser(user.id);
        return projected.preferences.map(preference => {
          expect(preference.setupDeadlineAt).toEqual(deadline);
          const probe = projected.probes.find(item => item.courseId === preference.courseId);
          return getDashboardCourseStatus({
            availability: { alertStatus: projected.status, outcome: probe?.outcome, rawSummary: probe?.rawSummary,
              qualifyingMatchCount: 0, players: projected.players, startTime: projected.startTime, endTime: projected.endTime },
            monitoring: { alertStatus: projected.status, alertSupport: null, automationEligibility: "UNKNOWN",
              automationReason: "NONE", upcomingBookingWindow: null, firstTimeLookup: true,
              latestProbe: probe, setupDeadlineAt: preference.setupDeadlineAt, now: observedAt },
          }).label;
        });
      };
      expect(await rowLabels(deadline)).toEqual([
        "Automatic availability not confirmed", "Automatic availability not confirmed", "Automatic availability not confirmed",
        "No public times listed", "Check the official course site",
      ]);

      const tick = () => GET(new Request("http://localhost/api/cron/recover-course-support-verifications", {
        headers: { authorization: `Bearer fixture-${suffix}` },
      }));
      const responses = await Promise.all([tick(), tick()]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
      const receipts = await Promise.all(responses.map(response => response.json()));
      expect(receipts.reduce((total, receipt) => total + receipt.discoveryDeadlines.queueTimedOut, 0)).toBe(1);
      expect(receipts.reduce((total, receipt) => total + receipt.discoveryDeadlines.executionTimedOut, 0)).toBe(1);

      const activeJobs = await Promise.all(jobs.map(job => database.courseDiscoveryJob.findUniqueOrThrow({ where: { id: job.id } })));
      expect(activeJobs.map(job => [job.status, job.outcome])).toEqual([
        ["TIMED_OUT", "QUEUE_DEADLINE"], ["TIMED_OUT", "DEADLINE"], ["QUEUED", null],
      ]);
      expect(activeJobs[0]).toMatchObject({ firstPickedUpAt: null, deadlineAt: null, activeTargetKey: null });
      expect(activeJobs[1]).toMatchObject({ firstPickedUpAt: jobs[1].firstPickedUpAt, deadlineAt: jobs[1].deadlineAt,
        setupDeadlineAt: deadline, leaseToken: null, activeTargetKey: null });
      await expect(heartbeatDiscoveryJob(jobs[1].id, suffix)).rejects.toThrow("Course discovery state changed");

      await database.courseProbe.create({ data: { teeSearchId: search.id, courseId: courses[0].id, ...emptyProbe(now) } });
      expect((await rowLabels(now))[0]).toBe("No public times listed");
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: search.id } })).toBe(0);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    }
  });
});
