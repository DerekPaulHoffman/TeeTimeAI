import { createHash, randomUUID } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let database: PrismaClient;
let fixtureOfficialFetch: typeof fetch | undefined;
const emailSend = vi.hoisted(() => vi.fn(async () => { throw new Error("EXTERNAL_EMAIL_FORBIDDEN"); }));
vi.mock("@/lib/prisma", () => ({ get prisma() { return database; } }));
vi.mock("resend", () => ({ Resend: class { emails = { send: emailSend }; } }));
vi.mock("@/lib/automation/address-pinned-public-fetch", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/automation/address-pinned-public-fetch")>();
  return { ...original, createAddressPinnedPublicFetchTransport: (...args: Parameters<typeof original.createAddressPinnedPublicFetchTransport>) => {
    const transport = original.createAddressPinnedPublicFetchTransport(...args);
    return (...request: Parameters<typeof fetch>) => (fixtureOfficialFetch ?? transport)(...request);
  } };
});
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

  it("shows a verified simulator opening from the saved receipt while its reader is offline", async () => {
    const key = randomUUID();
    const now = new Date();
    const dayAhead = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const date = dayAhead(3);
    const opensAt = new Date(`${dayAhead(2)}T08:00:00.000Z`);
    const website = "https://simulator.example.test/";
    const bookingUrl = "https://simulator.example.test/booking";
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const course = await database.course.create({ data: { name: "Simulator booking window fixture", latitude: 41, longitude: -73,
      timeZone: "UTC", website } });
    const offering = await database.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", active: true,
      publicAccessStatus: "PUBLIC", automationEligibility: "ALLOWED", bookingUrl, evidenceUrl: website,
      verifiedAt: new Date(now.getTime() - 60_000), supportedDurationsMinutes: [60],
      bookingWindowDaysAhead: 1, bookingReleaseTimeLocal: "08:00",
    } });
    const network = vi.fn(async () => { throw new Error("NO_EXTERNAL_REQUESTS"); });
    emailSend.mockClear();
    vi.stubGlobal("fetch", network);
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
    vi.stubEnv("COURSE_DISCOVERY_ENABLED", "false");
    try {
      const { createTeeSearchForUser, listTeeSearchesForUser } = await import("@/lib/searches/service");
      const { getSimulatorDashboardStatus } = await import("@/lib/simulators/dashboard-status");
      const { getSimulatorOfferingSourceFingerprint } = await import("@/lib/simulators/source-fingerprint");
      // Keep real database I/O and timers. Skew only the application clock at save.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now.getTime() + 20 * 60_000));
      const saved = await createTeeSearchForUser(user.id, { mode: "SIMULATOR", date, startTime: "10:00", endTime: "14:00",
        players: 2, durationMinutes: 60, userTimeZone: "UTC", cadenceMinutes: 5, additionalEmails: [],
        courses: [{ mode: "SIMULATOR", courseId: course.id, offeringId: offering.id, name: course.name,
          rank: 1, latitude: course.latitude, longitude: course.longitude }],
      }, "PUBLIC").finally(() => vi.useRealTimers());
      const savedReceipt = () => database.courseSetupReceipt.findFirstOrThrow({ where: { preference: { teeSearchId: saved.id } } });
      const receipt = await savedReceipt();
      const [databaseClock] = await database.$queryRaw<Array<{ observedAt: Date }>>`SELECT statement_timestamp() AS "observedAt"`;
      expect(receipt.startedAt).toEqual(saved.createdAt);
      expect(databaseClock.observedAt.getTime() - receipt.startedAt.getTime()).toBeGreaterThanOrEqual(0);
      expect(databaseClock.observedAt.getTime() - receipt.startedAt.getTime()).toBeLessThan(15_000);
      expect(receipt.deadlineAt.getTime() - receipt.startedAt.getTime()).toBe(15 * 60_000);
      expect(receipt).toMatchObject({ outcome: "BOOKING_NOT_OPEN", offeringId: offering.id, evidenceProbeId: null,
        evidenceObservedAt: offering.verifiedAt, closedAt: saved.setupStartedAt,
        request: { mode: "SIMULATOR", targetDate: date, durationMinutes: 60,
          factsAtSave: { kind: "VERIFIED_SIMULATOR_BOOKING_WINDOW", opensAt: opensAt.toISOString(), evidenceUrl: website,
            sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering) },
        },
      });
      const dashboardStatusAt = async (observedAt: Date) => {
        const [search] = await listTeeSearchesForUser(user.id);
        const [preference] = search.preferences;
        expect(search.probes).toHaveLength(0);
        expect(search.matches).toHaveLength(0);
        return { opensAt: preference.setupBookingOpensAt, status: getSimulatorDashboardStatus({
          offering: preference.offering, setupProbe: preference.setupProbe, currentMatchCount: 0,
          alertStatus: search.status, windowEnded: false, website: preference.course.website, now: observedAt,
          discoveryStatus: preference.discoveryStatus, setupDeadlineAt: preference.setupDeadlineAt,
          setupBookingOpensAt: preference.setupBookingOpensAt,
        }) };
      };
      const beforeCutoff = new Date(receipt.startedAt.getTime() + 60_000);
      const afterCutoff = new Date(receipt.deadlineAt.getTime() + 1);
      for (const observedAt of [beforeCutoff, afterCutoff]) {
        expect(await dashboardStatusAt(observedAt)).toMatchObject({ opensAt,
          status: { kind: "BOOKING_NOT_OPEN", label: "The public booking window has not opened yet.", officialUrl: bookingUrl } });
      }
      expect((await dashboardStatusAt(opensAt)).status.kind).toBe("UNCONFIRMED");

      const movedBookingUrl = "https://simulator.example.test/new-booking";
      await database.courseOffering.update({ where: { id: offering.id }, data: { bookingUrl: movedBookingUrl } });
      expect(await dashboardStatusAt(afterCutoff)).toMatchObject({ opensAt: undefined,
        status: { kind: "UNCONFIRMED", officialUrl: movedBookingUrl } });
      expect(await savedReceipt()).toEqual(receipt);
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: saved.id } })).toBe(0);
      expect(network).not.toHaveBeenCalled();
      expect(emailSend).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await database.user.delete({ where: { id: user.id } });
      await database.course.delete({ where: { id: course.id } });
    }
  }, 15_000);

  it("projects a due saved course with the application clock behind before and after durable closeout", async () => {
    const key = randomUUID();
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const course = await database.course.create({ data: { name: `Owner clock fixture ${key}`, latitude: 41, longitude: -73,
      timeZone: "UTC", website: "https://course.example.test/", isPublic: true,
    } });
    const network = vi.fn(async () => { throw new Error("NO_EXTERNAL_REQUESTS"); });
    const readDatabaseClock = async () => {
      const [clock] = await database.$queryRaw<Array<{ observedAt: Date }>>`SELECT statement_timestamp() AS "observedAt"`;
      return clock!.observedAt;
    };
    emailSend.mockClear();
    vi.stubGlobal("fetch", network);
    try {
      const { createTeeSearchForUser, listTeeSearchesForUser } = await import("@/lib/searches/service");
      const { recoverDueCourseSetupReceipts } = await import("@/lib/searches/course-setup-receipts");
      const { getDashboardCourseStatus } = await import("@/lib/searches/dashboard-alert-summary");
      const databaseClock = await readDatabaseClock();
      const day = new Date(databaseClock.getTime() + 2 * 86_400_000).toISOString().slice(0, 10);
      const saved = await createTeeSearchForUser(user.id, { mode: "OUTDOOR", date: day, startTime: "10:00", endTime: "14:00",
        players: 2, userTimeZone: "UTC", cadenceMinutes: 5, additionalEmails: [],
        courses: [{ courseId: course.id, name: course.name, rank: 1, latitude: course.latitude, longitude: course.longitude }],
      }, "TEST", true);
      const startedAt = new Date(databaseClock.getTime() - 16 * 60_000);
      const deadlineAt = new Date(startedAt.getTime() + 15 * 60_000);
      const receiptWhere = { preference: { teeSearchId: saved.id } };
      const setFixtureTimeline = (startedAt: Date, deadlineAt: Date, closedAt: Date | null) =>
        database.$transaction(async transaction => {
          await transaction.teeSearch.update({ where: { id: saved.id }, data: { createdAt: startedAt, setupStartedAt: startedAt } });
          await transaction.courseSetupReceipt.updateMany({ where: receiptWhere,
            data: { startedAt, deadlineAt, closedAt, registeredAt: startedAt },
          });
        });
      // Simulate elapsed time without a cron tick, while preserving the normal setup receipt and request.
      await setFixtureTimeline(startedAt, deadlineAt, null);
      const readReceipt = () => database.courseSetupReceipt.findFirstOrThrow({ where: receiptWhere });
      const pending = await readReceipt();
      expect(pending).toMatchObject({ outcome: null, closedAt: null, deadlineAt });

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(databaseClock.getTime() - 20 * 60_000));
      expect(Date.now()).toBeLessThan(deadlineAt.getTime());
      const expectDueInOwnerList = async (expectedDeadline = deadlineAt) => {
        const before = await readDatabaseClock();
        const [projected] = await listTeeSearchesForUser(user.id);
        const after = await readDatabaseClock();
        expect(projected).toMatchObject({ id: saved.id, availabilityObservedAt: expect.any(Date),
          preferences: [{ courseId: course.id, setupDeadlineAt: expectedDeadline, setupDeadlineReached: true }],
        });
        expect(projected.availabilityObservedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(projected.availabilityObservedAt.getTime()).toBeLessThanOrEqual(after.getTime());
        expect(projected.probes).toHaveLength(0);
        expect(projected.matches).toHaveLength(0);
        const [preference] = projected.preferences;
        expect(getDashboardCourseStatus({
          availability: { alertStatus: projected.status, qualifyingMatchCount: 0, players: projected.players,
            startTime: projected.startTime, endTime: projected.endTime },
          monitoring: { alertStatus: projected.status, alertSupport: null, upcomingBookingWindow: null,
            automationEligibility: "UNKNOWN", automationReason: "NONE", firstTimeLookup: true,
            setupDeadlineAt: preference.setupDeadlineAt, setupDeadlineReached: preference.setupDeadlineReached, now: new Date() },
        }).label).toBe("Automatic availability not confirmed");
        return projected.availabilityObservedAt.getTime();
      };
      await expectDueInOwnerList();
      expect(await readReceipt()).toEqual(pending);

      expect(await recoverDueCourseSetupReceipts()).toMatchObject({ unconfirmed: 1 });
      const closed = await readReceipt();
      expect(closed).toMatchObject({ outcome: "UNCONFIRMED", closedAt: expect.any(Date), evidenceProbeId: null });
      expect(closed.closedAt!.getTime()).toBeGreaterThanOrEqual(deadlineAt.getTime());
      await expectDueInOwnerList();
      expect(await readReceipt()).toEqual(closed);

      // Shift only the fixture timeline to simulate a database clock that fell behind the durable closeout.
      const moveTimelineForward = (value: Date) => new Date(value.getTime() + 5 * 60_000);
      const shiftedDeadline = moveTimelineForward(deadlineAt);
      await setFixtureTimeline(moveTimelineForward(startedAt), shiftedDeadline, moveTimelineForward(closed.closedAt!));
      expect(await expectDueInOwnerList(shiftedDeadline)).toBeLessThan(shiftedDeadline.getTime());
      expect((await readReceipt()).outcome).toBe("UNCONFIRMED");
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: saved.id } })).toBe(0);
      expect(network).not.toHaveBeenCalled();
      expect(emailSend).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      await database.user.delete({ where: { id: user.id } });
      await database.course.delete({ where: { id: course.id } });
    }
  }, 15_000);

  it("persists a known course's normal saved-check receipt while a sibling's official lookup remains open", async () => {
    const key = randomUUID();
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const alias = "staged-fixture";
    const bookingUrl = `https://${alias}.book.teeitup.com/`;
    const officialUrl = "https://example.com/unfamiliar-links";
    const providerOrigin = "https://phx-api-be-east-1b.kenna.io";
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const [slow, known] = await Promise.all([
      database.course.create({ data: { name: "Unfamiliar Links", latitude: 41, longitude: -73,
        timeZone: "UTC", website: officialUrl, isPublic: true } }),
      database.course.create({ data: { name: "Fixture Links", latitude: 42, longitude: -72,
        timeZone: "UTC", website: "https://example.com/fixture-links", isPublic: true,
        detectedBookingUrl: bookingUrl, detectedPlatform: "TEEITUP", providerFamilyKey: "TEEITUP",
        bookingMethod: "PUBLIC_ONLINE", automationEligibility: "ALLOWED",
        bookingMetadata: { aliases: [alias], bookingBaseUrl: bookingUrl },
      } }),
    ]);

    let unpause: () => void = () => {};
    const waitingForOfficialPage = new Promise<void>((resolve) => { unpause = resolve; });
    let officialReadStarted = false;
    const fetchOfficial = vi.fn<typeof fetch>(async (input, init) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (target !== officialUrl || (init?.method ?? "GET") !== "GET") throw new Error("UNEXPECTED_OFFICIAL_FIXTURE_REQUEST");
      officialReadStarted = true;
      await waitingForOfficialPage;
      return new Response("<html><head><title>Unfamiliar Links</title></head><body><h1>Unfamiliar Links</h1></body></html>",
        { headers: { "content-type": "text/html" } });
    });
    const fetchProvider = vi.fn<typeof fetch>(async (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (target.origin !== providerOrigin || (init?.method ?? "GET") !== "GET") throw new Error("UNEXPECTED_PROVIDER_FIXTURE_REQUEST");
      if (target.pathname === `/alias/${alias}/facilities`) {
        return Response.json([{ id: 71, courseId: "fixture-facility", name: known.name, timeZone: "UTC" }]);
      }
      if (target.pathname === "/v2/tee-times" && target.searchParams.get("facilityIds") === "71" && target.searchParams.get("date") === day) {
        return Response.json([{ courseId: "fixture-facility", teetimes: [{ courseId: "fixture-facility", teetime: `${day}T11:00:00.000Z`,
          rates: [{ _id: 1, allowedPlayers: [2, 4], holes: 18, greenFeeCart: 3000 }],
        }] }]);
      }
      throw new Error("UNEXPECTED_TEE_SHEET_FIXTURE_REQUEST");
    });
    fixtureOfficialFetch = fetchOfficial;
    emailSend.mockClear();
    vi.stubGlobal("fetch", fetchProvider);
    vi.stubEnv("COURSE_DISCOVERY_ENABLED", "false");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("ALERT_EMAIL_FROM", "");
    vi.stubEnv("VERCEL_ENV", "development");
    let pending: ReturnType<typeof import("@/lib/automation/search-schedule-execution").executeScheduledSearchCheck> | undefined;
    try {
      const { createTeeSearchForUser } = await import("@/lib/searches/service");
      const { executeScheduledSearchCheck } = await import("@/lib/automation/search-schedule-execution");
      const search = await createTeeSearchForUser(user.id, { mode: "OUTDOOR", date: day, startTime: "10:00", endTime: "12:00",
        players: 2, userTimeZone: "UTC", cadenceMinutes: 5, additionalEmails: [], courses: [slow, known].map((course, index) => ({
          courseId: course.id, name: course.name, rank: index + 1, latitude: course.latitude, longitude: course.longitude,
        })),
      }, "PUBLIC");
      const readReceipts = () => database.courseSetupReceipt.findMany({ where: { preference: { teeSearchId: search.id } } });
      const courseReceipt = (rows: Awaited<ReturnType<typeof readReceipts>>, courseId: string) => rows.find(row => row.courseId === courseId);
      const initial = await readReceipts();
      expect(initial).toHaveLength(2);
      expect(initial.every(receipt => receipt.outcome === null && !receipt.legacy)).toBe(true);

      pending = executeScheduledSearchCheck(search.id, search.scheduleVersion);
      await vi.waitFor(async () => {
        expect(officialReadStarted).toBe(true);
        expect(courseReceipt(await readReceipts(), known.id)).toMatchObject({ outcome: "MATCHES_AVAILABLE" });
      }, { timeout: 5000, interval: 25 });
      const beforeUnpause = await readReceipts();
      const knownReceipt = courseReceipt(beforeUnpause, known.id)!;
      const probe = await database.courseProbe.findUniqueOrThrow({ where: { id: knownReceipt.evidenceProbeId! } });
      expect(probe).toMatchObject({ courseId: known.id, teeSearchId: search.id, outcome: "MATCH_FOUND",
        rawSummary: { providerExecution: "RUNNABLE_PROVIDER_CHECK", publicAvailability: { date: day } },
      });
      expect(knownReceipt.closedAt!.getTime()).toBeLessThan(knownReceipt.deadlineAt.getTime());
      const savedToKnownResultMs = knownReceipt.closedAt!.getTime() - knownReceipt.startedAt.getTime();
      expect(savedToKnownResultMs).toBeLessThan(15_000);
      expect(courseReceipt(beforeUnpause, slow.id)).toMatchObject({ outcome: null, closedAt: null });
      expect(await database.searchEmailDelivery.count({ where: { teeSearchId: search.id } })).toBe(0);
      expect(emailSend).not.toHaveBeenCalled();
      console.info("[course-setup-acceptance]", { savedToKnownResultMs, knownResult: knownReceipt.outcome, pendingSibling: true, emailSends: 0 });

      unpause();
      const result = await pending;
      expect(result.courseResults).toMatchObject([
        { courseId: slow.id, outcome: "NEEDS_ADAPTER" },
        { courseId: known.id, outcome: "MATCH_FOUND", availableMatches: 1 },
      ]);
      expect(courseReceipt(await readReceipts(), known.id)).toEqual(knownReceipt);
      expect(await database.courseProbe.count({ where: { teeSearchId: search.id, courseId: slow.id } })).toBeGreaterThan(0);
      expect(fetchOfficial).toHaveBeenCalledTimes(1);
      expect(fetchProvider).toHaveBeenCalledTimes(2);
      expect(emailSend).not.toHaveBeenCalled();
    } finally {
      unpause();
      await pending?.catch(() => undefined);
      fixtureOfficialFetch = undefined;
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      const probes = await database.courseProbe.findMany({ where: { teeSearch: { userId: user.id } }, select: { automationRunId: true } });
      await database.user.delete({ where: { id: user.id } });
      await database.course.deleteMany({ where: { id: { in: [slow.id, known.id] } } });
      await database.automationRun.deleteMany({ where: { id: { in: probes.flatMap(probe => probe.automationRunId ? [probe.automationRunId] : []) } } });
    }
  }, 20_000);

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

  it("settles saved overdue receipts while legacy registration is blocked and reports its failure", async () => {
    const key = randomUUID();
    const old = new Date(Date.now() - 86_400_000);
    const user = await database.user.create({ data: { email: `${key}@example.test`, clerkUserId: key } });
    const course = await database.course.create({ data: {
      name: `Saved fixture ${key}`, latitude: 41, longitude: -73, timeZone: "UTC", isPublic: true,
    } });
    try {
      const search = await database.teeSearch.create({ data: {
        userId: user.id, createdAt: old, setupStartedAt: old, date: old, startTime: "09:00", endTime: "10:00", players: 2,
        trafficClass: "TEST", preferences: { create: { courseId: course.id, rank: 1 } },
      }, include: { preferences: true } });
      const receipt = await database.courseSetupReceipt.create({ data: {
        preferenceId: search.preferences[0]!.id, courseId: course.id, request: {},
        startedAt: old, deadlineAt: new Date(old.getTime() + 900_000),
      } });
      const { recoverDueCourseSetupReceipts } = await import("@/lib/searches/course-setup-receipts");
      const legacyFailure = new Error("Fixture legacy registration transaction failed");
      let failRegistration = () => {};
      const registration = new Promise<never>((_, reject) => { failRegistration = () => reject(legacyFailure); });
      const transaction = vi.spyOn(database, "$transaction").mockReturnValueOnce(registration);
      const recoveryFailure = expect(recoverDueCourseSetupReceipts()).rejects.toBe(legacyFailure);
      try {
        await vi.waitFor(async () => {
          const settled = await database.courseSetupReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
          expect(settled).toMatchObject({ outcome: "UNCONFIRMED", closedAt: expect.any(Date), evidenceProbeId: null });
        }, { timeout: 2_000 });
      } finally {
        failRegistration();
        transaction.mockRestore();
        await recoveryFailure;
      }
      expect(await recoverDueCourseSetupReceipts()).toMatchObject({ registeredLegacy: 0, unconfirmed: 0, legacyUnverified: 0 });
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
