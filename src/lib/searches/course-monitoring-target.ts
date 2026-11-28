import type { Prisma } from "@prisma/client";

export function legacyOutdoorOfferingId(courseId: string) {
  // The simulator migration assigned this compatibility-only ID to outdoor rows.
  return `outdoor-${courseId}`;
}

export function isCanonicalLegacyOutdoorOffering(courseId: string, offeringId: string | null | undefined,
  offering: { id: string; courseId: string; kind: string } | null | undefined) {
  return Boolean(offering && offeringId === legacyOutdoorOfferingId(courseId) &&
    offering.id === offeringId && offering.courseId === courseId && offering.kind === "OUTDOOR");
}

/** Outdoor targets are course-scoped. Simulator targets must keep their exact offering ID. */
export function courseMonitoringPreferenceTarget(target: { courseId: string; offeringId?: string | null }): Prisma.CoursePreferenceWhereInput {
  if (target.offeringId) return { courseId: target.courseId, offeringId: target.offeringId };
  return { courseId: target.courseId, OR: [
    { offeringId: null },
    { offeringId: legacyOutdoorOfferingId(target.courseId), offering: { is: { kind: "OUTDOOR", courseId: target.courseId } } },
  ] };
}
