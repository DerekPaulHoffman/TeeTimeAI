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

  it("restores simulator intent from the sign-in return URL without a physical hole preference", () => {
    expect(readSearchPrefillFromUrl("?mode=SIMULATOR")).toEqual({ mode: "SIMULATOR" });
    expect(readSearchPrefillFromUrl("?mode=SIMULATOR&utm_source=sign-in")).toEqual({ mode: "SIMULATOR" });
    expect(readSearchPrefillFromUrl("?mode=UNKNOWN")).toBeUndefined();
    expect(readSearchPrefillFromUrl("?mode=SIMULATOR&holes=18&players=3&radius=25")).toMatchObject({
      mode: "SIMULATOR",
      holes: undefined,
      players: 3,
      radius: 25,
    });
    expect(sanitizeSearchPrefill({ mode: "UNKNOWN", holes: "9" })).not.toHaveProperty("mode");
  });

  it("transfers simulator offering identity and bounded rental facts as single-use intent", () => {
    storeSearchPrefill({
      mode: "SIMULATOR",
      holes: "18",
      selectedCourse: {
        mode: "SIMULATOR",
        courseId: "hybrid-venue",
        offeringId: "simulator-offering",
        googlePlaceId: "hybrid-place",
        name: "Public Simulator Venue",
        latitude: 41.2,
        longitude: -73.2,
        timeZone: "America/New_York",
        website: "https://official.example/simulators",
        publicAccessStatus: "PUBLIC",
        supportedDurationsMinutes: [60, 90, 120],
        simulatorEvidenceUrl: "https://official.example/public-rentals",
        simulatorVerifiedAt: "2026-10-05T12:00:00Z",
        monitoringSupport: "AUTOMATIC",
        monitoringReadiness: "READY",
      },
    });

    expect(consumeSearchPrefill()).toMatchObject({
      mode: "SIMULATOR",
      holes: undefined,
      selectedCourse: {
        mode: "SIMULATOR",
        offeringId: "simulator-offering",
        publicAccessStatus: "PUBLIC",
        supportedDurationsMinutes: [60, 90, 120],
        simulatorEvidenceUrl: "https://official.example/public-rentals",
        monitoringReadiness: "READY",
      },
    });
    expect(consumeSearchPrefill()).toBeUndefined();
  });

  it("rejects a candidate from another mode and drops malformed simulator facts", () => {
    const candidate = {
      googlePlaceId: "hybrid-place",
      name: "Hybrid Venue",
      latitude: 41.2,
      longitude: -73.2,
      timeZone: "America/New_York",
    };
    expect(sanitizeSearchPrefill({ mode: "SIMULATOR", selectedCourse: candidate }).selectedCourse).toBeUndefined();
    expect(sanitizeSearchPrefill({ selectedCourse: { ...candidate, mode: "SIMULATOR" } }).selectedCourse).toBeUndefined();
    expect(sanitizeSearchPrefill({
      mode: "SIMULATOR",
      selectedCourse: {
        ...candidate,
        mode: "SIMULATOR",
        offeringId: "  simulator-offering  ",
        supportedDurationsMinutes: [60, 60, "120", -90, 10_000],
        maxPartySize: -1,
        website: "https://user:secret@official.example/simulators",
        profileUrl: "/courses/outdoor-guide",
        simulatorEvidenceUrl: "https://user:secret@official.example/evidence",
        simulatorVerifiedAt: "invalid-date",
        monitoringReadiness: "UNSUPPORTED_STATUS",
      },
    }).selectedCourse).toMatchObject({
      mode: "SIMULATOR",
      offeringId: "simulator-offering",
      supportedDurationsMinutes: [60],
      maxPartySize: undefined,
      website: undefined,
      profileUrl: undefined,
      simulatorEvidenceUrl: undefined,
      simulatorVerifiedAt: undefined,
      monitoringReadiness: undefined,
    });
  });
});
