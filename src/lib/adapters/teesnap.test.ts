import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTeesnapSlots, fetchTeesnapTeeSheet, isTeesnapMetadata, TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE, type TeesnapTeeSheetInput } from "./teesnap";

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
        sourceId: "teesnap-1210-2026-07-11T12:30:00",
        availableSpots: 4,
        priceCents: 4800,
        holes: 18,
        priceOptions: [
          { holes: 9, priceCents: 2800 },
          { holes: 18, priceCents: 4800 }
        ],
        bookingUrl: "https://huntergolfclub.teesnap.net/?date=2026-07-11"
      })
    ]);
  });

  it("collapses front and back sections at one start while preserving distinct tee times", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        teeTimes: {
          bookings: [],
          teeTimes: [
            {
              teeTime: "2026-07-11T12:30:00",
              teeOffSections: [
                { teeOff: "FRONT_NINE", isHeld: false },
                { teeOff: "BACK_NINE", isHeld: false }
              ]
            },
            {
              teeTime: "2026-07-11T12:40:00",
              teeOffSections: [
                { teeOff: "FRONT_NINE", isHeld: false },
                { teeOff: "BACK_NINE", isHeld: true }
              ]
            }
          ]
        }
      })
    );

    const slots = await fetchTeesnapSlots({
      courseId: "course-hunter",
      date: new Date("2026-07-11T00:00:00-04:00"),
      players: 2,
      metadata: {
        provider: "TEESNAP",
        courseId: 1210,
        bookingBaseUrl: "https://huntergolfclub.teesnap.net/",
        defaultHoles: 18
      }
    });

    expect(slots).toEqual([
      expect.objectContaining({
        sourceId: "teesnap-1210-2026-07-11T12:30:00",
        startsAt: "2026-07-11T12:30"
      }),
      expect.objectContaining({
        sourceId: "teesnap-1210-2026-07-11T12:40:00",
        startsAt: "2026-07-11T12:40"
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

  it("learns the exact booking window from the public TeeSnap course configuration", async () => {
    let availabilityFinished = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input.toString().includes("/customer-api/teetimes-day")) {
        await Promise.resolve();
        availabilityFinished = true;
        return jsonResponse({ errors: "date_not_allowed" }, { status: 400 });
      }
      expect(availabilityFinished).toBe(true);
      return new Response(
        `<script>window.courses = [{"id":1210,"advance":7,"start_availability_time":"5:00 AM"}]; window.property = {};</script>`,
        { status: 200 }
      );
    });

    await expect(
      fetchTeesnapTeeSheet({
        courseId: "course-hunter",
        date: new Date("2026-07-29T00:00:00-04:00"),
        players: 4,
        discoverBookingWindow: true,
        metadata: {
          provider: "TEESNAP",
          courseId: 1210,
          bookingBaseUrl: "https://huntergolfclub.teesnap.net/"
        }
      })
    ).resolves.toMatchObject({
      slots: [],
      targetDateStatus: "NOT_OPEN",
      bookingWindowEvidence: {
        daysAhead: 7,
        releaseTimeLocal: "05:00",
        source: "PROVIDER_CONFIG",
        confidence: 1,
        evidenceUrl: "https://huntergolfclub.teesnap.net/"
      }
    });
  });
});

describe("strict learned Teesnap evidence", () => {
  const input = (): TeesnapTeeSheetInput => ({ courseId: "synthetic-course", date: new Date("2030-06-12T00:00:00Z"), players: 2,
    metadata: { provider: "TEESNAP", courseId: 81, bookingBaseUrl: "https://synthetic.teesnap.net/" }, strictPublicEvidence: true });
  const day = () => ({ teeTimes: { bookings: [{ bookingId: 11, golfers: [{ id: 1 }, { id: 2 }] }, { bookingId: 12, golfers: [{ id: 3 }] }],
    teeTimes: [{ teeTime: "2030-06-12T12:30:00", prices: [{ roundType: "EIGHTEEN_HOLE", price: "$48.00" }],
      teeOffSections: [{ teeOff: "FRONT_NINE", bookings: [11], isHeld: false }, { teeOff: "BACK_NINE", bookings: [12], isHeld: false }] }] } });
  type Day = ReturnType<typeof day>;
  const read = (payload: unknown) => vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

  it("uses only the injected public reader and retains max-free section semantics", async () => {
    const fetch = read(day());
    const result = await fetchTeesnapTeeSheet(input(), fetch);
    expect(result).toMatchObject({ targetDateStatus: "OPEN", slots: [{ sourceId: "teesnap-81-2030-06-12T12:30:00",
      startsAt: "2030-06-12T12:30", availableSpots: 3, priceCents: 4800 }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://synthetic.teesnap.net/customer-api/teetimes-day?course=81&date=2030-06-12&players=2&holes=18&addons=off&profileId=",
      expect.objectContaining({ headers: expect.objectContaining({ referer: "https://synthetic.teesnap.net/" }) }));
  });

  it("routes optional booking-window reads through the same injected reader", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(jsonResponse(day())).mockResolvedValueOnce(new Response(
      '<script>window.courses = [{"id":81,"advance":7,"start_availability_time":"5:00 AM"}]; window.property = {};</script>'));
    expect((await fetchTeesnapTeeSheet({ ...input(), discoverBookingWindow: true }, fetch)).bookingWindowEvidence).toMatchObject({ daysAhead: 7 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("proves a closed empty day and all-held or full sections without inventing openings", async () => {
    expect(await fetchTeesnapTeeSheet(input(), read({ teeTimes: { bookings: [], teeTimes: [] } }))).toMatchObject({ targetDateStatus: "OPEN", slots: [] });
    const held = day(); held.teeTimes.teeTimes[0].teeOffSections.forEach(section => { section.isHeld = true; });
    expect(await fetchTeesnapTeeSheet(input(), read(held))).toMatchObject({ targetDateStatus: "OPEN", slots: [] });
    const full = day(); full.teeTimes.bookings[0].golfers.push({ id: 4 }, { id: 5 });
    full.teeTimes.teeTimes[0].teeOffSections[1].isHeld = true;
    expect(await fetchTeesnapTeeSheet(input(), read(full))).toMatchObject({ targetDateStatus: "OPEN", slots: [] });
  });

  it("keeps not-open and incomplete legacy evidence distinct", async () => {
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ errors: "date_not_allowed" }, { status: 400 }));
    expect(await fetchTeesnapTeeSheet(input(), unavailable)).toMatchObject({ targetDateStatus: "NOT_OPEN", slots: [] });
    expect(await fetchTeesnapTeeSheet({ ...input(), strictPublicEvidence: undefined }, read({ teeTimes: {} }))).toMatchObject({ targetDateStatus: "UNKNOWN", slots: [] });
    await expect(fetchTeesnapTeeSheet(input(), read({ teeTimes: {} }))).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
  });

  const invalid: Array<[string, (value: Day) => void]> = [
    ["duplicate booking IDs", value => { value.teeTimes.bookings.push(value.teeTimes.bookings[0]); }],
    ["nonpositive booking ID", value => { value.teeTimes.bookings[0].bookingId = 0; }],
    ["oversized golfer party", value => { value.teeTimes.bookings[0].golfers = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 })); }],
    ["duplicate golfers", value => { value.teeTimes.bookings[0].golfers = [{ id: 1 }, { id: 1 }]; }],
    ["unknown section booking", value => { value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [99]; }],
    ["duplicate section bookings", value => { value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 11]; }],
    ["same golfer in two section bookings", value => { value.teeTimes.bookings[1].golfers[0].id = 1; value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 12]; }],
    ["overbooked section", value => { value.teeTimes.bookings[0].golfers.push({ id: 4 }, { id: 5 }); value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 12]; }],
    ["duplicate sections", value => { value.teeTimes.teeTimes[0].teeOffSections[1].teeOff = "FRONT_NINE"; }],
    ["missing sections", value => { value.teeTimes.teeTimes[0].teeOffSections = []; }],
    ["wrong date", value => { value.teeTimes.teeTimes[0].teeTime = "2030-06-13T12:30:00"; }],
    ["invalid hour", value => { value.teeTimes.teeTimes[0].teeTime = "2030-06-12T24:30:00"; }],
    ["invalid minute", value => { value.teeTimes.teeTimes[0].teeTime = "2030-06-12T12:60:00"; }],
    ["duplicate normalized start", value => { value.teeTimes.teeTimes.push({ ...value.teeTimes.teeTimes[0], teeTime: "2030-06-12T12:30:30" }); }],
    ["unknown round", value => { value.teeTimes.teeTimes[0].prices[0].roundType = "UNKNOWN"; }],
    ["invalid price", value => { value.teeTimes.teeTimes[0].prices[0].price = "48 USD private-payload"; }],
    ["nonpositive price", value => { value.teeTimes.teeTimes[0].prices[0].price = "0"; }],
    ["duplicate price round", value => { value.teeTimes.teeTimes[0].prices.push(value.teeTimes.teeTimes[0].prices[0]); }],
    ["oversized day", value => { value.teeTimes.teeTimes = Array.from({ length: 501 }, () => value.teeTimes.teeTimes[0]); }],
  ];
  it.each(invalid)("fails the entire day closed for %s", async (_name, mutate) => {
    const value = day(); mutate(value);
    await expect(fetchTeesnapTeeSheet(input(), read(value))).rejects.toThrow(/^TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE$/u);
  });
  it.each([null, { teeTimes: { bookings: [], teeTimes: [null] } }, { teeTimes: { bookings: [null], teeTimes: [] } },
    { teeTimes: { bookings: [{ bookingId: 11, golfers: [null] }], teeTimes: [] } },
    { teeTimes: { bookings: [], teeTimes: [{ teeTime: "2030-06-12T12:30:00", teeOffSections: [{ teeOff: "FRONT_NINE", isHeld: "false" }] }] } }])(
    "rejects malformed evidence without echoing its payload", async value => {
      await expect(fetchTeesnapTeeSheet(input(), read(value))).rejects.toThrow(/^TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE$/u);
    });
  it("rejects truncated JSON and wrong MIME instead of producing a partial or empty day", async () => {
    for (const response of [new Response('{"teeTimes":', { headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify(day()), { headers: { "content-type": "text/html" } })]) {
      await expect(fetchTeesnapTeeSheet(input(), vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow(/^TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE$/u);
    }
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
