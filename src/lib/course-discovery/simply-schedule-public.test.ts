// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
vi.mock("./simply-schedule-public", async original => ({ ...(await original<typeof import("./simply-schedule-public")>()),
  SSA_PUBLIC_CLIENT_SHA256: (await import("node:crypto")).createHash("sha256").update("reviewed synthetic SSA client").digest("hex") }));
import { inspectSimplySchedule, executeSimplySchedule } from "./simply-schedule-executor";
import { parseSimplyScheduleBootstrap, parseSimplyScheduleSlots, simplyScheduleFrame, verifySimplyScheduleOfficial, SSA_PUBLIC_CLIENT_SHA256 } from "./simply-schedule-public";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { inspectExistingAdapter } from "./existing-adapter-executor";

const source = { officialUrl: "https://rental.example/", bookingUrl: "https://rental.example/book/", venueName: "Example Golf Studio",
  venueAddress: "123 Main Street, Example, CT 06001, USA", timeZone: "America/New_York" };
const input = { date: "2030-01-02", startTime: "09:00", endTime: "18:00", players: 2, durationMinutes: 60, timeZone: source.timeZone };
const service = { id: "1", slug: "public-simulator", title: "Multi-Sport Simulators - 1 hr", status: "publish", duration: "60",
  capacity_type: "individual", has_max_capacity: "0", resource_capacity: "1", timezone_style: "localized",
  resources_settings: [{ resource_group_id: 1, assigned_resource_id: 0, resource_option: "any" }],
  resources_objects: [{ id: "1", title: "Multi-Sport Simulator", resource_type: "identical" }] };
function fixture() {
  const frame = new URL("/wp-json/ssa/v1/embed-inner", source.bookingUrl);
  frame.searchParams.set("types", "public-simulator"); frame.searchParams.set("booking_url", source.bookingUrl);
  frame.searchParams.set("_wpnonce", "ephemeral-document-value"); frame.searchParams.set("sid", "ephemeral-page-session");
  const parent = `<main><h1>Public golf simulator rentals</h1><iframe name="ssa_booking" src="${frame.href}#/"></iframe></main>`;
  const root = `<main><h1>${source.venueName}</h1><a href="/book/">Rent a bay</a></main><footer><p>123 Main Street, Example, CT 06001</p></footer>`;
  const values: Record<string, unknown> = { ssa: { api: { root: "https://rental.example/wp-json/ssa/v1", public_nonce: "publicNonce123" },
    user: { user_id: 0, staff_id: 0, capabilities: [] } }, ssa_settings: { global: { timezone_string: "US/Eastern", company_name: source.venueName } },
    ssa_appointment_types: [structuredClone(service)], ssa_translations: {}, ssa_customer_information_defaults: {},
    ssa_booking_url_settings: { booking_url: source.bookingUrl }, ssa_token: "", ssa_embed_settings: {}, ssa_availability_edge_cache_timestamp: "not-availability-proof",
    ssa_availability_edge_cache: false, ssa_availability_query_args: {}, ssa_defer_init: false, ssa_hide_header: false };
  const html = () => `<html><body><script>${Object.entries(values).map(([key, value]) => `var ${key} = ${key === "ssa_token" && value === "" ? "''" : JSON.stringify(value)};`).join("\n")}</script>
    <script src="/wp-content/plugins/simply-schedule-appointments/booking-app-new/dist/static/js/app.js?ver=4.6.12.37"></script></body></html>`;
  const slots = { response_code: 200, error: "", message: "", booking_token: "discard-this-ephemeral-value",
    data: ["14:00", "17:00", "22:00", "22:15"].map(time => ({ start_date: "2030-01-02 " + time + ":00" })) };
  let active = 0, maxActive = 0, cancelAfter: number | undefined;
  const requests: Array<{ url: string; method: string; nonce: string | null }> = [], abort = new AbortController();
  const deps = { now: () => new Date("2030-01-01T00:00:00Z"), signal: abort.signal,
    requestLease: async <T>(family: string, work: () => Promise<T>) => { expect(family).toBe("simply_schedule_appointments");
      active++; maxActive = Math.max(maxActive, active); try { return { acquired: true as const, value: await work() }; } finally { active--; } },
    fetch: (async (url, init) => {
      expect(active).toBe(1); expect(init?.credentials).toBe("omit"); expect(init?.redirect).toBe("manual");
      const u = new URL(String(url)), headers = new Headers(init?.headers);
      expect(headers.has("cookie")).toBe(false); expect(headers.has("authorization")).toBe(false); expect(headers.has("X-WP-Nonce")).toBe(false);
      requests.push({ url: u.href, method: init?.method ?? "GET", nonce: headers.get("X-PUBLIC-Nonce") });
      let body: string, type = "text/html";
      if (u.href === source.officialUrl) body = root;
      else if (u.href === source.bookingUrl) body = parent;
      else if (u.href === frame.href) body = html();
      else if (u.pathname.endsWith("/static/js/app.js")) { body = "reviewed synthetic SSA client"; type = "application/javascript"; }
      else if (u.pathname === "/wp-json/ssa/v1/appointment_types/1/availability") {
        expect(u.searchParams.get("start_date_min")).toBe("2030-01-01"); expect(u.searchParams.get("start_date_max")).toBe("2030-01-04");
        expect(u.searchParams.get("query_args[resources_required][0][resource_quantity]")).toBe("1");
        expect(u.searchParams.get("query_args[resources_required][0][resource_id]")).toBe("0");
        expect(headers.get("X-PUBLIC-Nonce")).toBe("publicNonce123"); body = JSON.stringify(slots); type = "application/json";
      } else throw Error("UNEXPECTED_REQUEST");
      if (cancelAfter === requests.length) abort.abort(Error("test cancellation"));
      const response = new Response(body, { headers: { "content-type": type } }), read = response.text.bind(response);
      response.text = async () => { expect(active).toBe(1); return read(); }; return response;
    }) as typeof fetch };
  return { frame: frame.href, parent, root, values, html, slots, deps, requests, maxActive: () => maxActive, abort,
    cancelAfter: (count: number) => { cancelAfter = count; } };
}
describe("public Simply Schedule Appointments rental reader", () => {
  it("learns through the real adapter inspector when the canonical www root links to the bare-host booking parent", async () => {
    const f = fixture(), aliased = { ...source, officialUrl: "https://www.rental.example/" };
    const fetch: typeof globalThis.fetch = async (url, init) => String(url) === aliased.officialUrl
      ? new Response(f.root.replace('href="/book/"', `href="${source.bookingUrl}"`), { headers: { "content-type": "text/html" } })
      : f.deps.fetch(url, init);
    const result = await inspectExistingAdapter(aliased, { ...f.deps, fetch, requestedInput: input });
    expect(result.adapter.family).toBe("SIMPLY_SCHEDULE_APPOINTMENTS");
    expect(parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source: { ...aliased, providerFamily: result.adapter.family },
      target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" }, adapter: result.adapter }).source.officialUrl).toBe(aliased.officialUrl);
    await expect(inspectExistingAdapter({ ...aliased, officialUrl: "https://foreign.example/" },
      { ...f.deps, fetch, requestedInput: input })).rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
  });
  it("executes through the real recipe pipeline and rejects a different target or booking source", async () => {
    const f = fixture(), adapter = await inspectSimplySchedule(source, 60, f.deps);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" },
      source: { ...source, providerFamily: "SIMPLY_SCHEDULE_APPOINTMENTS" }, adapter });
    const result = await executeAccessRecipe(recipe, input, f.deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(3);
    for (const changed of [{ ...recipe, target: { kind: "OUTDOOR", courseId: "course" } },
      { ...recipe, source: { ...recipe.source, bookingUrl: "https://rental.example/wrong-room/" } },
      { ...recipe, source: { ...recipe.source, officialUrl: "https://foreign.example/" } }]) expect(() => parseAccessRecipe(changed)).toThrow();
  });
  it("replays a serialized method with fresh public GETs, one complete bay, and no appointment/session material saved", async () => {
    const f = fixture(), metadata = await inspectSimplySchedule(source, 60, f.deps);
    expect(metadata?.family).toBe("SIMPLY_SCHEDULE_APPOINTMENTS");
    expect(JSON.stringify(metadata)).not.toMatch(/nonce|sid|token|ephemeral/iu);
    const saved = JSON.parse(JSON.stringify(metadata)), slots = await executeSimplySchedule(source, saved, input, f.deps);
    expect(slots).toHaveLength(3); expect(slots[0]).toMatchObject({ startsAt: "2030-01-02T14:00:00.000Z", endsAt: "2030-01-02T15:00:00.000Z", capacity: null, availableSpots: 1 });
    expect(f.requests).toHaveLength(9); expect(f.requests.every(r => r.method === "GET" && !r.url.includes("/async"))).toBe(true);
    expect(f.requests.filter(r => r.nonce !== null)).toHaveLength(1); expect(f.maxActive()).toBe(1);
  });
  it.each(["identity", "address", "entry", "hidden"])("requires current complete official %s", kind => {
    const f = fixture(); let root = f.root;
    if (kind === "identity") root = root.replace(source.venueName, "Unrelated Golf Studio");
    if (kind === "address") root = root.replace("123 Main Street", "999 Main Street");
    if (kind === "entry") root = root.replace('href="/book/"', 'href="/unrelated/"');
    if (kind === "hidden") root = root.replace("<footer>", '<footer hidden>');
    expect(() => verifySimplyScheduleOfficial(root, source)).toThrow();
  });
  it.each(["cross-origin", "edit", "membership", "duplicate"])("rejects %s frames before any plugin request", kind => {
    const f = fixture(); let html = f.parent;
    if (kind === "cross-origin") html = html.replace("src=\"https://rental.example", "src=\"https://unrelated.example");
    if (kind === "edit") html = html.replace("#\/", "&edit=existing-appointment#/");
    if (kind === "membership") html = html.replace("#\/", "&mepr_membership_id=1#/");
    if (kind === "duplicate") html += f.parent;
    expect(() => simplyScheduleFrame(html, source.bookingUrl)).toThrow();
  });
  it.each(["account", "capabilities", "staff", "timezone", "company", "appointment", "duration", "resource", "party", "duplicate", "draft", "client", "script"])
    ("fails closed on %s changes", async kind => {
      const f = fixture(), values = f.values, ssa = values.ssa as { user: { user_id: number; staff_id: number } }, type = (values.ssa_appointment_types as typeof service[])[0];
      if (kind === "account") ssa.user.user_id = 7;
      if (kind === "capabilities") (ssa.user as unknown as { capabilities: string[] }).capabilities = ["manage_options"];
      if (kind === "staff") ssa.user.staff_id = 3;
      if (kind === "timezone") (values.ssa_settings as { global: { timezone_string: string } }).global.timezone_string = "America/Chicago";
      if (kind === "company") (values.ssa_settings as { global: { company_name: string } }).global.company_name = "Wrong Venue";
      if (kind === "appointment") values.ssa_token = "existing-appointment-token";
      if (kind === "duration") type.duration = "30";
      if (kind === "resource") type.resources_settings[0].assigned_resource_id = 2;
      if (kind === "party") type.title = "Simulator Watch Party - 1 hr";
      if (kind === "duplicate") (values.ssa_appointment_types as typeof service[]).push({ ...type, id: "2" });
      if (kind === "draft") type.status = "draft";
      let html = f.html(); if (kind === "client") html = html.replace("4.6.12.37", "4.6.99.0");
      if (kind === "script") html = html.replace("var ssa_token = '';", "var ssa_token = getSecret();");
      expect(() => parseSimplyScheduleBootstrap(html, f.frame, source, 60)).toThrow();
    });
  it("does not fetch JSON when the saved catalog changes, and cancels inside its owned body lease", async () => {
    const f = fixture(), metadata = await inspectSimplySchedule(source, 60, f.deps);
    const changed = { ...metadata!, catalogSha256: "a".repeat(64) };
    await expect(executeSimplySchedule(source, changed, input, f.deps)).rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(f.requests.some(r => r.url.includes("/availability?"))).toBe(false);
    const cancelled = fixture(); cancelled.cancelAfter(2);
    await expect(inspectSimplySchedule(source, 60, cancelled.deps)).rejects.toThrow("test cancellation"); expect(cancelled.requests).toHaveLength(2);
  });
  it.each(["unsorted", "duplicate", "invalid-date", "missing-data", "error", "partial"])("does not turn %s evidence into availability", async kind => {
    const f = fixture(), metadata = (await inspectSimplySchedule(source, 60, f.deps))!;
    if (kind === "unsorted") f.slots.data.reverse();
    if (kind === "duplicate") f.slots.data.push(f.slots.data[0]);
    if (kind === "invalid-date") f.slots.data[0].start_date = "2030-02-30 14:00:00";
    if (kind === "missing-data") delete (f.slots as { data?: unknown }).data;
    if (kind === "error") f.slots.error = "The public calendar is unavailable";
    if (kind === "partial") f.slots.data = [{ start_date: "2030-01-02 22:15:00" }];
    if (kind === "partial") expect(parseSimplyScheduleSlots(f.slots, metadata, input, f.deps.now())).toEqual([]);
    else expect(() => parseSimplyScheduleSlots(f.slots, metadata, input, f.deps.now())).toThrow("SSA_AVAILABILITY_UNVERIFIED");
  });
  it("rejects unsupported exact duration and saved session material", async () => {
    const f = fixture(), metadata = (await inspectSimplySchedule(source, 60, f.deps))!;
    await expect(executeSimplySchedule(source, metadata, { ...input, durationMinutes: 55 }, f.deps)).rejects.toThrow();
    await expect(executeSimplySchedule(source, { ...metadata, public_nonce: "never-saved" } as never, input, f.deps)).rejects.toThrow();
    expect(SSA_PUBLIC_CLIENT_SHA256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
