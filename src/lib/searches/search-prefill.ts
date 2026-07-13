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

  return {
    location,
    date,
    startTime,
    endTime,
    players,
    radius: radius ?? DEFAULT_COURSE_SEARCH_RADIUS_MILES,
    holes,
    coordinates
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
