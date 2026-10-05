import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { demoCourses } from "@/lib/places/demo-courses";
import { enrichCoursesWithAlertSupport } from "@/lib/places/alert-support";
import { clearCourseMonitoringEvidence } from "@/lib/places/course-monitoring-evidence";
import { courseDataSuccessCacheHeaders } from "@/lib/places/course-data-cache";
import { cacheCourseCandidatePhotos } from "@/lib/places/course-photo-metadata";
import {
  getCourseDiscoveryCacheKey,
  readCourseRuntimeCache,
  writeCourseRuntimeCache
} from "@/lib/places/course-runtime-cache";
import { searchNearbyGolfCourses, type CourseCandidate } from "@/lib/places/google";
import { loadActiveGooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";
import { enrichCoursesWithHoleLayouts } from "@/lib/places/hole-layout-enrichment";
import { normalizeCourseSearchRadiusMeters } from "@/lib/places/radius";
import { findPersistedNearbyCourseCandidates } from "@/lib/places/persisted-course-fallback";
import { enrichCoursesWithBookingEvidence } from "@/lib/pricing/course-price-enrichment";
import { simulatorDiscoveryResponse } from "@/lib/places/simulator-route-response";
import { excludeSimulatorOnlyOutdoorCandidates, loadSimulatorOnlyPlaceIds } from "@/lib/places/outdoor-simulator-identity";
import { isSimulatorModeEnabled } from "@/lib/simulators/config";

const COURSE_DISCOVERY_UNAVAILABLE_MESSAGE =
  "We couldn't load nearby courses right now. Please wait a moment and try again.";

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode") ?? "OUTDOOR";
  if (mode !== "OUTDOOR" && mode !== "SIMULATOR") {
    return NextResponse.json({ error: "Choose outdoor golf or simulator venues." }, { status: 400 });
  }
  if (mode === "SIMULATOR" && !isSimulatorModeEnabled()) {
    return NextResponse.json({ error: "Simulator alerts are not available yet." }, { status: 503 });
  }
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const radiusMeters = normalizeCourseSearchRadiusMeters(
    request.nextUrl.searchParams.get("radiusMeters")
  );
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return NextResponse.json({ error: "Latitude and longitude are required" }, { status: 400 });
  }

  if (!hasGooglePlacesConfig() && isVercelProduction()) {
    return NextResponse.json({ error: COURSE_DISCOVERY_UNAVAILABLE_MESSAGE }, { status: 503 });
  }

  if (!hasGooglePlacesConfig()) {
    return NextResponse.json(
      mode === "SIMULATOR" ? { courses: [], mode, demo: true } : { courses: demoCourses, demo: true },
      { headers: courseDataSuccessCacheHeaders }
    );
  }

  if (mode === "SIMULATOR") {
    return simulatorDiscoveryResponse({ latitude, longitude, radiusMeters, signal: request.signal });
  }

  let reviewIndex: Awaited<ReturnType<typeof loadActiveGooglePlaceReviewIndex>>;
  let simulatorOnlyPlaceIds: Awaited<ReturnType<typeof loadSimulatorOnlyPlaceIds>>;
  try {
    [reviewIndex, simulatorOnlyPlaceIds] = await Promise.all([
      loadActiveGooglePlaceReviewIndex(), loadSimulatorOnlyPlaceIds()
    ]);
  } catch {
    return NextResponse.json({ error: COURSE_DISCOVERY_UNAVAILABLE_MESSAGE }, { status: 503 });
  }

  const cacheKey = getCourseDiscoveryCacheKey({
    latitude,
    longitude,
    radiusMeters,
    reviewVersion: reviewIndex.reviewVersion
  });

  try {
    const cachedCourses = await readCourseRuntimeCache<unknown[]>(cacheKey);
    if (Array.isArray(cachedCourses)) {
      const currentCourses = await enrichCoursesWithAlertSupport(
        excludeSimulatorOnlyOutdoorCandidates(cachedCourses as CourseCandidate[], simulatorOnlyPlaceIds, reviewIndex)
          .map(clearCourseMonitoringEvidence),
      );
      await cacheCourseCandidatePhotos(currentCourses);
      return NextResponse.json(
        { courses: currentCourses, demo: false },
        { headers: courseDataSuccessCacheHeaders }
      );
    }

    const courses = await searchNearbyGolfCourses(
      {
        latitude,
        longitude,
        radiusMeters,
        signal: request.signal
      },
      reviewIndex
    );
    const outdoorCourses = excludeSimulatorOnlyOutdoorCandidates(courses, simulatorOnlyPlaceIds, reviewIndex);
    const coursesWithSupport = await enrichCoursesWithAlertSupport(outdoorCourses).catch((error) => {
      console.warn(
        "Course alert-support enrichment unavailable",
        error instanceof Error ? error.message : "Unknown alert-support error"
      );
      return outdoorCourses;
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
    const coursesWithPrices = await enrichCoursesWithBookingEvidence(coursesWithLayouts).catch(
      (error) => {
        console.warn(
          "Course pricing enrichment unavailable",
          error instanceof Error ? error.message : "Unknown pricing error"
        );
        return coursesWithLayouts;
      }
    );
    await Promise.all([
      writeCourseRuntimeCache(cacheKey, coursesWithPrices, "course-discovery"),
      cacheCourseCandidatePhotos(coursesWithPrices)
    ]);
    return NextResponse.json(
      { courses: coursesWithPrices, demo: false },
      { headers: courseDataSuccessCacheHeaders }
    );
  } catch {
    try {
      const persistedCourses = await findPersistedNearbyCourseCandidates({
        latitude,
        longitude,
        radiusMeters
      }, reviewIndex);
      const outdoorCourses = excludeSimulatorOnlyOutdoorCandidates(persistedCourses, simulatorOnlyPlaceIds, reviewIndex);
      if (outdoorCourses.length > 0) {
        const coursesWithSupport = await enrichCoursesWithAlertSupport(outdoorCourses);
        const coursesWithLayouts = await enrichCoursesWithHoleLayouts(coursesWithSupport);
        const coursesWithPrices = await enrichCoursesWithBookingEvidence(coursesWithLayouts);
        await Promise.all([
          writeCourseRuntimeCache(cacheKey, coursesWithPrices, "course-discovery"),
          cacheCourseCandidatePhotos(coursesWithPrices)
        ]);
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

    return NextResponse.json({ error: COURSE_DISCOVERY_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
}
