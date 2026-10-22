// @vitest-environment node
// In-memory DOM and real local Chrome only; every network request is denied.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectPublicDatePickerInput, inspectPublicDatePickerInputElement, openPublicDatePickerInput } from "./public-date-picker-input";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const input = '<input id="date" type="text" readonly placeholder="Choose date" aria-haspopup="dialog" value="Thu, Oct 22, 2026">';
describe.runIf(existsSync(executablePath))("public readonly date-picker input", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath, headless: true }); });
  afterAll(async () => { await browser?.close(); });
  async function withPage(html: string, run: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    let network = 0;
    await page.route("**/*", async route => { network++; await route.abort(); });
    try { await page.setContent(html); await run(page); expect(network).toBe(0); }
    finally { await page.close(); }
  }
  it("evaluates the actual tsx keepNames serialization without module scope", async () => {
    const helper = resolve(process.cwd(), "src/lib/course-discovery/public-date-picker-input.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import { inspectPublicDatePickerInputElement } from ${JSON.stringify(helper)}; process.stdout.write(inspectPublicDatePickerInputElement.toString());`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    // Recreate only this trusted local helper so Playwright serializes it with
    // no enclosing module helpers, as the actual tsx browser process does.
    const compiled = new Function(`return (${serialized});`)() as typeof inspectPublicDatePickerInputElement;
    await withPage(input, async page => {
      expect(await page.locator("#date").evaluate(compiled)).toEqual({ label: "Choose date", currentValue: "Thu, Oct 22, 2026" });
    });
    await withPage(input.replace("readonly", 'readonly name="dateofbirth"'), async page => {
      await page.locator("#date").evaluate(node => { Object.defineProperty(node, "value", { get() { throw new Error("PRIVATE_VALUE_READ"); } }); });
      expect(await page.locator("#date").evaluate(compiled)).toBeUndefined();
    });
  });
  it("uses the observed placeholder and exact current value without provider ids/classes or date inference", async () => {
    await withPage(input, async page => {
      const node = page.locator("input");
      expect(await inspectPublicDatePickerInput(node)).toEqual({ label: "Choose date", currentValue: "Thu, Oct 22, 2026" });
      await page.evaluate(() => { document.querySelector("input")!.addEventListener("click", () => {
        const calendar = document.createElement("div"); calendar.setAttribute("role", "dialog"); calendar.textContent = "October 2026"; document.body.append(calendar);
      }); });
      await openPublicDatePickerInput(node, { label: "Choose date", currentValue: "Thu, Oct 22, 2026" });
      expect(await page.getByRole("dialog").innerText()).toBe("October 2026");
      expect(await node.inputValue()).toBe("Thu, Oct 22, 2026");
    });
  });
  it.each([
    ['aria-label="Calendar"', "Calendar"],
    ['aria-labelledby="date-label"', "Choose day"],
    ["", "Date"],
  ])("accepts observed semantic labels: %s", async (attributes, expectedLabel) => {
    const label = attributes ? '<span id="date-label">Choose day</span>' : '<label for="date">Date</label>';
    await withPage(label + input.replace('placeholder="Choose date"', attributes), async page => {
      expect(await inspectPublicDatePickerInput(page.locator("input"))).toEqual({ label: expectedLabel, currentValue: "Thu, Oct 22, 2026" });
    });
  });
  it.each(["", "2026-10-22", "10/22/2026", "22 October 2026"])("returns bounded displayed date text verbatim: %s", async value => {
    await withPage(input.replace("Thu, Oct 22, 2026", value), async page => {
      expect((await inspectPublicDatePickerInput(page.locator("input")))?.currentValue).toBe(value);
    });
  });
  it("accepts readonly type=date and an ordinary public search form", async () => {
    await withPage(`<form>${input.replace('type="text"', 'type="date"').replace("Thu, Oct 22, 2026", "2026-10-22")}<button type="button">Find times</button></form>`, async page => {
      expect(await inspectPublicDatePickerInput(page.locator("input"))).toEqual({ label: "Choose date", currentValue: "2026-10-22" });
    });
  });
  it.each([
    ["not-readonly", input.replace("readonly", "")],
    ["wrong-type", input.replace('type="text"', 'type="email"')],
    ["no-popup", input.replace('aria-haspopup="dialog"', "")],
    ["other-popup", input.replace('aria-haspopup="dialog"', 'aria-haspopup="listbox"')],
    ["missing-label", input.replace('placeholder="Choose date"', "")],
    ["value-only-date", input.replace('placeholder="Choose date"', 'placeholder="Select"')],
    ["substring-label", input.replace("Choose date", "Candidate")],
    ["transaction-label", input.replace("Choose date", "Confirm booking date")],
    ["birth-label", input.replace("Choose date", "Date of birth")],
    ["formless-dob", input.replace("readonly", 'readonly name="dob"')],
    ["formless-birthday", input.replace("readonly", 'readonly autocomplete="bday"')],
    ["formless-birthday-part", input.replace("readonly", 'readonly autocomplete="section-person bday-day"')],
    ["formless-birth-name", input.replace("readonly", 'readonly name="dateOfBirth"')],
    ["formless-birthdate-name", input.replace("readonly", 'readonly name="birthdate"')],
    ["formless-dateofbirth-name", input.replace("readonly", 'readonly name="dateofbirth"')],
    ["formless-contact", input.replace("readonly", 'readonly name="contact_date"')],
    ["formless-payment", input.replace("readonly", 'readonly autocomplete="cc-exp"')],
    ["conflicting-label", input.replace("readonly", 'readonly aria-label="Payment date"')],
    ["title", input.replace("readonly", 'readonly title="Checkout"')],
    ["disabled", input.replace("readonly", "readonly disabled")],
    ["fieldset-disabled", `<fieldset disabled>${input}</fieldset>`],
    ["aria-disabled", `<div aria-disabled="true">${input}</div>`],
    ["hidden", `<div hidden>${input}</div>`],
    ["inert", `<div inert>${input}</div>`],
    ["aria-hidden", `<div aria-hidden="true">${input}</div>`],
    ["css-hidden", `<div style="visibility:hidden">${input}</div>`],
    ["transparent", `<div style="opacity:0">${input}</div>`],
    ["zero-size", input.replace("readonly", 'readonly style="width:0;height:0;padding:0;border:0"')],
    ["contenteditable", `<div contenteditable="true">${input}</div>`],
    ["link", `<a href="https://example.com">${input}</a>`],
    ["contact-form", `<form>${input}<input type="email"></form>`],
    ["password-form", `<form>${input}<input type="password"></form>`],
    ["payment-form", `<form>${input}<input autocomplete="cc-number"></form>`],
    ["text-contact-form", `<form>${input}<input type="text" name="phone"></form>`],
    ["named-contact-form", `<form>${input}<input type="text" name="contact_date"></form>`],
    ["birthday-form", `<form>${input}<input type="text" autocomplete="bday"></form>`],
    ["external-contact-form", `${input.replace("readonly", 'readonly form="private"')}<form id="private"><input type="email"></form>`],
    ["external-payment-form", `${input.replace("readonly", 'readonly form="private"')}<form id="private"><input autocomplete="cc-number"></form>`],
    ["unresolved-external-form", input.replace("readonly", 'readonly form="future"')],
    ["transaction-form", `<form action="/checkout">${input}</form>`],
    ["transaction-button", `<form>${input}<button>Reserve</button></form>`],
    ["private-context", `<section aria-label="Account">${input}</section>`],
    ["hidden-label", `<span hidden id="label">Calendar</span>${input.replace('placeholder="Choose date"', 'aria-labelledby="label"')}`],
    ["missing-labelledby", input.replace('placeholder="Choose date"', 'aria-labelledby="absent"')],
    ["unsafe-value", input.replace("Thu, Oct 22, 2026", "person@example.com")],
    ["non-date-value", input.replace("Thu, Oct 22, 2026", "October")],
    ["long-value", input.replace("Thu, Oct 22, 2026", "x".repeat(101))],
    ["long-label", input.replace("Choose date", `Choose date ${"x".repeat(100)}`)],
  ])("rejects %s without clicking", async (_kind, html) => {
    await withPage(html, async page => {
      const node = page.locator("input").first();
      expect(await inspectPublicDatePickerInput(node)).toBeUndefined();
      await expect(openPublicDatePickerInput(node)).rejects.toThrow("UNVERIFIED_PUBLIC_DATE_PICKER_INPUT");
    });
  });
  it("rejects duplicate matches and revalidates changed label/value/safety before a real click", async () => {
    await withPage(input + input.replace('id="date"', 'id="second"'), async page => {
      expect(await inspectPublicDatePickerInput(page.locator("input"))).toBeUndefined();
      await expect(openPublicDatePickerInput(page.locator("input"))).rejects.toThrow("UNVERIFIED_PUBLIC_DATE_PICKER_INPUT");
    });
    for (const mode of ["label", "value", "private"] as const) await withPage(input, async page => {
      const node = page.locator("input"), proof = (await inspectPublicDatePickerInput(node))!;
      await page.evaluate(mode => {
        const node = document.querySelector("input")!;
        document.body.dataset.clicks = "0";
        node.addEventListener("click", () => { document.body.dataset.clicks = "1"; });
        if (mode === "label") node.placeholder = "Calendar";
        if (mode === "value") node.value = "2026-10-24";
        if (mode === "private") node.setAttribute("aria-label", "Contact date");
      }, mode);
      await expect(openPublicDatePickerInput(node, proof)).rejects.toThrow("UNVERIFIED_PUBLIC_DATE_PICKER_INPUT");
      expect(await page.locator("body").getAttribute("data-clicks")).toBe("0");
    });
  });
  it("does not read value from a rejected sensitive input", async () => {
    await withPage(`<form>${input}<input type="email"></form>`, async page => {
      await page.locator("#date").evaluate(node => { Object.defineProperty(node, "value", { get() { throw new Error("PRIVATE_VALUE_READ"); } }); });
      expect(await inspectPublicDatePickerInput(page.locator("#date"))).toBeUndefined();
    });
  });
  it("rejects formless private field purposes before reading their date-shaped values", async () => {
    for (const attributes of ['name="dob"', 'name="birthdate"', 'name="dateofbirth"', 'autocomplete="bday"', 'name="contact_date"', 'autocomplete="cc-exp"']) {
      await withPage(input.replace("readonly", `readonly ${attributes}`), async page => {
        await page.locator("#date").evaluate(node => { Object.defineProperty(node, "value", { get() { throw new Error("PRIVATE_VALUE_READ"); } }); });
        expect(await inspectPublicDatePickerInput(page.locator("#date"))).toBeUndefined();
      });
    }
  });
  it("does not read the value of an externally associated private-form input", async () => {
    await withPage(`${input.replace("readonly", 'readonly form="contact"')}<form id="contact"><input type="email"></form>`, async page => {
      await page.locator("#date").evaluate(node => { Object.defineProperty(node, "value", { get() { throw new Error("PRIVATE_VALUE_READ"); } }); });
      expect(await inspectPublicDatePickerInput(page.locator("#date"))).toBeUndefined();
    });
  });
});
