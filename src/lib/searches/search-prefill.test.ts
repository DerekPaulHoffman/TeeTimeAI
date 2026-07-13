import { afterEach, describe, expect, it } from "vitest";

import {
  consumeSearchPrefill,
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
});
