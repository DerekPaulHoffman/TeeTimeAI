import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchTeeItUpSlots,
  fetchTeeItUpTeeSheet,
  isTeeItUpMetadata
} from "./teeitup";

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
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        origin: "https://whitneyfarmsgolfcourse.book.teeitup.golf",
        referer: "https://whitneyfarmsgolfcourse.book.teeitup.golf/"
      }
    });
    expect(slots).toMatchObject([
      {
        sourceId: "teeitup-13427-55c2dea0fe00b30300d44121-2026-07-10T17:50:00.000Z",
        startsAt: "2026-07-10T13:50",
        availableSpots: 4,
        holes: 18,
        priceCents: 6700,
        priceOptions: [{ holes: 18, priceCents: 6700 }]
      },
      {
        sourceId: "teeitup-13427-55c2dea0fe00b30300d44121-2026-07-10T18:00:00.000Z",
        startsAt: "2026-07-10T14:00",
        availableSpots: 2,
        holes: 9,
        priceCents: 4200,
        priceOptions: [{ holes: 9, priceCents: 4200 }]
      }
    ]);
  });

  it("fails before reading inventory when one unscoped alias exposes multiple facilities", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 24680,
          courseId: "first-course",
          name: "First Golf Course",
          timeZone: "America/New_York"
        },
        {
          id: 13579,
          courseId: "second-course",
          name: "Second Golf Course",
          timeZone: "America/New_York"
        }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchTeeItUpSlots({
        courseId: "target-course",
        date: new Date("2026-07-28T00:00:00-04:00"),
        metadata: {
          aliases: ["shared-public"],
          bookingBaseUrl: "https://shared-public.book.teeitup.com/"
        }
      })
    ).rejects.toThrow("ambiguous facility set");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "missing", facility: { courseId: "target-course" } },
    { label: "string", facility: { id: "24680", courseId: "target-course" } },
    { label: "zero", facility: { id: 0, courseId: "target-course" } },
    { label: "negative", facility: { id: -1, courseId: "target-course" } },
    { label: "decimal", facility: { id: 24.68, courseId: "target-course" } }
  ])(
    "fails before reading inventory for a $label unscoped facility id",
    async ({ facility }) => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => [facility]
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchTeeItUpSlots({
          courseId: "target-course",
          date: new Date("2026-07-28T00:00:00-04:00"),
          metadata: {
            aliases: ["single-public"],
            bookingBaseUrl: "https://single-public.book.teeitup.com/"
          }
        })
      ).rejects.toThrow("invalid facility identifier");
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  );

  it("limits a shared alias request and booking link to the selected facility", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 24680,
            courseId: "rock-creek-course",
            name: "Rock Creek Park Golf",
            timeZone: "America/New_York"
          },
          {
            id: 13579,
            courseId: "sibling-course",
            name: "Sibling Golf Course",
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
                courseId: "rock-creek-course",
                teetime: "2026-07-28T12:00:00.000Z",
                rates: [
                  {
                    allowedPlayers: [1, 2, 3, 4],
                    holes: 9,
                    greenFeeCart: 2400
                  }
                ]
              }
            ]
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    const slots = await fetchTeeItUpSlots({
      courseId: "rock-creek",
      date: new Date("2026-07-28T00:00:00-04:00"),
      metadata: {
        aliases: ["play-dc-golf-public"],
        bookingBaseUrl:
          "https://play-dc-golf-public.book.teeitup.com/?course=24680",
        facilityIds: [24680]
      }
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://phx-api-be-east-1b.kenna.io/v2/tee-times?date=2026-07-28&facilityIds=24680&returnPromotedRates=true"
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({
      courseId: "rock-creek",
      sourceId:
        "teeitup-24680-rock-creek-course-2026-07-28T12:00:00.000Z",
      bookingUrl:
        "https://play-dc-golf-public.book.teeitup.com/?course=24680&date=2026-07-28",
      holes: 9,
      priceCents: 2400
    });
  });

  it("fails when the selected facility is absent instead of reporting an empty tee sheet", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 13579,
          courseId: "sibling-course",
          name: "Sibling Golf Course",
          timeZone: "America/New_York"
        }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchTeeItUpTeeSheet({
        courseId: "rock-creek",
        date: new Date("2026-07-28T00:00:00-04:00"),
        metadata: {
          aliases: ["play-dc-golf-public"],
          bookingBaseUrl:
            "https://play-dc-golf-public.book.teeitup.com/?course=24680",
          facilityIds: [24680]
        }
      })
    ).rejects.toThrow("did not return the selected facility");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails when a scoped provider response references a sibling course", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 24680,
            courseId: "rock-creek-course",
            name: "Rock Creek Park Golf",
            timeZone: "America/New_York"
          },
          {
            id: 13579,
            courseId: "sibling-course",
            name: "Sibling Golf Course",
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
                courseId: "sibling-course",
                teetime: "2026-07-28T12:10:00.000Z",
                rates: [
                  {
                    allowedPlayers: [1, 2, 3, 4],
                    holes: 18,
                    greenFeeCart: 9000
                  }
                ]
              }
            ]
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchTeeItUpSlots({
        courseId: "rock-creek",
        date: new Date("2026-07-28T00:00:00-04:00"),
        metadata: {
          aliases: ["play-dc-golf-public"],
          bookingBaseUrl:
            "https://play-dc-golf-public.book.teeitup.com/?course=24680",
          facilityIds: [24680]
        }
      })
    ).rejects.toThrow("outside the selected facility set");
  });

  it("rejects duplicate selectors and scoped metadata that is not bound to one alias", () => {
    expect(
      isTeeItUpMetadata({
        aliases: ["play-dc-golf-public"],
        bookingBaseUrl:
          "https://play-dc-golf-public.book.teeitup.com/?course=24680&course=24680",
        facilityIds: [24680]
      })
    ).toBe(false);
    expect(
      isTeeItUpMetadata({
        aliases: ["play-dc-golf-public", "play-dc-golf-senior"],
        bookingBaseUrl:
          "https://play-dc-golf-public.book.teeitup.com/?course=24680",
        facilityIds: [24680]
      })
    ).toBe(false);
    expect(
      isTeeItUpMetadata({
        aliases: ["different-alias"],
        bookingBaseUrl:
          "https://play-dc-golf-public.book.teeitup.com/?course=24680",
        facilityIds: [24680]
      })
    ).toBe(false);
  });

  it.each([
    "not-a-url",
    "http://play-dc-golf-public.book.teeitup.com/",
    "https://example.com/",
    "https://user@play-dc-golf-public.book.teeitup.com/",
    "https://play-dc-golf-public.book.teeitup.com:8443/",
    "https://play-dc-golf-public.book.teeitup.com/store/",
    "https://play-dc-golf-public.book.teeitup.com/#tee-times",
    "https://play-dc-golf-public.book.teeitup.com/?course=24680&session=unsafe"
  ])("rejects a non-canonical TeeItUp booking base URL %s", (bookingBaseUrl) => {
    expect(
      isTeeItUpMetadata({
        aliases: ["play-dc-golf-public"],
        bookingBaseUrl,
        ...(bookingBaseUrl.includes("course=24680")
          ? { facilityIds: [24680] }
          : {})
      })
    ).toBe(false);
  });

  it("keeps canonical unscoped legacy TeeItUp metadata valid", () => {
    expect(
      isTeeItUpMetadata({
        aliases: ["red-course", "black-course"],
        bookingBaseUrl: "https://red-course.book.teeitup.golf/"
      })
    ).toBe(true);
  });

  it("uses each legacy alias as the booking URL for its own slots", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 111,
            courseId: "red-course-id",
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
                courseId: "red-course-id",
                teetime: "2026-07-12T12:00:00.000Z",
                rates: [{ allowedPlayers: [1, 2, 3, 4], holes: 18 }]
              }
            ]
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 222,
            courseId: "black-course-id",
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
                courseId: "black-course-id",
                teetime: "2026-07-12T13:00:00.000Z",
                rates: [{ allowedPlayers: [1, 2], holes: 9 }]
              }
            ]
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    const slots = await fetchTeeItUpSlots({
      courseId: "legacy-shared-course",
      date: new Date("2026-07-12T00:00:00-04:00"),
      metadata: {
        aliases: ["red-course", "black-course"],
        bookingBaseUrl: "https://red-course.book.teeitup.com/"
      }
    });

    expect(slots.map((slot) => slot.bookingUrl)).toEqual([
      "https://red-course.book.teeitup.com/?date=2026-07-12",
      "https://black-course.book.teeitup.com/?date=2026-07-12"
    ]);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: {
        origin: "https://black-course.book.teeitup.com",
        referer: "https://black-course.book.teeitup.com/"
      }
    });
  });

  it.each(["0", "-1", "1.5", "1e3", "%2024680", "9007199254740992"])(
    "rejects an unsafe TeeItUp facility selector %s",
    (selector) => {
      expect(
        isTeeItUpMetadata({
          aliases: ["play-dc-golf-public"],
          bookingBaseUrl:
            `https://play-dc-golf-public.book.teeitup.com/?course=${selector}`,
          facilityIds: [24680]
        })
      ).toBe(false);
    }
  );

  it("uses the legacy .com booking origin when the course metadata requires it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 5789,
            courseId: "richter-course",
            timeZone: "America/New_York"
          }
        ]
      })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await fetchTeeItUpSlots({
      courseId: "course-richter",
      date: new Date("2026-07-11T00:00:00-04:00"),
      metadata: {
        aliases: ["richter-park-golf-course"],
        bookingBaseUrl: "https://richter-park-golf-course.book.teeitup.com/"
      }
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        origin: "https://richter-park-golf-course.book.teeitup.com",
        referer: "https://richter-park-golf-course.book.teeitup.com/"
      }
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        origin: "https://richter-park-golf-course.book.teeitup.com",
        referer: "https://richter-park-golf-course.book.teeitup.com/"
      }
    });
  });

  it("learns an exact release date and time from the provider response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            id: 13427,
            courseId: "55c2dea0fe00b30300d44121",
            timeZone: "America/New_York"
          }
        ]
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          {
            courseId: "55c2dea0fe00b30300d44121",
            teetimes: [],
            message:
              "Tee times will be available to book from Wednesday, July 29, 2026 at 12:00 AM"
          }
        ]
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchTeeItUpTeeSheet({
        courseId: "course-1",
        date: new Date("2026-08-12T00:00:00-04:00"),
        metadata: {
          aliases: ["whitneyfarmsgolfcourse"],
          bookingBaseUrl: "https://whitneyfarmsgolfcourse.book.teeitup.golf/"
        }
      })
    ).resolves.toMatchObject({
      slots: [],
      targetDateStatus: "NOT_OPEN",
      bookingWindowEvidence: {
        daysAhead: 14,
        releaseTimeLocal: "00:00",
        source: "PROVIDER_MESSAGE",
        confidence: 1
      }
    });
  });
});
