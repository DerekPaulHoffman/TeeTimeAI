import { isSafeRecipeUrl } from "./recipe";

const providerDomain = "ezlinksgolf.com";
const documentTokenBrand = Symbol("EZLINKS_PUBLIC_DOCUMENT");
export type EzLinksDocumentToken = Readonly<{ [documentTokenBrand]: true }>;
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 9_999_999_999;
const freshMs = 5 * 60_000;

/** Recognize the entire provider namespace, including denied API/admin hosts.
 * A known REST call must never fall through to generic GraphQL permission. */
export function isEzLinksProviderUrl(value: string | URL) {
  try {
    const host = new URL(String(value)).hostname.replace(/\.$/u, "").toLowerCase();
    return host === providerDomain || host.endsWith(`.${providerDomain}`);
  } catch { return false; }
}

function publicDocument(value: string | URL) {
  try {
    const url = new URL(String(value));
    const tenant = /^([a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)\.ezlinksgolf\.com$/u.exec(url.hostname)?.[1];
    if (!tenant || /^(?:www|api|admin|auth|login|account|portal|private|member|config|dev|qa|staging|sandbox|test)/u.test(tenant) ||
        !isSafeRecipeUrl(url.href) || url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash ||
        !["/", "/search", "/index.html"].includes(url.pathname)) return;
    return url;
  } catch { return; }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function day(value: unknown, format: "ISO" | "US") {
  if (typeof value !== "string") return;
  const match = (format === "ISO" ? /^(20\d{2})-(\d{2})-(\d{2})$/u : /^(\d{2})\/(\d{2})\/(20\d{2})$/u).exec(value);
  if (!match) return;
  const iso = format === "ISO" ? value : `${match[3]}-${match[1]}-${match[2]}`;
  const milliseconds = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === iso ? milliseconds : undefined;
}
function configuredClock(value: unknown) {
  if (typeof value !== "string") return;
  const match = /^(\d{1,2}):([0-5]\d)(?::00)?$/u.exec(value);
  if (!match) return;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < 1440 ? minutes : undefined;
}
function serializedClock(value: unknown) {
  if (typeof value !== "string") return;
  // The observed hourMinFilter emits an unpadded hour, padded minutes and
  // uppercase meridiem. Midnight is its explicit0:00AM spelling, never12AM.
  const match = /^(\d|1[0-2]):([0-5]\d) (AM|PM)$/u.exec(value);
  if (!match) return;
  const hour = Number(match[1]), minute = Number(match[2]);
  if (match[3] === "AM") return hour < 12 ? hour * 60 + minute : undefined;
  return hour >= 1 && hour <= 12 ? (hour === 12 ? 12 : hour + 12) * 60 + minute : undefined;
}
function configuredDay(value: unknown) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?$/u.test(value)) return;
  return day(value.slice(0, 10), "ISO");
}
function jsonContentType(value: string) { return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-?8))?$/iu.test(value); }

/** Only controller-observed documents and actual anonymous init responses can
 * create this ephemeral scope. No persisted/model-supplied metadata is trusted. */
export function createEzLinksPublicReadPolicy({ now = Date.now }: { now?: () => number } = {}) {
  let document: { origin: string; token: EzLinksDocumentToken; observedAt: number } | undefined;
  let init: { sponsorId: number; courses: Set<number>; players: Set<number>; holes: number; first: number; last: number;
    start: number; end: number; observedAt: number } | undefined;
  return {
    handles: isEzLinksProviderUrl,
    observeDocument(value: string | URL, status: number): EzLinksDocumentToken | undefined {
      document = undefined; init = undefined;
      const url = publicDocument(value), observedAt = now();
      if (!url || status !== 200 || !Number.isFinite(observedAt)) return;
      const token = Object.freeze({ [documentTokenBrand]: true as const });
      document = { origin: url.origin, token, observedAt };
      return token;
    },
    currentDocument() { return document?.token; },
    observeResponse(value: string | URL, method: string, status: number, contentType: string, body: unknown, token: EzLinksDocumentToken | undefined) {
      if (!document || token !== document.token) return false;
      let url: URL;
      try { url = new URL(String(value)); } catch { return false; }
      if (url.origin !== document.origin || url.pathname !== "/api/search/init") return false;
      init = undefined;
      if (url.search || url.hash || url.username || url.password) return false;
      const observedAt = now();
      if (method !== "GET" || status !== 200 || !jsonContentType(contentType) || !Number.isFinite(observedAt) || observedAt < document.observedAt) return false;
      try {
        if (typeof body === "string") {
          if (Buffer.byteLength(body) > 600_000) return false;
          body = JSON.parse(body);
        } else if (Buffer.byteLength(JSON.stringify(body)) > 600_000) return false;
      } catch { return false; }
      if (!object(body) || typeof body.MasterSponsorID !== "string" || !/^[1-9]\d{0,9}$/u.test(body.MasterSponsorID) ||
          !Array.isArray(body.Courses) || !body.Courses.length || body.Courses.length > 40 ||
          body.Courses.some(row => !object(row) || !positiveId(row.CourseID)) ||
          typeof body.AllCourseIDs !== "string" || !/^[1-9]\d{0,9}(?:,[1-9]\d{0,9})*$/u.test(body.AllCourseIDs) ||
          !Array.isArray(body.NumPlayersList) || !body.NumPlayersList.length || body.NumPlayersList.length > 4 ||
          body.NumPlayersList.some(value => typeof value !== "string" || !/^[1-4]$/u.test(value)) ||
          !Array.isArray(body.HolesList) || !body.HolesList.length || body.HolesList.length > 3 ||
          body.HolesList.some(value => typeof value !== "string" || !["Any", "18", "9"].includes(value))) return false;
      const courses = new Set((body.Courses as Array<{ CourseID: number }>).map(row => row.CourseID));
      const declared = body.AllCourseIDs.split(",").map(Number), players = new Set((body.NumPlayersList as string[]).map(Number));
      const first = configuredDay(body.SearchMinDate), last = configuredDay(body.SearchMaxDate);
      const start = configuredClock(body.StartTimeSet), end = configuredClock(body.EndTimeSet);
      if (courses.size !== body.Courses.length || new Set(declared).size !== declared.length || declared.length !== courses.size ||
          !declared.every(id => courses.has(id)) || players.size !== body.NumPlayersList.length ||
          new Set(body.HolesList).size !== body.HolesList.length || first === undefined || last === undefined ||
          last < first || last - first > 366 * 86_400_000 || start === undefined || end === undefined || end <= start) return false;
      init = { sponsorId: Number(body.MasterSponsorID), courses, players, holes: body.HolesList.length, first, last, start, end, observedAt };
      return true;
    },
    /** Proves only these two POST bodies; callers must independently enforce
     * POST, URL/SSRF policy, credentials:omit, leases, limits and response proof. */
    allows(url: URL, headers: Headers, body: string) {
      const at = now();
      if (!document || !init || !Number.isFinite(at) || at < init.observedAt || at - init.observedAt > freshMs ||
          url.origin !== document.origin || url.username || url.password || url.search || url.hash ||
          !["/api/search/gsahs", "/api/search/search"].includes(url.pathname) || !isSafeRecipeUrl(url.href) ||
          headers.get("origin") !== document.origin || [...headers.keys()].some(key => /authorization|cookie|token|api.?key|secret|credential|next-action|csrf|session/iu.test(key)) ||
          !jsonContentType(headers.get("content-type") ?? "") || typeof body !== "string" || Buffer.byteLength(body) > 2_048) return false;
      let value: unknown;
      try { value = JSON.parse(body); } catch { return false; }
      if (!object(value)) return false;
      const keys = Object.keys(value);
      if ((body.match(/"[^"\\]*"\s*:/gu) ?? []).length !== keys.length) return false;
      if (url.pathname === "/api/search/gsahs") return keys.length === 1 && keys[0] === "sponsorId" && positiveId(value.sponsorId) && value.sponsorId === init.sponsorId;
      if (keys.length !== 7 || !keys.every(key => /^p0[1-7]$/u.test(key)) || value.p07 !== false ||
          !Array.isArray(value.p01) || !value.p01.length || value.p01.length > init.courses.size ||
          value.p01.some(id => !positiveId(id) || !init!.courses.has(id)) || new Set(value.p01).size !== value.p01.length ||
          !Number.isInteger(value.p05) || Number(value.p05) < 0 || Number(value.p05) >= init.holes ||
          !Number.isInteger(value.p06) || !init.players.has(Number(value.p06))) return false;
      const date = day(value.p02, "US"), start = serializedClock(value.p03), end = serializedClock(value.p04);
      return date !== undefined && date >= init.first && date <= init.last && start !== undefined && end !== undefined &&
        start >= init.start && end <= init.end && end > start;
    },
  };
}
