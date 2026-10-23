import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { inspectPublicDateChoiceElement, observedPublicDateChoices, parsePublicDateChoice, selectPublicDateChoice } from "./public-date-choice";

const grid = (extra = "") => `<div id="dates"><button id="selected">Oct 23, 2026<br>\nFriday</button><button>Oct 24, 2026<br>\nSaturday</button>${extra}</div>`;
const labelledGrid = (extra = "") => '<section><h2>THU, OCT 22, 2026</h2><button disabled>Previous month</button><button disabled>Next month</button>' +
  '<table role="grid"><tbody><tr><td role="gridcell"><button id="selected" aria-label="Fri, Oct 23, 2026">23</button></td>' +
  `<td role="gridcell"><button aria-label="Sat, Oct 24, 2026">24</button></td></tr>${extra}</tbody></table></section>`;
const presentationTable = () => '<section><h2>October 2026</h2><table role="presentation"><tbody>' +
  '<tr><th>SUN</th><th>MON</th><th>TUE</th><th>WED</th><th>THU</th><th>FRI</th><th>SAT</th></tr>' +
  '<tr><td aria-label="">18</td><td aria-label="">19</td><td aria-label="">20</td><td aria-label="">21</td>' +
  '<td role="button" tabindex="0" aria-label="Thursday, October 22nd 2026, Available">22</td>' +
  '<td id="selected" role="button" tabindex="0" aria-label="Friday, October 23rd 2026, Available">23</td>' +
  '<td role="button" tabindex="0" aria-label="Saturday, October 24th 2026, Available">24</td></tr></tbody></table></section>';
function inspect(html: string) { document.body.innerHTML = html; return inspectPublicDateChoiceElement(document.querySelector("#selected")!); }
describe("full-date public calendar choices", () => {
  beforeEach(() => { vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, toJSON: () => ({}) }); });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  it("proves the year and weekday from the Lightspeed public day grid", () => { expect(inspect(grid())).toEqual({ date: "2026-10-23" }); });
  it.each(["Fri, Oct 23, 2026", "Friday, October 23, 2026", "Friday October 23 2026", "October 23, 2026 Friday"])
    ("parses a complete explicit date with a verified weekday: %s", value => { expect(parsePublicDateChoice(value)).toBe("2026-10-23"); });
  it.each(["Thu, Oct 23, 2026", "Friday, Oct 23", "Fri, Feb 30, 2026", "Fri, Oct 23, 2026 12:00", "Fri, Oct 23, 2026 Reserve", "x".repeat(101)])
    ("rejects false or unbounded prefixed date labels: %s", value => { expect(parsePublicDateChoice(value)).toBeUndefined(); });
  it("proves nested numeric choices from exact aria dates without a full month-year heading", () => {
    expect(inspect(labelledGrid())).toEqual({ date: "2026-10-23" });
  });
  it("proves actual presentation calendar TD date cells without native buttons or ARIA grid roles", () => {
    expect(inspect(presentationTable())).toEqual({ date: "2026-10-23" });
    expect(parsePublicDateChoice("Friday, October 23rd 2026, Available")).toBe("2026-10-23");
  });
  it.each([
    "Sunday, November 1st 2026, Available", "Monday, November 2nd 2026, Available", "Tuesday, November 3rd 2026, Available",
    "Wednesday, November 4th 2026, Available", "Wednesday, November 11th 2026, Available", "Thursday, November 12th 2026, Available",
    "Friday, November 13th 2026, Available", "Saturday, November 21st 2026, Available", "Sunday, November 22nd 2026, Available",
    "Monday, November 23rd 2026, Available", "Saturday, October 31st 2026, Available",
  ])("validates the exact public ordinal and weekday grammar: %s", label => { expect(parsePublicDateChoice(label)).toMatch(/^2026-\d{2}-\d{2}$/u); });
  it.each([
    "Friday, October 23th 2026, Available", "Thursday, October 23rd 2026, Available", "Friday, October 23rd 2026, Unavailable",
    "Friday, October 23rd 2026, Available 12:00", "Friday, October 23rd 2026, Available Reserve", "Friday, October 23rd, Available",
    "Fri, October 23rd 2026, Available", "Friday, Oct 23rd 2026, Available", "Friday, October 23rd 2026, available",
    "Friday, November 13rd 2026, Available", "Friday, February 30th 2026, Available",
  ])("rejects broadened or invalid public ordinal labels: %s", label => { expect(parsePublicDateChoice(label)).toBeUndefined(); });
  it.each([
    presentationTable().replace('role="presentation"', 'role="grid"'),
    presentationTable().replace('id="selected" role="button"', 'id="selected" role="cell"'),
    presentationTable().replace('id="selected" role="button" tabindex="0"', 'id="selected" role="button" tabindex="1"'),
    presentationTable().replace('id="selected"', 'id="selected" aria-disabled="true"'),
    presentationTable().replace('id="selected"', 'id="selected" disabled'),
    presentationTable().replace('id="selected"', 'id="selected" hidden'),
    presentationTable().replace('role="presentation"', 'role="presentation" style="opacity:0"'),
    presentationTable().replace('Friday, October 23rd 2026, Available', 'Thursday, October 23rd 2026, Available'),
    presentationTable().replace('Friday, October 23rd 2026, Available', 'Friday, October 23th 2026, Available'),
    presentationTable().replace('Friday, October 23rd 2026, Available', 'Friday, October 23rd 2026, Unavailable'),
    presentationTable().replace('>23</td>', '>24</td>'),
    presentationTable().replace('Saturday, October 24th 2026, Available', 'Friday, October 23rd 2026, Available').replace('>24</td>', '>23</td>'),
    presentationTable().replace('Saturday, October 24th 2026, Available', 'Saturday, October 31st 2026, Available').replace('>24</td>', '>31</td>'),
    presentationTable().replace('<th>FRI</th>', '<th>THU</th>'),
    presentationTable().replace('<th>SUN</th>', '<td>SUN</td>'),
    presentationTable().replace('Saturday, October 24th 2026, Available', 'Saturday, October 24th 2026, Reserve'),
    presentationTable().replace('Saturday, October 24th 2026, Available', ''),
    presentationTable().replace('>24</td>', '><span>24</span></td>'),
    presentationTable().replace('id="selected"', 'id="selected" form="private"'),
    presentationTable().replace('<td aria-label="">18</td>', '<td aria-label=""><input type="email"></td>'),
    presentationTable().replace('<td aria-label="">18</td>', '<td aria-label=""><a href="/booking">18</a></td>'),
    presentationTable().replace('<td aria-label="">18</td>', '<td aria-label="" contenteditable="true">18</td>'),
    presentationTable().replace('<td aria-label="">18</td>', '<td aria-label="" title="dateofbirth">18</td>'),
    presentationTable().replace('role="button" tabindex="0" aria-label="Saturday', 'role="button" tabindex="0" title="dateOfBirth" aria-label="Saturday'),
    `<form>${presentationTable()}</form>`, `<section aria-label="Account">${presentationTable()}</section>`,
    `<section title="Payment">${presentationTable()}</section>`, `<section name="dateofbirth">${presentationTable()}</section>`,
    presentationTable().replace('<td aria-label="">18</td>', '<td aria-label="">Reserve 18</td>'),
    presentationTable().replace('>24</td>', '>24</td><td>25</td>'),
  ])("rejects noncalendar, malformed, ambiguous, unavailable or private presentation tables", html => { expect(inspect(html)).toBeUndefined(); });
  it("does not read private input values while rejecting presentation-table fields", () => {
    document.body.innerHTML = presentationTable().replace('<td aria-label="">18</td>', '<td><input type="text" name="dateofbirth"></td>');
    const value = vi.spyOn(HTMLInputElement.prototype, "value", "get").mockImplementation(() => { throw new Error("PRIVATE_VALUE_READ"); });
    expect(inspectPublicDateChoiceElement(document.querySelector("#selected")!)).toBeUndefined();
    expect(value).not.toHaveBeenCalled();
  });
  it.each(["", "true", "plaintext-only"])("rejects an inherited editable presentation-calendar wrapper: %s", editable => {
    expect(inspect(`<section contenteditable="${editable}">${presentationTable()}</section>`)).toBeUndefined();
  });
  it.each([
    labelledGrid().replace('aria-label="Fri, Oct 23, 2026"', 'aria-label="Thu, Oct 23, 2026"'),
    labelledGrid().replace('aria-label="Fri, Oct 23, 2026"', 'aria-label="Fri, Oct 23"'),
    labelledGrid().replace('>23</button>', '>22</button>'),
    labelledGrid().replace('aria-label="Fri, Oct 23, 2026"', ""),
    labelledGrid().replace('role="grid"', 'class="calendar"'),
    labelledGrid().replaceAll('role="gridcell"', ""),
    labelledGrid().replace('id="selected"', 'id="selected" disabled'),
    labelledGrid().replace('id="selected"', 'id="selected" title="Reserve"'),
    `${labelledGrid().replace('id="selected"', 'id="selected" form="checkout"')}<form id="checkout"><input type="email"></form>`,
    labelledGrid().replace('id="selected"', 'id="selected" form="future"'),
    `${labelledGrid().replace('aria-label="Sat, Oct 24, 2026"', 'form="checkout" aria-label="Sat, Oct 24, 2026"')}<form id="checkout"></form>`,
    labelledGrid().replace('role="grid"', 'role="grid" hidden'),
    labelledGrid().replace('role="grid"', 'role="grid" aria-disabled="true"'),
    `<form>${labelledGrid()}</form>`,
    `<section aria-label="Checkout">${labelledGrid()}</section>`,
    labelledGrid('<tr><td><input type="email"></td></tr>'),
    labelledGrid('<tr><td><button>12:00 Reserve</button></td></tr>'),
    labelledGrid('<tr><td role="gridcell"><button aria-label="Fri, Oct 23, 2026">23</button></td></tr>'),
    labelledGrid().replace('<td role="gridcell"><button aria-label="Sat, Oct 24, 2026">24</button></td>', ""),
    labelledGrid().replace('aria-label="Sat, Oct 24, 2026"', 'aria-label="Oct 24, 2026 Monday"'),
  ])("rejects malformed, mismatched, non-grid and sensitive numeric calendar choices", html => { expect(inspect(html)).toBeUndefined(); });
  it.each(["Oct 23 Friday", "Oct 23, 2026 Monday", "Feb 30, 2026", "Oct 23, 2026 Friday 12:00", "Oct 23, 2026 $40", "Oct 23, 2026 Reserve"])
    ("rejects ambiguous, malformed, time or product text %s", text => { expect(parsePublicDateChoice(text)).toBeUndefined(); });
  it.each([grid().replace('id="selected"', 'id="selected" disabled'), grid().replace('id="dates"', 'id="dates" style="opacity:0"'),
    `<form>${grid()}</form>`, `<section aria-label="Checkout">${grid()}</section>`, grid('<input type="email">'), grid('<button>Oct 23, 2026 Friday</button>'),
    grid('<button>12:00</button>'), '<div><button id="selected">Oct 23, 2026 Friday</button></div>'])
    ("rejects hidden, noncalendar, duplicate and sensitive choices", html => { expect(inspect(html)).toBeUndefined(); });
  it("rejects native external form submission for the original flat date mode too", () => {
    expect(inspect(`${grid().replace('id="selected"', 'id="selected" form="checkout"')}<form id="checkout"></form>`)).toBeUndefined();
  });
  it.each(["Date of birth", "Birthday", "DOB", "Account", "Membership"])("rejects a private %s date context in both modes", label => {
    expect(inspect(`<section aria-label="${label}">${labelledGrid()}</section>`)).toBeUndefined();
    expect(inspect(`<section aria-label="${label}">${grid()}</section>`)).toBeUndefined();
  });
  it("performs browser detail reads only for matching full-date text", async () => {
    const node = { evaluate: vi.fn(async () => ({ date: "2026-10-23" })), click: vi.fn() };
    const candidates = { count: async () => 1000, evaluateAll: vi.fn(async () => Array.from({ length: 1000 }, (_, index) => ({ index,
      text: index === 999 ? "Oct 23, 2026 Friday" : "Unrelated control" }))), nth: vi.fn(() => node) };
    await selectPublicDateChoice({ locator: () => candidates } as unknown as Page, "button", "2026-10-23");
    expect(candidates.evaluateAll).toHaveBeenCalledTimes(1);
    expect(candidates.nth).toHaveBeenCalledExactlyOnceWith(999);
    expect(node.evaluate).toHaveBeenCalledTimes(2);
    expect(node.click).toHaveBeenCalledTimes(1);
  });
  it("prefilters observed and selected numeric choices by aria then revalidates DOM before click", async () => {
    const node = { evaluate: vi.fn(async () => ({ date: "2026-10-23" })), click: vi.fn() };
    const candidates = { count: async () => 2, evaluateAll: vi.fn(async () => [{ index: 0, text: "23", ariaLabel: "Fri, Oct 23, 2026" },
      { index: 1, text: "24", ariaLabel: "Sat, Oct 24, 2026" }]), nth: vi.fn(() => node) };
    const page = { locator: () => candidates } as unknown as Page;
    await selectPublicDateChoice(page, "button", "2026-10-23");
    expect(candidates.nth).toHaveBeenCalledExactlyOnceWith(0);
    expect(node.evaluate).toHaveBeenCalledTimes(2); expect(node.click).toHaveBeenCalledTimes(1);
    const observedCandidates = { evaluateAll: vi.fn(async () => [0]), nth: vi.fn(() => node) };
    expect(await observedPublicDateChoices({ locator: () => observedCandidates } as unknown as Page)).toEqual([{ locator: node, date: "2026-10-23" }]);
  });
  it("does not click a date choice that changes after matching", async () => {
    const node = { evaluate: vi.fn().mockResolvedValueOnce({ date: "2026-10-23" }).mockResolvedValueOnce(undefined), click: vi.fn() };
    const candidates = { count: async () => 1, evaluateAll: async () => [{ index: 0, text: "23", ariaLabel: "Fri, Oct 23, 2026" }], nth: () => node };
    await expect(selectPublicDateChoice({ locator: () => candidates } as unknown as Page, "button", "2026-10-23")).rejects.toThrow("AMBIGUOUS_DATE_CHOICE");
    expect(node.click).not.toHaveBeenCalled();
  });
  it("attests only the native fully validated date button's exact pressed state", () => {
    expect(inspect(grid().replace('id="selected"', 'id="selected" aria-pressed="true"'))).toEqual({ date: "2026-10-23", alreadySelected: true });
    for (const value of ["false", "TRUE", "1", ""])
      expect(inspect(grid().replace('id="selected"', `id="selected" aria-pressed="${value}"`))).toEqual({ date: "2026-10-23" });
    expect(inspect(presentationTable().replace('id="selected"', 'id="selected" aria-pressed="true"'))).toEqual({ date: "2026-10-23" });
  });
  it("runs an optional synchronous callback after same-handle proof and clicks only that handle", async () => {
    const order: string[] = [];
    const handle = { evaluate: vi.fn(async () => ({ date: "2026-10-23", alreadySelected: true })),
      click: vi.fn(async () => { order.push("click"); }), dispose: vi.fn() };
    const node = { evaluate: vi.fn(async () => ({ date: "2026-10-23" })), elementHandle: vi.fn(async () => handle), click: vi.fn() };
    const candidates = { count: async () => 1, evaluateAll: async () => [{ index: 0, text: "Oct 23, 2026 Friday" }], nth: () => node };
    await selectPublicDateChoice({ locator: () => candidates } as unknown as Page, "button", "2026-10-23", proof => {
      expect(proof).toEqual({ date: "2026-10-23", alreadySelected: true }); order.push("callback");
    });
    expect(order).toEqual(["callback", "click"]); expect(node.click).not.toHaveBeenCalled(); expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it("cannot carry or click when the captured date handle loses its final proof", async () => {
    const handle = { evaluate: vi.fn(async () => undefined), click: vi.fn(), dispose: vi.fn() };
    const node = { evaluate: vi.fn(async () => ({ date: "2026-10-23" })), elementHandle: vi.fn(async () => handle), click: vi.fn() };
    const candidates = { count: async () => 1, evaluateAll: async () => [{ index: 0, text: "Oct 23, 2026 Friday" }], nth: () => node };
    const callback = vi.fn();
    await expect(selectPublicDateChoice({ locator: () => candidates } as unknown as Page, "button", "2026-10-23", callback)).rejects.toThrow("AMBIGUOUS_DATE_CHOICE");
    expect(callback).not.toHaveBeenCalled(); expect(handle.click).not.toHaveBeenCalled(); expect(node.click).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
  it("rejects a duplicate requested date in the final callback-scoped same-handle proof", () => {
    document.body.innerHTML = grid().replace('id="selected"', 'id="selected" aria-pressed="true"') + grid();
    expect(inspectPublicDateChoiceElement(document.querySelector("#selected")!, { selector: "button", date: "2026-10-23" })).toBeUndefined();
  });
});

describe.runIf(existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"))("serialized presentation calendar", () => {
  it("uses actual tsx keepNames serialization for calendar discovery and fresh selection", async () => {
    const helper = resolve(process.cwd(), "src/lib/course-discovery/public-date-choice.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import { inspectPublicDateChoiceElement } from ${JSON.stringify(helper)}; process.stdout.write(inspectPublicDateChoiceElement.toString());`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    const compiled = new Function(`return (${serialized});`)() as typeof inspectPublicDateChoiceElement;
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage();
    let network = 0;
    await page.route("**/*", async route => { network++; await route.abort(); });
    try {
      await page.setContent(presentationTable());
      expect(await page.locator("#selected").evaluate(compiled)).toEqual({ date: "2026-10-23" });
      expect((await observedPublicDateChoices(page)).map(choice => choice.date)).toEqual(["2026-10-22", "2026-10-23", "2026-10-24"]);
      await selectPublicDateChoice(page, 'td[role="button"][tabindex="0"]', "2026-10-23");
      await page.locator("#selected").evaluate(node => node.setAttribute("aria-label", "Thursday, October 23rd 2026, Available"));
      expect(await page.locator("#selected").evaluate(compiled)).toBeUndefined();
      await expect(selectPublicDateChoice(page, 'td[role="button"][tabindex="0"]', "2026-10-23")).rejects.toThrow("AMBIGUOUS_DATE_CHOICE");
      expect(network).toBe(0);
    } finally { await browser.close(); }
  });
});
