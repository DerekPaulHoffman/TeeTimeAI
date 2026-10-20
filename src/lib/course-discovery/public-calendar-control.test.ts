import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { observedCalendarMonth, selectPublicCalendarDate } from "./public-calendar-control";

it("requires a complete observed calendar month and year", () => {
  expect(observedCalendarMonth("October 2026")).toBe(2026 * 12 + 9);
  expect(observedCalendarMonth("October")).toBeUndefined();
  expect(observedCalendarMonth("Oct 2026")).toBeUndefined();
  expect(observedCalendarMonth("October 2026 {{year}}")).toBeUndefined();
});
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executablePath))("bounded public calendar navigation", () => {
  const controls = { monthYearSelector: "#month", nextSelector: "#next", previousSelector: "#previous", daySelector: "button.day" };
  const fixture = '<div class="MuiDateCalendar-root"><p id="month">October 2026</p><button id="previous" aria-label="Previous month">&lt;</button><button id="next" aria-label="Next month">&gt;</button><button class="day">22</button><button class="day">23</button></div>' +
    '<output id="selected"></output><script>let current=new Date(Date.UTC(2026,9,1)); const render=()=>document.querySelector("#month").textContent=current.toLocaleString("en-US",{month:"long",year:"numeric",timeZone:"UTC"}); document.querySelector("#next").onclick=()=>{current.setUTCMonth(current.getUTCMonth()+1);render()};document.querySelector("#previous").onclick=()=>{current.setUTCMonth(current.getUTCMonth()-1);render()};document.querySelectorAll("button.day").forEach(button=>button.onclick=()=>document.querySelector("#selected").textContent=document.querySelector("#month").textContent+" "+button.textContent);</script>';
  async function withPage(html: string, run: (page: import("@playwright/test").Page) => Promise<void>) {
    const browser = await chromium.launch({ executablePath, headless: true });
    try { const page = await browser.newPage(); await page.setContent(html); await run(page); } finally { await browser.close(); }
  }
  it.each([["2026-11-22", "November 2026 22"], ["2027-01-23", "January 2027 23"], ["2026-09-22", "September 2026 22"]])("selects %s from actual adjacent month observations", async (date, expected) => {
    await withPage(fixture, async page => { await selectPublicCalendarDate(page, { ...controls, date }); expect(await page.locator("#selected").innerText()).toBe(expected); });
  });
  it("rejects missing year, unexpected jumps and more than twelve months", async () => {
    await withPage(fixture.replace("October 2026", "October"), page => expect(selectPublicCalendarDate(page, { ...controls, date: "2026-11-22" })).rejects.toThrow("CALENDAR_MONTH_UNPROVEN"));
    await withPage(fixture.replace("getUTCMonth()+1", "getUTCMonth()+2"), page => expect(selectPublicCalendarDate(page, { ...controls, date: "2026-11-22" })).rejects.toThrow("CALENDAR_MONTH_DID_NOT_ADVANCE"));
    await withPage(fixture, page => expect(selectPublicCalendarDate(page, { ...controls, date: "2027-11-22" })).rejects.toThrow("CALENDAR_MONTH_LIMIT"));
  });
  it("rejects duplicate visible day numbers", async () => {
    await withPage(fixture.replace('<button class="day">23</button>', '<button class="day">22</button>'), page =>
      expect(selectPublicCalendarDate(page, { ...controls, date: "2026-10-22" })).rejects.toThrow("AMBIGUOUS_CALENDAR_CONTROL"));
  });
});
