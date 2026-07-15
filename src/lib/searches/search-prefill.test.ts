import { afterEach, describe, expect, it } from "vitest";

import {
  consumeSearchPrefill,
  readSearchPrefillFromUrl,
  SEARCH_PREFILL_STORAGE_KEY,
  sanitizeSearchPrefill,
  storeSearchPrefill
} from "./search-prefill";

describe("search prefill transfer", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    consumeSearchPrefill();
  });

  it("moves location and coordinates through single-use session storage", () => {
    storeSearchPrefill({
      location: "Current location",
      coordinates: { latitude: 41.2, longitude: -73.2 },
      players: 2,
      radius: 20
    });

    expect(window.sessionStorage.getItem(SEARCH_PREFILL_STORAGE_KEY)).not.toBeNull();
    expect(consumeSearchPrefill()).toMatchObject({
      location: "Current location",
      coordinates: { latitude: 41.2, longitude: -73.2 },
      players: 2,
      radius: 20
    });
    expect(window.sessionStorage.getItem(SEARCH_PREFILL_STORAGE_KEY)).toBeNull();
    expect(consumeSearchPrefill()).toBeUndefined();
  });

  it("sanitizes a selected course for the course-page CTA", () => {
    const selectedCourse = {
      courseId: "course-1",
      googlePlaceId: "place-1",
      name: "Tashua Knolls Golf Course",
      address: "40 Tashua Knolls Lane, Trumbull, CT",
      city: "Trumbull",
      stateCode: "ct",
      stateName: "Connecticut",
      county: "Fairfield",
      countryCode: "us",
      latitude: 41.268,
      longitude: -73.221,
      timeZone: "America/New_York",
      website: "https://example.com/golf",
      profileUrl: "/courses/tashua-knolls-golf-course-trumbull-ct"
    };

    expect(sanitizeSearchPrefill({ selectedCourse }).selectedCourse).toMatchObject({
      ...selectedCourse,
      stateCode: "CT",
      countryCode: "US"
    });
  });

  it("drops malformed or out-of-range values", () => {
    expect(
      sanitizeSearchPrefill({
        location: "  06825  ",
        players: 20,
        radius: 500,
        coordinates: { latitude: 200, longitude: -73 }
      })
    ).toEqual({
      location: "06825",
      date: undefined,
      startTime: undefined,
      endTime: undefined,
      players: undefined,
      radius: 15,
      holes: undefined,
      coordinates: undefined
    });
  });

  it("reads validated direct-link values without requiring a server render", () => {
    expect(
      readSearchPrefillFromUrl(
        "?location=South%20Lake%20Tahoe%2C%20CA&players=2&date=2026-07-18&startTime=08%3A30&endTime=12%3A00&holes=18&radius=25&latitude=38.9399&longitude=-119.9772"
      )
    ).toEqual({
      location: "South Lake Tahoe, CA",
      players: 2,
      date: "2026-07-18",
      startTime: "08:30",
      endTime: "12:00",
      holes: "18",
      radius: 25,
      coordinates: { latitude: 38.9399, longitude: -119.9772 }
    });
  });

  it("drops malformed direct-link fields and ignores unrelated query strings", () => {
    expect(readSearchPrefillFromUrl("?utm_source=guide")).toBeUndefined();
    expect(
      readSearchPrefillFromUrl(
        "?players=20&radius=100&holes=36&latitude=200&longitude=not-a-number"
      )
    ).toEqual({
      location: undefined,
      date: undefined,
      startTime: undefined,
      endTime: undefined,
      players: undefined,
      radius: 15,
      holes: undefined,
      coordinates: undefined
    });
  });
});
