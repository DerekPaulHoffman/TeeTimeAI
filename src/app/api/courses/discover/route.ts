import { NextRequest, NextResponse } from "next/server";

import { demoCourses } from "@/lib/places/demo-courses";
import { searchNearbyGolfCourses } from "@/lib/places/google";
import { normalizeCourseSearchRadiusMeters } from "@/lib/places/radius";

export async function GET(request: NextRequest) {
  const latitude = Number(request.nextUrl.searchParams.get("latitude"));
  const longitude = Number(request.nextUrl.searchParams.get("longitude"));
  const radiusMeters = normalizeCourseSearchRadiusMeters(
    request.nextUrl.searchParams.get("radiusMeters")
  );

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
