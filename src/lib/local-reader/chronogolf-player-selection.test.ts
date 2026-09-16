import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const readerSource = readFileSync(resolve("tools/local-chrome-reader/chronogolf-reader.js"), "utf8");
const contentSource = readFileSync(resolve("tools/local-chrome-reader/content.js"), "utf8");

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

async function readPublicPage(options: {
  players?: number; delayed?: boolean; challenge?: boolean; malformed?: boolean;
} = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T16:00:00Z"));
  const pageUrl = "https://www.chronogolf.com/club/overlook-golf-club?date=2026-09-19&step=teetimes";
  const job = { id: "controlled-job", courseKey: "chronogolf:overlook-golf-club",
    courseName: "Overlook Golf Club", bookingUrl: pageUrl, targetDate: "2026-09-19",
    players: options.players ?? 3, cardTextIncludes: [] };
  document.body.innerHTML = `<button id="filters">Filters</button><div id="sheet"></div>
    ${options.challenge ? "Verify you are human" : ""}`;
  Object.defineProperty(document.body, "innerText", { configurable: true, get() { return this.textContent; } });
  const clicked = vi.fn();
  document.querySelector("#filters")!.addEventListener("click", clicked);
  function renderCards() {
    document.querySelector("#sheet")!.innerHTML = options.malformed
      ? `<div data-testid="teeTimeCard" role="button">Loading tee-time details</div>`
      : [
          ["12:51 PM", "2 - 4"], ["1:00 PM", "3"], ["1:09 PM", "4"], ["2:39 PM", "1"]
        ].map(([time, capacity]) => `<div data-testid="teeTimeCard" role="button">${time} $39
          <span title="# of players available">${capacity}</span><span title="Hole count">9, 18</span>
        </div>`).join("");
    for (const card of document.querySelectorAll("[data-testid='teeTimeCard']")) card.addEventListener("click", clicked);
  }
  if (options.delayed) setTimeout(renderCards, 12_000);
  else renderCards();
  const results: Array<{ status: string; slots: Array<{startsAtLocal: string}> }> = [];
  runInNewContext(readerSource + "\n" + contentSource, {
    document, location: new URL(pageUrl), URL, Date, CSS: { escape: (s: string) => s },
    setTimeout, window: { setTimeout }, HTMLSelectElement,
    chrome: { storage: { local: { get: async () => ({ pendingJobs: { "1": { job } } }) } },
      runtime: { onMessage: { addListener: vi.fn() }, sendMessage: async (message: {type: string; result?: typeof results[number]}) => {
        if (message.type === "LOCAL_READER_IDENTIFY_TAB") return { tabId: 1 };
        if (message.result) results.push(message.result);
        return {};
      } } },
  });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(clicked).not.toHaveBeenCalled();
  expect(results).toHaveLength(1);
  return results[0];
}

describe("Chronogolf group capacity through the complete content reader", () => {
  it.each([3, 4])("reads public cards for %i players without opening filters or booking", async players => {
    const result = await readPublicPage({ players });
    expect(result.status).toBe("AVAILABLE");
    expect(result.slots.map(slot => slot.startsAtLocal)).toEqual([
      "2026-09-19T12:51:00", players === 3 ? "2026-09-19T13:00:00" : "2026-09-19T13:09:00"
    ]);
  });
  it("waits for delayed public cards without depending on hydrated filters", async () => {
    expect((await readPublicPage({delayed: true})).status).toBe("AVAILABLE");
  });
  it("does not treat malformed card details as no availability", async () => {
    expect(await readPublicPage({malformed: true})).toMatchObject({status: "READER_ERROR", slots: []});
  });
  it("stops at an access challenge", async () => {
    expect(await readPublicPage({challenge: true})).toMatchObject({status: "ACCESS_CHALLENGE", slots: []});
  });
});
