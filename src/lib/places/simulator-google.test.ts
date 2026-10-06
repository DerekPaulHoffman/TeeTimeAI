import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGooglePlaceReviewIndex, type GooglePlaceReviewRecord } from "./google-place-reviews";
import type { GooglePlace } from "./google";
import { filterSimulatorPlaces, getSimulatorVenueForDemand, searchNearbySimulatorVenues, searchSimulatorVenuesByName } from "./simulator-google";
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

  it("excludes a reviewed members-only simulator even when its outdoor access is unclassified", () => {
    const facts = buildGooglePlaceReviewIndex([review("place-1", "MEMBERS_ONLY_SIMULATOR", null)]);
    expect(filterSimulatorPlaces([place], facts, emptyOfferings)).toEqual([]);
  });

  it("refreshes the exact provider identity for pending demand and retains canonical alias correction", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetch = vi.fn(async () => new Response(JSON.stringify(whitneyPlayersClub), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const candidate = await getSimulatorVenueForDemand(whitneyPlayersClub.id as string,
      buildGooglePlaceReviewIndex([whitneySimulatorAlias()]));
    expect(candidate).toMatchObject({ googlePlaceId: whitneyCourse.id,
      name: whitneyCourse.displayName?.text, website: "https://www.whitneyfarmsgc.com/" });
    expect(fetch.mock.calls[0][0]).toBe(`https://places.googleapis.com/v1/places/${whitneyPlayersClub.id}`);
  });

  it("saves safe provider identity without passing a private or credential-bearing source URL", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    for (const websiteUri of ["http://127.0.0.1/", "https://secret:token@venue.example/"]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...place, websiteUri }), { status: 200 })));
      expect((await getSimulatorVenueForDemand("place-1", reviews)).website).toBeUndefined();
    }
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...place, websiteUri: undefined }), { status: 200 })));
    expect((await getSimulatorVenueForDemand("place-1", reviews)).website).toBeUndefined();
  });

  it("rejects a mismatched provider ID and never fetches an arbitrary input URL", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...place, id: "different-place" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(getSimulatorVenueForDemand("place-1", reviews)).rejects.toThrow(/could not be confirmed/i);
    await expect(getSimulatorVenueForDemand("https://127.0.0.1/admin", reviews)).rejects.toThrow(/invalid/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["direct", "canonical alias"])("does not recover a %s private rental from saved provisional demand", async (identity) => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const pending = { id: "rental-1", courseId: "course-1", active: true, publicAccessStatus: "UNVERIFIED",
      bookingUrl: null, evidenceUrl: null, verifiedAt: null, updatedAt: new Date(), maxPartySize: null,
      supportedDurationsMinutes: [], automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN",
      course: { id: "course-1", googlePlaceId: "place-1", name: "Venue", address: null,
        latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", website: null, phone: null },
    } satisfies SimulatorOfferingRecord;
    const facts = buildGooglePlaceReviewIndex(identity === "direct"
      ? [review("place-1", "MEMBERS_ONLY_SIMULATOR", null)]
      : [{ ...review("place-1", "INDOOR_SIMULATOR"), canonicalPlaceId: "canonical-members-only" },
        review("canonical-members-only", "MEMBERS_ONLY_SIMULATOR", null)]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [] }), { status: 200 })));
    expect(await searchNearbySimulatorVenues({ latitude: 41.24, longitude: -73.2 }, facts,
      buildSimulatorOfferingIndex([pending]))).toEqual([]);
  });

  it("does not mistake a residential website or unrelated text match for a simulator rental", () => {
    const residence = { ...place, id: "residence", displayName: { text: "Taunton Residences at Deep Brook" },
      websiteUri: "https://www.tauntonapts.com/", primaryType: "apartment_complex", types: ["apartment_complex"] };
    const records = [residence, { ...residence, id: "missing-residential-type", primaryType: undefined, types: [] },
      { ...place, id: "unrelated", displayName: { text: "Example Sportsplex" }, primaryType: "sports_complex", types: ["sports_complex"] },
      { ...place, id: "golf-apartments", displayName: { text: "Golf View Apartments" }, primaryType: "apartment_building", types: ["apartment_building"] }];
    expect(filterSimulatorPlaces(records, reviews, emptyOfferings)).toEqual([]);
  });

  it("retains genuine golf hybrids and indoor venues without claiming verified rental access", () => {
    const records = [
      { ...place, id: "oasis", displayName: { text: "Golf Oasis CT" }, primaryType: "bar", types: ["bar"] },
      { ...place, id: "whitney", displayName: { text: "Chris Bargas Golf Club at Whitney Farms" }, primaryType: "golf_course", types: ["golf_course"] },
      { ...place, id: "lounge", displayName: { text: "Golf Lounge 18" }, primaryType: "bar", types: ["bar"] },
      { ...place, id: "hybrid", displayName: { text: "Example Sportsplex" }, primaryType: "sports_complex", types: ["sports_complex", "indoor_golf_course"] }
    ];
    expect(filterSimulatorPlaces(records, reviews, emptyOfferings)).toEqual(records);
  });

  it("excludes instruction, fitting, and retail surfaces without reviewed public rental evidence", () => {
    const records = [
      { ...place, id: "instructor", displayName: { text: "Example Golf Center" }, primaryType: "golf_instructor" },
      { ...place, id: "coaching", displayName: { text: "Example Golf Center" }, primaryType: "sports_coaching" },
      { ...place, id: "retail", displayName: { text: "Example Golf" }, primaryType: "sporting_goods_store" },
      { ...place, id: "store", displayName: { text: "Example Golf" }, primaryType: "store" },
      { ...place, id: "lesson-url", displayName: { text: "GOLFTEC Trumbull" }, websiteUri: "https://www.golftec.com/golf-lessons/trumbull?utm_source=gmb" },
      { ...place, id: "fitting-url", displayName: { text: "Example Golf Center" }, websiteUri: "https://venue.example/club-fitting" }
    ];
    expect(filterSimulatorPlaces(records, reviews, emptyOfferings)).toEqual([]);
  });

  it("preserves an exact indoor review for a hybrid whose name does not mention golf", () => {
    const hybrid = { ...place, displayName: { text: "Example Sportsplex" }, primaryType: "sports_complex", types: ["sports_complex"] };
    expect(filterSimulatorPlaces([hybrid], buildGooglePlaceReviewIndex([review("place-1", "INDOOR_SIMULATOR")]), emptyOfferings)).toEqual([hybrid]);
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

  it("collapses the reviewed Whitney Farms simulator alias without claiming rental readiness", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const index = buildGooglePlaceReviewIndex([whitneySimulatorAlias()]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      places: [whitneyCourse, whitneyPlayersClub]
    }), { status: 200 })));

    const candidates = await searchNearbySimulatorVenues({ latitude: 41.304, longitude: -73.213 }, index, emptyOfferings);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      googlePlaceId: whitneyCourse.id, name: whitneyCourse.displayName?.text,
      website: "https://www.whitneyfarmsgc.com/", mode: "SIMULATOR",
      publicAccessStatus: "UNVERIFIED", monitoringReadiness: "VERIFYING"
    });
    expect(candidates[0]).not.toHaveProperty("offeringId");
    expect(index.verifiedPublicCourses).toEqual([]);
  });

  it("recovers the Whitney Farms canonical venue from its simulator alias when the course is absent", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const index = buildGooglePlaceReviewIndex([whitneySimulatorAlias()]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [whitneyPlayersClub] }), { status: 200 })));

    const nearby = await searchNearbySimulatorVenues({ latitude: 41.304, longitude: -73.213 }, index, emptyOfferings);
    const lookup = await searchSimulatorVenuesByName({ query: "The Players Club at Whitney Farms Golf Club" }, index, emptyOfferings);
    for (const candidates of [nearby, lookup]) {
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        googlePlaceId: whitneyCourse.id, name: whitneyCourse.displayName?.text,
        address: "175 Shelton Rd, Monroe, CT 06468, USA", website: "https://www.whitneyfarmsgc.com/",
        mode: "SIMULATOR", publicAccessStatus: "UNVERIFIED", monitoringReadiness: "VERIFYING"
      });
    }
  });

  it("does not let the Whitney Farms indoor alias override a canonical private review", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const alias = whitneySimulatorAlias();
    const privateCourse = review(whitneyCourse.id as string, "PRIVATE_MEMBER_CONTROLLED", "VERIFIED_PRIVATE");
    const index = buildGooglePlaceReviewIndex([alias, privateCourse]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [whitneyCourse, whitneyPlayersClub] }), { status: 200 })));

    expect(await searchNearbySimulatorVenues({ latitude: 41.304, longitude: -73.213 }, index, emptyOfferings)).toEqual([]);
    expect(index.byPlaceId.get(whitneyCourse.id as string)?.accessOverride).toBe("VERIFIED_PRIVATE");
    expect(index.byPlaceId.get(whitneyPlayersClub.id as string)?.accessOverride).toBe("VERIFIED_NON_COURSE");
    expect(index.verifiedPublicCourses).toEqual([]);
  });

  it("keeps direct name lookup stricter than the bounded nearby golf-name fallback", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const golfNamedPlace = { ...place, displayName: { text: "Example Golf Club" }, primaryType: "golf_course", types: ["golf_course"] };
    expect(filterSimulatorPlaces([golfNamedPlace], reviews, emptyOfferings)).toEqual([golfNamedPlace]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ places: [golfNamedPlace] }), { status: 200 })));
    expect(await searchSimulatorVenuesByName({ query: "Example Golf Club" }, reviews, emptyOfferings)).toEqual([]);
  });

  it("uses independent public rental evidence despite an outdoor private classification", () => {
    const index = buildGooglePlaceReviewIndex([review("place-1", "PRIVATE_MEMBER_CONTROLLED", "VERIFIED_PRIVATE")]);
    const offering = { id: "rental-1", courseId: "course-1", active: true, publicAccessStatus: "PUBLIC",
      bookingUrl: "https://booking.example", evidenceUrl: "https://venue.example/public-rental", verifiedAt: new Date(),
      updatedAt: new Date(), maxPartySize: 4, supportedDurationsMinutes: [60], automationEligibility: "UNKNOWN", monitoringState: "UNKNOWN",
      course: { id: "course-1", googlePlaceId: "place-1", name: "Venue", address: null, latitude: 41.24, longitude: -73.2,
        timeZone: "America/New_York", website: "https://venue.example", phone: null } } satisfies SimulatorOfferingRecord;
    expect(filterSimulatorPlaces([place], index, buildSimulatorOfferingIndex([offering]))).toEqual([place]);
    const rentalInHybridStore = { ...place, displayName: { text: "Example Golf Equipment Store" }, primaryType: "sporting_goods_store", types: ["sporting_goods_store"] };
    expect(filterSimulatorPlaces([rentalInHybridStore], index, buildSimulatorOfferingIndex([offering]))).toEqual([rentalInHybridStore]);
  });
});

function review(googlePlaceId: string, classification: string, accessOverride: GooglePlaceReviewRecord["accessOverride"] = "VERIFIED_NON_COURSE"): GooglePlaceReviewRecord {
  return { googlePlaceId, name: "Reviewed Venue", classification, accessOverride, evidenceUrl: "https://venue.example", reviewedAt: new Date(), active: true,
    canonicalPlaceId: null, canonicalName: null, canonicalAddress: null, canonicalWebsiteUrl: null, canonicalPhone: null,
    latitude: null, longitude: null, retainWhenCanonicalAbsent: false };
}

// Official venue identity and simulator lounge are distinct Places records for one facility.
const whitneyCourse: GooglePlace = {
  ...place, id: "ChIJZ3Rrpzzi54kR_g0Sly9n8Bc", displayName: { text: "Chris Bargas Golf Club at Whitney Farms" },
  primaryType: "golf_course", types: ["golf_course", "indoor_golf_course"],
  formattedAddress: "175 Shelton Rd, Monroe, CT 06468, USA", websiteUri: "https://www.whitneyfarmsgc.com/",
  location: { latitude: 41.304, longitude: -73.213 }
};
const whitneyPlayersClub: GooglePlace = {
  ...whitneyCourse, id: "ChIJDb2t7lHj54kRl0o341PUdx0", displayName: { text: "The Players Club at Whitney Farms Golf Club" },
  primaryType: "indoor_golf_course", types: ["indoor_golf_course"],
  websiteUri: "https://www.whitneyfarmsgc.com/the-players-club-trackman-simulators"
};

function whitneySimulatorAlias(): GooglePlaceReviewRecord {
  return {
    ...review(whitneyPlayersClub.id as string, "INDOOR_SIMULATOR"),
    name: whitneyPlayersClub.displayName?.text as string,
    evidenceUrl: "https://www.whitneyfarmsgc.com/the-players-club-trackman-simulators",
    canonicalPlaceId: whitneyCourse.id as string, canonicalName: whitneyCourse.displayName?.text as string,
    canonicalAddress: whitneyCourse.formattedAddress as string,
    canonicalWebsiteUrl: "https://www.whitneyfarmsgc.com/", canonicalPhone: "(203) 268-0707",
    retainWhenCanonicalAbsent: true
  };
}
