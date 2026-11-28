import { randomUUID } from "node:crypto";

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
    const search = await database.teeSearch.create({ data: {
      userId: user.id, createdAt: savedAt, date: playDate, startTime: "10:00", endTime: "15:00", players: 2,
      trafficClass: "TEST", preferences: { create: courses.map((course, index) => ({ courseId: course.id, rank: index + 1 })) },
    } });
    const { GET } = await import("@/app/api/cron/recover-course-support-verifications/route");
    const { getDiscoverySourceFingerprint, heartbeatDiscoveryJob } = await import("./service");
    const { listTeeSearchesForUser } = await import("@/lib/searches/service");
    const { getDashboardCourseStatus } = await import("@/lib/searches/dashboard-alert-summary");

    vi.stubEnv("CRON_SECRET", `fixture-${suffix}`);
    try {
      const jobs = await Promise.all([0, 1, 2].map(async index => {
        const course = courses[index];
        return database.courseDiscoveryJob.create({ data: {
          courseId: course.id, targetKey: `course:${course.id}`, activeTargetKey: `course:${course.id}`,
          sourceFingerprint: getDiscoverySourceFingerprint(course),
          createdAt: index === 2 ? now : savedAt,
          ...(index === 1 ? { status: "RUNNING", attempts: 1, firstPickedUpAt: savedAt,
            deadlineAt: deadline, leaseToken: suffix, leaseExpiresAt: deadline } : {}),
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
      expect(activeJobs[1]).toMatchObject({ firstPickedUpAt: savedAt, deadlineAt: deadline, leaseToken: null, activeTargetKey: null });
      await expect(heartbeatDiscoveryJob(jobs[1].id, suffix)).rejects.toThrow("Course discovery state changed");

      await database.courseProbe.create({ data: { teeSearchId: search.id, courseId: courses[0].id, ...emptyProbe(now) } });
      expect((await rowLabels(now))[0]).toBe("No public times listed");
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: search.id } })).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: courses.map(course => course.id) } } });
    }
  });
});
