import type { CourseAlertSupport, CourseMonitoringSupport } from "@/lib/courses/intelligence";
import type { CourseCandidate } from "@/lib/places/google";
import { MAX_COURSE_PREFERENCES } from "@/lib/validation/search-constraints";

import { sanitizeSearchPrefill } from "./search-prefill";
import type { SearchMode } from "./search-mode";

export const SEARCH_DRAFT_STORAGE_KEY = "tee-time-spot:search-draft:v1";
export const SIMULATOR_SEARCH_DRAFT_STORAGE_KEY = "tee-time-spot:search-draft:simulator:v1";

const MAX_STORED_COURSES = 100;
const ALERT_SUPPORT_VALUES = new Set<CourseAlertSupport>([
  "DIRECT_ONLINE",
  "ACCOUNT_REQUIRED",
  "ACCOUNT_SELF_SERVICE",
  "ACCOUNT_STAFF_PROVISIONED",
  "CAPTCHA_OR_QUEUE",
  "OFFICIAL_SITE_ONLY",
  "PHONE_ONLY",
  "CONTACT_COURSE",
  "WALK_IN_ONLY"
]);
const MONITORING_SUPPORT_VALUES = new Set<CourseMonitoringSupport>([
  "AUTOMATIC",
  "MANUAL_ONLY",
  "UNCONFIRMED"
]);

export type SearchDraft = {
  mode?: SearchMode;
  location?: string;
  players?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  holes?: "any" | "9" | "18";
  radius?: number;
  coordinates?: { latitude: number; longitude: number };
  courses: CourseCandidate[];
  selectedCourses: CourseCandidate[];
};

const volatileDrafts: Partial<Record<SearchMode, SearchDraft>> = {};

export function storeSearchDraft(draft: SearchDraft, mode: SearchMode = "OUTDOOR") {
  const safeDraft = sanitizeSearchDraft(draft, mode);
  volatileDrafts[mode] = safeDraft;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(searchDraftStorageKey(mode), JSON.stringify(safeDraft));
  } catch {
    // The in-memory fallback still covers client navigation when storage is unavailable.
  }
}

export function readSearchDraft(mode: SearchMode = "OUTDOOR") {
  if (typeof window === "undefined") {
    return volatileDrafts[mode];
  }

  try {
    const storedValue = window.sessionStorage.getItem(searchDraftStorageKey(mode));
    return storedValue
      ? sanitizeSearchDraft(JSON.parse(storedValue) as unknown, mode)
      : volatileDrafts[mode];
  } catch {
    return volatileDrafts[mode];
  }
}

export function clearSearchDraft(mode: SearchMode = "OUTDOOR") {
  delete volatileDrafts[mode];

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(searchDraftStorageKey(mode));
  } catch {
    // The volatile draft has still been cleared.
  }
}

function searchDraftStorageKey(mode: SearchMode) {
  return mode === "SIMULATOR" ? SIMULATOR_SEARCH_DRAFT_STORAGE_KEY : SEARCH_DRAFT_STORAGE_KEY;
}

export function sanitizeSearchDraft(value: unknown, mode: SearchMode = "OUTDOOR"): SearchDraft {
  const record = isRecord(value) ? value : {};
  const prefill = sanitizeSearchPrefill({ ...record, mode });

  return {
    location: prefill.location,
    players: prefill.players,
    date: prefill.date,
    startTime: prefill.startTime,
    endTime: prefill.endTime,
    holes: prefill.holes,
    radius: prefill.radius,
    coordinates: prefill.coordinates,
    ...(mode === "SIMULATOR" ? { mode } : {}),
    courses: sanitizeCourseList(record.courses, MAX_STORED_COURSES, mode),
    selectedCourses: sanitizeCourseList(record.selectedCourses, MAX_COURSE_PREFERENCES, mode)
  };
}

function sanitizeCourseList(value: unknown, maximum: number, mode: SearchMode) {
  if (!Array.isArray(value)) {
    return [];
  }

  const courses: CourseCandidate[] = [];
  const seenPlaceIds = new Set<string>();
  const seenOfferingIds = new Set<string>();

  for (const candidate of value.slice(0, maximum)) {
    const course = sanitizeCourseCandidate(candidate, mode);
    if (!course || seenPlaceIds.has(course.googlePlaceId) || (course.offeringId && seenOfferingIds.has(course.offeringId))) {
      continue;
    }
    seenPlaceIds.add(course.googlePlaceId);
    if (course.offeringId) seenOfferingIds.add(course.offeringId);
    courses.push(course);
  }

  return courses;
}

function sanitizeCourseCandidate(value: unknown, mode: SearchMode): CourseCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const base = sanitizeSearchPrefill({ selectedCourse: value, mode }).selectedCourse;
  if (!base) {
    return undefined;
  }

  const distanceMeters = safeNumber(value.distanceMeters, 0, 200_000);
  const rating = safeNumber(value.rating, 0, 5);
  const par = safeInteger(value.par, 27, 90);
  const phone = safeString(value.phone, 100);
  const photoReference = safeString(value.photoReference, 1_000);
  const photoAttributions = sanitizePhotoAttributions(value.photoAttributions);
  const priceEstimate = sanitizePriceEstimate(value.priceEstimate);
  const bookableHoleCounts = sanitizeHoleCounts(value.bookableHoleCounts);
  const layoutHoleCounts = sanitizeHoleCounts(value.layoutHoleCounts);
  const alertSupport = ALERT_SUPPORT_VALUES.has(value.alertSupport as CourseAlertSupport)
    ? value.alertSupport as CourseAlertSupport
    : undefined;
  const monitoringSupport = MONITORING_SUPPORT_VALUES.has(
    value.monitoringSupport as CourseMonitoringSupport
  )
    ? value.monitoringSupport as CourseMonitoringSupport
    : undefined;
  const layoutHolesStatus = value.layoutHolesStatus === "VERIFIED" ||
    value.layoutHolesStatus === "UNVERIFIED"
    ? value.layoutHolesStatus
    : undefined;
  const publicAccessStatus = value.publicAccessStatus === "PUBLIC" ||
    value.publicAccessStatus === "UNVERIFIED" ||
    value.publicAccessStatus === "REVIEW_REQUIRED"
    ? value.publicAccessStatus
    : undefined;

  const sharedCandidate: CourseCandidate = {
    ...base,
    ...(publicAccessStatus ? { publicAccessStatus } : {}),
    ...(distanceMeters !== undefined ? { distanceMeters } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(phone ? { phone } : {}),
    ...(photoReference ? { photoReference } : {}),
    ...(photoAttributions.length > 0 ? { photoAttributions } : {}),
    ...(alertSupport ? { alertSupport } : {}),
    ...(monitoringSupport ? { monitoringSupport } : {})
  };
  if (mode === "SIMULATOR") return sharedCandidate;

  return {
    ...sharedCandidate,
    ...(par !== undefined ? { par } : {}),
    ...(safeHttpUrl(value.parEvidenceUrl) ? { parEvidenceUrl: safeHttpUrl(value.parEvidenceUrl) } : {}),
    ...(safeDate(value.parVerifiedAt) ? { parVerifiedAt: safeDate(value.parVerifiedAt) } : {}),
    ...(priceEstimate ? { priceEstimate } : {}),
    ...(bookableHoleCounts.length > 0 ? { bookableHoleCounts } : {}),
    ...(layoutHoleCounts.length > 0 ? { layoutHoleCounts } : {}),
    ...(layoutHolesStatus ? { layoutHolesStatus } : {}),
    ...(safeHttpUrl(value.layoutHolesEvidenceUrl)
      ? { layoutHolesEvidenceUrl: safeHttpUrl(value.layoutHolesEvidenceUrl) }
      : {}),
    ...(safeDate(value.layoutHolesVerifiedAt)
      ? { layoutHolesVerifiedAt: safeDate(value.layoutHolesVerifiedAt) }
      : {})
  };
}

function sanitizePhotoAttributions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 5).flatMap((attribution) => {
    if (!isRecord(attribution)) {
      return [];
    }
    const displayName = safeString(attribution.displayName, 200);
    const uri = safeHttpUrl(attribution.uri);
    const photoUri = safeHttpUrl(attribution.photoUri);
    return displayName || uri || photoUri
      ? [{ ...(displayName ? { displayName } : {}), ...(uri ? { uri } : {}), ...(photoUri ? { photoUri } : {}) }]
      : [];
  });
}

function sanitizePriceEstimate(value: unknown): CourseCandidate["priceEstimate"] {
  if (!isRecord(value) || value.currency !== "USD") {
    return undefined;
  }
  const observedAt = safeDate(value.observedAt);
  const nineHoles = sanitizePriceRange(value.nineHoles);
  const eighteenHoles = sanitizePriceRange(value.eighteenHoles);
  if (!observedAt || (!nineHoles && !eighteenHoles)) {
    return undefined;
  }
  return {
    currency: "USD",
    observedAt,
    ...(nineHoles ? { nineHoles } : {}),
    ...(eighteenHoles ? { eighteenHoles } : {})
  };
}

function sanitizePriceRange(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }
  const minPriceCents = safeInteger(value.minPriceCents, 0, 1_000_000);
  const maxPriceCents = safeInteger(value.maxPriceCents, 0, 1_000_000);
  const sampleSize = safeInteger(value.sampleSize, 1, 100_000);
  if (
    minPriceCents === undefined ||
    maxPriceCents === undefined ||
    sampleSize === undefined ||
    minPriceCents > maxPriceCents
  ) {
    return undefined;
  }
  return { minPriceCents, maxPriceCents, sampleSize };
}

function sanitizeHoleCounts(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return ([9, 18] as const).filter((holes) => value.includes(holes));
}

function safeHttpUrl(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
      ? value.slice(0, 500)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value.slice(0, 100)
    : undefined;
}

function safeString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function safeNumber(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function safeInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? safeNumber(value, minimum, maximum)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
