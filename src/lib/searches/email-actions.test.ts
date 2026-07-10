import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { stopTeeSearchFromEmail } from "./email-actions";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    teeSearch: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    teeTimeMatch: {
      updateMany: vi.fn()
    },
    websiteEvent: {
      create: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("stopTeeSearchFromEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback) =>
      (callback as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
  });

  it("marks a booked search complete and stops every future notification path", async () => {
    mockedPrisma.teeSearch.findUnique.mockResolvedValue({
      id: "search-1",
      status: "ACTIVE"
    } as never);
    mockedPrisma.teeSearch.update.mockResolvedValue({
      id: "search-1",
      status: "COMPLETED"
    } as never);
    mockedPrisma.teeTimeMatch.updateMany.mockResolvedValue({ count: 2 } as never);
    mockedPrisma.websiteEvent.create.mockResolvedValue({ id: "event-1" } as never);

    await expect(stopTeeSearchFromEmail("search-1", "booked")).resolves.toEqual({
      id: "search-1",
      status: "COMPLETED",
      changed: true
    });
    expect(mockedPrisma.teeSearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "search-1" },
        data: expect.objectContaining({
          status: "COMPLETED",
          checkStatus: "STOPPED",
          nextCheckAt: null,
          workflowRunId: null,
          scheduleVersion: { increment: 1 }
        })
      })
    );
    expect(mockedPrisma.teeTimeMatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { teeSearchId: "search-1", alertStatus: "PENDING" },
        data: expect.objectContaining({ alertStatus: "SUPPRESSED" })
      })
    );
    expect(mockedPrisma.websiteEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "search_stopped_booked" })
      })
    );
  });

  it("leaves an already-cancelled search unchanged", async () => {
    mockedPrisma.teeSearch.findUnique.mockResolvedValue({
      id: "search-1",
      status: "CANCELLED"
    } as never);

    await expect(stopTeeSearchFromEmail("search-1", "cancelled")).resolves.toEqual({
      id: "search-1",
      status: "CANCELLED",
      changed: false
    });
    expect(mockedPrisma.teeSearch.update).not.toHaveBeenCalled();
    expect(mockedPrisma.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });
});
