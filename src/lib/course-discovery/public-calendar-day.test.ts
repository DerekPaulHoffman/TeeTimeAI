import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { isObservedPublicCalendarDay, observedPublicCalendarDays } from "./public-calendar-day";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const weekdays = '<div>Mo Tu We Th Fr Sa Su</div>';
const fixture = `<div data-testid="variable-week-calendar"><h3>October 2030</h3>${weekdays}<div>
  <div><div aria-label="2030-10-22 AvailabilityLoaded" data-testid="calendar-day-2030-10-22"><span>22</span></div></div>
  <div><div aria-label="2030-10-23 AvailabilityLoaded" data-testid="calendar-day-2030-10-23"><span>23</span></div></div>
  </div></div><output id="selected"></output><script>document.querySelectorAll('[data-testid^="calendar-day-"]').forEach(node=>node.onclick=()=>document.querySelector('#selected').textContent=node.getAttribute('aria-label'))</script>`;

describe.runIf(existsSync(executablePath))("proved public div/span calendar dates", () => {
  async function withPage(html: string, run: (page: import("@playwright/test").Page) => Promise<void>) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try { const page = await browser.newPage(); await page.setContent(html); await run(page); } finally { await browser.close(); }
  }
  it("returns one canonical control per date despite nested numeric wrappers", async () => {
    await withPage(fixture, async page => {
      const days = await observedPublicCalendarDays(page);
      expect(days.map(day => day.date)).toEqual(["2030-10-22", "2030-10-23"]);
      expect(await days[1].locator.getAttribute("data-testid")).toBe("calendar-day-2030-10-23");
      expect(await isObservedPublicCalendarDay(days[1].locator, "2030-10-23")).toBe(true);
      await days[1].locator.click();
      expect(await page.locator("#selected").innerText()).toBe("2030-10-23 AvailabilityLoaded");
      await page.locator("h3").evaluate(node => { node.textContent = "November 2030"; });
      expect(await isObservedPublicCalendarDay(days[1].locator, "2030-10-23")).toBe(false);
    });
  });
  it("supports a visible native month select and year input in a Flatpickr calendar", async () => {
    await withPage(`<div class="flatpickr-calendar"><select><option>October</option></select><input class="cur-year" type="number" value="2030">${weekdays}<span class="flatpickr-day" aria-label="October 23, 2030">23</span></div>`, async page => {
      expect((await observedPublicCalendarDays(page)).map(day => day.date)).toEqual(["2030-10-23"]);
    });
  });
  it("rejects duplicate controls for the same visible date", async () => {
    await withPage(fixture.replace('</h3>', '</h3><div data-testid="calendar-day-2030-10-23">23</div>'), async page => {
      expect((await observedPublicCalendarDays(page)).map(day => day.date)).toEqual(["2030-10-22"]);
    });
  });
  it.each([
    fixture.replace('October 2030', 'October'),
    fixture.replace(weekdays, ''),
    fixture.replace('variable-week-calendar', 'product-options'),
    `<form><input type="email">${fixture}</form>`,
    fixture.replaceAll('AvailabilityLoaded', 'Reserve 10:00'),
    fixture.replaceAll('data-testid="calendar-day-', 'aria-disabled="true" data-testid="calendar-day-'),
  ])("rejects unproven, non-calendar, sensitive and disabled controls", async html => {
    await withPage(html, async page => { expect(await observedPublicCalendarDays(page)).toEqual([]); });
  });
});
