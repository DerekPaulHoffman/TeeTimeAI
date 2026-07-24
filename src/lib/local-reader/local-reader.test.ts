import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  isAllowedLocalReaderUrl,
  localReaderJobSchema,
  localReaderResultSchema,
  signLocalReaderPayload,
  validateLocalReaderResultForJob,
  verifyLocalReaderSignature
} from "./contracts";

type Reader = {
  readSnapshot: (documentRoot: Document, pageUrl: string) => {
    status: string;
    slots: Array<Record<string, unknown>>;
  };
};

function loadReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "grassy-hill-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotGrassyHillReader as Reader;
}

describe("local Chrome reader contract", () => {
  it("accepts only Grassy Hill's public tee-time search route", () => {
    expect(
      isAllowedLocalReaderUrl(
        "grassy-hill",
        "https://grassyhill.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0"
      )
    ).toBe(true);
    expect(
      isAllowedLocalReaderUrl(
        "grassy-hill",
        "https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout"
      )
    ).toBe(false);
    expect(
      isAllowedLocalReaderUrl(
        "grassy-hill",
        "https://example.com/onlineresweb/search-teetime"
      )
    ).toBe(false);
  });

  it("parses only rendered public card fields", () => {
    document.title = "Grassy Hill Country Club";
    document.body.innerHTML = `
      <button class="btn-teesheet">
        <time role="timer" datetime="2026-07-24T11:02:00">11:02</time>
        <div>CART INCLUDED</div>
        <div>9 or 18 HOLES | 2 - 4 GOLFERS</div>
        <div>$70.00</div>
      </button>
      <button class="btn-teesheet">
        <time role="timer" datetime="2026-07-24T15:50:00">3:50</time>
        <div>CART INCLUDED</div>
        <div>9 HOLES | 2 - 4 GOLFERS</div>
        <div>$43.00</div>
      </button>
    `;

    const snapshot = loadReader().readSnapshot(
      document,
      "https://grassyhill.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0"
    );

    expect(snapshot).toMatchObject({
      status: "AVAILABLE",
      slots: [
        {
          startsAtLocal: "2026-07-24T11:02:00",
          timeLabel: "11:02 AM",
          holes: [9, 18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 7000,
          cartIncluded: true
        },
        {
          startsAtLocal: "2026-07-24T15:50:00",
          timeLabel: "3:50 PM",
          holes: [9],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 4300,
          cartIncluded: true
        }
      ]
    });
  });

  it("reports challenge and page mismatch states without returning slots", () => {
    document.title = "Just a moment";
    document.body.innerHTML = "<main>Checking your browser before accessing this site</main>";
    const reader = loadReader();

    expect(
      reader.readSnapshot(
        document,
        "https://grassyhill.cps.golf/onlineresweb/search-teetime"
      )
    ).toMatchObject({ status: "ACCESS_CHALLENGE", slots: [] });
    expect(
      reader.readSnapshot(
        document,
        "https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout"
      )
    ).toMatchObject({ status: "PAGE_MISMATCH", slots: [] });
  });

  it("validates jobs and results and rejects malformed availability", () => {
    const requestedAt = "2026-07-24T12:00:00.000Z";
    expect(
      localReaderJobSchema.parse({
        id: "job-1",
        courseKey: "grassy-hill",
        targetDate: "2026-07-25",
        players: 2,
        requestedAt,
        expiresAt: "2026-07-24T12:05:00.000Z",
        bookingUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime"
      })
    ).toMatchObject({ courseKey: "grassy-hill", players: 2 });

    expect(() =>
      localReaderResultSchema.parse({
        jobId: "job-1",
        courseKey: "grassy-hill",
        status: "AVAILABLE",
        observedAt: requestedAt,
        pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "test"
      })
    ).toThrow(/at least one slot/u);
  });

  it("signs job traffic and rejects a changed payload", () => {
    const secret = "test-device-secret-1234";
    const payload = '{"jobId":"job-1"}';
    const signature = signLocalReaderPayload(secret, payload);

    expect(verifyLocalReaderSignature(secret, payload, signature)).toBe(true);
    expect(verifyLocalReaderSignature(secret, '{"jobId":"job-2"}', signature)).toBe(false);
  });

  it("rejects slots for the wrong date or an unsupported player count", () => {
    const job = localReaderJobSchema.parse({
      id: "job-1",
      courseKey: "grassy-hill",
      targetDate: "2026-07-25",
      players: 2,
      requestedAt: "2026-07-24T12:00:00.000Z",
      expiresAt: "2026-07-24T12:05:00.000Z",
      bookingUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime"
    });
    const result = localReaderResultSchema.parse({
      jobId: "job-1",
      courseKey: "grassy-hill",
      status: "AVAILABLE",
      observedAt: "2026-07-24T12:01:00.000Z",
      pageUrl: "https://grassyhill.cps.golf/onlineresweb/search-teetime",
      pageTitle: "Grassy Hill Country Club",
      slots: [
        {
          startsAtLocal: "2026-07-24T11:02:00",
          timeLabel: "11:02 AM",
          holes: [9, 18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 7000,
          cartIncluded: true
        }
      ],
      readerVersion: "test"
    });

    expect(() => validateLocalReaderResultForJob(job, result)).toThrow(
      /requested local date/u
    );
    expect(() =>
      validateLocalReaderResultForJob(
        { ...job, targetDate: "2026-07-24", players: 1 },
        result
      )
    ).toThrow(/requested players/u);
  });
});
