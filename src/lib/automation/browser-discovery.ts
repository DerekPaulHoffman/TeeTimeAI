import type {
  AutomationReason,
  BookingMethod
} from "@/lib/courses/intelligence";

export type BrowserDiscoveryEvidence = {
  courseId: string;
  courseName: string;
  sourceUrl: string;
  finalUrl?: string;
  observedUrls: string[];
  visibleText?: string;
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
  automationEligibility: string;
  website?: string | null;
  detectedBookingUrl?: string | null;
  bookingMetadata?: unknown;
};

export function buildBrowserDiscovery(evidence: BrowserDiscoveryEvidence): BrowserDiscovery {
  const observedUrls = uniqueUrls([
    evidence.finalUrl,
    evidence.sourceUrl,
    ...evidence.observedUrls
  ]);
  const foreupDiscovery = learnForeupDiscovery(evidence, observedUrls);

  if (foreupDiscovery) {
    return foreupDiscovery;
  }

  const teeItUpDiscovery = learnTeeItUpDiscovery(evidence, observedUrls);

  if (teeItUpDiscovery) {
    return teeItUpDiscovery;
  }

  const cpsDiscovery = learnCpsDiscovery(evidence, observedUrls);

  if (cpsDiscovery) {
    return cpsDiscovery;
  }

  const teesnapDiscovery = learnTeesnapDiscovery(evidence, observedUrls);

  if (teesnapDiscovery) {
    return teesnapDiscovery;
  }

  const bookingUrl = pickBookingLikeUrl(observedUrls) ?? evidence.finalUrl ?? evidence.sourceUrl;

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

export function shouldQueueBrowserProbe(course: BrowserProbeCourseInput) {
  if (course.automationEligibility === "BLOCKED") {
    return false;
  }

  if (course.detectedPlatform === "FOREUP" && isReusableForeupMetadata(course.bookingMetadata)) {
    return false;
  }

  if (course.detectedPlatform === "TEEITUP" && isReusableTeeItUpMetadata(course.bookingMetadata)) {
    return false;
  }

  if (course.detectedPlatform === "CUSTOM" && isReusableCpsMetadata(course.bookingMetadata)) {
    return false;
  }

  if (course.detectedPlatform === "CHRONOGOLF" && isReusableChronogolfMetadata(course.bookingMetadata)) {
    return false;
  }

  return Boolean(getBestProbeUrl(course));
}

function learnCpsDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const cpsUrl =
    observedUrls.map(parseUrl).find(isCpsReservationUrl) ??
    getCpsWidgetUrl(evidence.visibleText);

  if (!cpsUrl) {
    return null;
  }

  const siteName = cpsUrl.hostname.split(".")[0];
  const bookingBaseUrl = `${cpsUrl.origin}/`;
  const courseIds = getCpsCourseIds(cpsUrl, evidence.visibleText) ?? [1, 2];

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl: bookingBaseUrl,
    apiEndpoint: `${cpsUrl.origin}/onlineres/onlineapi/api/v1/onlinereservation/TeeTimes`,
    apiMetadata: {
      provider: "CPS",
      siteName,
      bookingBaseUrl,
      courseIds,
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

function isCpsReservationUrl(url: URL | null) {
  return Boolean(
    url?.hostname.endsWith(".cps.golf") &&
      /\/(?:onlineresweb|onlineres\/onlineapi)(?:\/|$)/i.test(url.pathname)
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

function getCpsWidgetUrl(text?: string) {
  const match = text?.match(/"baseURL"\s*:\s*"([^"]+\.cps\.golf\/[^"]+)"/i);
  return parseUrl(match?.[1]);
}

function getCpsCourseIds(url: URL, text?: string) {
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

  const courseIds = [...(text?.matchAll(/"courseId"\s*:\s*"?(\d+)"?/gi) ?? [])].map((match) =>
    Number(match[1])
  );
  return courseIds.length ? [...new Set(courseIds)] : undefined;
}

function learnTeesnapDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const bookingUrl = observedUrls.find(isTeesnapBookingUrl);
  if (!bookingUrl) {
    return null;
  }

  const courseId = getTeesnapCourseId(observedUrls, evidence.visibleText);
  if (!courseId) {
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
        learnedFrom: "teesnap-url-without-course-id"
      }
    };
  }

  return {
    courseId: evidence.courseId,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    sourceUrl: evidence.sourceUrl,
    bookingUrl,
    apiEndpoint: new URL("/customer-api/teetimes-day", bookingUrl).toString(),
    apiMetadata: {
      provider: "TEESNAP",
      courseId,
      bookingBaseUrl: bookingUrl,
      defaultHoles: 18,
      defaultAddons: "off"
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

  const bookingUrl =
    observedUrls.find(isTeeItUpBookingUrl) ?? `https://${aliases[0]}.book.teeitup.golf/`;

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
  if (urls.some((url) => url.includes("foreupsoftware.com"))) {
    return "FOREUP";
  }
  if (urls.some((url) => url.includes("golfnow.com"))) {
    return "GOLFNOW";
  }
  if (urls.some((url) => url.includes("teeitup.com"))) {
    return "TEEITUP";
  }
  if (urls.some((url) => url.includes("chronogolf.com"))) {
    return "CHRONOGOLF";
  }
  if (urls.some((url) => url.includes("clubcaddie.com"))) {
    return "CLUB_CADDIE";
  }
  if (urls.some((url) => parseUrl(url)?.hostname.endsWith(".cps.golf"))) {
    return "CUSTOM";
  }
  if (urls.some(isTeesnapBookingUrl)) {
    return "CUSTOM";
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

function getTeesnapCourseId(urls: string[], text?: string) {
  for (const url of urls.map(parseUrl)) {
    const courseId = getNumericSearchParam(url, "course");
    if (courseId) {
      return courseId;
    }
  }

  const match = text?.match(/"id"\s*:\s*(\d+)[\s\S]{0,500}?"core_id"\s*:\s*\d+/);
  return match ? Number(match[1]) : undefined;
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

function isReusableForeupMetadata(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as { scheduleId?: unknown; bookingBaseUrl?: unknown };
  return typeof metadata.scheduleId === "number" && typeof metadata.bookingBaseUrl === "string";
}

function isReusableTeeItUpMetadata(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as { aliases?: unknown; bookingBaseUrl?: unknown };
  return (
    Array.isArray(metadata.aliases) &&
    metadata.aliases.length > 0 &&
    metadata.aliases.every((alias) => typeof alias === "string") &&
    typeof metadata.bookingBaseUrl === "string"
  );
}

function isReusableCpsMetadata(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as {
    provider?: unknown;
    siteName?: unknown;
    bookingBaseUrl?: unknown;
    courseIds?: unknown;
    holes?: unknown;
    courseId?: unknown;
  };
  return (
    (metadata.provider === "CPS" &&
      typeof metadata.siteName === "string" &&
      typeof metadata.bookingBaseUrl === "string" &&
      Array.isArray(metadata.courseIds) &&
      metadata.courseIds.length > 0 &&
      metadata.courseIds.every((courseId) => typeof courseId === "number") &&
      (metadata.holes === undefined ||
        (Array.isArray(metadata.holes) &&
          metadata.holes.length > 0 &&
          metadata.holes.every((holes) => holes === 9 || holes === 18)))) ||
    (metadata.provider === "TEESNAP" &&
      typeof metadata.courseId === "number" &&
      typeof metadata.bookingBaseUrl === "string")
  );
}

function isEditorialContentPath(pathname: string) {
  return /\/(?:events?|news|blog|calendar|posts?)\//i.test(pathname);
}

function isReusableChronogolfMetadata(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metadata = value as { clubId?: unknown; courseIds?: unknown; bookingBaseUrl?: unknown };
  return (
    typeof metadata.clubId === "number" &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every((courseId) => typeof courseId === "string") &&
    typeof metadata.bookingBaseUrl === "string"
  );
}
