import {
  evaluateBrowserDiscoveryMonitoringGate,
  extractStructuredPhoneBookingEvidence,
  haveSamePublicWebsiteOrigin,
  isEvidenceOnlyOfficialBookingAccountLink,
  isLegacyProphetPublicBookingLandingUrl,
  isSafeManualEvidenceUrl,
  prioritizeBrowserDiscoveryLinks,
  type BrowserAccessBarrier,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence,
  type BrowserRenderedAccessControl,
  type BrowserRetainedBookingTarget,
} from "@/lib/automation/browser-discovery";
import {
  getKnownProviderFamilyForHostname,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl,
} from "@/lib/automation/provider-capabilities";
import {
  haveCompatibleOfficialPageCourseNames,
  haveCompatibleOfficialPageCourseNamesWithVerifiedLayout,
  isConflictingOfficialPageCourseIdentity,
  isOfficialOrganizationIdentityCorroboratedByUrl,
  normalizeOfficialPagePresentationIdentity,
} from "@/lib/places/course-identity";

export type RawBrowserPageEvidence = {
  anchors: string[];
  accessControlDetected: boolean;
  managedProtectionTemplateDetected: boolean;
  managedProtectionDocumentDetected: boolean;
  identityCandidates?: string[];
  localityCandidates?: string[];
  providerExtractionText?: string;
  structuredActionScripts: string[];
  linkCandidates: Array<{ url: string; label: string }>;
  scripts: string[];
  visibleText: string;
};

export type PreparedBrowserPageEvidence = Omit<
  RawBrowserPageEvidence,
  "structuredActionScripts"
> & {
  structuredPhoneBookingEvidence: string;
};

export const MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS = 12;
export const MAX_BROWSER_INVESTIGATION_DEPTH = 2;
export const MAX_BROWSER_BOOKING_DESTINATION_VISITS = 3;

export type BrowserInvestigationMode = "RENDERED" | "INDEPENDENT";

export type BrowserCourseIdentityContext = {
  address?: string | null;
  city?: string | null;
  stateCode?: string | null;
  googlePlaceIdPresent?: boolean;
};

export type BrowserInvestigationAuditContext = {
  incidentCycle: number | null;
  runtimeVersion: string;
  observedAt: Date;
};

export type BrowserPageIdentityStatus = "MATCH" | "CONFLICT" | "UNKNOWN";

export type BrowserInvestigationPagePurpose =
  | "COURSE_IDENTITY"
  | "BOOKING"
  | "GOLF_INFORMATION"
  | "PUBLIC_ACCESS"
  | "MEMBERSHIP"
  | "FAQ"
  | "CONTACT"
  | "OTHER";

export type BrowserInvestigationLink = {
  url: string;
  label: string;
  purpose: BrowserInvestigationPagePurpose;
};

export type BrowserInvestigationPageVisit = {
  requestedUrl: string;
  finalUrl: string;
  label: string;
  depth: number;
  parentUrl: string | null;
  requiresDirectIdentityMatch?: boolean;
  interactionBlocked: boolean;
  deferredBookingUrl?: string | null;
  evidence: PreparedBrowserPageEvidence;
  observedUrls?: string[];
  successfulProviderUrls?: string[];
  teeItUpFacilityResponses?: NonNullable<
    BrowserDiscoveryEvidence["teeItUpFacilityResponses"]
  >;
  accessBarriers?: BrowserAccessBarrier[];
  networkContracts?: BrowserNetworkContractFingerprint[];
  restrictedNetworkObserved?: boolean;
};

export type BrowserBookingDestinationVisit = {
  sourcePageUrl: string | null;
  requestedUrl: string;
  finalUrl: string;
  label: string;
  courseScoped: boolean;
  interactionBlocked: boolean;
  evidence: PreparedBrowserPageEvidence;
  observedUrls?: string[];
  successfulProviderUrls?: string[];
  teeItUpFacilityResponses?: NonNullable<
    BrowserDiscoveryEvidence["teeItUpFacilityResponses"]
  >;
  accessBarriers?: BrowserAccessBarrier[];
  networkContracts?: BrowserNetworkContractFingerprint[];
  restrictedNetworkObserved?: boolean;
};

export type BrowserNetworkContractFingerprint = {
  origin: string;
  method: string;
  pathPattern: string;
  queryKeys: string[];
  resourceType: string;
  status: number | null;
};

export type BrowserInvestigationAudit = {
  mode: BrowserInvestigationMode;
  incidentCycle: number | null;
  runtimeVersion: string;
  observedAt: string;
  // Added only at persistence, after the guarded course projection has
  // produced the exact provider snapshot this observation describes.
  providerSnapshotFingerprint?: string;
  limits: {
    maxSameOriginPages: typeof MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS;
    maxDepth: typeof MAX_BROWSER_INVESTIGATION_DEPTH;
    maxBookingDestinations: typeof MAX_BROWSER_BOOKING_DESTINATION_VISITS;
  };
  retainedInputs: {
    officialWebsite: string | null;
    sourceUrl: string;
    bookingUrl: string | null;
  };
  identityAuthority: {
    source:
      | "RETAINED_OFFICIAL_WEBSITE"
      | "RETAINED_COURSE_SOURCE"
      | "UNPROJECTED_OWNER_SOURCE_CANDIDATE";
    renderedSignals: ["TITLE", "H1", "URL_PATH"];
    localityEvidencePresent: boolean;
    placeEvidencePresent: boolean;
  };
  sameOriginPages: Array<{
    requestedUrl: string;
    finalUrl: string;
    depth: number;
    purpose: BrowserInvestigationPagePurpose;
    identityStatus: BrowserPageIdentityStatus;
    localityCorroborated: boolean;
    trustedForCourse: boolean;
    interactionBlocked: boolean;
  }>;
  bookingDestinations: Array<{
    requestedUrl: string;
    finalUrl: string;
    courseScoped: boolean;
    interactionBlocked: boolean;
  }>;
  restrictedNetworkObserved?: boolean;
  networkContracts: BrowserNetworkContractFingerprint[];
};

export type BrowserInvestigationEvidence = BrowserDiscoveryEvidence & {
  browserInvestigation: BrowserInvestigationAudit;
  persistableVisibleText: string;
};

export type RawBrowserButtonCandidate = {
  label: string;
  type: string | null;
  disabled: boolean;
  insideForm: boolean;
  dataHref: string | null;
  dataUrl: string | null;
  onClick: string | null;
  baseUrl: string;
};

export type RawBrowserFrameCandidate = {
  src: string | null;
  dataSrc: string | null;
  title: string | null;
  ariaLabel: string | null;
  baseUrl: string;
};

export type BrowserProbeExpectedDisposition =
  "ACTIONABLE" | "MANUAL_FINAL" | "IDENTITY_FINAL" | "TECHNICAL_FINAL";

export type BrowserProbeDecisionTrace = {
  outcome: "classified" | "inspected";
  reasonCode:
    | "MANUAL_CLASSIFICATION_READY"
    | "IDENTITY_CLASSIFICATION_READY"
    | "TECHNICAL_CLASSIFICATION_READY"
    | "RUNNABLE_METADATA_LEARNED"
    | "STRUCTURED_PHONE_ACTION_NOT_CLASSIFIED"
    | "NO_REUSABLE_PROVIDER_SIGNAL"
    | "ACTIONABLE_EVIDENCE";
  status: BrowserDiscovery["status"];
  detectedPlatform: BrowserDiscovery["detectedPlatform"];
  monitoringDisposition: BrowserProbeExpectedDisposition;
  confidenceBand: "LOW" | "MEDIUM" | "HIGH";
  structuredPhoneActionFound: boolean;
  officialPageContextPresent: boolean;
  accessBarrierDetected: boolean;
  publicProviderReadDetected: boolean;
};

export function buildRedirectedProviderBookingCandidate(input: {
  officialPageUrl: string;
  selectedUrl: string;
  selectedLabel: string;
  destinationUrl: string;
}) {
  let officialPage: URL;
  let selected: URL;
  let destination: URL;
  try {
    officialPage = new URL(input.officialPageUrl);
    selected = new URL(input.selectedUrl);
    destination = new URL(input.destinationUrl);
  } catch {
    return null;
  }

  const officialHostname = officialPage.hostname
    .toLocaleLowerCase("en-US")
    .replace(/^www\./u, "");
  const selectedHostname = selected.hostname
    .toLocaleLowerCase("en-US")
    .replace(/^www\./u, "");
  const selectedBelongsToOfficialWebsite =
    selectedHostname === officialHostname ||
    selectedHostname.endsWith(`.${officialHostname}`);
  const selectedLooksLikeBooking =
    /\b(?:book|reserve|reservation|tee.?times?)\b/i.test(
      `${input.selectedLabel} ${selected.pathname}`,
    );

  if (
    !["http:", "https:"].includes(officialPage.protocol) ||
    !["http:", "https:"].includes(selected.protocol) ||
    officialPage.username ||
    officialPage.password ||
    selected.username ||
    selected.password ||
    !selectedBelongsToOfficialWebsite ||
    !selectedLooksLikeBooking ||
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password ||
    destination.port ||
    !getKnownProviderFamilyForHostname(destination.hostname) ||
    !isProviderPublicBookingLandingUrl(destination) ||
    destination.toString() === selected.toString()
  ) {
    return null;
  }

  return {
    url: destination.toString(),
    label: input.selectedLabel.replace(/\s+/g, " ").trim() || "Book a tee time",
  };
}

const MAX_RAW_VISIBLE_TEXT_LENGTH = 100_000;
const MAX_PREPARED_VISIBLE_TEXT_LENGTH = 12_000;
const LEADING_VISIBLE_TEXT_LENGTH = 4_000;

export function buildBrowserFrameCandidates(
  candidates: RawBrowserFrameCandidate[],
) {
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    const source = [candidate.src, candidate.dataSrc].find(
      (value): value is string => Boolean(value?.trim()),
    );
    if (!source) {
      return [];
    }

    try {
      const url = new URL(source, candidate.baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        seen.has(url.toString())
      ) {
        return [];
      }
      seen.add(url.toString());
      return [
        {
          url: url.toString(),
          label:
            candidate.title?.replace(/\s+/g, " ").trim() ||
            candidate.ariaLabel?.replace(/\s+/g, " ").trim() ||
            "Embedded tee-time booking",
        },
      ];
    } catch {
      return [];
    }
  });
}

export function buildBrowserButtonCandidates(
  candidates: RawBrowserButtonCandidate[],
) {
  const seen = new Set<string>();

  return candidates.slice(0, 100).flatMap((candidate) => {
    const label = candidate.label.replace(/\s+/gu, " ").trim().slice(0, 200);
    const type = candidate.type?.trim().toLocaleLowerCase("en-US") ?? "";
    if (
      candidate.disabled ||
      type === "submit" ||
      type === "reset" ||
      (candidate.insideForm && type !== "button") ||
      !/\b(?:book|find|search|view|check)\b[\s\S]{0,80}\btee\s*times?\b|\btee\s*times?\b[\s\S]{0,80}\b(?:book|find|search|view|check)\b/iu.test(
        label,
      ) ||
      /\b(?:checkout|purchase|pay|confirm|complete|submit|reserve|hold|cart)\b/iu.test(
        label,
      )
    ) {
      return [];
    }

    const inlineDestination = candidate.onClick?.match(
      /(?:window\.)?location(?:\.href)?\s*=\s*(["'])(.*?)\1/iu,
    )?.[2];
    const destination = [candidate.dataHref, candidate.dataUrl, inlineDestination]
      .find((value): value is string => Boolean(value?.trim()));
    if (!destination) {
      return [];
    }

    try {
      const url = new URL(destination, candidate.baseUrl);
      url.hash = "";
      if (
        !isSafeManualEvidenceUrl(url) ||
        seen.has(url.toString()) ||
        isEvidenceOnlyOfficialBookingAccountLink(
          { url: url.toString(), label },
          candidate.baseUrl,
        )
      ) {
        return [];
      }
      seen.add(url.toString());
      return [{ url: url.toString(), label }];
    } catch {
      return [];
    }
  });
}

export function sanitizeBrowserAuditUrl(value: string) {
  try {
    const url = new URL(value);
    if (!isSafeManualEvidenceUrl(url)) {
      return null;
    }
    const queryKeys = [
      ...new Set(
        [...url.searchParams.keys()]
          .map((key) => key.normalize("NFKC").replace(/[^a-z0-9_.-]/giu, ""))
          .filter(Boolean)
          .map((key) => key.slice(0, 64)),
      ),
    ].sort();
    url.search = "";
    url.hash = "";
    for (const key of queryKeys.slice(0, 20)) {
      url.searchParams.append(key, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

export function buildBrowserFrameCandidatesFromHtml(
  html: string,
  baseUrl: string,
) {
  const readAttribute = (
    tag: string,
    name: "src" | "data-src" | "title" | "aria-label",
  ) =>
    tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] ??
    null;
  const candidates = (
    html.slice(0, 1_000_000).match(/<iframe\b[^>]*>/giu) ?? []
  )
    .slice(0, 50)
    .map((tag) => ({
      src: readAttribute(tag, "src"),
      dataSrc: readAttribute(tag, "data-src"),
      title: readAttribute(tag, "title"),
      ariaLabel: readAttribute(tag, "aria-label"),
      baseUrl,
    }));

  return buildBrowserFrameCandidates(candidates);
}

export function buildBrowserWidgetCandidates(encodedConfigs: string[]) {
  const seen = new Set<string>();

  return encodedConfigs.slice(0, 50).flatMap((encodedConfig) => {
    try {
      const config = JSON.parse(
        Buffer.from(encodedConfig, "base64").toString("utf8"),
      ) as Record<string, unknown>;
      const value = [config.baseURL, config.baseUrl].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && Boolean(candidate.trim()),
      );
      if (!value) {
        return [];
      }

      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        (!isLegacyProphetPublicBookingLandingUrl(url) &&
          !isProviderPublicBookingLandingUrl(url)) ||
        seen.has(url.toString())
      ) {
        return [];
      }

      seen.add(url.toString());
      return [
        {
          url: url.toString(),
          label: "Embedded tee-time booking",
        },
      ];
    } catch {
      return [];
    }
  });
}

export function isRelevantBrowserAccessBarrierUrl(input: {
  responseUrl: string;
  currentPageUrl: string;
  officialSourceUrl: string;
}) {
  let responseHost = "";
  try {
    responseHost = new URL(input.responseUrl).hostname;
  } catch {
    return true;
  }
  return Boolean(
    haveSamePublicWebsiteOrigin(input.responseUrl, input.currentPageUrl) ||
    haveSamePublicWebsiteOrigin(input.responseUrl, input.officialSourceUrl) ||
    responseHost === "phx-api-be-east-1b.kenna.io" ||
    isProviderInfrastructureUrl(input.responseUrl),
  );
}

export function hasDistinctProviderBookingCandidate(input: {
  linkCandidates: Array<{ url: string; label: string }>;
  accessBarriers: BrowserAccessBarrier[];
}) {
  const candidateFamilies = new Set(
    input.linkCandidates.flatMap((candidate) => {
      try {
        const url = new URL(candidate.url);
        const family = getKnownProviderFamilyForHostname(url.hostname);
        return family && isProviderPublicBookingLandingUrl(url) ? [family] : [];
      } catch {
        return [];
      }
    }),
  );
  if (candidateFamilies.size === 0 || input.accessBarriers.length === 0) {
    return false;
  }

  return input.accessBarriers.every((barrier) => {
    try {
      const family = getKnownProviderFamilyForHostname(
        new URL(barrier.url).hostname,
      );
      return Boolean(family && !candidateFamilies.has(family));
    } catch {
      return false;
    }
  });
}

export function prioritizeBrowserPageVisibleText(value: string) {
  const normalized = value
    .slice(0, MAX_RAW_VISIBLE_TEXT_LENGTH)
    .replace(/\s+/g, " ")
    .trim();
  const manualInstructionCandidates = [
    ...normalized.matchAll(
      /\btee\s*times?\b(?:\s*[.:;-]?\s*tee\s*times?)?\s+are\s+available\b[\s\S]{0,220}?\bcall\s*:?\s*(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/giu,
    ),
  ].map((match) => match[0]);
  const prioritized = [
    ...new Set(
      manualInstructionCandidates.length > 0
        ? manualInstructionCandidates
        : [normalized.slice(0, LEADING_VISIBLE_TEXT_LENGTH)],
    ),
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PREPARED_VISIBLE_TEXT_LENGTH);

  return {
    manualInstructionCandidateFound: manualInstructionCandidates.length > 0,
    visibleText: prioritized,
  };
}

export function prepareBrowserPageEvidence(
  evidence: RawBrowserPageEvidence,
  officialCourseName?: string,
): PreparedBrowserPageEvidence {
  const managedProtectionTemplateDetected =
    evidence.managedProtectionTemplateDetected ||
    evidence.managedProtectionDocumentDetected;
  const managedProtectionDocumentDetected =
    evidence.managedProtectionDocumentDetected;
  const linkCandidates = managedProtectionTemplateDetected
    ? []
    : prioritizeBrowserDiscoveryLinks(evidence.linkCandidates, 100);
  const structuredPhoneBookingEvidence = managedProtectionTemplateDetected
    ? ""
    : extractStructuredPhoneBookingEvidence(evidence.structuredActionScripts);
  const prioritizedVisibleText = managedProtectionTemplateDetected
    ? { manualInstructionCandidateFound: false, visibleText: "" }
    : prioritizeBrowserPageVisibleText(evidence.visibleText);

  return {
    anchors: linkCandidates.map(({ url }) => url),
    accessControlDetected: evidence.accessControlDetected,
    managedProtectionTemplateDetected,
    managedProtectionDocumentDetected,
    ...(!managedProtectionTemplateDetected && evidence.identityCandidates?.length
      ? { identityCandidates: evidence.identityCandidates.slice(0, 50) }
      : {}),
    ...(!managedProtectionTemplateDetected && evidence.localityCandidates?.length
      ? { localityCandidates: evidence.localityCandidates.slice(0, 50) }
      : {}),
    ...(!managedProtectionTemplateDetected && evidence.providerExtractionText
      ? { providerExtractionText: evidence.providerExtractionText.slice(0, 16_000) }
      : {}),
    linkCandidates,
    scripts: managedProtectionTemplateDetected ? [] : evidence.scripts,
    structuredPhoneBookingEvidence,
    visibleText: [
      structuredPhoneBookingEvidence ||
      prioritizedVisibleText.manualInstructionCandidateFound
        ? officialCourseName
        : undefined,
      structuredPhoneBookingEvidence,
      prioritizedVisibleText.visibleText,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export function planBrowserInvestigationLinks(input: {
  pageUrl: string;
  officialPageUrl: string;
  courseName: string;
  sourceTrustedForCourse: boolean;
  candidates: Array<{ url: string; label: string }>;
}) {
  const seen = new Set<string>();
  const planned = input.candidates.flatMap((candidate, index) => {
    let url: URL;
    try {
      url = new URL(candidate.url, input.pageUrl);
      url.hash = "";
    } catch {
      return [];
    }
    const normalizedUrl = url.toString();
    if (
      seen.has(normalizedUrl) ||
      !isSafeManualEvidenceUrl(url) ||
      isEvidenceOnlyOfficialBookingAccountLink(
        { url: normalizedUrl, label: candidate.label },
        input.officialPageUrl,
      )
    ) {
      return [];
    }
    seen.add(normalizedUrl);

    const purpose = getBrowserInvestigationPagePurpose(
      `${candidate.label} ${url.pathname}`,
    );
    const sameOrigin = haveSamePublicWebsiteOrigin(
      input.officialPageUrl,
      normalizedUrl,
    );
    const bookingSignal = purpose === "BOOKING";
    const courseLabelScoped = doesLinkLabelIdentifyCourse(
      candidate.label,
      input.courseName,
    );
    if (
      !sameOrigin &&
      (!bookingSignal || (!input.sourceTrustedForCourse && !courseLabelScoped))
    ) {
      return [];
    }
    if (sameOrigin && purpose === "OTHER" && !courseLabelScoped) {
      return [];
    }

    const purposePriority: Record<BrowserInvestigationPagePurpose, number> = {
      BOOKING: 80,
      COURSE_IDENTITY: 70,
      PUBLIC_ACCESS: 60,
      GOLF_INFORMATION: 50,
      MEMBERSHIP: 40,
      FAQ: 30,
      CONTACT: 20,
      OTHER: 0,
    };
    return [
      {
        link: {
          url: normalizedUrl,
          label: candidate.label.replace(/\s+/gu, " ").trim().slice(0, 200),
          purpose,
        } satisfies BrowserInvestigationLink,
        sameOrigin,
        score:
          purposePriority[purpose] +
          (courseLabelScoped ? 100 : 0) +
          (input.sourceTrustedForCourse ? 10 : 0),
        index,
      },
    ];
  });

  const ordered = planned.sort(
    (left, right) => right.score - left.score || left.index - right.index,
  );
  return {
    sameOriginPages: ordered
      .filter(
        (candidate) =>
          candidate.sameOrigin && candidate.link.purpose !== "BOOKING",
      )
      .map(({ link }) => link),
    bookingDestinations: ordered
      .filter((candidate) => candidate.link.purpose === "BOOKING")
      .map(({ link }) => link),
  };
}

export function buildBrowserNetworkContractFingerprint(input: {
  url: string;
  method: string;
  resourceType: string;
  status?: number | null;
}): BrowserNetworkContractFingerprint | null {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return null;
  }
  if (!isSafeManualEvidenceUrl(url)) {
    return null;
  }

  const method = input.method
    .toUpperCase()
    .replace(/[^A-Z]/gu, "")
    .slice(0, 12);
  if (!method) {
    return null;
  }
  const pathPattern = `/${url.pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 20)
    .map(sanitizeNetworkPathSegment)
    .join("/")}`.slice(0, 500);
  const queryKeys = [
    ...new Set(
      [...url.searchParams.keys()]
        .map((key) => key.normalize("NFKC").replace(/[^a-z0-9_.-]/giu, ""))
        .filter(Boolean)
        .map((key) => key.slice(0, 64)),
    ),
  ]
    .sort()
    .slice(0, 20);
  const normalizedResourceType = input.resourceType
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9_-]/gu, "")
    .slice(0, 30);
  const status =
    Number.isInteger(input.status) &&
    Number(input.status) >= 100 &&
    Number(input.status) <= 599
      ? Number(input.status)
      : null;

  return {
    origin: url.origin,
    method,
    pathPattern: pathPattern || "/",
    queryKeys,
    resourceType: normalizedResourceType || "other",
    status,
  };
}

export function isRestrictedBrowserNetworkObservation(input: {
  url: string;
  method: string;
  resourceType: string;
}) {
  const classification = classifyBrowserNetworkContractRestriction(input);
  return classification.unsafeMethod || classification.unsafeUrlState;
}

export function classifyBrowserNetworkContractRestriction(
  input:
    | { url: string; method: string }
    | Pick<
        BrowserNetworkContractFingerprint,
        "origin" | "method" | "pathPattern" | "queryKeys"
      >,
) {
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(
    input.method.toUpperCase(),
  );
  const url = resolveBrowserNetworkRestrictionUrl(input);
  return {
    unsafeMethod,
    unsafeUrlState: !url || !isSafeManualEvidenceUrl(url),
  };
}

function resolveBrowserNetworkRestrictionUrl(
  input:
    | { url: string; method: string }
    | Pick<
        BrowserNetworkContractFingerprint,
        "origin" | "method" | "pathPattern" | "queryKeys"
      >,
) {
  try {
    if ("url" in input) {
      return new URL(input.url);
    }
    if (
      input.queryKeys.length > 20 ||
      input.queryKeys.some(
        (key) => !key || key.length > 64 || key.normalize("NFKC") !== key,
      )
    ) {
      return null;
    }
    const origin = new URL(input.origin);
    if (
      origin.origin !== input.origin ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !isSafeManualEvidenceUrl(origin)
    ) {
      return null;
    }
    const resolved = new URL(input.pathPattern, origin);
    if (resolved.origin !== origin.origin) {
      return null;
    }
    for (const key of input.queryKeys) {
      resolved.searchParams.append(key, "1");
    }
    return resolved;
  } catch {
    return null;
  }
}

export function finalizeBrowserInvestigationEvidence(input: {
  course: Pick<
    BrowserDiscoveryEvidence,
    | "courseId"
    | "courseName"
    | "sourceUrl"
    | "officialCourseWebsite"
    | "verifiedLayoutHoleCounts"
  > &
    BrowserCourseIdentityContext;
  mode: BrowserInvestigationMode;
  auditContext?: BrowserInvestigationAuditContext;
  retainedBookingUrl?: string | null;
  unprojectedSourceCandidate?: boolean;
  pageVisits: BrowserInvestigationPageVisit[];
  bookingDestinations: BrowserBookingDestinationVisit[];
}): BrowserInvestigationEvidence {
  const officialWebsite =
    input.course.officialCourseWebsite ?? input.course.sourceUrl;
  const auditOfficialWebsite =
    sanitizeBrowserAuditUrl(officialWebsite) ?? "about:blank";
  const pageVisits = input.pageVisits
    .filter((visit) =>
      haveSamePublicWebsiteOrigin(officialWebsite, visit.requestedUrl),
    )
    .slice(0, MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS);
  const bookingDestinations = input.bookingDestinations
    .filter((visit) => visit.courseScoped)
    .slice(0, MAX_BROWSER_BOOKING_DESTINATION_VISITS);
  const trustedByUrl = new Map<string, boolean>();
  const pageAssessments = pageVisits.map((visit) => {
    const identityStatus = classifyRenderedOfficialPageCourseIdentity(
      visit.finalUrl,
      visit.evidence,
      input.course,
    );
    const parentTrusted = visit.parentUrl
      ? trustedByUrl.get(visit.parentUrl) === true
      : false;
    const localityCorroborated = visit.requiresDirectIdentityMatch
      ? isRenderedUnprojectedSourceCandidateLocalityCorroborated(
          visit.evidence,
          input.course,
        )
      : isRenderedCourseLocalityCorroborated(visit.evidence, input.course);
    const trustedForCourse =
      (identityStatus === "MATCH" && localityCorroborated) ||
      (identityStatus === "UNKNOWN" && parentTrusted);
    trustedByUrl.set(visit.requestedUrl, trustedForCourse);
    trustedByUrl.set(visit.finalUrl, trustedForCourse);
    return {
      visit,
      identityStatus,
      localityCorroborated,
      trustedForCourse,
    };
  });
  const trustedPages = pageAssessments.filter(
    (assessment) => assessment.trustedForCourse,
  );
  const verifiedOfficialPage = trustedPages.find(
    (assessment) => assessment.identityStatus === "MATCH",
  );
  const sourceCandidateIdentityVerified = pageAssessments.some(
    ({ visit, identityStatus, localityCorroborated }) =>
      visit.requiresDirectIdentityMatch === true &&
      identityStatus === "MATCH" &&
      localityCorroborated,
  );
  const officialPage =
    verifiedOfficialPage ??
    trustedPages[0] ??
    pageAssessments.find(
      ({ visit }) => visit.requiresDirectIdentityMatch !== true,
    );
  const trustedOfficialLinks = trustedPages.flatMap(
    ({ visit }) =>
      visit.evidence.managedProtectionTemplateDetected
        ? []
        : visit.evidence.linkCandidates,
  );
  const allRenderedPageLinks = pageAssessments
    .filter(
      ({ visit, trustedForCourse }) =>
        !visit.evidence.managedProtectionTemplateDetected &&
        (visit.requiresDirectIdentityMatch !== true || trustedForCourse),
    )
    .flatMap(
      ({ visit }) => visit.evidence.linkCandidates,
    );
  const redirectedBookingLinks = bookingDestinations.flatMap((visit) => {
    const sourceTrusted = visit.sourcePageUrl
      ? trustedByUrl.get(visit.sourcePageUrl) === true
      : false;
    if (
      !sourceTrusted ||
      visit.interactionBlocked ||
      !looksLikeSafeBookingDestination(
        visit.finalUrl,
        visit.label,
        officialWebsite,
      )
    ) {
      return [];
    }
    return [{ url: visit.finalUrl, label: visit.label }];
  });
  const officialLinkCandidates = prioritizeBrowserDiscoveryLinks(
    deduplicateBrowserLinks([
      ...trustedOfficialLinks,
      ...redirectedBookingLinks,
    ]),
    100,
  );
  const renderedLinkCandidates = prioritizeBrowserDiscoveryLinks(
    deduplicateBrowserLinks([
      ...allRenderedPageLinks,
      ...redirectedBookingLinks,
    ]),
    100,
  );
  const officialStructuredPhoneBookingText = [
    ...new Set(
      trustedPages
        .map(({ visit }) => visit.evidence.structuredPhoneBookingEvidence)
        .filter(Boolean),
    ),
  ];
  const officialPageVisibleText = (
    officialStructuredPhoneBookingText.length > 0
      ? officialStructuredPhoneBookingText
          .map((text) => `${input.course.courseName}. ${text}`)
          .join("\n")
      : trustedPages
          .filter(
            ({ visit }) =>
              !visit.evidence.managedProtectionTemplateDetected,
          )
          .map(({ visit }) => visit.evidence.visibleText)
          .filter(
            (text, index, values) =>
              Boolean(text) && values.indexOf(text) === index,
          )
          .join("\n")
  ).slice(0, 12_000);
  const bookingSurfaceText = bookingDestinations
    .filter(
      (visit) =>
        !visit.evidence.managedProtectionTemplateDetected &&
        !haveSamePublicWebsiteOrigin(officialWebsite, visit.finalUrl),
    )
    .map((visit) => visit.evidence.visibleText)
    .filter(
      (text, index, values) => Boolean(text) && values.indexOf(text) === index,
    )
    .join("\n")
    .slice(0, 12_000);
  const providerExtractionText = [
    ...trustedPages
      .filter(({ visit }) => !visit.evidence.managedProtectionTemplateDetected)
      .map(({ visit }) => visit.evidence.providerExtractionText),
    ...bookingDestinations
      .filter((visit) => !visit.evidence.managedProtectionTemplateDetected)
      .map((visit) => visit.evidence.providerExtractionText),
  ]
    .filter(
      (text, index, values): text is string =>
        Boolean(text) && values.indexOf(text) === index,
    )
    .join("\n")
    .slice(0, 32_000);
  const persistableVisibleText = [officialPageVisibleText, bookingSurfaceText]
    .filter(Boolean)
    .join("\n")
    .slice(0, 12_000);
  const trustedObservations = [
    ...trustedPages.map(({ visit }) => visit),
    ...bookingDestinations,
  ];
  const contentBearingTrustedObservations = trustedObservations.filter(
    (visit) => !visit.evidence.managedProtectionTemplateDetected,
  );
  const observedUrls = uniqueBrowserUrls([
    input.course.sourceUrl,
    officialWebsite,
    ...contentBearingTrustedObservations.flatMap(
      (visit) => visit.observedUrls ?? [],
    ),
    ...trustedPages
      .filter(({ visit }) => !visit.evidence.managedProtectionTemplateDetected)
      .flatMap(({ visit }) => [
        ...visit.evidence.anchors,
        ...visit.evidence.scripts,
      ]),
    ...renderedLinkCandidates.map(({ url }) => url),
  ]);
  const successfulProviderUrls = uniqueBrowserUrls(
    contentBearingTrustedObservations.flatMap(
      (visit) => visit.successfulProviderUrls ?? [],
    ),
  );
  const teeItUpFacilityResponses = deduplicateTeeItUpResponses(
    contentBearingTrustedObservations.flatMap(
      (visit) => visit.teeItUpFacilityResponses ?? [],
    ),
  );
  const accessBarriers = deduplicateAccessBarriers([
    ...pageAssessments
      .filter(
        ({ visit, trustedForCourse }) =>
          trustedForCourse ||
          (visit.parentUrl === null &&
            visit.requiresDirectIdentityMatch !== true),
      )
      .flatMap(({ visit }) => retainVisitAccessBarriers(visit)),
    ...bookingDestinations.flatMap(retainVisitAccessBarriers),
  ]);
  const selectedBookingOrigins = new Set(
    bookingDestinations.flatMap((visit) => {
      try {
        return [
          new URL(visit.finalUrl).origin,
          new URL(visit.requestedUrl).origin,
        ];
      } catch {
        return [];
      }
    }),
  );
  const networkContracts = deduplicateNetworkContracts(
    contentBearingTrustedObservations.flatMap(
      (visit) => visit.networkContracts ?? [],
    ),
  )
    .filter(
      (contract) =>
        haveSamePublicWebsiteOrigin(officialWebsite, contract.origin) ||
        selectedBookingOrigins.has(contract.origin) ||
        isProviderInfrastructureUrl(contract.origin),
    )
    .slice(0, 80);
  const restrictedNetworkObserved =
    trustedObservations.some(
      (visit) =>
        visit.restrictedNetworkObserved === true ||
        visit.interactionBlocked ||
        visit.evidence.managedProtectionTemplateDetected,
    ) ||
    pageAssessments.some(
      ({ visit }) =>
        (visit.restrictedNetworkObserved === true ||
          visit.interactionBlocked ||
          visit.evidence.managedProtectionTemplateDetected) &&
        visit.parentUrl === null &&
        visit.requiresDirectIdentityMatch !== true &&
        [officialWebsite, input.course.sourceUrl].some((retainedUrl) =>
          haveSameExactBrowserNavigationInput(visit.requestedUrl, retainedUrl),
        ),
    );
  const renderedAccessControls = deduplicateRenderedAccessControls([
    ...pageAssessments.flatMap(({ visit }) => {
      if (
        !visit.evidence.managedProtectionDocumentDetected ||
        visit.parentUrl !== null ||
        visit.requiresDirectIdentityMatch === true ||
        ![officialWebsite, input.course.sourceUrl].some((retainedUrl) =>
          haveSameExactBrowserNavigationInput(visit.requestedUrl, retainedUrl),
        )
      ) {
        return [];
      }
      return buildRenderedAccessControl("RETAINED_ROOT", visit.requestedUrl);
    }),
    ...bookingDestinations.flatMap((visit) =>
      visit.evidence.managedProtectionDocumentDetected
        ? buildRenderedAccessControl(
            "COURSE_SCOPED_BOOKING",
            visit.requestedUrl,
          )
        : [],
    ),
  ]);
  const retainedBookingTarget = buildRetainedBookingTarget(
    input.retainedBookingUrl,
    bookingDestinations,
  );
  const finalUrl =
    [...bookingDestinations]
      .reverse()
      .find(
        (visit) =>
          !visit.interactionBlocked &&
          !visit.evidence.managedProtectionTemplateDetected,
      )?.finalUrl ??
    (officialPage &&
    !officialPage.visit.evidence.managedProtectionTemplateDetected
      ? officialPage.visit.finalUrl
      : undefined) ??
    input.course.sourceUrl;

  return {
    ...input.course,
    ...(input.unprojectedSourceCandidate
      ? {
          unprojectedSourceCandidate: true,
          sourceCandidateIdentityVerified,
        }
      : {}),
    sourceUrl:
      officialPage &&
      !officialPage.visit.evidence.managedProtectionTemplateDetected
        ? officialPage.visit.finalUrl
        : input.course.sourceUrl,
    finalUrl,
    observedUrls,
    successfulProviderUrls,
    ...(teeItUpFacilityResponses.length > 0
      ? { teeItUpFacilityResponses }
      : {}),
    linkCandidates: renderedLinkCandidates,
    ...(officialPage
      ? {
          officialPage: {
            url: officialPage.visit.evidence.managedProtectionTemplateDetected
              ? officialPage.visit.requestedUrl
              : officialPage.visit.finalUrl,
            linkCandidates: officialLinkCandidates,
            ...(verifiedOfficialPage
              ? { courseName: input.course.courseName }
              : {}),
            visibleText: officialPageVisibleText,
          },
        }
      : {}),
    accessBarrierUrls: accessBarriers.map(({ url }) => url),
    accessBarriers,
    ...(retainedBookingTarget ? { retainedBookingTarget } : {}),
    ...(renderedAccessControls.length > 0 ? { renderedAccessControls } : {}),
    ...(bookingSurfaceText ? { bookingSurfaceText } : {}),
    visibleText: [providerExtractionText, persistableVisibleText]
      .filter(Boolean)
      .join("\n"),
    persistableVisibleText,
    browserInvestigation: {
      mode: input.mode,
      incidentCycle: input.auditContext?.incidentCycle ?? null,
      runtimeVersion: sanitizeBrowserAuditRuntimeVersion(
        input.auditContext?.runtimeVersion ?? "diagnostic",
      ),
      observedAt: normalizeBrowserAuditObservedAt(
        input.auditContext?.observedAt,
      ),
      limits: {
        maxSameOriginPages: MAX_BROWSER_SAME_ORIGIN_PAGE_VISITS,
        maxDepth: MAX_BROWSER_INVESTIGATION_DEPTH,
        maxBookingDestinations: MAX_BROWSER_BOOKING_DESTINATION_VISITS,
      },
      retainedInputs: {
        officialWebsite: input.course.officialCourseWebsite
          ? sanitizeBrowserAuditUrl(input.course.officialCourseWebsite)
          : null,
        sourceUrl:
          sanitizeBrowserAuditUrl(input.course.sourceUrl) ??
          auditOfficialWebsite,
        bookingUrl: input.retainedBookingUrl
          ? sanitizeBrowserAuditUrl(input.retainedBookingUrl)
          : null,
      },
      identityAuthority: {
        source: input.unprojectedSourceCandidate
          ? "UNPROJECTED_OWNER_SOURCE_CANDIDATE"
          : input.course.officialCourseWebsite
            ? "RETAINED_OFFICIAL_WEBSITE"
            : "RETAINED_COURSE_SOURCE",
        renderedSignals: ["TITLE", "H1", "URL_PATH"],
        localityEvidencePresent: hasBrowserCourseLocality(input.course),
        placeEvidencePresent: input.course.googlePlaceIdPresent === true,
      },
      sameOriginPages: pageAssessments.map(
        ({ visit, identityStatus, localityCorroborated, trustedForCourse }) => ({
          requestedUrl:
            sanitizeBrowserAuditUrl(visit.requestedUrl) ?? auditOfficialWebsite,
          finalUrl:
            sanitizeBrowserAuditUrl(
              visit.evidence.managedProtectionTemplateDetected
                ? visit.requestedUrl
                : visit.finalUrl,
            ) ?? auditOfficialWebsite,
          depth: visit.depth,
          purpose: getBrowserInvestigationPagePurpose(
            `${visit.label} ${visit.requestedUrl}`,
          ),
          identityStatus,
          localityCorroborated,
          trustedForCourse,
          interactionBlocked: visit.interactionBlocked,
        }),
      ),
      bookingDestinations: bookingDestinations.map((visit) => ({
        requestedUrl:
          sanitizeBrowserAuditUrl(visit.requestedUrl) ?? auditOfficialWebsite,
        finalUrl:
          sanitizeBrowserAuditUrl(
            visit.evidence.managedProtectionTemplateDetected
              ? visit.requestedUrl
              : visit.finalUrl,
          ) ?? auditOfficialWebsite,
        courseScoped: visit.courseScoped,
        interactionBlocked: visit.interactionBlocked,
      })),
      restrictedNetworkObserved,
      networkContracts,
    },
  };
}

function buildRenderedAccessControl(
  scope: BrowserRenderedAccessControl["scope"],
  value: string,
): BrowserRenderedAccessControl[] {
  try {
    const url = new URL(value);
    if (!isSafeManualEvidenceUrl(url)) {
      return [];
    }
    url.search = "";
    url.hash = "";
    return [{ kind: "MANAGED_PROTECTION_DOCUMENT", scope, url: url.toString() }];
  } catch {
    return [];
  }
}

function buildRetainedBookingTarget(
  retainedBookingUrl: string | null | undefined,
  bookingDestinations: BrowserBookingDestinationVisit[],
): BrowserRetainedBookingTarget | null {
  if (
    !retainedBookingUrl ||
    !bookingDestinations.some(
      (visit) =>
        visit.courseScoped &&
        haveSameExactBrowserNavigationInput(
          visit.requestedUrl,
          retainedBookingUrl,
        ),
    )
  ) {
    return null;
  }
  try {
    const url = new URL(retainedBookingUrl);
    if (!isSafeManualEvidenceUrl(url)) {
      return null;
    }
    return {
      kind: "RETAINED_COURSE_BOOKING_TARGET",
      url: retainedBookingUrl,
    };
  } catch {
    return null;
  }
}

function deduplicateRenderedAccessControls(
  controls: BrowserRenderedAccessControl[],
) {
  const seen = new Set<string>();
  return controls
    .filter((control) => {
      const key = `${control.kind}:${control.scope}:${control.url}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 4);
}

function haveSameExactBrowserNavigationInput(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.toString() === rightUrl.toString();
  } catch {
    return false;
  }
}

function sanitizeNetworkPathSegment(segment: string) {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return ":value";
  }
  if (/^\d+$/u.test(decoded)) {
    return ":number";
  }
  if (/^\d{4}-\d{2}-\d{2}(?:t.*)?$/iu.test(decoded)) {
    return ":date";
  }
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      decoded,
    )
  ) {
    return ":uuid";
  }
  if (
    decoded.length > 80 ||
    /^[0-9a-f]{12,}$/iu.test(decoded) ||
    /^[a-z0-9_-]{24,}$/iu.test(decoded) ||
    decoded.includes("@")
  ) {
    return ":id";
  }
  return encodeURIComponent(decoded.toLocaleLowerCase("en-US")).slice(0, 100);
}

function getBrowserInvestigationPagePurpose(
  value: string,
): BrowserInvestigationPagePurpose {
  const normalized = value.normalize("NFKC").replace(/[_-]+/gu, " ");
  if (/\b(?:book|reserve|reservation|tee\s*times?)\b/iu.test(normalized)) {
    return "BOOKING";
  }
  if (
    /\b(?:public|municipal|daily\s*fee|open\s*to\s*the\s*public)\b/iu.test(
      normalized,
    )
  ) {
    return "PUBLIC_ACCESS";
  }
  if (
    /\b(?:member|membership|private\s*club|guest\s*policy)\b/iu.test(normalized)
  ) {
    return "MEMBERSHIP";
  }
  if (
    /\b(?:golf|course|rates?|green\s*fees?|hours?|polic(?:y|ies))\b/iu.test(
      normalized,
    )
  ) {
    return "GOLF_INFORMATION";
  }
  if (
    /\b(?:faq|frequently\s*asked|instructions?|how\s*to)\b/iu.test(normalized)
  ) {
    return "FAQ";
  }
  if (/\b(?:contact|phone|call|directions?|about)\b/iu.test(normalized)) {
    return "CONTACT";
  }
  return "OTHER";
}

function doesLinkLabelIdentifyCourse(label: string, courseName: string) {
  const stripped = label
    .replace(
      /\b(?:book|reserve|reservation|view|find|search|check|online|tee\s*times?)\b/giu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return Boolean(
    stripped && haveCompatibleOfficialPageCourseNames(courseName, stripped),
  );
}

function looksLikeSafeBookingDestination(
  destinationUrl: string,
  label: string,
  officialWebsite: string,
) {
  try {
    const url = new URL(destinationUrl);
    return Boolean(
      isSafeManualEvidenceUrl(url) &&
      !isEvidenceOnlyOfficialBookingAccountLink(
        { url: destinationUrl, label },
        officialWebsite,
      ) &&
      /\b(?:book|reserve|reservation|tee.?times?)\b/iu.test(
        `${label} ${url.pathname}`,
      ),
    );
  } catch {
    return false;
  }
}

function deduplicateBrowserLinks(links: Array<{ url: string; label: string }>) {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) {
      return false;
    }
    seen.add(link.url);
    return true;
  });
}

function uniqueBrowserUrls(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function deduplicateTeeItUpResponses(
  responses: NonNullable<BrowserDiscoveryEvidence["teeItUpFacilityResponses"]>,
) {
  const seen = new Set<string>();
  return responses.filter((response) => {
    const key = `${response.url}:${response.alias}:${response.facilityIds.join(",")}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateAccessBarriers(barriers: BrowserAccessBarrier[]) {
  const seen = new Set<string>();
  return barriers.filter((barrier) => {
    const key = `${barrier.status}:${barrier.url}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function retainVisitAccessBarriers(visit: {
  requestedUrl: string;
  finalUrl: string;
  evidence: PreparedBrowserPageEvidence;
  accessBarriers?: BrowserAccessBarrier[];
}) {
  const barriers = visit.accessBarriers ?? [];
  if (!visit.evidence.managedProtectionTemplateDetected) {
    return barriers;
  }
  return barriers.filter((barrier) =>
    [visit.requestedUrl, visit.finalUrl].some((documentUrl) =>
      haveSameExactBrowserNavigationInput(barrier.url, documentUrl),
    ),
  );
}

function deduplicateNetworkContracts(
  contracts: BrowserNetworkContractFingerprint[],
) {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = JSON.stringify(contract);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function finalizeBrowserEvidenceSnapshots(input: {
  course: Pick<
    BrowserDiscoveryEvidence,
    | "courseId"
    | "courseName"
    | "sourceUrl"
    | "officialCourseWebsite"
    | "verifiedLayoutHoleCounts"
  >;
  finalUrl: string;
  observedUrls: string[];
  successfulProviderUrls: string[];
  teeItUpFacilityResponses?: NonNullable<
    BrowserDiscoveryEvidence["teeItUpFacilityResponses"]
  >;
  accessBarrierUrls: string[];
  accessBarriers: BrowserAccessBarrier[];
  landingPageUrl: string;
  landingPageEvidence: PreparedBrowserPageEvidence;
  firstDestinationPageUrl: string;
  firstDestinationPageEvidence: PreparedBrowserPageEvidence;
  destinationPageUrl: string;
  destinationPageEvidence: PreparedBrowserPageEvidence;
}): BrowserDiscoveryEvidence {
  const {
    course,
    landingPageUrl,
    landingPageEvidence,
    firstDestinationPageUrl,
    firstDestinationPageEvidence,
    destinationPageUrl,
    destinationPageEvidence,
  } = input;
  const sameOriginOfficialPageEvidence = [
    { url: landingPageUrl, evidence: landingPageEvidence },
    ...(haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? [
          {
            url: firstDestinationPageUrl,
            evidence: firstDestinationPageEvidence,
          },
        ]
      : []),
    ...(haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? [
          {
            url: destinationPageUrl,
            evidence: destinationPageEvidence,
          },
        ]
      : []),
  ];
  const verifiedOfficialPageEvidence = [...sameOriginOfficialPageEvidence]
    .reverse()
    .find(({ url, evidence }) =>
      doesRenderedOfficialPageIdentifyCourse(url, evidence, course),
    );
  const officialPageEvidence =
    verifiedOfficialPageEvidence ?? sameOriginOfficialPageEvidence.at(-1)!;
  const officialStructuredPhoneBookingText = [
    landingPageEvidence.structuredPhoneBookingEvidence,
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? firstDestinationPageEvidence.structuredPhoneBookingEvidence
      : "",
    haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? destinationPageEvidence.structuredPhoneBookingEvidence
      : "",
  ].filter(
    (text, index, values) => Boolean(text) && values.indexOf(text) === index,
  );
  const officialFullPageVisibleText = [
    landingPageEvidence.visibleText,
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? firstDestinationPageEvidence.visibleText
      : "",
    haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? destinationPageEvidence.visibleText
      : "",
  ]
    .filter(
      (text, index, values) => Boolean(text) && values.indexOf(text) === index,
    )
    .join("\n");
  const officialPageVisibleText = (
    officialStructuredPhoneBookingText.length > 0
      ? officialStructuredPhoneBookingText
          .map((text) => `${course.courseName}. ${text}`)
          .join("\n")
      : officialFullPageVisibleText
  ).slice(0, 12_000);
  const observedUrls = new Set(input.observedUrls);
  const bookingSurfaceText = !haveSamePublicWebsiteOrigin(
    landingPageUrl,
    destinationPageUrl,
  )
    ? destinationPageEvidence.visibleText.slice(0, 12_000)
    : undefined;

  for (const url of [
    ...landingPageEvidence.anchors,
    ...landingPageEvidence.scripts,
    ...firstDestinationPageEvidence.anchors,
    ...firstDestinationPageEvidence.scripts,
    ...destinationPageEvidence.anchors,
    ...destinationPageEvidence.scripts,
  ]) {
    observedUrls.add(url);
  }

  return {
    ...course,
    sourceUrl: officialPageEvidence.url,
    finalUrl: input.finalUrl,
    observedUrls: [...observedUrls],
    successfulProviderUrls: input.successfulProviderUrls,
    ...(input.teeItUpFacilityResponses?.length
      ? { teeItUpFacilityResponses: input.teeItUpFacilityResponses }
      : {}),
    linkCandidates: [
      ...landingPageEvidence.linkCandidates,
      ...firstDestinationPageEvidence.linkCandidates,
      ...destinationPageEvidence.linkCandidates,
    ],
    officialPage: {
      url: officialPageEvidence.url,
      linkCandidates: officialPageEvidence.evidence.linkCandidates,
      ...(verifiedOfficialPageEvidence
        ? {
            courseName: course.courseName,
          }
        : {}),
      visibleText: officialPageVisibleText,
    },
    accessBarrierUrls: input.accessBarrierUrls,
    accessBarriers: input.accessBarriers,
    ...(bookingSurfaceText ? { bookingSurfaceText } : {}),
    visibleText: [
      landingPageEvidence.visibleText,
      firstDestinationPageEvidence.visibleText,
      destinationPageEvidence.visibleText,
    ]
      .filter(
        (text, index, values) =>
          Boolean(text) && values.indexOf(text) === index,
      )
      .join("\n"),
  };
}

export function classifyRenderedOfficialPageCourseIdentity(
  pageUrl: string,
  evidence: PreparedBrowserPageEvidence,
  course: Pick<
    BrowserDiscoveryEvidence,
    "courseName" | "verifiedLayoutHoleCounts"
  > &
    BrowserCourseIdentityContext,
): BrowserPageIdentityStatus {
  const localityCorroborated = isRenderedCourseLocalityCorroborated(
    evidence,
    course,
  );
  const permitIdentityMatch =
    !hasBrowserCourseLocality(course) || localityCorroborated;
  const identityStatuses = (evidence.identityCandidates ?? []).map(
    (identity) => {
      const exactIdentityCandidates =
        getRenderedOfficialIdentityVariants(identity);
      const statuses = exactIdentityCandidates.map((candidate) => {
        if (
          haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
            course.courseName,
            candidate,
            course.verifiedLayoutHoleCounts,
          )
        ) {
          return "MATCH" as const;
        }
        if (
          isOfficialOrganizationIdentityCorroboratedByUrl(candidate, pageUrl)
        ) {
          return "ABSENT" as const;
        }
        return isConflictingOfficialPageCourseIdentity(
          course.courseName,
          candidate,
        )
          ? ("CONFLICT" as const)
          : ("ABSENT" as const);
      });
      if (statuses.includes("CONFLICT")) {
        return "CONFLICT" as const;
      }
      return statuses.includes("MATCH")
        ? ("MATCH" as const)
        : ("ABSENT" as const);
    },
  );
  if (identityStatuses.includes("CONFLICT")) {
    return "CONFLICT";
  }
  if (identityStatuses.includes("MATCH")) {
    return permitIdentityMatch ? "MATCH" : "UNKNOWN";
  }
  try {
    const page = new URL(pageUrl);
    const pathIdentity = decodeURIComponent(page.pathname)
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.(?:html?|xhtml)$/iu, "")
      .replace(/[-_]+/gu, " ")
      .replace(/\btee\s*times?\b/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return pathIdentity &&
      haveCompatibleOfficialPageCourseNames(course.courseName, pathIdentity) &&
      permitIdentityMatch
      ? "MATCH"
      : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

export function hasBrowserCourseLocality(
  course: BrowserCourseIdentityContext,
) {
  return Boolean(
    course.address?.trim() || course.city?.trim() || course.stateCode?.trim(),
  );
}

export function isRenderedCourseLocalityCorroborated(
  evidence: Pick<
    PreparedBrowserPageEvidence,
    "visibleText" | "identityCandidates" | "localityCandidates"
  >,
  course: BrowserCourseIdentityContext,
) {
  if (!hasBrowserCourseLocality(course)) {
    return true;
  }
  const renderedLocalityEvidence = [
    ...(evidence.identityCandidates ?? []),
    ...(evidence.localityCandidates ?? []),
    evidence.visibleText,
  ];
  const normalizedEvidence = renderedLocalityEvidence
    .map(normalizeBrowserLocalityText)
    .filter(Boolean);
  const exactSignals = [course.address, course.city]
    .map((value) => normalizeBrowserLocalityText(value ?? ""))
    .filter((value) => value.length >= 3);
  if (
    exactSignals.some((signal) =>
      normalizedEvidence.some((candidate) =>
        ` ${candidate} `.includes(` ${signal} `),
      ),
    )
  ) {
    return true;
  }

  const stateCode = course.stateCode?.trim().toLocaleUpperCase("en-US") ?? "";
  return Boolean(
    /^[A-Z]{2}$/u.test(stateCode) &&
      renderedLocalityEvidence.some((candidate) =>
        new RegExp(`\\b${stateCode}\\b`, "u").test(candidate),
      ),
  );
}

export function isRenderedUnprojectedSourceCandidateLocalityCorroborated(
  evidence: Pick<
    PreparedBrowserPageEvidence,
    "visibleText" | "identityCandidates" | "localityCandidates"
  >,
  course: BrowserCourseIdentityContext,
) {
  const city = normalizeBrowserLocalityText(course.city ?? "");
  const stateCode = course.stateCode?.trim().toLocaleUpperCase("en-US") ?? "";
  if (!city || !/^[A-Z]{2}$/u.test(stateCode)) {
    return false;
  }
  const renderedLocalityEvidence = [
    ...(evidence.identityCandidates ?? []),
    ...(evidence.localityCandidates ?? []),
    evidence.visibleText,
  ];
  const normalizedEvidence = renderedLocalityEvidence
    .map(normalizeBrowserLocalityText)
    .filter(Boolean);
  const cityCorroborated = normalizedEvidence.some((candidate) =>
    containsNormalizedBrowserLocality(candidate, city),
  );
  const stateName = US_STATE_NAMES_BY_CODE[stateCode];
  const stateSignals = [stateCode.toLocaleLowerCase("en-US"), stateName]
    .map((value) => normalizeBrowserLocalityText(value ?? ""))
    .filter(Boolean);
  const stateCorroborated = stateSignals.some((signal) =>
    normalizedEvidence.some((candidate) =>
      containsNormalizedBrowserLocality(candidate, signal),
    ),
  );
  if (!cityCorroborated || !stateCorroborated) {
    return false;
  }

  const street = normalizeBrowserStreetText(course.address ?? "");
  if (!street) {
    return true;
  }
  return renderedLocalityEvidence
    .map(normalizeBrowserStreetText)
    .some((candidate) => containsNormalizedBrowserLocality(candidate, street));
}

const US_STATE_NAMES_BY_CODE: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

function containsNormalizedBrowserLocality(candidate: string, signal: string) {
  return Boolean(signal && ` ${candidate} `.includes(` ${signal} `));
}

function normalizeBrowserStreetText(value: string) {
  return normalizeBrowserLocalityText(value.split(",", 1)[0] ?? "")
    .replace(/\b(?:st|street)\b/gu, "street")
    .replace(/\b(?:rd|road)\b/gu, "road")
    .replace(/\b(?:ave|avenue)\b/gu, "avenue")
    .replace(/\b(?:blvd|boulevard)\b/gu, "boulevard")
    .replace(/\b(?:dr|drive)\b/gu, "drive")
    .replace(/\b(?:ln|lane)\b/gu, "lane")
    .replace(/\b(?:ct|court)\b/gu, "court")
    .replace(/\b(?:cir|circle)\b/gu, "circle")
    .replace(/\b(?:hwy|highway)\b/gu, "highway")
    .replace(/\b(?:pkwy|parkway)\b/gu, "parkway")
    .replace(/\b(?:rte|route)\b/gu, "route");
}

function normalizeBrowserLocalityText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function sanitizeBrowserAuditRuntimeVersion(value: string) {
  return (
    value
      .normalize("NFKC")
      .replace(/[^a-z0-9._-]/giu, "")
      .slice(0, 100) || "unknown"
  );
}

function normalizeBrowserAuditObservedAt(value?: Date) {
  const observedAt =
    value instanceof Date && Number.isFinite(value.getTime())
      ? value
      : new Date();
  return observedAt.toISOString();
}

function doesRenderedOfficialPageIdentifyCourse(
  pageUrl: string,
  evidence: PreparedBrowserPageEvidence,
  course: Pick<
    BrowserDiscoveryEvidence,
    "courseName" | "verifiedLayoutHoleCounts"
  > &
    BrowserCourseIdentityContext,
) {
  return (
    classifyRenderedOfficialPageCourseIdentity(pageUrl, evidence, course) ===
    "MATCH"
  );
}

function getRenderedOfficialIdentityVariants(identity: string) {
  const decoratedSegments = identity
    .split(/\s+(?:\||[–—]|-\s)\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const baseIdentities =
    decoratedSegments.length > 1 ? decoratedSegments : [identity];
  return baseIdentities
    .map(normalizeOfficialPagePresentationIdentity)
    .filter(
      (candidate, index, candidates): candidate is string =>
        Boolean(candidate) && candidates.indexOf(candidate) === index,
    );
}

export function buildBrowserProbeDecisionTrace(
  evidence: BrowserDiscoveryEvidence,
  discovery: BrowserDiscovery,
): BrowserProbeDecisionTrace {
  const observedDisposition =
    evaluateBrowserDiscoveryMonitoringGate(discovery).disposition;
  const monitoringDisposition: BrowserProbeExpectedDisposition =
    observedDisposition === "MANUAL_FINAL" ||
    observedDisposition === "IDENTITY_FINAL" ||
    observedDisposition === "TECHNICAL_FINAL"
      ? observedDisposition
      : "ACTIONABLE";
  const structuredPhoneActionFound = Boolean(
    evidence.officialPage?.visibleText?.match(
      /\b(?:call|phone)\b[\s\S]{0,160}\b(?:book|reserve|schedule)\b[\s\S]{0,160}\btee\s*time\b/i,
    ),
  );
  const reasonCode =
    monitoringDisposition === "MANUAL_FINAL"
      ? "MANUAL_CLASSIFICATION_READY"
      : monitoringDisposition === "IDENTITY_FINAL"
        ? "IDENTITY_CLASSIFICATION_READY"
        : monitoringDisposition === "TECHNICAL_FINAL"
          ? "TECHNICAL_CLASSIFICATION_READY"
          : discovery.status === "LEARNED"
            ? "RUNNABLE_METADATA_LEARNED"
            : structuredPhoneActionFound
              ? "STRUCTURED_PHONE_ACTION_NOT_CLASSIFIED"
              : discovery.evidence.learnedFrom === "browser-visible-links"
                ? "NO_REUSABLE_PROVIDER_SIGNAL"
                : "ACTIONABLE_EVIDENCE";

  return {
    outcome:
      monitoringDisposition === "ACTIONABLE" ? "inspected" : "classified",
    reasonCode,
    status: discovery.status,
    detectedPlatform: discovery.detectedPlatform,
    monitoringDisposition,
    confidenceBand:
      discovery.confidence >= 0.9
        ? "HIGH"
        : discovery.confidence >= 0.7
          ? "MEDIUM"
          : "LOW",
    structuredPhoneActionFound,
    officialPageContextPresent: Boolean(
      evidence.officialPage?.courseName && evidence.officialPage.visibleText,
    ),
    accessBarrierDetected: Boolean(evidence.accessBarriers?.length),
    publicProviderReadDetected: Boolean(
      evidence.successfulProviderUrls?.length,
    ),
  };
}

export function assertBrowserProbeExpectedDisposition(
  expected: BrowserProbeExpectedDisposition | undefined,
  traces: BrowserProbeDecisionTrace[],
) {
  if (!expected) {
    return;
  }
  const mismatched = traces
    .map((trace, index) => ({ trace, ordinal: index + 1 }))
    .filter(({ trace }) => trace.monitoringDisposition !== expected);
  if (mismatched.length > 0) {
    throw new Error(
      `Browser probe expectation failed for target ordinals ${mismatched
        .map(({ ordinal }) => ordinal)
        .join(", ")}: expected ${expected}.`,
    );
  }
}
