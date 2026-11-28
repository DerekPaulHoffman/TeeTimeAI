import { describe, expect, it, vi } from "vitest";

import {
  fetchChelseaTeeSheet,
  isChelseaMetadata,
  type ChelseaMetadata
} from "./chelsea";

const metadata: ChelseaMetadata = {
  provider: "CHELSEA",
  bookingBaseUrl: "https://dennis.chelseareservations.com/",
  courseCode: 2,
  courseLabel: "Highland",
  bookingWindowDaysAhead: 7,
  bookingWindowEvidenceUrl:
    "https://www.dennisgolf.com/wp-content/uploads/2025/08/Policies-and-Procedures-Amended-SB-08.26.2025-Current.pdf"
};

describe("Chelsea Reservations adapter", () => {
  it("recognizes bounded public Chelsea metadata", () => {
    expect(isChelseaMetadata(metadata)).toBe(true);
    expect(
      isChelseaMetadata({
        ...metadata,
        bookingBaseUrl: "https://example.com/",
        courseCode: 0
      })
    ).toBe(false);
  });

  it("uses official booking-window evidence before requesting a future tee sheet", async () => {
    const fetchImpl = vi.fn();

    const result = await fetchChelseaTeeSheet(
      {
        courseId: "dennis-highland",
        date: new Date("2026-08-15T00:00:00.000Z"),
        players: 4,
        timeZone: "America/New_York",
        metadata
      },
      fetchImpl as typeof fetch,
      new Date("2026-07-13T21:00:00.000Z")
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      slots: [],
      targetDateStatus: "NOT_OPEN",
      bookingWindowEvidence: {
        daysAhead: 7,
        releaseTimeLocal: null,
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 0.98,
        evidenceUrl: metadata.bookingWindowEvidenceUrl
      }
    });
  });

  it("uses an explicitly verified nonmember route and its current General Public type", async () => {
    const publicMetadata: ChelseaMetadata = {
      ...metadata,
      bookingBaseUrl: "https://westbk.chelseareservations.com/nonmember/",
      publicBookingPath: "/nonmember/code/Booking/booking1.aspx",
      publicMemberTypeCode: "07"
    };
    const page = calendarHtml("07/13/2026") +
      '<select id="ddlMemberType"><option value="07">General Public</option></select>' +
      '<select id="ddlTime"><option value="07:00">7 AM</option></select>' +
      '<select id="ddlTimeEnd"><option value="17:00">5 PM</option></select>';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(page))
      .mockResolvedValueOnce(htmlResponse(calendarHtml("07/18/2026")))
      .mockResolvedValueOnce(htmlResponse(resultsHtml()));
    await fetchChelseaTeeSheet({ courseId: "lakes", date: new Date("2026-07-18"),
      players: 2, metadata: publicMetadata }, fetchImpl as typeof fetch,
      new Date("2026-07-13"));
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://westbk.chelseareservations.com/nonmember/code/Booking/booking1.aspx"
    );
    expect(String(fetchImpl.mock.calls[1][1]?.body)).toContain("ddlMemberType=07");
    expect(String(fetchImpl.mock.calls[1][1]?.body)).toContain("ddlTime=07%3A00");
    expect(String(fetchImpl.mock.calls[1][1]?.body)).toContain("ddlTimeEnd=17%3A00");
    expect(isChelseaMetadata({ ...publicMetadata, publicBookingPath: "/member/login" })).toBe(false);
    const rejectedFetch = vi.fn().mockResolvedValue(htmlResponse(page.replace("General Public", "Members")));
    await expect(fetchChelseaTeeSheet({ courseId: "lakes", date: new Date("2026-07-18"),
      players: 2, metadata: publicMetadata }, rejectedFetch as typeof fetch,
      new Date("2026-07-13"))).rejects.toThrow("not corroborated");
    expect(rejectedFetch).toHaveBeenCalledTimes(1);
  });

  it("reads the unauthenticated non-member tee sheet without selecting Reserve", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(htmlResponse(calendarHtml("07/13/2026"), true))
      .mockResolvedValueOnce(htmlResponse(calendarHtml("07/18/2026")))
      .mockResolvedValueOnce(htmlResponse(resultsHtml()));

    const result = await fetchChelseaTeeSheet(
      {
        courseId: "dennis-highland",
        date: new Date("2026-07-18T00:00:00.000Z"),
        players: 4,
        timeZone: "America/New_York",
        metadata
      },
      fetchImpl as typeof fetch,
      new Date("2026-07-13T21:00:00.000Z")
    );

    expect(result.targetDateStatus).toBe("OPEN");
    expect(result.slots).toEqual([
      {
        courseId: "dennis-highland",
        sourceId: "chelsea-dennis-Compare72163601001",
        startsAt: "2026-07-18T16:36",
        availableSpots: 4,
        bookingUrl: "https://dennis.chelseareservations.com/",
        holes: 18,
        evidenceUrl:
          "https://dennis.chelseareservations.com/GPInprocess/code/Booking/booking1.aspx"
      },
      {
        courseId: "dennis-highland",
        sourceId: "chelsea-dennis-Compare72165401002",
        startsAt: "2026-07-18T16:54",
        availableSpots: 3,
        bookingUrl: "https://dennis.chelseareservations.com/",
        holes: 18,
        evidenceUrl:
          "https://dennis.chelseareservations.com/GPInprocess/code/Booking/booking1.aspx"
      }
    ]);

    const posts = fetchImpl.mock.calls.slice(1).map(([, options]) => String(options?.body));
    expect(posts[0]).toContain("gaDOWButton6=");
    expect(posts[0]).toContain("ddlCourse1=2");
    expect(posts[0]).toContain("ddlQuantity=4");
    expect(posts[1]).toContain("btnDisplayTimes=GO+%3E");
    expect(posts.join(" ")).not.toMatch(/Compare|Reserve/i);
  });

  const emptyResults = '<span id="lblTimes"></span>';
  const selectedDay = calendarHtml("07/18/2026");
  const readRequestedDate = (result: string, selected = selectedDay) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(htmlResponse(calendarHtml("07/13/2026")))
      .mockResolvedValueOnce(htmlResponse(selected))
      .mockResolvedValueOnce(htmlResponse(result));
    return fetchChelseaTeeSheet({ courseId: "dennis-highland", date: new Date("2026-07-18T00:00:00Z"),
      players: 2, metadata }, fetchImpl as typeof fetch, new Date("2026-07-13T21:00:00Z"));
  };

  it("accepts a newly displayed empty result envelope for the requested date", async () => {
    await expect(readRequestedDate(selectedDay + emptyResults)).resolves.toMatchObject({ slots: [], targetDateStatus: "OPEN" });
  });

  it.each([
    ["missing results", selectedDay],
    ["different date", calendarHtml("07/19/2026") + emptyResults],
    ["incomplete results", selectedDay + '<span id="lblTimes">'],
    ["hidden results", selectedDay + '<span id="lblTimes" hidden></span>'],
    ["duplicate result envelopes", selectedDay + emptyResults + emptyResults],
    ["an unrecognized error envelope", selectedDay + '<span id="lblTimes">Service disconnected</span>'],
    ["a malformed card beside a valid card", resultsHtml().replace('id="Compare72165401002"', '')],
  ])("does not certify %s as complete tee-time inventory", async (_, result) => {
    await expect(readRequestedDate(result)).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });

  it("rejects an unchanged blank placeholder on the selected-date page", async () => {
    const unchanged = selectedDay + emptyResults;
    await expect(readRequestedDate(unchanged, unchanged)).rejects.toMatchObject({ failureClass: "SCHEMA" });
  });
});

function htmlResponse(html: string, setCookie = false) {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html",
      ...(setCookie ? { "set-cookie": "ASP.NET_SessionId=session-1; Path=/; HttpOnly" } : {})
    }
  });
}

function calendarHtml(selectedDate: string) {
  return `
    <form method="post" action="./booking1.aspx">
      <input type="hidden" name="__VIEWSTATE" value="abc&amp;123" />
      <input type="hidden" name="__EVENTVALIDATION" value="validation" />
      <input type="hidden" name="hdSelectedDate" id="hdSelectedDate" value="${selectedDate}" />
      ${[13, 14, 15, 16, 17, 18, 19]
        .map(
          (day, index) => `
            <input type="submit" name="gaDOWButton${index + 1}" id="gaDOWButton${index + 1}" value="" />
            <span id="lblDowMonth${index + 1}">Jul</span>
            <span id="lblDowDay${index + 1}">${day}</span>
          `
        )
        .join("")}
    </form>
  `;
}

function resultsHtml() {
  return `${calendarHtml("07/18/2026")}
    <span id="lblTimes">
      <div class="garesultMainDiv">
        <div class="garesultTime">4:36 PM Hole:1</div>
        <div class="garesultCourseName">Highland
          <div class="garesultPlayer">Players
            <select class="garesultPlayerSelect"><option selected>4</option><option>3</option><option>2</option></select>
          </div>
        </div>
        <img title="18 Hole Time" alt="18 Hole Time" src="iconBlack18.png">
        <button class="garesultReserveButton" id="Compare72163601001">Reserve</button>
      </div>
      <div class="garesultMainDiv">
        <div class="garesultTime">4:54 PM Hole:1</div>
        <div class="garesultCourseName">Highland
          <div class="garesultPlayer">Players
            <select class="garesultPlayerSelect"><option selected>3</option><option>2</option></select>
          </div>
        </div>
        <img title="18 Hole Time" alt="18 Hole Time" src="iconBlack18.png">
        <button class="garesultReserveButton" id="Compare72165401002">Reserve</button>
      </div>
    </span>
  `;
}
