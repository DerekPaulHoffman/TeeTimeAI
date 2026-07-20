import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  applyPendingClerkEmailForSearch,
  applyPendingClerkEmailForUser,
  recoverPendingClerkEmailUpdates
} from "./pending-email";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    user: {
      findMany: vi.fn(),
      update: vi.fn()
    },
    teeSearch: {
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    searchEmailDelivery: {
      findFirst: vi.fn(),
      updateMany: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const now = new Date("2026-07-20T15:00:00.000Z");

function pendingUser() {
  return {
    id: "user-1",
    clerkUserId: "clerk-1",
    email: "old@example.com",
    clerkUserUpdatedAt: new Date("2026-07-20T14:59:00.000Z"),
    pendingEmail: "new@example.com",
    pendingEmailObservedAt: new Date("2026-07-20T14:59:00.000Z"),
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z")
  };
}

describe("pending Clerk email recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (worker) =>
      (worker as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 0 } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("keeps a pending email while any owned search has an unexpired claim", async () => {
    const retryAt = new Date("2026-07-20T15:05:00.000Z");
    const callOrder: string[] = [];
    mockedPrisma.$queryRaw
      .mockImplementationOnce(async () => {
        callOrder.push("lock-user");
        return [pendingUser()] as never;
      })
      .mockImplementationOnce(async () => {
        callOrder.push("lock-searches");
        return [{ id: "search-1" }] as never;
      });
    mockedPrisma.searchEmailDelivery.findFirst.mockImplementation(async () => {
      callOrder.push("find-claim");
      return { claimExpiresAt: retryAt } as never;
    });

    await expect(
      applyPendingClerkEmailForUser(prisma, { userId: "user-1", now })
    ).resolves.toEqual({ outcome: "deferred", retryAt });

    expect(callOrder).toEqual(["lock-user", "lock-searches", "find-claim"]);
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "WAITING",
        nextCheckAt: retryAt,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: now
      }
    });
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("revokes a live pre-release check before applying the new owner email", async () => {
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([pendingUser()] as never)
      .mockResolvedValueOnce([
        {
          id: "search-1",
          checkLeaseToken: "old-runtime-check",
          checkLeaseExpiresAt: new Date("2026-07-20T15:10:00.000Z")
        }
      ] as never);
    mockedPrisma.user.update.mockResolvedValue({} as never);

    await expect(
      applyPendingClerkEmailForUser(prisma, { userId: "user-1", now })
    ).resolves.toEqual({ outcome: "applied" });
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: now,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null
      }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        email: "new@example.com",
        pendingEmail: null,
        pendingEmailObservedAt: null
      }
    });
  });

  it("terminalizes expired claims as ambiguous before promoting the pending email", async () => {
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([pendingUser()] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 1 } as never);
    mockedPrisma.user.update.mockResolvedValue({} as never);

    await expect(
      applyPendingClerkEmailForUser(prisma, { userId: "user-1", now })
    ).resolves.toEqual({ outcome: "applied" });

    expect(mockedPrisma.searchEmailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        teeSearchId: { in: ["search-1"] },
        status: "SENDING",
        OR: [{ claimExpiresAt: null }, { claimExpiresAt: { lte: now } }]
      },
      data: {
        status: "FAILED",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: now,
        lastError: "DELIVERY_OUTCOME_UNKNOWN_AFTER_OWNER_EMAIL_CHANGE"
      }
    });
    expect(
      mockedPrisma.searchEmailDelivery.updateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(mockedPrisma.user.update.mock.invocationCallOrder[0]);
  });

  it("applies and clears a pending email when no live claim remains", async () => {
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([pendingUser()] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never);
    mockedPrisma.user.update.mockResolvedValue({
      ...pendingUser(),
      email: "new@example.com",
      pendingEmail: null,
      pendingEmailObservedAt: null
    } as never);

    await expect(
      applyPendingClerkEmailForUser(prisma, { userId: "user-1", now })
    ).resolves.toEqual({ outcome: "applied" });

    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        email: "new@example.com",
        pendingEmail: null,
        pendingEmailObservedAt: null
      }
    });
  });

  it("resolves a search owner and applies its pending email in one transaction", async () => {
    mockedPrisma.teeSearch.findUnique.mockResolvedValue({ userId: "user-1" } as never);
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([pendingUser()] as never)
      .mockResolvedValueOnce([] as never);
    mockedPrisma.user.update.mockResolvedValue({} as never);

    await expect(
      applyPendingClerkEmailForSearch({ searchId: "search-1", now })
    ).resolves.toEqual({ outcome: "applied" });

    expect(mockedPrisma.teeSearch.findUnique).toHaveBeenCalledWith({
      where: { id: "search-1" },
      select: { userId: true }
    });
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a search that no longer exists", async () => {
    mockedPrisma.teeSearch.findUnique.mockResolvedValue(null);

    await expect(
      applyPendingClerkEmailForSearch({ searchId: "missing", now })
    ).resolves.toEqual({ outcome: "none" });

    expect(mockedPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("bounds each recovery sweep and accounts for independent outcomes", async () => {
    mockedPrisma.user.findMany.mockResolvedValue([
      { id: "user-1" },
      { id: "user-2" }
    ] as never);
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([pendingUser()] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never)
      .mockResolvedValueOnce([{ ...pendingUser(), id: "user-2" }] as never)
      .mockResolvedValueOnce([{ id: "search-2" }] as never);
    mockedPrisma.searchEmailDelivery.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        claimExpiresAt: new Date("2026-07-20T15:05:00.000Z")
      } as never);
    mockedPrisma.user.update.mockResolvedValue({} as never);

    await expect(
      recoverPendingClerkEmailUpdates({ now, limit: 1_000 })
    ).resolves.toEqual({
      considered: 2,
      applied: 1,
      deferred: 1,
      failed: 0
    });

    expect(mockedPrisma.user.findMany).toHaveBeenCalledWith({
      where: { pendingEmail: { not: null } },
      orderBy: [{ pendingEmailObservedAt: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true }
    });
  });
});
