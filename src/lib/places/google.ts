export type GooglePlace = {
  id?: string;
  name?: string;
  displayName?: {
    text?: string;
  };
  formattedAddress?: string;
  businessStatus?: string;
  primaryType?: string;
  types?: string[];
  location?: {
    latitude?: number;
    longitude?: number;
  };
  rating?: number;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  photos?: Array<{
    name?: string;
    authorAttributions?: Array<{
      displayName?: string;
      uri?: string;
      photoUri?: string;
    }>;
  }>;
};

export type CoursePhotoAttribution = {
  displayName?: string;
  uri?: string;
  photoUri?: string;
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
  photoAttributions?: CoursePhotoAttribution[];
};

export type NearbyCourseSearchInput = {
  latitude: number;
  longitude: number;
  radiusMeters?: number;
};

const NON_PUBLIC_PRIMARY_TYPES = new Set([
  "association_or_organization",
  "indoor_golf_course",
  "sporting_goods_store",
  "sports_club"
]);

const PRIVATE_OR_NON_COURSE_NAME_PATTERNS = [
  /\bcountry\s+club\b/i,
  /\bprivate\b/i,
  /\bmembers?\s+only\b/i,
  /\bgolf\s+galaxy\b/i,
  /\bpga\s+tour\s+superstore\b/i,
  /\bdick'?s\s+sporting\s+goods\b/i,
  /\bx[-\s]?golf\b/i,
  /\bgolf\s+lounge\b/i,
  /\bsimulator\b/i,
  /\bindoor\b/i
];

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
    photoName: place.photos?.[0]?.name,
    photoAttributions: place.photos?.[0]?.authorAttributions
  };
}

export function filterPublicGolfCoursePlaces(places: GooglePlace[]) {
  return places.filter(isLikelyPublicGolfCoursePlace);
}

function isLikelyPublicGolfCoursePlace(place: GooglePlace) {
  const name = place.displayName?.text ?? "";

  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
    return false;
  }

  if (place.primaryType !== "golf_course") {
    return false;
  }

  if (!place.types?.includes("golf_course")) {
    return false;
  }

  if (NON_PUBLIC_PRIMARY_TYPES.has(place.primaryType)) {
    return false;
  }

  return !PRIVATE_OR_NON_COURSE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

export async function searchNearbyGolfCourses(input: NearbyCourseSearchInput) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  const response = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri,places.photos,places.types,places.primaryType,places.businessStatus"
    },
    body: JSON.stringify({
      includedTypes: ["golf_course"],
      excludedPrimaryTypes: Array.from(NON_PUBLIC_PRIMARY_TYPES),
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
  return filterPublicGolfCoursePlaces(json.places ?? []).map(mapGooglePlaceToCourseCandidate);
}

function normalizePlaceId(id: string) {
  return id.replace(/^places\//, "");
}

export function getGooglePlacesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY?.replace(/^\uFEFF/, "").trim();
}
