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
