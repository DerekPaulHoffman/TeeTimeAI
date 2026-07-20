import type {
  AutomationReason,
  BookingMethod
} from "@/lib/courses/intelligence";
import { isClubCaddieMetadata } from "@/lib/adapters/clubcaddie";
import {
  getKnownProviderFamilyForHostname,
  resolveProviderCapability
} from "@/lib/automation/provider-capabilities";
import { evaluateMonitoringGate } from "@/lib/automation/policy";
import {
  haveCompatibleCourseNames,
  normalizeCourseIdentityName
} from "@/lib/places/course-identity";

export type BrowserDiscoveryEvidence = {
  courseId: string;
  courseName: string;
  sourceUrl: string;
  finalUrl?: string;
  observedUrls: string[];
  linkCandidates?: Array<{ url: string; label: string }>;
  officialCourseWebsite?: string | null;
  officialPage?: {
    url: string;
    linkCandidates: Array<{ url: string; label: string }>;
  };
  visibleText?: string;
  bookingSurfaceText?: string;
  providerPolicyText?: string;
  providerPolicyUrl?: string;
  accessBarrierUrls?: string[];
  accessBarriers?: BrowserAccessBarrier[];
  corroboratedAccessBarrier?: BrowserAccessBarrier;
  bookingCallToAction?: boolean;
};

export type BrowserAccessBarrier = {
  url: string;
  status: 401 | 403;
};

export type BrowserDiscovery = {
  courseId: string;
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
    const chronogolfDiscovery = await enrichChronogolfDiscovery(
      discovery,
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
  const observedUrls = uniqueUrls([
    evidence.finalUrl,
    evidence.sourceUrl,
    ...evidence.observedUrls
  ]);
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

  const accountRequiredClassification = learnAccountRequiredClassification(
    evidence,
    observedUrls
  );

  if (accountRequiredClassification) {
    return withCourseIdentityCorroboration(accountRequiredClassification, evidence);
  }

  const whooshDiscovery = learnWhooshBookingClassification(evidence, observedUrls);

  if (whooshDiscovery) {
    return withCourseIdentityCorroboration(whooshDiscovery, evidence);
  }

  const foreupDiscovery = learnForeupDiscovery(evidence, observedUrls);

  if (foreupDiscovery) {
    return withCourseIdentityCorroboration(foreupDiscovery, evidence);
  }

  const teeItUpDiscovery = learnTeeItUpDiscovery(evidence, observedUrls);

  if (teeItUpDiscovery) {
    return withCourseIdentityCorroboration(teeItUpDiscovery, evidence);
  }

  const chelseaDiscovery = learnChelseaDiscovery(evidence, observedUrls);

  if (chelseaDiscovery) {
    return withCourseIdentityCorroboration(chelseaDiscovery, evidence);
  }

  const golfBackDiscovery = learnGolfBackDiscovery(evidence, observedUrls);

  if (golfBackDiscovery) {
    return withCourseIdentityCorroboration(golfBackDiscovery, evidence);
  }

  const webTracDiscovery = learnWebTracDiscovery(evidence, observedUrls);

  if (webTracDiscovery) {
    return withCourseIdentityCorroboration(webTracDiscovery, evidence);
  }

  const clubCaddieDiscovery = learnClubCaddieDiscovery(evidence, observedUrls);

  if (clubCaddieDiscovery) {
    return withCourseIdentityCorroboration(clubCaddieDiscovery, evidence);
  }

  const protectedCpsDiscovery = learnProtectedCpsDiscovery(evidence, observedUrls);

  if (protectedCpsDiscovery) {
    return withCourseIdentityCorroboration(protectedCpsDiscovery, evidence);
  }

  const cpsDiscovery = learnCpsDiscovery(evidence, observedUrls);

  if (cpsDiscovery) {
    return withCourseIdentityCorroboration(cpsDiscovery, evidence);
  }

  const teesnapDiscovery = learnTeesnapDiscovery(evidence, observedUrls);

  if (teesnapDiscovery) {
    return withCourseIdentityCorroboration(teesnapDiscovery, evidence);
  }

  const tenForeDiscovery = learnTenForeDiscovery(evidence, observedUrls);

  if (tenForeDiscovery) {
    return withCourseIdentityCorroboration(tenForeDiscovery, evidence);
  }

  const clubCaddieCandidates = getClubCaddieCandidates(evidence, observedUrls);
  const bookingUrl = clubCaddieCandidates.length > 0
    ? evidence.sourceUrl
    : pickBookingLikeUrl(observedUrls) ?? evidence.finalUrl ?? evidence.sourceUrl;

  return withCourseIdentityCorroboration({
    courseId: evidence.courseId,
    status: "INSPECTED",
    detectedPlatform: detectPlatform(observedUrls),
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    confidence: bookingUrl === evidence.sourceUrl ? 0.25 : 0.45,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      ...(hasBookingCallToActionEvidence(evidence) ||
      hasPositiveOnlineBookingText(evidence.visibleText ?? "")
        ? { bookingCallToAction: true }
        : {}),
      learnedFrom: "browser-visible-links"
    }
  }, evidence);
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
    url.search ||
    url.hash ||
    !/^apimanager-cc\d{1,4}\.clubcaddie\.com$/i.test(url.hostname) ||
    !/^\/webapi\/view\/[a-z0-9_-]{4,128}(?:\/slots)?\/?$/i.test(url.pathname)
  ) {
    return null;
  }

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
  url.search = "";
  url.hash = "";
  return url.toString();
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
  const bookingUrl = observedUrls.find(isGolfBackBookingUrl);
  const courseId = bookingUrl ? getGolfBackCourseId(bookingUrl) : null;
  if (!bookingUrl || !courseId) {
    return null;
  }

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
      includeWidget: false
    }).length > 0
  ) ?? [];
  const barrierCandidate = selectCpsBookingCandidate(
    getCpsBookingCandidates(evidence, cpsAccessBarriers.map((barrier) => barrier.url), {
      includeEvidenceLinks: false,
      includeWidget: false
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
    getKnownProviderFamilyForHostname(officialWebsite.hostname) ||
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
  const whooshBookingUrl = observedUrls
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
        /(^|\.)app\.whoosh\.io$/i.test(url.hostname) &&
        /^\/patron\/club\/[^/]+/i.test(url.pathname)
      )
    );
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
  const whooshBookingUrl = observedUrls
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
        /(^|\.)app\.whoosh\.io$/i.test(url.hostname) &&
        /^\/patron\/club\/[^/]+/i.test(url.pathname)
      )
    );

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

function learnWalkInClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const noTeeTimeEvidence = findExplicitNoTeeTimeEvidence(
    evidence.courseName,
    visibleText
  );
  const noReservationMatch =
    /(?:\btee times?\s+(?:are\s+)?not\s+(?:nec{1,2}essary|required)\b|\b(?:do|does)\s+not\s+(?:take|accept)\s+tee times?\b)/i.exec(
      visibleText
    );

  if (!noReservationMatch && !noTeeTimeEvidence) {
    return null;
  }

  if (noTeeTimeEvidence) {
    const officialSourceEvidence = getOfficialSourceScopedEvidence(
      evidence,
      noTeeTimeEvidence
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

    return buildWalkInDiscovery(evidence, manualEvidence, {
      policyNotes:
        "The course's official site says it does not use tee times. Tee Time Spot must direct golfers to the official course information instead of attempting automated retrieval.",
      learnedFrom: "official-no-tee-times-access"
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
  const sourceUrl = evidence.officialPage?.url ?? evidence.sourceUrl;
  const linkCandidates =
    evidence.officialPage?.linkCandidates ?? evidence.linkCandidates ?? [];
  const observedUrls = uniqueUrls([
    sourceUrl,
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
      /\b((?:[A-Z][\p{L}\p{N}'â€™&-]*\s+){0,6}(?:Golf\s+(?:Course|Club|Center|Centre|Links)|Country\s+Club))\b/gu
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
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/\b(?:at|for)\b/i.test(normalized)) {
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
    "in", "included", "includes", "is", "junior", "juniors", "may", "military",
    "monday", "must", "night", "no", "not", "offered", "on", "one", "online",
    "only", "open", "our", "outings", "per", "phone", "please", "pm", "pricing",
    "private", "pro", "public", "rate", "rates", "regular", "reservation",
    "reservations", "reserve", "reserved", "reserving", "resident", "riding",
    "saturday", "schedule", "scheduled", "senior", "seniors", "shop", "sunday",
    "taken", "tax", "tee", "the", "thursday", "time", "times", "to", "tuesday",
    "twilight", "up", "walking", "wednesday", "week", "weekday", "weekdays",
    "weekend", "weekends", "weeks", "your"
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
  return normalizeTeeTimeTypography(value).split(/[.!?\n]+/).some((statement) => {
    const normalized = statement.replace(/\s+/g, " ").trim();
    const hasExplicitTeeTimeBookingText =
      /\btee\s*times?\b/i.test(normalized) &&
      /\b(?:book|booking|reserve|reservation|schedule|online|availability)\b/i.test(
        normalized
      );
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
      /\bonline\b/i.test(normalized) ||
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
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const scopedAccess = findTargetScopedPrivateClubAccess(
    evidence.courseName,
    visibleText
  );
  if (!scopedAccess) {
    return null;
  }
  const { residentMemberClub, scopedText } = scopedAccess;
  const manualEvidence = getSafeManualEvidence(evidence, observedUrls);
  if (!manualEvidence) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: manualEvidence.evidenceUrl,
    bookingUrl: manualEvidence.evidenceUrl,
    bookingMethod: "CONTACT_COURSE",
    automationEligibility: "BLOCKED",
    automationReason: "OTHER",
    policyNotes: residentMemberClub
      ? "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course."
      : "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
    intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: manualEvidence.evidenceUrl,
      observedUrls: manualEvidence.observedUrls,
      visibleText: summarizeVisibleText(scopedText),
      learnedFrom: residentMemberClub
        ? "official-resident-member-access"
        : "official-private-club-access"
    }
  };
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
    .find((url) => Boolean(url && /(^|\.)chelseareservations\.com$/i.test(url.hostname)));
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
  options: { includeEvidenceLinks?: boolean; includeWidget?: boolean } = {}
): CpsBookingCandidate[] {
  const includeEvidenceLinks = options.includeEvidenceLinks ?? true;
  const includeWidget = options.includeWidget ?? true;
  const rawCandidates: Array<{
    value: string;
    label: string;
    courseIds?: number[];
    courseIdsAmbiguous?: boolean;
  }> = [
    ...(includeEvidenceLinks ? (evidence.linkCandidates ?? []).map((candidate) => ({
      value: candidate.url,
      label: candidate.label
    })) : []),
    ...observedUrls.map((value) => ({ value, label: "" })),
    ...(includeWidget ? getCpsWidgetCandidates(evidence.visibleText, evidence.courseName) : [])
  ];
  const candidates = new Map<string, CpsBookingCandidate>();

  for (const raw of rawCandidates) {
    const url = parseUrl(raw.value);
    if (!isCpsBookingCandidateUrl(url)) {
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

function isCpsBookingCandidateUrl(url: URL | null) {
  return Boolean(
    url?.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-z0-9](?:[a-z0-9-]{0,62})\.cps\.golf$/i.test(url.hostname) &&
      url.hostname.toLowerCase() !== "sc.cps.golf" &&
      (url.pathname === "/" ||
        /\/(?:onlineresweb|onlineres\/onlineapi)(?:\/|$)/i.test(url.pathname))
  );
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

  const response = await fetchImpl(profileUrl, {
    headers: { Accept: "text/html" },
    redirect: "follow"
  });
  if (!response.ok) {
    return {
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: "chronogolf-public-profile-unavailable"
      }
    };
  }

  const html = await response.text();
  const club = parseChronogolfClubProfile(html);
  if (!club) {
    return discovery;
  }

  const canonicalUrl = response.url || profileUrl;
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
  const response = await fetchImpl(bookingBaseUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
    },
    redirect: "follow"
  });
  if (!response.ok) {
    return {
      ...discovery,
      evidence: {
        ...discovery.evidence,
        learnedFrom: "teesnap-public-config-unavailable"
      }
    };
  }

  const html = await response.text();
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

  const canonicalUrl = response.url || bookingBaseUrl;
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

function getChronogolfProfileUrl(discovery: BrowserDiscovery) {
  const profileUrl = discovery.evidence.observedUrls
    .map(parseUrl)
    .find((url) =>
      Boolean(
        url &&
        /(^|\.)chronogolf\.com$/i.test(url.hostname) &&
        /^\/club\/[^/]+/i.test(url.pathname)
      )
    );
  if (profileUrl) {
    return `https://www.chronogolf.com${profileUrl.pathname.match(/^\/club\/[^/]+/i)?.[0]}`;
  }

  const textMatch = discovery.evidence.visibleText?.match(
    /(?:clubId|club_id)["'\s:=]+(\d+)/i
  )?.[1];
  const clubId = Number(textMatch);
  return Number.isInteger(clubId) && clubId > 0
    ? `https://www.chronogolf.com/club/${clubId}`
    : null;
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
    if (!Number.isInteger(courseId) || courseId < 0) {
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
  const courseIdFromUrl = getNumericSearchParam(url, "CourseId") ?? getNumericSearchParam(url, "courseId");
  if (courseIdFromUrl !== undefined) {
    return [courseIdFromUrl];
  }

  const courseIdsFromUrl = url.searchParams
    .get("courseIds")
    ?.split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0);
  if (courseIdsFromUrl?.length) {
    return courseIdsFromUrl;
  }

  return undefined;
}

function learnTeesnapDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const bookingUrl = observedUrls.find(isTeesnapBookingUrl);
  if (!bookingUrl) {
    return null;
  }

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
      bookingUrl,
      apiEndpoint: new URL("/customer-api/teetimes-day", bookingUrl).toString(),
      confidence: 0.55,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(evidence.visibleText),
        learnedFrom: `teesnap-url-without-course-id:${metadataResolution.reason}`
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
  const aliases = [
    ...new Set(
      observedUrls
        .map(getTeeItUpAlias)
        .filter((alias): alias is string => Boolean(alias))
    )
  ];

  if (aliases.length === 0) {
    return null;
  }

  const observedBookingUrl = observedUrls.find(isTeeItUpBookingUrl);
  const bookingUrl = observedBookingUrl
    ? `${new URL(observedBookingUrl).origin}/`
    : `https://${aliases[0]}.book.teeitup.golf/`;

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "TEEITUP",
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    apiEndpoint: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
    apiMetadata: {
      aliases,
      bookingBaseUrl: bookingUrl
    },
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "teeitup-booking-url"
    }
  };
}

export function getBestProbeUrl(
  course: Pick<
    BrowserProbeCourseInput,
    "website" | "detectedBookingUrl" | "monitoringFailureEvidence"
  >
) {
  const website = getSafeBrowserProbeUrl(course.website);
  const bookingUrl = getSafeBrowserProbeUrl(course.detectedBookingUrl);
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
    isSameHostGenericPermitDestination(website, bookingUrl)
  ) {
    return website;
  }
  return bookingUrl ?? website;
}

type CpsDiscoveryConfiguration = {
  courseId?: unknown;
  siteName?: unknown;
  websiteId?: unknown;
  onlineApi?: unknown;
  authorityBaseUrl?: unknown;
};

const CPS_CONFIGURATION_MAX_BYTES = 64 * 1024;

export async function enrichCpsDiscovery(
  discovery: BrowserDiscovery,
  courseName: string,
  fetchImpl: typeof fetch = fetch
): Promise<BrowserDiscovery> {
  const bookingBase = parseUrl(discovery.bookingUrl);
  if (
    discovery.status !== "INSPECTED" ||
    discovery.detectedPlatform !== "CUSTOM" ||
    discovery.evidence.learnedFrom !== "cps-course-id-missing" ||
    discovery.bookingMethod !== "PUBLIC_ONLINE" ||
    discovery.apiMetadata !== undefined ||
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
    headers: { Accept: "application/json" },
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
    courseName
  );
  if (!configuration) {
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
      courseIds: [configuration.courseId],
      holes: [18, 9],
      ...(configuration.courseId === 0
        ? { resolvePlaceholderCourseIds: true }
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
  courseName: string
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
  const tenantName = bookingBase.hostname.split(".")[0] ?? "";
  const tenantIdentity = normalizeCpsTenantIdentity(tenantName);
  const siteIdentity = normalizeCpsTenantIdentity(siteName);
  const courseIdentity = normalizeCpsTenantIdentity(courseName);

  if (
    !Number.isSafeInteger(courseId) ||
    (courseId as number) < 0 ||
    !/^[a-z0-9_-]{1,80}$/i.test(siteName) ||
    websiteId.length < 1 ||
    websiteId.length > 200 ||
    !tenantIdentity ||
    tenantIdentity !== siteIdentity ||
    !courseIdentity ||
    tenantIdentity !== courseIdentity ||
    !onlineApi ||
    !authorityBaseUrl
  ) {
    return null;
  }

  return {
    courseId: courseId as number,
    siteName
  };
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
  return parsed && isSafeManualEvidenceUrl(parsed) ? parsed.toString() : null;
}

function isNonProviderWebsite(value: string) {
  const url = parseUrl(value);
  return Boolean(url && !getKnownProviderFamilyForHostname(url.hostname));
}

function learnForeupDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const foreupApiUrl = observedUrls
    .map(parseUrl)
    .find((url) => url?.hostname.includes("foreupsoftware.com") && url.pathname.includes("/api/booking/times"));
  const foreupBookingUrl = observedUrls.find((url) => isForeupBookingUrl(url));

  if (!foreupApiUrl && !foreupBookingUrl) {
    return null;
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
    getNumericSearchParam(foreupApiUrl, "schedule_id") ??
    getForeupScheduleId(foreupBookingUrl);
  const bookingClassId = getNumericSearchParam(foreupApiUrl, "booking_class");
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
        bookingUrl: foreupBookingUrl,
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
      bookingUrl: foreupBookingUrl ?? accessBarrier.url,
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

  if (!scheduleId) {
    return {
      courseId: evidence.courseId,
      status: "INSPECTED",
      detectedPlatform: "FOREUP",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: foreupBookingUrl,
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

  const bookingBaseUrl =
    foreupBookingUrl ?? `https://foreupsoftware.com/index.php/booking/${scheduleId}#/teetimes`;
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

function pickBookingLikeUrl(urls: string[]) {
  return urls.find((url) => {
    const parsed = parseUrl(url);
    if (
      !parsed ||
      isNonBookingHost(parsed.hostname) ||
      isStaticAssetPath(parsed.pathname) ||
      isEditorialContentPath(parsed.pathname) ||
      isClearlyUnrelatedBookingUrl(parsed)
    ) {
      return false;
    }

    if (parsed.hostname.endsWith("chelseareservations.com")) {
      return true;
    }

    const searchable = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
    return /(^|[^a-z])(book|booking|tee.?times?|reservations?|reserve|foreup|golfnow|teeitup|chronogolf|clubcaddie)([^a-z]|$)/i.test(
      searchable
    );
  });
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
    url?.hostname.includes("foreupsoftware.com") && url.pathname.includes("/index.php/booking/")
  );
}

function getNumericSearchParam(url: URL | null | undefined, key: string) {
  const value = url?.searchParams.get(key);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  return Number(value);
}

function getForeupScheduleId(value?: string) {
  const match = value?.match(/\/booking\/\d+\/(\d+)(?:[/?#]|$)/);
  return match ? Number(match[1]) : undefined;
}

function isForeupApiUrl(value?: string) {
  const url = parseUrl(value);
  return Boolean(
    url?.hostname.includes("foreupsoftware.com") &&
      url.pathname.includes("/api/booking/times")
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
  return Boolean(url?.hostname.match(/^.+\.book\.teeitup\.(?:golf|com)$/i));
}

function isTeesnapBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(url?.hostname.endsWith(".teesnap.net"));
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
      .map((url) => getNumericSearchParam(url, "course"))
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
    /^\/[a-z0-9-]+\/?$/i.test(url.pathname)
  );
}

function isGolfBackBookingUrl(value: string) {
  const url = parseUrl(value);
  return Boolean(url && isGolfBackHostname(url.hostname) && getGolfBackCourseId(value));
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
