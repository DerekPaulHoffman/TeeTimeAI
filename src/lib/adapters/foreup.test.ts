import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchForeupSlots } from "./foreup";

describe("ForeUP adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes ForeUP slots and omits ambiguous holes values", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          {
            time: "2026-08-10 13:40",
            available_spots: 4,
            green_fee: 55,
            holes: "9/18"
          },
          {
            time: "2026-08-10 14:20",
            available_spots: 2,
            holes: "18"
          }
        ]
      }))
    );

    const slots = await fetchForeupSlots({
      courseId: "course-1",
      date: new Date("2026-08-10T00:00:00-04:00"),
      players: 3,
      metadata: {
        scheduleId: 6654,
        bookingClassId: 14910,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/21017#/teetimes"
      }
    });

    expect(slots).toMatchObject([
      {
        sourceId: "foreup-6654-2026-08-10 13:40",
        startsAt: "2026-08-10T13:40",
        availableSpots: 4,
        priceCents: 5500,
        holes: undefined
      },
      {
        sourceId: "foreup-6654-2026-08-10 14:20",
        startsAt: "2026-08-10T14:20",
        availableSpots: 2,
        holes: 18
      }
    ]);
  });
});
