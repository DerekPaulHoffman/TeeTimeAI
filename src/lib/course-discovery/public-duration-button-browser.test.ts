// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const entry = "https://www.sevenrooms.com/reservations/examplegolf";
const range = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=18:00&party_size={{players}}&halo_size_interval=64&start_date={{dateMdy}}&num_days=1&channel=web&picked_duration={{durationMinutes}}";
function html() {
  return `<h1 id="venue">Select a time at Example Golf</h1><div id="root"></div><script>
  setTimeout(()=>{document.querySelector('#root').innerHTML='<label>Players<select id="players" name="players"><option value="2">2</option><option value="3">3</option></select></label><button id="duration"><div id="value">1 hr</div><div>duration</div></button><section id="menu" hidden><h2>SELECT DESIRED DURATION</h2><div><button aria-label="1 hr">1 hr</button><button aria-label="2 hr">2 hr</button></div></section>';
  function refresh(){const date=new URLSearchParams(location.search).get('date')||'2030-10-23';const duration=parseInt(document.querySelector('#value').textContent)*60;fetch('https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=18:00&party_size='+document.querySelector('#players').value+'&halo_size_interval=64&start_date='+date.slice(5,7)+'-'+date.slice(8)+'-'+date.slice(0,4)+'&num_days=1&channel=web&picked_duration='+duration)}
  document.querySelector('#duration').onclick=()=>document.querySelector('#menu').hidden=false;
  document.querySelectorAll('#menu button').forEach(button=>button.onclick=()=>{document.querySelector('#value').textContent=button.textContent;document.querySelector('#menu').hidden=true;refresh()});
  document.querySelector('#players').onchange=refresh;},200);
  </script>`;
}
function transport(log: string[]) {
  return (async (url: string | URL | Request) => {
    const value = String(url); log.push(value);
    if (value.startsWith(entry)) return new Response(html(), { headers: { "content-type": "text/html" } });
    if (!value.startsWith("https://www.sevenrooms.com/api-yoa/availability/widget/range?")) throw Error("UNEXPECTED_FIXTURE_URL");
    const query = new URL(value).searchParams, mdy = query.get("start_date")!.split("-"), date = `${mdy[2]}-${mdy[0]}-${mdy[1]}`;
    return new Response(JSON.stringify({ status: 200, data: { availability: { [date]: [{ times: [{ type: "book", access_persistent_id: "public-fixture",
      public_time_slot_description: "Golf Rental", time: "5:15 PM", duration: Number(query.get("picked_duration")) }] }] } } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const saved = () => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_JSON", target: { courseId: "course", offeringId: "offering", kind: "SIMULATOR" },
  source: { officialUrl: "https://examplegolf.com/", bookingUrl: entry, venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: "America/New_York" },
  pageUrl: `${entry}?date={{date}}`, browserTransport: "PINNED_HTTP",
  permittedRoutes: [{ origin: "https://www.sevenrooms.com", path: "/reservations/examplegolf", methods: ["GET"], queryKeys: ["date"] },
    { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"], queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "picked_duration"] }],
  steps: [{ action: "waitFor", selector: "#duration" }, { action: "select", selector: "#duration", value: "{{durationMinutes}}", purpose: "DURATION" },
    { action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" }],
  availabilityResponse: { url: range, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" }, success: { path: "status", equals: 200 } },
  requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS",
  responseRows: { path: "data.availability", dateKey: "REQUESTED_DATE", rowsPath: "times", typePath: "type", excludeType: "request", availableTypes: ["book"], accessIdPath: "access_persistent_id",
    labelPath: "public_time_slot_description", expectedRentalLabel: "Golf Rental", startsAtPath: "time", durationMinutesPath: "duration" },
  proof: { venue: { selector: "#venue", format: "VENUE_SELECT_TIME" }, date: { availabilityDateKey: true }, complete: { availabilityResponse: true } } });

describe.runIf(existsSync(chrome))("duration-button discovery and fixed replay, in-memory only", () => {
  it("returns a typed duration filter whose numeric select uses the shared verified menu", async () => {
    const reads: string[] = [];
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [entry], deadlineAt: new Date(Date.now() + 15_000) }, {
      browserTransport: "PINNED_HTTP", launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: transport(reads),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      let snapshot = await session.execute({ id: "open", action: "open", url: entry });
      if (!snapshot.controls.some(control => control.filterPurpose === "DURATION")) snapshot = await session.execute({ id: "observe", action: "observe" });
      const duration = snapshot.controls.find(control => control.filterPurpose === "DURATION");
      expect(duration).toMatchObject({ kind: "filter", label: "duration", currentValue: "60" });
      snapshot = await session.execute({ id: "select", action: "select", target: duration!.target, option: "120" });
      expect(snapshot.controls.find(control => control.filterPurpose === "DURATION")).toMatchObject({ currentValue: "120" });
      expect(reads.some(url => url.includes("picked_duration=120"))).toBe(true);
    } finally { await session.close(); }
  }, 15_000);
  it("replays the same saved filter after SPA boot for changed date, duration and participants", async () => {
    const recipe = saved(), hashes: string[] = [];
    for (const input of [{ date: "2030-10-23", durationMinutes: 60, players: 2 }, { date: "2030-10-24", durationMinutes: 120, players: 3 }]) {
      const reads: string[] = [];
      const result = await executeAccessRecipe(recipe, { ...input, timeZone: "America/New_York", startTime: "10:00", endTime: "20:00" }, {
        now: () => new Date("2030-10-20T12:00:00Z"), launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), fetch: transport(reads),
        requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      });
      expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE"); expect(result.slots).toHaveLength(1);
      expect(new Date(result.slots[0].endsAt!).getTime() - new Date(result.slots[0].startsAt).getTime()).toBe(input.durationMinutes * 60_000);
      expect(reads.some(url => url.includes(`party_size=${input.players}`) && url.includes(`picked_duration=${input.durationMinutes}`))).toBe(true);
      hashes.push(result.evidence.recipeHash);
    }
    expect(new Set(hashes).size).toBe(1);
  }, 15_000);
});
