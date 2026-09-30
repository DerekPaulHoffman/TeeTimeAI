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
});

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
