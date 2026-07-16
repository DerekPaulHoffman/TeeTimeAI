import { describe, expect, it, vi } from "vitest";

import {
  fetchClubCaddieTeeSheet,
  isClubCaddieMetadata,
  parseClubCaddieSlots,
  type ClubCaddieMetadata
} from "./clubcaddie";

const metadata: ClubCaddieMetadata = {
  provider: "CLUB_CADDIE",
  bookingBaseUrl:
    "https://apimanager-cc28.clubcaddie.com/webapi/view/public-resource/slots"
};

const publicSearchPage = `
  <form id="SearchForm">
    <input value="front" name="HoleGroup" type="hidden">
    <input type="hidden" value="103436" name="CourseId">
    <input name="apikey" value="public-resource" type="hidden">
  </form>
`;

const availableSlots = `
  <div class="card card-box-outer">
    <div class="teetime bigscreen teetime-bigscreen">
      <div>Golfers: <span>2 - 4</span></div>
      <div>Starting 9: <span>Front</span></div>
      <div>Tee Time: <span>08:08 AM</span></div>
      <div>Price: <span>$20.00 - $34.00</span></div>
      <div>Holes: <span>9 Holes</span></div>
      <button>Book Now</button>
    </div>
    <div class="teetime smallscreen">
      Golfers: 2 - 4 Tee Time: 08:08 AM Price: $20.00 Holes: 9 Holes
    </div>
  </div>
  <div class="teetime bigscreen teetime-bigscreen">
    <div>Golfers: 1 - 2</div>
    <div>Starting 9: Back</div>
    <div>Tee Time: 01:24 PM</div>
    <div>Price: $42.50</div>
    <div>Holes: 18 Holes</div>
    <a href="#reserve">Reserve</a>
  </div>
`;

describe("isClubCaddieMetadata", () => {
  it("accepts only stable public Club Caddie tee-sheet roots", () => {
    expect(isClubCaddieMetadata(metadata)).toBe(true);
    expect(
      isClubCaddieMetadata({
        ...metadata,
        bookingBaseUrl:
          "https://apimanager-cc12.clubcaddie.com/webapi/view/championship-resource"
      })
    ).toBe(true);
    expect(
      isClubCaddieMetadata({
        ...metadata,
        bookingBaseUrl: `${metadata.bookingBaseUrl}?Interaction=do-not-persist`
      })
    ).toBe(false);
    expect(
      isClubCaddieMetadata({
        ...metadata,
        bookingBaseUrl:
          "https://apimanager-cc28.clubcaddie.com/authorization/signin/"
      })
    ).toBe(false);
    expect(
      isClubCaddieMetadata({
        ...metadata,
        bookingBaseUrl:
          "https://user:password@apimanager-cc28.clubcaddie.com/webapi/view/public-resource"
      })
    ).toBe(false);
  });
});

describe("parseClubCaddieSlots", () => {
  it("parses one desktop card per opening and honors the provider's minimum group size", () => {
    const onePlayer = parseClubCaddieSlots(availableSlots, {
      courseId: "course-1",
      providerCourseId: "103436",
      targetDate: "2026-07-19",
      players: 1,
      bookingBaseUrl: metadata.bookingBaseUrl
    });
    const twoPlayers = parseClubCaddieSlots(availableSlots, {
      courseId: "course-1",
      providerCourseId: "103436",
      targetDate: "2026-07-19",
      players: 2,
      bookingBaseUrl: metadata.bookingBaseUrl
    });

    expect(onePlayer).toEqual({
      responseRecognized: true,
      slots: [
        expect.objectContaining({
          sourceId: "clubcaddie-103436-20260719-1324-back-18",
          startsAt: "2026-07-19T13:24",
          availableSpots: 2,
          priceCents: 4250,
          holes: 18,
          bookingUrl: metadata.bookingBaseUrl,
          evidenceUrl: metadata.bookingBaseUrl
        })
      ]
    });
    expect(twoPlayers.slots).toHaveLength(2);
    expect(twoPlayers.slots[0]).toMatchObject({
      sourceId: "clubcaddie-103436-20260719-0808-front-9",
      startsAt: "2026-07-19T08:08",
      availableSpots: 4,
      holes: 9,
      bookableHoleCounts: [9]
    });
    expect(twoPlayers.slots[0]).not.toHaveProperty("priceCents");
  });

  it("recognizes an explicit empty public result without inventing a slot", () => {
    expect(
      parseClubCaddieSlots("<div>No tee times available for this date.</div>", {
        courseId: "course-1",
        providerCourseId: "103436",
        targetDate: "2026-07-19",
        players: 2,
        bookingBaseUrl: metadata.bookingBaseUrl
      })
    ).toEqual({ slots: [], responseRecognized: true });
  });

  it("does not convert a changed slot-card schema into a false no-match", () => {
    expect(
      parseClubCaddieSlots(
        '<div class="teetime bigscreen"><div>Unexpected provider fields</div></div>',
        {
          courseId: "course-1",
          providerCourseId: "103436",
          targetDate: "2026-07-19",
          players: 2,
          bookingBaseUrl: metadata.bookingBaseUrl
        }
      )
    ).toEqual({ slots: [], responseRecognized: false });
  });

  it("requires an actionable booking control before reporting a parsed-looking card", () => {
    expect(
      parseClubCaddieSlots(
        `<div class="teetime bigscreen">
          Golfers: 1 - 4 Starting 9: Front Tee Time: 08:08 AM
          Price: $42.50 Holes: 18 Holes
        </div>`,
        {
          courseId: "course-1",
          providerCourseId: "103436",
          targetDate: "2026-07-19",
          players: 2,
          bookingBaseUrl: metadata.bookingBaseUrl
        }
      )
    ).toEqual({ slots: [], responseRecognized: false });
  });

  it("recognizes explicit unavailable cards without turning them into openings", () => {
    const mixedCards = `
      <div class="teetime bigscreen">
        Golfers: 1 - 4 Starting 9: Front Tee Time: 08:08 AM
        Price: $42.50 Holes: 18 Holes
        <button>Book Now</button>
      </div>
      <div class="teetime bigscreen">
        Golfers: 1 - 4 Starting 9: Front Tee Time: 09:08 AM
        Price: $42.50 Holes: 18 Holes
        <button disabled>Book Now</button>
        <span>Sold out</span>
      </div>
    `;

    expect(
      parseClubCaddieSlots(mixedCards, {
        courseId: "course-1",
        providerCourseId: "103436",
        targetDate: "2026-07-19",
        players: 2,
        bookingBaseUrl: metadata.bookingBaseUrl
      })
    ).toEqual({
      slots: [expect.objectContaining({ startsAt: "2026-07-19T08:08" })],
      responseRecognized: true
    });
  });

  it("rejects invalid provider clocks and malformed cards even beside empty-result copy", () => {
    const invalidClock = availableSlots.replace("08:08 AM", "19:99 AM");
    expect(
      parseClubCaddieSlots(invalidClock, {
        courseId: "course-1",
        providerCourseId: "103436",
        targetDate: "2026-07-19",
        players: 2,
        bookingBaseUrl: metadata.bookingBaseUrl
      }).responseRecognized
    ).toBe(false);
    expect(
      parseClubCaddieSlots(
        '<div class="teetime bigscreen">Changed fields</div><footer>No tee times available</footer>',
        {
          courseId: "course-1",
          providerCourseId: "103436",
          targetDate: "2026-07-19",
          players: 2,
          bookingBaseUrl: metadata.bookingBaseUrl
        }
      )
    ).toEqual({ slots: [], responseRecognized: false });
  });
});

describe("fetchClubCaddieTeeSheet", () => {
  it("uses only the anonymous availability flow and never returns the interaction value", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response("<script>public session bootstrap</script>", {
          status: 200,
          headers: { "Session-Id": "request-local-session" }
        })
      )
      .mockResolvedValueOnce(new Response(publicSearchPage, { status: 200 }))
      .mockResolvedValueOnce(new Response(availableSlots, { status: 200 }));

    const result = await fetchClubCaddieTeeSheet(
      {
        courseId: "course-1",
        date: new Date("2026-07-19T00:00:00.000Z"),
        players: 2,
        metadata
      },
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [bootstrapUrl] = fetchImpl.mock.calls[0];
    const [bookingPageUrl] = fetchImpl.mock.calls[1];
    const [availabilityUrl, availabilityInit] = fetchImpl.mock.calls[2];
    expect(new URL(bootstrapUrl.toString()).searchParams.get("SetSessionIdInLocalStorage"))
      .toBe("true");
    expect(new URL(bookingPageUrl.toString()).searchParams.get("Interaction"))
      .toBe("request-local-session");
    expect(new URL(availabilityUrl.toString()).pathname).toBe("/webapi/TeeTimes");
    expect(availabilityInit.method).toBe("POST");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ credentials: "omit", cache: "no-store" });
      expect(JSON.stringify(init.headers)).not.toMatch(/cookie/i);
    }
    const requestBody = new URLSearchParams(availabilityInit.body.toString());
    expect(Object.fromEntries(requestBody)).toMatchObject({
      date: "07/19/2026",
      player: "2",
      holes: "any",
      CourseId: "103436",
      apikey: "public-resource",
      Interaction: "request-local-session"
    });
    expect(
      fetchImpl.mock.calls.map(([url]) => url.toString()).join(" ")
    ).not.toMatch(/authorization|checkout|cart/i);
    expect(JSON.stringify(result)).not.toContain("request-local-session");
    expect(result.slots[0]).toMatchObject({
      bookingUrl: metadata.bookingBaseUrl,
      evidenceUrl: metadata.bookingBaseUrl
    });
  });

  it("uses a valid public search form even when the provider page contains unrelated rendering warnings", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response("bootstrap", {
          status: 200,
          headers: { "Session-Id": "request-local-session" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          `<div>A PHP Error was encountered: Undefined property</div>${publicSearchPage}`,
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response("<div>No tee times available for this date.</div>", { status: 200 })
      );

    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl
      )
    ).resolves.toMatchObject({ slots: [], targetDateStatus: "OPEN" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the public interaction or response shape is missing", async () => {
    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        vi.fn().mockResolvedValue(new Response("bootstrap", { status: 200 }))
      )
    ).rejects.toMatchObject({ failureClass: "SCHEMA" });

    const unrecognizedFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response("bootstrap", {
          status: 200,
          headers: { "Session-Id": "request-local-session" }
        })
      )
      .mockResolvedValueOnce(new Response(publicSearchPage, { status: 200 }))
      .mockResolvedValueOnce(new Response("<div>unexpected response</div>", { status: 200 }));

    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        unrecognizedFetch
      )
    ).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });

  it("classifies an active challenge without attempting availability", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(
        new Response("bootstrap", {
          status: 200,
          headers: { "Session-Id": "request-local-session" }
        })
      )
      .mockResolvedValueOnce(
        new Response("<div>Complete the CAPTCHA challenge</div>", { status: 200 })
      );

    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl
      )
    ).rejects.toMatchObject({ failureClass: "CHALLENGE" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a bootstrap interaction when that response is an active challenge", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<div>Complete the CAPTCHA challenge</div>", {
        status: 200,
        headers: { "Session-Id": "request-local-session" }
      })
    );

    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        fetchImpl
      )
    ).rejects.toMatchObject({ failureClass: "CHALLENGE" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies non-success challenge and queue responses before generic HTTP failures", async () => {
    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        vi.fn().mockResolvedValue(
          new Response("challenge", {
            status: 403,
            headers: { "cf-mitigated": "challenge" }
          })
        )
      )
    ).rejects.toMatchObject({ failureClass: "CHALLENGE" });

    await expect(
      fetchClubCaddieTeeSheet(
        {
          courseId: "course-1",
          date: new Date("2026-07-19T00:00:00.000Z"),
          players: 2,
          metadata
        },
        vi.fn().mockResolvedValue(
          new Response("You are in line in the virtual queue.", { status: 503 })
        )
      )
    ).rejects.toMatchObject({ failureClass: "CHALLENGE" });
  });
});
