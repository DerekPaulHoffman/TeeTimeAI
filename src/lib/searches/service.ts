import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { TeeSearchInput } from "@/lib/validation/search";
import { parseLocalDate } from "@/lib/validation/search";

export async function createTeeSearchForUser(userId: string, input: TeeSearchInput) {
  const sortedCourses = [...input.courses].sort((a, b) => a.rank - b.rank);

  return prisma.teeSearch.create({
    data: {
      userId,
      date: parseLocalDate(input.date),
      startTime: input.startTime,
      endTime: input.endTime,
      players: input.players,
      cadenceMinutes: input.cadenceMinutes,
      preferences: {
        create: sortedCourses.map((course) => ({
          rank: course.rank,
          course: {
            connectOrCreate: {
              where: {
                googlePlaceId: course.googlePlaceId ?? `manual-${course.name}-${course.latitude}-${course.longitude}`
              },
              create: {
                googlePlaceId: course.googlePlaceId,
                name: course.name,
                address: course.address,
                latitude: course.latitude,
                longitude: course.longitude,
                rating: course.rating,
                phone: course.phone,
                website: course.website,
                photoName: course.photoName,
                isManual: !course.googlePlaceId
              }
            }
          }
        }))
      }
    },
    include: searchInclude
  });
}

export async function listTeeSearchesForUser(userId: string) {
  return prisma.teeSearch.findMany({
    where: { userId },
    orderBy: [{ status: "asc" }, { date: "asc" }, { createdAt: "desc" }],
    include: searchInclude
  });
}

export async function updateTeeSearchStatusForUser(
  userId: string,
  searchId: string,
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED"
) {
  return prisma.teeSearch.update({
    where: {
      id: searchId,
      userId
    },
    data: { status },
    include: searchInclude
  });
}

export const searchInclude = {
  preferences: {
    orderBy: { rank: "asc" },
    include: { course: true }
  },
  matches: {
    orderBy: { startsAt: "asc" },
    include: { course: true }
  },
  probes: {
    orderBy: { observedAt: "desc" },
    take: 5,
    include: { course: true }
  }
} satisfies Prisma.TeeSearchInclude;
