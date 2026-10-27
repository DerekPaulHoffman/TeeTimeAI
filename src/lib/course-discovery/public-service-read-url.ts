type PublicServiceReadRole = "METADATA" | "AVAILABILITY";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const datedPath = new RegExp("^https://api\\.ola\\.godaddy\\.com/(v2/)?accounts/" + uuid + "/services/([1-9][0-9]{0,9})/(available_times|available_dates)\\?([^#]+)$", "u");
const optionalMetadata = new RegExp("^https://api\\.ola\\.godaddy\\.com/(?:accounts/" + uuid + "/config\\?fields\\[\\]=cart|addons/v1/accounts/" + uuid + "/services/([1-9][0-9]{0,9})/addons)$", "u");
const dayMs = 86_400_000;
const publicId = (value: string) => /^[1-9][0-9]{0,9}$/u.test(value) && Number(value) <= 2_147_483_647;

function timestamp(raw: string) {
  const value = decodeURIComponent(raw);
  if (encodeURIComponent(value) !== raw) return null;
  const match = /^([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])\.([0-9]{3})([+-])([0-9]{2}):([0-5][0-9])$/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const localDay = Date.UTC(year, month - 1, day), calendar = new Date(localDay);
  const offsetHour = Number(match[9]), offsetMinute = Number(match[10]);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      offsetHour > 14 || offsetHour === 14 && offsetMinute !== 0 || match[8] === "-" && offsetHour === 0 && offsetMinute === 0) return null;
  const local = localDay + Number(match[4]) * 3_600_000 + Number(match[5]) * 60_000 + Number(match[6]) * 1000 + Number(match[7]);
  const offset = (offsetHour * 60 + offsetMinute) * 60_000 * (match[8] === "+" ? 1 : -1);
  return { localDay, instant: local - offset };
}

/** Finite anonymous public-service data roles, not navigation or proof. Every
 * path and query scalar is checked before a validation-only origin copy; the
 * caller retains the exact wire URL and all body/header/session/route guards. */
export function isSafePublicServiceReadUrl(value: string, resourceType: string, method: string,
  role: PublicServiceReadRole, strictUrl: (value: string) => boolean) {
  if (value.length > 2048 || value.trim() !== value || method !== "GET" || !["xhr", "fetch"].includes(resourceType)) return false;
  try {
    const metadata = optionalMetadata.exec(value);
    if (metadata) return role === "METADATA" && (metadata[1] === undefined || publicId(metadata[1])) &&
      strictUrl("https://api.ola.godaddy.com/public-service-metadata") === true;
    const path = datedPath.exec(value);
    if (!path || !publicId(path[2]) || (path[3] === "available_times" ? path[1] !== "v2/" || role !== "AVAILABILITY" : path[1] !== undefined || role !== "METADATA")) return false;
    const scalars = new Map<string, string>(), resources = new Set<string>(), query = path[4].split("&");
    if (query.length < 3 || query.length > 34) return false;
    for (const part of query) {
      const separator = part.indexOf("="), key = part.slice(0, separator), scalar = part.slice(separator + 1);
      if (separator < 1) return false;
      if (key === "resource_ids[]") {
        if (!publicId(scalar) || resources.has(scalar)) return false;
        resources.add(scalar);
      } else if (["start_time", "end_time"].includes(key) && !scalars.has(key)) scalars.set(key, scalar);
      else return false;
    }
    if (resources.size < 1 || resources.size > 32 || scalars.size !== 2) return false;
    const start = timestamp(scalars.get("start_time")!), end = timestamp(scalars.get("end_time")!);
    if (!start || !end) return false;
    const elapsed = end.instant - start.instant, inclusiveDays = (end.localDay - start.localDay) / dayMs + 1;
    if (elapsed <= 0 || (path[3] === "available_times" ? start.localDay !== end.localDay || elapsed > 26 * 3_600_000 :
      inclusiveDays < 1 || inclusiveDays > 32 || elapsed > 32 * dayMs)) return false;
    return strictUrl("https://api.ola.godaddy.com/public-service-data") === true;
  } catch { return false; }
}
