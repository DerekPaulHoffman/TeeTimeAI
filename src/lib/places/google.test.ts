import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dedupeGolfCoursePlaces,
  filterPublicGolfCoursePlaces,
  getGooglePlacesApiKey,
  mapGooglePlaceToCourseCandidate,
  searchNearbyGolfCourses
} from "./google";

describe("Google Places mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it("maps only the fields needed for course discovery", () => {
    const course = mapGooglePlaceToCourseCandidate({
      id: "places/abc123",
      displayName: { text: "Tashua Knolls Golf Course" },
      formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
      location: { latitude: 41.242, longitude: -73.209 },
      rating: 4.4,
      nationalPhoneNumber: "(203) 452-5171",
      websiteUri: "https://www.tashuaknolls.com",
      photos: [
        {
          name: "places/abc123/photos/photo1",
          authorAttributions: [
            {
              displayName: "Google contributor",
              uri: "//maps.google.com/maps/contrib/123"
            }
          ]
        }
      ]
    });

    expect(course).toEqual({
      googlePlaceId: "abc123",
      name: "Tashua Knolls Golf Course",
      address: "40 Tashua Knolls Ln, Trumbull, CT",
      latitude: 41.242,
      longitude: -73.209,
      rating: 4.4,
      phone: "(203) 452-5171",
      website: "https://www.tashuaknolls.com",
      photoReference: "places/abc123/photos/photo1",
      photoAttributions: [
        {
          displayName: "Google contributor",
          uri: "//maps.google.com/maps/contrib/123"
        }
      ]
    });
  });

  it("normalizes copied Google Places API keys before use in headers", () => {
    process.env.GOOGLE_PLACES_API_KEY = "\uFEFF copied-key \n";

    expect(getGooglePlacesApiKey()).toBe("copied-key");

    delete process.env.GOOGLE_PLACES_API_KEY;
  });

  it("keeps likely public outdoor golf courses from Places results", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/tashua",
        displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "athletic_field", "point_of_interest"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.242, longitude: -73.209 }
      },
      {
        id: "places/fairchild",
        displayName: { text: "Fairchild Wheeler Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_activity_location"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.199, longitude: -73.236 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Tashua Knolls & Tashua Glen Golf Course",
      "Fairchild Wheeler Golf Course"
    ]);
  });

  it("filters ancillary listings, private membership clubs, and closed businesses", () => {
    const places = filterPublicGolfCoursePlaces([
      {
        id: "places/golf-galaxy",
        displayName: { text: "Golf Galaxy" },
        primaryType: "sporting_goods_store",
        types: ["indoor_golf_course", "golf_course", "sporting_goods_store", "store"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.102, longitude: -73.417 }
      },
      {
        id: "places/racebrook",
        displayName: { text: "Race Brook Country Club" },
        primaryType: "association_or_organization",
        types: ["golf_course", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.296, longitude: -73.043 }
      },
      {
        id: "places/private-primary-course",
        displayName: { text: "Example Country Club" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.29, longitude: -73.04 }
      },
      {
        id: "places/presidio-fitting",
        displayName: { text: "Presidio Club Fitting" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.097, longitude: -73.392 }
      },
      {
        id: "places/general-store",
        displayName: { text: "General Store" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.163, longitude: -73.42 }
      },
      {
        id: "places/alameda-junior",
        displayName: { text: "Alameda Junior Golf Club" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.164, longitude: -73.421 }
      },
      {
        id: "places/olympic",
        displayName: { text: "The Olympic Club" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_club", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 37.709, longitude: -122.495 }
      },
      {
        id: "places/monarch",
        displayName: { text: "Monarch Bay Golf Club" },
        primaryType: "golf_course",
        types: ["golf_course", "sports_club", "association_or_organization"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 37.695, longitude: -122.186 }
      },
      {
        id: "places/x-golf",
        displayName: { text: "X-Golf Stratford" },
        primaryType: "indoor_golf_course",
        types: ["indoor_golf_course", "golf_course"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.184, longitude: -73.13 }
      },
      {
        id: "places/closed-course",
        displayName: { text: "Closed Public Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course"],
        businessStatus: "CLOSED_PERMANENTLY",
        location: { latitude: 41.2, longitude: -73.2 }
      },
      {
        id: "places/municipal",
        displayName: { text: "Short Beach Golf Course" },
        primaryType: "golf_course",
        types: ["golf_course", "tourist_attraction"],
        businessStatus: "OPERATIONAL",
        location: { latitude: 41.16, longitude: -73.12 }
      }
    ], { publicCourseEvidenceIds: new Set(["monarch", "olympic"]) });

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Monarch Bay Golf Club",
      "Short Beach Golf Course"
    ]);
  });

  it("dedupes the same logical course without collapsing distinct courses at one venue", () => {
    const places = dedupeGolfCoursePlaces([
      {
        id: "places/presidio-canonical",
        displayName: { text: "Presidio Golf Course" },
        formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        rating: 4.5,
        websiteUri: "https://www.presidiogolf.com/",
        photos: [{ name: "places/presidio-canonical/photos/1" }],
        location: { latitude: 37.79049, longitude: -122.45979 }
      },
      {
        id: "places/presidio-duplicate",
        displayName: { text: "Presidio Golf" },
        formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        location: { latitude: 37.79057, longitude: -122.45987 }
      },
      {
        id: "places/fleming",
        displayName: { text: "Fleming 9 Course" },
        formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        websiteUri: "https://tpc.com/tpc-harding-park-fleming-course",
        location: { latitude: 37.72563, longitude: -122.49106 }
      },
      {
        id: "places/harding",
        displayName: { text: "TPC Harding Park" },
        formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
        primaryType: "golf_course",
        types: ["golf_course"],
        websiteUri: "https://tpc.com/hardingpark",
        location: { latitude: 37.72482, longitude: -122.4932 }
      }
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual([
      "Presidio Golf Course",
      "Fleming 9 Course",
      "TPC Harding Park"
    ]);
  });

  it("merges popularity and distance ranked Places results before filtering", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/centennial",
              displayName: { text: "Centennial Golf Club" },
              formattedAddress: "185 John Simpson Rd, Carmel Hamlet, NY",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.451, longitude: -73.711 }
            },
            {
              id: "places/tashua",
              displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
              formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.242, longitude: -73.209 }
            },
            {
              id: "places/golf-galaxy",
              displayName: { text: "Golf Galaxy" },
              primaryType: "sporting_goods_store",
              types: ["golf_course", "sporting_goods_store"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.102, longitude: -73.417 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/tashua",
              displayName: { text: "Tashua Knolls & Tashua Glen Golf Course" },
              formattedAddress: "40 Tashua Knolls Ln, Trumbull, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.242, longitude: -73.209 }
            },
            {
              id: "places/fairchild",
              displayName: { text: "Fairchild Wheeler Golf Course" },
              formattedAddress: "2390 Easton Tpke, Fairfield, CT",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 41.199, longitude: -73.236 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [{ id: "places/centennial" }, { id: "places/tashua" }, { id: "places/fairchild" }]
        })
      } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 30000
    });

    expect(courses.map((course) => course.name)).toEqual([
      "Tashua Knolls & Tashua Glen Golf Course",
      "Fairchild Wheeler Golf Course",
      "Centennial Golf Club"
    ]);
    expect(courses[0]?.distanceMeters).toBe(0);
    expect(courses[1]?.distanceMeters).toBeLessThan(courses[2]?.distanceMeters ?? 0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": expect.stringContaining("places.primaryType")
        }),
        body: expect.stringContaining('"includedPrimaryTypes":["golf_course"]')
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        body: expect.stringContaining('"rankPreference":"DISTANCE"')
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://places.googleapis.com/v1/places:searchText",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": "places.id"
        }),
        body: expect.stringContaining('"textQuery":"public golf courses"')
      })
    );
  });

  it("removes SF sub-venues and an uncorroborated private club from discovery", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/presidio",
              displayName: { text: "Presidio Golf Course" },
              formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79049, longitude: -122.45979 }
            },
            {
              id: "places/olympic",
              displayName: { text: "The Olympic Club" },
              formattedAddress: "599 CA-35, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.70939, longitude: -122.49463 }
            },
            {
              id: "places/monarch",
              displayName: { text: "Monarch Bay Golf Club" },
              formattedAddress: "13800 Monarch Bay Dr, San Leandro, CA 94577, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.6951, longitude: -122.1856 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            {
              id: "places/presidio-fitting",
              displayName: { text: "Presidio Club Fitting" },
              formattedAddress: "300 Finley Rd, San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79057, longitude: -122.45987 }
            },
            {
              id: "places/general-store",
              displayName: { text: "General Store" },
              formattedAddress: "San Francisco, CA 94129, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.79425, longitude: -122.46874 }
            },
            {
              id: "places/fleming",
              displayName: { text: "Fleming 9 Course" },
              formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.72563, longitude: -122.49106 }
            },
            {
              id: "places/harding",
              displayName: { text: "TPC Harding Park" },
              formattedAddress: "99 Harding Rd, San Francisco, CA 94132, USA",
              primaryType: "golf_course",
              types: ["golf_course", "sports_club", "association_or_organization"],
              businessStatus: "OPERATIONAL",
              location: { latitude: 37.72482, longitude: -122.4932 }
            }
          ]
        })
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          places: [
            { id: "places/presidio" },
            { id: "places/monarch" },
            { id: "places/fleming" },
            { id: "places/harding" }
          ]
        })
      } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 37.7749,
      longitude: -122.4194,
      radiusMeters: 38624
    });

    expect(courses.map((course) => course.name)).toEqual(
      expect.arrayContaining([
        "Presidio Golf Course",
        "Monarch Bay Golf Club",
        "Fleming 9 Course",
        "TPC Harding Park"
      ])
    );
    expect(courses).toHaveLength(4);
  });
});
