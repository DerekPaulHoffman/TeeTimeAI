import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { course: { findMany: mocks.findMany } } }));

import { excludeSimulatorOnlyOutdoorCandidates, loadSimulatorOnlyPlaceIds } from "./outdoor-simulator-identity";
import { EMPTY_GOOGLE_PLACE_REVIEW_INDEX, buildGooglePlaceReviewIndex } from "./google-place-reviews";

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
});
