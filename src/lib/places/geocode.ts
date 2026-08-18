import { getGooglePlacesApiKey } from "@/lib/places/google";
import { fetchGooglePlacesJsonWithRetry } from "@/lib/places/google-places-request";

export class LocationNotFoundError extends Error {
  constructor() {
    super("No matching location found.");
    this.name = "LocationNotFoundError";
  }
}

export async function geocodeLocation(query: string, signal?: AbortSignal) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    return {
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    };
  }

  const endpoint = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  endpoint.searchParams.set("address", query);
  endpoint.searchParams.set("region", "us");
  endpoint.searchParams.set("key", apiKey);

  const { response, json } = await fetchGooglePlacesJsonWithRetry<{
    status?: string;
    results?: Array<{
      geometry?: {
        location?: {
          lat?: number;
          lng?: number;
        };
      };
    }>;
  }>(endpoint, { signal });

  if (!response.ok) {
    throw new Error(`Google Geocoding request failed with ${response.status}`);
  }

  if (json?.status === "ZERO_RESULTS") {
    throw new LocationNotFoundError();
  }
  if (json?.status !== "OK") {
    throw new Error(`Google Geocoding request failed with ${json?.status ?? "UNKNOWN"}`);
  }

  const location = json.results?.[0]?.geometry?.location;
  if (location?.lat === undefined || location.lng === undefined) {
    throw new LocationNotFoundError();
  }

  return {
    latitude: location.lat,
    longitude: location.lng,
    demo: false
  };
}
