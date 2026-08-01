import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { demoCourses } from "@/lib/places/demo-courses";
import { enrichCoursesWithAlertSupport } from "@/lib/places/alert-support";
import { courseDataSuccessCacheHeaders } from "@/lib/places/course-data-cache";
import {
  getCourseDiscoveryCacheKey,
  readCourseRuntimeCache,
  writeCourseRuntimeCache
} from "@/lib/places/course-runtime-cache";
import { searchNearbyGolfCourses } from "@/lib/places/google";
import { GooglePlaceReviewsUnavailableError } from "@/lib/places/google-place-reviews";
import { enrichCoursesWithHoleLayouts } from "@/lib/places/hole-layout-enrichment";
import { normalizeCourseSearchRadiusMeters } from "@/lib/places/radius";
import { findPersistedNearbyCourseCandidates } from "@/lib/places/persisted-course-fallback";
import { enrichCoursesWithBookingEvidence } from "@/lib/pricing/course-price-enrichment";

export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const radiusMeters = normalizeCourseSearchRadiusMeters(
    request.nextUrl.searchParams.get("radiusMeters")
  );
  const cacheKey = getCourseDiscoveryCacheKey({ latitude, longitude, radiusMeters });

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return NextResponse.json({ error: "Latitude and longitude are required" }, { status: 400 });
  }

  if (!hasGooglePlacesConfig() && isVercelProduction()) {
    return NextResponse.json(
      { error: "Course discovery is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  if (!hasGooglePlacesConfig()) {
    return NextResponse.json(
      { courses: demoCourses, demo: true },
      { headers: courseDataSuccessCacheHeaders }
    );
  }

  try {
    const cachedCourses = await readCourseRuntimeCache<unknown[]>(cacheKey);
    if (Array.isArray(cachedCourses)) {
      return NextResponse.json(
        { courses: cachedCourses, demo: false },
        { headers: courseDataSuccessCacheHeaders }
      );
    }

    const courses = await searchNearbyGolfCourses({ latitude, longitude, radiusMeters });
    const coursesWithSupport = await enrichCoursesWithAlertSupport(courses).catch((error) => {
      console.warn(
        "Course alert-support enrichment unavailable",
        error instanceof Error ? error.message : "Unknown alert-support error"
      );
      return courses;
    });
    const coursesWithLayouts = await enrichCoursesWithHoleLayouts(coursesWithSupport).catch(
      (error) => {
        console.warn(
          "Course hole-layout enrichment unavailable",
          error instanceof Error ? error.message : "Unknown hole-layout error"
        );
        return coursesWithSupport;
      }
    );
    const coursesWithPrices = await enrichCoursesWithBookingEvidence(coursesWithLayouts).catch((error) => {
      console.warn(
        "Course pricing enrichment unavailable",
        error instanceof Error ? error.message : "Unknown pricing error"
      );
      return coursesWithLayouts;
    });
    await writeCourseRuntimeCache(cacheKey, coursesWithPrices, "course-discovery");
    return NextResponse.json(
      { courses: coursesWithPrices, demo: false },
      { headers: courseDataSuccessCacheHeaders }
    );
  } catch (error) {
    if (error instanceof GooglePlaceReviewsUnavailableError) {
      return NextResponse.json(
        { error: "Course discovery is temporarily unavailable. Try again in a moment." },
        { status: 503 }
      );
    }

    try {
      const persistedCourses = await findPersistedNearbyCourseCandidates({
        latitude,
        longitude,
        radiusMeters
      });
      if (persistedCourses.length > 0) {
        const coursesWithSupport = await enrichCoursesWithAlertSupport(persistedCourses);
        const coursesWithLayouts = await enrichCoursesWithHoleLayouts(coursesWithSupport);
        const coursesWithPrices = await enrichCoursesWithBookingEvidence(coursesWithLayouts);
        await writeCourseRuntimeCache(cacheKey, coursesWithPrices, "course-discovery");
        return NextResponse.json(
          { courses: coursesWithPrices, demo: false },
          { headers: courseDataSuccessCacheHeaders }
        );
      }
    } catch (fallbackError) {
      console.warn(
        "Persisted course discovery fallback unavailable",
        fallbackError instanceof Error ? fallbackError.message : "Unknown fallback error"
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not discover courses" },
      { status: 502 }
    );
  }
}
