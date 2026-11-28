import { describe, expect, it, vi } from "vitest";

import {
  buildChronogolfPublicRequestHeaders,
  fetchChronogolfSlots,
  isChronogolfMetadata
} from "./chronogolf";

const input = {
  courseId: "blue-rock",
  date: new Date("2026-07-14T00:00:00.000Z"),
  players: 2,
  metadata: {
    clubId: 7221,
    courseIds: ["7657db51-4e0c-4bc7-8e98-bd0a705370af"],
    bookingBaseUrl: "https://www.chronogolf.com/club/blue-rock-golf-course"
  }
};

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
        total: 2,
        perPage: 1,
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
          }
          ]
        }
      })
      .mockResolvedValueOnce({
        total: 2,
        perPage: 1,
        payload: { status: "open", teetimes: [{ uuid: "slot-frozen", date: "2026-07-14", start_time: "8:00",
          max_player_size: 4, frozen: true }] }
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

  it.each([
    { teetimes: null },
    { tee_times: [] },
    { teetimes: {} },
    { status: "login_required", teetimes: [] }
  ])("rejects a malformed tee sheet instead of certifying it empty (%j)", async (payload) => {
    const request = vi.fn().mockResolvedValue({ total: 0, perPage: 12, payload });
    await expect(fetchChronogolfSlots(input, request)).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });

  it.each([
    { date: "2026-07-15" },
    { course: { uuid: "different-course" } },
    { start_time: "25:00" },
    { max_player_size: undefined }
  ])("rejects a malformed or foreign tee time row (%j)", async (overrides) => {
    const request = vi.fn().mockResolvedValue({ total: 1, perPage: 12, payload: { teetimes: [{
      uuid: "slot", date: "2026-07-14", start_time: "07:40", max_player_size: 4, ...overrides
    }] } });
    await expect(fetchChronogolfSlots(input, request)).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });

  it("rejects a prematurely empty later page and inventory over the existing page bound", async () => {
    const row = { uuid: "slot", date: "2026-07-14", start_time: "07:40", max_player_size: 4 };
    const request = vi.fn()
      .mockResolvedValueOnce({ total: 2, perPage: 1, payload: { teetimes: [row] } })
      .mockResolvedValueOnce({ total: 2, perPage: 1, payload: { teetimes: [] } });
    await expect(fetchChronogolfSlots(input, request)).rejects.toThrow("pagination could not be verified");
    expect(request).toHaveBeenCalledTimes(2);
    const oversized = vi.fn().mockResolvedValue({ total: 11, perPage: 1, payload: { teetimes: [row] } });
    await expect(fetchChronogolfSlots(input, oversized)).rejects.toThrow("pagination could not be verified");
    expect(oversized).toHaveBeenCalledTimes(1);
    const repeated = vi.fn().mockResolvedValue({ total: 2, perPage: 1, payload: { teetimes: [row] } });
    await expect(fetchChronogolfSlots(input, repeated)).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });

  it.each([
    { body: { teetimes: [] }, headers: {} },
    { body: { teetimes: [], pagination: { total: 0, perPage: 12 } }, headers: { total: "2", "per-page": "12" } },
  ])("rejects absent or conflicting native pagination evidence (%j)", async ({ body, headers }) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("profile"))
      .mockResolvedValueOnce(Response.json(body, { headers: new Headers(headers as Record<string, string>) }));
    await expect(fetchChronogolfSlots(input, undefined, fetchMock as typeof fetch)).rejects.toThrow("pagination could not be verified");
  });

  it("preserves a native explicit zero with coherent pagination headers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("profile"))
      .mockResolvedValueOnce(Response.json({ status: "sold_out", teetimes: [], total_count: 0 }, { headers: { total: "0", "per-page": "12" } }));
    await expect(fetchChronogolfSlots(input, undefined, fetchMock as typeof fetch)).resolves.toEqual([]);
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
