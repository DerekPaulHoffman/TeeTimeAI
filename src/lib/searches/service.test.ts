import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import {
  createTeeSearchForUser,
  updateTeeSearchForUser,
  updateTeeSearchStatusForUser
} from "./service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    course: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn()
    },
    coursePreference: {
      updateMany: vi.fn()
    },
    teeSearch: {
      count: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("createTeeSearchForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.course.findMany.mockResolvedValue([]);
    mockedPrisma.course.update.mockResolvedValue({ id: "course-1" } as never);
    mockedPrisma.teeSearch.count.mockResolvedValue(0);
  });

  it("connects demo selections to an existing supported nearby course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      { id: "foreup-course-1", name: "Tashua Knolls Golf Course" }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({ id: "search-1" } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      userTimeZone: "America/Los_Angeles",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      additionalEmails: ["FRIEND@example.com", "friend@example.com"],
      courses: [
        {
          googlePlaceId: "tashua-knolls",
          name: "Tashua Knolls Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.242,
          longitude: -73.209,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          detectedPlatform: { not: "UNKNOWN" },
          automationEligibility: "ALLOWED"
        })
      })
    );
    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          additionalEmails: ["friend@example.com"],
          userTimeZone: "America/Los_Angeles",
          preferences: {
            create: [
              {
                rank: 1,
                course: {
                  connect: { id: "foreup-course-1" }
                }
              }
            ]
          }
        })
      })
    );
  });

  it("connects composite Google facility names to an existing supported nearby course", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      { id: "foreup-course-1", name: "Tashua Knolls Golf Course" }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({ id: "search-1" } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "tashua-knolls-and-glen",
          name: "Tashua Knolls & Tashua Glen Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.2888889,
          longitude: -73.2494444,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              {
                rank: 1,
                course: {
                  connect: { id: "foreup-course-1" }
                }
              }
            ]
          }
        })
      })
    );
  });

  it("does not connect unrelated nearby supported courses", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([
      { id: "foreup-course-1", name: "Tashua Knolls Golf Course" }
    ]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({ id: "search-1" } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "oak-hills",
          name: "Oak Hills Park Golf Course",
          address: "165 Fillow St, Norwalk, CT",
          latitude: 41.242,
          longitude: -73.209,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: {
                      googlePlaceId: "oak-hills"
                    }
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("uses a stable manual place key when creating manual courses", async () => {
    mockedPrisma.course.findMany.mockResolvedValue([]);
    mockedPrisma.course.findUnique.mockResolvedValue(null);
    mockedPrisma.teeSearch.create.mockResolvedValue({ id: "search-1" } as never);

    await createTeeSearchForUser("user-1", {
      date: "2026-08-15",
      startTime: "13:00",
      endTime: "17:00",
      players: 2,
      cadenceMinutes: 15,
      alertEmail: "golfer@example.com",
      courses: [
        {
          name: "Manual Public Course",
          latitude: 41.2,
          longitude: -73.2,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.teeSearch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          preferences: {
            create: [
              expect.objectContaining({
                course: {
                  connectOrCreate: expect.objectContaining({
                    where: {
                      googlePlaceId: "manual-Manual Public Course-41.2--73.2"
                    },
                    create: expect.objectContaining({
                      googlePlaceId: "manual-Manual Public Course-41.2--73.2",
                      isManual: true
                    })
                  })
                }
              })
            ]
          }
        })
      })
    );
  });

  it("rejects a fourth queued search for the same user", async () => {
    mockedPrisma.teeSearch.count.mockResolvedValue(3);

    await expect(
      createTeeSearchForUser("user-1", {
        date: "2026-08-15",
        startTime: "13:00",
        endTime: "17:00",
        players: 2,
        cadenceMinutes: 15,
        alertEmail: "golfer@example.com",
        courses: [
          {
            googlePlaceId: "tashua-knolls",
            name: "Tashua Knolls Golf Course",
            latitude: 41.242,
            longitude: -73.209,
            rank: 1
          }
        ]
      })
    ).rejects.toThrow("You can keep up to 3 active or paused searches in the queue.");

    expect(mockedPrisma.teeSearch.create).not.toHaveBeenCalled();
  });
});

describe("updateTeeSearchStatusForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.teeSearch.count.mockResolvedValue(0);
  });

  it("excludes the current search when enforcing queue capacity on resume", async () => {
    mockedPrisma.teeSearch.update.mockResolvedValue({ id: "search-1" } as never);

    await updateTeeSearchStatusForUser("user-1", "search-1", "ACTIVE");

    expect(mockedPrisma.teeSearch.count).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: { in: ["ACTIVE", "PAUSED"] },
        id: { not: "search-1" }
      }
    });
    expect(mockedPrisma.teeSearch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "ACTIVE" }
      })
    );
  });
});

describe("updateTeeSearchForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (operations) =>
      Promise.all(operations as Array<Promise<unknown>>)
    );
    mockedPrisma.teeSearch.findUniqueOrThrow
      .mockResolvedValueOnce({ id: "search-1" } as never)
      .mockResolvedValueOnce({ id: "search-1", preferences: [] } as never);
    mockedPrisma.coursePreference.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("reorders course preferences without colliding with existing ranks", async () => {
    await updateTeeSearchForUser("user-1", "search-1", {
      coursePreferences: [
        { id: "pref-b", rank: 1 },
        { id: "pref-a", rank: 2 }
      ]
    });

    expect(mockedPrisma.teeSearch.findUniqueOrThrow).toHaveBeenNthCalledWith(1, {
      where: { id: "search-1", userId: "user-1" },
      select: { id: true }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "pref-b", teeSearchId: "search-1" },
      data: { rank: -1 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "pref-a", teeSearchId: "search-1" },
      data: { rank: -2 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(3, {
      where: { id: "pref-b", teeSearchId: "search-1" },
      data: { rank: 1 }
    });
    expect(mockedPrisma.coursePreference.updateMany).toHaveBeenNthCalledWith(4, {
      where: { id: "pref-a", teeSearchId: "search-1" },
      data: { rank: 2 }
    });
  });
});
