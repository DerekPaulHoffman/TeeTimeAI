// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { trySelectPublicFilterOption } from "./public-filter-option";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };

describe("public role option ownership", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); await page.route("**/*", route => route.abort()); });
  afterAll(async () => { await browser?.close(); });
  const menu = `<div role="combobox" aria-label="Players" aria-controls="menu" aria-expanded="true">4 Players</div><div id="menu" role="listbox"><custom-item role="option">1 Player</custom-item><custom-item role="option">2 Players</custom-item><custom-item role="option">3 Players</custom-item></div><output id="picked"></output><script>document.querySelectorAll('[role=option]').forEach(node=>node.onclick=()=>document.querySelector('#picked').textContent=node.textContent)</script>`;
  it("uses exact text and an expanded related public control without data-value", async () => {
    await page.setContent(menu); expect(await trySelectPublicFilterOption(page.locator("custom-item"), "2 Players", { simulator: false })).toBe(true);
    expect(await page.locator("#picked").textContent()).toBe("2 Players");
  });
  it("supports an explicitly labelled duration menu and ignores hidden duplicates", async () => {
    await page.setContent(menu.replaceAll("Players", "Duration").replaceAll("Player", "Duration").replaceAll("2 Duration", "60 minutes") + '<custom-item role="option" hidden>60 minutes</custom-item>');
    expect(await trySelectPublicFilterOption(page.locator("custom-item"), "60 minutes", { simulator: true })).toBe(true);
    expect(await page.locator("#picked").textContent()).toBe("60 minutes");
  });
  it.each([
    menu.replace('aria-controls="menu"', 'aria-controls="other"'), menu.replace('aria-expanded="true"', 'aria-expanded="false"'),
    menu.replace('aria-label="Players"', 'aria-label="Account players"'), menu.replace('aria-label="Players"', 'aria-label="Other"').replace('4 Players', 'Other'),
    menu.replace('id="menu"', 'id="menu" aria-label="Confirm purchase"'),
    `<form>${menu}</form>`, menu.replace('<custom-item role="option">2', '<custom-item role="option" form="external">2'),
    menu.replace('<custom-item role="option">2', '<custom-item role="option" aria-disabled="true">2'),
    menu.replace('<custom-item role="option">2', '<custom-item role="option" href="https://example.org/book">2'),
    menu.replace('2 Players</custom-item>', '2 Players</custom-item><custom-item role="option">2 Players</custom-item>'),
    menu + '<div role="combobox" aria-controls="menu" aria-expanded="true">Players</div>',
  ])("does not click an unsafe, unrelated, disabled or ambiguous option", async html => {
    await page.setContent(html); await expect(trySelectPublicFilterOption(page.locator("custom-item"), "2 Players", { simulator: false })).rejects.toThrow(/UNSAFE_CONTROL|AMBIGUOUS_CONTROL/u);
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it.each(["09:00", "2 Players checkout", "2 lessons", "100 Players"])("never treats %s as an allowed player filter", async text => {
    await page.setContent(menu.replace("2 Players", text)); await expect(trySelectPublicFilterOption(page.locator("custom-item"), text, { simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it.each([`<div contenteditable="">${menu}</div>`, `<div contenteditable="plaintext-only">${menu}</div>`,
    menu.replace("2 Players</custom-item>", '2 Players<span contenteditable=""></span></custom-item>')])(
    "refuses inherited or nested editable content before clicking an option", async html => {
      await page.setContent(html);
      await expect(trySelectPublicFilterOption(page.locator("custom-item"), "2 Players", { simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
      expect(await page.locator("#picked").textContent()).toBe("");
    });
  it("retains one-bay simulator restrictions and leaves non-option legacy controls untouched", async () => {
    await page.setContent(menu); await expect(trySelectPublicFilterOption(page.locator("custom-item"), "2 Players", { simulator: true })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await trySelectPublicFilterOption(page.locator("[role=combobox]"), "4 Players", { simulator: false })).toBe(false);
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it("bounds candidates and refuses duration prose rather than extracting a convenient number", async () => {
    await page.setContent(menu.replaceAll("Players", "Duration").replace("2 Duration", "60 minutes lesson"));
    await expect(trySelectPublicFilterOption(page.locator("custom-item"), "60 minutes lesson", { simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    await page.setContent(menu + '<custom-item role="option">3 Players</custom-item>'.repeat(80));
    await expect(trySelectPublicFilterOption(page.locator("custom-item"), "2 Players", { simulator: false })).rejects.toThrow("AMBIGUOUS_CONTROL");
    expect(await page.locator("#picked").textContent()).toBe("");
  });
});

describe("public custom option replay", () => {
  it("resolves one exact public option from the current labelled menu before counting the broad selector", async () => {
    const html = `<h1>Example Golf</h1><p id="date">2030-10-23</p>
      <div id="players" role="combobox" aria-label="Players" aria-controls="options" aria-expanded="false">4 Players</div>
      <div id="options" role="listbox" hidden><mat-option role="option">Any</mat-option><mat-option role="option">1 Player</mat-option><mat-option role="option">2 Players</mat-option><mat-option role="option">3 Players</mat-option><mat-option role="option">4 Players</mat-option></div>
      <button id="search">Search</button><div class="slot"><span class="time">09:00</span><span class="capacity">4</span></div>
      <script>const trigger=document.querySelector('#players'), menu=document.querySelector('#options');
      trigger.onclick=()=>{menu.hidden=false;trigger.setAttribute('aria-expanded','true')};
      menu.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{trigger.textContent=option.textContent;menu.hidden=true;trigger.setAttribute('aria-expanded','false')});
      document.querySelector('#search').onclick=()=>fetch('https://example.org/inventory?date=2030-10-23&players=2');</script>`;
    const recipe = { schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course", kind: "OUTDOOR" },
      source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
      pageUrl: "https://example.org/times", permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"], queryKeys: [] },
        { origin: "https://example.org", path: "/inventory", methods: ["GET"], queryKeys: ["date", "players"] }],
      steps: [{ action: "waitFor", selector: "#players" }, { action: "clickFilter", selector: "#players", text: "4 Players", purpose: "OPEN_FILTER" },
        { action: "clickFilter", selector: "mat-option", text: "{{players}} Players", purpose: "SELECT_FILTER" },
        { action: "clickFilter", selector: "#search", text: "Search", purpose: "RUN_SEARCH" }],
      availabilityResponse: { url: "https://example.org/inventory?date={{date}}&players={{players}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
      proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { availabilityResponse: true }, players: { selector: "#players", format: "INTEGER" } },
      slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } } };
    const reads: string[] = [];
    const result = await executeAccessRecipe(recipe as never, input, {
      now: () => new Date("2030-10-22T12:00:00Z"),
      launchBrowser: () => chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      fetch: (async url => { reads.push(String(url)); return new Response(String(url).endsWith("/times") ? html : '{"ok":true}', { headers: { "content-type": String(url).endsWith("/times") ? "text/html" : "application/json" } }); }) as typeof fetch,
    });
    expect(result.status, JSON.stringify(result.evidence)).toBe("AVAILABLE");
    expect(result.slots).toHaveLength(1);
    expect(reads).toContain("https://example.org/inventory?date=2030-10-23&players=2");
  });
});
