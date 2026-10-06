// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.SIMULATOR_TEST_DATABASE_URL;
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  sendMatch: vi.fn(),
  sendStatus: vi.fn(),
  sourceCheck: vi.fn(),
}));

vi.mock("@/lib/simulators/providers", () => ({ fetchSimulatorAvailability: mocks.fetch }));
vi.mock("./simulator-source-check", () => ({ checkSimulatorOfficialSource: mocks.sourceCheck }));
vi.mock("@/lib/automation/provider-request-lease", () => ({
  runWithProviderRequestLease: async (_family: string, worker: () => Promise<unknown>) =>
    ({ acquired: true, value: await worker() }),
}));
vi.mock("@/lib/email/alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/alerts")>()),
  sendTeeTimeAlert: mocks.sendMatch,
  sendSimulatorStatusEmail: mocks.sendStatus,
}));

let client: PrismaClient;
let runCheck: typeof import("./simulator-search-check").runSimulatorSearchCheck;
let getSearch: typeof import("./db-service").getActiveSearchForAutomation;
const fixtureIds: { search: string[]; course: string[]; user: string[]; run: string[] } = {
  search: [], course: [], user: [], run: [],
};

function assertPreviewDatabase(url: string) {
  const parsed = new URL(url);
  if (!(["localhost", "127.0.0.1", "[::1"].includes(parsed.hostname)) ||
      !/^\/simulator_preview$/.test(parsed.pathname) ||
      !["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("Simulator integration tests require the isolated local simulator_preview database");
  }
}

describe.skipIf(!databaseUrl)("simulator check against isolated Postgres", () => {
  beforeAll(async () => {
    assertPreviewDatabase(databaseUrl!);
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl!, connectionTimeoutMillis: 5_000 }) });
    await client.$connect();
    ({ runSimulatorSearchCheck: runCheck } = await import("./simulator-search-check"));
    ({ getActiveSearchForAutomation: getSearch } = await import("./db-service"));
  });

  afterAll(async () => {
    if (client) {
      await client.teeSearch.deleteMany({ where: { id: { in: fixtureIds.search } } });
      await client.automationRun.deleteMany({ where: { id: { in: fixtureIds.run } } });
      await client.course.deleteMany({ where: { id: { in: fixtureIds.course } } });
      await client.user.deleteMany({ where: { id: { in: fixtureIds.user } } });
      await client.$disconnect();
    }
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.sendMatch.mockReset().mockResolvedValue({ deliveryStatus: "sent", id: "intercepted-test-send" });
    mocks.sendStatus.mockReset().mockResolvedValue({ deliveryStatus: "sent", id: "intercepted-test-send" });
    mocks.sourceCheck.mockReset().mockResolvedValue({ outcome: "READ_OK", httpStatus: 200 });
  });

  async function fixture(venueCount: number, options: { setupPending?: boolean; additionalEmails?: string[] } = {}) {
    const suffix = randomUUID();
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + 2);
    const date = new Date(`${day.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const user = await client.user.create({ data: { id: `sim-user-${suffix}`, clerkUserId: `sim-clerk-${suffix}`, email: `sim-${suffix}@example.test` } });
    fixtureIds.user.push(user.id);
    const venues = [];
    for (let index = 0; index < venueCount; index++) {
      const course = await client.course.create({ data: {
        id: `sim-venue-${index}-${suffix}`, googlePlaceId: `sim-place-${index}-${suffix}`,
        name: `Simulator Venue ${index + 1}`, latitude: 41.1 + index, longitude: -73.2,
        timeZone: "UTC", isPublic: false, automationEligibility: "BLOCKED",
      } });
      fixtureIds.course.push(course.id);
      const offering = await client.courseOffering.create({ data: {
        courseId: course.id, kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC",
        bookingUrl: `https://venue-${index}.example.test/book`,
        evidenceUrl: `https://venue-${index}.example.test/rentals`, verifiedAt: new Date(),
        providerFamilyKey: "GOLFBOOK", maxPartySize: 8, supportedDurationsMinutes: [120],
      } });
      venues.push({ course, offering });
    }
    const token = randomUUID();
    const search = await client.teeSearch.create({ data: {
      userId: user.id, mode: "SIMULATOR", durationMinutes: 120, date,
      startTime: "13:00", endTime: "19:00", userTimeZone: "UTC", players: 4,
      additionalEmails: options.additionalEmails ?? [],
      status: "ACTIVE", checkStatus: "CHECKING", checkLeaseToken: token,
      checkLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      statusEmailSentAt: options.setupPending ? null : new Date(),
      preferences: { create: venues.map(({ course, offering }, index) => ({
        courseId: course.id, offeringId: offering.id, rank: index + 1,
      })) },
    } });
    fixtureIds.search.push(search.id);
    const run = await client.automationRun.create({ data: { promptVersion: "simulator-integration-test", kind: "SEARCH_CHECK" } });
    fixtureIds.run.push(run.id);
    const active = await getSearch(search.id);
    if (!active) throw new Error("Simulator test search was not active");
    return { search, active, venues, run, lease: { searchId: search.id, scheduleVersion: search.scheduleVersion,
      token, expiresAt: search.checkLeaseExpiresAt! } };
  }

  function providerSlot(offeringId: string, bookingUrl: string, date: Date) {
    const target = date.toISOString().slice(0, 10);
    return { sourceId: `slot-${offeringId}`, offeringId, resourceId: `bay-${offeringId}`,
      productId: "two-hours", startsAt: new Date(`${target}T14:00:00.000Z`),
      endsAt: new Date(`${target}T16:00:00.000Z`), maxPartySize: 8, bookingUrl };
  }

  it("immediately checks an unknown venue, queues support and sends one truthful status without a booking URL", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    const venue = venues[0];
    await client.courseOffering.update({ where: { id: venue.offering.id }, data: {
      publicAccessStatus: "UNVERIFIED", verifiedAt: null, evidenceUrl: null,
      bookingUrl: null, providerFamilyKey: null, supportedDurationsMinutes: [],
    } });
    const outdoorBefore = await client.course.findUniqueOrThrow({ where: { id: venue.course.id } });
    const active = (await getSearch(search.id))!;
    const result = await runCheck(active, run.id, lease);
    expect(result.courseResults[0].outcome).toBe("NEEDS_ADAPTER");
    expect(mocks.sourceCheck).toHaveBeenCalledOnce();
    expect(mocks.fetch).not.toHaveBeenCalled();
    const incident = await client.simulatorSupportIncident.findUniqueOrThrow({ where: { offeringId: venue.offering.id } });
    expect(incident.retryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await client.courseProbe.findFirstOrThrow({ where: { teeSearchId: search.id } }))
      .toMatchObject({ outcome: "NEEDS_ADAPTER", offeringId: venue.offering.id });
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(mocks.sendMatch).not.toHaveBeenCalled();
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendStatus.mock.calls[0][0].venues[0]).toMatchObject({ availability: "SUPPORT_PENDING" });
    expect(mocks.sendStatus.mock.calls[0][0].venues[0].bookingUrl).toBeUndefined();
    expect(await client.course.findUniqueOrThrow({ where: { id: venue.course.id } })).toEqual(outdoorBefore);

    const repeated = (await getSearch(search.id))!;
    await runCheck(repeated, run.id, lease);
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { offeringId: venue.offering.id } })).toEqual(incident);
    await client.courseOffering.update({ where: { id: venue.offering.id }, data: {
      publicAccessStatus: "PUBLIC", verifiedAt: new Date(), evidenceUrl: venue.offering.evidenceUrl,
      bookingUrl: venue.offering.bookingUrl, providerFamilyKey: "GOLFBOOK", supportedDurationsMinutes: [120],
    } });
    mocks.fetch.mockImplementation(async () => ({ complete: true, observedAt: new Date(), evidenceUrl: venue.offering.evidenceUrl, slots: [] }));
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendStatus).toHaveBeenCalledTimes(2);
    expect(mocks.sendStatus.mock.calls[1][0].venues[0].availability).toBe("NO_MATCH");
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendStatus).toHaveBeenCalledTimes(2);
    // Returning to a previously emailed state is a new transition, not a retry of its old delivery.
    for (let cycle = 0; cycle < 2; cycle++) {
      mocks.fetch.mockRejectedValueOnce(new Error("intercepted provider outage"));
      await runCheck((await getSearch(search.id))!, run.id, lease);
      expect(mocks.sendStatus.mock.calls.at(-1)![0].venues[0].availability).toBe("UNAVAILABLE");
      await runCheck((await getSearch(search.id))!, run.id, lease);
      expect(mocks.sendStatus.mock.calls.at(-1)![0].venues[0].availability).toBe("NO_MATCH");
    }
    expect(mocks.sendStatus).toHaveBeenCalledTimes(6);
  });

  it("reports pending support even when another selected venue immediately has a match", async () => {
    const { search, venues, run, lease } = await fixture(2, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
      publicAccessStatus: "UNVERIFIED", verifiedAt: null, supportedDurationsMinutes: [],
    } });
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(), evidenceUrl: venues[1].offering.evidenceUrl,
      slots: [providerSlot(venues[1].offering.id, venues[1].offering.bookingUrl!, search.date)] });
    const result = await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(result.courseResults.map(item => item.outcome)).toEqual(["NEEDS_ADAPTER", "MATCH_FOUND"]);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.sendMatch).toHaveBeenCalledOnce();
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendStatus.mock.calls[0][0].venues.map((venue: { availability: string }) => venue.availability))
      .toEqual(["SUPPORT_PENDING", "MATCH_FOUND"]);
  });

  it("sends link-free pending status when a preserved outdoor website is unsafe", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.course.update({ where: { id: venues[0].course.id }, data: { website: "http://127.0.0.1/internal" } });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
      publicAccessStatus: "UNVERIFIED", bookingUrl: null, supportedDurationsMinutes: [],
    } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendStatus.mock.calls[0][0].venues[0].bookingUrl).toBeUndefined();
    expect(await client.course.findUniqueOrThrow({ where: { id: venues[0].course.id } })).toMatchObject({ website: "http://127.0.0.1/internal" });
  });

  it("does not mislabel an existing source as missing when later checks defer its landing read", async () => {
    const { search, venues, run, lease } = await fixture(1);
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { publicAccessStatus: "UNVERIFIED" } });
    await client.teeSearch.update({ where: { id: search.id }, data: { lastCheckedAt: new Date() } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sourceCheck).not.toHaveBeenCalled();
    const probe = await client.courseProbe.findFirstOrThrow({ where: { teeSearchId: search.id } });
    expect(probe.rawSummary).toMatchObject({ officialSourceCheck: { outcome: "NOT_CHECKED" } });
  });

  it("reports unsupported session support before future booking-window guidance", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
      supportedDurationsMinutes: [60], bookingWindowDaysAhead: 1, bookingReleaseTimeLocal: "00:00",
    } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendStatus.mock.calls[0][0].venues[0].availability).toBe("SUPPORT_PENDING");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not overwrite a final support disposition written while the official landing is read", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { publicAccessStatus: "UNVERIFIED" } });
    mocks.sourceCheck.mockImplementation(async () => {
      await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
        monitoringState: "FINAL_TECHNICAL", automationEligibility: "BLOCKED",
      } });
      await client.simulatorSupportIncident.create({ data: { offeringId: venues[0].offering.id, status: "RESOLVED", resolvedAt: new Date() } });
      return { outcome: "READ_OK", httpStatus: 200 };
    });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(await client.courseProbe.count({ where: { teeSearchId: search.id, outcome: "NEEDS_ADAPTER" } })).toBe(0);
    expect(await client.simulatorSupportIncident.findUniqueOrThrow({ where: { offeringId: venues[0].offering.id } }))
      .toMatchObject({ status: "RESOLVED" });
    expect(mocks.sendStatus).not.toHaveBeenCalled();
  });

  it("does not persist or notify an unknown check after its alert is paused during the source read", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { publicAccessStatus: "UNVERIFIED" } });
    mocks.sourceCheck.mockImplementation(async () => {
      await client.teeSearch.update({ where: { id: search.id }, data: { status: "PAUSED", scheduleVersion: { increment: 1 } } });
      return { outcome: "READ_OK", httpStatus: 200 };
    });
    await expect(runCheck((await getSearch(search.id))!, run.id, lease)).rejects.toThrow(/current|lease/);
    expect(await client.courseProbe.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(await client.simulatorSupportIncident.count({ where: { offeringId: venues[0].offering.id } })).toBe(0);
    expect(mocks.sendStatus).not.toHaveBeenCalled();
  });

  it("keeps ordinary TEST demand out of the engineering support queue", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { publicAccessStatus: "UNVERIFIED" } });
    await client.teeSearch.update({ where: { id: search.id }, data: { trafficClass: "TEST", syntheticMultiCycle: false } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(await client.simulatorSupportIncident.count({ where: { offeringId: venues[0].offering.id } })).toBe(0);
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendMatch).not.toHaveBeenCalled();
  });

  it("keeps opted-in synthetic support demand away from rendering and transport", async () => {
    const { search, venues, run, lease } = await fixture(1, { setupPending: true });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { publicAccessStatus: "UNVERIFIED" } });
    await client.teeSearch.update({ where: { id: search.id }, data: { trafficClass: "TEST", syntheticMultiCycle: true } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(await client.simulatorSupportIncident.count({ where: { offeringId: venues[0].offering.id } })).toBe(1);
    expect(mocks.sendStatus).not.toHaveBeenCalled();
    expect(mocks.sendMatch).not.toHaveBeenCalled();
  });

  it("persists one whole same-bay session and keeps outdoor monitoring untouched", async () => {
    const { search, active, venues, run, lease } = await fixture(1);
    const venue = venues[0];
    const outdoorBefore = await client.course.findUniqueOrThrow({ where: { id: venue.course.id },
      select: { isPublic: true, automationEligibility: true, detectedBookingUrl: true } });
    mocks.fetch.mockImplementation(async () => ({
      complete: true, observedAt: new Date(), evidenceUrl: venue.offering.evidenceUrl,
      slots: [providerSlot(venue.offering.id, venue.offering.bookingUrl!, search.date)],
    }));
    const result = await runCheck(active, run.id, lease);
    const [match] = await client.teeTimeMatch.findMany({ where: { teeSearchId: search.id } });
    const offering = await client.courseOffering.findUniqueOrThrow({ where: { id: venue.offering.id } });
    expect(result.availableMatches).toBe(1);
    expect(match).toMatchObject({ offeringId: venue.offering.id, resourceId: `bay-${venue.offering.id}`,
      productId: "two-hours", capacity: 8, availableSpots: 1 });
    expect(match.endsAt!.getTime() - match.startsAt.getTime()).toBe(120 * 60_000);
    expect(offering.monitoringState).toBe("HEALTHY");
    expect(offering.monitoringVerifiedAt?.getTime()).toBe(match.lastConfirmedAt.getTime());
    expect(await client.course.findUniqueOrThrow({ where: { id: venue.course.id },
      select: { isPublic: true, automationEligibility: true, detectedBookingUrl: true } })).toEqual(outdoorBefore);
    expect(await client.courseMonitoringStatus.findUnique({ where: { courseId: venue.course.id } })).toBeNull();
    const { listTeeSearchesForUser } = await import("@/lib/searches/service");
    const [dashboard] = await listTeeSearchesForUser(search.userId);
    expect(dashboard.matches.map((current) => current.id)).toContain(match.id);
    expect(dashboard.probes.some((probe) => probe.offeringId === venue.offering.id && probe.outcome === "MATCH_FOUND")).toBe(true);
    // A hybrid venue can be public for outdoor golf while its simulator demand stays private to simulator mode.
    await client.course.update({ where: { id: venue.course.id }, data: { isPublic: true } });
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/courses/known-times/route");
    const targetDate = search.date.toISOString().slice(0, 10);
    const request = new NextRequest(`http://localhost/api/courses/known-times?courseId=${venue.course.id}&date=${targetDate}`);
    expect(await (await GET(request)).json()).toEqual({ courses: { [venue.course.id]: [] } });
    const { recordCourseMonitoringFinalClassification } = await import("@/lib/automation/course-monitoring");
    const finalObservedAt = new Date(Date.now() + 1);
    const final = await recordCourseMonitoringFinalClassification({
      courseId: venue.course.id, state: "FINAL_IDENTITY", outcome: "IDENTITY_FINAL",
      evidence: { kind: "COURSE_INTELLIGENCE", observedAt: finalObservedAt },
      message: "Outdoor course identity changed in isolated integration test.",
      now: finalObservedAt,
      courseIntelligenceUpdate: { isPublic: false, intelligenceVerifiedAt: finalObservedAt,
        intelligenceReviewAt: new Date(finalObservedAt.getTime() + 30 * 24 * 60 * 60_000),
        intelligenceConfidence: 0.9 },
    });
    expect(final?.sourceEvidenceAccepted).toBe(true);
    expect(await client.teeTimeMatch.findUniqueOrThrow({ where: { id: match.id } }))
      .toMatchObject({ availabilityStatus: "AVAILABLE", alertStatus: "SENT", offeringId: venue.offering.id });
    expect(mocks.sendMatch).toHaveBeenCalledTimes(1);
    expect(mocks.sendStatus).not.toHaveBeenCalled();
  });

  it("treats an all-venue instant match email as the first status without a duplicate setup", async () => {
    const { search, active, run, lease } = await fixture(2, { setupPending: true });
    mocks.fetch.mockImplementation(async ({ offering }: { offering: { id: string; bookingUrl: string; evidenceUrl: string } }) => ({
      complete: true, observedAt: new Date(), evidenceUrl: offering.evidenceUrl,
      slots: [providerSlot(offering.id, offering.bookingUrl, search.date)],
    }));
    await runCheck(active, run.id, lease);
    expect(mocks.sendMatch).toHaveBeenCalledOnce();
    expect(mocks.sendStatus).not.toHaveBeenCalled();
    const updated = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(updated.statusEmailSentAt).toBeTruthy();
    expect(updated.statusEmailSnapshot).toMatchObject({ mode: "SIMULATOR", venues: [
      { availability: "MATCH_FOUND" }, { availability: "MATCH_FOUND" },
    ] });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendMatch).toHaveBeenCalledOnce();
    expect(mocks.sendStatus).not.toHaveBeenCalled();
  });

  it("does not satisfy every venue's first status when one provider match fails the source proof", async () => {
    const { search, active, venues, run, lease } = await fixture(2, { setupPending: true });
    mocks.fetch.mockImplementation(async ({ offering }: { offering: { id: string; bookingUrl: string; evidenceUrl: string } }) => ({
      complete: true, observedAt: new Date(), evidenceUrl: offering.evidenceUrl,
      slots: [providerSlot(offering.id, offering.id === venues[1].offering.id
        ? "https://unrelated.example.test/book" : offering.bookingUrl, search.date)],
    }));
    const result = await runCheck(active, run.id, lease);
    expect(result.courseResults.map(venue => venue.outcome)).toEqual(["MATCH_FOUND", "MATCH_FOUND"]);
    expect(mocks.sendMatch).toHaveBeenCalledOnce();
    expect(mocks.sendMatch.mock.calls[0][0].matches).toHaveLength(1);
    expect(mocks.sendStatus).toHaveBeenCalledOnce();
    expect(mocks.sendStatus.mock.calls[0][0].venues.map((venue: { availability: string }) => venue.availability))
      .toEqual(["MATCH_FOUND", "CHECK_PENDING"]);
    const matchDelivery = await client.searchEmailDelivery.findFirstOrThrow({ where: { teeSearchId: search.id, kind: "MATCH" } });
    expect(matchDelivery.payload).not.toHaveProperty("satisfiesStatusReport", true);
  });

  it("sends the owner's mixed pending status even when an extra recipient's match delivery fails", async () => {
    const extra = `extra-${randomUUID()}@example.test`;
    const { search, active, venues, run, lease } = await fixture(2, { setupPending: true, additionalEmails: [extra] });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
      publicAccessStatus: "UNVERIFIED", verifiedAt: null, supportedDurationsMinutes: [],
    } });
    mocks.fetch.mockImplementation(async () => ({ complete: true, observedAt: new Date(), evidenceUrl: venues[1].offering.evidenceUrl,
      slots: [providerSlot(venues[1].offering.id, venues[1].offering.bookingUrl!, search.date)] }));
    let extraAttempts = 0;
    mocks.sendMatch.mockImplementation(async ({ to }: { to: string }) => {
      if (to === extra && extraAttempts++ === 0) throw new Error("intercepted extra match failure");
      return { deliveryStatus: "sent", id: "intercepted-test-send" };
    });
    await expect(runCheck((await getSearch(search.id))!, run.id, lease)).rejects.toThrow("intercepted extra match failure");
    expect(mocks.sendMatch.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
    expect(mocks.sendStatus.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
    const updated = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(updated.statusEmailSnapshot).toMatchObject({ mode: "SIMULATOR", venues: [
      { availability: "SUPPORT_PENDING" }, { availability: "MATCH_FOUND" },
    ] });
    await client.searchEmailDelivery.updateMany({ where: { teeSearchId: search.id, kind: "MATCH", recipient: extra },
      data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runCheck((await getSearch(search.id))!, run.id, lease);
    expect(mocks.sendMatch.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
    expect(mocks.sendMatch.mock.calls.filter(([call]) => call.to === extra)).toHaveLength(2);
    expect(mocks.sendStatus.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
  });

  it("preserves a newer owner status when an older all-match extra recipient retries", async () => {
    const extra = `extra-${randomUUID()}@example.test`;
    const { search, active, venues, run, lease } = await fixture(1, { setupPending: true, additionalEmails: [extra] });
    const venue = venues[0];
    mocks.fetch.mockImplementation(async () => ({ complete: true, observedAt: new Date(), evidenceUrl: venue.offering.evidenceUrl,
      slots: [providerSlot(venue.offering.id, venue.offering.bookingUrl!, search.date)] }));
    let extraAttempts = 0;
    mocks.sendMatch.mockImplementation(async ({ to }: { to: string }) => {
      if (to === extra && extraAttempts++ === 0) throw new Error("intercepted old match failure");
      return { deliveryStatus: "sent", id: "intercepted-test-send" };
    });
    await expect(runCheck(active, run.id, lease)).rejects.toThrow("intercepted old match failure");
    const oldGroup = await client.searchEmailDelivery.findFirstOrThrow({ where: { teeSearchId: search.id, kind: "MATCH", recipient: extra } });
    const oldStatus = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id } });
    const offering = await client.courseOffering.findUniqueOrThrow({ where: { id: venue.offering.id } });
    const { getSimulatorOfferingSourceFingerprint } = await import("@/lib/simulators/source-fingerprint");
    const { prepareSearchEmailDeliveryGroup, drainSearchEmailDeliveryGroup, hydrateSimulatorStatusPayload, hydrateMatchAlertPayload } = await import("@/lib/email/search-delivery-outbox");
    const report = { mode: "SIMULATOR", kind: "daily", targetDate: search.date.toISOString().slice(0, 10),
      startTime: search.startTime, endTime: search.endTime, durationMinutes: search.durationMinutes,
      players: search.players, userTimeZone: search.userTimeZone, venues: [{ offeringId: offering.id,
        courseId: venue.course.id, courseName: venue.course.name, courseRank: 1, bookingUrl: offering.bookingUrl,
        sourceFingerprint: getSimulatorOfferingSourceFingerprint(offering), availability: "MATCH_FOUND" }] };
    const groupKey = `newer-owner-status-${randomUUID()}`;
    await prepareSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token, kind: "MONITORING_STATUS_UPDATE", groupKey,
      ownerRecipient: active.user.email, recipients: [active.user.email, extra], payload: {
        schemaVersion: 3, mode: "SIMULATOR", checkedAt: new Date().toISOString(),
        statusReport: report, statusSnapshot: report,
      } });
    await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token, kind: "MONITORING_STATUS_UPDATE", groupKey,
      send: async ({ recipient, payload, assertCurrentDelivery }) => {
        await assertCurrentDelivery();
        return mocks.sendStatus({ ...hydrateSimulatorStatusPayload(payload), to: recipient });
      } });
    const newer = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(newer.statusEmailSentAt!.getTime()).toBeGreaterThan(oldStatus.statusEmailSentAt!.getTime());
    await client.searchEmailDelivery.update({ where: { id: oldGroup.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token, kind: "MATCH", groupKey: oldGroup.groupKey,
      send: async ({ recipient, payload, assertCurrentDelivery }) => {
        const hydrated = await hydrateMatchAlertPayload({ searchId: search.id, alertGeneration: search.alertGeneration, payload });
        await assertCurrentDelivery();
        return mocks.sendMatch({ ...hydrated, to: recipient });
      } });
    const afterRetry = await client.teeSearch.findUniqueOrThrow({ where: { id: search.id } });
    expect(afterRetry.statusEmailSentAt).toEqual(newer.statusEmailSentAt);
    expect(afterRetry.statusEmailSnapshot).toEqual(newer.statusEmailSnapshot);
    expect(mocks.sendMatch.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
    expect(mocks.sendMatch.mock.calls.filter(([call]) => call.to === extra)).toHaveLength(2);
  });

  it("keeps a second venue's match when the first provider fails", async () => {
    const { search, active, venues, run, lease } = await fixture(2);
    mocks.fetch.mockImplementation(async ({ offering }: { offering: { id: string; bookingUrl: string } }) => {
      if (offering.id === venues[0].offering.id) throw new Error("simulated provider failure");
      return { complete: true, observedAt: new Date(), evidenceUrl: venues[1].offering.evidenceUrl,
        slots: [providerSlot(offering.id, offering.bookingUrl, search.date)] };
    });
    const result = await runCheck(active, run.id, lease);
    const probes = await client.courseProbe.findMany({ where: { teeSearchId: search.id }, orderBy: { courseId: "asc" } });
    const matches = await client.teeTimeMatch.findMany({ where: { teeSearchId: search.id } });
    expect(result.courseResults.map((item) => item.outcome)).toEqual(["FETCH_FAILED", "MATCH_FOUND"]);
    expect(probes.map((probe) => probe.outcome).sort()).toEqual(["FETCH_FAILED", "MATCH_FOUND"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].offeringId).toBe(venues[1].offering.id);
    expect(mocks.sendMatch).toHaveBeenCalledTimes(1);
  });

  it("does not persist partial sessions or drifted booking links as alertable", async () => {
    const { search, active, venues, run, lease } = await fixture(1);
    const correct = providerSlot(venues[0].offering.id, venues[0].offering.bookingUrl!, search.date);
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(),
      evidenceUrl: venues[0].offering.evidenceUrl, slots: [
        { ...correct, sourceId: "partial", endsAt: new Date(correct.endsAt.getTime() - 30 * 60_000) },
      ] });
    const rejected = await runCheck(active, run.id, lease);
    expect(rejected.availableMatches).toBe(0);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(mocks.sendMatch).not.toHaveBeenCalled();

    const refreshed = await getSearch(search.id);
    if (!refreshed) throw new Error("Simulator test search vanished");
    const anotherRun = await client.automationRun.create({ data: { promptVersion: "simulator-integration-test", kind: "SEARCH_CHECK" } });
    fixtureIds.run.push(anotherRun.id);
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(),
      evidenceUrl: venues[0].offering.evidenceUrl, slots: [
        { ...correct, sourceId: "wrong-url", bookingUrl: "https://unrelated.example.test/book" },
      ] });
    await runCheck(refreshed, anotherRun.id, lease);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(1);
    expect(mocks.sendMatch).not.toHaveBeenCalled();
  });

  it.each([2, null])("alerts on one available bay with capacity metadata %s, independent of saved players", async (maxPartySize) => {
    const { search, venues, run, lease } = await fixture(1);
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: { maxPartySize } });
    const current = await getSearch(search.id);
    if (!current) throw new Error("Simulator test search vanished");
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(),
      evidenceUrl: venues[0].offering.evidenceUrl,
      slots: [{ ...providerSlot(venues[0].offering.id, venues[0].offering.bookingUrl!, search.date), maxPartySize }],
    });
    const result = await runCheck(current, run.id, lease);
    expect(result.availableMatches).toBe(1);
    const match = await client.teeTimeMatch.findFirstOrThrow({ where: { teeSearchId: search.id } });
    expect(match.capacity).toBe(maxPartySize);
    expect(match.availableSpots).toBe(1);
    expect(match.alertStatus).toBe("SENT");
    expect(mocks.sendMatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a first search's confirmed session current after another date checks the same offering", async () => {
    const { search, active, venues, run, lease } = await fixture(1);
    const offering = venues[0].offering;
    mocks.fetch.mockResolvedValueOnce({ complete: true, observedAt: new Date(),
      evidenceUrl: offering.evidenceUrl,
      slots: [providerSlot(offering.id, offering.bookingUrl!, search.date)] });
    await runCheck(active, run.id, lease);
    const first = await client.teeTimeMatch.findFirstOrThrow({ where: { teeSearchId: search.id } });

    const nextDate = new Date(search.date);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    const nextToken = randomUUID();
    const second = await client.teeSearch.create({ data: {
      userId: search.userId, mode: "SIMULATOR", durationMinutes: 120, date: nextDate,
      startTime: "13:00", endTime: "19:00", userTimeZone: "UTC", players: 4,
      status: "ACTIVE", checkStatus: "CHECKING", checkLeaseToken: nextToken,
      checkLeaseExpiresAt: new Date(Date.now() + 5 * 60_000), statusEmailSentAt: new Date(),
      preferences: { create: [{ courseId: offering.courseId, offeringId: offering.id, rank: 1 }] },
    } });
    fixtureIds.search.push(second.id);
    const secondRun = await client.automationRun.create({ data: { promptVersion: "simulator-integration-test", kind: "SEARCH_CHECK" } });
    fixtureIds.run.push(secondRun.id);
    const secondActive = await getSearch(second.id);
    if (!secondActive) throw new Error("Second simulator test search was not active");
    mocks.fetch.mockResolvedValueOnce({ complete: true, observedAt: new Date(),
      evidenceUrl: offering.evidenceUrl, slots: [] });
    await runCheck(secondActive, secondRun.id, { searchId: second.id,
      scheduleVersion: second.scheduleVersion, token: nextToken, expiresAt: second.checkLeaseExpiresAt! });
    const retained = await client.teeTimeMatch.findUniqueOrThrow({ where: { id: first.id }, include: { offering: true } });
    const { isCurrentSimulatorMatch } = await import("@/lib/simulators/current-availability");
    expect(retained.availabilityStatus).toBe("AVAILABLE");
    expect(retained.offering!.monitoringVerifiedAt!.getTime()).toBeGreaterThanOrEqual(first.lastConfirmedAt.getTime());
    expect(isCurrentSimulatorMatch(retained, new Date())).toBe(true);
  });

  it("creates a pending setup and retries only the failed additional recipient", async () => {
    const extra = `extra-${randomUUID()}@example.test`;
    const { search, active, venues, run, lease } = await fixture(1, { setupPending: true, additionalEmails: [extra] });
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(),
      evidenceUrl: venues[0].offering.evidenceUrl, slots: [] });
    let extraAttempts = 0;
    mocks.sendStatus.mockImplementation(async ({ to }: { to: string }) => {
      if (to === extra && extraAttempts++ === 0) throw new Error("intercepted first attempt failure");
      return { deliveryStatus: "sent", id: "intercepted-test-send" };
    });
    await expect(runCheck(active, run.id, lease)).rejects.toThrow();
    const firstRows = await client.searchEmailDelivery.findMany({ where: { teeSearchId: search.id, kind: "SETUP" } });
    expect(firstRows).toHaveLength(2);
    expect(firstRows.find((row) => row.isOwnerRecipient)?.status).toBe("SENT");
    expect(firstRows.find((row) => row.recipient === extra)?.status).toBe("FAILED");
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(0);
    await client.searchEmailDelivery.updateMany({ where: { teeSearchId: search.id, recipient: extra },
      data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const nextRun = await client.automationRun.create({ data: { promptVersion: "simulator-integration-test", kind: "SEARCH_CHECK" } });
    fixtureIds.run.push(nextRun.id);
    const refreshed = await getSearch(search.id);
    if (!refreshed) throw new Error("Simulator test search vanished");
    await runCheck(refreshed, nextRun.id, lease);
    const settled = await client.searchEmailDelivery.findMany({ where: { teeSearchId: search.id, kind: "SETUP" } });
    expect(settled.map((row) => row.status).sort()).toEqual(["SENT", "SENT"]);
    expect(mocks.sendStatus.mock.calls.filter(([call]) => call.to === active.user.email)).toHaveLength(1);
    expect(mocks.sendStatus.mock.calls.filter(([call]) => call.to === extra)).toHaveLength(2);
  });

  it("does not retry an old no-match setup after the offering source changes", async () => {
    const extra = `extra-${randomUUID()}@example.test`;
    const { search, active, venues, run, lease } = await fixture(1, { setupPending: true, additionalEmails: [extra] });
    mocks.fetch.mockResolvedValue({ complete: true, observedAt: new Date(),
      evidenceUrl: venues[0].offering.evidenceUrl, slots: [] });
    mocks.sendStatus.mockImplementation(async ({ to }: { to: string }) => {
      if (to === extra) throw new Error("intercepted recipient failure");
      return { deliveryStatus: "sent", id: "intercepted-test-send" };
    });
    await expect(runCheck(active, run.id, lease)).rejects.toThrow();
    const oldGroup = await client.searchEmailDelivery.findFirstOrThrow({ where: {
      teeSearchId: search.id, kind: "SETUP", recipient: extra,
    } });
    await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
      providerMetadata: { sourceRevision: "new-source" }, monitoringVerifiedAt: new Date(), monitoringState: "HEALTHY",
    } });
    await client.searchEmailDelivery.update({ where: { id: oldGroup.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    const { drainSearchEmailDeliveryGroup } = await import("@/lib/email/search-delivery-outbox");
    const send = vi.fn().mockResolvedValue({ deliveryStatus: "sent" as const });
    await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token, kind: "SETUP", groupKey: oldGroup.groupKey, send });
    expect(send).not.toHaveBeenCalled();
    const retired = await client.searchEmailDelivery.findUniqueOrThrow({ where: { id: oldGroup.id } });
    expect(retired.status).toBe("SUPPRESSED");
  });

  it("rejects a paused search after provider read without writing a stale match or sending", async () => {
    const { search, active, venues, run, lease } = await fixture(1);
    mocks.fetch.mockImplementation(async () => {
      await client.teeSearch.update({ where: { id: search.id }, data: { status: "PAUSED", scheduleVersion: { increment: 1 } } });
      return { complete: true, observedAt: new Date(), evidenceUrl: venues[0].offering.evidenceUrl,
        slots: [providerSlot(venues[0].offering.id, venues[0].offering.bookingUrl!, search.date)] };
    });
    await expect(runCheck(active, run.id, lease)).rejects.toThrow(/lease|current/i);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(mocks.sendMatch).not.toHaveBeenCalled();
    expect(mocks.sendStatus).not.toHaveBeenCalled();
  });

  it("marks a superseded offering pending without writing stale evidence", async () => {
    const { search, active, venues, run, lease } = await fixture(1);
    mocks.fetch.mockImplementation(async () => {
      await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
        observationToken: "newer-observation", observationExpiresAt: new Date(Date.now() + 60_000),
      } });
      return { complete: true, observedAt: new Date(), evidenceUrl: venues[0].offering.evidenceUrl,
        slots: [providerSlot(venues[0].offering.id, venues[0].offering.bookingUrl!, search.date)] };
    });
    const result = await runCheck(active, run.id, lease);
    expect(result.courseResults.map((item) => item.outcome)).toEqual(["CHECK_PENDING"]);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(await client.courseProbe.count({ where: { teeSearchId: search.id } })).toBe(0);
    expect(mocks.sendMatch).not.toHaveBeenCalled();
  });

  it("continues to a second venue after the first observation is superseded", async () => {
    const { search, active, venues, run, lease } = await fixture(2);
    mocks.fetch.mockImplementation(async ({ offering }: { offering: { id: string; bookingUrl: string } }) => {
      if (offering.id === venues[0].offering.id) {
        await client.courseOffering.update({ where: { id: offering.id }, data: {
          observationToken: "newer-observation", observationExpiresAt: new Date(Date.now() + 60_000),
        } });
      }
      return { complete: true, observedAt: new Date(), evidenceUrl: venues.find((venue) => venue.offering.id === offering.id)!.offering.evidenceUrl,
        slots: [providerSlot(offering.id, offering.bookingUrl, search.date)] };
    });
    const result = await runCheck(active, run.id, lease);
    expect(result.courseResults.map((item) => item.outcome)).toEqual(["CHECK_PENDING", "MATCH_FOUND"]);
    const matches = await client.teeTimeMatch.findMany({ where: { teeSearchId: search.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0].offeringId).toBe(venues[1].offering.id);
    expect(mocks.sendMatch).toHaveBeenCalledTimes(1);
  });

  it.each(["GONE", "BUSY"] as const)("keeps a healthy venue alertable when another offering is %s", async (sourceState) => {
    const { search, active, venues, run, lease } = await fixture(2);
    mocks.fetch.mockImplementation(async ({ offering }: { offering: { id: string; bookingUrl: string } }) => ({
      complete: true, observedAt: new Date(),
      evidenceUrl: venues.find((venue) => venue.offering.id === offering.id)!.offering.evidenceUrl,
      slots: [providerSlot(offering.id, offering.bookingUrl, search.date)],
    }));
    mocks.sendMatch.mockRejectedValueOnce(new Error("intercepted provider failure"));
    await expect(runCheck(active, run.id, lease)).rejects.toThrow();
    const matches = await client.teeTimeMatch.findMany({ where: { teeSearchId: search.id } });
    expect(matches).toHaveLength(2);
    const originalRows = await client.searchEmailDelivery.findMany({ where: { teeSearchId: search.id, kind: "MATCH" } });
    expect(originalRows.some((row) => row.status === "FAILED"), JSON.stringify(originalRows.map((row) => ({
      groupKey: row.groupKey, status: row.status, lastError: row.lastError,
    })))).toBe(true);
    const first = matches.find((match) => match.offeringId === venues[0].offering.id)!;
    const second = matches.find((match) => match.offeringId === venues[1].offering.id)!;
    if (sourceState === "GONE") {
      await client.teeTimeMatch.update({ where: { id: first.id }, data: { availabilityStatus: "GONE" } });
    } else {
      await client.courseOffering.update({ where: { id: venues[0].offering.id }, data: {
        observationToken: "pending-source", observationExpiresAt: new Date(Date.now() + 60_000),
      } });
    }
    // Reset the intercepted transport attempt to model an outbox row prepared before its first send.
    // The fixture still exercises the real preparation and persistence path.
    await client.searchEmailDelivery.updateMany({ where: { teeSearchId: search.id, kind: "MATCH" },
      data: { status: "PENDING", attemptCount: 0, lastError: null, nextAttemptAt: new Date(Date.now() - 1000) } });
    const rows = await client.searchEmailDelivery.findMany({ where: { teeSearchId: search.id, kind: "MATCH" } });
    expect(rows).toHaveLength(1);
    const { drainSearchEmailDeliveryGroup } = await import("@/lib/email/search-delivery-outbox");
    await drainSearchEmailDeliveryGroup({ searchId: search.id, alertGeneration: search.alertGeneration,
      checkLeaseToken: lease.token, kind: "MATCH", groupKey: rows[0].groupKey,
      send: async ({ payload, assertCurrentDelivery }) => {
        await assertCurrentDelivery();
        expect(payload.matchIds).toEqual([second.id]);
        return { deliveryStatus: "sent" as const };
      },
    });
    const healthy = await client.teeTimeMatch.findUniqueOrThrow({ where: { id: second.id } });
    expect(healthy.availabilityStatus).toBe("AVAILABLE");
    const deliveries = await client.searchEmailDelivery.findMany({ where: { teeSearchId: search.id, kind: "MATCH" } });
    expect(deliveries.some((delivery) => delivery.status === "SENT" &&
      JSON.stringify(delivery.payload).includes(second.id)), JSON.stringify(deliveries.map((row) => ({
        groupKey: row.groupKey, status: row.status, payload: row.payload,
      })))).toBe(true);
  });
});
