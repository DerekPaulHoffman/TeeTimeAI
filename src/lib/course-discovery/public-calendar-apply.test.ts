import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { applyPublicCalendarDate, isPublicCalendarApply } from "./public-calendar-apply";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const picker = (options: { month?: string; selected?: number; prefix?: string; suffix?: string } = {}) =>
  `<section role="dialog">${options.prefix ?? ""}<h2>${options.month ?? "October 2026"}</h2><div role="grid">` +
  Array.from({ length: 7 }, (_, i) => i + 20).map(day => `<button role="gridcell" id="day${day}" aria-selected="${day === (options.selected ?? 23)}">${day}</button>`).join("") +
  `</div><button id="apply" onclick="this.dataset.clicked='true'">Apply</button>${options.suffix ?? ""}</section>`;

describe.runIf(existsSync(executablePath))("public calendar Apply boundary", () => {
  it("requires a real visible date grid and the same currently selected requested day", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(picker());
      expect(await isPublicCalendarApply(page.locator("#apply"))).toBe(true);
      await applyPublicCalendarDate(page.locator("#apply"), { day: page.locator("#day23"), date: "2026-10-23" });
      expect(await page.locator("#apply").getAttribute("data-clicked")).toBe("true");
      expect(await isPublicCalendarApply(page.locator("#apply"), { day: page.locator("#day22"), date: "2026-10-22" })).toBe(false);
      expect(await isPublicCalendarApply(page.locator("#apply"), { day: page.locator("#day23"), date: "2026-11-23" })).toBe(false);
      await page.setContent(picker() + '<div><button id="other" aria-selected="true">23</button></div>');
      expect(await isPublicCalendarApply(page.locator("#apply"), { day: page.locator("#other"), date: "2026-10-23" })).toBe(false);
    } finally { await browser.close(); }
  });

  it("rejects cart, generic dialog, contact form, hidden grid and unproven year", async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    try {
      for (const html of [
        '<div role="dialog"><h2>Options</h2><button id="apply">Apply</button></div>',
        picker({ prefix: "<h3>Cart total</h3>" }),
        picker({ suffix: '<input type="email">' }),
        `<form><input type="tel">${picker()}</form>`,
        picker().replace('<div role="grid">', '<div role="grid" style="display:none">'),
        picker({ month: "October" }),
      ]) {
        await page.setContent(html);
        expect(await isPublicCalendarApply(page.locator("#apply"))).toBe(false);
      }
      await page.setContent(picker().replace(">Apply</button>", ">Apply payment</button>"));
      expect(await isPublicCalendarApply(page.locator("#apply"))).toBe(false);
    } finally { await browser.close(); }
  });
});
