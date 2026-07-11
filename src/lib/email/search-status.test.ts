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
  it("sends setup once and waits until 8 AM on a new local day for the morning report", () => {
    const lastSentAt = new Date("2026-07-10T03:00:00.000Z"); // Jul 9, 11 PM EDT

    expect(getSearchStatusEmailKind(null, new Date("2026-07-10T12:00:00.000Z"))).toBe(
      "setup"
    );
    expect(
      getSearchStatusEmailKind(
        lastSentAt,
        new Date("2026-07-10T11:59:00.000Z"),
        "America/New_York"
      )
    ).toBeNull();
    expect(
      getSearchStatusEmailKind(
        lastSentAt,
        new Date("2026-07-10T12:00:00.000Z"),
        "America/New_York"
      )
    ).toBe("daily");
  });

  it("does not send a second morning report on the same local day", () => {
    expect(
      getSearchStatusEmailKind(
        new Date("2026-07-10T12:05:00.000Z"),
        new Date("2026-07-10T20:00:00.000Z"),
        "America/New_York"
      )
    ).toBeNull();
  });

  it("uses the golfer timezone when deciding whether morning has started", () => {
    const lastSentAt = new Date("2026-07-10T05:00:00.000Z"); // Jul 9, 10 PM PDT

    expect(
      getSearchStatusEmailKind(
        lastSentAt,
        new Date("2026-07-10T14:59:00.000Z"),
        "America/Los_Angeles"
      )
    ).toBeNull();
    expect(
      getSearchStatusEmailKind(
        lastSentAt,
        new Date("2026-07-10T15:00:00.000Z"),
        "America/Los_Angeles"
      )
    ).toBe("daily");
  });
});

describe("renderSearchStatusHtml", () => {
  it("explains outside-window, not-visible, and work-in-progress course states", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
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
    expect(html).toContain("7:10 AM EDT before your window");
    expect(html).toContain("booking window may not be open yet");
    expect(html).toContain("We’re working on a safe connection");
    expect(html).toContain("keep checking fully monitored courses");
    expect(html).not.toContain("keep watching automatically");
    expect(html).toContain("What we’re watching for you");
    expect(html).toContain("Fully monitored ✓");
    expect(html).toContain("at most one morning status update per day");
    expect(html).not.toContain("<Needs Adapter>");
    expect(html).toContain("Course &lt;Needs Adapter&gt;");
    expect(html).toContain("x=&lt;unsafe&gt;");
  });

  it("shows every matching time with spots and email stop controls", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "daily",
      targetDate: "2026-07-11",
      startTime: "07:30",
      endTime: "09:00",
      players: 2,
      checkedAt: new Date("2026-07-10T12:15:00.000Z"),
      courses: [
        {
          courseId: "fairchild",
          courseName: "Fairchild Wheeler Golf Course",
          outcome: "MATCH_FOUND",
          availableMatches: 2,
          bookingUrl: "https://example.com/fairchild",
          matchingTimes: [
            { startsAt: "2026-07-11T07:40:00-04:00", availableSpots: 4 },
            { startsAt: "2026-07-11T08:10:00-04:00", availableSpots: 2 }
          ]
        }
      ],
      stopUrls: {
        booked: "https://teetimespot.com/alerts/stop?token=booked",
        cancelled: "https://teetimespot.com/alerts/stop?token=cancelled"
      }
    });

    expect(html).toContain("7:40 AM");
    expect(html).toContain("8:10 AM");
    expect(html).toContain("4 spots");
    expect(html).toContain("2 spots");
    expect(html).toContain("I booked — stop these emails");
    expect(html).toContain("Cancel this alert");
  });

  it("does not claim an official-site-only course is monitored automatically", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-12",
      startTime: "06:00",
      endTime: "16:00",
      players: 4,
      checkedAt: new Date("2026-07-11T12:15:00.000Z"),
      courses: [
        {
          courseId: "fairview-farm",
          courseName: "Fairview Farm Golf Course",
          outcome: "BLOCKED_POLICY",
          availableMatches: 0,
          bookingUrl: "https://fairviewfarmgc.com/",
          phone: "(860) 555-0102",
          bookingAccess: "OFFICIAL_SITE"
        },
        {
          courseId: "timberlin",
          courseName: "Timberlin Golf Course",
          outcome: "NO_MATCH",
          availableMatches: 0
        }
      ]
    });

    expect(html).toContain("keep checking supported courses");
    expect(html).toContain("Official site only");
    expect(html).toContain("not automatically monitored");
    expect(html).toContain("Open official site →");
    expect(html).toContain("Call (860) 555-0102 →");
    expect(html).not.toContain("keep watching automatically");
  });

  it("gives phone-only courses a clear direct-booking action", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-12",
      startTime: "06:00",
      endTime: "16:00",
      players: 4,
      checkedAt: new Date("2026-07-11T12:15:00.000Z"),
      courses: [
        {
          courseId: "phone-only",
          courseName: "Pinebrook Golf Club",
          outcome: "BLOCKED_POLICY",
          availableMatches: 0,
          bookingUrl: "https://pinebrook.example.com/",
          phone: "+1 (203) 555-0199",
          bookingMethod: "PHONE_ONLY",
          bookingAccess: "OFFICIAL_SITE"
        }
      ]
    });

    expect(html).toContain("Priority 1 · Phone only");
    expect(html).toContain("Call the course to check availability and book directly");
    expect(html).toContain('href="tel:+12035550199"');
    expect(html).toContain("Call +1 (203) 555-0199 →");
    expect(html).toContain("Open official site →");
    expect(html).not.toContain("Open official booking page");
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
