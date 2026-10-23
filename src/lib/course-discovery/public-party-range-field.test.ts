// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { executeAccessRecipe } from "./executor";
import { accessRecipeSchema, parseAccessRecipe, readRecipeFieldFormat } from "./recipe";
import { readPublicPartyRangeField } from "./public-party-range-field";

const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const launch = () => chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true });
const recipe = () => ({ schemaVersion: 1, engine: "BROWSER_DOM", target: { courseId: "course", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/times", steps: [{ action: "waitFor", selector: ".party" }],
  permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"] }, { origin: "https://example.org", path: "/inventory", methods: ["GET"], queryKeys: ["date"] }],
  availabilityResponse: { url: "https://example.org/inventory?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { availabilityResponse: true }, players: { selector: "#players" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".party", format: "PUBLIC_PARTY_RANGE" } } });
const partyField = (text = "2-4") => `<span><mat-icon role="img">person</mat-icon><span class="party">${text}</span></span>`;

describe("explicit public player-range field format", () => {
  it("accepts the ordinary recipe before testing invalid field positions", () => {
    expect(accessRecipeSchema.safeParse(recipe()).success).toBe(true);
  });
  it.each([["1-4", "1 to 4 players"], ["2-2", "2 to 2 players"], [" 2 - 4 ", "2 to 4 players"]])("reads the whole finite %s range", (text, value) => {
    expect(readRecipeFieldFormat({ path: "party", format: "PUBLIC_PARTY_RANGE" }, text)).toBe(value);
  });
  it.each(["0-4", "1-5", "4-1", "1.5-4", "$2-4", "2-4 hours", "2-4 players", "1-2-4", "09:00", "2–4", "2/4", "2-4 or 5", null])("refuses unproved or mixed-unit %s", text => {
    expect(readRecipeFieldFormat({ path: "party", format: "PUBLIC_PARTY_RANGE" }, text)).toBeUndefined();
  });
  it.each([["2-4", 3, "AVAILABLE"], ["2-4", 1, "EMPTY"], ["2-2", 3, "EMPTY"], ["2-2", 2, "AVAILABLE"], ["4-1", 2, "INCOMPLETE"]])(
    "preserves inclusive party eligibility %s / %s", async (party, players, status) => {
      const html = `<h1>Example Golf</h1><p id="date">${input.date}</p><p id="players">${players}</p><div class="slot"><span class="time">09:00</span>${partyField(party)}</div><script>fetch('https://example.org/inventory?date=2030-10-23');</script>`;
      const result = await executeAccessRecipe(parseAccessRecipe(recipe()), { ...input, players }, {
        now: () => new Date("2030-10-22T12:00:00Z"), launchBrowser: launch, requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
        fetch: (async url => new Response(String(url).endsWith("/times") ? html : '{"ok":true}',
          { headers: { "content-type": String(url).endsWith("/times") ? "text/html" : "application/json" } })) as typeof fetch,
      });
      expect(result.status).toBe(status);
      if (status === "AVAILABLE") expect(result.slots[0].availableSpots).toBe(Number(party.slice(-1)));
    });
  it.each(["venue", "date", "complete", "players"])("does not reinterpret %s proof as a party range", key => {
    const candidate = recipe();
    Object.assign(candidate.proof[key as keyof typeof candidate.proof], { format: "PUBLIC_PARTY_RANGE" });
    expect(accessRecipeSchema.safeParse(candidate).success).toBe(false);
  });
  it("keeps the formatter outside timestamps, minima and simulator quantities", () => {
    expect(accessRecipeSchema.safeParse({ ...recipe(), slots: { ...recipe().slots, startsAt: { path: "time", format: "PUBLIC_PARTY_RANGE" } } }).success).toBe(false);
    expect(accessRecipeSchema.safeParse({ ...recipe(), slots: { ...recipe().slots, minimumPlayers: { path: "min", format: "PUBLIC_PARTY_RANGE" } } }).success).toBe(false);
    expect(accessRecipeSchema.safeParse({ ...recipe(), target: { courseId: "course", offeringId: "rental", kind: "SIMULATOR" },
      proof: { ...recipe().proof, durationMinutes: { path: "duration" } }, slots: { ...recipe().slots, endsAt: { path: "end" } } }).success).toBe(false);
    expect(readRecipeFieldFormat({ path: "party" }, "2-4")).toBe("2-4");
    expect(readRecipeFieldFormat({ path: "party", format: "INTEGER" }, "2-4")).toBeUndefined();
  });
});

describe("current DOM authority for a public party range", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await launch(); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); await page.route("**/*", route => route.abort()); });
  afterAll(async () => { await browser?.close(); });
  it("reads a leaf next to the current exact person icon", async () => {
    await page.setContent(partyField());
    expect(await readPublicPartyRangeField(page.locator(".party"))).toBe("2 to 4 players");
  });
  it.each([
    partyField().replace('role="img"', 'role="button"'), partyField().replace('>person<', '>flag<'),
    partyField().replace('>person<', '>person 09:00<'), partyField().replace('role="img"', 'role="img" hidden'),
    partyField().replace('>2-4<', '>2-4<span>players</span><'), `<form>${partyField()}</form>`,
    `<section aria-label="Login">${partyField()}</section>`, `<div contenteditable="">${partyField()}</div>`,
    partyField().replace('</mat-icon>', '</mat-icon><span>Price</span>'),
    `<section style="opacity:0">${partyField()}</section>`,
    partyField().replace('role="img"', 'role="img" aria-label="Account profile"'),
    partyField().replace('class="party"', 'class="party" aria-label="Birthdate"'),
    partyField().replace('class="party"', 'class="party" aria-label="dateOfBirth"'),
    partyField().replace('class="party"', 'class="party" aria-label="date_of_birth"'),
    partyField().replace('class="party"', 'class="party" aria-labelledby="external"'),
    partyField().replace('class="party"', 'class="party" aria-describedby="external"'),
    `<section aria-label="Birthdate">${"<div>".repeat(10)}${partyField()}${"</div>".repeat(10)}</section>`,
  ])("refuses an unrelated, hidden, editable, private or ambiguous range", async html => {
    await page.setContent(html);
    expect(await readPublicPartyRangeField(page.locator(".party"))).toBeUndefined();
  });
});
