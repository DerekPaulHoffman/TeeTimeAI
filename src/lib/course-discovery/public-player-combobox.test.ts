// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { selectPublicFilter } from "./public-filter-control";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const fixture = () => `<mat-select id="players" role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0">4 Players</mat-select>
  <div id="choices" role="listbox" hidden><mat-option role="option">1 Player</mat-option><mat-option role="option">2 Players</mat-option><mat-option role="option">4 Players</mat-option></div>
  <output id="picked"></output><output id="opened"></output><script>
  const trigger=document.querySelector('#players'), menu=document.querySelector('#choices');
  trigger.onclick=()=>{document.querySelector('#opened').textContent='opened';trigger.setAttribute('aria-controls','choices');trigger.setAttribute('aria-expanded','true');menu.hidden=false};
  menu.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{trigger.textContent=option.textContent;trigger.setAttribute('aria-expanded','false');menu.hidden=true;document.querySelector('#picked').textContent=option.textContent});
  </script>`;

describe("public player combobox without invented option values", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); await page.route("**/*", route => route.abort()); });
  afterAll(async () => { await browser?.close(); });
  it("selects exact visible party text from its owned listbox and verifies the closed readback", async () => {
    await page.setContent(fixture());
    await selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false });
    expect(await page.locator("#picked").textContent()).toBe("2 Players");
    expect(await page.locator("#players").getAttribute("aria-expanded")).toBe("false");
  });
  it.each([
    fixture().replace('tabindex="0"', 'tabindex="-1"'),
    fixture().replace('aria-haspopup="listbox"', 'aria-haspopup="dialog"'),
    fixture().replace('id="players"', 'id="players" aria-label="Account players"'),
    fixture().replace('id="players"', 'id="players" href="https://example.org/book"'),
    `<form>${fixture()}</form>`, `<div contenteditable="">${fixture()}</div>`,
    fixture().replace('4 Players</mat-select>', '09:00 Players</mat-select>'),
    fixture().replace("trigger.setAttribute('aria-controls','choices')", "trigger.setAttribute('aria-controls','other')"),
    fixture().replace('2 Players</mat-option>', '2 Players</mat-option><mat-option role="option">2 Players</mat-option>'),
    fixture().replace('2 Players</mat-option>', '2 Players checkout</mat-option>'),
    fixture().replace("trigger.textContent=option.textContent", "trigger.textContent='4 Players'"),
    fixture().replace("trigger.setAttribute('aria-expanded','false');menu.hidden=true", "trigger.setAttribute('aria-expanded','true');menu.hidden=false"),
  ])("does not certify an unsafe, unrelated, ambiguous or unchanged control", async html => {
    await page.setContent(html);
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow(/UNSAFE_CONTROL|AMBIGUOUS_CONTROL/u);
  });
  it("retains simulator one-bay restrictions and rejects absent party choices", async () => {
    await page.setContent(fixture());
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: true })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#picked").textContent()).toBe("");
    await expect(selectPublicFilter(page.locator("#players"), { value: "3", purpose: "PLAYERS", simulator: false })).rejects.toThrow(/UNSAFE_CONTROL|AMBIGUOUS_CONTROL/u);
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it.each(["Login", "Sign in", "Authentication", "Account players"])("rejects %s context before opening or falling back", async label => {
    await page.setContent(`<section aria-label="${label}">${fixture()}</section>`);
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#opened").textContent()).toBe("");
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it("keeps a matching party option from a different listbox outside the selected control", async () => {
    await page.setContent(fixture().replace('2 Players</mat-option>', '3 Players</mat-option>') +
      '<div role="combobox" aria-label="Players" aria-controls="other" aria-expanded="true">4 Players</div><div id="other" role="listbox"><mat-option role="option">2 Players</mat-option></div>');
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow();
    expect(await page.locator("#picked").textContent()).toBe("");
  });
});

describe("saved public player combobox replay", () => {
  it.each(["select", "openThenChoose"])("replays %s without inventing a DOM option value", async action => {
    const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
    const html = `<h1>Example Golf</h1><p id="date">2030-10-23</p>${fixture()}
      <button id="search">Search</button><div class="slot"><span class="time">09:00</span><span class="capacity">4</span></div>
      <script>document.querySelector('#search').onclick=()=>fetch('https://example.org/inventory?date=2030-10-23&players='+document.querySelector('#players').textContent.match(/\\d+/)[0]);</script>`;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course", kind: "OUTDOOR" },
      source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
      pageUrl: "https://example.org/times", permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"] },
        { origin: "https://example.org", path: "/inventory", methods: ["GET"], queryKeys: ["date", "players"] }],
      steps: [{ action: "waitFor", selector: "#players" }, ...(action === "select" ?
        [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" }] :
        [{ action: "clickFilter", selector: "#players", text: "4 Players", purpose: "OPEN_FILTER" },
          { action: "clickFilter", selector: "[role=option]", text: "{{players}} Players", purpose: "SELECT_FILTER" }]),
      { action: "clickFilter", selector: "#search", text: "Search", purpose: "RUN_SEARCH" }],
      availabilityResponse: { url: "https://example.org/inventory?date={{date}}&players={{players}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
      proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { availabilityResponse: true }, players: { selector: "#players", format: "INTEGER" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } } });
    const reads: string[] = [];
    const result = await executeAccessRecipe(recipe, input, {
      now: () => new Date("2030-10-22T12:00:00Z"),
      launchBrowser: () => chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      fetch: (async url => { reads.push(String(url)); return new Response(String(url).endsWith("/times") ? html : '{"ok":true}',
        { headers: { "content-type": String(url).endsWith("/times") ? "text/html" : "application/json" } }); }) as typeof fetch,
    });
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE");
    expect(result.slots).toHaveLength(1);
    expect(reads).toContain("https://example.org/inventory?date=2030-10-23&players=2");
  });
});
