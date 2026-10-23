// @vitest-environment node
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe, venueProofMatches } from "./executor";
import { parseAccessRecipe } from "./recipe";
import { matchesPublicVenueGreeting } from "./public-venue-greeting";
import * as native from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

const venue = "Example Ridge Golf Club";
const greeting = `Welcome to the ${venue}'s online tee time engine. You are guaranteed to receive the best online rates for Example Ridge when you book direct with us. We look forward to seeing on the golf course.`;
const input = { date: "2030-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const recipe = (transport: "PINNED_HTTP" | "NATIVE_CHROME", enabled: boolean) => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", browserTransport: transport,
  target: { kind: "OUTDOOR", courseId: "course" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/", venueName: venue, providerFamily: "EXAMPLE", timeZone: input.timeZone },
  pageUrl: "https://example.org/?date={{date}}", steps: [],
  permittedRoutes: [{ origin: "https://example.org", path: "/", methods: ["GET"], queryKeys: ["date"] }],
  availabilityResponse: { kind: "SERVER_DOCUMENT", url: "https://example.org/?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
  proof: { venue: { selector: "#venue", ...(enabled ? { format: "VENUE_GREETING" } : {}) }, date: { selector: "#date", attribute: "value" }, complete: { serverDocument: true } },
  slots: { collection: { selector: ".slot" }, startsAt: { selector: ".start" }, availableSpots: { selector: ".capacity" } } });
const html = (text: string, tail = "", attributes = "") => '<!doctype html><html><head><title>Public golf</title></head><body>' +
  `<div id="venue" ${attributes}>${text}</div><input id="date" value="${input.date}">` +
  '<article class="slot"><span class="start">10:00AM</span><span class="capacity">1 to 4 players</span></article>' + tail + '</body></html>';
afterEach(() => vi.restoreAllMocks());

describe.runIf(existsSync(executable))("venue greeting interpretation after full server-document parity", () => {
  const run = async (body: string, transport: "PINNED_HTTP" | "NATIVE_CHROME" = "PINNED_HTTP", enabled = true) => {
    // These fixtures isolate executor source/live proof. Actual CDP network
    // identity is covered by the separate native TLS/browser test lane.
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare() {}, beginDocumentNavigation: async () => {}, pendingReads: 0, lastFailure: undefined, close: async () => {},
      releasePlaywrightRoute: async route => { await handler(route); },
    }));
    vi.spyOn(native, "continueNativeBrowserRead").mockImplementation(async route => {
      const bytes = Buffer.from(body), headers = { "content-type": "text/html" };
      await route.fulfill({ status: 200, body: bytes, headers });
      return { status: 200, url: route.request().url(), body: bytes, headers };
    });
    return executeAccessRecipe(recipe(transport, enabled), input, {
      now: () => new Date("2030-10-20T12:00:00Z"), launchBrowser: () => chromium.launch({ executablePath: executable, headless: true }),
      fetch: async () => new Response(body, { headers: { "content-type": "text/html" } }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
  };
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("interprets a complete visible generic claim only after %s parity", async transport => {
    expect(await run(html(greeting), transport)).toMatchObject({ status: "AVAILABLE", complete: true,
      slots: [{ startsAt: "2030-10-22T14:00:00.000Z", availableSpots: 4 }], evidence: { venueVerified: true, dateVerified: true } });
  }, 20_000);
  it("keeps ordinary exact-name proof unchanged and requires explicit opt-in for greetings", async () => {
    expect(await run(html(venue), "PINNED_HTTP", false)).toMatchObject({ status: "AVAILABLE", complete: true });
    expect(await run(html(greeting), "PINNED_HTTP", false)).toMatchObject({ status: "INCOMPLETE", complete: false,
      evidence: { reason: "SOURCE_PROOF_MISMATCH", venueVerified: false } });
  }, 20_000);
  it.each([
    greeting.replace("for Example Ridge when", "for Other Valley when"),
    greeting.replace(`the ${venue}'s`, "the Other Valley Golf Club's"),
    `Other copy. Welcome to ${venue}.`, greeting + " Welcome to Other Valley Golf Club.",
  ])("rejects conflicting or buried visible claims without returning availability", async text => {
    expect(await run(html(text))).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { venueVerified: false } });
  }, 20_000);
  it.each(["hidden", 'style="display:none"', 'aria-hidden="true" style="display:none"'])("does not promote a hidden claim: %s", async attributes => {
    expect(await run(html(greeting, "", attributes))).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { venueVerified: false } });
  }, 20_000);
  it("compares complete raw/live strings even when two different greetings each verify independently", async () => {
    const changed = `Welcome to ${venue}.`;
    expect(matchesPublicVenueGreeting(venue, greeting, venueProofMatches)).toBe(true);
    expect(matchesPublicVenueGreeting(venue, changed, venueProofMatches)).toBe(true);
    const script = `<script>document.querySelector("#venue").textContent=${JSON.stringify(changed)};</script>`;
    expect(await run(html(greeting, script))).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [],
      evidence: { reason: "SERVER_DOCUMENT_DOM_MISMATCH", diagnostic: { code: "SERVER_DOCUMENT_FIELD_VENUE_VALUE_MISMATCH" } } });
  }, 20_000);
  it("retains full public-copy parity rather than extracting away a client mutation", async () => {
    const changed = greeting.replace("seeing on", "seeing you on");
    expect(matchesPublicVenueGreeting(venue, changed, venueProofMatches)).toBe(true);
    const script = `<script>document.querySelector("#venue").textContent=${JSON.stringify(changed)};</script>`;
    expect(await run(html(greeting, script))).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "SERVER_DOCUMENT_DOM_MISMATCH" } });
  }, 20_000);
  it("retains date and row mutation rejection with the greeting mode enabled", async () => {
    const dateMutation = '<script>document.querySelector("#date").value="2030-10-23";</script>';
    const rowMutation = '<script>document.querySelector(".capacity").textContent="9";</script>';
    expect((await run(html(greeting, dateMutation))).evidence.reason).toBe("SERVER_DOCUMENT_DOM_MISMATCH");
    expect((await run(html(greeting, rowMutation))).evidence.reason).toBe("SERVER_DOCUMENT_DOM_MISMATCH");
  }, 20_000);
});
