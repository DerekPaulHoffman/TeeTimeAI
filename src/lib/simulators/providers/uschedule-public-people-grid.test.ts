import { describe, expect, it, vi } from "vitest";
import { createUSchedulePublicReadPolicy, readUSchedulePublicPeopleControl } from "@/lib/automation/uschedule-public-read-policy";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { executeAccessRecipe } from "@/lib/course-discovery/executor";
import { parseAccessRecipe } from "@/lib/course-discovery/recipe";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";

const source = "https://clients.uschedule.com/examplegolf/booking", service = { serviceId: "72", serviceName: "Simulator Rental" }, date = "2030-10-23";
const input: SimulatorAvailabilityInput = { date, durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC",
    providerMetadata: { tenant: "examplegolf", serviceId: "72" }, maxPartySize: null, supportedDurationsMinutes: [60] } };
const key = (day: string, hour: number) => `${day.slice(5, 7)}${day.slice(8)}${day.slice(0, 4)}${hour}00`;
function document(day = date, duration = 60, people = 1, max: number | null = 8) {
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Simulator Rental</option><option value="74">Simulator Rental: 30 Minutes</option><option value="73">Golf Lesson</option></select>
    <label for="select_length">Choose Time</label><select id="select_length"><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option><option value="120" ${duration === 120 ? "selected" : ""}>2 hours</option></select>
    <div id="group_size_section"><label for="select_group_size">Choose # of People</label><div><select id="select_group_size" onchange="groupSizeChanged();">${Array.from({ length: 8 }, (_, i) => `<option ${people === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select></div></div>
    <ul><li class="selected" onclick="return saveBookingDetail('single_date');">Date Chosen</li><li onclick="return saveBookingDetail('next_avail');">Next Available</li></ul>
    <div class="choices pt-2"><div class="row time_choices"><div class="col timeslot selected" data-time="${key(day, 10)}"><span>10:00 AM</span></div>
    <div class="col timeslot d-none extra" data-time="${key(day, 11)}"><span>11:00 AM</span></div>
    <div id="show-extra-row" class="w-100"><span class="no_time">Show Additional Times (<text>1</text> more)</span></div>
    <div id="hide-extra-row" class="w-100" style="display:none;"><span class="no_time">Hide Additional Times</span></div></div></div>
    <div class="card"><ul><li>Playing costs are per bay, not per player.</li>${max === null ? "" : `<li>Each bay can accommodat<span>e&nbsp;</span>up to ${max} people max (strictly enforced regardless of # of people golfing)</li>`}</ul></div>
    <script>var chosenDate = new Date(${day.slice(0, 4)}, ${Number(day.slice(5, 7)) - 1}, ${Number(day.slice(8))});</script></body>`;
}
function reader(mutate: (html: string) => string = h => h, ignore?: string, max: number | null = 8) {
  let currentDate = "2030-10-20", duration = 60, people = 1, first = true;
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "length" && ignore !== "duration") duration = Number(Value);
      if (Name === "group_size" && ignore !== "people") people = Number(Value);
      if (Name === "start_date" && ignore !== "date") { currentDate = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`; if (ignore === "resetPeople") people = 1; }
      return Response.json({ code: "refresh" });
    }
    const headers = { "content-type": "text/html", ...(first ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}) }; first = false;
    return new Response(mutate(document(currentDate, duration, people, max)), { headers });
  });
}
async function run(fetch: typeof globalThis.fetch, requestedPlayers: number | undefined = 2, durationMinutes = 60) {
  const session = createUSchedulePublicSession(source, { fetch, requestedPlayers, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
  try { return await fetchUScheduleRecipeAvailability({ ...input, requestedPlayers, durationMinutes }, service, session.read); }
  finally { session.dispose(); }
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
  source: { officialUrl: "https://official.example/", bookingUrl: source, venueName: "Example Golf", timeZone: input.timeZone, providerFamily: "USCHEDULE" }, adapter: { family: "USCHEDULE", tenant: "examplegolf", ...service } });
describe("explicit public PEOPLE quantity role", () => {
  it.each([1, 2, 4])("grants only requested %i people and rereads that count as one whole public bay", async requested => {
    const fetch = reader(), result = await run(fetch, requested);
    expect(result).toMatchObject({ complete: true, publicPartyLimit: 8 }); expect(result.slots).toHaveLength(2);
    expect(result.slots.every(slot => slot.maxPartySize === null && slot.resourceId === "uschedule-service:72:pooled" && slot.endsAt.getTime() - slot.startsAt.getTime() === 3_600_000)).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      [{ Name: "length", Value: "60" }], [{ Name: "group_size", Value: String(requested) }], [{ Name: "start_date", Value: "10/23/2030" }],
    ]);
    const policy = createUSchedulePublicReadPolicy({ requestedPlayers: requested }); expect(policy.observeResponse(source, "GET", 200, "text/html", document())).toBe(true);
    const headers = new Headers({ "content-type": "application/json", origin: new URL(source).origin, referer: source });
    for (const value of ["1", "2", "3", "4", "8"]) expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "group_size", Value: value }]))).toBe(value === String(requested));
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "units_to_book", Value: "1" }]))).toBe(false);
    policy.observeResponse(source, "GET", 200, "text/html", "<p>Replaced</p>");
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "group_size", Value: String(requested) }]))).toBe(false);
  });
  it("reuses the unchanged method for new ordinary people/date inputs while keeping availableSpots one bay", async () => {
    const method = recipe();
    for (const [players, day] of [[2, date], [1, "2030-10-24"]] as const) {
      const result = await executeAccessRecipe(method, { date: day, durationMinutes: 60, timeZone: input.timeZone, players, startTime: "09:00", endTime: "18:00" },
        { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
      expect(result.status).toBe("AVAILABLE"); expect(result.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null)).toBe(true);
    }
  });
  it("honors the current published one-person upper limit", async () => {
    const result = await executeAccessRecipe(recipe(), { date, durationMinutes: 60, timeZone: input.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
      { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(undefined, undefined, 1), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    expect(result).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { capacityVerified: false } });
  });
  it("keeps an unstated physical capacity unknown", async () => {
    const result = await run(reader(undefined, undefined, null)); expect(result.publicPartyLimit).toBeNull(); expect(result.slots.every(slot => slot.maxPartySize === null)).toBe(true);
  });
  it("accepts exactly accounted zero extras without relaxing the legacy grid", async () => {
    const result = await run(reader(h => h.replace(/<div class="col timeslot d-none extra"[^>]+><span>11:00 AM<\/span><\/div>/u, "").replace("<text>1</text>", "<text>0</text>")));
    expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1);
  });
  it.each([
    ["unknown role", (h: string) => h.replace("Choose # of People", "Choose # of Items")],
    ["wrong handler", (h: string) => h.replace("groupSizeChanged();", "unitsToBookChanged();")],
    ["hidden control", (h: string) => h.replace('id="group_size_section"', 'id="group_size_section" hidden')],
    ["private control", (h: string) => h.replace('id="group_size_section"', 'id="group_size_section" class="private"')],
    ["hidden label fragment", (h: string) => h.replace("Choose # of People", 'Choose # of <span hidden>People</span>')],
    ["ambiguous selection", (h: string) => h.replace('value="74"', 'value="74" selected')],
    ["duplicate control", (h: string) => h.replace("</body>", '<select id="select_group_size"></select></body>')],
    ["mixed unit mode", (h: string) => h.replace("</body>", '<select id="select_units_to_book"></select></body>')],
    ["mixed resource mode", (h: string) => h.replace("</body>", '<select class="resSelect"></select></body>')],
    ["missing requested value", (h: string) => h.replace(/<option\s*>2<\/option>/u, "")],
    ["missing per-bay meaning", (h: string) => h.replace("Playing costs are per bay, not per player.", "Prices vary.")],
    ["hidden per-bay meaning", (h: string) => h.replace("Playing costs are per bay, not per player.", '<span hidden>Playing costs are per bay, not per player.</span>')],
    ["contradictory pricing", (h: string) => h.replace("</ul></div>", "<li>Playing costs are per player.</li></ul></div>")],
    ["private service", (h: string) => h.replaceAll("Simulator Rental", "Private Simulator Rental")],
    ["lesson", (h: string) => h.replaceAll("Simulator Rental", "Golf Lesson")],
    ["incomplete extras", (h: string) => h.replace("<text>1</text>", "<text>2</text>")],
    ["competing choices container", (h: string) => h.replace("</body>", '<div class="choices"></div></body>')],
    ["disabled slot", (h: string) => h.replace("col timeslot selected", "col timeslot selected disabled")],
    ["conflicting maxima", (h: string) => h.replace("</ul></div>", "<li>A maximum of 1 player per bay.</li></ul></div>")],
  ] as const)("fails closed for %s", async (_name, mutate) => { await expect(run(reader(mutate))).rejects.toBeDefined(); });
  it.each(["date", "duration", "people", "resetPeople"])("requires current exact %s readback", async ignore => {
    await expect(run(reader(undefined, ignore), 2, ignore === "duration" ? 120 : 60)).rejects.toBeDefined();
  });
  it("cannot grant people without an ordinary bounded requested count", async () => {
    expect(readUSchedulePublicPeopleControl(document()).valid).toBe(true);
    for (const requestedPlayers of [undefined, 0, 5]) {
      const policy = createUSchedulePublicReadPolicy({ requestedPlayers }); policy.observeResponse(source, "GET", 200, "text/html", document());
      expect(policy.allows(new URL(`${source}/changefield`), new Headers({ "content-type": "application/json", origin: new URL(source).origin, referer: source }), JSON.stringify([{ Name: "group_size", Value: "1" }]))).toBe(false);
    }
    await expect(run(reader(), 5)).rejects.toThrow("INVALID_ADAPTER_SOURCE");
    expect(inspectUScheduleRecipeConfiguration(document(), source)?.rentals).toHaveLength(2);
  });
});
