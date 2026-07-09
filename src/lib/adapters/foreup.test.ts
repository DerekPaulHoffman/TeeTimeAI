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

  it("supports ForeUP courses that do not require a booking class", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          time: "2026-07-10 18:50",
          available_spots: 4,
          green_fee: 52,
          holes: "9/18"
        }
      ]
    }));
    vi.stubGlobal("fetch", fetchMock);

    const slots = await fetchForeupSlots({
      courseId: "oak-hills",
      date: new Date("2026-07-10T00:00:00-04:00"),
      players: 3,
      metadata: {
        scheduleId: 11739,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes"
      }
    });

    const requestedUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    expect(requestedUrl.searchParams.get("schedule_id")).toBe("11739");
    expect(requestedUrl.searchParams.has("booking_class")).toBe(false);
    expect(slots[0]).toMatchObject({
      sourceId: "foreup-11739-2026-07-10 18:50",
      startsAt: "2026-07-10T18:50",
      availableSpots: 4,
      priceCents: 5200
    });
  });

  it("treats ForeUP false responses as no available public slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => false
      }))
    );

    const slots = await fetchForeupSlots({
      courseId: "longshore",
      date: new Date("2026-07-10T00:00:00-04:00"),
      players: 3,
      metadata: {
        scheduleId: 23148,
        bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/23148#/login"
      }
    });

    expect(slots).toEqual([]);
  });
});
