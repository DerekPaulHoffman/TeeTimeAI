import { normalizeTimeZone, zonedDateTimeToDate } from "@/lib/timezones";

export function startOfUtcCalendarDay(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
}

// A course-local calendar date can be one day behind UTC. Use this indexed,
// conservative floor for database candidate selection, then apply the exact
// course-local end time before doing any course work.
export function earliestPotentiallyActiveSearchDate(now = new Date()) {
  const boundary = startOfUtcCalendarDay(now);
  boundary.setUTCDate(boundary.getUTCDate() - 1);
  return boundary;
}

export function getCourseLocalDateStorageBoundary(
  timeZone: string | null | undefined,
  now = new Date()
) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return new Date(
    `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}T00:00:00.000Z`
  );
}

export function calculateSearchWindowEnd(
  date: Date,
  endTime: string,
  courseTimeZones: string[],
  fallbackTimeZone: string
) {
  const dateValue = date.toISOString().slice(0, 10);
  const timeZones = courseTimeZones.length > 0 ? courseTimeZones : [fallbackTimeZone];
  return new Date(
    Math.max(
      ...timeZones.map((timeZone) =>
        zonedDateTimeToDate(
          `${dateValue}T${endTime}:00`,
          normalizeTimeZone(timeZone, fallbackTimeZone)
        ).getTime()
      )
    )
  );
}

export function isSearchWindowActive(input: {
  date: Date;
  endTime: string;
  courseTimeZones: string[];
  fallbackTimeZone: string;
  now?: Date;
}) {
  return (
    (input.now ?? new Date()) <
    calculateSearchWindowEnd(
      input.date,
      input.endTime,
      input.courseTimeZones,
      input.fallbackTimeZone
    )
  );
}
