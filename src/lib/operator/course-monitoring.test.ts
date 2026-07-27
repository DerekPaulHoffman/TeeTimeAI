import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  $transaction: vi.fn(),
  courseMonitoringEvent: {
    findUnique: vi.fn()
  },
  courseMonitoringStatus: {
    findFirst: vi.fn()
  },
  teeSearch: {
    findMany: vi.fn()
  }
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));
vi.mock("@/lib/automation/search-scheduler", () => ({
  startSearchSchedule: vi.fn()
}));

import {
  correctOperatorCourseBookingLink,
  requestOperatorCourseRecheck
} from "./course-monitoring";

const reference = "cm_123456789012345678901234";

function status() {
  return {
    courseId: "course-1",
    reference,
    state: "ENGINEERING_VERIFICATION_NEEDED",
    revision: 4,
    firstDegradedAt: new Date("2026-07-27T10:00:00.000Z"),
    course: {
      name: "Example Public Golf Course",
      detectedPlatform: "UNKNOWN",
      detectedBookingUrl: "https://course.example/book",
      website: "https://course.example",
      providerFamilyKey: "SOURCE_MISSING",
      bookingAccessMode: "UNKNOWN",
      automationReason: "OTHER",
      supportIncident: {
        id: "incident-1",
        cycle: 2,
        revision: 7,
        status: "NEEDS_HUMAN",
        activeRealSearchCount: 1,
        resolution: null,
        failureFingerprint: "SOURCE_MISSING:UNKNOWN"
      }
    }
  };
}

const context = {
  actorId: "user_clerk_operator",
  source: "OPERATOR_DASHBOARD" as const,
  apply: true,
  dispatchSearches: true
};

describe("operator course monitoring mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    prismaMocks.courseMonitoringStatus.findFirst.mockResolvedValue(status());
    prismaMocks.teeSearch.findMany.mockResolvedValue([]);
  });

  it("rejects unsafe official links before reading course state", async () => {
    await expect(
      correctOperatorCourseBookingLink(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          bookingUrl: "https://user:secret@course.example/book",
          evidenceUrl: "https://course.example/evidence",
          note: "Verified from the official course website.",
          idempotencyKey: "operator-link-1234567890"
        },
        context
      )
    ).rejects.toThrow("without credentials");
    expect(prismaMocks.courseMonitoringStatus.findFirst).not.toHaveBeenCalled();
  });

  it("rejects stale status, incident cycle, or incident revision", async () => {
    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 6,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).rejects.toThrow("changed while this form was open");
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("treats an existing same-course idempotency key as a replay", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-1"
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).resolves.toMatchObject({
      action: "request_recheck",
      applied: false,
      replayed: true
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key already used by another course", async () => {
    prismaMocks.courseMonitoringEvent.findUnique.mockResolvedValue({
      courseId: "course-2"
    });

    await expect(
      requestOperatorCourseRecheck(
        {
          reference,
          statusRevision: 4,
          incidentCycle: 2,
          incidentRevision: 7,
          note: "Retry the current public signed-out course surface.",
          idempotencyKey: "operator-recheck-123456"
        },
        context
      )
    ).rejects.toThrow("another course");
  });
});
