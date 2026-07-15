export const WEBSITE_TRAFFIC_CLASS_STORAGE_KEY = "tee-time-spot:traffic-class";
export const WEBSITE_TRAFFIC_CLASS_HEADER = "x-tee-time-spot-traffic-class";

export const websiteTrafficClasses = [
  "UNCLASSIFIED",
  "PUBLIC",
  "AUTOMATION",
  "TEST"
] as const;

export type WebsiteTrafficClassValue = (typeof websiteTrafficClasses)[number];
export const syntheticWebsiteTrafficClasses = ["AUTOMATION", "TEST"] as const;

export function parseWebsiteTrafficClass(
  value: string | null | undefined
): WebsiteTrafficClassValue {
  return websiteTrafficClasses.includes(value as WebsiteTrafficClassValue)
    ? (value as WebsiteTrafficClassValue)
    : "UNCLASSIFIED";
}

export function isSyntheticWebsiteTrafficClass(
  value: WebsiteTrafficClassValue
) {
  return syntheticWebsiteTrafficClasses.includes(
    value as (typeof syntheticWebsiteTrafficClasses)[number]
  );
}

/**
 * Returns an aggregate traffic label only. It deliberately creates no visitor
 * or session identifier.
 */
export function detectWebsiteTrafficClass(): WebsiteTrafficClassValue {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "UNCLASSIFIED";
  }

  try {
    const marker = window.sessionStorage.getItem(WEBSITE_TRAFFIC_CLASS_STORAGE_KEY);
    if (marker === "AUTOMATION" || marker === "TEST") {
      return marker;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  return navigator.webdriver ? "AUTOMATION" : "PUBLIC";
}
