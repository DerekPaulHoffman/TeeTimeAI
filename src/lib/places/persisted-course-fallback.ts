import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

const EARTH_RADIUS_METERS = 6_371_000;
const MAX_FALLBACK_COURSES = 500;
const LOOKUP_STOP_WORDS = new Set(["at", "club", "course", "golf", "of", "the"]);

const persistedCourseSelect = {
  id: true,
  googlePlaceId: true,
  name: true,
  address: true,
  city: true,
  stateCode: true,
  stateName: true,
  county: true,
  countryCode: true,
  latitude: true,
  longitude: true,
  timeZone: true,
  rating: true,
  ratingObservedAt: true,
  website: true,
  detectedBookingUrl: true,
  phone: true
} as const;

type PersistedCourse = {
  id: string;
  googlePlaceId: string | null;
  name: string;
  address: string | null;
  city: string | null;
  stateCode: string | null;
  stateName: string | null;
  county: string | null;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  timeZone: string;
  rating: number | null;
  ratingObservedAt: Date | null;
  website: string | null;
  detectedBookingUrl: string | null;
  phone: string | null;
};

export async function findPersistedNearbyCourseCandidates(input: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}) {
  const latitudeDelta = input.radiusMeters / 111_320;
  const longitudeScale = Math.max(
    Math.cos((input.latitude * Math.PI) / 180),
    0.2
  );
  const longitudeDelta = input.radiusMeters / (111_320 * longitudeScale);
  const courses = await prisma.course.findMany({
    where: {
      googlePlaceId: { not: null },
      OR: [{ isPublic: true }, { isPublic: null }],
      latitude: {
        gte: input.latitude - latitudeDelta,
        lte: input.latitude + latitudeDelta
      },
      longitude: {
        gte: input.longitude - longitudeDelta,
        lte: input.longitude + longitudeDelta
      }
    },
    orderBy: { updatedAt: "desc" },
    select: persistedCourseSelect,
    take: MAX_FALLBACK_COURSES
  });

  return courses
    .map((course) => ({
      ...mapPersistedCourse(course),
      distanceMeters: getDistanceMeters(input, course)
    }))
    .filter((course) => course.distanceMeters <= input.radiusMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
}

export async function findPersistedCourseCandidatesByName(query: string) {
  const queryTokens = getLookupTokens(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const courses = await prisma.course.findMany({
    where: {
      googlePlaceId: { not: null },
      OR: [{ isPublic: true }, { isPublic: null }]
    },
    orderBy: { updatedAt: "desc" },
    select: persistedCourseSelect,
    take: MAX_FALLBACK_COURSES
  });

  return courses
    .map((course) => ({
      course,
      score: getLookupMatchScore(queryTokens, course)
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map(({ course }) => mapPersistedCourse(course));
}

function mapPersistedCourse(course: PersistedCourse): CourseCandidate {
  return {
    courseId: course.id,
    googlePlaceId: course.googlePlaceId as string,
    name: course.name,
    ...(course.address ? { address: course.address } : {}),
    ...(course.city ? { city: course.city } : {}),
    ...(course.stateCode ? { stateCode: course.stateCode } : {}),
    ...(course.stateName ? { stateName: course.stateName } : {}),
    ...(course.county ? { county: course.county } : {}),
    ...(course.countryCode ? { countryCode: course.countryCode } : {}),
    latitude: course.latitude,
    longitude: course.longitude,
    timeZone: course.timeZone,
    ...(course.rating !== null ? { rating: course.rating } : {}),
    ...(course.ratingObservedAt
      ? { ratingObservedAt: course.ratingObservedAt.toISOString() }
      : {}),
    ...(course.phone ? { phone: course.phone } : {}),
    ...(course.detectedBookingUrl || course.website
      ? { website: course.detectedBookingUrl ?? course.website ?? undefined }
      : {})
  };
}

function getLookupTokens(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !LOOKUP_STOP_WORDS.has(token));
}

function getLookupMatchScore(tokens: string[], course: PersistedCourse) {
  const name = normalizeLookupText(course.name);
  const context = normalizeLookupText(
    [course.name, course.city, course.stateCode, course.stateName, course.address]
      .filter(Boolean)
      .join(" ")
  );
  if (!tokens.every((token) => context.includes(token))) {
    return 0;
  }

  return tokens.reduce(
    (score, token) => score + (name.includes(token) ? 2 : 1),
    0
  );
}

function normalizeLookupText(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ");
}

function getDistanceMeters(
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number }
) {
  const latitudeDelta = toRadians(destination.latitude - origin.latitude);
  const longitudeDelta = toRadians(destination.longitude - origin.longitude);
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(destination.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) *
      Math.cos(destinationLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}
