import { describe, expect, it, vi } from "vitest";
import { fetchUScheduleRecipeAvailability } from "./uschedule";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import type { SimulatorAvailabilityInput } from "./types";
import { parseAccessRecipe } from "@/lib/course-discovery/recipe";
import { executeAccessRecipe } from "@/lib/course-discovery/executor";

const source = "https://clients.uschedule.com/examplegolf/booking", service = { serviceId: "72", serviceName: "Public Tee Times" };
const input: SimulatorAvailabilityInput = { date: "2030-10-23", durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true,
    publicAccessStatus: "PUBLIC", providerMetadata: { tenant: "examplegolf", serviceId: service.serviceId }, maxPartySize: null, supportedDurationsMinutes: [60] } };
const key = (date: string, hour: number, minute = 0) => `${date.slice(5, 7)}${date.slice(8)}${date.slice(0, 4)}${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
function grid(date: string, duration: number) {
  const row = (hour: number, minute: number, classes = "") => `<div class="col timeslot ${classes}" data-time="${key(date, hour, minute)}"><span>${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}</span></div>`;
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Public Tee Times</option></select>
    <label for="select_length">Choose Simulator Time</label><select id="select_length"><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option><option value="120" ${duration === 120 ? "selected" : ""}>2 hours</option></select>
    <div id="res_section"><label for="resource91">Simulators</label><div><select id="resource91" class="resSelect"><option value="-1" selected>Any Available</option><option value="101">Sponsored Bay</option><option value="102">Bay #2</option></select></div></div>
    <div class="choices full"><div class="row time_choices">${row(10, 0, "selected")}${row(10, 16)}${row(11, 8, "d-none extra")}
      <div id="show-extra-row" class="w-100"><span class="no_time">Show Additional Times (<text>1</text> more)</span></div>
      <div id="hide-extra-row" class="w-100" style="display:none"><span class="no_time">Hide Additional Times</span></div>
    </div></div><script>var chosenDate = new Date(${date.slice(0, 4)}, ${Number(date.slice(5, 7)) - 1}, ${Number(date.slice(8))});</script></body>`;
}
function reader(mutate: (html: string) => string = html => html, ignore: "date" | "duration" | undefined = undefined) {
  let date = "2030-10-20", duration = 60, first = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "length" && ignore !== "duration") duration = Number(Value);
      if (Name === "start_date" && ignore !== "date") date = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
      return Response.json({ code: "refresh" });
    }
    const html = date === input.date ? mutate(grid(date, duration)) : grid(date, duration);
    const headers = { "content-type": "text/html", ...(first ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}) }; first = false;
    return new Response(html, { headers });
  });
  return fetch;
}
async function run(fetch: typeof globalThis.fetch, durationMinutes = 60) {
  const session = createUSchedulePublicSession(source, { fetch, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
  try { return await fetchUScheduleRecipeAvailability({ ...input, durationMinutes }, service, session.read); }
  finally { session.dispose(); }
}
describe("explicit public simulator dated time grid", () => {
  it("replays an unchanged SIMULATOR method for two golfers as one complete bay with unknown capacity", async () => {
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
      source: { officialUrl: "https://official.example/", bookingUrl: source, venueName: "Example Golf", timeZone: input.timeZone, providerFamily: "USCHEDULE" },
      adapter: { family: "USCHEDULE", tenant: "examplegolf", ...service } });
    const result = await executeAccessRecipe(recipe, { date: input.date, durationMinutes: 60, timeZone: input.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
      { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(3);expect(result.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null && slot.resourceId === "uschedule-resource-group:91:pooled")).toBe(true);
  });
  it.each([60, 120])("proves a whole %i-minute pooled bay directly from the selected-length response without joining adjacent starts", async duration => {
    const fetch = reader(), result = await run(fetch, duration);
    expect(result.complete).toBe(true); expect(result.slots).toHaveLength(3);
    expect(result.slots.map(slot => slot.startsAt.toISOString())).toEqual(["2030-10-23T14:00:00.000Z", "2030-10-23T14:16:00.000Z", "2030-10-23T15:08:00.000Z"]);
    expect(result.slots.every(slot => slot.endsAt.getTime() - slot.startsAt.getTime() === duration * 60000 && slot.maxPartySize === null && slot.resourceId === "uschedule-resource-group:91:pooled")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([[{ Name: "length", Value: String(duration) }], [{ Name: "start_date", Value: "10/23/2030" }]]);
  });
  it.each([
    ["mixed legacy layout", (h: string) => h.replace("</body>", '<div class="next_avail_results"><div class="next_avail_item"></div></div></body>')],
    ["two grids", (h: string) => h.replace("</body>", '<div class="time_choices"></div></body>')],
    ["unowned row", (h: string) => h.replace("</body>", `<div class="col timeslot" data-time="${key(input.date, 13)}"><span>1:00 PM</span></div></body>`)],
    ["booked", (h: string) => h.replace('class="col timeslot selected"', 'class="col timeslot selected booked"')],
    ["disabled", (h: string) => h.replace('class="col timeslot selected"', 'class="col timeslot selected disabled"')],
    ["no-time", (h: string) => h.replace('class="col timeslot selected"', 'class="col timeslot selected no_time"')],
    ["hidden", (h: string) => h.replace('data-time=', 'hidden data-time=')],
    ["aria disabled", (h: string) => h.replace('data-time=', 'aria-disabled="true" data-time=')],
    ["onclick", (h: string) => h.replace('data-time=', 'onclick="book()" data-time=')],
    ["hidden clock label", (h: string) => h.replace("<span>10:00 AM", "<span hidden>10:00 AM")],
    ["false clock label", (h: string) => h.replace("10:16 AM", "10:17 AM")],
    ["duplicate start", (h: string) => h.replace(key(input.date, 10, 16), key(input.date, 10, 0))],
    ["foreign day", (h: string) => h.replace(key(input.date, 10, 16), key("2030-10-24", 10, 16))],
    ["extra count mismatch", (h: string) => h.replace("<text>1</text>", "<text>2</text>")],
    ["unaccounted extra", (h: string) => h.replace('id="show-extra-row"', 'id="other-extra-row"')],
    ["hidden more label", (h: string) => h.replace('<span class="no_time">Show', '<span class="no_time" hidden>Show')],
    ["action on more control", (h: string) => h.replace('id="show-extra-row"', 'onclick="book()" id="show-extra-row"')],
    ["unpaired extra hiding", (h: string) => h.replace("d-none extra", "d-none")],
    ["hidden parent", (h: string) => h.replace('class="choices full"', 'class="choices full" hidden')],
    ["transparent parent", (h: string) => h.replace('class="choices full"', 'class="choices full" style="opacity:0!important"')],
    ["private parent", (h: string) => h.replace('class="choices full"', 'class="choices full private"')],
    ["resource selected", (h: string) => h.replace('value="-1" selected', 'value="-1"').replace('value="101"', 'value="101" selected')],
    ["duplicate resource", (h: string) => h.replace('value="102"', 'value="101"')],
    ["wrong pool label", (h: string) => h.replace(">Simulators<", ">Lessons<")],
    ["wrong duration label", (h: string) => h.replace("Choose Simulator Time", "Choose Lesson Time")],
    ["continuation", (h: string) => h.replace("</body>", '<a id="more_next_avail">More</a></body>')],
    ["empty not proven", (h: string) => h.replace(/<div class="col timeslot[^>]*>.*?<\/div>/gu, "")],
  ] as const)("never treats %s as complete public availability", async (_name, mutate) => {
    await expect(run(reader(mutate))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_SOURCE|SCHEMA_CHANGED/u) });
  });
  it.each(["date", "duration"] as const)("requires the selected %s to reflect the exact admitted refresh", async ignore => {
    await expect(run(reader(undefined, ignore), ignore === "duration" ? 120 : 60)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_SOURCE|SCHEMA_CHANGED/u) });
  });
  it("keeps a finite grid bound and does not reinterpret a non-grid service or lesson", async () => {
    await expect(run(reader(h => h.replace("</body>", '<div class="col timeslot"></div>'.repeat(65) + "</body>")))).rejects.toMatchObject({ code: "SCHEMA_CHANGED" });
    await expect(run(reader(h => h.replaceAll("Public Tee Times", "Hourly Simulator Rental")))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    await expect(run(reader(h => h.replaceAll("Public Tee Times", "Golf Lessons")))).rejects.toMatchObject({ code: "INVALID_SOURCE" });
  });
});
