import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { createTeeSearchForUser } from "./service";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    course: {
      findFirst: vi.fn(),
      findUnique: vi.fn()
    },
    teeSearch: {
      create: vi.fn()
    }
  }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("createTeeSearchForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects demo selections to an existing supported nearby course", async () => {
    mockedPrisma.course.findFirst.mockResolvedValue({ id: "foreup-course-1" });
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
          googlePlaceId: "tashua-knolls",
          name: "Tashua Knolls Golf Course",
          address: "40 Tashua Knolls Ln, Trumbull, CT",
          latitude: 41.242,
          longitude: -73.209,
          rank: 1
        }
      ]
    });

    expect(mockedPrisma.course.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: "Tashua Knolls Golf Course",
          detectedPlatform: { not: "UNKNOWN" },
          automationEligibility: "ALLOWED"
        })
      })
    );
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

  it("uses a stable manual place key when creating manual courses", async () => {
    mockedPrisma.course.findFirst.mockResolvedValue(null);
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
});
