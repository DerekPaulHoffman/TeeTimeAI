import { describe, expect, it, vi } from "vitest";

import {
  fetchGolfNowTeeSheet,
  getGolfNowFacilityId,
  isGolfNowMetadata,
  normalizeGolfNowBookingUrl
} from "./golfnow";

const bookingBaseUrl =
  "https://www.golfnow.com/tee-times/facility/10296-hunter-golf-course/search";
const metadata = {
  provider: "GOLFNOW" as const,
  facilityId: 10296,
  bookingBaseUrl
};

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    status: 200,
    headers: { "content-type": "application/json", ...init.headers }
  });
}

describe("GolfNow public tee-time adapter", () => {
  it("accepts only an exact matching public facility search URL", () => {
    expect(isGolfNowMetadata(metadata)).toBe(true);
    expect(getGolfNowFacilityId(bookingBaseUrl)).toBe(10296);
    expect(normalizeGolfNowBookingUrl(`${bookingBaseUrl}/`)).toBe(bookingBaseUrl);
    expect(isGolfNowMetadata({ ...metadata, facilityId: 10297 })).toBe(false);
    expect(isGolfNowMetadata({
      ...metadata,
      bookingBaseUrl: `${bookingBaseUrl}?token=secret`
    })).toBe(false);
    expect(normalizeGolfNowBookingUrl(
      "https://www.golfnow.com/account/login?returnUrl=%2Ftee-times"
    )).toBeNull();
  });

  it("reads signed-out search results without sending account or checkout state", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({
        facilityId: 10296,
        date: "Jul 24 2026",
        players: 3,
        searchType: "Facility"
      });
      expect(JSON.stringify(request)).not.toMatch(/token|account|payment|checkout/i);
      expect(init?.headers).toMatchObject({
        accept: "application/json",
        origin: "https://www.golfnow.com",
        referer: bookingBaseUrl
      });
      return jsonResponse({
        ttResults: {
          teeTimes: [{
            facilityId: 10296,
            time: { date: "2026-07-24T09:10:00+00:00", formatted: "9:10" },
            teeTimeRates: [
              {
                teeTimeRateId: 177849925,
                holeCount: 18,
                displayRate: { value: 42 }
              },
              {
                teeTimeRateId: 177849926,
                isNine: true,
                singlePlayerPrice: { greensFees: { value: 28.5 } }
              }
            ]
          }]
        }
      });
    }) as unknown as typeof fetch;

    await expect(fetchGolfNowTeeSheet({
      courseId: "hunter",
      date: new Date("2026-07-24T00:00:00.000Z"),
      players: 3,
      metadata
    }, fetchImpl)).resolves.toEqual({
      slots: [{
        courseId: "hunter",
        sourceId: "golfnow-10296-177849925",
        startsAt: "2026-07-24T09:10:00",
        availableSpots: 3,
        bookingUrl: bookingBaseUrl,
        priceCents: 2850,
        holes: 9,
        bookableHoleCounts: [9, 18],
        priceOptions: [
          { holes: 9, priceCents: 2850 },
          { holes: 18, priceCents: 4200 }
        ],
        evidenceUrl:
          "https://www.golfnow.com/api/tee-times/tee-time-search-results"
      }],
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null
    });
  });

  it("ignores restricted, mismatched, malformed, and rate-free records", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      ttResults: {
        teeTimes: [
          {
            facilityId: 10296,
            isReservationRestricted: true,
            time: { date: "2026-07-24T09:10:00", formatted: "9:10" },
            teeTimeRates: [{ holeCount: 18, displayRate: { value: 42 } }]
          },
          {
            facilityId: 999,
            time: { date: "2026-07-24T10:10:00", formatted: "10:10" },
            teeTimeRates: [{ holeCount: 18, displayRate: { value: 42 } }]
          },
          {
            facilityId: 10296,
            time: { date: "2026-07-24T11:10:00", formatted: "bad" },
            teeTimeRates: [{ holeCount: 18, displayRate: { value: 42 } }]
          },
          {
            facilityId: 10296,
            time: { date: "2026-07-24T12:10:00", formatted: "12:10" },
            teeTimeRates: []
          }
        ]
      }
    })) as unknown as typeof fetch;

    const result = await fetchGolfNowTeeSheet({
      courseId: "hunter",
      date: new Date("2026-07-24T00:00:00.000Z"),
      players: 2,
      metadata
    }, fetchImpl);
    expect(result).toEqual({
      slots: [],
      targetDateStatus: "UNKNOWN",
      bookingWindowEvidence: null
    });
  });

  it("fails closed on non-JSON, invalid JSON, oversized, and provider error responses", async () => {
    const input = {
      courseId: "hunter",
      date: new Date("2026-07-24T00:00:00.000Z"),
      players: 2,
      metadata
    };
    const nonJson = vi.fn(async () =>
      new Response("html", { headers: { "content-type": "text/html" } })
    ) as unknown as typeof fetch;
    const invalidJson = vi.fn(async () =>
      new Response("{", { headers: { "content-type": "application/json" } })
    ) as unknown as typeof fetch;
    const oversized = vi.fn(async () =>
      jsonResponse({}, { headers: { "content-length": String(6 * 1024 * 1024) } })
    ) as unknown as typeof fetch;
    const rateLimited = vi.fn(async () =>
      new Response("", {
        status: 429,
        headers: { "content-type": "application/json" }
      })
    ) as unknown as typeof fetch;

    await expect(fetchGolfNowTeeSheet(input, nonJson)).rejects.toThrow("non-JSON");
    await expect(fetchGolfNowTeeSheet(input, invalidJson)).rejects.toThrow("invalid JSON");
    await expect(fetchGolfNowTeeSheet(input, oversized)).rejects.toThrow("size limit");
    await expect(fetchGolfNowTeeSheet(input, rateLimited)).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 429
    });
  });
});
