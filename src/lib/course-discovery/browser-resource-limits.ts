/** Decoded public resources are bounded independently from request counts and
 * the native tunnel's encrypted-byte budget. Ordinary data/documents stay small. */
export const PUBLIC_BROWSER_REQUEST_LIMIT = 192;
/** Fixed native appointment catalog/day transitions load their public script
 * and stylesheet set again. This separate protocol allocation never resets. */
export const MINDBODY_APPOINTMENT_REQUEST_LIMIT = 512;
export function assertPublicBrowserRequestBudget(count: number, limit: number) {
  if (![PUBLIC_BROWSER_REQUEST_LIMIT, MINDBODY_APPOINTMENT_REQUEST_LIMIT].includes(limit) ||
      !Number.isSafeInteger(count) || count < 0 || count >= limit) throw new Error("PUBLIC_READ_REQUEST_LIMIT");
}
export const PUBLIC_BROWSER_TOTAL_BYTES = 48_000_000;
export const PUBLIC_BROWSER_TUNNEL_BYTES = 24_000_000;
/** Private owned source navigation only. Never a model, recipe or CLI setting. */
export const SOURCE_ROUTING_RESPONSE_PROFILE = "SOURCE_ROUTING" as const;
export type PublicBrowserResponseProfile = typeof SOURCE_ROUTING_RESPONSE_PROFILE;
export function publicBrowserResponseLimit(resourceType: string, method = "GET", profile?: PublicBrowserResponseProfile) {
  if (profile !== undefined && profile !== SOURCE_ROUTING_RESPONSE_PROFILE) throw new Error("PUBLIC_READ_RESPONSE_PROFILE_INVALID");
  const sourceData = profile === SOURCE_ROUTING_RESPONSE_PROFILE && method === "GET" && ["xhr", "fetch"].includes(resourceType);
  return resourceType === "script" || sourceData ? 16_000_000 : resourceType === "stylesheet" ? 6_000_000 : 2_000_000;
}

/** Byte-only allowance for a privately admitted GET data read on a proven
 * current official document. This does not select SOURCE_ROUTING behavior in
 * the native router or authorize the URL, method, headers, or request. */
export function publicOfficialRenderResponseLimit(resourceType: string, method: string, admittedOfficialDocumentRead: boolean) {
  const dataGet = admittedOfficialDocumentRead === true && method === "GET" && ["xhr", "fetch"].includes(resourceType);
  return publicBrowserResponseLimit(resourceType, method, dataGet ? SOURCE_ROUTING_RESPONSE_PROFILE : undefined);
}
