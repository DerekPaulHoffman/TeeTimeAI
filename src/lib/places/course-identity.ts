export const GENERIC_COURSE_MATCH_MAX_METERS = 175;
export const SAME_NAME_COURSE_MATCH_MAX_METERS = 1000;

const COURSE_NAME_STOP_WORDS = new Set([
  "and",
  "club",
  "course",
  "country",
  "facility",
  "golf",
  "links",
  "park",
  "the",
  "tpc"
]);
const LAYOUT_DISTINGUISHING_TOKENS = new Set([
  "black",
  "blue",
  "east",
  "green",
  "north",
  "red",
  "south",
  "west",
  "yellow"
]);
const OFFICIAL_IDENTITY_NEUTRAL_TOKENS = new Set([
  "a",
  "an",
  "and",
  "at",
  "book",
  "booking",
  "center",
  "centre",
  "club",
  "course",
  "courses",
  "country",
  "facility",
  "general",
  "golf",
  "home",
  "links",
  "like",
  "municipal",
  "no",
  "of",
  "official",
  "online",
  "other",
  "page",
  "public",
  "reservation",
  "reservations",
  "reserve",
  "resort",
  "site",
  "tee",
  "teeitup",
  "the",
  "time",
  "times",
  "to",
  "website",
  "welcome"
]);

export type CourseIdentity = {
  googlePlaceId?: string | null;
  name: string;
  address?: string | null;
  latitude: number;
  longitude: number;
  website?: string | null;
  phone?: string | null;
  containingPlaceIds?: readonly string[];
};

export function normalizeCourseIdentityName(name: string) {
  return getMeaningfulCourseNameTokens(name).join(" ");
}

export function isGenericCourseName(name: string) {
  return getMeaningfulCourseNameTokens(name).length === 0;
}

export function normalizeOfficialPagePresentationIdentity(value: string) {
  let normalized = value
    .replace(/^\s*welcome\s+to(?:\s+the)?\s+/iu, "")
    .replace(/\s*&\s*event\s+venue(?=\s+at\b)/iu, "")
    .trim();
  if (
    /^(?:(?:book|reserve|find|view|search)(?:\s+(?:a|your))?\s+tee\s*times?|book\s+now|online\s+booking|(?:private\s+)?golf\s+club\s+memberships?)$/iu.test(
      normalized
    )
  ) {
    return "";
  }
  normalized = normalized
    .replace(/\s+(?:(?:general\s+)?public\s+)?tee\s*times?\s*$/iu, "")
    .replace(/\s+details\s*$/iu, "")
    .trim();
  return normalized;
}

export function isExplicitCourseIdentityName(name: string) {
  return Boolean(
    normalizeCourseIdentityName(name) &&
    /\b(?:golf\s+(?:club|course|links?|center|centre|resort)|country\s+club)\b/iu.test(
      name
    )
  );
}

export function isConflictingOfficialPageCourseIdentity(
  courseName: string,
  pageIdentity: string
) {
  if (
    haveCompatibleOfficialPageCourseNames(courseName, pageIdentity) ||
    !pageIdentity.trim()
  ) {
    return false;
  }
  if (
    hasConflictingOfficialCourseIdentityDiscriminator(courseName, pageIdentity)
  ) {
    return true;
  }
  if (isNeutralOfficialSiteBrandIdentity(pageIdentity)) {
    return false;
  }
  if (isExplicitCourseIdentityName(pageIdentity)) {
    return true;
  }
  return getOfficialIdentityCoreTokens(pageIdentity).length > 0;
}

export function isOfficialOrganizationIdentityCorroboratedByUrl(
  identity: string,
  pageUrl: string
) {
  const organizationCore = getOfficialOrganizationIdentityCore(identity);
  if (!organizationCore) {
    return false;
  }
  try {
    const hostname = new URL(pageUrl).hostname
      .toLocaleLowerCase("en-US")
      .replace(/^www\./u, "")
      .replace(/[^a-z0-9]+/gu, " ")
      .trim();
    const hostCompact = hostname.replace(/\s+/gu, "");
    const coreCompact = organizationCore.replace(/\s+/gu, "");
    return Boolean(
      coreCompact.length >= 2 &&
      (hostCompact.includes(coreCompact) ||
        organizationCore
          .split(" ")
          .every((token) => hostname.split(" ").includes(token)))
    );
  } catch {
    return false;
  }
}

export function hasConflictingOfficialCourseIdentityDiscriminator(
  courseName: string,
  pageIdentity: string
) {
  const targetTokens = getOfficialIdentityCoreTokens(courseName);
  const pageTokens = getOfficialIdentityCoreTokens(pageIdentity);
  if (targetTokens.length === 0 || pageTokens.length === 0) {
    return false;
  }
  const targetSet = new Set(targetTokens);
  const pageSet = new Set(pageTokens);
  return Boolean(
    targetTokens.every((token) => pageSet.has(token)) &&
    pageTokens.some((token) => !targetSet.has(token))
  );
}

export function haveSameOfficialCourseIdentityCore(
  courseName: string,
  candidateIdentity: string
) {
  let courseInitialName = splitLeadingInitialCourseName(courseName);
  let candidateInitialName = splitLeadingInitialCourseName(candidateIdentity);
  if (courseInitialName && !candidateInitialName) {
    candidateInitialName = splitLeadingUndottedInitialCourseName(
      candidateIdentity,
      courseInitialName.initials.length
    );
  } else if (candidateInitialName && !courseInitialName) {
    courseInitialName = splitLeadingUndottedInitialCourseName(
      courseName,
      candidateInitialName.initials.length
    );
  }
  if (
    courseInitialName &&
    candidateInitialName &&
    courseInitialName.initials !== candidateInitialName.initials
  ) {
    return false;
  }
  const targetTokens = getOfficialIdentityCoreTokens(courseName);
  const candidateTokens = getOfficialIdentityCoreTokens(candidateIdentity);
  return Boolean(
    targetTokens.length > 0 &&
    (targetTokens.join(" ") === candidateTokens.join(" ") ||
      normalizeExactCourseName(courseName).replace(/\s+/gu, "") ===
        normalizeExactCourseName(candidateIdentity).replace(/\s+/gu, ""))
  );
}

export function isNonSpecificOfficialCourseIdentity(value: string) {
  return getOfficialIdentityCoreTokens(value).length === 0;
}

export function areEquivalentNamedCourses(left: CourseIdentity, right: CourseIdentity) {
  const leftIdentity = normalizeCourseIdentityName(left.name);
  const rightIdentity = normalizeCourseIdentityName(right.name);
  if (!leftIdentity || leftIdentity !== rightIdentity) {
    return false;
  }

  return (
    getCourseDistanceMeters(left, right) <= SAME_NAME_COURSE_MATCH_MAX_METERS ||
    haveSameNormalizedAddress(left.address, right.address) ||
    haveContainingPlaceRelationship(left, right)
  );
}

export function haveCompatibleCourseNames(leftName: string, rightName: string) {
  const left = getMeaningfulCourseNameTokens(leftName);
  const right = getMeaningfulCourseNameTokens(rightName);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left.join(" ") === right.join(" ")) {
    return true;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const smaller = left.length <= right.length ? left : right;
  const largerSet = left.length <= right.length ? rightSet : leftSet;
  const smallerSet = new Set(smaller);
  const extraTokens = (left.length <= right.length ? right : left).filter(
    (token) => !smallerSet.has(token)
  );

  return (
    smaller.length >= 2 &&
    smaller.every((token) => largerSet.has(token)) &&
    !extraTokens.some(isLayoutDistinguishingToken)
  );
}

export function haveCompatibleOfficialPageCourseNames(
  leftName: string,
  rightName: string
) {
  let leftInitialName = splitLeadingInitialCourseName(leftName);
  let rightInitialName = splitLeadingInitialCourseName(rightName);
  if (leftInitialName && !rightInitialName) {
    rightInitialName = splitLeadingUndottedInitialCourseName(
      rightName,
      leftInitialName.initials.length
    );
  } else if (rightInitialName && !leftInitialName) {
    leftInitialName = splitLeadingUndottedInitialCourseName(
      leftName,
      rightInitialName.initials.length
    );
  }
  if (!leftInitialName && !rightInitialName) {
    const normalizedLeftName = normalizeExactCourseName(
      stripOfficialMunicipalQualifier(leftName)
    );
    const normalizedRightName = normalizeExactCourseName(
      stripOfficialMunicipalQualifier(rightName)
    );
    return Boolean(
      normalizedLeftName &&
      (normalizedLeftName === normalizedRightName ||
        ((`${normalizedLeftName} course` === normalizedRightName ||
          `${normalizedRightName} course` === normalizedLeftName) &&
          (normalizedLeftName.endsWith(" golf") ||
            normalizedRightName.endsWith(" golf"))))
    );
  }
  if (
    leftInitialName &&
    rightInitialName &&
    leftInitialName.initials !== rightInitialName.initials
  ) {
    return false;
  }

  const leftRemainder = leftInitialName?.remainder ?? leftName;
  const rightRemainder = rightInitialName?.remainder ?? rightName;
  const normalizedLeftRemainder = normalizeExactCourseName(
    stripOfficialMunicipalQualifier(leftRemainder)
  );
  const normalizedRightRemainder = normalizeExactCourseName(
    stripOfficialMunicipalQualifier(rightRemainder)
  );
  return Boolean(
    normalizedLeftRemainder &&
    normalizedLeftRemainder === normalizedRightRemainder
  );
}

export function haveCompatibleOfficialPageCourseNamesWithVerifiedLayout(
  courseName: string,
  pageIdentity: string,
  verifiedLayoutHoleCounts: readonly unknown[] | null | undefined
) {
  if (haveCompatibleOfficialPageCourseNames(courseName, pageIdentity)) {
    return true;
  }
  const verifiedLayouts = new Set(
    (verifiedLayoutHoleCounts ?? []).filter(
      (value): value is 9 | 18 => value === 9 || value === 18
    )
  );
  if (
    verifiedLayouts.size !== 1 ||
    /\b(?:9|18|nine|eighteen)(?:\s*[- ]?\s*holes?)?\b/iu.test(courseName)
  ) {
    return false;
  }
  const qualifiers = [
    ...pageIdentity.matchAll(
      /\b(9|18|nine|eighteen)(?:\s*[- ]?\s*holes?)?\b/giu
    )
  ];
  if (qualifiers.length !== 1) {
    return false;
  }
  const qualifier = qualifiers[0]?.[1]?.toLocaleLowerCase("en-US");
  const holes = qualifier === "9" || qualifier === "nine" ? 9 : 18;
  if (!verifiedLayouts.has(holes)) {
    return false;
  }
  const unqualifiedPageIdentity = pageIdentity
    .replace(/\b(?:9|18|nine|eighteen)(?:\s*[- ]?\s*holes?)?\b/iu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    haveCompatibleOfficialPageCourseNames(courseName, unqualifiedPageIdentity) ||
    haveCompatibleOfficialPageCourseNames(
      courseName,
      unqualifiedPageIdentity.replace(/\bgolf\s+courses\b/iu, "Golf Course")
    )
  );
}

function stripOfficialMunicipalQualifier(value: string) {
  return value.replace(/\bmunicipal(?=\s+golf\s+course\b)/giu, "");
}

export function findUniqueGenericCourseMatch<T extends CourseIdentity>(
  genericCourse: CourseIdentity,
  candidates: readonly T[]
) {
  if (!isGenericCourseName(genericCourse.name)) {
    return undefined;
  }

  const nearbyCandidates = candidates.filter(
    (candidate) =>
      !isGenericCourseName(candidate.name) &&
      getCourseDistanceMeters(genericCourse, candidate) <= GENERIC_COURSE_MATCH_MAX_METERS &&
      !haveConflictingStreetAddresses(genericCourse.address, candidate.address)
  );
  if (nearbyCandidates.length === 1) {
    return nearbyCandidates[0];
  }

  const stronglyLinkedCandidates = nearbyCandidates.filter((candidate) =>
    haveStrongCourseIdentityLink(genericCourse, candidate)
  );
  return stronglyLinkedCandidates.length === 1 ? stronglyLinkedCandidates[0] : undefined;
}

export function getCourseDistanceMeters(
  from: Pick<CourseIdentity, "latitude" | "longitude">,
  to: Pick<CourseIdentity, "latitude" | "longitude">
) {
  const earthRadiusMeters = 6371000;
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const latitudeDelta = toRadians(to.latitude - from.latitude);
  const longitudeDelta = toRadians(to.longitude - from.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return Math.round(
    earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
  );
}

function getMeaningfulCourseNameTokens(name: string) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token && !COURSE_NAME_STOP_WORDS.has(token));
}

function splitLeadingInitialCourseName(value: string) {
  const match = value.match(/^\s*((?:[a-z]\s*\.\s*){1,4})([^\s].*?)\s*$/iu);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  const initials = [...match[1].matchAll(/[a-z]/giu)]
    .map((initial) => initial[0].toLocaleLowerCase("en-US"))
    .join("");
  return initials
    ? {
        initials,
        remainder: match[2]
      }
    : null;
}

function splitLeadingUndottedInitialCourseName(
  value: string,
  expectedInitialCount: number
) {
  if (expectedInitialCount < 1 || expectedInitialCount > 4) {
    return null;
  }
  const tokens = value.trim().split(/\s+/u);
  const initialTokens = tokens.slice(0, expectedInitialCount);
  const remainder = tokens.slice(expectedInitialCount).join(" ");
  if (
    initialTokens.length !== expectedInitialCount ||
    initialTokens.some((token) => !/^[a-z]$/iu.test(token)) ||
    !remainder
  ) {
    return null;
  }
  return {
    initials: initialTokens
      .map((initial) => initial.toLocaleLowerCase("en-US"))
      .join(""),
    remainder
  };
}

function normalizeExactCourseName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function getOfficialIdentityCoreTokens(value: string) {
  const tokens = normalizeExactCourseName(value).split(" ").filter(Boolean);
  while (tokens[0]?.length === 1 && /^[a-z]$/u.test(tokens[0])) {
    tokens.shift();
  }
  return tokens.filter((token) => !OFFICIAL_IDENTITY_NEUTRAL_TOKENS.has(token));
}

function isNeutralOfficialSiteBrandIdentity(value: string) {
  const normalized = normalizeExactCourseName(value);
  if (isExplicitCourseIdentityName(value)) {
    return false;
  }
  return /^(?:facilit(?:y|ies)|golf\s+courses|city\s+golf|municipal\s+golf)$/u.test(
    normalized
  );
}

function getOfficialOrganizationIdentityCore(value: string) {
  if (isExplicitCourseIdentityName(value)) {
    return null;
  }
  const normalized = normalizeExactCourseName(value);
  const patterns = [
    /^city\s+of\s+(.+?)(?:\s+golf(?:\s+courses)?)?$/u,
    /^(.+?)\s+golf\s+courses$/u,
    /^(.+?)\s+city\s+golf\s+courses$/u,
    /^play\s+(.+?)\s+golf\s+public$/u
  ];
  for (const pattern of patterns) {
    const core = normalized.match(pattern)?.[1]
      ?.replace(/\b(?:city|county|department|parks?)\b/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (core) {
      return core;
    }
  }
  return null;
}

function isLayoutDistinguishingToken(token: string) {
  return LAYOUT_DISTINGUISHING_TOKENS.has(token) || /^\d+$/.test(token);
}

export function haveStrongCourseIdentityLink(left: CourseIdentity, right: CourseIdentity) {
  return (
    haveSameWebsiteHost(left.website, right.website) ||
    haveSamePhone(left.phone, right.phone) ||
    haveSameNormalizedAddress(left.address, right.address) ||
    haveContainingPlaceRelationship(left, right)
  );
}

function haveSameWebsiteHost(left?: string | null, right?: string | null) {
  const leftHost = getWebsiteHost(left);
  const rightHost = getWebsiteHost(right);
  return Boolean(leftHost && leftHost === rightHost);
}

function getWebsiteHost(value?: string | null) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function haveSamePhone(left?: string | null, right?: string | null) {
  const leftPhone = left?.replace(/\D/g, "");
  const rightPhone = right?.replace(/\D/g, "");
  return Boolean(leftPhone && leftPhone === rightPhone);
}

function haveSameNormalizedAddress(left?: string | null, right?: string | null) {
  const leftAddress = normalizeAddress(left);
  const rightAddress = normalizeAddress(right);
  return Boolean(leftAddress && leftAddress === rightAddress);
}

function haveConflictingStreetAddresses(left?: string | null, right?: string | null) {
  const leftStreet = getNumberedStreetAddress(left);
  const rightStreet = getNumberedStreetAddress(right);
  return Boolean(leftStreet && rightStreet && leftStreet !== rightStreet);
}

function getNumberedStreetAddress(address?: string | null) {
  const street = normalizeAddress(address?.split(",")[0]);
  return street && /^\d+\b/.test(street) ? street : "";
}

function normalizeAddress(address?: string | null) {
  return address
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function haveContainingPlaceRelationship(left: CourseIdentity, right: CourseIdentity) {
  const leftId = left.googlePlaceId ?? "";
  const rightId = right.googlePlaceId ?? "";
  return Boolean(
    (rightId && left.containingPlaceIds?.includes(rightId)) ||
      (leftId && right.containingPlaceIds?.includes(leftId))
  );
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}
