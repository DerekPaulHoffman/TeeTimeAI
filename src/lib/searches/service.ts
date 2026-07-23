import { Prisma, type WebsiteTrafficClass } from "@prisma/client";

import {
  getCourseLayoutCompatibility,
  getCourseLayoutLabel,
  type CourseLayoutHoleCount
} from "@/lib/courses/course-layout";
import { lockSearchForAlertMutation } from "@/lib/email/search-delivery-outbox";
import {
  findUniqueGenericCourseMatch,
  haveCompatibleCourseNames,
  haveStrongCourseIdentityLink,
  isGenericCourseName
} from "@/lib/places/course-identity";
import {
  loadActiveGooglePlaceReviewIndex,
  type GooglePlaceReviewIndex
} from "@/lib/places/google-place-reviews";
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

export async function createTeeSearchForUser(
  userId: string,
  input: TeeSearchInput,
  trafficClass: WebsiteTrafficClass = "UNCLASSIFIED",
  syntheticMultiCycle = false
) {
  await assertQueueCapacity(userId);

  const placeReviews = await loadActiveGooglePlaceReviewIndex();
  const sortedCourses = input.courses
    .map((course) => applyActivePlaceReview(course, placeReviews))
    .sort((a, b) => a.rank - b.rank);
  const unverifiedCourse = sortedCourses.find(
    (course) => course.publicAccessStatus === "UNVERIFIED"
  );
  if (unverifiedCourse) {
    throw new Error(
      `${unverifiedCourse.name} still needs public-course verification before alerts can start.`
    );
  }
  const observedAt = new Date();
  const resolvedPreferences = await Promise.all(
    sortedCourses.map((course) => buildCoursePreferenceCreate(course, observedAt))
  );
  if (resolvedPreferences.some((preference) => preference.course.isPublic === false)) {
    throw new Error(
      "Tee Time Spot can only create alerts for public golf courses. Remove the private or non-public course and try again."
    );
  }
  assertCourseLayoutsCompatible(resolvedPreferences, input.requestedLayoutHoles);
  if (resolvedPreferences.every((preference) => preference.automationEligibility === "BLOCKED")) {
    throw new Error(
      "None of the selected courses offers a supported public online tee-time page. Choose at least one course Tee Time Spot can monitor."
    );
  }
  const coursePreferences = resolvedPreferences.map((preference) => preference.create);

  const teeSearch = await prisma.$transaction(async (transaction) => {
    for (const preference of resolvedPreferences) {
      if (preference.ratingUpdate) {
        await transaction.course.update({
          where: { id: preference.ratingUpdate.courseId },
          data: {
            rating: preference.ratingUpdate.rating,
            ratingObservedAt: preference.ratingUpdate.observedAt
          }
        });
      }
    }

    return transaction.teeSearch.create({
      data: {
        userId,
        date: parseLocalDate(input.date),
        startTime: input.startTime,
        endTime: input.endTime,
        userTimeZone: normalizeTimeZone(input.userTimeZone),
        players: input.players,
        requestedLayoutHoles: input.requestedLayoutHoles ?? null,
        cadenceMinutes: input.cadenceMinutes,
        additionalEmails: normalizeAdditionalEmails(input.additionalEmails),
        trafficClass,
        syntheticMultiCycle,
        preferences: {
          create: coursePreferences
        }
      },
      include: searchInclude
    });
  });

  return teeSearch;
}

async function buildCoursePreferenceCreate(
  course: SelectedCourseInput,
  observedAt: Date
) {
  const reusableCourse = await findReusableCourse(course);

  if (reusableCourse) {
    return {
      automationEligibility: reusableCourse.automationEligibility,
      course: reusableCourse,
      ratingUpdate:
        typeof course.rating === "number"
          ? {
              courseId: reusableCourse.id,
              rating: course.rating,
              observedAt
            }
          : null,
      create: {
        rank: course.rank,
        course: {
          connect: { id: reusableCourse.id }
        }
      }
    };
  }

  const placeId = getStablePlaceId(course);
  const timeZone = getTimeZoneForCoordinates(course.latitude, course.longitude);

  return {
    automationEligibility: "UNKNOWN",
    ratingUpdate: null,
    course: {
      name: course.name,
      isPublic: true,
      layoutHoleCounts: [] as number[],
      layoutHolesVerifiedAt: null
    },
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
            city: course.city,
            stateCode: course.stateCode?.toUpperCase(),
            stateName: course.stateName,
            county: course.county?.replace(/\s+County$/i, ""),
            countryCode: course.countryCode?.toUpperCase(),
            latitude: course.latitude,
            longitude: course.longitude,
            timeZone,
            rating: course.rating,
            ratingObservedAt:
              typeof course.rating === "number" ? observedAt : undefined,
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
  const existingById = course.courseId
    ? await prisma.course.findUnique({
      where: { id: course.courseId },
      select: {
        id: true,
        name: true,
        googlePlaceId: true,
        address: true,
        latitude: true,
        longitude: true,
        website: true,
        phone: true,
        isPublic: true,
        automationEligibility: true,
        layoutHoleCounts: true,
        layoutHolesVerifiedAt: true
      }
    })
    : null;
  if (course.courseId && !existingById) {
    throw new Error(
      "The selected course is no longer available. Refresh the course list and try again."
    );
  }

  const exactCourse = course.googlePlaceId
    ? await prisma.course.findUnique({
        where: { googlePlaceId: course.googlePlaceId },
        select: {
          id: true,
          name: true,
          googlePlaceId: true,
          address: true,
          latitude: true,
          longitude: true,
          website: true,
          phone: true,
          isPublic: true,
          automationEligibility: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true
        }
      })
    : null;
  if (exactCourse?.isPublic === false) {
    return exactCourse;
  }
  if (
    existingById &&
    exactCourse &&
    exactCourse.id !== existingById.id &&
    exactCourse.automationEligibility === "BLOCKED"
  ) {
    return exactCourse;
  }
  if (existingById) {
    if (
      course.googlePlaceId &&
      existingById.googlePlaceId !== course.googlePlaceId &&
      (!isConfirmedCourseAlias(course, existingById) ||
        (exactCourse !== null &&
          exactCourse.id !== existingById.id &&
          !isConfirmedPersistedCourseAlias(existingById, exactCourse)))
    ) {
      throw new Error(
        "The selected course details do not match. Refresh the course list and try again."
      );
    }
    return existingById;
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
        { automationEligibility: "BLOCKED" },
        { isPublic: false },
        { layoutHolesVerifiedAt: { not: null } }
      ]
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
      website: true,
      phone: true,
      isPublic: true,
      automationEligibility: true,
      layoutHoleCounts: true,
      layoutHolesVerifiedAt: true
    }
  });
  const supportedNearbyCourse = reusableNearbyCourses.find(
    (candidate) =>
      candidate.automationEligibility === "ALLOWED" &&
      haveCompatibleCourseNames(course.name, candidate.name)
  );

  if (supportedNearbyCourse) {
    return supportedNearbyCourse;
  }

  if (exactCourse) {
    return exactCourse;
  }

  const verifiedNearbyCourse = reusableNearbyCourses.find(
    (candidate) =>
      Boolean(candidate.layoutHolesVerifiedAt) &&
      haveCompatibleCourseNames(course.name, candidate.name)
  );
  if (verifiedNearbyCourse) {
    return verifiedNearbyCourse;
  }

  const blockedNearbyCourses = reusableNearbyCourses.filter(
    (candidate) => candidate.automationEligibility === "BLOCKED"
  );
  if (isGenericCourseName(course.name)) {
    return findUniqueGenericCourseMatch(course, blockedNearbyCourses) ?? null;
  }

  return (
    blockedNearbyCourses.find((candidate) =>
      haveCompatibleCourseNames(course.name, candidate.name)
    ) ?? null
  );
}

function applyActivePlaceReview(
  course: SelectedCourseInput,
  reviews: GooglePlaceReviewIndex
): SelectedCourseInput {
  if (!course.googlePlaceId) {
    return course;
  }
  const review = reviews.byPlaceId.get(course.googlePlaceId);
  const canonicalReview = review?.canonicalPlaceId
    ? reviews.byPlaceId.get(review.canonicalPlaceId)
    : undefined;
  if (
    isRejectedPlaceReview(review?.accessOverride) ||
    isRejectedPlaceReview(canonicalReview?.accessOverride)
  ) {
    throw new Error(
      "Tee Time Spot can only create alerts for public golf courses. Remove the private or non-public course and try again."
    );
  }
  if (!review) {
    return course;
  }
  return {
    ...course,
    ...(review.accessOverride === "VERIFIED_PUBLIC"
      ? { publicAccessStatus: "PUBLIC" as const }
      : {}),
    googlePlaceId: review.canonicalPlaceId ?? course.googlePlaceId,
    name: review.canonicalName ?? course.name,
    address: review.canonicalAddress ?? course.address,
    website: review.canonicalWebsiteUrl ?? course.website,
    phone: review.canonicalPhone ?? course.phone,
    latitude: review.latitude ?? course.latitude,
    longitude: review.longitude ?? course.longitude
  };
}

function isRejectedPlaceReview(value: string | null | undefined) {
  return value === "VERIFIED_PRIVATE" || value === "VERIFIED_NON_COURSE";
}

function isConfirmedCourseAlias(
  input: SelectedCourseInput,
  canonical: {
    name: string;
    latitude: number;
    longitude: number;
  }
) {
  return (
    haveCompatibleCourseNames(input.name, canonical.name) &&
    Math.abs(input.latitude - canonical.latitude) <=
      SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE &&
    Math.abs(input.longitude - canonical.longitude) <=
      SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE
  );
}

function isConfirmedPersistedCourseAlias(
  canonical: {
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    website: string | null;
    phone: string | null;
  },
  exact: {
    name: string;
    address: string | null;
    latitude: number;
    longitude: number;
    website: string | null;
    phone: string | null;
  }
) {
  return Boolean(
    haveCompatibleCourseNames(canonical.name, exact.name) &&
      Math.abs(canonical.latitude - exact.latitude) <=
        SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE &&
      Math.abs(canonical.longitude - exact.longitude) <=
        SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE &&
      haveStrongCourseIdentityLink(canonical, exact)
  );
}

function getStablePlaceId(course: SelectedCourseInput) {
  return course.googlePlaceId ?? `manual-${course.name}-${course.latitude}-${course.longitude}`;
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

  return prisma.$transaction(async (transaction) => {
    await lockSearchForAlertMutation(transaction, { searchId, userId });
    return transaction.teeSearch.update({
      where: {
        id: searchId,
        userId
      },
      data: {
        status,
        scheduleVersion: { increment: 1 },
        alertGeneration: { increment: 1 },
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null
      },
      include: searchInclude
    });
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

  if (input.requestedLayoutHoles !== undefined && input.requestedLayoutHoles !== null) {
    const existingSearch = await prisma.teeSearch.findUniqueOrThrow({
      where: { id: searchId, userId },
      select: {
        preferences: {
          include: {
            course: {
              select: {
                name: true,
                layoutHoleCounts: true,
                layoutHolesVerifiedAt: true
              }
            }
          }
        }
      }
    });
    assertCourseLayoutsCompatible(existingSearch.preferences, input.requestedLayoutHoles);
  }

  const teeSearchData = {
    scheduleVersion: { increment: 1 } as const,
    alertGeneration: { increment: 1 } as const,
    workflowRunId: null,
    checkLeaseToken: null,
    checkLeaseExpiresAt: null,
    recheckRequestedAt: null,
    ...(input.date ? { date: parseLocalDate(input.date) } : {}),
    ...(input.startTime ? { startTime: input.startTime } : {}),
    ...(input.endTime ? { endTime: input.endTime } : {}),
    ...(input.userTimeZone ? { userTimeZone: normalizeTimeZone(input.userTimeZone) } : {}),
    ...(input.players ? { players: input.players } : {}),
    ...(input.requestedLayoutHoles !== undefined
      ? { requestedLayoutHoles: input.requestedLayoutHoles }
      : {}),
    ...(input.cadenceMinutes ? { cadenceMinutes: input.cadenceMinutes } : {}),
    ...(input.additionalEmails
      ? { additionalEmails: normalizeAdditionalEmails(input.additionalEmails) }
      : {}),
    ...(input.status ? { status: input.status } : {})
  };
  const coursePreferences = normalizeCoursePreferenceRankUpdates(input.coursePreferences);

  if (coursePreferences.length === 0) {
    return prisma.$transaction(async (transaction) => {
      await lockSearchForAlertMutation(transaction, { searchId, userId });
      return transaction.teeSearch.update({
        where: {
          id: searchId,
          userId
        },
        data: teeSearchData,
        include: searchInclude
      });
    });
  }

  return prisma.$transaction(async (transaction) => {
    await lockSearchForAlertMutation(transaction, { searchId, userId });
    for (const [index, preference] of coursePreferences.entries()) {
      await transaction.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId
        },
        data: { rank: -(index + 1) }
      });
    }
    for (const preference of coursePreferences) {
      await transaction.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId
        },
        data: { rank: preference.rank }
      });
    }
    return transaction.teeSearch.update({
      where: {
        id: searchId,
        userId
      },
      data: teeSearchData,
      include: searchInclude
    });
  });
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
  return prisma.$transaction(async (transaction) => {
    await lockSearchForAlertMutation(transaction, { searchId, userId });
    const removedAt = new Date();
    await transaction.courseSupportBatchSearch.updateMany({
      where: { teeSearchId: searchId, removedAt: null },
      data: {
        removedAt,
        removalReason: "SEARCH_DELETED_BY_OWNER"
      }
    });
    return transaction.teeSearch.delete({
      where: {
        id: searchId,
        userId
      }
    });
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

function assertCourseLayoutsCompatible(
  preferences: Array<{
    course: {
      name: string;
      layoutHoleCounts: readonly number[];
      layoutHolesVerifiedAt: Date | null;
    };
  }>,
  requestedLayoutHoles: CourseLayoutHoleCount | null | undefined
) {
  if (!requestedLayoutHoles) {
    return;
  }

  const incompatibleCourses = preferences
    .map((preference) => preference.course)
    .filter(
      (course) =>
        Boolean(course.layoutHolesVerifiedAt) &&
        getCourseLayoutCompatibility(course.layoutHoleCounts, requestedLayoutHoles) ===
          "incompatible"
    );

  if (incompatibleCourses.length === 0) {
    return;
  }

  const details = incompatibleCourses
    .map((course) => `${course.name} (${getCourseLayoutLabel(course.layoutHoleCounts)})`)
    .join(", ");
  throw new Error(
    `The selected course layout does not match this ${requestedLayoutHoles}-hole search: ${details}.`
  );
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
  preferences: {
    orderBy: { rank: "asc" },
    include: {
      course: {
        include: {
          bookingFacts: {
            orderBy: { holes: "asc" }
          },
          profile: {
            select: {
              canonicalSlug: true,
              status: true
            }
          }
        }
      }
    }
  },
  user: {
    select: { email: true }
  }
} satisfies Prisma.TeeSearchInclude;
