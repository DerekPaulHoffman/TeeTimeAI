import { describe, expect, it } from "vitest";

import { dedupeMatches, filterSlotsForSearch, rankMatches } from "./matching";

const search = {
  date: "2026-08-10",
  startTime: "13:40",
  endTime: "16:00",
  players: 3,
  preferredCourses: [
    { courseId: "course-a", rank: 1 },
    { courseId: "course-b", rank: 2 }
  ]
};

describe("tee time matching", () => {
  it("filters slots to the requested date, player count, and time window", () => {
    const matches = filterSlotsForSearch(search, [
      {
        sourceId: "a-1320",
        courseId: "course-a",
        startsAt: "2026-08-10T13:20:00-04:00",
        availableSpots: 4,
        bookingUrl: "https://example.com/a"
      },
      {
        sourceId: "a-1340",
        courseId: "course-a",
        startsAt: "2026-08-10T13:40:00-04:00",
        availableSpots: 3,
        bookingUrl: "https://example.com/a"
      },
      {
        sourceId: "b-1600",
        courseId: "course-b",
        startsAt: "2026-08-10T16:00:00-04:00",
        availableSpots: 2,
        bookingUrl: "https://example.com/b"
      }
    ]);

    expect(matches.map((match) => match.sourceId)).toEqual(["a-1340"]);
  });

  it("dedupes previously alerted slots by course and source id", () => {
    const matches = dedupeMatches(
      [
        {
          sourceId: "a-1340",
          courseId: "course-a",
          startsAt: "2026-08-10T13:40:00-04:00",
          availableSpots: 3,
          bookingUrl: "https://example.com/a"
        },
        {
          sourceId: "a-1350",
          courseId: "course-a",
          startsAt: "2026-08-10T13:50:00-04:00",
          availableSpots: 3,
          bookingUrl: "https://example.com/a"
        }
      ],
      [
        {
          sourceId: "a-1340",
          courseId: "course-a",
          startsAt: "2026-08-10T13:40:00-04:00"
        }
      ]
    );

    expect(matches.map((match) => match.sourceId)).toEqual(["a-1350"]);
  });

  it("dedupes when stored UTC start time differs from source local time", () => {
    const matches = dedupeMatches(
      [
        {
          sourceId: "foreup-6654-2026-08-10 13:40",
          courseId: "course-a",
          startsAt: "2026-08-10T13:40",
          availableSpots: 3,
          bookingUrl: "https://example.com/a"
        }
      ],
      [
        {
          sourceId: "foreup-6654-2026-08-10 13:40",
          courseId: "course-a",
          startsAt: "2026-08-10T17:40:00.000Z"
        }
      ]
    );

    expect(matches).toEqual([]);
  });

  it("orders matches by course priority and then tee time", () => {
    const ranked = rankMatches(search, [
      {
        sourceId: "b-1400",
        courseId: "course-b",
        startsAt: "2026-08-10T14:00:00-04:00",
        availableSpots: 3,
        bookingUrl: "https://example.com/b"
      },
      {
        sourceId: "a-1500",
        courseId: "course-a",
        startsAt: "2026-08-10T15:00:00-04:00",
        availableSpots: 3,
        bookingUrl: "https://example.com/a"
      }
    ]);

    expect(ranked.map((match) => match.sourceId)).toEqual(["a-1500", "b-1400"]);
  });
});
