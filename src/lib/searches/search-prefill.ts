import {
  DEFAULT_COURSE_SEARCH_RADIUS_MILES,
  MAX_COURSE_SEARCH_RADIUS_MILES,
  MIN_COURSE_SEARCH_RADIUS_MILES
} from "@/lib/places/radius";
import { MAX_PLAYERS_PER_SEARCH } from "@/lib/validation/search";

export const SEARCH_PREFILL_STORAGE_KEY = "tee-time-spot:search-prefill";

export type SearchPrefill = {
  location?: string;
  players?: number;
  date?: string;
  startTime?: string;
  endTime?: string;
  holes?: "any" | "9" | "18";
  radius?: number;
  coordinates?: { latitude: number; longitude: number };
  selectedCourse?: {
    courseId?: string;
    googlePlaceId: string;
    name: string;
    address?: string;
    city?: string;
    stateCode?: string;
    stateName?: string;
    county?: string;
    countryCode?: string;
    latitude: number;
    longitude: number;
    timeZone: string;
    website?: string;
    profileUrl?: string;
  };
};

let volatilePrefill: SearchPrefill | undefined;

export function storeSearchPrefill(prefill: SearchPrefill) {
  const safePrefill = sanitizeSearchPrefill(prefill);
  volatilePrefill = safePrefill;

  if (typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.setItem(SEARCH_PREFILL_STORAGE_KEY, JSON.stringify(safePrefill));
  } catch {
    // The in-memory fallback preserves client navigation when storage is unavailable.
  }
}

export function consumeSearchPrefill() {
  let storedValue: string | null = null;

  if (typeof window !== "undefined") {
    try {
      storedValue = window.sessionStorage.getItem(SEARCH_PREFILL_STORAGE_KEY);
      window.sessionStorage.removeItem(SEARCH_PREFILL_STORAGE_KEY);
    } catch {
      // Fall back to the single-use in-memory value.
    }
  }

  const fallback = volatilePrefill;
  volatilePrefill = undefined;

  if (!storedValue) {
    return fallback;
  }

  try {
    return sanitizeSearchPrefill(JSON.parse(storedValue) as unknown);
  } catch {
    return fallback;
  }
}

export function readSearchPrefillFromUrl(search?: string) {
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
  if (!query) {
    return undefined;
  }

  const params = new URLSearchParams(query);
  const supportedKeys = [
    "location",
    "players",
    "date",
    "startTime",
    "endTime",
    "holes",
    "radius",
    "latitude",
    "longitude"
  ];
  if (!supportedKeys.some((key) => params.has(key))) {
    return undefined;
  }

  const latitude = numberParam(params, "latitude");
  const longitude = numberParam(params, "longitude");

  return sanitizeSearchPrefill({
    location: params.get("location") ?? undefined,
    players: numberParam(params, "players"),
    date: params.get("date") ?? undefined,
    startTime: params.get("startTime") ?? undefined,
    endTime: params.get("endTime") ?? undefined,
    holes: params.get("holes") ?? undefined,
    radius: numberParam(params, "radius"),
    coordinates:
      latitude === undefined || longitude === undefined
        ? undefined
        : { latitude, longitude }
  });
}

export function sanitizeSearchPrefill(value: unknown): SearchPrefill {
  if (!isRecord(value)) {
    return {};
  }

  const location = safeString(value.location, 300);
  const date = matches(value.date, /^\d{4}-\d{2}-\d{2}$/);
  const startTime = matches(value.startTime, /^\d{2}:\d{2}$/);
  const endTime = matches(value.endTime, /^\d{2}:\d{2}$/);
  const players = safeInteger(value.players, 1, MAX_PLAYERS_PER_SEARCH);
  const radius = safeInteger(
    value.radius,
    MIN_COURSE_SEARCH_RADIUS_MILES,
    MAX_COURSE_SEARCH_RADIUS_MILES
  );
  const holes = value.holes === "9" || value.holes === "18" || value.holes === "any"
    ? value.holes
    : undefined;
  const coordinates = sanitizeCoordinates(value.coordinates);
  const selectedCourse = sanitizeSelectedCourse(value.selectedCourse);

  return {
    location,
    date,
    startTime,
    endTime,
    players,
    radius: radius ?? DEFAULT_COURSE_SEARCH_RADIUS_MILES,
    holes,
    coordinates,
    ...(selectedCourse ? { selectedCourse } : {})
  };
}

function sanitizeSelectedCourse(value: unknown): SearchPrefill["selectedCourse"] {
  if (!isRecord(value)) return undefined;
  const googlePlaceId = safeString(value.googlePlaceId, 200);
  const name = safeString(value.name, 200);
  const coordinates = sanitizeCoordinates(value);
  const timeZone = safeString(value.timeZone, 100);
  if (!googlePlaceId || !name || !coordinates || !timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    return undefined;
  }
  const safeUrl = (candidate: unknown) => {
    if (typeof candidate !== "string") return undefined;
    try {
      const url = new URL(candidate, "https://teetimespot.com");
      return new Set(["http:", "https:"]).has(url.protocol) ? candidate.slice(0, 500) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    courseId: safeString(value.courseId, 100),
    googlePlaceId,
    name,
    address: safeString(value.address, 300),
    city: safeString(value.city, 120),
    stateCode: safeString(value.stateCode, 2)?.toUpperCase(),
    stateName: safeString(value.stateName, 120),
    county: safeString(value.county, 120),
    countryCode: safeString(value.countryCode, 2)?.toUpperCase(),
    ...coordinates,
    timeZone,
    website: safeUrl(value.website),
    profileUrl: safeUrl(value.profileUrl)
  };
}

function sanitizeCoordinates(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  const { latitude, longitude } = value;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return undefined;
  }

  return { latitude, longitude };
}

function safeString(value: unknown, maxLength: number) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function matches(value: unknown, pattern: RegExp) {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function numberParam(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
