import {
  filterVerifiedDuplicateCoursePlaces, getGooglePlacesApiKey, getTextSearchLocation, mapGooglePlaceToCourseCandidate,
  type CourseCandidate, type CourseNameSearchInput, type GooglePlace, type NearbyCourseSearchInput
} from "@/lib/places/google";
import type { GooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";
import { fetchGooglePlacesJsonWithRetry } from "@/lib/places/google-places-request";
import {
  getPersistedSimulatorCandidates, hasVerifiedPublicSimulatorRental, mapSimulatorCandidate,
  type SimulatorOfferingIndex
} from "@/lib/places/simulator-offerings";

const SIMULATOR_FIELDS = "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.websiteUri,places.photos,places.types,places.primaryType,places.businessStatus";
const NON_RENTAL_NAME = /\b(?:disc\s+golf|mini(?:ature)?\s+golf|equipment\s+(?:sales|repair)|simulator\s+(?:sales|installation)|club\s*fitting|golf\s+(?:lessons?|school|academy))\b/i;
const MEMBERS_ONLY = /\b(?:members?\s+only|membership\s+required|private\s+(?:golf\s+)?(?:club|facility))\b/i;
const RESIDENTIAL_NAME = /\b(?:apartments?|residences?|condominiums?|residential|housing\s+(?:complex|community))\b/i;
const NON_RENTAL_PRIMARY_TYPES = new Set([
  "apartment_building", "apartment_complex", "condominium_complex", "housing_complex", "real_estate_agency",
  "golf_instructor", "sports_coaching", "sports_school", "store"
]);
const LESSON_OR_FITTING_PATH = /\/(?:golf-lessons?|golf-school|club-fitting)(?:\/|$)/i;
export const SIMULATOR_DISCOVERY_CLASSIFICATION_VERSION = "public-rentals-v2";

export function filterSimulatorPlaces(places: GooglePlace[], reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  return places.filter((place) => {
    const id = (place.id ?? place.name ?? "").replace(/^places\//, "");
    const review = reviews.byPlaceId.get(id);
    const canonicalId = review?.canonicalPlaceId ?? id;
    const canonicalReview = reviews.byPlaceId.get(canonicalId);
    const offering = offerings.byPlaceId.get(canonicalId);
    if (!id || !place.displayName?.text || !Number.isFinite(place.location?.latitude) || !Number.isFinite(place.location?.longitude) ||
      (place.businessStatus && place.businessStatus !== "OPERATIONAL")) return false;
    if (offering && (!offering.active || offering.publicAccessStatus === "NOT_PUBLIC")) return false;
    const verified = hasVerifiedPublicSimulatorRental(offering);
    // An outdoor non-course review is retained. Only simulator classifications may
    // be explored here; a reviewed rental may independently establish public access.
    if (!verified && [review, canonicalReview].some((fact) => fact?.accessOverride === "VERIFIED_PRIVATE" ||
      (fact?.accessOverride === "VERIFIED_NON_COURSE" && fact.classification !== "INDOOR_SIMULATOR"))) return false;
    const name = place.displayName.text;
    if (verified) return true;
    const primaryType = place.primaryType ?? "";
    if (NON_RENTAL_NAME.test(name) || MEMBERS_ONLY.test(name) || RESIDENTIAL_NAME.test(name) ||
      NON_RENTAL_PRIMARY_TYPES.has(primaryType) || primaryType.endsWith("_store") || primaryType.endsWith("_shop") ||
      hasLessonOrFittingWebsite(place.websiteUri)) return false;
    // Text relevance and a website alone can surface apartments and other unrelated
    // businesses. Preserve likely golf hybrids without treating them as verified rentals.
    return place.types?.includes("indoor_golf_course") || [review, canonicalReview].some((fact) =>
      fact?.classification === "INDOOR_SIMULATOR") || (Boolean(place.websiteUri) && /\bgolf\b/i.test(name));
  });
}

function hasLessonOrFittingWebsite(website: string | undefined) {
  if (!website) return false;
  try { return LESSON_OR_FITTING_PATH.test(new URL(website).pathname); } catch { return false; }
}

async function requestPlaces(endpoint: "searchNearby" | "searchText", body: object, signal?: AbortSignal) {
  const key = getGooglePlacesApiKey();
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not configured");
  const { response, json } = await fetchGooglePlacesJsonWithRetry<{ places?: GooglePlace[] }>(
    `https://places.googleapis.com/v1/places:${endpoint}`, {
      method: "POST", headers: {
        "Content-Type": "application/json", "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": SIMULATOR_FIELDS
      }, body: JSON.stringify({ languageCode: "en", ...body }), signal
    }
  );
  if (!response.ok) throw new Error(`Simulator discovery failed with ${response.status}`);
  return json?.places ?? [];
}

export async function searchNearbySimulatorVenues(input: NearbyCourseSearchInput, reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  const radius = input.radiusMeters ?? 24140;
  // Dedicated queries retain recall without sweeping all bars or sports stores.
  const results = await Promise.allSettled([
    requestPlaces("searchNearby", {
      includedTypes: ["indoor_golf_course"], maxResultCount: 20, rankPreference: "DISTANCE",
      locationRestriction: { circle: { center: { latitude: input.latitude, longitude: input.longitude }, radius } }
    }, input.signal),
    ...["golf simulators", "indoor golf"].map((textQuery) => requestPlaces("searchText", {
      textQuery, pageSize: 20, rankPreference: "RELEVANCE", ...getTextSearchLocation({ ...input, radiusMeters: radius })
    }, input.signal))
  ]);
  if (input.signal?.aborted) throw input.signal.reason;
  const places = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const courses = mergeSimulatorCandidates(
    mapSimulatorPlaces(places, reviews, offerings), getPersistedSimulatorCandidates(offerings)
  ).map((candidate) => ({ ...candidate, distanceMeters: simulatorDistanceMeters(input, candidate) }))
    .filter((candidate) => candidate.distanceMeters <= radius)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
  if (!courses.length && results.every((result) => result.status === "rejected")) {
    throw (results[0] as PromiseRejectedResult).reason;
  }
  return courses;
}

export async function searchSimulatorVenuesByName(input: CourseNameSearchInput, reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  const hasLocation = Number.isFinite(input.latitude) && Number.isFinite(input.longitude);
  const places = await requestPlaces("searchText", {
    // A course-type fence would discard studios, bars and hybrid venues.
    textQuery: input.query.trim(), pageSize: 8, rankPreference: "RELEVANCE",
    ...(hasLocation ? { locationBias: { circle: {
      center: { latitude: input.latitude, longitude: input.longitude }, radius: 50000
    } } } : {})
  }, input.signal);
  // For an exact-name lookup require indoor evidence or a rental review. A generic
  // unrelated named business with a website is insufficient simulator evidence.
  return mapSimulatorPlaces(places.filter((place) => {
    const id = (place.id ?? place.name ?? "").replace(/^places\//, "");
    const offering = offerings.byPlaceId.get(reviews.byPlaceId.get(id)?.canonicalPlaceId ?? id);
    return hasVerifiedPublicSimulatorRental(offering) || place.types?.includes("indoor_golf_course") ||
      /\b(?:indoor\s+golf|golf\s+simulators?|simulator|golf\s+lounge)\b/i.test(place.displayName?.text ?? "") ||
      reviews.byPlaceId.get(id)?.classification === "INDOOR_SIMULATOR";
  }), reviews, offerings).map((candidate) => hasLocation ? {
    ...candidate, distanceMeters: simulatorDistanceMeters({ latitude: input.latitude as number, longitude: input.longitude as number }, candidate)
  } : candidate);
}

function mapSimulatorPlaces(places: GooglePlace[], reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  const candidates = new Map<string, CourseCandidate>();
  for (const place of filterVerifiedDuplicateCoursePlaces(filterSimulatorPlaces(places, reviews, offerings), reviews)) {
    const candidate = mapSimulatorCandidate(mapGooglePlaceToCourseCandidate(place, reviews), offerings);
    const prior = candidates.get(candidate.googlePlaceId);
    if (!prior || (!prior.website && candidate.website) || (!prior.photoReference && candidate.photoReference)) {
      candidates.set(candidate.googlePlaceId, candidate);
    }
  }
  // Different businesses/branches can share a chain name and nearby address.
  // Only exact IDs and reviewed aliases establish simulator venue equivalence.
  return [...candidates.values()];
}

function mergeSimulatorCandidates(first: CourseCandidate[], second: CourseCandidate[]) {
  const candidates = new Map(first.map((candidate) => [candidate.googlePlaceId, candidate]));
  for (const candidate of second) if (!candidates.has(candidate.googlePlaceId)) candidates.set(candidate.googlePlaceId, candidate);
  return [...candidates.values()];
}

export function simulatorDistanceMeters(origin: { latitude: number; longitude: number }, target: { latitude: number; longitude: number }) {
  const radians = (value: number) => value * Math.PI / 180;
  const deltaLatitude = radians(target.latitude - origin.latitude);
  const deltaLongitude = radians(target.longitude - origin.longitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(origin.latitude)) *
    Math.cos(radians(target.latitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return Math.round(2 * 6_371_000 * Math.asin(Math.sqrt(Math.min(1, haversine))));
}
