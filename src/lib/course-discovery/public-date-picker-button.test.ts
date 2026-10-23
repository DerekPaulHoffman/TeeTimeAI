// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tryOpenPublicDatePickerButton } from "./public-date-picker-button";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const button = (display = "Thu, Oct 22") => `<button id="date"><div>${display}</div><div>Date</div></button>`;
const fixture = (html = button()) => `${html}<output id="opened"></output><script>document.querySelector('#date').onclick=()=>document.querySelector('#opened').textContent='open';</script>`;

describe.runIf(existsSync(chrome))("explicit Date button with a changing public display", () => {
  let browser: Browser, page: Page;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); await page.route("**/*", route => route.abort()); });
  afterAll(async () => { await browser?.close(); });
  it.each(["Thu, Oct 22", "Fri, Oct 23", "Mon, Nov 2", "Sat, Feb 29"])("opens static Date for displayed %s without inferring a full requested date", async display => {
    await page.setContent(fixture(button(display)));
    expect(await tryOpenPublicDatePickerButton(page.locator("#date"), "Date")).toBe(true);
    expect(await page.locator("#opened").textContent()).toBe("open");
  });
  it.each(["Thu, Oct 22 Date", "Choose date", "Calendar", "date"])("does not reinterpret another expected label (%s)", async expected => {
    await page.setContent(fixture());
    expect(await tryOpenPublicDatePickerButton(page.locator("#date"), expected)).toBe(false);
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it("retains the exact two direct DIVs while allowing bounded noninteractive text spans", async () => {
    await page.setContent(fixture(button().replace("<div>Thu, Oct 22</div>", "<div><span>Thu, Oct 22</span></div>")
      .replace("<div>Date</div>", "<div><span>Date</span></div>")));
    expect(await tryOpenPublicDatePickerButton(page.locator("#date"), "Date")).toBe(true);
    expect(await page.locator("#opened").textContent()).toBe("open");
  });
  it.each([
    button("Fri, Feb 30"), button("Fri, Apr 31"), button("Thu, Oct 32"), button("Thu, Oct 0"),
    button("Thursday, October 22"), button("Thu, Oct 22, 2026"), button("10:00 AM"), button("2 Players"),
    button().replace("<div>Date</div>", "<div>Birthdate</div>"),
    button().replace("<div>Date</div>", "<div>Date</div><div>Search</div>"),
    button().replace("<div>Date</div>", "<span>Date</span>"),
    button().replace("<button", '<div role="button"').replace("</button>", "</div>"),
    button().replace('<button id="date">', '<button id="date" aria-label="Choose date">'),
  ])("does not click unrelated tokens, labels or shapes", async html => {
    await page.setContent(fixture(html));
    expect(await tryOpenPublicDatePickerButton(page.locator("#date"), "Date")).toBe(false);
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it.each([
    `<form>${button()}</form>`, `<section aria-label="Login">${button()}</section>`,
    `<section aria-label="dateofbirth">${button()}</section>`, `<section aria-label="DateOfBirth">${button()}</section>`,
    `<section contenteditable="">${button()}</section>`, `<section style="opacity:0">${button()}</section>`,
    `<section hidden>${button()}</section>`, button().replace('id="date"', 'id="date" value="private"'),
    button().replace('id="date"', 'id="date" form="external"'), button().replace('id="date"', 'id="date" role="combobox"'),
    button().replace('<div>Date</div>', '<div aria-label="Contact details">Date</div>'),
    button().replace('<div>Date</div>', '<div aria-hidden="true">Date</div>'),
    button().replace('<div>Date</div>', '<div name="DateOfBirth">Date</div>'),
    button().replace('<div>Date</div>', '<div><span name="DateOfBirth">Date</span></div>'),
    button().replace('<div>Date</div>', '<div><span role="button">Date</span></div>'),
    button().replace('<div>Date</div>', '<div><a href="https://example.org/checkout">Date</a></div>'),
    '<p id="private-label">Birthdate</p>' + button().replace('id="date"', 'id="date" aria-labelledby="private-label"'),
    '<p id="private-label">Customer contact</p>' + button().replace('id="date"', 'id="date" aria-describedby="private-label"'),
    '<p id="private-label">Birthdate</p>' + button().replace('<div>Date</div>', '<div><span aria-labelledby="private-label">Date</span></div>'),
    "<section>".repeat(41) + button() + "</section>".repeat(41),
  ])("keeps private, editable, hidden, form and action contexts unclicked", async html => {
    await page.setContent(fixture(html));
    const opened = await tryOpenPublicDatePickerButton(page.locator("#date"), "Date").catch(() => false);
    expect(opened).toBe(false);
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it("does not read unrelated input values while rejecting private form context", async () => {
    await page.setContent(fixture(`<form><input type="password" value="private">${button()}</form>`));
    await page.locator("input").evaluate(node => Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } }));
    await expect(tryOpenPublicDatePickerButton(page.locator("#date"), "Date")).rejects.toThrow("UNSAFE_CONTROL");
    expect(await page.locator("#opened").textContent()).toBe("");
  });
  it("rechecks the same complete display immediately before clicking", async () => {
    const node = { count: async () => 1, isVisible: async () => true, isEnabled: async () => true,
      evaluate: vi.fn().mockResolvedValueOnce({ label: "Date", displayedDate: "Thu, Oct 22" }).mockResolvedValueOnce({ label: "Date", displayedDate: "Fri, Oct 23" }), click: vi.fn() };
    await expect(tryOpenPublicDatePickerButton(node as never, "Date")).rejects.toThrow("UNSAFE_CONTROL");
    expect(node.click).not.toHaveBeenCalled();
  });
  it("executes the actual tsx keepNames callback in isolated Chromium", async () => {
    const helper = resolve(process.cwd(), "src/lib/course-discovery/public-date-picker-button.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import {tryOpenPublicDatePickerButton as open} from ${JSON.stringify(helper)};
      void open({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,evaluate:async(fn)=>{process.stdout.write(fn.toString());return null}},'Date');`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    expect(serialized).toContain("function datePickerButtonProof");
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    await page.setContent(fixture());
    const callback = new Function(`return (${serialized});`)();
    expect(await page.locator("#date").evaluate(callback)).toEqual({ label: "Date", displayedDate: "Thu, Oct 22" });
  });
});
