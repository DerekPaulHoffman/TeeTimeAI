import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";
import {
  buildCoursePriceEstimate,
  buildObservedBookableHoleCounts
} from "@/lib/pricing/course-prices";

const BOOKING_EVIDENCE_LOOKBACK_DAYS = 30;
const COURSE_MATCH_COORDINATE_TOLERANCE = 0.06;

export type PricingCourseRecord = {
  googlePlaceId: string | null;
  name: string;
  latitude: number;
  longitude: number;
  probes: Array<{ observedAt: Date; rawSummary: unknown }>;
  matches: Array<{ priceCents: number | null; holes: number | null; lastConfirmedAt: Date }>;
};

export async function enrichCoursesWithBookingEvidence(candidates: CourseCandidate[], now = new Date()) {
  if (candidates.length === 0) return candidates;
  const latitudes = candidates.map((course) => course.latitude);
  const longitudes = candidates.map((course) => course.longitude);
  const cutoff = new Date(now.getTime() - BOOKING_EVIDENCE_LOOKBACK_DAYS * 86_400_000);
  const bookingEvidence = {
    holes: { in: [9, 18] },
    lastConfirmedAt: { gte: cutoff }
  };
  const courses = await prisma.course.findMany({
    where: {
      latitude: { gte: Math.min(...latitudes) - 0.06, lte: Math.max(...latitudes) + 0.06 },
      longitude: { gte: Math.min(...longitudes) - 0.06, lte: Math.max(...longitudes) + 0.06 },
      OR: [
        { probes: { some: { observedAt: { gte: cutoff } } } },
        { matches: { some: bookingEvidence } }
      ]
    },
    take: 500,
    select: {
      googlePlaceId: true,
      name: true,
      latitude: true,
      longitude: true,
      probes: {
        where: { observedAt: { gte: cutoff } },
        orderBy: { observedAt: "desc" },
        take: 30,
        select: { observedAt: true, rawSummary: true }
      },
      matches: {
        where: bookingEvidence,
        orderBy: { lastConfirmedAt: "desc" },
        take: 200,
        select: { priceCents: true, holes: true, lastConfirmedAt: true }
      }
    }
  });

  return candidates.map((candidate) => {
    const matchedCourse = findPricingCourse(candidate, courses);
    const priceEstimate = matchedCourse ? buildCoursePriceEstimate(matchedCourse) : undefined;
    const bookableHoleCounts = matchedCourse
      ? buildObservedBookableHoleCounts(matchedCourse)
      : [];
    return priceEstimate || bookableHoleCounts.length > 0
      ? {
          ...candidate,
          ...(priceEstimate ? { priceEstimate } : {}),
          ...(bookableHoleCounts.length > 0 ? { bookableHoleCounts } : {})
        }
      : candidate;
  });
}

export function findPricingCourse(
  candidate: Pick<CourseCandidate, "googlePlaceId" | "name" | "latitude" | "longitude">,
  courses: PricingCourseRecord[]
) {
  const exact = courses.find((course) => course.googlePlaceId === candidate.googlePlaceId);
  if (exact) return exact;
  return courses
    .filter((course) =>
      Math.abs(course.latitude - candidate.latitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
      Math.abs(course.longitude - candidate.longitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
      hasMeaningfulNameOverlap(candidate.name, course.name))
    .sort((left, right) => coordinateDistance(candidate, left) - coordinateDistance(candidate, right))[0];
}

function coordinateDistance(candidate: Pick<CourseCandidate, "latitude" | "longitude">, course: PricingCourseRecord) {
  return Math.hypot(course.latitude - candidate.latitude, course.longitude - candidate.longitude);
}

function hasMeaningfulNameOverlap(leftName: string, rightName: string) {
  const left = getMeaningfulNameTokens(leftName);
  const right = getMeaningfulNameTokens(rightName);
  if (left.size === 0 || right.size === 0) return false;
  return [...right].filter((token) => left.has(token)).length >= Math.min(2, right.size);
}

function getMeaningfulNameTokens(name: string) {
  const ignored = new Set(["and", "club", "course", "golf", "park", "the"]);
  return new Set(name.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length > 0 && !ignored.has(token)));
}
