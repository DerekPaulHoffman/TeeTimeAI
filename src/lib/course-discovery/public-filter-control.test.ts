// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { selectPublicFilter } from "./public-filter-control";

let browser: Browser;
let page: Page;
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe("public custom filter selection", () => {
  beforeAll(async () => { browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); });
  afterAll(async () => { await browser?.close(); });
  const fixture = (extra = "") => `<div><label id="label">Duration</label><div id="filter" role="combobox" aria-labelledby="label" tabindex="0">Duration</div></div>
    <ul id="options" hidden><li role="option" data-value="60">1 hour</li><li role="option" data-value="120">2 hours</li>${extra}</ul>
    <output id="selected"></output><script>
    document.querySelector('#filter').onclick=()=>document.querySelector('#options').hidden=false;
    document.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>document.querySelector('#selected').textContent=option.dataset.value);
    </script>`;
  it("selects the requested duration through observed option values with the same control", async () => {
    await page.setContent(fixture());
    for (const value of ["60", "120"]) {
      await selectPublicFilter(page.locator("#filter"), { value, purpose: "DURATION", simulator: true });
      expect(await page.locator("#selected").textContent()).toBe(value);
    }
  });
  it("rejects duplicate values instead of selecting the first", async () => {
    await page.setContent(fixture('<li role="option" data-value="60">1 hour</li>'));
    await expect(selectPublicFilter(page.locator("#filter"), { value: "60", purpose: "DURATION", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    expect(await page.locator("#selected").textContent()).toBe("");
  });
  it("ignores a hidden option from another filter", async () => {
    await page.setContent('<div hidden role="option" data-value="60">60 guests</div>' + fixture());
    await selectPublicFilter(page.locator("#filter"), { value: "60", purpose: "DURATION", simulator: true });
    expect(await page.locator("#selected").textContent()).toBe("60");
  });
  it.each([
    fixture().replace('id="label">Duration', 'id="label">Book now'),
    fixture().replace('data-value="60">1 hour', 'data-value="60">Pay now'),
    `<form><input type="email">${fixture()}</form>`,
    fixture().replace('data-value="60">1 hour', 'data-value="60">2 hours'),
  ])("rejects unsafe or inconsistent custom controls", async html => {
    await page.setContent(html);
    await expect(selectPublicFilter(page.locator("#filter"), { value: "60", purpose: "DURATION", simulator: true })).rejects.toThrow(/UNSAFE_CONTROL/u);
    expect(await page.locator("#selected").textContent()).toBe("");
  });
  it("preserves native date selects and prevents simulator party quantity from becoming bays", async () => {
    await page.setContent('<select id="native"><option value="2026-10-22">22</option><option value="2026-10-23">23</option></select>');
    await selectPublicFilter(page.locator("#native"), { value: "2026-10-23", purpose: "DATE", simulator: false });
    expect(await page.locator("#native").inputValue()).toBe("2026-10-23");
    await expect(selectPublicFilter(page.locator("#native"), { value: "2", purpose: "PLAYERS", simulator: true })).rejects.toThrow("UNSAFE_CONTROL");
  });
});
