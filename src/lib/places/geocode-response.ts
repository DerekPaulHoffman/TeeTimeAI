import { LocationNotFoundError } from "@/lib/places/geocode";

const LOCATION_NOT_FOUND_MESSAGE =
  "We couldn't find that location. Check the city, state, or ZIP code and try again.";
export const LOCATION_SEARCH_UNAVAILABLE_MESSAGE =
  "We couldn't search that location right now. Please wait a moment and try again.";

export const geocodeSuccessCacheHeaders = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "Vercel-CDN-Cache-Control":
    "max-age=86400, stale-while-revalidate=604800, stale-if-error=86400"
} as const;

export function getGeocodeErrorResponse(error: unknown) {
  if (error instanceof LocationNotFoundError) {
    return { message: LOCATION_NOT_FOUND_MESSAGE, status: 404 };
  }

  return {
    message: LOCATION_SEARCH_UNAVAILABLE_MESSAGE,
    status: 503
  };
}
