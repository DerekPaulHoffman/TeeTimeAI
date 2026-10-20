// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { continuePublicRentalService, inspectPublicRentalService, inspectPublicServiceContinuation,
  isPublicRentalServiceLabel, openPublicRentalService, selectPublicRentalService } from "./public-service-control";

const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe("public rental service classification", () => {
  it.each(["Golf Simulator", "Golf Simulator $30.00", "Simulator Rental 1 hour", "Golf Bay Rental"])("accepts rental product %s", label => {
    expect(isPublicRentalServiceLabel(label)).toBe(true);
  });
  it.each(["Golf Lessons $40.00", "Tournament Fees $50.00", "Golf Simulator Membership", "Member Golf Simulator", "Golf Simulator Package",
    "Golf Simulator 09:00", "Golf Simulator 9am", "Golf Simulator October 23", "Golf Simulator 2026-10-23", "Golf Simulator 10/23",
    "Golf Simulator Payment", "Golf Simulator Checkout", "Golf Simulator Event", "Golf Simulator Lesson"])("rejects non-rental option %s", label => {
    expect(isPublicRentalServiceLabel(label)).toBe(false);
  });
});

describe.runIf(existsSync(chrome))("public rental service controls", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(2000); });
  afterAll(async () => { await browser?.close(); });
  const fixture = (extraOptions = "") => `<div id="widget"><form id="initial"><div id="field"><label for="service">Service:</label>
    <div><span id="selected">Select Service</span><input id="service" type="text" role="combobox" tabindex="0" aria-label="Select Service"
      aria-controls="service-options" aria-haspopup="listbox" aria-expanded="false" readonly></div></div>
    <button id="continue" type="button">Continue</button><div hidden><input type="email"><input type="date"></div></form>
    <ul id="service-options" role="listbox" hidden><li role="option">Golf Lessons $40.00</li><li role="option">Golf Simulator $30.00</li>
      <li role="option">Tournament Fees $50.00</li>${extraOptions}</ul>
    <section id="packages" hidden><p>Hey, there are special packages with this service, check them out!</p><p>Birdie Membership $100.00</p>
      <button type="button" id="skip">Skip packages and continue with the selected service $30.00 - $50.00</button></section>
    <output id="advanced"></output></div><script>
      document.querySelector('#service').onclick=()=>{document.querySelector('#service-options').hidden=false;document.querySelector('#service').setAttribute('aria-expanded','true')};
      document.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{document.querySelector('#selected').textContent=option.textContent.replace(/ \\$[0-9.]+$/,'');document.querySelector('#service-options').hidden=true;document.querySelector('#service').setAttribute('aria-expanded','false')});
      document.querySelector('#continue').onclick=()=>{document.querySelector('#packages').hidden=false;document.querySelector('#continue').hidden=true};
      document.querySelector('#skip').onclick=()=>document.querySelector('#advanced').textContent='calendar';
    </script>`;

  it("shares the observed Amelia-like input/listbox selection and explicit package skip contract", async () => {
    await page.setContent(fixture());
    expect(await inspectPublicRentalService(page.locator("#service"))).toMatchObject({ label: "Service:", selectedText: "Select Service", options: [] });
    await openPublicRentalService(page.locator("#service"));
    expect((await inspectPublicRentalService(page.locator("#service")))?.options).toEqual([{ label: "Golf Simulator $30.00" }]);
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    expect(selected.label).toBe("Golf Simulator");
    expect(await inspectPublicServiceContinuation(page.locator("#skip"), selected, "SKIP_PACKAGES")).toBe(false);
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(true);
    await continuePublicRentalService(page.locator("#continue"), selected, "SERVICE");
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
    expect(await inspectPublicServiceContinuation(page.locator("#skip"), selected, "SKIP_PACKAGES")).toBe(true);
    await continuePublicRentalService(page.locator("#skip"), selected, "SKIP_PACKAGES");
    expect(await inspectPublicServiceContinuation(page.locator("#skip"), selected, "SKIP_PACKAGES")).toBe(false);
    expect(await page.locator("#advanced").innerText()).toBe("calendar");
  });
  it("reaches the genuine label through the captured seven-level ElementPlus service subtree", async () => {
    await page.setContent(fixture());
    await page.locator("#field").evaluate(field => {
      const input = field.querySelector("input")!, selected = field.querySelector("#selected")!, old = input.parentElement!;
      const content = document.createElement("div"); content.className = "el-form-item__content";
      let root = content;
      for (const name of ["am-select-wrapper", "el-select", "el-select__wrapper", "el-select__selection"]) {
        const next = document.createElement("div"); next.className = name; root.append(next); root = next;
      }
      const inputWrapper = document.createElement("div"); inputWrapper.className = "el-select__selected-item el-select__input-wrapper";
      inputWrapper.append(input); root.append(inputWrapper);
      const placeholder = document.createElement("div"); placeholder.className = "el-select__selected-item el-select__placeholder";
      placeholder.append(selected); root.append(placeholder); old.replaceWith(content);
    });
    expect((await inspectPublicRentalService(page.locator("#service")))?.label).toBe("Service:");
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    expect(selected.label).toBe("Golf Simulator");
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(true);
  });
  it("preserves native product selectors and never treats price as duration proof", async () => {
    await page.setContent('<div><form><label for="service">Select Service</label><select id="service"><option>Select Service</option><option value="rental">Golf Simulator $30.00</option></select><button id="continue" type="button">Continue</button></form></div>');
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    expect(selected).toEqual({ label: "Golf Simulator" });
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(true);
  });
  it.each(["Golf Lessons $40.00", "Tournament Fees $50.00", "Golf Simulator Membership", "Golf Simulator 09:00"])("never selects %s", async text => {
    await page.setContent(fixture(`<li role="option">${text}</li>`));
    await expect(selectPublicRentalService(page.locator("#service"), text)).rejects.toThrow("UNSAFE_RENTAL_SERVICE");
    expect(await page.locator("#selected").innerText()).toBe("Select Service");
  });
  it("rejects duplicate rental options rather than selecting one", async () => {
    await page.setContent(fixture('<li role="option">Golf Simulator $30.00</li>'));
    await expect(selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00")).rejects.toThrow("AMBIGUOUS_SERVICE_OPTIONS");
  });
  it("rejects an unrelated already-open listbox", async () => {
    await page.setContent('<ul role="listbox"><li role="option">Golf Simulator</li></ul>' + fixture());
    await expect(openPublicRentalService(page.locator("#service"))).rejects.toThrow("UNOWNED_SERVICE_OPTIONS");
  });
  it.each([
    ['<input type="email">', "contact"], ['<input type="date">', "date"], ['<input name="time" value="09:00">', "slot"], ['<input type="password">', "account"],
  ])("rejects visible %s fields while preserving hidden later wizard fields", async field => {
    await page.setContent(fixture().replace('<button id="continue"', `${field}<button id="continue"`));
    expect(await inspectPublicRentalService(page.locator("#service"))).toBeUndefined();
    await expect(selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00")).rejects.toThrow("UNSAFE_SERVICE_CONTROL");
  });
  it.each(['style="opacity:0"', 'hidden', 'inert', 'aria-hidden="true"'])("rejects a concealed ancestor %s", async attrs => {
    await page.setContent(`<section ${attrs}>${fixture()}</section>`);
    expect(await inspectPublicRentalService(page.locator("#service"))).toBeUndefined();
  });
  it("requires unchanged selected readback and a genuine helper-issued token", async () => {
    await page.setContent(fixture());
    await expect(continuePublicRentalService(page.locator("#continue"), { label: "Golf Simulator" }, "SERVICE")).rejects.toThrow("UNSAFE_SERVICE_CONTINUATION");
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.locator("#selected").evaluate(node => { node.textContent = "Golf Lessons"; });
    await expect(continuePublicRentalService(page.locator("#continue"), selected, "SERVICE")).rejects.toThrow("UNSAFE_SERVICE_CONTINUATION");
  });
  it("rejects a token from a replaced document even if all labels match", async () => {
    await page.setContent(fixture());
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.setContent(fixture().replace('id="selected">Select Service', 'id="selected">Golf Simulator'));
    await expect(continuePublicRentalService(page.locator("#continue"), selected, "SERVICE")).rejects.toThrow("UNSAFE_SERVICE_CONTINUATION");
  });
  it.each(["checkout", "contact", "review", "confirm", "payment", "cart"])("rejects Continue within %s context", async label => {
    await page.setContent(fixture());
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.locator("#widget").evaluate((node, label) => { node.setAttribute("aria-label", label); }, label);
    await expect(continuePublicRentalService(page.locator("#continue"), selected, "SERVICE")).rejects.toThrow("UNSAFE_SERVICE_CONTINUATION");
  });
  it("rejects submit buttons, generic skip, arbitrary Continue and visible time cards", async () => {
    await page.setContent(fixture());
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.locator("#continue").evaluate(node => { node.setAttribute("type", "submit"); });
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
    await page.locator("#continue").evaluate(node => { node.setAttribute("type", "button"); });
    await page.locator("#widget").evaluate(node => { node.insertAdjacentHTML("beforeend", '<button type="button">09:00</button>'); });
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SKIP_PACKAGES")).toBe(false);
  });
  it.each([
    '<div role="grid"><span role="gridcell">23</span></div>',
    '<div class="calendar"><h2>October 2026</h2></div>',
    '<div><h2>October 2026</h2><button>1</button><button>2</button><button>3</button><button>4</button><button>5</button><button>6</button><button>7</button></div>',
    '<article data-slot-id="slot">Selected appointment</article>',
  ])("rejects a visible calendar or selected appointment sibling %s", async surface => {
    await page.setContent(fixture());
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.locator("#widget").evaluate((node, html) => { node.insertAdjacentHTML("beforeend", html); }, surface);
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
  });
  it("rejects a competing Continue and transaction-labelled action", async () => {
    await page.setContent(fixture());
    const selected = await selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00");
    await page.locator("#widget").evaluate(node => { node.insertAdjacentHTML("beforeend", '<button id="foreign" type="button">Continue</button>'); });
    expect(await inspectPublicServiceContinuation(page.locator("#foreign"), selected, "SERVICE")).toBe(false);
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
    await page.locator("#foreign").evaluate(node => { node.remove(); });
    await page.locator("#continue").evaluate(node => { node.setAttribute("aria-label", "Checkout"); });
    expect(await inspectPublicServiceContinuation(page.locator("#continue"), selected, "SERVICE")).toBe(false);
  });
  it.each(["Checkout", "Payment", "Contact", "Account", "Review", "Confirm"])("rejects a service inside labelled %s grandparent before interaction", async label => {
    await page.setContent(`<section aria-label="${label}">${fixture()}</section>`);
    expect(await inspectPublicRentalService(page.locator("#service"))).toBeUndefined();
    await expect(selectPublicRentalService(page.locator("#service"), "Golf Simulator $30.00")).rejects.toThrow("UNSAFE_SERVICE_CONTROL");
    expect(await page.locator("#service").getAttribute("aria-expanded")).toBe("false");
  });
  it("rejects an exact owned listbox portalled into a checkout-labelled ancestor", async () => {
    await page.setContent(fixture());
    await page.locator("#service-options").evaluate(menu => { const host = document.createElement("section"); host.setAttribute("aria-label", "Checkout"); menu.before(host); host.append(menu); });
    await expect(openPublicRentalService(page.locator("#service"))).rejects.toThrow("UNOWNED_SERVICE_OPTIONS");
    expect(await page.locator("#service").getAttribute("aria-expanded")).toBe("false");
  });
  it.each(['<optgroup disabled><option>Golf Simulator</option></optgroup>', '<option hidden>Golf Simulator</option>', '<option style="display:none">Golf Simulator</option>'])("does not offer disabled or hidden native rentals %s", async option => {
    await page.setContent(`<form><label for="service">Service:</label><select id="service"><option>Select Service</option>${option}</select><button type="button">Continue</button></form>`);
    expect((await inspectPublicRentalService(page.locator("#service")))?.options).toEqual([]);
    await expect(selectPublicRentalService(page.locator("#service"), "Golf Simulator")).rejects.toThrow("UNOBSERVED_RENTAL_SERVICE");
  });
});
