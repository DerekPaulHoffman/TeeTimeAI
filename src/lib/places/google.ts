import type { CoursePriceEstimate } from "@/lib/pricing/course-prices";
import type { CourseAlertSupport } from "@/lib/courses/intelligence";
import type { CourseLayoutHoleCount } from "@/lib/courses/course-layout";
import {
  areEquivalentNamedCourses,
  findUniqueGenericCourseMatch,
  isGenericCourseName,
  normalizeCourseIdentityName,
  type CourseIdentity
} from "@/lib/places/course-identity";
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
  layoutHoleCounts?: CourseLayoutHoleCount[];
  layoutHolesStatus?: "VERIFIED" | "UNVERIFIED";
  layoutHolesEvidenceUrl?: string;
  layoutHolesVerifiedAt?: string;
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

const EXPLICIT_PRIVATE_NAME_PATTERNS = [
  /\bprivate\b/i,
  /\bmembers?\s+only\b/i,
  /\bmembership\s+required\b/i
];
const AMBIGUOUS_COUNTRY_CLUB_NAME_PATTERN = /\bcountry\s+club\b/i;

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
// Some public golf facilities are misclassified by Google as organizations and omitted from
// generic nearby results. Keep this registry evidence-backed and narrow so reported misses can be
// guaranteed in nearby discovery without weakening the private-club filter.
const VERIFIED_PUBLIC_COURSES = [
  {
    placeId: "ChIJHRdhRQt16IkRnZxbawELtdM",
    name: "Grassy Hill Country Club",
    latitude: 41.2675142,
    longitude: -73.044987,
    evidenceUrl: "https://grassyhillcountryclub.com/"
  }
] as const;
const VERIFIED_PUBLIC_COURSE_PLACE_IDS = new Set<string>(
  VERIFIED_PUBLIC_COURSES.map((course) => course.placeId)
);
// Google can classify invitation-only facilities as golf_course and even return them for a
// "public golf courses" text search. Keep verified private facilities out by stable place ID
// when their official site explicitly documents private or member-only access.
const VERIFIED_PRIVATE_COURSES = [
  {
    placeId: "ChIJMXRRcFvo5YkRkNXOrqSfVGM",
    name: "Shelter Harbor Golf Club",
    evidenceUrl: "https://www.shgcri.com/"
  }
] as const;
const VERIFIED_PRIVATE_COURSE_PLACE_IDS = new Set<string>(
  VERIFIED_PRIVATE_COURSES.map((course) => course.placeId)
);
// Some indoor simulator businesses remain misclassified by Google as outdoor golf courses even
// after indoor_golf_course became a distinct Places type. Exclude only stable place IDs whose
// official site confirms that the location is a simulator rather than a playable course.
const VERIFIED_NON_COURSE_PLACES = [
  {
    placeId: "ChIJy4_CTDEtDogR9wxAr-a-VGI",
    name: "Chicago Golf Authority",
    evidenceUrl: "https://chicagogolfauthority.com/pages/how-it-works"
  }
] as const;
const VERIFIED_NON_COURSE_PLACE_IDS = new Set<string>(
  VERIFIED_NON_COURSE_PLACES.map((place) => place.placeId)
);

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
  const hasPublicCourseEvidence = publicCourseEvidenceIds.has(placeId);
  const isVerifiedPublicCourse = VERIFIED_PUBLIC_COURSE_PLACE_IDS.has(placeId);

  if (
    VERIFIED_PRIVATE_COURSE_PLACE_IDS.has(placeId) ||
    VERIFIED_NON_COURSE_PLACE_IDS.has(placeId)
  ) {
    return false;
  }

  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
    return false;
  }

  const hasTypedGolfCourseEvidence =
    place.primaryType === "golf_course" && placeTypes.includes("golf_course");
  const hasSemanticFallbackEvidence =
    hasPublicCourseEvidence &&
    (isVerifiedPublicCourse ||
      (!place.primaryType && SEMANTIC_FALLBACK_NAME_PATTERN.test(name))) &&
    Boolean(place.websiteUri);

  if (!hasTypedGolfCourseEvidence && !hasSemanticFallbackEvidence) {
    return false;
  }

  if (
    place.primaryType &&
    NON_PUBLIC_PRIMARY_TYPES.has(place.primaryType) &&
    !isVerifiedPublicCourse
  ) {
    return false;
  }

  if (EXPLICIT_PRIVATE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return false;
  }

  // "Country Club" is not proof of private access. Keep it only when a separate
  // public-course text search corroborates the same Google place.
  if (AMBIGUOUS_COUNTRY_CLUB_NAME_PATTERN.test(name) && !hasPublicCourseEvidence) {
    return false;
  }

  if (NON_COURSE_NAME_PATTERNS.some((pattern) => pattern.test(name))) {
    return false;
  }

  const hasMembershipShape =
    /\bclub\b/i.test(name) && placeTypes.some((type) => MEMBERSHIP_PLACE_TYPES.has(type));
  const hasGolfIdentity = /\bgolf\b/i.test(name);
  const hasExplicitCourseSurface = PLAYABLE_COURSE_NAME_PATTERN.test(name);

  if (
    hasMembershipShape &&
    !hasExplicitCourseSurface &&
    !hasGolfIdentity &&
    !isVerifiedPublicCourse
  ) {
    return false;
  }

  return true;
}

export async function searchNearbyGolfCourses(input: NearbyCourseSearchInput) {
  const placesById = new Map<string, GooglePlace>();
  const [popularityPlaces, distancePlaces, publicCoursePlaces, verifiedPublicCoursePlaces] = await Promise.all([
    searchNearbyGolfCoursePlaces(input, "POPULARITY"),
    searchNearbyGolfCoursePlaces(input, "DISTANCE"),
    searchPublicGolfCoursePlaces(input),
    searchVerifiedPublicCoursePlaces(input)
  ]);
  const publicCourseEvidenceIds = new Set(
    [...publicCoursePlaces, ...verifiedPublicCoursePlaces]
      .map((place) => normalizePlaceId(place.id ?? place.name ?? ""))
      .filter(Boolean)
  );

  for (const places of [
    popularityPlaces,
    distancePlaces,
    publicCoursePlaces,
    verifiedPublicCoursePlaces
  ]) {
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
  const primaryPlaces = json.places ?? [];
  const initiallyAcceptedPlaces = filterPublicGolfCoursePlaces(primaryPlaces);
  const needsPublicAccessCorroboration =
    initiallyAcceptedPlaces.length === 0 ||
    primaryPlaces.some((place) =>
      AMBIGUOUS_COUNTRY_CLUB_NAME_PATTERN.test(place.displayName?.text ?? "")
    );
  const publicCoursePlaces = needsPublicAccessCorroboration
    ? await searchPublicGolfCoursePlacesByName(input)
    : [];
  const publicCourseEvidenceIds = new Set(
    publicCoursePlaces
      .map((place) => normalizePlaceId(place.id ?? place.name ?? ""))
      .filter(Boolean)
  );
  const origin = hasLocationBias
    ? { latitude: input.latitude as number, longitude: input.longitude as number }
    : null;

  return dedupeGolfCoursePlaces(
    filterPublicGolfCoursePlaces([...primaryPlaces, ...publicCoursePlaces], {
      publicCourseEvidenceIds
    })
  ).map((place) => {
    const course = mapGooglePlaceToCourseCandidate(place);
    return origin ? { ...course, distanceMeters: getDistanceMeters(origin, course) } : course;
  });
}

async function searchPublicGolfCoursePlacesByName(input: CourseNameSearchInput) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    return [];
  }

  const hasLocationBias =
    Number.isFinite(input.latitude) && Number.isFinite(input.longitude);

  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.nationalPhoneNumber,places.websiteUri,places.photos,places.types,places.primaryType,places.businessStatus"
      },
      body: JSON.stringify({
        textQuery: `${input.query.trim()} public golf course`,
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
      return [];
    }

    const json = (await response.json()) as { places?: GooglePlace[] };
    return json.places ?? [];
  } catch {
    return [];
  }
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

async function searchVerifiedPublicCoursePlaces(input: NearbyCourseSearchInput) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    return [];
  }

  const nearbyVerifiedCourses = VERIFIED_PUBLIC_COURSES.filter(
    (course) => getDistanceMeters(input, course) <= getSearchRadius(input)
  );

  return (
    await Promise.all(
      nearbyVerifiedCourses.map(async (course) => {
        try {
          const response = await fetch(
            `https://places.googleapis.com/v1/places/${course.placeId}`,
            {
              headers: {
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask":
                  "id,displayName,formattedAddress,location,rating,nationalPhoneNumber,websiteUri,photos,types,primaryType,businessStatus"
              }
            }
          );

          if (!response.ok) {
            return null;
          }

          return (await response.json()) as GooglePlace;
        } catch {
          return null;
        }
      })
    )
  ).filter((place): place is GooglePlace => place !== null);
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
  const placesById = new Map<string, { place: GooglePlace; firstIndex: number }>();
  const placesWithoutIds: Array<{ place: GooglePlace; firstIndex: number }> = [];

  places.forEach((place, index) => {
    const id = normalizePlaceId(place.id ?? place.name ?? "");
    if (!id) {
      placesWithoutIds.push({ place, firstIndex: index });
      return;
    }

    const existing = placesById.get(id);
    if (!existing) {
      placesById.set(id, { place, firstIndex: index });
      return;
    }
    if (getPlaceCompletenessScore(place) > getPlaceCompletenessScore(existing.place)) {
      placesById.set(id, { place, firstIndex: existing.firstIndex });
    }
  });

  const indexedPlaces = [...placesById.values(), ...placesWithoutIds];
  const identifiedPlaces: Array<{
    place: GooglePlace;
    firstIndex: number;
    identity: CourseIdentity;
  }> = [];
  const genericPlaces: typeof identifiedPlaces = [];
  const incompletePlaces: Array<{ place: GooglePlace; firstIndex: number }> = [];

  for (const indexedPlace of indexedPlaces) {
    const identity = getPlaceCourseIdentity(indexedPlace.place);
    if (!identity) {
      incompletePlaces.push(indexedPlace);
    } else if (isGenericCourseName(identity.name)) {
      genericPlaces.push({ ...indexedPlace, identity });
    } else {
      identifiedPlaces.push({ ...indexedPlace, identity });
    }
  }

  const dedupedIdentified: typeof identifiedPlaces = [];
  for (const identified of identifiedPlaces) {
    const duplicateIndex = dedupedIdentified.findIndex((candidate) =>
      areEquivalentNamedCourses(candidate.identity, identified.identity)
    );
    if (duplicateIndex === -1) {
      dedupedIdentified.push(identified);
      continue;
    }

    const duplicate = dedupedIdentified[duplicateIndex];
    if (getPlaceCompletenessScore(identified.place) > getPlaceCompletenessScore(duplicate.place)) {
      dedupedIdentified[duplicateIndex] = {
        ...identified,
        firstIndex: Math.min(duplicate.firstIndex, identified.firstIndex)
      };
    }
  }

  const retainedGeneric = genericPlaces.filter(
    (generic) =>
      !findUniqueGenericCourseMatch(
        generic.identity,
        dedupedIdentified.map((candidate) => candidate.identity)
      )
  );

  return [...dedupedIdentified, ...retainedGeneric, ...incompletePlaces]
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ place }) => place);
}

function getPlaceCourseIdentity(place: GooglePlace): CourseIdentity | undefined {
  const name = place.displayName?.text;
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (!name || latitude === undefined || longitude === undefined) {
    return undefined;
  }

  return {
    googlePlaceId: normalizePlaceId(place.id ?? place.name ?? ""),
    name,
    address: place.formattedAddress,
    latitude,
    longitude,
    website: place.websiteUri,
    phone: place.nationalPhoneNumber,
    containingPlaceIds: (place.containingPlaces ?? [])
      .map((containingPlace) => normalizePlaceId(containingPlace.id ?? containingPlace.name ?? ""))
      .filter(Boolean)
  };
}

function getPlaceCompletenessScore(place: GooglePlace) {
  return (
    Number(Boolean(normalizeCourseIdentityName(place.displayName?.text ?? ""))) * 3 +
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
