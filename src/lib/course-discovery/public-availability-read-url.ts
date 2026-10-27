import { isSafePublicServiceReadUrl } from "./public-service-read-url";

const rangePrefix = "https://www.sevenrooms.com/api-yoa/availability/widget/range?";
const requiredKeys = ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel"];
const allowedKeys = new Set([...requiredKeys, "selected_lang_code", "picked_duration"]);
const memberSportsTeeSheet = "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes";

function boundedInteger(value: string, minimum: number, maximum: number) {
  return /^(?:0|[1-9]\d*)$/u.test(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function calendarDate(value: string) {
  const match = /^(\d{2})-(\d{2})-([1-9]\d{3})$/u.exec(value);
  if (!match) return false;
  const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Validation-only language-key masking for this published public GET. It does
 * not rewrite the wire URL, grant navigation, or prove inventory completeness. */
export function isSafePublicAvailabilityReadUrl(value: string, resourceType: string, method: string,
  strictUrl: (value: string) => boolean) {
  if (isSafePublicServiceReadUrl(value, resourceType, method, "AVAILABILITY", strictUrl)) return true;
  // This fixed public read basename resembles opaque state to the customer URL
  // guard. The exception grants only data-read URL validation, never navigation,
  // body/header authority or a changed wire URL.
  if (value === memberSportsTeeSheet && method === "POST" && ["xhr", "fetch"].includes(resourceType)) {
    try { return strictUrl(value.replace("/onlineBookingTeeTimes", "/public-tee-sheet")) === true; }
    catch { return false; }
  }
  if (value.length > 2048 || value.trim() !== value || !value.startsWith(rangePrefix) || value.includes("#") ||
      method !== "GET" || !["xhr", "fetch"].includes(resourceType)) return false;
  try {
    const url = new URL(value), query = value.slice(rangePrefix.length).split("&"), values = new Map<string, string>();
    if (url.protocol !== "https:" || url.hostname !== "www.sevenrooms.com" || url.port || url.username || url.password ||
        url.pathname !== "/api-yoa/availability/widget/range" || query.length < requiredKeys.length || query.length > allowedKeys.size) return false;
    for (const part of query) {
      const separator = part.indexOf("=");
      if (separator < 1) return false;
      const key = part.slice(0, separator), scalar = part.slice(separator + 1);
      // The published constructor concatenates these simple scalars literally;
      // encoded names/values, duplicate keys and query aliases gain no exception.
      if (!allowedKeys.has(key) || values.has(key) || url.searchParams.getAll(key).length !== 1 ||
          url.searchParams.get(key) !== scalar) return false;
      values.set(key, scalar);
    }
    if (!requiredKeys.every(key => values.has(key)) ||
        !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(values.get("venue")!) || values.get("venue")!.length > 128 ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(values.get("time_slot")!) ||
        !boundedInteger(values.get("party_size")!, 1, 4) || !calendarDate(values.get("start_date")!) ||
        !["1", "3"].includes(values.get("num_days")!) || !/^[a-z][a-z0-9_-]{0,63}$/iu.test(values.get("channel")!)) return false;
    // Source proves halo = minutes / 15, but not every UI maximum. One day of
    // halo and duration are conservative safety caps, not provider limit claims.
    if (!boundedInteger(values.get("halo_size_interval")!, 0, 96) ||
        values.has("picked_duration") && !boundedInteger(values.get("picked_duration")!, 1, 1440)) return false;
    const language = values.get("selected_lang_code");
    if (language !== undefined && !/^[a-z]{2,3}(?:-(?:[a-z]{2}|\d{3}))?$/iu.test(language)) return false;
    const checked = language === undefined ? value : rangePrefix + query.map(part =>
      part.startsWith("selected_lang_code=") ? "public_availability_language=" + language : part).join("&");
    // Every original value, the exact origin/path and all remaining keys still
    // pass the unchanged strict callback; the original URL is never returned.
    return strictUrl(checked) === true;
  } catch { return false; }
}
