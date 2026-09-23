import { describe, expect, it, vi } from "vitest";

import {
  parseForeupPublicConfiguration,
  readForeupPublicConfiguration,
} from "./foreup-public-configuration";

const bookingUrl = "https://foreupsoftware.com/index.php/booking/19021#/teetimes";
const schedules = [
  { course_id: "19021", title: "Bridges", teesheet_id: "792", booking_classes: [
    { teesheet_id: "792", booking_class_id: "4931", active: "1", hidden: "0" },
  ] },
  { course_id: "19021", title: "Columbia", teesheet_id: "781", booking_classes: [
    { teesheet_id: "781", booking_class_id: "4930", active: "1", hidden: "0" },
  ] },
];
const html = `<html><script>SCHEDULES = ${JSON.stringify(schedules)};</script></html>`;

describe("public ForeUp schedule configuration", () => {
  it("selects only the exact course-specific schedule from a shared official landing", () => {
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html })).toEqual({
      sourceBookingUrl: bookingUrl,
      bookingBaseUrl: "https://foreupsoftware.com/index.php/booking/19021/792#/teetimes",
      scheduleId: 792,
      bookingClassId: 4931,
    });
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Golf Club", html }))
      .toMatchObject({ scheduleId: 781, bookingClassId: 4930 });
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Another Bridges", html }))
      .toMatchObject({ scheduleId: 792 });
  });

  it("rejects ambiguous, hidden, off-facility, or transaction-shaped evidence", () => {
    const parse = (value: unknown, url = bookingUrl) => parseForeupPublicConfiguration({
      bookingUrl: url, courseName: "Columbia Bridges",
      html: `<script>SCHEDULES = ${JSON.stringify(value)};</script>`,
    });
    expect(parse([{ ...schedules[0], course_id: "999" }])).toBeNull();
    expect(parse([schedules[0], schedules[0]])).toBeNull();
    expect(parse([{ ...schedules[0], booking_classes: [
      { ...schedules[0].booking_classes[0], hidden: "1" },
    ] }])).toBeNull();
    expect(parse(schedules, "https://evilforeupsoftware.com/index.php/booking/19021")).toBeNull();
    expect(parse(schedules, "https://foreupsoftware.com/index.php/booking/19021#/checkout")).toBeNull();
    expect(parse(schedules, "https://foreupsoftware.com/index.php/booking/19021?token=abc")).toBeNull();
    expect(parseForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", html: `${html}${html}` })).toBeNull();
  });

  it("requires a successful public API read before returning runnable metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, {
      status: 200, headers: { "content-type": "text/html" },
    })).mockResolvedValueOnce(new Response("[]", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl }))
      .toMatchObject({ scheduleId: 792 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const apiRequest = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(apiRequest.pathname).toBe("/index.php/api/booking/times");
    expect(apiRequest.searchParams.get("schedule_id")).toBe("792");
    expect(apiRequest.searchParams.get("booking_class")).toBe("4931");

    const blocked = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(html, {
      status: 200, headers: { "content-type": "text/html" },
    })).mockResolvedValueOnce(new Response("Access Denied", { status: 403 }));
    expect(await readForeupPublicConfiguration({ bookingUrl, courseName: "Columbia Bridges", fetchImpl: blocked }))
      .toBeNull();
    expect(blocked).toHaveBeenCalledTimes(2);
  });
});
