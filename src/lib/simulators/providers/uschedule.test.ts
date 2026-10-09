import { describe, expect, it, vi } from "vitest";
import { fetchSimulatorAvailability } from "./index";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";
import { isSimulatorPublicConfigurationSource, knownSimulatorPublicConfigurationFamily } from "./public-configuration";
import { fetchUScheduleAvailability, projectUSchedulePublicConfiguration } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";

const bookingUrl = "https://clients.uschedule.com/syntheticvenue/booking";
const cookie = "ASP.NET_SessionId=AnonymousOnly123";
const input: SimulatorAvailabilityInput = {
  offering: { id: "synthetic-offering", courseId: "synthetic-course", bookingUrl, providerFamilyKey: "USCHEDULE",
    active: true, publicAccessStatus: "PUBLIC",
    providerMetadata: { tenant: "syntheticvenue", serviceId: "29547" }, maxPartySize: null, supportedDurationsMinutes: [60] },
  date: "2026-10-10", durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
};
const day = (hour: number, minute = 0) => `10102026${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
const firstTimes = Array.from({ length: 10 }, (_, index) => day(16 + Math.floor(index / 2), index % 2 ? 30 : 0));
const secondTimes = [day(21), ...Array.from({ length: 9 }, (_, index) =>
  `10142026${String(15 + Math.floor(index / 2)).padStart(2, "0")}${index % 2 ? "30" : "00"}`)];
function html(times: string[], options: { serviceId?: string; selectedLength?: string; resource?: string; cursor?: string;
  access?: string; more?: boolean } = {}) {
  const rows = times.map(time => `<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="${options.resource ?? "0"}"><div><span><strong>Public start</strong></span></div></div></div>`).join("");
  return `<select id="select_service"><option value="${options.serviceId ?? "29547"}" selected>Simulator Rental</option></select>
    <select id="select_length"><option value="60" ${options.selectedLength === undefined || options.selectedLength === "60" ? "selected" : ""}>1 hour</option>
    <option value="90" ${options.selectedLength === "90" ? "selected" : ""}>1.5 hours</option></select>
    ${rows}${options.more === false ? "" : "<a id='more_next_avail'>Show more</a>"}
    <script>var lastAvailTime = '${options.cursor ?? times.at(-1) ?? ""}';</script>${options.access ?? ""}`;
}
const response = (body: string, type = "text/html", extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { "content-type": type, ...extra } });
function sequence(first = html(firstTimes), second = html(secondTimes), code = '{"code":"refresh"}') {
  const replies = [response(first, "text/html", { "set-cookie": `${cookie}; Path=/; HttpOnly` }),
    response(code, "application/json"), response(first), response(code, "application/json"), response(second)];
  const fetch = vi.fn(async () => {
    const next = replies.shift();
    if (!next) throw new Error("Unexpected request");
    return next;
  });
  return { fetch, replies };
}

describe("USchedule exact public rental source", () => {
  it("projects only the selected one-hour pooled rental from a structural tenant URL", () => {
    const configuration = projectUSchedulePublicConfiguration(html(firstTimes), bookingUrl);
    expect(configuration).toEqual({ family: "USCHEDULE", tenant: "syntheticvenue", serviceId: "29547",
      durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    expect(knownSimulatorPublicConfigurationFamily(bookingUrl)).toBe("USCHEDULE");
    expect(isSimulatorPublicConfigurationSource(configuration!, bookingUrl)).toBe(true);
    expect(isSimulatorPublicConfigurationSource(configuration!, bookingUrl.replace("syntheticvenue", "differentvenue"))).toBe(false);
    for (const url of ["http://clients.uschedule.com/syntheticvenue/booking", "https://clients.uschedule.com/syntheticvenue/booking?x=1",
      "https://clients.uschedule.com/syntheticvenue/booking/changefield", "https://clients.uschedule.com.evil.test/syntheticvenue/booking",
      "https://clients.uschedule.com/syntheticvenue/cart", "https://clients.uschedule.com/a.b/booking"]) {
      expect(projectUSchedulePublicConfiguration(html(firstTimes), url)).toBeUndefined();
    }
    expect(projectUSchedulePublicConfiguration(html(firstTimes, { selectedLength: "90" }), bookingUrl)).toBeUndefined();
    expect(projectUSchedulePublicConfiguration(html(firstTimes, { access: "<p>Sign in to continue</p>" }), bookingUrl)).toBeUndefined();
  });
  it("projects pooled identity only from bounded one-row public result containers", () => {
    const valid = html(firstTimes);
    expect(projectUSchedulePublicConfiguration(valid, bookingUrl)?.availabilityKind).toBe("OPAQUE_POOLED");
    for (const invalid of [
      html([]), html([...firstTimes, day(21)]), html(firstTimes, { resource: "1" }),
      valid.replace('data-empid="0"', 'data-empid="Bay 1"'),
      valid.replace('data-empid="0"', ''), valid.replace(`data-time="${firstTimes[0]}"`, 'data-time="unknown"'),
      `${valid}<div class="next_avail_results"><div class="next_avail_item" data-time="${day(21)}" data-empid="0"></div></div>`,
      valid.replace('class="next_avail_results"', 'class="other_results"'),
      valid.replace('class="next_avail_item"', 'class="other_item"'),
    ]) expect(projectUSchedulePublicConfiguration(invalid, bookingUrl)).toBeUndefined();
  });
  it("unions replacement pages, stops after a later-day witness, and sends only exact date/cursor bodies", async () => {
    const { fetch, replies } = sequence();
    const result = await fetchSimulatorAvailability(input, fetch);
    expect(replies).toHaveLength(0);
    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(11);
    expect(result.slots[0]).toMatchObject({ resourceId: "ANY", productId: "29547", maxPartySize: null,
      bookingUrl, startsAt: new Date("2026-10-10T20:00:00.000Z"), endsAt: new Date("2026-10-10T21:00:00.000Z") });
    expect(result.slots.at(-1)?.startsAt).toEqual(new Date("2026-10-11T01:00:00.000Z"));
    expect(new Set(result.slots.map(slot => slot.startsAt.toISOString())).size).toBe(11);
    const inWindow = filterSimulatorSessionsForSearch({ date: input.date, startTime: "09:00", endTime: "18:00",
      durationMinutes: 60, preferredOfferings: [{ offeringId: input.offering.id }] },
    result.slots.map(slot => ({ ...slot, startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() })), input.timeZone);
    expect(inWindow).toHaveLength(3);
    expect(inWindow.at(-1)?.startsAt).toBe("2026-10-10T21:00:00.000Z");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([bookingUrl, `${bookingUrl}/changefield`, bookingUrl,
      `${bookingUrl}/changefield`, bookingUrl]);
    const calls = fetch.mock.calls.map(([, init]) => init as RequestInit);
    expect(calls.map(call => call.method)).toEqual(["GET", "POST", "GET", "POST", "GET"]);
    expect(calls[0].headers).not.toHaveProperty("Cookie");
    expect(calls.slice(1).every(call => (call.headers as Record<string, string>).Cookie === cookie)).toBe(true);
    expect(calls[1].body).toBe('[{"Name":"start_date","Value":"10/10/2026"}]');
    expect(calls[3].body).toBe('[{"Name":"more_next_avail","Value":"101020262030"}]');
    expect(JSON.stringify(result)).not.toContain(cookie);
  });
  it("deduplicates an exact overlap while still requiring the continuation cursor to advance", async () => {
    const { fetch } = sequence(html(firstTimes), html([firstTimes.at(-1)!, ...secondTimes.slice(0, 9)]));
    const result = await fetchUScheduleAvailability(input, fetch);
    expect(result.slots).toHaveLength(11);
    expect(new Set(result.slots.map(slot => slot.sourceId)).size).toBe(11);
  });
  it("stops before any POST on stale source, alternate duration, or changed selected rental", async () => {
    for (const changed of [
      { offering: { ...input.offering, bookingUrl: bookingUrl.replace("syntheticvenue", "othervenue") } },
      { offering: { ...input.offering, providerMetadata: { tenant: "other", serviceId: "29547" } } },
      { offering: { ...input.offering, providerMetadata: { tenant: "syntheticvenue", serviceId: "29547", booking: "1" } } },
      { offering: { ...input.offering, supportedDurationsMinutes: [60, 90] } },
      { offering: { ...input.offering, maxPartySize: 5 } },
      { offering: { ...input.offering, publicAccessStatus: "UNVERIFIED" } },
      { offering: { ...input.offering, active: false } },
      { durationMinutes: 90 },
    ]) {
      const fetch = vi.fn();
      await expect(fetchUScheduleAvailability({ ...input, ...changed }, fetch)).rejects.toBeInstanceOf(Error);
      expect(fetch).not.toHaveBeenCalled();
    }
    const { fetch } = sequence(html(firstTimes, { serviceId: "99999" }));
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([
    ["cart transition", html(firstTimes), html(secondTimes), '{"code":"cart"}', "SCHEMA_CHANGED"],
    ["extra response keys", html(firstTimes), html(secondTimes), '{"code":"refresh","next":"payment"}', "SCHEMA_CHANGED"],
    ["changed length", html(firstTimes), html(secondTimes, { selectedLength: "90" }), '{"code":"refresh"}', "INVALID_SOURCE"],
    ["changed resource", html(firstTimes), html(secondTimes, { resource: "1" }), '{"code":"refresh"}', "SCHEMA_CHANGED"],
    ["repeated cursor", html(firstTimes), html(secondTimes, { cursor: firstTimes.at(-1) }), '{"code":"refresh"}', "SCHEMA_CHANGED"],
    ["regressed list", html(firstTimes), html(firstTimes), '{"code":"refresh"}', "SCHEMA_CHANGED"],
    ["unknown empty list", html(firstTimes), html([]), '{"code":"refresh"}', "SCHEMA_CHANGED"],
    ["commented cursor", html(firstTimes).replace("var lastAvailTime", "/* var lastAvailTime").replace(";</script>", "; */</script>"),
      html(secondTimes), '{"code":"refresh"}', "SCHEMA_CHANGED"],
    ["access change", html(firstTimes), html(secondTimes, { access: "<p>Sign in to continue</p>" }), '{"code":"refresh"}', "INVALID_SOURCE"],
  ] as const)("fails closed on %s", async (_label, first, second, code, expected) => {
    const { fetch } = sequence(first, second, code);
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: expected });
  });
  it("never treats a full requested-day page as complete without a later-date continuation", async () => {
    const { fetch } = sequence(html(firstTimes, { more: false }));
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("stops at its finite page budget without reporting a partial date as complete", async () => {
    let getCount = 0, postCount = 0;
    const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      if (init?.method === "POST") { postCount += 1; return response('{"code":"refresh"}', "application/json"); }
      const page = html([day(8 + getCount)]);
      getCount += 1;
      return response(page, "text/html", getCount === 1 ? { "set-cookie": `${cookie}; Path=/; HttpOnly` } : {});
    });
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(getCount).toBe(9); // initial anonymous landing plus eight bounded dated pages
    expect(postCount).toBe(8); // one date filter plus seven exact cursors
  });
  it("rejects redirects and a cart response during More without entering a transaction", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: "https://clients.uschedule.com/syntheticvenue/payment" } }));
    await expect(fetchUScheduleAvailability(input, redirect)).rejects.toMatchObject({ code: "HTTP_ERROR" });
    expect(redirect).toHaveBeenCalledOnce();
    const replies = [response(html(firstTimes), "text/html", { "set-cookie": `${cookie}; Path=/; HttpOnly` }),
      response('{"code":"refresh"}', "application/json"), response(html(firstTimes)),
      response('{"code":"cart"}', "application/json")];
    const fetch = vi.fn(async () => replies.shift()!);
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(replies).toHaveLength(0);
  });
  it("rejects a changed anonymous session before using any stale list", async () => {
    const replies = [response(html(firstTimes), "text/html", { "set-cookie": `${cookie}; Path=/; HttpOnly` }),
      response('{"code":"refresh"}', "application/json", { "set-cookie": "ASP.NET_SessionId=DifferentAnonymous123; Path=/" })];
    const fetch = vi.fn(async () => replies.shift()!);
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects ambiguous and missing venue-local DST starts", async () => {
    for (const [date, encoded] of [["2026-11-01", "110120260130"], ["2026-03-08", "030820260230"],
      ["2026-03-08", "030820260130"]]) {
      const first = html([encoded]), later = html([`${encoded.slice(0, 4)}2027${encoded.slice(8)}`]);
      const { fetch } = sequence(first, later);
      await expect(fetchUScheduleAvailability({ ...input, date }, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    }
  });
  it("keeps a valid hour after the spring transition in the venue timezone", async () => {
    const { fetch } = sequence(html(["030820260330"]), html(["030920261500"]));
    const result = await fetchUScheduleAvailability({ ...input, date: "2026-03-08" }, fetch);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ startsAt: new Date("2026-03-08T07:30:00.000Z"),
      endsAt: new Date("2026-03-08T08:30:00.000Z") });
  });
  it.each([
    ["spring gap", "America/New_York", "2026-03-08", "030820260230", "030920261500"],
    ["spring crossing", "America/New_York", "2026-03-08", "030820260130", "030920261500"],
    ["one-hour fold", "America/New_York", "2026-11-01", "110120260130", "110220261500"],
    ["half-hour fold", "Australia/Lord_Howe", "2026-04-05", "040520260145", "040620261500"],
    ["half-hour crossing", "Australia/Lord_Howe", "2026-04-05", "040520260115", "040620261500"],
  ] as const)("rejects %s without returning partial availability", async (_label, timeZone, date, start, witness) => {
    const { fetch } = sequence(html([start]), html([witness]));
    await expect(fetchUScheduleAvailability({ ...input, date, timeZone }, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
});
