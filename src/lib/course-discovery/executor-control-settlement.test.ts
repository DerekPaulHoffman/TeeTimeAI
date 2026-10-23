// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, type AccessExecutorDependencies } from "./executor";
import { parseAccessRecipe } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = { date: "2030-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const inventory = "https://example.org/inventory?date=2030-10-23&players=2";
const recipe = (mode: "select" | "openThenChoose" = "select") => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM",
  browserTransport: "PINNED_HTTP", target: { courseId: "fixture", kind: "OUTDOOR" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/times", permittedRoutes: [{ origin: "https://example.org", path: "/times", methods: ["GET"] },
    { origin: "https://example.org", path: "/startup", methods: ["GET"] },
    { origin: "https://example.org", path: "/late", methods: ["GET"] },
    { origin: "https://example.org", path: "/inventory", methods: ["GET"], queryKeys: ["date", "players"] }],
  steps: [{ action: "waitFor", selector: "#players" }, ...(mode === "select"
    ? [{ action: "select", selector: "#players", value: "{{players}}", purpose: "PLAYERS" }]
    : [{ action: "clickFilter", selector: "#players", text: "4 Players", purpose: "OPEN_FILTER" },
      { action: "clickFilter", selector: "[role=option]", text: "{{players}} Players", purpose: "SELECT_FILTER" }]),
  { action: "clickFilter", selector: "#search", text: "Search", purpose: "RUN_SEARCH" }],
  availabilityResponse: { url: "https://example.org/inventory?date={{date}}&players={{players}}", method: "GET", date: { source: "QUERY", path: "date" }, success: { path: "ok", equals: true } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { availabilityResponse: true }, players: { selector: "#players", format: "INTEGER" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".capacity" } },
});

/** Actual isolated Chrome and normal controller interpreters; wholly in-memory
 * wire and leases. Startup is held until the test explicitly releases it. */
function fixture(persistentPrivate = false, advancePollingClock = false, startReadDuringFrames = false) {
  let release!: () => void, releaseLate!: () => void, started!: () => void, offset = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), startupStarted = new Promise<void>(resolve => { started = resolve; });
  const late = new Promise<void>(resolve => { releaseLate = resolve; });
  const events: string[] = [], reads: string[] = [];
  const html = `<h1>Example Golf</h1><p id="date">2030-10-23</p>
    <form method="GET"><mat-select id="players" role="combobox" aria-haspopup="listbox" aria-expanded="false" tabindex="0">4 Players</mat-select>
      <input id="temporary" type="email" name="account"></form>
    <div id="choices" role="listbox" hidden>${[1, 2, 3, 4].map(p => `<mat-option role="option">${p} Players</mat-option>`).join("")}</div>
    <button id="search">Search</button><button id="payment">Pay now</button>
    <div class="slot"><button id="slot">09:00</button><span class="time">09:00</span><span class="capacity">4</span></div>
    <script>
      let bootSettled=false;const trigger=document.querySelector('#players'),menu=document.querySelector('#choices');
      fetch('/startup').then(r=>r.json()).then(()=>{${persistentPrivate ? "" : "document.querySelector('#temporary').remove();"}bootSettled=true;console.log('BOOT_SETTLED')});
      trigger.onclick=()=>{console.log(bootSettled?'PLAYER_OPEN_SETTLED':'PLAYER_OPEN_PENDING');trigger.setAttribute('aria-controls','choices');trigger.setAttribute('aria-expanded','true');menu.hidden=false};
      menu.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{console.log('PICK_'+option.textContent);trigger.textContent=option.textContent;trigger.setAttribute('aria-expanded','false');menu.hidden=true});
      document.querySelector('#search').onclick=()=>{console.log('SEARCH');fetch('/inventory?date=2030-10-23&players='+trigger.textContent.match(/\\d+/)[0])};
      document.querySelector('#payment').onclick=()=>console.log('PAYMENT_CLICK');document.querySelector('#slot').onclick=()=>console.log('SLOT_CLICK');
      ${startReadDuringFrames ? "let frames=0;const frame=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>frame(time=>{if(++frames===1)fetch('/late');callback(time)});" : ""}
    </script>`;
  const fetch = vi.fn(async url => {
    reads.push(String(url));
    if (String(url).endsWith("/startup")) { started(); await held; }
    if (String(url).endsWith("/late")) await late;
    return new Response(String(url).endsWith("/times") ? html : '{"ok":true}', { headers: { "content-type": String(url).endsWith("/times") ? "text/html" : "application/json" } });
  }) as typeof globalThis.fetch;
  const realNow = Date.now.bind(Date);
  const clock = advancePollingClock ? vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset) : undefined;
  const deps: AccessExecutorDependencies = { fetch, now: () => new Date("2030-10-22T12:00:00Z"),
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    launchBrowser: async () => {
      const browser = await chromium.launch({ executablePath: chrome, headless: true }), newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, "newContext").mockImplementation(async options => {
        const context = await newContext(options), close = context.close.bind(context);
        context.on("page", page => {
          page.on("console", message => events.push(message.text()));
          if (advancePollingClock) {
            const wait = page.waitForTimeout.bind(page);
            vi.spyOn(page, "waitForTimeout").mockImplementation(async ms => {
              // Only the owned fixture's polling delay advances wall time;
              // no production constant, timer or network behavior is changed.
              if (ms === 100) { offset += 2000; await wait(0); } else await wait(ms);
            });
          }
        });
        vi.spyOn(context, "close").mockImplementation(async (...args) => { release(); releaseLate(); await close(...args); });
        return context;
      });
      return browser;
    } };
  return { deps, events, reads, startupStarted, release, restore: () => { releaseLate(); clock?.mockRestore(); } };
}

describe.runIf(existsSync(chrome))("control mutation waits for existing read settlement", () => {
  it.each(["select", "openThenChoose"] as const)("waits before %s proof, then selects only the exact owned player option", async mode => {
    const f = fixture(); let finished = false;
    const execution = executeAccessRecipe(recipe(mode), input, f.deps).finally(() => { finished = true; });
    try {
      await f.startupStarted;
      // The source response is deliberately still held while a public trigger
      // is already visible; it supplies no usable control proof yet.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(finished).toBe(false); expect(f.events).toEqual([]);
      f.release();
      const result = await execution;
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 4 }] });
      expect(f.events).toEqual(["BOOT_SETTLED", "PLAYER_OPEN_SETTLED", "PICK_2 Players", "SEARCH"]);
      expect(f.reads).toEqual(["https://example.org/times", "https://example.org/startup", inventory]);
    } finally { f.release(); await execution; f.restore(); }
  }, 20_000);

  it("still rejects a settled persistent private field without opening a menu, searching or transacting", async () => {
    const f = fixture(true), execution = executeAccessRecipe(recipe(), input, f.deps);
    try {
      await f.startupStarted; f.release();
      expect(await execution).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: { reason: "BROWSER_EVALUATION_FAILED", diagnostic: { stepIndex: 1 } } });
      expect(f.events).toEqual(["BOOT_SETTLED"]);
      expect(f.reads).toEqual(["https://example.org/times", "https://example.org/startup"]);
    } finally { f.release(); await execution; f.restore(); }
  }, 15_000);

  it("fails closed when the existing quiet-read deadline expires with startup still pending", async () => {
    const f = fixture(false, true), execution = executeAccessRecipe(recipe(), input, f.deps);
    try {
      const result = await execution;
      expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "UNSETTLED_REQUESTS",
        diagnostic: { stepIndex: 1, requestState: { pendingReads: 1, currentDocumentPendingHandlers: 1 } } } });
      expect(f.events).not.toContain("PLAYER_OPEN_PENDING"); expect(f.events).not.toContain("SEARCH");
      expect(f.reads).toEqual(["https://example.org/times", "https://example.org/startup"]);
    } finally { f.release(); await execution; f.restore(); }
  }, 15_000);

  it("does not act when the application starts a new admitted read during the DOM frame barrier", async () => {
    const f = fixture(false, true, true), execution = executeAccessRecipe(recipe(), input, f.deps);
    try {
      await f.startupStarted; f.release();
      expect(await execution).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "UNSETTLED_REQUESTS",
        diagnostic: { stepIndex: 1, requestState: { pendingReads: 1, currentDocumentPendingHandlers: 1 } } } });
      expect(f.events).toEqual(["BOOT_SETTLED"]);
      expect(f.reads).toEqual(["https://example.org/times", "https://example.org/startup", "https://example.org/late"]);
    } finally { f.release(); await execution; f.restore(); }
  }, 15_000);
});
