import type {
  AutomationReason,
  BookingMethod
} from "@/lib/courses/intelligence";
import { isClubCaddieMetadata } from "@/lib/adapters/clubcaddie";
import {
  getKnownProviderFamilyForHostname,
  getProviderPublicBookingLandingIdentity,
  isProviderInfrastructureUrl,
  isProviderPublicBookingLandingUrl,
  isProviderTrackingQueryParameter,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import {
  haveCompatibleCourseNames,
  normalizeCourseIdentityName
} from "@/lib/places/course-identity";

export const OFFICIAL_SITE_SOFT_NOT_FOUND_POLICY_NOTES =
  "The saved official course site currently serves a not-found page and exposes no trustworthy public booking surface. Tee Time Spot will retry discovery without following unrelated page links.";

export type BrowserDiscoveryEvidence = {
  courseId: string;
  courseName: string;
  sourceUrl: string;
  finalUrl?: string;
  sourcePageAvailability?: "SOFT_NOT_FOUND";
  observedUrls: string[];
  linkCandidates?: Array<{ url: string; label: string }>;
  officialCourseWebsite?: string | null;
  officialPage?: {
    url: string;
    linkCandidates: Array<{ url: string; label: string }>;
    observedUrls?: string[];
    courseName?: string;
    visibleText?: string;
  };
  visibleText?: string;
  bookingSurfaceText?: string;
  providerPolicyText?: string;
  providerPolicyUrl?: string;
  accessBarrierUrls?: string[];
  accessBarriers?: BrowserAccessBarrier[];
  corroboratedAccessBarrier?: BrowserAccessBarrier;
  bookingCallToAction?: boolean;
  teeItUpLegacyConfigurations?: TeeItUpLegacyConfigurationEvidence[];
};

export type TeeItUpLegacyConfigurationEvidence = {
  providerUrl: string;
  alias: string;
  facilityIds: number[];
  courseName: string;
};

export type BrowserAccessBarrier = {
  url: string;
  status: 401 | 403;
};

export type BrowserDiscovery = {
  courseId: string;
  isPublic?: boolean;
  status: "LEARNED" | "VERIFIED" | "INSPECTED" | "BLOCKED" | "FAILED";
  detectedPlatform: "UNKNOWN" | "FOREUP" | "GOLFNOW" | "TEEITUP" | "CHRONOGOLF" | "CLUB_CADDIE" | "CUSTOM";
  sourceUrl: string;
  bookingUrl?: string;
  bookingMethod?: BookingMethod;
  bookingPhone?: string;
  automationEligibility?: "UNKNOWN" | "ALLOWED" | "BLOCKED" | "NEEDS_REVIEW";
  automationReason?: AutomationReason;
  policyNotes?: string;
  intelligenceReviewAt?: Date | string;
  apiEndpoint?: string;
  apiMetadata?: {
    scheduleId: number;
    bookingClassId?: number;
    bookingBaseUrl: string;
  } | {
    aliases: string[];
    bookingBaseUrl: string;
    facilityIds?: number[];
  } | {
    provider: "CPS";
    siteName: string;
    bookingBaseUrl: string;
    courseIds: number[];
    holes?: number[];
    resolvePlaceholderCourseIds?: boolean;
    clientId?: string;
    websiteId?: string;
    onlineApi?: string;
    authorityBaseUrl?: string;
    buildNumber?: string;
    terminalId?: number;
  } | {
    provider: "TEESNAP";
    courseId: number;
    bookingBaseUrl: string;
    defaultHoles?: 9 | 18;
    defaultAddons?: string;
  } | {
    provider: "CHELSEA";
    bookingBaseUrl: string;
    courseCode: number;
    courseLabel: string;
    bookingWindowDaysAhead?: number;
    bookingWindowEvidenceUrl?: string;
  } | {
    provider: "GOLFBACK";
    courseId: string;
    bookingBaseUrl: string;
  } | {
    provider: "WEBTRAC";
    bookingBaseUrl: string;
    courseCode: string;
    bookingWindowDaysAhead?: number;
    bookingWindowEvidenceUrl?: string;
  } | {
    provider: "CLUB_CADDIE";
    bookingBaseUrl: string;
  } | {
    clubId: number;
    courseIds: string[];
    bookingBaseUrl: string;
  };
  confidence: number;
  evidence: {
    finalUrl?: string;
    observedUrls: string[];
    visibleText?: string;
    accessBarriers?: BrowserAccessBarrier[];
    accessBarrierProviderIds?: {
      scheduleId?: number;
      bookingClassId?: number;
    };
    bookingCallToAction?: boolean;
    courseIdentityCorroboration?: {
      kind: "OFFICIAL_COURSE_PROVIDER_LINK";
      courseName?: string;
      officialWebsiteUrl: string;
      officialPageUrl: string;
      providerUrl: string;
    };
    learnedFrom: string;
  };
};

export function evaluateBrowserDiscoveryMonitoringGate(
  discovery: Pick<
    BrowserDiscovery,
    | "status"
    | "isPublic"
    | "bookingMethod"
    | "automationEligibility"
    | "automationReason"
    | "intelligenceReviewAt"
    | "confidence"
  >,
  now = new Date()
) {
  const finalClassification =
    discovery.status === "VERIFIED" || discovery.status === "BLOCKED";
  return evaluateMonitoringGate({
    isPublic: discovery.isPublic,
    bookingMethod: discovery.bookingMethod,
    automationEligibility: finalClassification
      ? discovery.automationEligibility
      : "NEEDS_REVIEW",
    automationReason: discovery.automationReason,
    intelligenceVerifiedAt: now,
    intelligenceReviewAt: discovery.intelligenceReviewAt,
    intelligenceConfidence: discovery.confidence,
    finalClassification,
    now
  });
}

export function keepPolicyOnlyDiscoveryActionable(
  discovery: BrowserDiscovery
): BrowserDiscovery {
  if (discovery.automationReason !== "AUTOMATION_PROHIBITED") {
    return discovery;
  }

  return {
    ...discovery,
    status: "VERIFIED",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "AUTOMATION_PROHIBITED",
    policyNotes:
      "The official public booking page remains eligible for signed-out, read-only monitoring. Provider terms are retained as evidence, but reusable monitoring support still needs technical verification.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: Math.max(0.9, Math.min(discovery.confidence, 0.95)),
    evidence: {
      ...discovery.evidence,
      learnedFrom: `${discovery.evidence.learnedFrom}:policy-evidence-only`
    }
  };
}

export function sanitizeBrowserDiscoveryAccessEvidence(
  discovery: BrowserDiscovery,
  barriers: BrowserAccessBarrier[] | undefined
): BrowserDiscovery {
  if (!barriers?.length) {
    return discovery;
  }

  return {
    ...discovery,
    sourceUrl: sanitizeDeniedUrl(discovery.sourceUrl, barriers),
    bookingUrl: discovery.bookingUrl
      ? sanitizeDeniedUrl(discovery.bookingUrl, barriers)
      : discovery.bookingUrl,
    evidence: {
      ...discovery.evidence,
      finalUrl: discovery.evidence.finalUrl
        ? sanitizeDeniedUrl(discovery.evidence.finalUrl, barriers)
        : discovery.evidence.finalUrl,
      observedUrls: sanitizeObservedAccessBarrierUrls(
        discovery.evidence.observedUrls,
        barriers
      )
    }
  };
}

export type BrowserDiscoveryProviderLeaseRunner = <T>(
  providerFamilyKey: string,
  worker: () => Promise<T>
) => Promise<{ acquired: true; value: T } | { acquired: false }>;

export type BrowserDiscoveryEnrichmentResult =
  | { acquired: true; discovery: BrowserDiscovery }
  | { acquired: false; providerFamilyKey: string };

class BrowserDiscoveryEnrichmentDeferredError extends Error {
  constructor(readonly providerFamilyKey: string) {
    super("Browser discovery enrichment was deferred by the provider concurrency guard");
  }
}

export async function enrichBrowserDiscoveryWithProviderLease(
  discovery: BrowserDiscovery,
  courseName: string,
  runWithLease: BrowserDiscoveryProviderLeaseRunner,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscoveryEnrichmentResult> {
  const leasedFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ) => {
    const destinationUrl = input instanceof Request ? input.url : input.toString();
    const providerFamilyKey = resolveProviderCapability({
      detectedBookingUrl: destinationUrl
    }).providerFamilyKey;
    const execution = await runWithLease(providerFamilyKey, () =>
      fetchImpl(input, init)
    );
    if (!execution.acquired) {
      throw new BrowserDiscoveryEnrichmentDeferredError(providerFamilyKey);
    }
    return execution.value;
  }) as typeof fetch;

  try {
    const teeItUpDiscovery = await enrichTeeItUpDiscovery(
      discovery,
      courseName,
      leasedFetch
    );
    const chronogolfDiscovery = await enrichChronogolfDiscovery(
      teeItUpDiscovery,
      leasedFetch
    );
    const cpsDiscovery = await enrichCpsDiscovery(
      chronogolfDiscovery,
      courseName,
      leasedFetch
    );
    return {
      acquired: true,
      discovery: await enrichTeesnapDiscovery(
        cpsDiscovery,
        courseName,
        leasedFetch
      )
    };
  } catch (error) {
    if (error instanceof BrowserDiscoveryEnrichmentDeferredError) {
      return { acquired: false, providerFamilyKey: error.providerFamilyKey };
    }
    throw error;
  }
}

export async function enrichTeeItUpDiscovery(
  discovery: BrowserDiscovery,
  courseName: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscovery> {
  if (
    discovery.detectedPlatform !== "TEEITUP" ||
    ![
      "teeitup-target-scope-ambiguous",
      "teeitup-target-scope-unconfirmed"
    ].includes(discovery.evidence.learnedFrom)
  ) {
    return discovery;
  }

  const corroboration = discovery.evidence.courseIdentityCorroboration;
  const legacyUrls = [
    corroboration?.providerUrl,
    ...discovery.evidence.observedUrls
  ]
    .filter((value): value is string => Boolean(value))
    .filter(isLegacyTeeItUpPlayUrl);
  const uniqueLegacyUrls = [
    ...new Set(
      legacyUrls
        .map(normalizeTeeItUpSourceUrl)
        .filter((value): value is string => Boolean(value))
    )
  ];
  if (
    corroboration?.kind !== "OFFICIAL_COURSE_PROVIDER_LINK" ||
    uniqueLegacyUrls.length !== 1 ||
    normalizeTeeItUpSourceUrl(corroboration.providerUrl) !== uniqueLegacyUrls[0]
  ) {
    return discovery;
  }

  const providerUrl = uniqueLegacyUrls[0];
  const fetched = await fetchLegacyTeeItUpConfigurationPage(
    providerUrl,
    fetchImpl
  );
  if (!fetched?.response.ok) {
    return discovery;
  }

  const configuration = parseLegacyTeeItUpConfiguration(
    providerUrl,
    await fetched.response.text()
  );
  if (
    !configuration ||
    !haveCompatibleCourseNames(courseName, configuration.courseName)
  ) {
    return discovery;
  }

  const facilityId = configuration.facilityIds[0];
  const bookingUrl = buildTeeItUpBookingUrl(providerUrl, facilityId);
  if (!bookingUrl) {
    return discovery;
  }

  return {
    ...discovery,
    status: "LEARNED",
    bookingUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The official course page embeds a public TeeItUp tee sheet. Tee Time Spot reads only public availability and leaves booking on the official provider page.",
    apiEndpoint: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
    apiMetadata: {
      aliases: [configuration.alias],
      bookingBaseUrl: bookingUrl,
      facilityIds: [facilityId]
    },
    confidence: 0.9,
    evidence: {
      ...discovery.evidence,
      finalUrl: fetched.finalUrl,
      observedUrls: uniqueUrls([
        ...discovery.evidence.observedUrls,
        providerUrl,
        bookingUrl
      ]),
      learnedFrom: "teeitup-legacy-play-configuration"
    }
  };
}

export async function fetchLegacyTeeItUpConfigurationPage(
  providerUrl: string,
  fetchImpl: typeof fetch
) {
  const sourceAlias = getTeeItUpAlias(providerUrl);
  if (!sourceAlias || !isLegacyTeeItUpPlayUrl(providerUrl)) {
    return null;
  }
  let currentUrl = providerUrl;
  for (let redirectCount = 0; redirectCount <= 2; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9",
        "User-Agent":
          "Tee Time Spot availability monitor (+https://teetimespot.com/guides/public-golf-booking-windows)"
      },
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 2) {
        return null;
      }
      const redirectUrl = new URL(location, currentUrl);
      if (
        !isTeeItUpPublicLandingCandidate(redirectUrl.toString()) ||
        getTeeItUpAlias(redirectUrl.toString())?.toLocaleLowerCase("en-US") !==
          sourceAlias.toLocaleLowerCase("en-US")
      ) {
        return null;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }
    const finalUrl = response.url || currentUrl;
    if (
      getTeeItUpAlias(finalUrl)?.toLocaleLowerCase("en-US") !==
        sourceAlias.toLocaleLowerCase("en-US") ||
      !isTeeItUpPublicLandingCandidate(finalUrl)
    ) {
      return null;
    }
    return { response, finalUrl };
  }
  return null;
}

export function parseLegacyTeeItUpConfiguration(
  providerUrl: string,
  html: string
): TeeItUpLegacyConfigurationEvidence | null {
  const alias = getTeeItUpAlias(providerUrl);
  if (!alias || !html.trim()) {
    return null;
  }
  const normalized = html
    .replace(/&quot;/giu, '"')
    .replace(/&#(?:x27|39);/giu, "'")
    .replace(/\\+"/gu, '"');
  const facilityMatch = normalized.match(/"gnFacilityIds"\s*:\s*\[([^\]]*)\]/u);
  if (!facilityMatch) {
    return null;
  }
  const facilityIds = [
    ...new Set(
      facilityMatch[1]
        .split(",")
        .map((value) => Number(value.trim()))
        .filter(isPositiveSafeInteger)
    )
  ];
  const courseNameMatch = normalized
    .slice(facilityMatch.index)
    .match(/"name"\s*:\s*"([^"\r\n]{1,200})"/u);
  const configuredCourseName = courseNameMatch?.[1]?.trim();
  if (facilityIds.length !== 1 || !configuredCourseName) {
    return null;
  }
  return {
    providerUrl,
    alias,
    facilityIds,
    courseName: configuredCourseName
  };
}

export type BrowserProbeCourseInput = {
  isPublic?: boolean | null;
  detectedPlatform: string;
  providerFamilyKey?: string | null;
  automationEligibility: string;
  automationReason?: string | null;
  bookingMethod?: string | null;
  intelligenceVerifiedAt?: Date | string | null;
  intelligenceReviewAt?: Date | string | null;
  intelligenceConfidence?: number | null;
  website?: string | null;
  detectedBookingUrl?: string | null;
  bookingMetadata?: unknown;
  monitoringFailureEvidence?: {
    kind: "FETCH_FAILED";
    occurrenceCount: number;
    latestFailureAt: Date | string;
    latestSuccessfulAt?: Date | string | null;
  };
};

export function buildBrowserDiscovery(evidence: BrowserDiscoveryEvidence): BrowserDiscovery {
  evidence = sanitizeClubCaddieDiscoveryEvidence(evidence);
  evidence = scopeBrowserDiscoveryProviderEvidence(evidence);
  const observedUrls = uniqueUrls([
    evidence.finalUrl,
    evidence.sourceUrl,
    ...evidence.observedUrls
  ]);
  const providerEvidence = getTargetScopedProviderEvidence(evidence);
  const providerObservedUrls = uniqueUrls([
    providerEvidence.finalUrl,
    providerEvidence.sourceUrl,
    ...providerEvidence.observedUrls
  ]);
  const unavailableOfficialSiteClassification =
    learnUnavailableOfficialSiteClassification(evidence);

  if (unavailableOfficialSiteClassification) {
    return unavailableOfficialSiteClassification;
  }

  const privateClubClassification = learnPrivateClubClassification(evidence, observedUrls);

  if (privateClubClassification) {
    return withCourseIdentityCorroboration(privateClubClassification, evidence);
  }

  const phoneReservationClassification = learnOfficialPhoneReservationClassification(
    evidence,
    observedUrls
  );

  if (phoneReservationClassification) {
    return phoneReservationClassification;
  }

  const walkInClassification = learnWalkInClassification(evidence, observedUrls);

  if (walkInClassification) {
    return withCourseIdentityCorroboration(walkInClassification, evidence);
  }

  const contactOnlyClassification = learnOfficialContactOnlyClassification(
    evidence,
    observedUrls
  );

  if (contactOnlyClassification) {
    return withCourseIdentityCorroboration(contactOnlyClassification, evidence);
  }

  if (hasUnresolvedProviderEvidenceConflict(providerEvidence)) {
    return withCourseIdentityCorroboration(
      {
        courseId: evidence.courseId,
        status: "INSPECTED",
        detectedPlatform: "UNKNOWN",
        sourceUrl: providerEvidence.sourceUrl,
        confidence: 0.2,
        evidence: {
          finalUrl: providerEvidence.finalUrl,
          observedUrls: providerObservedUrls,
          visibleText: summarizeVisibleText(providerEvidence.visibleText),
          learnedFrom: "provider-evidence-conflict"
        }
      },
      evidence
    );
  }

  const accountRequiredClassification = learnAccountRequiredClassification(
    providerEvidence,
    providerObservedUrls
  );

  if (accountRequiredClassification) {
    return withCourseIdentityCorroboration(accountRequiredClassification, evidence);
  }

  const providerDiscoveries = [
    learnWhooshBookingClassification(providerEvidence, providerObservedUrls),
    learnForeupDiscovery(providerEvidence, providerObservedUrls),
    learnTeeItUpDiscovery(providerEvidence, providerObservedUrls),
    learnChelseaDiscovery(providerEvidence, providerObservedUrls),
    learnGolfBackDiscovery(providerEvidence, providerObservedUrls),
    learnWebTracDiscovery(providerEvidence, providerObservedUrls),
    learnClubCaddieDiscovery(providerEvidence, providerObservedUrls),
    learnProtectedCpsDiscovery(providerEvidence, providerObservedUrls),
    learnCpsDiscovery(providerEvidence, providerObservedUrls),
    learnTeesnapDiscovery(providerEvidence, providerObservedUrls),
    learnTenForeDiscovery(providerEvidence, providerObservedUrls),
    learnKnownProviderAccessBarrierClassification(
      providerEvidence,
      providerObservedUrls
    )
  ];
  const firstProviderDiscovery = providerDiscoveries.find(
    (discovery): discovery is BrowserDiscovery => Boolean(discovery)
  );

  if (firstProviderDiscovery) {
    return withCourseIdentityCorroboration(firstProviderDiscovery, evidence);
  }

  const clubCaddieCandidates = getClubCaddieCandidates(
    providerEvidence,
    providerObservedUrls
  );
  const bookingUrl = clubCaddieCandidates.length > 0
    ? pickSafeBrowserDiscoveryFallbackUrl([providerEvidence.sourceUrl])
    : pickBookingLikeUrl(
        providerObservedUrls,
        providerEvidence.linkCandidates ?? []
      ) ??
      pickSafeBrowserDiscoveryFallbackUrl([
        providerEvidence.finalUrl,
        providerEvidence.sourceUrl,
        getSafeNonProviderBarrierFallback(providerEvidence.accessBarriers)
      ]);

  return withCourseIdentityCorroboration({
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: detectPlatform(observedUrls),
    sourceUrl: providerEvidence.sourceUrl,
    bookingUrl,
    confidence: !bookingUrl || bookingUrl === evidence.sourceUrl ? 0.25 : 0.45,
    evidence: {
      finalUrl: providerEvidence.finalUrl,
      observedUrls: providerObservedUrls,
      visibleText: summarizeVisibleText(providerEvidence.visibleText),
      ...(hasBookingCallToActionEvidence(providerEvidence) ||
      hasPositiveOnlineBookingText(providerEvidence.visibleText ?? "")
        ? { bookingCallToAction: true }
        : {}),
      learnedFrom: "browser-visible-links"
    }
  }, evidence);
}

function learnKnownProviderAccessBarrierClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const accessBarrier = evidence.corroboratedAccessBarrier;
  const barrierUrl = parseUrl(accessBarrier?.url);
  if (
    !accessBarrier ||
    !barrierUrl ||
    !isProviderPublicBookingLandingUrl(barrierUrl)
  ) {
    return null;
  }

  const provider = resolveProviderCapability({
    detectedBookingUrl: barrierUrl.toString()
  });
  if (!provider.capability) {
    return null;
  }

  const exactBarrierObserved = observedUrls.some(
    (url) => haveSameExactUrl(url, barrierUrl.toString())
  );
  const exactBookingLinkObserved = (evidence.linkCandidates ?? []).some(
    (candidate) =>
      haveSameExactUrl(candidate.url, barrierUrl.toString()) &&
      isRecognizedProviderBookingLink(candidate)
  );
  if (!exactBarrierObserved || !exactBookingLinkObserved) {
    return null;
  }

  const safeAccessBarriers = sanitizeAccessBarriers([accessBarrier]);
  const accountRequired = accessBarrier.status === 401;
  return {
    courseId: evidence.courseId,
    status: "BLOCKED",
    detectedPlatform: provider.detectedPlatform,
    sourceUrl: evidence.sourceUrl,
    bookingUrl: barrierUrl.toString(),
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "BLOCKED",
    automationReason: accountRequired
      ? "ACCOUNT_REQUIRED"
      : "CAPTCHA_OR_QUEUE",
    policyNotes: accountRequired
      ? "The official public booking landing requires an account before availability can be viewed. Tee Time Spot does not use golfer accounts or account-specific sessions, so golfers must check the official booking page directly."
      : "The official public booking landing repeatedly returns a managed browser challenge. Tee Time Spot does not bypass technical access controls, so golfers must check the official booking page directly.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: 0.95,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls: uniqueUrls([...observedUrls, barrierUrl.toString()]),
      visibleText: summarizeVisibleText(evidence.visibleText),
      accessBarriers: safeAccessBarriers,
      learnedFrom: "known-provider-public-landing-access-barrier"
    }
  };
}

function getSafeNonProviderBarrierFallback(
  barriers: BrowserAccessBarrier[] | undefined
) {
  for (const barrier of barriers ?? []) {
    const normalized = normalizeAccessBarrierUrl(barrier.url);
    const url = parseUrl(normalized);
    if (url && !getKnownProviderFamilyForHostname(url.hostname)) {
      return url.toString();
    }
  }
  return undefined;
}

function pickSafeBrowserDiscoveryFallbackUrl(
  values: Array<string | undefined>
) {
  for (const value of values) {
    const url = parseUrl(value);
    if (
      !url ||
      !isSafeManualEvidenceUrl(url) ||
      isClearlyUnrelatedBookingUrl(url)
    ) {
      continue;
    }
    if (
      getKnownProviderFamilyForHostname(url.hostname) &&
      !isProviderPublicBookingLandingUrl(url)
    ) {
      continue;
    }
    return url.toString();
  }
  return undefined;
}

function learnUnavailableOfficialSiteClassification(
  evidence: BrowserDiscoveryEvidence
): BrowserDiscovery | null {
  if (evidence.sourcePageAvailability !== "SOFT_NOT_FOUND") {
    return null;
  }

  const canonicalSource = canonicalizeUnavailableOfficialUrl(evidence.sourceUrl);
  const canonicalFinal = canonicalizeUnavailableOfficialUrl(
    evidence.finalUrl ?? evidence.sourceUrl
  );
  if (!canonicalSource) {
    return null;
  }
  const firstPartyFinal =
    canonicalFinal &&
    haveSameWebsiteOrigin(new URL(canonicalSource), new URL(canonicalFinal))
      ? canonicalFinal
      : canonicalSource;

  return {
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: canonicalSource,
    bookingMethod: "UNKNOWN",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "TEMPORARILY_UNAVAILABLE",
    policyNotes: OFFICIAL_SITE_SOFT_NOT_FOUND_POLICY_NOTES,
    intelligenceReviewAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: firstPartyFinal,
      observedUrls: uniqueUrls([canonicalSource, firstPartyFinal]),
      learnedFrom: "official-site-soft-not-found"
    }
  };
}

function learnClubCaddieDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const candidates = getClubCaddieCandidates(evidence, observedUrls);
  const selected = selectClubCaddieCandidate(candidates, evidence.courseName);
  if (!selected) {
    return null;
  }

  const metadata = {
    provider: "CLUB_CADDIE" as const,
    bookingBaseUrl: selected.url
  };
  if (!isClubCaddieMetadata(metadata)) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CLUB_CADDIE",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: selected.url,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The course's official site links to a signed-out Club Caddie tee sheet. Tee Time Spot reads only public availability and leaves account, cart, checkout, and booking actions to the golfer on the official provider page.",
    apiEndpoint: `${new URL(selected.url).origin}/webapi/TeeTimes`,
    apiMetadata: metadata,
    confidence: candidates.length === 1 ? 0.92 : 0.96,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "club-caddie-public-tee-time-link"
    }
  };
}

type ClubCaddieLinkCandidate = { url: string; label: string };

function getClubCaddieCandidates(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): ClubCaddieLinkCandidate[] {
  const candidates = [
    ...(evidence.linkCandidates ?? []),
    ...observedUrls.map((url) => ({ url, label: "" }))
  ];
  const byUrl = new Map<string, ClubCaddieLinkCandidate>();

  for (const candidate of candidates) {
    const url = canonicalizeClubCaddieBookingUrl(candidate.url);
    if (!url) {
      continue;
    }
    const label = candidate.label.replace(/\s+/g, " ").trim().slice(0, 160);
    const current = byUrl.get(url);
    if (!current || (!current.label && label)) {
      byUrl.set(url, { url, label });
    }
  }

  return [...byUrl.values()];
}

function canonicalizeClubCaddieBookingUrl(value: string) {
  const url = parseUrl(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^apimanager-cc\d{1,4}\.clubcaddie\.com$/i.test(url.hostname) ||
    !/^\/webapi\/view\/[a-z0-9_-]{4,128}(?:\/slots)?\/?$/i.test(url.pathname) ||
    !isProviderPublicBookingLandingUrl(url)
  ) {
    return null;
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

function selectClubCaddieCandidate(
  candidates: ClubCaddieLinkCandidate[],
  courseName: string
) {
  if (candidates.length === 1) {
    return isCourseCorroboratedClubCaddieCandidate(candidates[0], courseName)
      ? candidates[0]
      : undefined;
  }
  if (candidates.length === 0) {
    return undefined;
  }

  if (candidates.some((candidate) => !candidate.label)) {
    return undefined;
  }

  const safeCandidates = candidates.filter((candidate) =>
    isSafeClubCaddieLinkLabel(candidate.label)
  );
  if (safeCandidates.length === 0) {
    return undefined;
  }

  const normalizedName = normalizeCourseName(courseName);
  const meaningfulTokens = normalizedName
    .split(" ")
    .filter((token) => !CLUB_CADDIE_GENERIC_COURSE_WORDS.has(token));
  if (meaningfulTokens.length === 0) {
    return undefined;
  }
  const expectedAcronyms = [...new Set([
    meaningfulTokens.map((token) => token[0]).join(""),
    normalizedName
      .split(" ")
      .filter((token) => !["and", "at", "of", "the"].includes(token))
      .map((token) => token[0])
      .join("")
  ].filter((value) => value.length >= 2))];
  const scored = safeCandidates.map((candidate) => ({
    candidate,
    score: scoreClubCaddieCandidate(
      candidate.label,
      normalizedName,
      meaningfulTokens,
      expectedAcronyms
    )
  }));
  const highestScore = Math.max(...scored.map(({ score }) => score));
  const strongest = scored.filter(({ score }) => score === highestScore && score > 0);
  if (strongest.length === 1) {
    return strongest[0].candidate;
  }

  const targetIsBear = meaningfulTokens.includes("bear");
  const targetIsShortCourse = meaningfulTokens.some((token) =>
    ["short", "par3", "executive"].includes(token)
  );
  const bearCandidates = safeCandidates.filter((candidate) => /\bbear\b/i.test(candidate.label));
  const championshipCandidates = safeCandidates.filter((candidate) =>
    /\bchampionship\b/i.test(candidate.label)
  );
  if (targetIsBear && bearCandidates.length === 1) {
    return bearCandidates[0];
  }
  if (
    !targetIsBear &&
    !targetIsShortCourse &&
    bearCandidates.length === 1 &&
    championshipCandidates.length === 1
  ) {
    return championshipCandidates[0];
  }

  return undefined;
}

function isCourseCorroboratedClubCaddieCandidate(
  candidate: ClubCaddieLinkCandidate,
  courseName: string
) {
  if (!isSafeClubCaddieLinkLabel(candidate.label)) {
    return false;
  }
  if (haveCompatibleCourseNames(courseName, candidate.label)) {
    return true;
  }

  const normalizedName = normalizeCourseName(courseName);
  const meaningfulTokens = normalizedName
    .split(" ")
    .filter((token) => !CLUB_CADDIE_GENERIC_COURSE_WORDS.has(token));
  const expectedAcronyms = [...new Set([
    meaningfulTokens.map((token) => token[0]).join(""),
    normalizedName
      .split(" ")
      .filter((token) => !["and", "at", "of", "the"].includes(token))
      .map((token) => token[0])
      .join("")
  ].filter((value) => value.length >= 2))];
  const labelAcronyms = [...candidate.label.matchAll(/(?:@|\b)([A-Z]{2,8})\b/g)]
    .map((match) => match[1].toLowerCase());
  if (expectedAcronyms.some((acronym) => labelAcronyms.includes(acronym))) {
    return true;
  }

  const resourceSlug = new URL(candidate.url).pathname.match(
    /^\/webapi\/view\/([^/]+)/i
  )?.[1];
  return Boolean(
    resourceSlug &&
      haveCompatibleCourseNames(
        courseName,
        decodeURIComponent(resourceSlug).replace(/[-_]+/g, " ")
      )
  );
}

function isSafeClubCaddieLinkLabel(label: string) {
  const normalized = label.replace(/\s+/g, " ").trim();
  return Boolean(
    normalized &&
      !/\b(?:activit(?:y|ies)|driving\s+range|events?|gift\s+cards?|leagues?|lessons?|mini\s+golf|putt(?:-|\s)putt|putting\s+course|simulators?)\b/i.test(
        normalized
      )
  );
}

function sanitizeClubCaddieDiscoveryEvidence(
  evidence: BrowserDiscoveryEvidence
): BrowserDiscoveryEvidence {
  return {
    ...evidence,
    sourceUrl: sanitizeClubCaddieEvidenceUrl(evidence.sourceUrl),
    finalUrl: evidence.finalUrl
      ? sanitizeClubCaddieEvidenceUrl(evidence.finalUrl)
      : undefined,
    observedUrls: evidence.observedUrls.map(sanitizeClubCaddieEvidenceUrl),
    linkCandidates: evidence.linkCandidates?.map((candidate) => ({
      ...candidate,
      url: sanitizeClubCaddieEvidenceUrl(candidate.url)
    }))
  };
}

function sanitizeClubCaddieEvidenceUrl(value: string) {
  const url = parseUrl(value);
  if (!url || !/(^|\.)clubcaddie\.com$/i.test(url.hostname)) {
    return value;
  }
  if (!url.search && !url.hash) {
    return value;
  }
  const nonTrackingEntries = [...url.searchParams.entries()].filter(
    ([key]) => !isProviderTrackingQueryParameter(key)
  );
  const hasOnlyKnownRequestLocalState = Boolean(
    !url.hash &&
      (nonTrackingEntries.length === 0 ||
        (nonTrackingEntries.length === 1 &&
          nonTrackingEntries[0][0].toLocaleLowerCase("en-US") ===
            "interaction"))
  );
  url.search = "";
  url.hash = "";
  if (
    hasOnlyKnownRequestLocalState &&
    isProviderPublicBookingLandingUrl(url)
  ) {
    return url.toString();
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/redacted-provider-evidence`;
  return url.toString();
}

function scopeBrowserDiscoveryProviderEvidence(
  evidence: BrowserDiscoveryEvidence
): BrowserDiscoveryEvidence {
  const scopeUrl = [evidence.sourceUrl, evidence.finalUrl]
    .map(parseUrl)
    .find((url) => Boolean(url && isProviderPublicBookingLandingUrl(url)));
  if (!scopeUrl) {
    return evidence;
  }
  const scopeFamily = getKnownProviderFamilyForHostname(scopeUrl.hostname);
  const scopeLandingIdentity = getProviderPublicBookingLandingIdentity(
    scopeUrl
  );
  if (!scopeFamily || !scopeLandingIdentity) {
    return evidence;
  }
  const hasScope = (value: string, allowTechnicalEvidence: boolean) => {
    const url = parseUrl(value);
    if (
      !url ||
      getKnownProviderFamilyForHostname(url.hostname) !== scopeFamily ||
      !haveSameProviderReplayHostname(scopeUrl, url)
    ) {
      return false;
    }
    const landingIdentity = getProviderPublicBookingLandingIdentity(url);
    if (landingIdentity) {
      return landingIdentity === scopeLandingIdentity;
    }
    return Boolean(
      allowTechnicalEvidence &&
        isExactProviderTechnicalEvidenceUrl(scopeFamily, url) &&
        isProviderTechnicalEvidenceCompatibleWithLanding(
          scopeFamily,
          scopeUrl,
          url
        )
    );
  };
  const sanitizeProviderEndpoint = (
    value: string | undefined,
    preserveNonProvider: boolean
  ) => {
    if (!value) {
      return value;
    }
    const url = parseUrl(value);
    if (
      preserveNonProvider &&
      url &&
      !getKnownProviderFamilyForHostname(url.hostname)
    ) {
      return value;
    }
    return hasScope(value, false) ? value : scopeUrl.toString();
  };
  const scopeLandingLinks = (
    candidates: Array<{ url: string; label: string }> | undefined
  ) => candidates?.filter((candidate) => hasScope(candidate.url, false));
  const accessBarriers = evidence.accessBarriers?.filter((barrier) =>
    hasScope(barrier.url, true)
  );
  const corroboratedAccessBarrier =
    evidence.corroboratedAccessBarrier &&
    accessBarriers?.some(
      (barrier) =>
        barrier.status === evidence.corroboratedAccessBarrier?.status &&
        barrier.url === evidence.corroboratedAccessBarrier.url
    )
      ? evidence.corroboratedAccessBarrier
      : undefined;

  return {
    ...evidence,
    sourceUrl: sanitizeProviderEndpoint(evidence.sourceUrl, true)!,
    finalUrl: sanitizeProviderEndpoint(evidence.finalUrl, false),
    observedUrls: evidence.observedUrls.filter((url) => hasScope(url, true)),
    linkCandidates: scopeLandingLinks(evidence.linkCandidates),
    accessBarrierUrls: evidence.accessBarrierUrls?.filter((url) =>
      hasScope(url, true)
    ),
    accessBarriers,
    corroboratedAccessBarrier,
    officialPage: evidence.officialPage
      ? {
          ...evidence.officialPage,
          linkCandidates:
            scopeLandingLinks(evidence.officialPage.linkCandidates) ?? [],
          ...(evidence.officialPage.observedUrls
            ? {
                observedUrls: evidence.officialPage.observedUrls.filter((url) =>
                  hasScope(url, true)
                )
              }
            : {})
        }
      : undefined,
    teeItUpLegacyConfigurations: evidence.teeItUpLegacyConfigurations?.filter(
      (configuration) => hasScope(configuration.providerUrl, false)
    )
  };
}

function hasUnresolvedProviderEvidenceConflict(
  evidence: BrowserDiscoveryEvidence
) {
  const ordinaryUrls = [
    evidence.sourceUrl,
    evidence.finalUrl,
    ...evidence.observedUrls,
    ...(evidence.linkCandidates ?? []).map((candidate) => candidate.url),
    evidence.officialPage?.url,
    ...(evidence.officialPage?.observedUrls ?? []),
    ...(evidence.officialPage?.linkCandidates ?? []).map(
      (candidate) => candidate.url
    ),
    ...(evidence.teeItUpLegacyConfigurations ?? []).map(
      (configuration) => configuration.providerUrl
    )
  ];
  const barrierUrls = [
    ...(evidence.accessBarrierUrls ?? []),
    ...(evidence.accessBarriers ?? []).map((barrier) => barrier.url),
    evidence.corroboratedAccessBarrier?.url
  ];
  const families = new Set<string>();
  const landingIdentities = new Map<string, Set<string>>();
  const landingHosts = new Map<string, Set<string>>();
  const technicalHosts = new Map<string, Set<string>>();
  const barrierHosts = new Map<string, Set<string>>();
  const addToFamilySet = (
    target: Map<string, Set<string>>,
    family: string,
    value: string
  ) => {
    const values = target.get(family) ?? new Set<string>();
    values.add(value);
    target.set(family, values);
  };
  const addIdentity = (value: string | undefined, allowBarrier: boolean) => {
    const url = parseUrl(value);
    if (!url) {
      return;
    }
    const family = getKnownProviderFamilyForHostname(url.hostname);
    if (!family) {
      return;
    }
    const replayHostname = url.hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "");
    if (allowBarrier) {
      families.add(family);
      const landingIdentity = getProviderPublicBookingLandingIdentity(url);
      if (landingIdentity) {
        addToFamilySet(landingHosts, family, replayHostname);
        addToFamilySet(landingIdentities, family, landingIdentity);
      } else {
        addToFamilySet(barrierHosts, family, replayHostname);
      }
      return;
    }
    if (isProviderPublicBookingLandingUrl(url)) {
      families.add(family);
      addToFamilySet(landingHosts, family, replayHostname);
      addToFamilySet(
        landingIdentities,
        family,
        getProviderPublicBookingLandingIdentity(url)!
      );
      return;
    }
    if (isExactProviderTechnicalEvidenceUrl(family, url)) {
      families.add(family);
      addToFamilySet(technicalHosts, family, replayHostname);
    }
  };
  ordinaryUrls.forEach((url) => addIdentity(url, false));
  barrierUrls.forEach((url) => addIdentity(url, true));

  if (families.size > 1) {
    return true;
  }
  const family = [...families][0];
  if (!family) {
    return false;
  }
  const providerHosts = new Set([
    ...(landingHosts.get(family) ?? []),
    ...(technicalHosts.get(family) ?? []),
    ...(barrierHosts.get(family) ?? [])
  ]);
  if ((barrierHosts.get(family)?.size ?? 0) > 0 && providerHosts.size > 1) {
    return true;
  }
  const familiesRequiringOneUnscopedLanding = new Set([
    "CHELSEA",
    "CHRONOGOLF",
    "EZLINKS",
    "FOREUP",
    "GOLFBACK",
    "GOLFNOW",
    "TEESNAP",
    "TENFORE",
    "WEBTRAC",
    "WHOOSH"
  ]);
  return Boolean(
    familiesRequiringOneUnscopedLanding.has(family) &&
      (landingIdentities.get(family)?.size ?? 0) > 1
  );
}

function haveSameProviderReplayHostname(left: URL, right: URL) {
  const normalize = (hostname: string) =>
    hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  return normalize(left.hostname) === normalize(right.hostname);
}

function isProviderTechnicalEvidenceCompatibleWithLanding(
  providerFamily: string,
  landingUrl: URL,
  technicalUrl: URL
) {
  if (providerFamily === "FOREUP") {
    const landingScheduleId = getForeupScheduleId(landingUrl.toString());
    const technicalScheduleId = getPositiveBoundedSearchParam(
      technicalUrl,
      "schedule_id"
    );
    return landingScheduleId
      ? technicalScheduleId === landingScheduleId
      : Boolean(technicalScheduleId);
  }
  return true;
}

function isExactProviderTechnicalEvidenceUrl(
  providerFamily: string,
  url: URL
) {
  switch (providerFamily) {
    case "FOREUP":
      return isForeupApiUrl(url.toString());
    case "CPS":
      return isCpsProviderEvidenceUrl(url);
    case "TEESNAP":
      return isTeesnapTechnicalEvidenceUrl(url.toString());
    case "CHRONOGOLF":
      return isExactChronogolfProfilePingUrl(url);
    default:
      return false;
  }
}

const CLUB_CADDIE_GENERIC_COURSE_WORDS = new Set([
  "and",
  "at",
  "center",
  "centre",
  "club",
  "country",
  "course",
  "family",
  "golf",
  "links",
  "municipal",
  "of",
  "public",
  "the"
]);

function scoreClubCaddieCandidate(
  label: string,
  normalizedName: string,
  meaningfulTokens: string[],
  expectedAcronyms: string[]
) {
  const normalizedLabel = normalizeCourseName(label);
  let score = normalizedLabel.includes(normalizedName) ? 100 : 0;
  score += meaningfulTokens.filter(
    (token) => token.length >= 3 && normalizedLabel.split(" ").includes(token)
  ).length * 20;

  const labelAcronyms = [...label.matchAll(/(?:@|\b)([A-Z]{2,8})\b/g)]
    .map((match) => match[1].toLowerCase());
  if (expectedAcronyms.some((acronym) => labelAcronyms.includes(acronym))) {
    score += 80;
  }

  return score;
}

function learnWebTracDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const bookingUrl = observedUrls
    .map(parseUrl)
    .find((url) => Boolean(
      url &&
      (url.hostname === "navyaims.com" || url.hostname.endsWith(".navyaims.com")) &&
      /\/webtrac\/web\/search\.html$/i.test(url.pathname) &&
      isProviderPublicBookingLandingUrl(url) &&
      url.searchParams.get("module")?.toUpperCase() === "GR" &&
      url.searchParams.get("secondarycode")
    ));
  const courseCode = bookingUrl?.searchParams.get("secondarycode");
  if (!bookingUrl || !courseCode) {
    return null;
  }
  const bookingWindowDays = [...(evidence.visibleText ?? "").matchAll(/\b(\d{1,2})\s+DAYS?\s+(?:prior|in advance)\b/gi)]
    .map((match) => Number(match[1]))
    .filter((days) => days >= 0 && days <= 31);
  const bookingBaseUrl = bookingUrl.toString();

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The official Vermont Systems WebTrac golf search exposes signed-out tee-time availability. Tee Time Spot reads only search results and leaves cart, account, and booking actions to the golfer on the provider site.",
    apiEndpoint: `${bookingUrl.origin}${bookingUrl.pathname}?module=GR&secondarycode=${encodeURIComponent(courseCode)}&begindate={date}`,
    apiMetadata: {
      provider: "WEBTRAC",
      bookingBaseUrl,
      courseCode,
      ...(bookingWindowDays.length > 0
        ? {
            bookingWindowDaysAhead: Math.min(...bookingWindowDays),
            bookingWindowEvidenceUrl: evidence.sourceUrl
          }
        : {})
    },
    confidence: 0.95,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "webtrac-public-golf-search"
    }
  };
}

function learnGolfBackDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const observedBookingUrl = observedUrls.find(isGolfBackBookingUrl);
  const courseId = observedBookingUrl
    ? getGolfBackCourseId(observedBookingUrl)
    : null;
  if (!observedBookingUrl || !courseId) {
    return null;
  }
  const bookingUrl = `https://golfback.com/#/course/${courseId}`;

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The official GolfBack course page exposes public tee-time availability without login. Tee Time Spot reads that public tee sheet and leaves booking on GolfBack.",
    apiEndpoint: `https://api.golfback.com/api/v1/courses/${courseId}/date/{date}/teetimes`,
    apiMetadata: {
      provider: "GOLFBACK",
      courseId,
      bookingBaseUrl: bookingUrl
    },
    confidence: 0.95,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "golfback-public-course-link"
    }
  };
}

function learnProtectedCpsDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const cpsAccessBarriers = evidence.accessBarriers?.filter((barrier) =>
    getCpsBookingCandidates(evidence, [barrier.url], {
      includeEvidenceLinks: false,
      includeWidget: false,
      includeInfrastructureEvidence: false
    }).length > 0
  ) ?? [];
  const barrierCandidate = selectCpsBookingCandidate(
    getCpsBookingCandidates(evidence, cpsAccessBarriers.map((barrier) => barrier.url), {
      includeEvidenceLinks: false,
      includeWidget: false,
      includeInfrastructureEvidence: false
    }),
    evidence.courseName
  );
  if (!barrierCandidate) {
    return null;
  }

  const bookingBaseUrl = barrierCandidate.bookingBaseUrl;
  const corroboratedAccessBarrier = evidence.corroboratedAccessBarrier
    ? cpsAccessBarriers.find((barrier) =>
        areSameAccessBarrier(barrier, evidence.corroboratedAccessBarrier!)
      )
    : undefined;
  const accessBarrier = corroboratedAccessBarrier ?? cpsAccessBarriers[0];
  if (!accessBarrier) {
    return null;
  }
  const safeAccessBarriers = sanitizeAccessBarriers([accessBarrier]);
  const safeObservedUrls = sanitizeObservedAccessBarrierUrls(
    observedUrls,
    cpsAccessBarriers
  );
  if (!corroboratedAccessBarrier) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: bookingBaseUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "NEEDS_REVIEW",
      automationReason: "NONE",
      confidence: 0.7,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls: safeObservedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        accessBarriers: safeAccessBarriers,
        learnedFrom: "cps-managed-challenge-unconfirmed"
      }
    };
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "BLOCKED",
    automationReason: "CAPTCHA_OR_QUEUE",
    policyNotes:
      "The official CPS booking page shows public online tee times, but direct retrieval is protected by a managed browser challenge. Tee Time Spot does not bypass challenge-protected access, so golfers should check and book on the official page directly.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls: safeObservedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      accessBarriers: safeAccessBarriers,
      learnedFrom: "cps-managed-challenge-booking"
    }
  };
}

function withCourseIdentityCorroboration(
  discovery: BrowserDiscovery,
  evidence: BrowserDiscoveryEvidence
): BrowserDiscovery {
  const corroboration = getOfficialCourseProviderLinkCorroboration(
    discovery,
    evidence
  );
  if (!corroboration) {
    return discovery;
  }
  return {
    ...discovery,
    evidence: {
      ...discovery.evidence,
      courseIdentityCorroboration: corroboration
    }
  };
}

function getOfficialCourseProviderLinkCorroboration(
  discovery: BrowserDiscovery,
  evidence: BrowserDiscoveryEvidence
) {
  const officialWebsite = parseUrl(evidence.officialCourseWebsite);
  const officialPage = parseUrl(evidence.officialPage?.url);
  const providerUrl = parseUrl(discovery.bookingUrl);
  if (
    !officialWebsite ||
    !officialPage ||
    !providerUrl ||
    !evidence.officialPage?.courseName ||
    !haveCompatibleCourseNames(
      evidence.courseName,
      evidence.officialPage.courseName
    ) ||
    !hasCanonicalTargetPageAuthority(evidence) ||
    getKnownProviderFamilyForHostname(officialWebsite.hostname) ||
    !getKnownProviderFamilyForHostname(providerUrl.hostname) ||
    !haveSameWebsiteOrigin(officialWebsite, officialPage)
  ) {
    return null;
  }
  const exactProviderLink = evidence.officialPage?.linkCandidates.find(
    (candidate) => haveSameExactUrl(candidate.url, providerUrl.toString())
  );
  if (!exactProviderLink) {
    return null;
  }
  return {
    kind: "OFFICIAL_COURSE_PROVIDER_LINK" as const,
    courseName: evidence.courseName,
    officialWebsiteUrl: officialWebsite.toString(),
    officialPageUrl: officialPage.toString(),
    providerUrl: new URL(exactProviderLink.url).toString()
  };
}

function haveSameWebsiteOrigin(left: URL, right: URL) {
  const normalizeHostname = (hostname: string) =>
    hostname.toLowerCase().replace(/^www\./u, "");
  return (
    (left.protocol === right.protocol ||
      (left.protocol === "http:" && right.protocol === "https:")) &&
    normalizeHostname(left.hostname) === normalizeHostname(right.hostname) &&
    left.port === right.port
  );
}

function haveSameExactUrl(left: string, right: string) {
  const leftUrl = parseUrl(left);
  const rightUrl = parseUrl(right);
  return Boolean(leftUrl && rightUrl && leftUrl.toString() === rightUrl.toString());
}

function learnTenForeDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const bookingUrl = observedUrls.find(isTenForeBookingUrl);
  if (!bookingUrl) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: canonicalizeTenForeBookingUrl(bookingUrl),
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "NONE",
    policyNotes:
      "The official signed-out TenFore page renders public tee-time availability in a normal browser. Its consumer availability request uses invisible reCAPTCHA, so direct server retrieval is not yet implemented; keep adapter work open instead of treating provider policy or the visible CAPTCHA badge as a terminal monitoring classification.",
    confidence: 0.95,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "tenfore-public-browser-availability"
    }
  };
}

function learnAccountRequiredClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const bookingSurfaceText = evidence.bookingSurfaceText?.replace(/\s+/g, " ").trim() ?? "";
  const whooshBookingUrl = getWhooshPublicBookingUrl(observedUrls);
  const registrationRequired =
    /\bplayers? must register(?: in whoosh)? before booking\b/i.test(bookingSurfaceText);
  const availabilityRequiresConfirmation =
    /\bonce (?:a )?players?[’']s registration is confirmed,? availability of tee times? through whoosh can be viewed\b/i.test(
      bookingSurfaceText
    );
  const signInRequiredToViewAvailability =
    /\b(?:sign|log) in\b[^.]{0,120}\b(?:view|see|access)\b[^.]{0,80}\b(?:tee[ -]?time )?availability\b/i.test(
      bookingSurfaceText
    );

  if (
    !whooshBookingUrl ||
    (!signInRequiredToViewAvailability &&
      !(registrationRequired && availabilityRequiresConfirmation))
  ) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: whooshBookingUrl.toString(),
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "BLOCKED",
    automationReason: "ACCOUNT_REQUIRED",
    policyNotes:
      "The course's official booking guidance says registration must be confirmed before tee-time availability can be viewed in Whoosh. Tee Time Spot does not use golfer accounts or account-specific sessions, so golfers must check the official booking page directly.",
    intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.bookingSurfaceText),
      learnedFrom: "official-account-required-booking"
    }
  };
}

function learnWhooshBookingClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const whooshBookingUrl = getWhooshPublicBookingUrl(observedUrls);

  if (!whooshBookingUrl) {
    return null;
  }

  const providerPolicyText = evidence.providerPolicyText?.replace(/\s+/g, " ").trim() ?? "";
  const providerTermsProhibitAutomation =
    /attempt to (?:access or )?search the whoosh platform or content[^.]{0,500}\b(?:engine|software|tool|agent|device|mechanism)\b/i.test(
      providerPolicyText
    ) &&
    /\b(?:spiders?|robots?|crawlers?|data mining tools?)\b/i.test(providerPolicyText);

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: whooshBookingUrl.toString(),
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "NEEDS_REVIEW",
    automationReason: "UNSUPPORTED_PLATFORM",
    policyNotes:
      providerTermsProhibitAutomation
        ? "The course links to an official public Whoosh booking page. Provider terms are retained as evidence but do not determine read-only monitoring eligibility; reusable monitoring support still needs technical verification."
        : "The course links to an official Whoosh online booking page. Golfers can use that page directly; Tee Time Spot has not yet confirmed reusable monitoring for this Whoosh surface.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(
        providerTermsProhibitAutomation ? providerPolicyText : evidence.visibleText
      ),
      learnedFrom: providerTermsProhibitAutomation
        ? "official-whoosh-booking-policy-evidence"
        : "official-whoosh-booking"
    }
  };
}

function getWhooshPublicBookingUrl(values: string[]) {
  const observed = values
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
          url.hostname.toLocaleLowerCase("en-US") === "app.whoosh.io" &&
          isProviderPublicBookingLandingUrl(url)
      )
    );
  if (!observed || observed.hostname.toLocaleLowerCase("en-US") !== "app.whoosh.io") {
    return null;
  }
  const canonical = new URL(observed);
  canonical.search = "";
  canonical.hash = "";
  canonical.pathname = canonical.pathname.replace(/\/+$/u, "");
  return canonical;
}

function learnWalkInClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const authoritativeVisibleText = evidence.officialPage?.visibleText ??
    evidence.visibleText;
  const visibleText = authoritativeVisibleText
    ?.replace(/\s+/g, " ")
    .trim() ?? "";
  const noTeeTimeEvidence = findExplicitNoTeeTimeEvidence(
    evidence.courseName,
    visibleText
  );
  const dayScopedNoTeeTimeEvidence = findRepeatedDayScopedNoTeeTimeEvidence(
    evidence.courseName,
    authoritativeVisibleText ?? ""
  );
  const noReservationMatch =
    /(?:\btee times?\s+(?:are\s+)?not\s+(?:nec{1,2}essary|required)\b|\bno\s+tee\s+time(?:s|\s+reservations?)\s+(?:are\s+)?(?:needed|nec{1,2}essary|required)\b|\b(?:do|does)\s+not\s+(?:take|accept)\s+tee times?\b)/i.exec(
      visibleText
    );
  if (!noReservationMatch && !noTeeTimeEvidence && !dayScopedNoTeeTimeEvidence) {
    return null;
  }

  if (noTeeTimeEvidence || dayScopedNoTeeTimeEvidence) {
    if (
      hasUnsafePrimaryManualEvidenceUrl(evidence) ||
      hasUntrustedPrimaryManualEvidenceTransition(evidence) ||
      evidence.bookingCallToAction ||
      hasBookingCallToActionEvidence(evidence) ||
      hasTransientTeeTimeRouteEvidence(evidence) ||
      hasCurrentOnlineBookingEvidence(
        evidence,
        observedUrls,
        evidence.sourceUrl,
        false
      )
    ) {
      return null;
    }
    const scopedVisibleText = noTeeTimeEvidence ?? dayScopedNoTeeTimeEvidence!;
    const officialSourceEvidence = getOfficialSourceScopedEvidence(
      evidence,
      scopedVisibleText
    );
    const officialSourceUrls = officialSourceEvidence.observedUrls;
    if (
      evidence.bookingCallToAction ||
      hasBookingCallToActionEvidence(officialSourceEvidence) ||
      hasTransientTeeTimeRouteEvidence(officialSourceEvidence)
    ) {
      return null;
    }
    const manualEvidence = getSafeCourseSourceManualEvidence(
      officialSourceEvidence,
      officialSourceUrls
    );
    if (
      !manualEvidence ||
      hasCurrentOnlineBookingEvidence(
        officialSourceEvidence,
        officialSourceUrls,
        manualEvidence.evidenceUrl,
        true
      )
    ) {
      return null;
    }

    return buildWalkInDiscovery(officialSourceEvidence, manualEvidence, {
      policyNotes: dayScopedNoTeeTimeEvidence
        ? "The course's official site says ordinary weekday and weekend play does not require tee times. Tee Time Spot must direct golfers to the official course information instead of attempting automated retrieval."
        : "The course's official site says it does not use tee times. Tee Time Spot must direct golfers to the official course information instead of attempting automated retrieval.",
      learnedFrom: dayScopedNoTeeTimeEvidence
        ? "official-day-scoped-walk-in-access"
        : "official-no-tee-times-access"
    });
  }

  if (!noReservationMatch) {
    return null;
  }

  const statementStart = Math.max(
    0,
    ...[".", "!", "?"].map(
      (punctuation) =>
        visibleText.lastIndexOf(punctuation, noReservationMatch.index) + 1
    )
  );
  const statementRemainderStart =
    noReservationMatch.index + noReservationMatch[0].length;
  const nextPunctuationOffset = visibleText
    .slice(statementRemainderStart)
    .search(/[.!?]/);
  const statementEnd = nextPunctuationOffset === -1
    ? Math.min(visibleText.length, noReservationMatch.index + 320)
    : Math.min(
        visibleText.length,
        statementRemainderStart + nextPunctuationOffset + 1
      );
  const statement = visibleText.slice(statementStart, statementEnd);
  const statementContext = visibleText.slice(
    Math.max(0, statementStart - 600),
    statementEnd
  );
  const normalizedStatementContext = statementContext.toLocaleLowerCase("en-US");
  const normalizedCourseName = evidence.courseName.toLocaleLowerCase("en-US");
  const targetContextStart = normalizedStatementContext.lastIndexOf(
    normalizedCourseName
  );
  const courseScopedStatementContext = targetContextStart >= 0
    ? statementContext.slice(targetContextStart)
    : statementContext;
  const identifiesTargetCourse =
    hasTargetCourseIdentity(statement, evidence.courseName) ||
    (hasTargetCourseIdentity(statementContext, evidence.courseName) &&
      /\bpublic\b/i.test(statementContext) &&
      /\b(?:nine|9|eighteen|18)[- ]holes?\b/i.test(statementContext));
  const explicitlyFirstCome = /\bfirst[- ]come\s*,?\s*first[- ]serve(?:d)?(?:\s+basis)?\b/i.test(
    statement
  );
  const scopedToNonCourseFacility =
    /\b(?:driving|practice)\s+(?:range|facility|stalls?)\b/i.test(statement);
  const contradictsWalkInOnly =
    /\b(?:book|reserve)\s+(?:a\s+)?tee times?\s+(?:online|now)\b/i.test(statement);

  if (
    !identifiesTargetCourse ||
    hasDifferentExplicitCourseIdentity(statement, evidence.courseName) ||
    hasDifferentNoTeeTimeCourseIdentity(
      courseScopedStatementContext,
      evidence.courseName
    ) ||
    !explicitlyFirstCome ||
    scopedToNonCourseFacility ||
    contradictsWalkInOnly
  ) {
    return null;
  }
  if (hasUnsafeManualEvidenceUrl(evidence, observedUrls)) {
    return null;
  }
  const manualEvidence = getSafeManualEvidence(evidence, observedUrls);
  if (
    !manualEvidence ||
    hasCurrentOnlineBookingEvidence(
      evidence,
      observedUrls,
      manualEvidence.evidenceUrl,
      true
    )
  ) {
    return null;
  }

  return buildWalkInDiscovery(evidence, manualEvidence, {
    policyNotes:
      "The course's official site says tee times are not required and play is first-come, first-served. Tee Time Spot must direct golfers to the official course information instead of attempting automated retrieval.",
    learnedFrom: "official-walk-in-access"
  });
}

function findExplicitNoTeeTimeEvidence(courseName: string, visibleText: string) {
  const targetName = courseName.trim();
  if (!targetName || !visibleText) {
    return null;
  }

  const normalizedTarget = targetName.toLocaleLowerCase("en-US");
  const normalizedText = visibleText.toLocaleLowerCase("en-US");
  const matches = [
    ...visibleText.matchAll(
      /(?:^|[.!?;:]\s+|\n)no\s+tee\s+times?(?=\s*(?:[.!?;:]|$))(?!\s+(?:available|found|left|remaining)\b)/gi
    )
  ];

  for (const match of matches) {
    const matchStart = match.index ?? -1;
    if (matchStart < 0) {
      continue;
    }
    const targetStart = normalizedText.lastIndexOf(normalizedTarget, matchStart);
    if (targetStart < 0 || matchStart - targetStart > 900) {
      continue;
    }
    const betweenTargetAndStatement = visibleText.slice(
      targetStart + targetName.length,
      matchStart
    );
    const targetSectionBeforeStatement = visibleText.slice(
      targetStart,
      matchStart
    );
    const afterStatement = visibleText.slice(
      matchStart + match[0].length,
      Math.min(visibleText.length, matchStart + match[0].length + 180)
    );
    const immediateContactSentence = afterStatement
      .replace(/^[\s.!?;:-]+/, "")
      .split(/[.!?]/, 1)[0] ?? "";
    const scopedText = visibleText.slice(
      targetStart,
      Math.min(visibleText.length, matchStart + match[0].length + 300)
    );
    const identifiesPublicPhysicalCourse =
      /\bpublic\b/i.test(targetSectionBeforeStatement) &&
      /\b(?:nine|9|eighteen|18)[- ]holes?\b/i.test(
        targetSectionBeforeStatement
      );
    const questionOnlyContact =
      /^(?:please\s+)?(?:call|contact)\b.{0,140}\b(?:with|for)\s+(?:any\s+)?questions?\b/i.test(
        immediateContactSentence
      ) &&
      !/\b(?:book(?:ed|ing|ings|s)?|reserv(?:e|ed|es|ing|ation|ations)|tee\s+times?)\b/i.test(
        immediateContactSentence
      );
    if (
      !/\bopen\s+daily\b/i.test(betweenTargetAndStatement) ||
      !identifiesPublicPhysicalCourse ||
      !questionOnlyContact ||
      hasInterveningNamedSection(
        betweenTargetAndStatement,
        targetName
      ) ||
      /\b(?:another\s+date|availability|choose|driving\s+range|inventory|practice\s+range|results?|search|selected\s+date|sold\s+out|try\s+again)\b/i.test(
        betweenTargetAndStatement
      ) ||
      hasDifferentNoTeeTimeCourseIdentity(
        betweenTargetAndStatement,
        targetName
      ) ||
      /\b(?:search|results?|inventory|availability)\b[^.]{0,120}\bno\s+tee\s+times?\b/i.test(
        scopedText
      )
    ) {
      continue;
    }
    return scopedText;
  }
  return null;
}

function hasTransientTeeTimeRouteEvidence(evidence: BrowserDiscoveryEvidence) {
  return [evidence.sourceUrl, evidence.finalUrl].some((value) => {
    const url = parseUrl(value);
    if (!url) {
      return true;
    }
    const encodedRouteState = `${url.hostname} ${url.pathname} ${url.search}`;
    let decodedRouteState = encodedRouteState;
    try {
      decodedRouteState = decodeURIComponent(encodedRouteState);
    } catch {
      // A malformed escape keeps the original bounded route text actionable.
    }
    const routeState = decodedRouteState
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLocaleLowerCase("en-US")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    return /\b(?:book\w*|reserv\w*|search\w*|result\w*|availab\w*|calendar\w*|inventor\w*|schedul\w*|slots?|tee\s*times?)\b/i.test(
      routeState
    );
  });
}

function getSafeCourseSourceManualEvidence(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
) {
  const manualEvidence = getSafeManualEvidence(evidence, observedUrls);
  const sourceUrl = canonicalizeManualUrl(evidence.sourceUrl);
  if (!manualEvidence || !sourceUrl) {
    return null;
  }
  return {
    ...manualEvidence,
    evidenceUrl: sourceUrl,
    observedUrls: [...new Set([sourceUrl, ...manualEvidence.observedUrls])]
  } satisfies SafeManualEvidence;
}

function getOfficialSourceScopedEvidence(
  evidence: BrowserDiscoveryEvidence,
  visibleText: string
): BrowserDiscoveryEvidence {
  const source = parseUrl(evidence.sourceUrl);
  const final = parseUrl(evidence.finalUrl);
  const secureSameHostFinal = Boolean(
    source &&
      final &&
      source.protocol === "http:" &&
      final.protocol === "https:" &&
      normalizeHostname(source.hostname) === normalizeHostname(final.hostname) &&
      normalizeManualEvidencePath(source.pathname) ===
        normalizeManualEvidencePath(final.pathname) &&
      isSafeManualEvidenceUrl(source) &&
      isSafeManualEvidenceUrl(final)
  );
  const sourceUrl = evidence.officialPage?.url ??
    (secureSameHostFinal && final ? final.toString() : evidence.sourceUrl);
  const linkCandidates =
    evidence.officialPage?.linkCandidates ?? evidence.linkCandidates ?? [];
  const observedUrls = uniqueUrls([
    sourceUrl,
    ...(evidence.officialPage?.observedUrls ?? []),
    ...linkCandidates.map(({ url }) => url)
  ]);
  return {
    ...evidence,
    sourceUrl,
    finalUrl: sourceUrl,
    observedUrls,
    linkCandidates,
    visibleText
  };
}

function normalizeManualEvidencePath(value: string) {
  const normalized = value.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
  return normalized || "/";
}

function hasUnsafePrimaryManualEvidenceUrl(evidence: BrowserDiscoveryEvidence) {
  return [evidence.sourceUrl, evidence.finalUrl]
    .filter((value): value is string => Boolean(value))
    .some((value) => {
      const parsed = parseUrl(value);
      return !parsed || !isSafeManualEvidenceUrl(parsed);
    });
}

function hasUntrustedPrimaryManualEvidenceTransition(
  evidence: BrowserDiscoveryEvidence
) {
  if (!evidence.finalUrl) {
    return false;
  }
  const source = parseUrl(evidence.sourceUrl);
  const final = parseUrl(evidence.finalUrl);
  const officialPage = parseUrl(evidence.officialPage?.url);
  if (!source || !final || final.protocol !== "https:") {
    return true;
  }
  if (
    officialPage &&
    evidence.officialPage?.courseName &&
    haveCompatibleCourseNames(
      evidence.courseName,
      evidence.officialPage.courseName
    ) &&
    evidence.officialPage.visibleText?.trim() &&
    isSafeManualEvidenceUrl(officialPage) &&
    normalizeHostname(source.hostname) ===
      normalizeHostname(officialPage.hostname)
  ) {
    return false;
  }
  return (
    normalizeHostname(source.hostname) !== normalizeHostname(final.hostname) ||
    normalizeManualEvidencePath(source.pathname) !==
      normalizeManualEvidencePath(final.pathname)
  );
}

function hasInterveningNamedSection(value: string, courseName: string) {
  return [
    ...value.matchAll(
      /\b((?:[A-Z][\p{L}\p{N}'â€™&-]*\s+){0,5}[A-Z][\p{L}\p{N}'â€™&-]*)\s+is\s+open\s+daily\b/gu
    )
  ].some((match) => !isLikelyTargetCourseAlias(match[1] ?? "", courseName));
}

function hasDifferentNoTeeTimeCourseIdentity(value: string, courseName: string) {
  return [
    ...value.matchAll(
      /\b((?:[A-Z][\p{L}\p{N}'â€™&-]*[^\S\r\n]+){0,6}(?:Golf[^\S\r\n]+(?:Course|Club|Center|Centre|Links)|Country[^\S\r\n]+Club))\b/gu
    )
  ].some((match) => {
    const candidate = match[1] ?? "";
    if (
      /^(?:(?:nine|9|eighteen|18)[- ]?)?holes?\s+public\s+golf\s+(?:course|club|center|centre|links)$/i.test(
        candidate
      )
    ) {
      return false;
    }
    const matchStart = match.index ?? -1;
    const lineStart = matchStart >= 0
      ? value.lastIndexOf("\n", Math.max(0, matchStart - 1)) + 1
      : -1;
    const followingLineBreak = matchStart >= 0
      ? value.indexOf("\n", matchStart + candidate.length)
      : -1;
    const lineEnd = followingLineBreak >= 0 ? followingLineBreak : value.length;
    const containingLine = lineStart >= 0
      ? value.slice(lineStart, lineEnd).trim()
      : "";
    if (
      containingLine.localeCompare(candidate, "en-US", { sensitivity: "accent" }) === 0 &&
      isGenericGolfFacilityLabel(candidate)
    ) {
      return false;
    }
    return !isLikelyTargetCourseAlias(candidate, courseName);
  });
}

function isLikelyTargetCourseAlias(candidate: string, courseName: string) {
  const genericTokens = new Set([
    "club",
    "course",
    "golf",
    "links",
    "center",
    "centre",
    "country",
    "park",
    "public",
    "the"
  ]);
  const normalizedCandidate = normalizeCourseIdentityName(candidate);
  const normalizedTarget = normalizeCourseIdentityName(courseName);
  const candidateLabel = candidate
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const targetLabel = courseName
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const facilityKinds = [
    "country club",
    "golf club",
    "golf course",
    "golf center",
    "golf centre",
    "golf links"
  ];
  const candidateKind = facilityKinds.find((kind) =>
    candidateLabel.endsWith(kind)
  );
  const targetKind = facilityKinds.find((kind) => targetLabel.endsWith(kind));
  if (candidateKind && targetKind && candidateKind !== targetKind) {
    return false;
  }
  const targetTokens = new Set(
    normalizedTarget
      .split(" ")
      .filter((token) => token && !genericTokens.has(token))
  );
  const candidateTokens = normalizedCandidate
    .split(" ")
    .filter((token) => token && !genericTokens.has(token));
  return Boolean(
    candidateTokens.length > 0 &&
      candidateTokens.every((token) => targetTokens.has(token))
  );
}

function buildWalkInDiscovery(
  evidence: BrowserDiscoveryEvidence,
  manualEvidence: NonNullable<ReturnType<typeof getSafeManualEvidence>>,
  input: { policyNotes: string; learnedFrom: string }
): BrowserDiscovery {
  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: manualEvidence.evidenceUrl,
    bookingUrl: manualEvidence.evidenceUrl,
    bookingMethod: "WALK_IN",
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    policyNotes: input.policyNotes,
    intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: manualEvidence.evidenceUrl,
      observedUrls: manualEvidence.observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: input.learnedFrom
    }
  };
}

function learnOfficialPhoneReservationClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = normalizeTeeTimeTypography(
    evidence.visibleText?.replace(/\s+/g, " ").trim() ?? ""
  );
  const directPhone = findDirectTeeTimeReservationPhone(visibleText);
  if (directPhone.kind === "NONE") {
    return null;
  }
  if (directPhone.kind === "AMBIGUOUS") {
    return hasKnownProviderEvidence(evidence, observedUrls)
      ? null
      : buildRejectedManualDiscovery(evidence, observedUrls, "ambiguous-phone-evidence");
  }
  if (!hasStrongCourseIdentityEvidence(evidence.courseName, visibleText, directPhone)) {
    return null;
  }

  if (hasUnsafeManualEvidenceUrl(evidence, observedUrls)) {
    return hasKnownProviderEvidence(evidence, observedUrls)
      ? null
      : buildRejectedManualDiscovery(evidence, observedUrls, "unsafe-url-evidence");
  }

  const manualEvidence = getSafeManualEvidence(evidence, observedUrls, true);
  if (!manualEvidence) {
    return null;
  }

  const explicitlyPhoneOnly = hasExplicitPhoneOnlyEvidence(visibleText);
  if (
    hasCurrentOnlineBookingEvidence(
      evidence,
      observedUrls,
      manualEvidence.evidenceUrl,
      explicitlyPhoneOnly
    )
  ) {
    return null;
  }

  const bookingMethod = explicitlyPhoneOnly ? "PHONE_ONLY" : "CONTACT_COURSE";
  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: manualEvidence.evidenceUrl,
    bookingUrl: manualEvidence.evidenceUrl,
    bookingMethod,
    bookingPhone: directPhone.phone,
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    policyNotes: explicitlyPhoneOnly
      ? "The official course page explicitly says tee-time reservations are phone-only and publishes the number to call. Tee Time Spot cannot monitor phone-only inventory, so golfers should call the course directly."
      : "The official course page directs golfers to call the course to reserve a tee time and exposes no current online booking surface. Tee Time Spot cannot confirm live inventory automatically, so golfers should contact the course directly.",
    intelligenceReviewAt: new Date(
      Date.now() + (explicitlyPhoneOnly ? 90 : 30) * 24 * 60 * 60 * 1000
    ),
    confidence: explicitlyPhoneOnly ? 0.98 : 0.92,
    evidence: {
      finalUrl: manualEvidence.evidenceUrl,
      observedUrls: manualEvidence.observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: explicitlyPhoneOnly
        ? "official-phone-only-tee-time-access"
        : "official-phone-reservation-contact"
    }
  };
}

function hasStrongCourseIdentityEvidence(
  courseName: string,
  visibleText: string,
  directPhone: Extract<DirectReservationPhone, { kind: "FOUND" }>
) {
  const normalizedCourseName = normalizeCourseIdentityName(courseName);
  const meaningfulTokens = normalizedCourseName.split(" ").filter(Boolean);
  const genericTokens = new Set([
    "the",
    "at",
    "of",
    "golf",
    "course",
    "club",
    "center",
    "centre",
    "municipal",
    "public"
  ]);
  if (
    meaningfulTokens.length < 2 ||
    !meaningfulTokens.some((token) => token.length >= 3 && !genericTokens.has(token))
  ) {
    return false;
  }

  const precedingContext = visibleText.slice(
    Math.max(0, directPhone.matchStart - 600),
    directPhone.matchStart
  );
  const normalizedContext = normalizeCourseIdentityName(precedingContext);
  if (!` ${normalizedContext} `.includes(` ${normalizedCourseName} `)) {
    return false;
  }
  const targetStart = precedingContext
    .toLocaleLowerCase("en-US")
    .lastIndexOf(courseName.toLocaleLowerCase("en-US"));
  if (targetStart < 0) {
    return false;
  }

  const betweenTargetAndInstruction = precedingContext.slice(
    targetStart + courseName.length
  );
  const afterInstruction = visibleText.slice(
    directPhone.matchEnd,
    directPhone.matchEnd + 200
  );
  if (
    hasDifferentExplicitCourseIdentity(
      `${betweenTargetAndInstruction} ${afterInstruction}`,
      courseName
    ) ||
    hasUnscopedPhoneAssociationContext(
      betweenTargetAndInstruction,
      afterInstruction
    )
  ) {
    return false;
  }
  return true;
}

function hasDifferentExplicitCourseIdentity(value: string, courseName: string) {
  const normalizedTarget = normalizeCourseIdentityName(courseName);
  return [
    ...value.matchAll(
      /\b((?:[\p{L}\p{N}'’&-]+\s+){0,6}(?:golf\s+(?:course|club|center|centre|links)|country\s+club))\b/giu
    )
  ].some((match) => {
    const candidate = match[1] ?? "";
    if (normalizeCourseIdentityName(candidate) === normalizedTarget) {
      return false;
    }
    const genericWords = new Set([
      "a",
      "an",
      "the",
      "is",
      "our",
      "public",
      "private",
      "municipal",
      "golf",
      "course",
      "club",
      "center",
      "centre",
      "links",
      "country",
      "executive",
      "eighteen",
      "hole",
      "holes",
      "nine",
      "par"
    ]);
    return candidate
      .normalize("NFKD")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.some((token) => !/^\d+$/.test(token) && !genericWords.has(token)) ?? false;
  });
}

function hasTargetCourseIdentity(value: string, courseName: string) {
  const targetTokens = normalizeCourseIdentityName(courseName).split(" ").filter(Boolean);
  if (targetTokens.length === 0) {
    return false;
  }
  if (targetTokens.length === 1) {
    const normalizedValue = normalizeExactCourseNamePhrase(value);
    const normalizedCourseName = normalizeExactCourseNamePhrase(courseName);
    return Boolean(
      normalizedCourseName &&
      ` ${normalizedValue} `.includes(` ${normalizedCourseName} `)
    );
  }
  const valueTokens = new Set(
    normalizeCourseIdentityName(value).split(" ").filter(Boolean)
  );
  return targetTokens.every((token) => valueTokens.has(token));
}

function normalizeExactCourseNamePhrase(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function hasDifferentNamedCourseIdentity(value: string, courseName: string) {
  const targetTokens = normalizeCourseIdentityName(courseName).split(" ").filter(Boolean);
  const boundaryTokens = new Set([
    "adjacent",
    "beside",
    "is",
    "near",
    "next",
    "to",
    "visit",
    "welcome",
    "where"
  ]);
  const nonNameTokens = new Set([
    "a",
    "an",
    "available",
    "award",
    "challenging",
    "championship",
    "eighteen",
    "for",
    "hole",
    "holes",
    "is",
    "member",
    "members",
    "neighborhood",
    "nine",
    "offers",
    "our",
    "private",
    "public",
    "resident",
    "residents",
    "social",
    "the",
    "to",
    "use",
    "winning"
  ]);
  const leadingDescriptorTokens = new Set([
    "a",
    "an",
    "award",
    "challenging",
    "championship",
    "eighteen",
    "hole",
    "holes",
    "nine",
    "our",
    "private",
    "public",
    "the",
    "winning"
  ]);
  const candidatesByEnd = new Map<number, string[][]>();
  for (const match of value.matchAll(
    /(?=\b((?:[\p{L}][\p{L}\p{N}'’&-]*\s+){1,6}?(?:golf\s+(?:course|club|center|centre|links)|country\s+club))\b)/giu
  )) {
    const rawCandidate = match[1] ?? "";
    const rawTokens = rawCandidate.match(/[\p{L}\p{N}'’&-]+/gu) ?? [];
    let boundaryIndex = -1;
    rawTokens.forEach((token, index) => {
      if (boundaryTokens.has(token.toLocaleLowerCase("en-US"))) {
        boundaryIndex = index;
      }
    });
    const normalizedCandidateTokens = normalizeCourseIdentityName(
      rawTokens.slice(boundaryIndex + 1).join(" ")
    ).split(" ").filter(Boolean);
    const firstIdentityToken = normalizedCandidateTokens.findIndex(
      (token) =>
        !/^\d+$/u.test(token) && !leadingDescriptorTokens.has(token)
    );
    const candidateTokens = firstIdentityToken < 0
      ? []
      : normalizedCandidateTokens.slice(firstIdentityToken);
    if (candidateTokens.length === 0) {
      continue;
    }
    const end = (match.index ?? 0) + rawCandidate.length;
    const candidates = candidatesByEnd.get(end) ?? [];
    candidates.push(candidateTokens);
    candidatesByEnd.set(end, candidates);
  }

  return [...candidatesByEnd.values()].some((candidates) => {
    const candidateTokens = [...candidates].sort(
      (left, right) => right.length - left.length
    )[0];
    if (
      !candidateTokens ||
      candidateTokens.join(" ") === targetTokens.join(" ")
    ) {
      return false;
    }
    return candidateTokens.some(
      (token) => !/^\d+$/u.test(token) && !nonNameTokens.has(token)
    );
  });
}

function hasUnscopedPhoneAssociationContext(
  betweenTargetAndInstruction: string,
  afterInstruction: string
) {
  if (
    betweenTargetAndInstruction
      .split(/[.!?;]+/u)
      .map((part) => part.replace(/^[\s,:-]+|[\s,:-]+$/gu, ""))
      .filter(Boolean)
      .some((part) => !isSafePhoneAssociationPart(part))
  ) {
    return true;
  }

  return afterInstruction
    .split(/[.!?;]+/u)
    .map((part) =>
      part.replace(/^[\s()[\]{},:/\\\-–—]+|[\s()[\]{},:/\\\-–—]+$/gu, "")
    )
    .filter(Boolean)
    .slice(0, 2)
    .some(
      (part) =>
        !/^(?:the\s+course|(?:for|with)\s+more\s+information|(?:for|with)\s+more\s+details|details)$/i.test(
          part
        ) && !isSafePhoneAssociationPart(part)
    );
}

function isSafePhoneAssociationPart(value: string) {
  const normalized = value
    .replace(/[*_]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const isLastTeeTimeNotice =
    /^(?:as\s+of\s+[a-z]+\s+\d{1,2}\s*,?\s*\d{4}\s*:?\s*)?(?:weather\s+permitting\s*)?(?:our\s+)?last\s+tee[- ]?time\b.{0,160}\b(?:holes?|am|pm)\b/i.test(
      normalized
    );
  if (!isLastTeeTimeNotice && /\b(?:at|for)\b/i.test(normalized)) {
    return false;
  }
  const hasRecognizedStructure = (
    /^(?:please|rates?|pricing|green\s+fees?)$/i.test(normalized) ||
    /^(?:is|offers?|features?)\s+(?:an?\s+)?(?:\d+[- ]hole\s+)?(?:public|private|municipal)?\s*golf\s+(?:course|club|center|centre|links)$/i.test(
      normalized
    ) ||
    /^(?:tee[- ]?times?|tee[- ]?time\s+reservations?|reservations?|bookings?)\b.{0,240}\b(?:may|can|are|is|must|accepted|taken|booked|reserved|scheduled|phone|online|advance)\b/i.test(
      normalized
    ) ||
    isLastTeeTimeNotice ||
    /^(?:events?|outings?)(?:\s+and\s+(?:events?|outings?))?\b.{0,160}\bcall\b/i.test(
      normalized
    )
  );
  if (!hasRecognizedStructure) {
    return false;
  }
  const allowedWords = new Set([
    "a", "adult", "adults", "advance", "after", "all", "am", "an", "and",
    "are", "as", "at", "be", "before", "between", "book", "booked", "booking",
    "bookings", "by", "call", "can", "cart", "carts", "closed", "contact",
    "course", "courses", "current", "daily", "day", "days", "daytime", "during",
    "each", "events", "fee", "fees", "first", "for", "friday", "from", "golf",
    "green", "greens", "holiday", "holidays", "hole", "holes", "hour", "hours",
    "highly", "in", "included", "includes", "is", "junior", "juniors", "last",
    "may", "military",
    "monday", "must", "night", "no", "not", "offered", "on", "one", "online",
    "of", "only", "open", "our", "outings", "per", "permitting", "phone", "please",
    "pm", "pricing",
    "private", "pro", "public", "rate", "rates", "regular", "reservation",
    "recommended", "reservations", "reserve", "reserved", "reserving", "resident", "riding",
    "saturday", "schedule", "scheduled", "senior", "seniors", "shop", "sunday",
    "taken", "tax", "tee", "the", "thursday", "time", "times", "to", "tuesday",
    "twilight", "up", "walking", "weather", "wednesday", "week", "weekday", "weekdays",
    "weekend", "weekends", "weeks", "your", "january", "february", "march", "april",
    "june", "july", "august", "september", "october", "november", "december"
  ]);
  const tokens = normalized
    .normalize("NFKD")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return tokens.length > 0 && tokens.every(
    (token) => /^\d+$/.test(token) || allowedWords.has(token)
  );
}

type DirectReservationPhone =
  | { kind: "NONE" }
  | { kind: "AMBIGUOUS" }
  | { kind: "FOUND"; phone: string; matchStart: number; matchEnd: number };

function findDirectTeeTimeReservationPhone(visibleText: string): DirectReservationPhone {
  const patterns = [
    /\b(?:please\s+)?call\s+(?:(?:the\s+)?pro\s+shop\s*)?(?:at\s*)?((?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})\s*(?:,|\s)*(?:to|for)\s+(?:book|reserve|schedule|make)\s+(?:a\s+|your\s+|the\s+)?(?:tee\s*times?|tee\s*time\s+reservations?)/gi,
    /\b(?:book|reserve|schedule|make)\s+(?:a\s+|your\s+|the\s+)?(?:tee\s*times?|tee\s*time\s+reservations?)\s+(?:by\s+)?call(?:ing)?\s+(?:(?:the\s+)?pro\s+shop\s*)?(?:at\s*)?((?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})\b/gi,
    /\b(?:for\s+)?(?:tee\s*times?|tee\s*time\s+reservations?)\s*[:,;-]?\s*(?:please\s+)?call\s+(?:(?:the\s+)?pro\s+shop\s*)?(?:at\s*)?((?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})\b/gi,
    /\btee\s*times?\b[^.!?]{0,80}\b(?:made|booked|reserved|scheduled)\b[^.!?]{0,60}\b(?:by\s+)?call(?:ing)?\s+(?:(?:the\s+)?pro\s+shop\s*)?(?:at\s*)?((?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})\b/gi,
    /\b(?:please\s+)?call\s+(?:(?:the\s+)?pro\s+shop\s*)?(?:at\s*)?((?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4})\s*(?:,|\s)*(?:for\s+)?tee\s*times?\b/gi
  ];
  const phoneByDigits = new Map<
    string,
    { phone: string; matchStart: number; matchEnd: number }
  >();
  for (const pattern of patterns) {
    for (const match of visibleText.matchAll(pattern)) {
      const phone = match[1]?.replace(/\s+/g, " ").trim();
      const digits = phone?.replace(/\D/g, "");
      if (phone && digits) {
        const normalizedDigits = digits.length === 11 && digits.startsWith("1")
          ? digits.slice(1)
          : digits;
        if (!phoneByDigits.has(normalizedDigits)) {
          const matchStart = match.index ?? 0;
          phoneByDigits.set(normalizedDigits, {
            phone,
            matchStart,
            matchEnd: matchStart + match[0].length
          });
        }
      }
    }
  }

  if (phoneByDigits.size === 0) {
    return { kind: "NONE" };
  }
  if (phoneByDigits.size > 1) {
    return { kind: "AMBIGUOUS" };
  }
  return { kind: "FOUND", ...[...phoneByDigits.values()][0] };
}

function hasExplicitPhoneOnlyEvidence(value: string) {
  return [
    /\b(?:phone|telephone|call(?:ing)?)\s*[- ]?only\b/i,
    /\b(?:tee\s*times?|reservations?)\b.{0,80}\bmust\b.{0,80}\b(?:call|phone)\b/i,
    /\bmust\s+call\b.{0,80}\b(?:tee\s*times?|reservations?)\b/i,
    /\bno\s+online\s+(?:booking|reservations?|tee\s*times?)\b/i,
    /\bonline\s+(?:booking|reservations?|tee\s*times?)\b.{0,40}\b(?:is|are)\s+(?:not\s+available|unavailable|disabled|not\s+offered)\b/i,
    /\bwe\s+do\s+not\s+(?:offer|accept|take)\s+online\s+(?:booking|reservations?|tee\s*times?)\b/i
  ].some((pattern) => pattern.test(value));
}

function hasCurrentOnlineBookingEvidence(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  evidenceUrl: string,
  allowDemonstrablyNonBookingEvidenceUrl: boolean
) {
  const allUrls = uniqueUrls([
    ...observedUrls,
    ...(evidence.linkCandidates ?? []).map(({ url }) => url)
  ]);
  if (
    allUrls.some((url) => resolveProviderCapability({ detectedBookingUrl: url }).capability)
  ) {
    return true;
  }

  const hasBookingDestination = allUrls.some((url) => {
    const parsed = parseUrl(url);
    if (!parsed || !hasExplicitTeeTimeDestination(parsed)) {
      return false;
    }
    return !(
      allowDemonstrablyNonBookingEvidenceUrl &&
      canonicalizeManualUrl(url) === evidenceUrl
    );
  });
  if (hasBookingDestination) {
    return true;
  }

  return (
    hasBookingCallToActionEvidence(evidence) ||
    hasPositiveOnlineBookingText(evidence.visibleText ?? "")
  );
}

function hasBookingCallToActionEvidence(evidence: BrowserDiscoveryEvidence) {
  return (evidence.linkCandidates ?? []).some(
    (candidate) =>
      isBookingCallToActionCandidate(candidate) ||
      isGenericOnlineBookingCallToAction(candidate)
  );
}

function isGenericOnlineBookingCallToAction(candidate: {
  url: string;
  label: string;
}) {
  const parsed = parseUrl(candidate.url);
  if (
    !parsed ||
    isClearlyUnrelatedBookingLabel(candidate.label) ||
    isClearlyUnrelatedBookingUrl(parsed)
  ) {
    return false;
  }
  const label = normalizeTeeTimeTypography(candidate.label)
    .replace(/\s+/g, " ")
    .trim();
  return Boolean(
    /\b(?:book(?:ing)?\s+online|online\s+booking)\b/i.test(label) &&
      /(?:^|\/)(?:book|booking|reserve|reservation)(?:\/|$)/i.test(
        parsed.pathname
      )
  );
}

function isBookingCallToActionCandidate(candidate: { url: string; label: string }) {
  const parsed = parseUrl(candidate.url);
  if (!parsed) {
    return false;
  }
  if (
    isClearlyUnrelatedBookingLabel(candidate.label)
  ) {
    return false;
  }
  return isBookingCallToActionLabel(candidate.label);
}

function isClearlyUnrelatedBookingUrl(url: URL) {
  if (hasExplicitTeeTimeDestination(url)) {
    return false;
  }
  return hasClearlyUnrelatedBookingCategory(
    `${url.hostname} ${url.pathname} ${url.search}`
  );
}

function hasExplicitTeeTimeDestination(url: URL) {
  return /(?:^|\/)(?:(?:book|reserve|schedule)[-_ ]+(?:a[-_ ]+)?)?tee[-_ ]?times?(?:[-_ ]+(?:booking|reservations?))?(?:\.(?:aspx?|php\d?|s?html?|xhtml|jspx?|cfm|cgi|do|action))?(?:\/|$)/i.test(
    url.pathname
  );
}

function isClearlyUnrelatedBookingLabel(value: string) {
  return hasClearlyUnrelatedBookingCategory(value);
}

function hasClearlyUnrelatedBookingCategory(value: string) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\b(?:privacy|terms|careers?|jobs?|employment|lessons?|instruction|academ(?:y|ies)|golf\s*academ(?:y|ies)|golf\s*schools?|clinics?|camps?|leagues?|tournaments?|simulators?|indoor\s*golf|driving\s*ranges?|practice\s*ranges?|golf\s*ranges?|mini\s*golf|miniature\s*golf|top\s*tracer|trackman|pickle\s*ball|tennis|pools?|rv\s*sites?|club\s*rentals?|equipment\s*rentals?|gift\s*cards?|memberships?|events?|outings?|restaurants?|dining|food|beverage|lodging|lodges?|stays?|resorts?|hotels?|accommodations?|cabins?|rooms?|spa|appointments?|wellness|fitness|gyms?|massage|marinas?|campgrounds?|water\s*parks?|pro\s*shops?|stores?|merchandise|fittings?|banquets?|weddings?|venues?)\b/i.test(
    normalized
  );
}

function isBookingCallToActionLabel(value: string) {
  const normalized = normalizeTeeTimeTypography(value).replace(/\s+/g, " ").trim();
  if (
    /\b(?:call(?:ing)?|phone)\b/i.test(normalized) &&
    !/\bonline\b/i.test(normalized)
  ) {
    return false;
  }
  return (
    /\btee\s*times?\b/i.test(normalized) &&
    /\b(?:book|reserve|schedule|view|see|search|find|check|make|online)\b/i.test(
      normalized
    )
  );
}

type SafeManualEvidence = {
  evidenceUrl: string;
  observedUrls: string[];
};

function getSafeManualEvidence(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  requireFinalUrl = false
): SafeManualEvidence | null {
  if (requireFinalUrl && !evidence.finalUrl) {
    return null;
  }
  const sourceUrl = parseUrl(evidence.sourceUrl);
  const finalUrl = parseUrl(evidence.finalUrl ?? evidence.sourceUrl);
  if (
    !sourceUrl ||
    !finalUrl ||
    !["http:", "https:"].includes(sourceUrl.protocol) ||
    finalUrl.protocol !== "https:" ||
    normalizeHostname(sourceUrl.hostname) !== normalizeHostname(finalUrl.hostname) ||
    !isSafeManualEvidenceUrl(sourceUrl) ||
    !isSafeManualEvidenceUrl(finalUrl)
  ) {
    return null;
  }

  const evidenceUrl = canonicalizeManualUrl(finalUrl.toString());
  if (!evidenceUrl) {
    return null;
  }
  return {
    evidenceUrl,
    observedUrls: [
      ...new Set(
        uniqueUrls([...observedUrls, evidenceUrl]).flatMap((url) => {
          const parsed = parseUrl(url);
          const sanitized = canonicalizeManualUrl(url);
          return parsed?.protocol === "https:" && sanitized
            ? [sanitized]
            : [];
        })
      )
    ]
  };
}

function hasKnownProviderEvidence(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
) {
  return [
    evidence.sourceUrl,
    evidence.finalUrl,
    ...observedUrls,
    ...(evidence.linkCandidates ?? []).map(({ url }) => url)
  ].some((value) => {
    const parsed = parseUrl(value);
    return Boolean(
      parsed &&
      isSafeManualEvidenceUrl(parsed) &&
      resolveProviderCapability({ detectedBookingUrl: value }).capability
    );
  });
}

function hasUnsafeManualEvidenceUrl(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
) {
  const primaryUrls = [evidence.sourceUrl, evidence.finalUrl].filter(
    (value): value is string => Boolean(value)
  );
  if (
    primaryUrls.some((value) => {
      const parsed = parseUrl(value);
      return !parsed || !isSafeManualEvidenceUrl(parsed);
    })
  ) {
    return true;
  }

  return [
    ...observedUrls,
    ...(evidence.linkCandidates ?? []).map(({ url }) => url)
  ].some((value) => {
    if (!value) {
      return false;
    }
    const parsed = parseUrl(value);
    if (!parsed) {
      return true;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    return !isSafeManualEvidenceUrl(parsed);
  });
}

function isSafeManualEvidenceUrl(url: URL) {
  const hasInvalidPort = Boolean(
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  );
  return !(
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    hasInvalidPort ||
    url.hostname.endsWith(".") ||
    isPrivateManualHostname(url.hostname) ||
    isForbiddenManualSurfaceHostname(url.hostname) ||
    hasSensitiveManualUrlState(url)
  );
}

function hasSensitiveManualUrlState(url: URL, nestingDepth = 0) {
  for (const [key, value] of url.searchParams) {
    const decodedKey = decodeUrlComponent(key);
    const decodedValue = decodeUrlComponent(value);
    if (
      !decodedKey ||
      decodedValue === null ||
      isSensitiveManualUrlKey(decodedKey) ||
      isContextualSensitiveManualUrlParameter(decodedKey, decodedValue, url) ||
      isOpaqueCredentialValue(decodedValue) ||
      hasUnsafeNestedManualUrl(decodedValue, url, nestingDepth, decodedKey)
    ) {
      return true;
    }
  }
  const decodedPath = decodeUrlPath(url.pathname);
  if (!decodedPath) {
    return true;
  }
  const pathSegments = decodedPath
    .split(/[/;=]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const decodedHash = decodeUrlComponent(url.hash.slice(1));
  if (decodedHash === null) {
    return true;
  }
  if (hasSensitiveManualFragmentState(decodedHash, url, nestingDepth)) {
    return true;
  }
  const hashSegments = decodedHash
    .split(/[/;=?&]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return (
    pathSegments.some(isForbiddenManualPathSegment) ||
    hasForbiddenAdjacentManualPathSegments(pathSegments) ||
    hasRestrictedManualBookingPathSegments(pathSegments) ||
    pathSegments.some((segment, index) =>
      (isOpaqueCredentialValue(segment) ||
        isOpaqueManualRedirectPathSegment(pathSegments, index)) &&
      !isAllowedPublicOpaquePathSegment(pathSegments, index)
    ) ||
    hashSegments.some(isForbiddenManualPathSegment) ||
    hasForbiddenAdjacentManualPathSegments(hashSegments) ||
    hasRestrictedManualBookingPathSegments(hashSegments) ||
    hashSegments.some((segment, index) =>
      (isOpaqueCredentialValue(segment) ||
        isOpaqueManualRedirectPathSegment(hashSegments, index)) &&
      !isAllowedPublicOpaquePathSegment(hashSegments, index)
    )
  );
}

function hasForbiddenAdjacentManualPathSegments(segments: string[]) {
  return segments.some((segment, index) => {
    if (index === 0) {
      return false;
    }
    const adjacent = `${segments[index - 1] ?? ""}${segment}`
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    return isForbiddenCompactManualSecurityRoute(adjacent);
  });
}

function hasRestrictedManualBookingPathSegments(segments: string[]) {
  const normalized = segments.map((segment) =>
    segment
      .replace(/\.(?:aspx?|php\d?|s?html?|xhtml|jspx?|cfm|cgi|do|action)$/i, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase()
  );
  return normalized.some((segment, index) => {
    if (
      !/^(?:admins?|staff|members?|customers?|users?|clients?|partners?|employees?|secure|accounts?|myaccount|portal)(?:v?\d+)?$/.test(
        segment
      )
    ) {
      return false;
    }
    const tailSegments = normalized.slice(index + 1);
    return tailSegments.join("").includes("teetime") || tailSegments.some(
      (tailSegment) =>
        /^(?:book|booking|reserve|reservation|schedule|checkout|cart|portal|dashboard|account)$/.test(
          tailSegment
        )
    );
  });
}

function hasSensitiveManualFragmentState(
  value: string,
  parentUrl: URL,
  nestingDepth: number
) {
  if (hasUnsafeNestedManualUrl(value, parentUrl, nestingDepth)) {
    return true;
  }
  const fragment = value.replace(/^\/+/, "");
  const queryLike = fragment.includes("?")
    ? fragment.slice(fragment.indexOf("?") + 1)
    : fragment;
  if (!queryLike.includes("=")) {
    return false;
  }
  return queryLike.split("&").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) {
      return false;
    }
    const key = decodeUrlComponent(part.slice(0, separator));
    const valuePart = decodeUrlComponent(part.slice(separator + 1));
    return (
      !key ||
      valuePart === null ||
      isSensitiveManualUrlKey(key) ||
      isContextualSensitiveManualUrlParameter(key, valuePart, parentUrl) ||
      isOpaqueCredentialValue(valuePart) ||
      hasUnsafeNestedManualUrl(valuePart, parentUrl, nestingDepth, key)
    );
  });
}

function hasUnsafeNestedManualUrl(
  value: string,
  parentUrl: URL,
  nestingDepth: number,
  parameterKey?: string
) {
  const trimmed = value.trim();
  const isUrlLike = Boolean(
    /^(?:https?:\/\/|\/\/|\/|\.\.?(?:\/|$))/i.test(trimmed) ||
      /^(?:https?:)?[\\/]{2}/i.test(trimmed) ||
      /^[^?#\s]+\/[^\s]*$/.test(trimmed) ||
      (parameterKey && isNavigationManualUrlKey(parameterKey))
  );
  if (!isUrlLike) {
    return false;
  }
  if (nestingDepth >= 2) {
    return true;
  }
  try {
    const nested = new URL(trimmed, parentUrl);
    const hasInvalidPort = Boolean(
      nested.port &&
      !(
        (nested.protocol === "http:" && nested.port === "80") ||
        (nested.protocol === "https:" && nested.port === "443")
      )
    );
    return (
      nested.origin !== parentUrl.origin ||
      !["http:", "https:"].includes(nested.protocol) ||
      Boolean(nested.username || nested.password) ||
      hasInvalidPort ||
      nested.hostname.endsWith(".") ||
      isPrivateManualHostname(nested.hostname) ||
      isForbiddenManualSurfaceHostname(nested.hostname) ||
      hasSensitiveManualUrlState(nested, nestingDepth + 1)
    );
  } catch {
    return true;
  }
}

function isNavigationManualUrlKey(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /^(?:url|uri|(?:next|continue|destination|dest|goto|return|redirect|success|cancel|callback|forward|target|relay)(?:to|url|uri|path|location|destination)?)$/.test(
    normalized
  );
}

function decodeUrlComponent(value: string) {
  let decoded = value;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        return decoded;
      }
      decoded = next;
    }
    return /%[0-9a-f]{2}/i.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

const decodeUrlPath = decodeUrlComponent;

function isForbiddenManualPathSegment(value: string) {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const tokens = getManualSecurityTokens(value);
  const hasStrongSensitiveToken = tokens.some((token) =>
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|login|signin|signup|logout|register|registration|session|jsessionid|signed|signature|token|auth\d*|authentication|authorize|authorization|oauth\d*|openid|oidc|sso\d*|saml|assertion|relaystate|ticket|credential|password|passwordless|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|turnstile|queue|queueit|waitingroom|verify|verification|magiclink|invite|invitation|checkout)$/i.test(
      token
    )
  );
  const hasSensitiveFlowPair =
    tokens.some((token) =>
      /^(?:payment|pay|cart|purchase|order|challenge)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|acs|connect|provider|gateway|settings|reset|recover|recovery|forgot|checkout|booking|reservation)$/i.test(
        token
      )
    );
  const hasAccountSurfacePair =
    tokens.some((token) =>
      /^(?:admin|staff|member|customer|user)$/i.test(token)
    ) &&
    tokens.some((token) =>
      /^(?:account|dashboard|portal|profile|settings|login|signin)$/i.test(token)
    );
  const hasIdentityRecoveryPair =
    tokens.some((token) =>
      /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)$/i.test(
        token
      )
    ) &&
    tokens.some((token) => /^(?:username|email|password|account)$/i.test(token));
  return (
    hasStrongSensitiveToken ||
    hasSensitiveFlowPair ||
    hasAccountSurfacePair ||
    hasIdentityRecoveryPair ||
    isForbiddenCompactManualSecurityRoute(normalized) ||
    /^(?:checkout|securecheckout|payment|pay|cart|shoppingcart|purchase|order|myaccount|useraccount|memberaccount|customeraccount|account|accountlogin|accountsignin|accountsignup|accountportal|memberportal|customerportal|login|userlogin|memberlogin|customerlogin|loginredirect|signin|signup|logout|register|registration|createaccount|session|jsessionid|signed|signature|token|auth|authentication|authcallback|auth0|oauth\d*|oauthcallback|authorize|authorization|openid|oidc|sso|ssologin|saml|assertion|relaystate|ticket|credential|password|passwordless|resetpassword|passwordreset|secret|consent|mfa|2fa|webauthn|captcha|recaptcha|captchachallenge|turnstile|queue|queueit|waitingroom|challenge|challengeplatform|verify|verification|verifyemail|emailverification|magiclink|invite|invitation)$/.test(
      normalized
    ) ||
    /^(?:(?:forgot|reset|recover|recovery)(?:my)?(?:password|account)(?:confirm|confirmation)?|(?:password|account)(?:forgot|reset|recover|recovery|settings)(?:confirm|confirmation)?|(?:login|signin|auth|oauth\d*|oidc|sso)(?:callback|redirect|oidc|sso|oauth\d*)|(?:callback|redirect)(?:login|signin|auth|oauth\d*|oidc|sso)|(?:checkout|payment|captcha|recaptcha|queue|challenge)(?:session|flow|status|page|wait|waiting|redirect|response|confirm|confirmation|verify|verification|v\d+))$/.test(
      normalized
    )
  );
}

function isForbiddenCompactManualSecurityRoute(normalized: string) {
  return (
    normalized.includes("login") ||
    /^(?:(?:admin|staff|member|customer|user|client|partner|employee|regional|secure)?(?:signon|logon))[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:saml|openid|oidc|oauth\d*|adfs|identity|idp|mfa|2fa|webauthn|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|queue|queueit|waitingroom|checkout|authorize|authorization|authentication|signin|signup|logout|register|registration|password|session|token|magiclink|invite|invitation|verify|verification|wresult)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth\d*(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|challenge|login|signin|provider|gateway|server|service|proxy)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^auth(?:n|z|enticate|entication|orize|orization)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:accounts?|myaccount|useraccount|memberaccount|customeraccount|clientaccount|partneraccount|employeeaccount|regionalaccount)(?:(?:login|signin|signup|portal|dashboard|profile|settings|callback|redirect|recovery|recover|reset|management|manage)[a-z0-9]*)?$/.test(
      normalized
    ) ||
    /^(?:login\d*|(?:admin|staff|member|customer|user|secure|portal|prod|tenant)login\d*)(?:callback|redirect|flow|session|step|start|portal|dashboard|secure|provider|gateway|us|eu|prod|dev|stage|staging|\d*)?$/.test(
      normalized
    ) ||
    /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:members?|admin|staff|customer|user|client|partner|employee|regional|secure)(?:center|centre|booking|portal|dashboard|profile|settings|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:forgot|reset|recover|recovery|confirm|confirmation|verify|verification)(?:username|email|password|account)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:email|username)(?:verify|verification|confirm|confirmation|reset|recovery)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^billing(?:portal|account|history|settings|payment|invoices?|details?)?$/.test(
      normalized
    ) ||
    /^payment[a-z0-9]*$/.test(normalized) ||
    /^(?:credentials?|signature|signed(?:url)?|assertion|relaystate|consent|jsessionid|authcode|nonce|jwt|bearer)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:token|secret|ticket)[a-z0-9]*$/.test(normalized) ||
    /^(?:access|refresh|id|api|client|service|login|auth)(?:token|key|secret|ticket)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:pay(?:portal|account|method|ment)?|basket|shoppingbag|placeorder|completepurchase|orderhistory|purchasehistory|transactionhistory)$/.test(
      normalized
    ) ||
    /^(?:order|cart)(?:review|summary|confirm|confirmation|checkout|payment|billing)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:booking|reservation|cart)(?:payment|checkout)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:payment|pay|cart|purchase|order|challenge)(?:callback|redirect|flow|session|step|start|confirm|confirmation|verify|verification|response|request|status|page|wait|waiting|progress|checkout)[a-z0-9]*$/.test(
      normalized
    )
  );
}

function getManualSecurityTokens(value: string) {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSensitiveManualUrlKey(value: string) {
  const normalized = value.normalize("NFKC").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    /^(?:sid|cfid|cftoken|oscsid|connectsid|j(?:ava)?sessionid[a-z0-9]*|php(?:sess|session)id[a-z0-9]*|asp(?:net)?sessionid[a-z0-9]*|sessionid[a-z0-9]*)$/.test(
      normalized
    ) ||
    /^(?:token|secret|nonce|jwt|ticket|loginticket|serviceticket|authorization|signature|signed|sig|credential|password|expires?|expiry|expiration|assertion|relaystate|saml(?:response|art)?|oauth(?:token|code|state|verifier)?|authcode|verificationcode|session(?:id|token|key|state)?|clientid|responsetype|redirecturi|granttype|scope|codechallenge|codeverifier|(?:access|auth|id|api|client)(?:token|key|secret))$/.test(
      normalized
    ) ||
    /^(?:saml|oauth|openid|oidc|auth|authentication|login)[a-z0-9]*$/.test(
      normalized
    ) ||
    /^(?:sigalg|openidmode|openidreturnto|openidclaimedid|openididentity|openidrealm|openidassochandle|openidresponse(?:nonce)?|samlrequest|oauthnonce|oauthcallback)$/.test(
      normalized
    ) ||
    /^(?:prompt|codechallengemethod|responsemode|wresult|wctx|wreply|wtrealm|wa)$/.test(
      normalized
    ) ||
    /^(?:csrf|csrftoken|xcsrftoken|csrfmiddlewaretoken|xsrf|xsrftoken|formkey|requestverificationtoken|antiforgerytoken|anticsrftoken|authenticitytoken|verificationtoken|checkoutsessionid|paymentintent|orderid|transactionid|invoiceid|cartid)$/.test(
      normalized
    ) ||
    /(?:password|credential|signature|authorization|assertion|relaystate)/.test(
      normalized
    )
  );
}

function isContextualSensitiveManualUrlParameter(key: string, value: string, url: URL) {
  const normalizedKey = key
    .normalize("NFKC")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  if (!/^(?:code|state|key)$/.test(normalizedKey)) {
    return false;
  }
  const hasAuthenticationContext = `${url.hostname}/${url.pathname}`
    .split(/[./_-]+/u)
    .map((segment) => segment.replace(/[^a-z0-9]/gi, "").toLowerCase())
    .some((segment) =>
      /^(?:callback(?:v?\d+)?|(?:auth(?:entication|orization|enticate|orize|n|z)?|oauth\d*|oidc|openid|saml|sso|signin|login)(?:callback(?:v?\d+)?)?)$/.test(
        segment
      )
    );
  const hasSensitiveCompanion = [...url.searchParams.keys()].some((candidate) => {
    const normalizedCandidate = candidate
      .normalize("NFKC")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
    return normalizedCandidate !== normalizedKey && isSensitiveManualUrlKey(candidate);
  });
  const hasSecretShapedValue = /(?:^|[^a-z0-9])(?:private|secret|token|credential|signature|session|nonce|ticket|auth)(?:[^a-z0-9]|$)/i.test(
    value
  );
  return hasAuthenticationContext || hasSensitiveCompanion || hasSecretShapedValue;
}

function isOpaqueCredentialValue(value: string) {
  return (
    /^(?:sk|pk|rk)_(?:test|live)_[A-Za-z0-9_-]{12,}$/i.test(value) ||
    /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value) ||
    /^[A-Za-z0-9+/_-]{16,}={1,2}$/.test(value) ||
    (/^[A-Za-z0-9]{19,}$/.test(value) &&
      /[A-Za-z]/.test(value) &&
      /\d/.test(value)) ||
    (/^[A-Za-z]{19,}$/.test(value) &&
      /[a-z]/.test(value) &&
      /[A-Z]/.test(value))
  );
}

function isAllowedPublicOpaquePathSegment(segments: string[], index: number) {
  return (
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
      segments[index] ?? ""
    ) &&
    /^(?:programs?|courses?)$/i.test(segments[index - 1] ?? "")
  );
}

function isOpaqueManualRedirectPathSegment(segments: string[], index: number) {
  return (
    /^(?:go|r|redirect|link|magic|invite|token)$/i.test(segments[index - 1] ?? "") &&
    /^[A-Za-z0-9_-]{16,}$/.test(segments[index] ?? "")
  );
}

function isPrivateManualHostname(hostname: string) {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (
    !normalized.includes(".") ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".home") ||
    normalized.endsWith(".corp") ||
    normalized.includes(":") ||
    /^\d+$|^0x[\da-f]+$/i.test(normalized)
  ) {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  if (
    ipv4.length !== 4 ||
    ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [first, second, third] = ipv4;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function isForbiddenManualSurfaceHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.+$/u, "");
  const hasForbiddenLabel = normalized.split(".").some((label) => {
    const compact = label.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const tokens = getManualSecurityTokens(label);
    return (
      isForbiddenCompactManualSecurityRoute(compact) ||
      /^(?:(?:secure|portal|customer|member|user|prod|tenant)?(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider|login)?|(?:accounts?|myaccount|login|signin|auth\d*|authentication|authorize|sso\d*|oauth\d*|oidc|idp|identity|checkout|queue|captcha|challenge|verify|register|registration)(?:secure|portal|gateway|provider))$/.test(
        compact
      ) ||
      tokens.some((token) =>
        /^(?:accounts?|myaccount|login\d*|signin|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity|identityserver|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|mfa|2fa|webauthn|verify|verification|register|registration)$/i.test(
          token
        )
      ) ||
      /^(?:(?:admin|staff|member|customer|user|secure|portal|prod|tenant)?(?:login\d*|accounts?|myaccount|auth\d*|authentication|authorization|authorize|sso\d*|oauth\d*|openid|oidc|saml|adfs|idp|identity(?:server|provider)?|checkout|queue|queueit|waitingroom|captcha|recaptcha|hcaptcha|funcaptcha|turnstile|challenge|mfa|2fa|webauthn|verify|verification|register|registration)(?:us|eu|prod|dev|stage|staging|secure|portal|gateway|provider|server|callback|redirect|flow|session|step|start|connect|progress|challenge|platform|dashboard|settings|acs|authnrequest|request|response|confirm|confirmation|verification|verify|\d*)?)$/.test(
        compact
      ) ||
      /^(?:admin|staff|member|customer|user)(?:account|dashboard|portal|profile|settings|login|signin)[a-z0-9]*$/.test(
        compact
      ) ||
      /^(?:arkose|arkoselabs|okta|onelogin|cloudflareaccess)$/.test(
        compact
      )
    );
  });
  return (
    hasForbiddenLabel ||
    normalized === "queue-it.net" ||
    normalized.endsWith(".queue-it.net") ||
    normalized === "challenges.cloudflare.com" ||
    normalized === "hcaptcha.com" ||
    normalized.endsWith(".hcaptcha.com") ||
    normalized === "funcaptcha.com" ||
    normalized.endsWith(".funcaptcha.com") ||
    normalized === "arkoselabs.com" ||
    normalized.endsWith(".arkoselabs.com") ||
    normalized === "auth0.com" ||
    normalized.endsWith(".auth0.com") ||
    normalized === "okta.com" ||
    normalized.endsWith(".okta.com") ||
    normalized === "onelogin.com" ||
    normalized.endsWith(".onelogin.com") ||
    normalized === "cloudflareaccess.com" ||
    normalized.endsWith(".cloudflareaccess.com")
  );
}

function canonicalizeManualUrl(value: string) {
  const parsed = parseUrl(value);
  if (!parsed || parsed.protocol !== "https:" || !isSafeManualEvidenceUrl(parsed)) {
    return null;
  }
  return `${parsed.origin}${parsed.pathname || "/"}`;
}

function isGenericGolfFacilityLabel(value: string) {
  return /^(?:Golf\s+(?:Course|Club|Center|Centre|Links)|Country\s+Club)$/i.test(
    value.trim()
  );
}

function findRepeatedDayScopedNoTeeTimeEvidence(
  courseName: string,
  visibleText: string
) {
  const targetName = courseName.trim();
  const normalizedText = visibleText
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n+ */gu, "\n")
    .trim();
  if (!targetName || !normalizedText) {
    return null;
  }

  const noTeeTimeWording =
    "tee\\s*times?\\s+(?:are\\s+)?not\\s+(?:needed|nec{1,2}essary|required)(?=\\s*(?:[.!?;]|$))";
  const weekdayMatch = new RegExp(
    `\\bweekdays?\\s*:?\\s*${noTeeTimeWording}`,
    "i"
  ).exec(normalizedText);
  const weekendMatch = new RegExp(
    `\\bweekends?\\s*:?\\s*${noTeeTimeWording}`,
    "i"
  ).exec(normalizedText);
  if (!weekdayMatch || !weekendMatch) {
    return null;
  }

  const firstMatch = weekdayMatch.index <= weekendMatch.index
    ? weekdayMatch
    : weekendMatch;
  const lastMatch = firstMatch === weekdayMatch ? weekendMatch : weekdayMatch;
  const firstStart = firstMatch.index;
  const firstEnd = firstStart + firstMatch[0].length;
  const lastStart = lastMatch.index;
  const lastEnd = lastMatch.index + lastMatch[0].length;
  const betweenStatements = normalizedText.slice(firstEnd, lastStart);
  if (
    lastEnd - firstStart > 600 ||
    /[\p{L}\p{N}]/u.test(betweenStatements)
  ) {
    return null;
  }

  const headingMatches = [
    ...normalizedText
      .slice(0, firstStart)
      .matchAll(/\bstarting\s+times?\b/gi)
  ];
  const startingTimesHeading = headingMatches.at(-1);
  const headingStart = startingTimesHeading?.index ?? -1;
  const headingEnd = headingStart + (startingTimesHeading?.[0].length ?? 0);
  if (
    !startingTimesHeading ||
    headingStart < 0 ||
    firstStart - headingEnd > 240
  ) {
    return null;
  }

  const normalizedTarget = targetName.toLocaleLowerCase("en-US");
  const normalizedLowerText = normalizedText.toLocaleLowerCase("en-US");
  const targetStart = normalizedLowerText.lastIndexOf(
    normalizedTarget,
    firstStart
  );
  if (targetStart < 0 || firstStart - targetStart > 4_000) {
    return null;
  }
  const corroborationTargetStart = normalizedLowerText.indexOf(
    normalizedTarget,
    Math.max(0, firstStart - 4_000)
  );
  if (corroborationTargetStart < 0) {
    return null;
  }

  const feeEvidenceEnd = Math.min(normalizedText.length, lastEnd + 700);
  const feeEvidence = normalizedText.slice(lastEnd, feeEvidenceEnd);
  const corroboration = normalizedText.slice(
    corroborationTargetStart,
    feeEvidenceEnd
  );
  const identityContext = normalizedText.slice(
    corroborationTargetStart,
    lastEnd
  );
  const sectionOwnerContext = normalizedText.slice(
    Math.max(corroborationTargetStart, headingStart - 600),
    firstStart
  );
  const policyContext = normalizedText.slice(headingStart, feeEvidenceEnd);
  const identifiesPublicPhysicalCourse =
    hasTargetCourseIdentity(corroboration, targetName) &&
    /\bpublic\b/i.test(corroboration) &&
    /\b(?:nine|9|eighteen|18)[- ]?holes?\b/i.test(corroboration);
  const publishesDailyFees =
    /\b(?:green\s+)?fees?\b/i.test(feeEvidence) &&
    /\b9\s*holes?\b/i.test(feeEvidence) &&
    /\b18\s*holes?\b/i.test(feeEvidence) &&
    /\b\d{1,3}\.\d{2}\b/.test(feeEvidence);
  const hasDifferentIdentity = hasDifferentNoTeeTimeCourseIdentity(
    identityContext,
    targetName
  );
  const hasAmbiguousOwner = hasAmbiguousStartingTimesSectionOwner(
    sectionOwnerContext,
    targetName
  );
  const hasNonCourseOwner = hasNonCourseFacilityStartingTimesOwner(
    sectionOwnerContext,
    targetName
  );
  const hasSearchResultLanguage =
    /\b(?:availability|inventory|results?|search|selected\s+date|sold\s+out|try\s+again)\b/i.test(
      policyContext
    );
  if (
    !identifiesPublicPhysicalCourse ||
    !publishesDailyFees ||
    hasDifferentIdentity ||
    hasAmbiguousOwner ||
    hasNonCourseOwner ||
    hasSearchResultLanguage
  ) {
    return null;
  }

  const identityExcerpt = normalizedText
    .slice(
      corroborationTargetStart,
      Math.min(firstStart, corroborationTargetStart + 360)
    )
    .split("\n")
    .filter((line) =>
      !isGenericGolfFacilityLabel(line) ||
      isLikelyTargetCourseAlias(line, targetName)
    )
    .join("\n");
  const targetIdentityProof = normalizedText.slice(
    targetStart,
    targetStart + targetName.length
  );
  const feeStartOffset = feeEvidence.search(/\b(?:green\s+)?fees?\b/i);
  const feeStart = feeStartOffset >= 0 ? lastEnd + feeStartOffset : lastEnd;
  const feeExcerpt = normalizedText.slice(
    feeStart,
    Math.min(feeEvidenceEnd, feeStart + 420)
  );
  return [
    identityExcerpt,
    targetIdentityProof,
    startingTimesHeading[0],
    firstMatch[0],
    lastMatch[0],
    feeExcerpt
  ]
    .filter(Boolean)
    .join(". ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_200);
}

function hasAmbiguousStartingTimesSectionOwner(
  value: string,
  courseName: string
) {
  const headings = [...value.matchAll(/\bstarting\s+times?\b/gi)];
  const heading = headings.at(-1);
  if (!heading || heading.index === undefined) {
    return true;
  }

  const beforeHeading = value.slice(0, heading.index);
  const withoutTrailingBoundary = beforeHeading.replace(
    /[\s.!?;:|•–—-]+$/gu,
    ""
  );
  const ownerSegments = withoutTrailingBoundary
    .split(/[.!?;:\n|•]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  let ownerIndex = ownerSegments.length - 1;
  while (
    ownerIndex >= 0 &&
    isGenericStartingTimesNavigation(ownerSegments[ownerIndex] ?? "")
  ) {
    ownerIndex -= 1;
  }
  const ownerSegment = ownerSegments[ownerIndex] ?? "";
  if (!isExactTargetStartingTimesOwner(ownerSegment, courseName)) {
    return true;
  }

  const afterHeading = value.slice(heading.index + heading[0].length);
  const afterWithoutContact = afterHeading
    .replace(
      /\b(?:call|phone|telephone|tel)\b\s*:?\s*(?:\+?\d[\d().\s-]{5,}\d)?/gi,
      ""
    )
    .replace(/[\d()+.\s:;|–—-]+/gu, "");
  return afterWithoutContact.length > 0;
}

function isExactTargetStartingTimesOwner(
  value: string,
  courseName: string
) {
  const normalizedValue = normalizeExactCourseNamePhrase(value);
  const normalizedTarget = normalizeExactCourseNamePhrase(courseName);
  if (!normalizedValue || !normalizedTarget) {
    return false;
  }
  const haystack = ` ${normalizedValue} `;
  const needle = ` ${normalizedTarget} `;
  const firstTarget = haystack.indexOf(needle);
  if (
    firstTarget < 0 ||
    haystack.indexOf(needle, firstTarget + needle.length) >= 0
  ) {
    return false;
  }
  const wrapperTokens = `${haystack.slice(0, firstTarget)} ${haystack.slice(
    firstTarget + needle.length
  )}`
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const allowedWrapperTokens = new Set([
    "direction",
    "directions",
    "for",
    "home",
    "official",
    "page",
    "the",
    "to"
  ]);
  return (
    wrapperTokens.length <= 6 &&
    wrapperTokens.every((token) => allowedWrapperTokens.has(token))
  );
}

function isGenericStartingTimesNavigation(value: string) {
  const tokens = value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  const genericTokens = new Set([
    "back",
    "contact",
    "direction",
    "directions",
    "for",
    "go",
    "home",
    "to",
    "top",
    "us"
  ]);
  return tokens.every((token) => genericTokens.has(token));
}

function hasNonCourseFacilityStartingTimesOwner(
  value: string,
  courseName: string
) {
  const matches = [
    ...value.matchAll(
      /\b(?:driving|practice)\s+(?:range|facility|center|centre|stalls?)\b/gi
    )
  ];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    return false;
  }
  const afterFacility = value.slice(
    (lastMatch.index ?? 0) + lastMatch[0].length
  );
  return !(
    hasTargetCourseIdentity(afterFacility, courseName) ||
    /\b(?:nine|9|eighteen|18)[- ]?holes?\s+(?:public\s+)?(?:golf\s+)?course\b/i.test(
      afterFacility
    )
  );
}

function canonicalizeUnavailableOfficialUrl(value: string) {
  const parsed = parseUrl(value);
  if (!parsed || !isSafeManualEvidenceUrl(parsed)) {
    return null;
  }
  return `${parsed.origin}${parsed.pathname || "/"}`;
}

function buildRejectedManualDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  reason: string
): BrowserDiscovery | null {
  const safeSourceUrl = canonicalizeRejectedManualSource(
    evidence.finalUrl ?? evidence.sourceUrl
  ) ?? canonicalizeRejectedManualSource(evidence.sourceUrl);
  if (!safeSourceUrl) {
    return null;
  }
  const safeObservedUrls = [
    ...new Set(
      uniqueUrls(observedUrls).flatMap((url) => {
        const sanitized = canonicalizeManualUrl(url);
        return sanitized ? [sanitized] : [];
      })
    )
  ];
  return {
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: safeSourceUrl,
    confidence: 0.25,
    evidence: {
      finalUrl: safeSourceUrl,
      observedUrls: safeObservedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: `official-phone-reservation-rejected:${reason}`
    }
  };
}

function canonicalizeRejectedManualSource(value: string) {
  const parsed = parseUrl(value);
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    (parsed.port && parsed.port !== "443") ||
    parsed.hostname.endsWith(".") ||
    isPrivateManualHostname(parsed.hostname) ||
    isForbiddenManualSurfaceHostname(parsed.hostname)
  ) {
    return null;
  }
  return `${parsed.origin}/`;
}

function hasPositiveOnlineBookingText(value: string) {
  return normalizeTeeTimeTypography(value).split(/[.!?]+/).some((statement) => {
    const normalized = statement.replace(/\s+/g, " ").trim();
    const teeTimePositions = [...normalized.matchAll(/\btee\s*times?\b/gi)].map(
      (match) => match.index ?? 0
    );
    const hasRelevantOnlineTeeTimeText = [
      ...normalized.matchAll(/\bonline\b/gi)
    ].some((onlineMatch) => {
      const onlineIndex = onlineMatch.index ?? 0;
      if (
        /^online\s+(?:store|shop|merchandise|gift\s+cards?|lessons?|instruction|academ(?:y|ies)|clinics?|simulators?|restaurants?|dining|lodging|spa|appointments?)\b/i.test(
          normalized.slice(onlineIndex)
        )
      ) {
        return false;
      }
      return teeTimePositions.some(
        (teeTimeIndex) => Math.abs(teeTimeIndex - onlineIndex) <= 80
      );
    });
    const hasExplicitTeeTimeBookingText =
      teeTimePositions.length > 0 &&
      (hasRelevantOnlineTeeTimeText ||
        /\b(?:book|booking|reserve|reservation|schedule|availability)\b/i.test(
          normalized
        ));
    if (
      /\b(?:no|not|never|without|do\s+not|does\s+not|cannot|can['’]t)\b.{0,60}\bonline\b/i.test(
        normalized
      ) ||
      /\bonline\s+(?:booking|reservations?|tee\s*times?)\b.{0,40}\b(?:not\s+available|unavailable|disabled)\b/i.test(
        normalized
      )
    ) {
      return false;
    }
    if (
      !hasExplicitTeeTimeBookingText &&
      hasClearlyUnrelatedBookingCategory(normalized)
    ) {
      return false;
    }
    if (!hasExplicitTeeTimeBookingText) {
      return false;
    }
    if (
      /\b(?:call(?:ing)?|phone)\b/i.test(normalized) &&
      !/\bonline\b/i.test(normalized)
    ) {
      return false;
    }
    return (
      hasRelevantOnlineTeeTimeText ||
      /\b(?:book|reserve|schedule)\b.{0,80}\bnow\b/i.test(normalized) ||
      /^(?:book|reserve|schedule|view|see|search|find|check)\b.{0,80}\btee\s*times?\b/i.test(
        normalized
      )
    );
  });
}

function normalizeTeeTimeTypography(value: string) {
  return value.replace(
    /\btee(?:[\s\x2d\u00ad\u2010-\u2015\u2212])+(times?)\b/giu,
    "tee $1"
  );
}

function normalizeHostname(value: string) {
  return value.toLowerCase().replace(/^www\./, "");
}

function learnOfficialContactOnlyClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const scopedEvidence = findTargetCourseContactEvidence(
    evidence.courseName,
    visibleText
  );
  if (!scopedEvidence) {
    return null;
  }
  const { phone, scopedText } = scopedEvidence;
  const identifiesPhysicalCourse =
    /\b(?:nine|eighteen|9|18)[- ]hole\b[^.]{0,100}\bgolf course\b/i.test(
      scopedText
    ) || /\bpar\s*3\s+golf course\b/i.test(scopedText);
  const postsPublicPrice =
    /\bprices?\b/i.test(scopedText) &&
    /\b(?:adult|senior|junior|weekdays?|weekends?|holidays?)\b[^$]{0,80}\$\s*\d/i.test(
      scopedText
    );

  if (!identifiesPhysicalCourse || !postsPublicPrice) {
    return null;
  }
  if (hasUnsafeManualEvidenceUrl(evidence, observedUrls)) {
    return null;
  }
  const manualEvidence = getSafeManualEvidence(evidence, observedUrls);
  if (
    !manualEvidence ||
    hasCurrentOnlineBookingEvidence(
      evidence,
      observedUrls,
      manualEvidence.evidenceUrl,
      false
    )
  ) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: manualEvidence.evidenceUrl,
    bookingUrl: manualEvidence.evidenceUrl,
    bookingMethod: "CONTACT_COURSE",
    bookingPhone: phone,
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    policyNotes:
      "The official course page publishes public play pricing and directs golfers to contact the facility for current hours or availability, without presenting an online tee-time reservation surface. Tee Time Spot must direct golfers to the course instead of attempting automated retrieval.",
    intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    confidence: 0.9,
    evidence: {
      finalUrl: manualEvidence.evidenceUrl,
      observedUrls: manualEvidence.observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "official-contact-only-course-access"
    }
  };
}

function findTargetCourseContactEvidence(courseName: string, visibleText: string) {
  const targetName = courseName.trim();
  if (!targetName || !visibleText) {
    return null;
  }
  const normalizedTarget = targetName.toLocaleLowerCase("en-US");
  const normalizedText = visibleText.toLocaleLowerCase("en-US");
  const contactMatches = [
    ...visibleText.matchAll(
      /\bhours? of operation may vary by season\b[^.]{0,180}\bplease contact us for details\b|\bplease contact us for (?:current )?(?:hours?|details|availability)\b/gi
    )
  ];
  const phoneMatches = [
    ...visibleText.matchAll(
      /(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/g
    )
  ];

  const candidates = contactMatches.flatMap((contact) => {
    const contactStart = contact.index ?? -1;
    const contactEnd = contactStart + contact[0].length;
    if (contactStart < 0) {
      return [];
    }
    return phoneMatches.flatMap((phoneMatch) => {
      const phoneStart = phoneMatch.index ?? -1;
      const phoneEnd = phoneStart + phoneMatch[0].length;
      if (phoneStart < 0) {
        return [];
      }
      const distance = phoneEnd <= contactStart
        ? contactStart - phoneEnd
        : phoneStart >= contactEnd
          ? phoneStart - contactEnd
          : 0;
      if (distance > 320) {
        return [];
      }
      const evidenceEnd = Math.max(phoneEnd, contactEnd);
      const targetStart = normalizedText.lastIndexOf(normalizedTarget, evidenceEnd);
      if (targetStart < 0 || Math.min(phoneStart, contactStart) - targetStart > 900) {
        return [];
      }
      const scopedText = visibleText.slice(targetStart, evidenceEnd);
      if (
        hasDifferentExplicitCourseIdentity(
          scopedText.slice(targetName.length),
          targetName
        )
      ) {
        return [];
      }
      const phoneLead = visibleText.slice(
        Math.max(targetStart, phoneStart - 140),
        phoneStart
      );
      const phoneContext = visibleText.slice(
        Math.max(targetStart, phoneStart - 180),
        Math.min(visibleText.length, phoneEnd + 80)
      );
      if (
        /\b(?:parks? (?:department|office)|city hall|administration|general inquiries?|sitewide|footer)\b/i.test(
          phoneContext
        )
      ) {
        return [];
      }
      const coursePhoneLabel =
        /\b(?:pro shop|golf shop|course office|tee[- ]time reservations?)\b/i.test(
          phoneLead
        );
      if (phoneStart > contactEnd && !coursePhoneLabel && distance > 80) {
        return [];
      }
      return [{
        associationRank: coursePhoneLabel ? 0 : phoneStart <= contactEnd ? 1 : 2,
        distance,
        phone: phoneMatch[0].replace(/\s+/g, " ").trim(),
        scopedText
      }];
    });
  });

  return candidates.sort(
    (left, right) =>
      left.associationRank - right.associationRank || left.distance - right.distance
  )[0] ?? null;
}

export function shouldQueueBrowserProbe(course: BrowserProbeCourseInput) {
  // Stored blocks and structurally runnable providers stay on the non-interactive,
  // address-pinned remediation path. The Playwright probe follows page links and
  // must not be used to reclassify access controls or retry a known adapter.
  if (course.automationEligibility === "BLOCKED") {
    return false;
  }

  if (!evaluateMonitoringGate(course).adapterAllowed) {
    return false;
  }

  if (resolveProviderCapability(course).isRunnable) {
    return false;
  }

  return Boolean(getBestProbeUrl(course));
}

export function hasCurrentRepeatedMonitoringFailure(
  evidence: BrowserProbeCourseInput["monitoringFailureEvidence"],
  now = new Date()
) {
  if (!evidence || evidence.kind !== "FETCH_FAILED" || evidence.occurrenceCount < 2) {
    return false;
  }
  const latestFailureAt = new Date(evidence.latestFailureAt);
  const latestSuccessfulAt = evidence.latestSuccessfulAt
    ? new Date(evidence.latestSuccessfulAt)
    : null;
  return Boolean(
    !Number.isNaN(latestFailureAt.getTime()) &&
      latestFailureAt.getTime() <= now.getTime() + 60_000 &&
      now.getTime() - latestFailureAt.getTime() <= 30 * 24 * 60 * 60 * 1000 &&
      (!latestSuccessfulAt ||
        Number.isNaN(latestSuccessfulAt.getTime()) ||
        latestSuccessfulAt.getTime() < latestFailureAt.getTime())
  );
}

function learnPrivateClubClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const rawVisibleText = evidence.visibleText ?? "";
  const visibleText = rawVisibleText.replace(/\s+/g, " ").trim();
  const officialCourseProfileText =
    evidence.officialPage?.courseName &&
    haveCompatibleCourseNames(
      evidence.courseName,
      evidence.officialPage.courseName
    )
      ? evidence.officialPage.visibleText ?? ""
      : "";
  const privateCourseProfile =
    findTargetScopedPrivateCourseProfile(
      evidence.courseName,
      officialCourseProfileText
    ) ??
    (!/\r?\n/u.test(rawVisibleText)
      ? findTargetScopedPrivateCourseProfile(evidence.courseName, rawVisibleText)
      : null);
  const scopedAccess = privateCourseProfile
    ? {
        privateMemberGuestClub: true,
        residentMemberClub: false,
        scopedText: privateCourseProfile.scopedText
      }
    : findTargetScopedPrivateClubAccess(evidence.courseName, visibleText);
  if (!scopedAccess) {
    return null;
  }
  if (
    privateCourseProfile &&
    (hasUnsafePrimaryManualEvidenceUrl(evidence) ||
      hasUntrustedPrimaryManualEvidenceTransition(evidence))
  ) {
    return null;
  }
  const { residentMemberClub, scopedText } = scopedAccess;
  const scopedEvidence = privateCourseProfile
    ? getOfficialSourceScopedEvidence(evidence, scopedText)
    : evidence;
  const manualEvidence = getSafeManualEvidence(
    scopedEvidence,
    privateCourseProfile ? scopedEvidence.observedUrls : observedUrls
  );
  if (!manualEvidence) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    isPublic: false,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: manualEvidence.evidenceUrl,
    bookingUrl: manualEvidence.evidenceUrl,
    bookingMethod: "UNKNOWN",
    automationEligibility: "BLOCKED",
    automationReason: "OTHER",
    policyNotes: residentMemberClub
      ? "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course."
      : privateCourseProfile
        ? "The official course profile identifies this course as private. Tee Time Spot must not present public tee-time monitoring for member-controlled inventory."
      : "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
    intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: manualEvidence.evidenceUrl,
      observedUrls: manualEvidence.observedUrls,
      visibleText: summarizeVisibleText(scopedText),
      learnedFrom: residentMemberClub
        ? "official-resident-member-access"
        : privateCourseProfile
          ? "official-private-course-profile"
        : "official-private-club-access"
    }
  };
}

function findTargetScopedPrivateCourseProfile(
  courseName: string,
  visibleText: string
) {
  const normalizedLines = visibleText
    .replace(/\r\n?/gu, "\n")
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  const normalizedText = normalizedLines.join(" ");
  if (
    !normalizedText ||
    /\b(?:open|available)\s+to\s+(?:the\s+)?public\b|\bopen\s+to\s+(?:all\s+golfers?|anyone|everyone)\b|\bopen\s+to\s+[^.!?]{1,80}\b(?:the\s+)?public\b|\bpublic\s+(?:(?:golf\s+)?course|tee\s*times?|play|access|welcome|golfers?\s+are\s+welcome|daily(?:[\s\-\u00ad\u2010-\u2015\u2212]+)fee)\b|\b(?:the\s+)?public\s+(?:is|are)\s+welcome(?:\s+to\s+play)?\b|\bwelcomes?\s+(?:the\s+)?public\b|\bsemi(?:[\s\-\u00ad\u2010-\u2015\u2212]+)private\b|\bdaily(?:[\s\-\u00ad\u2010-\u2015\u2212]+)fee\b|\bnon(?:[\s\-\u00ad\u2010-\u2015\u2212]+)members?\b/i.test(
      normalizedText
    )
  ) {
    return null;
  }

  const profileLines = /\r?\n/u.test(visibleText)
    ? normalizedLines
    : visibleText
        .split(/[.!?]\s+/u)
        .map((line) => line.replace(/\s+/gu, " ").trim())
        .filter(Boolean);
  for (let index = 0; index < profileLines.length; index += 1) {
    const detailsLine = profileLines[index] ?? "";
    if (!/\sdetails\s*$/i.test(detailsLine)) {
      continue;
    }
    const identity = detailsLine
      .replace(/\s+details\s*$/i, "")
      .trim();
    if (!isTargetOrShorterCourseProfileIdentity(identity, courseName)) {
      continue;
    }
    const architect = readPrivateCourseProfileField(
      profileLines,
      index + 1,
      "architect"
    );
    const stats = architect && readPrivateCourseProfileField(
      profileLines,
      architect.nextIndex,
      "stats"
    );
    const established = stats && readPrivateCourseProfileField(
      profileLines,
      stats.nextIndex,
      "established"
    );
    const status = established && readPrivateCourseProfileField(
      profileLines,
      established.nextIndex,
      "status"
    );
    const location = status && readPrivateCourseProfileField(
      profileLines,
      status.nextIndex,
      "location"
    );
    if (
      !architect ||
      !stats ||
      !established ||
      !status ||
      !location ||
      !architect.value ||
      !/\byards?\b.*\bpar\b/i.test(stats.value) ||
      !/^\d{4}$/u.test(established.value) ||
      !/^private$/i.test(status.value) ||
      !location.value
    ) {
      continue;
    }
    return {
      scopedText: normalizePrivateCourseProfileProof(
        profileLines.slice(index, location.nextIndex)
      )
    };
  }
  return null;
}

function readPrivateCourseProfileField(
  lines: string[],
  index: number,
  field: "architect" | "stats" | "established" | "status" | "location"
) {
  const line = lines[index] ?? "";
  const match = new RegExp(`^${field}\\s*:\\s*(.*)$`, "i").exec(line);
  if (!match) {
    return null;
  }
  const inlineValue = match[1]?.trim() ?? "";
  if (!inlineValue) {
    return null;
  }
  return { value: inlineValue, nextIndex: index + 1 };
}

function isTargetOrShorterCourseProfileIdentity(
  candidate: string,
  courseName: string
) {
  const candidateFacilityKind = getPrivateCourseProfileFacilityKind(candidate);
  const targetFacilityKind = getPrivateCourseProfileFacilityKind(courseName);
  if (
    candidateFacilityKind &&
    targetFacilityKind &&
    candidateFacilityKind !== targetFacilityKind
  ) {
    return false;
  }
  const candidateTokens = normalizeCourseIdentityName(candidate)
    .split(" ")
    .filter(Boolean);
  const targetTokens = normalizeCourseIdentityName(courseName)
    .split(" ")
    .filter(Boolean);
  if (candidateTokens.length === 0 || targetTokens.length === 0) {
    return false;
  }
  if (candidateTokens.join(" ") === targetTokens.join(" ")) {
    return true;
  }
  const omittedTargetTokens = targetTokens.slice(candidateTokens.length);
  return candidateTokens.length >= 2 &&
    candidateTokens.length < targetTokens.length &&
    candidateTokens.every((token, index) => targetTokens[index] === token) &&
    omittedTargetTokens[0] === "at" &&
    hasPrivateCourseProfileParentSuffix(courseName);
}

function getPrivateCourseProfileFacilityKind(value: string) {
  const primaryIdentity = value.split(/\s+at\s+/iu)[0]?.trim() ?? "";
  const normalized = primaryIdentity
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  return [
    "country club",
    "golf club",
    "golf course",
    "golf center",
    "golf centre",
    "golf links",
    "club",
    "course",
    "center",
    "centre",
    "links"
  ].find((kind) => normalized.endsWith(kind));
}

function hasPrivateCourseProfileParentSuffix(courseName: string) {
  const suffix = /\bat\b(?<suffix>.+)$/iu.exec(courseName)?.groups?.suffix;
  if (!suffix) {
    return false;
  }
  const tokens = suffix
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const parentFacilityTokens = new Set([
    "association",
    "athletic",
    "club",
    "college",
    "community",
    "municipal",
    "resort",
    "university"
  ]);
  const layoutTokens = new Set([
    "back",
    "black",
    "blue",
    "championship",
    "course",
    "east",
    "eighteen",
    "executive",
    "front",
    "green",
    "lake",
    "lakes",
    "nine",
    "north",
    "par",
    "red",
    "short",
    "south",
    "west",
    "yellow"
  ]);
  return (
    tokens.some((token) => parentFacilityTokens.has(token)) &&
    !tokens.some((token) => layoutTokens.has(token) || /^\d+$/u.test(token))
  );
}

function normalizePrivateCourseProfileProof(lines: string[]) {
  return lines.join(". ").replace(/:\.\s*/gu, ": ");
}

function findTargetScopedPrivateClubAccess(courseName: string, visibleText: string) {
  const sentences = visibleText.match(/[^.!?]+[.!?]?/gu) ?? [];
  for (let index = 0; index < sentences.length; index += 1) {
    const anchor = sentences[index] ?? "";
    if (
      !/\b(?:private|members?|residents?|neighborhood (?:social )?club)\b/i.test(
        anchor
      )
    ) {
      continue;
    }
    const scopedText = sentences.slice(
      Math.max(0, index - 1),
      Math.min(sentences.length, index + 3)
    ).join(" ");
    if (
      !hasTargetCourseIdentity(scopedText, courseName) ||
      hasDifferentNamedCourseIdentity(scopedText, courseName)
    ) {
      continue;
    }
    const explicitlyPrivateGolfAccess =
      /\bprivate (?:golf )?club\b/i.test(scopedText) ||
      /\bprivate(?:[\s,-]+(?:award-winning|challenging|championship|\d{1,2}[- ]hole))*[\s,-]+golf course\b/i.test(
        scopedText
      );
    const privateMemberGuestClub =
      /\bis a private club available to\b/i.test(scopedText) ||
      (explicitlyPrivateGolfAccess &&
        /\bmembers? and (?:their )?guests?\b/i.test(scopedText));
    const residentMemberClub =
      /\bneighborhood (?:social )?club for residents?\b/i.test(scopedText) &&
      /\boffers? (?:its )?members? the use of\b[^.]{0,220}\bgolf course\b/i.test(
        scopedText
      );
    if (privateMemberGuestClub || residentMemberClub) {
      return { privateMemberGuestClub, residentMemberClub, scopedText };
    }
  }
  return null;
}

function learnChelseaDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const chelseaUrl = observedUrls
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
          /(^|\.)chelseareservations\.com$/i.test(url.hostname) &&
          isProviderPublicBookingLandingUrl(url)
      )
    );
  const course = getChelseaCourse(evidence.courseName);
  if (!chelseaUrl || !course) {
    return null;
  }

  const bookingBaseUrl = `${chelseaUrl.origin}/`;
  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The official Chelsea Reservations non-member surface exposes public availability without login. Tee Time Spot reads the tee sheet and leaves reservation on the official site.",
    apiEndpoint: `${chelseaUrl.origin}/GPInprocess/code/Booking/booking1.aspx`,
    apiMetadata: {
      provider: "CHELSEA",
      bookingBaseUrl,
      courseCode: course.code,
      courseLabel: course.label
    },
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "chelsea-public-non-member-surface"
    }
  };
}

function getChelseaCourse(courseName: string) {
  if (/\bhighlands?\b/i.test(courseName)) {
    return { code: 2, label: "Highland" };
  }
  if (/\bpines?\b/i.test(courseName)) {
    return { code: 1, label: "Pines" };
  }
  return null;
}

function learnCpsDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const candidates = getCpsBookingCandidates(evidence, observedUrls);
  const selected = selectCpsBookingCandidate(candidates, evidence.courseName);

  if (!selected && candidates.length === 0) {
    return null;
  }
  if (!selected) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: evidence.sourceUrl,
      confidence: 0.55,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: "cps-tenant-ambiguous"
      }
    };
  }

  const siteName = selected.url.hostname.split(".")[0];
  const bookingBaseUrl = selected.bookingBaseUrl;
  const apiEndpoint = `${selected.url.origin}/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes`;
  if (!selected.courseIds?.length) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: bookingBaseUrl,
      bookingMethod: "PUBLIC_ONLINE",
      apiEndpoint,
      confidence: 0.7,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: selected.courseIdsAmbiguous
          ? "cps-course-id-ambiguous"
          : "cps-course-id-missing"
      }
    };
  }

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    apiEndpoint,
    apiMetadata: {
      provider: "CPS",
      siteName,
      bookingBaseUrl,
      courseIds: selected.courseIds,
      holes: [18, 9]
    },
    confidence: 0.85,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "cps-booking-url"
    }
  };
}

type CpsBookingCandidate = {
  url: URL;
  bookingBaseUrl: string;
  label: string;
  courseIds?: number[];
  courseIdsAmbiguous?: boolean;
};

function getCpsBookingCandidates(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  options: {
    includeEvidenceLinks?: boolean;
    includeWidget?: boolean;
    includeInfrastructureEvidence?: boolean;
  } = {}
): CpsBookingCandidate[] {
  const includeEvidenceLinks = options.includeEvidenceLinks ?? true;
  const includeWidget = options.includeWidget ?? true;
  const includeInfrastructureEvidence =
    options.includeInfrastructureEvidence ?? true;
  const rawCandidates: Array<{
    value: string;
    label: string;
    source: "LINK" | "OBSERVED" | "WIDGET";
    courseIds?: number[];
    courseIdsAmbiguous?: boolean;
  }> = [
    ...(includeEvidenceLinks ? (evidence.linkCandidates ?? []).map((candidate) => ({
      value: candidate.url,
      label: candidate.label,
      source: "LINK" as const
    })) : []),
    ...observedUrls.map((value) => ({
      value,
      label: "",
      source: "OBSERVED" as const
    })),
    ...(includeWidget
      ? getCpsWidgetCandidates(evidence.visibleText, evidence.courseName).map(
          (candidate) => ({ ...candidate, source: "WIDGET" as const })
        )
      : [])
  ];
  const candidates = new Map<string, CpsBookingCandidate>();

  for (const raw of rawCandidates) {
    const url = parseUrl(raw.value);
    const isPublicLanding = isCpsPublicBookingCandidateUrl(url);
    const isInfrastructureEvidence = Boolean(
      includeInfrastructureEvidence &&
        raw.source !== "LINK" &&
        isCpsProviderEvidenceUrl(url)
    );
    if (!isPublicLanding && !isInfrastructureEvidence) {
      continue;
    }
    const bookingBaseUrl = `${url!.origin}/`;
    const courseIds = raw.courseIds ?? getCpsCourseIdsFromUrl(url!);
    const label = raw.label.replace(/\s+/g, " ").trim().slice(0, 160);
    const candidateKey = [
      url!.href,
      label.toLowerCase(),
      [...(courseIds ?? [])].sort((left, right) => left - right).join(",")
    ].join("\u0000");
    candidates.set(candidateKey, {
      url: url!,
      bookingBaseUrl,
      label,
      courseIds,
      courseIdsAmbiguous: raw.courseIdsAmbiguous
    });
  }

  return [...candidates.values()];
}

function selectCpsBookingCandidate(
  candidates: CpsBookingCandidate[],
  courseName: string
) {
  if (candidates.length === 0) {
    return undefined;
  }

  const labelMatches = candidates.filter(
    (candidate) =>
      candidate.label && haveCompatibleCourseNames(courseName, candidate.label)
  );
  if (labelMatches.length > 0) {
    const matchingTenant = selectCpsTenantGroup(labelMatches, courseName);
    return matchingTenant
      ? mergeCpsCandidates(matchingTenant, { courseSpecificEvidence: true })
      : undefined;
  }

  const tenant = selectCpsTenantGroup(candidates, courseName);
  return tenant
    ? mergeCpsCandidates(tenant, { courseSpecificEvidence: false })
    : undefined;
}

function selectCpsTenantGroup(
  candidates: CpsBookingCandidate[],
  courseName: string
) {
  const groups = new Map<string, CpsBookingCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.bookingBaseUrl) ?? [];
    group.push(candidate);
    groups.set(candidate.bookingBaseUrl, group);
  }
  if (groups.size === 1) {
    return [...groups.values()][0];
  }

  const targetIdentity = normalizeCpsTenantIdentity(courseName);
  const tenantMatches = targetIdentity && targetIdentity.length >= 4
    ? [...groups.values()].filter((group) => {
        const tenant = group[0].url.hostname.split(".")[0]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "");
        return tenant.includes(targetIdentity) || targetIdentity.includes(tenant);
      })
    : [];
  return tenantMatches.length === 1 ? tenantMatches[0] : undefined;
}

function mergeCpsCandidates(
  candidates: CpsBookingCandidate[],
  options: { courseSpecificEvidence: boolean }
): CpsBookingCandidate {
  const primary = candidates.find((candidate) => candidate.courseIds?.length) ?? candidates[0];
  const courseIds = [...new Set(candidates.flatMap((candidate) => candidate.courseIds ?? []))]
    .sort((left, right) => left - right);
  const courseIdSignatures = candidates.map((candidate) =>
    [...(candidate.courseIds ?? [])].sort((left, right) => left - right).join(",")
  );
  const allCandidatesIdentifySameCourse = Boolean(
    courseIdSignatures[0] &&
      courseIdSignatures.every((signature) => signature === courseIdSignatures[0])
  );
  const safeCourseIds = options.courseSpecificEvidence ||
    candidates.length === 1 ||
    allCandidatesIdentifySameCourse
    ? courseIds
    : [];
  const courseIdsAmbiguous =
    candidates.some((candidate) => candidate.courseIdsAmbiguous) ||
    (courseIds.length > 0 && safeCourseIds.length === 0);

  return {
    ...primary,
    label: candidates.find((candidate) => candidate.label)?.label ?? primary.label,
    courseIds: safeCourseIds.length > 0 ? safeCourseIds : undefined,
    courseIdsAmbiguous: courseIdsAmbiguous || undefined
  };
}

function normalizeCpsTenantIdentity(value: string) {
  return normalizeCourseIdentityName(
    value.replace(/\b(?:and|at|of)\b/gi, " ")
  ).replace(/\s+/g, "");
}

function isStrictCpsTenantUrl(url: URL | null) {
  return Boolean(
    url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9](?:[a-z0-9-]{0,62})\.cps\.golf$/i.test(url.hostname) &&
      url.hostname.toLowerCase() !== "sc.cps.golf"
  );
}

function isCpsPublicBookingCandidateUrl(url: URL | null) {
  return Boolean(
    isStrictCpsTenantUrl(url) &&
      url &&
      isProviderPublicBookingLandingUrl(url)
  );
}

function isCpsProviderEvidenceUrl(url: URL | null) {
  return Boolean(
    isStrictCpsTenantUrl(url) &&
      url &&
      /^\/onlineres\/onlineapi\/api\/v1\/onlinereservation(?:\/teetimes)?\/?$/iu.test(
        url.pathname
      ) &&
      !url.hash &&
      hasOnlyBoundedCpsEvidenceCourseQuery(url)
  );
}

function hasOnlyBoundedCpsEvidenceCourseQuery(url: URL) {
  if (!url.search) {
    return true;
  }
  const keys = [...url.searchParams.keys()].map((key) =>
    key.toLocaleLowerCase("en-US")
  );
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => key !== "courseid" && key !== "courseids") ||
    new Set(keys).size !== 1
  ) {
    return false;
  }
  return Boolean(readBoundedCpsCourseIds(url)?.length);
}

export async function enrichChronogolfDiscovery(
  discovery: BrowserDiscovery,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscovery> {
  if (discovery.detectedPlatform !== "CHRONOGOLF") {
    return discovery;
  }

  const profileUrl = getChronogolfProfileUrl(discovery);
  if (!profileUrl) {
    return discovery;
  }

  const fetched = await fetchValidatedProviderLanding(
    profileUrl,
    fetchImpl,
    { Accept: "text/html" },
    true
  );
  if (!fetched?.response.ok) {
    return {
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: "chronogolf-public-profile-unavailable"
      }
    };
  }

  const html = await fetched.response.text();
  const club = parseChronogolfClubProfile(html);
  if (!club) {
    return discovery;
  }
  const requestedNumericClubId = parseUrl(profileUrl)?.pathname.match(
    /^\/club\/([1-9]\d{0,9})\/?$/u
  )?.[1];
  if (
    getProviderPublicBookingLandingIdentity(profileUrl) !==
      getProviderPublicBookingLandingIdentity(fetched.finalUrl) &&
    (!requestedNumericClubId || club.id !== Number(requestedNumericClubId))
  ) {
    return discovery;
  }

  const canonicalUrl = fetched.finalUrl;
  const profileSummary = `Chronogolf public club profile ${canonicalUrl} reports onlineBookingEnabled=${String(
    club.onlineBookingEnabled
  )} and ${club.courseCount} public course records.`;

  if (club.onlineBookingEnabled === false) {
    return {
      ...discovery,
      status: "VERIFIED",
      bookingUrl: canonicalUrl,
      bookingMethod: "CONTACT_COURSE",
      automationEligibility: "BLOCKED",
      automationReason: "NO_ONLINE_BOOKING",
      policyNotes: `${profileSummary} Tee Time Spot must direct golfers to the course instead of attempting automated retrieval.`,
      intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      confidence: 0.95,
      evidence: {
        ...discovery.evidence,
        observedUrls: uniqueUrls([...discovery.evidence.observedUrls, canonicalUrl]),
        learnedFrom: "chronogolf-public-club-profile"
      }
    };
  }

  if (club.onlineBookingEnabled === true) {
    return {
      ...discovery,
      status: "LEARNED",
      bookingUrl: canonicalUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      policyNotes: `${profileSummary} Tee Time Spot reads the same public marketplace availability endpoint and leaves booking on Chronogolf.`,
      apiEndpoint: "https://www.chronogolf.com/marketplace/v2/teetimes",
      apiMetadata: {
        clubId: club.id,
        courseIds: club.courseIds,
        bookingBaseUrl: canonicalUrl
      },
      confidence: 0.95,
      evidence: {
        ...discovery.evidence,
        observedUrls: uniqueUrls([...discovery.evidence.observedUrls, canonicalUrl]),
        learnedFrom: "chronogolf-public-club-profile"
      }
    };
  }

  return discovery;
}

export async function enrichTeesnapDiscovery(
  discovery: BrowserDiscovery,
  courseName: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscovery> {
  if (
    discovery.detectedPlatform !== "CUSTOM" ||
    !discovery.evidence.learnedFrom.startsWith("teesnap-url-without-course-id") ||
    !discovery.bookingUrl ||
    !isTeesnapBookingUrl(discovery.bookingUrl)
  ) {
    return discovery;
  }

  const bookingBaseUrl = new URL("/", discovery.bookingUrl).toString();
  const fetched = await fetchValidatedProviderLanding(
    bookingBaseUrl,
    fetchImpl,
    {
      Accept: "text/html,application/xhtml+xml;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    }
  );
  if (!fetched?.response.ok) {
    return {
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: "teesnap-public-config-unavailable"
      }
    };
  }

  const html = await fetched.response.text();
  const metadataResolution = resolveTeesnapCourseMetadata(
    discovery.evidence.observedUrls,
    html,
    courseName
  );
  if (!metadataResolution.metadata) {
    return {
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: `teesnap-public-config-${metadataResolution.reason}`
      }
    };
  }
  const courseMetadata = metadataResolution.metadata;

  const canonicalUrl = fetched.finalUrl;
  return {
    ...discovery,
    status: "LEARNED",
    bookingUrl: canonicalUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The official public TeeSnap page exposes course-specific availability without login. Tee Time Spot reads that tee sheet and leaves booking on the official provider page.",
    apiEndpoint: new URL("/customer-api/teetimes-day", canonicalUrl).toString(),
    apiMetadata: {
      provider: "TEESNAP",
      courseId: courseMetadata.courseId,
      bookingBaseUrl: canonicalUrl,
      defaultHoles: courseMetadata.defaultHoles ?? 18,
      defaultAddons: courseMetadata.defaultAddons ?? "off"
    },
    confidence: 0.95,
    evidence: {
      ...discovery.evidence,
      observedUrls: uniqueUrls([...discovery.evidence.observedUrls, canonicalUrl]),
      learnedFrom: "teesnap-public-course-config"
    }
  };
}

async function fetchValidatedProviderLanding(
  sourceUrl: string,
  fetchImpl: typeof fetch,
  headers: HeadersInit,
  allowSameHostIdentityChange = false
) {
  const source = parseUrl(sourceUrl);
  if (!source || !isProviderPublicBookingLandingUrl(source)) {
    return null;
  }
  const providerFamily = getKnownProviderFamilyForHostname(source.hostname);
  const normalizeHostname = (hostname: string) =>
    hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  const sourceHostname = normalizeHostname(source.hostname);
  let currentUrl = source.toString();

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers,
      redirect: "manual"
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 5) {
        return null;
      }
      const redirectUrl = new URL(location, currentUrl);
      if (
        getKnownProviderFamilyForHostname(redirectUrl.hostname) !==
          providerFamily ||
        normalizeHostname(redirectUrl.hostname) !== sourceHostname ||
        !isProviderPublicBookingLandingUrl(redirectUrl) ||
        (!allowSameHostIdentityChange &&
          getProviderPublicBookingLandingIdentity(redirectUrl) !==
            getProviderPublicBookingLandingIdentity(source))
      ) {
        return null;
      }
      currentUrl = redirectUrl.toString();
      continue;
    }

    const finalUrl = parseUrl(response.url || currentUrl);
    if (
      !finalUrl ||
      getKnownProviderFamilyForHostname(finalUrl.hostname) !== providerFamily ||
      normalizeHostname(finalUrl.hostname) !== sourceHostname ||
      !isProviderPublicBookingLandingUrl(finalUrl) ||
      (!allowSameHostIdentityChange &&
        getProviderPublicBookingLandingIdentity(finalUrl) !==
          getProviderPublicBookingLandingIdentity(source))
    ) {
      return null;
    }
    return { response, finalUrl: finalUrl.toString() };
  }
  return null;
}

function getChronogolfProfileUrl(discovery: BrowserDiscovery) {
  const profileUrl = discovery.evidence.observedUrls
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
        /(^|\.)chronogolf\.com$/i.test(url.hostname) &&
        isProviderPublicBookingLandingUrl(url)
      )
    );
  if (profileUrl) {
    return `https://www.chronogolf.com${profileUrl.pathname.replace(/\/+$/u, "")}`;
  }

  const technicalProfileUrl = discovery.evidence.observedUrls
    .map(parseUrl)
    .find(isExactChronogolfProfilePingUrl);
  if (technicalProfileUrl) {
    const clubId = technicalProfileUrl.pathname.match(
      /^\/club\/([1-9]\d{0,9})\/ping\/?$/u
    )?.[1];
    const derived = clubId
      ? `https://www.chronogolf.com/club/${clubId}`
      : null;
    return derived && isProviderPublicBookingLandingUrl(derived)
      ? derived
      : null;
  }

  const textMatch = discovery.evidence.visibleText?.match(
    /(?:clubId|club_id)["'\s:=]+(\d+)/i
  )?.[1];
  const clubId = Number(textMatch);
  if (!Number.isSafeInteger(clubId) || clubId <= 0) {
    return null;
  }
  const derived = `https://www.chronogolf.com/club/${clubId}`;
  return isProviderPublicBookingLandingUrl(derived) ? derived : null;
}

function isExactChronogolfProfilePingUrl(url: URL | null) {
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:www\.)?chronogolf\.com$/iu.test(url.hostname) ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const clubId = url.pathname.match(
    /^\/club\/([1-9]\d{0,9})\/ping\/?$/u
  )?.[1];
  if (!clubId) {
    return false;
  }
  const parsed = Number(clubId);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647;
}

function parseChronogolfClubProfile(html: string) {
  const nextData = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  )?.[1];
  if (!nextData) {
    return null;
  }

  try {
    const parsed = JSON.parse(nextData) as {
      props?: {
        pageProps?: {
          club?: {
            id?: number;
            features?: { onlineBookingEnabled?: boolean };
            courses?: Array<{ uuid?: string }>;
          };
        };
      };
    };
    const club = parsed.props?.pageProps?.club;
    if (!club) {
      return null;
    }
    const courseIds = Array.isArray(club.courses)
      ? club.courses.flatMap((course) =>
          typeof course.uuid === "string" && course.uuid.length > 0 ? [course.uuid] : []
        )
      : [];
    if (!Number.isInteger(club.id) || (club.id ?? 0) <= 0) {
      return null;
    }
    return {
      id: club.id as number,
      onlineBookingEnabled: club.features?.onlineBookingEnabled,
      courseCount: courseIds.length,
      courseIds
    };
  } catch {
    return null;
  }
}

function getCpsWidgetCandidates(text: string | undefined, courseName: string) {
  const urls = [...(text?.matchAll(/"baseURL"\s*:\s*"([^"]+\.cps\.golf\/[^"]+)"/gi) ?? [])]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index);
  const locations = getCpsWidgetLocations(text);
  const locationMatches = locations.filter((location) =>
    haveCompatibleCpsLocationName(courseName, location.name)
  );
  const selectedLocation = urls.length === 1 && locationMatches.length === 1
    ? locationMatches[0]
    : undefined;
  const courseIdsAmbiguous = locations.length > 0 && !selectedLocation;

  return urls.map((value) => ({
    value,
    label: selectedLocation?.name ?? courseName,
    ...(selectedLocation ? { courseIds: [selectedLocation.courseId] } : {}),
    ...(courseIdsAmbiguous ? { courseIdsAmbiguous: true } : {})
  }));
}

function getCpsWidgetLocations(text: string | undefined) {
  const locations: Array<{ name: string; courseId: number }> = [];
  for (const object of text?.match(/\{[^{}]{0,1500}\}/g) ?? []) {
    const nameMatch = object.match(/"name"\s*:\s*"((?:\\.|[^"\\])*)"/i);
    const courseIdMatch = object.match(/"courseId"\s*:\s*"?(\d+)"?/i);
    if (!nameMatch || !courseIdMatch) {
      continue;
    }
    const courseId = Number(courseIdMatch[1]);
    if (
      !Number.isSafeInteger(courseId) ||
      courseId < 0 ||
      courseId > 2_147_483_647
    ) {
      continue;
    }
    let name = nameMatch[1];
    try {
      name = JSON.parse(`"${name}"`) as string;
    } catch {
      // Keep the bounded raw label when the widget contains malformed escaping.
    }
    name = name.replace(/\s+/g, " ").trim().slice(0, 160);
    if (
      name &&
      !locations.some((location) =>
        location.courseId === courseId && location.name === name
      )
    ) {
      locations.push({ name, courseId });
    }
  }
  return locations;
}

function haveCompatibleCpsLocationName(courseName: string, locationName: string) {
  if (haveCompatibleCourseNames(courseName, locationName)) {
    return true;
  }
  const targetTokens = normalizeCourseIdentityName(courseName).split(" ").filter(Boolean);
  const locationTokens = normalizeCourseIdentityName(locationName).split(" ").filter(Boolean);
  return Boolean(
    locationTokens.length === 1 &&
      locationTokens[0].length >= 5 &&
      targetTokens.length <= 2 &&
      targetTokens.includes(locationTokens[0])
  );
}

function getCpsCourseIdsFromUrl(url: URL) {
  return readBoundedCpsCourseIds(url);
}

function readBoundedCpsCourseIds(url: URL) {
  const directValues = [
    ...url.searchParams.getAll("CourseId"),
    ...url.searchParams.getAll("courseId")
  ];
  const pluralValues = url.searchParams.getAll("courseIds");
  if (directValues.length > 1 || pluralValues.length > 1) {
    return undefined;
  }
  const rawValues = directValues.length === 1
    ? directValues
    : pluralValues.length === 1
      ? pluralValues[0].split(",").map((value) => value.trim())
      : [];
  if (rawValues.length === 0 || rawValues.length > 20) {
    return undefined;
  }
  const parsed = rawValues.map((value) =>
    /^\d{1,10}$/u.test(value) ? Number(value) : Number.NaN
  );
  return parsed.every(
    (value) =>
      Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
  )
    ? [...new Set(parsed)]
    : undefined;
}

function learnTeesnapDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const observedBookingUrl = observedUrls.find(isTeesnapBookingUrl);
  const technicalEvidenceUrls = observedUrls.filter(
    isTeesnapTechnicalEvidenceUrl
  );
  if (!observedBookingUrl && technicalEvidenceUrls.length === 0) {
    return null;
  }
  const bookingUrl = observedBookingUrl
    ? new URL("/", observedBookingUrl).toString()
    : undefined;

  const metadataResolution = resolveTeesnapCourseMetadata(
    observedUrls,
    evidence.visibleText,
    evidence.courseName
  );
  if (!metadataResolution.metadata) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(bookingUrl
        ? {
            apiEndpoint: new URL(
              "/customer-api/teetimes-day",
              bookingUrl
            ).toString()
          }
        : {}),
      confidence: 0.55,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: bookingUrl
          ? `teesnap-url-without-course-id:${metadataResolution.reason}`
          : `teesnap-technical-evidence-without-public-landing:${metadataResolution.reason}`
      }
    };
  }
  if (!bookingUrl) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      confidence: 0.5,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: "teesnap-technical-evidence-without-public-landing"
      }
    };
  }
  const courseMetadata = metadataResolution.metadata;

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    apiEndpoint: new URL("/customer-api/teetimes-day", bookingUrl).toString(),
    apiMetadata: {
      provider: "TEESNAP",
      courseId: courseMetadata.courseId,
      bookingBaseUrl: bookingUrl,
      defaultHoles: courseMetadata.defaultHoles ?? 18,
      defaultAddons: courseMetadata.defaultAddons ?? "off"
    },
    confidence: 0.85,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "teesnap-booking-page"
    }
  };
}

function learnTeeItUpDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const officialPageMatchesTarget = Boolean(
    evidence.officialPage &&
      evidence.officialPage.courseName &&
      haveCompatibleCourseNames(
        evidence.courseName,
        evidence.officialPage.courseName
      )
  );
  const candidateLinks = officialPageMatchesTarget
    ? evidence.officialPage?.linkCandidates ?? []
    : [];
  const labeledBookingCandidates =
    uniqueTeeItUpLinkCandidates(candidateLinks);
  const hasTeeItUpEvidence =
    labeledBookingCandidates.length > 0 ||
    observedUrls.some(isTeeItUpBookingUrl);
  if (!officialPageMatchesTarget) {
    return hasTeeItUpEvidence
      ? buildRejectedTeeItUpDiscovery(
          evidence,
          observedUrls,
          false,
          "teeitup-target-scope-unconfirmed"
        )
      : null;
  }

  const generalPublicCandidates = labeledBookingCandidates.filter(
    ({ label }) => isGeneralPublicTeeItUpLabel(label)
  );
  const unrestrictedCandidates = labeledBookingCandidates.filter(
    ({ label }) => !isRestrictedTeeItUpLabel(label)
  );
  const selectedBookingUrls = uniqueUrls(
    generalPublicCandidates.length > 0
      ? generalPublicCandidates.map(({ url }) => url)
      : unrestrictedCandidates.length > 0
        ? unrestrictedCandidates.map(({ url }) => url)
        : labeledBookingCandidates.length > 0
          ? []
          : []
  );

  if (selectedBookingUrls.length === 0) {
    return hasTeeItUpEvidence
      ? buildRejectedTeeItUpDiscovery(
          evidence,
          observedUrls,
          officialPageMatchesTarget,
          "teeitup-target-scope-unconfirmed"
        )
      : null;
  }

  const selectorResolution = resolveTeeItUpFacilitySelector(
    selectedBookingUrls,
    evidence.teeItUpLegacyConfigurations,
    evidence.courseName
  );
  if (selectorResolution.status === "INVALID") {
    return buildRejectedTeeItUpDiscovery(
      evidence,
      observedUrls,
      officialPageMatchesTarget,
      "teeitup-target-scope-ambiguous"
    );
  }

  const aliases = [
    ...new Set(
      selectedBookingUrls
        .map(getTeeItUpAlias)
        .filter((alias): alias is string => Boolean(alias))
    )
  ];

  if (aliases.length === 0) {
    return buildRejectedTeeItUpDiscovery(
      evidence,
      observedUrls,
      officialPageMatchesTarget,
      "teeitup-alias-invalid"
    );
  }

  const bookingUrl = buildTeeItUpBookingUrl(
    selectedBookingUrls[0],
    selectorResolution.facilityId
  );
  if (!bookingUrl) {
    return buildRejectedTeeItUpDiscovery(
      evidence,
      observedUrls,
      officialPageMatchesTarget,
      "teeitup-booking-root-invalid"
    );
  }

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "TEEITUP",
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    apiEndpoint: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
    apiMetadata: {
      aliases,
      bookingBaseUrl: bookingUrl,
      ...(selectorResolution.facilityId
        ? { facilityIds: [selectorResolution.facilityId] }
        : {})
    },
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: selectedBookingUrls.some(isLegacyTeeItUpPlayUrl)
        ? "teeitup-legacy-play-configuration"
        : "teeitup-booking-url"
    }
  };
}

function getTargetScopedProviderEvidence(
  evidence: BrowserDiscoveryEvidence
): BrowserDiscoveryEvidence {
  if (
    !evidence.officialPage?.courseName ||
    !hasCanonicalTargetPageAuthority(evidence) ||
    !haveCompatibleCourseNames(
      evidence.courseName,
      evidence.officialPage.courseName
    )
  ) {
    return evidence;
  }
  return getOfficialSourceScopedEvidence(
    evidence,
    evidence.officialPage.visibleText ?? evidence.visibleText ?? ""
  );
}

function hasCanonicalTargetPageAuthority(
  evidence: BrowserDiscoveryEvidence
) {
  const sourcePage = parseUrl(evidence.sourceUrl);
  const officialPage = parseUrl(evidence.officialPage?.url);
  if (
    !sourcePage ||
    !officialPage ||
    !haveSameWebsiteOrigin(sourcePage, officialPage) ||
    isNonCourseInformationPage(sourcePage) ||
    isNonCourseInformationPage(officialPage)
  ) {
    return false;
  }
  const normalizePath = (url: URL) =>
    decodePagePath(url)
      .replace(/\/+$/u, "")
      .toLowerCase() || "/";
  if (normalizePath(sourcePage) === normalizePath(officialPage)) {
    return true;
  }
  return [sourcePage, officialPage].every((page) =>
    doesPagePathIdentifyCourse(page, evidence.courseName)
  );
}

function doesPagePathIdentifyCourse(page: URL, courseName: string) {
  const pathSegment = decodePagePath(page)
    .split("/")
    .filter(Boolean)
    .at(-1) ?? "";
  const identity = pathSegment
    .replace(/[-_]+/gu, " ")
    .replace(/\btee\s*times?\b/giu, " ");
  const targetIdentity = normalizeCourseIdentityName(courseName);
  return Boolean(
    targetIdentity &&
    normalizeCourseIdentityName(identity) === targetIdentity
  );
}

function isNonCourseInformationPage(page: URL) {
  const path = decodePagePath(page).replace(/[-_]+/gu, " ");
  return /\b(?:academy|events?|faqs?|instructors?|lessons?|simulators?|terms)\b/iu.test(
    path
  );
}

function decodePagePath(page: URL) {
  try {
    return decodeURIComponent(page.pathname);
  } catch {
    return page.pathname;
  }
}

function buildRejectedTeeItUpDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  officialPageMatchesTarget: boolean,
  learnedFrom: string
): BrowserDiscovery {
  const officialCoursePage = [
    officialPageMatchesTarget ? evidence.officialPage?.url : undefined,
    evidence.officialCourseWebsite ?? undefined,
    evidence.sourceUrl
  ]
    .map((value) => parseUrl(value))
    .find((url) => url && !isTeeItUpBookingUrl(url.toString()));
  const linkedProviderUrls = uniqueUrls(
    uniqueTeeItUpLinkCandidates(
      officialPageMatchesTarget ? evidence.officialPage?.linkCandidates ?? [] : []
    ).map(({ url }) => url)
  );
  const courseIdentityCorroboration = linkedProviderUrls.length === 1
    ? getOfficialCourseProviderLinkCorroboration(
        {
          courseId: evidence.courseId,
          status: "INSPECTED",
          detectedPlatform: "TEEITUP",
          sourceUrl: evidence.sourceUrl,
          bookingUrl: linkedProviderUrls[0],
          confidence: 0.45,
          evidence: { observedUrls, learnedFrom }
        },
        evidence
      )
    : null;

  return {
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: "TEEITUP",
    sourceUrl: evidence.sourceUrl,
    ...(officialCoursePage
      ? { bookingUrl: officialCoursePage.toString() }
      : {}),
    confidence: 0.45,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      ...(courseIdentityCorroboration ? { courseIdentityCorroboration } : {}),
      learnedFrom
    }
  };
}

function uniqueTeeItUpLinkCandidates(
  candidates: Array<{ url: string; label: string }>
) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (
      !isTeeItUpBookingUrl(candidate.url) ||
      !isTeeItUpPublicLandingCandidate(candidate.url)
    ) {
      return false;
    }
    const key = `${candidate.url}\u0000${candidate.label}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isGeneralPublicTeeItUpLabel(label: string) {
  return /\bgeneral\s+public\b|\bpublic\s+tee\s*times?\b/i.test(label);
}

function isRestrictedTeeItUpLabel(label: string) {
  return /\b(?:capital\s+club|juniors?|members?|military|seniors?)\b/i.test(
    label
  );
}

function resolveTeeItUpFacilitySelector(
  urls: string[],
  legacyConfigurations: TeeItUpLegacyConfigurationEvidence[] | undefined,
  courseName: string
):
  | { status: "VALID"; facilityId?: number }
  | { status: "INVALID" } {
  const legacyUrls = urls.filter(isLegacyTeeItUpPlayUrl);
  if (legacyUrls.length > 0) {
    if (legacyUrls.length !== 1 || urls.length !== 1) {
      return { status: "INVALID" };
    }
    const legacyUrl = legacyUrls[0];
    const alias = getTeeItUpAlias(legacyUrl);
    const matchingConfigurations = (legacyConfigurations ?? []).filter(
      (configuration) =>
        normalizeTeeItUpSourceUrl(configuration.providerUrl) ===
          normalizeTeeItUpSourceUrl(legacyUrl) &&
        alias &&
        configuration.alias.toLocaleLowerCase("en-US") ===
          alias.toLocaleLowerCase("en-US") &&
        configuration.facilityIds.length === 1 &&
        isPositiveSafeInteger(configuration.facilityIds[0]) &&
        haveCompatibleCourseNames(courseName, configuration.courseName)
    );
    const uniqueFacilityIds = new Set(
      matchingConfigurations.map(
        (configuration) => configuration.facilityIds[0]
      )
    );
    return matchingConfigurations.length > 0 && uniqueFacilityIds.size === 1
      ? { status: "VALID", facilityId: [...uniqueFacilityIds][0] }
      : { status: "INVALID" };
  }

  const facilityIds = new Set<number>();
  const scopedAliases = new Set<string>();
  let scopedUrlCount = 0;

  for (const value of urls) {
    const url = parseUrl(value);
    if (!url) {
      return { status: "INVALID" };
    }
    const selectors = url.searchParams.getAll("course");
    if (selectors.length === 0) {
      continue;
    }
    scopedUrlCount += 1;
    if (selectors.length !== 1 || !/^[1-9]\d*$/.test(selectors[0])) {
      return { status: "INVALID" };
    }
    const facilityId = Number(selectors[0]);
    if (!Number.isSafeInteger(facilityId) || facilityId <= 0) {
      return { status: "INVALID" };
    }
    const alias = getTeeItUpAlias(value);
    if (!alias) {
      return { status: "INVALID" };
    }
    facilityIds.add(facilityId);
    scopedAliases.add(alias.toLocaleLowerCase("en-US"));
  }

  if (
    facilityIds.size > 1 ||
    (scopedUrlCount === 0 && urls.length !== 1) ||
    (scopedUrlCount > 0 &&
      (scopedUrlCount !== urls.length || scopedAliases.size !== 1))
  ) {
    return { status: "INVALID" };
  }

  return {
    status: "VALID",
    ...(facilityIds.size === 1
      ? { facilityId: [...facilityIds][0] }
      : {})
  };
}

function buildTeeItUpBookingUrl(
  value: string | undefined,
  facilityId: number | undefined
) {
  const observedUrl = parseUrl(value);
  if (
    !observedUrl ||
    !["http:", "https:"].includes(observedUrl.protocol) ||
    !isTeeItUpBookingUrl(observedUrl.toString()) ||
    !isTeeItUpPublicLandingCandidate(observedUrl.toString())
  ) {
    return null;
  }
  const legacyHost = getLegacyTeeItUpHost(observedUrl.hostname);
  const bookingHostname = legacyHost
    ? `${legacyHost.alias}.book.teeitup.${legacyHost.domain}`
    : observedUrl.hostname;
  const bookingUrl = new URL(`https://${bookingHostname}/`);
  if (facilityId) {
    bookingUrl.searchParams.set("course", String(facilityId));
  }
  return isProviderPublicBookingLandingUrl(bookingUrl)
    ? bookingUrl.toString()
    : null;
}

export function getBestProbeUrl(
  course: Pick<
    BrowserProbeCourseInput,
    "website" | "detectedBookingUrl" | "monitoringFailureEvidence"
  > &
    Partial<
      Pick<
        BrowserProbeCourseInput,
        "detectedPlatform" | "providerFamilyKey" | "bookingMetadata"
      >
    >
) {
  const website = getSafeBrowserProbeUrl(course.website);
  const bookingUrl = getSafeBrowserProbeUrl(course.detectedBookingUrl);
  const provider = resolveProviderCapability(course);
  if (
    hasCurrentRepeatedMonitoringFailure(course.monitoringFailureEvidence) &&
    website &&
    isNonProviderWebsite(website)
  ) {
    return website;
  }
  if (
    website &&
    bookingUrl &&
    isNonProviderWebsite(website) &&
    provider.providerFamilyKey === "TEEITUP" &&
    provider.capability?.supportsAutomation &&
    !provider.metadataReady
  ) {
    return website;
  }
  if (
    website &&
    bookingUrl &&
    isSameHostGenericPermitDestination(website, bookingUrl)
  ) {
    return website;
  }
  return bookingUrl ?? website;
}

type CpsDiscoveryConfiguration = {
  courseId?: unknown;
  siteName?: unknown;
  clientId?: unknown;
  websiteId?: unknown;
  onlineApi?: unknown;
  authorityBaseUrl?: unknown;
  buildNumber?: unknown;
  terminalId?: unknown;
};

const CPS_CONFIGURATION_MAX_BYTES = 64 * 1024;
const CPS_PUBLIC_MONITOR_USER_AGENT =
  "TeeTimeSpot/1.0 (+https://teetimespot.com)";

export async function enrichCpsDiscovery(
  discovery: BrowserDiscovery,
  courseName: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscovery> {
  const bookingBase = parseUrl(discovery.bookingUrl);
  const existingMetadata = bookingBase
    ? getExistingCpsDiscoveryMetadata(discovery.apiMetadata, bookingBase)
    : null;
  const missingCourseId =
    discovery.status === "INSPECTED" &&
    discovery.evidence.learnedFrom === "cps-course-id-missing" &&
    discovery.apiMetadata === undefined;
  const missingPersistedConfiguration = Boolean(
    discovery.status === "LEARNED" &&
      discovery.evidence.learnedFrom === "cps-booking-url" &&
      existingMetadata &&
      (!existingMetadata.clientId ||
        !existingMetadata.websiteId ||
        !existingMetadata.onlineApi ||
        !existingMetadata.authorityBaseUrl)
  );
  if (
    (!missingCourseId && !missingPersistedConfiguration) ||
    discovery.detectedPlatform !== "CUSTOM" ||
    Boolean(discovery.evidence.accessBarriers?.length) ||
    !bookingBase ||
    !isStrictCpsTenantRoot(bookingBase)
  ) {
    return discovery;
  }

  const bookingBaseUrl = `${bookingBase.origin}/`;
  const configurationUrl = new URL(
    "/onlineresweb/Home/Configuration",
    bookingBaseUrl
  );
  const response = await fetchImpl(configurationUrl, {
    headers: {
      Accept: "application/json",
      Referer: bookingBaseUrl,
      "User-Agent": CPS_PUBLIC_MONITOR_USER_AGENT
    },
    redirect: "manual"
  });
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    return withCpsConfigurationResult(discovery, "redirected");
  }
  if (!response.ok || response.status !== 200) {
    return withCpsConfigurationResult(discovery, "unavailable");
  }

  const responseUrl = parseUrl(response.url);
  if (
    response.url &&
    (!responseUrl ||
      responseUrl.origin !== configurationUrl.origin ||
      responseUrl.pathname !== configurationUrl.pathname ||
      responseUrl.search ||
      responseUrl.hash)
  ) {
    return withCpsConfigurationResult(discovery, "redirected");
  }

  const rawConfiguration = await readBoundedCpsConfiguration(response);
  if (!rawConfiguration) {
    return withCpsConfigurationResult(discovery, "invalid");
  }
  const configuration = parseCpsDiscoveryConfiguration(
    rawConfiguration,
    bookingBase,
    missingCourseId ? courseName : null
  );
  if (!configuration) {
    return withCpsConfigurationResult(discovery, "invalid");
  }
  const courseIdentity = resolveEnrichedCpsCourseIdentity(
    existingMetadata,
    configuration.courseId
  );
  if (!courseIdentity) {
    return withCpsConfigurationResult(discovery, "invalid");
  }

  return {
    ...discovery,
    status: "LEARNED",
    bookingUrl: bookingBaseUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes:
      "The exact CPS tenant publishes course-specific configuration for its signed-out tee-time search. Tee Time Spot reads public availability and leaves booking on the official provider page.",
    apiEndpoint: `${bookingBase.origin}/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes`,
    apiMetadata: {
      provider: "CPS",
      siteName: configuration.siteName,
      bookingBaseUrl,
      courseIds: courseIdentity.courseIds,
      holes: existingMetadata?.holes ?? [18, 9],
      ...(courseIdentity.resolvePlaceholderCourseIds
        ? { resolvePlaceholderCourseIds: true }
        : {}),
      clientId: configuration.clientId,
      websiteId: configuration.websiteId,
      onlineApi: configuration.onlineApi,
      authorityBaseUrl: configuration.authorityBaseUrl,
      ...(configuration.buildNumber
        ? { buildNumber: configuration.buildNumber }
        : {}),
      ...(configuration.terminalId !== undefined
        ? { terminalId: configuration.terminalId }
        : {})
    },
    confidence: 0.95,
    evidence: {
      ...discovery.evidence,
      observedUrls: uniqueUrls([
        ...discovery.evidence.observedUrls,
        configurationUrl.toString()
      ]),
      learnedFrom: "cps-public-configuration"
    }
  };
}

function withCpsConfigurationResult(
  discovery: BrowserDiscovery,
  reason: "invalid" | "redirected" | "unavailable"
) {
  return {
    ...discovery,
    evidence: {
      ...discovery.evidence,
      learnedFrom: `cps-public-configuration-${reason}`
    }
  };
}

function parseCpsDiscoveryConfiguration(
  value: unknown,
  bookingBase: URL,
  courseName: string | null
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const configuration = value as CpsDiscoveryConfiguration;
  const courseId = configuration.courseId;
  const siteName =
    typeof configuration.siteName === "string"
      ? configuration.siteName.trim()
      : "";
  const clientId =
    configuration.clientId === undefined
      ? "onlineresweb"
      : typeof configuration.clientId === "string"
        ? configuration.clientId.trim()
        : "";
  const websiteId =
    typeof configuration.websiteId === "string"
      ? configuration.websiteId.trim()
      : "";
  const onlineApi = parseCpsConfigurationEndpoint(
    configuration.onlineApi,
    bookingBase,
    /^\/onlineres\/onlineapi\/api\/v1\/onlinereservation\/?$/i
  );
  const authorityBaseUrl = parseCpsConfigurationEndpoint(
    configuration.authorityBaseUrl,
    bookingBase,
    /^\/identityapi\/?$/i
  );
  const buildNumber =
    typeof configuration.buildNumber === "string" &&
    configuration.buildNumber.trim().length > 0 &&
    configuration.buildNumber.trim().length <= 200
      ? configuration.buildNumber.trim()
      : undefined;
  const terminalId =
    Number.isSafeInteger(configuration.terminalId) &&
    (configuration.terminalId as number) >= 0
      ? (configuration.terminalId as number)
      : undefined;
  const tenantName = bookingBase.hostname.split(".")[0] ?? "";
  const tenantIdentity = normalizeCpsTenantIdentity(tenantName);
  const siteIdentity = normalizeCpsTenantIdentity(siteName);
  const courseIdentity = courseName
    ? normalizeCpsTenantIdentity(courseName)
    : null;

  if (
    !Number.isSafeInteger(courseId) ||
    (courseId as number) < 0 ||
    !/^[a-z0-9_-]{1,80}$/i.test(siteName) ||
    clientId.length < 1 ||
    clientId.length > 200 ||
    websiteId.length < 1 ||
    websiteId.length > 200 ||
    !tenantIdentity ||
    tenantIdentity !== siteIdentity ||
    (courseName !== null &&
      (!courseIdentity || tenantIdentity !== courseIdentity)) ||
    !onlineApi ||
    !authorityBaseUrl
  ) {
    return null;
  }

  return {
    courseId: courseId as number,
    siteName,
    clientId,
    websiteId,
    onlineApi,
    authorityBaseUrl,
    ...(buildNumber ? { buildNumber } : {}),
    ...(terminalId !== undefined ? { terminalId } : {})
  };
}

function resolveEnrichedCpsCourseIdentity(
  existingMetadata: ReturnType<typeof getExistingCpsDiscoveryMetadata>,
  configurationCourseId: number
) {
  if (!existingMetadata) {
    return {
      courseIds: [configurationCourseId],
      resolvePlaceholderCourseIds: configurationCourseId === 0
    };
  }
  const hasOnlyPlaceholder =
    existingMetadata.courseIds.length === 1 &&
    existingMetadata.courseIds[0] === 0;
  if (hasOnlyPlaceholder) {
    return configurationCourseId === 0
      ? { courseIds: [0], resolvePlaceholderCourseIds: true }
      : {
          courseIds: [configurationCourseId],
          resolvePlaceholderCourseIds: false
        };
  }
  if (
    configurationCourseId !== 0 &&
    !existingMetadata.courseIds.includes(configurationCourseId)
  ) {
    return null;
  }
  return {
    courseIds: existingMetadata.courseIds,
    resolvePlaceholderCourseIds: false
  };
}

function getExistingCpsDiscoveryMetadata(
  value: BrowserDiscovery["apiMetadata"],
  bookingBase: URL
) {
  if (!value || !("provider" in value) || value.provider !== "CPS") {
    return null;
  }
  const tenantName = bookingBase.hostname.split(".")[0]?.toLowerCase();
  if (
    !tenantName ||
    value.siteName.trim().toLowerCase() !== tenantName ||
    value.bookingBaseUrl !== `${bookingBase.origin}/` ||
    value.courseIds.length === 0 ||
    !value.courseIds.every(
      (courseId) => Number.isSafeInteger(courseId) && courseId >= 0
    ) ||
    (value.holes !== undefined &&
      (value.holes.length === 0 ||
        !value.holes.every((holes) => holes === 9 || holes === 18))) ||
    (value.buildNumber !== undefined &&
      (typeof value.buildNumber !== "string" ||
        value.buildNumber.trim().length === 0 ||
        value.buildNumber.trim().length > 200)) ||
    (value.terminalId !== undefined &&
      (!Number.isSafeInteger(value.terminalId) || value.terminalId < 0))
  ) {
    return null;
  }
  return value;
}

function isStrictCpsTenantRoot(url: URL) {
  return Boolean(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^[a-z0-9](?:[a-z0-9-]{0,62})\.cps\.golf$/i.test(url.hostname) &&
      url.hostname.toLowerCase() !== "sc.cps.golf"
  );
}

async function readBoundedCpsConfiguration(response: Response) {
  const contentType = response.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    contentType !== "application/json" &&
    !contentType?.endsWith("+json")
  ) {
    return null;
  }

  const declaredLength = response.headers.get("content-length")?.trim();
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > CPS_CONFIGURATION_MAX_BYTES)
  ) {
    return null;
  }

  const body = response.body;
  if (!body) {
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > CPS_CONFIGURATION_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseCpsConfigurationEndpoint(
  value: unknown,
  bookingBase: URL,
  expectedPath: RegExp
) {
  const url = parseUrl(typeof value === "string" ? value.trim() : undefined);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.origin !== bookingBase.origin ||
    url.search ||
    url.hash ||
    !expectedPath.test(url.pathname)
  ) {
    return null;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function isSameHostGenericPermitDestination(website: string, bookingUrl: string) {
  const official = parseUrl(website);
  const detected = parseUrl(bookingUrl);
  if (
    !official ||
    !detected ||
    normalizeHostname(official.hostname) !== normalizeHostname(detected.hostname)
  ) {
    return false;
  }
  const route = `${detected.pathname} ${detected.search}`
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim();
  return (
    /\b(?:permits?|forms?)\b/i.test(route) &&
    !/\b(?:golf|tee\s*times?)\b/i.test(route)
  );
}

function getSafeBrowserProbeUrl(value: string | null | undefined) {
  const parsed = parseUrl(value?.trim());
  return parsed &&
    isSafeManualEvidenceUrl(parsed) &&
    (!getKnownProviderFamilyForHostname(parsed.hostname) ||
      isProviderPublicBookingLandingUrl(parsed))
    ? parsed.toString()
    : null;
}

function isNonProviderWebsite(value: string) {
  const url = parseUrl(value);
  return Boolean(url && !getKnownProviderFamilyForHostname(url.hostname));
}

function learnForeupDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const foreupApiUrls = observedUrls
    .map(parseUrl)
    .filter((url): url is URL => Boolean(url && isForeupApiUrl(url.toString())));
  const foreupBookingUrls = observedUrls
    .map(canonicalizeForeupBookingUrl)
    .filter((url): url is string => Boolean(url));
  const foreupApiUrl = foreupApiUrls[0];
  const foreupBookingUrl = foreupBookingUrls[0];

  if (!foreupApiUrl && !foreupBookingUrl) {
    return null;
  }

  const apiScheduleIds = new Set(
    foreupApiUrls
      .map((url) => getPositiveBoundedSearchParam(url, "schedule_id"))
      .filter((value): value is number => value !== undefined)
  );
  const landingScheduleIds = new Set(
    foreupBookingUrls
      .map(getForeupScheduleId)
      .filter((value): value is number => value !== undefined)
  );
  const apiScheduleId = [...apiScheduleIds][0];
  const landingScheduleId = [...landingScheduleIds][0];
  if (
    apiScheduleIds.size > 1 ||
    landingScheduleIds.size > 1 ||
    (apiScheduleId !== undefined &&
      landingScheduleId !== undefined &&
      apiScheduleId !== landingScheduleId)
  ) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "FOREUP",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: foreupBookingUrl,
      confidence: 0.45,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: "foreup-selector-conflict"
      }
    };
  }

  const foreupAccessBarriers = evidence.accessBarriers?.filter(
    (barrier) =>
      isForeupBookingUrl(barrier.url) || isForeupApiUrl(barrier.url)
  ) ?? [];
  const safeObservedUrls = sanitizeObservedAccessBarrierUrls(
    observedUrls,
    foreupAccessBarriers
  );
  const scheduleId =
    apiScheduleId ?? landingScheduleId;
  const bookingClassId = getPositiveBoundedSearchParam(
    foreupApiUrl,
    "booking_class"
  );
  const canonicalBookingUrl = foreupBookingUrl;
  const accessBarrierProviderIds = {
    ...(scheduleId ? { scheduleId } : {}),
    ...(bookingClassId ? { bookingClassId } : {})
  };
  const corroboratedAccessBarrier = evidence.corroboratedAccessBarrier
    ? foreupAccessBarriers.find((barrier) =>
        areSameAccessBarrier(barrier, evidence.corroboratedAccessBarrier!)
      )
    : undefined;
  const accessBarrier = corroboratedAccessBarrier ?? foreupAccessBarriers[0];
  if (accessBarrier) {
    const safeAccessBarriers = sanitizeAccessBarriers([accessBarrier]);
    if (!corroboratedAccessBarrier) {
      return {
        courseId: evidence.courseId,
        status: "INSPECTED",
        detectedPlatform: "FOREUP",
        sourceUrl: evidence.sourceUrl,
        bookingUrl: canonicalBookingUrl,
        bookingMethod: "PUBLIC_ONLINE",
        automationEligibility: "NEEDS_REVIEW",
        automationReason: "NONE",
        confidence: 0.65,
          evidence: {
            finalUrl: evidence.finalUrl,
            observedUrls: safeObservedUrls,
            visibleText: summarizeVisibleText(evidence.visibleText),
            accessBarriers: safeAccessBarriers,
            ...(Object.keys(accessBarrierProviderIds).length > 0
              ? { accessBarrierProviderIds }
              : {}),
            learnedFrom: "foreup-access-control-unconfirmed"
        }
      };
    }

    return {
      courseId: evidence.courseId,
      status: "VERIFIED",
      detectedPlatform: "FOREUP",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: canonicalBookingUrl,
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason:
        accessBarrier.status === 401 ? "ACCOUNT_REQUIRED" : "CAPTCHA_OR_QUEUE",
      policyNotes:
        "The official ForeUP booking page is available for golfers, but signed-out automated retrieval is denied by the provider's access control. Tee Time Spot does not bypass access controls, so golfers should check and book on the official page directly.",
      intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confidence: 0.95,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls: safeObservedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        accessBarriers: safeAccessBarriers,
        ...(Object.keys(accessBarrierProviderIds).length > 0
          ? { accessBarrierProviderIds }
          : {}),
        learnedFrom: "foreup-access-control"
      }
    };
  }

  if (!scheduleId || !canonicalBookingUrl) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "FOREUP",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: canonicalBookingUrl,
      apiEndpoint: foreupApiUrl ? getOriginAndPath(foreupApiUrl) : undefined,
      confidence: 0.55,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: "foreup-url-without-schedule"
      }
    };
  }

  const bookingBaseUrl = canonicalBookingUrl;
  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "FOREUP",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    apiEndpoint: foreupApiUrl ? getOriginAndPath(foreupApiUrl) : undefined,
    apiMetadata: {
      scheduleId,
      ...(bookingClassId ? { bookingClassId } : {}),
      bookingBaseUrl
    },
    confidence: foreupApiUrl ? 0.95 : 0.8,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: foreupApiUrl ? "foreup-api-request" : "foreup-booking-url"
    }
  };
}

function detectPlatform(urls: string[]): BrowserDiscovery["detectedPlatform"] {
  for (const url of urls) {
    const resolution = resolveProviderCapability({ detectedBookingUrl: url });
    if (resolution.capability) {
      return resolution.detectedPlatform;
    }
  }
  return "UNKNOWN";
}

function pickBookingLikeUrl(
  urls: string[],
  linkCandidates: Array<{ url: string; label: string }>
) {
  const candidates = urls.flatMap((url) => {
    const parsed = parseUrl(url);
    if (
      !parsed ||
      !isSafeManualEvidenceUrl(parsed) ||
      isNonBookingHost(parsed.hostname) ||
      isStaticAssetPath(parsed.pathname) ||
      isEditorialContentPath(parsed.pathname) ||
      isClearlyUnrelatedBookingUrl(parsed) ||
      (getKnownProviderFamilyForHostname(parsed.hostname) &&
        !isProviderPublicBookingLandingUrl(parsed))
    ) {
      return [];
    }

    return [{ url, parsed }];
  });

  const recognizedProvider = candidates.find(({ url, parsed }) =>
    Boolean(
      getKnownProviderFamilyForHostname(parsed.hostname) &&
        linkCandidates.some(
          (candidate) =>
            haveSameExactUrl(candidate.url, url) &&
            isRecognizedProviderBookingLink(candidate)
        )
    )
  );
  if (recognizedProvider) {
    return recognizedProvider.url;
  }

  return candidates.find(({ parsed }) => {
    if (parsed.hostname.endsWith("chelseareservations.com")) {
      return true;
    }

    const searchable = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
    return /(^|[^a-z])(book|booking|tee.?times?|reservations?|reserve|foreup|golfnow|teeitup|chronogolf|clubcaddie)([^a-z]|$)/i.test(
      searchable
    );
  })?.url;
}

function isRecognizedProviderBookingLink(candidate: {
  url: string;
  label: string;
}) {
  const parsed = parseUrl(candidate.url);
  if (
    !parsed ||
    !isSafeManualEvidenceUrl(parsed) ||
    !getKnownProviderFamilyForHostname(parsed.hostname) ||
    isProviderInfrastructureUrl(parsed) ||
    !isProviderPublicBookingLandingUrl(parsed) ||
    isClearlyUnrelatedBookingLabel(candidate.label) ||
    isClearlyUnrelatedBookingUrl(parsed)
  ) {
    return false;
  }
  const label = normalizeTeeTimeTypography(candidate.label)
    .replace(/\s+/gu, " ")
    .trim();
  return Boolean(
    isBookingCallToActionCandidate(candidate) ||
      isGenericOnlineBookingCallToAction(candidate) ||
      /^(?:book|reserve)(?:\s+(?:now|online))?$/iu.test(label)
  );
}

function uniqueUrls(urls: Array<string | undefined>) {
  return [...new Set(urls.filter((url): url is string => Boolean(url?.trim())).map((url) => url.trim()))];
}

function parseUrl(value?: string | null) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isForeupBookingUrl(value?: string) {
  const url = parseUrl(value);
  return Boolean(
    url &&
      /^(?:www\.)?foreupsoftware\.com$/i.test(url.hostname) &&
      isProviderPublicBookingLandingUrl(url)
  );
}

function canonicalizeForeupBookingUrl(value?: string) {
  const url = parseUrl(value);
  if (!url || !isForeupBookingUrl(url.toString())) {
    return null;
  }
  url.search = "";
  if (!url.hash) {
    url.hash = "#/teetimes";
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString();
}

function getPositiveBoundedSearchParam(
  url: URL | null | undefined,
  key: string
) {
  const values = url?.searchParams.getAll(key) ?? [];
  if (values.length !== 1 || !/^[1-9]\d{0,9}$/u.test(values[0])) {
    return undefined;
  }
  const parsed = Number(values[0]);
  return Number.isSafeInteger(parsed) && parsed <= 2_147_483_647
    ? parsed
    : undefined;
}

function getForeupScheduleId(value?: string) {
  const path = parseUrl(value)?.pathname;
  const match = path?.match(
    /^\/index\.php\/booking\/[1-9]\d{0,9}\/([1-9]\d{0,9})\/?$/u
  );
  const parsed = match?.[1] ? Number(match[1]) : undefined;
  return parsed && Number.isSafeInteger(parsed) && parsed <= 2_147_483_647
    ? parsed
    : undefined;
}

function isForeupApiUrl(value?: string) {
  const url = parseUrl(value);
  return Boolean(
    url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^(?:www\.)?foreupsoftware\.com$/i.test(url.hostname) &&
      url.pathname === "/index.php/api/booking/times" &&
      !url.hash &&
      isSafeManualEvidenceUrl(url)
  );
}

export function findCorroboratingAccessBarrier(
  previousEvidence: unknown,
  currentBarriers: BrowserAccessBarrier[] | undefined
) {
  if (!currentBarriers?.length || !previousEvidence || typeof previousEvidence !== "object") {
    return null;
  }
  const previous = previousEvidence as Record<string, unknown>;
  const previousBarriers = Array.isArray(previous.accessBarriers)
    ? previous.accessBarriers
        .filter(
          (value): value is Record<string, unknown> =>
            Boolean(value) && typeof value === "object" && !Array.isArray(value)
        )
        .map((value) => ({
          url: typeof value.url === "string" ? value.url : "",
          status: value.status
        }))
    : [];

  for (const current of currentBarriers) {
    if (!normalizeAccessBarrierUrl(current.url)) {
      continue;
    }
    if (
      previousBarriers.some((previousBarrier) =>
        areSameAccessBarrier(previousBarrier as BrowserAccessBarrier, current)
      )
    ) {
      return current;
    }

    const legacyVisibleText =
      typeof previous.visibleText === "string" ? previous.visibleText : "";
    const legacyObservedUrls = Array.isArray(previous.observedUrls)
      ? previous.observedUrls.filter((value): value is string => typeof value === "string")
      : [];
    if (
      current.status === 403 &&
      /\b403\s+Forbidden\b/i.test(legacyVisibleText) &&
      legacyObservedUrls.some(
        (value) => normalizeAccessBarrierUrl(value) === normalizeAccessBarrierUrl(current.url)
      )
    ) {
      return current;
    }
  }

  return null;
}

function areSameAccessBarrier(
  left: Pick<BrowserAccessBarrier, "url" | "status">,
  right: Pick<BrowserAccessBarrier, "url" | "status">
) {
  const leftUrl = normalizeAccessBarrierUrl(left.url);
  return Boolean(
    leftUrl &&
      left.status === right.status &&
      leftUrl === normalizeAccessBarrierUrl(right.url)
  );
}

function sanitizeAccessBarriers(barriers: BrowserAccessBarrier[]) {
  return barriers.flatMap((barrier) => {
    const url = normalizeAccessBarrierUrl(barrier.url);
    return url ? [{ url, status: barrier.status }] : [];
  });
}

function sanitizeObservedAccessBarrierUrls(
  observedUrls: string[],
  barriers: BrowserAccessBarrier[]
) {
  const deniedUrls = new Set(
    barriers.flatMap((barrier) => {
      const url = parseUrl(barrier.url);
      if (!url) {
        return [];
      }
      url.hash = "";
      return [url.toString()];
    })
  );

  return uniqueUrls(
    observedUrls.map((value) => {
      const url = parseUrl(value);
      if (!url) {
        return value;
      }
      url.hash = "";
      return deniedUrls.has(url.toString())
        ? `${url.origin}${url.pathname}`
        : value;
    })
  );
}

function sanitizeDeniedUrl(value: string, barriers: BrowserAccessBarrier[]) {
  const url = parseUrl(value);
  if (!url) {
    return value;
  }
  url.hash = "";
  const denied = barriers.some((barrier) => {
    const deniedUrl = parseUrl(barrier.url);
    if (!deniedUrl) {
      return false;
    }
    deniedUrl.hash = "";
    return deniedUrl.toString() === url.toString();
  });
  return denied ? `${url.origin}${url.pathname}` : value;
}

function normalizeAccessBarrierUrl(value: string) {
  const url = parseUrl(value);
  return url ? `${url.origin}${url.pathname}` : null;
}

function getOriginAndPath(url: URL) {
  return `${url.origin}${url.pathname}`;
}

function getTeeItUpAlias(value: string) {
  const url = parseUrl(value);
  if (!url) {
    return null;
  }

  const bookingHostMatch = url.hostname.match(/^(.+)\.book\.teeitup\.(?:golf|com)$/i);
  if (bookingHostMatch?.[1]) {
    return bookingHostMatch[1];
  }

  const legacyHost = getLegacyTeeItUpHost(url.hostname);
  if (legacyHost && isLegacyTeeItUpPlayUrl(value)) {
    return legacyHost.alias;
  }

  if (url.hostname === "phx-api-be-east-1b.kenna.io") {
    const aliasMatch = url.pathname.match(/^\/alias\/([^/]+)\/facilities$/);
    if (aliasMatch?.[1]) {
      return aliasMatch[1];
    }
  }

  return null;
}

function isTeeItUpBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url?.hostname.match(/^.+\.book\.teeitup\.(?:golf|com)$/i) ||
      isLegacyTeeItUpPlayUrl(value)
  );
}

function isTeeItUpPublicLandingCandidate(value: string) {
  const url = parseUrl(value);
  if (!url || !["http:", "https:"].includes(url.protocol)) {
    return false;
  }
  if (url.protocol === "http:") {
    url.protocol = "https:";
    url.port = "";
  }
  return isProviderPublicBookingLandingUrl(url);
}

export function isLegacyTeeItUpPlayUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.pathname === "/" &&
      !url.search &&
      getLegacyTeeItUpHost(url.hostname)
  );
}

function getLegacyTeeItUpHost(hostname: string) {
  const match = hostname.match(
    /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.play\.teeitup\.(golf|com)$/i
  );
  return match?.[1] && match[2]
    ? {
        alias: match[1],
        domain: match[2].toLocaleLowerCase("en-US")
      }
    : null;
}

function normalizeTeeItUpSourceUrl(value: string) {
  const url = parseUrl(value);
  return url && isLegacyTeeItUpPlayUrl(value)
    ? `https://${url.hostname.toLocaleLowerCase("en-US")}/`
    : null;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTeesnapBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url &&
      isTeesnapTenantHostname(url.hostname) &&
      isProviderPublicBookingLandingUrl(url)
  );
}

function isTeesnapTechnicalEvidenceUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      isTeesnapTenantHostname(url.hostname) &&
      url.pathname.toLocaleLowerCase("en-US") ===
        "/customer-api/teetimes-day" &&
      !url.hash &&
      readTeesnapTechnicalCourseId(url) !== undefined
  );
}

function isTeesnapTenantHostname(hostname: string) {
  const normalized = hostname.toLocaleLowerCase("en-US");
  if (!normalized.endsWith(".teesnap.net")) {
    return false;
  }
  const tenant = normalized.slice(0, -".teesnap.net".length);
  return Boolean(tenant && !tenant.includes("."));
}

function readTeesnapTechnicalCourseId(url: URL) {
  const allowedKeys = new Set([
    "addons",
    "course",
    "date",
    "holes",
    "players",
    "profileid"
  ]);
  const query = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLocaleLowerCase("en-US");
    if (!allowedKeys.has(normalizedKey) || query.has(normalizedKey)) {
      return undefined;
    }
    query.set(normalizedKey, value);
  }
  const course = query.get("course");
  if (!course || !/^[1-9]\d{0,9}$/u.test(course)) {
    return undefined;
  }
  const courseId = Number(course);
  if (!Number.isSafeInteger(courseId) || courseId > 2_147_483_647) {
    return undefined;
  }
  const players = query.get("players");
  const holes = query.get("holes");
  const addons = query.get("addons");
  const date = query.get("date");
  const profileId = query.get("profileid");
  if (
    (players && !/^[1-8]$/u.test(players)) ||
    (holes && holes !== "9" && holes !== "18") ||
    (addons && addons !== "on" && addons !== "off") ||
    (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) ||
    (profileId !== undefined && !/^[a-z0-9_-]{0,64}$/iu.test(profileId))
  ) {
    return undefined;
  }
  return courseId;
}

type TeesnapDiscoveryCourseConfig = {
  id?: unknown;
  name?: unknown;
  core_id?: unknown;
  course_type?: unknown;
  enabled?: unknown;
  customer_enabled?: unknown;
  holes_default?: unknown;
  addons_default?: unknown;
};

type TeesnapMetadataResolutionReason =
  | "course-config-ambiguous"
  | "course-config-invalid"
  | "course-config-missing"
  | "observed-course-config-mismatch"
  | "physical-course-config-missing";

function resolveTeesnapCourseMetadata(
  urls: string[],
  text: string | undefined,
  courseName: string
): {
  metadata?: ReturnType<typeof buildTeesnapCourseMetadata>;
  reason: TeesnapMetadataResolutionReason;
} {
  const parsed = parseTeesnapCourseConfigs(text);
  const observedCourseIds = [...new Set(
    urls
      .map(parseUrl)
      .map((url) => (url ? readTeesnapTechnicalCourseId(url) : undefined))
      .filter((courseId): courseId is number => courseId !== undefined)
  )];
  const physicalConfigs = dedupeTeesnapCourseConfigs(
    parsed.configs.filter(isPhysicalTeesnapCourseConfig)
  );

  if (observedCourseIds.length === 1) {
    const courseId = observedCourseIds[0];
    const matchingConfig = parsed.configs.find((candidate) => candidate.id === courseId);
    if (matchingConfig && isPhysicalTeesnapCourseConfig(matchingConfig)) {
      return {
        metadata: buildTeesnapCourseMetadata(matchingConfig, courseId),
        reason: parsed.reason
      };
    }
    if (matchingConfig) {
      return { reason: "physical-course-config-missing" };
    }
    if (parsed.configs.length > 0) {
      return { reason: "observed-course-config-mismatch" };
    }
    return {
      metadata: buildTeesnapCourseMetadata(undefined, courseId),
      reason: parsed.reason
    };
  }

  const namedPhysicalConfigs = physicalConfigs.filter((candidate) =>
    typeof candidate.name === "string" && candidate.name.trim().length > 0
  );
  const eligibleConfigs = observedCourseIds.length > 1
    ? namedPhysicalConfigs.filter((candidate) =>
        observedCourseIds.includes(candidate.id as number)
      )
    : namedPhysicalConfigs;
  if (eligibleConfigs.length === 0) {
    return {
      reason: parsed.configs.length > 0
        ? "physical-course-config-missing"
        : parsed.reason
    };
  }

  const normalizedTarget = normalizeCourseName(courseName);
  const exactMatches = eligibleConfigs.filter(
    (candidate) => normalizeCourseName(String(candidate.name ?? "")) === normalizedTarget
  );
  const compatibleMatches = exactMatches.length > 0
    ? exactMatches
    : eligibleConfigs.filter((candidate) =>
        typeof candidate.name === "string" &&
        haveCompatibleCourseNames(courseName, candidate.name)
      );
  const selected = compatibleMatches.length === 1
    ? compatibleMatches[0]
    : compatibleMatches.length === 0 && eligibleConfigs.length === 1
      ? eligibleConfigs[0]
      : undefined;
  return selected && typeof selected.id === "number"
    ? {
        metadata: buildTeesnapCourseMetadata(selected, selected.id),
        reason: parsed.reason
      }
    : { reason: "course-config-ambiguous" };
}

function isTenForeBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url?.hostname.toLowerCase() === "fox.tenfore.golf" &&
      /^\/[a-z0-9-]+\/?$/i.test(url.pathname) &&
      isProviderPublicBookingLandingUrl(url)
  );
}

function isGolfBackBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(
    url &&
      isGolfBackHostname(url.hostname) &&
      isProviderPublicBookingLandingUrl(url) &&
      getGolfBackCourseId(value)
  );
}

function isGolfBackHostname(hostname: string) {
  return /(^|\.)golfback\.com$/i.test(hostname);
}

function getGolfBackCourseId(value: string) {
  const url = parseUrl(value);
  return url?.hash.match(
    /^#\/course\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i
  )?.[1] ?? null;
}

function canonicalizeTenForeBookingUrl(value: string) {
  const url = new URL(value);
  const vanityName = url.pathname.split("/").filter(Boolean)[0];
  return `${url.origin}/${vanityName}`;
}

function parseTeesnapCourseConfigs(text?: string): {
  configs: TeesnapDiscoveryCourseConfig[];
  reason: TeesnapMetadataResolutionReason;
} {
  const assignment = text?.match(/window\.courses\s*=/i);
  if (!text || assignment?.index === undefined) {
    return { configs: [], reason: "course-config-missing" };
  }
  const start = text.indexOf("[", assignment.index + assignment[0].length);
  const serialized = start >= 0 ? extractBalancedJsonArray(text, start) : null;
  if (!serialized) {
    return { configs: [], reason: "course-config-invalid" };
  }

  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed)
      ? { configs: parsed, reason: "course-config-missing" }
      : { configs: [], reason: "course-config-invalid" };
  } catch {
    return { configs: [], reason: "course-config-invalid" };
  }
}

function extractBalancedJsonArray(text: string, start: number) {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
}

function dedupeTeesnapCourseConfigs(configs: TeesnapDiscoveryCourseConfig[]) {
  const byId = new Map<number, TeesnapDiscoveryCourseConfig>();
  for (const config of configs) {
    if (typeof config.id === "number" && !byId.has(config.id)) {
      byId.set(config.id, config);
    }
  }
  return [...byId.values()];
}

function isPhysicalTeesnapCourseConfig(config: TeesnapDiscoveryCourseConfig) {
  const name = typeof config.name === "string" ? config.name : "";
  const courseType = typeof config.course_type === "string" ? config.course_type : "";
  return Boolean(
    Number.isInteger(config.id) &&
      config.enabled !== false &&
      config.customer_enabled !== false &&
      !/\b(?:activit(?:y|ies)|driving[\s_-]+range|events?|gift[\s_-]+cards?|leagues?|lessons?|mini[\s_-]+golf|putt(?:-|[\s_])putt|putting[\s_-]+course|simulators?|top[\s_-]*tracer)\b/i.test(
        `${name} ${courseType}`
      ) &&
      !/\bdisc[\s_-]*golf\b/i.test(`${name} ${courseType}`)
  );
}

function buildTeesnapCourseMetadata(
  config: TeesnapDiscoveryCourseConfig | undefined,
  courseId: number
) {
  const holes = Number(config?.holes_default);
  const defaultAddons =
    typeof config?.addons_default === "string" ? config.addons_default : undefined;
  return {
    courseId,
    ...(holes === 9 || holes === 18 ? { defaultHoles: holes as 9 | 18 } : {}),
    ...(defaultAddons ? { defaultAddons } : {})
  };
}

function normalizeCourseName(value: string) {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNonBookingHost(hostname: string) {
  return /(^|\.)facebook\.com$|(^|\.)instagram\.com$|(^|\.)x\.com$|(^|\.)twitter\.com$|(^|\.)youtube\.com$|(^|\.)linkedin\.com$/i.test(
    hostname
  );
}

function isStaticAssetPath(pathname: string) {
  return /\.(?:css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf)(?:$|[?#])/i.test(pathname);
}

function summarizeVisibleText(text?: string) {
  return text?.replace(/\s+/g, " ").trim().slice(0, 1000) || undefined;
}

function isEditorialContentPath(pathname: string) {
  return /\/(?:events?|news|blog|calendar|posts?)\//i.test(pathname);
}
