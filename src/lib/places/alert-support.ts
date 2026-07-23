import {
  getCourseAlertSupport,
  getCourseMonitoringSupport,
  type AutomationReason,
  type BookingAccessMode,
  type BookingMethod
} from "@/lib/courses/intelligence";
import {
  findUniqueGenericCourseMatch,
  getCourseDistanceMeters,
  haveCompatibleCourseNames,
  haveStrongCourseIdentityLink,
  isGenericCourseName,
  type CourseIdentity
} from "@/lib/places/course-identity";
import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

const COURSE_MATCH_COORDINATE_TOLERANCE = 0.06;

type KnownCourseRecord = CourseIdentity & {
  id: string;
  bookingMethod: BookingMethod;
  bookingAccessMode: BookingAccessMode;
  automationEligibility: string;
  automationReason: AutomationReason;
  detectedBookingUrl?: string | null;
  profile?: { canonicalSlug: string; status: string } | null;
};

export async function enrichCoursesWithAlertSupport(candidates: CourseCandidate[]) {
  if (candidates.length === 0) {
    return candidates;
  }

  const latitudes = candidates.map((course) => course.latitude);
  const longitudes = candidates.map((course) => course.longitude);
  const knownCourses = await prisma.course.findMany({
    where: {
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
      id: true,
      googlePlaceId: true,
      name: true,
      address: true,
      latitude: true,
      longitude: true,
      website: true,
      phone: true,
      bookingMethod: true,
      bookingAccessMode: true,
      automationEligibility: true,
      automationReason: true,
      detectedBookingUrl: true,
      profile: { select: { canonicalSlug: true, status: true } }
    }
  });

  return candidates.map((candidate) =>
    mapCourseAlertSupport(candidate, findKnownCourse(candidate, knownCourses))
  );
}

function mapCourseAlertSupport(
  candidate: CourseCandidate,
  course: KnownCourseRecord | undefined
) {
  const monitoringSupport = getCourseMonitoringSupport(course);
  if (!course) {
    return { ...candidate, monitoringSupport };
  }

  const candidateWithOfficialBooking =
    course.bookingMethod === "PUBLIC_ONLINE" && course.detectedBookingUrl
      ? { ...candidate, website: course.detectedBookingUrl }
      : candidate;
  const candidateWithProfile = {
    ...candidateWithOfficialBooking,
    courseId: course.id,
    ...(course.profile?.status === "PUBLISHED"
      ? { profileUrl: `/courses/${course.profile.canonicalSlug}` }
      : {})
  };
  const alertSupport = getCourseAlertSupport(course);
  return alertSupport
    ? { ...candidateWithProfile, alertSupport, monitoringSupport }
    : { ...candidateWithProfile, monitoringSupport };
}

export function findKnownCourse(
  candidate: Pick<
    CourseCandidate,
    | "googlePlaceId"
    | "name"
    | "address"
    | "latitude"
    | "longitude"
    | "website"
    | "phone"
  >,
  courses: KnownCourseRecord[]
) {
  const exact = courses.find((course) => course.googlePlaceId === candidate.googlePlaceId);
  if (exact?.automationEligibility === "ALLOWED" || exact?.automationEligibility === "BLOCKED") {
    return exact;
  }

  const nearbyCourses = courses.filter(
    (course) =>
      Math.abs(course.latitude - candidate.latitude) <= COURSE_MATCH_COORDINATE_TOLERANCE &&
      Math.abs(course.longitude - candidate.longitude) <= COURSE_MATCH_COORDINATE_TOLERANCE
  );
  const linkedAllowedCourses = nearbyCourses.filter(
    (course) =>
      course.automationEligibility === "ALLOWED" &&
      haveCompatibleCourseNames(candidate.name, course.name) &&
      haveStrongCourseIdentityLink(candidate, course)
  );
  if (linkedAllowedCourses.length === 1) {
    return linkedAllowedCourses[0];
  }
  if (exact) {
    return exact;
  }
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
