import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getTimeZoneForCoordinates, normalizeTimeZone } from "@/lib/timezones";
import {
  MAX_COURSE_PREFERENCES,
  MAX_QUEUED_SEARCHES_PER_USER,
  type SelectedCourseInput,
  type TeeSearchDetailsInput,
  type TeeSearchInput
} from "@/lib/validation/search";
import { parseLocalDate } from "@/lib/validation/search";

const SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE = 0.06;
const COURSE_NAME_STOP_WORDS = new Set(["and", "course", "golf", "the"]);
const QUEUED_SEARCH_STATUSES = ["ACTIVE", "PAUSED"] as const;
type SearchStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

export type CoursePreferenceRankUpdateInput = {
  id: string;
  rank: number;
};

export type TeeSearchUpdateInput = Partial<TeeSearchDetailsInput> & {
  coursePreferences?: CoursePreferenceRankUpdateInput[];
  status?: SearchStatus;
};

export async function createTeeSearchForUser(userId: string, input: TeeSearchInput) {
  await assertQueueCapacity(userId);

  const sortedCourses = [...input.courses].sort((a, b) => a.rank - b.rank);
  const resolvedPreferences = await Promise.all(sortedCourses.map(buildCoursePreferenceCreate));
  if (resolvedPreferences.every((preference) => preference.automationEligibility === "BLOCKED")) {
    throw new Error(
      "None of the selected courses offers a supported public online tee-time page. Choose at least one course Tee Time Spot can monitor."
    );
  }
  const coursePreferences = resolvedPreferences.map((preference) => preference.create);

  return prisma.teeSearch.create({
    data: {
      userId,
      date: parseLocalDate(input.date),
      startTime: input.startTime,
      endTime: input.endTime,
      userTimeZone: normalizeTimeZone(input.userTimeZone),
      players: input.players,
      cadenceMinutes: input.cadenceMinutes,
      additionalEmails: normalizeAdditionalEmails(input.additionalEmails),
      preferences: {
        create: coursePreferences
      }
    },
    include: searchInclude
  });
}

async function buildCoursePreferenceCreate(course: SelectedCourseInput) {
  const timeZone = getTimeZoneForCoordinates(course.latitude, course.longitude);
  const reusableCourse = await findReusableCourse(course);

  if (reusableCourse) {
    await prisma.course.update({
      where: { id: reusableCourse.id },
      data: { timeZone }
    });
    return {
      automationEligibility: reusableCourse.automationEligibility,
      create: {
        rank: course.rank,
        course: {
          connect: { id: reusableCourse.id }
        }
      }
    };
  }

  const placeId = getStablePlaceId(course);

  return {
    automationEligibility: "UNKNOWN",
    create: {
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
            timeZone,
            rating: course.rating,
            phone: course.phone,
            website: course.website,
            isManual: !course.googlePlaceId
          }
        }
      }
    }
  };
}

async function findReusableCourse(course: SelectedCourseInput) {
  if (course.courseId) {
    const existingById = await prisma.course.findUnique({
      where: { id: course.courseId },
      select: { id: true, automationEligibility: true }
    });

    if (existingById) {
      return existingById;
    }
  }

  const reusableNearbyCourses = await prisma.course.findMany({
    where: {
      latitude: {
        gte: course.latitude - SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
        lte: course.latitude + SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE
      },
      longitude: {
        gte: course.longitude - SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
        lte: course.longitude + SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE
      },
      OR: [
        {
          automationEligibility: "ALLOWED",
          detectedPlatform: { not: "UNKNOWN" }
        },
        { automationEligibility: "BLOCKED" }
      ]
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, automationEligibility: true }
  });
  const supportedNearbyCourse = reusableNearbyCourses.find(
    (candidate) =>
      candidate.automationEligibility === "ALLOWED" &&
      hasMeaningfulNameOverlap(course.name, candidate.name)
  );

  if (supportedNearbyCourse) {
    return supportedNearbyCourse;
  }

  if (course.googlePlaceId) {
    const exactCourse = await prisma.course.findUnique({
      where: { googlePlaceId: course.googlePlaceId },
      select: { id: true, automationEligibility: true }
    });
    if (exactCourse) {
      return exactCourse;
    }
  }

  return reusableNearbyCourses.find(
    (candidate) =>
      candidate.automationEligibility === "BLOCKED" &&
      hasMeaningfulNameOverlap(course.name, candidate.name)
  ) ?? null;
}

function getStablePlaceId(course: SelectedCourseInput) {
  return course.googlePlaceId ?? `manual-${course.name}-${course.latitude}-${course.longitude}`;
}

function hasMeaningfulNameOverlap(selectedName: string, existingName: string) {
  const selectedTokens = getMeaningfulNameTokens(selectedName);
  const existingTokens = getMeaningfulNameTokens(existingName);

  if (selectedTokens.size === 0 || existingTokens.size === 0) {
    return false;
  }

  const overlapCount = [...existingTokens].filter((token) => selectedTokens.has(token)).length;
  const requiredOverlap = Math.min(2, existingTokens.size);
  return overlapCount >= requiredOverlap;
}

function getMeaningfulNameTokens(name: string) {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 2 && !COURSE_NAME_STOP_WORDS.has(token))
  );
}

export async function listTeeSearchesForUser(userId: string) {
  return prisma.teeSearch.findMany({
    where: { userId },
    orderBy: [{ status: "asc" }, { date: "asc" }, { createdAt: "desc" }],
    include: searchListInclude
  });
}

export async function getTeeSearchForUser(userId: string, searchId: string) {
  return prisma.teeSearch.findUnique({
    where: { id: searchId, userId },
    select: { id: true, status: true }
  });
}

export async function updateTeeSearchStatusForUser(
  userId: string,
  searchId: string,
  status: SearchStatus
) {
  if (QUEUED_SEARCH_STATUSES.includes(status as (typeof QUEUED_SEARCH_STATUSES)[number])) {
    await assertQueueCapacity(userId, searchId);
  }

  return prisma.teeSearch.update({
    where: {
      id: searchId,
      userId
    },
    data: { status },
    include: searchInclude
  });
}

export async function updateTeeSearchForUser(
  userId: string,
  searchId: string,
  input: TeeSearchUpdateInput
) {
  if (
    input.status &&
    QUEUED_SEARCH_STATUSES.includes(input.status as (typeof QUEUED_SEARCH_STATUSES)[number])
  ) {
    await assertQueueCapacity(userId, searchId);
  }

  const teeSearchData = {
    ...(input.date ? { date: parseLocalDate(input.date) } : {}),
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.userTimeZone ? { userTimeZone: normalizeTimeZone(input.userTimeZone) } : {}),
    ...(input.players ? { players: input.players } : {}),
    ...(input.cadenceMinutes ? { cadenceMinutes: input.cadenceMinutes } : {}),
    ...(input.additionalEmails
      ? { additionalEmails: normalizeAdditionalEmails(input.additionalEmails) }
      : {}),
    ...(input.status ? { status: input.status } : {})
  };
  const coursePreferences = normalizeCoursePreferenceRankUpdates(input.coursePreferences);

  if (coursePreferences.length === 0) {
    return prisma.teeSearch.update({
      where: {
        id: searchId,
        userId
      },
      data: teeSearchData,
      include: searchInclude
    });
  }

  const operations = [
    prisma.teeSearch.findUniqueOrThrow({
      where: {
        id: searchId,
        userId
      },
      select: { id: true }
    }),
    ...coursePreferences.map((preference, index) =>
      prisma.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId
        },
        data: { rank: -(index + 1) }
      })
    ),
    ...coursePreferences.map((preference) =>
      prisma.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId
        },
        data: { rank: preference.rank }
      })
    ),
    prisma.teeSearch.update({
      where: {
        id: searchId,
        userId
      },
      data: teeSearchData,
      include: searchInclude
    })
  ];
  const results = await prisma.$transaction(operations);
  const updatedSearch = results.at(-1);
  if (!updatedSearch) {
    throw new Error("Could not update search");
  }

  return updatedSearch as Awaited<ReturnType<typeof prisma.teeSearch.update>>;
}

function normalizeCoursePreferenceRankUpdates(
  preferences: CoursePreferenceRankUpdateInput[] | undefined
) {
  if (!preferences || preferences.length === 0) {
    return [];
  }

  const seenIds = new Set<string>();
  const seenRanks = new Set<number>();
  const normalized = preferences.map((preference) => {
    const id = preference.id.trim();
    if (!id) {
      throw new Error("Course preference id is required");
    }
    if (
      !Number.isInteger(preference.rank) ||
      preference.rank < 1 ||
      preference.rank > MAX_COURSE_PREFERENCES
    ) {
      throw new Error("Course preference ranks must be between 1 and 5");
    }
    if (seenIds.has(id)) {
      throw new Error("Course preference ids must be unique");
    }
    if (seenRanks.has(preference.rank)) {
      throw new Error("Course preference ranks must be unique");
    }
    seenIds.add(id);
    seenRanks.add(preference.rank);
    return { id, rank: preference.rank };
  });

  return normalized.sort((a, b) => a.rank - b.rank);
}

export async function deleteTeeSearchForUser(userId: string, searchId: string) {
  return prisma.teeSearch.delete({
    where: {
      id: searchId,
      userId
    }
  });
}

async function assertQueueCapacity(userId: string, excludeSearchId?: string) {
  const queuedCount = await prisma.teeSearch.count({
    where: {
      userId,
      status: { in: [...QUEUED_SEARCH_STATUSES] },
      ...(excludeSearchId ? { id: { not: excludeSearchId } } : {})
    }
  });

  if (queuedCount >= MAX_QUEUED_SEARCHES_PER_USER) {
    throw new Error(
      `You can keep up to ${MAX_QUEUED_SEARCHES_PER_USER} active or paused searches in the queue.`
    );
  }
}

function normalizeAdditionalEmails(emails: string[] = []) {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
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

const searchListInclude = {
  ...searchInclude,
  user: {
    select: { email: true }
  }
} satisfies Prisma.TeeSearchInclude;
