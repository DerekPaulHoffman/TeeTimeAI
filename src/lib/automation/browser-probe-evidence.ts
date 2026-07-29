import {
  evaluateBrowserDiscoveryMonitoringGate,
  extractStructuredPhoneBookingEvidence,
  haveSamePublicWebsiteOrigin,
  prioritizeBrowserDiscoveryLinks,
  type BrowserAccessBarrier,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";

export type RawBrowserPageEvidence = {
  anchors: string[];
  accessControlDetected: boolean;
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

export type BrowserProbeExpectedDisposition =
  | "ACTIONABLE"
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
};

const MAX_RAW_VISIBLE_TEXT_LENGTH = 100_000;
const MAX_PREPARED_VISIBLE_TEXT_LENGTH = 12_000;
const LEADING_VISIBLE_TEXT_LENGTH = 4_000;

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
    "courseId" | "courseName" | "sourceUrl" | "officialCourseWebsite"
  >;
  finalUrl: string;
  observedUrls: string[];
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
  const officialPageEvidence = haveSamePublicWebsiteOrigin(
    landingPageUrl,
    destinationPageUrl
  )
    ? { url: destinationPageUrl, evidence: destinationPageEvidence }
    : haveSamePublicWebsiteOrigin(landingPageUrl, firstDestinationPageUrl)
      ? {
          url: firstDestinationPageUrl,
          evidence: firstDestinationPageEvidence
        }
      : { url: landingPageUrl, evidence: landingPageEvidence };
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
    linkCandidates: [
      ...landingPageEvidence.linkCandidates,
      ...firstDestinationPageEvidence.linkCandidates,
      ...destinationPageEvidence.linkCandidates
    ],
    officialPage: {
      url: officialPageEvidence.url,
      linkCandidates: officialPageEvidence.evidence.linkCandidates,
      courseName: course.courseName,
      visibleText: officialPageVisibleText
    },
    accessBarrierUrls: input.accessBarrierUrls,
    accessBarriers: input.accessBarriers,
    visibleText: [
      landingPageEvidence.visibleText,
      firstDestinationPageEvidence.visibleText,
      destinationPageEvidence.visibleText
    ]
      .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index)
      .join("\n")
  };
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
    accessBarrierDetected: Boolean(evidence.accessBarriers?.length)
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
