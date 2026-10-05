import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGooglePlaceReviewIndex, type GooglePlaceReviewRecord } from "./google-place-reviews";
import type { GooglePlace } from "./google";
import { filterSimulatorPlaces, searchNearbySimulatorVenues, searchSimulatorVenuesByName } from "./simulator-google";
import { buildSimulatorOfferingIndex, type SimulatorOfferingRecord } from "./simulator-offerings";

const reviews = buildGooglePlaceReviewIndex([]);
const emptyOfferings = buildSimulatorOfferingIndex([]);
const place: GooglePlace = { id: "place-1", displayName: { text: "Example Indoor Golf" },
  primaryType: "indoor_golf_course", types: ["indoor_golf_course"], businessStatus: "OPERATIONAL",
  location: { latitude: 41.24, longitude: -73.2 }, websiteUri: "https://venue.example" };
const oldKey = process.env.GOOGLE_PLACES_API_KEY;
afterEach(() => { vi.unstubAllGlobals(); if (oldKey === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = oldKey; });

describe("simulator Places discovery", () => {
  it("allows a private bay but rejects members-only facilities and non-rental fittings", () => {
    const records = [place, { ...place, id: "private-bay", displayName: { text: "Example Indoor Golf Private Bays" } },
      { ...place, id: "members", displayName: { text: "Members Only Indoor Golf" } },
      { ...place, id: "fitting", displayName: { text: "Indoor Golf Club Fitting" } }];
    expect(filterSimulatorPlaces(records, reviews, emptyOfferings).map((item) => item.id)).toEqual(["place-1", "private-bay"]);
  });

  it("retains outdoor simulator exclusions without bypassing other exact exclusions", () => {
    const facts = [review("place-1", "INDOOR_SIMULATOR"), review("bad", "NON_COURSE_PARKING")];
    const index = buildGooglePlaceReviewIndex(facts);
    expect(filterSimulatorPlaces([place, { ...place, id: "bad" }], index, emptyOfferings)).toEqual([place]);
  });

  it("queries indoor secondary types and bounded text, then enforces the actual radius", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ places: [place,
      { ...place, id: "far", location: { latitude: 43, longitude: -73 } }] }), { status: 200 }));
    // Each network response must have its own readable body.
    fetch.mockImplementation(async () => new Response(JSON.stringify({ places: [place,
      { ...place, id: "far", location: { latitude: 43, longitude: -73 } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const courses = await searchNearbySimulatorVenues({ latitude: 41.24, longitude: -73.2, radiusMeters: 24140 }, reviews, emptyOfferings);
    expect(courses).toHaveLength(1);
    expect(courses[0]).toMatchObject({ mode: "SIMULATOR", publicAccessStatus: "UNVERIFIED" });
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies[0]).toMatchObject({ includedTypes: ["indoor_golf_course"], maxResultCount: 20 });
    expect(bodies[1].textQuery).toBe("golf simulators");
    expect(bodies[2].textQuery).toBe("indoor golf");
  });

  it("does not force simulator name lookup into the outdoor golf-course type", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ places: [place] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await searchSimulatorVenuesByName({ query: "Example Indoor Golf" }, reviews, emptyOfferings)).toHaveLength(1);
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty("includedType");
    expect(body).not.toHaveProperty("strictTypeFiltering");
  });

  it("preserves neighboring same-name branches unless an exact alias is reviewed", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const second = { ...place, id: "place-2", location: { latitude: 41.241, longitude: -73.201 } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [place, second] }), { status: 200 })));
    expect(await searchSimulatorVenuesByName({ query: "Example Indoor Golf" }, reviews, emptyOfferings)).toHaveLength(2);
  });

  it("uses independent public rental evidence despite an outdoor private classification", () => {
    const index = buildGooglePlaceReviewIndex([review("place-1", "PRIVATE_MEMBER_CONTROLLED", "VERIFIED_PRIVATE")]);
    const offering = { id: "rental-1", courseId: "course-1", active: true, publicAccessStatus: "PUBLIC",
      bookingUrl: "https://booking.example", evidenceUrl: "https://venue.example/public-rental", verifiedAt: new Date(),
      updatedAt: new Date(), maxPartySize: 4, supportedDurationsMinutes: [60], automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN",
      course: { id: "course-1", googlePlaceId: "place-1", name: "Venue", address: null, latitude: 41.24, longitude: -73.2,
        timeZone: "America/New_York", website: "https://venue.example", phone: null } } satisfies SimulatorOfferingRecord;
    expect(filterSimulatorPlaces([place], index, buildSimulatorOfferingIndex([offering]))).toEqual([place]);
  });
});

function review(googlePlaceId: string, classification: string, accessOverride: GooglePlaceReviewRecord["accessOverride"] = "VERIFIED_NON_COURSE"): GooglePlaceReviewRecord {
  return { googlePlaceId, name: "Reviewed Venue", classification, accessOverride, evidenceUrl: "https://venue.example", reviewedAt: new Date(), active: true,
    canonicalPlaceId: null, canonicalName: null, canonicalAddress: null, canonicalWebsiteUrl: null, canonicalPhone: null,
    latitude: null, longitude: null, retainWhenCanonicalAbsent: false };
}
