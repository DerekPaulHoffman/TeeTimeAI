// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { fetchGolfBookAvailability, isGolfBookPublicBookingUrl, parseGolfBookSlots } from "./golfbook";
import { fetchSimulatorAvailability } from "./index";
import type { SimulatorAvailabilityInput } from "./types";

const input: SimulatorAvailabilityInput = {
  offering: { id: "offering-zstrict", courseId: "venue-zstrict", bookingUrl: "https://zstrict.golfbook.in/calendar.php", providerFamilyKey: "GOLFBOOK", providerMetadata: { templateId: "53" }, maxPartySize: 6, supportedDurationsMinutes: [60, 90, 120] },
  date: "2026-10-10", durationMinutes: 60, partySize: 2, timeZone: "America/New_York"
};

// Reduced signed-out HTML. Only public calendar settings, inventory identities
// and bay rules are retained; scripts, payment and customer forms are absent.
function fixture(statuses = [[1, 1], [1, 2], [4, 1]], date = input.date, startMinute = 540) {
  const rows = statuses.map((states, index) => {
    const minute = startMinute + index * 30;
    const hour = Math.floor(minute / 60);
    const time = `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
    const epoch = Date.parse(`${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`) / 1000;
    return `<tr><td class="time-col">${time}</td>${states.map((state, column) => `<td class="status_${state}" ${state === 1 ? `onclick="redirect('reserve','date=${epoch}&lane=${column ? "20" : "1"}&templateId=53')"` : ""}>${state === 4 ? "Please phone to book" : "$70 / hour"}</td>`).join("")}</tr>`;
  });
  return `<input id="waitlist_date" value="${date}"><input id="waitlist_template" value="53"><input id="template_min_booking_mins" value="60"><input id="template_max_booking_mins" value="360"><input id="template_booking_increment_mins" value="30"><table id="bookingsheet"><thead><tr><th>Time</th><th id="th_1">Bay 1<a onclick="bayInfo('Bay','','THIS BAY IS up to 6 players with Swingplate')"></a></th><th id="th_20">VIP<a onclick="bayInfo('VIP','','RH/LH up to 6 players')"></a></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
function htmlResponse(html = fixture()) { return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } }); }

describe("GolfBook public simulator availability", () => {
  it("reads only the public date-specific sheet and keeps a full interval on one bay", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(htmlResponse());
    const result = await fetchSimulatorAvailability(input, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe("https://zstrict.golfbook.in/bookingsheet.php?date=2026-10-10&lang=en");
    expect(request).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
    expect(request?.body).toBeUndefined();
    expect(new Headers(request?.headers).has("Cookie")).toBe(false);
    expect(result).toMatchObject({ complete: true, evidenceUrl: String(url) });
    expect(result.slots).toEqual([{
      sourceId: "golfbook:offering-zstrict:53:1:2026-10-10T13:00:00.000Z", offeringId: "offering-zstrict", resourceId: "1", productId: "53", startsAt: new Date("2026-10-10T13:00:00Z"), endsAt: new Date("2026-10-10T14:00:00Z"), maxPartySize: 6, bookingUrl: input.offering.bookingUrl
    }]);
    expect(result.slots[0]).not.toHaveProperty("price");
  });

  it("does not join free cells across different bays or phone-only cells", () => {
    expect(parseGolfBookSlots(fixture([[1, 2], [2, 1], [4, 4]]), input, "53")).toEqual([]);
  });
  it("requires every cell in the selected duration, rather than a shorter opening", () => {
    expect(parseGolfBookSlots(fixture(), { ...input, durationMinutes: 90 }, "53")).toEqual([]);
  });
  it("converts winter wall-clock epochs using the venue's current offset", () => {
    const date = "2026-12-10";
    const slots = parseGolfBookSlots(fixture(undefined, date), { ...input, date }, "53");
    expect(slots[0].startsAt.toISOString()).toBe("2026-12-10T14:00:00.000Z");
  });
  it.each([
    ["2026-11-01", 60],
    ["2026-03-08", 120]
  ])("rejects ambiguous or nonexistent venue time on %s", (date, startMinute) => {
    expect(() => parseGolfBookSlots(fixture([[1, 2], [1, 2], [2, 2]], date, startMinute), { ...input, date }, "53")).toThrow("venue timezone");
  });
  it("keeps independent named bays and their capacity", () => {
    const slots = parseGolfBookSlots(fixture([[1, 1], [1, 1], [4, 4]]).replace("RH/LH up to 6", "RH/LH up to 2"), { ...input, partySize: 3 }, "53");
    expect(slots.map((slot) => slot.resourceId)).toEqual(["1", "20"]);
    expect(slots.find((slot) => slot.resourceId === "20")?.maxPartySize).toBe(2);
  });
  it("uses the more conservative saved capacity", () => {
    expect(parseGolfBookSlots(fixture(), { ...input, partySize: 3, offering: { ...input.offering, maxPartySize: 2 } }, "53")[0].maxPartySize).toBe(2);
  });
  it("uses current source capacity when it has not been saved", () => {
    expect(parseGolfBookSlots(fixture(), { ...input, offering: { ...input.offering, maxPartySize: null } }, "53")[0].maxPartySize).toBe(6);
  });
  it.each([
    "https://zstrict.golfbook.in.attacker.example/calendar.php", "https://golfbook.in/calendar.php", "https://localhost/calendar.php", "http://zstrict.golfbook.in/calendar.php", "https://user:pass@zstrict.golfbook.in/calendar.php", "https://zstrict.golfbook.in:8443/calendar.php", "https://zstrict.golfbook.in/reserve.php", "https://zstrict.golfbook.in/calendar.php?date=2026-10-10", "https://zstrict.golfbook.in/calendar.php#booking"
  ])("rejects an unsafe or transaction source before any request: %s", async (bookingUrl) => {
    expect(isGolfBookPublicBookingUrl(bookingUrl)).toBe(false);
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfBookAvailability({ ...input, offering: { ...input.offering, bookingUrl } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("requires an explicit verified template before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfBookAvailability({ ...input, offering: { ...input.offering, providerMetadata: {} } }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    ["date", fixture().replace('id="waitlist_date" value="2026-10-10"', 'id="waitlist_date" value="2026-10-11"')],
    ["template", fixture().replace('id="waitlist_template" value="53"', 'id="waitlist_template" value="54"')],
    ["bay", fixture().replace("lane=1&", "lane=2&")],
    ["cell template", fixture().replace("templateId=53", "templateId=54")],
    ["wall clock epoch", fixture().replace("1791622800", "1791637200")]
  ])("rejects conflicting %s identity", (_label, html) => {
    expect(() => parseGolfBookSlots(html, input, "53")).toThrow();
  });
  it.each([
    ["unknown status", fixture().replace("status_2", "status_9")],
    ["missing action", fixture().replace(/onclick="redirect\('reserve','date=\d+&lane=1&templateId=53'\)"/u, "")],
    ["duplicate resource", fixture().replace('id="th_20"', 'id="th_1"')],
    ["missing column", fixture().replace('<td class="status_4" >Please phone to book</td>', "")],
    ["time grid", fixture().replace("9:30 AM", "9:45 AM")],
    ["duration contract", fixture().replace('id="template_booking_increment_mins" value="30"', 'id="template_booking_increment_mins" value="0"')],
    ["calendar missing", "<html>Sign in</html>"]
  ])("fails closed when %s changes", (_label, html) => {
    expect(() => parseGolfBookSlots(html, input, "53")).toThrow();
  });
  it("keeps public named-bay intervals when group capacity is unknown", () => {
    const slots = parseGolfBookSlots(fixture().replaceAll("up to 6 players", "many players"),
      { ...input, offering: { ...input.offering, maxPartySize: null } }, "53");
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0].maxPartySize).toBeNull();
  });
  it("honors the public minimum session length", () => {
    expect(() => parseGolfBookSlots(fixture(), { ...input, durationMinutes: 30 }, "53")).toThrow("session length");
  });
  it("returns a complete empty observation for a fully closed grid", () => {
    expect(parseGolfBookSlots(fixture([[2, 2], [3, 3], [4, 4]]), input, "53")).toEqual([]);
  });
  it.each([
    { date: "2026-02-30" }, { durationMinutes: 45 }, { partySize: 0 }, { timeZone: "Invalid/Zone" }
  ])("validates requested inputs before reading", async (patch) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchGolfBookAvailability({ ...input, ...patch }, fetchImpl)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([403, 302, 429])("records observed HTTP %s without guessing an account gate", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("private-body", { status, headers: { "Content-Type": "text/html", "Retry-After": "30" } }));
    await expect(fetchGolfBookAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", httpStatus: status, retryable: status === 429 });
  });
  it("sanitizes network errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error("private transport data"));
    await expect(fetchGolfBookAvailability(input, fetchImpl)).rejects.toMatchObject({ code: "HTTP_ERROR", message: "The public simulator calendar could not be reached", retryable: true });
  });
  it("rejects unexpected response types and oversized calendars", async () => {
    for (const response of [new Response("{}", { headers: { "Content-Type": "application/json" } }), new Response("html", { headers: { "Content-Type": "text/html", "Content-Length": "600001" } })]) {
      await expect(fetchGolfBookAvailability(input, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    }
  });
});
