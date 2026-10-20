import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { inspectPublicDateChoiceElement, parsePublicDateChoice, selectPublicDateChoice } from "./public-date-choice";

const grid = (extra = "") => `<div id="dates"><button id="selected">Oct 23, 2026<br>\nFriday</button><button>Oct 24, 2026<br>\nSaturday</button>${extra}</div>`;
function inspect(html: string) { document.body.innerHTML = html; return inspectPublicDateChoiceElement(document.querySelector("#selected")!); }
describe("full-date public calendar choices", () => {
  beforeEach(() => { vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, toJSON: () => ({}) }); });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  it("proves the year and weekday from the Lightspeed public day grid", () => { expect(inspect(grid())).toEqual({ date: "2026-10-23" }); });
  it.each(["Oct 23 Friday", "Oct 23, 2026 Monday", "Feb 30, 2026", "Oct 23, 2026 Friday 12:00", "Oct 23, 2026 $40", "Oct 23, 2026 Reserve"])
    ("rejects ambiguous, malformed, time or product text %s", text => { expect(parsePublicDateChoice(text)).toBeUndefined(); });
  it.each([grid().replace('id="selected"', 'id="selected" disabled'), grid().replace('id="dates"', 'id="dates" style="opacity:0"'),
    `<form>${grid()}</form>`, `<section aria-label="Checkout">${grid()}</section>`, grid('<input type="email">'), grid('<button>Oct 23, 2026 Friday</button>'),
    grid('<button>12:00</button>'), '<div><button id="selected">Oct 23, 2026 Friday</button></div>'])
    ("rejects hidden, noncalendar, duplicate and sensitive choices", html => { expect(inspect(html)).toBeUndefined(); });
  it("performs browser detail reads only for matching full-date text", async () => {
    const node = { evaluate: vi.fn(async () => ({ date: "2026-10-23" })), click: vi.fn() };
    const candidates = { count: async () => 1000, evaluateAll: vi.fn(async () => Array.from({ length: 1000 }, (_, index) => ({ index,
      text: index === 999 ? "Oct 23, 2026 Friday" : "Unrelated control" }))), nth: vi.fn(() => node) };
    await selectPublicDateChoice({ locator: () => candidates } as unknown as Page, "button", "2026-10-23");
    expect(candidates.evaluateAll).toHaveBeenCalledTimes(1);
    expect(candidates.nth).toHaveBeenCalledExactlyOnceWith(999);
    expect(node.evaluate).toHaveBeenCalledTimes(1);
    expect(node.click).toHaveBeenCalledTimes(1);
  });
});
