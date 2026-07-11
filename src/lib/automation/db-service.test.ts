import { beforeEach, describe, expect, it, vi } from "vitest";

import { markMissingMatchesUnavailable, recordCourseProbeIfChanged } from "./db-service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teeTimeMatch: {
      updateMany: vi.fn()
    },
    courseProbe: {
      create: vi.fn(),
      findFirst: vi.fn()
    },
    $transaction: vi.fn()
  }
}));

import { prisma } from "@/lib/prisma";

const mockedPrisma = vi.mocked(prisma);

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
