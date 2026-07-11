import timezoneLookup from "@photostructure/tz-lookup";

export const DEFAULT_TIME_ZONE = "America/New_York";

export function isValidTimeZone(value: string | null | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(
  value: string | null | undefined,
  fallback = DEFAULT_TIME_ZONE
) {
  return isValidTimeZone(value) ? value : fallback;
}

export function getTimeZoneForCoordinates(
  latitude: number,
  longitude: number,
  fallback = DEFAULT_TIME_ZONE
) {
  try {
    return normalizeTimeZone(timezoneLookup(latitude, longitude), fallback);
  } catch {
    return fallback;
  }
}

export function zonedDateTimeToDate(value: string, timeZone: string) {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) {
    return new Date(value);
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) {
    return new Date(value);
  }

  const [, year, month, day, hour, minute, second = "0"] = match;
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );
  const offset = getTimeZoneOffsetMinutes(new Date(utcGuess), timeZone);

  return new Date(utcGuess - offset * 60_000);
}

export function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(byType.get("year")),
    Number(byType.get("month")) - 1,
    Number(byType.get("day")),
    Number(byType.get("hour")),
    Number(byType.get("minute")),
    Number(byType.get("second"))
  );

  return Math.round((zonedAsUtc - date.getTime()) / 60_000);
}

export function formatTimeZoneLabel(timeZone: string, date = new Date()) {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizeTimeZone(timeZone),
    timeZoneName: "short"
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;

  return zoneName ? `${zoneName} (${normalizeTimeZone(timeZone)})` : normalizeTimeZone(timeZone);
}
