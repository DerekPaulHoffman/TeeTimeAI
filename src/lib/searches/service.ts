import { Prisma, type WebsiteTrafficClass } from "@prisma/client";

import { requestTechnicalFinalRevalidationForDemand } from "@/lib/automation/course-monitoring";
import {
  getCourseLayoutCompatibility,
  getCourseLayoutLabel,
  type CourseLayoutHoleCount,
} from "@/lib/courses/course-layout";
import { lockSearchForAlertMutation } from "@/lib/email/search-delivery-outbox";
import {
  findUniqueGenericCourseMatch,
  haveCompatibleCourseNames,
  haveStrongCourseIdentityLink,
  isGenericCourseName,
} from "@/lib/places/course-identity";
import {
  buildGooglePlaceReviewIndex,
  loadActiveGooglePlaceReviewIndex,
  type GooglePlaceReviewIndex,
} from "@/lib/places/google-place-reviews";
import { prisma } from "@/lib/prisma";
import { enqueueOperatorNotification } from "@/lib/operator-notifications/queue";
import {
  buildAlertGenerationStartMarker,
  readAlertGenerationStartedAt,
  unwrapAlertGenerationStatusSnapshot,
} from "@/lib/searches/generation-clock";
import { getTimeZoneForCoordinates, normalizeTimeZone } from "@/lib/timezones";
import {
  MAX_COURSE_PREFERENCES,
  MAX_QUEUED_SEARCHES_PER_USER,
  type SelectedCourseInput,
  type TeeSearchDetailsInput,
  type TeeSearchInput,
} from "@/lib/validation/search";
import { parseLocalDate } from "@/lib/validation/search";
import { assertFutureCourseSearchDate } from "@/lib/validation/search-date";
import { getLocalReaderCourseKey } from "@/lib/local-reader/course-key";
import {
  getNewestCompletedLocalReaderProviderObservationsInTransaction,
  type CompletedLocalReaderProviderObservation,
} from "@/lib/local-reader/service";
import {
  getCourseProviderObservationFencesInTransaction,
  type CourseProviderObservationFence,
} from "@/lib/automation/provider-execution-marker";
import { isSyntheticWebsiteTrafficClass } from "@/lib/engagement/traffic-class";
import {
  matchesCurrentSearchSettings,
  type CurrentMatchSearchSettings,
  type CurrentMatchSettings,
} from "@/lib/searches/current-match-settings";
import { projectCurrentCheckEvidence } from "@/lib/searches/current-check-evidence";
import { isCurrentSimulatorMatch } from "@/lib/simulators/current-availability";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";
import { assertSimulatorSessionFitsWindow } from "@/lib/searches/simulator-window";
import { DEFAULT_SIMULATOR_DURATION_MINUTES } from "@/lib/searches/search-mode";
import { getSimulatorVenueForDemand } from "@/lib/places/simulator-google";
import type { CourseCandidate } from "@/lib/places/google";

const SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE = 0.06;
const QUEUED_SEARCH_STATUSES = ["ACTIVE", "PAUSED"] as const;
type SearchStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

function runCustomerProjectionTransaction<T>(
  worker: (transaction: Prisma.TransactionClient) => Promise<T>,
) {
  return prisma.$transaction(worker, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  });
}

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
  syntheticMultiCycle = false,
) {
  await assertQueueCapacity(userId);

  if (input.mode === "SIMULATOR") {
    return createSimulatorTeeSearchForUser(userId, input, trafficClass, syntheticMultiCycle);
  }

  const placeReviews = await loadActiveGooglePlaceReviewIndex();
  const sortedCourses = input.courses
    .map((course) => applyActivePlaceReview(course, placeReviews))
    .sort((a, b) => a.rank - b.rank);
  const observedAt = new Date();
  const resolvedPreferences = await Promise.all(
    sortedCourses.map((course) =>
      buildCoursePreferenceCreate(course, observedAt),
    ),
  );
  if (
    resolvedPreferences.some(
      (preference) => preference.course.isPublic === false,
    )
  ) {
    throw new Error(
      "Tee Time Spot can only create alerts for public golf courses. Remove the private or non-public course and try again.",
    );
  }
  assertCourseLayoutsCompatible(
    resolvedPreferences,
    input.requestedLayoutHoles,
  );
  assertFutureCourseSearchDate(
    input.date,
    resolvedPreferences.map((preference) => preference.course.timeZone),
  );
  const coursePreferences = resolvedPreferences.map(
    (preference) => preference.create,
  );

  const teeSearch = await prisma.$transaction(async (transaction) => {
    for (const preference of resolvedPreferences) {
      if (preference.ratingUpdate) {
        await transaction.course.update({
          where: { id: preference.ratingUpdate.courseId },
          data: {
            rating: preference.ratingUpdate.rating,
            ratingObservedAt: preference.ratingUpdate.observedAt,
          },
        });
      }
    }

    const created = await transaction.teeSearch.create({
      data: {
        userId,
        date: parseLocalDate(input.date),
        startTime: input.startTime,
        endTime: input.endTime,
        userTimeZone: normalizeTimeZone(input.userTimeZone),
        players: input.players,
        requestedLayoutHoles: input.requestedLayoutHoles ?? null,
        cadenceMinutes: input.cadenceMinutes,
        alertEmail: normalizeAlertEmail(input.alertEmail),
        additionalEmails: normalizeAdditionalEmails(input.additionalEmails),
        trafficClass,
        syntheticMultiCycle,
        preferences: {
          create: coursePreferences,
        },
      },
      include: searchInclude,
    });
    await enqueueOperatorNotification(transaction, created);
    return created;
  });

  if (!isSyntheticWebsiteTrafficClass(trafficClass)) {
    try {
      await requestTechnicalFinalRevalidationForDemand({
        courseIds: resolvedPreferences.flatMap((preference) =>
          "id" in preference.course ? [preference.course.id] : [],
        ),
      });
    } catch {
      // The saved alert remains authoritative. The five-minute invariant
      // watchdog independently requests any missed final-state revalidation.
      console.error("[course-monitoring:revalidation-request-failed]", {
        selectedCourseCount: resolvedPreferences.length,
      });
    }
  }

  return teeSearch;
}

async function createSimulatorTeeSearchForUser(
  userId: string,
  input: TeeSearchInput,
  trafficClass: WebsiteTrafficClass,
  syntheticMultiCycle: boolean,
) {
  const durationMinutes = input.durationMinutes ?? DEFAULT_SIMULATOR_DURATION_MINUTES;
  if (input.players < 1 || input.players > 4) throw new Error("Choose 1 to 4 players.");
  const selected = [...input.courses].sort((a, b) => a.rank - b.rank);
  if (selected.some((candidate) => candidate.mode === "OUTDOOR" ||
      (!candidate.offeringId && !candidate.googlePlaceId))) {
    throw new Error("Choose simulator venues from the results.");
  }
  const reviews = await loadActiveGooglePlaceReviewIndex();
  const offeringIds = selected.flatMap((candidate) => candidate.offeringId ? [candidate.offeringId] : []);
  if (new Set(offeringIds).size !== offeringIds.length) throw new Error("Choose distinct simulator venues.");
  const placeIds = selected.flatMap((candidate) => candidate.googlePlaceId
    ? [reviews.byPlaceId.get(candidate.googlePlaceId)?.canonicalPlaceId ?? candidate.googlePlaceId] : []);
  const offerings = await prisma.courseOffering.findMany({
    where: { kind: "SIMULATOR", OR: [
      { id: { in: offeringIds } }, { course: { googlePlaceId: { in: placeIds } } },
    ] },
    include: { course: true },
  });
  const byId = new Map(offerings.map((offering) => [offering.id, offering]));
  const byPlaceId = new Map(offerings.flatMap((offering) => offering.course.googlePlaceId
    ? [[offering.course.googlePlaceId, offering] as const] : []));
  const canonical = await Promise.all(selected.map(async (candidate) => {
    const placeId = candidate.googlePlaceId
      ? reviews.byPlaceId.get(candidate.googlePlaceId)?.canonicalPlaceId ?? candidate.googlePlaceId : undefined;
    const offering = candidate.offeringId ? byId.get(candidate.offeringId) : placeId ? byPlaceId.get(placeId) : undefined;
    assertSimulatorPlaceReview(candidate.googlePlaceId ?? offering?.course.googlePlaceId, reviews, offering);
    if (offering) {
      assertSimulatorOfferingAcceptsDemand(offering);
      if ((candidate.courseId && candidate.courseId !== offering.courseId) ||
          (placeId && placeId !== offering.course.googlePlaceId)) {
        throw new Error("The selected simulator venue details do not match. Refresh the venues and try again.");
      }
      return { candidate, offering, venue: {
        googlePlaceId: offering.course.googlePlaceId ?? "", name: offering.course.name,
        latitude: offering.course.latitude, longitude: offering.course.longitude,
        timeZone: offering.course.timeZone,
      } as CourseCandidate };
    }
    if (candidate.offeringId || !candidate.googlePlaceId) {
      throw new Error("The selected simulator venue changed. Refresh the venues and try again.");
    }
    // All identity and source fields come from the exact provider record. The
    // client supplies only intent; it cannot turn a URL into a monitoring source.
    const venue = await getSimulatorVenueForDemand(candidate.googlePlaceId, reviews);
    const existing = await prisma.course.findUnique({ where: { googlePlaceId: venue.googlePlaceId } });
    if (candidate.courseId && existing?.id !== candidate.courseId) {
      throw new Error("The selected simulator venue details do not match. Refresh the venues and try again.");
    }
    return { candidate, offering: undefined, venue: {
      ...venue, ...(existing ? { timeZone: existing.timeZone } : {}),
    } };
  }));
  const identities = canonical.map(({ offering, venue }) => offering?.courseId ?? venue.googlePlaceId);
  const canonicalPlaceIds = canonical.map(({ venue }) => venue.googlePlaceId).filter(Boolean);
  if (new Set(identities).size !== canonical.length || new Set(canonicalPlaceIds).size !== canonicalPlaceIds.length) {
    throw new Error("Choose distinct simulator venues.");
  }
  assertSimulatorSessionFitsWindow({ date: input.date, startTime: input.startTime,
    endTime: input.endTime, durationMinutes,
    timeZones: canonical.map(({ venue }) => normalizeTimeZone(venue.timeZone)) });

  return prisma.$transaction(async (transaction) => {
    const currentReviews = buildGooglePlaceReviewIndex(await transaction.googlePlaceReview.findMany({
      where: { active: true },
    }));
    const resolved = [];
    for (const { candidate, offering, venue } of canonical) {
      const currentPlaceId = candidate.googlePlaceId
        ? currentReviews.byPlaceId.get(candidate.googlePlaceId)?.canonicalPlaceId ?? candidate.googlePlaceId : undefined;
      if (currentPlaceId && currentPlaceId !== venue.googlePlaceId) {
        throw new Error("The selected simulator venue changed. Refresh the venues and try again.");
      }
      assertSimulatorPlaceReview(candidate.googlePlaceId ?? venue.googlePlaceId, currentReviews, offering);
      if (offering) { resolved.push({ candidate, offering }); continue; }
      const course = await transaction.course.upsert({
        where: { googlePlaceId: venue.googlePlaceId }, update: {},
        create: {
          googlePlaceId: venue.googlePlaceId, name: venue.name, address: venue.address,
          city: venue.city, stateCode: venue.stateCode, stateName: venue.stateName,
          county: venue.county, countryCode: venue.countryCode,
          latitude: venue.latitude, longitude: venue.longitude,
          timeZone: venue.timeZone, website: venue.website, phone: venue.phone,
          isPublic: null, isManual: false,
        },
      });
      // Concurrent saves reuse the offering without overwriting a review or
      // outdoor knowledge. Empty durations mean unverified, not unsupported.
      const pendingRecord = await transaction.courseOffering.upsert({
        where: { courseId_kind: { courseId: course.id, kind: "SIMULATOR" } }, update: {},
        create: { courseId: course.id, kind: "SIMULATOR", publicAccessStatus: "UNVERIFIED",
          bookingUrl: venue.website ?? null, supportedDurationsMinutes: [],
          automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN" },
      });
      const pendingOffering = { ...pendingRecord, course };
      assertSimulatorOfferingAcceptsDemand(pendingOffering);
      assertSimulatorPlaceReview(venue.googlePlaceId, currentReviews, pendingOffering);
      resolved.push({ candidate, offering: pendingOffering });
    }
    if (new Set(resolved.map(({ offering }) => offering.courseId)).size !== resolved.length) {
      throw new Error("Choose distinct simulator venues.");
    }
    const resolvedOfferingIds = resolved.map(({ offering }) => offering.id);
    const currentOfferings = await transaction.courseOffering.findMany({
      where: { id: { in: resolvedOfferingIds }, kind: "SIMULATOR" },
      include: { course: true },
    });
    const currentById = new Map(currentOfferings.map((offering) => [offering.id, offering]));
    for (const [index, { offering: planned }] of resolved.entries()) {
      const venue = canonical[index].venue;
      const offering = currentById.get(planned.id);
      if (!offering || offering.courseId !== planned.courseId ||
          (venue.googlePlaceId && venue.googlePlaceId !== offering.course.googlePlaceId)) {
        throw new Error("A selected simulator venue changed. Refresh the venues and try again.");
      }
      assertSimulatorOfferingAcceptsDemand(offering);
      assertSimulatorPlaceReview(offering.course.googlePlaceId, currentReviews, offering);
    }
    assertSimulatorSessionFitsWindow({ date: input.date, startTime: input.startTime,
      endTime: input.endTime, durationMinutes,
      timeZones: currentOfferings.map((offering) => offering.course.timeZone) });
    const created = await transaction.teeSearch.create({
      data: {
        userId,
        mode: "SIMULATOR",
        durationMinutes,
        date: parseLocalDate(input.date),
        startTime: input.startTime,
        endTime: input.endTime,
        userTimeZone: normalizeTimeZone(input.userTimeZone),
        players: input.players,
        requestedLayoutHoles: null,
        cadenceMinutes: input.cadenceMinutes,
        alertEmail: normalizeAlertEmail(input.alertEmail),
        additionalEmails: normalizeAdditionalEmails(input.additionalEmails),
        trafficClass,
        syntheticMultiCycle,
        preferences: {
          create: resolved.map(({ candidate, offering }) => ({
            rank: candidate.rank,
            course: { connect: { id: offering.courseId } },
            offering: { connect: { id: offering.id } },
            ...(candidate.distanceMeters !== undefined
              ? { distanceMetersAtSelection: candidate.distanceMeters }
              : {}),
          })),
        },
      },
      include: searchInclude,
    });
    await enqueueOperatorNotification(transaction, created);
    return created;
  });
}

function assertSimulatorOfferingAcceptsDemand(offering: { active: boolean; publicAccessStatus: string; kind?: string }) {
  if (!offering.active || offering.publicAccessStatus === "NOT_PUBLIC" ||
      (offering.kind !== undefined && offering.kind !== "SIMULATOR")) {
    throw new Error("The selected simulator venue is no longer available for public alerts. Refresh the venues and try again.");
  }
}

function assertSimulatorPlaceReview(
  googlePlaceId: string | null | undefined,
  reviews: GooglePlaceReviewIndex,
  offering?: { publicAccessStatus: string; bookingUrl: string | null; evidenceUrl: string | null; verifiedAt: Date | null },
) {
  if (!googlePlaceId) return;
  const review = reviews.byPlaceId.get(googlePlaceId);
  const canonical = review?.canonicalPlaceId ? reviews.byPlaceId.get(review.canonicalPlaceId) : undefined;
  const verifiedRental = offering?.publicAccessStatus === "PUBLIC" && offering.bookingUrl &&
    offering.evidenceUrl && offering.verifiedAt && offering.verifiedAt.getTime() <= Date.now();
  if ([review, canonical].some((fact) => fact?.classification === "MEMBERS_ONLY_SIMULATOR" ||
      (!verifiedRental && (fact?.accessOverride === "VERIFIED_PRIVATE" ||
        (fact?.accessOverride === "VERIFIED_NON_COURSE" && fact.classification !== "INDOOR_SIMULATOR"))))) {
    throw new Error("The selected venue is not a public simulator rental. Choose another venue.");
  }
}

async function buildCoursePreferenceCreate(
  course: SelectedCourseInput,
  observedAt: Date,
) {
  const reusableCourse = await findReusableCourse(course);

  if (reusableCourse) {
    return {
      automationEligibility:
        reusableCourse.automationEligibility === "BLOCKED" &&
        getLocalReaderCourseKey(reusableCourse.detectedBookingUrl) !== null
          ? "ALLOWED"
          : reusableCourse.automationEligibility,
      course: reusableCourse,
      ratingUpdate:
        typeof course.rating === "number"
          ? {
              courseId: reusableCourse.id,
              rating: course.rating,
              observedAt,
            }
          : null,
      create: {
        rank: course.rank,
        ...(course.distanceMeters !== undefined
          ? { distanceMetersAtSelection: course.distanceMeters }
          : {}),
        course: {
          connect: { id: reusableCourse.id },
        },
      },
    };
  }

  const placeId = getStablePlaceId(course);
  const timeZone = getTimeZoneForCoordinates(course.latitude, course.longitude);

  return {
    automationEligibility: "UNKNOWN",
    ratingUpdate: null,
    course: {
      name: course.name,
      timeZone,
      isPublic: course.publicAccessStatus === "UNVERIFIED" ? null : true,
      layoutHoleCounts: [] as number[],
      layoutHolesVerifiedAt: null,
    },
    create: {
      rank: course.rank,
      ...(course.distanceMeters !== undefined
        ? { distanceMetersAtSelection: course.distanceMeters }
        : {}),
      course: {
        connectOrCreate: {
          where: {
            googlePlaceId: placeId,
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
            isPublic: course.publicAccessStatus === "UNVERIFIED" ? null : true,
            isManual: !course.googlePlaceId,
          },
        },
      },
    },
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
          timeZone: true,
          website: true,
          detectedBookingUrl: true,
          phone: true,
          isPublic: true,
          automationEligibility: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
        },
      })
    : null;
  if (course.courseId && !existingById) {
    throw new Error(
      "The selected course is no longer available. Refresh the course list and try again.",
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
          timeZone: true,
          website: true,
          detectedBookingUrl: true,
          phone: true,
          isPublic: true,
          automationEligibility: true,
          layoutHoleCounts: true,
          layoutHolesVerifiedAt: true,
        },
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
        "The selected course details do not match. Refresh the course list and try again.",
      );
    }
    return existingById;
  }

  const reusableNearbyCourses = await prisma.course.findMany({
    where: {
      latitude: {
        gte: course.latitude - SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
        lte: course.latitude + SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
      },
      longitude: {
        gte: course.longitude - SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
        lte: course.longitude + SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE,
      },
      OR: [
        {
          automationEligibility: "ALLOWED",
          detectedPlatform: { not: "UNKNOWN" },
        },
        { automationEligibility: "BLOCKED" },
        { isPublic: false },
        { layoutHolesVerifiedAt: { not: null } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
      timeZone: true,
      website: true,
      detectedBookingUrl: true,
      phone: true,
      isPublic: true,
      automationEligibility: true,
      layoutHoleCounts: true,
      layoutHolesVerifiedAt: true,
    },
  });
  const supportedNearbyCourse = reusableNearbyCourses.find(
    (candidate) =>
      candidate.automationEligibility === "ALLOWED" &&
      haveCompatibleCourseNames(course.name, candidate.name),
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
      haveCompatibleCourseNames(course.name, candidate.name),
  );
  if (verifiedNearbyCourse) {
    return verifiedNearbyCourse;
  }

  const blockedNearbyCourses = reusableNearbyCourses.filter(
    (candidate) => candidate.automationEligibility === "BLOCKED",
  );
  if (isGenericCourseName(course.name)) {
    return findUniqueGenericCourseMatch(course, blockedNearbyCourses) ?? null;
  }

  return (
    blockedNearbyCourses.find((candidate) =>
      haveCompatibleCourseNames(course.name, candidate.name),
    ) ?? null
  );
}

function applyActivePlaceReview(
  course: SelectedCourseInput,
  reviews: GooglePlaceReviewIndex,
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
      "Tee Time Spot can only create alerts for public golf courses. Remove the private or non-public course and try again.",
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
    longitude: review.longitude ?? course.longitude,
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
  },
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
  },
) {
  return Boolean(
    haveCompatibleCourseNames(canonical.name, exact.name) &&
    Math.abs(canonical.latitude - exact.latitude) <=
      SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE &&
    Math.abs(canonical.longitude - exact.longitude) <=
      SUPPORTED_COURSE_REUSE_COORDINATE_TOLERANCE &&
    haveStrongCourseIdentityLink(canonical, exact),
  );
}

function getStablePlaceId(course: SelectedCourseInput) {
  return (
    course.googlePlaceId ??
    `manual-${course.name}-${course.latitude}-${course.longitude}`
  );
}

export async function listTeeSearchesForUser(userId: string) {
  return runCustomerProjectionTransaction(async (transaction) => {
    const searches = await transaction.teeSearch.findMany({
      where: { userId },
      orderBy: [{ status: "asc" }, { date: "asc" }, { createdAt: "desc" }],
      include: searchListInclude,
    });

    if (searches.length === 0) {
      return [];
    }

    const matchCourseIds = searches.filter(search => search.mode !== "SIMULATOR").flatMap((search) =>
      search.matches.map((match) => match.course.id),
    );
    const completedLocalReaderSources =
      await getNewestCompletedLocalReaderProviderObservationsInTransaction(
        transaction,
        matchCourseIds,
      );
    const providerObservationFences =
      await getCourseProviderObservationFencesInTransaction(
        transaction,
        matchCourseIds,
      );

    const latestProbeIds = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT DISTINCT ON ("teeSearchId", "courseId") id
        FROM "CourseProbe"
        WHERE "teeSearchId" IN (${Prisma.join(searches.map((search) => search.id))})
        ORDER BY "teeSearchId", "courseId", "observedAt" DESC, id DESC
      `,
    );
    const latestProbes =
      latestProbeIds.length === 0
        ? []
        : await transaction.courseProbe.findMany({
            where: { id: { in: latestProbeIds.map((probe) => probe.id) } },
            orderBy: { observedAt: "desc" },
            include: { course: true },
          });
    const probesBySearch = new Map<string, typeof latestProbes>();

    for (const probe of latestProbes) {
      const probes = probesBySearch.get(probe.teeSearchId) ?? [];
      probes.push(probe);
      probesBySearch.set(probe.teeSearchId, probes);
    }

    return searches.map((search) =>
      projectCurrentCustomerMatches(
        projectCurrentCheckEvidence({
          ...search,
          probes: probesBySearch.get(search.id) ?? [],
        }),
        completedLocalReaderSources,
        providerObservationFences,
      ),
    );
  });
}

export async function getTeeSearchForUser(userId: string, searchId: string) {
  return prisma.teeSearch.findUnique({
    where: { id: searchId, userId },
    select: { id: true, status: true },
  });
}

export async function updateTeeSearchStatusForUser(
  userId: string,
  searchId: string,
  status: SearchStatus,
) {
  if (
    QUEUED_SEARCH_STATUSES.includes(
      status as (typeof QUEUED_SEARCH_STATUSES)[number],
    )
  ) {
    await assertQueueCapacity(userId, searchId);
  }

  return runCustomerProjectionTransaction(async (transaction) => {
    const lockedSearch = await lockSearchForAlertMutation(transaction, {
      searchId,
      userId,
    });
    if (status === "ACTIVE") {
      const current = await transaction.teeSearch.findUniqueOrThrow({
        where: { id: searchId, userId },
        select: { mode: true, date: true, startTime: true, endTime: true, durationMinutes: true,
          preferences: { select: { course: { select: { timeZone: true } } } } },
      });
      if (current.mode === "SIMULATOR") {
        if (current.preferences.length === 0) throw new Error("Choose a simulator venue for this alert.");
        assertSimulatorSessionFitsWindow({ date: current.date.toISOString().slice(0, 10),
          startTime: current.startTime, endTime: current.endTime,
          durationMinutes: current.durationMinutes ?? DEFAULT_SIMULATOR_DURATION_MINUTES,
          timeZones: current.preferences.map((preference) => preference.course.timeZone) });
      }
    }
    const nextAlertGeneration = lockedSearch.alertGeneration + 1;
    const updatedSearch = await transaction.teeSearch.update({
      where: {
        id: searchId,
        userId,
      },
      data: {
        status,
        scheduleVersion: { increment: 1 },
        alertGeneration: { increment: 1 },
        ...(status === "ACTIVE"
          ? {
              statusEmailSentAt: null,
              statusEmailSnapshot: buildAlertGenerationStartMarker({
                alertGeneration: nextAlertGeneration,
              }),
            }
          : {}),
        workflowRunId: null,
        checkLeaseToken: null,
        checkLeaseExpiresAt: null,
        recheckRequestedAt: null,
      },
      include: searchInclude,
    });
    return projectCurrentCustomerSearch(transaction, updatedSearch);
  });
}

export async function updateTeeSearchForUser(
  userId: string,
  searchId: string,
  input: TeeSearchUpdateInput,
) {
  const modeAndOfferings = await prisma.teeSearch.findUniqueOrThrow({
    where: { id: searchId, userId },
    select: {
      mode: true,
      date: true,
      startTime: true,
      endTime: true,
      players: true,
      durationMinutes: true,
      preferences: {
        select: {
          offering: {
            select: {
              active: true,
              publicAccessStatus: true,
              maxPartySize: true,
              supportedDurationsMinutes: true,
              bookingUrl: true,
              evidenceUrl: true,
              verifiedAt: true,
              course: { select: { timeZone: true } },
            },
          },
        },
      },
    },
  });
  if (input.mode && input.mode !== modeAndOfferings.mode) {
    throw new Error("An alert's course type cannot change. Create a new alert for the other type.");
  }
  const nextPlayers = input.players ?? modeAndOfferings.players;
  const nextDuration = input.durationMinutes === undefined
    ? (modeAndOfferings.mode === "SIMULATOR"
      ? modeAndOfferings.durationMinutes ?? DEFAULT_SIMULATOR_DURATION_MINUTES
      : modeAndOfferings.durationMinutes)
    : input.durationMinutes;
  if (modeAndOfferings.mode === "SIMULATOR") {
    const changesSimulatorIntent = input.date !== undefined || input.startTime !== undefined ||
      input.endTime !== undefined || input.players !== undefined || input.durationMinutes !== undefined ||
      input.status === "ACTIVE";
    if (input.requestedLayoutHoles != null || (changesSimulatorIntent && (nextPlayers < 1 || nextPlayers > 4)) || !nextDuration) {
      throw new Error("Choose 1 to 4 players and a simulator session length.");
    }
    if (changesSimulatorIntent && modeAndOfferings.preferences.some(({ offering }) =>
      !offering || !offering.active || offering.publicAccessStatus === "NOT_PUBLIC"
    )) {
      throw new Error("A selected simulator venue no longer supports public alerts.");
    }
    if (changesSimulatorIntent) assertSimulatorSessionFitsWindow({
      date: input.date ?? modeAndOfferings.date.toISOString().slice(0, 10),
      startTime: input.startTime ?? modeAndOfferings.startTime,
      endTime: input.endTime ?? modeAndOfferings.endTime,
      durationMinutes: nextDuration,
      timeZones: modeAndOfferings.preferences.flatMap(({ offering }) => offering ? [offering.course.timeZone] : []),
    });
  } else if (nextPlayers < 1 || nextPlayers > 4 || nextDuration != null) {
    throw new Error("Outdoor alerts support 1 to 4 players without a session length.");
  }
  if (
    input.status &&
    QUEUED_SEARCH_STATUSES.includes(
      input.status as (typeof QUEUED_SEARCH_STATUSES)[number],
    )
  ) {
    await assertQueueCapacity(userId, searchId);
  }

  if (
    input.requestedLayoutHoles !== undefined &&
    input.requestedLayoutHoles !== null
  ) {
    const existingSearch = await prisma.teeSearch.findUniqueOrThrow({
      where: { id: searchId, userId },
      select: {
        preferences: {
          include: {
            course: {
              select: {
                name: true,
                layoutHoleCounts: true,
                layoutHolesVerifiedAt: true,
              },
            },
          },
        },
      },
    });
    assertCourseLayoutsCompatible(
      existingSearch.preferences,
      input.requestedLayoutHoles,
    );
  }

  const buildTeeSearchData = (lockedSearch: {
    status: string;
    alertGeneration: number;
  }) => {
    const nextStatus = input.status ?? lockedSearch.status;
    const nextAlertGeneration = lockedSearch.alertGeneration + 1;
    return {
      scheduleVersion: { increment: 1 } as const,
      alertGeneration: { increment: 1 } as const,
      workflowRunId: null,
      checkLeaseToken: null,
      checkLeaseExpiresAt: null,
      recheckRequestedAt: null,
      ...(nextStatus === "ACTIVE"
        ? {
            statusEmailSentAt: null,
            statusEmailSnapshot: buildAlertGenerationStartMarker({
              alertGeneration: nextAlertGeneration,
            }),
          }
        : {}),
      ...(input.date ? { date: parseLocalDate(input.date) } : {}),
      ...(input.startTime ? { startTime: input.startTime } : {}),
      ...(input.endTime ? { endTime: input.endTime } : {}),
      ...(input.userTimeZone
        ? { userTimeZone: normalizeTimeZone(input.userTimeZone) }
        : {}),
      ...(input.players ? { players: input.players } : {}),
      ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
      ...(input.requestedLayoutHoles !== undefined
        ? { requestedLayoutHoles: input.requestedLayoutHoles }
        : {}),
      ...(input.cadenceMinutes ? { cadenceMinutes: input.cadenceMinutes } : {}),
      ...(input.alertEmail
        ? { alertEmail: normalizeAlertEmail(input.alertEmail) }
        : {}),
      ...(input.additionalEmails
        ? {
            additionalEmails: normalizeAdditionalEmails(input.additionalEmails),
          }
        : {}),
      ...(input.status ? { status: input.status } : {}),
    };
  };
  const coursePreferences = normalizeCoursePreferenceRankUpdates(
    input.coursePreferences,
  );

  async function assertCurrentSimulatorIntent(transaction: Prisma.TransactionClient) {
    if (modeAndOfferings.mode !== "SIMULATOR" ||
        (input.date === undefined && input.startTime === undefined && input.endTime === undefined &&
         input.players === undefined && input.durationMinutes === undefined && input.status !== "ACTIVE")) return;
    const current = await transaction.teeSearch.findUniqueOrThrow({
      where: { id: searchId, userId },
      select: { mode: true, date: true, startTime: true, endTime: true, players: true, durationMinutes: true,
        preferences: { select: { offering: { include: { course: { select: { timeZone: true, googlePlaceId: true } } } } } } },
    });
    if (current.mode !== "SIMULATOR") throw new Error("An alert's course type cannot change.");
    const durationMinutes = input.durationMinutes ?? current.durationMinutes ?? DEFAULT_SIMULATOR_DURATION_MINUTES;
    if (!durationMinutes || current.preferences.some(({ offering }) =>
      !offering || !offering.active || offering.kind !== "SIMULATOR" ||
      offering.publicAccessStatus === "NOT_PUBLIC")) {
      throw new Error("A selected simulator venue no longer supports public alerts.");
    }
    const offeringPlaceIds = current.preferences.flatMap(({ offering }) =>
      offering?.course.googlePlaceId ? [offering.course.googlePlaceId] : []);
    if (offeringPlaceIds.length) {
      const reviews = buildGooglePlaceReviewIndex(await transaction.googlePlaceReview.findMany({
        where: { active: true },
      }));
      for (const { offering } of current.preferences) {
        if (offering) assertSimulatorPlaceReview(offering.course.googlePlaceId, reviews, offering);
      }
    }
    assertSimulatorSessionFitsWindow({ date: input.date ?? current.date.toISOString().slice(0, 10),
      startTime: input.startTime ?? current.startTime, endTime: input.endTime ?? current.endTime,
      durationMinutes, timeZones: current.preferences.flatMap(({ offering }) => offering ? [offering.course.timeZone] : []) });
  }

  if (coursePreferences.length === 0) {
    return runCustomerProjectionTransaction(async (transaction) => {
      const lockedSearch = await lockSearchForAlertMutation(transaction, {
        searchId,
        userId,
      });
      await assertCurrentSimulatorIntent(transaction);
      await assertUpdatedSearchDate(transaction, userId, searchId, input.date);
      const updatedSearch = await transaction.teeSearch.update({
        where: {
          id: searchId,
          userId,
        },
        data: buildTeeSearchData(lockedSearch),
        include: searchInclude,
      });
      return projectCurrentCustomerSearch(transaction, updatedSearch);
    });
  }

  return runCustomerProjectionTransaction(async (transaction) => {
    const lockedSearch = await lockSearchForAlertMutation(transaction, {
      searchId,
      userId,
    });
    await assertCurrentSimulatorIntent(transaction);
    await assertUpdatedSearchDate(transaction, userId, searchId, input.date);
    for (const [index, preference] of coursePreferences.entries()) {
      await transaction.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId,
        },
        data: { rank: -(index + 1) },
      });
    }
    for (const preference of coursePreferences) {
      await transaction.coursePreference.updateMany({
        where: {
          id: preference.id,
          teeSearchId: searchId,
        },
        data: { rank: preference.rank },
      });
    }
    const updatedSearch = await transaction.teeSearch.update({
      where: {
        id: searchId,
        userId,
      },
      data: buildTeeSearchData(lockedSearch),
      include: searchInclude,
    });
    return projectCurrentCustomerSearch(transaction, updatedSearch);
  });
}

async function assertUpdatedSearchDate(
  transaction: Prisma.TransactionClient,
  userId: string,
  searchId: string,
  date: string | undefined,
) {
  if (date === undefined) {
    return;
  }
  const search = await transaction.teeSearch.findUniqueOrThrow({
    where: { id: searchId, userId },
    select: {
      mode: true,
      preferences: { select: { course: { select: { timeZone: true } } } },
    },
  });
  if (search.mode !== "SIMULATOR") {
    assertFutureCourseSearchDate(
      date,
      search.preferences.map((preference) => preference.course.timeZone),
    );
  }
}

async function projectCurrentCustomerSearch<
  T extends Parameters<typeof projectCurrentCustomerMatches>[0],
>(transaction: Prisma.TransactionClient, search: T) {
  if (search.mode === "SIMULATOR") return projectCurrentCustomerMatches(projectCurrentCheckEvidence(search), new Map(), new Map());
  const courseIds = search.matches.map((match) => match.course.id);
  const completedLocalReaderSources =
    await getNewestCompletedLocalReaderProviderObservationsInTransaction(
      transaction,
      courseIds,
    );
  const providerObservationFences =
    await getCourseProviderObservationFencesInTransaction(
      transaction,
      courseIds,
    );
  return projectCurrentCustomerMatches(
    projectCurrentCheckEvidence(search),
    completedLocalReaderSources,
    providerObservationFences,
  );
}

function hideInternalGenerationMarker<
  T extends { statusEmailSnapshot?: unknown },
>(search: T) {
  const publicSnapshot = unwrapAlertGenerationStatusSnapshot(
    search.statusEmailSnapshot,
  );
  return publicSnapshot === search.statusEmailSnapshot
    ? search
    : { ...search, statusEmailSnapshot: publicSnapshot };
}

function projectCurrentCustomerMatches<
  T extends CurrentMatchSearchSettings & {
    mode?: string;
    durationMinutes?: number | null;
    alertGeneration?: number;
    createdAt?: Date;
    lastCheckedAt?: Date | null;
    lastCheckOutcome?: string | null;
    statusEmailSnapshot?: unknown;
    probes: Array<{
      courseId: string;
      observedAt: Date;
      outcome: string;
      rawSummary?: unknown;
    }>;
    matches: Array<CurrentMatchSettings & {
      offeringId?: string | null;
      offeringSourceFingerprint?: string | null;
      endsAt?: Date | null;
      resourceId?: string | null;
      capacity?: number | null;
      bookingUrl?: string;
      offering?: import("@/lib/simulators/current-availability").SimulatorMatchProof["offering"];
      availabilityStatus: string;
      lastConfirmedAt: Date | null;
      course: {
        id: string;
        monitoringStatus?: {
          state: string;
          lastSuccessfulAt: Date | null;
          lastFailureAt: Date | null;
        } | null;
      };
    }>;
  },
>(
  search: T,
  completedLocalReaderSources: ReadonlyMap<
    string,
    CompletedLocalReaderProviderObservation
  >,
  providerObservationFences: ReadonlyMap<
    string,
    CourseProviderObservationFence
  >,
) {
  return {
    ...hideInternalGenerationMarker(search),
    matches: search.matches.flatMap((match) => {
      const { monitoringStatus: monitoring, ...course } = match.course;
      if (search.mode === "SIMULATOR") {
        const preference = search.preferences.find(preference => preference.course.id === match.course.id && preference.offeringId === match.offeringId);
        const generationStartedAt = typeof search.alertGeneration === "number" && search.createdAt
          ? readAlertGenerationStartedAt({ alertGeneration: search.alertGeneration, createdAt: search.createdAt, statusEmailSnapshot: search.statusEmailSnapshot }) : null;
        if (!match.offeringId || !match.endsAt || !match.bookingUrl || !match.lastConfirmedAt || !search.durationMinutes ||
          !preference || !generationStartedAt || match.lastConfirmedAt < generationStartedAt ||
          !isCurrentSimulatorMatch({ ...match, offeringId: match.offeringId, endsAt: match.endsAt, bookingUrl: match.bookingUrl,
            lastConfirmedAt: match.lastConfirmedAt, capacity: match.capacity ?? null }, new Date())) return [];
        const matching = filterSimulatorSessionsForSearch({ date: search.date.toISOString().slice(0, 10), startTime: search.startTime,
          endTime: search.endTime, players: search.players, durationMinutes: search.durationMinutes,
          preferredOfferings: [{ offeringId: match.offeringId, rank: 1 }] }, [{ offeringId: match.offeringId, sourceId: "projection",
          resourceId: match.resourceId ?? "ANY", startsAt: match.startsAt.toISOString(), endsAt: match.endsAt.toISOString(),
          capacity: match.capacity ?? 0, bookingUrl: match.bookingUrl }], match.course.timeZone);
        return matching.length ? [{ ...match, course }] : [];
      }
      const lastConfirmedAt = match.lastConfirmedAt;
      const completedLocalReaderSource = completedLocalReaderSources.get(
        match.course.id,
      );
      const providerObservationFence = providerObservationFences.get(
        match.course.id,
      );
      const latestMonitoringSourceAt = Math.max(
        monitoring?.lastSuccessfulAt instanceof Date
          ? monitoring.lastSuccessfulAt.getTime()
          : Number.NEGATIVE_INFINITY,
        monitoring?.lastFailureAt instanceof Date
          ? monitoring.lastFailureAt.getTime()
          : Number.NEGATIVE_INFINITY,
      );
      const sourceIsCurrent =
        match.availabilityStatus === "AVAILABLE" &&
        !["FINAL_MANUAL", "FINAL_TECHNICAL", "FINAL_IDENTITY"].includes(
          monitoring?.state ?? "",
        ) &&
        lastConfirmedAt instanceof Date &&
        Number.isFinite(lastConfirmedAt.getTime()) &&
        monitoring?.lastSuccessfulAt instanceof Date &&
        monitoring.lastSuccessfulAt.getTime() === lastConfirmedAt.getTime() &&
        (!(monitoring.lastFailureAt instanceof Date) ||
          monitoring.lastFailureAt < lastConfirmedAt) &&
        !providerObservationFence &&
        (!completedLocalReaderSource ||
          completedLocalReaderSource.state === "CONSUMED" ||
          latestMonitoringSourceAt >
            completedLocalReaderSource.providerObservedAt.getTime());
      return sourceIsCurrent && matchesCurrentSearchSettings(search, match)
        ? [{ ...match, course }]
        : [];
    }),
  };
}

function normalizeCoursePreferenceRankUpdates(
  preferences: CoursePreferenceRankUpdateInput[] | undefined,
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
        removalReason: "SEARCH_DELETED_BY_OWNER",
      },
    });
    return transaction.teeSearch.delete({
      where: {
        id: searchId,
        userId,
      },
    });
  });
}

async function assertQueueCapacity(userId: string, excludeSearchId?: string) {
  const queuedCount = await prisma.teeSearch.count({
    where: {
      userId,
      status: { in: [...QUEUED_SEARCH_STATUSES] },
      ...(excludeSearchId ? { id: { not: excludeSearchId } } : {}),
    },
  });

  if (queuedCount >= MAX_QUEUED_SEARCHES_PER_USER) {
    throw new Error(
      `You can keep up to ${MAX_QUEUED_SEARCHES_PER_USER} active or paused searches in the queue.`,
    );
  }
}

function normalizeAdditionalEmails(emails: string[] = []) {
  return [
    ...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

function normalizeAlertEmail(email: string | undefined) {
  return email?.trim().toLowerCase() || null;
}

function assertCourseLayoutsCompatible(
  preferences: Array<{
    course: {
      name: string;
      layoutHoleCounts: readonly number[];
      layoutHolesVerifiedAt: Date | null;
    };
  }>,
  requestedLayoutHoles: CourseLayoutHoleCount | null | undefined,
) {
  if (!requestedLayoutHoles) {
    return;
  }

  const incompatibleCourses = preferences
    .map((preference) => preference.course)
    .filter(
      (course) =>
        Boolean(course.layoutHolesVerifiedAt) &&
        getCourseLayoutCompatibility(
          course.layoutHoleCounts,
          requestedLayoutHoles,
        ) === "incompatible",
    );

  if (incompatibleCourses.length === 0) {
    return;
  }

  const details = incompatibleCourses
    .map(
      (course) =>
        `${course.name} (${getCourseLayoutLabel(course.layoutHoleCounts)})`,
    )
    .join(", ");
  throw new Error(
    `The selected course layout does not match this ${requestedLayoutHoles}-hole search: ${details}.`,
  );
}

export const searchInclude = {
  preferences: {
    orderBy: { rank: "asc" },
    include: { course: true, offering: true },
  },
  matches: {
    orderBy: { startsAt: "asc" },
    include: {
      offering: true,
      course: {
        include: {
          monitoringStatus: {
            select: {
              state: true,
              lastSuccessfulAt: true,
              lastFailureAt: true,
            },
          },
        },
      },
    },
  },
  probes: {
    orderBy: { observedAt: "desc" },
    take: 5,
    include: { course: true, offering: true },
  },
} satisfies Prisma.TeeSearchInclude;

const searchListInclude = {
  ...searchInclude,
  probes: false,
  matches: {
    orderBy: { startsAt: "asc" },
    include: {
      offering: true,
      course: {
        include: {
          monitoringStatus: {
            select: {
              state: true,
              lastSuccessfulAt: true,
              lastFailureAt: true,
            },
          },
        },
      },
    },
  },
  preferences: {
    orderBy: { rank: "asc" },
    include: {
      offering: true,
      course: {
        include: {
          bookingFacts: {
            orderBy: { holes: "asc" },
          },
          monitoringStatus: {
            select: { state: true, stateChangedAt: true },
          },
          profile: {
            select: {
              canonicalSlug: true,
              status: true,
            },
          },
          supportIncident: {
            select: {
              id: true,
              cycle: true,
              status: true,
              attemptLedger: true,
              humanReviewReason: true,
              escalatedAt: true,
              escalationDeadlineAt: true,
              firstSeenAt: true,
              monitoringEvents: {
                where: { eventType: "HUMAN_REVIEW_REQUESTED" },
                orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
                take: 5,
                select: {
                  incidentId: true,
                  eventType: true,
                  occurredAt: true,
                  audit: true,
                },
              },
            },
          },
        },
      },
    },
  },
  user: {
    select: { email: true },
  },
} satisfies Prisma.TeeSearchInclude;
