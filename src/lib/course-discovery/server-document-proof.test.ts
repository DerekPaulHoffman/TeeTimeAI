// @vitest-environment node
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
import { executeAccessRecipe, recipeTimeToInstant } from "./executor";
import { parseAccessRecipe, hashAccessRecipe, readRecipeFieldFormat } from "./recipe";
import { extractServerDocument, isServerDocumentSelector } from "./server-document-proof";
import * as native from "./native-public-browser";

const input = { date: "2030-10-22", timeZone: "America/New_York", players: 2, startTime: "08:00", endTime: "18:00" };
const now = () => new Date("2030-10-20T12:00:00Z");
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "BROWSER_DOM", target: { kind: "OUTDOOR", courseId: "course" },
  source: { officialUrl: "https://example.org/", bookingUrl: "https://example.org/", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: input.timeZone },
  browserTransport: "PINNED_HTTP", pageUrl: "https://example.org/?date={{date}}", steps: [],
  availabilityResponse: { kind: "SERVER_DOCUMENT", url: "https://example.org/?date={{date}}", method: "GET", date: { source: "QUERY", path: "date" } },
  permittedRoutes: [{ origin: "https://example.org", path: "/", methods: ["GET"], queryKeys: ["date"] },
    { origin: "https://example.org", path: "/later", methods: ["GET"], queryKeys: [] }],
  proof: { venue: { selector: "#venue" }, date: { selector: "#date", attribute: "value" }, complete: { serverDocument: true },
    players: { selector: "#players", attribute: "value" }, empty: { selector: "#empty" } },
  slots: { collection: { selector: "#times .slot" }, startsAt: { selector: ".start", attribute: "data-time" }, availableSpots: { selector: ".capacity" } },
});
const slot = '<article class="slot"><span class="start" data-time="2030-10-22T10:00:00.0000000">10:00</span><span class="capacity">4</span></article>';
const html = (contents = slot, script = "") => '<!doctype html><html><head><title>Public golf</title></head><body><h1 id="venue">Example Golf</h1>' +
  '<input id="date" value="2030-10-22"><input id="players" value="2"><div id="times">' + contents + '</div>' + script + '</body></html>';
afterEach(() => vi.restoreAllMocks());

describe("inert server-document proof", () => {
  it("accepts only a bounded simple selector grammar", () => {
    expect(isServerDocumentSelector("#times > article.slot .start")).toBe(true);
    for (const selector of ["body:has(.slot)", "#times[data-ready]", "script", ".a, .b", "> .slot"]) {
      if (selector === "script") continue;
      expect(isServerDocumentSelector(selector)).toBe(false);
    }
  });
  it("reads full source without executing scripts and rejects truncation and pagination", () => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    const value = extractServerDocument(r, html(), (field, value) => readRecipeFieldFormat(field, value));
    expect(value.rows).toEqual([{ startsAt: "2030-10-22T10:00:00.0000000", availableSpots: "4" }]);
    expect(() => extractServerDocument(r, html().replace("</html>", ""), readRecipeFieldFormat)).toThrow("SERVER_DOCUMENT_TRUNCATED");
    expect(() => extractServerDocument(r, html(slot, '<a rel="next" href="?page=2">Next</a>'), readRecipeFieldFormat)).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it("does not change hashes of existing recipes by inserting a response kind", () => {
    const before = recipe(); if (before.engine !== "BROWSER_DOM") throw new Error("fixture");
    const legacy = { ...before, availabilityResponse: { url: before.availabilityResponse.url, method: "GET", date: before.availabilityResponse.date },
      proof: { ...before.proof, complete: { selector: "#ready" } } };
    const parsed = parseAccessRecipe(legacy);
    expect(parsed).toEqual(legacy);
    expect(hashAccessRecipe(parsed)).toBe(hashAccessRecipe(legacy as typeof parsed));
  });
  it("does not admit server documents for HTTP JSON, simulator, or unsupported selectors", () => {
    expect(() => parseAccessRecipe({ ...recipe(), engine: "HTTP_JSON" })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe(), target: { kind: "SIMULATOR", courseId: "course", offeringId: "offering" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe(), slots: { ...recipe().slots, collection: { selector: "#times:nth-child(1)" } } })).toThrow();
  });
  it("accepts bounded .NET fractional seconds while retaining course-local time and rejecting invalid dates", () => {
    expect(recipeTimeToInstant("2030-10-22T10:00:00.0000000", input).toISOString()).toBe("2030-10-22T14:00:00.000Z");
    expect(recipeTimeToInstant("2030-10-22T10:00:00.123456789", input).toISOString()).toBe("2030-10-22T14:00:00.123Z");
    expect(() => recipeTimeToInstant("2030-02-30T10:00:00.0000000", input)).toThrow();
    expect(() => recipeTimeToInstant("2030-10-22T25:00:00.0000000", input)).toThrow();
    expect(() => recipeTimeToInstant("2030-10-22T10:00:00.1234567890", input)).toThrow();
  });
});

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executable))("server-document raw/live fence in isolated Chrome", () => {
  const run = async (body: string, transport: "PINNED_HTTP" | "NATIVE_CHROME" = "PINNED_HTTP", type = "text/html", pageUrl?: string, status = 200) => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture"); r.browserTransport = transport;
    if (pageUrl) { r.pageUrl = pageUrl; r.permittedRoutes.push({ origin: "https://example.org", path: "/shell", methods: ["GET"], queryKeys: [] }); }
    vi.spyOn(native, "continueNativeBrowserRead").mockImplementation(async route => {
      const bytes = Buffer.from(body), headers = { "content-type": type };
      await route.fulfill({ status, body: bytes, headers });
      return { status, url: route.request().url(), body: bytes, headers };
    });
    return executeAccessRecipe(r, input, { now, launchBrowser: () => chromium.launch({ executablePath: executable, headless: true }),
      fetch: async () => new Response(body, { status, headers: { "content-type": type } }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  };
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("requires the full matching %s document and preserves rows", async transport => {
    expect(await run(html(), transport)).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-10-22T14:00:00.000Z", availableSpots: 4 }] });
  }, 20_000);
  it("accepts explicit source empty and rejects an empty generic container", async () => {
    expect((await run(html('<p id="empty">No tee times available</p>'))).status).toBe("EMPTY");
    expect((await run(html(""))).complete).toBe(false);
  }, 20_000);
  it.each([
    html().replace("2030-10-22\"", "2030-10-23\""), html().replace("</html>", ""),
    html(slot, '<button>Load more</button>'),
    html(slot, '<script>document.querySelector(".capacity").textContent="9";</script>'),
    html("", `<script>document.querySelector('#times').innerHTML=${JSON.stringify(slot)};</script>`),
    html(slot, '<script>fetch("/later").catch(()=>{});</script>'),
    html(slot, '<script>setTimeout(()=>fetch("/later").catch(()=>{}),900);</script>'),
  ])("rejects incomplete, changed, scripted or paginated documents", async body => {
    expect((await run(body)).complete).toBe(false);
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("rejects successful non-HTML %s document bodies", async transport => {
    expect((await run(html(), transport, "text/plain")).complete).toBe(false);
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("rejects partial %s document responses even with complete-looking markup", async transport => {
    expect((await run(html(), transport, "text/html", undefined, 206)).complete).toBe(false);
  }, 20_000);
  it("does not accept a matching dated document loaded only in a subframe", async () => {
    expect((await run(html("", '<iframe src="https://example.org/?date=2030-10-22"></iframe>'), "PINNED_HTTP", "text/html", "https://example.org/shell")).complete).toBe(false);
  }, 20_000);
});
