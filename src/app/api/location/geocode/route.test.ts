import { describe, expect, it } from "vitest";

import { LocationNotFoundError } from "@/lib/places/geocode";

import { getGeocodeErrorResponse } from "./route";

describe("geocode API errors", () => {
  it("treats an unmatched location as a correctable client error", () => {
    expect(getGeocodeErrorResponse(new LocationNotFoundError())).toEqual({
      message:
        "We couldn't find that location. Check the city, state, or ZIP code and try again.",
      status: 404
    });
  });

  it("keeps provider failures distinct from invalid user input", () => {
    expect(getGeocodeErrorResponse(new Error("Google Places text search failed with 503"))).toEqual({
      message: "Google Places text search failed with 503",
      status: 502
    });
  });
});
