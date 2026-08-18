import {
  evaluateBrowserDiscoveryMonitoringGate,
  extractStructuredPhoneBookingEvidence,
  haveSamePublicWebsiteOrigin,
  isLegacyProphetPublicBookingLandingUrl,
  prioritizeBrowserDiscoveryLinks,
  type BrowserAccessBarrier,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";
import {
  getKnownProviderFamilyForHostname,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl
} from "@/lib/automation/provider-capabilities";
import {
  haveCompatibleOfficialPageCourseNames,
  haveCompatibleOfficialPageCourseNamesWithVerifiedLayout,
  isConflictingOfficialPageCourseIdentity,
  isOfficialOrganizationIdentityCorroboratedByUrl,
  normalizeOfficialPagePresentationIdentity
} from "@/lib/places/course-identity";

export type RawBrowserPageEvidence = {
  anchors: string[];
  accessControlDetected: boolean;
  identityCandidates?: string[];
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

export type RawBrowserFrameCandidate = {
  src: string | null;
  dataSrc: string | null;
  title: string | null;
  ariaLabel: string | null;
  baseUrl: string;
};

export type BrowserProbeExpectedDisposition = "ACTIONABLE"
  | "MANUAL_FINAL"
  | "IDENTITY_FINAL"
  | "TECHNICAL_FINAL";

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
  const selectedLooksLikeBooking = /\b(?:book|reserve|reservation|tee.?times?)\b/i.test(
    `${input.selectedLabel} ${selected.pathname}`
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
    label: input.selectedLabel.replace(/\s+/g, " ").trim() || "Book a tee time"
  };
}

const MAX_RAW_VISIBLE_TEXT_LENGTH = 100_000;
const MAX_PREPARED_VISIBLE_TEXT_LENGTH = 12_000;
const LEADING_VISIBLE_TEXT_LENGTH = 4_000;

export function buildBrowserFrameCandidates(
  candidates: RawBrowserFrameCandidate[]
) {
  const seen = new Set<string>();

  return candidates.flatMap((candidate) => {
    const source = [candidate.src, candidate.dataSrc].find(
      (value): value is string => Boolean(value?.trim())
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
      return [{
        url: url.toString(),
        label:
          candidate.title?.replace(/\s+/g, " ").trim() ||
          candidate.ariaLabel?.replace(/\s+/g, " ").trim() ||
          "Embedded tee-time booking"
      }];
    } catch {
      return [];
    }
  });
}

export function buildBrowserFrameCandidatesFromHtml(
  html: string,
  baseUrl: string
) {
  const readAttribute = (
    tag: string,
    name: "src" | "data-src" | "title" | "aria-label"
  ) => tag.match(
    new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, "i")
  )?.[2] ?? null;
  const candidates = (
    html.slice(0, 1_000_000).match(/<iframe\b[^>]*>/giu) ?? []
  )
    .slice(0, 50)
    .map((tag) => ({
      src: readAttribute(tag, "src"),
      dataSrc: readAttribute(tag, "data-src"),
      title: readAttribute(tag, "title"),
      ariaLabel: readAttribute(tag, "aria-label"),
      baseUrl
    }));

  return buildBrowserFrameCandidates(candidates);
}

export function buildBrowserWidgetCandidates(encodedConfigs: string[]) {
  const seen = new Set<string>();

  return encodedConfigs.slice(0, 50).flatMap((encodedConfig) => {
    try {
      const config = JSON.parse(
        Buffer.from(encodedConfig, "base64").toString("utf8")
      ) as Record<string, unknown>;
      const value = [config.baseURL, config.baseUrl].find(
        (candidate): candidate is string =>
          typeof candidate === "string" && Boolean(candidate.trim())
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
      return [{
        url: url.toString(),
        label: "Embedded tee-time booking"
      }];
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
    isProviderInfrastructureUrl(input.responseUrl)
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
        return family && isProviderPublicBookingLandingUrl(url)
          ? [family]
          : [];
      } catch {
        return [];
      }
    })
  );
  if (candidateFamilies.size === 0 || input.accessBarriers.length === 0) {
    return false;
  }

  return input.accessBarriers.every((barrier) => {
    try {
      const family = getKnownProviderFamilyForHostname(
        new URL(barrier.url).hostname
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
      /\btee\s*times?\b(?:\s*[.:;-]?\s*tee\s*times?)?\s+are\s+available\b[\s\S]{0,220}?\bcall\s*:?\s*(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/giu
    )
  ].map((match) => match[0]);
  const prioritized = [
    ...new Set(
      manualInstructionCandidates.length > 0
        ? manualInstructionCandidates
        : [normalized.slice(0, LEADING_VISIBLE_TEXT_LENGTH)]
    )
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PREPARED_VISIBLE_TEXT_LENGTH);

  return {
    manualInstructionCandidateFound: manualInstructionCandidates.length > 0,
    visibleText: prioritized
  };
}

export function prepareBrowserPageEvidence(
  evidence: RawBrowserPageEvidence,
  officialCourseName?: string
): PreparedBrowserPageEvidence {
  const linkCandidates = prioritizeBrowserDiscoveryLinks(
    evidence.linkCandidates,
    100
  );
  const structuredPhoneBookingEvidence =
    extractStructuredPhoneBookingEvidence(evidence.structuredActionScripts);
  const prioritizedVisibleText = prioritizeBrowserPageVisibleText(
    evidence.visibleText
  );

  return {
    anchors: linkCandidates.map(({ url }) => url),
    accessControlDetected: evidence.accessControlDetected,
    ...(evidence.identityCandidates?.length
      ? { identityCandidates: evidence.identityCandidates.slice(0, 50) }
      : {}),
    linkCandidates,
    scripts: evidence.scripts,
    structuredPhoneBookingEvidence,
    visibleText: [
      structuredPhoneBookingEvidence ||
      prioritizedVisibleText.manualInstructionCandidateFound
        ? officialCourseName
        : undefined,
      structuredPhoneBookingEvidence,
      prioritizedVisibleText.visibleText
    ]
      .filter(Boolean)
      .join("\n")
  };
}

export function finalizeBrowserEvidenceSnapshots(input: {
  course: Pick<
    BrowserDiscoveryEvidence,
    |
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
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
    destinationPageEvidence
  } = input;
  const sameOriginOfficialPageEvidence = [
    { url: landingPageUrl, evidence: landingPageEvidence },
    ...( haveSamePublicWebsiteOrigin(
    landingPageUrl, firstDestinationPageUrl
  )
    ? [ { url: firstDestinationPageUrl, evidence: firstDestinationPageEvidence }
        ]
    : []),
    ...( haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? [ {
          url: destinationPageUrl,
          evidence: destinationPageEvidence
        }]
      : [])
  ];
  const verifiedOfficialPageEvidence = [...sameOriginOfficialPageEvidence]
    .reverse()
    .find(( { url, evidence }) =>
      doesRenderedOfficialPageIdentifyCourse(url, evidence, course)
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
      : ""
  ].filter(
    (text, index, values) => Boolean(text) && values.indexOf(text) === index
  );
  const officialFullPageVisibleText = [
    landingPageEvidence.visibleText,
    haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? firstDestinationPageEvidence.visibleText
      : "",
    haveSamePublicWebsiteOrigin(landingPageUrl, destinationPageUrl)
      ? destinationPageEvidence.visibleText
      : ""
  ]
    .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index)
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
    destinationPageUrl
  )
    ? destinationPageEvidence.visibleText.slice(0, 12_000)
    : undefined;

  for (const url of [
    ...landingPageEvidence.anchors,
    ...landingPageEvidence.scripts,
    ...firstDestinationPageEvidence.anchors,
    ...firstDestinationPageEvidence.scripts,
    ...destinationPageEvidence.anchors,
    ...destinationPageEvidence.scripts
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
      ...destinationPageEvidence.linkCandidates
    ],
    officialPage: {
      url: officialPageEvidence.url,
      linkCandidates: officialPageEvidence.evidence.linkCandidates,
      ...(verifiedOfficialPageEvidence
        ? {
      courseName: course.courseName }
        : {}),
      visibleText: officialPageVisibleText
    },
    accessBarrierUrls: input.accessBarrierUrls,
    accessBarriers: input.accessBarriers,
    ...(bookingSurfaceText ? { bookingSurfaceText } : {}),
    visibleText: [
      landingPageEvidence.visibleText,
      firstDestinationPageEvidence.visibleText,
      destinationPageEvidence.visibleText
    ]
      .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index)
      .join("\n")
  };
}

function doesRenderedOfficialPageIdentifyCourse(
  pageUrl: string,
  evidence: PreparedBrowserPageEvidence,
  course: Pick<
    BrowserDiscoveryEvidence,
    "courseName" | "verifiedLayoutHoleCounts"
  >
) {
  const identityStatuses = (evidence.identityCandidates ?? []).map(
    (identity) => {
      const exactIdentityCandidates =
        getRenderedOfficialIdentityVariants(identity);
      const statuses = exactIdentityCandidates.map((candidate) => {
        if (
          haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
            course.courseName,
            candidate,
            course.verifiedLayoutHoleCounts
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
          candidate
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
    }
  );
  if (identityStatuses.includes("CONFLICT")) {
    return false;
  }
  if (identityStatuses.includes("MATCH")) {
    return true;
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
    return Boolean(
      pathIdentity &&
      haveCompatibleOfficialPageCourseNames(course.courseName, pathIdentity)
    );
  } catch {
    return false;
  }
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
        Boolean(candidate) && candidates.indexOf(candidate) === index
    );
}

export function buildBrowserProbeDecisionTrace(
  evidence: BrowserDiscoveryEvidence,
  discovery: BrowserDiscovery
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
      /\b(?:call|phone)\b[\s\S]{0,160}\b(?:book|reserve|schedule)\b[\s\S]{0,160}\btee\s*time\b/i
    )
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
    outcome: monitoringDisposition === "ACTIONABLE" ? "inspected" : "classified",
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
      evidence.officialPage?.courseName && evidence.officialPage.visibleText
    ),
    accessBarrierDetected: Boolean(evidence.accessBarriers?.length),
    publicProviderReadDetected: Boolean(evidence.successfulProviderUrls?.length)
  };
}

export function assertBrowserProbeExpectedDisposition(
  expected: BrowserProbeExpectedDisposition | undefined,
  traces: BrowserProbeDecisionTrace[]
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
        .join(", ")}: expected ${expected}.`
    );
  }
}
