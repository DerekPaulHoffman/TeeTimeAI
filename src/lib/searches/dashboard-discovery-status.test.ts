import { describe, expect, it, vi } from "vitest";
import { getDiscoverySourceFingerprint } from "@/lib/course-discovery/service";
import { getDashboardDiscoveryStatus } from "./dashboard-discovery-status";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const completedAt = new Date("2026-10-22T00:37:34.801Z");
const now = new Date("2026-10-22T00:40:00Z");
function fixture() {
  const course = {
    id: "course-1", name: "Public Golf Club", address: "1 Fairway Rd, Example, NC",
    website: "https://golf.example/", detectedBookingUrl: "https://booking.example/",
    timeZone: "America/New_York", providerFamilyKey: null, bookingMetadata: {},
    isPublic: true, activeAccessRecipeId: null, bookingMethod: "UNKNOWN",
    bookingAccessMode: "UNKNOWN", automationEligibility: "UNKNOWN", automationReason: "NONE",
  } as Parameters<typeof getDiscoverySourceFingerprint>[0];
  const search = { id: "search-1", status: "ACTIVE", mode: "OUTDOOR", alertGeneration: 0,
    date: new Date("2026-10-23T00:00:00Z"), startTime: "08:00", endTime: "18:00", players: 2, durationMinutes: null };
  const job = {
    targetKey: "course:course-1", courseId: course.id, offeringId: null,
    sourceFingerprint: getDiscoverySourceFingerprint(course), baseRecipeId: null, status: "FAILED" as const,
    createdAt: new Date("2026-10-22T00:35:42.192Z"), completedAt,
    request: { target: { courseId: course.id, kind: "OUTDOOR" },
      demand: { searchId: search.id, alertGeneration: search.alertGeneration },
      identity: { name: course.name, address: course.address, officialUrl: course.website,
        bookingUrl: course.detectedBookingUrl, timeZone: course.timeZone, providerFamily: course.providerFamilyKey },
      input: { date: "2026-10-23", timeZone: course.timeZone, players: 2, startTime: "08:00", endTime: "18:00" } },
  };
  return { course, search, job };
}

describe("current request's terminal discovery presentation", () => {
  it.each(["FAILED", "TIMED_OUT"] as const)("projects %s without exposing request/config/diagnostic data", status => {
    const { course, search, job } = fixture();
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job, status }, undefined, now))
      .toEqual({ state: "TERMINAL_FAILURE", completedAt });
  });

  it.each(["QUEUED", "RUNNING", "SUCCEEDED", "CANCELLED"] as const)("does not call a latest %s job terminal failure", status => {
    const { course, search, job } = fixture();
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job, status }, undefined, now)).toBeNull();
  });

  it.each(["PAUSED", "COMPLETED", "CANCELLED"])("does not override %s lifecycle", status => {
    const { course, search, job } = fixture();
    expect(getDashboardDiscoveryStatus({ ...search, status }, { course, offering: null }, job, undefined, now)).toBeNull();
  });

  it.each([
    { searchId: "other-search", alertGeneration: 0 },
    { searchId: "search-1", alertGeneration: 1 },
  ])("rejects another search or generation %j", demand => {
    const { course, search, job } = fixture();
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job, request: { ...job.request, demand } }, undefined, now)).toBeNull();
  });

  it("requires exact typed target and all saved input fields", () => {
    const { course, search, job } = fixture();
    for (const target of [{ courseId: "foreign", kind: "OUTDOOR" }, { courseId: course.id, kind: "SIMULATOR" },
      { courseId: course.id, kind: "OUTDOOR", offeringId: "foreign" }]) {
      expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job, request: { ...job.request, target } }, undefined, now)).toBeNull();
    }
    for (const change of [{ date: "2026-10-24" }, { players: 1 }, { timeZone: "UTC" }, { startTime: "09:00" },
      { endTime: "17:00" }, { durationMinutes: 60 }]) {
      expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job,
        request: { ...job.request, input: { ...job.request.input, ...change } } }, undefined, now)).toBeNull();
    }
  });

  it("ignores changed source metadata, address identity, or a replacement active recipe", () => {
    const { course, search, job } = fixture();
    for (const changed of [{ ...course, bookingMetadata: { changed: true } }, { ...course, address: "2 Other Rd" },
      { ...course, activeAccessRecipeId: "new-recipe" }]) {
      expect(getDashboardDiscoveryStatus(search, { course: changed, offering: null }, job, undefined, now)).toBeNull();
    }
  });

  it("binds simulator target, party/duration, and current offering configuration separately from its course", () => {
    const { course, search, job } = fixture();
    const offering = { id: "offering-1", courseId: course.id, kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", bookingUrl: "https://booking.example/rentals", providerFamilyKey: "USCHEDULE",
      providerMetadata: {}, maxPartySize: null, supportedDurationsMinutes: [], activeAccessRecipeId: null,
      automationEligibility: "UNKNOWN" } as NonNullable<Parameters<typeof getDiscoverySourceFingerprint>[1]>;
    const simulator = { ...search, mode: "SIMULATOR", durationMinutes: 60 };
    const simulatorJob = { ...job, targetKey: `offering:${offering.id}`, offeringId: offering.id,
      sourceFingerprint: getDiscoverySourceFingerprint(course, offering),
      request: { ...job.request, target: { courseId: course.id, offeringId: offering.id, kind: "SIMULATOR" },
        input: { ...job.request.input, durationMinutes: 60 },
        identity: { ...job.request.identity, bookingUrl: offering.bookingUrl, providerFamily: offering.providerFamilyKey } } };
    expect(getDashboardDiscoveryStatus(simulator, { course, offering }, simulatorJob, undefined, now)?.state).toBe("TERMINAL_FAILURE");
    expect(getDashboardDiscoveryStatus({ ...simulator, durationMinutes: 120 }, { course, offering }, simulatorJob, undefined, now)).toBeNull();
    expect(getDashboardDiscoveryStatus(simulator, { course, offering: { ...offering, id: "offering-2" } }, simulatorJob, undefined, now)).toBeNull();
    expect(getDashboardDiscoveryStatus(simulator, { course, offering: { ...offering, providerMetadata: { changed: true } } }, simulatorJob, undefined, now)).toBeNull();
  });

  it.each(["MATCH_FOUND", "NO_MATCH"])("yields to a later generation-fenced %s check, not an older one", outcome => {
    const { course, search, job } = fixture();
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, job,
      { outcome, observedAt: new Date(completedAt.getTime() + 1) }, now)).toBeNull();
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, job,
      { outcome, observedAt: new Date(completedAt.getTime() - 1) }, now)?.state).toBe("TERMINAL_FAILURE");
  });

  it("rejects missing and malformed/future terminal timestamps", () => {
    const { course, search, job } = fixture();
    for (const timestamp of [null, new Date("invalid"), new Date(now.getTime() + 1), new Date(job.createdAt.getTime() - 1)]) {
      expect(getDashboardDiscoveryStatus(search, { course, offering: null }, { ...job, completedAt: timestamp }, undefined, now)).toBeNull();
    }
    expect(getDashboardDiscoveryStatus(search, { course, offering: null }, null, undefined, now)).toBeNull();
  });
});
