// @vitest-environment node
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
import { executeAccessRecipe, recipeTimeToInstant } from "./executor";
import { parseAccessRecipe, hashAccessRecipe, readRecipeFieldFormat } from "./recipe";
import { extractServerDocument, isServerDocumentSelector, sameServerDocumentEvidence, serverDocumentMismatchDiagnostic } from "./server-document-proof";
import * as native from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";

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
const calendar = (days = ["2030-10-21", "2030-10-22", "2030-10-23"], next = "2030-10-24", compact = true) => {
  const href = (day: string) => `/?date=${compact ? day.replaceAll("-", "") : day}`;
  return '<ol><li></li>' + days.map(day => {
    const date = new Date(`${day}T00:00:00Z`), labels = [new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date),
      date.getUTCDate(), new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date)];
    return `<li data-day="${day}">` + labels.map(label => `<div><a href="${href(day)}">${label}</a></div>`).join("") + '</li>';
  }).join("") + `<li><div><a href="${href(next)}">Next</a></div></li></ol>`;
};
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
  it("diagnoses generation counters separately without exposing values or changing equality", () => {
    const current = { generation: 0, documentSequence: 1, dataSequence: 0 }, extracted = { venue: "private marker", date: input.date, players: "2", rows: [] };
    const source = { ...current, extracted };
    expect(serverDocumentMismatchDiagnostic(undefined, current, extracted)).toBe("SERVER_DOCUMENT_SOURCE_MISSING");
    expect(serverDocumentMismatchDiagnostic({ ...source, generation: 1 }, current, extracted)).toBe("SERVER_DOCUMENT_GENERATION_MISMATCH");
    expect(serverDocumentMismatchDiagnostic({ ...source, documentSequence: 2 }, current, extracted)).toBe("SERVER_DOCUMENT_SEQUENCE_MISMATCH");
    expect(serverDocumentMismatchDiagnostic({ ...source, dataSequence: 1 }, current, extracted)).toBe("SERVER_DOCUMENT_DATA_SEQUENCE_MISMATCH");
    for (const [field, value, expected] of [["venue", "changed", "VENUE_VALUE"], ["date", "other", "DATE_VALUE"], ["players", 2, "PLAYERS_TYPE"]] as const) {
      const code = serverDocumentMismatchDiagnostic(source, current, { ...extracted, [field]: value });
      expect(code).toBe(`SERVER_DOCUMENT_FIELD_${expected}_MISMATCH`);
      expect(code).not.toContain("private marker");
    }
    expect(serverDocumentMismatchDiagnostic(source, current, { ...extracted, rows: [{}] })).toBe("SERVER_DOCUMENT_ROW_COUNT_MISMATCH");
  });
  it("canonicalizes only proved row-clock meridiem spacing introduced by child text", () => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    // Read the text field just as a no-attribute saved recipe does.
    const withoutAttribute = { ...r, slots: { ...r.slots, startsAt: { selector: ".start" } } };
    const inert = extractServerDocument(withoutAttribute, html(slot.replace('>10:00</span>', '>10:00<span>AM</span></span>')), readRecipeFieldFormat);
    const live = { ...inert, rows: [{ ...inert.rows[0], startsAt: "10:00AM" }] };
    expect(inert.rows[0].startsAt).toBe("10:00 AM");
    expect(sameServerDocumentEvidence(inert, live)).toBe(true);
    expect(serverDocumentMismatchDiagnostic({ generation: 0, documentSequence: 1, dataSequence: 0, extracted: inert },
      { generation: 0, documentSequence: 1, dataSequence: 0 }, live)).toBe("SERVER_DOCUMENT_NO_MISMATCH");
    expect(sameServerDocumentEvidence("10:00 AM", "10:00AM")).toBe(false);
  });
  it("keeps nonclock fields, changed times, invalid clocks and row identities exact", () => {
    expect(sameServerDocumentEvidence({ rows: [{ startsAt: "7:47 AM", endsAt: "8:47 PM" }] },
      { rows: [{ startsAt: "7:47AM", endsAt: "8:47PM" }] })).toBe(true);
    for (const field of ["venue", "date", "players", "duration", "capacity"])
      expect(sameServerDocumentEvidence({ [field]: "7:47 AM" }, { [field]: "7:47AM" })).toBe(false);
    for (const field of ["availableSpots", "minimumPlayers", "resourceId", "productId"])
      expect(sameServerDocumentEvidence({ rows: [{ [field]: "7:47 AM" }] }, { rows: [{ [field]: "7:47AM" }] })).toBe(false);
    for (const startsAt of ["8:47AM", "7:47PM", "07:47AM", "7 :47AM", "7:47AM extra"])
      expect(sameServerDocumentEvidence({ rows: [{ startsAt: "7:47 AM" }] }, { rows: [{ startsAt }] })).toBe(false);
    expect(sameServerDocumentEvidence({ rows: [{ startsAt: "7:47 AM" }] }, { rows: [] })).toBe(false);
  });
  it.each(["00:00 AM", "13:00 AM", "10:60 AM", "10:00 priceAM", "10 :00 AM", "10:00 AM extra"])("diagnostic never attests an invalid bounded meridiem clock: %s", startsAt => {
    const current = { generation: 0, documentSequence: 1, dataSequence: 0 }, raw = { rows: [{ startsAt }] };
    const live = { rows: [{ startsAt: startsAt.replace(/\s+/gu, "") }] };
    expect(serverDocumentMismatchDiagnostic({ ...current, extracted: raw }, current, live)).not.toContain("MERIDIEM_SPACING");
    expect(sameServerDocumentEvidence(raw, live)).toBe(false);
  });
  it.each([true, false])("classifies only a response-bound calendar Next with compact links: %s", compact => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    const body = html(slot, calendar(undefined, undefined, compact));
    const context = { responseUrl: `https://example.org/?date=${input.date}`, requestedDate: input.date };
    expect(extractServerDocument(r, body, readRecipeFieldFormat, context).rows).toHaveLength(1);
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat)).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it.each([
    ["2030-01-01", ["2029-12-30", "2029-12-31", "2030-01-01"], "2030-01-02"],
    ["2030-10-22", ["2030-10-21", "2030-10-22", "2030-10-23"], "2030-10-24"],
    ["2030-10-23", ["2030-10-22", "2030-10-23", "2030-10-24"], "2030-10-25"],
    ["2030-12-31", ["2030-12-29", "2030-12-30", "2030-12-31"], "2031-01-01"],
  ] as const)("binds the actual compact date template for %s without accepting a changed request", (day, days, next) => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    r.availabilityResponse.url = "https://example.org/?date={{dateCompact}}";
    const body = html(slot, calendar([...days], next)).replaceAll(input.date, day);
    const context = { responseUrl: `https://example.org/?date=${day.replaceAll("-", "")}`, requestedDate: day };
    expect(extractServerDocument(r, body, readRecipeFieldFormat, context).rows).toHaveLength(1);
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat,
      { ...context, responseUrl: "https://example.org/?date=20301021" })).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat,
      { ...context, responseUrl: `https://example.org/?date=${day}` })).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it("retains exact fixed filters while allowing calendar dates across a year boundary", () => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    const day = "2030-12-31";
    r.availabilityResponse.url = "https://example.org/?players=2&date={{date}}";
    const strip = calendar(["2030-12-29", "2030-12-30", day], "2031-01-01").replaceAll("?date=", "?players=2&amp;date=");
    const context = { responseUrl: `https://example.org/?players=2&date=${day}`, requestedDate: day };
    const body = html(slot, strip).replaceAll(input.date, day);
    expect(extractServerDocument(r, body, readRecipeFieldFormat, context).rows).toHaveLength(1);
    expect(() => extractServerDocument(r, body.replace('players=2&amp;date=20310101', 'players=3&amp;date=20310101'), readRecipeFieldFormat, context))
      .toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it("binds actual dynamic players without borrowing changed filters or another execution date", () => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    r.availabilityResponse.url = "https://example.org/?players={{players}}&date={{dateCompact}}";
    const strip = calendar().replaceAll("?date=", "?players=2&amp;date=");
    const body = html(slot, strip), context = { responseUrl: "https://example.org/?players=2&date=20301022", requestedDate: input.date, input };
    expect(extractServerDocument(r, body, readRecipeFieldFormat, context).rows).toHaveLength(1);
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat, { ...context, input: { ...input, players: 3 } })).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, body.replaceAll("players=2", "players=3"), readRecipeFieldFormat, context)).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat, { ...context, input: { ...input, date: "2030-10-23" } })).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, body, readRecipeFieldFormat, { responseUrl: context.responseUrl, requestedDate: input.date })).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it.each([
    (strip: string) => strip.replace("date=20301024", "date=20301022"),
    (strip: string) => strip.replace("date=20301024", "date=20301023"),
    (strip: string) => strip.replace("date=20301024", "date=20401024"),
    (strip: string) => strip.replace("date=20301024", "date=20300230"),
    (strip: string) => strip.replace("date=20301024", "date=20301024&amp;page=2"),
    (strip: string) => strip.replace("date=20301024", "date=20301024&amp;cursor=2"),
    (strip: string) => strip.replace("date=20301024", "date=20301024&amp;offset=2"),
    (strip: string) => strip.replace("date=20301024", "date=20301024&amp;unknown=2"),
    (strip: string) => strip.replace("date=20301024", "date=20301024&amp;date=20301025"),
    (strip: string) => strip.replace('href="/?date=20301024"', 'href="https://other.example.org/?date=20301024"'),
    (strip: string) => strip.replace('href="/?date=20301024"', 'href="/?date=20301024#page2"'),
    (strip: string) => strip.replace('href="/?date=20301024"', 'onclick="return false" href="/?date=20301024"'),
    (strip: string) => strip.replace('href="/?date=20301024"', 'target="_blank" href="/?date=20301024"'),
    (strip: string) => strip.replace('href="/?date=20301024"', 'aria-label="Load more" href="/?date=20301024"'),
    (strip: string) => strip.replace('<a href="/?date=20301024">Next</a>', '<button>Next</button>'),
    (strip: string) => strip.replace('data-day="2030-10-22"', 'hidden data-day="2030-10-22"'),
    (strip: string) => strip.replace('data-day="2030-10-22"', 'class="visually-hidden" data-day="2030-10-22"'),
    (strip: string) => strip.replace('>Oct</a>', '>Nov</a>'),
    () => calendar(["2030-10-20", "2030-10-21"], "2030-10-22"),
    () => calendar(["2030-10-21", "2030-10-22", "2030-10-22"], "2030-10-23"),
    () => calendar(Array.from({ length: 15 }, (_, i) => new Date(Date.parse('2030-10-22') + i * 86_400_000).toISOString().slice(0, 10)), '2030-11-06'),
  ])("rejects unproved, same-date, paged, distant, concealed or ambiguous Next controls %#", mutate => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    expect(() => extractServerDocument(r, html(slot, mutate(calendar())), readRecipeFieldFormat,
      { responseUrl: `https://example.org/?date=${input.date}`, requestedDate: input.date })).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it.each(['rel="next"', 'rel="NEXT"', 'data-next-page="2"', 'class="pagination"', 'class="infinite-scroll"'])("never waives strong pagination marker %s", marker => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    expect(() => extractServerDocument(r, html(slot, calendar().replace('href="/?date=20301024"', `${marker} href="/?date=20301024"`)), readRecipeFieldFormat,
      { responseUrl: `https://example.org/?date=${input.date}`, requestedDate: input.date })).toThrow("SERVER_DOCUMENT_PAGINATION");
  });
  it("keeps pagination outside the date strip and date navigation inside slot rows incomplete", () => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture");
    const context = { responseUrl: `https://example.org/?date=${input.date}`, requestedDate: input.date };
    expect(() => extractServerDocument(r, html(slot, calendar() + '<button>Load more</button>'), readRecipeFieldFormat, context)).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, html(slot.replace('</article>', calendar() + '</article>')), readRecipeFieldFormat, context)).toThrow("SERVER_DOCUMENT_PAGINATION");
    expect(() => extractServerDocument(r, html(slot, calendar()), readRecipeFieldFormat, { ...context, responseUrl: 'https://example.org/?date=2030-10-23' })).toThrow("SERVER_DOCUMENT_PAGINATION");
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
  const run = async (body: string, transport: "PINNED_HTTP" | "NATIVE_CHROME" = "PINNED_HTTP", type = "text/html", pageUrl?: string, status = 200,
    execution = input, template?: string, textStart = false) => {
    const r = recipe(); if (r.engine !== "BROWSER_DOM") throw new Error("fixture"); r.browserTransport = transport;
    if (template) { r.pageUrl = template; r.availabilityResponse.url = template; r.permittedRoutes[0].queryKeys.push("players"); }
    if (textStart) r.slots.startsAt = { selector: ".start" };
    if (pageUrl) { r.pageUrl = pageUrl; r.permittedRoutes.push({ origin: "https://example.org", path: "/shell", methods: ["GET"], queryKeys: [] }); }
    // Isolate the executor's raw/live proof seam. Actual native interception is
    // qualified separately; its CDP routes intentionally cannot fulfill bytes.
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
      prepare() {}, pendingReads: 0, lastFailure: undefined, close: async () => {},
      releasePlaywrightRoute: async route => { await handler(route); },
    }));
    vi.spyOn(native, "continueNativeBrowserRead").mockImplementation(async route => {
      const bytes = Buffer.from(body), headers = { "content-type": type };
      await route.fulfill({ status, body: bytes, headers });
      return { status, url: route.request().url(), body: bytes, headers };
    });
    return executeAccessRecipe(r, execution, { now, launchBrowser: () => chromium.launch({ executablePath: executable, headless: true }),
      fetch: async () => new Response(body, { status, headers: { "content-type": type } }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }) });
  };
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("requires the full matching %s document and preserves rows", async transport => {
    expect(await run(html(), transport)).toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: "2030-10-22T14:00:00.000Z", availableSpots: 4 }] });
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("accepts a proved calendar strip through the %s executor binding", async transport => {
    expect(await run(html(slot, calendar()), transport)).toMatchObject({ status: "AVAILABLE", complete: true,
      slots: [{ startsAt: "2030-10-22T14:00:00.000Z", availableSpots: 4 }] });
  }, 20_000);
  it.each(["PINNED_HTTP", "NATIVE_CHROME"] as const)("preserves explicit source player options in the %s raw/live proof", async transport => {
    expect(await run(html(slot.replace('>4</span>', '>1 to 4 players</span>'), calendar()), transport))
      .toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ availableSpots: 4 }] });
    expect(await run(html(slot.replace('>4</span>', '>1 or 4 players</span>'), calendar()), transport))
      .toMatchObject({ status: "EMPTY", complete: true, slots: [] });
  }, 20_000);
  it("diagnoses live input-value mutation while preserving raw value attribute rejection", async () => {
    const result = await run(html(slot, '<script>document.querySelector("#date").value="2030-10-23";</script>'));
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, evidence: { reason: "SERVER_DOCUMENT_DOM_MISMATCH",
      diagnostic: { code: "SERVER_DOCUMENT_FIELD_DATE_VALUE_MISMATCH" } } });
  }, 20_000);
  it("accepts the same bounded inline-meridiem clock without altering the public time", async () => {
    const body = html(slot.replace('>10:00</span>', '>10:00<span>AM</span></span>'));
    const result = await run(body, "PINNED_HTTP", "text/html", undefined, 200, input, undefined, true);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true,
      slots: [{ startsAt: "2030-10-22T14:00:00.000Z", availableSpots: 4 }] });
  }, 20_000);
  it.each([
    '<script>document.querySelector(".start").textContent="11:00AM";</script>',
    '<script>document.querySelector(".start").textContent="10:00PM";</script>',
    '<script>document.querySelector(".slot").style.display="none";</script>',
  ])("rejects semantic client time mutations or hidden rows after meridiem canonicalization", async script => {
    const body = html(slot.replace('>10:00</span>', '>10:00<span>AM</span></span>'), script);
    expect(await run(body, "PINNED_HTTP", "text/html", undefined, 200, input, undefined, true))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "SERVER_DOCUMENT_DOM_MISMATCH" } });
  }, 20_000);
  it("rejects invalid inline-meridiem clocks instead of canonicalizing them", async () => {
    const body = html(slot.replace('>10:00</span>', '>13:00<span>AM</span></span>'));
    expect(await run(body, "PINNED_HTTP", "text/html", undefined, 200, input, undefined, true))
      .toMatchObject({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "SERVER_DOCUMENT_DOM_MISMATCH" } });
  }, 20_000);
  it.each(["2030-12-31", "2031-01-01"])("replays the actual compact date and player fence on %s", async date => {
    const days = [new Date(Date.parse(date) - 86_400_000).toISOString().slice(0, 10), date];
    const next = new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10);
    const strip = calendar(days, next).replaceAll("?date=", "?players=2&amp;date=");
    const body = html(slot, strip).replaceAll(input.date, date);
    expect(await run(body, "PINNED_HTTP", "text/html", undefined, 200, { ...input, date }, "https://example.org/?players={{players}}&date={{dateCompact}}"))
      .toMatchObject({ status: "AVAILABLE", complete: true, slots: [{ startsAt: `${date}T15:00:00.000Z`, availableSpots: 4 }] });
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
