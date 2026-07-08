import { describe, expect, it } from "vitest";

import { getGooglePlacesApiKey, mapGooglePlaceToCourseCandidate } from "./google";

describe("Google Places mapping", () => {
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
});
