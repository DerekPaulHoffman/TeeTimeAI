/** Decoded public resources are bounded independently from request counts and
 * the native tunnel's encrypted-byte budget. Data/documents stay small. */
export const PUBLIC_BROWSER_TOTAL_BYTES = 48_000_000;
export const PUBLIC_BROWSER_TUNNEL_BYTES = 24_000_000;
export function publicBrowserResponseLimit(resourceType: string) {
  return resourceType === "script" ? 16_000_000 : resourceType === "stylesheet" ? 6_000_000 : 2_000_000;
}
