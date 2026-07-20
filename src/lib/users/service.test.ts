import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { upsertClerkUser, upsertGuestUser } from "./service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn()
    },
    searchEmailDelivery: {
      findFirst: vi.fn(),
      updateMany: vi.fn()
    },
    teeSearch: {
      findUnique: vi.fn(),
      updateMany: vi.fn()
    },
    $queryRaw: vi.fn()
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });
const observedAt = new Date("2026-07-20T15:00:00.000Z");

function lockedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "clerk-user",
    clerkUserId: "user_clerk",
    email: "old@example.com",
    clerkUserUpdatedAt: new Date("2026-07-20T14:00:00.000Z"),
    pendingEmail: null,
    pendingEmailObservedAt: null,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides
  };
}

describe("user ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(observedAt);
    vi.resetAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (worker) =>
      (worker as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue(null);
    mockedPrisma.searchEmailDelivery.updateMany.mockResolvedValue({ count: 0 } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves guest alerts into a newly persisted Clerk account", async () => {
    const user = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([user] as never);
    mockedPrisma.user.upsert.mockResolvedValue(user as never);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "guest-user" } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: " Golfer@Example.com ",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(user);

    expect(mockedPrisma.user.upsert).toHaveBeenCalledWith({
      where: { clerkUserId: "user_clerk" },
      update: {},
      create: {
        clerkUserId: "user_clerk",
        email: "golfer@example.com",
        clerkUserUpdatedAt: observedAt
      }
    });
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { clerkUserId: "guest:golfer@example.com" },
      select: { id: true }
    });
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { userId: "guest-user" },
      data: { userId: "clerk-user" }
    });
  });

  it("does not move alerts when there is no guest record for the email", async () => {
    const user = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([user] as never);
    mockedPrisma.user.upsert.mockResolvedValue(user as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await upsertClerkUser({
      clerkUserId: "user_clerk",
      email: "golfer@example.com",
      clerkUpdatedAt: observedAt
    });

    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it("locks the User and then every owned search before applying an email change", async () => {
    const callOrder: string[] = [];
    const existingUser = lockedUser();
    const updatedUser = lockedUser({
      email: "new@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockImplementationOnce(async () => {
        callOrder.push("lock-user");
        return [existingUser] as never;
      })
      .mockImplementationOnce(async () => {
        callOrder.push("lock-searches");
        return [{ id: "search-1" }, { id: "search-2" }] as never;
      });
    mockedPrisma.searchEmailDelivery.findFirst.mockImplementation(async () => {
      callOrder.push("find-active-claim");
      return null;
    });
    mockedPrisma.teeSearch.updateMany.mockImplementationOnce(async () => {
      callOrder.push("fence-searches");
      return { count: 2 };
    });
    mockedPrisma.user.update.mockImplementation(async () => {
      callOrder.push("update-user");
      return updatedUser as never;
    });
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "new@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(updatedUser);

    expect(callOrder).toEqual([
      "lock-user",
      "lock-searches",
      "find-active-claim",
      "fence-searches",
      "update-user"
    ]);
    expect(mockedPrisma.searchEmailDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        teeSearchId: { in: ["search-1", "search-2"] },
        status: "SENDING",
        claimExpiresAt: { gt: observedAt }
      },
      orderBy: [{ claimExpiresAt: "desc" }, { id: "asc" }],
      select: { claimExpiresAt: true }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: {
        email: "new@example.com",
        clerkUserUpdatedAt: observedAt,
        pendingEmail: null,
        pendingEmailObservedAt: null
      }
    });
  });

  it("commits the newest pending email before reporting an active delivery conflict", async () => {
    const retryAt = new Date("2026-07-20T15:05:00.000Z");
    const existingUser = lockedUser();
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([existingUser] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never);
    mockedPrisma.searchEmailDelivery.findFirst.mockResolvedValue({ claimExpiresAt: retryAt } as never);
    mockedPrisma.user.update.mockResolvedValue({
      ...existingUser,
      pendingEmail: "new@example.com",
      pendingEmailObservedAt: observedAt,
      clerkUserUpdatedAt: observedAt
    } as never);

    const request = upsertClerkUser({
      clerkUserId: "user_clerk",
      email: " New@Example.com ",
      clerkUpdatedAt: observedAt
    });

    await expect(request).rejects.toMatchObject({
      name: "SearchEmailDeliveryInProgressError",
      retryable: true,
      retryAt
    });
    await expect(request).rejects.toBeInstanceOf(SearchEmailDeliveryInProgressError);
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "WAITING",
        nextCheckAt: retryAt,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: observedAt
      }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: {
        pendingEmail: "new@example.com",
        pendingEmailObservedAt: observedAt,
        clerkUserUpdatedAt: observedAt
      }
    });
    expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("revokes a live pre-release search check before applying an email change", async () => {
    const existingUser = lockedUser();
    const updatedUser = lockedUser({
      email: "new@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([existingUser] as never)
      .mockResolvedValueOnce([
        {
          id: "search-1",
          checkLeaseToken: "old-runtime-check",
          checkLeaseExpiresAt: new Date("2026-07-20T15:10:00.000Z")
        }
      ] as never);
    mockedPrisma.user.update.mockResolvedValue(updatedUser as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "new@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(updatedUser);

    expect(mockedPrisma.searchEmailDelivery.findFirst).toHaveBeenCalledOnce();
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: observedAt,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null
      }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledOnce();
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: {
        email: "new@example.com",
        clerkUserUpdatedAt: observedAt,
        pendingEmail: null,
        pendingEmailObservedAt: null
      }
    });
  });

  it("does not let a stale Clerk worker replace a newer pending email", async () => {
    const newerClerkVersion = new Date("2026-07-20T15:01:00.000Z");
    const existingUser = lockedUser({
      pendingEmail: "newest@example.com",
      pendingEmailObservedAt: newerClerkVersion,
      clerkUserUpdatedAt: newerClerkVersion
    });
    mockedPrisma.$queryRaw.mockResolvedValueOnce([existingUser] as never);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "old@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(existingUser);

    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.findFirst).not.toHaveBeenCalled();
  });

  it("does not let a stale Clerk worker revert an already applied email", async () => {
    const newerClerkVersion = new Date("2026-07-20T15:01:00.000Z");
    const existingUser = lockedUser({
      email: "newest@example.com",
      clerkUserUpdatedAt: newerClerkVersion
    });
    mockedPrisma.$queryRaw.mockResolvedValueOnce([existingUser] as never);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "old@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(existingUser);

    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(mockedPrisma.searchEmailDelivery.findFirst).not.toHaveBeenCalled();
  });

  it("clears a stale pending value when Clerk has returned to the current email", async () => {
    const existingUser = lockedUser({
      email: "golfer@example.com",
      pendingEmail: "stale@example.com",
      pendingEmailObservedAt: new Date("2026-07-20T14:00:00.000Z"),
      clerkUserUpdatedAt: new Date("2026-07-20T14:00:00.000Z")
    });
    const updatedUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([existingUser] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never);
    mockedPrisma.user.update.mockResolvedValue(updatedUser as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "golfer@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(updatedUser);

    expect(mockedPrisma.searchEmailDelivery.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: observedAt,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null
      }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: {
        email: "golfer@example.com",
        clerkUserUpdatedAt: observedAt,
        pendingEmail: null,
        pendingEmailObservedAt: null
      }
    });
  });

  it("advances a same-email Clerk watermark before rejecting an older different email", async () => {
    const originalClerkVersion = new Date("2026-07-20T14:00:00.000Z");
    const staleDifferentVersion = new Date("2026-07-20T14:30:00.000Z");
    const latestSameEmailVersion = new Date("2026-07-20T15:00:00.000Z");
    const originalUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: originalClerkVersion
    });
    const advancedUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: latestSameEmailVersion
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([originalUser] as never)
      .mockResolvedValueOnce([advancedUser] as never);
    mockedPrisma.user.update.mockResolvedValue(advancedUser as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "golfer@example.com",
        clerkUpdatedAt: latestSameEmailVersion
      })
    ).resolves.toEqual(advancedUser);
    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "obsolete@example.com",
        clerkUpdatedAt: staleDifferentVersion
      })
    ).resolves.toEqual(advancedUser);

    expect(mockedPrisma.user.update).toHaveBeenCalledOnce();
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: { clerkUserUpdatedAt: latestSameEmailVersion }
    });
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.searchEmailDelivery.findFirst).not.toHaveBeenCalled();
  });

  it("fences active searches when first versioning a legacy same-email user", async () => {
    const existingUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: null
    });
    const updatedUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([existingUser] as never)
      .mockResolvedValueOnce([{ id: "search-1" }] as never);
    mockedPrisma.user.update.mockResolvedValue(updatedUser as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: "golfer@example.com",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(updatedUser);

    expect(mockedPrisma.teeSearch.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["search-1"] }, status: "ACTIVE" },
      data: {
        scheduleVersion: { increment: 1 },
        checkStatus: "QUEUED",
        nextCheckAt: observedAt,
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null
      }
    });
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "clerk-user" },
      data: { clerkUserUpdatedAt: observedAt }
    });
  });

  it("does not lock searches when the persisted Clerk email is already current", async () => {
    const existingUser = lockedUser({
      email: "golfer@example.com",
      clerkUserUpdatedAt: observedAt
    });
    mockedPrisma.$queryRaw.mockResolvedValueOnce([existingUser] as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      upsertClerkUser({
        clerkUserId: "user_clerk",
        email: " GOLFER@example.com ",
        clerkUpdatedAt: observedAt
      })
    ).resolves.toEqual(existingUser);

    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.searchEmailDelivery.findFirst).not.toHaveBeenCalled();
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps signed-out alerts under a normalized guest identity", async () => {
    mockedPrisma.user.upsert.mockResolvedValue({ id: "guest-user" } as never);

    await upsertGuestUser(" Golfer@Example.com ");

    expect(mockedPrisma.user.upsert).toHaveBeenCalledWith({
      where: { clerkUserId: "guest:golfer@example.com" },
      update: { email: "golfer@example.com" },
      create: {
        clerkUserId: "guest:golfer@example.com",
        email: "golfer@example.com"
      }
    });
  });
});
