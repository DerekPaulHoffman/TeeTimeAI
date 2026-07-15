import { afterEach, describe, expect, it } from "vitest";

import {
  clearSearchDraft,
  readSearchDraft,
  SEARCH_DRAFT_STORAGE_KEY,
  sanitizeSearchDraft,
  storeSearchDraft
} from "./search-draft";

const course = {
  googlePlaceId: "course-1",
  name: "Test Public Golf Course",
  address: "100 Public Links Rd, Trumbull, CT",
  latitude: 41.24,
  longitude: -73.2,
  timeZone: "America/New_York",
  distanceMeters: 2_500,
  rating: 4.4,
  monitoringSupport: "AUTOMATIC" as const,
  layoutHoleCounts: [18] as const,
  website: "https://example.com/course-1"
};

describe("search draft storage", () => {
  afterEach(() => {
    clearSearchDraft();
    window.sessionStorage.clear();
  });

  it("keeps filters, results, and ranked courses available for repeated reads", () => {
    storeSearchDraft({
      location: "Trumbull, CT",
      players: 2,
      date: "2026-07-18",
      startTime: "08:30",
      endTime: "12:00",
      holes: "18",
      radius: 20,
      coordinates: { latitude: 41.24, longitude: -73.2 },
      courses: [course],
      selectedCourses: [course]
    });

    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).not.toBeNull();
    expect(readSearchDraft()).toMatchObject({
      location: "Trumbull, CT",
      players: 2,
      courses: [
        {
          googlePlaceId: "course-1",
          monitoringSupport: "AUTOMATIC",
          layoutHoleCounts: [18]
        }
      ],
      selectedCourses: [{ googlePlaceId: "course-1" }]
    });
    expect(readSearchDraft()?.selectedCourses).toHaveLength(1);
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).not.toBeNull();
  });

  it("drops malformed courses, unsafe values, and duplicate place ids", () => {
    expect(
      sanitizeSearchDraft({
        location: "  06825  ",
        players: 20,
        courses: [
          course,
          { ...course, name: "Duplicate" },
          { ...course, googlePlaceId: "bad-course", latitude: 200 },
          { ...course, googlePlaceId: "unsafe-course", website: "javascript:alert(1)" }
        ],
        selectedCourses: [{ ...course, timeZone: "Not/AZone" }]
      })
    ).toMatchObject({
      location: "06825",
      players: undefined,
      courses: [
        { googlePlaceId: "course-1", website: "https://example.com/course-1" },
        { googlePlaceId: "unsafe-course", website: undefined }
      ],
      selectedCourses: []
    });
  });

  it("removes the draft when an alert is finished", () => {
    storeSearchDraft({ courses: [course], selectedCourses: [course] });
    clearSearchDraft();

    expect(readSearchDraft()).toBeUndefined();
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toBeNull();
  });
});
