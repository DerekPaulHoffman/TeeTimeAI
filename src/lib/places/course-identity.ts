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
