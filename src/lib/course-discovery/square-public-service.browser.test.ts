// @vitest-environment node
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { inspectPublicRentalProduct, selectPublicRentalProduct } from "./public-product-control";
import { inspectSquareRentalNext, continueSquareRental, inspectSquareRentalVariantElement, inspectSquareAvailabilityScope } from "./square-public-service-control";
import { inspectSquarePublicDateElement } from "./square-public-date-control";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const executablePath = [chromium.executablePath(), "C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const catalog = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/services";
const source = `${catalog}/${"A".repeat(24)}`;
const endpoint = "https://app.squareup.com/appointments/api/buyer/availability";
const body = { search_availability_request: { query: { filter: { location_id: "LOC1234567890",
  start_at_range: { start_at: "2030-01-06T00:00:00.000Z", end_at: "2030-02-05T00:00:00.000Z" },
  segment_filters: [{ service_variation_id: "B".repeat(24), team_member_id_filter: { any: ["public-team-1234"] } }],
} } } };
const responseStart = Date.parse("2030-01-11T10:00:00Z") / 1000;
const publicMonthResponse = JSON.stringify({ staff_ids: ["public-team-1234"], resources: {}, availability: [0, 3600].map(offset => ({ start: responseStart + offset, end: responseStart + offset + 3300, available: true, staff_id: "public-team-1234", segments: [{ start: responseStart + offset, end: responseStart + offset + 3300, resource_token: null, employee_token: "private-transient-value" }] })) });
const service = `<section aria-label="Main content"><h2>Golf Simulator Room</h2><market-header id="options"><h3>Options</h3><h3 slot="compact">Options</h3></market-header>
  <market-list role="listbox" aria-labelledby="options"><market-row role="option" aria-selected="true" selected><label slot="label">Regular</label><div slot="subtext">$50.00・55 min</div></market-row></market-list>
  <market-button type="button" id="add">Add</market-button></section>`;
const summary = `<div><div data-testid="desktop-cart"><h2>Appointment summary</h2><div data-testid="service-staff-row"><span>Golf Simulator Room</span><span>Regular</span><div>$50.00</div></div></div><market-button type="button" id="next">Next</market-button></div>`;
const week = `<div data-testid="weekview-date-picker"><h2>Jan 2030</h2><div data-testid="present-week">${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) =>
  `<market-button type="button" aria-pressed="${index === 0}" data-day="${index + 6}"><div aria-label="${day}">${day.slice(0, 3)}</div><div> ${index + 6} </div></market-button>`).join("")}</div></div>`;
const inventory = `<h1 id="venue">Public simulator fixture</h1><p id="date">2030-01-06</p><div data-testid="availability-page"><section aria-label="Main content">${week}<div id="slots" data-testid="availability-segments"></div><span id="empty">false</span></section><aside><div data-testid="desktop-cart"><div data-testid="service-staff-row"><span class="resource-name">Golf Simulator Room</span><span>Regular</span></div></div></aside><div data-testid="mobile-cart" hidden><div data-testid="service-staff-row"><span class="resource-name">Golf Simulator Room</span><span>Regular</span></div></div></div>`;
const html = `<html><head><meta charset="utf-8"><style>market-button,market-list,market-row{display:block}</style></head><body>${service}<script>
  customElements.define('market-button',class extends HTMLElement{connectedCallback(){if(!this.shadowRoot)this.attachShadow({mode:'open'}).innerHTML='<button type="button"><slot></slot></button>';}});
  customElements.define('market-header',class extends HTMLElement{connectedCallback(){if(!this.shadowRoot)this.attachShadow({mode:'open'}).innerHTML='<slot></slot>';}});
  fetch('https://cdn.cookielaw.org/consent/12345678-1234-1234-1234-123456789abc/12345678-1234-1234-1234-123456789abc.json').catch(()=>{});
  fetch('https://app.squareup.com/1.0/features/get-flags',{method:'POST',headers:{'content-type':'application/json'},body:'{"feature":"optional"}'}).catch(()=>{});
  document.getElementById('add').addEventListener('click',()=>{history.pushState({},'',${JSON.stringify(catalog)});document.body.innerHTML=${JSON.stringify(summary)};
    document.getElementById('next').addEventListener('click',()=>{history.pushState({},'',${JSON.stringify(catalog.replace(/services$/u, "availability"))});document.body.innerHTML=${JSON.stringify(inventory)};
      fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(body))}}).then(r=>r.json()).then(()=>{
        document.body.insertAdjacentHTML('beforeend','<span id="loaded">true</span>');
        for(const day of document.querySelectorAll('[data-day]'))day.addEventListener('click',()=>{document.getElementById('date').textContent='2030-01-'+day.dataset.day;
          document.getElementById('slots').innerHTML='<div role="list" aria-label="Available time slots, Morning, select a time to proceed"><market-button type="button" role="listitem" data-testid="time-slot">10:00 AM</market-button></div><div role="list" aria-label="Available time slots, Afternoon, select a time to proceed"><market-button type="button" role="listitem" data-testid="time-slot">11:00 AM</market-button></div>';});
      });
    });
  });
</script></body></html>`;
const fetcher = (payload = body) => vi.fn(async value => new Response(String(value) === source ? html.replace(JSON.stringify(JSON.stringify(body)), JSON.stringify(JSON.stringify(payload))) : publicMonthResponse, { headers: {
  "content-type": String(value) === source ? "text/html" : "application/json", "access-control-allow-origin": "https://book.squareup.com",
  "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type",
} })) as unknown as typeof fetch;
const unselectedHtml = html.replace('aria-selected="true" selected', 'aria-selected="false"').replace("document.getElementById('add').addEventListener", `document.querySelector('market-row').addEventListener('click',event=>{event.currentTarget.setAttribute('aria-selected','true');event.currentTarget.setAttribute('selected','');});document.getElementById('add').addEventListener`);

describe.skipIf(!executablePath)("public Square service stages", () => {
  it("serializes public predicates through the actual worker tsx compiler", () => {
    const serviceFile = resolve(process.cwd(), "src/lib/course-discovery/square-public-service-control.ts"), dateFile = resolve(process.cwd(), "src/lib/course-discovery/square-public-date-control.ts");
    const serialized = JSON.parse(execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import { inspectSquareRentalAddElement, inspectSquareRentalNext, inspectSquareRentalVariantElement, squarePublicControlSelector } from ${JSON.stringify(serviceFile)}; import { inspectSquarePublicDateElement } from ${JSON.stringify(dateFile)}; process.stdout.write(JSON.stringify([inspectSquareRentalAddElement,inspectSquareRentalNext,inspectSquareRentalVariantElement,squarePublicControlSelector,inspectSquarePublicDateElement].map(fn=>fn.toString())));`],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 100_000 })) as string[];
    for (const fn of serialized) { expect(fn).not.toMatch(/\b__name\s*\(/u); expect(() => new Function(`return (${fn});`)()).not.toThrow(); }
  }, 30_000);
  it.each([true, false])("replays only when the cached month covers the requested date, agent disabled: %s", async coversDate => {
    const payload = structuredClone(body);
    if (!coversDate) payload.search_availability_request.query.filter.start_at_range.end_at = "2030-01-07T00:00:00.000Z";
    const fetch = vi.fn(async (value: unknown) => {
      const response = await fetcher(payload)(value as string);
      return String(value) === source ? new Response((await response.text()).replace('aria-selected="true" selected', 'aria-selected="false"').replace("document.getElementById('add').addEventListener", `document.querySelector('market-row').addEventListener('click',event=>{event.currentTarget.setAttribute('aria-selected','true');event.currentTarget.setAttribute('selected','');});document.getElementById('add').addEventListener`), { headers: response.headers }) : response;
    }) as unknown as typeof globalThis.fetch;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", target: { kind: "SIMULATOR", courseId: "course-1", offeringId: "offering-1" },
      source: { venueName: "Public simulator fixture", officialUrl: source, bookingUrl: catalog, timeZone: "UTC", providerFamily: "SQUARE" }, pageUrl: source,
      permittedRoutes: [{ origin: "https://book.squareup.com", path: new URL(source).pathname, methods: ["GET"], queryKeys: [] },
        { origin: "https://book.squareup.com", path: new URL(catalog).pathname, methods: ["GET"], queryKeys: [] },
        { origin: "https://book.squareup.com", path: new URL(catalog.replace(/services$/u, "availability")).pathname, methods: ["GET"], queryKeys: [] },
        { origin: "https://app.squareup.com", path: new URL(endpoint).pathname, methods: ["POST"], queryKeys: [] }],
      availabilityResponse: { kind: "SQUARE_PUBLIC_MONTH", url: endpoint, method: "POST", date: { source: "JSON_BODY", path: "search_availability_request.query.filter.start_at_range.start_at", format: "SQUARE_PUBLIC_MONTH_RANGE" }, endDatePath: "search_availability_request.query.filter.start_at_range.end_at" },
      steps: [{ action: "selectProduct", productSelector: 'section[aria-label="Main content"]', selector: 'market-row[role="option"]' },
        { action: "selectProduct", productSelector: 'section[aria-label="Main content"]', selector: "#add button" },
        { action: "continueToAvailability", selector: "#next button", mode: "SQUARE_SERVICE" }, { action: "waitFor", selector: "#loaded" },
        { action: "selectDateChoice", selector: '[data-testid="present-week"] market-button button' }],
      proof: { venue: { selector: "#venue" }, date: { selector: "#date" }, complete: { availabilityResponse: true }, empty: { selector: "#empty" } },
      slots: { scope: { selector: '[data-testid="availability-page"]', label: { selector: '[data-testid="desktop-cart"] .resource-name' }, expectedLabel: "Golf Simulator Room" }, collection: { selector: '[data-testid="time-slot"]' }, startsAt: { selector: ":scope" }, endsAt: { derive: "ADD_REQUESTED_DURATION" } } });
    const result = await executeAccessRecipe(recipe, { date: "2030-01-11", timeZone: "UTC", players: 2, durationMinutes: 55, startTime: "09:00", endTime: "18:00" }, {
      fetch, launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    expect(result, JSON.stringify(result)).toMatchObject(coversDate ? { status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-01-11T10:00:00.000Z", endsAt: "2030-01-11T10:55:00.000Z" }, { startsAt: "2030-01-11T11:00:00.000Z", endsAt: "2030-01-11T11:55:00.000Z" }] } : { status: "INCOMPLETE", complete: false, slots: [] });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(args => String(args[0]) === endpoint)).toHaveLength(1);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(args => String(args[0]).includes("/features/get-flags") || String(args[0]).includes("cdn.cookielaw.org"))).toBe(false);
  }, 75_000);

  it("revalidates an unselected public variant without granting a continuation", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage(); await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: unselectedHtml })); await page.goto(source);
      const option = page.locator('market-row[role="option"]'), card = page.locator('section[aria-label="Main content"]'), add = page.locator("#add button");
      expect(await inspectPublicRentalProduct(add)).toBeUndefined();
      expect(await option.evaluate(inspectSquareRentalVariantElement)).toMatchObject({ squareVariant: true, durationMinutes: 55, option: "Regular" });
      await expect(selectPublicRentalProduct(option, card, 60)).rejects.toThrow("UNSAFE_PRODUCT_SELECTION");
      for (const mutation of ["event", "duplicate", "hidden", "form", "date", "handler"]) {
        await page.goto(source);
        await option.evaluate((node, kind) => {
          if (kind === "event") node.querySelector("label")!.textContent = "Charity event";
          if (kind === "duplicate") node.parentElement!.append(node.cloneNode(true));
          if (kind === "hidden") node.setAttribute("hidden", "");
          if (kind === "form") node.parentElement!.insertAdjacentHTML("beforeend", "<form></form>");
          if (kind === "date") node.setAttribute("data-start-time", "2030-01-11T10:00:00Z");
          if (kind === "handler") node.setAttribute("onclick", "void 0");
        }, mutation);
        expect(await inspectPublicRentalProduct(option.first())).toBeUndefined();
      }
      await page.goto(source);
      expect(await selectPublicRentalProduct(option, card, 55)).toBeUndefined();
      expect(await inspectPublicRentalProduct(add)).toMatchObject({ squareService: true, durationMinutes: 55 });
      expect(await selectPublicRentalProduct(option, card, 55)).toBeUndefined();
      expect(await inspectSquareRentalNext(add, undefined)).toBe(false);
    } finally { await browser.close(); }
  }, 75_000);

  it("exposes only the proved Add and subsequent Next to discovery", async () => {
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source], deadlineAt: new Date(Date.now() + 60_000) }, {
      fetch: fetcher(), launchBrowser: () => chromium.launch({ executablePath, headless: true }), requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      const first = await session.execute({ id: 1, action: "open", url: source });
      const add = first.controls.find(control => control.kind === "product" && control.name === "Add");
      expect(add).toBeDefined();
      const summary = await session.execute({ id: 2, action: "click", target: add!.target });
      const next = summary.controls.find(control => control.name === "Next" && control.kind === "service-continuation");
      expect(next).toBeDefined();
      const calendar = await session.execute({ id: 3, action: "click", target: next!.target });
      expect(calendar.controls.some(control => control.name === "Date 2030-01-11")).toBe(true);
    } finally { await session.close(); }
  }, 75_000);

  it("rejects forged continuation, foreign documents, edited service, event variant and calendar/customer controls", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage(); await page.route("**/*", route => route.fulfill(route.request().url() === endpoint ? {
        contentType: "application/json", body: '{"available":true}', headers: { "access-control-allow-origin": "https://book.squareup.com", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" },
      } : { contentType: "text/html", body: html })); await page.goto(source);
      const add = page.locator("#add button"), card = page.locator('section[aria-label="Main content"]');
      expect(await inspectPublicRentalProduct(add)).toMatchObject({ durationMinutes: 55 });
      for (const label of ["Member rate", "Charity tournament", "", "Regular $100"]) {
        await page.locator('label[slot="label"]').evaluate((n, value) => n.textContent = value, label);
        expect(await inspectPublicRentalProduct(add)).toBeUndefined();
      }
      await page.locator('label[slot="label"]').evaluate(n => n.textContent = "Regular");
      await expect(selectPublicRentalProduct(add, card, 60)).rejects.toThrow("UNSAFE_PRODUCT_SELECTION");
      await page.locator('label[slot="label"]').evaluate(n => n.textContent = "Charity tournament");
      expect(await inspectPublicRentalProduct(add)).toBeUndefined();
      await page.locator('label[slot="label"]').evaluate(n => n.textContent = "Regular");
      const selected = await selectPublicRentalProduct(add, card, 55);
      const next = page.locator("#next button");
      expect(await inspectSquareRentalNext(next, { label: "Golf Simulator Room" })).toBe(false);
      expect(await inspectSquareRentalNext(next, selected)).toBe(true);
      const row = page.locator('[data-testid="service-staff-row"]');
      await row.locator("span").first().evaluate(n => n.textContent = "Other Simulator Room");
      expect(await inspectSquareRentalNext(next, selected)).toBe(false);
      await row.locator("span").first().evaluate(n => n.textContent = "Golf Simulator Room");
      await page.locator("body").evaluate(n => n.insertAdjacentHTML("beforeend", '<input type="email">'));
      expect(await inspectSquareRentalNext(next, selected)).toBe(false);
      await page.locator('input[type="email"]').evaluate(n => n.remove());
      await continueSquareRental(next, selected);
      await page.locator("#loaded").waitFor();
      const friday = page.locator('[data-day="11"] button');
      expect(await friday.evaluate(inspectSquarePublicDateElement)).toMatchObject({ date: "2030-01-11" });
      await friday.click();
      const availability = page.locator('[data-testid="availability-page"]');
      const publicLabel = '[data-testid="desktop-cart"] .resource-name';
      expect(await inspectSquareAvailabilityScope(availability, selected, publicLabel, '[data-testid="time-slot"]', 55)).toBe(true);
      expect(await inspectSquareAvailabilityScope(availability, selected, ".resource-name", '[data-testid="time-slot"]', 55)).toBe(false);
      expect(await inspectSquareAvailabilityScope(availability, { label: "Golf Simulator Room" }, ".resource-name", '[data-testid="time-slot"]', 55)).toBe(false);
      expect(await inspectSquareAvailabilityScope(availability, selected, publicLabel, '[data-testid="time-slot"]:nth-of-type(2)', 55)).toBe(false);
      expect(await inspectSquareAvailabilityScope(availability, selected, ".resource-name", '[data-testid="time-slot"]', 60)).toBe(false);
      await page.locator('[data-testid="desktop-cart"] [data-testid="service-staff-row"] span').last().evaluate(n => n.textContent = "Charity event");
      expect(await inspectSquareAvailabilityScope(availability, selected, publicLabel, '[data-testid="time-slot"]', 55)).toBe(false);
      await page.locator('[data-day="11"] div[aria-label]').evaluate(n => n.setAttribute("aria-label", "Thursday"));
      expect(await friday.evaluate(inspectSquarePublicDateElement)).toBeUndefined();
      await page.goto(source.replace("LOC1234567890", "OTH1234567890"));
      expect(await inspectSquareRentalNext(page.locator("#add button"), selected)).toBe(false);
    } finally { await browser.close(); }
  }, 75_000);
});
