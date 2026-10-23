import { z } from "zod";

/** Observed 2026-10-20 in Mindbody's public services client:
 * /book/_next/static/chunks/5929-4a8e627162b8fbfe.js
 * SHA256 d7857e7ce0bac662fcfb106ad3582f141dfeb46b80b2e01d05d4fe5ad4dbe5a6.
 * The callsites resolve displayed-service prices, next-available labels, and
 * decode the public service ID and read routing flags before navigating to
 * the scheduling page.
 * These are server-action IDs, not credentials. Unknown/replaced IDs remain
 * denied; a matching JSON body alone never authorizes another server action.
 */
export const MINDBODY_PUBLIC_READ_ACTIONS = {
  servicePrices: "93b7c06aff1ef5e4ca3aee4626d1c89dc5886ba7",
  nextAvailable: "8625182d2131442b14ab39683c3a8865e99d2153",
  decodeServiceId: "1578d5a4b7778ff4f4c22f5dc8974cbab3d46e6f",
  serviceRouting: "10a3a84cc7c391c1812dd0672341ca5c5a4d2a58",
} as const;

const publicId = z.string().regex(/^[1-9]\d{0,9}$/u);
const serviceId = z.string().regex(/^asrv_[A-Za-z0-9]{8,64}$/u);
const timeZone = z.string().min(3).max(80).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
});
const serviceIds = z.array(serviceId).min(1).max(40).refine(values => new Set(values).size === values.length);
const priceArguments = z.tuple([z.object({ businessId: publicId, locationId: publicId, locationTimezone: timeZone, serviceIds }).strict()]);
const nextAvailableArguments = z.tuple([z.object({ businessId: publicId, locationId: publicId, locationTimezone: timeZone,
  serviceIds, includedStaffIds: z.tuple([]) }).strict()]);
const decodeArguments = z.tuple([serviceId]);
const routingArguments = z.tuple([z.object({ businessId: publicId, locationId: publicId, appointmentServiceId: publicId,
  includedStaffIds: z.tuple([]), preview: z.literal("view"), widgetId: z.string().regex(/^[a-f0-9]{11}$/u), locale: z.literal("en") }).strict()]);
function exactObjectArgumentKeys(value: unknown, keys: string[]) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object" || Array.isArray(value[0])) return false;
  const actual = Object.keys(value[0]);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

function widgetPath(url: URL) {
  return url.protocol === "https:" && url.hostname === "go.mindbodyonline.com" && !url.username && !url.password && !url.port &&
    !url.search && !url.hash && /^\/book\/widgets\/appointments\/view\/([a-f0-9]{11})\/services$/u.test(url.pathname);
}

/** A signed-out request from this exact public widget page to its own route. */
export function isMindbodyPublicReadPost(url: URL, headers: Headers, body: string) {
  if (!widgetPath(url) || Buffer.byteLength(body) > 16_384 ||
      !/^text\/plain(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
      headers.get("origin") !== url.origin ||
      [...headers.keys()].some(key => /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/iu.test(key))) return false;
  let referer: URL;
  try { referer = new URL(headers.get("referer") ?? ""); } catch { return false; }
  if (!widgetPath(referer) || referer.href !== url.href) return false;
  let argumentsValue: unknown;
  try { argumentsValue = JSON.parse(body); } catch { return false; }
  switch (headers.get("next-action")) {
    case MINDBODY_PUBLIC_READ_ACTIONS.servicePrices: return exactObjectArgumentKeys(argumentsValue,
      ["businessId", "locationId", "locationTimezone", "serviceIds"]) && priceArguments.safeParse(argumentsValue).success;
    case MINDBODY_PUBLIC_READ_ACTIONS.nextAvailable: return exactObjectArgumentKeys(argumentsValue,
      ["businessId", "locationId", "locationTimezone", "serviceIds", "includedStaffIds"]) && nextAvailableArguments.safeParse(argumentsValue).success;
    case MINDBODY_PUBLIC_READ_ACTIONS.decodeServiceId: return decodeArguments.safeParse(argumentsValue).success;
    case MINDBODY_PUBLIC_READ_ACTIONS.serviceRouting: {
      const parsed = routingArguments.safeParse(argumentsValue);
      return exactObjectArgumentKeys(argumentsValue, ["businessId", "locationId", "appointmentServiceId", "includedStaffIds", "preview", "widgetId", "locale"]) &&
        parsed.success && parsed.data[0].widgetId === url.pathname.split("/")[5];
    }
    default: return false;
  }
}

/** Only copy action routing metadata after the complete public-read contract
 * passes. Callers must reject false even for native browser continuation. */
export function addVerifiedMindbodyReadHeaders(url: URL, method: string, original: Record<string, string>, headers: Headers, body: string) {
  if (original["next-action"] === undefined) return true;
  const proposed = new Headers(headers);
  proposed.set("next-action", original["next-action"]);
  proposed.set("referer", original.referer ?? "");
  if (method !== "POST" || !isMindbodyPublicReadPost(url, proposed, body)) return false;
  headers.set("next-action", proposed.get("next-action")!);
  headers.set("referer", proposed.get("referer")!);
  return true;
}

// Observed 2026-10-23 before transmission: the public /classic/ws entry
// automatically submits wsLaunch to /classic/home. This only displays the
// public site; it is not permission for other classic forms or availability.
const classicBootstrapFields = ["tg", "vt", "lvl", "stype", "qParam", "view", "trn", "page", "catid", "prodid", "prodGroupId", "date", "classid",
  "sSU", "optForwardingLink", "singleUseToken", "oAuthToken", "launchGUID", "launchUID", "launchPWDChange", "launchPWDChangeKey", "launchLostPWD",
  "launchResetPWD", "launchBizModeLogin", "launchBizModeLoginWithRedirectLink", "key", "studioId", "consumerModeRedirect", "extLink", "giftCardID"] as const;

/** Pure URL binding. Only a current, completed native document can attest it. */
export function mindbodyClassicPublicBootstrapSource(sourceUrl: string, targetUrl: string): { studioId: string } | null {
  try {
    const source = new URL(sourceUrl), target = new URL(targetUrl);
    if (source.protocol !== "https:" || source.hostname !== "clients.mindbodyonline.com" || source.username || source.password || source.port ||
        source.pathname !== "/classic/ws" || source.hash || target.href !== "https://clients.mindbodyonline.com/classic/home") return null;
    const parts = source.search.slice(1).split("&");
    // Require literal keys/values: percent aliases and duplicate keys cannot
    // borrow the public source's routing identity.
    if (parts.length !== 2 || !parts.every(part => /^(?:studioid=[1-9]\d{0,9}|stype=-9)$/u.test(part)) ||
        source.searchParams.getAll("studioid").length !== 1 || source.searchParams.getAll("stype").length !== 1) return null;
    return { studioId: source.searchParams.get("studioid")! };
  } catch { return null; }
}

function publicUsCalendarDate(value: string) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (!match) return false;
  const month = Number(match[1]), day = Number(match[2]), year = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Fixed anonymous display bootstrap, independently rechecked by the handler.
 * Source ownership is private native metadata, never Referer or a form claim. */
export function isMindbodyClassicPublicBootstrapPost(url: URL, headers: Headers, body: string, sourceUrl: string) {
  const source = mindbodyClassicPublicBootstrapSource(sourceUrl, url.href);
  if (!source || Buffer.byteLength(body) > 2048 || headers.get("origin") !== url.origin ||
      !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
      [...headers.keys()].some(key => /^(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|next-action)$/iu.test(key))) return false;
  const form = new URLSearchParams(body), keys = [...form.keys()];
  if (keys.length !== classicBootstrapFields.length || new Set(keys).size !== keys.length ||
      !keys.every(key => (classicBootstrapFields as readonly string[]).includes(key)) || form.toString() !== body) return false;
  for (const key of classicBootstrapFields) {
    const value = form.get(key);
    if (key === "studioId") { if (value !== source.studioId) return false; }
    else if (key === "stype") { if (value !== "-9") return false; }
    else if (key === "trn" || key === "classid") { if (value !== "0") return false; }
    else if (key === "date") { if (!value || !publicUsCalendarDate(value)) return false; }
    else if (value !== "") return false;
  }
  return true;
}
