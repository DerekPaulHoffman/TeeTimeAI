import { isSafePublicServiceReadUrl } from "./public-service-read-url";

/** Exact anonymous facility metadata and published Next routing assets used
 * by this public booking client. Build identifiers are asset versions.
 * This grants metadata reads only; source, inventory and header guards remain
 * separate, and the original transport URL is never rewritten. */
export function isSafePublicSwiftBootstrapReadUrl(value: string, resourceType: string, method: string,
  strictUrl: (value: string) => boolean) {
  if (value.length > 2048 || !["xhr", "fetch"].includes(resourceType) || !["GET", "HEAD"].includes(method)) return false;
  const manifest = /^https:\/\/book\.runswiftapp\.com\/_next\/static\/[A-Za-z0-9_-]{8,128}\/_buildManifest\.js$/u;
  const page = /^https:\/\/book\.runswiftapp\.com\/_next\/data\/[A-Za-z0-9_-]{8,128}\/facilities\/([a-z0-9][a-z0-9-]{0,99})(?:\/rentals)?\.json$/u.exec(value);
  const facility = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/facility\/getFacilityBySubdomain\?subdomain=([a-z0-9][a-z0-9-]{0,99})$/u.exec(value);
  const eligibility = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/facility\/([1-9][0-9]{0,9})\/isEligibleForBooking$/u.exec(value);
  const visibility = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/public\/service\/visibility\?facilityId=([1-9][0-9]{0,9})&userId=$/u.exec(value);
  const rentalPage = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/_next\/data\/[A-Za-z0-9_-]{8,128}\/book\/facilities\/([a-z0-9][a-z0-9-]{0,99})\/rentals\.json\?subdomain=\1&serviceType=rentals$/u.exec(value);
  // These are the observed catalogue defaults, not dated slot filters.
  const catalog = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/public\/rental\/?\?facilityId=([1-9][0-9]{0,9})&duration=0%2C480&price=0%2C500&startTime=4%2C23&dayOfWeek=0$/u.exec(value);
  const collections = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/public\/facility\/([1-9][0-9]{0,9})\/service-collections\?type=RENTAL$/u.exec(value);
  const price = method === "GET" && /^https:\/\/book\.runswiftapp\.com\/api\/public\/price\?facilityId=([1-9][0-9]{0,9})&serviceId=([1-9][0-9]{0,9})&packageId=&membershipId=&userId=$/u.exec(value);
  if ([eligibility, visibility, catalog, collections, price].some(match => match && Number(match[1]) > 2_147_483_647) || price && Number(price[2]) > 2_147_483_647) return false;
  if (!(method === "GET" && manifest.test(value)) && !page && !facility && !eligibility && !visibility && !rentalPage && !catalog && !collections && !price) return false;
  try {
    const checked = new URL(value);
    if (checked.href !== value || checked.username || checked.password || checked.port ||
        (!facility && !visibility && !rentalPage && !catalog && !collections && !price && checked.search) || checked.hash) return false;
    const reference = page?.[1] || (rentalPage ? rentalPage[1] : undefined) || (facility ? facility[1] : undefined) ||
      [eligibility, visibility, catalog, collections, price].find((match): match is RegExpExecArray => Boolean(match))?.[1];
    checked.pathname = reference ? "/public-facility/" + reference : "/public-routing-metadata";
    checked.search = "";
    return strictUrl(checked.href) === true;
  } catch { return false; }
}

/** The public catalogue canonicalizes its trailing slash with a 308. This
 * preserves the exact anonymous catalogue query and grants no page route. */
export function isSafePublicSwiftCatalogRedirect(from: string, to: string, status: number, resourceType: string, method: string,
  strictUrl: (value: string) => boolean) {
  return status === 308 && method === "GET" && from.startsWith("https://book.runswiftapp.com/api/public/rental/?") &&
    to === from.replace("/api/public/rental/?", "/api/public/rental?") &&
    isSafePublicSwiftBootstrapReadUrl(from, resourceType, method, strictUrl) &&
    isSafePublicSwiftBootstrapReadUrl(to, resourceType, method, strictUrl);
}

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
  if (isSafePublicSwiftBootstrapReadUrl(value, resourceType, method, strictUrl)) return true;
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
