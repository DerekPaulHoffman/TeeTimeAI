import { createHash } from "node:crypto";

import { isCpsMetadata } from "@/lib/adapters/cps";
import { isChelseaMetadata } from "@/lib/adapters/chelsea";
import { isChronogolfMetadata } from "@/lib/adapters/chronogolf";
import { isClubCaddieMetadata } from "@/lib/adapters/clubcaddie";
import { isForeupMetadata } from "@/lib/adapters/foreup";
import { isGolfBackMetadata } from "@/lib/adapters/golfback";
import { isGolfWithAccessMetadata } from "@/lib/adapters/golf-with-access";
import { isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { isTeesnapMetadata } from "@/lib/adapters/teesnap";
import { isWebTracMetadata } from "@/lib/adapters/webtrac";
import { isWhooshMetadata } from "@/lib/adapters/whoosh";
import { evaluateMonitoringGate } from "@/lib/automation/policy";

export const SOURCE_MISSING_PROVIDER_FAMILY = "SOURCE_MISSING" as const;
export const SOURCE_CONFLICT_PROVIDER_FAMILY = "SOURCE_CONFLICT" as const;

export const KNOWN_PROVIDER_FAMILIES = [
  "FOREUP",
  "TEEITUP",
  "CHRONOGOLF",
  "CPS",
  "CHELSEA",
  "TEESNAP",
  "GOLFBACK",
  "GOLF_WITH_ACCESS",
  "WEBTRAC",
  "EZLINKS",
  "GOLFNOW",
  "CLUB_CADDIE",
  "WHOOSH",
  "TENFORE"
] as const;

export type KnownProviderFamily = (typeof KNOWN_PROVIDER_FAMILIES)[number];

export type ExternalDetectedPlatform =
  | "UNKNOWN"
  | "FOREUP"
  | "GOLFNOW"
  | "TEEITUP"
  | "CHRONOGOLF"
  | "CLUB_CADDIE"
  | "CUSTOM";

export type CourseSupportFailureClass =
  | "MISSING_SOURCE"
  | "MISSING_METADATA"
  | "UNSUPPORTED_FAMILY"
  | "AUTH"
  | "RATE_LIMIT"
  | "CHALLENGE"
  | "NOT_FOUND"
  | "HTTP_5XX"
  | "TIMEOUT"
  | "NETWORK"
  | "SCHEMA"
  | "UNKNOWN";

export type ProviderOperation =
  | "DISCOVERY"
  | "METADATA"
  | "AVAILABILITY"
  | "BOOKING_WINDOW"
  | "UNKNOWN";

export type ConsumerDisposition =
  | "MATCH_AVAILABLE"
  | "CHECKED_NO_MATCH"
  | "BOOKING_NOT_OPEN"
  | "DIRECT_SITE_ONLY"
  | "PHONE_OR_WALK_IN"
  | "ACCOUNT_REQUIRED"
  | "POLICY_BLOCKED"
  | "CAPTCHA_OR_QUEUE"
  | "PRIVATE_OR_INVALID"
  | "SOURCE_UNVERIFIED"
  | "RETRYING"
  | "ENGINEERING";

export type ProviderCourseInput = {
  detectedPlatform?: string | null;
  providerFamilyKey?: string | null;
  detectedBookingUrl?: string | null;
  website?: string | null;
  bookingMetadata?: unknown;
};

type ProviderCapability = {
  family: KnownProviderFamily;
  detectedPlatform: ExternalDetectedPlatform;
  supportsAutomation: boolean;
  matchesHostname: (hostname: string) => boolean;
  validatesMetadata?: (metadata: unknown) => boolean;
};

const matchesDomain = (hostname: string, domain: string) =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export const PROVIDER_CAPABILITIES = {
  FOREUP: {
    family: "FOREUP",
    detectedPlatform: "FOREUP",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "foreupsoftware.com"),
    validatesMetadata: isForeupMetadata
  },
  TEEITUP: {
    family: "TEEITUP",
    detectedPlatform: "TEEITUP",
    supportsAutomation: true,
    matchesHostname: (hostname) =>
      matchesDomain(hostname, "teeitup.golf") ||
      matchesDomain(hostname, "teeitup.com") ||
      hostname === "phx-api-be-east-1b.kenna.io",
    validatesMetadata: isTeeItUpMetadata
  },
  CHRONOGOLF: {
    family: "CHRONOGOLF",
    detectedPlatform: "CHRONOGOLF",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "chronogolf.com"),
    validatesMetadata: isChronogolfMetadata
  },
  CPS: {
    family: "CPS",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "cps.golf"),
    validatesMetadata: isCpsMetadata
  },
  CHELSEA: {
    family: "CHELSEA",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) =>
      matchesDomain(hostname, "chelseareservations.com"),
    validatesMetadata: isChelseaMetadata
  },
  TEESNAP: {
    family: "TEESNAP",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "teesnap.net"),
    validatesMetadata: isTeesnapMetadata
  },
  GOLFBACK: {
    family: "GOLFBACK",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "golfback.com"),
    validatesMetadata: isGolfBackMetadata
  },
  GOLF_WITH_ACCESS: {
    family: "GOLF_WITH_ACCESS",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "golfwithaccess.com"),
    validatesMetadata: isGolfWithAccessMetadata
  },
  WEBTRAC: {
    family: "WEBTRAC",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "navyaims.com"),
    validatesMetadata: isWebTracMetadata
  },
  EZLINKS: {
    family: "EZLINKS",
    detectedPlatform: "CUSTOM",
    supportsAutomation: false,
    matchesHostname: (hostname) => matchesDomain(hostname, "ezlinksgolf.com")
  },
  GOLFNOW: {
    family: "GOLFNOW",
    detectedPlatform: "GOLFNOW",
    supportsAutomation: false,
    matchesHostname: (hostname) => matchesDomain(hostname, "golfnow.com")
  },
  CLUB_CADDIE: {
    family: "CLUB_CADDIE",
    detectedPlatform: "CLUB_CADDIE",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "clubcaddie.com"),
    validatesMetadata: isClubCaddieMetadata
  },
  WHOOSH: {
    family: "WHOOSH",
    detectedPlatform: "CUSTOM",
    supportsAutomation: true,
    matchesHostname: (hostname) => matchesDomain(hostname, "whoosh.io"),
    validatesMetadata: isWhooshMetadata
  },
  TENFORE: {
    family: "TENFORE",
    detectedPlatform: "CUSTOM",
    supportsAutomation: false,
    matchesHostname: (hostname) => matchesDomain(hostname, "tenfore.golf")
  }
} satisfies Record<KnownProviderFamily, ProviderCapability>;

export type ProviderCapabilityResolution = {
  providerFamilyKey: string;
  capability: ProviderCapability | null;
  detectedPlatform: ExternalDetectedPlatform;
  metadataReady: boolean;
  isRunnable: boolean;
  evidenceConflict: boolean;
};

const PROVIDER_DISCOVERY_IDENTITY_MIN_CONFIDENCE = 0.4;

const knownProviderFamilySet = new Set<string>(KNOWN_PROVIDER_FAMILIES);
const externalDetectedPlatforms = new Set<string>([
  "UNKNOWN",
  "FOREUP",
  "GOLFNOW",
  "TEEITUP",
  "CHRONOGOLF",
  "CLUB_CADDIE",
  "CUSTOM"
]);
const failureClasses = new Set<string>([
  "MISSING_SOURCE",
  "MISSING_METADATA",
  "UNSUPPORTED_FAMILY",
  "AUTH",
  "RATE_LIMIT",
  "CHALLENGE",
  "NOT_FOUND",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK",
  "SCHEMA",
  "UNKNOWN"
]);

const platformFamilies: Partial<Record<ExternalDetectedPlatform, KnownProviderFamily>> = {
  FOREUP: "FOREUP",
  GOLFNOW: "GOLFNOW",
  TEEITUP: "TEEITUP",
  CHRONOGOLF: "CHRONOGOLF",
  CLUB_CADDIE: "CLUB_CADDIE"
};

const metadataProviderFamilies = new Map<string, KnownProviderFamily>([
  ["CPS", "CPS"],
  ["CHELSEA", "CHELSEA"],
  ["TEESNAP", "TEESNAP"],
  ["GOLFBACK", "GOLFBACK"],
  ["GOLF_WITH_ACCESS", "GOLF_WITH_ACCESS"],
  ["WEBTRAC", "WEBTRAC"],
  ["CLUB_CADDIE", "CLUB_CADDIE"],
  ["WHOOSH", "WHOOSH"]
]);

export function resolveProviderCapability(
  input: ProviderCourseInput
): ProviderCapabilityResolution {
  const metadataFamily = getMetadataProviderFamily(input.bookingMetadata);
  const platform = normalizeExternalDetectedPlatform(input.detectedPlatform);
  const platformFamily = platformFamilies[platform];
  const bookingHostname = getSafePublicHostname(input.detectedBookingUrl);
  const websiteHostname = getSafePublicHostname(input.website);
  const bookingFamily = bookingHostname
    ? getKnownProviderFamilyForHostname(bookingHostname)
    : null;
  const websiteFamily = websiteHostname
    ? getKnownProviderFamilyForHostname(websiteHostname)
    : null;
  const persistedFamily = normalizeProviderFamilyKey(input.providerFamilyKey);
  const persistedKnownFamily = getKnownProviderCapability(persistedFamily)
    ? persistedFamily
    : null;
  const evidenceFamilies = new Set(
    [
      metadataFamily,
      platformFamily,
      bookingFamily,
      websiteFamily,
      persistedKnownFamily
    ].filter((family): family is string => Boolean(family))
  );
  const evidenceConflict = evidenceFamilies.size > 1;

  const providerFamilyKey = evidenceConflict
    ? SOURCE_CONFLICT_PROVIDER_FAMILY
    : metadataFamily ??
      platformFamily ??
      bookingFamily ??
      bookingHostname ??
      (persistedFamily !== SOURCE_MISSING_PROVIDER_FAMILY ? persistedFamily : null) ??
      websiteFamily ??
      websiteHostname ??
      SOURCE_MISSING_PROVIDER_FAMILY;
  const capability = getKnownProviderCapability(providerFamilyKey);
  const metadataHasBookingBaseUrl = Boolean(
    isPlainMetadata(input.bookingMetadata) &&
      typeof input.bookingMetadata.bookingBaseUrl === "string"
  );
  const metadataReady = Boolean(
    capability?.supportsAutomation &&
      validatesSafeProviderMetadata(
        providerFamilyKey,
        capability,
        input.bookingMetadata
      ) &&
      (!metadataHasBookingBaseUrl ||
        !bookingFamily ||
        (input.detectedBookingUrl &&
          isProviderPublicBookingLandingUrl(input.detectedBookingUrl)))
  );

  return {
    providerFamilyKey,
    capability,
    detectedPlatform: evidenceConflict
      ? platform
      : capability?.detectedPlatform ?? platform,
    metadataReady,
    isRunnable: Boolean(
      !evidenceConflict && capability?.supportsAutomation && metadataReady
    ),
    evidenceConflict
  };
}

export function resolveProviderDiscoveryIdentity(input: {
  detectedPlatform?: string | null;
  bookingUrl?: string | null;
  apiMetadata?: unknown;
  confidence: number;
}): ProviderCapabilityResolution | null {
  if (input.confidence < PROVIDER_DISCOVERY_IDENTITY_MIN_CONFIDENCE) {
    return null;
  }

  const bookingHostname = getSafePublicHostname(input.bookingUrl);
  const bookingFamily = bookingHostname
    ? getKnownProviderFamilyForHostname(bookingHostname)
    : null;
  const metadataFamily = getMetadataProviderFamily(input.apiMetadata);
  if (!bookingFamily && !metadataFamily) {
    return null;
  }
  if (bookingFamily && metadataFamily && bookingFamily !== metadataFamily) {
    return null;
  }

  const resolution = resolveProviderCapability({
    detectedPlatform: input.detectedPlatform,
    detectedBookingUrl: input.bookingUrl,
    bookingMetadata: input.apiMetadata
  });
  const corroboratedFamily = metadataFamily ?? bookingFamily;
  if (
    !corroboratedFamily ||
    !resolution.capability ||
    resolution.evidenceConflict ||
    resolution.providerFamilyKey !== corroboratedFamily
  ) {
    return null;
  }

  return resolution;
}

export function getProviderReadinessFailure(
  resolution: ProviderCapabilityResolution
): CourseSupportFailureClass | null {
  if (resolution.isRunnable) {
    return null;
  }
  if (resolution.providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY) {
    return "MISSING_SOURCE";
  }
  if (resolution.providerFamilyKey === SOURCE_CONFLICT_PROVIDER_FAMILY) {
    return "MISSING_METADATA";
  }
  if (resolution.capability?.supportsAutomation) {
    return "MISSING_METADATA";
  }
  return "UNSUPPORTED_FAMILY";
}

export function isProviderMetadataReady(
  providerFamilyKey: string,
  metadata: unknown
) {
  const capability = getKnownProviderCapability(providerFamilyKey);
  return Boolean(
    capability?.supportsAutomation &&
      validatesSafeProviderMetadata(providerFamilyKey, capability, metadata)
  );
}

function validatesSafeProviderMetadata(
  providerFamilyKey: string,
  capability: ProviderCapability | null,
  metadata: unknown
) {
  if (!capability?.validatesMetadata?.(metadata) || !isPlainMetadata(metadata)) {
    return false;
  }
  const bookingBaseUrl = metadata.bookingBaseUrl;
  if (bookingBaseUrl === undefined) {
    // The adapter schema owns required-field validation. Every production
    // runnable metadata schema requires bookingBaseUrl; this branch keeps
    // isolated callers that replace the schema validator from duplicating it.
    return true;
  }
  if (typeof bookingBaseUrl !== "string") {
    return false;
  }
  try {
    const url = new URL(bookingBaseUrl);
    return Boolean(
      getKnownProviderFamilyForHostname(url.hostname) === providerFamilyKey &&
        isProviderPublicBookingLandingUrl(url)
    );
  } catch {
    return false;
  }
}

function isPlainMetadata(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeProviderFamilyKey(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return SOURCE_MISSING_PROVIDER_FAMILY;
  }

  const upper = trimmed.toUpperCase();
  if (
    upper === SOURCE_MISSING_PROVIDER_FAMILY ||
    upper === SOURCE_CONFLICT_PROVIDER_FAMILY ||
    knownProviderFamilySet.has(upper)
  ) {
    return upper;
  }

  const hostname = trimmed.toLowerCase().replace(/\.$/u, "");
  return isSafeHostname(hostname) ? hostname : SOURCE_MISSING_PROVIDER_FAMILY;
}

export function getKnownProviderFamilyForHostname(hostname: string) {
  const normalized = normalizeProviderFamilyKey(hostname);
  if (normalized === SOURCE_MISSING_PROVIDER_FAMILY) {
    return null;
  }

  return (
    KNOWN_PROVIDER_FAMILIES.find((family) =>
      PROVIDER_CAPABILITIES[family].matchesHostname(normalized)
    ) ?? null
  );
}

const PROVIDER_INFRASTRUCTURE_TOKENS = new Set([
  "admin",
  "api",
  "asset",
  "assets",
  "auth",
  "cdn",
  "config",
  "configuration",
  "developer",
  "dev",
  "doc",
  "docs",
  "graphql",
  "geojson",
  "json",
  "jsonp",
  "openapi",
  "qa",
  "rest",
  "sandbox",
  "stage",
  "staging",
  "static",
  "status",
  "swagger",
  "test",
  "xml",
  "yaml",
  "yml"
]);

export function isProviderTrackingQueryParameter(key: string) {
  return /^(?:utm_(?:campaign|content|id|medium|source|term)|_gl|dclid|fbclid|gclid|mc_cid|mc_eid|msclkid)$/iu.test(
    key
  );
}

export function isProviderInfrastructureUrl(value: URL | string) {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return true;
  }

  const hostnameTokens = url.hostname
    .toLocaleLowerCase("en-US")
    .split(".");
  const pathname = safeDecodeProviderSurfacePart(url.pathname);
  const pathTokens = pathname
    .split("/")
    .filter(Boolean)
    .flatMap(tokenizeProviderSurfacePart);
  const hash = safeDecodeProviderSurfacePart(url.hash);
  const hashTokens = hash
    .split("/")
    .filter(Boolean)
    .flatMap(tokenizeProviderSurfacePart);
  return Boolean(
    hostnameTokens.some(isProviderInfrastructureToken) ||
      pathTokens.some(isProviderInfrastructureToken) ||
      hashTokens.some(isProviderInfrastructureToken) ||
      /\.(?:geojson|jsonp?|m?js|map|xml|ya?ml)$/iu.test(pathname) ||
      /\.(?:geojson|jsonp?|m?js|map|xml|ya?ml)(?:$|[?#])/iu.test(hash) ||
      [...url.searchParams.keys()].some((key) =>
        /^(?:(?:api|endpoint|route|schema|spec)(?:path|url|uri|version)?|(?:json|jsonp)?callback|jsonp|path|url|uri)$/u.test(
          safeDecodeProviderSurfacePart(key)
            .normalize("NFKC")
            .toLocaleLowerCase("en-US")
            .replace(/[^a-z0-9]/gu, "")
        )
      ) ||
      [...url.searchParams.entries()].some(
        ([key, entry]) =>
          !isProviderTrackingQueryParameter(key) &&
          /^(?:(?:application|text)\/(?:(?:[a-z0-9.+-]+\+)?(?:json|xml|ya?ml|ndjson|geojson)|x-(?:json|xml|ya?ml|ndjson|geojson)|json-seq)|(?:x-)?(?:jsonp?|xml|ya?ml|ndjson|geojson|pjson|jsonl|jsonseq))(?:\s*;.*)?$/iu.test(
            safeDecodeProviderSurfacePart(entry).trim()
          )
      )
  );
}

export function isProviderPublicBookingLandingUrl(value: URL | string) {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port
  ) {
    return false;
  }
  const providerFamily = getKnownProviderFamilyForHostname(url.hostname);
  if (!providerFamily || isProviderTransactionOrAccessUrl(url)) {
    return false;
  }
  if (!hasAllowedProviderBookingLandingQuery(url, providerFamily)) {
    return false;
  }

  const pathname = safeDecodeProviderSurfacePart(url.pathname);
  if (isExactClubCaddiePublicViewUrl(url, providerFamily, pathname)) {
    return true;
  }
  if (isProviderInfrastructureUrl(url)) {
    return false;
  }
  return isProviderFamilyPublicBookingLandingUrl(
    url,
    providerFamily,
    pathname
  );
}

export function getProviderPublicBookingLandingIdentity(
  value: URL | string
) {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
  if (!isProviderPublicBookingLandingUrl(url)) {
    return null;
  }
  const providerFamily = getKnownProviderFamilyForHostname(url.hostname);
  if (!providerFamily) {
    return null;
  }
  const hostname = url.hostname
    .toLocaleLowerCase("en-US")
    .replace(/^www\./u, "");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  switch (providerFamily) {
    case "CHELSEA":
    case "TEESNAP":
      return `${providerFamily}:${hostname}`;
    case "EZLINKS": {
      const scopedCourse = pathname.match(
        /^\/([a-z0-9][a-z0-9-]{0,127})\/(?:(?:public-)?(?:book(?:ing)?|tee-?times?)|search)$/iu
      )?.[1];
      return `${providerFamily}:${hostname}:${scopedCourse?.toLocaleLowerCase("en-US") ?? "root"}`;
    }
    case "FOREUP":
      return `${providerFamily}:${hostname}:${pathname}`;
    case "TEEITUP":
      return `${providerFamily}:${hostname}:${readProviderLandingQueryValue(url, "course") ?? "root"}`;
    case "CPS":
      return `${providerFamily}:${hostname}:${readProviderLandingQueryValue(url, "courseid") ?? "root"}`;
    case "GOLFBACK":
      return `${providerFamily}:${hostname}:${url.hash.toLocaleLowerCase("en-US")}`;
    case "WEBTRAC":
      return `${providerFamily}:${hostname}:${pathname}:${readProviderLandingQueryValue(url, "secondarycode")?.toLocaleLowerCase("en-US")}`;
    case "CLUB_CADDIE":
      return `${providerFamily}:${hostname}:${pathname.replace(/\/slots$/iu, "")}`;
    default:
      return `${providerFamily}:${hostname}:${pathname}:${url.hash.toLocaleLowerCase("en-US")}`;
  }
}

function readProviderLandingQueryValue(url: URL, expectedKey: string) {
  return [...url.searchParams.entries()].find(
    ([key]) => key.toLocaleLowerCase("en-US") === expectedKey
  )?.[1];
}

const PROVIDER_UNRELATED_HOST_LABELS = new Set([
  "about",
  "blog",
  "careers",
  "community",
  "contact",
  "corporate",
  "giftcard",
  "giftcards",
  "help",
  "investors",
  "jobs",
  "marketing",
  "merchandise",
  "news",
  "shop",
  "store",
  "support"
]);

function isProviderFamilyPublicBookingLandingUrl(
  url: URL,
  providerFamily: KnownProviderFamily,
  pathname: string
) {
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const isRoot = /^\/(?:index\.(?:html?|php))?\/?$/iu.test(pathname);

  switch (providerFamily) {
    case "FOREUP":
      return Boolean(
        /^(?:www\.)?foreupsoftware\.com$/u.test(hostname) &&
          /^\/index\.php\/booking\/[1-9]\d{0,9}(?:\/[1-9]\d{0,9})?\/?$/u.test(
            pathname
          ) &&
          (!url.hash || /^#\/?teetimes\/?$/iu.test(url.hash))
      );
    case "TEEITUP":
      return Boolean(
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:book|play)\.teeitup\.(?:golf|com)$/u.test(
          hostname
        ) &&
          (isRoot || /^\/(?:book(?:ing)?|tee-?times?)\/?$/iu.test(pathname)) &&
          !url.hash
      );
    case "CHRONOGOLF":
      return Boolean(
        /^(?:www\.)?chronogolf\.com$/u.test(hostname) &&
          /^\/club\/[a-z0-9][a-z0-9_-]{0,127}\/?$/iu.test(pathname) &&
          !url.hash
      );
    case "CPS":
      return Boolean(
        isSingleProviderTenantHostname(hostname, "cps.golf") &&
          hostname !== "sc.cps.golf" &&
          (isRoot ||
            /^\/onlineresweb(?:\/search-teetime)?\/?$/iu.test(pathname)) &&
          !url.hash
      );
    case "CHELSEA":
      return Boolean(
        isSingleProviderTenantHostname(hostname, "chelseareservations.com") &&
          (isRoot || /^\/gpinprocess\/?$/iu.test(pathname)) &&
          !url.hash &&
          hasOnlyProviderTrackingQuery(url)
      );
    case "TEESNAP":
      return Boolean(
        isSingleProviderTenantHostname(hostname, "teesnap.net") &&
          isRoot &&
          !url.hash
      );
    case "GOLFBACK":
      return Boolean(
        /^(?:www\.)?golfback\.com$/u.test(hostname) &&
          isRoot &&
          /^#\/course\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/iu.test(
            url.hash
          )
      );
    case "GOLF_WITH_ACCESS":
      return Boolean(
        hostname === "golfwithaccess.com" &&
          /^\/course\/[a-z0-9][a-z0-9-]{0,127}\/reserve-tee-time\/?$/iu.test(
            pathname
          ) &&
          !url.hash
      );
    case "WEBTRAC":
      return Boolean(
        (hostname === "navyaims.com" || hostname.endsWith(".navyaims.com")) &&
          /^\/(?:[^/]+\/)*web\/search\.html\/?$/iu.test(pathname) &&
          url.searchParams.get("module")?.toUpperCase() === "GR" &&
          url.searchParams.get("secondarycode") &&
          !url.hash
      );
    case "EZLINKS": {
      const legacySearchHash = /^#\/search\/?$/iu.test(url.hash);
      return Boolean(
        isSingleProviderTenantHostname(hostname, "ezlinksgolf.com") &&
          !hasUnrelatedProviderHostLabel(hostname, "ezlinksgolf.com") &&
          (isRoot ||
            /^\/(?:public-)?(?:book(?:ing)?|tee-?times?)\/?$/iu.test(pathname) ||
            /^\/[a-z0-9][a-z0-9-]{0,127}\/(?:(?:public-)?(?:book(?:ing)?|tee-?times?)|search)\/?$/iu.test(
              pathname
            )) &&
          (!url.hash || (isRoot && legacySearchHash))
      );
    }
    case "GOLFNOW":
      return Boolean(
        /^(?:www\.)?golfnow\.com$/u.test(hostname) &&
          (/^\/course\/[a-z0-9][a-z0-9-]{0,127}\/?$/iu.test(pathname) ||
            /^\/tee-times\/facility\/[a-z0-9][a-z0-9-]{0,127}(?:\/[1-9]\d{0,9})?(?:\/search)?\/?$/iu.test(
              pathname
            )) &&
          !url.hash
      );
    case "WHOOSH":
      return Boolean(
        hostname === "app.whoosh.io" &&
          /^\/patron\/club\/[a-z0-9][a-z0-9_-]{0,127}\/?$/iu.test(pathname) &&
          !url.hash
      );
    case "TENFORE":
      return Boolean(
        hostname === "fox.tenfore.golf" &&
          /^\/[a-z0-9][a-z0-9-]{0,127}\/?$/iu.test(pathname) &&
          hasOnlyProviderTrackingQuery(url) &&
          !url.hash
      );
    case "CLUB_CADDIE":
      return false;
  }
}

function isSingleProviderTenantHostname(hostname: string, domain: string) {
  const suffix = `.${domain}`;
  if (!hostname.endsWith(suffix)) {
    return false;
  }
  const tenant = hostname.slice(0, -suffix.length);
  return Boolean(tenant && !tenant.includes("."));
}

function hasUnrelatedProviderHostLabel(hostname: string, domain: string) {
  const label = hostname.slice(0, -(domain.length + 1));
  return tokenizeProviderSurfacePart(label).some((token) =>
    PROVIDER_UNRELATED_HOST_LABELS.has(token)
  );
}

function isExactClubCaddiePublicViewUrl(
  url: URL,
  providerFamily: KnownProviderFamily,
  pathname: string
) {
  if (
    providerFamily !== "CLUB_CADDIE" ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/^apimanager-cc\d{1,4}\.clubcaddie\.com$/iu.test(url.hostname)
  ) {
    return false;
  }
  const slug = pathname.match(
    /^\/webapi\/view\/([a-z0-9][a-z0-9_-]{0,127})(?:\/slots)?\/?$/iu
  )?.[1];
  return Boolean(
    slug &&
      !tokenizeProviderSurfacePart(slug).some(
        (token) =>
          isProviderInfrastructureToken(token) ||
          isProviderTransactionOrAccessToken(token)
      )
  );
}

const PROVIDER_TRANSACTION_OR_ACCESS_TOKENS = new Set([
  "account",
  "accounts",
  "captcha",
  "cart",
  "challenge",
  "checkout",
  "checkouts",
  "complete",
  "completed",
  "confirmation",
  "confirm",
  "commit",
  "completion",
  "done",
  "finalise",
  "finalize",
  "finish",
  "finished",
  "login",
  "logout",
  "member",
  "members",
  "mfa",
  "order",
  "orders",
  "password",
  "payment",
  "payments",
  "profile",
  "profiles",
  "purchase",
  "purchases",
  "queue",
  "receipt",
  "receipts",
  "register",
  "registration",
  "session",
  "sessions",
  "signin",
  "signup",
  "sso",
  "submit",
  "success",
  "succeeded",
  "transaction",
  "transactions",
  "token",
  "tokens",
  "verification",
  "verify",
  "waiting",
  "waitingroom"
]);

function isProviderTransactionOrAccessUrl(url: URL) {
  const surfaces = [url.hostname, url.pathname, url.hash];
  if (
    surfaces
      .flatMap(tokenizeProviderSurfacePart)
      .some(isProviderTransactionOrAccessToken)
  ) {
    return true;
  }
  return surfaces
    .flatMap((surface) => safeDecodeProviderSurfacePart(surface).split(/[./#?&]+/u))
    .map((segment) =>
      segment
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]/gu, "")
    )
    .some(isProviderTransactionOrAccessToken);
}

function isProviderTransactionOrAccessToken(value: string) {
  const compact = value.replace(/[^a-z0-9]/gu, "");
  return Boolean(
    PROVIDER_TRANSACTION_OR_ACCESS_TOKENS.has(compact) ||
      compact.includes("login") ||
      /^(?:saml|openid|oidc|oauth\d*|adfs|identity|idp|mfa|2fa|webauthn|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|queue|queueit|waitingroom|checkout|authorize|authorization|authentication|signin|signup|logout|register|registration|password|session|token|magiclink|invite|invitation|verify|verification|wresult)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^auth(?:\d*(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|challenge|login|signin|provider|gateway|server|service|proxy)|n|z|enticate|entication|orize|orization)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|clientaccount|partneraccount|employeeaccount|regionalaccount)(?:(?:login|signin|signup|portal|dashboard|profile|settings|callback|redirect|recovery|recover|reset|management|manage)[a-z0-9]*)?$/u.test(
        compact
      ) ||
      /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:admin|staff|member|members|customer|user|client|partner|employee|secure)(?:area|center|centre|dashboard|portal|profile|settings)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:myprofile|profile(?:area|edit|settings))$/u.test(compact) ||
      /^(?:members?|admin|staff|customer|user|client|partner|employee|regional|secure)(?:center|centre|booking|portal|dashboard|profile|settings|account)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)(?:username|email|password|account)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:email|username)(?:verify|verification|confirm|confirmation|reset|recovery)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^billing(?:portal|account|history|settings|payment|invoices?|details?)?$/u.test(
        compact
      ) ||
      /^paymentmethod[a-z0-9]*$/u.test(compact) ||
      /^(?:credentials?|signature|signed(?:url)?|assertion|relaystate|consent|jsessionid|authcode|nonce|jwt|bearer)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:token|secret|ticket)[a-z0-9]*$/u.test(compact) ||
      /^(?:access|refresh|id|api|client|service|login|auth)(?:token|key|secret|ticket)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:account|cart|checkout|confirmation|order|payment|purchase|receipt|transaction)(?:complete|confirmation|page|portal|status|success)?$/u.test(
        compact
      ) ||
      /^(?:bookings?|reservations?)(?:cart|checkout|complete|confirm|confirmation|done|payment|receipt|status|success|thankyou)$/u.test(
        compact
      ) ||
      /^(?:complete|completed|confirmation|receipt|success|succeeded)(?:page|status)?$/u.test(
        compact
      ) ||
      /^thankyou(?:page)?$/u.test(compact) ||
      /^transaction[a-z0-9]*$/u.test(compact) ||
      /^(?:order|purchase|checkout)(?:complete|confirm|confirmation|done|flow|page|portal|review|start|status|step|success)$/u.test(
        compact
      ) ||
      /^(?:cart|order)(?:review|summary|confirm|confirmation|checkout|payment|billing)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:payment|pay|cart|purchase|order|challenge)(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|checkout)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:pay(?:portal|account|method|ment)?|basket|shoppingbag|placeorder|completepurchase|orderhistory|purchasehistory|transactionhistory)$/u.test(
        compact
      ) ||
      /^(?:log|sign)(?:in|out|up)$/u.test(compact) ||
      /^(?:my)?account$/u.test(compact) ||
      /^(?:captcha|challenge|member|members|mfa|password|profile|profiles|queue|register|registration|session|sessions|sso|token|tokens|verification|verify)(?:page|portal)?$/u.test(
        compact
      ) ||
      /^(?:waiting|challenge)(?:area|gate|hold|lobby|room)?$/u.test(compact)
  );
}

function hasAllowedProviderBookingLandingQuery(
  url: URL,
  providerFamily: KnownProviderFamily
) {
  if (!url.search) {
    return true;
  }
  if (providerFamily === "GOLF_WITH_ACCESS") {
    const facilityFilters = [...url.searchParams.entries()].filter(
      ([key]) => key.toLocaleLowerCase("en-US") === "filterfacilities"
    );
    const unsafeEntry = [...url.searchParams.entries()].some(
      ([key, value]) =>
        !isProviderTrackingQueryParameter(key) &&
        (key.toLocaleLowerCase("en-US") !== "filterfacilities" ||
          !/^[a-z0-9][a-z0-9-]{0,127}$/iu.test(value))
    );
    return Boolean(
      !unsafeEntry &&
        facilityFilters.length <= 12 &&
        new Set(
          facilityFilters.map(([, value]) =>
            value.toLocaleLowerCase("en-US")
          )
        ).size === facilityFilters.length
    );
  }
  const query = readUniqueProviderLandingQuery(url);
  if (!query) {
    return false;
  }
  if (query.size === 0) {
    return true;
  }
  if (providerFamily === "CPS") {
    return Boolean(
      query.size === 1 &&
        readBoundedProviderLandingInteger(query.get("courseid"), 2_147_483_647)
    );
  }
  if (providerFamily === "WEBTRAC") {
    const allowedKeys = new Set([
      "interfaceparameter",
      "module",
      "secondarycode"
    ]);
    const secondaryCode = query.get("secondarycode");
    return Boolean(
      query.get("module")?.toUpperCase() === "GR" &&
        secondaryCode &&
        /^[a-z0-9_-]{1,24}$/iu.test(secondaryCode) &&
        [...query.entries()].every(([key, entry]) => {
          if (!allowedKeys.has(key)) {
            return false;
          }
          return key === "interfaceparameter"
            ? entry.toLocaleLowerCase("en-US") === "webtrac_se"
            : /^[a-z0-9_-]{1,24}$/iu.test(entry);
        })
    );
  }
  if (providerFamily === "TEEITUP") {
    const allowedKeys = new Set(["course", "date", "holes", "max", "players"]);
    return Boolean(
      readBoundedProviderLandingInteger(query.get("course"), 2_147_483_647) &&
        [...query.entries()].every(([key, entry]) => {
          if (!allowedKeys.has(key)) {
            return false;
          }
          if (key === "date") {
            return isValidProviderLandingDate(entry);
          }
          if (key === "holes") {
            return entry === "9" || entry === "18";
          }
          const maximum = key === "players" ? 8 : key === "max" ? 100 : 2_147_483_647;
          return readBoundedProviderLandingInteger(entry, maximum);
        })
    );
  }
  return false;
}

function readUniqueProviderLandingQuery(url: URL) {
  const values = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (isProviderTrackingQueryParameter(key)) {
      continue;
    }
    const normalizedKey = key.toLocaleLowerCase("en-US");
    if (values.has(normalizedKey)) {
      return null;
    }
    values.set(normalizedKey, value);
  }
  return values;
}

function hasOnlyProviderTrackingQuery(url: URL) {
  return [...url.searchParams.keys()].every(isProviderTrackingQueryParameter);
}

function readBoundedProviderLandingInteger(
  value: string | undefined,
  maximum: number
) {
  if (!value || !/^[1-9]\d{0,9}$/u.test(value)) {
    return false;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum;
}

function isValidProviderLandingDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  if (year < 2000 || year > 2100) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function tokenizeProviderSurfacePart(value: string) {
  const decoded = safeDecodeProviderSurfacePart(value)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US");
  const tokens = decoded.split(/[^a-z0-9]+/u).filter(Boolean);
  return tokens.length > 0 ? tokens : [decoded];
}

function safeDecodeProviderSurfacePart(value: string) {
  let decoded = value;
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function isProviderInfrastructureToken(value: string) {
  const compact = value.replace(/[^a-z0-9]/gu, "");
  return Boolean(
    PROVIDER_INFRASTRUCTURE_TOKENS.has(compact) ||
      /^(?:api|openapi|swagger)(?:v?\d+)?$/u.test(compact) ||
      /^v\d+(?:(?:alpha|beta|preview|rc)\d*)?$/u.test(compact) ||
      /^(?:admin|api|assets?|auth|cdn|config(?:uration)?|developer|docs?|graphql|openapi|sandbox|static|status|swagger)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^rest(?:api|endpoint|gateway|private|proxy|public|server|services?|v\d+)[a-z0-9]*$/u.test(
        compact
      ) ||
      /^(?:dev|qa|stage|staging|test)(?:admin|api|app|console|gateway|portal|prod|production|server|services?|v\d+|web)$/u.test(
        compact
      ) ||
      /(?:admin|api|assets?|auth|cdn|config(?:uration)?|developer|docs?|graphql|openapi|static|status|swagger)$/u.test(
        compact
      )
  );
}

export type ProviderFailureSignal = {
  error?: unknown;
  httpStatus?: number | null;
  retryAfter?: number | string | null;
  challenge?: boolean;
  readinessFailure?: CourseSupportFailureClass | null;
  now?: Date;
};

export type ClassifiedProviderFailure = {
  failureClass: CourseSupportFailureClass;
  httpStatus: number | null;
  retryAfterSeconds: number | null;
};

export function classifyProviderFailure(
  signal: ProviderFailureSignal
): ClassifiedProviderFailure {
  const record = asRecord(signal.error);
  const structuredFailure =
    typeof record?.failureClass === "string" && failureClasses.has(record.failureClass)
      ? (record.failureClass as CourseSupportFailureClass)
      : null;
  const message = getErrorMessage(signal.error);
  const errorName = typeof record?.name === "string" ? record.name : "";
  const errorCode = typeof record?.code === "string" ? record.code : "";
  const httpStatus =
    normalizeHttpStatus(signal.httpStatus) ??
    normalizeHttpStatus(record?.status) ??
    normalizeHttpStatus(record?.statusCode) ??
    getHttpStatusFromMessage(message);
  const retryAfter = signal.retryAfter ?? record?.retryAfter;

  let failureClass = signal.readinessFailure ?? structuredFailure;
  if (!failureClass && (signal.challenge || isChallengeMessage(message))) {
    failureClass = "CHALLENGE";
  }
  if (!failureClass && httpStatus === 429) {
    failureClass = "RATE_LIMIT";
  }
  if (!failureClass && [401, 403, 407].includes(httpStatus ?? 0)) {
    failureClass = "AUTH";
  }
  if (!failureClass && [404, 410].includes(httpStatus ?? 0)) {
    failureClass = "NOT_FOUND";
  }
  if (!failureClass && httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) {
    failureClass = "HTTP_5XX";
  }
  if (
    !failureClass &&
    (/^(?:AbortError|TimeoutError)$/i.test(errorName) || /\btimed?\s*out\b|\btimeout\b/i.test(message))
  ) {
    failureClass = "TIMEOUT";
  }
  if (
    !failureClass &&
    (/^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|EPIPE|ETIMEDOUT)$/i.test(
      errorCode
    ) || /\bfetch failed\b|\bnetwork error\b|\bsocket hang up\b|\bdns\b/i.test(message))
  ) {
    failureClass = "NETWORK";
  }
  if (
    !failureClass &&
    /\b(?:invalid|malformed|unexpected) (?:json|payload|response|schema)\b|\bjson parse\b|\bdid not include\b|\bdid not select\b/i.test(
      message
    )
  ) {
    failureClass = "SCHEMA";
  }

  return {
    failureClass: failureClass ?? "UNKNOWN",
    httpStatus,
    retryAfterSeconds: parseRetryAfterSeconds(retryAfter, signal.now ?? new Date())
  };
}

export function buildProviderFailureFingerprint(input: {
  providerFamilyKey: string;
  failureClass: CourseSupportFailureClass;
  operation?: ProviderOperation;
  httpStatus?: number | null;
}) {
  const providerFamilyKey = normalizeProviderFamilyKey(input.providerFamilyKey);
  const operation = input.operation ?? "UNKNOWN";
  const statusBucket = getHttpStatusBucket(input.httpStatus);
  return createHash("sha256")
    .update(`v1|${providerFamilyKey}|${input.failureClass}|${operation}|${statusBucket}`)
    .digest("hex");
}

export type ConsumerDispositionInput = ProviderCourseInput & {
  isPublic?: boolean | null;
  invalidCourse?: boolean;
  bookingMethod?: string | null;
  automationEligibility?: string | null;
  automationReason?: string | null;
  currentEvidenceTrusted?: boolean;
  currentEvidenceObservedAt?: Date | string | null;
  intelligenceVerifiedAt?: Date | string | null;
  intelligenceReviewAt?: Date | string | null;
  intelligenceConfidence?: number | null;
  latestOutcome?: string | null;
  targetDateStatus?: string | null;
  bookingOpensAt?: Date | string | null;
  availableMatchCount?: number;
  failureClass?: CourseSupportFailureClass | null;
  finalClassification?: boolean;
  now?: Date;
};

const retryableFailureClasses = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK"
]);

const effectiveConsumerDispositions = new Set<ConsumerDisposition>([
  "MATCH_AVAILABLE",
  "CHECKED_NO_MATCH",
  "BOOKING_NOT_OPEN"
]);

export function deriveConsumerDisposition(
  input: ConsumerDispositionInput
): ConsumerDisposition {
  const monitoringGate = evaluateMonitoringGate(input);
  if (monitoringGate.disposition === "IDENTITY_RECHECK") {
    return "SOURCE_UNVERIFIED";
  }
  if (monitoringGate.disposition === "IDENTITY_FINAL") {
    return "PRIVATE_OR_INVALID";
  }
  if (monitoringGate.disposition === "TECHNICAL_FINAL") {
    return input.automationReason === "ACCOUNT_REQUIRED"
      ? "ACCOUNT_REQUIRED"
      : "CAPTCHA_OR_QUEUE";
  }
  if (monitoringGate.disposition === "MANUAL_FINAL") {
    return ["PHONE_ONLY", "CONTACT_COURSE", "WALK_IN"].includes(
      input.bookingMethod ?? ""
    )
      ? "PHONE_OR_WALK_IN"
      : "DIRECT_SITE_ONLY";
  }

  if (
    input.currentEvidenceTrusted &&
    isRunnableEvidenceNewEnough(input)
  ) {
    if (input.latestOutcome === "MATCH_FOUND" && (input.availableMatchCount ?? 0) > 0) {
      return "MATCH_AVAILABLE";
    }
    if (input.latestOutcome === "NO_MATCH") {
      if (
        input.targetDateStatus === "NOT_OPEN" ||
        isFutureInstant(input.bookingOpensAt, input.now ?? new Date())
      ) {
        return "BOOKING_NOT_OPEN";
      }
      return "CHECKED_NO_MATCH";
    }
  }
  const provider = resolveProviderCapability(input);
  const hasOfficialSource =
    provider.providerFamilyKey !== SOURCE_MISSING_PROVIDER_FAMILY &&
    provider.providerFamilyKey !== SOURCE_CONFLICT_PROVIDER_FAMILY;
  if (input.failureClass && retryableFailureClasses.has(input.failureClass)) {
    return "RETRYING";
  }
  if (!hasOfficialSource) {
    return "SOURCE_UNVERIFIED";
  }
  return "ENGINEERING";
}

function isRunnableEvidenceNewEnough(input: ConsumerDispositionInput) {
  const evidenceAt = parseEvidenceDate(input.currentEvidenceObservedAt);
  const classificationAt = parseEvidenceDate(input.intelligenceVerifiedAt);
  if (!classificationAt) {
    return true;
  }
  return Boolean(evidenceAt && evidenceAt.getTime() >= classificationAt.getTime());
}

function parseEvidenceDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isEffectiveConsumerCoverage(disposition: ConsumerDisposition) {
  return effectiveConsumerDispositions.has(disposition);
}

function getKnownProviderCapability(providerFamilyKey: string) {
  const normalized = normalizeProviderFamilyKey(providerFamilyKey);
  return knownProviderFamilySet.has(normalized)
    ? PROVIDER_CAPABILITIES[normalized as KnownProviderFamily]
    : null;
}

function getMetadataProviderFamily(metadata: unknown) {
  const record = asRecord(metadata);
  const provider = typeof record?.provider === "string"
    ? record.provider.toUpperCase()
    : null;
  return provider ? metadataProviderFamilies.get(provider) ?? null : null;
}

function normalizeExternalDetectedPlatform(value?: string | null): ExternalDetectedPlatform {
  const normalized = value?.trim().toUpperCase() ?? "UNKNOWN";
  return externalDetectedPlatforms.has(normalized)
    ? (normalized as ExternalDetectedPlatform)
    : "UNKNOWN";
}

function getSafePublicHostname(value?: string | null) {
  if (!value?.trim()) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return isSafeHostname(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

function isSafeHostname(value: string) {
  if (value.length < 1 || value.length > 253 || value.includes("..")) {
    return false;
  }
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
    )
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const record = asRecord(error);
  return typeof record?.message === "string"
    ? record.message
    : typeof error === "string"
      ? error
      : "";
}

function normalizeHttpStatus(value: unknown) {
  const status = typeof value === "string" ? Number(value) : value;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

function getHttpStatusFromMessage(message: string) {
  const status = message.match(/\b(?:http|returned|status)\s+(\d{3})\b/i)?.[1];
  return normalizeHttpStatus(status);
}

function isChallengeMessage(message: string) {
  return /\b(?:captcha|recaptcha|managed challenge|browser challenge|cloudflare challenge|queue[- ]gated)\b/i.test(
    message
  );
}

function parseRetryAfterSeconds(value: unknown, now: Date) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.ceil(value);
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  if (/^\d+(?:\.\d+)?$/u.test(value.trim())) {
    return Math.ceil(Number(value));
  }
  const retryAt = new Date(value);
  return Number.isNaN(retryAt.getTime())
    ? null
    : Math.max(0, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
}

function getHttpStatusBucket(status?: number | null) {
  const normalized = normalizeHttpStatus(status);
  if (normalized !== null && normalized >= 500) {
    return "5XX";
  }
  return normalized === null ? "NONE" : String(normalized);
}

function isFutureInstant(value: Date | string | null | undefined, now: Date) {
  if (!value) {
    return false;
  }
  const instant = value instanceof Date ? value : new Date(value);
  return !Number.isNaN(instant.getTime()) && instant > now;
}
