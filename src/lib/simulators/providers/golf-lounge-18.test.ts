// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fetchGolfLounge18Availability, isGolfLounge18PublicBookingUrl, parseGolfLounge18Slots } from "./golf-lounge-18";
import { fetchSimulatorAvailability } from "./index";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput } from "./types";

// A reduced, public scheduler shape. Anonymous session values are fixtures;
// neither customer information nor live nonces/cookies are retained here.
const landing = `<!doctype html><html><body>
  <input id="locationName" value="Fairfield" data-location-id="4">
  <div id="locationId">4</div><input name="_token" value="public-fixture-nonce">
  <button class="btn btn-apt-type-pre" data-appt-id="8204979" data-calender-id="2555560" data-appt-name="1 hour bay time at Fairfield">Book</button>
  <button class="btn btn-apt-type-pre" data-appt-id="8204982" data-calender-id="2555560" data-appt-name="2 hours bay time at Fairfield">Book</button>
  <button class="btn btn-apt-type-pre" data-appt-id="111" data-calender-id="222" data-appt-name="1 Hour Lesson at Fairfield">Book</button>
  <p>Maximum up to 6 guests per bay. No guest fee for up to 6 guests.</p>
</body></html>`;

const input: SimulatorAvailabilityInput = {
  offering: {
    id: "offering-fairfield",
    courseId: "venue-fairfield",
    providerFamilyKey: "GOLF_LOUNGE_18",
    providerMetadata: { locationId: "4" },
    bookingUrl: "https://portal.golflounge18.com/appointment/book/4",
    maxPartySize: 6,
    supportedDurationsMinutes: [60, 120]
  },
  date: "2026-10-10",
  durationMinutes: 120,
  partySize: 4,
  timeZone: "America/New_York"
};

function htmlResponse(html = landing, cookies = ["XSRF-TOKEN=public-xsrf; Path=/", "golf_lounge_18_session=public-session; Path=/; HttpOnly"]) {
  const headers = new Headers({ "Content-Type": "text/html; charset=UTF-8" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(html, { headers });
}

function mockReads(payload: unknown = [{ time: "2026-10-10T10:00:00-0400", slotsAvailable: 8 }], html = landing) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(htmlResponse(html))
    .mockResolvedValueOnce(new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } }));
}

describe("Golf Lounge 18 public simulator availability", () => {
  it("bootstraps an anonymous session and reads the exact full-duration public product", async () => {
    const fetchImpl = mockReads();
    const result = await fetchSimulatorAvailability(input, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, request] = fetchImpl.mock.calls[1];
    expect(String(url)).toBe("https://portal.golflounge18.com/proxy_request");
    expect(request).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store" });
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({
      proxyMethod: "GET",
      proxyUrl: "https://acuityscheduling.com/api/v1/availability/times?appointmentTypeID=8204982&calendarID=2555560&date=2026-10-10&admin=false",
      proxyBody: { location: "Fairfield", locationId: "4" }
    });
    expect(new Headers(request?.headers).get("Cookie")).toBe("XSRF-TOKEN=public-xsrf; golf_lounge_18_session=public-session");
    expect(new Headers(request?.headers).get("X-CSRF-TOKEN")).toBe("public-fixture-nonce");
    expect(result).toMatchObject({ complete: true, evidenceUrl: input.offering.bookingUrl });
    expect(result.slots).toEqual([{
      sourceId: "golf-lounge-18:offering-fairfield:8204982:2026-10-10T14:00:00.000Z",
      offeringId: input.offering.id,
      resourceId: "ANY",
      productId: "8204982",
      startsAt: new Date("2026-10-10T14:00:00Z"),
      endsAt: new Date("2026-10-10T16:00:00Z"),
      maxPartySize: 6,
      bookingUrl: input.offering.bookingUrl
    }]);
    // Eight remaining resource slots are not eight golfers or eight named bays.
    expect(result.slots[0]).not.toHaveProperty("price");
    expect(result.slots[0]).not.toHaveProperty("availableSpots");
  });

  it("keeps session cookies request-scoped and ignores foreign and unrelated cookies", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(htmlResponse(landing, [
        "other_session=ignored; Path=/",
        "XSRF-TOKEN=foreign; Domain=other.example; Path=/",
        "golf_lounge_18_session=public-session; Domain=portal.golflounge18.com; Path=/"
      ]))
      .mockResolvedValueOnce(new Response("[]", { headers: { "Content-Type": "application/json" } }));
    await fetchGolfLounge18Availability(input, fetchImpl);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).has("Cookie")).toBe(false);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get("Cookie")).toBe("golf_lounge_18_session=public-session");
  });

  it.each([
    "https://other.example/appointment/book/4",
    "https://portal.golflounge18.com.attacker.example/appointment/book/4",
    "http://portal.golflounge18.com/appointment/book/4",
    "https://user:password@portal.golflounge18.com/appointment/book/4",
    "https://portal.golflounge18.com/appointment/book/4?proxyUrl=https://other.example",
    "https://portal.golflounge18.com/appointment/book/4#account",
    "https://portal.golflounge18.com/checkin/4"
  ])("rejects non-public or caller-modified booking sources before fetching: %s", async (bookingUrl) => {
    expect(isGolfLounge18PublicBookingUrl(bookingUrl)).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfLounge18Availability({ ...input, offering: { ...input.offering, bookingUrl } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects conflicting tenant metadata before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfLounge18Availability({ ...input, offering: { ...input.offering, providerMetadata: { locationId: "10" } } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a different location in the returned landing before reading its calendar", async () => {
    const fetchImpl = mockReads([], landing.replace('data-location-id="4"', 'data-location-id="10"'));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not infer rental availability from lessons or concatenate shorter products", async () => {
    const fetchImpl = mockReads([], landing.replace('data-appt-name="2 hours bay time at Fairfield"', 'data-appt-name="2 Hour Lesson at Fairfield"'));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "UNSUPPORTED_DURATION" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails closed on ambiguous duration products", async () => {
    const duplicate = '<button class="btn-apt-type-pre" data-appt-id="999" data-calender-id="2555560" data-appt-name="2 hours bay time at Fairfield">Book</button>';
    const fetchImpl = mockReads([], landing.replace("</body>", `${duplicate}</body>`));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });

  it("ignores valid longer rentals outside the alert duration range", async () => {
    const longer = '<button class="btn-apt-type-pre" data-appt-id="999" data-calender-id="2555560" data-appt-name="5 hours bay time at Fairfield">Book</button>';
    const result = await fetchGolfLounge18Availability(input, mockReads(undefined, landing.replace("</body>", `${longer}</body>`)));
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0].productId).toBe("8204982");
  });

  it("uses current public guest capacity and rejects a larger group before the read", async () => {
    const fetchImpl = mockReads();
    await expect(fetchGolfLounge18Availability({ ...input, partySize: 7, offering: { ...input.offering, maxPartySize: 8 } }, fetchImpl)).rejects.toMatchObject({ code: "PARTY_TOO_LARGE" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("requires verified public guest capacity instead of trusting saved optimistic metadata", async () => {
    const fetchImpl = mockReads([], landing.replace("Maximum up to 6 guests per bay.", "Groups welcome."));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-10-10T00:00:00Z"])("rejects an invalid venue date: %s", async (date) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfLounge18Availability({ ...input, date }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns a complete empty observation only for a valid empty provider array", async () => {
    const result = await fetchGolfLounge18Availability(input, mockReads([]));
    expect(result.complete).toBe(true);
    expect(result.slots).toEqual([]);
  });

  it.each([
    { status_code: 400, message: "Not available" },
    { data: [] },
    [{ time: "2026-10-10T10:00:00-04:00", slotsAvailable: "8" }],
    [{ time: "2026-10-11T10:00:00-04:00", slotsAvailable: 1 }],
    [{ time: "2026-10-10T10:00:00-05:00", slotsAvailable: 1 }],
    [{ time: "2026-10-10T25:00:00-04:00", slotsAvailable: 1 }],
    [{ time: "2026-10-10T10:00:00-04:00", slotsAvailable: -1 }]
  ])("does not turn malformed, wrong-day or timezone-conflicting responses into no-match success", async (payload) => {
    await expect(fetchGolfLounge18Availability(input, mockReads(payload))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });

  it("deduplicates pooled choices, excludes unavailable times and preserves provider durations", () => {
    const slots = parseGolfLounge18Slots({
      input, productId: "8204982", maxPartySize: 6,
      payload: [
        { time: "2026-10-10T11:00:00-04:00", slotsAvailable: 0 },
        { time: "2026-10-10T10:00:00-04:00", slotsAvailable: 8 },
        { time: "2026-10-10T10:00:00-04:00", slotsAvailable: 8 }
      ]
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].endsAt.getTime() - slots[0].startsAt.getTime()).toBe(120 * 60_000);
  });

  it("classifies a rejected anonymous CSRF session without retaining nonce or provider response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(htmlResponse()).mockResolvedValueOnce(new Response("private error body", { status: 419 }));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "PUBLIC_SESSION_REQUIRED", retryable: true, httpStatus: 419 });
  });

  it("does not label a provider 403 as an account requirement", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("Denied", { status: 403 }));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", httpStatus: 403 });
  });

  it("rejects redirects without following them", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: "https://other.example" } }));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", httpStatus: 302 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it("preserves Retry-After for coordinated throttled retries", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", retryable: true, retryAfter: "120" });
  });

  it("reports network failures as retryable without exposing request/session details", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("sensitive diagnostic must not escape"));
    await expect(fetchGolfLounge18Availability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", retryable: true, message: "The public simulator calendar could not be reached" });
  });

  it("does not call an unimplemented provider", () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => fetchSimulatorAvailability({ ...input, offering: { ...input.offering, providerFamilyKey: "UNKNOWN_FAMILY" } }, fetchImpl)).toThrow(SimulatorAvailabilityError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
