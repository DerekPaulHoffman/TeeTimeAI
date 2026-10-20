import { getKnownProviderFamilyForHostname, normalizeProviderFamilyKey } from "@/lib/automation/provider-capabilities";

/** Share a known provider's mutex with its established adapter. The model's
 * descriptive family label must never select the request-concurrency key. */
export function requestFamilyForUrl(value: string) {
  const hostname = new URL(value).hostname;
  if (hostname === "clients.uschedule.com") return normalizeProviderFamilyKey("USCHEDULE");
  if (hostname === "booking.lightspeed.app") return hostname;
  return getKnownProviderFamilyForHostname(hostname) ?? normalizeProviderFamilyKey(hostname);
}
