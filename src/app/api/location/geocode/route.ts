import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { geocodeLocation } from "@/lib/places/geocode";
import {
  geocodeSuccessCacheHeaders,
  getGeocodeErrorResponse,
  LOCATION_SEARCH_UNAVAILABLE_MESSAGE
} from "@/lib/places/geocode-response";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ error: "Missing q parameter" }, { status: 400 });
  }

  if (!hasGooglePlacesConfig() && isVercelProduction()) {
    return NextResponse.json(
      { error: LOCATION_SEARCH_UNAVAILABLE_MESSAGE },
      { status: 503 }
    );
  }

  try {
    const result = await geocodeLocation(query, request.signal);
    return NextResponse.json(result, { headers: geocodeSuccessCacheHeaders });
  } catch (error) {
    const response = getGeocodeErrorResponse(error);
    return NextResponse.json(
      { error: response.message },
      { status: response.status }
    );
  }
}
