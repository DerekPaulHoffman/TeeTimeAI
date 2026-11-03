import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { revealNativeVenueHeading, revealNativeVenueAddress } from "./native-venue-heading";

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
function fixture(markup = '<h1 style="opacity:0">Welcome to Harbor Golf Course</h1>', reveal = true) {
  document.body.innerHTML = markup;
  // Browser computed defaults are explicit in this layout-free DOM fixture.
  document.documentElement.style.opacity = document.body.style.opacity = "1";
  document.documentElement.style.visibility = document.body.style.visibility = "visible";
  let clock = 1000, scrolled = false, url = "https://public.example/";
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: scrolled ? 100 : 1200, top: scrolled ? 100 : 1200, bottom: scrolled ? 150 : 1250,
    left: 0, right: 500, width: 500, height: 50, toJSON: () => ({}) }));
  const scroll = vi.fn(async () => {
    scrolled = true;
    if (reveal) for (const h of document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6,p,address")) h.style.opacity = "1";
  });
  const headingNodes = (selector = "h1,h2,h3,h4,h5,h6,p,address") => [...document.querySelectorAll<HTMLElement>(selector)];
  // jsdom has no layout-backed innerText; keep its text semantics explicit.
  for (const h of headingNodes()) Object.defineProperty(h, "innerText", { get: () => h.innerHTML.replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]*>/gu, "") });
  const page = {
    locator: (selector: string) => ({ evaluateAll: (fn: (nodes: HTMLElement[], arg: unknown) => unknown, arg: unknown) => fn(headingNodes(selector), arg),
      nth: (index: number) => ({ scrollIntoViewIfNeeded: scroll, evaluate: (fn: (node: HTMLElement) => unknown) => fn(headingNodes(selector)[index]) }) }),
    url: () => url, evaluate: (fn: () => unknown) => fn(), waitForTimeout: async (ms: number) => { clock += ms; },
  } as unknown as Page;
  return { page, scroll, deadline: new Date(10000), changeUrl: () => { url = "https://public.example/other/"; } };
}

describe("private native venue heading reveal", () => {
  it("reveals one offscreen branded address field without treating the cue as exact identity proof", async () => {
    const f = fixture('<h5 style="opacity:0">Harbor Golf Course<br>10 Harbor Drive<br>Example, NY 12345</h5>');
    expect(await revealNativeVenueAddress(f.page, "10 Harbor Dr, Example, NY 12345", f.deadline)).toBe(true);
    expect(f.scroll).toHaveBeenCalledOnce();
  });
  it.each([
    '<address>11 Harbor Drive, Example, NY 12345</address>',
    '<address>10 Other Drive, Example, NY 12345</address>',
    '<address>10 Harbor Drive, Example, NY 12346</address>',
    '<form><address>10 Harbor Drive, Example, NY 12345</address></form>',
    '<address>10 Harbor Drive, Example, NY 12345</address><p>10 Harbor Drive, Example, NY 12345</p>',
  ])("does not select an excluded or ambiguous address cue: %s", async markup => {
    const f = fixture(markup);
    expect(await revealNativeVenueAddress(f.page, "10 Harbor Dr, Example, NY 12345", f.deadline)).toBe(false);
    expect(f.scroll).not.toHaveBeenCalled();
  });
  it("scrolls one exact offscreen heading and waits for the site's own visibility change", async () => {
    const f = fixture();
    expect(await revealNativeVenueHeading(f.page, "Harbor Golf Course", f.deadline)).toBe(true);
    expect(f.scroll).toHaveBeenCalledOnce();
  });
  it.each([
    '<h1 style="display:none">Harbor Golf Course</h1>',
    '<h1 style="visibility:hidden">Harbor Golf Course</h1>',
    '<form><h1>Harbor Golf Course</h1></form>',
    '<section inert><h1>Harbor Golf Course</h1></section>',
    '<section class="members-only"><h1>Harbor Golf Course</h1></section>',
    '<h1>Other Golf Course</h1>',
    '<h1>Harbor Golf Course</h1><h2>Harbor Golf Course</h2>',
  ])("does not reveal an excluded or ambiguous heading: %s", async markup => {
    const f = fixture(markup);
    expect(await revealNativeVenueHeading(f.page, "Harbor Golf Course", f.deadline)).toBe(false);
    expect(f.scroll).not.toHaveBeenCalled();
  });
  it("does not pretend scrolling made an intentionally transparent heading visible", async () => {
    const f = fixture(undefined, false);
    expect(await revealNativeVenueHeading(f.page, "Harbor Golf Course", f.deadline)).toBe(false);
    expect(f.scroll).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>("h1")!.style.opacity).toBe("0");
  });
  it("rejects navigation during the scroll instead of returning a visible witness", async () => {
    const f = fixture(); f.scroll.mockImplementationOnce(async () => f.changeUrl());
    expect(await revealNativeVenueHeading(f.page, "Harbor Golf Course", f.deadline)).toBe(false);
  });
  it("does not start after the original read budget expires", async () => {
    const f = fixture();
    expect(await revealNativeVenueHeading(f.page, "Harbor Golf Course", new Date(1200))).toBe(false);
    expect(f.scroll).not.toHaveBeenCalled();
  });
});
