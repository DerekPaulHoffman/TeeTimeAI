// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { followPublicAvailabilityLink } from "./public-navigation-control";
import { observedPublicDateChoices, selectPublicDateChoice } from "./public-date-choice";

let browser: Browser;
let page: Page;
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
describe("public link execution", () => {
  beforeAll(async () => { browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome, headless: true } : { headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); });
  afterAll(async () => { await browser?.close(); });
  const fixture = '<a id="next" href="https://example.org/date?duration=60">Next</a><output></output><script>document.querySelector("#next").onclick=event=>{event.preventDefault();document.querySelector("output").textContent="client navigation";};</script>';
  it("preserves the public client navigation handler rather than reloading the href", async () => {
    await page.setContent(fixture);
    await followPublicAvailabilityLink(page.locator("#next"), "Next", url => url === "https://example.org/date?duration=60");
    expect(await page.locator("output").textContent()).toBe("client navigation");
    expect(page.url()).toBe("about:blank");
  });
  it.each([fixture.replace('id="next"', 'id="next" style="opacity:0"'), `<div inert>${fixture}</div>`,
    `<form><input type="email">${fixture}</form>`, fixture.replace('id="next"', 'id="next" target="_blank"')])
    ("rejects hidden, contact and separate-context links", async html => {
      await page.setContent(html);
      await expect(followPublicAvailabilityLink(page.locator("#next"), "Next", () => true)).rejects.toThrow("UNSAFE_PUBLIC_LINK");
      expect(await page.locator("output").textContent()).toBe("");
    });
  it("rejects changed labels and unadmitted destinations before clicking", async () => {
    await page.setContent(fixture);
    await expect(followPublicAvailabilityLink(page.locator("#next"), "Continue", () => true)).rejects.toThrow("UNSAFE_PUBLIC_LINK");
    await expect(followPublicAvailabilityLink(page.locator("#next"), "Next", () => false)).rejects.toThrow("UNSAFE_PUBLIC_LINK");
    expect(await page.locator("output").textContent()).toBe("");
  });
  it("selects changed dates from the same full-year public grid without clicking a time", async () => {
    await page.setContent('<div><button>Oct 23, 2026<br>Friday</button><button>Oct 24, 2026<br>Saturday</button></div><output></output><script>document.querySelectorAll("button").forEach(button=>button.onclick=()=>document.querySelector("output").textContent=button.innerText);</script>');
    expect((await observedPublicDateChoices(page)).map(choice => choice.date)).toEqual(["2026-10-23", "2026-10-24"]);
    for (const date of ["2026-10-23", "2026-10-24"]) {
      await selectPublicDateChoice(page, "button", date);
      expect(await page.locator("output").textContent()).toContain(date.endsWith("23") ? "Friday" : "Saturday");
    }
    await expect(selectPublicDateChoice(page, "button", "2026-10-25")).rejects.toThrow("AMBIGUOUS_DATE_CHOICE");
  });
});
