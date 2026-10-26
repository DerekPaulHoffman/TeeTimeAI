import { describe, expect, it, vi } from "vitest";
import { createUSchedulePublicReadPolicy, readUSchedulePublicUnitsControl } from "@/lib/automation/uschedule-public-read-policy";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { executeAccessRecipe } from "@/lib/course-discovery/executor";
import { parseAccessRecipe } from "@/lib/course-discovery/recipe";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "./uschedule";
import type { SimulatorAvailabilityInput } from "./types";

const source = "https://clients.uschedule.com/examplegolf/booking", service = { serviceId: "72", serviceName: "Suite Rental" };
const date = "2030-10-23", wall = (day: string, hour: number) => `${day.slice(5, 7)}${day.slice(8)}${day.slice(0, 4)}${hour}00`;
const input: SimulatorAvailabilityInput = { date, durationMinutes: 60, partySize: 1, timeZone: "America/New_York",
  offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true,
    publicAccessStatus: "PUBLIC", providerMetadata: { tenant: "examplegolf", serviceId: "72" }, maxPartySize: null, supportedDurationsMinutes: [60] } };
function document(day = date, duration = 60, limit: number | null = 8) {
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Suite Rental</option><option value="73">Golf Lesson</option></select>
    <label for="select_length">Choose Time</label><select id="select_length"><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option><option value="120" ${duration === 120 ? "selected" : ""}>2 hours</option></select>
    <div id="units_to_book_size_section"><label for="select_group_size">Number of Suites to Book</label><div><select id="select_units_to_book" onchange="unitsToBookChanged();"><option selected>1</option><option>2</option></select></div></div>
    <div class="choices full"><div class="row time_choices"><div class="col timeslot selected" data-time="${wall(day, 10)}"><span>10:00 AM</span></div>
    <div class="col timeslot d-none extra" data-time="${wall(day, 11)}"><span>11:00 AM</span></div>
    <div id="show-extra-row" class="w-100"><span class="no_time">Show Additional Times (<text>1</text> more)</span></div>
    <div id="hide-extra-row" class="w-100" style="display:none;"><span class="no_time">Hide Additional Times</span></div></div></div>
    ${limit === null ? "" : `<div class="card"><div><ul><li>A maximum of ${limit} people can compete on simulators at one time (additional space for guests at suite bars and main bar).</li></ul></div></div>`}
    <script>var chosenDate = new Date(${day.slice(0, 4)}, ${Number(day.slice(5, 7)) - 1}, ${Number(day.slice(8))});</script></body>`;
}
function reader(mutate: (html: string) => string = h => h, ignore?: string, limit: number | null = 8) {
  let selectedDate = "2030-10-20", duration = 60, first = true;
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "length" && ignore !== "duration") duration = Number(Value);
      if (Name === "start_date" && ignore !== "date") selectedDate = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
      return Response.json({ code: "refresh" });
    }
    const headers = { "content-type": "text/html", ...(first ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}) }; first = false;
    return new Response(mutate(document(selectedDate, duration, limit)), { headers });
  });
}
async function run(fetch: typeof globalThis.fetch, durationMinutes = 60) {
  const session = createUSchedulePublicSession(source, { fetch, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
  try { return await fetchUScheduleRecipeAvailability({ ...input, durationMinutes }, service, session.read); }
  finally { session.dispose(); }
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
  source: { officialUrl: "https://official.example/", bookingUrl: source, venueName: "Example Golf", timeZone: input.timeZone, providerFamily: "USCHEDULE" }, adapter: { family: "USCHEDULE", tenant: "examplegolf", ...service } });
const execute = (limit: number | null, players: number, mutate?: (html: string) => string) => executeAccessRecipe(recipe(), { date, durationMinutes: 60, timeZone: input.timeZone, players, startTime: "09:00", endTime: "18:00" },
  { now: () => new Date("2030-10-19T12:00:00Z"), fetch: reader(mutate, undefined, limit), requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });

describe("public rental units pool", () => {
  it.each(["Suite", "Bay", "Simulator"])("learns generic %s rental and only the observed one-unit POST", unit => {
    const html = document().replaceAll("Suite Rental", `${unit} Rental`).replace("Number of Suites", `Number of ${unit}s`);
    expect(inspectUScheduleRecipeConfiguration(html, source)?.selected.serviceName).toBe(`${unit} Rental`);
    expect(readUSchedulePublicUnitsControl(html)).toMatchObject({ present: true, valid: true, selectedOne: true });
    const policy = createUSchedulePublicReadPolicy(); expect(policy.observeResponse(source, "GET", 200, "text/html", html)).toBe(true);
    const headers = new Headers({ "content-type": "application/json", origin: new URL(source).origin, referer: source });
    for (const [Name, Value, accepted] of [["units_to_book", "1", true], ["units_to_book", "2", false], ["group_size", "1", false], ["time", wall(date, 10), false]] as const)
      expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name, Value }]))).toBe(accepted);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "units_to_book", Value: "1", other: "1" }]))).toBe(false);
    policy.observeResponse(source, "GET", 200, "text/html", "<p>Changed</p>");
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "units_to_book", Value: "1" }]))).toBe(false);
  });
  it.each([60, 120])("refreshes duration, one unit and date; proves whole %i minutes without joining starts", async duration => {
    const fetch = reader(), result = await run(fetch, duration);
    expect(result).toMatchObject({ complete: true, publicPartyLimit: 8 }); expect(result.slots).toHaveLength(2);
    expect(result.slots.every(slot => slot.maxPartySize === null && slot.resourceId === "uschedule-service:72:pooled" && slot.endsAt.getTime() - slot.startsAt.getTime() === duration * 60_000)).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      [{ Name: "length", Value: String(duration) }], [{ Name: "units_to_book", Value: "1" }], [{ Name: "start_date", Value: "10/23/2030" }],
    ]);
  });
  it("matches one bay for two people with unknown physical capacity and enforces the separate public upper limit", async () => {
    for (const limit of [null, 8]) {
      const result = await execute(limit, 2); expect(result).toMatchObject({ status: "AVAILABLE", complete: true });
      expect(result.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null)).toBe(true);
    }
    expect(await execute(2, 4)).toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { capacityVerified: false } });
  });
  it.each(["player", "golfer", "person"])("honors a published one-%s limit without downgrading it to unknown", async noun => {
    expect(await execute(1, 2, h => h.replace("A maximum of 1 people can compete on simulators at one time (additional space for guests at suite bars and main bar).", `A maximum of 1 ${noun} per suite.`)))
      .toMatchObject({ status: "INCOMPLETE", slots: [], evidence: { capacityVerified: false } });
  });
  it.each([
    ["two units", (h: string) => h.replace("<option selected>1</option><option>2", "<option>1</option><option selected>2")],
    ["unselected units", (h: string) => h.replace("<option selected>1", "<option>1")],
    ["duplicate units", (h: string) => h.replace("<option>2</option>", "<option>1</option>")],
    ["two selectors", (h: string) => h.replace("</body>", '<select id="select_units_to_book"></select></body>')],
    ["missing units control", (h: string) => h.replace('id="select_units_to_book"', 'id="unrelated"')],
    ["label mismatch", (h: string) => h.replace("Number of Suites", "Number of Golfers")],
    ["foreign handler", (h: string) => h.replace("unitsToBookChanged();", "book();")],
    ["private units", (h: string) => h.replace('id="units_to_book_size_section"', 'id="units_to_book_size_section" class="private"')],
    ["hidden units", (h: string) => h.replace('id="units_to_book_size_section"', 'id="units_to_book_size_section" hidden')],
    ["lesson", (h: string) => h.replaceAll("Suite Rental", "Suite Rental Lesson")],
    ["package", (h: string) => h.replaceAll("Suite Rental", "Suite Rental Package")],
    ["wrong duration label", (h: string) => h.replace("Choose Time", "Choose Lesson Time")],
    ["mixed pool", (h: string) => h.replace("</body>", '<select class="resSelect"></select></body>')],
    ["unaccounted extras", (h: string) => h.replace("<text>1</text>", "<text>2</text>")],
    ["disabled slot", (h: string) => h.replace("col timeslot selected", "col timeslot selected disabled")],
    ["wrong date", (h: string) => h.replace(wall(date, 11), wall("2030-10-24", 11))],
    ["conflicting limits", (h: string) => h.replace("</ul>", "<li>A maximum of 2 people per suite.</li></ul>")],
    ["malformed limit", (h: string) => h.replace("maximum of 8", "maximum of many")],
    ["unverified restrictive wording", (h: string) => h.replace("A maximum of 8 people can compete on simulators at one time (additional space for guests at suite bars and main bar).", "Only 1 player per suite.")],
  ] as const)("rejects %s instead of claiming complete inventory", async (_name, mutate) => {
    await expect(run(reader(mutate))).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_SOURCE|SCHEMA_CHANGED/u) });
  });
  it.each(["date", "duration"])("requires actual %s readback", async ignore => {
    await expect(run(reader(undefined, ignore), ignore === "duration" ? 120 : 60)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_SOURCE|SCHEMA_CHANGED/u) });
  });
});
