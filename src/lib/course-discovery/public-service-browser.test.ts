// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

vi.mock("@/lib/automation/provider-request-lease", () => ({ runWithProviderRequestLease: vi.fn() }));
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const html = `<div id="widget"><form><div><label>Service:</label><div><span id="selected">Select Service</span>
  <input id="service" type="text" role="combobox" aria-label="Select Service" aria-haspopup="listbox" aria-controls="services" aria-expanded="false" readonly></div></div>
  <button id="continue" type="button">Continue</button><div hidden><input type="email"></div></form>
  <ul id="services" role="listbox" hidden><li role="option">Golf Lessons $40.00</li><li role="option">Golf Simulator $30.00</li><li role="option">Tournament Fees $50.00</li></ul>
  <section id="packages" hidden><p>Hey, there are special packages with this service, check them out!</p><p>Birdie Membership $100</p>
  <button id="skip" type="button">Skip packages and continue with the selected service $30.00 - $50.00</button></section>
  <output id="result"></output></div><script>
  document.querySelector('#service').onclick=()=>{document.querySelector('#services').hidden=false;document.querySelector('#service').setAttribute('aria-expanded','true')};
  document.querySelectorAll('[role=option]').forEach(option=>option.onclick=()=>{document.querySelector('#selected').textContent=option.textContent.replace(/ \\$[0-9.]+$/,'');document.querySelector('#services').hidden=true;document.querySelector('#service').setAttribute('aria-expanded','false')});
  document.querySelector('#continue').onclick=()=>{document.querySelector('#continue').hidden=true;document.querySelector('#packages').hidden=false};
  document.querySelector('#skip').onclick=()=>{document.querySelector('#packages').hidden=true;document.querySelector('#result').textContent='Public calendar';};
  </script>`;

describe.runIf(existsSync(chrome))("discovery public rental service parity", () => {
  const session = (fixture = html) => createCourseDiscoveryBrowserSession({ deadlineAt: new Date(Date.now() + 60_000), initialUrls: ["https://example.org/widget"] }, {
    launchBrowser: () => chromium.launch({ executablePath: chrome, headless: true }),
    fetch: vi.fn(async () => new Response(fixture, { headers: { "content-type": "text/html" } })) as typeof fetch,
    requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
  });
  it("returns opaque rental-only service actions and bound single-use continuations", async () => {
    const browser = await session();
    try {
      let view = await browser.execute({ id: 1, action: "open", url: "https://example.org/widget" });
      expect(view.controls.find(control => control.name === "Continue")).toBeUndefined();
      const initial = view.controls.find(control => control.name === "Select Service");
      expect(initial?.kind).toBe("filter");
      view = await browser.execute({ id: 2, action: "click", target: initial!.target });
      const service = view.controls.find(control => control.name === "Select Service");
      expect(service?.options).toEqual([{ value: "Golf Simulator $30.00", label: "Golf Simulator $30.00" }]);
      expect(view.controls.some(control => /Golf Lessons|Tournament Fees/u.test(control.name))).toBe(false);
      view = await browser.execute({ id: 3, action: "select", target: service!.target, option: "Golf Simulator $30.00" });
      const next = view.controls.find(control => control.name === "Continue");
      expect(next?.kind).toBe("service-continuation");
      view = await browser.execute({ id: 4, action: "click", target: next!.target });
      const skip = view.controls.find(control => control.name.startsWith("Skip packages and continue"));
      expect(skip?.kind).toBe("service-continuation");
      view = await browser.execute({ id: 5, action: "click", target: skip!.target });
      expect(view.text).toContain("Public calendar");
      expect(view.controls.some(control => control.kind === "service-continuation")).toBe(false);
    } finally { await browser.close(); }
  }, 20_000);
  it("rejects lesson selection and clears a selected-service capability on open", async () => {
    const browser = await session();
    try {
      let view = await browser.execute({ id: 1, action: "open", url: "https://example.org/widget" });
      let service = view.controls.find(control => control.name === "Select Service")!;
      await expect(browser.execute({ id: 2, action: "select", target: service.target, option: "Golf Lessons $40.00" })).rejects.toThrow("UNSAFE_RENTAL_SERVICE");
      view = await browser.execute({ id: 3, action: "observe" });
      service = view.controls.find(control => control.name === "Select Service")!;
      view = await browser.execute({ id: 4, action: "select", target: service.target, option: "Golf Simulator $30.00" });
      expect(view.controls.some(control => control.kind === "service-continuation")).toBe(true);
      service = view.controls.find(control => control.name === "Select Service")!;
      await expect(browser.execute({ id: 5, action: "select", target: service.target, option: "Golf Lessons $40.00" })).rejects.toThrow("UNSAFE_RENTAL_SERVICE");
      view = await browser.execute({ id: 6, action: "observe" });
      expect(view.controls.some(control => control.kind === "service-continuation")).toBe(false);
      view = await browser.execute({ id: 7, action: "open", url: "https://example.org/widget" });
      expect(view.controls.some(control => control.kind === "service-continuation")).toBe(false);
    } finally { await browser.close(); }
  }, 20_000);
  it("round-trips the exposed native service option label rather than an opaque product id", async () => {
    const browser = await session('<form><label for="native">Service:</label><select id="native"><option>Select Service</option><option value="rental">Golf Simulator $30.00</option><option value="lesson">Golf Lessons</option></select><button type="button">Continue</button></form>');
    try {
      let view = await browser.execute({ id: 1, action: "open", url: "https://example.org/widget" });
      const service = view.controls.find(control => control.selector.includes("native"))!;
      expect(service.options).toEqual([{ value: "Golf Simulator $30.00", label: "Golf Simulator $30.00" }]);
      view = await browser.execute({ id: 2, action: "select", target: service.target, option: service.options![0].value });
      expect(view.controls.some(control => control.kind === "service-continuation")).toBe(true);
    } finally { await browser.close(); }
  }, 20_000);
});
