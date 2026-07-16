import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGolfBackTeeSheet, isGolfBackMetadata } from "./golfback";

const metadata = {
  provider: "GOLFBACK" as const,
  courseId: "5a90fb0c-b928-43f0-9486-d5d43c03d25d",
  bookingBaseUrl: "https://golfback.com/#/course/5a90fb0c-b928-43f0-9486-d5d43c03d25d"
};

describe("GolfBack adapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts only exact reusable public GolfBack metadata", () => {
    expect(isGolfBackMetadata(metadata)).toBe(true);
    expect(isGolfBackMetadata({ ...metadata, courseId: "not-a-provider-id" })).toBe(false);
    expect(
      isGolfBackMetadata({
        ...metadata,
        bookingBaseUrl: "https://example.com/course"
      })
    ).toBe(false);
  });

  it("normalizes public availability and preserves player, hole, price, and source evidence", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "slot-open",
              localDateTime: "2026-07-18T08:02:00",
              isAvailable: true,
              playersMax: 4,
              holes: [18, 9],
              primaryPrices: [
                { holes: 18, price: 65 },
                { holes: 9, price: 42.5 }
              ]
            },
            {
              id: "slot-too-small",
              localDateTime: "2026-07-18T08:10:00",
              isAvailable: true,
              playersMax: 1,
              holes: [18]
            },
            {
              id: "slot-unavailable",
              localDateTime: "2026-07-18T08:18:00",
              isAvailable: false,
              playersMax: 4,
              holes: [18]
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      fetchGolfBackTeeSheet(
        {
          courseId: "windsor-parke",
          date: new Date("2026-07-18T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl as typeof fetch
      )
    ).resolves.toEqual({
      slots: [
        {
          sourceId: "golfback-slot-open",
          courseId: "windsor-parke",
          startsAt: "2026-07-18T08:02",
          availableSpots: 4,
          bookingUrl: metadata.bookingBaseUrl,
          priceCents: 6500,
          bookableHoleCounts: [18, 9],
          priceOptions: [
            { holes: 18, priceCents: 6500 },
            { holes: 9, priceCents: 4250 }
          ],
          evidenceUrl:
            "https://api.golfback.com/api/v1/courses/5a90fb0c-b928-43f0-9486-d5d43c03d25d/date/2026-07-18/teetimes"
        }
      ],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/date/2026-07-18/teetimes"),
      expect.objectContaining({ method: "POST", body: '{"sessionId":null}' })
    );
  });

  it("uses public course configuration to defer dates outside the booking window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { teeTimesDaysOut: 8 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      fetchGolfBackTeeSheet(
        {
          courseId: "windsor-parke",
          date: new Date("2026-08-08T00:00:00.000Z"),
          players: 3,
          timeZone: "America/New_York",
          metadata,
          discoverBookingWindow: true
        },
        fetchImpl as typeof fetch,
        new Date("2026-07-15T20:00:00-04:00")
      )
    ).resolves.toMatchObject({
      slots: [],
      targetDateStatus: "NOT_OPEN",
      bookingWindowEvidence: {
        daysAhead: 8,
        releaseTimeLocal: null,
        source: "PROVIDER_CONFIG",
        confidence: 1
      }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.golfback.com/api/v1/courses/5a90fb0c-b928-43f0-9486-d5d43c03d25d",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("TeeTimeSpot/1.0")
        })
      })
    );
  });

  it("surfaces provider failures without trying another booking endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(
      fetchGolfBackTeeSheet(
        {
          courseId: "windsor-parke",
          date: new Date("2026-07-18T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toThrow("GolfBack tee times returned 503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
