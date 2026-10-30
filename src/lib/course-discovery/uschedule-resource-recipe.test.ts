import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { readUSchedulePublicResourcePool } from "@/lib/simulators/providers/uschedule-public-resources";
import { createUSchedulePublicReadPolicy } from "@/lib/automation/uschedule-public-read-policy";

const source = "https://clients.uschedule.com/examplegolf/booking";
const input = { date: "2030-10-20", players: 2, timeZone: "America/New_York", startTime: "09:00", endTime: "18:00", durationMinutes: 60 };
const deps = { now: () => new Date("2030-10-19T12:00:00Z"), requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
function html(resource = "7", date = input.date, duration = 60) {
  const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
  const key = (d: string) => `${d.slice(5, 7)}${d.slice(8)}${d.slice(0, 4)}1000`;
  const values = [key(date), key(next.toISOString().slice(0, 10))];
  return `<body class="examplegolf"><select id="select_service"><option value="72" selected>Simulator Rental</option><option value="73">Punch Card Simulator Rental</option></select>
    <select id="select_length"><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option><option value="120" ${duration === 120 ? "selected" : ""}>2 hours</option></select>
    <section id="res_section"><label for="resource5">Simulators</label><select id="resource5" class="resSelect"><option value="7" ${resource === "7" ? "selected" : ""}>Simulator Bay Public</option><option value="8" ${resource === "8" ? "selected" : ""}>Simulator Bay Private</option></select></section>
    ${values.map(value => `<div class="next_avail_results"><div class="next_avail_item" data-time="${value}" data-empid="0"><strong>Simulator Rental</strong></div></div>`).join("")}
    <script>var chosenDate=new Date(${Number(date.slice(0, 4))},${Number(date.slice(5, 7)) - 1},${Number(date.slice(8))});var lastAvailTime='${values.at(-1)}';</script></body>`;
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
  source: { officialUrl: "https://official.example/", bookingUrl: source, venueName: "Example Golf", timeZone: input.timeZone, providerFamily: "USCHEDULE" },
  adapter: { family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", serviceName: "Simulator Rental", publicResourcePoolProof: readUSchedulePublicResourcePool(html())!.proof } });
function transport(options: { ignoreResource?: boolean; changeResourceLabel?: boolean; emptyPrivate?: boolean; wrongEmptyDate?: boolean } = {}) {
  const states = new Map<string, { resource: string; date: string; duration: number }>();
  let currentKey: string | undefined, afterFilter = false;
  const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    // Cookie injection occurs below the credential-free transport in real HTTPS.
    // A GET following a completed listing starts the next anonymous session;
    // every in-session reload is preceded by a public changefield response.
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    const first = init?.method !== "POST" && !afterFilter;
    if (first) { currentKey = `ASP.NET_SessionId=AnonymousScope${states.size + 1}`; states.set(currentKey, { resource: "7", date: input.date, duration: 60 }); }
    const key = currentKey!, state = states.get(key); if (!state) throw Error("UNKNOWN_ANONYMOUS_SESSION");
    if (init?.method === "POST") {
      afterFilter = true;
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "length") state.duration = Number(Value);
      if (Name === "start_date") state.date = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
      if (Name === "resource" && !options.ignoreResource) state.resource = Value.split("~")[1];
      return Response.json({ code: "refresh" });
    }
    afterFilter = false;
    let body = html(state.resource, state.date, state.duration);
    if (options.emptyPrivate && state.resource === "8") {
      body = body.replace(/<div class="next_avail_results">.*?<\/div><\/div>/gu, "")
        .replace('</body>', '<div class="choices no_times_avail"><p>Sorry, there are no times available for the selected criteria.</p></div></body>');
      if (options.wrongEmptyDate) body = body.replace('var chosenDate=new Date(2030,9,20)', 'var chosenDate=new Date(2030,9,21)');
    }
    return new Response(options.changeResourceLabel && state.resource === "8" ? body.replace("Simulator Bay Private", "Changed Resource") : body,
      { status: 200, headers: { "content-type": "text/html", ...(first ? { "set-cookie": `${key}; Path=/; HttpOnly` } : {}) } });
  });
  return { fetch, states };
}
describe("complete public simulator resource recipes", () => {
  it("learns the bounded public catalog and replays every resource in a separate anonymous session", async () => {
    const learned = await inspectExistingAdapter(recipe().source, { ...deps, fetch: transport().fetch, venueMatches: () => true });
    expect(learned.adapter).toMatchObject({ family: "USCHEDULE", publicResourcePoolProof: readUSchedulePublicResourcePool(html())!.proof });
    const t = transport(), result = await executeAccessRecipe(parseAccessRecipe({ ...recipe(), adapter: learned.adapter }), input, { ...deps, fetch: t.fetch });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, durationVerified: true, completeVerified: true } });
    expect(t.states.size).toBe(2); expect(result.slots).toHaveLength(2);
    expect(new Set(result.slots.map(slot => slot.resourceId)).size).toBe(2); expect(new Set(result.slots.map(slot => slot.sourceId)).size).toBe(2);
    expect(t.fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body))[0].Name)).not.toContain("time");
  });
  it.each([{ ignoreResource: true }, { changeResourceLabel: true }])("never publishes partial results when a later resource fails", async options => {
    const result = await executeAccessRecipe(recipe(), input, { ...deps, fetch: transport(options).fetch });
    expect(result.status).toBe("INCOMPLETE"); expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
  });
  it("includes a resource with a fresh explicit dated empty result in the complete check", async () => {
    const result = await executeAccessRecipe(recipe(), input, { ...deps, fetch: transport({ emptyPrivate: true }).fetch });
    expect(result, JSON.stringify(result)).toMatchObject({ status: "AVAILABLE", complete: true });
    expect(result.slots).toHaveLength(1); expect(result.slots[0].resourceId).toBe("uschedule-resource-group:5:resource:7");
    const wrong = await executeAccessRecipe(recipe(), input, { ...deps, fetch: transport({ emptyPrivate: true, wrongEmptyDate: true }).fetch });
    expect(wrong).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
  });
  it("permits only fresh observed group/resource filter pairs, never transaction fields", () => {
    const policy = createUSchedulePublicReadPolicy(), url = new URL(source + "/changefield"), headers = new Headers({ "content-type": "application/json", origin: new URL(source).origin, referer: source });
    expect(policy.observeResponse(source, "GET", 200, "text/html", html())).toBe(true);
    const allows = (Name: string, Value: string) => policy.allows(url, headers, JSON.stringify([{ Name, Value }]));
    expect(allows("resource", "5~7")).toBe(true); expect(allows("resource", "5~8")).toBe(true);
    for (const value of ["6~7", "5~99", "5~-1", "5~7,8", "5~7~8"]) expect(allows("resource", value)).toBe(false);
    for (const name of ["time", "payment", "addon", "book", "customer"]) expect(allows(name, "5~7")).toBe(false);
    policy.observeResponse(source, "GET", 200, "text/html", html().replace("Simulator Bay Private", "Members Only Bay"));
    expect(allows("resource", "5~8")).toBe(false);
  });
});
