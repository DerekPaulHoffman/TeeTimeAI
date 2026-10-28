import type { Course } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeLayoutHoleCounts } from "@/lib/courses/course-layout";
import { readSharedFacilityScope } from "./shared-facility-scope";
import type { CourseCandidate } from "@/lib/places/google";
import { isForeupMetadata } from "@/lib/adapters/foreup";

function scopedBookingUrl(course: Course): string | undefined {
  if (course.providerFamilyKey === "FOREUP" && isForeupMetadata(course.bookingMetadata)) {
    try {
      const metadata = course.bookingMetadata;
      const url = new URL(metadata.bookingBaseUrl);
      const match = /^\/index\.php\/booking\/([1-9]\d{0,9})(?:\/[1-9]\d{0,9})?\/?$/u.exec(url.pathname);
      if (url.protocol === "https:" && url.hostname === "foreupsoftware.com" && !url.username && !url.password && !url.search && match && Number.isSafeInteger(metadata.scheduleId) && metadata.scheduleId > 0) {
        return `https://foreupsoftware.com/index.php/booking/${match[1]}/${metadata.scheduleId}#/teetimes`;
      }
    } catch { /* Keep the stored official source when it cannot be scoped. */ }
  }
  return course.detectedBookingUrl ?? course.website ?? undefined;
}

export function mapFacilityCourse(course: Course, root: Course, candidate?: CourseCandidate): CourseCandidate {
  return {
    googlePlaceId: root.googlePlaceId ?? "", courseId: course.id, name: course.name,
    address: course.address ?? undefined, latitude: course.latitude, longitude: course.longitude,
    timeZone: course.timeZone, website: scopedBookingUrl(course),
    publicAccessStatus: course.isPublic === true ? "PUBLIC" : "UNVERIFIED", mode: "OUTDOOR",
    layoutHoleCounts: course.layoutHolesVerifiedAt ? normalizeLayoutHoleCounts(course.layoutHoleCounts) : [],
    ...(course.layoutHolesEvidenceUrl ? { layoutHolesEvidenceUrl: course.layoutHolesEvidenceUrl } : {}),
    ...(course.layoutHolesVerifiedAt ? { layoutHolesVerifiedAt: course.layoutHolesVerifiedAt.toISOString() } : {}),
    photoReference: candidate?.photoReference, photoAttributions: candidate?.photoAttributions,
    distanceMeters: candidate?.distanceMeters,
  };
}

export async function loadSharedFacilityCourses(course: { id: string; bookingMetadata: unknown }): Promise<CourseCandidate[]> {
  const scope = readSharedFacilityScope(course.bookingMetadata, course.id);
  if (!scope) return [];
  const rows = await prisma.course.findMany({ where: { id: { in: scope.courseIds } } });
  const root = rows.find(row => row.id === scope.rootCourseId);
  // All members must agree on the same stored group; partial/stale membership
  // never widens an existing alert or inherits the root's monitoring proof.
  if (!root || root.isPublic !== true || rows.length !== scope.courseIds.length || rows.some(row => {
    const member = readSharedFacilityScope(row.bookingMetadata, row.id);
    return row.isPublic === false || !member || JSON.stringify(member) !== JSON.stringify(scope);
  })) return [];
  return scope.courseIds.map(id => mapFacilityCourse(rows.find(row => row.id === id)!, root));
}

