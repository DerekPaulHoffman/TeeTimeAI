import { getKnownProviderFamilyForHostname, normalizeProviderFamilyKey } from "@/lib/automation/provider-capabilities";

/** Share a known provider's mutex with its established adapter. The model's
 * descriptive family label must never select the request-concurrency key. */
export function requestFamilyForUrl(value: string) {
  const hostname = new URL(value).hostname;
  return getKnownProviderFamilyForHostname(hostname) ?? normalizeProviderFamilyKey(hostname);
}
