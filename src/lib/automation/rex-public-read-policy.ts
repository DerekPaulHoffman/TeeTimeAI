import { z } from "zod";

/** Public signed-out client observed 2026-10-22:
 * https://waymakerbrewing.reservewithrex.com/assets/app-UmUWLyNF.js
 * SHA256 6a9da5d4031dea74d3eff8c0ecb42419aa45e2fbeebfe7d61d966948969504c6.
 * tRe (offset 1070060) reads the filtered venue catalog; gA (1070360)
 * reads venue/package availability. Neither calls /api/reservation.
 * duration is a count of provider slots, not a number of minutes.
 */
export const REX_PUBLIC_READ_PATHS = ["/api/venue/get", "/api/venue/get-venue-with-package"] as const;
const publicId = z.string().regex(/^(?:[1-9]\d{0,9}|[a-fA-F0-9]{24}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/u);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(value => {
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
});
const common = {
  venueId: publicId, date: day, guests: z.number().int().min(1).max(200),
  duration: z.number().int().min(1).max(96).optional(),
  lanes: z.number().int().min(1).max(20).optional(),
  packagesTag: z.string().max(120).regex(/^[\p{L}\p{N}\s.,'&()_-]*$/u).optional(),
  targetPackage: publicId.optional(),
};
const catalog = z.object(common).strict();
const availability = z.object({ ...common, packageId: publicId.optional(), singlePackage: z.boolean().optional(),
  guestsWithAgeGroups: z.tuple([]).optional(), resourceIds: z.tuple([]).optional(),
}).strict();
const credentialHeader = /authorization|cookie|token|secret|credential|password|session|api.?key|csrf|next-action|(?:http-)?method-override/iu;

export function isRexNamespace(url: URL) {
  return url.hostname === "reservewithrex.com" || url.hostname.endsWith(".reservewithrex.com");
}
function publicTenant(url: URL) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.reservewithrex\.com$/u.test(url.hostname);
}

/** Two closed anonymous catalog reads, never an assertion based on a route name alone. */
export function isRexPublicReadPost(url: URL, headers: Headers, body: string) {
  if (!publicTenant(url) || url.search || url.hash || !REX_PUBLIC_READ_PATHS.some(path => path === url.pathname) ||
      headers.get("origin") !== url.origin || [...headers.keys()].some(key => credentialHeader.test(key)) ||
      !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
      Buffer.byteLength(body) > 16_384) return false;
  try {
    const value: unknown = JSON.parse(body);
    return (url.pathname === "/api/venue/get" ? catalog : availability).safeParse(value).success;
  } catch { return false; }
}

/** The published signed-out client emits this exact non-credential placeholder.
 * Native Chrome forwards it unchanged. This function never authorizes a real
 * bearer token, cookie, another endpoint, or another current document.
 */
export function isRexAnonymousPlaceholderRead(url: URL, method: string, original: Record<string, string>, body: string, frameUrl: string) {
  if (method !== "POST" || url.pathname !== "/api/venue/get-venue-with-package" || original.authorization !== "bearer null" ||
      Object.keys(original).some(key => key !== "authorization" && credentialHeader.test(key))) return false;
  let frame: URL;
  try { frame = new URL(frameUrl); } catch { return false; }
  if (!publicTenant(frame) || frame.origin !== url.origin || frame.pathname !== "/package" || frame.hash ||
      [...frame.searchParams.keys()].some(key => !["venue", "date", "guests", "currentPackage"].includes(key))) return false;
  const projected = new Headers();
  for (const key of ["content-type", "origin"]) if (original[key]) projected.set(key, original[key]);
  return isRexPublicReadPost(url, projected, body);
}

/** Inspect actual native request headers before their normal public projection.
 * Native Chrome forwards original headers, so a projected header set cannot
 * establish that a request is anonymous. */
export function isRexPublicBrowserReadPost(url: URL, method: string, original: Record<string, string>, body: string, frameUrl: string) {
  if (method !== "POST") return false;
  let frame: URL;
  try { frame = new URL(frameUrl); } catch { return false; }
  if (!publicTenant(frame) || frame.origin !== url.origin) return false;
  return isRexPublicReadPost(url, new Headers(original), body) || isRexAnonymousPlaceholderRead(url, method, original, body, frameUrl);
}

/** Diagnostic only. Never returns request values, unknown key names or header
 * values, and never grants read authority. Call after the full predicate denies. */
export function rexPublicBrowserReadRejection(url: URL, method: string, original: Record<string, string>, body: string, frameUrl: string): string {
  try {
    if (isRexPublicBrowserReadPost(url, method, original, body, frameUrl)) return "REX_READ_NOT_REJECTED";
    if (method !== "POST") return "REX_READ_METHOD";
    let frame: URL;
    try { frame = new URL(frameUrl); } catch { return "REX_READ_FRAME_URL"; }
    if (!publicTenant(frame)) return "REX_READ_FRAME_URL";
    if (frame.origin !== url.origin) return "REX_READ_FRAME_ORIGIN";
    if (!publicTenant(url)) return "REX_READ_URL";
    if (url.search || url.hash) return "REX_READ_URL_STATE";
    if (!REX_PUBLIC_READ_PATHS.some(path => path === url.pathname)) return "REX_READ_PATH";
    const placeholder = original.authorization === "bearer null" && url.pathname === "/api/venue/get-venue-with-package";
    for (const key of Object.keys(original).sort()) {
      if (!credentialHeader.test(key) || placeholder && key === "authorization") continue;
      const normalized = key.toLowerCase();
      const kind = /authorization/u.test(normalized) ? "AUTHORIZATION" : /cookie/u.test(normalized) ? "COOKIE"
        : /csrf/u.test(normalized) ? "CSRF" : /api.?key/u.test(normalized) ? "API_KEY"
          : /method-override/u.test(normalized) ? "METHOD_OVERRIDE" : /token/u.test(normalized) ? "TOKEN" : "OTHER_CREDENTIAL";
      return `REX_READ_HEADER_${kind}`;
    }
    if (placeholder && (frame.pathname !== "/package" || frame.hash ||
        [...frame.searchParams.keys()].some(key => !["venue", "date", "guests", "currentPackage"].includes(key)))) return "REX_READ_PLACEHOLDER_FRAME";
    const headers = new Headers(original);
    if (headers.get("origin") !== url.origin) return "REX_READ_ORIGIN";
    if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "")) return "REX_READ_CONTENT_TYPE";
    if (Buffer.byteLength(body) > 16_384) return "REX_READ_BODY_LIMIT";
    let value: unknown;
    try { value = JSON.parse(body); } catch { return "REX_READ_BODY_JSON"; }
    const parsed = (url.pathname === "/api/venue/get" ? catalog : availability).safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const fields: Record<string, string> = { venueId: "VENUE_ID", date: "DATE", guests: "GUESTS", duration: "DURATION", lanes: "LANES",
        packagesTag: "PACKAGES_TAG", targetPackage: "TARGET_PACKAGE", packageId: "PACKAGE_ID", singlePackage: "SINGLE_PACKAGE",
        guestsWithAgeGroups: "GUESTS_WITH_AGE_GROUPS", resourceIds: "RESOURCE_IDS" };
      const key = issue.path[0], field = key === undefined ? issue.code === "unrecognized_keys" ? "OTHER" : "ROOT"
        : typeof key === "string" && Object.hasOwn(fields, key) ? fields[key] : "OTHER";
      const item = key !== undefined && value && typeof value === "object" && Object.hasOwn(value, key) ? Reflect.get(value, key) : key === undefined ? value : undefined;
      const type = item === undefined ? "ABSENT" : item === null ? "NULL" : item === "" ? "EMPTY_STRING" : Array.isArray(item) ? "ARRAY"
        : typeof item === "string" ? "STRING" : typeof item === "number" ? "NUMBER" : typeof item === "boolean" ? "BOOLEAN" : "OBJECT";
      const reason = issue.code === "unrecognized_keys" ? "EXTRA_FIELDS" : issue.code === "invalid_type" ? "TYPE"
        : issue.code === "invalid_format" ? "FORMAT" : issue.code === "too_small" || issue.code === "too_big" ? "RANGE" : "VALUE";
      return `REX_READ_BODY_${field}_${type}_${reason}`;
    }
    return "REX_READ_POLICY_OTHER";
  } catch { return "REX_READ_DIAGNOSTIC_UNAVAILABLE"; }
}

/** PINNED transport diagnostics describe only its three projected public
 * headers, never the browser's original Cookie/authorization header state. */
export function rexProjectedPublicReadRejection(url: URL, headers: Headers, body: string, frameUrl: string): string {
  const projected: Record<string, string> = {};
  for (const key of ["accept", "content-type", "origin"]) {
    const value = headers.get(key);
    if (value !== null) projected[key] = value;
  }
  const reason = rexPublicBrowserReadRejection(url, "POST", projected, body, frameUrl);
  return reason === "REX_READ_NOT_REJECTED" ? "REX_READ_PROJECTED_POLICY" : reason;
}
