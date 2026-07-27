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

vi.mock("@/lib/prisma", () => ({ prisma: prismaMocks }));

import { backfillCourseMonitoringLifecycle } from "./course-monitoring-backfill";

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
});
