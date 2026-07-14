import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";

import {
  buildGooglePlaceReviewIndex,
  GooglePlaceReviewsUnavailableError,
  loadActiveGooglePlaceReviewIndex,
  type GooglePlaceReviewRecord
} from "./google-place-reviews";

vi.mock("@/lib/prisma", () => ({
  prisma: { googlePlaceReview: { findMany: vi.fn() } }
}));

const mockedPrisma = vi.mocked(prisma, { deep: true });

describe("Google Place review index", () => {
  beforeEach(() => vi.clearAllMocks());

  it("indexes active reviews and exposes verified public courses", () => {
    const activePublic = review({ accessOverride: "VERIFIED_PUBLIC" });
    const inactive = review({ googlePlaceId: "inactive", active: false });

    const index = buildGooglePlaceReviewIndex([activePublic, inactive]);

    expect(index.byPlaceId.get(activePublic.googlePlaceId)).toBe(activePublic);
    expect(index.byPlaceId.has(inactive.googlePlaceId)).toBe(false);
    expect(index.verifiedPublicCourses).toEqual([activePublic]);
  });

  it("orders exact-ID reviews deterministically for alias preference", () => {
    const index = buildGooglePlaceReviewIndex([
      review({ googlePlaceId: "place-z" }),
      review({ googlePlaceId: "place-a" })
    ]);

    expect([...index.byPlaceId.keys()]).toEqual(["place-a", "place-z"]);
  });

  it("loads active rows once with a narrow projection", async () => {
    mockedPrisma.googlePlaceReview.findMany.mockResolvedValue([review()] as never);

    const index = await loadActiveGooglePlaceReviewIndex();

    expect(index.byPlaceId.has("place-1")).toBe(true);
    expect(mockedPrisma.googlePlaceReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
  });

  it("wraps database failures in the public unavailable error", async () => {
    const databaseError = new Error("connection details that must stay internal");
    mockedPrisma.googlePlaceReview.findMany.mockRejectedValue(databaseError);

    await expect(loadActiveGooglePlaceReviewIndex()).rejects.toMatchObject({
      name: "GooglePlaceReviewsUnavailableError",
      message: "Google Place reviews are temporarily unavailable",
      cause: databaseError
    });
    await expect(loadActiveGooglePlaceReviewIndex()).rejects.toBeInstanceOf(
      GooglePlaceReviewsUnavailableError
    );
  });
});

function review(overrides: Partial<GooglePlaceReviewRecord> = {}): GooglePlaceReviewRecord {
  return {
    googlePlaceId: "place-1",
    accessOverride: null,
    name: "Example Golf Course",
    classification: "PUBLIC_GOLF_COURSE",
    evidenceUrl: "https://example.com/golf",
    reviewedAt: new Date("2026-07-14T00:00:00.000Z"),
    active: true,
    canonicalPlaceId: null,
    canonicalName: null,
    canonicalAddress: null,
    canonicalWebsiteUrl: null,
    canonicalPhone: null,
    latitude: null,
    longitude: null,
    retainWhenCanonicalAbsent: false,
    ...overrides
  };
}
