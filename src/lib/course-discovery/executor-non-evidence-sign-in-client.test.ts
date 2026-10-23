// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, type AccessExecutorDependencies } from "./executor";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl, parseAccessRecipe, recipeAllowsRequest } from "./recipe";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const clients = ["https://accounts.google.com/gsi/client", "https://token.dcap.com/v1/client", "https://token.dcap.com/v1/client/hosted"], pageUrl = "https://example.org/tee-times";
const input = { date: "2026-10-23", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: "PINNED_HTTP",
  target: { kind: "OUTDOOR", courseId: "fixture-course" },
  source: { officialUrl: pageUrl, bookingUrl: pageUrl, venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl, permittedRoutes: [{ origin: "https://example.org", path: "/tee-times", methods: ["GET"] },
    { origin: "https://example.org", path: "/availability", methods: ["GET"], queryKeys: ["date"] }], steps: [{ action: "waitFor", selector: "h1" }],
  availabilityResponse: { url: "https://example.org/availability?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
  proof: { venue: { selector: "h1" }, date: { selector: "#date" }, complete: { selector: "#ready" } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".time" }, availableSpots: { selector: ".players" } },
});

/** Synthetic caller fixture: real isolated Chrome, in-memory wire and leases.
 * The optional client is never fetched or executed; no real provider proof. */
describe.runIf(existsSync(chrome))("optional account and payment clients supply no inventory or access authority", () => {
  const run = async (client: string, mode: "inventory" | "access" | "payment", kind: "script" | "xhr" = "script") => {
    const html = `<!doctype html><html><body><h1>Example Golf</h1><p id="date">2026-10-23</p><p id="ready">Ready</p>` +
      `<div class="slot"><span class="time">09:00</span><span class="players">4</span></div>` +
      (mode === "access" ? "<p>You must sign in to view availability</p>" : "") +
      '<button id="payment" type="button" onclick="console.log(\'PAYMENT_ACTION_ENTERED\')">Pay now</button>' +
      (kind === "script" ? `<script src="${client}"></script>` :
        `<script>const icons=new XMLHttpRequest();icons.open('GET',${JSON.stringify(client)});icons.send();</script>`) +
      "<script>fetch('/availability?date=2026-10-23')</script></body></html>";
    const fetch = vi.fn(async url => new Response(String(url) === pageUrl ? html : '{"ok":true}',
      { headers: { "content-type": String(url) === pageUrl ? "text/html" : "application/json" } })) as typeof globalThis.fetch;
    const families: string[] = []; let paymentActions = 0;
    const deps: AccessExecutorDependencies = { fetch, now: () => new Date("2026-10-20T12:00:00Z"),
      launchBrowser: async () => {
        const browser = await chromium.launch({ executablePath: chrome, headless: true }), newContext = browser.newContext.bind(browser);
        vi.spyOn(browser, "newContext").mockImplementation(async options => {
          const context = await newContext(options);
          context.on("page", page => page.on("console", message => { if (message.text() === "PAYMENT_ACTION_ENTERED") paymentActions++; }));
          return context;
        });
        return browser;
      },
      requestLease: async (family, work) => { families.push(family); return { acquired: true, value: await work() }; } };
    const selected = recipe();
    if (selected.engine !== "BROWSER_DOM") throw new Error("fixture");
    if (mode === "payment") selected.steps.push({ action: "clickFilter", selector: "#payment", text: "Pay now", purpose: "RUN_SEARCH" });
    const result = await executeAccessRecipe(selected, input, deps);
    if (clients.includes(client)) {
      expect(isSafeRecipeUrl(client)).toBe(false);
      expect(isSafeBrowserAssetUrl(client, "script", "GET")).toBe(false);
    }
    expect(recipeAllowsRequest(selected, client, "GET", "script")).toBe(false);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).not.toContain(client);
    expect(new Set(families)).toEqual(new Set(["example.org"]));
    expect(paymentActions).toBe(0);
    return result;
  };
  it.each(clients)("certifies complete public inventory while denying optional %s without its execution, wire or lease", async client => {
    expect(await run(client, "inventory")).toMatchObject({ status: "AVAILABLE", complete: true,
      slots: [{ startsAt: "2026-10-23T13:00:00.000Z", availableSpots: 4 }] });
  }, 15_000);
  it.each(clients)("retains the access-required outcome for an actual rendered sign-in gate with %s", async client => {
    expect(await run(client, "access")).toMatchObject({ status: "ACCESS_REQUIRED", complete: false, slots: [], evidence: { reason: "ACCESS_REQUIRED" } });
  }, 15_000);
  it.each(clients.slice(1))("refuses an actual payment control even when mislabeled as search with %s", async client => {
    expect(await run(client, "payment")).toMatchObject({ status: "FAILED", complete: false, slots: [], evidence: { reason: "UNSAFE_CONTROL" } });
  }, 15_000);
  it.each([
    ["https://kit.fontawesome.com/7aa4bc216c.js", "script"],
    ["https://ka-p.fontawesome.com/releases/v7.3.1/js/pro-plus.min.js", "script"],
    ["https://ka-p.fontawesome.com/releases/v7.3.1/js/pro-v4-shims.min.js", "xhr"],
  ] as const)("keeps public inventory complete while an unrelated icon client is denied: %s %s", async (client, kind) => {
    expect(await run(client, "inventory", kind)).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 4 }] });
  }, 15_000);
  it("keeps a rendered access gate when an unrelated icon XHR is denied", async () => {
    expect(await run("https://ka-p.fontawesome.com/releases/v7.3.1/js/pro-v4-shims.min.js", "access", "xhr"))
      .toMatchObject({ status: "ACCESS_REQUIRED", complete: false, slots: [] });
  }, 15_000);
});
