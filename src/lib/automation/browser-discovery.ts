import type {
  AutomationReason,
  BookingMethod
} from "@/lib/courses/intelligence";
import { isClubCaddieMetadata } from "@/lib/adapters/clubcaddie";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
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
  visibleText?: string;
  bookingSurfaceText?: string;
  providerPolicyText?: string;
  providerPolicyUrl?: string;
  accessBarrierUrls?: string[];
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
    learnedFrom: string;
  };
};

export type BrowserProbeCourseInput = {
  detectedPlatform: string;
  providerFamilyKey?: string | null;
  automationEligibility: string;
  website?: string | null;
  detectedBookingUrl?: string | null;
  bookingMetadata?: unknown;
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
    return privateClubClassification;
  }

  const walkInClassification = learnWalkInClassification(evidence, observedUrls);

  if (walkInClassification) {
    return walkInClassification;
  }

  const contactOnlyClassification = learnOfficialContactOnlyClassification(
    evidence,
    observedUrls
  );

  if (contactOnlyClassification) {
    return contactOnlyClassification;
  }

  const accountRequiredClassification = learnAccountRequiredClassification(
    evidence,
    observedUrls
  );

  if (accountRequiredClassification) {
    return accountRequiredClassification;
  }

  const whooshDiscovery = learnWhooshBookingClassification(evidence, observedUrls);

  if (whooshDiscovery) {
    return whooshDiscovery;
  }

  const foreupDiscovery = learnForeupDiscovery(evidence, observedUrls);

  if (foreupDiscovery) {
    return foreupDiscovery;
  }

  const teeItUpDiscovery = learnTeeItUpDiscovery(evidence, observedUrls);

  if (teeItUpDiscovery) {
    return teeItUpDiscovery;
  }

  const chelseaDiscovery = learnChelseaDiscovery(evidence, observedUrls);

  if (chelseaDiscovery) {
    return chelseaDiscovery;
  }

  const golfBackDiscovery = learnGolfBackDiscovery(evidence, observedUrls);

  if (golfBackDiscovery) {
    return golfBackDiscovery;
  }

  const webTracDiscovery = learnWebTracDiscovery(evidence, observedUrls);

  if (webTracDiscovery) {
    return webTracDiscovery;
  }

  const clubCaddieDiscovery = learnClubCaddieDiscovery(evidence, observedUrls);

  if (clubCaddieDiscovery) {
    return clubCaddieDiscovery;
  }

  const protectedCpsDiscovery = learnProtectedCpsDiscovery(evidence, observedUrls);

  if (protectedCpsDiscovery) {
    return protectedCpsDiscovery;
  }

  const cpsDiscovery = learnCpsDiscovery(evidence, observedUrls);

  if (cpsDiscovery) {
    return cpsDiscovery;
  }

  const teesnapDiscovery = learnTeesnapDiscovery(evidence, observedUrls);

  if (teesnapDiscovery) {
    return teesnapDiscovery;
  }

  const tenForeDiscovery = learnTenForeDiscovery(evidence, observedUrls);

  if (tenForeDiscovery) {
    return tenForeDiscovery;
  }

  const clubCaddieCandidates = getClubCaddieCandidates(evidence, observedUrls);
  const bookingUrl = clubCaddieCandidates.length > 0
    ? evidence.sourceUrl
    : pickBookingLikeUrl(observedUrls) ?? evidence.finalUrl ?? evidence.sourceUrl;

  return {
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
      learnedFrom: "browser-visible-links"
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
  const barrierCandidate = selectCpsBookingCandidate(
    getCpsBookingCandidates(evidence, evidence.accessBarrierUrls ?? [], {
      includeEvidenceLinks: false,
      includeWidget: false
    }),
    evidence.courseName
  );
  if (!barrierCandidate) {
    return null;
  }

  const bookingBaseUrl = barrierCandidate.bookingBaseUrl;
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
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "cps-managed-challenge-booking"
    }
  };
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
    status: "VERIFIED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: canonicalizeTenForeBookingUrl(bookingUrl),
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "BLOCKED",
    automationReason: "CAPTCHA_OR_QUEUE",
    policyNotes:
      "The official TenFore page shows public online tee times, but its availability request requires a reCAPTCHA token. Tee Time Spot does not solve or bypass captcha-protected retrieval, so golfers should check and book on the official page directly.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "tenfore-captcha-protected-booking"
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

  if (providerTermsProhibitAutomation) {
    return {
      courseId: evidence.courseId,
      status: "VERIFIED",
      detectedPlatform: "CUSTOM",
      sourceUrl: evidence.sourceUrl,
      bookingUrl: whooshBookingUrl.toString(),
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED",
      policyNotes:
        "Whoosh's current End User Terms prohibit using automated agents, robots, crawlers, data-mining tools, or similar mechanisms to search or download platform content. Golfers can still view and book on the official Whoosh page directly, but Tee Time Spot does not retrieve Whoosh availability automatically.",
      intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      confidence: 0.99,
      evidence: {
        finalUrl: evidence.finalUrl,
        observedUrls,
        visibleText: summarizeVisibleText(providerPolicyText),
        learnedFrom: "whoosh-automation-prohibited-booking"
      }
    };
  }

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
      "The course links to an official Whoosh online booking page. Golfers can use that page directly; Tee Time Spot has not yet confirmed policy-safe automatic monitoring for this Whoosh surface.",
    intelligenceReviewAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "official-whoosh-booking"
    }
  };
}

function learnWalkInClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const noReservationMatch = /\btee times?\s+(?:are\s+)?not\s+(?:nec{1,2}essary|required)\b/i.exec(
    visibleText
  );

  if (!noReservationMatch) {
    return null;
  }

  const statementStart = Math.max(0, visibleText.lastIndexOf(".", noReservationMatch.index) + 1);
  const nextPeriod = visibleText.indexOf(
    ".",
    noReservationMatch.index + noReservationMatch[0].length
  );
  const statementEnd = nextPeriod === -1
    ? Math.min(visibleText.length, noReservationMatch.index + 320)
    : Math.min(visibleText.length, nextPeriod + 1);
  const statement = visibleText.slice(statementStart, statementEnd);
  const explicitlyFirstCome = /\bfirst[- ]come\s*,?\s*first[- ]serve(?:d)?(?:\s+basis)?\b/i.test(
    statement
  );
  const scopedToNonCourseFacility =
    /\b(?:driving|practice)\s+(?:range|facility|stalls?)\b/i.test(statement);
  const contradictsWalkInOnly =
    /\b(?:book|reserve)\s+(?:a\s+)?tee times?\s+(?:online|now)\b/i.test(statement);

  if (!explicitlyFirstCome || scopedToNonCourseFacility || contradictsWalkInOnly) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: evidence.finalUrl ?? evidence.sourceUrl,
    bookingMethod: "WALK_IN",
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    policyNotes:
      "The course's official site says tee times are not required and play is first-come, first-served. Tee Time Spot must direct golfers to the official course information instead of attempting automated retrieval.",
    intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "official-walk-in-access"
    }
  };
}

function learnOfficialContactOnlyClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const identifiesPhysicalCourse =
    /\b(?:nine|eighteen|9|18)[- ]hole\b[^.]{0,100}\bgolf course\b/i.test(
      visibleText
    ) || /\bpar\s*3\s+golf course\b/i.test(visibleText);
  const postsPublicPrice =
    /\bprices?\b/i.test(visibleText) &&
    /\b(?:adult|senior|junior|weekdays?|weekends?|holidays?)\b[^$]{0,80}\$\s*\d/i.test(
      visibleText
    );
  const directsContactForCurrentDetails =
    /\bhours? of operation may vary by season\b[^.]{0,180}\bplease contact us for details\b/i.test(
      visibleText
    ) ||
    /\bplease contact us for (?:current )?(?:hours?|details|availability)\b/i.test(
      visibleText
    );
  const phoneMatch = visibleText.match(
    /(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.-]*\d{3}[\s.-]*\d{4}\b/
  );
  const advertisesOnlineBooking =
    Boolean(pickBookingLikeUrl(observedUrls)) ||
    (evidence.linkCandidates ?? []).some(({ url, label }) =>
      /\b(?:book|booking|tee\s*times?|reservations?|reserve)\b/i.test(
        `${label} ${url}`
      )
    ) ||
    /\b(?:book|reserve)\s+(?:a\s+)?tee\s*time\s+online\b/i.test(visibleText);

  if (
    !identifiesPhysicalCourse ||
    !postsPublicPrice ||
    !directsContactForCurrentDetails ||
    !phoneMatch ||
    advertisesOnlineBooking
  ) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: evidence.finalUrl ?? evidence.sourceUrl,
    bookingMethod: "CONTACT_COURSE",
    bookingPhone: phoneMatch[0].replace(/\s+/g, " ").trim(),
    automationEligibility: "BLOCKED",
    automationReason: "NO_ONLINE_BOOKING",
    policyNotes:
      "The official course page publishes public play pricing and directs golfers to contact the facility for current hours or availability, without presenting an online tee-time reservation surface. Tee Time Spot must direct golfers to the course instead of attempting automated retrieval.",
    intelligenceReviewAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    confidence: 0.9,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: "official-contact-only-course-access"
    }
  };
}

export function shouldQueueBrowserProbe(course: BrowserProbeCourseInput) {
  if (course.automationEligibility === "BLOCKED") {
    return false;
  }

  if (resolveProviderCapability(course).isRunnable) {
    return false;
  }

  return Boolean(getBestProbeUrl(course));
}

function learnPrivateClubClassification(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const visibleText = evidence.visibleText?.replace(/\s+/g, " ").trim() ?? "";
  const explicitlyPrivateGolfAccess =
    /\bprivate (?:golf )?club\b/i.test(visibleText) ||
    /\bprivate(?:[\s,-]+(?:award-winning|challenging|championship|\d{1,2}[- ]hole))*[\s,-]+golf course\b/i.test(
      visibleText
    );
  const privateMemberGuestClub =
    /\bis a private club available to\b/i.test(visibleText) ||
    (explicitlyPrivateGolfAccess &&
      /\bmembers? and (?:their )?guests?\b/i.test(visibleText));
  const residentMemberClub =
    /\bneighborhood (?:social )?club for residents?\b/i.test(visibleText) &&
    /\boffers? (?:its )?members? the use of\b[^.]{0,220}\bgolf course\b/i.test(visibleText);

  if (!privateMemberGuestClub && !residentMemberClub) {
    return null;
  }

  return {
    courseId: evidence.courseId,
    status: "VERIFIED",
    detectedPlatform: "UNKNOWN",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: evidence.finalUrl ?? evidence.sourceUrl,
    bookingMethod: "CONTACT_COURSE",
    automationEligibility: "BLOCKED",
    automationReason: "OTHER",
    policyNotes: residentMemberClub
      ? "The official site identifies this as a neighborhood social club for residents and says the golf course is a member amenity. Tee Time Spot must not present automated public tee-time monitoring for this course."
      : "The course's official site identifies it as a private club and limits access to members and their guests. Tee Time Spot must not present automated public tee-time monitoring for this course.",
    intelligenceReviewAt: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
    confidence: 0.98,
    evidence: {
      finalUrl: evidence.finalUrl,
      observedUrls,
      visibleText: summarizeVisibleText(evidence.visibleText),
      learnedFrom: residentMemberClub
        ? "official-resident-member-access"
        : "official-private-club-access"
    }
  };
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
        learnedFrom: "cps-course-id-missing"
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
};

function getCpsBookingCandidates(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[],
  options: { includeEvidenceLinks?: boolean; includeWidget?: boolean } = {}
): CpsBookingCandidate[] {
  const includeEvidenceLinks = options.includeEvidenceLinks ?? true;
  const includeWidget = options.includeWidget ?? true;
  const rawCandidates: Array<{ value: string; label: string; courseIds?: number[] }> = [
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
      courseIds
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

  return {
    ...primary,
    label: candidates.find((candidate) => candidate.label)?.label ?? primary.label,
    courseIds: safeCourseIds.length > 0 ? safeCourseIds : undefined
  };
}

function normalizeCpsTenantIdentity(value: string) {
  return normalizeCourseIdentityName(
    value.replace(/\b(?:and|at|of)\b/gi, " ")
  ).replace(/\s+/g, "");
}

function isCpsBookingCandidateUrl(url: URL | null) {
  return Boolean(
    url?.hostname.endsWith(".cps.golf") &&
      url.hostname !== "sc.cps.golf" &&
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

  return urls.map((value) => ({
    value,
    label: selectedLocation?.name ?? courseName,
    ...(selectedLocation ? { courseIds: [selectedLocation.courseId] } : {})
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

export function getBestProbeUrl(course: Pick<BrowserProbeCourseInput, "website" | "detectedBookingUrl">) {
  return course.detectedBookingUrl?.trim() || course.website?.trim() || null;
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

  const scheduleId = getNumericSearchParam(foreupApiUrl, "schedule_id") ?? getForeupScheduleId(foreupBookingUrl);
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
  const bookingClassId = getNumericSearchParam(foreupApiUrl, "booking_class");

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
      isEditorialContentPath(parsed.pathname)
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
  const match = value?.match(/\/booking\/(?:\d+\/)?(\d+)/);
  return match ? Number(match[1]) : undefined;
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
