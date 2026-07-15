import { createHash } from "node:crypto";

export const COURSE_PROFILE_TYPES = [
  "MUNICIPAL",
  "DAILY_FEE",
  "RESORT",
  "UNIVERSITY",
  "MILITARY",
  "SEMI_PRIVATE",
  "OTHER_PUBLIC"
] as const;

export const COURSE_PROFILE_SOURCE_TYPES = [
  "OFFICIAL_COURSE",
  "OFFICIAL_OPERATOR",
  "MUNICIPAL_GOVERNMENT",
  "OFFICIAL_BOOKING",
  "GOLF_ASSOCIATION",
  "GOVERNMENT_TOURISM",
  "ESTABLISHED_NEWS",
  "GOOGLE_PLACE_IDENTITY"
] as const;

export type CourseProfileTypeValue = (typeof COURSE_PROFILE_TYPES)[number];
export type CourseProfileSourceTypeValue = (typeof COURSE_PROFILE_SOURCE_TYPES)[number];

export type CourseProfileSourceDraft = {
  url: string;
  title: string;
  publisher: string;
  sourceType: CourseProfileSourceTypeValue;
  claimKeys: string[];
  evidenceSummary: string;
  accessedAt: string;
};

export type CourseProfileDraft = {
  courseId: string;
  officialWebsiteUrl?: string;
  location: {
    city: string;
    stateCode: string;
    stateName: string;
    county: string;
    countryCode: string;
  };
  courseType: CourseProfileTypeValue;
  accessSummary: string;
  overview: string;
  courseCharacter: string;
  notableFacts: string[];
  profileVerifiedAt: string;
  sources: CourseProfileSourceDraft[];
};

const OFFICIAL_SOURCE_TYPES = new Set<CourseProfileSourceTypeValue>([
  "OFFICIAL_COURSE",
  "OFFICIAL_OPERATOR",
  "MUNICIPAL_GOVERNMENT"
]);
const EDITORIAL_FALLBACK_TYPES = new Set<CourseProfileSourceTypeValue>([
  "GOLF_ASSOCIATION",
  "GOVERNMENT_TOURISM",
  "ESTABLISHED_NEWS"
]);
const REQUIRED_CLAIMS = ["access", "course_type", "overview", "course_character"];
const EXCLUDED_HOST_PARTS = [
  "reddit.",
  "yelp.",
  "tripadvisor.",
  "facebook.",
  "instagram.",
  "x.com",
  "golfpass.",
  "golflink."
];
const UNSUPPORTED_SUPERLATIVE = /\b(?:best|finest|premier|world[- ]class|top[- ]rated|number one|#1)\b/i;

export function validateCourseProfileDraft(value: unknown) {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ["Profile draft must be an object"], draft: null };
  }

  const courseId = requiredString(value.courseId, "courseId", 100, errors);
  const officialWebsiteUrl = value.officialWebsiteUrl === undefined
    ? undefined
    : httpUrl(value.officialWebsiteUrl, "officialWebsiteUrl", errors) ?? undefined;
  const location = validateLocation(value.location, errors);
  const courseType = enumValue(value.courseType, COURSE_PROFILE_TYPES, "courseType", errors);
  const accessSummary = requiredString(value.accessSummary, "accessSummary", 600, errors);
  const overview = requiredString(value.overview, "overview", 1800, errors);
  const courseCharacter = requiredString(
    value.courseCharacter,
    "courseCharacter",
    1200,
    errors
  );
  const notableFacts = stringArray(value.notableFacts, "notableFacts", 8, 400, errors);
  const profileVerifiedAt = validDateString(
    value.profileVerifiedAt,
    "profileVerifiedAt",
    errors
  );
  const sources = validateSources(value.sources, errors);
  if (
    officialWebsiteUrl &&
    !sources.some(
      (source) =>
        OFFICIAL_SOURCE_TYPES.has(source.sourceType) &&
        new URL(source.url).hostname === new URL(officialWebsiteUrl).hostname
    )
  ) {
    errors.push("officialWebsiteUrl must share a host with an official source");
  }

  const copy = [accessSummary, overview, courseCharacter, ...notableFacts].filter(Boolean).join(" ");
  if (UNSUPPORTED_SUPERLATIVE.test(copy)) {
    errors.push("Profile copy cannot use unsupported superlatives");
  }

  const coveredClaims = new Set(sources.flatMap((source) => source.claimKeys));
  const requiredClaims = [
    ...REQUIRED_CLAIMS,
    ...notableFacts.map((_, index) => `notable_fact_${index}`)
  ];
  for (const claim of requiredClaims) {
    if (!coveredClaims.has(claim)) {
      errors.push(`At least one source must support the ${claim} claim`);
    }
  }

  const hasOfficialDescription = sources.some(
    (source) =>
      OFFICIAL_SOURCE_TYPES.has(source.sourceType) &&
      source.claimKeys.some((claim) => claim === "overview" || claim === "course_character")
  );
  const fallbackPublishers = new Set(
    sources
      .filter(
        (source) =>
          EDITORIAL_FALLBACK_TYPES.has(source.sourceType) &&
          source.claimKeys.some((claim) => claim === "overview" || claim === "course_character")
      )
      .map((source) => source.publisher.toLowerCase())
  );
  if (!hasOfficialDescription && fallbackPublishers.size < 2) {
    errors.push(
      "Use an official descriptive source or two independent authoritative fallback publishers"
    );
  }

  for (const prose of [overview, courseCharacter, ...notableFacts].filter(
    (item): item is string => Boolean(item)
  )) {
    for (const source of sources) {
      if (hasLongSharedPhrase(prose, source.evidenceSummary)) {
        errors.push(`Profile prose overlaps too closely with source ${source.url}`);
      }
    }
  }

  const draft =
    courseId && location && courseType && accessSummary && overview && courseCharacter && profileVerifiedAt
      ? ({
          courseId,
          officialWebsiteUrl,
          location,
          courseType,
          accessSummary,
          overview,
          courseCharacter,
          notableFacts,
          profileVerifiedAt,
          sources
        } satisfies CourseProfileDraft)
      : null;

  return { valid: errors.length === 0 && Boolean(draft), errors, draft };
}

export function hashCourseProfileDraft(draft: CourseProfileDraft) {
  return createHash("sha256").update(JSON.stringify(draft)).digest("hex");
}

function validateLocation(value: unknown, errors: string[]) {
  if (!isRecord(value)) {
    errors.push("location is required");
    return null;
  }
  const city = requiredString(value.city, "location.city", 120, errors);
  const stateCode = requiredString(value.stateCode, "location.stateCode", 2, errors)?.toUpperCase();
  const stateName = requiredString(value.stateName, "location.stateName", 120, errors);
  const county = requiredString(value.county, "location.county", 120, errors)?.replace(/\s+County$/i, "");
  const countryCode = requiredString(value.countryCode, "location.countryCode", 2, errors)?.toUpperCase();
  if (stateCode?.length !== 2) errors.push("location.stateCode must be a two-letter code");
  if (countryCode?.length !== 2) errors.push("location.countryCode must be a two-letter code");
  return city && stateCode && stateName && county && countryCode
    ? { city, stateCode, stateName, county, countryCode }
    : null;
}

function validateSources(value: unknown, errors: string[]) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) {
    errors.push("sources must contain between 1 and 12 entries");
    return [];
  }

  const sources: CourseProfileSourceDraft[] = [];
  const urls = new Set<string>();
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`sources[${index}] must be an object`);
      return;
    }
    const url = httpUrl(item.url, `sources[${index}].url`, errors);
    const title = requiredString(item.title, `sources[${index}].title`, 240, errors);
    const publisher = requiredString(item.publisher, `sources[${index}].publisher`, 160, errors);
    const sourceType = enumValue(
      item.sourceType,
      COURSE_PROFILE_SOURCE_TYPES,
      `sources[${index}].sourceType`,
      errors
    );
    const claimKeys = stringArray(item.claimKeys, `sources[${index}].claimKeys`, 20, 80, errors);
    const evidenceSummary = requiredString(
      item.evidenceSummary,
      `sources[${index}].evidenceSummary`,
      800,
      errors
    );
    const accessedAt = validDateString(item.accessedAt, `sources[${index}].accessedAt`, errors);
    if (!url || !title || !publisher || !sourceType || !evidenceSummary || !accessedAt) return;
    const host = new URL(url).hostname.toLowerCase();
    if (EXCLUDED_HOST_PARTS.some((part) => host.includes(part))) {
      errors.push(`Source host is not approved: ${host}`);
      return;
    }
    if (urls.has(url)) {
      errors.push(`Duplicate source URL: ${url}`);
      return;
    }
    urls.add(url);
    sources.push({ url, title, publisher, sourceType, claimKeys, evidenceSummary, accessedAt });
  });
  return sources;
}

function hasLongSharedPhrase(left: string, right: string, phraseLength = 14) {
  const leftWords = words(left);
  const rightText = ` ${words(right).join(" ")} `;
  if (leftWords.length < phraseLength) return false;
  for (let index = 0; index <= leftWords.length - phraseLength; index += 1) {
    if (rightText.includes(` ${leftWords.slice(index, index + phraseLength).join(" ")} `)) return true;
  }
  return false;
}

function words(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function httpUrl(value: unknown, label: string, errors: string[]) {
  if (typeof value !== "string") {
    errors.push(`${label} is required`);
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) throw new Error();
    url.hash = "";
    return url.toString();
  } catch {
    errors.push(`${label} must be a safe http(s) URL`);
    return null;
  }
}

function validDateString(value: unknown, label: string, errors: string[]) {
  if (typeof value !== "string") {
    errors.push(`${label} is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() > Date.now() + 60_000) {
    errors.push(`${label} must be a valid date that is not in the future`);
    return null;
  }
  return date.toISOString();
}

function requiredString(value: unknown, label: string, max: number, errors: string[]) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${label} is required`);
    return null;
  }
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) errors.push(`${label} must be ${max} characters or fewer`);
  return text.slice(0, max);
}

function stringArray(value: unknown, label: string, maxItems: number, maxLength: number, errors: string[]) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    errors.push(`${label} must be an array with at most ${maxItems} entries`);
    return [];
  }
  return value
    .map((item, index) => requiredString(item, `${label}[${index}]`, maxLength, errors))
    .filter((item): item is string => Boolean(item));
}

function enumValue<const T extends readonly string[]>(value: unknown, options: T, label: string, errors: string[]) {
  if (typeof value !== "string" || !options.includes(value as T[number])) {
    errors.push(`${label} must be one of ${options.join(", ")}`);
    return null;
  }
  return value as T[number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
