import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { observedPublicDropdowns, selectPublicDropdown } from "./public-dropdown-control";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const fixture = '<div><div>Duration</div><div><div id="duration" tabindex="0"><span id="value">Any</span><svg aria-label="Chevron Down"></svg></div></div></div><div id="portal"></div>' +
  '<script>document.querySelector("#duration").onclick=()=>{document.querySelector("#portal").innerHTML=`<div data-testid="dropdown-select-30" tabindex="0">30 Min</div><div data-testid="dropdown-select-60" tabindex="0">1 Hr</div>`;document.querySelectorAll("#portal>div").forEach(n=>n.onclick=()=>{document.querySelector("#value").textContent=n.textContent;document.querySelector("#portal").innerHTML=""})}</script>';
describe.runIf(existsSync(executablePath))("verified public labelled dropdowns", () => {
  async function run(html: string, task: (page: import("@playwright/test").Page) => Promise<void>) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try { const page = await browser.newPage(); await page.setContent(html); await task(page); } finally { await browser.close(); }
  }
  it("selects exact observed duration and confirms the original field readback", async () => {
    await run(fixture, async page => {
      const controls = await observedPublicDropdowns(page);
      expect(controls).toHaveLength(1); expect(controls[0].proof).toMatchObject({ purpose: "DURATION", label: "Duration", text: "Any" });
      await selectPublicDropdown(controls[0].locator, { purpose: "DURATION", value: "60", simulator: true });
      expect(await page.locator("#value").innerText()).toBe("1 Hr");
    });
  });
  it("reads compound hours and minutes without treating ranges as one option", async () => {
    await run(fixture.replaceAll('1 Hr', '1 Hr 30 Min'), async page => {
      await selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "90", simulator: true });
      expect(await page.locator("#value").innerText()).toBe("1 Hr 30 Min");
    });
    await run(fixture.replaceAll('1 Hr', '1 Hr-3 Hrs'), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("UNSAFE_CONTROL_VALUE");
    });
  });
  it.each([fixture.replace('>Duration<', '>Checkout<'), `<form><input type="email">${fixture}</form>`, fixture.replace('tabindex="0"', '')])("does not expose ambiguous or transaction fields", async html => {
    await run(html, async page => { expect(await observedPublicDropdowns(page)).toEqual([]); });
  });
  it("rejects a time-slot option before clicking it", async () => {
    await run(fixture.replace('>1 Hr<', '>Reserve 10:00<'), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("UNSAFE_CONTROL_VALUE");
      expect(await page.locator("#value").innerText()).toBe("Any");
    });
  });
  it("rejects duplicate visible option values and unoffered durations", async () => {
    await run(fixture.replace('>30 Min<', '>1 Hr<'), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    });
    await run(fixture, async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "90", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    });
  });
  it("rejects a pre-existing foreign menu even when the field already has the desired value", async () => {
    await run(fixture.replace('>Any<', '>1 Hr<') + '<div data-testid="dropdown-select-foreign">1 Hr</div>', async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("UNOWNED_FILTER_OPTIONS");
    });
  });
  it.each(["", ' aria-label="Checkout"'])("does not merge detached single-option groups or transaction ancestors: %s", async context => {
    await run(fixture.replace('<div data-testid="dropdown-select-30" tabindex="0">30 Min</div><div data-testid="dropdown-select-60" tabindex="0">1 Hr</div>', '<section><div data-testid="dropdown-select-30">30 Min</div></section><section><div data-testid="dropdown-select-60">1 Hr</div></section>').replace('id="portal"', `id="portal"${context}`), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    });
  });
  it("honors an explicit aria-controls menu binding", async () => {
    await run(fixture.replace('id="duration"', 'id="duration" aria-controls="different-menu"'), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    });
  });
  it("rejects a transaction ancestor above an otherwise valid option group", async () => {
    await run(fixture.replace('<div id="portal"></div>', '<section aria-label="Checkout"><div id="portal"></div></section>'), async page => {
      await expect(selectPublicDropdown(page.locator("#duration"), { purpose: "DURATION", value: "60", simulator: true })).rejects.toThrow("AMBIGUOUS_CONTROL");
    });
  });
});
