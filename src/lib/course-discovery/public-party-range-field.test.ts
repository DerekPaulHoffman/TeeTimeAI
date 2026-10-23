// @vitest-environment node
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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
const filterForm = (attributes = "", extra = "", field = partyField()) => `<form ${attributes}>
  <input readonly aria-haspopup="dialog" placeholder="Choose date" autocomplete="off"><input readonly><input readonly autocomplete="off">
  <label><input type="radio" hidden>Closest</label><label><input type="radio" style="opacity:0">After</label>
  <svg aria-hidden="true"><path></path></svg><button type="button">Previous</button><button>Search</button>
  <public-collection id="public-card-list" role="listbox" tabindex="0">${field}</public-collection>${extra}</form>`;

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
  it("reads the actual visible decorative person icon with only its own aria-hidden flag", async () => {
    await page.setContent(partyField().replace('role="img"', 'role="img" aria-hidden="true"'));
    expect(await readPublicPartyRangeField(page.locator(".party"))).toBe("2 to 4 players");
  });
  it.each([
    'hidden', 'inert', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"',
    'href="/account"', 'form="filters"', 'tabindex="0"', 'onclick="void 0"', 'aria-controls="menu"', 'aria-expanded="false"',
    'aria-label="Account profile"', 'title="Payment details"', 'aria-labelledby="missing"',
    'aria-describedby="private"', 'contenteditable="true"',
  ])("keeps decorative icon %s unsafe despite self aria-hidden", async attributes => {
    await page.setContent(partyField().replace('role="img"', `role="img" aria-hidden="true" ${attributes}`));
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_ICON_CONTEXT");
  });
  it.each([
    `<section aria-hidden="true">${partyField().replace('role="img"', 'role="img" aria-hidden="true"')}</section>`,
    `<section hidden>${partyField().replace('role="img"', 'role="img" aria-hidden="true"')}</section>`,
    `<section inert>${partyField().replace('role="img"', 'role="img" aria-hidden="true"')}</section>`,
    `<section aria-label="Account">${partyField().replace('role="img"', 'role="img" aria-hidden="true"')}</section>`,
    partyField().replace('role="img"', 'role="img" aria-hidden="true"').replace('class="party"', 'class="party" aria-hidden="true"'),
  ])("retains every leaf and ancestor veto around a decorative icon", async html => {
    await page.setContent(html);
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_LEAF_CONTEXT");
  });
  it.each([
    partyField().replace('role="img"', 'role="button" aria-hidden="true"'),
    partyField().replace('role="img"', 'role="img" aria-hidden="true"').replace('>person<', '>players<'),
    partyField().replace('role="img"', 'role="img" aria-hidden="true"').replace('>person<', '>person<input><'),
    partyField().replace('role="img"', 'role="img" aria-hidden="true"').replace('>person<', '>person<span></span><'),
    partyField().replace('<mat-icon role="img">person</mat-icon>', '<button type="button" role="img" aria-hidden="true">person</button>'),
  ])("does not turn an interactive, nested or unrelated caption into a decorative person", async html => {
    await page.setContent(html);
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_ICON_CONTEXT");
  });
  it.each([`<form>${partyField()}</form>`, filterForm('method="GET" target="_self"')])(
    "reads a public leaf inside only a bounded read-only filter form", async html => {
      await page.setContent(html);
      await page.locator("input").evaluateAll(nodes => nodes.forEach(node => {
        Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } });
        Object.defineProperty(node, "checked", { get() { throw Error("PRIVATE_STATE_READ"); } });
      }));
      expect(await readPublicPartyRangeField(page.locator(".party"))).toBe("2 to 4 players");
    });
  it.each([
    ['method="POST"', ""], ['action="/search"', ""], ['target="_blank"', ""], ['onsubmit="void 0"', ""],
    ['aria-label="Account filters"', ""], ["", '<input type="hidden">'], ["", '<input type="password">'],
    ["", '<input type="email">'], ["", '<input type="tel">'], ["", '<input type="file">'], ["", '<input type="text">'],
    ["", '<input readonly name="cardNumber">'], ["", '<input readonly placeholder="Date of birth">'],
    ["", '<input readonly autocomplete="email">'], ["", '<button type="button" formaction="/pay">Search</button>'],
    ["", '<button>Reserve</button>'], ["", '<label>Account details</label>'], ["", '<div contenteditable=""></div>'],
    ["", '<svg role="button"><path></path></svg>'], ["", '<span aria-describedby="missing"></span>'],
    ["", '<div aria-describedby="private"></div><span id="private">Account details</span>'],
    ["", "<span></span>".repeat(250)], ["", "<input readonly>".repeat(81)],
  ])("reports only FORM_CONTEXT for private, actionable or unbounded form metadata (%s %s)", async (attributes, extra) => {
    await page.setContent(filterForm(attributes, extra));
    await page.locator("input").evaluateAll(nodes => nodes.forEach(node => Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } })));
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_FORM_CONTEXT");
  });
  it("rejects an external native form association without reading its private value", async () => {
    await page.setContent(filterForm('id="filters"') + '<input form="filters" type="hidden">');
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_FORM_CONTEXT");
  });
  it.each(["accessToken", "apiKey", "authorization"])("rejects credential-native metadata %s without reading the field", async name => {
    await page.setContent(filterForm("", `<input readonly name="${name}">`));
    await page.locator("input").evaluateAll(nodes => nodes.forEach(node => Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } })));
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_FORM_CONTEXT");
  });
  it.each([
    partyField().replace('role="img"', 'role="button"'), partyField().replace('>person<', '>flag<'),
    partyField().replace('>person<', '>person 09:00<'), partyField().replace('role="img"', 'role="img" hidden'),
    partyField().replace('>2-4<', '>2-4<span>players</span><'),
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
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow(/^PUBLIC_PARTY_RANGE_(?:FORM_CONTEXT|LEAF_CONTEXT|ICON_CONTEXT|RANGE_INVALID|PARENT_SHAPE)$/u);
  });
  it.each([
    [partyField("4-1"), "RANGE_INVALID"], [partyField("2-4 hours"), "RANGE_INVALID"],
    [partyField().replace('role="img"', 'role="img" aria-hidden="true" hidden'), "ICON_CONTEXT"],
    [partyField().replace('</mat-icon>', '</mat-icon><span>Other</span>'), "PARENT_SHAPE"],
    [`<section aria-label="Login">${partyField()}</section>`, "LEAF_CONTEXT"],
  ])("retains closed precise rejection %s -> %s", async (html, reason) => {
    await page.setContent(html);
    await expect(readPublicPartyRangeField(page.locator(".party"))).rejects.toThrow("PUBLIC_PARTY_RANGE_" + reason);
  });
  it("runs the actual tsx-serialized read-only form callback without __name", async () => {
    const path = resolve(process.cwd(), "src/lib/course-discovery/public-party-range-field.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import{readPublicPartyRangeField as read}from ${JSON.stringify(path)};void read({evaluate:async(fn)=>{process.stdout.write(fn.toString());throw Error('CAPTURE_DONE')}}).catch(()=>{});`],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    // Retained actual shape: a physically visible static person adornment is
    // intentionally absent from the accessibility tree, not from the layout.
    await page.setContent(filterForm("", "", partyField().replace('role="img"', 'role="img" aria-hidden="true"')));
    const callback = new Function(`return (${serialized});`)();
    expect(await page.locator(".party").evaluate(callback)).toBe("2 to 4 players");
  });
});

describe("read-only form range full executor composition", () => {
  it.each([["", "AVAILABLE"], ['method="POST"', "INCOMPLETE"]])("keeps %s form context honest as %s", async (attributes, status) => {
    const html = `<h1>Example Golf</h1><p id="date">${input.date}</p><p id="players">2</p>` +
      filterForm(attributes, "", `<div class="slot"><span class="time">09:00</span>${partyField()}</div>`) +
      "<script>fetch('https://example.org/inventory?date=2030-10-23')</script>";
    const result = await executeAccessRecipe(parseAccessRecipe(recipe()), input, {
      now: () => new Date("2030-10-22T12:00:00Z"), launchBrowser: launch, requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
      fetch: (async url => new Response(String(url).endsWith("/times") ? html : '{"ok":true}',
        { headers: { "content-type": String(url).endsWith("/times") ? "text/html" : "application/json" } })) as typeof fetch,
    });
    expect(result.status).toBe(status);
    if (status === "AVAILABLE") expect(result.slots).toHaveLength(1);
    else expect(result).toMatchObject({ complete: false, slots: [], evidence: { reason: "PUBLIC_PARTY_RANGE_FORM_CONTEXT" } });
  });
});
