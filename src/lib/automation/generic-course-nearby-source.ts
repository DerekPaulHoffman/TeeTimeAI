import { isSafeManualEvidenceUrl } from "./browser-discovery";
import {
  isExplicitCourseIdentityName,
  isGenericCourseName,
  normalizeCourseIdentityName,
} from "@/lib/places/course-identity";

export type GenericCourseLocation = {
  name: string;
  googlePlaceId: string | null;
  address: string | null;
  city: string | null;
  stateCode: string | null;
  latitude: number;
  longitude: number;
  website: string | null;
  isPublic: boolean | null;
};

export type NearbyOfficialCourse = {
  googlePlaceId: string;
  name: string;
  address: string | null;
  city: string | null;
  stateCode: string | null;
  latitude: number;
  longitude: number;
  website: string | null;
};

/** Some typed golf-course places use a distinctive course name without the
 * words "golf course" (for example, a named second course at one facility). */
export function isSufficientNearbyCourseName(name: string) {
  return !isGenericCourseName(name) &&
    (isExplicitCourseIdentityName(name) ||
      normalizeCourseIdentityName(name).split(" ").filter(Boolean).length >= 2);
}

function normalizedPlaceId(value: string | null) {
  return value?.trim().replace(/^places\//u, "") || null;
}

function normalizedLocality(value: string | null) {
  return value?.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
    .trim().toLocaleLowerCase("en-US") || null;
}

function zipCode(value: string | null) {
  return value?.match(/\b\d{5}(?:-\d{4})?\b/u)?.[0]?.slice(0, 5) ?? null;
}

function safeWebsite(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isSafeManualEvidenceUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function distanceMeters(a: GenericCourseLocation, b: NearbyOfficialCourse) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(b.latitude - a.latitude);
  const longitudeDelta = radians(b.longitude - a.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) *
    Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

/**
 * A generic map feature may sit on a real course fairway, far from its
 * clubhouse. This selects a research candidate only; the official page must
 * independently corroborate its name before any Course row is changed.
 */
export function selectUniqueNearbyOfficialCourse(
  course: GenericCourseLocation,
  nearby: readonly NearbyOfficialCourse[],
) {
  const placeId = normalizedPlaceId(course.googlePlaceId);
  const stateCode = course.stateCode?.trim().toUpperCase() ?? null;
  if (!isGenericCourseName(course.name) || course.isPublic !== true ||
      !placeId || !/^[A-Z]{2}$/u.test(stateCode ?? "") ||
      !Number.isFinite(course.latitude) || !Number.isFinite(course.longitude) ||
      !nearby.some(candidate =>
        normalizedPlaceId(candidate.googlePlaceId) === placeId &&
        distanceMeters(course, candidate) <= 100)) {
    return null;
  }
  const originalWebsite = course.website ? safeWebsite(course.website) : null;
  if (course.website && !originalWebsite) return null;
  const originalCity = normalizedLocality(course.city);
  const originalZip = zipCode(course.address);
  if (!originalCity && !originalZip) return null;

  const named = [...new Map(nearby
    .filter(candidate => normalizedPlaceId(candidate.googlePlaceId) !== placeId)
    .filter(candidate => isSufficientNearbyCourseName(candidate.name) &&
      Number.isFinite(candidate.latitude) && Number.isFinite(candidate.longitude))
    .map(candidate => [normalizedPlaceId(candidate.googlePlaceId), candidate] as const))
    .values()]
    .map(candidate => ({ candidate, distanceMeters: distanceMeters(course, candidate) }))
    .filter(result => result.distanceMeters <= 800)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  if (named.length !== 1 || named[0].distanceMeters > 500) return null;

  const candidate = named[0].candidate;
  const website = safeWebsite(candidate.website);
  if (!website || !/^\s*\d+[a-z]?\s+\S+/iu.test(candidate.address ?? "") ||
      candidate.stateCode?.trim().toUpperCase() !== stateCode ||
      (originalCity
        ? normalizedLocality(candidate.city) !== originalCity
        : zipCode(candidate.address) !== originalZip) ||
      (originalWebsite && originalWebsite.hostname.replace(/^www\./iu, "") !==
        website.hostname.replace(/^www\./iu, ""))) {
    return null;
  }
  return { candidate, distanceMeters: named[0].distanceMeters };
}
