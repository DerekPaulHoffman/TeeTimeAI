import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  course: {
    findMany: vi.fn()
  },
  teeSearch: {
    aggregate: vi.fn()
  },
  courseMonitoringEvent: {
    findMany: vi.fn()
  },
  $transaction: vi.fn()
}));
const transactionMocks = vi.hoisted(() => ({
  courseMonitoringStatus: {
    findUnique: vi.fn(),
    updateMany: vi.fn()
  },
  courseSupportIncident: {
    findUnique: vi.fn()
  },
  courseMonitoringEvent: {
    create: vi.fn()
  }
}));

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import {
  backfillCourseMonitoringLifecycle,
  getIncidentLifecycleState,
  reconcileCourseMonitoringLifecycle
} from "./course-monitoring-backfill";

function course(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Course ${id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    timeZone: "America/New_York",
    isPublic: true,
    bookingMethod: "UNKNOWN",
    automationReason: "NONE",
    automationEligibility: "UNKNOWN",
    bookingAccessMode: "UNKNOWN",
    detectedBookingUrl: null,
    website: "https://course.example",
    detectedPlatform: "UNKNOWN",
    providerFamilyKey: "SOURCE_MISSING",
    monitoringStatus: null,
    supportIncident: null,
    probes: [],
    ...overrides
  };
}

describe("course monitoring backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.teeSearch.aggregate.mockResolvedValue({
      _count: { id: 0 },
      _min: { date: null }
    });
    prismaMocks.courseMonitoringEvent.findMany.mockResolvedValue([]);
    prismaMocks.$transaction.mockImplementation(
      async (callback: (transaction: typeof transactionMocks) => Promise<unknown>) =>
        callback(transactionMocks)
    );
    transactionMocks.courseMonitoringStatus.findUnique.mockReset();
    transactionMocks.courseMonitoringStatus.updateMany.mockReset();
    transactionMocks.courseSupportIncident.findUnique.mockReset();
    transactionMocks.courseMonitoringEvent.create.mockReset();
  });

  it("reports a dry run without inventing events or reopening human finals", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      course("manual", {
        bookingMethod: "PHONE_ONLY",
        automationReason: "NO_ONLINE_BOOKING"
      }),
      course("reader", {
        detectedBookingUrl: "https://grassyhill.cps.golf/"
      }),
      course("human-final", {
        automationEligibility: "BLOCKED",
        automationReason: "CAPTCHA_OR_QUEUE",
        bookingAccessMode: "CAPTCHA_OR_QUEUE",
        supportIncident: {
          id: "incident-human",
          status: "RESOLVED",
          resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
          confirmedAt: new Date("2026-07-20T00:00:00.000Z")
        }
      })
    ]);

    await expect(
      backfillCourseMonitoringLifecycle({
        apply: false,
        now: new Date("2026-07-27T12:00:00.000Z")
      })
    ).resolves.toMatchObject({
      apply: false,
      coursesScanned: 3,
      statusesToCreate: 3,
      baselineEventsToCreate: 3,
      technicalRowsToReopen: 0,
      incidentsToCreate: 1,
      readerCandidateIncidentsToCreate: 1,
      manualFinalsPreserved: 1,
      technicalFinalsPreserved: 1,
      identityFinalsPreserved: 0,
      applied: {
        statusesCreated: 0,
        baselineEventsCreated: 0,
        technicalRowsReopened: 0,
        incidentsCreated: 0,
        incidentsConfirmed: 0
      }
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("counts existing unconfirmed work for explicit confirmation", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      course("open", {
        supportIncident: {
          id: "incident-open",
          status: "AUTO_INVESTIGATING",
          resolution: null,
          confirmedAt: null,
          occurrenceCount: 2,
          failureFingerprint: "SOURCE_MISSING:UNKNOWN",
          firstSeenAt: new Date("2026-07-25T00:00:00.000Z"),
          lastSeenAt: new Date("2026-07-27T00:00:00.000Z")
        }
      })
    ]);

    await expect(backfillCourseMonitoringLifecycle({ apply: false })).resolves.toMatchObject({
      incidentsToCreate: 0,
      incidentsToConfirm: 1
    });
  });

  it("derives lifecycle state from the authoritative incident outcome", () => {
    expect(
      getIncidentLifecycleState({
        incidentStatus: "NEEDS_HUMAN",
        resolution: null,
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("ENGINEERING_VERIFICATION_NEEDED");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "MONITORING_RESTORED",
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("HEALTHY");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        currentState: "AUTO_INVESTIGATING"
      })
    ).toBe("FINAL_MANUAL");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "HUMAN_VERIFIED_TECHNICAL_LIMITATION",
        currentState: "REVALIDATING_FINAL"
      })
    ).toBe("REVALIDATING_FINAL");
    expect(
      getIncidentLifecycleState({
        incidentStatus: "RESOLVED",
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        currentState: "FINAL_IDENTITY"
      })
    ).toBeNull();
  });

  it("reports lifecycle drift without mutating on a reconciliation dry run", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      {
        id: "needs-human",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "NEEDS_HUMAN", resolution: null }
      },
      {
        id: "restored",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: {
          status: "RESOLVED",
          resolution: "MONITORING_RESTORED"
        }
      },
      {
        id: "aligned",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "AUTO_INVESTIGATING", resolution: null }
      }
    ]);

    await expect(
      reconcileCourseMonitoringLifecycle({
        apply: false,
        actorId: "operator-cli-dry-run"
      })
    ).resolves.toEqual({
      apply: false,
      coursesScanned: 3,
      mismatchesFound: 2,
      transitions: {
        "AUTO_INVESTIGATING->ENGINEERING_VERIFICATION_NEEDED": 1,
        "AUTO_INVESTIGATING->HEALTHY": 1
      },
      applied: 0,
      skippedAfterRefresh: 0
    });
    expect(prismaMocks.$transaction).not.toHaveBeenCalled();
  });

  it("rechecks current revisions and appends an audited event when applying", async () => {
    prismaMocks.course.findMany.mockResolvedValue([
      {
        id: "needs-human",
        monitoringStatus: { state: "AUTO_INVESTIGATING" },
        supportIncident: { status: "NEEDS_HUMAN", resolution: null }
      }
    ]);
    transactionMocks.courseMonitoringStatus.findUnique.mockResolvedValue({
      courseId: "needs-human",
      state: "AUTO_INVESTIGATING",
      revision: 4
    });
    transactionMocks.courseSupportIncident.findUnique.mockResolvedValue({
      id: "incident-human",
      courseId: "needs-human",
      cycle: 2,
      revision: 7,
      status: "NEEDS_HUMAN",
      resolution: null,
      failureFingerprint: "SOURCE_MISSING:MISSING_SOURCE",
      nextAttemptAt: new Date("2026-07-29T18:00:00.000Z"),
      resolvedAt: null
    });
    transactionMocks.courseMonitoringStatus.updateMany.mockResolvedValue({
      count: 1
    });
    transactionMocks.courseMonitoringEvent.create.mockResolvedValue({
      id: "event-1"
    });

    await expect(
      reconcileCourseMonitoringLifecycle({
        apply: true,
        actorId: "operator-test",
        now: new Date("2026-07-29T17:45:00.000Z")
      })
    ).resolves.toMatchObject({
      mismatchesFound: 1,
      applied: 1,
      skippedAfterRefresh: 0
    });
    expect(transactionMocks.courseMonitoringStatus.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          courseId: "needs-human",
          revision: 4,
          state: "AUTO_INVESTIGATING"
        },
        data: expect.objectContaining({
          state: "ENGINEERING_VERIFICATION_NEEDED",
          revision: { increment: 1 }
        })
      })
    );
    expect(transactionMocks.courseMonitoringEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "STATE_CHANGED",
          source: "OPERATOR_CLI",
          fromState: "AUTO_INVESTIGATING",
          toState: "ENGINEERING_VERIFICATION_NEEDED",
          operatorActorId: "operator-test"
        })
      })
    );
  });
});
