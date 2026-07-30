import { NextRequest, NextResponse } from "next/server";

import { hasGooglePlacesConfig, isVercelProduction } from "@/lib/env";
import { geocodeLocation } from "@/lib/places/geocode";
import {
  geocodeSuccessCacheHeaders,
  getGeocodeErrorResponse
} from "@/lib/places/geocode-response";

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
