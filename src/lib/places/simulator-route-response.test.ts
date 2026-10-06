import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSimulatorOfferingIndex, type SimulatorOfferingRecord } from "./simulator-offerings";
import { simulatorDiscoveryResponse, simulatorLookupResponse } from "./simulator-route-response";

const mocks = vi.hoisted(() => ({ loadReviews: vi.fn(), loadOfferings: vi.fn(), readCache: vi.fn(), writeCache: vi.fn(),
  searchNearby: vi.fn(), searchByName: vi.fn(), cachePhotos: vi.fn() }));
vi.mock("@/lib/places/google-place-reviews", () => ({ loadActiveGooglePlaceReviewIndex: mocks.loadReviews }));
vi.mock("@/lib/places/simulator-offerings", async (importOriginal) => ({
  ...await importOriginal<typeof import("./simulator-offerings")>(), loadSimulatorOfferingIndex: mocks.loadOfferings
}));
vi.mock("@/lib/places/course-runtime-cache", async (importOriginal) => ({
  ...await importOriginal<typeof import("./course-runtime-cache")>(), readCourseRuntimeCache: mocks.readCache, writeCourseRuntimeCache: mocks.writeCache
}));
vi.mock("@/lib/places/simulator-google", async (importOriginal) => ({
  ...await importOriginal<typeof import("./simulator-google")>(), searchNearbySimulatorVenues: mocks.searchNearby, searchSimulatorVenuesByName: mocks.searchByName
}));
vi.mock("@/lib/places/course-photo-metadata", () => ({ cacheCourseCandidatePhotos: mocks.cachePhotos }));

const row: SimulatorOfferingRecord = {
  id: "rental-1", courseId: "venue-1", active: true, publicAccessStatus: "PUBLIC", bookingUrl: "https://booking.example/simulator",
  evidenceUrl: "https://venue.example/rentals", verifiedAt: new Date("2026-10-01T12:00:00Z"), updatedAt: new Date("2026-10-01T12:00:00Z"),
  maxPartySize: 6, supportedDurationsMinutes: [60], automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN",
  course: { id: "venue-1", googlePlaceId: "place-1", name: "Example Indoor Golf", address: "10 Main St", latitude: 41.24,
    longitude: -73.2, timeZone: "America/New_York", website: "https://venue.example", phone: null }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadReviews.mockResolvedValue({ byPlaceId: new Map(), verifiedPublicCourses: [], reviewVersion: "outdoor-review-1" });
  mocks.loadOfferings.mockResolvedValue(buildSimulatorOfferingIndex([row]));
  mocks.readCache.mockResolvedValue(null);
  mocks.writeCache.mockResolvedValue(undefined);
  mocks.cachePhotos.mockResolvedValue(undefined);
});

describe("simulator discovery response isolation", () => {
  it("rebuilds rental proof and strips outdoor attributes in cached results", async () => {
    mocks.readCache.mockResolvedValue([{ googlePlaceId: "place-1", name: row.course.name, latitude: 41.24, longitude: -73.2,
      timeZone: "America/New_York", layoutHoleCounts: [18], priceEstimate: { label: "$50" }, monitoringReadiness: "READY",
      monitoringSupport: "AUTOMATIC", offeringId: "stale-offering" }]);
    const response = await simulatorLookupResponse({ query: "Example Indoor Golf" });
    const body = await response.json();
    expect(body).toMatchObject({ mode: "SIMULATOR", courses: [{ offeringId: "rental-1", monitoringReadiness: "VERIFYING" }] });
    expect(body.courses[0]).not.toHaveProperty("layoutHoleCounts");
    expect(body.courses[0]).not.toHaveProperty("priceEstimate");
    expect(mocks.readCache).toHaveBeenCalledWith(expect.stringContaining("lookup-simulator-v1:outdoor-review-1:rentals:"));
    expect(mocks.readCache).toHaveBeenCalledWith(expect.stringContaining(":classification:public-rentals-v2"));
  });

  it("checks rental reviews before serving cached discovery and fails closed when they cannot be read", async () => {
    mocks.loadOfferings.mockRejectedValue(new Error("Database unavailable"));
    expect((await simulatorDiscoveryResponse({ latitude: 41.24, longitude: -73.2, radiusMeters: 24140 })).status).toBe(503);
    expect(mocks.readCache).not.toHaveBeenCalled();
    expect(mocks.searchNearby).not.toHaveBeenCalled();
  });

  it("uses only reviewed simulator rentals as the provider-failure fallback", async () => {
    mocks.searchNearby.mockRejectedValue(new Error("Google quota"));
    const response = await simulatorDiscoveryResponse({ latitude: 41.24, longitude: -73.2, radiusMeters: 24140 });
    expect(await response.json()).toMatchObject({ mode: "SIMULATOR", demo: false, courses: [{ googlePlaceId: "place-1", offeringId: "rental-1" }] });
    expect(mocks.writeCache).toHaveBeenCalledWith(expect.stringContaining("discover-simulator-v1:"), expect.any(Array), "course-discovery");
    expect(mocks.readCache).toHaveBeenCalledWith(expect.stringContaining(":classification:public-rentals-v2"));
  });

  it("does not turn an unverified rental into fallback availability", async () => {
    mocks.loadOfferings.mockResolvedValue(buildSimulatorOfferingIndex([{ ...row, verifiedAt: null }]));
    mocks.searchByName.mockRejectedValue(new Error("Google quota"));
    expect((await simulatorLookupResponse({ query: "Example Indoor Golf" })).status).toBe(503);
    expect(mocks.writeCache).not.toHaveBeenCalled();
  });
});
