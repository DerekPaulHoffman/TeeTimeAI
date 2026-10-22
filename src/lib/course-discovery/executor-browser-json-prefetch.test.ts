// @vitest-environment node
// Actual local Chrome, exclusively in-memory HTTP fixtures; no provider calls.
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { expandRecipeTemplate, parseAccessRecipe } from "./recipe";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, durationMinutes: 60, startTime: "10:00", endTime: "20:00" };
const entry = "https://www.sevenrooms.com/reservations/examplegolf";
const range = "https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=examplegolf&time_slot=19:00&party_size={{players}}&halo_size_interval=64&start_date={{dateMdy}}&num_days=1&channel=SEVENROOMS_WIDGET&selected_lang_code=en&picked_duration={{durationMinutes}}";
const primary = expandRecipeTemplate(range, input, true);
const offsets = [1, 4, 7, 10, 13, 16, 19, 22];
function prefetch(offset: number) {
  const date = new Date(Date.UTC(2030, 9, 23 + offset));
  const mdy = `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}-${date.getUTCFullYear()}`;
  return primary.replace("start_date=10-23-2030", `start_date=${mdy}`).replace("num_days=1", "num_days=3");
}
type Mode = "after" | "before" | "all" | "only" | "wrong-party" | "wrong-duration" | "wrong-language" | "wrong-offset" | "not-three" | "primary-error" | "mutation" | "new-document" | "throttled";
function saved(mode: Mode) {
  return parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_JSON", browserTransport: "PINNED_HTTP",
    target: { courseId: "fixture", offeringId: "fixture-offering", kind: "SIMULATOR" },
    source: { officialUrl: "https://examplegolf.com/", bookingUrl: entry, venueName: "Example Golf", providerFamily: "FIXTURE", timeZone: input.timeZone }, pageUrl: entry,
    permittedRoutes: [{ origin: "https://www.sevenrooms.com", path: "/reservations/examplegolf", methods: ["GET"], queryKeys: ["again"] },
      { origin: "https://www.sevenrooms.com", path: "/api-yoa/availability/widget/range", methods: ["GET"], queryKeys: ["venue", "time_slot", "party_size", "halo_size_interval", "start_date", "num_days", "channel", "selected_lang_code", "picked_duration"] }],
    steps: [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" },
      ...(mode === "mutation" ? [{ action: "waitFor", selector: "#primary-complete" }, { action: "select", selector: "#duration", value: "{{durationMinutes}}", purpose: "DURATION" }] : [])],
    availabilityResponse: { url: range, method: "GET", date: { source: "QUERY", path: "start_date", format: "MM-DD-YYYY" }, success: { path: "status", equals: 200 } },
    requestBinding: "SEVENROOMS_PUBLIC_PARTICIPANTS",
    responseRows: { path: "data.availability", dateKey: "REQUESTED_DATE", rowsPath: "times", typePath: "type", excludeType: "request", availableTypes: ["book"], accessIdPath: "access_persistent_id", labelPath: "public_time_slot_description", expectedRentalLabel: "Golf Rental", startsAtPath: "time", durationMinutesPath: "duration" },
    proof: { venue: { selector: "#venue", format: "VENUE_SELECT_TIME" }, date: { availabilityDateKey: true }, complete: { availabilityResponse: true } },
  });
}
async function run(mode: Mode) {
  const reads: string[] = []; let primaryReads = 0;
  let additional = mode === "all" ? offsets.map(prefetch) : [prefetch(1)];
  if (mode === "wrong-party") additional = [prefetch(1).replace("party_size=2", "party_size=3")];
  if (mode === "wrong-duration") additional = [prefetch(1).replace("picked_duration=60", "picked_duration=90")];
  if (mode === "wrong-language") additional = [prefetch(1).replace("selected_lang_code=en", "selected_lang_code=fr")];
  if (mode === "wrong-offset") additional = [prefetch(2)];
  if (mode === "not-three") additional = [prefetch(1).replace("num_days=3", "num_days=1")];
  if (mode === "primary-error") additional = [primary];
  const fetcher = async (url: string | URL | Request) => {
    const value = String(url); reads.push(value);
    if (value === entry || value === `${entry}?again=1`) {
      let script = mode === "before" ? `fetch(${JSON.stringify(additional[0])}).then(()=>fetch(${JSON.stringify(primary)}))`
        : mode === "only" ? `fetch(${JSON.stringify(additional[0])})`
        : mode === "mutation" ? `fetch(${JSON.stringify(primary)}).then(()=>document.body.insertAdjacentHTML('beforeend','<p id="primary-complete">ready</p>'))`
        : mode === "new-document" ? `fetch(${JSON.stringify(primary)}).then(()=>location.href=${JSON.stringify(entry + "?again=1")})`
        : `fetch(${JSON.stringify(primary)}).then(()=>Promise.all(${JSON.stringify(additional)}.map(url=>fetch(url))))`;
      if (value.includes("?again=1")) script = "void 0";
      return new Response(`<h1 id="venue">Select a time at Example Golf</h1><select id="players" aria-label="Players"><option value="2">2</option></select><select id="duration" aria-label="Duration"><option value="60">60</option></select><script>document.querySelector('#players').onchange=()=>{${script}};document.querySelector('#duration').onchange=()=>fetch(${JSON.stringify(additional[0])});</script>`, { headers: { "content-type": "text/html" } });
    }
    if (!value.startsWith("https://www.sevenrooms.com/api-yoa/availability/widget/range?")) throw Error("UNEXPECTED_FIXTURE_URL");
    const isPrimary = value === primary; if (isPrimary) primaryReads++;
    if (mode === "throttled" && !isPrimary) return new Response("unavailable", { status: 429 });
    const body = isPrimary ? { status: mode === "primary-error" && primaryReads > 1 ? 400 : 200, data: { availability: { [input.date]: [{ times: [{ type: "book", access_persistent_id: "public-fixture", public_time_slot_description: "Golf Rental", time: "5:15 PM", duration: 60 }] }] } } }
      : { status: 200, data: { availability: { "2030-10-24": [{ times: [{ deliberatelyMalformedAncillaryRow: true }] }] } } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  const now = new Date("2030-10-22T12:00:00Z");
  const result = await executeAccessRecipe(saved(mode), input, { fetch: fetcher as typeof fetch,
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    now: () => now, deadlineAt: new Date(now.getTime() + 6000) });
  return { result, reads, primaryReads };
}
describe.runIf(existsSync(chrome))("BROWSER_JSON ancillary-calendar relevance, in-memory replay", () => {
  it.each<Mode>(["after", "before", "all"])("retains only primary proof when exact observed ancillary prefetches complete %s", async mode => {
    const { result, reads } = await run(mode);
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE"); expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1);
    expect(reads).toContain(primary); expect(reads).toContain(prefetch(1));
    if (mode === "all") for (const offset of offsets) expect(reads).toContain(prefetch(offset));
  }, 10000);
  it.each<Mode>(["only", "wrong-party", "wrong-duration", "wrong-language", "wrong-offset", "not-three", "primary-error", "mutation", "new-document", "throttled"])("never rescues old proof for %s", async mode => {
    const { result } = await run(mode);
    expect(result.complete, JSON.stringify(result.evidence)).toBe(false); expect(result.slots).toEqual([]); expect(result.status).not.toBe("EMPTY");
    if (mode === "throttled") expect(result.evidence.reason).toBe("PROVIDER_THROTTLED");
  }, 10000);
});
