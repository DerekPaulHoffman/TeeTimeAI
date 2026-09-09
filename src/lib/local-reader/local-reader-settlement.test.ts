import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

type Snapshot = {
  status: "AVAILABLE" | "NO_AVAILABILITY" | "ACCESS_CHALLENGE" | "PAGE_MISMATCH" | "READER_ERROR";
  slots: unknown[];
};

type Reader = {
  prepareRenderedResults?: (documentRoot: Document, windowRoot: unknown) => Promise<void>;
  readSnapshot: (documentRoot: Document, pageUrl: string, job: unknown) => Snapshot;
};

type FixtureControl = {
  document: Document;
  location: URL;
};

const readerSource = readFileSync(
  resolve(process.cwd(), "tools/local-chrome-reader/tenfore-reader.js"),
  "utf8"
);
const contentSource = readFileSync(
  resolve(process.cwd(), "tools/local-chrome-reader/content.js"),
  "utf8"
);
const clockOrigin = Date.parse("2026-07-29T12:00:00.000Z");
const job = {
  bookingUrl: "https://fox.tenfore.golf/offline-fixture?date=2026-07-29",
  cardTextIncludes: [],
  courseKey: "tenfore:offline-fixture",
  courseName: "Offline reader fixture",
  players: 4,
  targetDate: "2026-07-29"
};

function card(id: string, capacity: string | null, time = "1:20 PM") {
  return `<div class="bg-white text-xl font-medium leading-none">
    <div class="text-2xl font-bold">${time}</div>
    <div id="${id}">${capacity === null ? "" : details(capacity)}</div>
    <div>Online Booking</div>
  </div>`;
}

function details(capacity = "1-4") {
  return `<span>18</span><span>${capacity}</span><span>$42.00</span>`;
}

async function runContent(options: {
  cards: string;
  cps?: boolean;
  emptyText?: string;
  changeAtMs?: number;
  change?: (control: FixtureControl) => void;
  prepare?: (control: FixtureControl) => void;
  prepareDelayMs?: number;
}) {
  // Every case executes the full production content script, including its normal
  // storage lookup, readiness, preparation, parser call, and result submission.
  document.title = "Offline reader fixture";
  document.body.innerHTML = `
    <div class="filter-section" data-filter-key="selectedDate">
      <div class="filter-value">Jul 29, 2026</div>
    </div>
    ${options.cards}
    ${options.emptyText ?? ""}
  `;
  Object.defineProperty(document.body, "innerText", {
    configurable: true,
    get() {
      return this.textContent;
    }
  });
  const activeJob = options.cps ? { ...job, courseKey: "cps:offline-fixture.cps.golf", bookingUrl: "https://offline-fixture.cps.golf/onlineresweb/search-teetime" } : job;
  const location = new URL(activeJob.bookingUrl);
  const control = { document, location };
  let clockMs = 0;
  let changeApplied = false;
  let timerId = 0;
  const events: { event: string; atMs: number }[] = [];
  const submissions: { snapshot: Snapshot; atMs: number }[] = [];
  let resolveResult!: (snapshot: Snapshot) => void;
  const submitted = new Promise<Snapshot>((resolveResultPromise) => {
    resolveResult = resolveResultPromise;
  });

  function advance(milliseconds: number) {
    clockMs += milliseconds;
    if (clockMs > 30_000) {
      throw new Error("Offline reader exceeded the bounded test clock");
    }
    if (!changeApplied && options.changeAtMs !== undefined && clockMs >= options.changeAtMs) {
      changeApplied = true;
      options.change?.(control);
    }
  }

  class ClockDate extends Date {
    constructor(value?: string | number) {
      super(value ?? clockOrigin + clockMs);
    }

    static now() {
      return clockOrigin + clockMs;
    }
  }

  const setTimeout = (callback: () => void, milliseconds = 0) => {
    advance(milliseconds);
    callback();
    return ++timerId;
  };
  const fetch = vi.fn(() => {
    throw new Error("Offline reader tests must not perform network requests");
  });
  const click = vi.fn();
  document.addEventListener("click", click);
  const context: Record<string, unknown> = {
    CSS: { escape: (value: string) => value },
    Date: ClockDate,
    HTMLSelectElement,
    URL,
    document,
    fetch,
    getComputedStyle: window.getComputedStyle.bind(window),
    location,
    setTimeout,
    window: { getComputedStyle: window.getComputedStyle.bind(window), setTimeout },
    chrome: {
      storage: {
        local: { get: async () => ({ pendingJobs: { "1": { job: activeJob } } }) }
      },
      runtime: {
        onMessage: { addListener: () => undefined },
        sendMessage: async (message: { type: string; result?: Snapshot }) => {
          if (message.type === "LOCAL_READER_IDENTIFY_TAB") return { tabId: 1 };
          if (message.type !== "LOCAL_READER_RESULT" || !message.result) {
            throw new Error("Unexpected offline reader message");
          }
          submissions.push({ snapshot: message.result, atMs: clockMs });
          resolveResult(message.result);
          return true;
        }
      }
    }
  };
  context.globalThis = context;
  runInNewContext(options.cps ? readFileSync(resolve(process.cwd(), "tools/local-chrome-reader/cps-reader.js"), "utf8") : readerSource, context);
  const reader = (options.cps ? context.TeeTimeSpotCpsReader : context.TeeTimeSpotTenForeReader) as Reader;
  const readSnapshot = reader.readSnapshot;
  reader.readSnapshot = (...args) => {
    events.push({ event: "snapshot", atMs: clockMs });
    return readSnapshot(...args);
  };
  if (options.prepare) {
    reader.prepareRenderedResults = async () => {
      events.push({ event: "prepare-start", atMs: clockMs });
      advance(options.prepareDelayMs ?? 0);
      options.prepare?.(control);
      events.push({ event: "prepare-complete", atMs: clockMs });
    };
  }

  try {
    runInNewContext(contentSource, context);
    const snapshot = await submitted;
    await Promise.resolve();
    expect(submissions).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    return { snapshot, submittedAtMs: submissions[0].atMs, events };
  } finally {
    document.removeEventListener("click", click);
  }
}

describe("rendered reader snapshot settlement", () => {
  it("reports the CPS visitor challenge before touching player or date controls", async () => {
    const result = await runContent({ cps: true, cards: "<h1>Security check · Verifying</h1> <p>We sometimes confirm a visitor is human.</p> <button class='mat-button-toggle-button' name='fontStyle'>4</button>" });
    expect(result.snapshot.status).toBe("ACCESS_CHALLENGE");
    expect(result.submittedAtMs).toBe(0);
  });
  it("keeps the existing fast path when all card details are already valid", async () => {
    const result = await runContent({ cards: card("ready", "1-4") });

    expect(result.submittedAtMs).toBe(750);
    expect(result.snapshot.status).toBe("AVAILABLE");
    expect(result.snapshot.slots).toHaveLength(1);
  });

  it.each([
    { label: "all details pending", initial: "", expectedSlots: 1 },
    { label: "a qualified card and pending details", initial: card("ready", "1-4", "2:10 PM"), expectedSlots: 2 },
    { label: "an unqualified card and pending details", initial: card("ready", "1-2", "2:10 PM"), expectedSlots: 1 }
  ])("waits for $label without treating a stable label count as complete", async ({ initial, expectedSlots }) => {
    const result = await runContent({
      cards: initial + card("pending", null),
      changeAtMs: 2_000,
      change: ({ document }) => {
        document.getElementById("pending")!.innerHTML = details();
      }
    });

    expect(result.submittedAtMs).toBe(2_000);
    expect(result.snapshot.status).toBe("AVAILABLE");
    expect(result.snapshot.slots).toHaveLength(expectedSlots);
  });

  it.each([
    { label: "all malformed", initial: "" },
    { label: "qualified plus malformed", initial: card("ready", "1-4", "2:10 PM") },
    { label: "unqualified plus malformed", initial: card("ready", "1-2", "2:10 PM") }
  ])("retains READER_ERROR at the absolute deadline for $label cards", async ({ initial }) => {
    const result = await runContent({ cards: initial + card("pending", null) });

    expect(result.submittedAtMs).toBe(25_000);
    expect(result.snapshot.status).toBe("READER_ERROR");
    expect(result.snapshot.slots).toEqual([]);
  });

  it.each([
    {
      label: "route",
      expectedStatus: "PAGE_MISMATCH",
      change: ({ location }: FixtureControl) => { location.pathname = "/unsupported-route"; }
    },
    {
      label: "date",
      expectedStatus: "PAGE_MISMATCH",
      change: ({ document }: FixtureControl) => {
        document.querySelector(".filter-value")!.textContent = "Jul 30, 2026";
      }
    },
    {
      label: "challenge",
      expectedStatus: "ACCESS_CHALLENGE",
      change: ({ document }: FixtureControl) => {
        document.body.insertAdjacentHTML("beforeend", "<aside>Verify you are human</aside>");
      }
    }
  ])("terminates fail-closed when the $label changes during passive settlement", async ({ change, expectedStatus }) => {
    const result = await runContent({
      cards: card("pending", null),
      changeAtMs: 1_250,
      change
    });

    expect(result.submittedAtMs).toBe(1_250);
    expect(result.snapshot.status).toBe(expectedStatus);
    expect(result.snapshot.slots).toEqual([]);
  });

  it("preserves the existing explicit empty-state wait", async () => {
    const result = await runContent({ cards: "", emptyText: "<p>No tee times available</p>" });

    expect(result.submittedAtMs).toBe(5_000);
    expect(result.snapshot.status).toBe("NO_AVAILABILITY");
    expect(result.snapshot.slots).toEqual([]);
  });

  it("runs the existing preparation hook before the first snapshot", async () => {
    const result = await runContent({
      cards: card("pending", null),
      prepare: ({ document }) => {
        document.getElementById("pending")!.innerHTML = details();
      }
    });

    expect(result.events).toEqual([
      { event: "prepare-start", atMs: 750 },
      { event: "prepare-complete", atMs: 750 },
      { event: "snapshot", atMs: 750 }
    ]);
    expect(result.snapshot.status).toBe("AVAILABLE");
    expect(result.snapshot.slots).toHaveLength(1);
  });

  it("does not restart the absolute deadline after preparation", async () => {
    const result = await runContent({
      cards: card("pending", null),
      prepare: () => undefined,
      prepareDelayMs: 10_000
    });

    expect(result.submittedAtMs).toBe(25_000);
    expect(result.events[0]).toEqual({ event: "prepare-start", atMs: 750 });
    expect(result.events[1]).toEqual({ event: "prepare-complete", atMs: 10_750 });
    expect(result.events.filter(({ event }) => event === "prepare-start")).toHaveLength(1);
    expect(result.snapshot.status).toBe("READER_ERROR");
    expect(result.snapshot.slots).toEqual([]);
  });
});
