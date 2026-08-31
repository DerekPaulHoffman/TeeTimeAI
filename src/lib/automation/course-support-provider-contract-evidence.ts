import { createHash } from "node:crypto";

import { isSafeManualEvidenceUrl } from "./browser-discovery";
import { classifyBrowserNetworkContractRestriction } from "./browser-probe-evidence";
import {
  getKnownProviderFamilyForHostname,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl,
  normalizeProviderFamilyKey,
  resolveProviderDiscoveryIdentity,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY,
} from "./provider-capabilities";

export const COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION = 1;
export const PROVIDER_CONTRACT_MAX_CONTRACTS = 24;

const SAFE_PATH_SEGMENTS = new Map<string, string>([
  ["api", "api"],
  ["v1", "v1"],
  ["v2", "v2"],
  ["v3", "v3"],
  ["availability", "availability"],
  ["available", "available"],
  ["booking", "booking"],
  ["bookings", "bookings"],
  ["calendar", "calendar"],
  ["course", "course"],
  ["courses", "courses"],
  ["facility", "facility"],
  ["facilities", "facilities"],
  ["inventory", "inventory"],
  ["location", "location"],
  ["locations", "locations"],
  ["public", "public"],
  ["search", "search"],
  ["slot", "slot"],
  ["slots", "slots"],
  ["tee-time", "tee-time"],
  ["tee-times", "tee-times"],
  ["teetime", "tee-time"],
  ["teetimes", "tee-times"],
  ["time", "time"],
  ["times", "times"],
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"] as const);

export type ProviderContractMethod = "GET" | "HEAD" | "OPTIONS";
export type ProviderContractResourceType =
  "DOCUMENT" | "FETCH" | "XHR" | "SCRIPT" | "OTHER";
export type ProviderContractStatusBand =
  "SUCCESS" | "REDIRECT" | "CLIENT_ERROR" | "SERVER_ERROR" | "UNKNOWN";
export type ProviderContractQueryKey =
  | "COURSE_ID"
  | "DATE"
  | "END_DATE"
  | "FACILITY_ID"
  | "HOLES"
  | "LIMIT"
  | "LOCATION_ID"
  | "OFFSET"
  | "PAGE"
  | "PLAYERS"
  | "START_DATE"
  | "TIMEZONE"
  | "OTHER";
export type ProviderContractSignal =
  | "OFFICIAL_ORIGIN"
  | "BOOKING_ORIGIN"
  | "KNOWN_PROVIDER_INFRASTRUCTURE"
  | "TRUSTED_BROWSER_ORIGIN"
  | "TRUSTED_SCRIPT_RELATIVE";

export type SanitizedProviderContract = {
  method: ProviderContractMethod;
  resourceType: ProviderContractResourceType;
  statusBand: ProviderContractStatusBand;
  pathPattern: string;
  queryKeys: ProviderContractQueryKey[];
  providerSignal: ProviderContractSignal;
  digest: string;
};

export type CourseSupportProviderContractEvidenceMarker = {
  schemaVersion: typeof COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION;
  evidenceDigest: string;
  contractCount: number;
};

export type ProviderContractBrowserNetworkContract = {
  origin: string;
  method: string;
  pathPattern: string;
  queryKeys: string[];
  resourceType: string;
  status: number | null;
};

export type ProviderContractBrowserDiscovery = {
  evidence: unknown;
  automationReason: string;
  detectedPlatform: string;
  bookingUrl: string | null;
  apiMetadata: unknown;
  confidence: number;
  createdAt: Date;
};

export type CurrentBrowserProviderContractEvidence = {
  createdAt: Date;
  contracts: SanitizedProviderContract[];
  restrictionDetected: boolean;
  marker: CourseSupportProviderContractEvidenceMarker | null;
};

export function selectCurrentBrowserProviderContractEvidence(input: {
  discoveries: readonly ProviderContractBrowserDiscovery[];
  incidentCycle: number;
  incidentFirstSeenAt: Date;
  providerFamilyKey: string;
  providerSnapshotFingerprint: string;
  officialUrl: string | null;
  bookingUrl: string | null;
}): CurrentBrowserProviderContractEvidence | null {
  const providerFamily = normalizeProviderFamilyKey(input.providerFamilyKey);

  for (const discovery of input.discoveries) {
    const evidence = asRecord(discovery.evidence);
    const browser = asRecord(evidence.browserInvestigation);
    const observedAt =
      typeof browser.observedAt === "string"
        ? new Date(browser.observedAt)
        : null;
    if (
      browser.incidentCycle !== input.incidentCycle ||
      !observedAt ||
      !Number.isFinite(observedAt.getTime()) ||
      observedAt.getTime() < input.incidentFirstSeenAt.getTime()
    ) {
      continue;
    }

    const rawContracts = Array.isArray(browser.networkContracts)
      ? browser.networkContracts.flatMap(readRawBrowserContract)
      : [];
    const barriers = Array.isArray(evidence.accessBarriers)
      ? evidence.accessBarriers
      : [];
    const restrictionDetected =
      browser.restrictedNetworkObserved === true ||
      discovery.automationReason === "ACCOUNT_REQUIRED" ||
      discovery.automationReason === "CAPTCHA_OR_QUEUE" ||
      barriers.length > 0 ||
      rawContracts.some(isRestrictedPersistedBrowserContract);
    if (restrictionDetected) {
      return {
        createdAt: discovery.createdAt,
        contracts: [],
        restrictionDetected: true,
        marker: null,
      };
    }

    const discoveryProvider = resolveProviderDiscoveryIdentity({
      detectedPlatform: discovery.detectedPlatform,
      bookingUrl: discovery.bookingUrl,
      apiMetadata: discovery.apiMetadata,
      confidence: discovery.confidence,
    });
    if (
      browser.providerSnapshotFingerprint !==
        input.providerSnapshotFingerprint ||
      (discoveryProvider &&
        normalizeProviderFamilyKey(discoveryProvider.providerFamilyKey) !==
          providerFamily)
    ) {
      continue;
    }

    const projection = projectBrowserProviderContracts({
      contracts: rawContracts,
      providerFamilyKey: providerFamily,
      officialUrl: input.officialUrl,
      bookingUrl: input.bookingUrl,
    });
    const marker = projection.automaticContracts.some(
      (contract) => contract.statusBand === "SUCCESS",
    )
      ? buildCourseSupportProviderContractEvidenceMarker({
          incidentCycle: input.incidentCycle,
          observedAt,
          providerFamilyKey: providerFamily,
          providerSnapshotFingerprint: input.providerSnapshotFingerprint,
          contracts: projection.automaticContracts,
        })
      : null;
    return {
      createdAt: discovery.createdAt,
      contracts: projection.contracts,
      restrictionDetected: false,
      marker,
    };
  }
  return null;
}

export function parseCourseSupportProviderContractEvidenceMarker(
  value: unknown,
): CourseSupportProviderContractEvidenceMarker | null {
  const marker = asRecord(value);
  if (
    Object.keys(marker).length !== 3 ||
    marker.schemaVersion !==
      COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION ||
    typeof marker.evidenceDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(marker.evidenceDigest) ||
    !Number.isSafeInteger(marker.contractCount) ||
    (marker.contractCount as number) < 1 ||
    (marker.contractCount as number) > PROVIDER_CONTRACT_MAX_CONTRACTS
  ) {
    return null;
  }
  return {
    schemaVersion: COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION,
    evidenceDigest: marker.evidenceDigest,
    contractCount: marker.contractCount as number,
  };
}

export function parseSanitizedProviderContract(
  value: unknown,
): SanitizedProviderContract | null {
  const contract = asRecord(value);
  if (
    typeof contract.method !== "string" ||
    normalizeProviderContractReadMethod(contract.method) !== contract.method ||
    typeof contract.resourceType !== "string" ||
    normalizeProviderContractResourceType(contract.resourceType) !==
      contract.resourceType ||
    typeof contract.statusBand !== "string" ||
    ![
      "SUCCESS",
      "REDIRECT",
      "CLIENT_ERROR",
      "SERVER_ERROR",
      "UNKNOWN",
    ].includes(contract.statusBand) ||
    typeof contract.pathPattern !== "string" ||
    !Array.isArray(contract.queryKeys) ||
    !contract.queryKeys.every((key) => typeof key === "string") ||
    typeof contract.providerSignal !== "string" ||
    ![
      "OFFICIAL_ORIGIN",
      "BOOKING_ORIGIN",
      "KNOWN_PROVIDER_INFRASTRUCTURE",
      "TRUSTED_BROWSER_ORIGIN",
      "TRUSTED_SCRIPT_RELATIVE",
    ].includes(contract.providerSignal) ||
    typeof contract.digest !== "string"
  ) {
    return null;
  }
  const rebuilt = buildSanitizedProviderContract({
    method: contract.method as ProviderContractMethod,
    resourceType: contract.resourceType as ProviderContractResourceType,
    statusBand: contract.statusBand as ProviderContractStatusBand,
    pathPattern: contract.pathPattern,
    queryKeys: contract.queryKeys as string[],
    providerSignal: contract.providerSignal as ProviderContractSignal,
  });
  return rebuilt.digest === contract.digest ? rebuilt : null;
}

export function courseSupportProviderContractEvidenceMarkersMatch(
  left: CourseSupportProviderContractEvidenceMarker | null | undefined,
  right: CourseSupportProviderContractEvidenceMarker | null | undefined,
) {
  if (!left || !right) return !left && !right;
  return (
    left.schemaVersion === right.schemaVersion &&
    left.evidenceDigest === right.evidenceDigest &&
    left.contractCount === right.contractCount
  );
}

export function buildSanitizedProviderContract(
  input: Omit<
    SanitizedProviderContract,
    "digest" | "pathPattern" | "queryKeys"
  > & {
    pathPattern: string;
    queryKeys: string[];
  },
): SanitizedProviderContract {
  const contract = {
    method: input.method,
    resourceType: input.resourceType,
    statusBand: input.statusBand,
    pathPattern: sanitizeContractPath(input.pathPattern),
    queryKeys: normalizeQueryKeys(input.queryKeys),
    providerSignal: input.providerSignal,
  };
  return {
    ...contract,
    digest: createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
  };
}

export function deduplicateProviderContracts(
  contracts: SanitizedProviderContract[],
) {
  return [
    ...new Map(
      contracts.map((contract) => [contract.digest, contract]),
    ).values(),
  ]
    .sort((left, right) => left.digest.localeCompare(right.digest))
    .slice(0, PROVIDER_CONTRACT_MAX_CONTRACTS);
}

export function normalizeProviderContractReadMethod(
  value: string,
): ProviderContractMethod | null {
  const normalized = value.toUpperCase();
  return READ_METHODS.has(normalized as ProviderContractMethod)
    ? (normalized as ProviderContractMethod)
    : null;
}

export function normalizeProviderContractResourceType(
  value: string,
): ProviderContractResourceType {
  const normalized = value.toUpperCase();
  return ["DOCUMENT", "FETCH", "XHR", "SCRIPT"].includes(normalized)
    ? (normalized as ProviderContractResourceType)
    : "OTHER";
}

export function safeProviderContractOrigin(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return isSafeManualEvidenceUrl(url) ? url.origin : null;
  } catch {
    return null;
  }
}

export function selectProviderContractTrustedLandingUrl(
  values: readonly (string | null)[],
) {
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (!isSafeManualEvidenceUrl(url)) continue;
      url.hash = "";
      return url.toString();
    } catch {
      // Continue to the next server-derived candidate.
    }
  }
  return null;
}

export function selectProviderContractTrustedBookingLandingUrl(
  value: string | null,
  providerFamilyKey: string,
) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!isSafeManualEvidenceUrl(url)) return null;
    const expectedFamily = normalizeProviderFamilyKey(providerFamilyKey);
    const knownFamily = getKnownProviderFamilyForHostname(url.hostname);
    const familyMatches = knownFamily
      ? normalizeProviderFamilyKey(knownFamily) === expectedFamily
      : normalizeProviderFamilyKey(url.hostname) === expectedFamily;
    if (
      !familyMatches ||
      (knownFamily
        ? !isProviderPublicBookingLandingUrl(url)
        : url.protocol !== "https:" || isProviderInfrastructureUrl(url))
    ) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeContractPath(value: string) {
  let pathname = value;
  try {
    pathname = new URL(value, "https://contract.invalid").pathname;
  } catch {
    pathname = "/";
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 12)
    .map((segment) => {
      const decoded = safeDecode(segment)
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .replace(/[_\s]+/gu, "-")
        .replace(/[^a-z0-9-]/gu, "");
      if (!decoded) return "{segment}";
      if (/^v\d{1,2}$/u.test(decoded)) return decoded;
      return SAFE_PATH_SEGMENTS.get(decoded) ?? "{segment}";
    })
    .filter(
      (segment, index, values) =>
        segment !== "{segment}" || values[index - 1] !== "{segment}",
    );
  return `/${segments.join("/")}`.slice(0, 160) || "/";
}

export function projectBrowserProviderContracts(input: {
  contracts: readonly unknown[];
  providerFamilyKey: string;
  officialUrl: string | null;
  bookingUrl: string | null;
}) {
  const officialOrigin = safeProviderContractOrigin(input.officialUrl);
  const bookingOrigin = safeProviderContractOrigin(input.bookingUrl);
  const projected: SanitizedProviderContract[] = [];
  const automatic: SanitizedProviderContract[] = [];
  for (const contract of input.contracts.flatMap(readRawBrowserContract)) {
    const method = normalizeProviderContractReadMethod(contract.method);
    const resourceType = normalizeProviderContractResourceType(
      contract.resourceType,
    );
    if (
      !method ||
      !contractMatchesProviderFamily({
        contract,
        providerFamilyKey: input.providerFamilyKey,
        officialOrigin,
        bookingOrigin,
      }) ||
      (resourceType !== "FETCH" && resourceType !== "XHR")
    ) {
      continue;
    }
    const sanitized = buildSanitizedProviderContract({
      method,
      resourceType,
      statusBand: normalizeStatusBand(contract.status),
      pathPattern: contract.pathPattern,
      queryKeys: contract.queryKeys,
      providerSignal: classifyBrowserProviderSignal(
        contract.origin,
        officialOrigin,
        bookingOrigin,
      ),
    });
    projected.push(sanitized);
    if (
      contractOriginSupportsAutomaticImplementation({
        origin: contract.origin,
        bookingOrigin,
        providerFamilyKey: input.providerFamilyKey,
      }) &&
      hasActionableAvailabilityShape(sanitized)
    ) {
      automatic.push(sanitized);
    }
  }
  return {
    contracts: deduplicateProviderContracts(projected),
    automaticContracts: deduplicateProviderContracts(automatic),
  };
}

function contractOriginSupportsAutomaticImplementation(input: {
  origin: string;
  bookingOrigin: string | null;
  providerFamilyKey: string;
}) {
  try {
    const url = new URL(input.origin);
    if (!isSafeManualEvidenceUrl(url)) return false;
    const expectedFamily = normalizeProviderFamilyKey(input.providerFamilyKey);
    if (
      expectedFamily === SOURCE_MISSING_PROVIDER_FAMILY ||
      expectedFamily === SOURCE_CONFLICT_PROVIDER_FAMILY
    ) {
      return false;
    }
    if (input.bookingOrigin && url.origin === input.bookingOrigin) return true;
    const family = getKnownProviderFamilyForHostname(url.hostname);
    if (family) {
      return (
        normalizeProviderFamilyKey(family) ===
        expectedFamily
      );
    }
    const hostnameFamily = normalizeProviderFamilyKey(url.hostname);
    return (
      hostnameFamily !== SOURCE_MISSING_PROVIDER_FAMILY &&
      hostnameFamily !== SOURCE_CONFLICT_PROVIDER_FAMILY &&
      hostnameFamily === expectedFamily
    );
  } catch {
    return false;
  }
}

function hasActionableAvailabilityShape(contract: SanitizedProviderContract) {
  const pathSegments = contract.pathPattern.split("/");
  const availabilityPathSignal = pathSegments.some((segment) =>
    new Set([
      "availability",
      "available",
      "calendar",
      "slot",
      "slots",
      "tee-time",
      "tee-times",
    ]).has(segment),
  );
  if (availabilityPathSignal) return true;

  const temporalQuerySignal = contract.queryKeys.some((key) =>
    new Set<ProviderContractQueryKey>([
      "DATE",
      "END_DATE",
      "START_DATE",
    ]).has(key),
  );
  const entityQuerySignal = contract.queryKeys.some((key) =>
    new Set<ProviderContractQueryKey>([
      "COURSE_ID",
      "FACILITY_ID",
      "LOCATION_ID",
      "PLAYERS",
    ]).has(key),
  );
  const bookingPathSignal = pathSegments.some((segment) =>
    new Set([
      "booking",
      "bookings",
      "course",
      "courses",
      "facility",
      "facilities",
      "location",
      "locations",
    ]).has(segment),
  );
  return temporalQuerySignal && (entityQuerySignal || bookingPathSignal);
}

function buildCourseSupportProviderContractEvidenceMarker(input: {
  incidentCycle: number;
  observedAt: Date;
  providerFamilyKey: string;
  providerSnapshotFingerprint: string;
  contracts: SanitizedProviderContract[];
}): CourseSupportProviderContractEvidenceMarker {
  const evidenceDigest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION,
        incidentCycle: input.incidentCycle,
        observedAt: input.observedAt.toISOString(),
        providerFamilyKey: input.providerFamilyKey,
        providerSnapshotFingerprint: input.providerSnapshotFingerprint,
        contractDigests: input.contracts.map((contract) => contract.digest),
      }),
    )
    .digest("hex");
  return {
    schemaVersion: COURSE_SUPPORT_PROVIDER_CONTRACT_EVIDENCE_SCHEMA_VERSION,
    evidenceDigest,
    contractCount: input.contracts.length,
  };
}

function isRestrictedPersistedBrowserContract(
  contract: ProviderContractBrowserNetworkContract,
) {
  const classification = classifyBrowserNetworkContractRestriction(contract);
  return Boolean(
    contract.status === 401 ||
    contract.status === 403 ||
    contract.status === 429 ||
    classification.unsafeMethod ||
    classification.unsafeUrlState,
  );
}

function readRawBrowserContract(
  value: unknown,
): ProviderContractBrowserNetworkContract[] {
  const record = asRecord(value);
  if (
    typeof record.origin !== "string" ||
    typeof record.method !== "string" ||
    typeof record.pathPattern !== "string" ||
    !Array.isArray(record.queryKeys) ||
    !record.queryKeys.every((key) => typeof key === "string") ||
    typeof record.resourceType !== "string" ||
    !(
      record.status === null ||
      (typeof record.status === "number" && Number.isInteger(record.status))
    )
  ) {
    return [];
  }
  return [
    {
      origin: record.origin,
      method: record.method,
      pathPattern: record.pathPattern,
      queryKeys: record.queryKeys as string[],
      resourceType: record.resourceType,
      status: record.status as number | null,
    },
  ];
}

function contractMatchesProviderFamily(input: {
  contract: ProviderContractBrowserNetworkContract;
  providerFamilyKey: string;
  officialOrigin: string | null;
  bookingOrigin: string | null;
}) {
  try {
    const url = new URL(input.contract.origin);
    if (!isSafeManualEvidenceUrl(url)) return false;
    if (
      url.origin === input.officialOrigin ||
      url.origin === input.bookingOrigin
    ) {
      return true;
    }
    const family = getKnownProviderFamilyForHostname(url.hostname);
    return Boolean(
      family &&
      normalizeProviderFamilyKey(family) ===
        normalizeProviderFamilyKey(input.providerFamilyKey),
    );
  } catch {
    return false;
  }
}

function classifyBrowserProviderSignal(
  origin: string,
  officialOrigin: string | null,
  bookingOrigin: string | null,
): ProviderContractSignal {
  if (origin === officialOrigin) return "OFFICIAL_ORIGIN";
  if (origin === bookingOrigin) return "BOOKING_ORIGIN";
  try {
    const family = getKnownProviderFamilyForHostname(new URL(origin).hostname);
    if (family) return "KNOWN_PROVIDER_INFRASTRUCTURE";
  } catch {
    // The contract family gate already rejected an unsafe or malformed origin.
  }
  return "TRUSTED_BROWSER_ORIGIN";
}

function normalizeStatusBand(
  status: number | null,
): ProviderContractStatusBand {
  if (status === null) return "UNKNOWN";
  if (status >= 200 && status < 300) return "SUCCESS";
  if (status >= 300 && status < 400) return "REDIRECT";
  if (status >= 400 && status < 500) return "CLIENT_ERROR";
  if (status >= 500 && status < 600) return "SERVER_ERROR";
  return "UNKNOWN";
}

function normalizeQueryKeys(keys: string[]) {
  return [
    ...new Set(
      keys.slice(0, 30).map((key): ProviderContractQueryKey => {
        const normalized = key
          .normalize("NFKC")
          .toLocaleLowerCase("en-US")
          .replace(/[^a-z0-9]/gu, "");
        if (["date", "day", "playdate"].includes(normalized)) return "DATE";
        if (["startdate", "fromdate", "begindate"].includes(normalized))
          return "START_DATE";
        if (["enddate", "todate"].includes(normalized)) return "END_DATE";
        if (
          ["players", "playercount", "party", "partysize"].includes(normalized)
        )
          return "PLAYERS";
        if (["holes", "holecount"].includes(normalized)) return "HOLES";
        if (["courseid", "course"].includes(normalized)) return "COURSE_ID";
        if (["facilityid", "facility"].includes(normalized))
          return "FACILITY_ID";
        if (["locationid", "location"].includes(normalized))
          return "LOCATION_ID";
        if (["timezone", "tz"].includes(normalized)) return "TIMEZONE";
        if (["limit", "pagesize"].includes(normalized)) return "LIMIT";
        if (["offset", "skip"].includes(normalized)) return "OFFSET";
        if (["page", "pagenumber"].includes(normalized)) return "PAGE";
        return "OTHER";
      }),
    ),
  ].sort();
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
