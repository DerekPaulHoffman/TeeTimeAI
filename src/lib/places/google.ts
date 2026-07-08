export type GooglePlace = {
  id?: string;
  name?: string;
  displayName?: {
    text?: string;
  };
  formattedAddress?: string;
  location?: {
    latitude?: number;
    longitude?: number;
  };
  rating?: number;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  photos?: Array<{ name?: string }>;
};

export type CourseCandidate = {
  googlePlaceId: string;
  name: string;
  address?: string;
  latitude: number;
  longitude: number;
  rating?: number;
  phone?: string;
  website?: string;
  photoName?: string;
};

export type NearbyCourseSearchInput = {
  latitude: number;
  longitude: number;
  radiusMeters?: number;
};

export function mapGooglePlaceToCourseCandidate(place: GooglePlace): CourseCandidate {
  const googlePlaceId = normalizePlaceId(place.id ?? place.name ?? "");
  const name = place.displayName?.text;
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;

  if (!googlePlaceId || !name || latitude === undefined || longitude === undefined) {
    throw new Error("Google Places response is missing required course fields");
  }

  return {
    googlePlaceId,
    name,
    address: place.formattedAddress,
    latitude,
    longitude,
    rating: place.rating,
    phone: place.nationalPhoneNumber,
    website: place.websiteUri,
    photoName: place.photos?.[0]?.name
  };
}

export async function searchNearbyGolfCourses(input: NearbyCourseSearchInput) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri,places.photos"
    },
    body: JSON.stringify({
      includedTypes: ["golf_course"],
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: {
            latitude: input.latitude,
            longitude: input.longitude
          },
          radius: input.radiusMeters ?? 30000
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places nearby search failed with ${response.status}`);
  }

  const json = (await response.json()) as { places?: GooglePlace[] };
  return (json.places ?? []).map(mapGooglePlaceToCourseCandidate);
}

function normalizePlaceId(id: string) {
  return id.replace(/^places\//, "");
}
