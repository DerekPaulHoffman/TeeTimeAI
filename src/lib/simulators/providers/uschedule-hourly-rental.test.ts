import { describe, expect, it, vi } from "vitest";
import { fetchUScheduleAvailability, projectUSchedulePublicConfiguration } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";

const bookingUrl = "https://clients.uschedule.com/examplegolf/booking";
const input: SimulatorAvailabilityInput = {
  date: "2030-11-04", durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl, providerFamilyKey: "USCHEDULE",
    providerMetadata: { tenant: "examplegolf", serviceId: "72" }, active: true,
    publicAccessStatus: "PUBLIC", maxPartySize: null, supportedDurationsMinutes: [60] },
};
function document(times = ["110420300800", "110420300900"], resource = "0") {
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Hourly Simulator Rental</option></select>
    <select id="select_length"><option value="60" selected>1 hour</option><option value="120">2 hours</option>
    <option value="180">3 hours</option><option value="240">4 hours</option></select>
    <div class="choices">${times.map(time => `<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="${resource}">
    <div>Public start</div><div>Hourly Simulator Rental - $50.00</div></div></div>`).join("")}</div>
    <a id="more_next_avail">show more results</a><script>var lastAvailTime = '${times.at(-1)}';</script></body>`;
}
function sequence(dated = document(["110420300800", "110520300800"])) {
  const replies = [new Response(document(), { headers: { "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=AnonymousFixture123; HttpOnly" } }),
    Response.json({ code: "refresh" }), new Response(dated, { headers: { "content-type": "text/html" } })];
  return vi.fn<typeof globalThis.fetch>(async () => replies.shift()!);
}

describe("one-hour public hourly simulator rental", () => {
  it("projects the exact selected one-hour pooled service without capacity or longer durations", () => {
    expect(projectUSchedulePublicConfiguration(document(), bookingUrl)).toEqual({ family: "USCHEDULE", tenant: "examplegolf",
      serviceId: "72", durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    const withOptionalLogin = document().replace("</body>", '<a href="/login">Login</a><input type="hidden" value="PrivateFixtureSecret"></body>');
    const projected = projectUSchedulePublicConfiguration(withOptionalLogin, bookingUrl);
    expect(projected).toBeDefined();
    expect(JSON.stringify(projected)).not.toContain("PrivateFixtureSecret");
    expect(JSON.stringify(projected)).not.toContain("50.00");
  });
  it("reads an open day with full one-hour intervals and unknown capacity", async () => {
    const fetch = sequence();
    const result = await fetchUScheduleAvailability(input, fetch);
    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ startsAt: new Date("2030-11-04T13:00:00Z"), endsAt: new Date("2030-11-04T14:00:00Z"), maxPartySize: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[1][1]?.body)).toBe('[{"Name":"start_date","Value":"11/04/2030"}]');
  });
  it("accepts a no-match day only with the existing later-day completion witness", async () => {
    const result = await fetchUScheduleAvailability(input, sequence(document(["110520300800"])));
    expect(result.complete).toBe(true);
    expect(result.slots).toEqual([]);
  });
  it("rejects an occupied or explicitly assigned bay instead of inventing pooled availability", async () => {
    const fetch = sequence(document(["110420300800", "110520300800"], "3"));
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(projectUSchedulePublicConfiguration(document(undefined, "3"), bookingUrl)).toBeUndefined();
  });
  it.each([
    ["private rental", (html: string) => html.replaceAll("Hourly Simulator Rental", "Members Simulator Rental")],
    ["lesson", (html: string) => html.replaceAll("Hourly Simulator Rental", "Hourly Golf Lesson")],
    ["changed selected duration", (html: string) => html.replace('value="60" selected', 'value="30" selected')],
    ["unverified resource selector", (html: string) => html.replace("</body>", '<select class="resSelect"><option value="3" selected>Bay</option></select></body>')],
    ["unverified group selector", (html: string) => html.replace("</body>", '<select id="select_group_size"><option value="4" selected>4</option></select></body>')],
    ["changed row rental", (html: string) => html.replace("Hourly Simulator Rental - $50.00", "Golf Lesson - $50.00")],
    ["mandatory login", (html: string) => html.replace("</body>", "<p>Sign in to continue</p></body>")],
  ])("rejects %s without issuing a filter request", async (_name, change) => {
    const page = change(document());
    expect(projectUSchedulePublicConfiguration(page, bookingUrl)).toBeUndefined();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(page, { headers: { "content-type": "text/html" } }));
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
