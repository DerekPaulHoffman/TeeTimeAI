import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const mocks = vi.hoisted(() => ({
  enrichCoursesWithAlertSupport: vi.fn(),
  enrichCoursesWithHoleLayouts: vi.fn(),
  getGooglePlacesApiKey: vi.fn(),
  searchGolfCoursesByName: vi.fn()
}));

vi.mock("@/lib/places/alert-support", () => ({
  enrichCoursesWithAlertSupport: mocks.enrichCoursesWithAlertSupport
}));

vi.mock("@/lib/places/hole-layout-enrichment", () => ({
  enrichCoursesWithHoleLayouts: mocks.enrichCoursesWithHoleLayouts
}));

vi.mock("@/lib/places/google", () => ({
  getGooglePlacesApiKey: mocks.getGooglePlacesApiKey,
  searchGolfCoursesByName: mocks.searchGolfCoursesByName
}));

describe("GET /api/courses/lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getGooglePlacesApiKey.mockReturnValue("test-key");
    mocks.enrichCoursesWithAlertSupport.mockImplementation(async (courses) => courses);
    mocks.enrichCoursesWithHoleLayouts.mockImplementation(async (courses) =>
      courses.map((course: object) => ({
        ...course,
        layoutHolesStatus: "UNVERIFIED"
      }))
    );
  });

  it("returns matching course candidates with optional location context", async () => {
    mocks.searchGolfCoursesByName.mockResolvedValue([
      {
        googlePlaceId: "bethpage-black",
        name: "Bethpage Black Course",
        latitude: 40.744,
        longitude: -73.456
      }
    ]);

    const response = await GET(
      request("?q=Bethpage%20Black&latitude=40.73&longitude=-73.44")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      courses: [
        expect.objectContaining({
          googlePlaceId: "bethpage-black",
          name: "Bethpage Black Course",
          layoutHolesStatus: "UNVERIFIED"
        })
      ]
    });
    expect(mocks.searchGolfCoursesByName).toHaveBeenCalledWith({
      query: "Bethpage Black",
      latitude: 40.73,
      longitude: -73.44
    });
    expect(mocks.enrichCoursesWithAlertSupport).toHaveBeenCalledWith([
      expect.objectContaining({ googlePlaceId: "bethpage-black" })
    ]);
    expect(mocks.enrichCoursesWithHoleLayouts).toHaveBeenCalledWith([
      expect.objectContaining({ googlePlaceId: "bethpage-black" })
    ]);
  });

  it("rejects short queries and incomplete coordinates", async () => {
    const shortResponse = await GET(request("?q=B"));
    const incompleteLocationResponse = await GET(
      request("?q=Bethpage%20Black&latitude=40.73")
    );

    expect(shortResponse.status).toBe(400);
    expect(incompleteLocationResponse.status).toBe(400);
    expect(mocks.searchGolfCoursesByName).not.toHaveBeenCalled();
  });

  it("returns a useful temporary-unavailable response without a provider key", async () => {
    mocks.getGooglePlacesApiKey.mockReturnValue(undefined);

    const response = await GET(request("?q=Bethpage%20Black"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Course lookup is temporarily unavailable. Try the nearby search instead."
    });
  });
});

function request(search = "") {
  return new NextRequest(`http://localhost/api/courses/lookup${search}`);
}
