export const DISCOVERY_SOURCE_STORAGE_KEY = "tee-time-spot:discovery-source";

export const discoverySources = [
  "DIRECT",
  "INTERNAL",
  "SEARCH_GOOGLE",
  "SEARCH_BING",
  "SEARCH_OTHER",
  "AI_CHATGPT",
  "AI_PERPLEXITY",
  "AI_CLAUDE",
  "AI_COPILOT",
  "AI_GEMINI",
  "REFERRAL_OTHER"
] as const;

export type DiscoverySource = (typeof discoverySources)[number];

/**
 * Converts a referrer into a fixed aggregate label. The full URL, path, and
 * query are deliberately discarded and must never be persisted.
 */
export function classifyDiscoverySource(
  referrer: string | null | undefined,
  currentOrigin: string
): DiscoverySource {
  if (!referrer) {
    return "DIRECT";
  }

  try {
    const url = new URL(referrer);
    if (url.origin === currentOrigin) {
      return "INTERNAL";
    }

    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    if (
      hostname === "chatgpt.com" ||
      hostname.endsWith(".chatgpt.com") ||
      hostname === "chat.openai.com"
    ) {
      return "AI_CHATGPT";
    }
    if (hostname === "perplexity.ai" || hostname.endsWith(".perplexity.ai")) {
      return "AI_PERPLEXITY";
    }
    if (hostname === "claude.ai" || hostname.endsWith(".claude.ai")) {
      return "AI_CLAUDE";
    }
    if (hostname === "copilot.microsoft.com" || hostname.endsWith(".copilot.microsoft.com")) {
      return "AI_COPILOT";
    }
    if (hostname === "gemini.google.com") {
      return "AI_GEMINI";
    }
    if (hostname === "bing.com" || hostname.endsWith(".bing.com")) {
      return url.pathname.startsWith("/chat") ? "AI_COPILOT" : "SEARCH_BING";
    }
    if (/^google\.[a-z.]+$/.test(hostname) || hostname.includes(".google.")) {
      return "SEARCH_GOOGLE";
    }
    if (
      hostname === "duckduckgo.com" ||
      hostname.endsWith(".duckduckgo.com") ||
      hostname === "search.yahoo.com"
    ) {
      return "SEARCH_OTHER";
    }

    return "REFERRAL_OTHER";
  } catch {
    return "DIRECT";
  }
}

/**
 * Remembers only the aggregate label for the current tab. This is attribution,
 * not identity: no random value, visitor id, or session id is created.
 */
export function detectDiscoverySource(): DiscoverySource {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return "DIRECT";
  }

  try {
    const stored = window.sessionStorage.getItem(DISCOVERY_SOURCE_STORAGE_KEY);
    if (isDiscoverySource(stored)) {
      return stored;
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const source = classifyDiscoverySource(document.referrer, window.location.origin);

  try {
    window.sessionStorage.setItem(DISCOVERY_SOURCE_STORAGE_KEY, source);
  } catch {
    // The aggregate label can still be sent for this page without storage.
  }

  return source;
}

function isDiscoverySource(value: string | null): value is DiscoverySource {
  return discoverySources.includes(value as DiscoverySource);
}
