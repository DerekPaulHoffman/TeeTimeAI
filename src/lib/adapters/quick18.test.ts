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

function page(rows: string, displayedDate = "9/29/2026") {
  return `<!doctype html><html><body>
    <form action="/teetimes/searchmatrix?teedate=20260929" method="post">
      <input id="SearchForm_Date" value="${displayedDate}">
    </form>
    <div id="searchMatrix"><a href="/teetimes/searchmatrix?teedate=20260929">Sep 29</a>
    <table class="matrixTable"><thead><tr>
      <th>Tee Time</th><th>Players</th><th>Daily Rate</th><th>Member Rate</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
  </body></html>`;
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

  it("reports zero slots when the selected date has an explicit no-times row", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(page('<tr><td colspan="4">No tee times available</td></tr>'), { status: 200, headers: { "content-type": "text/html" } })
    );
    await expect(
      fetchQuick18TeeSheet(
        { courseId: "mount-snow", date: new Date("2026-09-29T00:00:00.000Z"), players: 2, metadata },
        fetchImpl
      )
    ).resolves.toEqual({ slots: [], targetDateStatus: "OPEN", bookingWindowEvidence: null });
    expect(parse(page(row("8:00<div>AM</div>", "1 to 3 players", "202609290800")), 4)).toEqual([]);
  });

  it("fails closed on a changed date, account page, and unsafe selection links", () => {
    expect(() => parse(page("", "9/30/2026"))).toThrow(/requested date/u);
    expect(() => parse("<html><h1>Sign in</h1></html>")).toThrow(/requested date/u);
    expect(() => parse(page(""))).toThrow(/no completed no-times evidence/u);
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
