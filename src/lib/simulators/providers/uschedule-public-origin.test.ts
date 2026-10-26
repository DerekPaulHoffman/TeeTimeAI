import { describe, expect, it, vi } from "vitest";
import { isUSchedulePublicHost, uschedulePublicTenant, knownSimulatorPublicConfigurationFamily } from "./public-configuration";
import { parseUScheduleLocationSource } from "./uschedule-location-source";
import { inspectUScheduleRecipeConfiguration } from "./uschedule";
import { createUSchedulePublicReadPolicy } from "@/lib/automation/uschedule-public-read-policy";
import { createUSchedulePublicSession } from "@/lib/automation/uschedule-public-session";
import { isAnonymousBrowserReadPost } from "@/lib/automation/simulator-interactive-browser";
import { executeAccessRecipe } from "@/lib/course-discovery/executor";
import { parseAccessRecipe, hashAccessRecipe } from "@/lib/course-discovery/recipe";

const hosts = ["clients.uschedule.com", "iframe.uschedule.com"];
const cookie = "ASP.NET_SessionId=AnonymousTest123";
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
const controls = (durations = [60, 120], selected = 60) => `<body class="examplegolf"><select id="select_service"><option value="72" selected>Hourly Simulator Rental</option></select>
 <select id="select_length">${durations.map(v => `<option value="${v}" ${v === selected ? "selected" : ""}>${v} minutes</option>`).join("")}</select>
 <select id="select_group_size"><option value="1" selected>1</option><option value="4">4</option></select><select class="resSelect"><option value="-1" selected>Any Available</option></select>`;
const payload = (Name: string, Value: string) => JSON.stringify([{ Name, Value }]);

describe("USchedule exact public origins", () => {
  it.each(hosts)("retains the exact %s source origin and canonical tenant", host => {
    const url = `https://${host}/examplegolf/booking`;
    expect(isUSchedulePublicHost(host)).toBe(true);expect(uschedulePublicTenant(url)).toBe("examplegolf");
    expect(knownSimulatorPublicConfigurationFamily(url)).toBe("USCHEDULE");expect(parseUScheduleLocationSource(url)?.canonicalUrl).toBe(url);
    expect(inspectUScheduleRecipeConfiguration(controls() + "</body>", url)?.tenant).toBe("examplegolf");
  });
  it.each(["https://other.uschedule.com/examplegolf/booking", "https://iframe.uschedule.com.evil.example/examplegolf/booking", "https://eviliframe.uschedule.com/examplegolf/booking",
    "http://iframe.uschedule.com/examplegolf/booking", "https://user:pass@iframe.uschedule.com/examplegolf/booking", "https://iframe.uschedule.com:444/examplegolf/booking",
    "https://iframe.uschedule.com/examplegolf/booking?filter=loc[1]", "https://iframe.uschedule.com/examplegolf/booking?date=2030-10-23", "https://iframe.uschedule.com/examplegolf/booking#x",
    "https://iframe.uschedule.com/examplegolf/cart", "https://iframe.uschedule.com/examplegolf/booking/changefield"])("rejects unearned or transactional source %s", url => {
    expect(uschedulePublicTenant(url)).toBeUndefined();expect(parseUScheduleLocationSource(url)).toBeUndefined();
    expect(inspectUScheduleRecipeConfiguration(controls(), url)).toBeUndefined();expect(() => createUSchedulePublicSession(url)).toThrow("INVALID_ADAPTER_SOURCE");
  });
  it("preserves the independently bound legacy clients location filter only", () => {
    expect(parseUScheduleLocationSource("https://clients.uschedule.com/examplegolf/booking?filter=loc[82]")?.locationId).toBe("82");
  });
  it.each(hosts)("bounds the observed %s duration catalog at twenty without changing values, selection or tenant", host => {
    const url = `https://${host}/examplegolf/booking`, values = Array.from({ length: 20 }, (_, i) => (i + 1) * 15);
    expect(inspectUScheduleRecipeConfiguration(controls(values), url)?.durations).toEqual(values);
    expect(inspectUScheduleRecipeConfiguration(controls([...values, 315]), url)).toBeUndefined();
    expect(inspectUScheduleRecipeConfiguration(controls([...values.slice(0, 19), 60]), url)).toBeUndefined();
    expect(inspectUScheduleRecipeConfiguration(controls(values).replace('class="examplegolf"', 'class="anothergolf"'), url)).toBeUndefined();
    expect(inspectUScheduleRecipeConfiguration(controls(values).replace("Hourly Simulator Rental", "Members Simulator Rental"), url)).toBeUndefined();
  });
  it.each(hosts)("earns %s read-only POST options only from its own successful document", host => {
    const url = `https://${host}/examplegolf/booking`, origin = new URL(url).origin, target = new URL(url + "/changefield"), policy = createUSchedulePublicReadPolicy();
    const h = () => new Headers({ "content-type": "application/json", origin, referer: url });
    expect(policy.allows(target, h(), payload("length", "60"))).toBe(false);expect(policy.observeResponse(url, "GET", 200, "text/html", controls())).toBe(true);
    for (const [key, value] of [["length", "60"], ["length", "120"], ["service_id", "72"], ["group_size", "1"], ["start_date", "10/23/2030"]])expect(policy.allows(target, h(), payload(key, value))).toBe(true);
    for (const [key, value] of [["length", "90"], ["service_id", "73"], ["group_size", "2"], ["group_size", "4"], ["time", "103020301000"], ["payment", "1"], ["start_date", "02/30/2030"]])expect(policy.allows(target, h(), payload(key, value))).toBe(false);
    const foreign = host === hosts[0] ? hosts[1] : hosts[0];
    for (const [key, value] of [["origin", `https://${foreign}`], ["referer", url.replace(host, foreign)], ["cookie", cookie], ["authorization", "Bearer PRIVATE"], ["next-action", "PRIVATE"]]) { const headers = h();headers.set(key, value);expect(policy.allows(target, headers, payload("length", "60"))).toBe(false); }
    expect(isAnonymousBrowserReadPost(target, h(), '{"query":"{ availability }"}')).toBe(false);
    expect(policy.addReadHeaders(target, "POST", { referer: url }, new Headers({ "content-type": "application/json", origin }), payload("payment", "1"))).toBe(false);
  });
  it.each(hosts)("isolates %s anonymous session and rejects cross-origin cookie or redirect reuse", async host => {
    const url = `https://${host}/examplegolf/booking`, other = url.replace(host, host === hosts[0] ? hosts[1] : hosts[0]);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(controls(), { headers: { "content-type": "text/html", "set-cookie": cookie + "; Secure" } })).mockResolvedValueOnce(Response.json({ code: "refresh" }));
    const session = createUSchedulePublicSession(url, { fetch, requestLease: lease });
    try { await session.read(url);const post = { method: "POST", headers: { "content-type": "application/json", origin: new URL(url).origin, referer: url, cookie }, body: payload("length", "60") };
      await session.read(url + "/changefield", post);expect(fetch.mock.calls.map(([u]) => String(u))).toEqual([url, url + "/changefield"]);expect(new Headers(fetch.mock.calls[1][1]?.headers).has("cookie")).toBe(false);
      await expect(session.read(other, { headers: { cookie } })).rejects.toThrow("UNSCOPED_ADAPTER_REQUEST");await expect(session.read(url, { headers: { cookie: "ASP.NET_SessionId=Foreign123" } })).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
    } finally { session.dispose(); }
    const redirected = createUSchedulePublicSession(url, { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: other } })), requestLease: lease });
    try { await expect(redirected.read(url)).rejects.toThrow("ADAPTER_TRANSPORT_FAILED"); } finally { redirected.dispose(); }
  });
  it.each(hosts)("executes immutable %s two-date/duration method with one bay and unknown golfer limit", async host => {
    const source = `https://${host}/examplegolf/booking`, recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
      source: { officialUrl: "https://examplegolf.example/", bookingUrl: source, venueName: "Example Golf", venueAddress: "100 Public Road, Denver, CO 80001, US", providerFamily: "USCHEDULE", timeZone: "America/Denver" }, adapter: { family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", serviceName: "Hourly Simulator Rental" } });
    const originalHash = hashAccessRecipe(recipe);
    for (const [date, duration] of [["2030-10-23", 60], ["2030-10-24", 120]] as const) {
      let length = 60, current = date, first = true, gets = 0;const bodies: string[] = [];
      const fetch = vi.fn<typeof globalThis.fetch>(async (u, init) => {expect(new URL(String(u)).origin).toBe(new URL(source).origin);
        if (init?.method === "POST") { const body = String(init.body);bodies.push(body);for (const f of JSON.parse(body)) {if (f.Name === "length") length = Number(f.Value);if (f.Name === "start_date") {const [m,d,y] = f.Value.split("/");current = `${y}-${m}-${d}`;}}return Response.json({ code: "refresh" }); }
        gets++;const next = new Date(current + "T12:00:00Z");next.setUTCDate(next.getUTCDate() + 1);const later = next.toISOString().slice(0, 10), key = (day: string) => day.slice(5,7) + day.slice(8) + day.slice(0,4) + "1000";
        const times = [key(current),key(later)], html = controls([60,120], length) + times.map(v => `<div class="next_avail_results"><div class="next_avail_item" data-time="${v}" data-empid="0">Hourly Simulator Rental</div></div>`).join("") + `<script>var chosenDate = new Date(${current.slice(0,4)},${Number(current.slice(5,7))-1},${Number(current.slice(8))});\nvar lastAvailTime = '${times[1]}';</script></body>`;
        const headers = { "content-type": "text/html", ...(first ? { "set-cookie": cookie + "; Secure" } : {}) };first = false;return new Response(html, { headers }); });
      const result = await executeAccessRecipe(recipe, { date, durationMinutes: duration, players: 2, timeZone: "America/Denver", startTime: "08:00", endTime: "18:00" }, { fetch, requestLease: lease, now: () => new Date("2030-10-20T12:00:00Z") });
      expect(result.status).toBe("AVAILABLE");expect(result.complete).toBe(true);expect(result.evidence).toMatchObject({ recipeHash: originalHash, venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true });
      expect(result.slots).toHaveLength(1);expect(result.slots[0].capacity).toBeNull();expect(result.slots[0].availableSpots).toBe(1);expect(Date.parse(result.slots[0].endsAt!) - Date.parse(result.slots[0].startsAt)).toBe(duration * 60000);
      expect(gets).toBeGreaterThan(1);expect(bodies.filter(v => v.includes("group_size")).every(v => JSON.parse(v)[0].Value === "1")).toBe(true);expect(hashAccessRecipe(recipe)).toBe(originalHash);
    }
  });
});
