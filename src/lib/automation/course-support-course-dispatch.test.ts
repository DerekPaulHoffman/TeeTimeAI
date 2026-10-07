import { describe, expect, it } from "vitest";

import { collectCurrentCourseDispatchSourceUsage, selectCourseDispatchTargets } from "./course-support-course-dispatch";
import { createCourseDispatchIntentDigest } from "./course-support-dispatch-intent";
import { createSimulatorSupportIntentDigest, type SimulatorSupportSource } from "./simulator-support-policy";

const source = (id: string) => [{ id, scheduleVersion: 1, alertGeneration: 1, trafficClass: "PUBLIC" }];

describe("course support course dispatch selection", () => {
  it("admits fifteen distinct courses from three active alerts and excludes a fourth cohort", () => {
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      courseId: `course-${String(index).padStart(2, "0")}`,
      activeRealSearchCount: 1,
    }));
    const sourceSearchesByCourse = new Map(candidates.map((candidate, index) => [
      candidate.courseId,
      source(`alert-${Math.floor(index / 5)}`),
    ]));
    const result = selectCourseDispatchTargets({
      candidates,
      sourceSearchesByCourse,
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 15,
    });
    expect(result.selected).toHaveLength(15);
    expect(result.eligibleCount).toBe(15);
    expect(result.admittedSearchCount).toBe(3);
    expect(result.selected.map((entry) => entry.candidate.courseId)).not.toContain("course-15");
  });

  it("limits starts even when more courses from the same three alerts are eligible", () => {
    const candidates = Array.from({ length: 15 }, (_, index) => ({
      courseId: `course-${String(index).padStart(2, "0")}`,
      activeRealSearchCount: 1,
    }));
    const result = selectCourseDispatchTargets({
      candidates,
      sourceSearchesByCourse: new Map(candidates.map((candidate, index) => [
        candidate.courseId, source(`alert-${Math.floor(index / 5)}`),
      ])),
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 14,
    });
    expect(result.eligibleCount).toBe(15);
    expect(result.selected).toHaveLength(14);
  });

  it("deduplicates shared courses and respects already admitted alert cohorts", () => {
    const result = selectCourseDispatchTargets({
      candidates: [
        { courseId: "shared", activeRealSearchCount: 2 },
        { courseId: "shared", activeRealSearchCount: 2 },
        { courseId: "new", activeRealSearchCount: 1 },
        { courseId: "occupied", activeRealSearchCount: 1 },
      ],
      sourceSearchesByCourse: new Map([
        ["shared", source("alert-b")],
        ["new", source("alert-c")],
        ["occupied", source("alert-a")],
      ]),
      occupiedCourses: new Set(["occupied"]),
      priorSearchIds: new Set(["alert-a", "alert-b"]),
      maxStarts: 15,
    });
    expect(result.selected.map((entry) => entry.candidate.courseId).sort()).toEqual(["new", "shared"]);
    expect(result.admittedSearchCount).toBe(3);
  });

  it("does not dispatch an old engineering incident without an active source alert", () => {
    const result = selectCourseDispatchTargets({
      candidates: [{ courseId: "ended-alert-course", activeRealSearchCount: 0 }],
      sourceSearchesByCourse: new Map(),
      occupiedCourses: new Set(),
      priorSearchIds: new Set(),
      maxStarts: 15,
    });
    expect(result.selected).toEqual([]);
  });
});

const now = new Date("2026-10-07T18:00:00.000Z");
function currentSearch(id = "search", mode: "OUTDOOR" | "SIMULATOR" = "OUTDOOR"): SimulatorSupportSource {
  return {
    id, mode, userId: "owner", user: { id: "owner", clerkUserId: "clerk", email: "owner@example.test", pendingEmail: null },
    alertEmail: "owner@example.test", additionalEmails: [], date: new Date("2026-10-08T00:00:00.000Z"),
    startTime: "09:00", endTime: "18:00", userTimeZone: "America/New_York", players: 4,
    requestedLayoutHoles: null, cadenceMinutes: 15, trafficClass: "PUBLIC", syntheticMultiCycle: false,
    syntheticTestWindow: null, createdAt: now, status: "ACTIVE", scheduleVersion: 2, alertGeneration: 1,
    durationMinutes: mode === "SIMULATOR" ? 60 : null, checkStatus: "WAITING", checkLeaseExpiresAt: null,
    remediationDispatchKey: null, remediationDispatchVersion: null,
    preferences: Array.from({ length: 5 }, (_, rank) => ({ courseId: `course-${rank}`, offeringId: mode === "SIMULATOR" ? `offering-${rank}` : null, rank: rank + 1 })),
  };
}
function priorSource(search: SimulatorSupportSource, courseId = "course-0") {
  return {
    courseId, ...(search.mode === "SIMULATOR" ? { mode: "SIMULATOR" as const, offeringId: "offering-0" } : {}),
    trafficClass: (search.trafficClass === "TEST" ? "SYNTHETIC" : "REAL") as "SYNTHETIC" | "REAL",
    ref: { id: search.id, scheduleVersion: search.scheduleVersion, alertGeneration: search.alertGeneration,
      intentDigest: search.mode === "SIMULATOR" ? createSimulatorSupportIntentDigest(search) : createCourseDispatchIntentDigest(search) },
  };
}
function usage(search: SimulatorSupportSource, prior = priorSource(search), timeZone = "America/New_York") {
  return collectCurrentCourseDispatchSourceUsage({ priorSources: [prior], searches: new Map([[search.id, search]]),
    courseTimeZones: new Map([[prior.courseId, timeZone]]), now });
}

describe("current alert cohorts remain separate from physical worker ownership", () => {
  it.each(["COMPLETED", "CANCELLED", "PAUSED"] as const)("does not admit a %s source", status => {
    const search = currentSearch();
    const prior = priorSource(search);
    search.status = status;
    expect(usage(search, prior).priorSearchIds.size).toBe(0);
  });

  it.each(["OUTDOOR", "SIMULATOR"] as const)("excludes expired %s synthetic demand even when the requested date remains future", mode => {
    const search = currentSearch("expired", mode);
    search.trafficClass = "TEST"; search.syntheticMultiCycle = true;
    search.createdAt = new Date(now.getTime() - 18 * 60 * 60_000);
    expect(usage(search).priorSearchIds.size).toBe(0);
  });

  it("evaluates the original course-local end instead of server midnight", () => {
    const search = currentSearch();
    search.date = new Date("2026-10-07T00:00:00.000Z"); search.endTime = "13:00";
    const prior = priorSource(search);
    expect(usage(search, prior, "America/New_York").priorSearchIds.size).toBe(0);
    expect(usage(search, prior, "America/Los_Angeles").priorSearchIds.has(search.id)).toBe(true);
  });

  it("counts a current simulator only for its selected course and offering", () => {
    const search = currentSearch("sim", "SIMULATOR"); const prior = priorSource(search);
    expect(usage(search, prior).priorSearchIds.has(search.id)).toBe(true);
    expect(usage(search, { ...prior, courseId: "course-1" }).priorSearchIds.size).toBe(0);
    expect(usage(search, { ...prior, offeringId: "removed-offering" }).priorSearchIds.size).toBe(0);
  });

  it("rejects changed intent and removed courses while accepting a schedule-only recovery", () => {
    const search = currentSearch(); const prior = priorSource(search);
    search.scheduleVersion += 2;
    expect(usage(search, prior).priorSearchIds.has(search.id)).toBe(true);
    search.players = 2;
    expect(usage(search, prior).priorSearchIds.size).toBe(0);
    search.players = 4;
    search.preferences = search.preferences.filter(preference => preference.courseId !== prior.courseId);
    expect(usage(search, { ...prior, ref: { ...prior.ref, intentDigest: undefined, scheduleVersion: search.scheduleVersion } }).priorSearchIds.size).toBe(0);
  });

  it("admits three fresh cohorts while ended sources still occupy their course slots", () => {
    const old = [currentSearch("ended-a"), currentSearch("ended-b"), currentSearch("ended-c")];
    const priorSources = old.map(search => priorSource(search));
    old.forEach(search => { search.status = "COMPLETED"; });
    const priorUsage = collectCurrentCourseDispatchSourceUsage({ priorSources,
      searches: new Map(old.map(search => [search.id, search])), courseTimeZones: new Map([["course-0", "America/New_York"]]), now });
    const result = selectCourseDispatchTargets({ candidates: ["course-0", "fresh-a", "fresh-b", "fresh-c", "fresh-d"].map(courseId => ({ courseId, activeRealSearchCount: 1 })),
      sourceSearchesByCourse: new Map(["course-0", "fresh-a", "fresh-b", "fresh-c", "fresh-d"].map(courseId => [courseId, source(courseId)])),
      occupiedCourses: new Set(["course-0"]), ...priorUsage, maxStarts: 15 });
    expect(result.selected.map(entry => entry.candidate.courseId)).toEqual(["fresh-a", "fresh-b", "fresh-c"]);
    expect(result.admittedSearchCount).toBe(3);
  });

  it("counts distinct courses once across live runs, this tick, and batch summaries", () => {
    const search = currentSearch();
    const priors = search.preferences.map(preference => priorSource(search, preference.courseId));
    const priorUsage = collectCurrentCourseDispatchSourceUsage({ priorSources: [...priors, ...priors, ...priors],
      searches: new Map([[search.id, search]]), courseTimeZones: new Map(search.preferences.map(preference => [preference.courseId, "America/New_York"])), now });
    expect(priorUsage.priorSearchCounts.get(search.id)).toBe(5);
    const result = selectCourseDispatchTargets({ candidates: [{ courseId: "sixth", activeRealSearchCount: 1 }],
      sourceSearchesByCourse: new Map([["sixth", source(search.id)]]), occupiedCourses: new Set(), ...priorUsage, maxStarts: 15 });
    expect(result.selected).toEqual([]);
  });
});
