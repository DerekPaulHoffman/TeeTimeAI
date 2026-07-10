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
  status: "LEARNED" | "INSPECTED" | "BLOCKED" | "FAILED";
  detectedPlatform: "UNKNOWN" | "FOREUP" | "GOLFNOW" | "TEEITUP" | "CHRONOGOLF" | "CLUB_CADDIE" | "CUSTOM";
  sourceUrl: string;
  bookingUrl?: string;
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

  return Boolean(getBestProbeUrl(course));
}

function learnCpsDiscovery(
  evidence: BrowserDiscoveryEvidence,
  observedUrls: string[]
): BrowserDiscovery | null {
  const cpsUrl = observedUrls.map(parseUrl).find((url) => url?.hostname.endsWith(".cps.golf"));

  if (!cpsUrl) {
    return null;
  }

  const siteName = cpsUrl.hostname.split(".")[0];
  const bookingBaseUrl = `${cpsUrl.origin}/`;

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
      courseIds: [1, 2],
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
  return "UNKNOWN";
}

function pickBookingLikeUrl(urls: string[]) {
  return urls.find((url) => {
    const parsed = parseUrl(url);
    if (!parsed || isNonBookingHost(parsed.hostname) || isStaticAssetPath(parsed.pathname)) {
      return false;
    }

    const searchable = `${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
    return /(^|[^a-z])(book|booking|tee.?times?|reservation|reserve|foreup|golfnow|teeitup|chronogolf|clubcaddie)([^a-z]|$)/i.test(
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
  };
  return (
    metadata.provider === "CPS" &&
    typeof metadata.siteName === "string" &&
    typeof metadata.bookingBaseUrl === "string" &&
    Array.isArray(metadata.courseIds) &&
    metadata.courseIds.length > 0 &&
    metadata.courseIds.every((courseId) => typeof courseId === "number") &&
    (metadata.holes === undefined ||
      (Array.isArray(metadata.holes) &&
        metadata.holes.length > 0 &&
        metadata.holes.every((holes) => holes === 9 || holes === 18)))
  );
}
