import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

const COURSE_MATCH_COORDINATE_TOLERANCE = 0.06;
const COURSE_NAME_STOP_WORDS = new Set(["and", "club", "course", "golf", "park", "the"]);

type BlockedCourseRecord = {
  googlePlaceId: string | null;
  name: string;
  latitude: number;
  longitude: number;
};

export async function enrichCoursesWithAlertSupport(candidates: CourseCandidate[]) {
  if (candidates.length === 0) {
    return candidates;
  }

  const latitudes = candidates.map((course) => course.latitude);
  const longitudes = candidates.map((course) => course.longitude);
  const blockedCourses = await prisma.course.findMany({
    where: {
      automationEligibility: "BLOCKED",
      latitude: {
        gte: Math.min(...latitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
        lte: Math.max(...latitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
      },
      longitude: {
        gte: Math.min(...longitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
        lte: Math.max(...longitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
      }
    },
    take: 500,
    select: {
      googlePlaceId: true,
      name: true,
      latitude: true,
      longitude: true
    }
  });

  return candidates.map((candidate) =>
    findBlockedCourse(candidate, blockedCourses)
      ? { ...candidate, alertSupport: "OFFICIAL_SITE_ONLY" as const }
      : candidate
  );
}

export function findBlockedCourse(
  candidate: Pick<CourseCandidate, "googlePlaceId" | "name" | "latitude" | "longitude">,
  courses: BlockedCourseRecord[]
) {
  const exact = courses.find((course) => course.googlePlaceId === candidate.googlePlaceId);
  if (exact) {
    return exact;
  }

  return courses
    .filter(
      (course) =>
        Math.abs(course.latitude - candidate.latitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
        Math.abs(course.longitude - candidate.longitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
        hasMeaningfulNameOverlap(candidate.name, course.name)
    )
    .sort(
      (left, right) =>
        coordinateDistance(candidate, left) - coordinateDistance(candidate, right)
    )[0];
}

function coordinateDistance(
  candidate: Pick<CourseCandidate, "latitude" | "longitude">,
  course: Pick<BlockedCourseRecord, "latitude" | "longitude">
) {
  return Math.hypot(
    course.latitude - candidate.latitude,
    course.longitude - candidate.longitude
  );
}

function hasMeaningfulNameOverlap(leftName: string, rightName: string) {
  const left = getMeaningfulNameTokens(leftName);
  const right = getMeaningfulNameTokens(rightName);
  if (left.size === 0 || right.size === 0) {
    return false;
  }

  return [...right].filter((token) => left.has(token)).length >= Math.min(2, right.size);
}

function getMeaningfulNameTokens(name: string) {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((token) => token.length > 0 && !COURSE_NAME_STOP_WORDS.has(token))
  );
}
