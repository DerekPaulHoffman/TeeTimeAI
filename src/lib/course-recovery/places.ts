import type { BookingMethod } from "@prisma/client";

import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import type { RecoveryInput } from "@/lib/course-recovery/contracts";
import { normalizeCourseIdentityName } from "@/lib/places/course-identity";
import { getGooglePlacesApiKey, type CourseCandidate, type GooglePlace } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";
import { getTimeZoneForCoordinates } from "@/lib/timezones";

export const RECOVERY_MAX_CANDIDATES = 8;
export const RECOVERY_MAX_PLACE_QUERIES = 2;
const MAX_PLACES_RESPONSE_BYTES = 256_000;
const PLACES_TIMEOUT_MS = 12_000;

/** Identity evidence only. A returned place is not yet a verified public course. */
export type RecoveryPlace = {
  candidate: CourseCandidate;
  source: "CATALOGUE" | "GOOGLE" | "REVIEW";
  isPublic?: boolean | null;
  primaryType?: string;
  types?: string[];
  businessStatus?: string;
  typeLabel?: string;
  bookingUrl?: string | null;
  bookingMethod?: BookingMethod;
};

type RecoveryPlacesDependencies = {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  signal?: AbortSignal;
};

export async function findCatalogueRecoveryPlaces(input: RecoveryInput): Promise<RecoveryPlace[]> {
  const tokens = normalizeCourseIdentityName(input.name).split(" ").filter(Boolean).slice(0, 4);
  if (tokens.length === 0) return [];
  const courses = await prisma.course.findMany({
    where: { AND: tokens.map(token => ({ name: { contains: token, mode: "insensitive" as const } })) },
    orderBy: { updatedAt: "desc" },
    take: RECOVERY_MAX_CANDIDATES,
    select: {
      id: true, googlePlaceId: true, name: true, address: true, city: true,
      stateCode: true, stateName: true, county: true, countryCode: true,
      latitude: true, longitude: true, timeZone: true, website: true, phone: true,
      isPublic: true, detectedBookingUrl: true, bookingMethod: true,
    },
  });
  return courses.map(course => ({
    source: "CATALOGUE",
    isPublic: course.isPublic,
    bookingUrl: course.detectedBookingUrl,
    bookingMethod: course.bookingMethod,
    candidate: {
      courseId: course.id,
      googlePlaceId: course.googlePlaceId ?? `manual-${course.id}`,
      name: course.name,
      latitude: course.latitude,
      longitude: course.longitude,
      timeZone: course.timeZone,
      ...(course.address ? { address: course.address } : {}),
      ...(course.city ? { city: course.city } : {}),
      ...(course.stateCode ? { stateCode: course.stateCode } : {}),
      ...(course.stateName ? { stateName: course.stateName } : {}),
      ...(course.county ? { county: course.county } : {}),
      ...(course.countryCode ? { countryCode: course.countryCode } : {}),
      ...(course.website ? { website: course.website } : {}),
      ...(course.phone ? { phone: course.phone } : {}),
      publicAccessStatus: "UNVERIFIED",
    },
  }));
}

/** Two fixed broad text queries; no strict type filter, photos, cache, or writes. */
export async function searchRecoveryCoursePlaces(
  input: RecoveryInput,
  dependencies: RecoveryPlacesDependencies = {},
): Promise<RecoveryPlace[]> {
  const apiKey = dependencies.apiKey ?? getGooglePlacesApiKey();
  if (!apiKey) throw new Error("Course recovery Places configuration is unavailable");
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(PLACES_TIMEOUT_MS)])
    : AbortSignal.timeout(PLACES_TIMEOUT_MS);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const placesById = new Map<string, RecoveryPlace>();
  const queries = [`${input.name} ${input.town}`, `${input.name} public golf course ${input.town}`];
  for (const textQuery of queries.slice(0, RECOVERY_MAX_PLACE_QUERIES)) {
    const read = async () => {
      signal.throwIfAborted();
      const response = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.location,places.nationalPhoneNumber,places.websiteUri,places.types,places.primaryType,places.googleMapsTypeLabel,places.businessStatus",
      },
      body: JSON.stringify({
        textQuery, languageCode: "en", pageSize: RECOVERY_MAX_CANDIDATES, rankPreference: "RELEVANCE",
        ...(input.latitude !== undefined && input.longitude !== undefined ? {
          locationBias: { circle: { center: { latitude: input.latitude, longitude: input.longitude }, radius: 50_000 } },
        } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Empty evidence and failed evidence are different; Workflow owns retries.
      throw new Error(`Course recovery Places request failed (${response.status})`);
    }
      return JSON.parse(await readRecoveryResponseText(response, MAX_PLACES_RESPONSE_BYTES, signal)) as unknown;
    };
    const execution = dependencies.fetchImpl ? { acquired: true as const, value: await read() }
      : await withRecoveryAbort(runWithProviderRequestLease("places.googleapis.com", read), signal);
    if (!execution.acquired) throw new Error("Course recovery Places request deferred by provider capacity");
    const body = execution.value;
    const rawPlaces = isRecord(body) && Array.isArray(body.places) ? body.places : [];
    for (const raw of rawPlaces.slice(0, RECOVERY_MAX_CANDIDATES)) {
      const place = mapRecoveryGooglePlace(raw);
      if (place && !placesById.has(place.candidate.googlePlaceId)) placesById.set(place.candidate.googlePlaceId, place);
      if (placesById.size === RECOVERY_MAX_CANDIDATES) break;
    }
    if (placesById.size === RECOVERY_MAX_CANDIDATES) break;
  }
  return [...placesById.values()];
}

function mapRecoveryGooglePlace(value: unknown): RecoveryPlace | null {
  if (!isRecord(value)) return null;
  const place = value as GooglePlace;
  const id = boundedString(place.id)?.replace(/^places\//, "");
  const name = boundedString(place.displayName?.text);
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (!id || !name || typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  const addressComponent = (types: string[], short = false) => {
    const component = Array.isArray(place.addressComponents)
      ? place.addressComponents.find(component => component && Array.isArray(component.types) && component.types.some(type => types.includes(type)))
      : undefined;
    return boundedString(short ? component?.shortText : component?.longText);
  };
  return {
    source: "GOOGLE",
    primaryType: boundedString(place.primaryType),
    types: Array.isArray(place.types) ? place.types.filter((type): type is string => typeof type === "string").slice(0, 30) : [],
    businessStatus: boundedString(place.businessStatus),
    typeLabel: boundedString(place.googleMapsTypeLabel?.text),
    candidate: {
      googlePlaceId: id, name, latitude, longitude,
      timeZone: getTimeZoneForCoordinates(latitude, longitude),
      address: boundedString(place.formattedAddress),
      city: addressComponent(["locality", "postal_town", "administrative_area_level_3"]),
      stateCode: addressComponent(["administrative_area_level_1"], true),
      stateName: addressComponent(["administrative_area_level_1"]),
      countryCode: addressComponent(["country"], true),
      website: boundedString(place.websiteUri),
      phone: boundedString(place.nationalPhoneNumber),
      publicAccessStatus: "UNVERIFIED",
    },
  };
}

export async function readRecoveryResponseText(response: Response, maxBytes: number, signal: AbortSignal) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Course recovery response exceeded its byte limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await withRecoveryAbort(reader.read(), signal);
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Course recovery response exceeded its byte limit");
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function withRecoveryAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function boundedString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1000 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
