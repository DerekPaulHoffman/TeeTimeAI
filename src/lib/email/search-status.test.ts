import { describe, expect, it } from "vitest";

import {
  buildSearchStatusSnapshot,
  getChangedCourseNames,
  getSearchStatusEmailKind,
  renderSearchStatusHtml,
  summarizeSearchStatusAvailability,
  type SearchStatusCourseReport
} from "./search-status";

const courses: SearchStatusCourseReport[] = [
  {
    courseId: "course-1",
    courseName: "Richter Park Golf Course",
    outcome: "NO_MATCH",
    availableMatches: 0,
    bookingUrl: "https://example.com/richter?x=<unsafe>",
    availability: {
      visibleSlotCount: 12,
      playerEligibleSlotCount: 12,
      closestBefore: "2026-07-11T07:10",
      closestAfter: "2026-07-11T15:00"
    }
  },
  {
    courseId: "course-2",
    courseName: "Course <Needs Adapter>",
    outcome: "NEEDS_ADAPTER",
    availableMatches: 0
  },
  {
    courseId: "course-3",
    courseName: "Future Course",
    outcome: "NO_MATCH",
    availableMatches: 0,
    availability: { visibleSlotCount: 0, playerEligibleSlotCount: 0 }
  }
];

describe("search status email cadence", () => {
  it("sends once for setup and then no more than once every 24 hours", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(getSearchStatusEmailKind(null, now)).toBe("setup");
    expect(getSearchStatusEmailKind(new Date("2026-07-09T13:00:00.000Z"), now)).toBeNull();
    expect(getSearchStatusEmailKind(new Date("2026-07-09T12:00:00.000Z"), now)).toBe("daily");
  });
});

describe("renderSearchStatusHtml", () => {
  it("explains outside-window, not-visible, and work-in-progress course states", () => {
    const html = renderSearchStatusHtml({
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-11",
      startTime: "07:30",
      endTime: "09:00",
      players: 1,
      checkedAt: new Date("2026-07-10T12:15:00.000Z"),
      courses
    });

    expect(html).toContain("We’re working on your tee times");
    expect(html).toContain("7:10 AM before your window");
    expect(html).toContain("booking window may not be open yet");
    expect(html).toContain("We’re working on connecting this course");
    expect(html).toContain("at most one status update per day");
    expect(html).not.toContain("<Needs Adapter>");
    expect(html).toContain("Course &lt;Needs Adapter&gt;");
    expect(html).toContain("x=&lt;unsafe&gt;");
  });
});

describe("search status snapshots", () => {
  it("reports only courses whose meaningful state changed", () => {
    const current = buildSearchStatusSnapshot(courses);
    const previous = current.map((course) =>
      course.courseId === "course-1" ? { ...course, state: "MATCH_FOUND" } : course
    );

    expect(getChangedCourseNames(current, previous)).toEqual(["Richter Park Golf Course"]);
    expect(getChangedCourseNames(current, current)).toEqual([]);
  });
});

describe("summarizeSearchStatusAvailability", () => {
  it("distinguishes outside-window times from dates or player counts we cannot use", () => {
    expect(
      summarizeSearchStatusAvailability(
        {
          date: "2026-07-11",
          startTime: "07:30",
          endTime: "09:00",
          players: 2
        },
        [
          { startsAt: "2026-07-10T08:00", availableSpots: 4 },
          { startsAt: "2026-07-11T07:10", availableSpots: 2 },
          { startsAt: "2026-07-11T08:20", availableSpots: 1 },
          { startsAt: "2026-07-11T10:40", availableSpots: 4 }
        ]
      )
    ).toEqual({
      visibleSlotCount: 3,
      playerEligibleSlotCount: 2,
      closestBefore: "2026-07-11T07:10",
      closestAfter: "2026-07-11T10:40"
    });
  });
});
