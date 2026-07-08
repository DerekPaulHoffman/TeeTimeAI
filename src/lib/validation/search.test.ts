import { describe, expect, it } from "vitest";

import {
  MAX_COURSE_PREFERENCES,
  MIN_COURSE_PREFERENCES,
  teeSearchInputSchema
} from "./search";

const tomorrow = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
};

describe("teeSearchInputSchema", () => {
  it("accepts a future search with one to five ranked courses", () => {
    const result = teeSearchInputSchema.parse({
      date: tomorrow(),
      startTime: "13:40",
      endTime: "16:00",
      players: 3,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "place-1",
          name: "Tashua Knolls",
          rank: 1,
          latitude: 41.242,
          longitude: -73.209
        }
      ],
      cadenceMinutes: 15
    });

    expect(result.courses).toHaveLength(MIN_COURSE_PREFERENCES);
    expect(result.courses[0]?.rank).toBe(1);
    expect(result.alertEmail).toBe("golfer@example.com");
  });

  it("rejects same-day or past searches", () => {
    const today = new Date().toISOString().slice(0, 10);

    expect(() =>
      teeSearchInputSchema.parse({
        date: today,
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        courses: [
          {
            googlePlaceId: "place-1",
            name: "Tashua Knolls",
            rank: 1,
            latitude: 41.242,
            longitude: -73.209
          }
        ]
      })
    ).toThrow(/future/i);
  });

  it("rejects more than five prioritized courses", () => {
    expect(() =>
      teeSearchInputSchema.parse({
        date: tomorrow(),
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        courses: Array.from({ length: MAX_COURSE_PREFERENCES + 1 }, (_, index) => ({
          googlePlaceId: `place-${index}`,
          name: `Course ${index}`,
          rank: index + 1,
          latitude: 41 + index / 100,
          longitude: -73 - index / 100
        }))
      })
    ).toThrow(/5/);
  });

  it("rejects an end time that is not after the start time", () => {
    expect(() =>
      teeSearchInputSchema.parse({
        date: tomorrow(),
        startTime: "16:00",
        endTime: "13:40",
        players: 3,
        courses: [
          {
            googlePlaceId: "place-1",
            name: "Tashua Knolls",
            rank: 1,
            latitude: 41.242,
            longitude: -73.209
          }
        ]
      })
    ).toThrow(/after/i);
  });

  it("rejects invalid alert emails", () => {
    expect(() =>
      teeSearchInputSchema.parse({
        date: tomorrow(),
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        alertEmail: "not-an-email",
        courses: [
          {
            googlePlaceId: "place-1",
            name: "Tashua Knolls",
            rank: 1,
            latitude: 41.242,
            longitude: -73.209
          }
        ]
      })
    ).toThrow(/email/i);
  });
});
