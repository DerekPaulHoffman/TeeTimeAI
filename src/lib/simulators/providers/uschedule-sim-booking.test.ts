import { describe, expect, it, vi } from "vitest";
import { fetchUScheduleAvailability, projectUSchedulePublicConfiguration } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";
import { resultFromSimulatorResearchBody } from "@/lib/automation/simulator-support-research";

const bookingUrl = "https://clients.uschedule.com/examplegolf/booking";
const input: SimulatorAvailabilityInput = {
  date: "2030-11-04", durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl, providerFamilyKey: "USCHEDULE",
    providerMetadata: { tenant: "examplegolf", serviceId: "72" }, active: true,
    publicAccessStatus: "PUBLIC", maxPartySize: null, supportedDurationsMinutes: [60] },
};
function document(times = ["110420301300", "110420301330"], resource = "0") {
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Sim Booking</option>
    <option value="73">30 Minute Quick Practice Session</option><option value="74">Summer member sim booking</option></select>
    <select id="select_length"><option value="60" selected>1 hour</option><option value="90">1 hour and 30 minutes</option></select>
    <div id="serviceDescription"><p>Play or Practice for one hour on our XGOLF SIMULATOR</p></div>
    <div class="choices">${times.map(time => `<div class="next_avail_results"><div class="next_avail_item" data-time="${time}" data-empid="${resource}">
    <div>Public start</div><div>Sim Booking - $40.00</div></div></div>`).join("")}</div>
    <a id="more_next_avail">show more results</a><script>var lastAvailTime = '${times.at(-1)}';</script></body>`;
}
function sequence(dated = document(["110420301300", "110520301300"])) {
  const replies = [new Response(document(), { headers: { "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=AnonymousFixture123; HttpOnly" } }),
    Response.json({ code: "refresh" }), new Response(dated, { headers: { "content-type": "text/html" } })];
  return vi.fn<typeof globalThis.fetch>(async () => replies.shift()!);
}

describe("selected one-hour public Sim Booking", () => {
  it("retains the reviewed service through the owned research projection", () => {
    const result = resultFromSimulatorResearchBody(bookingUrl, bookingUrl, 200, "text/html", Buffer.from(document()), new Date("2030-11-04T12:00:00Z"));
    expect(result.publicConfiguration).toEqual({ family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    expect(result.publicConfiguration).not.toHaveProperty("maxPartySize");
    const changed = document().replace("Play or Practice", "Members Play or Practice");
    expect(resultFromSimulatorResearchBody(bookingUrl, bookingUrl, 200, "text/html", Buffer.from(changed), new Date()).publicConfiguration).toBeUndefined();
  });
  it("projects only the selected corroborated rental beside unrelated member options", () => {
    const value = projectUSchedulePublicConfiguration(document(), bookingUrl);
    expect(value).toEqual({ family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    const extra = document().replace("</body>", '<a href="/login">Login</a><input type="hidden" value="FixtureSecret"></body>');
    expect(projectUSchedulePublicConfiguration(extra, bookingUrl)).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/FixtureSecret|member|40\.00|description/i);
  });
  it("reads full one-hour open-day intervals with unknown capacity", async () => {
    const fetch = sequence();
    const result = await fetchUScheduleAvailability(input, fetch);
    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(1);
    expect(result.slots[0]).toMatchObject({ startsAt: new Date("2030-11-04T18:00:00Z"), endsAt: new Date("2030-11-04T19:00:00Z"), maxPartySize: null });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[1][1]?.body)).toBe('[{"Name":"start_date","Value":"11/04/2030"}]');
  });
  it("requires a later-day witness for a complete no-match day", async () => {
    const result = await fetchUScheduleAvailability(input, sequence(document(["110520301300"])));
    expect(result).toMatchObject({ complete: true, slots: [] });
  });
  it("rejects occupied or assigned bays", async () => {
    await expect(fetchUScheduleAvailability(input, sequence(document(["110420301300", "110520301300"], "3")))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    expect(projectUSchedulePublicConfiguration(document(undefined, "3"), bookingUrl)).toBeUndefined();
  });
  it("rejects a truncated same-day list instead of reporting no availability", async () => {
    const dated = document().replace('<a id="more_next_avail">show more results</a>', "");
    await expect(fetchUScheduleAvailability(input, sequence(dated))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
  });
  it.each([
    ["missing description", (h: string) => h.replace('id="serviceDescription"', 'id="other"')],
    ["hidden description", (h: string) => h.replace('id="serviceDescription"', 'id="serviceDescription" hidden')],
    ["member description", (h: string) => h.replace("Play or Practice", "Members Play or Practice")],
    ["wrong service", (h: string) => h.replaceAll("Sim Booking", "VIP Sim Booking")],
    ["duplicate selected service", (h: string) => h.replace('value="73"', 'value="73" selected')],
    ["duplicate service id", (h: string) => h.replace('value="73"', 'value="72"')],
    ["hidden selected service", (h: string) => h.replace('value="72" selected', 'value="72" selected hidden')],
    ["hidden row", (h: string) => h.replace('class="next_avail_item"', 'hidden class="next_avail_item"')],
    ["wrong selected duration", (h: string) => h.replace('value="60" selected', 'value="30" selected')],
    ["location selector", (h: string) => h.replace("</body>", '<select id="select_location"></select></body>')],
    ["group selector", (h: string) => h.replace("</body>", '<select id="select_group_size"></select></body>')],
    ["resource selector", (h: string) => h.replace("</body>", '<select class="resSelect"></select></body>')],
    ["wrong row identity", (h: string) => h.replace("Sim Booking - $40.00", "Golf Lesson - $40.00")],
    ["required access", (h: string) => h.replace("</body>", "<p>Sign in to continue</p></body>")],
  ])("rejects %s before sending a date filter", async (_name, mutate) => {
    const page = mutate(document());
    expect(projectUSchedulePublicConfiguration(page, bookingUrl)).toBeUndefined();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(page, { headers: { "content-type": "text/html" } }));
    await expect(fetchUScheduleAvailability(input, fetch)).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
