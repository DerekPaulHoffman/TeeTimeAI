// @vitest-environment node
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
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
const formFixture = (attributes = "", extra = "") => fixture().replace(/<mat-select[^>]*>4 Players<\/mat-select>/u,
  node => `<form ${attributes}>${node}${extra}</form>`);
// Metadata-faithful public filter siblings; this is not a copied provider DOM.
const passiveFilters = `<input readonly aria-haspopup="dialog" placeholder="Choose date" autocomplete="off">
  <input readonly><input readonly autocomplete="off">
  <label><input type="radio" hidden>Closest</label><label><input type="radio" style="opacity:0">After</label>
  <svg aria-hidden="true"><path d="M0 0h1"></path></svg><svg role="img"><path d="M0 0h1"></path></svg>
  <button type="button">Previous</button><button type="button">Next</button><button type="button" role="option">Course</button><button>Search</button>`;

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
  it("selects within a native inert public GET filter form while the owned listbox remains outside", async () => {
    await page.setContent(formFixture('method="GET" target="_self"'));
    await selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false });
    expect(await page.locator("#picked").textContent()).toBe("2 Players");
  });
  it("selects in a bounded 183-descendant public form without reading passive field values or radio state", async () => {
    await page.setContent(formFixture("", passiveFilters + "<span></span>".repeat(167)));
    expect(await page.locator("form *").count()).toBe(183);
    await page.locator("input").evaluateAll(nodes => nodes.forEach(node => {
      Object.defineProperty(node, "value", { get() { throw Error("PASSIVE_VALUE_READ"); } });
      Object.defineProperty(node, "checked", { get() { throw Error("PASSIVE_CHECKED_READ"); } });
    }));
    await selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false });
    expect(await page.locator("#picked").textContent()).toBe("2 Players");
  });
  it.each([
    ['method="POST"', ""], ['action="/search"', ""], ['target="_blank"', ""], ['enctype="text/plain"', ""],
    ['onsubmit="window.privateSubmit=true"', ""], ['aria-label="Account filters"', ""],
    ["", '<input type="password" value="private-never-read">'], ["", '<input type="hidden" value="private-never-read">'],
    ["", '<input type="email">'], ["", '<input type="tel">'], ["", '<input type="file">'],
    ["", '<input type="number" autocomplete="on">'], ["", '<input type="number" name="creditCardNumber">'],
    ["", '<input type="number" name="customerId">'], ["", '<input type="number" hidden>'], ["", '<input type="number" style="opacity:0">'],
    ["", '<label>Account details</label>'], ["", '<button>Other</button>'], ["", '<button type="button">Reserve now</button>'],
    ["", '<button type="button" formaction="/pay">Search</button>'], ["", '<a href="/other">Players</a>'],
    ["", '<div contenteditable="false"></div>'], ["", '<input type="text" aria-label="Date">'],
    ["", '<input readonly placeholder="Date of birth" autocomplete="off">'], ["", '<input readonly autocomplete="bday">'],
    ["", '<svg role="button"><path></path></svg>'], ["", '<svg onclick="void 0"><path></path></svg>'],
    ["", '<svg><a href="/other"></a></svg>'], ["", '<svg><foreignObject></foreignObject></svg>'],
  ])("never opens a form with navigation, private or unproved field semantics (%s %s)", async (attributes, extra) => {
    await page.setContent(formFixture(attributes, extra));
    await page.locator("input").evaluateAll(nodes => nodes.forEach(node => Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } })));
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#opened").textContent()).toBe("");
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it("rejects external form-associated controls before opening", async () => {
    await page.setContent(formFixture('id="filter"') + '<input type="hidden" form="filter" value="private-never-read">');
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it.each(['aria-describedby="account"', 'aria-describedby="missing"', 'aria-describedby="account account"', 'aria-describedby=""'])(
    "rejects unproved or private external descriptions before opening (%s)", async attributes => {
      await page.setContent(formFixture(attributes) + '<p id="account">Account details</p>');
      await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
      expect(await page.locator("#opened").textContent()).toBe("");
    });
  it("never selects a submitting native button even in a benign public filter form", async () => {
    await page.setContent(formFixture().replace(/mat-select/gu, "button"));
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it("rechecks a form changed while opening before choosing an overlay option", async () => {
    await page.setContent(formFixture().replace("trigger.onclick=()=>{", "trigger.onclick=()=>{trigger.closest('form').setAttribute('action','/submit');"));
    await expect(selectPublicFilter(page.locator("#players"), { value: "2", purpose: "PLAYERS", simulator: false })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#picked").textContent()).toBe("");
  });
  it("runs the actual tsx-serialized form proof in Chromium without a named-helper dependency", async () => {
    const path = resolve(process.cwd(), "src/lib/course-discovery/public-player-combobox.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import{tryOpenPublicPlayerCombobox as open}from ${JSON.stringify(path)};void open({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async(fn)=>{process.stdout.write(fn.toString());throw Error('CAPTURE_DONE')}},'4 Players').catch(()=>{});`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    await page.setContent(formFixture("", passiveFilters));
    const callback = new Function(`return (${serialized});`)();
    expect(await page.locator("#players").evaluate(callback)).toMatchObject({ players: 4, expanded: false });
  });
  it.each([
    fixture().replace('tabindex="0"', 'tabindex="-1"'),
    fixture().replace('aria-haspopup="listbox"', 'aria-haspopup="dialog"'),
    fixture().replace('id="players"', 'id="players" aria-label="Account players"'),
    fixture().replace('id="players"', 'id="players" href="https://example.org/book"'),
    `<form method="POST">${fixture()}</form>`, `<div contenteditable="">${fixture()}</div>`,
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
