import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { geocodeLocation, LocationNotFoundError } from "@/lib/places/geocode";

const LOCATION_NOT_FOUND_MESSAGE =
  "We couldn't find that location. Check the city, state, or ZIP code and try again.";

export const geocodeSuccessCacheHeaders = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Vercel-CDN-Cache-Control":
    "max-age=86400, stale-while-revalidate=604800, stale-if-error=86400"
} as const;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  if (!hasGooglePlacesConfig() && isVercelProduction()) {
    return NextResponse.json(
      { error: "Location search is temporarily unavailable. Try again in a moment." },
      { status: 503 }
    );
  }

  try {
    const result = await geocodeLocation(query);
    return NextResponse.json(result, { headers: geocodeSuccessCacheHeaders });
  } catch (error) {
    const response = getGeocodeErrorResponse(error);
    return NextResponse.json(
      { error: response.message },
      { status: response.status }
    );
  }
}

export function getGeocodeErrorResponse(error: unknown) {
  if (error instanceof LocationNotFoundError) {
    return { message: LOCATION_NOT_FOUND_MESSAGE, status: 404 };
  }

  return {
    message: error instanceof Error ? error.message : "Could not geocode location",
    status: 502
  };
}
