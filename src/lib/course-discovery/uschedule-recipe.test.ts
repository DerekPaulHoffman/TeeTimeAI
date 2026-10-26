import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { inspectExistingAdapter } from "./existing-adapter-executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";
import { inspectUScheduleRecipeConfiguration } from "@/lib/simulators/providers/uschedule";

const source = "https://clients.uschedule.com/examplegolf/booking";
const cookie = "ASP.NET_SessionId=AnonymousOnly123";
const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: source, venueName: "Example Golf", timeZone: "America/New_York", providerFamily: "USCHEDULE" },
  adapter: { family: "USCHEDULE", tenant: "examplegolf", serviceId: "72", serviceName: "Hourly Simulator Rental" } });
function responses(options: { ignoreDate?: boolean; ignoreDuration?: boolean; changedService?: boolean; neverComplete?: boolean } = {}) {
  let date = "2030-10-20", duration = 60, page = 0, first = true;
  return async (_value: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === "POST") {
      const [{ Name, Value }] = JSON.parse(String(init.body));
      if (Name === "start_date" && !options.ignoreDate) date = `${Value.slice(6)}-${Value.slice(0, 2)}-${Value.slice(3, 5)}`;
      if (Name === "length" && !options.ignoreDuration) duration = Number(Value);
      if (Name === "more_next_avail") page++;
      return Response.json({ code: "refresh" });
    }
    const next = new Date(`${date}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    const nextDate = next.toISOString().slice(0, 10);
    const key = (day: string, hour: number) => `${day.slice(5, 7)}${day.slice(8)}${day.slice(0, 4)}${String(hour).padStart(2, "0")}00`;
    const values = page === 0 || options.neverComplete ? [key(date, 10 + page), key(date, 11 + page)] : [key(date, 12), key(nextDate, 10)];
    const body = `<body class="examplegolf"><select id="select_service"><option value="72" selected>${options.changedService ? "Golf Lessons" : "Hourly Simulator Rental"}</option></select>
      <select id="select_length"><option value="60" ${duration === 60 ? "selected" : ""}>1 hour</option><option value="120" ${duration === 120 ? "selected" : ""}>2 hours</option></select>
      <select id="select_group_size"><option selected>1</option></select><select class="resSelect"><option value="-1" selected>Any Available</option></select>
      ${values.map(value => `<div class="next_avail_results"><div class="next_avail_item" data-time="${value}" data-empid="0"><strong>Hourly Simulator Rental</strong></div></div>`).join("")}
      <a id="more_next_avail">Show more</a><script>var chosenDate = new Date(${Number(date.slice(0, 4))}, ${Number(date.slice(5, 7)) - 1}, ${Number(date.slice(8))});\nvar lastAvailTime = '${values.at(-1)}';</script></body>`;
    const headers = { "content-type": "text/html", ...(first ? { "set-cookie": `${cookie}; HttpOnly` } : {}) }; first = false;
    return new Response(body, { headers });
  };
}
const deps = { now: () => new Date("2030-10-19T12:00:00Z"), requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
// This legacy fixture proves one available bay, not multi-attendee capacity.
const input = { date: "2030-10-23", durationMinutes: 60, timeZone: "America/New_York", players: 1, startTime: "09:00", endTime: "18:00" };
describe("learned USchedule fixed public reader", () => {
  it.each([2, 3, 4])("rejects unproven %i-attendee use before any provider read", async players => {
    const fetch = vi.fn(responses());
    const result = await executeAccessRecipe(recipe, { ...input, players }, { ...deps, fetch });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: {
      reason: "USCHEDULE_PUBLIC_PARTY_UNVERIFIED", venueVerified: false, dateVerified: false, capacityVerified: false,
      durationVerified: false, completeVerified: false,
    } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("discovers selected rental metadata only from the matching public tenant", async () => {
    const inspected = await inspectExistingAdapter(recipe.source, { ...deps, fetch: responses(), venueMatches: () => true });
    expect(inspected.adapter).toEqual(recipe.adapter);
    expect(JSON.stringify(inspected)).not.toContain(cookie);
    await expect(inspectExistingAdapter({ ...recipe.source, venueName: "Different Golf" }, { ...deps, fetch: responses(), venueMatches: () => true })).rejects.toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["Simulator Rental Membership", "Members-only Simulator Rental", "Simulator Rental - members only", "Member Simulator Rental"])("rejects selected nonpublic rental even beside a public alternative: %s", label => {
    const html = `<body class="examplegolf"><select id="select_service"><option value="72" selected>${label}</option><option value="73">Public Simulator Rental</option></select>
      <select id="select_length"><option value="60">1 hour</option></select></body>`;
    expect(inspectUScheduleRecipeConfiguration(html, source)).toBeUndefined();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, serviceName: label } })).toThrow();
  });
  it("reuses the same immutable recipe for changed date and duration with a later-day completion witness", async () => {
    const hash = hashAccessRecipe(recipe);
    const first = await executeAccessRecipe(recipe, input, { ...deps, fetch: responses() });
    const second = await executeAccessRecipe(recipe, { ...input, date: "2030-10-24", durationMinutes: 120 }, { ...deps, fetch: responses() });
    for (const result of [first, second]) expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { recipeHash: hash, dateVerified: true, durationVerified: true } });
    expect(first.slots).toHaveLength(3); expect(second.slots).toHaveLength(3);
    expect(second.slots.every(slot => Date.parse(slot.endsAt!) - Date.parse(slot.startsAt) === 120 * 60_000)).toBe(true);
    expect(second.slots.every(slot => slot.availableSpots === 1 && slot.capacity === null && slot.productId === "72" && slot.resourceId === "ANY")).toBe(true);
  });
  it.each([{ ignoreDate: true }, { ignoreDuration: true }, { changedService: true }, { neverComplete: true }])("never treats stale or partial listing as empty: %j", async options => {
    const fetch = vi.fn(responses(options));
    const result = await executeAccessRecipe(recipe, { ...input, durationMinutes: 120 }, { ...deps, fetch });
    expect(result.complete).toBe(false); expect(result.status).not.toBe("EMPTY"); expect(result.slots).toEqual([]);
    expect(result.evidence.reason).not.toBe("USCHEDULE_PUBLIC_PARTY_UNVERIFIED"); expect(fetch).toHaveBeenCalled();
  });
  it.each(["Example Golf Annex", "Other Example Golf", "Example Golfer", "Example"]) ("rejects venue/tenant mismatch: %s", async venueName => {
    const result = await executeAccessRecipe({ ...recipe, source: { ...recipe.source, venueName } }, input, { ...deps, fetch: responses() });
    expect(result).toMatchObject({ complete: false, evidence: { reason: "ADAPTER_IDENTITY_MISMATCH" } });
  });
});
