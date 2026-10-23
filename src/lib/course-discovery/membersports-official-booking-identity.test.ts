// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { attestMemberSportsOfficialBookingIdentity } from "./membersports-official-booking-identity";

const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const source = { officialUrl: "https://example.org/", bookingUrl: "https://app.membersports.com/tee-times/42/84/0",
  venueAddress: "1005 Richardson Drive, Groveport, OH 43125, USA" };
const selectors = { addressSelector: "#address", bookingLinkSelector: "#booking" };
const current = "https://example.org/rates";
const fixture = () => `<h1>Example Municipal Golf</h1><section><p id="address">1005 Richardson Dr<br>Groveport, OH 43125</p></section>
  <nav><a id="booking" target="_blank" href="${source.bookingUrl}" onclick="window.linkClicked=true">BOOK A TEE TIME</a></nav>`;

describe("strict public MemberSports official source inputs", () => {
  it.each([
    { bookingUrl: source.bookingUrl.replace("https:", "http:") },
    { bookingUrl: source.bookingUrl.replace("/42/", "/0/") },
    { bookingUrl: source.bookingUrl.replace("/42/", "/042/") },
    { bookingUrl: source.bookingUrl.replace("/42/", "/2147483648/") },
    { bookingUrl: source.bookingUrl.replace("/84/", "/2147483648/") },
    { bookingUrl: source.bookingUrl.replace("/0", "/1") },
    { bookingUrl: source.bookingUrl + "?date=2026-10-23" },
    { bookingUrl: source.bookingUrl + "#calendar" },
    { bookingUrl: source.bookingUrl.replace("membersports.com", "membersports.com:443") },
    { bookingUrl: source.bookingUrl.replace("/tee-times/", "/tee%2Dtimes/") },
    { bookingUrl: source.bookingUrl.replace("app.membersports.com", "other.membersports.com") },
    { officialUrl: "https://127.0.0.1/" },
    { officialUrl: "https://user:password@example.org/" },
    { venueAddress: "Groveport, OH 43125" },
    { venueAddress: "PO Box 42, Groveport, OH 43125" },
  ])("rejects unsafe or incomplete source input before DOM access (%j)", async override => {
    const page = { url: vi.fn(), locator: vi.fn() };
    await expect(attestMemberSportsOfficialBookingIdentity(page as unknown as Page, { ...source, ...override }, selectors))
      .rejects.toThrow("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED");
    expect(page.locator).not.toHaveBeenCalled();
  });
});

describe.runIf(existsSync(chrome))("fresh official address and exact public booking link", () => {
  let browser: Browser, page: Page;
  let requests: string[];
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); });
  beforeEach(async () => { await page?.close(); page = await browser.newPage(); page.setDefaultTimeout(1000); requests = []; });
  afterAll(async () => { await browser?.close(); });
  async function load(html: string, url = current) {
    const wireUrl = new URL(url); wireUrl.hash = "";
    await page.route("**/*", async route => {
      requests.push(route.request().url());
      if (route.request().url() !== wireUrl.href) throw new Error("UNEXPECTED_FIXTURE_REQUEST");
      await route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto(url);
  }
  it("attests the current same-site Rates address and exact _blank anchor without a name alias or click", async () => {
    await load(fixture());
    const result = await attestMemberSportsOfficialBookingIdentity(page, source, selectors);
    expect(result).toEqual({ officialDocumentUrl: current, bookingUrl: source.bookingUrl, clubId: 42, courseId: 84 });
    expect(Object.isFrozen(result)).toBe(true);
    expect(await page.evaluate(() => Object.hasOwn(window, "linkClicked"))).toBe(false);
    expect(requests).toEqual([current]);
  });
  it("treats nested address formatting and repeated empty line delimiters as formatting only", async () => {
    await load(fixture().replace("1005 Richardson Dr<br>Groveport, OH 43125", "<span>1005 Richardson Drive,</span><br><span>Groveport, OH 43125, US</span>"));
    await expect(attestMemberSportsOfficialBookingIdentity(page, source, selectors)).resolves.toMatchObject({ bookingUrl: source.bookingUrl });
  });
  it.each([
    fixture().replace("1005 Richardson Dr", "1006 Richardson Dr"),
    fixture().replace("Richardson Dr", "Richardson Rd"),
    fixture().replace("Groveport, OH", "Grove City, OH"),
    fixture().replace("43125", "43126"),
    fixture().replace('id="address"', 'id="address" hidden'),
    fixture().replace('id="address"', 'id="address" style="opacity:0"'),
    fixture().replace("<section>", '<section aria-label="Corporate mailing address">'),
    `<section contenteditable="">${fixture()}</section>`,
    `<form>${fixture()}</form>`,
    `<section aria-label="Login">${fixture()}</section>`,
    fixture().replace('id="booking"', 'id="booking" aria-label="Confirm purchase"'),
    fixture().replace("BOOK A TEE TIME", "Pay for tee time"),
    fixture().replace(source.bookingUrl, source.bookingUrl.replace("/84/", "/85/")),
    fixture().replace(source.bookingUrl, source.bookingUrl + "?session=private"),
    fixture().replace('target="_blank"', 'target="named-window"'),
    fixture().replace('id="booking"', 'id="booking" download'),
    fixture() + '<p>1005 Richardson Dr, Groveport, OH 43125</p>',
    fixture() + '<p>1200 Other Street, Groveport, OH 43125</p>',
    fixture() + `<a href="${source.bookingUrl}">Book a tee time</a>`,
    fixture() + '<a href="https://app.membersports.com/tee-times/42/85/0">Book a tee time</a>',
  ])("rejects ambiguous, hidden, private, mismatched or transactional evidence", async html => {
    await load(html);
    await expect(attestMemberSportsOfficialBookingIdentity(page, source, selectors)).rejects.toThrow("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED");
    expect(requests).toEqual([current]);
  });
  it("ignores hidden duplicate evidence without reading input values", async () => {
    await load(fixture() + `<div hidden><p>1005 Richardson Dr, Groveport, OH 43125</p><a href="${source.bookingUrl}">Book a tee time</a></div>` +
      '<form><input type="password" value="private-value"><p>1200 Other Street, Groveport, OH 43125</p></form>');
    await page.locator("input").evaluate(node => Object.defineProperty(node, "value", { get() { throw Error("PRIVATE_VALUE_READ"); } }));
    await expect(attestMemberSportsOfficialBookingIdentity(page, source, selectors)).resolves.toMatchObject({ clubId: 42 });
  });
  it.each(["https://www.example.org/rates", "https://other.example.org/rates", "https://example.org/rates#alias"])("rejects a different origin or fragment (%s)", async url => {
    await load(fixture(), url);
    await expect(attestMemberSportsOfficialBookingIdentity(page, source, selectors)).rejects.toThrow("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED");
  });
  it.each([{ addressSelector: "p", bookingLinkSelector: "a" }, { addressSelector: "#address", bookingLinkSelector: "[" }])("does not hide selector ambiguity or invalid syntax", async values => {
    await load(fixture() + '<p>Some public text</p>');
    await expect(attestMemberSportsOfficialBookingIdentity(page, source, values)).rejects.toThrow("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED");
  });
  it("rejects a changed address between its two same-document readings", async () => {
    await load(fixture());
    const root = await page.locator("html").elementHandle();
    if (!root) throw Error("fixture root");
    const evaluate = root.evaluate.bind(root);
    vi.spyOn(root, "evaluate").mockImplementationOnce(evaluate).mockImplementationOnce(async (fn, arg) => {
      await page.locator("#address").evaluate(node => { node.textContent = "1200 Other Street, Groveport, OH 43125"; });
      return evaluate(fn, arg);
    });
    const ownedPage = { url: () => page.url(), locator: () => ({ elementHandle: async () => root }) } as unknown as Page;
    await expect(attestMemberSportsOfficialBookingIdentity(ownedPage, source, selectors)).rejects.toThrow("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED");
  });
  it("runs the actual tsx keepNames-compiled read callback in Chromium without injected helper dependencies", async () => {
    const modulePath = resolve(process.cwd(), "src/lib/course-discovery/membersports-official-booking-identity.ts");
    const serialized = execFileSync(process.execPath, [resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e",
      `import {attestMemberSportsOfficialBookingIdentity as attest} from ${JSON.stringify(modulePath)};
      void attest({url:()=>${JSON.stringify(current)},locator:()=>({elementHandle:async()=>({evaluate:async(fn)=>{process.stdout.write(fn.toString());throw Error('CAPTURE_DONE')},dispose:async()=>{}})})},${JSON.stringify(source)},${JSON.stringify(selectors)}).catch(()=>{});`],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 100_000 });
    expect(serialized).toContain("function readOfficialDocument");
    expect(serialized).not.toMatch(/\b__name\s*\(/u);
    await load(fixture());
    const callback = new Function(`return (${serialized});`)();
    const result = await page.locator("html").evaluate(callback, { ...selectors, bookingUrl: source.bookingUrl });
    expect(result).toMatchObject({ documentUrl: current, href: source.bookingUrl, bookingLinks: 1 });
  });
});
