import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  courseFindMany: vi.fn(),
  courseProbeFindMany: vi.fn(),
  coursePreferenceGroupBy: vi.fn(),
  localReaderJobFindMany: vi.fn(),
  courseMonitoringEventFindMany: vi.fn(),
  transaction: vi.fn(),
  executeRawUnsafe: vi.fn(),
}));
const providerCoverageMocks = vi.hoisted(() => ({
  classifyProviderCoverage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: { findMany: prismaMocks.courseFindMany },
    courseProbe: { findMany: prismaMocks.courseProbeFindMany },
    coursePreference: { groupBy: prismaMocks.coursePreferenceGroupBy },
    localReaderJob: { findMany: prismaMocks.localReaderJobFindMany },
    courseMonitoringEvent: { findMany: prismaMocks.courseMonitoringEventFindMany },
    $transaction: prismaMocks.transaction,
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
  prismaMocks.localReaderJobFindMany.mockResolvedValue([]);
  prismaMocks.courseMonitoringEventFindMany.mockResolvedValue([]);
  prismaMocks.executeRawUnsafe.mockResolvedValue(0);
  prismaMocks.transaction.mockImplementation(async (read: (database: unknown) => Promise<unknown>) =>
    read({ ...countsDatabase(), $executeRawUnsafe: prismaMocks.executeRawUnsafe }),
  );
  providerCoverageMocks.classifyProviderCoverage.mockReturnValue(
    "SUPPORTED_READY",
  );
});

describe("operator course fleet loader", () => {
  it("opens one read-only RepeatableRead snapshot before any default counts read", async () => {
    await loadOperatorCourseFleetCounts({ now: NOW });

    expect(prismaMocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000,
    });
    expect(prismaMocks.executeRawUnsafe.mock.calls).toEqual([
      ["SET TRANSACTION READ ONLY"], ["SET LOCAL statement_timeout = '25000ms'"],
    ]);
    expect(prismaMocks.executeRawUnsafe.mock.invocationCallOrder[1]).toBeLessThan(
      prismaMocks.courseFindMany.mock.invocationCallOrder[0]!,
    );
  });

  it.each([0, 1])("stops all default counts reads when snapshot setup command %i fails", async (index) => {
    if (index === 1) prismaMocks.executeRawUnsafe.mockResolvedValueOnce(0);
    prismaMocks.executeRawUnsafe.mockRejectedValueOnce(new Error("Snapshot setup failed."));

    await expect(loadOperatorCourseFleetCounts({ now: NOW })).rejects.toThrow("Snapshot setup failed.");

    expect(prismaMocks.executeRawUnsafe).toHaveBeenCalledTimes(index + 1);
    expect(prismaMocks.courseFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJobFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEventFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
  });

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
      localReaderJob: { findMany: vi.fn() },
      courseMonitoringEvent: { findMany: vi.fn() },
      get $transaction() { throw new Error("A supplied snapshot must not be probed."); },
      get $executeRawUnsafe() { throw new Error("A supplied snapshot must not be reconfigured."); },
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
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
    expect(prismaMocks.executeRawUnsafe).not.toHaveBeenCalled();
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

  it("keeps metadata, complete payloads, probes and all 12 counts on a supplied snapshot without global escape", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
    installSelectedFleetReads(fleetParityRows(null));
    const supplied = {
      course: { findMany: vi.fn(prismaMocks.courseFindMany.getMockImplementation()!) },
      courseProbe: { findMany: vi.fn(prismaMocks.courseProbeFindMany.getMockImplementation()!) },
      coursePreference: { groupBy: vi.fn(prismaMocks.coursePreferenceGroupBy.getMockImplementation()!) },
      localReaderJob: { findMany: vi.fn(prismaMocks.localReaderJobFindMany.getMockImplementation()!) },
      courseMonitoringEvent: { findMany: vi.fn(prismaMocks.courseMonitoringEventFindMany.getMockImplementation()!) },
      get $transaction() { throw new Error("Snapshot transaction property was probed."); },
      get $executeRawUnsafe() { throw new Error("Snapshot configuration property was probed."); },
    };
    const nativeReader = supplied.localReaderJob.findMany.getMockImplementation()!;
    supplied.localReaderJob.findMany.mockImplementationOnce(async (query) =>
      (await nativeReader(query) as Record<string, unknown>[]).map((job) => ({
        ...job, completedAt: new Date((job.completedAt as Date).getTime()),
        updatedAt: new Date((job.updatedAt as Date).getTime()),
      })),
    );
    const nativeAudit = supplied.courseMonitoringEvent.findMany.getMockImplementation()!;
    supplied.courseMonitoringEvent.findMany.mockImplementationOnce(async (query) =>
      (await nativeAudit(query) as Record<string, unknown>[]).map((event) => ({
        ...event, occurredAt: new Date((event.occurredAt as Date).getTime()),
      })),
    );
    const globalEscape = () => { throw new Error("The global client must not be used."); };
    for (const mock of Object.values(prismaMocks)) mock.mockImplementation(globalEscape);

    const counts = await loadOperatorCourseFleetCounts({ now: NOW }, supplied as unknown as OperatorCourseFleetCountsReadDatabase);

    expect(counts).toEqual({
      action: 4, watch: 2, parked: 1, limitations: 1, unchecked: 1, working: 1,
      dueNow: 1, inProgress: 1, recoveryRequired: 1, scheduledRetry: 1,
      engineeringNeeded: 1, needsHuman: 1,
    });
    expect(supplied.course.findMany).toHaveBeenCalledTimes(1);
    expect(supplied.localReaderJob.findMany).toHaveBeenCalledTimes(1);
    expect(supplied.courseMonitoringEvent.findMany).toHaveBeenCalledTimes(1);
    expect(supplied.courseProbe.findMany).toHaveBeenCalledTimes(1);
    expect(supplied.coursePreference.groupBy).toHaveBeenCalledTimes(2);
    expect(supplied.course.findMany.mock.invocationCallOrder[0]).toBeLessThan(supplied.localReaderJob.findMany.mock.invocationCallOrder[0]!);
    expect(supplied.localReaderJob.findMany.mock.invocationCallOrder[0]).toBeLessThan(supplied.courseMonitoringEvent.findMany.mock.invocationCallOrder[0]!);
    expect(supplied.courseMonitoringEvent.findMany.mock.invocationCallOrder[0]).toBeLessThan(supplied.courseProbe.findMany.mock.invocationCallOrder[0]!);
    for (const mock of Object.values(prismaMocks)) expect(mock).not.toHaveBeenCalled();
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
      expect(countsQuery.select.localReaderJobs.select).toEqual({
        id: true, courseId: true, status: true, completedAt: true, updatedAt: true,
      });
      expect(countsQuery.select.supportIncident.select.monitoringEvents.select).toEqual({
        id: true, courseId: true, incidentId: true, eventType: true, occurredAt: true,
      });
      expect(prismaMocks.localReaderJobFindMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: ["job-test"] } },
        select: { id: true, courseId: true, status: true, completedAt: true, updatedAt: true, result: true },
      });
      expect(prismaMocks.courseMonitoringEventFindMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: ["event-parked"] } },
        select: { id: true, courseId: true, incidentId: true, eventType: true, occurredAt: true, audit: true },
      });
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
    expect(query.select.localReaderJobs.select).not.toHaveProperty("result");
    expect(query.select.supportIncident.select.monitoringEvents.select).not.toHaveProperty("audit");
    expect(prismaMocks.localReaderJobFindMany.mock.calls[0]![0].select.result).toBe(true);
    expect(prismaMocks.courseMonitoringEventFindMany.mock.calls[0]![0].select.audit).toBe(true);
  });

  it.each(["latest success", "latest failure", "missing", "stale success", "tied failure first", "tied success first"] as const)(
    "retains all 12 real-classifier counts and the original latest-probe choice with %s",
    async (kind) => {
      providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
      const rows = fleetParityRows(null);
      rows.push({ ...rows.find((row) => row.id === "ready")!, id: "probe-course", name: "Probe Course" });
      const latestAt = new Date(kind === "stale success" ? "2026-08-20T13:00:00.000Z" : "2026-08-22T13:55:00.000Z");
      const failureFirst = kind === "latest failure" || kind === "tied failure first";
      const first = { courseId: "probe-course", outcome: failureFirst ? "FETCH_FAILED" : "NO_MATCH", observedAt: latestAt,
        message: failureFirst ? "HTTP 403 at the official booking page." : "The newest public availability check completed.", evidenceUrl: null };
      const second = { ...first, outcome: failureFirst ? "NO_MATCH" : "FETCH_FAILED",
        observedAt: kind.startsWith("tied") ? latestAt : new Date(latestAt.getTime() - 60_000),
        message: "The older or equally timed check has a different outcome." };
      installSelectedFleetReads(rows, { probes: kind === "missing" ? [] : [first, second], extraActiveCourseIds: ["probe-course"] });

      const full = await loadOperatorCourseFleet({ now: NOW });
      const counts = await loadOperatorCourseFleetCounts({ now: NOW });
      const expected = {
        action: 4, watch: 2, parked: 1, limitations: 1, unchecked: 1, working: 1,
        dueNow: 1, inProgress: 1, recoveryRequired: 1, scheduledRetry: 1,
        engineeringNeeded: 1, needsHuman: 1,
        ...(kind === "missing" ? { unchecked: 2 }
          : failureFirst || kind === "stale success" ? { action: 5, needsHuman: 2 }
            : { working: 2 }),
      };
      expect(full.counts).toEqual(expected);
      expect(counts).toEqual(expected);
      expect(Object.values(counts).every((count) => count > 0)).toBe(true);
      expect(full.courses).toHaveLength(11);
      const displayed = full.courses.find((course) => course.id === "probe-course")!;
      if (kind === "missing") expect(displayed.latestProbe).toBeNull();
      else expect(displayed.latestProbe).toMatchObject({ outcome: first.outcome, observedAt: latestAt });
      if (failureFirst) expect(displayed.problemSummary).toContain("returned HTTP 403");
      const [fullQuery, countsQuery] = prismaMocks.courseProbeFindMany.mock.calls.map(([query]) => query);
      expect(fullQuery.where).toEqual({ courseId: { in: rows.map((row) => row.id) } });
      expect(countsQuery.where).toEqual(fullQuery.where);
      expect(fullQuery.orderBy).toEqual({ observedAt: "desc" });
      expect(countsQuery.orderBy).toEqual(fullQuery.orderBy);
      expect(fullQuery.distinct).toEqual(["courseId"]);
      expect(countsQuery.distinct).toEqual(fullQuery.distinct);
      expect(fullQuery.select.message).toBe(true);
      expect(countsQuery.select).toEqual({ courseId: true, outcome: true, observedAt: true });
    },
  );

  it("reads historical display messages for the full fleet but never accesses them for counts", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
    const rows = fleetParityRows(null);
    rows.push({ ...rows.find((row) => row.id === "ready")!, id: "probe-course", name: "Probe Course" });
    const messageRead = vi.fn((latest: boolean) => latest ? "HTTP 403 at the official booking page." : "x".repeat(500));
    const probes = Array.from({ length: 5_000 }, (_, index) => {
      const row = { courseId: "probe-course", outcome: index === 0 ? "FETCH_FAILED" : "NO_MATCH",
        observedAt: new Date(NOW.getTime() - (index + 1) * 60_000), evidenceUrl: null };
      Object.defineProperty(row, "message", { enumerable: true, get: () => messageRead(index === 0) });
      return row;
    });
    installSelectedFleetReads(rows, { probes, extraActiveCourseIds: ["probe-course"] });

    const counts = await loadOperatorCourseFleetCounts({ now: NOW });
    expect(messageRead).not.toHaveBeenCalled();
    const full = await loadOperatorCourseFleet({ now: NOW });

    // The pinned Prisma query path selects historical scalars before its
    // in-memory distinct reduction. The fixture mirrors that projection order.
    expect(messageRead).toHaveBeenCalledTimes(5_000);
    expect(counts).toEqual(full.counts);
    expect(counts).toMatchObject({ action: 5, watch: 2, parked: 1, working: 1, needsHuman: 2 });
    const displayed = full.courses.find((course) => course.id === "probe-course")!;
    expect(displayed.latestProbe?.message).toBe("HTTP 403 at the official booking page.");
    expect(displayed.problemSummary).toContain("returned HTTP 403");
  });

  it.each(["valid first", "invalid first", "newer invalid"] as const)(
    "preserves the reader winner without older-valid fallback for %s", async (kind) => {
      providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
      const rows = fleetParityRows(null);
      const working = rows.find((row) => row.id === "working")!;
      const valid = (working.localReaderJobs as Record<string, unknown>[])[0]!;
      const invalid = {
        ...valid, id: "job-invalid", result: { ...(valid.result as object), unexpected: true },
        completedAt: new Date((valid.completedAt as Date).getTime() + (kind === "newer invalid" ? 1 : 0)),
      };
      working.localReaderJobs = kind === "valid first" ? [valid, invalid] : [invalid, valid];
      installSelectedFleetReads(rows);

      const full = await loadOperatorCourseFleet({ now: NOW });
      const counts = await loadOperatorCourseFleetCounts({ now: NOW });

      expect(counts).toEqual(full.counts);
      expect(counts.working).toBe(kind === "valid first" ? 1 : 0);
      expect(prismaMocks.localReaderJobFindMany.mock.calls[0]![0].where.id.in).toEqual([
        kind === "valid first" ? "job-test" : "job-invalid",
      ]);
      const [fullQuery, countsQuery] = prismaMocks.courseFindMany.mock.calls.map(([query]) => query);
      expect(countsQuery.select.localReaderJobs.where).toEqual(fullQuery.select.localReaderJobs.where);
      expect(countsQuery.select.localReaderJobs.orderBy).toEqual({ completedAt: "desc" });
      expect(countsQuery.select.localReaderJobs.orderBy).toEqual(fullQuery.select.localReaderJobs.orderBy);
      expect(countsQuery.select.localReaderJobs.take).toBe(1);
    },
  );

  it.each(["highest", "lowest"] as const)(
    "keeps the event ID tie order and the five selected complete audits with the proof %s", async (position) => {
      providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
      const rows = fleetParityRows(null);
      const parked = rows.find((row) => row.id === "parked")!;
      const incident = parked.supportIncident as { monitoringEvents: Record<string, unknown>[] };
      const event = incident.monitoringEvents[0]!;
      incident.monitoringEvents = Array.from({ length: 6 }, (_, index) => ({
        ...event, id: `event-${index}`, audit: index === (position === "highest" ? 5 : 0) ? event.audit : null,
      }));
      installSelectedFleetReads(rows);
      const nativeAudits = prismaMocks.courseMonitoringEventFindMany.getMockImplementation()!;
      prismaMocks.courseMonitoringEventFindMany.mockImplementationOnce(async (query) =>
        (await nativeAudits(query)).reverse(),
      );

      const full = await loadOperatorCourseFleet({ now: NOW });
      const counts = await loadOperatorCourseFleetCounts({ now: NOW });

      expect(counts).toEqual(full.counts);
      expect(counts.parked).toBe(position === "highest" ? 1 : 0);
      expect(prismaMocks.courseMonitoringEventFindMany.mock.calls[0]![0].where.id.in).toEqual([
        "event-5", "event-4", "event-3", "event-2", "event-1",
      ]);
      const [fullQuery, countsQuery] = prismaMocks.courseFindMany.mock.calls.map(([query]) => query);
      expect(countsQuery.select.supportIncident.select.monitoringEvents.orderBy).toEqual([
        { occurredAt: "desc" }, { id: "desc" },
      ]);
      expect(countsQuery.select.supportIncident.select.monitoringEvents.orderBy).toEqual(
        fullQuery.select.supportIncident.select.monitoringEvents.orderBy,
      );
    },
  );

  it("passes null full payloads to the native classifiers without inventing evidence", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
    const rows = fleetParityRows(null);
    (rows.find((row) => row.id === "working")!.localReaderJobs as Record<string, unknown>[])[0]!.result = null;
    const incident = rows.find((row) => row.id === "parked")!.supportIncident as { monitoringEvents: Record<string, unknown>[] };
    incident.monitoringEvents[0]!.audit = null;
    installSelectedFleetReads(rows);

    const full = await loadOperatorCourseFleet({ now: NOW });
    const counts = await loadOperatorCourseFleetCounts({ now: NOW });

    expect(counts).toEqual(full.counts);
    expect(counts).toMatchObject({ working: 0, parked: 0, needsHuman: 3 });
    expect(prismaMocks.localReaderJobFindMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseMonitoringEventFindMany).toHaveBeenCalledTimes(1);
  });

  it("hydrates only chosen payloads for counts while the full UI keeps historical result and audit scalars", async () => {
    providerCoverageMocks.classifyProviderCoverage.mockImplementation(realProviderCoverage.classifyProviderCoverage);
    const rows = fleetParityRows(null);
    const working = rows.find((row) => row.id === "working")!;
    const job = (working.localReaderJobs as Record<string, unknown>[])[0]!;
    const incident = rows.find((row) => row.id === "parked")!.supportIncident as { monitoringEvents: Record<string, unknown>[] };
    const event = incident.monitoringEvents[0]!;
    const unusedPayload = { unused: "x".repeat(17 * 1024 * 1024) };
    const unusedReaderRead = vi.fn(() => unusedPayload);
    const unusedAuditRead = vi.fn(() => unusedPayload);
    working.localReaderJobs = [job, ...Array.from({ length: 300 }, (_, index) => {
      const older = { ...job, id: `old-job-${index}`, completedAt: new Date((job.completedAt as Date).getTime() - (index + 1) * 60_000) };
      Object.defineProperty(older, "result", { enumerable: true, get: unusedReaderRead });
      return older;
    })];
    incident.monitoringEvents = [
      ...Array.from({ length: 5 }, (_, index) => ({ ...event, id: `selected-event-${index}` })),
      ...Array.from({ length: 300 }, (_, index) => {
        const older = { ...event, id: `old-event-${index}`, occurredAt: new Date((event.occurredAt as Date).getTime() - (index + 1) * 60_000) };
        Object.defineProperty(older, "audit", { enumerable: true, get: unusedAuditRead });
        return older;
      }),
    ];
    installSelectedFleetReads(rows);

    const counts = await loadOperatorCourseFleetCounts({ now: NOW });

    expect(unusedReaderRead).not.toHaveBeenCalled();
    expect(unusedAuditRead).not.toHaveBeenCalled();
    expect(prismaMocks.localReaderJobFindMany.mock.calls[0]![0].where.id.in).toEqual(["job-test"]);
    expect(prismaMocks.courseMonitoringEventFindMany.mock.calls[0]![0].where.id.in).toEqual([
      "selected-event-4", "selected-event-3", "selected-event-2", "selected-event-1", "selected-event-0",
    ]);
    const full = await loadOperatorCourseFleet({ now: NOW });

    expect(counts).toEqual(full.counts);
    expect(Object.values(counts).every((count) => count > 0)).toBe(true);
    expect(unusedReaderRead).toHaveBeenCalledTimes(300);
    expect(unusedAuditRead).toHaveBeenCalledTimes(300);
    expect(full.courses.find((course) => course.id === "working")!.localReaderVerifiedAt).toEqual(job.completedAt);
  });

  it.each([
    "missing", "duplicate", "extra", "unknown ID", "wrong course", "wrong status", "changed completion",
    "invalid completion", "null completion", "changed updatedAt", "invalid updatedAt", "missing result",
    "undefined result", "inherited result",
  ] as const)("rejects a %s full reader binding before any later reads", async (kind) => {
    const rows = fleetParityRows(null);
    installSelectedFleetReads(rows);
    const nativeRead = prismaMocks.localReaderJobFindMany.getMockImplementation()!;
    prismaMocks.localReaderJobFindMany.mockImplementationOnce(async (query) => {
      const selected = await nativeRead(query) as Record<string, unknown>[];
      const row = selected[0]!;
      switch (kind) {
        case "missing": return [];
        case "duplicate": return [row, row];
        case "extra": return [row, { ...row, id: "extra-private-job" }];
        case "unknown ID": row.id = "unknown-private-job"; break;
        case "wrong course": row.courseId = "other-private-course"; break;
        case "wrong status": row.status = "FAILED"; break;
        case "changed completion": row.completedAt = new Date((row.completedAt as Date).getTime() + 1); break;
        case "invalid completion": row.completedAt = new Date("invalid"); break;
        case "null completion": row.completedAt = null; break;
        case "changed updatedAt": row.updatedAt = new Date((row.updatedAt as Date).getTime() + 1); break;
        case "invalid updatedAt": row.updatedAt = new Date("invalid"); break;
        case "missing result": delete row.result; break;
        case "undefined result": row.result = undefined; break;
        case "inherited result": {
          const result = row.result;
          delete row.result;
          Object.setPrototypeOf(row, { result });
          break;
        }
      }
      return selected;
    });

    await expect(loadOperatorCourseFleetCounts({ now: NOW }, countsDatabase())).rejects.toThrow(/^READ_FAILED$/);

    expect(prismaMocks.courseMonitoringEventFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    "missing", "duplicate", "extra", "unknown ID", "wrong course", "wrong incident", "wrong type",
    "changed clock", "invalid clock", "null clock", "missing audit", "undefined audit", "inherited audit",
  ] as const)("rejects a %s full event binding before probe or demand reads", async (kind) => {
    const rows = fleetParityRows(null);
    installSelectedFleetReads(rows);
    const nativeRead = prismaMocks.courseMonitoringEventFindMany.getMockImplementation()!;
    prismaMocks.courseMonitoringEventFindMany.mockImplementationOnce(async (query) => {
      const selected = await nativeRead(query) as Record<string, unknown>[];
      const row = selected[0]!;
      switch (kind) {
        case "missing": return [];
        case "duplicate": return [row, row];
        case "extra": return [row, { ...row, id: "extra-private-event" }];
        case "unknown ID": row.id = "unknown-private-event"; break;
        case "wrong course": row.courseId = "other-private-course"; break;
        case "wrong incident": row.incidentId = "other-private-incident"; break;
        case "wrong type": row.eventType = "CHECK_SUCCEEDED"; break;
        case "changed clock": row.occurredAt = new Date((row.occurredAt as Date).getTime() + 1); break;
        case "invalid clock": row.occurredAt = new Date("invalid"); break;
        case "null clock": row.occurredAt = null; break;
        case "missing audit": delete row.audit; break;
        case "undefined audit": row.audit = undefined; break;
        case "inherited audit": {
          const audit = row.audit;
          delete row.audit;
          Object.setPrototypeOf(row, { audit });
          break;
        }
      }
      return selected;
    });

    await expect(loadOperatorCourseFleetCounts({ now: NOW }, countsDatabase())).rejects.toThrow(/^READ_FAILED$/);

    expect(prismaMocks.localReaderJobFindMany).toHaveBeenCalledTimes(1);
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
    expect(prismaMocks.transaction).not.toHaveBeenCalled();
  });

  it.each([
    "too many jobs", "duplicate job IDs", "job wrong parent", "job wrong status", "job missing ID", "job invalid completion", "job invalid updatedAt",
    "too many events", "duplicate event IDs", "event wrong course", "event wrong incident", "event wrong type", "event missing ID", "event invalid clock",
  ] as const)("rejects selected metadata with %s before full payload reads", async (kind) => {
    const rows = fleetParityRows(null);
    installSelectedFleetReads(rows);
    const nativeMetadata = prismaMocks.courseFindMany.getMockImplementation()!;
    prismaMocks.courseFindMany.mockImplementationOnce(async (query) => {
      const selected = await nativeMetadata(query) as Record<string, unknown>[];
      const working = selected.find((row) => row.id === "working")!;
      const jobs = working.localReaderJobs as Record<string, unknown>[];
      const incident = selected.find((row) => row.id === "parked")!.supportIncident as { monitoringEvents: Record<string, unknown>[] };
      const events = incident.monitoringEvents;
      switch (kind) {
        case "too many jobs": jobs.push({ ...jobs[0], id: "job-extra" }); break;
        case "duplicate job IDs": (selected[0]!.localReaderJobs as unknown[]) = [{ ...jobs[0] }]; break;
        case "job wrong parent": jobs[0]!.courseId = "other-course"; break;
        case "job wrong status": jobs[0]!.status = "FAILED"; break;
        case "job missing ID": jobs[0]!.id = ""; break;
        case "job invalid completion": jobs[0]!.completedAt = new Date("invalid"); break;
        case "job invalid updatedAt": jobs[0]!.updatedAt = null; break;
        case "too many events": incident.monitoringEvents = Array.from({ length: 6 }, (_, index) => ({ ...events[0], id: `event-extra-${index}` })); break;
        case "duplicate event IDs": incident.monitoringEvents = [events[0]!, { ...events[0] }]; break;
        case "event wrong course": events[0]!.courseId = "other-course"; break;
        case "event wrong incident": events[0]!.incidentId = "other-incident"; break;
        case "event wrong type": events[0]!.eventType = "CHECK_SUCCEEDED"; break;
        case "event missing ID": events[0]!.id = ""; break;
        case "event invalid clock": events[0]!.occurredAt = null; break;
      }
      return selected;
    });

    await expect(loadOperatorCourseFleetCounts({ now: NOW }, countsDatabase())).rejects.toThrow(/^READ_FAILED$/);

    expect(prismaMocks.localReaderJobFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseMonitoringEventFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.courseProbeFindMany).not.toHaveBeenCalled();
    expect(prismaMocks.coursePreferenceGroupBy).not.toHaveBeenCalled();
  });
});

type FleetTestRelation = {
  select: FleetTestSelect;
  take?: number;
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
};
type FleetTestSelect = { [field: string]: boolean | FleetTestRelation };

function countsDatabase(): OperatorCourseFleetCountsReadDatabase {
  return {
    course: { findMany: prismaMocks.courseFindMany },
    courseProbe: { findMany: prismaMocks.courseProbeFindMany },
    coursePreference: { groupBy: prismaMocks.coursePreferenceGroupBy },
    localReaderJob: { findMany: prismaMocks.localReaderJobFindMany },
    courseMonitoringEvent: { findMany: prismaMocks.courseMonitoringEventFindMany },
  } as unknown as OperatorCourseFleetCountsReadDatabase;
}

function matchingFleetRows(rows: Record<string, unknown>[], selection: FleetTestRelation) {
  const matching = rows.filter((row) => Object.entries(selection.where ?? {}).every(([field, filter]) =>
    filter && typeof filter === "object" && "gte" in filter
      ? row[field] instanceof Date && row[field].getTime() >= (filter.gte as Date).getTime()
      : row[field] === filter,
  ));
  const orders = Array.isArray(selection.orderBy) ? selection.orderBy : [selection.orderBy ?? {}];
  return matching.sort((left, right) => {
    for (const order of orders) {
      for (const [field, direction] of Object.entries(order)) {
        const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
        const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
        if (leftValue === rightValue) continue;
        const comparison = (leftValue as string | number) < (rightValue as string | number) ? -1 : 1;
        return comparison * (direction === "desc" ? -1 : 1);
      }
    }
    return 0;
  });
}

function projectFleetRow(row: Record<string, unknown>, select: FleetTestSelect): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [field, selection] of Object.entries(select)) {
    if (selection === true) projected[field] = row[field];
    else if (selection && typeof selection === "object") {
      const value = row[field];
      projected[field] = value === null
        ? null
        : Array.isArray(value)
          // The installed Query strategy fetches selected child scalars before
          // reducing a bulk nested take. Keep that physical projection order.
          ? matchingFleetRows(value, selection).map((child) => projectFleetRow(child, selection.select))
            .slice(0, selection.take ?? value.length)
          : projectFleetRow(value as Record<string, unknown>, selection.select);
    }
  }
  return projected;
}

function installSelectedFleetReads(rows: Record<string, unknown>[], input: {
  probes?: Record<string, unknown>[];
  extraActiveCourseIds?: string[];
} = {}) {
  prismaMocks.courseFindMany.mockImplementation(async (query: { select: FleetTestSelect }) =>
    rows.map((row) => projectFleetRow(row, query.select)),
  );
  const installPayloadRead = (
    mock: typeof prismaMocks.localReaderJobFindMany,
    source: () => Record<string, unknown>[],
  ) => mock.mockImplementation(async (query: {
    where: { id: { in: string[] } }; select: FleetTestSelect;
  }) => source().filter((row) => query.where.id.in.includes(row.id as string))
    .map((row) => projectFleetRow(row, query.select)));
  installPayloadRead(prismaMocks.localReaderJobFindMany,
    () => rows.flatMap((row) => row.localReaderJobs as Record<string, unknown>[]));
  installPayloadRead(prismaMocks.courseMonitoringEventFindMany,
    () => rows.flatMap((row) => (row.supportIncident as { monitoringEvents: Record<string, unknown>[] } | null)?.monitoringEvents ?? []));
  prismaMocks.courseProbeFindMany.mockImplementation(async (query: {
    where: { courseId: { in: string[] } }; select: FleetTestSelect;
    orderBy: { observedAt: "asc" | "desc" }; distinct: string[];
  }) => {
    const probes = input.probes ?? [{
      courseId: "working", outcome: "FETCH_FAILED", observedAt: new Date("2026-08-22T13:00:00.000Z"),
      message: "Older read failed.", evidenceUrl: "https://example.test/evidence",
    }];
    const projected = probes.filter((row) => query.where.courseId.in.includes(row.courseId as string))
      .sort((left, right) => ((left.observedAt as Date).getTime() - (right.observedAt as Date).getTime()) *
        (query.orderBy.observedAt === "desc" ? -1 : 1))
      .map((row) => projectFleetRow(row, query.select));
    const seen = new Set<string>();
    return projected.filter((row) => {
      const key = JSON.stringify(query.distinct.map((field) => row[field]));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  prismaMocks.coursePreferenceGroupBy.mockImplementation(async (query: {
    where: { teeSearch: { status?: string; trafficClass: unknown } };
  }) => {
    const courseIds = query.where.teeSearch.trafficClass === "TEST"
      ? ["working"]
      : query.where.teeSearch.status === "ACTIVE"
        ? ["due", "owned", ...(input.extraActiveCourseIds ?? [])]
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
      id: "event-parked", courseId: "parked", incidentId: "incident-parked", eventType: "HUMAN_REVIEW_REQUESTED", occurredAt: new Date("2026-08-22T13:00:00.000Z"),
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
      id: "job-test", courseId: "working", status: "COMPLETED", updatedAt: new Date("2026-08-22T13:50:00.000Z"),
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
