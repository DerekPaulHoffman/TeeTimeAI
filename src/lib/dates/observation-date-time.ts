import { normalizeTimeZone } from "@/lib/timezones";

export function formatObservationDateTime(
  value: Date | string,
  timeZone: string
) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: normalizeTimeZone(timeZone),
    timeZoneName: "short"
  });
}
