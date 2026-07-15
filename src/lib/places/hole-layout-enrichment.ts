import {
  normalizeCoursePar,
  normalizeLayoutHoleCounts,
  type CourseLayoutHoleCount
} from "@/lib/courses/course-layout";
import type { CourseCandidate } from "@/lib/places/google";
import { prisma } from "@/lib/prisma";

const COURSE_MATCH_COORDINATE_TOLERANCE = 0.02;
const COURSE_NAME_STOP_WORDS = new Set([
  "and",
  "club",
  "course",
  "golf",
  "park",
  "the"
]);

export type CourseLayoutRecord = {
  googlePlaceId: string | null;
  name: string;
  latitude: number;
  longitude: number;
  layoutHoleCounts: number[];
  layoutHolesEvidenceUrl: string | null;
  layoutHolesVerifiedAt: Date | null;
  par: number | null;
  parEvidenceUrl: string | null;
  parVerifiedAt: Date | null;
};

export async function enrichCoursesWithHoleLayouts(candidates: CourseCandidate[]) {
  if (candidates.length === 0) {
    return candidates;
  }

  const persistedCourses = await findPersistedLayoutCourses(candidates);

  return candidates.map((candidate) => {
    const persistedCourse = findCourseLayout(candidate, persistedCourses);
    if (!persistedCourse) {
      return { ...candidate, layoutHolesStatus: "UNVERIFIED" as const };
    }

    const layoutHoleCounts = persistedCourse.layoutHolesVerifiedAt
      ? normalizeLayoutHoleCounts(persistedCourse.layoutHoleCounts)
      : [];
    const par = persistedCourse.parVerifiedAt
      ? normalizeCoursePar(persistedCourse.par)
      : undefined;
    return {
      ...candidate,
      layoutHolesStatus: layoutHoleCounts.length > 0
        ? "VERIFIED" as const
        : "UNVERIFIED" as const,
      ...(layoutHoleCounts.length > 0 ? { layoutHoleCounts } : {}),
      ...(layoutHoleCounts.length > 0 && persistedCourse.layoutHolesEvidenceUrl
        ? { layoutHolesEvidenceUrl: persistedCourse.layoutHolesEvidenceUrl }
        : {}),
      ...(layoutHoleCounts.length > 0 && persistedCourse.layoutHolesVerifiedAt
        ? { layoutHolesVerifiedAt: persistedCourse.layoutHolesVerifiedAt.toISOString() }
        : {}),
      ...(par !== undefined ? { par } : {}),
      ...(par !== undefined && persistedCourse.parEvidenceUrl
        ? { parEvidenceUrl: persistedCourse.parEvidenceUrl }
        : {}),
      ...(par !== undefined && persistedCourse.parVerifiedAt
        ? { parVerifiedAt: persistedCourse.parVerifiedAt.toISOString() }
        : {})
    };
  });
}

export function findCourseLayout(
  candidate: Pick<CourseCandidate, "googlePlaceId" | "name" | "latitude" | "longitude">,
  courses: CourseLayoutRecord[]
) {
  const exact = courses.find(
    (course) =>
      Boolean(course.googlePlaceId) && course.googlePlaceId === candidate.googlePlaceId
  );
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

async function findPersistedLayoutCourses(candidates: CourseCandidate[]) {
  const latitudes = candidates.map((course) => course.latitude);
  const longitudes = candidates.map((course) => course.longitude);
  const googlePlaceIds = candidates.map((course) => course.googlePlaceId).filter(Boolean);

  return prisma.course.findMany({
    where: {
      OR: [
        ...(googlePlaceIds.length > 0
          ? [{ googlePlaceId: { in: googlePlaceIds } }]
          : []),
        {
          latitude: {
            gte: Math.min(...latitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
            lte: Math.max(...latitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
          },
          longitude: {
            gte: Math.min(...longitudes) - COURSE_MATCH_COORDINATE_TOLERANCE,
            lte: Math.max(...longitudes) + COURSE_MATCH_COORDINATE_TOLERANCE
          }
        }
      ]
    },
    take: 500,
    select: {
      googlePlaceId: true,
      name: true,
      latitude: true,
      longitude: true,
      layoutHoleCounts: true,
      layoutHolesEvidenceUrl: true,
      layoutHolesVerifiedAt: true,
      par: true,
      parEvidenceUrl: true,
      parVerifiedAt: true
    }
  });
}

function coordinateDistance(
  candidate: Pick<CourseCandidate, "latitude" | "longitude">,
  course: Pick<CourseLayoutRecord, "latitude" | "longitude">
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

export type { CourseLayoutHoleCount };
