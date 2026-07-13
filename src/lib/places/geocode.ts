import { getGooglePlacesApiKey } from "@/lib/places/google";

export class LocationNotFoundError extends Error {
  constructor() {
    super("No matching location found.");
    this.name = "LocationNotFoundError";
  }
}

export async function geocodeLocation(query: string) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    return {
      latitude: 41.242,
      longitude: -73.209,
      demo: true
    };
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location"
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 1,
      regionCode: "US"
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places text search failed with ${response.status}`);
  }

  const json = (await response.json()) as {
    places?: Array<{
      location?: {
        latitude?: number;
        longitude?: number;
      };
    }>;
  };

  const location = json.places?.[0]?.location;
  if (location?.latitude === undefined || location.longitude === undefined) {
    throw new LocationNotFoundError();
  }

  return {
    latitude: location.latitude,
    longitude: location.longitude,
    demo: false
  };
}
