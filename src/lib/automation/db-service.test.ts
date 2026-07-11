import { beforeEach, describe, expect, it, vi } from "vitest";

import { markMissingMatchesUnavailable } from "./db-service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    teeTimeMatch: {
      updateMany: vi.fn()
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
          sourceId: "still-available",
          startsAt: new Date("2026-07-11T12:00:00.000Z")
        }
      ]
    });

    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          alertStatus: "PENDING",
          NOT: [
            {
              sourceId: "still-available",
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
