import { isSafePublicServiceReadUrl } from "./public-service-read-url";

/** Exact observed anonymous dated-course event read, separate from inventory.
 * Only the fixed opaque basename is masked for unchanged strict validation;
 * the caller retains the original URL and all request/header authority. */
export function isSafePublicMemberSportsEventsReadUrl(value: string, resourceType: string, method: string,
  strictUrl: (value: string) => boolean) {
  if (value.length > 2048 || value.trim() !== value || method !== "GET" || !["xhr", "fetch"].includes(resourceType)) return false;
  const match = /^https:\/\/api\.membersports\.com\/api\/v1\/Events\/eventsByDateForCourses\/golfClubId\/([1-9][0-9]{0,9})\/searchDate\/([1-9][0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\?golfCourseIds=([1-9][0-9]{0,9})$/u.exec(value);
  if (!match || Number(match[1]) > 2_147_483_647 || Number(match[5]) > 2_147_483_647) return false;
  const year = Number(match[2]), month = Number(match[3]), day = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  try { return strictUrl(value.replace("/eventsByDateForCourses/", "/public-course-events/")) === true; }
  catch { return false; }
}

/** Validation-only copies for anonymous browser metadata reads. This function
 * never returns a rewritten transport URL or grants navigation/recipe proof. */
export function isSafePublicBootstrapReadUrl(value: string, resourceType: string, method: string,
  strictUrl: (value: string) => boolean) {
  if (isSafePublicMemberSportsEventsReadUrl(value, resourceType, method, strictUrl)) return true;
  if (isSafePublicServiceReadUrl(value, resourceType, method, "METADATA", strictUrl)) return true;
  if (value.length > 2048 || value.trim() !== value || method !== "GET" || !["xhr", "fetch"].includes(resourceType)) return false;
  try {
    const url = new URL(value), rawPath = /^https:\/\/[^/?#]+([^?#]*)/u.exec(value)?.[1] || "/";
    // Do not turn encoded, dot-normalized or otherwise aliased paths into an
    // exempt metadata role. Every parent path remains under the strict guard.
    if (rawPath !== url.pathname || url.hash) return false;
    // These four observed anonymous service-catalog metadata reads are not
    // customer/account actions or availability proof. Validate the entire raw
    // role before masking its account path in a validation-only copy; retain
    // the original transport URL and all caller header/session/route guards.
    const publicCatalog = /^https:\/\/api\.ola\.godaddy\.com\/(?:accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:config|hivemind)|v2\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/categories|v3\/accounts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/services\?(?:per_page=80&with_category_ids=true|with_category_ids=true&per_page=80))$/u;
    if (publicCatalog.test(value)) {
      const checked = new URL(value);
      checked.pathname = "/public-bootstrap-metadata";
      return strictUrl(checked.href) === true;
    }
    const role = rawPath.slice(rawPath.lastIndexOf("/") + 1);
    if (!["GlobalTenantSettings", "AuthenticationSettings", "venue_info", "GetReadOnlyTeeSheet"].includes(role)) return false;
    // This observed GET returns a UI configuration flag, not dated inventory.
    // No parameters were observed or established for this metadata role.
    if (role === "GetReadOnlyTeeSheet" && value.includes("?")) return false;
    const query = value.includes("?") ? value.slice(value.indexOf("?") + 1).split("&") : [];
    const literalParameter = (key: string) => {
      const values = url.searchParams.getAll(key), indices = query.flatMap((part, index) => part.split("=", 1)[0] === key ? [index] : []);
      if (values.length !== 1 || indices.length !== 1) return undefined;
      const index = indices[0], prefix = key + "=";
      return query[index].startsWith(prefix) ? { index, value: values[0], raw: query[index].slice(prefix.length) } : undefined;
    };
    const checked = new URL(url.href);
    if (role === "venue_info") {
      const reference = literalParameter("venue_url_key");
      if (!reference || reference.raw !== reference.value || reference.value.length > 128 ||
        !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(reference.value)) return false;
      // Keep the actual public identifier unchanged under the existing opaque,
      // nested-URL and contextual credential-value checks before masking its key.
      const valueCheck = new URL(url.href); valueCheck.pathname = "/public-bootstrap-value"; valueCheck.search = "";
      valueCheck.searchParams.set("key", reference.value);
      if (!strictUrl(valueCheck.href)) return false;
      query[reference.index] = "public_venue_reference=" + reference.raw;
    } else {
      checked.pathname = rawPath.slice(0, rawPath.lastIndexOf("/") + 1) + "public-bootstrap-metadata";
      if (role === "AuthenticationSettings" && url.searchParams.has("AuthenticationType")) {
        const type = literalParameter("AuthenticationType");
        if (!type || type.raw !== "" || type.value !== "") return false;
        query[type.index] = "public_bootstrap_type=";
      }
    }
    checked.search = query.length ? "?" + query.join("&") : "";
    return strictUrl(checked.href);
  } catch { return false; }
}
