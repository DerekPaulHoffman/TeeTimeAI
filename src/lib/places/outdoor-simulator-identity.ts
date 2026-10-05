import { prisma } from "@/lib/prisma";
import type { GooglePlaceReviewIndex } from "@/lib/places/google-place-reviews";

/** A reviewed rental is not evidence that its venue is a public outdoor course. */
export async function loadSimulatorOnlyPlaceIds(): Promise<ReadonlySet<string>> {
  const courses = await prisma.course.findMany({
    where: {
      isPublic: false,
      googlePlaceId: { not: null },
      offerings: { some: { kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC" } }
    },
    select: { googlePlaceId: true }
  });
  return new Set(courses.flatMap((course) => course.googlePlaceId ? [course.googlePlaceId] : []));
}

export function excludeSimulatorOnlyOutdoorCandidates<T extends { googlePlaceId: string }>(
  candidates: readonly T[],
  simulatorOnlyPlaceIds: ReadonlySet<string>,
  reviews: GooglePlaceReviewIndex
): T[] {
  return candidates.filter((candidate) =>
    !simulatorOnlyPlaceIds.has(candidate.googlePlaceId) ||
    reviews.byPlaceId.get(candidate.googlePlaceId)?.accessOverride === "VERIFIED_PUBLIC"
  );
}
