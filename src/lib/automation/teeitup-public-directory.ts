import { fetchWithProviderTimeout, providerHttpError } from "@/lib/adapters/fetch-with-timeout";
import { resolveTeeItUpFacilityIdentity } from "@/lib/adapters/teeitup-facility-identity";
import type { BrowserDiscovery } from "./browser-discovery";

export type TeeItUpPublicSourceContext = {
  course: { id: string; name: string; address: string; city: string; stateCode: string; timeZone: string; website: string };
  observation: {
    courseId: string;
    pageUrl: string;
    observedAt: Date;
    visibleText: string;
    links: Array<{ url: string; label: string }>;
  };
};

/** Source observation must be captured under the caller's existing ownership fence. */
export async function enrichTeeItUpFromPublicDirectory(
  discovery: BrowserDiscovery,
  context: TeeItUpPublicSourceContext,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<BrowserDiscovery> {
  const { course, observation } = context;
  if (discovery.detectedPlatform !== "TEEITUP" ||
    !["INSPECTED", "LEARNED"].includes(discovery.status) ||
    course.id !== discovery.courseId || observation.courseId !== course.id ||
    !Number.isFinite(observation.observedAt.getTime()) ||
    !Number.isFinite(now.getTime()) || observation.observedAt > now ||
    now.getTime() - observation.observedAt.getTime() > 5 * 60_000 ||
    observation.visibleText.length > 20_000 || observation.links.length > 100 ||
    !sameOfficialHost(course.website, discovery.sourceUrl) ||
    !sameOfficialHost(course.website, observation.pageUrl) ||
    !sourceContainsAddress(course, observation.visibleText)) return discovery;

  const providerOrigins = new Map<string, string>();
  for (const link of observation.links) {
    if (!/\b(?:book|reserve|tee\s*times?)\b/iu.test(link.label)) continue;
    const url = safeUrl(link.url);
    const alias = url?.hostname.match(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.book\.teeitup\.(?:com|golf)$/iu)?.[1];
    if (!url || !alias || url.protocol !== "https:" || url.pathname !== "/" ||
      [...url.searchParams.keys()].some((key) => key !== "course") ||
      url.searchParams.getAll("course").length > 1 ||
      (url.searchParams.has("course") && !/^[1-9]\d*(?:,[1-9]\d*){0,19}$/u.test(url.searchParams.get("course")!))) continue;
    providerOrigins.set(url.origin, alias);
  }
  if (providerOrigins.size !== 1) return discovery;
  const [bookingOrigin, alias] = [...providerOrigins][0];
  const endpoint = `https://phx-api-be-east-1b.kenna.io/alias/${alias}/facilities`;
  const response = await fetchWithProviderTimeout(endpoint, {
    headers: { accept: "application/json", "x-be-alias": alias, origin: bookingOrigin, referer: `${bookingOrigin}/` },
    redirect: "error",
  }, fetchImpl);
  if (!response.ok) throw providerHttpError("TeeItUp public directory", response);
  const identity = resolveTeeItUpFacilityIdentity(course, await response.json());
  if (identity.status !== "MATCHED") return discovery;
  const bookingUrl = `${bookingOrigin}/?course=${identity.facility.id}`;
  return {
    ...discovery,
    status: "LEARNED",
    bookingUrl,
    apiEndpoint: "https://phx-api-be-east-1b.kenna.io/v2/tee-times",
    apiMetadata: { aliases: [alias], bookingBaseUrl: bookingUrl, facilityIds: [identity.facility.id] },
    confidence: 0.85,
    evidence: {
      ...discovery.evidence,
      learnedFrom: "teeitup-official-directory-identity",
      observedUrls: [...new Set([...discovery.evidence.observedUrls, observation.pageUrl, bookingUrl])],
      courseIdentityCorroboration: {
        kind: "OFFICIAL_COURSE_PROVIDER_LINK",
        courseName: course.name,
        officialWebsiteUrl: course.website,
        officialPageUrl: observation.pageUrl,
        providerUrl: bookingUrl,
      },
    },
  };
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.port ? url : null;
  } catch { return null; }
}

function sameOfficialHost(expected: string, observed: string) {
  const left = safeUrl(expected);
  const right = safeUrl(observed);
  return Boolean(left && right && left.hostname.replace(/^www\./u, "") === right.hostname.replace(/^www\./u, "") &&
    (left.protocol === right.protocol || (left.protocol === "http:" && right.protocol === "https:")));
}

function words(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function sourceContainsAddress(course: TeeItUpPublicSourceContext["course"], text: string) {
  const source = ` ${words(text)} `;
  const street = words(course.address.split(",")[0]);
  return /^\d+\s/u.test(street) && [street, words(course.city), words(course.stateCode)]
    .every((part) => part.length > 0 && source.includes(` ${part} `));
}
