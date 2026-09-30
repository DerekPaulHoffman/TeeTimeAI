import { normalizeTimeZone } from "@/lib/timezones";

export function isValidSearchCalendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function assertFutureCourseSearchDate(
  date: string,
  courseTimeZones: Array<string | null | undefined>,
  now = new Date(),
) {
  if (!isValidSearchCalendarDate(date)) {
    throw new Error("Use a valid YYYY-MM-DD date");
  }

  // The stored UTC-midnight value is a calendar date, not the start of the
  // golfer's window. Every selected course must still have a future local day.
  const timeZones = courseTimeZones.length > 0 ? courseTimeZones : [undefined];
  for (const timeZone of new Set(timeZones.map((zone) => normalizeTimeZone(zone)))) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const byType = new Map(parts.map((part) => [part.type, part.value]));
    const today = `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
    if (date <= today) {
      throw new Error("Search date must be in the future for every selected course");
    }
  }
}
