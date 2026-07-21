import { createHash } from "node:crypto";

import { isCpsMetadata } from "@/lib/adapters/cps";
import { isChelseaMetadata } from "@/lib/adapters/chelsea";
import { isChronogolfMetadata } from "@/lib/adapters/chronogolf";
import { isClubCaddieMetadata } from "@/lib/adapters/clubcaddie";
import { isForeupMetadata } from "@/lib/adapters/foreup";
import { isGolfBackMetadata } from "@/lib/adapters/golfback";
import { isTeeItUpMetadata } from "@/lib/adapters/teeitup";
import { isTeesnapMetadata } from "@/lib/adapters/teesnap";
import { isWebTracMetadata } from "@/lib/adapters/webtrac";
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
    supportsAutomation: false,
    matchesHostname: (hostname) => matchesDomain(hostname, "whoosh.io")
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
  ["WEBTRAC", "WEBTRAC"],
  ["CLUB_CADDIE", "CLUB_CADDIE"]
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
  const metadataReady = Boolean(
    capability?.supportsAutomation &&
      capability.validatesMetadata?.(input.bookingMetadata)
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
    capability?.supportsAutomation && capability.validatesMetadata?.(metadata)
  );
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
