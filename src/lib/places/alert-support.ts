import { getCourseAlertSupport, type BookingMethod } from "@/lib/courses/intelligence";
import {
  findUniqueGenericCourseMatch,
  getCourseDistanceMeters,
  haveCompatibleCourseNames,
  isGenericCourseName,
  type CourseIdentity
} from "@/lib/places/course-identity";
import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

const COURSE_MATCH_COORDINATE_TOLERANCE = 0.06;

type BlockedCourseRecord = CourseIdentity & {
  bookingMethod: BookingMethod;
  automationEligibility: string;
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
      address: true,
      latitude: true,
      longitude: true,
      website: true,
      phone: true,
      bookingMethod: true,
      automationEligibility: true
    }
  });

  return candidates.map((candidate) =>
    mapCourseAlertSupport(candidate, findBlockedCourse(candidate, blockedCourses))
  );
}

function mapCourseAlertSupport(
  candidate: CourseCandidate,
  course: BlockedCourseRecord | undefined
) {
  if (!course) {
    return candidate;
  }

  const alertSupport = getCourseAlertSupport(course);
  return alertSupport ? { ...candidate, alertSupport } : candidate;
}

export function findBlockedCourse(
  candidate: Pick<CourseCandidate, "googlePlaceId" | "name" | "latitude" | "longitude">,
  courses: BlockedCourseRecord[]
) {
  const exact = courses.find((course) => course.googlePlaceId === candidate.googlePlaceId);
  if (exact) {
    return exact;
  }

  const nearbyCourses = courses.filter(
    (course) =>
      Math.abs(course.latitude - candidate.latitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
      Math.abs(course.longitude - candidate.longitude) <= COURSE_MATCH_COORDINATE_TOLERANCE
  );
  if (isGenericCourseName(candidate.name)) {
    return findUniqueGenericCourseMatch(candidate, nearbyCourses);
  }

  return nearbyCourses
    .filter(
      (course) => haveCompatibleCourseNames(candidate.name, course.name)
    )
    .sort(
      (left, right) =>
        getCourseDistanceMeters(candidate, left) - getCourseDistanceMeters(candidate, right)
    )[0];
}
