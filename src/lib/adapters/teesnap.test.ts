import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchTeesnapSlots, fetchTeesnapTeeSheet, isTeesnapMetadata, TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE, TEESNAP_PUBLIC_USER_AGENT, type TeesnapTeeSheetInput } from "./teesnap";

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

describe("modern signed-out Teesnap public day", () => {
  const input = (): TeesnapTeeSheetInput => ({ courseId: "synthetic-course", date: new Date("2030-06-12T00:00:00Z"), players: 2,
    metadata: { provider: "TEESNAP", courseId: 81, bookingBaseUrl: "https://synthetic.teesnap.net/", publicApiVersion: "BOOKINGSITE_V1" } });
  const row = (minute: number, bookings?: number[]) => ({ teeTime: `2030-06-12T12:${minute}:00`, squeezeTime: false, shotgun: false,
    prices: [{ roundType: "EIGHTEEN_HOLE", price: "48.00", taxInclusive: false }],
    teeOffSections: [{ teeOff: "FRONT_NINE", isHeld: false, ...(bookings === undefined ? {} : { bookings }) }] });
  const day = () => ({ teeTimes: { bookings: [{ bookingId: 11, golfers: [1, 2] }, { bookingId: 12, golfers: [3] }],
    golfers: [{ id: 1 }, { id: 2 }, { id: 3 }], teeSheetPriceOverrides: [] as unknown[], teeTimes: [row(30, [11])] } });
  const read = (payload: unknown) => vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

  it("recognizes only the explicit supported API version", () => {
    expect(isTeesnapMetadata(input().metadata)).toBe(true);
    for (const publicApiVersion of ["BOOKINGSITE_V2", "", null, 1]) expect(isTeesnapMetadata({ ...input().metadata, publicApiVersion })).toBe(false);
  });

  it.each([1, 2, 3, 4])("resolves numeric references for %i free spots using the exact public request", async free => {
    const value = day();
    value.teeTimes.bookings = [{ bookingId: 11, golfers: Array.from({ length: 4 - free }, (_, i) => i + 1) }];
    value.teeTimes.teeTimes = [row(30, free === 4 ? undefined : [11])];
    const fetch = read(value), result = await fetchTeesnapTeeSheet({ ...input(), players: free }, fetch);
    expect(result).toMatchObject({ targetDateStatus: "OPEN", slots: [{ availableSpots: free, holes: 18, priceCents: 4800 }] });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://synthetic.api.teesnap.net/api/bookingsite/teetimes-day?course=81&date=2030-06-12&players=" + free + "&holes=18&addons=off",
      expect.objectContaining({ headers: { accept: "application/json, text/plain, */*", referer: "https://synthetic.teesnap.net/", "user-agent": TEESNAP_PUBLIC_USER_AGENT } }));
    const options = fetch.mock.calls[0][1]!;
    expect(options).not.toHaveProperty("credentials");
    expect(result).not.toHaveProperty("golfers");
    expect(JSON.stringify(result)).not.toContain("bookingId");
  });

  it("uses maximum unheld section capacity and never adds front and back capacity", async () => {
    const value = day();
    value.teeTimes.teeTimes[0].teeOffSections.push({ teeOff: "BACK_NINE", bookings: [12], isHeld: false });
    expect(await fetchTeesnapTeeSheet(input(), read(value))).toMatchObject({ slots: [{ availableSpots: 3 }] });
    value.teeTimes.teeTimes[0].teeOffSections[1].isHeld = true;
    expect(await fetchTeesnapTeeSheet(input(), read(value))).toMatchObject({ slots: [{ availableSpots: 2 }] });
    value.teeTimes.teeTimes[0].teeOffSections[0].isHeld = true;
    expect(await fetchTeesnapTeeSheet(input(), read(value))).toMatchObject({ targetDateStatus: "OPEN", slots: [] });
  });

  it("emits only rows priced for the requested round, including changed 9-hole inputs", async () => {
    const value = day();
    value.teeTimes.teeTimes = [row(30), row(40)];
    value.teeTimes.teeTimes[0].prices[0].roundType = "NINE_HOLE";
    expect(await fetchTeesnapTeeSheet(input(), read(value))).toMatchObject({ slots: [{ startsAt: "2030-06-12T12:40", holes: 18 }] });
    expect(await fetchTeesnapTeeSheet({ ...input(), metadata: { ...input().metadata, defaultHoles: 9 } }, read(value)))
      .toMatchObject({ slots: [{ startsAt: "2030-06-12T12:30", holes: 9 }] });
    value.teeTimes.teeTimes.forEach(row => { row.prices = []; });
    expect(await fetchTeesnapTeeSheet(input(), read(value))).toMatchObject({ targetDateStatus: "OPEN", slots: [] });
  });

  it("requires complete empty-day arrays and does not carry private roster fields into output", async () => {
    const value = day(); Object.assign(value.teeTimes.golfers[0], { name: "unneeded-private-field", email: "unused@example.invalid" });
    expect(JSON.stringify(await fetchTeesnapTeeSheet(input(), read(value)))).not.toMatch(/unneeded-private-field|unused@example/);
    expect(await fetchTeesnapTeeSheet(input(), read({ teeTimes: { bookings: [], golfers: [], teeSheetPriceOverrides: [], teeTimes: [] } })))
      .toMatchObject({ targetDateStatus: "OPEN", slots: [] });
  });

  const invalid: Array<[string, (value: ReturnType<typeof day>) => void]> = [
    ["duplicate global golfer", value => { value.teeTimes.golfers.push({ id: 1 }); }],
    ["negative global golfer", value => { value.teeTimes.golfers[0].id = -1; }],
    ["fractional global golfer", value => { value.teeTimes.golfers[0].id = 1.5; }],
    ["unknown golfer reference", value => { value.teeTimes.bookings[0].golfers = [99]; }],
    ["duplicate golfer reference", value => { value.teeTimes.bookings[0].golfers = [1, 1]; }],
    ["negative golfer reference", value => { value.teeTimes.bookings[0].golfers = [-1]; }],
    ["duplicate booking", value => { value.teeTimes.bookings.push(value.teeTimes.bookings[0]); }],
    ["unknown booking reference", value => { value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [99]; }],
    ["duplicate booking reference", value => { value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 11]; }],
    ["duplicate joined golfer", value => { value.teeTimes.bookings[1].golfers = [1]; value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 12]; }],
    ["overfull section", value => { value.teeTimes.bookings[0].golfers = [1, 2, 3]; value.teeTimes.teeTimes[0].teeOffSections[0].bookings = [11, 12]; value.teeTimes.bookings[1].golfers = [1, 2]; }],
    ["foreign date", value => { value.teeTimes.teeTimes[0].teeTime = "2030-06-13T12:30:00"; }],
    ["duplicate section", value => { value.teeTimes.teeTimes[0].teeOffSections.push(value.teeTimes.teeTimes[0].teeOffSections[0]); }],
    ["zero price", value => { value.teeTimes.teeTimes[0].prices[0].price = "0"; }],
    ["unverified price override", value => { value.teeTimes.teeSheetPriceOverrides.push({}); }],
  ];
  it.each(invalid)("rejects the entire joined day for %s", async (_name, mutate) => {
    const value = day(); mutate(value);
    await expect(fetchTeesnapTeeSheet(input(), read(value))).rejects.toThrow(/^TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE$/u);
  });

  it.each(["golfers", "bookings", "teeSheetPriceOverrides", "teeTimes"])("rejects a missing required %s array", async key => {
    const value = day(); delete (value.teeTimes as Record<string, unknown>)[key];
    await expect(fetchTeesnapTeeSheet(input(), read(value))).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
  });
  it.each(["bookings", "isHeld", "teeOff", "squeezeTime", "shotgun", "prices", "taxInclusive"])("does not mistake invalid %s for an empty section", async key => {
    const value = day(), section = value.teeTimes.teeTimes[0].teeOffSections[0];
    if (key === "bookings") Object.assign(section, { bookings: null });
    else if (key === "isHeld" || key === "teeOff") delete (section as Record<string, unknown>)[key];
    else if (key === "taxInclusive") delete (value.teeTimes.teeTimes[0].prices[0] as Record<string, unknown>)[key];
    else delete (value.teeTimes.teeTimes[0] as Record<string, unknown>)[key];
    await expect(fetchTeesnapTeeSheet(input(), read(value))).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
  });
  it.each(["https://api.teesnap.net/", "https://synthetic.api.teesnap.net/", "https://synthetic.teesnap.net/not-root", "https://synthetic.teesnap.net/?profileId=1", "http://synthetic.teesnap.net/"])(
    "rejects noncanonical modern roots before any read: %s", async bookingBaseUrl => {
      const fetch = read(day());
      await expect(fetchTeesnapTeeSheet({ ...input(), metadata: { ...input().metadata, bookingBaseUrl } }, fetch)).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
      expect(fetch).not.toHaveBeenCalled();
    });
  it("rejects unknown error/envelope fields, malformed JSON, wrong MIME and unobserved modern HTTP errors", async () => {
    for (const payload of [{ ...day(), errors: "" }, { ...day(), hasMore: true }, { success: true, data: day() }, null]) {
      await expect(fetchTeesnapTeeSheet(input(), read(payload))).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
    }
    for (const response of [new Response('{"teeTimes":', { headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify(day()), { headers: { "content-type": "text/html" } })]) {
      await expect(fetchTeesnapTeeSheet(input(), vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow(TEESNAP_PUBLIC_EVIDENCE_INCOMPLETE);
    }
    await expect(fetchTeesnapTeeSheet(input(), vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ errors: "date_not_allowed" }, { status: 400 }))))
      .rejects.toThrow("returned 400");
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
