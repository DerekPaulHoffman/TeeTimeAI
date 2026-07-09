import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTeeItUpSlots } from "./teeitup";

describe("TeeItUp adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discovers facilities for aliases and normalizes available tee times", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 13427,
            courseId: "55c2dea0fe00b30300d44121",
            name: "Chris Bargas Golf Club at Whitney Farms",
            timeZone: "America/New_York"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            teetimes: [
              {
                courseId: "55c2dea0fe00b30300d44121",
                teetime: "2026-07-10T17:50:00.000Z",
                rates: [
                  {
                    _id: -1,
                    allowedPlayers: [1, 2, 3, 4],
                    holes: 18,
                    greenFeeCart: 6700
                  }
                ]
              },
              {
                courseId: "55c2dea0fe00b30300d44121",
                teetime: "2026-07-10T18:00:00.000Z",
                rates: [
                  {
                    _id: -2,
                    allowedPlayers: [1, 2],
                    holes: 9,
                    greenFeeCart: 4200
                  }
                ]
              }
            ]
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    const slots = await fetchTeeItUpSlots({
      courseId: "course-1",
      date: new Date("2026-07-10T00:00:00-04:00"),
      metadata: {
        aliases: ["whitneyfarmsgolfcourse"],
        bookingBaseUrl: "https://whitneyfarmsgolfcourse.book.teeitup.golf/"
      }
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://phx-api-be-east-1b.kenna.io/alias/whitneyfarmsgolfcourse/facilities"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://phx-api-be-east-1b.kenna.io/v2/tee-times?date=2026-07-10&facilityIds=13427&returnPromotedRates=true"
    );
    expect(slots).toMatchObject([
      {
        sourceId: "teeitup-13427-55c2dea0fe00b30300d44121-2026-07-10T17:50:00.000Z",
        startsAt: "2026-07-10T13:50",
        availableSpots: 4,
        holes: 18,
        priceCents: 6700
      },
      {
        sourceId: "teeitup-13427-55c2dea0fe00b30300d44121-2026-07-10T18:00:00.000Z",
        startsAt: "2026-07-10T14:00",
        availableSpots: 2,
        holes: 9,
        priceCents: 4200
      }
    ]);
  });
});
