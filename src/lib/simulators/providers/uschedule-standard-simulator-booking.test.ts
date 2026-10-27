import { describe, expect, it, vi } from "vitest";
import { createUSchedulePublicReadPolicy, hasUScheduleStandardSimulatorBookingWitness,
  isUSchedulePublicRentalLabel, readUSchedulePublicPeopleControl } from "@/lib/automation/uschedule-public-read-policy";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { fetchUScheduleRecipeAvailability, inspectUScheduleRecipeConfiguration } from "./uschedule";

const source = "https://clients.uschedule.com/publicstudio/booking";
const note = "Rates are per hour per simulator and NOT per person. Plan for 1 hour per person to play a full 18 hole round.";
const priceHeading = `<h3><span>${note}</span></h3>`;
const day = "2030-10-23";
const wall = (date: string, hour: number) => `${date.slice(5, 7)}${date.slice(8)}${date.slice(0, 4)}${hour}00`;
function expandedPublicGrid(date: string) {
  const rows = Array.from({ length: 41 }, (_, index) => {
    const minutes = 11 * 60 + index * 15, hour = Math.floor(minutes / 60), minute = minutes % 60;
    const encoded = `${date.slice(5, 7)}${date.slice(8)}${date.slice(0, 4)}${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
    const extra = index >= 12, selected = index === 25;
    return `<div class="col timeslot ${selected ? "selected " : ""}${extra ? "extra " : ""}" data-time="${encoded}"><span>${hour % 12 || 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}</span></div>`;
  }).join("");
  return `<div class="row row-cols-3 time_choices">${rows}
    <div id="show-extra-row" class="w-100" style="display:none;"><span class="no_time">Show Additional Times (<text>29</text> more)</span></div>
    <div id="hide-extra-row" class="w-100"><span class="no_time">Hide Additional Times</span></div></div>`;
}
function document(date = day, people = 1, duration = 30, expanded = false) {
  const grid = expanded ? expandedPublicGrid(date) : `<div class="row time_choices"><div class="col timeslot selected" data-time="${wall(date, 10)}"><span>10:00 AM</span></div></div>`;
  return `<body class="publicstudio"><div class="main pt-3"><div class="container location-2641"><div class="row">
    <div class="col-lg-4 order-1"><div id="service_section"><div class="select-container"><select id="select_service"><option value="27567" selected>Simulator Booking</option>
    <option value="27568">VIP SimBooking</option><option value="27569">Sim #4 Booking NO LH</option><option value="27570">Private Lessons</option></select>
    </div></div><select id="select_service_type"><option value="0" selected>All Services</option><option value="41">Simulator Reservation</option><option value="42">Private Lessons</option></select>
    <label for="select_length">${expanded ? "Choose Service Time" : "Choose Time"}</label><select id="select_length"><option value="30" ${duration === 30 ? "selected" : ""}>30 minutes</option><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option></select>
    <div id="group_size_section"><label for="select_group_size">Choose Party Size (doesn't affect pricing)</label><select id="select_group_size" onchange="groupSizeChanged();">
    ${Array.from({ length: 6 }, (_, i) => `<option ${people === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select></div>
    <div id="serv_desc_section">Play a round, Practice or Take a Lesson on our X-Golf Simulator!</div>
    <div class="card my-3"><div class="card-body pt-3 pb-2"><h3><span>${note}</span></h3></div></div></div>
    <div class="col-lg-4 order-3 order-lg-2">
    <ul><li class="selected" onclick="return saveBookingDetail('single_date');">Date Chosen</li><li onclick="return saveBookingDetail('next_avail');">Next Available</li></ul>
    <div class="choices pt-2">${grid}</div>
    </div></div></div></div><script>var chosenDate = new Date(${date.slice(0, 4)}, ${Number(date.slice(5, 7)) - 1}, ${Number(date.slice(8))});</script></body>`;
}
const headers = new Headers({ "content-type": "application/json", origin: new URL(source).origin, referer: source });
describe("selected standard public simulator booking", () => {
  it("requires exact selected service, hourly per-simulator pricing, and valid current party control", () => {
    const html = document();
    expect(inspectUScheduleRecipeConfiguration(html, source)?.selected).toMatchObject({ serviceId: "27567", serviceName: "Simulator Booking" });
    expect(readUSchedulePublicPeopleControl(html)).toMatchObject({ valid: true, datedGridEligible: true, selectedPeople: 1 });
    expect(hasUScheduleStandardSimulatorBookingWitness(html)).toBe(true);
    const policy = createUSchedulePublicReadPolicy({ requestedPlayers: 2 });
    expect(policy.observeResponse(source, "GET", 200, "text/html", html)).toBe(true);
    for (const [id, allowed] of [["27567", true], ["27568", false], ["27569", false], ["27570", false]] as const)
      expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "service_id", Value: id }]))).toBe(allowed);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "group_size", Value: "2" }]))).toBe(true);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "group_size", Value: "6" }]))).toBe(false);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "service_type_id", Value: "0" }]))).toBe(true);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "service_type_id", Value: "42" }]))).toBe(false);
    for (const label of ["VIP Simulator Booking", "Member Simulator Booking", "Simulator Booking Lesson", "Sim #4 Booking NO LH"])
      expect(isUSchedulePublicRentalLabel(label)).toBe(false);
  });
  it.each([
    ["missing pricing", (h: string) => h.replace(note, "Rates vary.")],
    ["per-person pricing", (h: string) => h.replace(note, "Rates are per person per hour.")],
    ["conflicting pricing", (h: string) => h.replace(priceHeading, `${priceHeading}<h3>Rates are per person.</h3>`) ],
    ["hidden pricing", (h: string) => h.replace(priceHeading, `<h3 hidden><span>${note}</span></h3>`) ],
    ["hidden price fragment", (h: string) => h.replace(priceHeading, `<h3><span hidden>${note}</span></h3>`) ],
    ["missing shared container", (h: string) => h.replace('class="container location-2641"', 'class="location-2641"')],
    ["control in pricing card", (h: string) => h.replace(priceHeading, `${priceHeading}<button>Reserve</button>`) ],
    ["duplicate pricing card", (h: string) => h.replace(priceHeading, `${priceHeading}${priceHeading}`) ],
    ["wrong service", (h: string) => h.replace("Simulator Booking</option>", "VIP Simulator Booking</option>")],
    ["duplicate selection", (h: string) => h.replace('value="27568"', 'value="27568" selected')],
    ["duplicate service id", (h: string) => h.replace('value="27568"', 'value="27567"')],
    ["standard service not selected", (h: string) => h.replace('value="27567" selected', 'value="27567"').replace('value="27568"', 'value="27568" selected')],
    ["wrong party role", (h: string) => h.replace("Choose Party Size (doesn't affect pricing)", "Choose Party Size")],
    ["hidden party", (h: string) => h.replace('id="group_size_section"', 'id="group_size_section" hidden')],
  ] as const)("denies %s", (_name, mutate) => {
    const changed = mutate(document());
    expect(inspectUScheduleRecipeConfiguration(changed, source)).toBeUndefined();
    const policy = createUSchedulePublicReadPolicy({ requestedPlayers: 2 });
    policy.observeResponse(source, "GET", 200, "text/html", changed);
    expect(policy.allows(new URL(`${source}/changefield`), headers, JSON.stringify([{ Name: "service_id", Value: "27567" }]))).toBe(false);
  });
  it("rechecks the published service and pricing after each public filter before a complete read", async () => {
    let selectedDate = "2030-10-20", people = 2, duration = 30, first = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const [{ Name, Value }] = JSON.parse(String(init.body));
        if (Name === "length") duration = Number(Value);
        if (Name === "group_size") people = Number(Value);
        if (Name === "start_date") selectedDate = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
        return Response.json({ code: "refresh" });
      }
      const response = new Response(document(selectedDate, people, duration, true), { headers: { "content-type": "text/html", ...(first ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}) } });
      first = false; return response;
    });
    const session = createUSchedulePublicSession(source, { fetch, requestedPlayers: 3, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    try {
      const result = await fetchUScheduleRecipeAvailability({ date: day, durationMinutes: 60, partySize: 1, requestedPlayers: 3, timeZone: "America/New_York",
        offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC",
          providerMetadata: { tenant: "publicstudio", serviceId: "27567" }, maxPartySize: null, supportedDurationsMinutes: [60] } },
      { serviceId: "27567", serviceName: "Simulator Booking" }, session.read);
      expect(result.complete).toBe(true); expect(result.slots).toHaveLength(41);
      expect(result.slots[0]?.startsAt).toEqual(new Date("2030-10-23T15:00:00.000Z"));
      expect(result.slots[40]?.startsAt).toEqual(new Date("2030-10-24T01:00:00.000Z"));
      expect(result.slots.every(slot => slot.maxPartySize === null)).toBe(true);
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body))[0].Name)).toEqual(["length", "group_size", "start_date"]);
    } finally { session.dispose(); }
  });
  it.each([
    ["wrong duration label", (h: string) => h.replace("Choose Service Time", "Choose Reservation Time")],
    ["missing pricing witness", (h: string) => h.replace(note, "Rates vary.")],
    ["other selected service", (h: string) => h.replace("Simulator Booking</option>", "Private Lesson</option>")],
    ["wrong expanded count", (h: string) => h.replace("<text>29</text> more", "<text>28</text> more")],
    ["unaccounted expanded row", (h: string) => h.replace('class="col timeslot extra "', 'class="col timeslot "')],
    ["hidden expanded toggle", (h: string) => h.replace('id="hide-extra-row" class="w-100"', 'id="hide-extra-row" class="w-100" hidden')],
  ] as const)("rejects %s in the expanded public grid", async (_name, mutate) => {
    const html = mutate(document(day, 2, 60, true));
    let first = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ code: "refresh" });
      const response = new Response(html, { headers: { "content-type": "text/html", ...(first ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}) } });
      first = false;
      return response;
    });
    const session = createUSchedulePublicSession(source, { fetch, requestedPlayers: 2,
      requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    try {
      await expect(fetchUScheduleRecipeAvailability({ date: day, durationMinutes: 60, partySize: 1, requestedPlayers: 2, timeZone: "America/New_York",
        offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC",
          providerMetadata: { tenant: "publicstudio", serviceId: "27567" }, maxPartySize: null, supportedDurationsMinutes: [60] } },
      { serviceId: "27567", serviceName: "Simulator Booking" }, session.read)).rejects.toBeDefined();
      if (["wrong duration label", "wrong expanded count", "unaccounted expanded row", "hidden expanded toggle"].includes(_name)) {
        expect(fetch.mock.calls.filter(([, init]) => init?.method !== "POST")).toHaveLength(4);
        expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body))[0].Name))
          .toEqual(["length", "group_size", "start_date"]);
      }
    } finally { session.dispose(); }
  });
  it("rejects a changed pricing witness on warm read before any date filter", async () => {
    let gets = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "POST") return Response.json({ code: "refresh" });
      gets++;
      return new Response(gets === 1 ? document() : document().replace(note, "Rates vary."), { headers: {
        "content-type": "text/html", ...(gets === 1 ? { "set-cookie": "ASP.NET_SessionId=OwnedFixture12345; HttpOnly" } : {}),
      } });
    });
    const session = createUSchedulePublicSession(source, { fetch, requestedPlayers: 2, requestLease: async (_family, work) => ({ acquired: true as const, value: await work() }) });
    try {
      await expect(fetchUScheduleRecipeAvailability({ date: day, durationMinutes: 60, partySize: 1, requestedPlayers: 2, timeZone: "America/New_York",
        offering: { id: "offering", courseId: "course", bookingUrl: source, providerFamilyKey: "USCHEDULE", active: true, publicAccessStatus: "PUBLIC",
          providerMetadata: { tenant: "publicstudio", serviceId: "27567" }, maxPartySize: null, supportedDurationsMinutes: [60] } },
      { serviceId: "27567", serviceName: "Simulator Booking" }, session.read)).rejects.toBeDefined();
      expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body))[0].Name)).toEqual(["length"]);
    } finally { session.dispose(); }
  });
});
