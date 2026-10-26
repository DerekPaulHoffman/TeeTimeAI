import { describe, expect, it, vi } from "vitest";
import { readUSchedulePublicPeopleControl } from "@/lib/automation/uschedule-public-read-policy";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { executeAccessRecipe } from "@/lib/course-discovery/executor";
import { parseAccessRecipe } from "@/lib/course-discovery/recipe";
import { fetchUScheduleRecipeAvailability } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";

const source = "https://clients.uschedule.com/examplegolf/booking", service = { serviceId: "72", serviceName: "Simulator Rental" }, date = "2030-10-23";
const input: SimulatorAvailabilityInput = { date, durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC", providerMetadata: { tenant: "examplegolf", serviceId: "72" }, maxPartySize: null, supportedDurationsMinutes: [60] } };
const key = (day: string, hour: number) => `${day.slice(5, 7)}${day.slice(8)}${day.slice(0, 4)}${hour}00`;
function document(day = date, duration = 60, people = 1, next = false, morePage = false, limit?: number) {
  const tomorrow = new Date(`${day}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const starts = morePage ? [[day, 12], [tomorrow.toISOString().slice(0, 10), 10]] as const : [[day, 10], [day, 11]] as const;
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Simulator Rental</option><option value="73">Golf Lesson</option></select>
    <label for="select_length">Choose Service Time</label><select id="select_length">${[30, 60, 120].map(n => `<option value="${n}" ${duration === n ? "selected" : ""}>${n} minutes</option>`).join("")}</select>
    <div id="group_size_section"><label for="select_group_size">Choose Party Size</label><div><select id="select_group_size" onchange="groupSizeChanged();">${[1, 2, 3, 4].map(n => `<option ${n === people ? "selected" : ""}>${n}</option>`).join("")}</select></div></div>
    <ul><li class="${next ? "selected" : ""}" onclick="return saveBookingDetail('next_avail');">Next Available</li></ul>
    <div class="choices">${starts.map(([d, h]) => `<div class="next_avail_results"><div class="next_avail_item" data-time="${key(d, h)}" data-empid="0"><div>Public start</div><div>Simulator Rental - $30.00</div></div></div>`).join("")}
    ${morePage ? "" : '<a id="more_next_avail">More</a>'}</div>
    ${limit === undefined ? "" : `<div class="card"><ul><li>A maximum of ${limit} people per bay.</li></ul></div>`}
    <script>var chosenDate = new Date(${day.slice(0, 4)}, ${Number(day.slice(5, 7)) - 1}, ${Number(day.slice(8))});
    var lastAvailTime = '${key(starts.at(-1)![0], starts.at(-1)![1])}';</script></body>`;
}
type State = { day: string; duration: number; people: number; next: boolean; more: boolean; lengthChanged: boolean };
function reader(mutate: (html: string, state: State) => string = h => h, ignore?: string, limits?: [number | undefined, number | undefined]) {
  const state: State = { day: "2030-10-20", duration: 30, people: 1, next: false, more: false, lengthChanged: false };
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "length") { state.lengthChanged = true; if (ignore !== "duration") state.duration = Number(Value); }
      if (Name === "group_size" && ignore !== "people") state.people = Number(Value);
      if (Name === "start_date" && ignore !== "date") { state.day = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`; state.next = false; }
      if (Name === "next_avail" && ignore !== "view") state.next = true;
      if (Name === "more_next_avail" && ignore !== "cursor") state.more = true;
      return Response.json({ code: "refresh" });
    }
    return new Response(mutate(document(state.day, state.duration, state.people, state.next, state.more, limits?.[state.more ? 1 : 0]), state),
      { headers: { "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } });
  });
}
async function run(fetch: typeof globalThis.fetch, requestedPlayers = 2) {
  const session = createUSchedulePublicSession(source, { fetch, requestedPlayers, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
  try { return await fetchUScheduleRecipeAvailability({ ...input, requestedPlayers }, service, session.read); }
  finally { session.dispose(); }
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
  source: { officialUrl: "https://official.example/", bookingUrl: source, venueName: "Example Golf", timeZone: input.timeZone, providerFamily: "USCHEDULE" }, adapter: { family: "USCHEDULE", tenant: "examplegolf", ...service } });
describe("participant role on the strict public Next Available list", () => {
  it.each([1, 2, 4])("queries exactly %i participants and keeps legacy view/cursor/later-day completeness", async players => {
    const fetch = reader(), result = await run(fetch, players);
    expect(result).toMatchObject({ complete: true, publicPartyLimit: null }); expect(result.slots).toHaveLength(3);
    expect(result.slots.every(s => s.maxPartySize === null && s.resourceId === "uschedule-service:72:pooled" && s.endsAt.getTime() - s.startsAt.getTime() === 3_600_000)).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init.body)))).toEqual([
      [{ Name: "length", Value: "60" }], [{ Name: "group_size", Value: String(players) }], [{ Name: "start_date", Value: "10/23/2030" }], [{ Name: "next_avail" }], [{ Name: "more_next_avail", Value: key(date, 11) }],
    ]);
    expect(readUSchedulePublicPeopleControl(document())).toMatchObject({ valid: true, datedGridEligible: false });
  });
  it("reuses an unchanged serialized method for people2 then4 with no physical-capacity invention", async () => {
    const method = recipe();
    for (const players of [2, 4]) {
      const result = await executeAccessRecipe(method, { date, durationMinutes: 60, timeZone: input.timeZone, players, startTime: "09:00", endTime: "18:00" },
        { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
      expect(result.status).toBe("AVAILABLE"); expect(result.slots.every(s => s.availableSpots === 1 && s.capacity === null)).toBe(true);
    }
  });
  it("keeps the lowest observed public limit across pages and rejects a party above it", async () => {
    expect((await run(reader(undefined, undefined, [1, 4]))).publicPartyLimit).toBe(1);
    const result = await executeAccessRecipe(recipe(), { date, durationMinutes: 60, timeZone: input.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
      { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(undefined, undefined, [1, 4]), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    expect(result).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { capacityVerified: false } });
  });
  it("honors the current service description maximum without importing unrelated event totals", async () => {
    const fetch = reader(h => h.replace("</body>", '<div id="serv_desc_section"><p>Maximum of 1 player per simulator.</p><p>Event venue maximum 100 people.</p></div></body>'));
    const result = await executeAccessRecipe(recipe(), { date, durationMinutes: 60, timeZone: input.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
      { now: () => new Date("2030-10-19T12:00:00Z"), fetch, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    expect(result).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { capacityVerified: false } });
    const unrelated = await run(reader(h => h.replace("</body>", '<div id="serv_desc_section"><p>Event venue maximum 1 person per event.</p><p>Public rental details.</p></div></body>')));
    expect(unrelated.publicPartyLimit).toBeNull();
  });
  it("never drops an ancestor's direct maximum beside child paragraphs and accepts ordinary nested inline limits", async () => {
    for (const [description, status] of [
      ['Maximum of 1 player per simulator.<p>Public rental details.</p>', "INCOMPLETE"],
      ['<p>Maximum of <b>4</b> players per simulator.</p><p>Public rental details.</p>', "AVAILABLE"],
    ] as const) {
      const result = await executeAccessRecipe(recipe(), { date, durationMinutes: 60, timeZone: input.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
        { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(h => h.replace("</body>", `<div id="serv_desc_section">${description}</div></body>`)), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
      expect(result.status).toBe(status);
      if (status === "INCOMPLETE") expect(result.slots).toEqual([]);
      else expect(result.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null)).toBe(true);
    }
  });
  it.each([
    ["unknown label", (h: string) => h.replace("Choose Party Size", "Choose Product Count")],
    ["missing control", (h: string) => h.replace('id="select_group_size"', 'id="unrelated"')],
    ["hidden control", (h: string) => h.replace('id="group_size_section"', 'id="group_size_section" hidden')],
    ["private control", (h: string) => h.replace('id="group_size_section"', 'id="group_size_section" class="private"')],
    ["form control", (h: string) => h.replace('<div id="group_size_section">', '<form id="group_size_section">').replace('</select></div></div>', '</select></div></form>')],
    ["wrong handler", (h: string) => h.replace("groupSizeChanged();", "book();")],
    ["mixed units", (h: string) => h.replace("</body>", '<select id="select_units_to_book"></select></body>')],
    ["missing requested value", (h: string) => h.replace(/<option\s*>2<\/option>/u, "")],
    ["lesson service", (h: string) => h.replaceAll("Simulator Rental", "Golf Lesson")],
    ["hidden row", (h: string) => h.replace('class="next_avail_item"', 'class="next_avail_item" hidden')],
    ["booked row", (h: string) => h.replace('class="next_avail_item"', 'class="next_avail_item booked"')],
    ["wrong row service", (h: string) => h.replace("Simulator Rental - $30.00", "Golf Lesson - $30.00")],
    ["partial day", (h: string) => h.replace('<a id="more_next_avail">More</a>', "")],
    ["bad cursor", (h: string) => h.replace(/var lastAvailTime = '[0-9]+';/u, "var lastAvailTime = '102320300900';")],
    ["duplicate start", (h: string) => h.replace(key(date, 11), key(date, 10))],
    ["wrong chosen date", (h: string) => h.replace("new Date(2030, 9, 23)", "new Date(2030, 9, 22)")],
    ["conflicting limits", (h: string) => h.replace("</body>", '<div class="card"><ul><li>A maximum of 1 player per bay.</li><li>A maximum of 4 players per bay.</li></ul></div></body>')],
    ["unparseable public limit", (h: string) => h.replace("</body>", '<div class="card"><ul><li>Only 1 player per bay.</li></ul></div></body>')],
    ["duplicate service description", (h: string) => h.replace("</body>", '<div id="serv_desc_section"></div><div id="serv_desc_section"></div></body>')],
    ["interactive cap description", (h: string) => h.replace("</body>", '<div id="serv_desc_section"><p>Maximum of 1 player per simulator.<button>Book</button></p></div></body>')],
  ] as const)("rejects %s", async (_name, mutate) => { await expect(run(reader(mutate))).rejects.toBeDefined(); });
  it.each(["date", "duration", "people", "view", "cursor"])("requires exact %s progress/readback", async ignore => { await expect(run(reader(undefined, ignore))).rejects.toBeDefined(); });
  it("does not promote a Party Size dated grid or lose its role mid-execution", async () => {
    await expect(run(reader(h => h.replace('class="choices"', 'class="choices time_choices"')))).rejects.toBeDefined();
    const fetch = reader((h, state) => state.lengthChanged ? h.replace("Choose Party Size", "Choose Unknown").replace(/<option\s+selected>2<\/option>/u, "<option>2</option>").replace(/<option\s*>1<\/option>/u, "<option selected>1</option>") : h);
    await expect(run(fetch)).rejects.toBeDefined();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
