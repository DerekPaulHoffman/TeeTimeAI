import { describe, expect, it } from "vitest";

import { getGoogleMapsSearchUrl } from "@/lib/maps";

const course = {
  googlePlaceId: "abc123",
  name: "Tashua Knolls Golf Course",
  address: "40 Tashua Knolls Ln, Trumbull, CT",
  latitude: 41.242,
  longitude: -73.209
};

describe("Google Maps URL helpers", () => {
  it("builds a direct Google Maps search URL with place id support", () => {
    const url = new URL(getGoogleMapsSearchUrl(course));

    expect(url.origin).toBe("https://www.google.com");
    expect(url.pathname).toBe("/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.get("query")).toBe(
      "Tashua Knolls Golf Course, 40 Tashua Knolls Ln, Trumbull, CT"
    );
    expect(url.searchParams.get("query_place_id")).toBe("abc123");
  });

  it("does not pass fake demo ids as Google place ids", () => {
    const url = new URL(getGoogleMapsSearchUrl({ ...course, googlePlaceId: "demo-tashua" }));

    expect(url.searchParams.has("query_place_id")).toBe(false);
  });
});
