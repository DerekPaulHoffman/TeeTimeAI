import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { upsertClerkUser, upsertGuestUser } from "./service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    user: {
      findUnique: vi.fn(),
      upsert: vi.fn()
    },
    teeSearch: {
      updateMany: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("user ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (worker) =>
      (worker as (transaction: typeof prisma) => Promise<unknown>)(prisma)
    );
  });

  it("moves guest alerts into the Clerk account with the same normalized email", async () => {
    mockedPrisma.user.upsert.mockResolvedValue({
      id: "clerk-user",
      clerkUserId: "user_clerk",
      email: "golfer@example.com"
    } as never);
    mockedPrisma.user.findUnique.mockResolvedValue({ id: "guest-user" } as never);
    mockedPrisma.teeSearch.updateMany.mockResolvedValue({ count: 2 });

    const user = await upsertClerkUser({
      clerkUserId: "user_clerk",
      email: " Golfer@Example.com "
    });

    expect(user.id).toBe("clerk-user");
    expect(mockedPrisma.user.upsert).toHaveBeenCalledWith({
      where: { clerkUserId: "user_clerk" },
      update: { email: "golfer@example.com" },
      create: {
        clerkUserId: "user_clerk",
        email: "golfer@example.com"
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
    mockedPrisma.user.upsert.mockResolvedValue({ id: "clerk-user" } as never);
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await upsertClerkUser({ clerkUserId: "user_clerk", email: "golfer@example.com" });

    expect(mockedPrisma.teeSearch.updateMany).not.toHaveBeenCalled();
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
