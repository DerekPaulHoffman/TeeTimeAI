import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { demoCourses } from "@/lib/places/demo-courses";
import { enrichCoursesWithAlertSupport } from "@/lib/places/alert-support";
import { searchNearbyGolfCourses } from "@/lib/places/google";
import { GooglePlaceReviewsUnavailableError } from "@/lib/places/google-place-reviews";
import { enrichCoursesWithHoleLayouts } from "@/lib/places/hole-layout-enrichment";
import { normalizeCourseSearchRadiusMeters } from "@/lib/places/radius";
import { enrichCoursesWithPriceEstimates } from "@/lib/pricing/course-price-enrichment";

export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const radiusMeters = normalizeCourseSearchRadiusMeters(
    request.nextUrl.searchParams.get("radiusMeters")
  );

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
    return NextResponse.json({ courses: demoCourses, demo: true });
  }

  try {
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
    const coursesWithPrices = await enrichCoursesWithPriceEstimates(coursesWithLayouts).catch((error) => {
      console.warn(
        "Course pricing enrichment unavailable",
        error instanceof Error ? error.message : "Unknown pricing error"
      );
      return coursesWithLayouts;
    });
    return NextResponse.json({ courses: coursesWithPrices, demo: false });
  } catch (error) {
    if (error instanceof GooglePlaceReviewsUnavailableError) {
      return NextResponse.json(
        { error: "Course discovery is temporarily unavailable. Try again in a moment." },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not discover courses" },
      { status: 502 }
    );
  }
}
