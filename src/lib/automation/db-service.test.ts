import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeHourlyImprovementRun,
  markMissingMatchesUnavailable,
  recordCourseProbeIfChanged,
  recordTeeTimeMatch,
  updateHourlyImprovementRunState
} from "./db-service";
import {
  buildHourlyImprovementRunProvenance,
  buildImprovementCheckpoints,
  type HourlyImprovementRunRecord
} from "./improvement";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teeTimeMatch: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn()
    },
    courseProbe: {
      create: vi.fn(),
      findFirst: vi.fn()
    },
    automationRun: {
      updateMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma);

function buildHourlyRecord(): HourlyImprovementRunRecord {
  return {
    schemaVersion: 1,
    automationId: "teetimeai-hourly-product-improvement-loop",
    promptVersion: "tee-time-spot-improvement-loop-v8",
    lifecycle: "candidate_selected",
    owner: {
      runId: "run-hourly-1",
      threadId: "thread-hourly-1"
    },
    provenance: buildHourlyImprovementRunProvenance({
      ownerRunId: "run-hourly-1",
      ownerThreadId: "thread-hourly-1",
      branch: "automation/hourly-20260713-120000",
      startingSha: "0123456789abcdef0123456789abcdef01234567",
      plannedPaths: ["src/lib/automation/improvement.ts"]
    }),
    checkpoints: buildImprovementCheckpoints({
      queueConfirmed: true,
      candidateSelected: true,
      provenanceRecorded: true
    })
  };
}

describe("hourly improvement durable state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.automationRun.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("refuses to persist outcome_recorded before closeout", async () => {
    const record = buildHourlyRecord();
    record.checkpoints.outcome_recorded = true;

    await expect(updateHourlyImprovementRunState("run-hourly-1", record)).rejects.toThrow(
      "outcome_recorded may only become true"
    );
    expect(mockedPrisma.automationRun.updateMany).not.toHaveBeenCalled();
  });

  it("sets completedAt, terminal outcome, and outcome_recorded atomically", async () => {
    await closeHourlyImprovementRun("run-hourly-1", {
      outcome: "success",
      record: buildHourlyRecord(),
      changedFiles: ["src/lib/automation/improvement.ts"]
    });

    expect(mockedPrisma.automationRun.updateMany).toHaveBeenCalledTimes(1);
    const update = mockedPrisma.automationRun.updateMany.mock.calls[0]?.[0];
    expect(update?.data).toMatchObject({
      completedAt: expect.any(Date),
      outcome: "success",
      changedFiles: ["src/lib/automation/improvement.ts"]
    });
    expect(JSON.parse(String(update?.data.notes))).toMatchObject({
      lifecycle: "closeout",
      checkpoints: { outcome_recorded: true }
    });
  });
});

describe("recordTeeTimeMatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    mockedPrisma.teeTimeMatch.upsert.mockResolvedValue({ id: "match-1" } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not re-alert a tee time that briefly disappears and returns", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:45:00.000Z")
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book"
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({ alertStatus: "PENDING" })
      })
    );
  });

  it("re-alerts a tee time that returns after being absent for 30 minutes", async () => {
    mockedPrisma.teeTimeMatch.findUnique.mockResolvedValue({
      availabilityStatus: "GONE",
      unavailableAt: new Date("2026-07-10T11:30:00.000Z")
    } as never);

    await recordTeeTimeMatch({
      searchId: "search-1",
      courseId: "course-1",
      sourceId: "slot-1",
      startsAt: new Date("2026-07-11T12:00:00.000Z"),
      availableSpots: 4,
      bookingUrl: "https://example.com/book"
    });

    expect(mockedPrisma.teeTimeMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ alertStatus: "PENDING", sentAt: null })
      })
    );
  });
});

describe("markMissingMatchesUnavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.$transaction.mockResolvedValue([{ count: 1 }, { count: 1 }] as never);
  });

  it("suppresses pending alerts when their tee times disappear", async () => {
    await markMissingMatchesUnavailable({
      searchId: "search-1",
      courseId: "course-1",
      date: "2026-07-11",
      timeZone: "America/New_York",
      confirmedMatches: [
        {
          sourceId: "foreup-6654-2026-07-11 08:00",
          startsAt: new Date("2026-07-11T12:00:00.000Z")
        }
      ]
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: "PENDING",
          startsAt: {
            gte: new Date("2026-07-11T04:00:00.000Z"),
            lt: new Date("2026-07-12T04:00:00.000Z")
          },
          NOT: [
            {
              sourceId: "foreup-6654-2026-07-11 08:00",
              startsAt: new Date("2026-07-11T12:00:00.000Z")
            }
          ]
        }),
        data: expect.objectContaining({
          alertStatus: "SUPPRESSED",
          availabilityStatus: "GONE"
        })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: { not: "PENDING" }
        }),
        data: expect.not.objectContaining({
          alertStatus: expect.anything()
        })
      })
    );
    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
  });
});

describe("recordCourseProbeIfChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.courseProbe.create.mockResolvedValue({ id: "new-probe" } as never);
  });

  it("does not write the same Fairview policy block every five minutes", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).not.toHaveBeenCalled();
  });

  it("records a transition from adapter work to a policy block", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "NEEDS_ADAPTER",
      message: "No supported adapter yet for UNKNOWN"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });

  it("records a changed policy reason", async () => {
    mockedPrisma.courseProbe.findFirst.mockResolvedValue({
      id: "existing-probe",
      outcome: "BLOCKED_POLICY",
      message: "Older policy reason"
    } as never);

    await recordCourseProbeIfChanged({
      searchId: "search-1",
      courseId: "fairview-farm",
      outcome: "BLOCKED_POLICY",
      message: "Course is explicitly marked as blocked for automation."
    });

    expect(mockedPrisma.courseProbe.create).toHaveBeenCalledOnce();
  });
});
