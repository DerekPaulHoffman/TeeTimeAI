import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { accessRecipeSchema, parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const entry = "https://example.org/tee-times";
const choices = 'table[role="presentation"] td[role="button"][tabindex="0"]';

function dateChoiceDescriptions(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  const action = (node.properties as { action?: { const?: string } } | undefined)?.action?.const;
  return [action === "selectDateChoice" && typeof node.description === "string" ? node.description : "",
    ...Object.values(node).flatMap(dateChoiceDescriptions)].filter(Boolean);
}

describe("published calendar capability", () => {
  it("advertises the implemented presentation-table TD grammar in the actual learner schema", () => {
    const descriptions = dateChoiceDescriptions(z.toJSONSchema(accessRecipeSchema, { io: "input", unrepresentable: "any" }));
    expect(descriptions.length).toBeGreaterThan(0);
    for (const description of descriptions) {
      expect(description).toMatch(/table.*role=presentation/iu);
      expect(description).toMatch(/TD.*role=button.*tabindex=0/iu);
      expect(description).toContain("Available");
    }
  });
  it("directs observed full-date TD choices to the existing interpreter instead of calendar-navigation controls", () => {
    const worker = readFileSync(resolve(process.cwd(), "scripts/automation/course-discovery-worker.mjs"), "utf8");
    const guidance = worker.split(/\r?\n/u).find(line => line.includes("For explicit full date labels"));
    expect(guidance).toMatch(/selectDateChoice.*TD.*role=button.*tabindex=0/iu);
    expect(guidance).toMatch(/reusable.*selector/iu);
  });
});

function savedRecipe() {
  return parseAccessRecipe({
    schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
    target: { kind: "OUTDOOR", courseId: "public-calendar-fixture" },
    source: { officialUrl: "https://example.org/", bookingUrl: entry, venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: "America/New_York" },
    pageUrl: entry,
    permittedRoutes: [
      { origin: "https://example.org", path: "/tee-times", methods: ["GET"], queryKeys: [] },
      { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] },
    ],
    steps: [
      { action: "waitFor", selector: "#open-date" },
      { action: "clickFilter", selector: "#open-date", text: "Choose date", purpose: "OPEN_DATE_PICKER" },
      { action: "selectDateChoice", selector: choices },
    ],
    availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
    proof: { venue: { selector: "#venue" }, date: { selector: "#chosen-date", attribute: "value" }, complete: { selector: "#complete" },
      empty: { selector: "#empty" }, players: { selector: "#players", attribute: "value" } },
    slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" }, holes: { selector: ".holes" } },
  });
}

function fixture(mode: "valid" | "wrong-weekday" | "form") {
  const table = `<table id="calendar" role="presentation" hidden><tbody>
    <tr><th>SUN</th><th>MON</th><th>TUE</th><th>WED</th><th>THU</th><th>FRI</th><th>SAT</th></tr>
    <tr><td aria-label="">18</td><td aria-label="">19</td><td aria-label="">20</td><td aria-label="">21</td>
    <td role="button" tabindex="0" aria-label="Thursday, October 22nd 2026, Available">22</td>
    <td role="button" tabindex="0" aria-label="${mode === "wrong-weekday" ? "Thursday" : "Friday"}, October 23rd 2026, Available">23</td>
    <td role="button" tabindex="0" aria-label="Saturday, October 24th 2026, Available">24</td></tr>
    </tbody></table>`;
  return `<!doctype html><html><body><h1 id="venue">Example Golf</h1>
    <button id="open-date" type="button">Choose date</button>${mode === "form" ? `<form>${table}</form>` : table}
    <input id="chosen-date" readonly value="2026-10-22"><select id="players" aria-label="Players"><option value="2">2</option></select>
    <p id="complete">false</p><p id="empty">false</p><div id="slots"></div><script>
    document.querySelector('#open-date').onclick=()=>document.querySelector('#calendar').hidden=false;
    for(const cell of document.querySelectorAll('td[role="button"]'))cell.onclick=async()=>{
      const date='2026-10-'+cell.textContent.trim();document.querySelector('#chosen-date').value=date;
      document.querySelector('#calendar').hidden=true;const response=await fetch('/availability?date='+date);const data=await response.json();
      if(data.ok===true){document.querySelector('#complete').textContent='true';document.querySelector('#slots').innerHTML='<div class="slot"><span class="start">09:00</span><span class="capacity">4</span><span class="holes">18</span></div>';}
    };</script></body></html>`;
}

async function replay(date: string, mode: "valid" | "wrong-weekday" | "form" = "valid") {
  const reads: string[] = [];
  const result = await executeAccessRecipe(savedRecipe(), { date, timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" }, {
    now: () => new Date("2026-10-20T12:00:00Z"),
    deadlineAt: new Date("2026-10-20T12:00:08Z"),
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    fetch: (async value => {
      const url = String(value); reads.push(url);
      if (url === entry) return new Response(fixture(mode), { headers: { "content-type": "text/html" } });
      if (/^https:\/\/example\.org\/availability\?date=2026-10-(?:23|24)$/u.test(url))
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      throw Error("UNEXPECTED_FIXTURE_URL");
    }) as typeof fetch,
  });
  return { result, reads };
}

// Real isolated Chrome and the complete executor; every HTTP response and lease
// is injected locally. This is a date-control fixture, not native wire proof.
describe.runIf(existsSync(chrome))("saved presentation-table date replay", () => {
  it.each(["2026-10-23", "2026-10-24"])("selects the explicit requested full date %s in a fresh execution", async date => {
    const { result, reads } = await replay(date);
    expect(result, JSON.stringify(result.evidence)).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { dateVerified: true } });
    expect(result.slots[0].startsAt).toBe(`${date}T13:00:00.000Z`);
    expect(reads).toEqual([entry, `https://example.org/availability?date=${date}`]);
  }, 12_000);
  it.each(["wrong-weekday", "form"] as const)("rejects %s without clicking or requesting availability", async mode => {
    const { result, reads } = await replay("2026-10-23", mode);
    expect(result).toMatchObject({ complete: false, slots: [], evidence: { reason: "AMBIGUOUS_DATE_CHOICE", diagnostic: { stepIndex: 2 } } });
    expect(reads).toEqual([entry]);
  }, 12_000);
});
