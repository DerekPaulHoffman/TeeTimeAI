import { describe, expect, it, vi } from "vitest";

import {
  buildChronogolfPublicRequestHeaders,
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
    expect(
      isChronogolfMetadata({
        clubId: 7221,
        courseIds: ["course-id"],
        bookingBaseUrl: "https://members.chronogolf.com/club/member-login"
      })
    ).toBe(false);
    expect(
      isChronogolfMetadata({
        clubId: 7221,
        courseIds: ["course-id"],
        bookingBaseUrl: "https://cdn2.chronogolf.com/widgets/v2"
      })
    ).toBe(false);
  });

  it("identifies itself and uses the canonical public profile as request context", () => {
    expect(
      buildChronogolfPublicRequestHeaders(
        "https://chronogolf.com/club/blue-rock-golf-course"
      )
    ).toEqual({
      accept: "application/json",
      referer: "https://www.chronogolf.com/club/blue-rock-golf-course",
      "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)"
    });
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
      "https://www.chronogolf.com/marketplace/v2/teetimes?start_date=2026-07-14&free_slots=3&course_ids=7657db51-4e0c-4bc7-8e98-bd0a705370af&page=1",
      "https://www.chronogolf.com/club/blue-rock-golf-course"
    );
    expect(requestMock).toHaveBeenNthCalledWith(
      2,
      "https://www.chronogolf.com/marketplace/v2/teetimes?start_date=2026-07-14&free_slots=3&course_ids=7657db51-4e0c-4bc7-8e98-bd0a705370af&page=2",
      "https://www.chronogolf.com/club/blue-rock-golf-course"
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

  it("bootstraps a bounded signed-out session and reads the current response shape", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("profile", {
        status: 200,
        headers: {
          "set-cookie": "__cf_bm=anonymous-public-value; HttpOnly; Secure; Path=/, account_session=do-not-forward; HttpOnly"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagination: { total: 1, per_page: 12 },
        data: {
          status: "open",
          teetimes: [{
            uuid: "slot-current-shape",
            date: "2026-07-14",
            start_time: "9:10",
            max_player_size: 2,
            frozen: false,
            course: { holes: 18 }
          }]
        }
      }), { status: 200 }));

    const slots = await fetchChronogolfSlots({
      courseId: "blue-rock",
      date: new Date("2026-07-14T00:00:00.000Z"),
      players: 2,
      metadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    }, undefined, fetchMock as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://www.chronogolf.com/club/blue-rock-golf-course"
    );
    const profileHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(profileHeaders.get("accept")).toBe("text/html,application/xhtml+xml");
    expect(profileHeaders.get("cookie")).toBeNull();
    const teeTimeHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(teeTimeHeaders.get("accept")).toBe("application/json");
    expect(teeTimeHeaders.get("cookie")).toBe("__cf_bm=anonymous-public-value");
    expect(teeTimeHeaders.get("cookie")).not.toContain("account_session");
    expect(slots).toEqual([
      expect.objectContaining({
        sourceId: "chronogolf-slot-current-shape",
        startsAt: "2026-07-14T09:10",
        availableSpots: 2
      })
    ]);
  });

  it("refreshes the bounded anonymous session once after a public API rejection", async () => {
    const firstCookie = "first-anonymous-cookie";
    const refreshedCookie = "refreshed-anonymous-cookie";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("profile", {
        status: 200,
        headers: { "set-cookie": `__cf_bm=${firstCookie}; HttpOnly; Secure; Path=/` }
      }))
      .mockResolvedValueOnce(new Response("rejected", { status: 403 }))
      .mockResolvedValueOnce(new Response("profile", {
        status: 200,
        headers: { "set-cookie": `__cf_bm=${refreshedCookie}; HttpOnly; Secure; Path=/` }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagination: { total: 0, per_page: 12 },
        data: { teetimes: [] }
      }), { status: 200 }));

    await fetchChronogolfSlots({
      courseId: "blue-rock",
      date: new Date("2026-07-14T00:00:00.000Z"),
      players: 2,
      metadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    }, undefined, fetchMock as typeof fetch);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("cookie"))
      .toBe(`__cf_bm=${firstCookie}`);
    expect(new Headers(fetchMock.mock.calls[3]?.[1]?.headers).get("cookie"))
      .toBe(`__cf_bm=${refreshedCookie}`);
  });

  it("does not forward challenge-clearance or account cookies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("profile", {
        status: 200,
        headers: {
          "set-cookie": "cf_clearance=not-allowed; Secure; Path=/, session=not-allowed; HttpOnly"
        }
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        pagination: { total: 0, per_page: 12 },
        data: { teetimes: [] }
      }), { status: 200 }));

    await fetchChronogolfSlots({
      courseId: "blue-rock",
      date: new Date("2026-07-14T00:00:00.000Z"),
      players: 2,
      metadata: {
        clubId: 7221,
        courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
        bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
      }
    }, undefined, fetchMock as typeof fetch);

    const teeTimeHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(teeTimeHeaders.get("cookie")).toBeNull();
  });
});
