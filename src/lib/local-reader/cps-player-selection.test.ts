import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const readerSource = readFileSync(resolve("tools/local-chrome-reader/cps-reader.js"), "utf8");
const contentSource = readFileSync(resolve("tools/local-chrome-reader/content.js"), "utf8");

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

async function readPublicPage(options: {
  hostname: string; golfers: string; players?: number; anyWorks?: boolean; malformed?: boolean;
}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T16:00:00Z"));
  // The observed CPS controls omit 1 even when Any reveals single openings.
  document.body.innerHTML = `<div role="group">${["Any", "2", "3", "4"].map(label =>
    `<button class="mat-button-toggle-button" name="fontStyle" aria-pressed="${label === "2"}">${label}</button>`,
  ).join("")}</div><button aria-label="Next date">&gt;</button>
  <button class="btn-teesheet"><time datetime="2026-09-09T08:00:00">8:00</time>
  <div>${options.malformed ? "Loading details" : `18 HOLES | ${options.golfers} GOLFERS $51.00`}</div></button>`;
  const bookingClick = vi.fn();
  document.querySelector(".btn-teesheet")!.addEventListener("click", bookingClick);
  for (const button of document.querySelectorAll("button[name]")) {
    button.addEventListener("click", () => {
      if (button.textContent === "Any" && options.anyWorks === false) return;
      for (const other of document.querySelectorAll("button[name]")) {
        other.setAttribute("aria-pressed", String(other === button));
      }
    });
  }
  document.querySelector('[aria-label="Next date"]')!.addEventListener("click", () => {
    document.querySelector("time")!.setAttribute("datetime", "2026-09-10T08:00:00");
  });
  const pageUrl = `https://${options.hostname}/onlineresweb/search-teetime`;
  const job = { id: "controlled-job", courseKey: `cps:${options.hostname}`,
    courseName: "Public course", bookingUrl: pageUrl, targetDate: "2026-09-10",
    players: options.players ?? 1, cardTextIncludes: [] };
  const results: Array<{status: string; slots: Array<{minimumPlayers: number; startsAtLocal: string}>; readerVersion: string}> = [];
  const context = { document, location: new URL(pageUrl), URL, Date, CSS: {escape: (s: string) => s},
    setTimeout, window: {setTimeout}, HTMLSelectElement,
    chrome: { storage: {local: {get: async () => ({pendingJobs: {"1": {job}}})}},
      runtime: {onMessage: {addListener: vi.fn()}, sendMessage: async (message: {type: string; result?: typeof results[number]}) => {
        if (message.type === "LOCAL_READER_IDENTIFY_TAB") return {tabId: 1};
        if (message.result) results.push(message.result);
        return {};
      }}},
  };
  runInNewContext(readerSource + "\n" + contentSource, context);
  await vi.advanceTimersByTimeAsync(40_000);
  expect(bookingClick).not.toHaveBeenCalled();
  expect(results).toHaveLength(1);
  return {result: results[0], selected: document.querySelector('[aria-pressed="true"]')?.textContent};
}

describe("CPS public player filtering through the complete content reader", () => {
  it.each([
    ["shadowvalley.cps.golf", "2", "NO_AVAILABILITY", 0],
    ["trosper.cps.golf", "1", "AVAILABLE", 1],
  ])("reads %s without requiring a missing single-player button", async (hostname, golfers, status, slots) => {
    const {result, selected} = await readPublicPage({hostname, golfers});
    expect(selected).toBe("Any");
    expect(result.status).toBe(status);
    expect(result.slots).toHaveLength(slots);
    expect(result.readerVersion).toBe("cps-rendered-v2");
    for (const slot of result.slots) expect(slot.startsAtLocal).toBe("2026-09-10T08:00:00");
  });
  it("prefers an exact player filter even when Any appears first", async () => {
    const {result, selected} = await readPublicPage({hostname: "shadowvalley.cps.golf", golfers: "2 - 4", players: 3});
    expect(selected).toBe("3"); expect(result.status).toBe("AVAILABLE");
  });
  it("does not read a stale filtered page when Any fails to activate", async () => {
    const {result} = await readPublicPage({hostname: "trosper.cps.golf", golfers: "1", anyWorks: false});
    expect(result.status).toBe("READER_ERROR"); expect(result.slots).toEqual([]);
  });
  it("keeps malformed availability unresolved after the filter changes", async () => {
    const {result} = await readPublicPage({hostname: "trosper.cps.golf", golfers: "1", malformed: true});
    expect(result.status).toBe("READER_ERROR"); expect(result.slots).toEqual([]);
  });
});
