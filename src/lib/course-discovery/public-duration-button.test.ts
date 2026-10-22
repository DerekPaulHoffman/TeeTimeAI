// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inspectPublicDurationButton, observedPublicDurationButtons, selectPublicDurationButton } from "./public-duration-button";
import { selectPublicFilter } from "./public-filter-control";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const fixture = () => `<div><div><div><button id="duration"><div id="value">1 hr</div><div>duration</div></button></div></div></div>
 <section id="menu" hidden><h2>SELECT DESIRED DURATION</h2><div>
 <button id="sr-selectdesiredduration-3" aria-label="1 hr">1 hr</button><button id="sr-selectdesiredduration-4" aria-label="2 hr">2 hr</button>
 <button id="sr-selectdesiredduration-5" aria-label="3 hr">3 hr</button><button id="sr-selectdesiredduration-6" aria-label="4 hr">4 hr</button>
 </div></section><output id="selected"></output><script>
 document.querySelector('#duration').onclick=()=>{document.querySelector('#menu').hidden=false;};
 document.querySelectorAll('#menu button').forEach(button=>button.onclick=()=>{document.querySelector('#value').textContent=button.textContent;document.querySelector('#selected').textContent=button.textContent;document.querySelector('#menu').hidden=true});
 </script>`;

describe.runIf(existsSync(chrome))("shared labelled duration-button filter", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); });
  afterAll(async () => { await browser?.close(); });
  it("exposes the actual button as a duration filter and reuses it for changed requested minutes", async () => {
    await page.setContent(fixture());
    const found = await observedPublicDurationButtons(page);
    expect(found).toHaveLength(1); expect(found[0].proof).toMatchObject({ purpose: "DURATION", label: "duration", minutes: 60 });
    for (const value of ["60", "120"]) {
      await selectPublicFilter(page.locator("#duration"), { value, purpose: "DURATION", simulator: true });
      expect((await inspectPublicDurationButton(page.locator("#duration")))?.minutes).toBe(Number(value));
      expect(await page.locator("#menu").isVisible()).toBe(false);
    }
  });
  it("keeps actual keepNames-compiled callbacks portable through serialized browser evaluation", async () => {
    const source = readFileSync(new URL("./public-duration-button.ts", import.meta.url), "utf8");
    const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "node22", keepNames: true }).code;
    const compiledModule = { exports: {} as typeof import("./public-duration-button") };
    new Function("module", "exports", compiled)(compiledModule, compiledModule.exports);
    await page.setContent(fixture());
    await compiledModule.exports.selectPublicDurationButton(page.locator("#duration"), "120");
    expect(await page.locator("#value").innerText()).toBe("2 hr");
  });
  it.each([
    fixture().replace("<div>duration</div>", "<div>Checkout</div>"),
    fixture().replace('<button id="duration">', '<button id="duration"><input type="email" value="PRIVATE_SENTINEL">'),
    `<form>${fixture()}</form>`,
    `<form id="private"></form>${fixture().replace('id="duration"', 'id="duration" form="private"')}`,
    `<section contenteditable="true">${fixture()}</section>`,
    `<section contenteditable="">${fixture()}</section>`,
    `<section contenteditable="plaintext-only">${fixture()}</section>`,
    `<section id="paymentDetails">${fixture()}</section>`,
    `<section id="birthdate">${fixture()}</section>`,
    `<section><h2>Date of birth</h2>${fixture()}</section>`,
    fixture().replace("<div>duration</div>", "<div>duration</div><div>Book now</div>"),
  ])("never exposes sensitive, editable, transaction or unlabelled openers", async html => {
    await page.setContent(html); expect(await observedPublicDurationButtons(page)).toEqual([]);
    await expect(selectPublicDurationButton(page.locator("#duration"), "60")).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#selected").innerText()).toBe("");
  });
  it.each([
    fixture().replace('id="menu" hidden', 'id="menu"'),
    fixture().replace('</section><output', '</section><section><h2>Select duration</h2><button>1 hr</button><button>2 hr</button></section><output'),
  ])("rejects a pre-existing foreign duration menu before clicking", async html => {
    await page.setContent(html);
    await expect(selectPublicDurationButton(page.locator("#duration"), "60")).rejects.toThrow("UNOWNED_DURATION_MENU");
    expect(await page.locator("#selected").innerText()).toBe("");
  });
  it.each([
    fixture().replace('aria-label="2 hr">2 hr', 'aria-label="1 hr">1 hr'),
    fixture().replace('aria-label="2 hr">2 hr', 'aria-label="Book">Book'),
    fixture().replace('aria-label="2 hr">2 hr', 'aria-label="10:00">10:00'),
    fixture().replace('aria-label="2 hr">2 hr', 'aria-label="60 guests">60 guests'),
    fixture().replace('aria-label="2 hr">2 hr', 'aria-label="2 hr membership">2 hr membership'),
    fixture().replace("SELECT DESIRED DURATION", "SELECT DESIRED LENGTH"),
    fixture().replace('id="menu" hidden', 'id="menu" aria-label="Checkout" hidden'),
    fixture().replace('<h2>SELECT DESIRED DURATION</h2>', '<h2>SELECT DESIRED DURATION</h2><input value="PRIVATE_SENTINEL">'),
    fixture().replace('<h2>SELECT DESIRED DURATION</h2>', '<h2>SELECT DESIRED DURATION</h2><p>Checkout</p>'),
    fixture().replace('<section id="menu" hidden>', '<form id="menu" hidden>').replace('</section>', '</form>'),
    fixture().replace('id="sr-selectdesiredduration-3"', 'id="sr-selectdesiredduration-3" form="external"') + '<form id="external"></form>',
    fixture().replace('id="duration"', 'id="duration" aria-controls="unrelated"'),
  ])("rejects ambiguous or unowned menus without clicking a duration choice", async html => {
    await page.setContent(html);
    await expect(selectPublicDurationButton(page.locator("#duration"), "60")).rejects.toThrow();
    expect(await page.locator("#selected").innerText()).toBe("");
  });
  it("requires selected opener readback and menu closure", async () => {
    for (const html of [fixture().replace("document.querySelector('#value').textContent=button.textContent;", ""),
      fixture().replace("document.querySelector('#menu').hidden=true", "document.querySelector('#menu').hidden=false")]) {
      await page.setContent(html);
      await expect(selectPublicDurationButton(page.locator("#duration"), "120")).rejects.toThrow("DURATION_SELECTION_UNCONFIRMED");
    }
  });
  it("rejects stale opener replacement and an unoffered duration", async () => {
    await page.setContent(fixture().replace("document.querySelector('#menu').hidden=false;", "document.querySelector('#menu').hidden=false;document.querySelector('#duration').outerHTML=document.querySelector('#duration').outerHTML;"));
    await expect(selectPublicDurationButton(page.locator("#duration"), "120")).rejects.toThrow("STALE_DURATION_CONTROL");
    await page.setContent(fixture());
    await expect(selectPublicDurationButton(page.locator("#duration"), "90")).rejects.toThrow("AMBIGUOUS_DURATION_MENU");
  });
});
