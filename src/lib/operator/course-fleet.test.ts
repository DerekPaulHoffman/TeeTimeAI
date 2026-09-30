import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  courseFindMany: vi.fn(),
  courseProbeFindMany: vi.fn(),
  coursePreferenceGroupBy: vi.fn(),
}));
const providerCoverageMocks = vi.hoisted(() => ({
  classifyProviderCoverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: { findMany: prismaMocks.courseFindMany },
    courseProbe: { findMany: prismaMocks.courseProbeFindMany },
    coursePreference: { groupBy: prismaMocks.coursePreferenceGroupBy },
  },
}));
vi.mock("@/lib/automation/provider-coverage", () => providerCoverageMocks);

import {
  loadOperatorCourseFleet,
  loadOperatorCourseFleetCounts,
  type OperatorCourseFleetCountsReadDatabase,
} from "./course-fleet";

const realProviderCoverage = await vi.importActual<
  typeof import("@/lib/automation/provider-coverage")
>("@/lib/automation/provider-coverage");

const NOW = new Date("2026-08-22T14:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.courseFindMany.mockResolvedValue([courseRow()]);
  prismaMocks.courseProbeFindMany.mockResolvedValue([]);
  prismaMocks.coursePreferenceGroupBy.mockResolvedValue([]);
  providerCoverageMocks.classifyProviderCoverage.mockReturnValue(
    "SUPPORTED_READY",
  );
});

describe("operator course fleet loader", () => {
  it("reuses the complete inventory classifier and returns the existing aggregate counts", async () => {
    prismaMocks.coursePreferenceGroupBy
      .mockResolvedValueOnce([
        { courseId: "course-sensitive", _count: { _all: 7 } },
      ])
      .mockResolvedValueOnce([
        { courseId: "course-sensitive", _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { courseId: "course-sensitive", _count: { _all: 1 } },
      ]);

    const result = await loadOperatorCourseFleet({ now: NOW });

    expect(result.courses).toHaveLength(1);
    expect(result.courses[0]).toMatchObject({
      id: "course-sensitive",
      activeAlertCount: 2,
      activeSyntheticAlertCount: 1,
      selectionCount: 7,
      priorityGroup: "ACTION",
      automationQueueState: "ENGINEERING_NEEDED",
    });
    expect(result.counts).toEqual({
      action: 1,
      watch: 0,
      parked: 0,
      limitations: 0,
      unchecked: 0,
      working: 0,
      dueNow: 0,
      inProgress: 0,
      recoveryRequired: 0,
      scheduledRetry: 0,
      engineeringNeeded: 1,
      needsHuman: 0,
    });
    expect(prismaMocks.courseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          localReaderJobs: expect.objectContaining({
            where: {
              status: "COMPLETED",
              completedAt: { gte: new Date("2026-07-23T14:00:00.000Z") },
            },
          }),
        }),
      }),
    );
    expect(prismaMocks.coursePreferenceGroupBy).toHaveBeenCalledTimes(3);
  });

  it("exposes only privacy-safe aggregate numbers from the counts loader", async () => {
    const counts = await loadOperatorCourseFleetCounts({ now: NOW });

    expect(counts).toEqual({
      action: 1,
      watch: 0,
      parked: 0,
      limitations: 0,
      unchecked: 0,
      working: 0,
      dueNow: 0,
      inProgress: 0,
      recoveryRequired: 0,
      scheduledRetry: 0,
      engineeringNeeded: 1,
      needsHuman: 0,
    });
    expect(
      Object.values(counts).every((value) => typeof value === "number"),
    ).toBe(true);
    expect(JSON.stringify(counts)).not.toContain("course-sensitive");
    expect(JSON.stringify(counts)).not.toContain("Sensitive Course Name");
    const countQuery = prismaMocks.courseFindMany.mock.calls[0]?.[0];
    expect(countQuery.select).not.toHaveProperty("name");
    expect(countQuery.select).not.toHaveProperty("address");
    expect(countQuery.select).not.toHaveProperty("profile");
    expect(countQuery.select.courseProbe).toBeUndefined();
    expect(prismaMocks.coursePreferenceGroupBy).toHaveBeenCalledTimes(2);
  });

  it("keeps all counts reads on the supplied client with the same native aggregate output", async () => {
    const expected = await loadOperatorCourseFleetCounts({ now: NOW });
    const expectedCourseQuery = prismaMocks.courseFindMany.mock.calls[0]![0];
    const expectedProbeQuery = prismaMocks.courseProbeFindMany.mock.calls[0]![0];
    const expectedGroupQueries = prismaMocks.coursePreferenceGroupBy.mock.calls.map(
      ([query]) => query,
    );
    vi.clearAllMocks();
    const mutation = vi.fn(() => {
      throw new Error("Counts must remain read-only.");
    });
    const courseFindMany = vi.fn().mockResolvedValue([courseRow()]);
    const courseProbeFindMany = vi.fn().mockResolvedValue([]);
    const coursePreferenceGroupBy = vi.fn().mockResolvedValue([]);
    const database = {
      course: { findMany: courseFindMany, update: mutation },
      courseProbe: { findMany: courseProbeFindMany, create: mutation },
      coursePreference: { groupBy: coursePreferenceGroupBy, deleteMany: mutation },
      $transaction: mutation,
      $executeRawUnsafe: mutation,
    } as unknown as OperatorCourseFleetCountsReadDatabase;

    const actual = await loadOperatorCourseFleetCounts({ now: NOW }, database);

    expect(actual).toEqual(expected);
    expect(courseFindMany).toHaveBeenCalledExactlyOnceWith(expectedCourseQuery);
    expect(courseProbeFindMany).toHaveBeenCalledExactlyOnceWith(expectedProbeQuery);
    expect(coursePreferenceGroupBy.mock.calls.map(([query]) => query)).toEqual(
      expectedGroupQueries,
    );
    expect(prismaMocks.courseFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("retains the empty-course probe shortcut and both demand reads on the supplied client", async () => {
    const courseFindMany = vi.fn().mockResolvedValue([]);
    const courseProbeFindMany = vi.fn();
    const coursePreferenceGroupBy = vi.fn().mockResolvedValue([]);
    const database = {
      course: { findMany: courseFindMany },
      courseProbe: { findMany: courseProbeFindMany },
      coursePreference: { groupBy: coursePreferenceGroupBy },
    } as unknown as OperatorCourseFleetCountsReadDatabase;

    const result = await loadOperatorCourseFleetCounts({ now: NOW }, database);

    expect(Object.values(result).every((count) => count === 0)).toBe(true);
    expect(courseFindMany).toHaveBeenCalledTimes(1);
    expect(courseProbeFindMany).not.toHaveBeenCalled();
    expect(coursePreferenceGroupBy).toHaveBeenCalledTimes(2);
    expect(prismaMocks.courseFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
  });

  it.each(["account", "captcha", "unsupported", "candidate", "stale", "FAILED", "null"] as const)(
    "retains all 12 real-classifier counts across %s discovery display evidence",
    async (kind) => {
      providerCoverageMocks.classifyProviderCoverage.mockImplementation(
        realProviderCoverage.classifyProviderCoverage,
      );
      const rows = fleetParityRows(discoveryRow(kind));
      installSelectedFleetReads(rows);

      const full = await loadOperatorCourseFleet({ now: NOW });
      const counts = await loadOperatorCourseFleetCounts({ now: NOW });

      expect(full.counts).toEqual({
        action: 4, watch: 2, parked: 1, limitations: 1, unchecked: 1, working: 1,
        dueNow: 1, inProgress: 1, recoveryRequired: 1, scheduledRetry: 1,
        engineeringNeeded: 1, needsHuman: 1,
      });
      expect(counts).toEqual(full.counts);
      expect(Object.values(counts).every((count) => count > 0)).toBe(true);
      expect(new Set(full.courses.map((course) => course.priorityGroup))).toEqual(
        new Set(["ACTION", "WATCH", "PARKED", "LIMITATION", "UNCHECKED", "WORKING"]),
      );
      expect(new Set(full.courses.map((course) => course.automationQueueState).filter(Boolean))).toEqual(
        new Set(["DUE_NOW", "IN_PROGRESS", "RECOVERY_REQUIRED", "SCHEDULED_RETRY", "ENGINEERING_NEEDED", "NEEDS_HUMAN"]),
      );
      const fullQuery = prismaMocks.courseFindMany.mock.calls[0]![0];
      const countsQuery = prismaMocks.courseFindMany.mock.calls[1]![0];
      expect(fullQuery.select.automationDiscoveries).toEqual({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1,
        select: {
          status: true, detectedPlatform: true, bookingMethod: true,
          automationEligibility: true, automationReason: true, bookingAccessMode: true,
          bookingUrl: true, confidence: true, evidence: true, createdAt: true,
        },
      });
      expect(countsQuery.select).not.toHaveProperty("automationDiscoveries");
      expect(countsQuery.select.bookingMetadata).toBe(true);
      expect(countsQuery.select.localReaderJobs.select.result).toBe(true);
      expect(countsQuery.select.supportIncident.select.monitoringEvents.select.audit).toBe(true);
      const human = full.courses.find((course) => course.id === "human")!;
      if (["stale", "FAILED", "null"].includes(kind)) {
        expect(human.discoveryProviderLabel).toBeNull();
      } else {
        expect(human.discoveryProviderLabel).not.toBeNull();
        expect(human.problemSummary).not.toBe("Reader parser missing.");
      }
      if (kind === "account") {
        expect(human.discoveryStatusLabel).toBe("Account sign-in required");
        expect(human.problemSummary).toContain("viewing tee times requires a golfer account");
        expect(human.recommendedAction).toContain("Confirm the account-required technical limitation");
      }
    },
  );

  it("never hydrates excluded oversized discovery evidence in the counts-only projection", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(
      realProviderCoverage.classifyProviderCoverage,
    );
    const hugeEvidence = { unrelated: "x".repeat(17 * 1024 * 1024) };
    const evidenceRead = vi.fn(() => hugeEvidence);
    const discovery = { ...discoveryRow("account"), evidence: hugeEvidence };
    Object.defineProperty(discovery, "evidence", { get: evidenceRead });
    const rows = fleetParityRows(discovery);
    installSelectedFleetReads(rows);

    const counts = await loadOperatorCourseFleetCounts({ now: NOW });

    expect(counts).toEqual({
      action: 4, watch: 2, parked: 1, limitations: 1, unchecked: 1, working: 1,
      dueNow: 1, inProgress: 1, recoveryRequired: 1, scheduledRetry: 1,
      engineeringNeeded: 1, needsHuman: 1,
    });
    expect(evidenceRead).not.toHaveBeenCalled();
    expect(prismaMocks.courseFindMany.mock.calls[0]![0].select).not.toHaveProperty("automationDiscoveries");
  });

  it("retains complete local-reader and parking proof validation in the counts-only path", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(
      realProviderCoverage.classifyProviderCoverage,
    );
    const rows = fleetParityRows(null);
    const working = rows.find((row) => row.id === "working")!;
    const readerJobs = working.localReaderJobs as Array<{ result: Record<string, unknown> }>;
    readerJobs[0]!.result.unexpected = true;
    const parked = rows.find((row) => row.id === "parked")!;
    const incident = parked.supportIncident as { monitoringEvents: Array<{ audit: Record<string, unknown> }> };
    incident.monitoringEvents[0]!.audit.cycle = 2;
    installSelectedFleetReads(rows);

    const full = await loadOperatorCourseFleet({ now: NOW });
    const counts = await loadOperatorCourseFleetCounts({ now: NOW });

    expect(counts).toEqual(full.counts);
    // The invalid reader proof leaves this course's active synthetic demand in
    // attention; the unproven parking endpoint also remains a human handoff.
    expect(counts).toMatchObject({ action: 6, parked: 0, unchecked: 1, working: 0, needsHuman: 3 });
    const query = prismaMocks.courseFindMany.mock.calls[1]![0];
    expect(query.select.localReaderJobs.select.result).toBe(true);
    expect(query.select.supportIncident.select.monitoringEvents.select.audit).toBe(true);
  });
});

type FleetTestSelect = { [field: string]: boolean | { select: FleetTestSelect; take?: number } };

function projectFleetRow(row: Record<string, unknown>, select: FleetTestSelect): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [field, selection] of Object.entries(select)) {
    if (selection === true) projected[field] = row[field];
    else if (selection && typeof selection === "object") {
      const value = row[field];
      projected[field] = value === null
        ? null
        : Array.isArray(value)
          ? value.slice(0, selection.take ?? value.length).map((child) => projectFleetRow(child, selection.select))
          : projectFleetRow(value as Record<string, unknown>, selection.select);
    }
  }
  return projected;
}

function installSelectedFleetReads(rows: Record<string, unknown>[]) {
  prismaMocks.courseFindMany.mockImplementation(async (query: { select: FleetTestSelect }) =>
    rows.map((row) => projectFleetRow(row, query.select)),
  );
  prismaMocks.courseProbeFindMany.mockImplementation(async (query: {
    where: { courseId: { in: string[] } }; select: FleetTestSelect;
  }) => [{
    courseId: "working", outcome: "FETCH_FAILED", observedAt: new Date("2026-08-22T13:00:00.000Z"),
    message: "Older read failed.", evidenceUrl: "https://example.test/evidence",
  }].filter((row) => query.where.courseId.in.includes(row.courseId)).map((row) => projectFleetRow(row, query.select)));
  prismaMocks.coursePreferenceGroupBy.mockImplementation(async (query: {
    where: { teeSearch: { status?: string; trafficClass: unknown } };
  }) => {
    const courseIds = query.where.teeSearch.trafficClass === "TEST"
      ? ["working"]
      : query.where.teeSearch.status === "ACTIVE"
        ? ["due", "owned"]
        : rows.map((row) => row.id);
    return courseIds.map((courseId) => ({ courseId, _count: { _all: 1 } }));
  });
}

function discoveryRow(kind: "account" | "captcha" | "unsupported" | "candidate" | "stale" | "FAILED" | "null") {
  if (kind === "null") return null;
  const bookingUrl = "https://public-course.book.teeitup.golf/";
  return {
    status: kind === "FAILED" ? "FAILED" : kind === "candidate" ? "LEARNED" : "VERIFIED",
    detectedPlatform: kind === "unsupported" ? "MEMBERSPORTS" : kind === "candidate" ? "TEEITUP" : "CUSTOM",
    bookingMethod: "PUBLIC_ONLINE", automationEligibility: "BLOCKED",
    automationReason: kind === "captcha" ? "CAPTCHA_OR_QUEUE" : kind === "candidate" || kind === "unsupported" ? "NONE" : "ACCOUNT_REQUIRED",
    bookingAccessMode: kind === "captcha" ? "CAPTCHA_OR_QUEUE" : kind === "candidate" || kind === "unsupported" ? "PUBLIC_SIGNED_OUT" : "ACCOUNT_SELF_SERVICE",
    bookingUrl, confidence: 0.9,
    createdAt: new Date(kind === "stale" ? "2026-08-22T11:59:59.999Z" : "2026-08-22T13:30:00.000Z"),
    evidence: {
      learnedFrom: "official-booking-cta-account-sign-in", finalUrl: bookingUrl,
      ...(kind === "candidate" ? {} : { courseIdentityCorroboration: {
        kind: "OFFICIAL_COURSE_PROVIDER_LINK", officialWebsiteUrl: "https://example.test/",
        officialPageUrl: "https://example.test/golf", providerUrl: bookingUrl,
      } }),
    },
  };
}

function fleetParityRows(discovery: Record<string, unknown> | null): Record<string, unknown>[] {
  const rows = ["due", "scheduled", "owned", "expired", "engineering", "human", "parked", "manual", "ready", "working"].map((id) => {
    const base = courseRow();
    return {
      ...base, id, name: id,
      automationDiscoveries: discovery ? [discovery] : [],
      supportIncident: { ...base.supportIncident, id: `incident-${id}`, failureClass: "MISSING_METADATA" },
      monitoringStatus: { ...base.monitoringStatus, reference: `MON-${id}` },
    } as Record<string, unknown>;
  });
  const find = (id: string) => rows.find((row) => row.id === id)!;
  for (const id of ["due", "scheduled", "owned", "expired"]) {
    const row = find(id);
    Object.assign(row.supportIncident as object, { status: "AUTO_INVESTIGATING", kind: "NEEDS_ADAPTER" });
    Object.assign(row.monitoringStatus as object, { state: "AUTO_INVESTIGATING" });
  }
  Object.assign(find("scheduled").supportIncident as object, { nextAttemptAt: new Date("2026-08-22T15:00:00.000Z") });
  for (const id of ["owned", "expired"]) {
    Object.assign(find(id).supportIncident as object, {
      activeBatchId: `batch-${id}`, activeBatch: {
        status: "IMPLEMENTING", leaseExpiresAt: new Date(id === "owned" ? "2026-08-22T15:00:00.000Z" : "2026-08-22T13:00:00.000Z"),
      },
    });
  }
  Object.assign(find("engineering").supportIncident as object, { failureClass: "READER_PARSER_MISSING" });
  Object.assign(find("human"), { providerFamilyKey: "MEMBERSPORTS", detectedPlatform: "MEMBERSPORTS" });
  Object.assign(find("parked").supportIncident as object, {
    humanReviewReason: "AUTOMATION_STALLED", escalatedAt: new Date("2026-08-22T13:00:00.000Z"),
    monitoringEvents: [{
      incidentId: "incident-parked", eventType: "HUMAN_REVIEW_REQUESTED", occurredAt: new Date("2026-08-22T13:00:00.000Z"),
      audit: { cycle: 1, customerState: "NEEDS_HUMAN_REVIEW", parkedUntilMaterialChange: true, automationStalled: true },
    }],
  });
  Object.assign(find("manual").supportIncident as object, { status: "RESOLVED", resolution: "DIRECT_BOOKING_CLASSIFIED" });
  Object.assign(find("manual").monitoringStatus as object, { state: "FINAL_MANUAL" });
  Object.assign(find("ready"), {
    detectedPlatform: "FOREUP", providerFamilyKey: "FOREUP", supportIncident: null, monitoringStatus: null,
    detectedBookingUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes",
    bookingMetadata: { scheduleId: 6654, bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes" },
  });
  Object.assign(find("working"), {
    detectedPlatform: "PROPHET", providerFamilyKey: "PROPHET", supportIncident: null,
    detectedBookingUrl: "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex",
    automationEligibility: "BLOCKED", automationReason: "CAPTCHA_OR_QUEUE", bookingAccessMode: "CAPTCHA_OR_QUEUE",
    intelligenceVerifiedAt: new Date("2026-08-22T13:00:00.000Z"), intelligenceReviewAt: new Date("2026-09-22T13:00:00.000Z"), intelligenceConfidence: 0.99,
    monitoringStatus: { ...courseRow().monitoringStatus, state: "HEALTHY" },
    localReaderJobs: [{
      completedAt: new Date("2026-08-22T13:50:00.000Z"), readerVersion: "reader-test",
      result: {
        jobId: "job-test", courseKey: "frear-park", status: "NO_AVAILABILITY", observedAt: "2026-08-22T13:49:00.000Z",
        pageUrl: "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex", pageTitle: "Frear Park", slots: [], readerVersion: "reader-test",
      },
    }],
  });
  return rows;
}

function courseRow() {
  return {
    id: "course-sensitive",
    name: "Sensitive Course Name",
    address: "1 Private Lane",
    city: "Example",
    stateCode: "CT",
    isPublic: true,
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "UNKNOWN",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    bookingAccessMode: "PUBLIC_SIGNED_OUT",
    bookingMethod: "PUBLIC_ONLINE",
    bookingMetadata: null,
    intelligenceVerifiedAt: null,
    intelligenceReviewAt: null,
    intelligenceConfidence: null,
    detectedBookingUrl: "https://book.example.test/",
    website: "https://example.test/",
    automationDiscoveries: [],
    profile: null,
    supportIncident: {
      id: "incident-sensitive",
      status: "NEEDS_HUMAN",
      kind: "READER_CANDIDATE",
      activeRealSearchCount: 0,
      cycle: 1,
      firstSeenAt: new Date("2026-08-22T12:00:00.000Z"),
      resolvedAt: null,
      resolution: null,
      engineeringOnly: true,
      latestMessage: "Reader parser missing.",
      nextAction: "Implement the parser.",
      failureClass: "READER_PARSER_MISSING",
      humanReviewReason: null,
      escalatedAt: null,
      escalationDeadlineAt: null,
      nextAttemptAt: null,
      activeBatchId: null,
      activeBatch: null,
      attemptCount: 1,
      monitoringEvents: [],
    },
    monitoringStatus: {
      reference: "MON-sensitive",
      state: "ENGINEERING_VERIFICATION_NEEDED",
      lastSuccessfulAt: null,
      lastFailureAt: new Date("2026-08-22T13:00:00.000Z"),
      nextAutomaticAttemptAt: null,
      revalidationRequestedAt: null,
    },
    localReaderJobs: [],
  };
}
