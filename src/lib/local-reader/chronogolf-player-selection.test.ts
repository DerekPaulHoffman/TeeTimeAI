import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const readerSource = readFileSync(resolve("tools/local-chrome-reader/chronogolf-reader.js"), "utf8");
const contentSource = readFileSync(resolve("tools/local-chrome-reader/content.js"), "utf8");

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

async function readPublicPage(options: {
  players?: number; collapsed?: boolean; selectionWorks?: boolean; applyWorks?: boolean; challenge?: boolean;
} = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T16:00:00Z"));
  const pageUrl = "https://www.chronogolf.com/club/overlook-golf-club?date=2026-09-19&step=teetimes";
  const job = { id: "controlled-job", courseKey: "chronogolf:overlook-golf-club",
    courseName: "Overlook Golf Club", bookingUrl: pageUrl, targetDate: "2026-09-19",
    players: options.players ?? 3, cardTextIncludes: [] };
  // The live narrow layout mounts these controls only after opening Filters.
  const controls = `<div role="radiogroup">Group size${[1, 2, 3, 4].map(n =>
    `<label><button type="button" role="radio" aria-checked="${n === 1}" value="${n}"></button><div><span>${n} ${n === 1 ? "player" : "Players"}</span></div></label>`,
  ).join("")}</div>`;
  document.body.innerHTML = `<button id="filters">Filters</button>
    <div id="sheet"><div data-testid="teeTimeCard" role="button">12:51 PM $39
      <span title="# of players available">2 - 4</span><span title="Hole count">9, 18</span>
    </div><div data-testid="teeTimeCard" role="button">2:39 PM $20
      <span title="# of players available">1</span><span title="Hole count">18</span>
    </div></div>${options.challenge ? "Verify you are human" : ""}`;
  Object.defineProperty(document.body, "innerText", { configurable: true, get() { return this.textContent; } });
  const bookingClick = vi.fn(), openFilters = vi.fn(), applyFilters = vi.fn();
  let selected = "1";
  for (const card of document.querySelectorAll("[data-testid='teeTimeCard']")) card.addEventListener("click", bookingClick);
  function wireRadios(root: Element) {
    for (const radio of root.querySelectorAll("[role='radio']")) radio.addEventListener("click", () => {
      if (options.selectionWorks === false) return;
      selected = radio.getAttribute("value")!;
      for (const other of root.querySelectorAll("[role='radio']")) other.setAttribute("aria-checked", String(other === radio));
    });
  }
  document.querySelector("#filters")!.addEventListener("click", () => {
    openFilters();
    document.querySelector("#sheet")!.setAttribute("aria-hidden", "true");
    const modal = document.createElement("div"); modal.setAttribute("role", "dialog");
    modal.innerHTML = `<h2>Filters</h2>${controls}<button id="apply">Show 14 tee times</button>`;
    document.body.append(modal); wireRadios(modal);
    modal.querySelector("#apply")!.addEventListener("click", () => {
      applyFilters();
      if (options.applyWorks === false) return;
      modal.remove(); document.querySelector("#sheet")!.removeAttribute("aria-hidden");
    });
  });
  if (options.collapsed === false) {
    const inline = document.createElement("div"); inline.innerHTML = controls;
    document.body.append(inline); wireRadios(inline);
  }
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
  expect(bookingClick).not.toHaveBeenCalled(); expect(results).toHaveLength(1);
  return { result: results[0], selected, openFilters, applyFilters };
}

describe("Chronogolf player filtering through the complete content reader", () => {
  it.each([3, 4])("opens and applies collapsed filters for %i players without touching a tee time", async players => {
    const read = await readPublicPage({ players });
    expect(read.openFilters).toHaveBeenCalledOnce(); expect(read.applyFilters).toHaveBeenCalledOnce();
    expect(read.selected).toBe(String(players));
    expect(read.result).toMatchObject({status: "AVAILABLE", slots: [{startsAtLocal: "2026-09-19T12:51:00"}]});
  });
  it("retains the inline desktop controls", async () => {
    const read = await readPublicPage({collapsed: false});
    expect(read.openFilters).not.toHaveBeenCalled(); expect(read.result.status).toBe("AVAILABLE");
  });
  it.each([{selectionWorks: false}, {applyWorks: false}])("does not accept an unapplied filter: %j", async options => {
    expect((await readPublicPage(options)).result).toMatchObject({status: "READER_ERROR", slots: []});
  });
  it("stops at an access challenge before opening filters", async () => {
    const read = await readPublicPage({challenge: true});
    expect(read.openFilters).not.toHaveBeenCalled(); expect(read.result.status).toBe("ACCESS_CHALLENGE");
  });
});
