import { afterEach, describe, expect, it, vi } from "vitest";

import { clearCourseMonitoringEvidence } from "@/lib/places/course-monitoring-evidence";

import {
  clearSearchDraft,
  readSearchDraft,
  SEARCH_DRAFT_STORAGE_KEY,
  SIMULATOR_SEARCH_DRAFT_STORAGE_KEY,
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

const simulator = {
  ...course,
  courseId: "hybrid-course",
  mode: "SIMULATOR" as const,
  offeringId: "simulator-offering",
  publicAccessStatus: "PUBLIC" as const,
  supportedDurationsMinutes: [60, 90, 120],
  maxPartySize: 6,
  simulatorEvidenceUrl: "https://official.example/public-rentals",
  simulatorVerifiedAt: "2026-10-05T12:00:00Z",
  monitoringSupport: "AUTOMATIC" as const,
  monitoringReadiness: "READY" as const,
  monitoringReadinessObservedAt: "2026-10-05T12:30:00Z",
};

describe("search draft storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearSearchDraft();
    clearSearchDraft("SIMULATOR");
    window.sessionStorage.clear();
  });

  it("keeps filters, results, and ranked courses available for repeated reads", () => {
    const reviewPendingCourse = {
      ...course,
      publicAccessStatus: "UNVERIFIED" as const
    };
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
      selectedCourses: [reviewPendingCourse]
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
      selectedCourses: [
        {
          googlePlaceId: "course-1",
          publicAccessStatus: "UNVERIFIED"
        }
      ]
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

  it("preserves every structured account-access classification", () => {
    expect(
      sanitizeSearchDraft({
        courses: [
          {
            ...course,
            monitoringSupport: "MANUAL_ONLY",
            alertSupport: "ACCOUNT_STAFF_PROVISIONED"
          }
        ]
      }).courses
    ).toEqual([
      expect.objectContaining({
        alertSupport: "ACCOUNT_STAFF_PROVISIONED",
        monitoringSupport: "MANUAL_ONLY"
      })
    ]);
  });

  it("removes the draft when an alert is finished", () => {
    storeSearchDraft({ courses: [course], selectedCourses: [course] });
    clearSearchDraft();

    expect(readSearchDraft()).toBeUndefined();
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("keeps outdoor and simulator demand separate at the same hybrid venue", () => {
    storeSearchDraft({ courses: [course], selectedCourses: [course], holes: "18" });
    storeSearchDraft({ courses: [simulator], selectedCourses: [simulator], holes: "18" }, "SIMULATOR");

    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).not.toBeNull();
    expect(window.sessionStorage.getItem(SIMULATOR_SEARCH_DRAFT_STORAGE_KEY)).not.toBeNull();
    expect(readSearchDraft()).toMatchObject({ holes: "18", selectedCourses: [{ googlePlaceId: "course-1", layoutHoleCounts: [18] }] });
    expect(readSearchDraft("SIMULATOR")).toMatchObject({ mode: "SIMULATOR", holes: undefined, selectedCourses: [{ offeringId: "simulator-offering", mode: "SIMULATOR" }] });

    clearSearchDraft("SIMULATOR");
    expect(readSearchDraft("SIMULATOR")).toBeUndefined();
    expect(readSearchDraft()?.selectedCourses).toHaveLength(1);
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).not.toBeNull();
  });

  it("retains simulator rental facts while fencing outdoor metadata and restored readiness", () => {
    const draft = sanitizeSearchDraft({
      courses: [
        { ...simulator, par: 72, bookableHoleCounts: [18], profileUrl: "/courses/outdoor-guide", priceEstimate: {
          currency: "USD", observedAt: "2026-10-05", eighteenHoles: { minPriceCents: 5_000, maxPriceCents: 7_000, sampleSize: 2 },
        } },
        { ...simulator, googlePlaceId: "alias-of-the-same-offering" },
        course,
      ],
      selectedCourses: [simulator],
    }, "SIMULATOR");
    expect(draft.courses).toHaveLength(1);
    expect(draft.selectedCourses[0]).toMatchObject({
      offeringId: "simulator-offering",
      publicAccessStatus: "PUBLIC",
      supportedDurationsMinutes: [60, 90, 120],
      simulatorVerifiedAt: "2026-10-05T12:00:00Z",
      monitoringReadiness: "READY",
      monitoringReadinessObservedAt: "2026-10-05T12:30:00Z",
    });
    const stored = draft.courses[0];
    expect(stored).not.toHaveProperty("layoutHoleCounts");
    expect(stored).not.toHaveProperty("par");
    expect(stored).not.toHaveProperty("bookableHoleCounts");
    expect(stored).not.toHaveProperty("priceEstimate");
    expect(stored.profileUrl).toBeUndefined();

    const restored = clearCourseMonitoringEvidence(draft.selectedCourses[0]);
    expect(restored).toMatchObject({ mode: "SIMULATOR", offeringId: "simulator-offering", supportedDurationsMinutes: [60, 90, 120] });
    expect(restored).not.toHaveProperty("monitoringSupport");
    expect(restored).not.toHaveProperty("monitoringReadiness");
    expect(restored).not.toHaveProperty("monitoringReadinessObservedAt");
    expect(sanitizeSearchDraft({ courses: [simulator], selectedCourses: [simulator] }).courses).toEqual([]);
  });

  it("keeps each mode's volatile fallback independent when session storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    storeSearchDraft({ location: "Outdoor town", courses: [course], selectedCourses: [course] });
    storeSearchDraft({ location: "Simulator town", courses: [simulator], selectedCourses: [simulator] }, "SIMULATOR");

    expect(readSearchDraft()?.location).toBe("Outdoor town");
    expect(readSearchDraft("SIMULATOR")?.location).toBe("Simulator town");
    clearSearchDraft();
    expect(readSearchDraft()).toBeUndefined();
    expect(readSearchDraft("SIMULATOR")?.selectedCourses[0].offeringId).toBe("simulator-offering");
  });
});
