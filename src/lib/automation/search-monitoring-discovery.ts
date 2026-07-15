import {
  applyBrowserDiscoveryToCourse,
  listRecentCourseAutomationDiscoveries,
  recordBrowserDiscovery,
  type ActiveAutomationSearch
} from "@/lib/automation/db-service";
import {
  buildBrowserDiscovery,
  enrichChronogolfDiscovery,
  enrichTeesnapDiscovery,
  getBestProbeUrl,
  shouldQueueBrowserProbe,
  type BrowserDiscovery,
  type BrowserDiscoveryEvidence
} from "@/lib/automation/browser-discovery";

const DISCOVERY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DISCOVERY_RETRY_DELAY_MS = 30 * 60 * 1000;
const MAX_DISCOVERY_ATTEMPTS_PER_DAY = 2;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const MAX_BOOKING_LINK_FOLLOWUPS = 2;
const MAX_HTML_BYTES = 1_500_000;

type CollectedPageEvidence = Pick<
  BrowserDiscoveryEvidence,
  | "sourceUrl"
  | "finalUrl"
  | "observedUrls"
  | "visibleText"
  | "bookingSurfaceText"
  | "accessBarrierUrls"
>;

export type SearchMonitoringDiscoveryResult = {
  attemptedCourseIds: string[];
  appliedCourseIds: string[];
  failedCourseIds: string[];
  retryCourseIds: string[];
};

export async function prepareSearchMonitoring(
  search: ActiveAutomationSearch,
  fetchImpl: typeof fetch = fetch,
  now = new Date()
): Promise<SearchMonitoringDiscoveryResult> {
  const candidates = search.preferences
    .map((preference) => preference.course)
    .filter((course) => shouldQueueBrowserProbe(course))
    .map((course) => ({ course, sourceUrl: getBestProbeUrl(course) }))
    .filter(
      (candidate): candidate is typeof candidate & { sourceUrl: string } =>
        Boolean(candidate.sourceUrl)
    );

  if (candidates.length === 0) {
    return {
      attemptedCourseIds: [],
      appliedCourseIds: [],
      failedCourseIds: [],
      retryCourseIds: []
    };
  }

  const recentDiscoveries = await listRecentCourseAutomationDiscoveries(
    candidates.map((candidate) => candidate.course.id),
    new Date(now.getTime() - DISCOVERY_LOOKBACK_MS)
  );
  const discoveriesByCourse = new Map<string, Date[]>();
  for (const discovery of recentDiscoveries) {
    const attempts = discoveriesByCourse.get(discovery.courseId) ?? [];
    attempts.push(discovery.createdAt);
    discoveriesByCourse.set(discovery.courseId, attempts);
  }

  const dueCandidates = candidates.filter(({ course }) =>
    shouldAttemptMonitoringDiscovery(discoveriesByCourse.get(course.id) ?? [], now)
  );
  const evidenceBySource = new Map<string, Promise<CollectedPageEvidence>>();
  const pageFetches = new Map<string, Promise<Awaited<ReturnType<typeof fetchPublicHtml>>>>();
  const attemptedCourseIds: string[] = [];
  const appliedCourseIds: string[] = [];
  const failedCourseIds: string[] = [];

  for (const { course, sourceUrl } of dueCandidates) {
    attemptedCourseIds.push(course.id);
    try {
      const sourceKey = `${normalizeSourceKey(sourceUrl)}|${normalizeCourseLinkName(course.name)}`;
      let evidencePromise = evidenceBySource.get(sourceKey);
      if (!evidencePromise) {
        evidencePromise = collectOfficialSiteEvidence(
          sourceUrl,
          fetchImpl,
          course.name,
          pageFetches
        );
        evidenceBySource.set(sourceKey, evidencePromise);
      }
      const collected = await evidencePromise;
      const chronogolfDiscovery = await enrichChronogolfDiscovery(
        buildBrowserDiscovery({
          ...collected,
          courseId: course.id,
          courseName: course.name
        }),
        fetchImpl
      );
      const discovery = await enrichTeesnapDiscovery(
        chronogolfDiscovery,
        course.name,
        fetchImpl
      );
      await recordBrowserDiscovery(discovery);
      const applied = await applyBrowserDiscoveryToCourse(discovery);
      if (applied) {
        appliedCourseIds.push(course.id);
      }
    } catch (error) {
      failedCourseIds.push(course.id);
      await recordBrowserDiscovery(
        buildFailedDiscovery({
          courseId: course.id,
          sourceUrl,
          detectedPlatform: course.detectedPlatform,
          message: error instanceof Error ? error.message : "Official-site discovery failed"
        })
      );
    }
  }

  const attemptedCourseIdSet = new Set(attemptedCourseIds);
  const retryCourseIds = candidates
    .filter(({ course }) => {
      const persistedAttempts = discoveriesByCourse.get(course.id)?.length ?? 0;
      const completedThisRun = attemptedCourseIdSet.has(course.id) ? 1 : 0;
      return persistedAttempts + completedThisRun < MAX_DISCOVERY_ATTEMPTS_PER_DAY;
    })
    .map(({ course }) => course.id);

  return { attemptedCourseIds, appliedCourseIds, failedCourseIds, retryCourseIds };
}

export function shouldAttemptMonitoringDiscovery(attempts: Date[], now = new Date()) {
  if (attempts.length >= MAX_DISCOVERY_ATTEMPTS_PER_DAY) {
    return false;
  }

  const latestAttempt = attempts.reduce<Date | null>(
    (latest, attempt) => (!latest || attempt > latest ? attempt : latest),
    null
  );
  return !latestAttempt || now.getTime() - latestAttempt.getTime() >= DISCOVERY_RETRY_DELAY_MS;
}

export async function collectOfficialSiteEvidence(
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
  courseName?: string,
  pageFetches = new Map<string, Promise<Awaited<ReturnType<typeof fetchPublicHtml>>>>()
): Promise<CollectedPageEvidence> {
  const fetchPage = (url: string) => {
    const key = normalizeSourceKey(url);
    let page = pageFetches.get(key);
    if (!page) {
      page = fetchPublicHtml(url, fetchImpl);
      pageFetches.set(key, page);
    }
    return page;
  };
  const firstPage = await fetchPage(sourceUrl);
  const pages = [{
    ...firstPage,
    evidence: extractHtmlEvidence(firstPage.html, firstPage.finalUrl)
  }];
  const visited = new Set([normalizeSourceKey(firstPage.finalUrl)]);

  for (let followup = 0; followup < MAX_BOOKING_LINK_FOLLOWUPS; followup += 1) {
    const linkCandidates = pages.flatMap((page) => page.evidence.linkCandidates);
    const unvisitedCandidates = linkCandidates.filter(
      (candidate) => !visited.has(normalizeSourceKey(candidate.url))
    );
    const followupCandidate =
      pickOfficialPolicyCandidate(unvisitedCandidates, firstPage.finalUrl) ??
      pickOfficialCourseDetailCandidate(
        unvisitedCandidates,
        courseName,
        firstPage.finalUrl
      ) ??
      pickLikelyBookingCandidate(
        unvisitedCandidates,
        firstPage.finalUrl
      ) ??
      pickPrivateClubInformationCandidate(
        unvisitedCandidates,
        pages.map((page) => page.evidence.visibleText).join(" "),
        firstPage.finalUrl
      );
    if (!followupCandidate) {
      break;
    }
    visited.add(normalizeSourceKey(followupCandidate));

    try {
      const fetched = await fetchPage(followupCandidate);
      const page = {
        ...fetched,
        evidence: extractHtmlEvidence(fetched.html, fetched.finalUrl)
      };
      pages.push(page);
      visited.add(normalizeSourceKey(page.finalUrl));
    } catch {
      // A failed PDF or booking shell must not prevent inspection of another official policy page.
      continue;
    }
  }

  const finalPage = pages.at(-1)!;
  return {
    sourceUrl,
    finalUrl: finalPage.finalUrl,
    observedUrls: uniqueStrings(
      pages.flatMap((page) => [page.finalUrl, ...page.evidence.observedUrls])
    ),
    visibleText: pages.slice().reverse().map((page) => page.evidence.visibleText)
      .filter(Boolean)
      .join("\n")
      .slice(0, 12_000),
    bookingSurfaceText: pages
      .filter((page) => /(^|\.)app\.whoosh\.io$/i.test(new URL(page.finalUrl).hostname))
      .map((page) => page.evidence.visibleText)
      .filter(Boolean)
      .join("\n")
      .slice(0, 4_000),
    accessBarrierUrls: pages
      .filter((page) => page.accessBarrier === "MANAGED_CHALLENGE")
      .map((page) => page.finalUrl)
  };
}

async function fetchPublicHtml(sourceUrl: string, fetchImpl: typeof fetch) {
  const parsedSource = parseSafePublicUrl(sourceUrl);
  if (parsedSource.protocol === "http:") {
    const secureSource = new URL(parsedSource);
    secureSource.protocol = "https:";
    secureSource.port = "";
    const secureCandidates = [secureSource];
    if (secureSource.hostname.toLowerCase().startsWith("www.")) {
      const apexSource = new URL(secureSource);
      apexSource.hostname = secureSource.hostname.slice(4);
      secureCandidates.push(apexSource);
    }
    for (const candidate of secureCandidates) {
      try {
        return await fetchPublicHtmlFromUrl(candidate.toString(), fetchImpl);
      } catch {
        // Try the equivalent secure apex before the stored HTTP URL.
      }
    }
    return fetchPublicHtmlFromUrl(parsedSource.toString(), fetchImpl);
  }

  return fetchPublicHtmlFromUrl(parsedSource.toString(), fetchImpl);
}

async function fetchPublicHtmlFromUrl(sourceUrl: string, fetchImpl: typeof fetch) {
  let currentUrl = sourceUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5",
        "User-Agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new Error("Official site returned an incomplete redirect");
      }
      currentUrl = parseSafePublicUrl(new URL(location, currentUrl).toString()).toString();
      continue;
    }

    const managedChallenge =
      response.status === 403 &&
      response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
    if (!response.ok && !managedChallenge) {
      throw new Error(`Official site returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml") &&
      !contentType.includes("text/plain")
    ) {
      throw new Error("Official site did not return an HTML page");
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_HTML_BYTES) {
      throw new Error("Official site page is too large to inspect safely");
    }

    return {
      finalUrl: parseSafePublicUrl(response.url || currentUrl).toString(),
      html: (await response.text()).slice(0, MAX_HTML_BYTES),
      accessBarrier: managedChallenge ? ("MANAGED_CHALLENGE" as const) : undefined
    };
  }

  throw new Error("Official site exceeded the redirect limit");
}

function extractHtmlEvidence(html: string, pageUrl: string) {
  const observedUrls: string[] = [];
  const linkCandidates: Array<{ url: string; label: string }> = [];
  const decodedHtml = decodeHtmlEntities(html);
  const embeddedContent = decodeEmbeddedContent(decodedHtml);

  for (const match of decodedHtml.matchAll(
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi
  )) {
    const url = resolveHttpUrl(match[1] ?? match[2] ?? match[3], pageUrl);
    if (!url) {
      continue;
    }
    observedUrls.push(url);
    linkCandidates.push({ url, label: stripHtml(match[4] ?? "") });
  }

  for (const match of decodedHtml.matchAll(
    /\b(?:href|src|action)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi
  )) {
    const url = resolveHttpUrl(match[1] ?? match[2] ?? match[3], pageUrl);
    if (url) {
      observedUrls.push(url);
    }
  }

  for (const match of embeddedContent.matchAll(
    /"title"\s*:\s*"([^"]{1,160})"[\s\S]{0,600}?"(?:url|link)"\s*:\s*"([^"]+)"/gi
  )) {
    const url = resolveHttpUrl(match[2], pageUrl);
    if (!url) {
      continue;
    }
    observedUrls.push(url);
    linkCandidates.push({ url, label: match[1] });
  }

  for (const match of embeddedContent.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)) {
    const url = resolveHttpUrl(match[0], pageUrl);
    if (url) {
      observedUrls.push(url);
    }
  }

  const widgetConfigs = [...decodedHtml.matchAll(
    /\bdata-widget-config\s*=\s*(?:"([^"]+)"|'([^']+)')/gi
  )]
    .map((match) => decodeWidgetConfig(match[1] ?? match[2]))
    .filter(Boolean)
    .join("\n");
  const relevantScripts = [...decodedHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1] ?? "")
    .filter((script) => /window\.(?:courses|property)|baseURL|courseId|schedule_id/i.test(script))
    .join("\n")
    .slice(0, 8_000);
  const visibleText = [
    stripHtml(
      decodedHtml
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<(?:style|nav|header)\b[^>]*>[\s\S]*?<\/(?:style|nav|header)>/gi, " ")
    ),
    relevantScripts,
    widgetConfigs
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 12_000);

  return {
    observedUrls: uniqueStrings(observedUrls),
    linkCandidates,
    visibleText
  };
}

function pickLikelyBookingCandidate(
  candidates: Array<{ url: string; label: string }>,
  currentUrl: string
) {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreBookingCandidate(candidate, currentUrl)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.url;
}

function pickOfficialCourseDetailCandidate(
  candidates: Array<{ url: string; label: string }>,
  courseName: string | undefined,
  officialUrl: string
) {
  if (!courseName) {
    return undefined;
  }

  const officialOrigin = new URL(officialUrl).origin;
  const normalizedTarget = normalizeCourseLinkName(courseName);
  return candidates.find((candidate) => {
    const parsed = new URL(candidate.url);
    if (parsed.origin !== officialOrigin) {
      return false;
    }

    const normalizedLabel = normalizeCourseLinkName(
      candidate.label.replace(/\s*\([^)]*\)\s*$/u, "")
    );
    const pathSegment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
    return (
      normalizedLabel === normalizedTarget ||
      normalizeCourseLinkName(pathSegment) === normalizedTarget
    );
  })?.url;
}

function normalizeCourseLinkName(value: string) {
  return value.normalize("NFKD").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function pickOfficialPolicyCandidate(
  candidates: Array<{ url: string; label: string }>,
  officialUrl: string
) {
  const officialOrigin = new URL(officialUrl).origin;
  return candidates
    .map((candidate) => {
      const parsed = new URL(candidate.url);
      const searchable = `${candidate.label} ${parsed.pathname}`;
      let score = 0;
      if (parsed.origin !== officialOrigin) {
        return { ...candidate, score: -1 };
      }
      if (/\bfaqs?\b/i.test(searchable)) {
        score += 50;
      }
      if (/\bterms? and conditions?\b|terms-and-conditions/i.test(searchable)) {
        score += 30;
      }
      if (/\b(?:registration|booking) instructions?\b/i.test(searchable)) {
        score += 20;
      }
      if (/\.(?:pdf|docx?)(?:$|[?#])/i.test(parsed.pathname)) {
        score -= 100;
      }
      return { ...candidate, score };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.url;
}

function pickPrivateClubInformationCandidate(
  candidates: Array<{ url: string; label: string }>,
  visibleText: string,
  currentUrl: string
) {
  if (!/\bPrivate Golf Club sites by MembersFirst\b/i.test(visibleText)) {
    return undefined;
  }

  const currentOrigin = new URL(currentUrl).origin;
  return candidates.find((candidate) => {
    const parsed = new URL(candidate.url);
    return (
      parsed.origin === currentOrigin &&
      (/^The Club$/i.test(candidate.label.trim()) || /\/public\/?$/i.test(parsed.pathname))
    );
  })?.url;
}

function scoreBookingCandidate(candidate: { url: string; label: string }, currentUrl: string) {
  const parsed = new URL(candidate.url);
  const searchable = `${candidate.label} ${parsed.hostname} ${parsed.pathname} ${parsed.search}`;
  let score = 0;
  if (/foreupsoftware\.com|\.book\.teeitup\.(?:golf|com)|\.cps\.golf|\.teesnap\.net|fox\.tenfore\.golf/i.test(candidate.url)) {
    score += 100;
  }
  if (/tee.?times?/i.test(searchable)) {
    score += 25;
  }
  if (/book|reserve|reservation/i.test(searchable)) {
    score += 15;
  }
  if (normalizeSourceKey(candidate.url) === normalizeSourceKey(currentUrl)) {
    score -= 100;
  }
  if (/facebook\.com|instagram\.com|youtube\.com|linkedin\.com|twitter\.com|x\.com/i.test(parsed.hostname)) {
    score -= 100;
  }
  if (/\.(?:css|js|mjs|png|jpe?g|gif|webp|svg|ico|woff2?)(?:$|[?#])/i.test(parsed.pathname)) {
    score -= 100;
  }
  return score;
}

function parseSafePublicUrl(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    Boolean(url.username || url.password) ||
    (url.port && !["80", "443"].includes(url.port)) ||
    isPrivateHostname(url.hostname)
  ) {
    throw new Error("Official site URL is not a safe public HTTP address");
  }
  return url;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "::1" ||
    (normalized.includes(":") &&
      (normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe80:"))) ||
    /^\d+$|^0x[\da-f]+$/i.test(normalized)
  ) {
    return true;
  }
  const ipv4 = normalized.split(".").map(Number);
  if (ipv4.length !== 4 || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = ipv4;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function resolveHttpUrl(value: string | undefined, baseUrl: string) {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.startsWith("#") ||
    normalized.startsWith("mailto:") ||
    normalized.startsWith("tel:") ||
    normalized.includes("\\") ||
    /(?:%22|<%|%3c%25)/i.test(normalized)
  ) {
    return null;
  }
  try {
    const resolved = new URL(normalized, baseUrl).toString();
    if (/(?:%22|%3c%25)/i.test(resolved)) {
      return null;
    }
    return parseSafePublicUrl(resolved).toString();
  } catch {
    return null;
  }
}

function buildFailedDiscovery(input: {
  courseId: string;
  sourceUrl: string;
  detectedPlatform: string;
  message: string;
}): BrowserDiscovery {
  const detectedPlatform = [
    "FOREUP",
    "GOLFNOW",
    "TEEITUP",
    "CHRONOGOLF",
    "CLUB_CADDIE",
    "CUSTOM"
  ].includes(input.detectedPlatform)
    ? (input.detectedPlatform as BrowserDiscovery["detectedPlatform"])
    : "UNKNOWN";
  return {
    courseId: input.courseId,
    status: "FAILED",
    detectedPlatform,
    sourceUrl: input.sourceUrl,
    confidence: 0,
    evidence: {
      observedUrls: [input.sourceUrl],
      visibleText: input.message.slice(0, 500),
      learnedFrom: "official-site-fetch-failed"
    }
  };
}

function decodeWidgetConfig(value: string) {
  try {
    return Buffer.from(value, "base64").toString("utf8").slice(0, 8_000);
  } catch {
    return "";
  }
}

function decodeHtmlEntities(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function decodeEmbeddedContent(value: string) {
  return value
    .replace(/\\u003c/gi, "<")
    .replace(/\\u003e/gi, ">")
    .replace(/\\u003a/gi, ":")
    .replace(/\\u002f/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replaceAll("\\/", "/")
    .replaceAll('\\"', '"');
}

function stripHtml(value: string) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeSourceKey(value: string) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
