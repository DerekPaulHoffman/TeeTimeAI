import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: mocks.findMany } } }));

import { excludeSimulatorOnlyOutdoorCandidates, loadSimulatorOnlyPlaceIds } from "./outdoor-simulator-identity";
import { EMPTY_GOOGLE_PLACE_REVIEW_INDEX, buildGooglePlaceReviewIndex } from "./google-place-reviews";
import { filterPublicGolfCoursePlaces, mapGooglePlaceToCourseCandidate, type GooglePlace } from "./google";
import type { GooglePlaceReviewRecord } from "./google-place-reviews";

describe("outdoor simulator identity fence", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads only active reviewed rentals on explicitly non-public outdoor venue identities", async () => {
    mocks.findMany.mockResolvedValue([{ googlePlaceId: "sim-only" }]);
    await expect(loadSimulatorOnlyPlaceIds()).resolves.toEqual(new Set(["sim-only"]));
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { isPublic: false, googlePlaceId: { not: null }, offerings: { some: {
        kind: "SIMULATOR", active: true, publicAccessStatus: "PUBLIC"
      } } },
      select: { googlePlaceId: true }
    });
  });

  it("excludes simulator-only identities but preserves genuine dual-use public courses", () => {
    const candidates = [
      { googlePlaceId: "sim-only" }, { googlePlaceId: "dual-use" }, { googlePlaceId: "outdoor" }
    ];
    const excluded = new Set(["sim-only", "dual-use"]);
    expect(excludeSimulatorOnlyOutdoorCandidates(candidates, excluded, EMPTY_GOOGLE_PLACE_REVIEW_INDEX))
      .toEqual([{ googlePlaceId: "outdoor" }]);
    const reviewed = buildGooglePlaceReviewIndex([{
      googlePlaceId: "dual-use", accessOverride: "VERIFIED_PUBLIC", active: true,
      name: "Dual-use public course", classification: "PUBLIC_GOLF_COURSE", evidenceUrl: "https://example.com/evidence",
      reviewedAt: new Date(), canonicalPlaceId: null, canonicalName: null, canonicalAddress: null,
      canonicalWebsiteUrl: null, canonicalPhone: null, latitude: null, longitude: null,
      retainWhenCanonicalAbsent: false
    }]);
    expect(excludeSimulatorOnlyOutdoorCandidates(candidates, excluded, reviewed))
      .toEqual([{ googlePlaceId: "dual-use" }, { googlePlaceId: "outdoor" }]);
  });

  it("keeps the Whitney Farms public course while excluding its exact simulator alias before outdoor dedupe", () => {
    const index = buildGooglePlaceReviewIndex([playersClubAlias]);
    // Give the simulator alias an erroneous outdoor type to prove its exact non-course review wins.
    const filtered = filterPublicGolfCoursePlaces([whitneyCourse, playersClubOutdoorShape], { reviewIndex: index });
    expect(filtered).toEqual([whitneyCourse]);
    expect(filtered.map((place) => mapGooglePlaceToCourseCandidate(place, index))).toEqual([
      expect.objectContaining({ googlePlaceId: whitneyCourse.id, website: "https://www.whitneyfarmsgc.com/" })
    ]);
    expect(filterPublicGolfCoursePlaces([playersClubOutdoorShape], { reviewIndex: index })).toEqual([]);
    expect(index.verifiedPublicCourses).toEqual([]);
    expect(index.byPlaceId.get(playersClubAlias.googlePlaceId)?.accessOverride).toBe("VERIFIED_NON_COURSE");
  });

  it("does not promote an outdoor private canonical identity through the Whitney Farms simulator alias", () => {
    const privateCourse: GooglePlaceReviewRecord = {
      ...playersClubAlias, googlePlaceId: whitneyCourse.id as string, name: whitneyCourse.displayName?.text as string,
      accessOverride: "VERIFIED_PRIVATE", classification: "PRIVATE_MEMBER_CONTROLLED", canonicalPlaceId: null,
      canonicalName: null, canonicalAddress: null, canonicalWebsiteUrl: null, canonicalPhone: null,
      retainWhenCanonicalAbsent: false
    };
    const index = buildGooglePlaceReviewIndex([playersClubAlias, privateCourse]);
    expect(filterPublicGolfCoursePlaces([whitneyCourse, playersClubOutdoorShape], { reviewIndex: index })).toEqual([]);
    expect(index.byPlaceId.get(whitneyCourse.id as string)?.accessOverride).toBe("VERIFIED_PRIVATE");
    expect(index.verifiedPublicCourses).toEqual([]);
  });
});

const whitneyCourse: GooglePlace = {
  id: "ChIJZ3Rrpzzi54kR_g0Sly9n8Bc", displayName: { text: "Chris Bargas Golf Club at Whitney Farms" },
  primaryType: "golf_course", types: ["golf_course", "indoor_golf_course"], businessStatus: "OPERATIONAL",
  formattedAddress: "175 Shelton Rd, Monroe, CT 06468, USA", websiteUri: "https://www.whitneyfarmsgc.com/",
  location: { latitude: 41.304, longitude: -73.213 }
};
const playersClubOutdoorShape: GooglePlace = {
  ...whitneyCourse, id: "ChIJDb2t7lHj54kRl0o341PUdx0", displayName: { text: "The Players Club at Whitney Farms Golf Club" }
};
const playersClubAlias: GooglePlaceReviewRecord = {
  googlePlaceId: playersClubOutdoorShape.id as string, name: playersClubOutdoorShape.displayName?.text as string,
  accessOverride: "VERIFIED_NON_COURSE", classification: "INDOOR_SIMULATOR", active: true,
  evidenceUrl: "https://www.whitneyfarmsgc.com/the-players-club-trackman-simulators", reviewedAt: new Date("2026-10-06T00:00:00Z"),
  canonicalPlaceId: whitneyCourse.id as string, canonicalName: whitneyCourse.displayName?.text as string,
  canonicalAddress: whitneyCourse.formattedAddress as string, canonicalWebsiteUrl: "https://www.whitneyfarmsgc.com/",
  canonicalPhone: "(203) 268-0707", latitude: null, longitude: null, retainWhenCanonicalAbsent: true
};
