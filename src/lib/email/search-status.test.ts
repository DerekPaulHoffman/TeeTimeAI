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
  it("shows the exact provider-confirmed booking release time", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-window",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-29",
      startTime: "07:30",
      endTime: "09:00",
      players: 4,
      checkedAt: new Date("2026-07-13T19:00:00.000Z"),
      courses: [
        {
          courseId: "course-window",
          courseName: "Weekend Golf Course",
          timeZone: "America/New_York",
          outcome: "NO_MATCH",
          availableMatches: 0,
          bookingWindow: {
            releaseDate: "2026-07-15",
            releaseTimeLocal: "05:00",
            opensAt: "2026-07-15T09:00:00.000Z",
            timeZone: "America/New_York",
            exactTime: true
          }
        }
      ]
    });

    expect(html).toContain("SCHEDULED");
    expect(html).toContain("Booking opens Wednesday, July 15 at 5:00 AM EDT");
    expect(html).toContain("start checking at that time");
  });

  it("explains outside-window, not-visible, and work-in-progress course states", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-11",
      startTime: "07:30",
      endTime: "09:00",
      players: 1,
      requestedLayoutHoles: 18,
      checkedAt: new Date("2026-07-10T12:15:00.000Z"),
      courses
    });

    expect(html).toContain("Your tee-time alert is active");
    expect(html).toContain("7:10 AM EDT before your window");
    expect(html).toContain("booking window may not be open yet");
    expect(html).toContain("ADDING MONITORING");
    expect(html).toContain("Check this course directly for now");
    expect(html).toContain("We checked every selected course");
    expect(html).not.toContain("keep watching automatically");
    expect(html).toContain("What we're watching for you");
    expect(html).toContain("COURSE LAYOUT");
    expect(html).toContain("18 Holes");
    expect(html).toContain("FULLY MONITORED");
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
    expect(html).toContain("I booked &mdash; stop these results");
    expect(html).toContain("Cancel this alert");
    expect(html).toContain('href="https://teetimespot.com/alerts/stop?token=cancelled"');
    expect(html).toContain(">Unsubscribe</a>");
  });

  it("keeps available courses out of the monitoring list and shows every bookable hole count", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 4,
      checkedAt: new Date("2026-07-15T17:41:00.000Z"),
      courses: [
        {
          courseId: "tashua",
          courseName: "Tashua Knolls Golf Course",
          rank: 1,
          outcome: "MATCH_FOUND",
          availableMatches: 1,
          bookingUrl: "https://example.com/tashua",
          matchingTimes: [
            {
              startsAt: "2026-07-18T16:20:00-04:00",
              availableSpots: 4,
              priceCents: 6100,
              bookableHoleCounts: [9, 18],
              isNew: true
            }
          ]
        },
        {
          courseId: "gainfield",
          courseName: "Gainfield Farms Golf Course",
          rank: 2,
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          bookingUrl: "https://example.com/gainfield"
        }
      ]
    });

    expect(html).toContain("9H/18H");
    expect(html.match(/Tashua Knolls Golf Course/g)).toHaveLength(1);
    expect(html).toContain("What we're watching for you");
    expect(html).toContain("PRIORITY 2 &middot; ADDING MONITORING");
  });

  it("revalidates a generic legacy block instead of treating it as final", () => {
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

    expect(html).toContain("monitoring is still being added");
    expect(html).toContain("ADDING MONITORING");
    expect(html).toContain("generic classification is being re-checked");
    expect(html).toContain("Open official site &rarr;");
    expect(html).toContain("Call (860) 555-0102 &rarr;");
    expect(html).not.toContain("keep watching automatically");
  });

  it("reopens a legacy online policy block as monitoring work", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-1",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 4,
      checkedAt: new Date("2026-07-15T12:15:00.000Z"),
      courses: [
        {
          courseId: "yale-golf",
          courseName: "Yale University Golf Course",
          outcome: "BLOCKED_POLICY",
          availableMatches: 0,
          bookingUrl: "https://app.whoosh.io/patron/club/yale-golf-course",
          bookingMethod: "PUBLIC_ONLINE",
          automationReason: "AUTOMATION_PROHIBITED",
          bookingAccess: "BOOKING_PAGE"
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; ADDING MONITORING");
    expect(html).toContain("legacy policy-only or generic classification is being re-checked");
    expect(html).toContain("Open official booking page &rarr;");
    expect(html).toContain("keep working to add monitoring");
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
          automationReason: "NO_ONLINE_BOOKING",
          bookingAccess: "OFFICIAL_SITE"
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; PHONE ONLY");
    expect(html).toContain("Call the course to check availability and book directly");
    expect(html).toContain('href="tel:+12035550199"');
    expect(html).toContain("Call +1 (203) 555-0199 &rarr;");
    expect(html).toContain("Open official site &rarr;");
    expect(html).not.toContain("Open official booking page");
  });

  it.each([
    ["ACCOUNT_REQUIRED", "ACCOUNT REQUIRED", "requires a golfer account"],
    ["CAPTCHA_OR_QUEUE", "CAPTCHA OR QUEUE", "behind a captcha, queue"]
  ] as const)(
    "renders %s as a technical final even with the same booking page",
    (automationReason, badge, detail) => {
      const html = renderSearchStatusHtml({
        searchId: "search-1",
        to: "player@example.com",
        kind: "setup",
        targetDate: "2026-07-18",
        startTime: "09:00",
        endTime: "18:00",
        players: 4,
        checkedAt: new Date("2026-07-15T12:15:00.000Z"),
        courses: [
          {
            courseId: "technical-course",
            courseName: "Technical Course",
            outcome: "BLOCKED_AUTH",
            availableMatches: 0,
            bookingUrl: "https://booking.example/tee-times",
            bookingMethod: "PUBLIC_ONLINE",
            bookingAccess: "BOOKING_PAGE",
            automationReason
          }
        ]
      });

      expect(html).toContain(`PRIORITY 1 &middot; ${badge}`);
      expect(html).toContain(detail);
      expect(html).not.toContain("ADDING MONITORING");
      expect(html).not.toContain("legacy policy-only");
    }
  );

  it("renders identity finals without any booking or contact action", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-identity",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 2,
      checkedAt: new Date("2026-07-16T12:15:00.000Z"),
      courses: [
        {
          courseId: "private-listing",
          courseName: "Private Listing",
          outcome: "BLOCKED_POLICY",
          availableMatches: 1,
          bookingUrl: "https://private.example/book",
          phone: "+1 (203) 555-0100",
          bookingMethod: "CONTACT_COURSE",
          automationReason: "OTHER",
          monitoringDisposition: "IDENTITY_FINAL",
          matchingTimes: [
            {
              startsAt: "2026-07-18T10:00:00-04:00",
              availableSpots: 4,
              isNew: true
            }
          ]
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; NOT A PUBLIC COURSE");
    expect(html).toContain("private, is not a playable golf course");
    expect(html).not.toContain("AVAILABLE NOW");
    expect(html).not.toContain("https://private.example/book");
    expect(html).not.toContain("tel:+12035550100");
    expect(html).not.toContain("Open official");
    expect(html).not.toContain("Call +1");
    expect(html).not.toContain("Contact course");
    expect(html).not.toContain("Contact the course");
  });

  it("renders an identity recheck as paused without stale availability or actions", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-identity-recheck",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 2,
      checkedAt: new Date("2026-07-16T12:15:00.000Z"),
      courses: [
        {
          courseId: "identity-recheck",
          courseName: "Identity Recheck Course",
          outcome: "BLOCKED_POLICY",
          availableMatches: 1,
          bookingUrl: "https://private.example/book",
          phone: "+1 (203) 555-0100",
          bookingMethod: "CONTACT_COURSE",
          automationReason: "OTHER",
          monitoringDisposition: "IDENTITY_RECHECK",
          matchingTimes: [
            {
              startsAt: "2026-07-18T10:00:00-04:00",
              availableSpots: 4,
              isNew: true
            }
          ]
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; COURSE IDENTITY RECHECK");
    expect(html).toContain("Monitoring paused while we verify public access");
    expect(html).toContain("prior course-identity review is due");
    expect(html).not.toContain("Current verified identity evidence");
    expect(html).not.toContain("AVAILABLE NOW");
    expect(html).not.toContain("https://private.example/book");
    expect(html).not.toContain("tel:+12035550100");
    expect(html).not.toContain("Open official");
    expect(html).not.toContain("Call +1");
    expect(html).not.toContain("Contact course");
  });

  it("does not infer a manual final from automation reason OTHER", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-other",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 2,
      checkedAt: new Date("2026-07-16T12:15:00.000Z"),
      courses: [
        {
          courseId: "generic-other",
          courseName: "Generic Other Course",
          outcome: "BLOCKED_POLICY",
          availableMatches: 0,
          bookingUrl: "https://course.example/book",
          bookingMethod: "PUBLIC_ONLINE",
          automationReason: "OTHER"
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; ADDING MONITORING");
    expect(html).toContain("legacy policy-only or generic classification");
    expect(html).not.toContain("DIRECT BOOKING REQUIRED");
  });

  it("does not infer a manual final from no-online metadata with an unknown method", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-unknown-manual",
      to: "player@example.com",
      kind: "setup",
      targetDate: "2026-07-18",
      startTime: "09:00",
      endTime: "18:00",
      players: 2,
      checkedAt: new Date("2026-07-16T12:15:00.000Z"),
      courses: [
        {
          courseId: "unknown-manual",
          courseName: "Unknown Method Course",
          outcome: "BLOCKED_POLICY",
          availableMatches: 0,
          bookingMethod: "UNKNOWN",
          automationReason: "NO_ONLINE_BOOKING"
        }
      ]
    });

    expect(html).toContain("PRIORITY 1 &middot; ADDING MONITORING");
    expect(html).not.toContain("DIRECT BOOKING REQUIRED");
  });

  it("keeps internal escalation state out of customer-facing course copy", () => {
    const baseInput = {
      searchId: "search-1",
      to: "player@example.com",
      kind: "daily" as const,
      targetDate: "2026-07-12",
      startTime: "13:40",
      endTime: "16:00",
      players: 3,
      checkedAt: new Date("2026-07-12T12:15:00.000Z")
    };
    const pendingHtml = renderSearchStatusHtml({
      ...baseInput,
      courses: [
        {
          courseId: "pequabuck",
          courseName: "Pequabuck Golf Club",
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          supportStatus: "PENDING_ALERT"
        }
      ]
    });
    const alertedHtml = renderSearchStatusHtml({
      ...baseInput,
      courses: [
        {
          courseId: "pequabuck",
          courseName: "Pequabuck Golf Club",
          outcome: "NEEDS_ADAPTER",
          availableMatches: 0,
          supportStatus: "TEAM_ALERTED"
        }
      ]
    });

    expect(pendingHtml).toContain("ADDING MONITORING");
    expect(alertedHtml).toContain("ADDING MONITORING");
    expect(pendingHtml).toContain("Check this course directly for now");
    expect(alertedHtml).toContain("Check this course directly for now");
    expect(pendingHtml).not.toContain("team has been alerted");
    expect(alertedHtml).not.toContain("team has been alerted");
    expect(alertedHtml).not.toContain("Automatic monitoring isn’t available yet");
  });

  it("uses the Figma shell, alternating course imagery, and availability-first order", () => {
    const html = renderSearchStatusHtml({
      searchId: "search-figma",
      to: "player@example.com",
      kind: "daily",
      targetDate: "2026-07-18",
      startTime: "07:30",
      endTime: "09:00",
      players: 2,
      requestedLayoutHoles: 18,
      checkedAt: new Date("2026-07-15T12:15:00.000Z"),
      courses: [
        {
          courseId: "pinebrook",
          courseName: "Pinebrook Golf Club",
          rank: 1,
          courseAddress: "1 Pine Road, Glastonbury, CT 06033, USA",
          timeZone: "America/New_York",
          outcome: "MATCH_FOUND",
          availableMatches: 3,
          bookingUrl: "https://example.com/pinebrook",
          matchingTimes: [
            {
              startsAt: "2026-07-18T07:40:00-04:00",
              availableSpots: 4,
              priceCents: 5800,
              holes: 18,
              isNew: true
            },
            {
              startsAt: "2026-07-18T08:10:00-04:00",
              availableSpots: 3,
              priceCents: 6200,
              holes: 18,
              isNew: false
            },
            {
              startsAt: "2026-07-18T08:20:00-04:00",
              availableSpots: 4,
              priceCents: 6200,
              holes: 18,
              isNew: false
            }
          ]
        },
        {
          courseId: "ridgecrest",
          courseName: "Ridgecrest Golf Course",
          rank: 2,
          courseAddress: "2 Ridge Road, Orange, CT 06477",
          timeZone: "America/New_York",
          outcome: "NO_MATCH",
          availableMatches: 0,
          availability: { visibleSlotCount: 0, playerEligibleSlotCount: 0 }
        }
      ],
      assetBaseUrl: "https://assets.example.com",
      stopUrls: {
        booked: "https://teetimespot.com/alerts/stop?token=booked-signed",
        cancelled: "https://teetimespot.com/alerts/stop?token=cancelled-signed"
      }
    });

    expect(html).toContain('width="680"');
    expect(html).toContain("background:#f7f4eb");
    expect(html).toContain("background:#14231d");
    expect(html).toContain("background:#d9862f");
    expect(html).toContain("MORNING UPDATE");
    expect(html).toContain("https://assets.example.com/email/course-card-1.png");
    expect(html).toContain("https://assets.example.com/email/course-card-2.png");
    expect(html).toContain("Glastonbury, CT");
    expect(html).toContain("Orange, CT");
    expect(html).toContain(">NEW</span>");
    expect(html).toContain("8:10 AM EDT – 8:20 AM EDT");
    expect(html.indexOf("AVAILABLE NOW")).toBeLessThan(
      html.indexOf("What we're watching for you")
    );
    expect(html).toContain(
      'href="https://teetimespot.com/alerts/stop?token=cancelled-signed"'
    );
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
