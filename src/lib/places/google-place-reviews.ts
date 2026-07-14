import { prisma } from "@/lib/prisma";

export type GooglePlaceAccessOverrideValue =
  | "VERIFIED_PUBLIC"
  | "VERIFIED_PRIVATE"
  | "VERIFIED_NON_COURSE";

export type GooglePlaceReviewRecord = {
  googlePlaceId: string;
  accessOverride: GooglePlaceAccessOverrideValue | null;
  name: string;
  classification: string;
  evidenceUrl: string;
  reviewedAt: Date;
  active: boolean;
  canonicalPlaceId: string | null;
  canonicalName: string | null;
  canonicalAddress: string | null;
  canonicalWebsiteUrl: string | null;
  canonicalPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  retainWhenCanonicalAbsent: boolean;
};

export type GooglePlaceReviewIndex = {
  byPlaceId: ReadonlyMap<string, GooglePlaceReviewRecord>;
  verifiedPublicCourses: readonly GooglePlaceReviewRecord[];
};

const EMPTY_VERIFIED_PUBLIC_COURSES: readonly GooglePlaceReviewRecord[] = [];

export const EMPTY_GOOGLE_PLACE_REVIEW_INDEX: GooglePlaceReviewIndex = {
  byPlaceId: new Map(),
  verifiedPublicCourses: EMPTY_VERIFIED_PUBLIC_COURSES
};

export class GooglePlaceReviewsUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Google Place reviews are temporarily unavailable", { cause });
    this.name = "GooglePlaceReviewsUnavailableError";
  }
}

export function buildGooglePlaceReviewIndex(
  rows: readonly GooglePlaceReviewRecord[]
): GooglePlaceReviewIndex {
  // PostgreSQL row order is unspecified. Stable place-ID ordering keeps alias fallback
  // deterministic when more than one retained alias points at the same canonical course.
  const activeRows = rows
    .filter((row) => row.active)
    .sort((left, right) => {
      if (left.googlePlaceId < right.googlePlaceId) return -1;
      if (left.googlePlaceId > right.googlePlaceId) return 1;
      return 0;
    });
  const verifiedPublicCourses = activeRows.filter(
    (row) => row.accessOverride === "VERIFIED_PUBLIC"
  );

  return {
    byPlaceId: new Map(activeRows.map((row) => [row.googlePlaceId, row])),
    verifiedPublicCourses
  };
}

export async function loadActiveGooglePlaceReviewIndex(): Promise<GooglePlaceReviewIndex> {
  try {
    const rows = await prisma.googlePlaceReview.findMany({
      where: { active: true },
      orderBy: { googlePlaceId: "asc" },
      select: {
        googlePlaceId: true,
        accessOverride: true,
        name: true,
        classification: true,
        evidenceUrl: true,
        reviewedAt: true,
        active: true,
        canonicalPlaceId: true,
        canonicalName: true,
        canonicalAddress: true,
        canonicalWebsiteUrl: true,
        canonicalPhone: true,
        latitude: true,
        longitude: true,
        retainWhenCanonicalAbsent: true
      }
    });

    return buildGooglePlaceReviewIndex(rows);
  } catch (error) {
    throw new GooglePlaceReviewsUnavailableError(error);
  }
}
