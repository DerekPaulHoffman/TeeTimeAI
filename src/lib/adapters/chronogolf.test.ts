import { describe, expect, it, vi } from "vitest";

import {
  fetchChronogolfSlots,
  isChronogolfMetadata
} from "./chronogolf";

describe("Chronogolf adapter", () => {
  it("validates reusable public marketplace metadata", () => {
    expect(
      isChronogolfMetadata({
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      })
    ).toBe(true);
    expect(isChronogolfMetadata({ clubId: 7221, courseIds: [] })).toBe(false);
  });

  it("normalizes public tee times without entering the booking flow", async () => {
    const requestMock = vi.fn()
      .mockResolvedValueOnce({
        total: 25,
        perPage: 24,
        payload: {
          status: "open",
          teetimes: [
          {
            uuid: "slot-public-1",
            date: "2026-07-14",
            start_time: "7:40",
            max_player_size: 4,
            frozen: false,
            course: {
              uuid: "7657db51-4e0c-4bc7-8e98-bd0a705370af",
              holes: 18
            },
            default_price: {
              green_fee: 40,
              bookable_holes: 9
            }
          },
          {
            uuid: "slot-frozen",
            date: "2026-07-14",
            start_time: "8:00",
            max_player_size: 4,
            frozen: true
          }
          ]
        }
      })
      .mockResolvedValueOnce({
        total: 25,
        perPage: 24,
        payload: { status: "open", teetimes: [] }
      });

    const slots = await fetchChronogolfSlots({
      courseId: "blue-rock",
      date: new Date("2026-07-14T00:00:00.000Z"),
      players: 3,
      metadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    }, requestMock);

    expect(requestMock).toHaveBeenNthCalledWith(
      1,
      "https://www.chronogolf.com/marketplace/v2/teetimes?start_date=2026-07-14&free_slots=3&course_ids=7657db51-4e0c-4bc7-8e98-bd0a705370af&page=1"
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      "https://www.chronogolf.com/marketplace/v2/teetimes?start_date=2026-07-14&free_slots=3&course_ids=7657db51-4e0c-4bc7-8e98-bd0a705370af&page=2"
    );
    expect(slots).toEqual([
      {
        courseId: "blue-rock",
        sourceId: "chronogolf-slot-public-1",
        startsAt: "2026-07-14T07:40",
        availableSpots: 4,
        bookingUrl:
          "https://www.chronogolf.com/club/blue-rock-golf-course?date=2026-07-14&step=teetimes",
        priceCents: 4000,
        holes: 9,
        priceOptions: [{ holes: 9, priceCents: 4000 }],
        evidenceUrl:
          "https://www.chronogolf.com/marketplace/v2/teetimes?start_date=2026-07-14&free_slots=3&course_ids=7657db51-4e0c-4bc7-8e98-bd0a705370af&page=1"
      }
    ]);
  });
});
