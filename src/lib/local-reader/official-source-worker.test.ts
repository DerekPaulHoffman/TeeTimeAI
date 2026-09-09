import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOfficialSourceResult, type OfficialSourceJob, type OfficialSourceResult } from "./official-source-contracts";
import { verifyLocalReaderSignature } from "./contracts";

const background = readFileSync(resolve("tools/local-chrome-reader/background.js"), "utf8");
const content = readFileSync(resolve("tools/local-chrome-reader/official-source-content.js"), "utf8");
const parser = readFileSync(resolve("tools/local-chrome-reader/official-source-reader.js"), "utf8");
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; });

describe("official-source extension worker and content transport", () => {
  it("follows the retained directory to its course page and submits a signed bounded result", async () => {
    const now = new Date("2026-09-09T19:00:00Z");
    vi.useFakeTimers(); vi.setSystemTime(now);
    const job: OfficialSourceJob = { id: "controlled-source", purpose: "OFFICIAL_SOURCE_DISCOVERY",
      courseKey: "official-source:parks.cityofomaha.org", contextKey: "a".repeat(64),
      course: { id: "elmwood", name: "Elmwood 18 Hole Golf Course", address: "6232 Pacific St., Omaha, NE", city: "Omaha",
        stateCode: "NE", timeZone: "America/Chicago", website: "http://parks.cityofomaha.org/golf" },
      sourceUrl: "https://parks.cityofomaha.org/golf", requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString() };
    const wire = { ...job, bookingUrl: job.sourceUrl, courseName: job.course.name, cardTextIncludes: [],
      leaseToken: "controlled-lease", leaseExpiresAt: job.expiresAt, requiredCapability: { key: "OFFICIAL_SOURCE_RENDERED", parserVersion: 1 } };
    const secret = "worker-test-source-secret";
    const storage: Record<string, unknown> = { enabled: true, backendOrigin: "https://teetimespot.com", deviceId: "test-source",
      deviceToken: secret, pendingJobs: { "1": { job: wire, openedAt: now.toISOString(), closeTabOnFinish: true } } };
    const listeners: Array<(message: unknown, sender: unknown) => Promise<unknown>> = [];
    const writes: OfficialSourceResult[] = [];
    const navigations: string[] = [];
    let pageUrl = "https://parks.cityofomaha.org/golf-course/";
    const local = { get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys])
      .map(key => [key, structuredClone(storage[key])])),
      set: async (data: Record<string, unknown>) => { Object.assign(storage, structuredClone(data)); } };
    const noop = () => undefined;
    const chrome = { storage: { local }, runtime: { onInstalled: { addListener: noop }, onStartup: { addListener: noop },
      onMessage: { addListener: (listener: typeof listeners[number]) => listeners.push(listener) }, getManifest: () => ({ version: "1.12.0" }) },
      alarms: { onAlarm: { addListener: noop } },
      tabs: { onUpdated: { addListener: noop }, remove: vi.fn(), update: async (_tabId: number, update: { url: string }) => {
        navigations.push(update.url); pageUrl = `${update.url.replace(/\/$/u, "")}/`;
      } } };
    const workerContext = { chrome, URL, Date, AbortController, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout,
      fetch: async (url: string, options: { method: string; body: string; headers: Record<string, string> }) => {
        expect(options.method).toBe("POST");
        expect(url).toBe(`https://teetimespot.com/api/local-reader/jobs/${job.id}/result`);
        expect(options.headers["x-local-reader-lease"]).toBe(wire.leaseToken);
        const path = new URL(url).pathname;
        expect(verifyLocalReaderSignature(secret, `POST\n${path}\n${options.headers["x-local-reader-timestamp"]}\n${options.body}`,
          options.headers["x-local-reader-signature"])).toBe(true);
        writes.push(JSON.parse(options.body)); return { ok: true, status: 200 };
      } };
    runInNewContext(background, workerContext);
    const pending: Promise<unknown>[] = [];
    async function visit(html: string) {
      document.body.innerHTML = html;
      const contentContext = { document, location: new URL(pageUrl), URL, Date,
        chrome: { storage: { local }, runtime: { onMessage: { addListener: noop }, sendMessage: (message: unknown) => {
          const promise = Promise.resolve(listeners[0](message, { url: pageUrl, tab: { id: 1 } }));
          pending.push(promise); return promise;
        } } } };
      runInNewContext(parser + "\n" + content, contentContext);
      // Drain actual message promises, including messages added after storage.
      for (let i = 0; i < 8; i++) { await Promise.all(pending); await Promise.resolve(); }
    }
    await visit(`<h2>Omaha Golf Courses</h2><a href="/elmwoodgolf-course">Elmwoodgolf Course</a>
      <a href="/johnny-goodman-golf-course">Johnny Goodman Golf Course</a>
      <a href="https://other.example/elmwood">Elmwood Golf Course</a>`);
    expect(navigations).toEqual(["https://parks.cityofomaha.org/elmwoodgolf-course"]); expect(writes).toEqual([]);
    await visit(`<h1>Elmwood Golf Course</h1><p>6232 Pacific St.</p><footer>Omaha, NE</footer>
      <a href="https://city-of-omaha.book.teeitup.com/?course=8336">Book A Tee Time</a>`);
    expect(writes).toHaveLength(1); validateOfficialSourceResult(job, writes[0], now);
    expect(writes[0].pages).toHaveLength(2); expect(navigations).toHaveLength(1);
    expect(storage.pendingJobs).toEqual({}); expect(chrome.tabs.remove).toHaveBeenCalledWith(1);
    expect(storage.lastStatus).toBe("COMPLETED");
  });
});
