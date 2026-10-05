import { NextResponse } from "next/server";

import { courseDataSuccessCacheHeaders } from "@/lib/places/course-data-cache";
import { cacheCourseCandidatePhotos } from "@/lib/places/course-photo-metadata";
import { getCourseDiscoveryCacheKey, getCourseLookupCacheKey, readCourseRuntimeCache, writeCourseRuntimeCache } from "@/lib/places/course-runtime-cache";
import type { CourseCandidate, CourseNameSearchInput, NearbyCourseSearchInput } from "@/lib/places/google";
import { loadActiveGooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";
import { searchNearbySimulatorVenues, searchSimulatorVenuesByName, simulatorDistanceMeters } from "@/lib/places/simulator-google";
import { getPersistedSimulatorCandidates, loadSimulatorOfferingIndex, mapSimulatorCandidate } from "@/lib/places/simulator-offerings";

export async function simulatorDiscoveryResponse(input: NearbyCourseSearchInput & { radiusMeters: number }) {
  return simulatorResponse({ discovery: input });
}

export async function simulatorLookupResponse(input: CourseNameSearchInput) {
  return simulatorResponse({ lookup: input });
}

async function simulatorResponse(input: { discovery: NearbyCourseSearchInput & { radiusMeters: number }; lookup?: never } | { lookup: CourseNameSearchInput; discovery?: never }) {
  try {
    const [reviews, offerings] = await Promise.all([loadActiveGooglePlaceReviewIndex(), loadSimulatorOfferingIndex()]);
    const reviewVersion = `${reviews.reviewVersion}:rentals:${offerings.reviewVersion}`;
    const cacheKey = input.discovery ? getCourseDiscoveryCacheKey({ ...input.discovery, mode: "SIMULATOR", reviewVersion }) :
      getCourseLookupCacheKey({ ...input.lookup, mode: "SIMULATOR", reviewVersion });
    const cached = await readCourseRuntimeCache<CourseCandidate[]>(cacheKey);
    let courses: CourseCandidate[];
    if (Array.isArray(cached)) {
      courses = cached.map((candidate) => mapSimulatorCandidate(candidate, offerings));
    } else {
      try {
        courses = input.discovery ? await searchNearbySimulatorVenues(input.discovery, reviews, offerings) :
          await searchSimulatorVenuesByName(input.lookup, reviews, offerings);
      } catch (error) {
        const signal = input.discovery?.signal ?? input.lookup?.signal;
        if (signal?.aborted) throw error;
        courses = getPersistedSimulatorCandidates(offerings);
        if (input.discovery) {
          const origin = input.discovery;
          courses = courses.map((course) => ({ ...course, distanceMeters: simulatorDistanceMeters(origin, course) }))
            .filter((course) => (course.distanceMeters ?? Infinity) <= origin.radiusMeters)
            .sort((left, right) => (left.distanceMeters ?? Infinity) - (right.distanceMeters ?? Infinity));
        } else {
          const tokens = input.lookup.query.toLowerCase().split(/\s+/).filter(Boolean);
          courses = courses.filter((course) => tokens.every((token) =>
            `${course.name} ${course.address ?? ""}`.toLowerCase().includes(token))).slice(0, 8);
        }
        if (!courses.length) throw error;
      }
      await writeCourseRuntimeCache(cacheKey, courses, input.discovery ? "course-discovery" : "course-lookup");
    }
    await cacheCourseCandidatePhotos(courses);
    return NextResponse.json({ courses, mode: "SIMULATOR", ...(input.discovery ? { demo: false } : {}) },
      { headers: courseDataSuccessCacheHeaders });
  } catch {
    return NextResponse.json({ error: "Simulator venues are temporarily unavailable. Please try again in a moment." }, { status: 503 });
  }
}
