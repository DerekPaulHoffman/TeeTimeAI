import { describe, expect, it } from "vitest";

import { addLocalDays, formatDateInputValue } from "@/lib/dates/local-date";
import {
  MAX_ADDITIONAL_ALERT_EMAILS,
  MAX_COURSE_PREFERENCES,
  MAX_PLAYERS_PER_SEARCH,
  MIN_COURSE_PREFERENCES,
  DEFAULT_SEARCH_CADENCE_MINUTES,
  teeSearchInputSchema
} from "./search";

const tomorrow = () => {
  return formatDateInputValue(addLocalDays(new Date(), 1));
};

describe("teeSearchInputSchema", () => {
  it("accepts a future search with one to five ranked courses", () => {
    const result = teeSearchInputSchema.parse({
      date: tomorrow(),
      startTime: "13:40",
      endTime: "16:00",
      userTimeZone: "America/Los_Angeles",
      players: 3,
      alertEmail: "golfer@example.com",
      additionalEmails: ["FRIEND@example.com"],
      courses: [
        {
          googlePlaceId: "place-1",
          name: "Tashua Knolls",
          rank: 1,
          latitude: 41.242,
          longitude: -73.209,
          timeZone: "America/New_York"
        }
      ],
      cadenceMinutes: 15
    });

    expect(result.courses).toHaveLength(MIN_COURSE_PREFERENCES);
    expect(result.courses[0]?.rank).toBe(1);
    expect(result.alertEmail).toBe("golfer@example.com");
    expect(result.additionalEmails).toEqual(["friend@example.com"]);
    expect(result.userTimeZone).toBe("America/Los_Angeles");
    expect(result.courses[0]?.timeZone).toBe("America/New_York");
  });

  it("defaults new searches to the five-minute launch cadence", () => {
    const result = teeSearchInputSchema.parse({
      date: tomorrow(),
      startTime: "13:40",
      endTime: "16:00",
      players: 2,
      alertEmail: "golfer@example.com",
      courses: [
        {
          googlePlaceId: "place-1",
          name: "Tashua Knolls",
          rank: 1,
          latitude: 41.242,
          longitude: -73.209
        }
      ]
    });

    expect(result.cadenceMinutes).toBe(DEFAULT_SEARCH_CADENCE_MINUTES);
  });

  it("rejects same-day or past searches", () => {
    const today = formatDateInputValue(new Date());

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

  it("rejects player counts above one tee time group", () => {
    expect(() =>
      teeSearchInputSchema.parse({
        date: tomorrow(),
        startTime: "13:40",
        endTime: "16:00",
        players: MAX_PLAYERS_PER_SEARCH + 1,
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
    ).toThrow(String(MAX_PLAYERS_PER_SEARCH));
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

  it("rejects more than three additional alert emails", () => {
    expect(() =>
      teeSearchInputSchema.parse({
        date: tomorrow(),
        startTime: "13:40",
        endTime: "16:00",
        players: 3,
        additionalEmails: Array.from(
          { length: MAX_ADDITIONAL_ALERT_EMAILS + 1 },
          (_, index) => `extra-${index}@example.com`
        ),
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
    ).toThrow(/3/);
  });
});
