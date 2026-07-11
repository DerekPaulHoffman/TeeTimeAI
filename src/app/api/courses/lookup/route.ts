import { NextRequest, NextResponse } from "next/server";

import { getGooglePlacesApiKey, searchGolfCoursesByName } from "@/lib/places/google";

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 120;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? "";
  const latitudeValue = request.nextUrl.searchParams.get("latitude");
  const longitudeValue = request.nextUrl.searchParams.get("longitude");
  const hasLatitude = latitudeValue !== null;
  const hasLongitude = longitudeValue !== null;

  if (query.length < MIN_QUERY_LENGTH || query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `Enter a course name between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters.` },
      { status: 400 }
    );
  }

  if (hasLatitude !== hasLongitude) {
    return NextResponse.json(
      { error: "Latitude and longitude must be provided together." },
      { status: 400 }
    );
  }

  const latitude = hasLatitude ? Number(latitudeValue) : undefined;
  const longitude = hasLongitude ? Number(longitudeValue) : undefined;
  if (
    (latitude !== undefined && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) ||
    (longitude !== undefined && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180))
  ) {
    return NextResponse.json({ error: "Enter valid search coordinates." }, { status: 400 });
  }

  if (!getGooglePlacesApiKey()) {
    return NextResponse.json(
      { error: "Course lookup is temporarily unavailable. Try the nearby search instead." },
      { status: 503 }
    );
  }

  try {
    const courses = await searchGolfCoursesByName({ query, latitude, longitude });
    return NextResponse.json({ courses });
  } catch (error) {
    console.error(
      "Course lookup failed",
      error instanceof Error ? error.message : "Unknown course lookup error"
    );
    return NextResponse.json(
      { error: "Course lookup is temporarily unavailable. Try again in a moment." },
      { status: 502 }
    );
  }
}
