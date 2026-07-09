import { NextRequest, NextResponse } from "next/server";

import { demoCourses } from "@/lib/places/demo-courses";
import { searchNearbyGolfCourses } from "@/lib/places/google";

const DEFAULT_COURSE_SEARCH_RADIUS_METERS = 50000;
const MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS = 50000;

export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const requestedRadiusMeters = Number(
    request.nextUrl.searchParams.get("radiusMeters") ?? DEFAULT_COURSE_SEARCH_RADIUS_METERS
  );
  const radiusMeters = Number.isFinite(requestedRadiusMeters)
    ? Math.min(requestedRadiusMeters, MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS)
    : DEFAULT_COURSE_SEARCH_RADIUS_METERS;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return NextResponse.json({ error: "Latitude and longitude are required" }, { status: 400 });
  }

  if (!process.env.GOOGLE_PLACES_API_KEY) {
    return NextResponse.json({ courses: demoCourses, demo: true });
  }

  try {
    const courses = await searchNearbyGolfCourses({ latitude, longitude, radiusMeters });
    return NextResponse.json({ courses, demo: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not discover courses" },
      { status: 502 }
    );
  }
}
