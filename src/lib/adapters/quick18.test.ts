import { describe, expect, it, vi } from "vitest";

import {
  fetchQuick18TeeSheet,
  isQuick18Metadata,
  isQuick18PublicSearchUrl,
  parseQuick18Slots
} from "./quick18";

const bookingBaseUrl = "https://mountsnow.quick18.com/teetimes/searchmatrix";
const evidenceUrl = `${bookingBaseUrl}?teedate=20260929`;
const metadata = { provider: "QUICK18" as const, bookingBaseUrl };
const targetDate = "2026-09-29";

function page(rows: string, displayedDate = "9/29/2026", headers = ["Tee Time", "Players", "Daily Rate", "Member Rate"]) {
  return `<!doctype html><html><body>
    <form action="/teetimes/searchmatrix?teedate=20260929" method="post">
      <input id="SearchForm_Date" value="${displayedDate}">
    </form>
    <div id="searchMatrix"><a href="/teetimes/searchmatrix?teedate=20260929">Sep 29</a>
    <table class="matrixTable"><thead><tr>
      ${headers.map((header) => `<th>${header}</th>`).join("")}
    </tr></thead><tbody>${rows}</tbody></table></div>
  </body></html>`;
}

const solitudeHeaders = [
  "Tee Time", "Course", "Players", "18 Holes", "9 Holes", "Back 9 Holes",
  "Group Golfer", "Friday Couples Special", "Locals Twilight"
];

function solitudeRow(options: {
  time?: string;
  course?: string;
  players?: string;
  providerCourseId?: string;
  eighteen?: string;
  nine?: string;
  reverseRates?: boolean;
}) {
  const time = options.time ?? "11:03AM";
  const stamp = `20260929${time === "11:03AM" ? "1103" : "1200"}`;
  const courseId = options.providerCourseId ?? "1367";
  const link = (price: string, psid: string) =>
    `<div class="mtrxPrice">${price}</div><a href="/teetimes/course/${courseId}/teetime/${stamp}?psid=${psid}&amp;p=0">Select</a>`;
  const eighteen = options.eighteen ?? link("$55.00", "6786");
  const nine = options.nine ?? link("$35.00", "6787");
  return `<tr>
    <td>${time}</td><td>${options.course ?? "Solitude Links"}</td>
    <td>${options.players ?? "1 to 4 players"}</td>
    <td>${options.reverseRates ? nine : eighteen}</td>
    <td>${options.reverseRates ? eighteen : nine}</td>
    <td>N/A Rate not available for date selected</td>
    <td>${link("$0.00", "6788")}</td><td>N/A</td><td>N/A</td>
  </tr>`;
}

function row(time: string, players: string, stamp: string, publicHref?: string) {
  const publicLink = publicHref ??
    `/teetimes/course/1202/teetime/${stamp}?psid=6786&amp;p=0`;
  return `<tr>
    <td class="mtrxTeeTimes">${time}</td><td class="matrixPlayers">${players}</td>
    <td class="matrixsched"><div class="mtrxPrice">$84.00</div>
      <a href="${publicLink}">Select</a></td>
    <td class="matrixsched"><div class="mtrxPrice">$0.00</div>
      <a href="/teetimes/course/1202/teetime/${stamp}?psid=6860&amp;p=0">Select</a></td>
  </tr>`;
}

function parse(html: string, players = 2) {
  return parseQuick18Slots({
    html,
    courseId: "mount-snow",
    targetDate,
    players,
    evidenceUrl
  });
}

function parseSolitude(html: string, players = 2) {
  return parseQuick18Slots({
    html, courseId: "solitude", targetDate, players, evidenceUrl,
    courseName: "Solitude Links Golf Course & Banquet Center"
  });
}

describe("Quick18 public read-only tee sheet", () => {
  it("accepts only a tenant public search page and bounded date query", () => {
    expect(isQuick18Metadata(metadata)).toBe(true);
    expect(isQuick18PublicSearchUrl(`${bookingBaseUrl}?teedate=20260929`)).toBe(true);
    for (const unsafe of [
      "https://quick18.com/teetimes/searchmatrix",
      "https://www.quick18.com/teetimes/searchmatrix",
      "https://mountsnow.quick18.com/account",
      "https://mountsnow.quick18.com/teetimes/course/1202/teetime/202609290800",
      `${bookingBaseUrl}?teedate=20260230`,
      `${bookingBaseUrl}?teedate=20260929&token=secret`,
      "https://mountsnow.quick18.com.evil.example/teetimes/searchmatrix",
      "https://user:pass@mountsnow.quick18.com/teetimes/searchmatrix"
    ]) {
      expect(isQuick18PublicSearchUrl(unsafe)).toBe(false);
    }
  });

  it("reads course-local times, player capacity and only the public rate link", async () => {
    const html = page(
      row("8:00<div>AM</div>", "1 to 3 players", "202609290800") +
      row("12:00<div>PM</div>", "1 to 4 players", "202609291200")
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    );

    const result = await fetchQuick18TeeSheet(
      { courseId: "mount-snow", date: new Date("2026-09-29T00:00:00.000Z"), players: 2, metadata },
      fetchImpl
    );

    expect(fetchImpl).toHaveBeenCalledWith(evidenceUrl, expect.objectContaining({
      method: "GET",
      redirect: "manual"
    }));
    expect(fetchImpl.mock.calls[0][1]).not.toHaveProperty("body");
    expect(result).toMatchObject({
      targetDateStatus: "OPEN",
      bookingWindowEvidence: null,
      slots: [
        {
          sourceId: "quick18-mountsnow-1202-202609290800",
          startsAt: "2026-09-29T08:00",
          availableSpots: 3,
          priceCents: 8400,
          bookingUrl: "https://mountsnow.quick18.com/teetimes/course/1202/teetime/202609290800?psid=6786&p=0",
          evidenceUrl
        },
        { startsAt: "2026-09-29T12:00", availableSpots: 4 }
      ]
    });
    expect(result.slots.every((slot) => !slot.bookingUrl.includes("psid=6860"))).toBe(true);
    expect(parse(html, 4).map((slot) => slot.startsAt)).toEqual(["2026-09-29T12:00"]);
  });

  it("reads the optional Course column and positive 18/9-hole rates without using group specials", () => {
    const html = page(
      solitudeRow({}) + solitudeRow({
        time: "12:00PM",
        players: "1 or 2 players",
        eighteen: "N/A Rate not available for date selected"
      }),
      "9/29/2026",
      solitudeHeaders
    );
    expect(parseSolitude(html)).toMatchObject([
      {
        startsAt: "2026-09-29T11:03",
        priceCents: 5500,
        holes: 18,
        bookableHoleCounts: [18, 9],
        priceOptions: [{ holes: 18, priceCents: 5500 }, { holes: 9, priceCents: 3500 }],
        bookingUrl: "https://mountsnow.quick18.com/teetimes/course/1367/teetime/202609291103?psid=6786&p=0"
      },
      {
        startsAt: "2026-09-29T12:00",
        priceCents: 3500,
        bookingUrl: "https://mountsnow.quick18.com/teetimes/course/1367/teetime/202609291200?psid=6787&p=0"
      }
    ]);
    expect(parseSolitude(html, 4)).toHaveLength(1);
    expect(parseSolitude(html).every((slot) => !slot.bookingUrl.includes("psid=6788"))).toBe(true);
    expect(parseQuick18Slots({
      html, courseId: "solitude", targetDate, players: 2, evidenceUrl,
      providerCourseId: "1367", courseName: "Solitude Links Golf Course"
    })).toHaveLength(2);
    const reversedHeaders = [...solitudeHeaders];
    [reversedHeaders[3], reversedHeaders[4]] = [reversedHeaders[4], reversedHeaders[3]];
    expect(parseSolitude(page(solitudeRow({ reverseRates: true }), "9/29/2026", reversedHeaders))[0]).toMatchObject({
      holes: 18,
      priceCents: 5500,
      priceOptions: [{ holes: 18, priceCents: 5500 }, { holes: 9, priceCents: 3500 }]
    });
  });

  it("rejects ambiguous round rates and mixed or mismatched course identities", () => {
    const sheet = (rows: string) => page(rows, "9/29/2026", solitudeHeaders);
    expect(() => parseSolitude(sheet(solitudeRow({
      eighteen: `<div>$0.00</div><a href="/teetimes/course/1367/teetime/202609291103?psid=6786&amp;p=0">Select</a>`,
      nine: "N/A"
    })))).toThrow(/public rate is ambiguous/u);
    expect(() => parseSolitude(sheet(solitudeRow({
      eighteen: `<div>$55.00 Member Special</div><a href="/teetimes/course/1367/teetime/202609291103?psid=6786&amp;p=0">Select</a>`,
      nine: "N/A"
    })))).toThrow(/public rate is ambiguous/u);
    expect(() => parseSolitude(sheet(solitudeRow({
      eighteen: `<div>$0.00</div><a href="/teetimes/course/1367/teetime/202609291103?psid=6786&amp;p=0">Select</a>`
    })))).toThrow(/public rate is ambiguous/u);
    expect(() => parseSolitude(sheet(solitudeRow({}) + solitudeRow({
      time: "12:00PM", course: "Other Course"
    })))).toThrow(/mixes courses/u);
    expect(() => parseSolitude(sheet(solitudeRow({}) + solitudeRow({
      time: "12:00PM", providerCourseId: "9999"
    })))).toThrow(/mixes provider courses/u);
    expect(() => parse(sheet(solitudeRow({})))).toThrow(/course identity is unbound/u);
    expect(() => parseQuick18Slots({
      html: sheet(solitudeRow({})), courseId: "solitude", targetDate, players: 2,
      evidenceUrl, providerCourseId: "9999", courseName: "Solitude Links Golf Course"
    })).toThrow(/mixes provider courses/u);
    expect(() => parseQuick18Slots({
      html: sheet(solitudeRow({})), courseId: "solitude", targetDate, players: 2,
      evidenceUrl, courseName: "Another Golf Club"
    })).toThrow(/does not match the official course/u);
    expect(() => parseQuick18Slots({
      html: sheet(solitudeRow({ course: "Solstice Links" })),
      courseId: "solitude", targetDate, players: 2,
      evidenceUrl, courseName: "Solitude Links Golf Course & Banquet Center"
    })).toThrow(/does not match the official course/u);
    expect(parseQuick18Slots({
      html: sheet(solitudeRow({})), courseId: "solitude", targetDate, players: 2,
      evidenceUrl, courseName: "Solitude Links Golf Course & Banquet Center"
    })).toHaveLength(1);
    expect(isQuick18Metadata({ ...metadata, providerCourseId: "1367" })).toBe(true);
    expect(isQuick18Metadata({ ...metadata, providerCourseId: "wrong" })).toBe(false);
    expect(isQuick18Metadata({ ...metadata, courseName: "" })).toBe(false);
  });

  it("enforces persisted course identity during the public read", async () => {
    const html = page(solitudeRow({}), "9/29/2026", solitudeHeaders);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    );
    await expect(fetchQuick18TeeSheet({
      courseId: "solitude",
      date: new Date("2026-09-29T00:00:00.000Z"),
      players: 2,
      metadata: {
        ...metadata,
        courseName: "Solitude Links Golf Course",
        providerCourseId: "9999"
      }
    }, fetchImpl)).rejects.toThrow(/mixes provider courses/u);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports zero slots for a complete server-rendered empty matrix or explicit no-times row", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(page('<tr><td colspan="4">No tee times available</td></tr>'), { status: 200, headers: { "content-type": "text/html" } })
    );
    await expect(
      fetchQuick18TeeSheet(
        { courseId: "mount-snow", date: new Date("2026-09-29T00:00:00.000Z"), players: 2, metadata },
        fetchImpl
      )
    ).resolves.toEqual({ slots: [], targetDateStatus: "OPEN", bookingWindowEvidence: null });
    expect(parse(page(""))).toEqual([]);
    expect(parse(page(row("8:00<div>AM</div>", "1 to 3 players", "202609290800")), 4)).toEqual([]);
  });

  it("fails closed on a changed date, account page, and unsafe selection links", () => {
    expect(() => parse(page("", "9/30/2026"))).toThrow(/requested date/u);
    expect(() => parse("<html><h1>Sign in</h1></html>")).toThrow(/requested date/u);
    expect(() => parse(page("").replace("</body></html>", ""))).toThrow(/incomplete/u);
    expect(() => parse(page("").replace("</body>", "<div>Loading tee times, please wait</div></body>"))).toThrow(/still loading/u);
    expect(() => parse(page("").replace('id="searchMatrix"', 'id="loading"'))).toThrow(/matrix is missing/u);
    expect(() => parse(page('<tr><td colspan="4">No tee times available</td></tr>').replace("</body>", "<div>Error loading tee times</div></body>"))).toThrow(/still loading/u);
    expect(() => parse(page("").replace("Daily Rate", "Members Daily Rate"))).toThrow(/public rate/u);
    expect(() => parse(page(row(
      "8:00<div>AM</div>",
      "1 to 4 players",
      "202609290800",
      "https://evil.example/teetimes/course/1202/teetime/202609290800?psid=6786&p=0"
    )))).toThrow(/unsafe booking link/u);
    expect(() => parse(page(row(
      "8:00<div>AM</div>",
      "1 to 4 players",
      "202609290800",
      "/account?token=secret"
    )))).toThrow(/unsafe booking link/u);
  });

  it("propagates HTTP and malformed response failures instead of reporting no availability", async () => {
    const request = { courseId: "mount-snow", date: new Date("2026-09-29T00:00:00.000Z"), players: 2, metadata };
    await expect(fetchQuick18TeeSheet(
      request,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("blocked", { status: 403 }))
    )).rejects.toMatchObject({ status: 403 });
    await expect(fetchQuick18TeeSheet(
      request,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))
    )).rejects.toMatchObject({ failureClass: "SCHEMA" });
    await expect(fetchQuick18TeeSheet(
      request,
      vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(256_001), { status: 200, headers: { "content-type": "text/html" } }))
    )).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });
});
