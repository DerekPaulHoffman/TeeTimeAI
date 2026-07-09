export const COURSE_SEARCH_RADIUS_OPTIONS_MILES = [5, 10, 15, 20, 25, 30] as const;

export const DEFAULT_COURSE_SEARCH_RADIUS_MILES = 15;
export const MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS = 50000;

const METERS_PER_MILE = 1609.344;

export function milesToMeters(miles: number) {
  return Math.round(miles * METERS_PER_MILE);
}

export function normalizeCourseSearchRadiusMeters(value: string | null) {
  const requestedRadiusMeters = Number(value);

  if (!Number.isFinite(requestedRadiusMeters) || requestedRadiusMeters <= 0) {
    return milesToMeters(DEFAULT_COURSE_SEARCH_RADIUS_MILES);
  }

  return Math.min(Math.round(requestedRadiusMeters), MAX_GOOGLE_NEARBY_SEARCH_RADIUS_METERS);
}
