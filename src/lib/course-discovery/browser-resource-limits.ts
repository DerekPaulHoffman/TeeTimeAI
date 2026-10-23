/** Decoded public resources are bounded independently from request counts and
 * the native tunnel's encrypted-byte budget. Data/documents stay small. */
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
export function publicBrowserResponseLimit(resourceType: string) {
  return resourceType === "script" ? 16_000_000 : resourceType === "stylesheet" ? 6_000_000 : 2_000_000;
}
