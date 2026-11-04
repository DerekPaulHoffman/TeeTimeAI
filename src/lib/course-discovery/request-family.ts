import { getKnownProviderFamilyForHostname, normalizeProviderFamilyKey } from "@/lib/automation/provider-capabilities";

/** Share a known provider's mutex with its established adapter. The model's
 * descriptive family label must never select the request-concurrency key. */
export function requestFamilyForUrl(value: string) {
  const hostname = new URL(value).hostname;
  if (hostname === "api.youcanbook.me" || /^[a-z][a-z0-9-]{0,61}[a-z0-9]\.youcanbook\.me$/u.test(hostname)) return normalizeProviderFamilyKey("YOUCANBOOKME");
  if (hostname === "cdn.skedda.com" || /^[a-z][a-z0-9-]{0,62}\.skedda\.com$/u.test(hostname)) return normalizeProviderFamilyKey("SKEDDA");
  if (/^[a-z][a-z0-9-]{0,62}\.(?:golfbook\.in|golfbooking\.us)$/u.test(hostname)) return normalizeProviderFamilyKey("GOLFBOOK");
  if (hostname === "booking.fiveirongolf.com" || hostname === "api.booking.fiveirongolf.com") return normalizeProviderFamilyKey("FIVE_IRON");
  if (hostname === "clients.uschedule.com" || hostname === "iframe.uschedule.com") return normalizeProviderFamilyKey("USCHEDULE");
  if (hostname === "booking.lightspeed.app") return hostname;
  return getKnownProviderFamilyForHostname(hostname) ?? normalizeProviderFamilyKey(hostname);
}
