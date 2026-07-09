import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
      photoName: "places/abc123/photos/photo1",
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

  it("filters golf stores, indoor simulators, private clubs, and closed businesses", () => {
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
    ]);

    expect(places.map((place) => place.displayName?.text)).toEqual(["Short Beach Golf Course"]);
  });

  it("asks Places for primary type metadata and excludes obvious non-public results", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
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
            id: "places/golf-galaxy",
            displayName: { text: "Golf Galaxy" },
            primaryType: "sporting_goods_store",
            types: ["golf_course", "sporting_goods_store"],
            businessStatus: "OPERATIONAL",
            location: { latitude: 41.102, longitude: -73.417 }
          }
        ]
      })
    } as Response);

    const courses = await searchNearbyGolfCourses({
      latitude: 41.242,
      longitude: -73.209,
      radiusMeters: 30000
    });

    expect(courses.map((course) => course.name)).toEqual([
      "Tashua Knolls & Tashua Glen Golf Course"
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://places.googleapis.com/v1/places:searchNearby",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-FieldMask": expect.stringContaining("places.primaryType")
        }),
        body: expect.stringContaining("excludedPrimaryTypes")
      })
    );
  });
});
