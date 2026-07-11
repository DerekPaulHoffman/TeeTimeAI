import type { CoursePriceEstimate } from "@/lib/pricing/course-prices";
import type { CourseAlertSupport } from "@/lib/courses/intelligence";
import { getTimeZoneForCoordinates } from "@/lib/timezones";

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
  containingPlaces?: Array<{
    name?: string;
    id?: string;
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
  timeZone: string;
  distanceMeters?: number;
  rating?: number;
  phone?: string;
  website?: string;
  photoReference?: string;
  photoAttributions?: CoursePhotoAttribution[];
  priceEstimate?: CoursePriceEstimate;
  alertSupport?: CourseAlertSupport;
};

export type NearbyCourseSearchInput = {
  latitude: number;
  longitude: number;
  radiusMeters?: number;
};

export type CourseNameSearchInput = {
  query: string;
  latitude?: number;
  longitude?: number;
};

type RankPreference = "POPULARITY" | "DISTANCE";

type PublicCourseFilterOptions = {
  publicCourseEvidenceIds?: ReadonlySet<string>;
};

const NON_PUBLIC_PRIMARY_TYPES = new Set([
  "association_or_organization",
  "indoor_golf_course",
  "sporting_goods_store",
  "sports_club"
]);

const PRIVATE_NAME_PATTERNS = [
  /\bcountry\s+club\b/i,
  /\bprivate\b/i,
  /\bmembers?\s+only\b/i,
  /\bmembership\s+required\b/i
];

const NON_COURSE_NAME_PATTERNS = [
  /\bclub\s*fitting\b/i,
  /\bpro\s*shop\b/i,
  /\bgeneral\s+store\b/i,
  /\bclubhouse\b/i,
  /\bdriving\s+range\b/i,
  /\bgolf\s+(?:academy|school|lessons?)\b/i,
  /\bjunior\s+golf\s+club\b/i,
  /\bdisc\s+golf\b/i,
  /\bmini(?:ature)?\s+golf\b/i,
  /\bgolf\s+galaxy\b/i,
  /\bpga\s+tour\s+superstore\b/i,
  /\bdick'?s\s+sporting\s+goods\b/i,
  /\bx[-\s]?golf\b/i,
  /\bgolf\s+lounge\b/i,
  /\bsimulator\b/i,
  /\bindoor\b/i
];

const PLAYABLE_COURSE_NAME_PATTERN =
  /\b(?:course|links|park|center|resort|tpc)\b|\b\d+\s*(?:hole|course)\b/i;
const SEMANTIC_FALLBACK_NAME_PATTERN = /\bgolf\s+(?:course|links)\b/i;

const MEMBERSHIP_PLACE_TYPES = new Set(["association_or_organization", "sports_club"]);

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
    timeZone: getTimeZoneForCoordinates(latitude, longitude),
    rating: place.rating,
    phone: place.nationalPhoneNumber,
    website: place.websiteUri,
    photoReference: place.photos?.[0]?.name,
    photoAttributions: place.photos?.[0]?.authorAttributions
  };
}

export function filterPublicGolfCoursePlaces(
  places: GooglePlace[],
  options: PublicCourseFilterOptions = {}
) {
  return places.filter((place) => isLikelyPublicGolfCoursePlace(place, options));
}

function isLikelyPublicGolfCoursePlace(
  place: GooglePlace,
  { publicCourseEvidenceIds = new Set<string>() }: PublicCourseFilterOptions
) {
  const name = place.displayName?.text ?? "";
  const placeId = normalizePlaceId(place.id ?? place.name ?? "");
  const placeTypes = place.types ?? [];

  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
    return false;
  }

  const hasTypedGolfCourseEvidence =
    place.primaryType === "golf_course" && placeTypes.includes("golf_course");
  const hasSemanticFallbackEvidence =
    !place.primaryType &&
    publicCourseEvidenceIds.has(placeId) &&
    SEMANTIC_FALLBACK_NAME_PATTERN.test(name) &&
    Boolean(place.websiteUri);

  if (!hasTypedGolfCourseEvidence && !hasSemanticFallbackEvidence) {
    return false;
  }

  if (place.primaryType && NON_PUBLIC_PRIMARY_TYPES.has(place.primaryType)) {
    return false;
  }

  if (PRIVATE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return false;
  }

  if (NON_COURSE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return false;
  }

  const hasMembershipShape =
    /\bclub\b/i.test(name) && placeTypes.some((type) => MEMBERSHIP_PLACE_TYPES.has(type));
  const hasGolfIdentity = /\bgolf\b/i.test(name);
  const hasExplicitCourseSurface = PLAYABLE_COURSE_NAME_PATTERN.test(name);

  if (hasMembershipShape && !hasExplicitCourseSurface && !hasGolfIdentity) {
    return false;
  }

  return true;
}

export async function searchNearbyGolfCourses(input: NearbyCourseSearchInput) {
  const placesById = new Map<string, GooglePlace>();
  const [popularityPlaces, distancePlaces, publicCoursePlaces] = await Promise.all([
    searchNearbyGolfCoursePlaces(input, "POPULARITY"),
    searchNearbyGolfCoursePlaces(input, "DISTANCE"),
    searchPublicGolfCoursePlaces(input)
  ]);
  const publicCourseEvidenceIds = new Set(
    publicCoursePlaces
      .map((place) => normalizePlaceId(place.id ?? place.name ?? ""))
      .filter(Boolean)
  );

  for (const places of [popularityPlaces, distancePlaces, publicCoursePlaces]) {
    for (const place of places) {
      const id = normalizePlaceId(place.id ?? place.name ?? "");
      if (id && !placesById.has(id)) {
        placesById.set(id, place);
      }
    }
  }

  return dedupeGolfCoursePlaces(
    filterPublicGolfCoursePlaces([...placesById.values()], { publicCourseEvidenceIds })
  )
    .map((place) => {
      const course = mapGooglePlaceToCourseCandidate(place);
      return {
        ...course,
        distanceMeters: getDistanceMeters(input, course)
      };
    })
    .filter((course) => (course.distanceMeters ?? Number.MAX_SAFE_INTEGER) <= getSearchRadius(input))
    .sort((a, b) => (a.distanceMeters ?? Number.MAX_SAFE_INTEGER) - (b.distanceMeters ?? Number.MAX_SAFE_INTEGER));
}

export async function searchGolfCoursesByName(input: CourseNameSearchInput) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  const hasLocationBias =
    Number.isFinite(input.latitude) && Number.isFinite(input.longitude);
  const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri,places.photos,places.types,places.primaryType,places.businessStatus"
    },
    body: JSON.stringify({
      textQuery: input.query.trim(),
      includedType: "golf_course",
      strictTypeFiltering: true,
      pageSize: 8,
      rankPreference: "RELEVANCE",
      ...(hasLocationBias
        ? {
            locationBias: {
              circle: {
                center: {
                  latitude: input.latitude,
                  longitude: input.longitude
                },
                radius: 50000
              }
            }
          }
        : {})
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places course search failed with ${response.status}`);
  }

  const json = (await response.json()) as { places?: GooglePlace[] };
  const origin = hasLocationBias
    ? { latitude: input.latitude as number, longitude: input.longitude as number }
    : null;

  return dedupeGolfCoursePlaces(filterPublicGolfCoursePlaces(json.places ?? [])).map((place) => {
    const course = mapGooglePlaceToCourseCandidate(place);
    return origin ? { ...course, distanceMeters: getDistanceMeters(origin, course) } : course;
  });
}

async function searchNearbyGolfCoursePlaces(
  input: NearbyCourseSearchInput,
  rankPreference: RankPreference
) {
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
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri,places.photos,places.types,places.primaryType,places.businessStatus,places.containingPlaces"
    },
    body: JSON.stringify({
      includedPrimaryTypes: ["golf_course"],
      excludedPrimaryTypes: Array.from(NON_PUBLIC_PRIMARY_TYPES),
      maxResultCount: 20,
      rankPreference,
      locationRestriction: {
        circle: {
          center: {
            latitude: input.latitude,
            longitude: input.longitude
          },
          radius: getSearchRadius(input)
        }
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Google Places nearby search failed with ${response.status}`);
  }

  const json = (await response.json()) as { places?: GooglePlace[] };
  return json.places ?? [];
}

async function searchPublicGolfCoursePlaces(input: NearbyCourseSearchInput) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  }

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.websiteUri,places.types,places.primaryType,places.businessStatus"
      },
      body: JSON.stringify({
        textQuery: "public golf courses",
        pageSize: 20,
        rankPreference: "RELEVANCE",
        ...getTextSearchLocation(input)
      })
    });

    if (!response.ok) {
      return [];
    }

    const json = (await response.json()) as { places?: GooglePlace[] };
    return json.places ?? [];
  } catch {
    return [];
  }
}

function getSearchRadius(input: NearbyCourseSearchInput) {
  return input.radiusMeters ?? 30000;
}

function getTextSearchLocation(input: NearbyCourseSearchInput) {
  const radius = getSearchRadius(input);
  const latitudeDelta = toDegrees(radius / 6371000);
  const longitudeScale = Math.cos(toRadians(input.latitude));
  const longitudeDelta = latitudeDelta / Math.max(Math.abs(longitudeScale), 0.01);
  const lowLatitude = Math.max(-90, input.latitude - latitudeDelta);
  const highLatitude = Math.min(90, input.latitude + latitudeDelta);
  const lowLongitude = input.longitude - longitudeDelta;
  const highLongitude = input.longitude + longitudeDelta;

  if (lowLongitude < -180 || highLongitude > 180 || lowLatitude === -90 || highLatitude === 90) {
    return {
      locationBias: {
        circle: {
          center: {
            latitude: input.latitude,
            longitude: input.longitude
          },
          radius
        }
      }
    };
  }

  return {
    locationRestriction: {
      rectangle: {
        low: { latitude: lowLatitude, longitude: lowLongitude },
        high: { latitude: highLatitude, longitude: highLongitude }
      }
    }
  };
}

export function dedupeGolfCoursePlaces(places: GooglePlace[]) {
  const deduped: GooglePlace[] = [];

  for (const place of places) {
    const duplicateIndex = deduped.findIndex((candidate) => isDuplicateCoursePlace(candidate, place));
    if (duplicateIndex === -1) {
      deduped.push(place);
      continue;
    }

    if (getPlaceCompletenessScore(place) > getPlaceCompletenessScore(deduped[duplicateIndex])) {
      deduped[duplicateIndex] = place;
    }
  }

  return deduped;
}

function isDuplicateCoursePlace(first: GooglePlace, second: GooglePlace) {
  const firstId = normalizePlaceId(first.id ?? first.name ?? "");
  const secondId = normalizePlaceId(second.id ?? second.name ?? "");
  if (firstId && firstId === secondId) {
    return true;
  }

  const firstIdentity = normalizeCourseIdentity(first.displayName?.text ?? "");
  const secondIdentity = normalizeCourseIdentity(second.displayName?.text ?? "");
  if (!firstIdentity || firstIdentity !== secondIdentity) {
    return false;
  }

  const firstAddress = normalizeAddress(first.formattedAddress);
  const secondAddress = normalizeAddress(second.formattedAddress);
  if (firstAddress && firstAddress === secondAddress) {
    return true;
  }

  if (containingPlaceIds(first).has(secondId) || containingPlaceIds(second).has(firstId)) {
    return true;
  }

  const firstLocation = getPlaceLocation(first);
  const secondLocation = getPlaceLocation(second);
  return Boolean(
    firstLocation && secondLocation && getDistanceMeters(firstLocation, secondLocation) <= 1000
  );
}

function normalizeCourseIdentity(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(?:the|golf|course|club|links|tpc|facility)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeAddress(address?: string) {
  return address
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containingPlaceIds(place: GooglePlace) {
  return new Set(
    (place.containingPlaces ?? [])
      .map((containingPlace) =>
        normalizePlaceId(containingPlace.id ?? containingPlace.name ?? "")
      )
      .filter(Boolean)
  );
}

function getPlaceLocation(place: GooglePlace) {
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  return latitude === undefined || longitude === undefined ? undefined : { latitude, longitude };
}

function getPlaceCompletenessScore(place: GooglePlace) {
  return (
    Number(Boolean(place.formattedAddress)) +
    Number(Boolean(place.rating)) +
    Number(Boolean(place.nationalPhoneNumber)) +
    Number(Boolean(place.websiteUri)) +
    Number(Boolean(place.photos?.length)) * 2
  );
}

function normalizePlaceId(id: string) {
  return id.replace(/^places\//, "");
}

function getDistanceMeters(
  from: Pick<CourseCandidate, "latitude" | "longitude">,
  to: Pick<CourseCandidate, "latitude" | "longitude">
) {
  const earthRadiusMeters = 6371000;
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toDegrees(value: number) {
  return (value * 180) / Math.PI;
}

export function getGooglePlacesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY?.replace(/^\uFEFF/, "").trim();
}
