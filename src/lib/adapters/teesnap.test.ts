import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTeesnapSlots, isTeesnapMetadata } from "./teesnap";

describe("isTeesnapMetadata", () => {
  it("recognizes reusable Teesnap metadata", () => {
    expect(
      isTeesnapMetadata({
        provider: "TEESNAP",
        courseId: 1210,
        bookingBaseUrl: "https://huntergolfclub.teesnap.net/",
        defaultHoles: 18,
        defaultAddons: "off"
      })
    ).toBe(true);
  });
});

describe("fetchTeesnapSlots", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps public Teesnap tee-sheet JSON without entering reservation flows", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        teeTimes: {
          bookings: [
            {
              bookingId: 53212529,
              golfers: [{ id: 1 }, { id: 2 }]
            }
          ],
          teeTimes: [
            {
              teeTime: "2026-07-11T12:30:00",
              prices: [
                { roundType: "NINE_HOLE", price: "28.00" },
                { roundType: "EIGHTEEN_HOLE", price: "48.00" }
              ],
              teeOffSections: [
                {
                  teeOff: "FRONT_NINE",
                  bookings: [53212529],
                  isHeld: false
                },
                {
                  teeOff: "BACK_NINE",
                  isHeld: false
                }
              ]
            }
          ]
        }
      })
    );

    const slots = await fetchTeesnapSlots({
      courseId: "course-hunter",
      date: new Date("2026-07-11T00:00:00-04:00"),
      players: 4,
      metadata: {
        provider: "TEESNAP",
        courseId: 1210,
        bookingBaseUrl: "https://huntergolfclub.teesnap.net/",
        defaultHoles: 18,
        defaultAddons: "off"
      }
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://huntergolfclub.teesnap.net/customer-api/teetimes-day?course=1210&date=2026-07-11&players=4&holes=18&addons=off&profileId=",
      expect.objectContaining({
        headers: expect.objectContaining({
          accept: "application/json, text/plain, */*",
          referer: "https://huntergolfclub.teesnap.net/"
        })
      })
    );
    expect(slots).toEqual([
      expect.objectContaining({
        sourceId: "teesnap-1210-2026-07-11T12:30:00-FRONT_NINE",
        availableSpots: 2,
        priceCents: 4800,
        holes: 18,
        priceOptions: [
          { holes: 9, priceCents: 2800 },
          { holes: 18, priceCents: 4800 }
        ]
      }),
      expect.objectContaining({
        sourceId: "teesnap-1210-2026-07-11T12:30:00-BACK_NINE",
        availableSpots: 4,
        bookingUrl: "https://huntergolfclub.teesnap.net/?date=2026-07-11"
      })
    ]);
  });

  it("treats dates outside the course booking window as no current slots", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ errors: "date_not_allowed" }, { status: 400 })
    );

    await expect(
      fetchTeesnapSlots({
        courseId: "course-hunter",
        date: new Date("2026-07-26T00:00:00-04:00"),
        players: 4,
        metadata: {
          provider: "TEESNAP",
          courseId: 1210,
          bookingBaseUrl: "https://huntergolfclub.teesnap.net/"
        }
      })
    ).resolves.toEqual([]);
  });
});

function jsonResponse(value: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(value), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
