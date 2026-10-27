import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "12:00" };
const recipe = (selectFirst = true) => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
  target: { kind: "OUTDOOR", courseId: "fixture" }, source: { officialUrl: "https://example.org/calendar", bookingUrl: "https://example.org/calendar", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/calendar", permittedRoutes: [{ origin: "https://example.org", path: "/calendar", methods: ["GET"] }, { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] }],
  availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
  steps: [...(selectFirst ? [{ action: "clickFilter", selector: "button.day", purpose: "SELECT_DATE", text: "{{day}}" }] : []), { action: "clickFilter", selector: "#apply", purpose: "APPLY_DATE", text: "Apply" }],
  proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, players: { selector: "#players" }, complete: { availabilityResponse: true } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } },
});
const html = `<h1 id="venue">Example Golf</h1><p id="date">2026-10-20</p><p id="players">2</p><div role="dialog"><h2>October 2026</h2><div role="grid">` +
  Array.from({ length: 7 }, (_, i) => i + 20).map(day => `<button role="gridcell" class="day" aria-selected="${day === 20}" onclick="document.querySelectorAll('.day').forEach(e=>e.setAttribute('aria-selected','false'));this.setAttribute('aria-selected','true')">${day}</button>`).join("") +
  `</div><button id="apply" onclick="const date='2026-10-'+document.querySelector('[aria-selected=true]').textContent;fetch('/availability?date='+date).then(r=>r.json()).then(r=>{if(r.ok){document.querySelector('#date').textContent=date;document.querySelector('#slots').innerHTML='<div class=slot><span class=time>09:00</span><span class=capacity>4</span></div>'}})">Apply</button></div><div id="slots"></div>`;

describe.runIf(existsSync(executablePath))("date Apply replay", () => {
  it("requires requested-day selection and then a fresh successful response before returning slots", async () => {
    const urls: string[] = [];
    const dependencies = {
      now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: () => chromium.launch({ executablePath, headless: true }),
      requestLease: async (_family: string, work: () => Promise<unknown>) => ({ acquired: true as const, value: await work() }),
      fetch: (async (value: Parameters<typeof fetch>[0]) => { const url = String(value); urls.push(url);
        return new Response(url.includes("/availability?") ? JSON.stringify({ ok: true }) : html, { headers: { "content-type": url.includes("/availability?") ? "application/json" : "text/html" } }); }) as typeof fetch,
    };
    const good = await executeAccessRecipe(recipe(), input, dependencies as Parameters<typeof executeAccessRecipe>[2]);
    expect(good.status, JSON.stringify(good.evidence)).toBe("AVAILABLE"); expect(good.complete).toBe(true); expect(good.slots).toHaveLength(1);
    expect(urls).toContain("https://example.org/availability?date=2026-10-23");
    urls.length = 0;
    const omitted = await executeAccessRecipe(recipe(false), input, dependencies as Parameters<typeof executeAccessRecipe>[2]);
    expect(omitted.status).toBe("FAILED"); expect(omitted.evidence.diagnostic?.code).toBe("UNSAFE_CALENDAR_APPLY");
    expect(urls.some(url => url.includes("/availability?"))).toBe(false);
  }, 25_000);
});
