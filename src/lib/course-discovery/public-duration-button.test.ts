// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inspectPublicDurationButton, inspectPublicMenuButton, observedPublicDurationButtons, observedPublicMenuButtons, selectPublicDurationButton, selectPublicMenuButton } from "./public-duration-button";
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
// The measured public menus contain three empty non-tabbable leaf buttons
// before four choices and two afterward. They are never option targets.
const sourceBackedFixture = () => fixture().replace("<h2>SELECT DESIRED DURATION</h2><div>",
  '<div tabindex="0">SELECT DESIRED DURATION</div><div><div><button tabindex="-1"></button></div><div><button tabindex="-1"></button></div><div><button tabindex="-1"></button></div>')
  .replace('</div></section>', '<div><button tabindex="-1"></button></div><div><button tabindex="-1"></button></div></div></section>')
  .replace(/(<button id="sr-selectdesiredduration-[3-6]"[^>]*>[^<]+<\/button>)/gu, '<div>$1</div>')
  .replace("document.querySelectorAll('#menu button')", "document.querySelectorAll('#menu button[aria-label]')")
  .replace('</script>', "document.querySelectorAll('#menu button[tabindex=\"-1\"]').forEach(button=>button.onclick=()=>document.querySelector('#selected').textContent='AUXILIARY_CLICKED');</script>");
const participantFixture = () => sourceBackedFixture().replace('id="value">1 hr', 'id="value">2')
  .replace('<div>duration</div>', '<div>Players</div>').replace('SELECT DESIRED DURATION', 'SELECT DESIRED PARTY SIZE')
  .replace(/aria-label="([1-4]) hr">[1-4] hr/gu, 'aria-label="$1">$1');

describe.runIf(existsSync(chrome))("shared labelled duration-button filter", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); });
  afterAll(async () => { await browser?.close(); });
  it("selects the actual source-backed menu without clicking its five raw-empty non-tabbable leaf buttons", async () => {
    await page.setContent(sourceBackedFixture());
    await selectPublicFilter(page.locator("#duration"), { value: "120", purpose: "DURATION", simulator: true });
    expect(await page.locator("#selected").innerText()).toBe("2 hr");
    expect(await page.locator("#menu").isVisible()).toBe(false);
  });
  it("uses the same safe interpreter for offered participant values and preserves the simulator one-bay fence", async () => {
    await page.setContent(participantFixture());
    expect((await observedPublicMenuButtons(page)).map(found => found.proof.purpose)).toEqual(["PLAYERS"]);
    await expect(selectPublicFilter(page.locator("#duration"), { value: "3", purpose: "PLAYERS", simulator: true })).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#menu").isVisible()).toBe(false);
    for (const value of ["2", "3"]) {
      await selectPublicFilter(page.locator("#duration"), { value, purpose: "PLAYERS", simulator: false });
      expect(await inspectPublicMenuButton(page.locator("#duration"), "PLAYERS")).toMatchObject({ purpose: "PLAYERS", players: Number(value) });
      expect(await page.locator("#selected").innerText()).toBe(value);
      expect(await page.locator("#menu").isVisible()).toBe(false);
    }
  });
  it.each([
    ['tabbable', '<button tabindex="0"></button>'],
    ['whitespace text', '<button tabindex="-1"> </button>'],
    ['whitespace aria label', '<button tabindex="-1" aria-label=" "></button>'],
    ['over-80 aria label', `<button tabindex="-1" aria-label="${"x".repeat(81)}"></button>`],
    ['over-80 title', `<button tabindex="-1" title="${"x".repeat(81)}"></button>`],
    ['value even empty', '<button tabindex="-1" value=""></button>'],
    ['data value', '<button tabindex="-1" data-value="3"></button>'],
    ['name', '<button tabindex="-1" name="action"></button>'],
    ['content', '<button tabindex="-1" content=""></button>'],
    ['sensitive attribute', '<button tabindex="-1" data-token="PRIVATE_SENTINEL"></button>'],
    ['accessible referenced label', '<button tabindex="-1" aria-labelledby="elsewhere"></button>'],
    ['nested content', '<button tabindex="-1"><span></span></button>'],
  ])("does not omit unknown auxiliary-looking controls: %s", async (_name, button) => {
    await page.setContent(sourceBackedFixture().replace('<button tabindex="-1"></button>', button));
    await expect(selectPublicDurationButton(page.locator("#duration"), "120")).rejects.toThrow();
    expect(await page.locator("#selected").innerText()).toBe("");
  });
  it.each([
    participantFixture().replace('aria-label="3">3', 'aria-label="4">3'),
    participantFixture().replace('aria-label="3">3', 'aria-label="3" tabindex="-1">3'),
    participantFixture().replace('aria-label="3">3', 'aria-label="2">2'),
    participantFixture().replace('SELECT DESIRED PARTY SIZE', 'SELECT A TEE TIME'),
    participantFixture().replace('aria-label="3">3', 'aria-label="Book">Book'),
    `<form>${participantFixture()}</form>`,
    `<section contenteditable="true">${participantFixture()}</section>`,
  ])("rejects unsafe or ambiguous participant menu ownership and choices", async html => {
    await page.setContent(html);
    await expect(selectPublicMenuButton(page.locator("#duration"), "3", "PLAYERS")).rejects.toThrow();
    expect(await page.locator("#selected").innerText()).toBe("");
  });
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
    await page.setContent(participantFixture());
    await compiledModule.exports.selectPublicMenuButton(page.locator("#duration"), "3", "PLAYERS");
    expect(await page.locator("#value").innerText()).toBe("3");
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
