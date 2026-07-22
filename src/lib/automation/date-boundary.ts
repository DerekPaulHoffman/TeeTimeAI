import { normalizeTimeZone } from "@/lib/timezones";

export function startOfUtcCalendarDay(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
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
