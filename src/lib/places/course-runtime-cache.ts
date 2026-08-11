import { getCache } from "@vercel/functions";

const COURSE_CACHE_TTL_SECONDS = 31_536_000;

export async function readCourseRuntimeCache<T>(key: string): Promise<T | null> {
  if (process.env.VERCEL_ENV !== "production") {
    return null;
  }

  try {
    return (await getCourseCache().get(key)) as T | null;
  } catch (error) {
    console.warn(
      "Course runtime cache read unavailable",
      error instanceof Error ? error.message : "Unknown runtime cache error"
    );
    return null;
  }
}

export async function writeCourseRuntimeCache(
  key: string,
  value: unknown,
  name: "course-discovery" | "course-lookup" | "course-photo" | "course-photo-metadata"
) {
  if (process.env.VERCEL_ENV !== "production") {
    return;
  }

  try {
    await getCourseCache().set(key, value, {
      name,
      tags: [name],
      ttl: COURSE_CACHE_TTL_SECONDS
    });
  } catch (error) {
    console.warn(
      "Course runtime cache write unavailable",
      error instanceof Error ? error.message : "Unknown runtime cache error"
    );
  }
}

export function getCourseDiscoveryCacheKey(input: {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  reviewVersion: string;
}) {
  return [
    "discover-v2",
    input.reviewVersion,
    input.latitude.toFixed(3),
    input.longitude.toFixed(3),
    input.radiusMeters
  ].join(":");
}

export function getCourseLookupCacheKey(input: {
  query: string;
  latitude?: number;
  longitude?: number;
  reviewVersion: string;
}) {
  const normalizedQuery = input.query.trim().replace(/\s+/g, " ").toLowerCase();
  return [
    "lookup-v2",
    input.reviewVersion,
    normalizedQuery,
    input.latitude?.toFixed(3) ?? "none",
    input.longitude?.toFixed(3) ?? "none"
  ].join(":");
}

export function getCoursePhotoCacheKey(photoReference: string) {
  return `photo-v1:${photoReference}`;
}

export function getCoursePhotoMetadataCacheKey(googlePlaceId: string) {
  return `photo-metadata-v1:${googlePlaceId.trim()}`;
}

function getCourseCache() {
  return getCache({ namespace: "tee-time-spot-course-data" });
}
