import { describe, expect, it } from "vitest";

import { buildTopCourses, countEvents } from "./overview";

describe("operator overview aggregation", () => {
  it("ranks courses by real saved selections and counts distinct owners", () => {
    const date = new Date("2026-07-28T00:00:00.000Z");
    const result = buildTopCourses([
      preference({
        courseId: "course-a",
        courseName: "Alpha Municipal",
        searchId: "search-1",
        userId: "user-1",
        date
      }),
      preference({
        courseId: "course-a",
        courseName: "Alpha Municipal",
        searchId: "search-2",
        userId: "user-1",
        date: new Date("2026-07-27T00:00:00.000Z")
      }),
      preference({
        courseId: "course-b",
        courseName: "Beta Golf",
        searchId: "search-3",
        userId: "user-2",
        date,
        status: "PAUSED"
      })
    ]);

    expect(result[0]).toMatchObject({
      id: "course-a",
      selectionCount: 2,
      ownerCount: 1,
      activeAlertCount: 2,
      nearestRequestedDate: new Date("2026-07-27T00:00:00.000Z")
    });
    expect(result[1]).toMatchObject({
      id: "course-b",
      selectionCount: 1,
      ownerCount: 1,
      activeAlertCount: 0,
      nearestRequestedDate: null
    });
  });

  it("counts only recognized funnel events", () => {
    expect(
      countEvents([
        { name: "page_viewed" },
        { name: "page_viewed" },
        { name: "search_submitted" },
        { name: "unknown_event" }
      ])
    ).toMatchObject({
      page_viewed: 2,
      search_submitted: 1,
      course_discovery_completed: 0
    });
  });
});

function preference(input: {
  courseId: string;
  courseName: string;
  searchId: string;
  userId: string;
  date: Date;
  status?: string;
}) {
  return {
    courseId: input.courseId,
    teeSearch: {
      id: input.searchId,
      userId: input.userId,
      status: input.status ?? "ACTIVE",
      date: input.date
    },
    course: {
      id: input.courseId,
      name: input.courseName,
      providerFamilyKey: "FOREUP",
      supportIncident: null
    }
  };
}
