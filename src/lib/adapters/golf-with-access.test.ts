import { describe, expect, it, vi } from "vitest";

import {
  fetchGolfWithAccessTeeSheet,
  isGolfWithAccessMetadata,
  type GolfWithAccessMetadata
} from "./golf-with-access";

const metadata: GolfWithAccessMetadata = {
  provider: "GOLF_WITH_ACCESS",
  courseIds: [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ],
  bookingBaseUrl:
    "https://golfwithaccess.com/course/example-public-course/reserve-tee-time"
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function teeTime(overrides: Record<string, unknown> = {}) {
  return {
    id: "opaque-public-slot",
    dayTime: {
      year: 2026,
      month: 7,
      day: 24,
      hour: 16,
      minute: 30,
      second: 0
    },
    players: { min: 1, max: 4 },
    holesOption: "EIGHTEEN",
    course: { id: metadata.courseIds[0] },
    displayRate: {
      isAvailableToUser: true,
      holesOption: "EIGHTEEN",
      price: {
        dollars: { cents: 9_000, code: "USD" }
      }
    },
    ...overrides
  };
}

describe("isGolfWithAccessMetadata", () => {
  it("accepts a bounded public booking root and unique provider course ids", () => {
    expect(isGolfWithAccessMetadata(metadata)).toBe(true);
  });

  it.each([
    { ...metadata, provider: "OTHER" },
    { ...metadata, courseIds: [] },
    { ...metadata, courseIds: [metadata.courseIds[0], metadata.courseIds[0]] },
    { ...metadata, courseIds: ["not-a-provider-id"] },
    { ...metadata, bookingBaseUrl: "http://golfwithaccess.com/course/example/reserve-tee-time" },
    { ...metadata, bookingBaseUrl: "https://cdn.golfwithaccess.com/course/example/reserve-tee-time" },
    { ...metadata, bookingBaseUrl: "https://golfwithaccess.com/account/login" },
    { ...metadata, bookingBaseUrl: "https://golfwithaccess.com/course/example/reserve-tee-time/private-slot" },
    { ...metadata, bookingBaseUrl: "https://golfwithaccess.com/course/example/reserve-tee-time?token=private" }
  ])("rejects unsafe or incomplete metadata", (value) => {
    expect(isGolfWithAccessMetadata(value)).toBe(false);
  });
});

describe("fetchGolfWithAccessTeeSheet", () => {
  it("reads public availability without entering a reservation flow", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        teeTimes: [
          teeTime(),
          teeTime({
            id: "nine-hole-slot",
            dayTime: {
              year: 2026,
              month: 7,
              day: 24,
              hour: 17,
              minute: 5,
              second: 0
            },
            holesOption: "NINE",
            displayRate: {
              isAvailableToUser: true,
              holesOption: "NINE",
              price: { dollars: { cents: 4_500, code: "USD" } }
            }
          }),
          teeTime({
            id: "member-only-slot",
            displayRate: { isAvailableToUser: false }
          }),
          teeTime({
            id: "wrong-course-slot",
            course: { id: "33333333-3333-4333-8333-333333333333" }
          })
        ]
      })
    );

    const result = await fetchGolfWithAccessTeeSheet(
      {
        courseId: "course-1",
        date: new Date("2026-07-24T00:00:00.000Z"),
        players: 3,
        metadata
      },
      fetchMock
    );

    expect(result).toMatchObject({
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
      slots: [
        {
          courseId: "course-1",
          startsAt: "2026-07-24T16:30",
          availableSpots: 4,
          bookingUrl: metadata.bookingBaseUrl,
          priceCents: 9_000,
          holes: 18,
          bookableHoleCounts: [18]
        },
        {
          courseId: "course-1",
          startsAt: "2026-07-24T17:05",
          priceCents: 4_500,
          holes: 9,
          bookableHoleCounts: [9]
        }
      ]
    });
    expect(result.slots[0]?.sourceId).toMatch(/^golf-with-access-[a-f0-9]{64}$/u);
    expect(result.slots[0]?.evidenceUrl).toContain("/api/v1/tee-times?");

    const [requestInput, requestInit] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(requestInput!.toString());
    expect(requestUrl.origin + requestUrl.pathname).toBe(
      "https://golfwithaccess.com/api/v1/tee-times"
    );
    expect(requestUrl.searchParams.getAll("courseIds")).toEqual(
      metadata.courseIds
    );
    expect(Object.fromEntries(requestUrl.searchParams)).toMatchObject({
      players: "3",
      startAt: "00:00:00",
      endAt: "23:59:59",
      day: "2026-07-24"
    });
    expect(requestInit).toMatchObject({
      headers: expect.objectContaining({ Accept: "application/json" })
    });
    expect(requestInit).not.toHaveProperty("body");
  });

  it("treats a valid empty public response as checked with no availability", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({ teeTimes: [] })
    );
    await expect(
      fetchGolfWithAccessTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-24T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchMock
      )
    ).resolves.toEqual({
      slots: [],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
  });

  it("fails closed on a nonempty incompatible provider schema", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response({ teeTimes: [{ unexpected: true }] })
    );
    await expect(
      fetchGolfWithAccessTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-24T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchMock
      )
    ).rejects.toThrow("unexpected tee-time schema");
  });

  it("preserves provider HTTP status and retry headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": "60" }
      })
    );
    await expect(
      fetchGolfWithAccessTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-24T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchMock
      )
    ).rejects.toMatchObject({ status: 429, retryAfter: "60" });
  });
});
