import type { BrowserDiscovery, BrowserDiscoveryEvidence } from "./browser-discovery";
import { golfGeekCourseUrl, parseGolfGeekCourse } from "@/lib/adapters/golf-geek";
import { haveCompatibleCourseNames } from "@/lib/places/course-identity";
import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";

const MAIN_SCRIPT = /^\/static\/js\/main\.[0-9a-f]{8,32}\.chunk\.js$/u;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

function root(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        (url.pathname !== "/" && url.pathname !== "/tee-times")) return null;
    return new URL("/", url);
  } catch {
    return null;
  }
}

async function boundedText(response: Response, limit: number) {
  const size = response.headers.get("content-length");
  if (size && Number(size) > limit) return null;
  const text = await response.text();
  return text.length <= limit ? text : null;
}

export async function enrichGolfGeekDiscovery(input: {
  discovery: BrowserDiscovery;
  sourceEvidence: BrowserDiscoveryEvidence;
  courseName: string;
  courseCity: string | null;
  courseState: string | null;
  officialWebsite: string | null;
  publicFetch: typeof fetch;
  apiFetch: typeof fetch;
}): Promise<BrowserDiscovery> {
  const { discovery, sourceEvidence } = input;
  if (discovery.apiMetadata || !input.officialWebsite ||
      !input.courseCity || !input.courseState) return discovery;
  const official = root(input.officialWebsite);
  if (!official) return discovery;
  const officialHost = official.hostname.replace(/^www\./u, "");
  const candidates = [...sourceEvidence.observedUrls,
    ...sourceEvidence.linkCandidates?.map(link => link.url) ?? []];
  const bookingRoots = new Set(candidates.map(root).filter((url): url is URL =>
    Boolean(url && url.hostname === `booking.${officialHost}`)).map(url => url.toString()));
  if (bookingRoots.size !== 1) return discovery;
  const bookingBaseUrl = [...bookingRoots][0]!;
  const landing = await fetchWithProviderTimeout(bookingBaseUrl, {
    redirect: "error", credentials: "omit", headers: { accept: "text/html" }
  }, input.publicFetch);
  if (!landing.ok) return discovery;
  const html = await boundedText(landing, 250_000);
  if (!html || !html.includes("Golf Booking System")) return discovery;
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)]
    .map(match => { try { return new URL(match[1]!, bookingBaseUrl); } catch { return null; } })
    .filter((url): url is URL => Boolean(url && url.origin === new URL(bookingBaseUrl).origin &&
      MAIN_SCRIPT.test(url.pathname) && !url.search && !url.hash));
  if (scripts.length !== 1) return discovery;
  const scriptResponse = await fetchWithProviderTimeout(scripts[0]!.toString(), {
    redirect: "error", credentials: "omit", headers: { accept: "text/javascript" }
  }, input.publicFetch);
  if (!scriptResponse.ok) return discovery;
  const script = await boundedText(scriptResponse, 1_000_000);
  if (!script || !script.includes("xq8v7un6ad.execute-api.us-east-1.amazonaws.com")) return discovery;
  const ids = new Set([...script.matchAll(UUID)].map(match => match[0]!.toLowerCase()));
  if (ids.size !== 1) return discovery;
  const courseId = [...ids][0]!;
  const courseUrl = golfGeekCourseUrl(courseId);
  const response = await fetchWithProviderTimeout(courseUrl, {
    redirect: "error", credentials: "omit", headers: { accept: "application/json" }
  }, input.apiFetch);
  if (!response.ok) return discovery;
  const payload = await response.json().catch(() => null);
  const profile = parseGolfGeekCourse(payload);
  if (!profile || profile.id.toLowerCase() !== courseId ||
      profile.subdomain !== bookingBaseUrl ||
      new URL(profile.website).hostname.replace(/^www\./u, "") !== officialHost ||
      !haveCompatibleCourseNames(profile.name, input.courseName) ||
      profile.city.trim().toLowerCase() !== input.courseCity.trim().toLowerCase() ||
      profile.state !== input.courseState.trim().toUpperCase()) return discovery;
  return {
    ...discovery,
    status: "LEARNED",
    detectedPlatform: "CUSTOM",
    bookingUrl: bookingBaseUrl,
    bookingMethod: "PUBLIC_ONLINE",
    automationEligibility: "ALLOWED",
    automationReason: "NONE",
    policyNotes: "The official booking page exposes signed-out public tee times. Tee Time Spot reads availability and leaves booking on the official site.",
    apiEndpoint: `https://xq8v7un6ad.execute-api.us-east-1.amazonaws.com/prod/course/${courseId}/tee-times`,
    apiMetadata: {
      provider: "GOLF_GEEK", courseId, bookingBaseUrl,
      officialWebsite: official.toString(),
      ...(profile.bookingAllowedDays !== undefined
        ? { bookingWindowDaysAhead: profile.bookingAllowedDays } : {})
    },
    confidence: 0.97,
    evidence: {
      ...discovery.evidence,
      observedUrls: [...new Set([...discovery.evidence.observedUrls, bookingBaseUrl, courseUrl])],
      learnedFrom: "golf-geek-public-course-profile"
    }
  };
}
