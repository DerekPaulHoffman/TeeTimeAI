import {
  filterVerifiedDuplicateCoursePlaces, getGooglePlacesApiKey, getTextSearchLocation, mapGooglePlaceToCourseCandidate,
  type CourseCandidate, type CourseNameSearchInput, type GooglePlace, type NearbyCourseSearchInput
} from "@/lib/places/google";
import type { GooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
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
export const SIMULATOR_DISCOVERY_CLASSIFICATION_VERSION = "public-rentals-v3";

type SimulatorConfirmationDiagnostic = {
  reason: "CONFIGURATION_MISSING" | "REQUEST_FAILED" | "UPSTREAM_HTTP_ERROR" | "MALFORMED_RESPONSE";
  upstreamStatus?: number;
  googleErrorCode?: number;
  googleErrorStatus?: string;
};

export class SimulatorVenueConfirmationUnavailableError extends Error {
  constructor(readonly diagnostic: SimulatorConfirmationDiagnostic) {
    super("We could not verify this venue right now. Please try again shortly.");
    this.name = "SimulatorVenueConfirmationUnavailableError";
  }
}

function confirmationUnavailable(diagnostic: SimulatorConfirmationDiagnostic): never {
  // Provider bodies, request URLs/headers, and selected venue details must not
  // become application logs. These fixed codes still distinguish an upstream
  // outage/configuration failure from a rejected simulator identity.
  console.error("[simulator-place-confirmation-unavailable]", diagnostic);
  throw new SimulatorVenueConfirmationUnavailableError(diagnostic);
}

async function readGoogleErrorDiagnostic(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DIAGNOSTIC_DEADLINE")), 1_000);
  });
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8_192) return {};
      text += decoder.decode(value, { stream: true });
    }
    const error = JSON.parse(text + decoder.decode())?.error;
    const statuses = new Set(["INVALID_ARGUMENT", "UNAUTHENTICATED", "PERMISSION_DENIED", "NOT_FOUND",
      "RESOURCE_EXHAUSTED", "FAILED_PRECONDITION", "DEADLINE_EXCEEDED", "INTERNAL", "UNAVAILABLE", "UNKNOWN"]);
    return {
      ...(Number.isInteger(error?.code) && error.code >= 100 && error.code <= 599 ? { googleErrorCode: error.code as number } : {}),
      ...(statuses.has(error?.status) ? { googleErrorStatus: error.status as string } : {}),
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

function isCompletePlaceIdentity(value: unknown): value is GooglePlace {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const place = value as GooglePlace;
  return typeof (place.id ?? place.name) === "string" && Boolean(place.id ?? place.name) &&
    typeof place.displayName?.text === "string" && Boolean(place.displayName.text.trim()) &&
    Number.isFinite(place.location?.latitude) && Number.isFinite(place.location?.longitude) &&
    (place.types === undefined || Array.isArray(place.types) && place.types.every((type) => typeof type === "string")) &&
    (place.primaryType === undefined || typeof place.primaryType === "string") &&
    (place.businessStatus === undefined || typeof place.businessStatus === "string") &&
    (place.websiteUri === undefined || typeof place.websiteUri === "string");
}

export function getReviewedPersistedSimulatorCandidates(reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  return filterReviewedSimulatorCandidates(getPersistedSimulatorCandidates(offerings), reviews, offerings);
}

export function filterReviewedSimulatorCandidates(candidates: CourseCandidate[], reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  return candidates.filter((candidate) => {
    const review = reviews.byPlaceId.get(candidate.googlePlaceId);
    const canonicalReview = review?.canonicalPlaceId ? reviews.byPlaceId.get(review.canonicalPlaceId) : undefined;
    const offering = offerings.byPlaceId.get(candidate.googlePlaceId);
    if (offering && (!offering.active || offering.publicAccessStatus === "NOT_PUBLIC")) return false;
    return ![review, canonicalReview].some((fact) => fact?.classification === "MEMBERS_ONLY_SIMULATOR") &&
      (hasVerifiedPublicSimulatorRental(offering) ||
        ![review, canonicalReview].some((fact) => fact?.accessOverride === "VERIFIED_PRIVATE" ||
          (fact?.accessOverride === "VERIFIED_NON_COURSE" && fact.classification !== "INDOOR_SIMULATOR")));
  });
}

export function filterSimulatorPlaces(places: GooglePlace[], reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
  return places.filter((place) => simulatorRejectionReason(place, reviews, offerings) === null);
}

function simulatorRejectionReason(place: GooglePlace, reviews: GooglePlaceReviewIndex, offerings: SimulatorOfferingIndex) {
    const id = (place.id ?? place.name ?? "").replace(/^places\//, "");
    const review = reviews.byPlaceId.get(id);
    const canonicalId = review?.canonicalPlaceId ?? id;
    const canonicalReview = reviews.byPlaceId.get(canonicalId);
    const offering = offerings.byPlaceId.get(canonicalId);
    if (!id || !place.displayName?.text || !Number.isFinite(place.location?.latitude) || !Number.isFinite(place.location?.longitude)) return "MISSING_REQUIRED_IDENTITY";
    if (place.businessStatus && place.businessStatus !== "OPERATIONAL") return "NOT_OPERATIONAL";
    if (offering && (!offering.active || offering.publicAccessStatus === "NOT_PUBLIC")) return "OFFERING_NOT_PUBLIC";
    if ([review, canonicalReview].some((fact) => fact?.classification === "MEMBERS_ONLY_SIMULATOR")) return "REVIEWED_MEMBERS_ONLY";
    const verified = hasVerifiedPublicSimulatorRental(offering);
    // An outdoor non-course review is retained. Only simulator classifications may
    // be explored here; a reviewed rental may independently establish public access.
    if (!verified && [review, canonicalReview].some((fact) => fact?.accessOverride === "VERIFIED_PRIVATE" ||
      (fact?.accessOverride === "VERIFIED_NON_COURSE" && fact.classification !== "INDOOR_SIMULATOR"))) return "REVIEWED_PRIVATE_OR_NON_COURSE";
    const name = place.displayName.text;
    if (verified) return null;
    const primaryType = place.primaryType ?? "";
    if (NON_RENTAL_NAME.test(name) || MEMBERS_ONLY.test(name) || RESIDENTIAL_NAME.test(name)) return "EXCLUDED_NAME";
    if (NON_RENTAL_PRIMARY_TYPES.has(primaryType) || primaryType.endsWith("_store") || primaryType.endsWith("_shop")) return "EXCLUDED_PRIMARY_TYPE";
    if (hasLessonOrFittingWebsite(place.websiteUri)) return "EXCLUDED_WEBSITE_PATH";
    // Text relevance and a website alone can surface apartments and other unrelated
    // businesses. Preserve likely golf hybrids without treating them as verified rentals.
    return place.types?.includes("indoor_golf_course") || [review, canonicalReview].some((fact) =>
      fact?.classification === "INDOOR_SIMULATOR") || (Boolean(place.websiteUri) && /\bgolf\b/i.test(name))
      ? null : "MISSING_SIMULATOR_EVIDENCE";
}

function rejectSimulatorIdentity(reason: NonNullable<ReturnType<typeof simulatorRejectionReason>> | "EXACT_ID_MISMATCH", place: GooglePlace, upstreamStatus: number): never {
  const primaryTypes = new Set(["indoor_golf_course", "golf_course", "golf_instructor", "sports_coaching", "sports_school",
    "bar", "sports_bar", "sports_complex", "store", "sporting_goods_store", "apartment_building", "apartment_complex",
    "condominium_complex", "housing_complex", "real_estate_agency"]);
  const statuses = new Set(["OPERATIONAL", "CLOSED_TEMPORARILY", "CLOSED_PERMANENTLY"]);
  console.error("[simulator-place-confirmation-rejected]", {
    reason, upstreamStatus,
    ...(primaryTypes.has(place.primaryType ?? "") ? { primaryType: place.primaryType } : {}),
    ...(statuses.has(place.businessStatus ?? "") ? { businessStatus: place.businessStatus } : {}),
  });
  throw new Error("The selected venue could not be confirmed as a simulator. Refresh the venues and try again.");
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

/** Refresh an exact provider identity before accepting unverified rental demand. */
export async function getSimulatorVenueForDemand(googlePlaceId: string, reviews: GooglePlaceReviewIndex) {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(googlePlaceId)) {
    throw new Error("The selected simulator venue is invalid. Refresh the venues and try again.");
  }
  const key = getGooglePlacesApiKey();
  if (!key) confirmationUnavailable({ reason: "CONFIGURATION_MISSING" });
  let result: Awaited<ReturnType<typeof fetchGooglePlacesJsonWithRetry<GooglePlace>>>;
  try {
    result = await fetchGooglePlacesJsonWithRetry<GooglePlace>(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(googlePlaceId)}`, {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask":
          "id,displayName,formattedAddress,addressComponents,location,websiteUri,nationalPhoneNumber,types,primaryType,businessStatus" },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch (error) {
    confirmationUnavailable({ reason: error instanceof SyntaxError ? "MALFORMED_RESPONSE" : "REQUEST_FAILED" });
  }
  const { response, json } = result;
  if (!response.ok) confirmationUnavailable({ reason: "UPSTREAM_HTTP_ERROR", upstreamStatus: response.status,
    ...await readGoogleErrorDiagnostic(response) });
  if (!isCompletePlaceIdentity(json)) confirmationUnavailable({ reason: "MALFORMED_RESPONSE", upstreamStatus: response.status });
  const emptyOfferings: SimulatorOfferingIndex = { byPlaceId: new Map(), reviewVersion: "none" };
  if ((json.id ?? json.name?.replace(/^places\//, "")) !== googlePlaceId) rejectSimulatorIdentity("EXACT_ID_MISMATCH", json, response.status);
  const rejection = simulatorRejectionReason(json, reviews, emptyOfferings);
  if (rejection) rejectSimulatorIdentity(rejection, json, response.status);
  const candidate = mapGooglePlaceToCourseCandidate(json, reviews);
  return { ...candidate, website: getSafeCustomerBookingUrl(candidate.website) ?? undefined };
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
    mapSimulatorPlaces(places, reviews, offerings), getReviewedPersistedSimulatorCandidates(reviews, offerings)
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
