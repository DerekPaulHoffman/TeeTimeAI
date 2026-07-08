import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { SelectedCourseInput, TeeSearchInput } from "@/lib/validation/search";
import { parseLocalDate } from "@/lib/validation/search";

const COURSE_COORDINATE_TOLERANCE = 0.005;

export async function createTeeSearchForUser(userId: string, input: TeeSearchInput) {
  const sortedCourses = [...input.courses].sort((a, b) => a.rank - b.rank);
  const coursePreferences = await Promise.all(sortedCourses.map(buildCoursePreferenceCreate));

  return prisma.teeSearch.create({
    data: {
      userId,
      date: parseLocalDate(input.date),
      startTime: input.startTime,
      endTime: input.endTime,
      players: input.players,
      cadenceMinutes: input.cadenceMinutes,
      preferences: {
        create: coursePreferences
      }
    },
    include: searchInclude
  });
}

async function buildCoursePreferenceCreate(course: SelectedCourseInput) {
  const reusableCourse = await findReusableCourse(course);

  if (reusableCourse) {
    return {
      rank: course.rank,
      course: {
        connect: { id: reusableCourse.id }
      }
    };
  }

  const placeId = getStablePlaceId(course);

  return {
    rank: course.rank,
    course: {
      connectOrCreate: {
        where: {
          googlePlaceId: placeId
        },
        create: {
          googlePlaceId: placeId,
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
  };
}

async function findReusableCourse(course: SelectedCourseInput) {
  if (course.courseId) {
    const existingById = await prisma.course.findUnique({
      where: { id: course.courseId },
      select: { id: true }
    });

    if (existingById) {
      return existingById;
    }
  }

  const supportedNearbyCourse = await prisma.course.findFirst({
    where: {
      name: course.name,
      latitude: {
        gte: course.latitude - COURSE_COORDINATE_TOLERANCE,
        lte: course.latitude + COURSE_COORDINATE_TOLERANCE
      },
      longitude: {
        gte: course.longitude - COURSE_COORDINATE_TOLERANCE,
        lte: course.longitude + COURSE_COORDINATE_TOLERANCE
      },
      detectedPlatform: {
        not: "UNKNOWN"
      },
      automationEligibility: "ALLOWED"
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true }
  });

  if (supportedNearbyCourse) {
    return supportedNearbyCourse;
  }

  if (!course.googlePlaceId) {
    return null;
  }

  return prisma.course.findUnique({
    where: { googlePlaceId: course.googlePlaceId },
    select: { id: true }
  });
}

function getStablePlaceId(course: SelectedCourseInput) {
  return course.googlePlaceId ?? `manual-${course.name}-${course.latitude}-${course.longitude}`;
}

export async function listTeeSearchesForUser(userId: string) {
  return prisma.teeSearch.findMany({
    where: { userId },
    orderBy: [{ status: "asc" }, { date: "asc" }, { createdAt: "desc" }],
    include: searchInclude
  });
}

export async function listRecentTeeSearches(limit = 20) {
  return prisma.teeSearch.findMany({
    orderBy: [{ status: "asc" }, { date: "asc" }, { createdAt: "desc" }],
    take: limit,
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
