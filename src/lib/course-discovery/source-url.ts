import { isSafeRecipeUrl } from "./recipe";

/** Discovery tries HTTPS for a public HTTP identity without claiming a redirect
 * was observed. Stored identity and its source fingerprint keep the raw URL. */
export function normalizeDiscoverySourceUrl(value: string): string;
export function normalizeDiscoverySourceUrl(value: null): null;
export function normalizeDiscoverySourceUrl(value: string | null): string | null;
export function normalizeDiscoverySourceUrl(value: string | null): string | null {
  if (value === null || !/^http:\/\//iu.test(value) || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return value;
  const authority = /^http:\/\/([^/?#]+)/iu.exec(value)?.[1];
  if (!authority || /[:@]/u.test(authority)) return value;
  const https = `https:${value.slice(5)}`;
  // An invalid source stays invalid; never drop it or guess another address.
  return isSafeRecipeUrl(https) ? https : value;
}
