import { describe, expect, it, vi } from "vitest";
import { bindTeeItUpOfficialBookingFacility, readTeeItUpOfficialEmbed, readTeeItUpOfficialHome, teeItUpCompleteStreetAddress,
  teeItUpNumberOnlyAddressConflict } from "./teeitup-official-booking-source";
import { createTeeItUpOfficialBookingScope, observedTeeItUpOfficialBookingChain, type TeeItUpOfficialBookingToken } from "./teeitup-official-booking-context";
import { readTeeItUpOfficialBookingChain } from "./teeitup-official-booking-reader";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import type { ExistingAdapterRecipe } from "./existing-adapter-schema";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import * as teeItUpAdapter from "@/lib/adapters/teeitup";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://example-golf.book.teeitup.com/", venueName: "Example Ridge Golf Club",
  venueAddress: "565 Competition Road, Example, NC 27603, USA", timeZone: "America/New_York" };
const official = "https://www.example.org/", bookingPage = `${official}tee-times/`, entry = "https://example-ridge.play.teeitup.com/";
const homeHtml = `<html><body><h2>Welcome to ${source.venueName}</h2><a href="${bookingPage}">Tee Times</a><footer><p>${source.venueAddress}</p></footer></body></html>`;
const pageHtml = `<html><body><main><iframe src="${entry}" title="Public tee times" width="800" height="600"></iframe></main></body></html>`;
const home = { url: official, html: homeHtml, visibleEvidence: { title: source.venueName, headings: [`Welcome to ${source.venueName}`], linkUrls: [bookingPage], addressTexts: [source.venueAddress] } };
const directory = [{ id: 31, courseId: "public-course-31", name: source.venueName, address: "601 Competition Rd, Example, NC 27603, US", timeZone: source.timeZone, isSimulator: false }];
function observed(finalContentType = "text/html", nativeCurrentDocument?: (request: object, currentUrl: string, timeOrigin: number) => boolean, homePage = home) {
  const controller = new AbortController(), scope = createTeeItUpOfficialBookingScope(source, controller.signal, nativeCurrentDocument);
  const root = {}, normal = {}, page = {}, play = {}, book = {};
  const begin = (object: object, url: string, parent?: object) => scope.beginMainDocument(object, { url, method: "GET", parent })!;
  scope.completeMainDocument(begin(root, source.officialUrl), { status: 302, location: official });
  const homeToken = begin(normal, official, root);
  scope.completeMainDocument(homeToken, { status: 200, contentType: "text/html" });
  scope.observeRenderedSnapshot(homeToken, { url: official, timeOrigin: 1, officialPage: homePage, verifiedOfficial: { kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: source.officialUrl, documentUrl: official }, frames: [], blocked: false });
  const pageToken = begin(page, bookingPage);
  scope.completeMainDocument(pageToken, { status: 200, contentType: "text/html" });
  scope.observeRenderedSnapshot(pageToken, { url: bookingPage, timeOrigin: 2, officialPage: { url: bookingPage, html: pageHtml }, verifiedOfficial: { kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: source.officialUrl, documentUrl: bookingPage }, frames: [entry], blocked: false });
  scope.completeMainDocument(begin(play, entry), { status: 302, location: source.bookingUrl });
  const bookToken = begin(book, source.bookingUrl, play);
  scope.completeMainDocument(bookToken, { status: 200, contentType: finalContentType });
  scope.observeRenderedSnapshot(bookToken, { url: source.bookingUrl, timeOrigin: 3, frames: [], blocked: false });
  return { scope, controller, token: scope.tokenFor(source.bookingUrl, source.bookingUrl)!, bookToken, book };
}
function fixtureFetch(options: { directory?: unknown; home?: string; page?: string; empty?: boolean; status?: number; entryLocation?: string } = {}) {
  return vi.fn<typeof fetch>(async (value, init) => {
    const url = String(value);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "manual" });
    expect(new Headers(init?.headers).has("cookie")).toBe(false);
    if (url === source.officialUrl) return new Response("", { status: 302, headers: { location: official } });
    if (url === official) return new Response(options.home ?? homeHtml, { headers: { "content-type": "text/html" } });
    if (url === bookingPage) return new Response(options.page ?? pageHtml, { headers: { "content-type": "text/html" } });
    if (url === entry) return new Response("", { status: 302, headers: { location: options.entryLocation ?? source.bookingUrl } });
    if (url === source.bookingUrl) return new Response("<html><body>Public booking</body></html>", { status: options.status ?? 200, headers: { "content-type": "text/html" } });
    if (url.endsWith("/facilities")) return Response.json(options.directory ?? directory);
    const date = new URL(url).searchParams.get("date");
    return Response.json(options.empty ? [] : [{ teetimes: [{ courseId: directory[0].courseId, teetime: `${date}T15:00:00Z`, rates: [{ allowedPlayers: [2, 3, 4], holes: 18 }] }] }]);
  });
}
const deps = { now: () => new Date("2030-10-20T12:00:00Z"), venueMatches: venueProofMatches,
  recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant,
  requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
const input = { date: "2030-10-23", timeZone: source.timeZone, players: 2, startTime: "09:00", endTime: "18:00" };

describe("official booking source proof", () => {
  const footerRow = `${source.venueName} | 565 Competition Road Example, NC 27603 | 212-555-1234`;
  const shapedHome = (heading = "h4") => ({ ...home,
    html: `<html><body><${heading}>Welcome to ${source.venueName}!</${heading}><a href="#">Tee Times</a><a href="${bookingPage}">Book A Tee Time</a><a href="${bookingPage}">Tee Times</a><footer><p class="address">${footerRow}</p></footer></body></html>`,
    visibleEvidence: { ...home.visibleEvidence, headings: [`Welcome to ${source.venueName}!`], linkUrls: [official + "#", bookingPage], addressTexts: [footerRow.toUpperCase()] } });
  it.each(["h1", "h2", "h3", "h4", "h5", "h6"])("recognizes a standard %s and the exact printed footer without treating a self fragment as another route", heading => {
    expect(readTeeItUpOfficialHome(source, shapedHome(heading), true).bookingPageUrl).toBe(bookingPage);
  });
  it.each(["wrongHeading", "hiddenHeading", "formHeading", "inertHeading", "conflictingH1", "hiddenFooter", "formFooter", "inertFooter", "corporateFooter", "wrongBrand", "wrongStreet", "extraDirection", "missingUnit", "wrongZip", "wrongCountry", "invalidPhone", "renderedChanged", "ambiguousFooter", "otherRoute"])
  ("rejects the ordinary home shape when %s prevents exact current identity or route", variant => {
    const page = shapedHome();
    if (variant === "wrongHeading") page.html = page.html.replace(`Welcome to ${source.venueName}!`, "Welcome to Other Golf Club!");
    if (variant === "hiddenHeading") page.html = page.html.replace("<h4>", "<h4 hidden>");
    if (variant === "formHeading") page.html = page.html.replace("<h4>", "<form><h4>").replace("</h4>", "</h4></form>");
    if (variant === "inertHeading") page.html = page.html.replace("<h4>", "<h4 inert>");
    if (variant === "conflictingH1") page.html = page.html.replace("<body>", "<body><h1>Other Golf Club</h1>");
    if (variant === "hiddenFooter") page.html = page.html.replace("<footer>", "<footer hidden>");
    if (variant === "formFooter") page.html = page.html.replace("<footer>", "<footer><form>").replace("</footer>", "</form></footer>");
    if (variant === "inertFooter") page.html = page.html.replace("<footer>", "<footer inert>");
    if (variant === "corporateFooter") page.html = page.html.replace("<footer>", "<footer><h5>Corporate Address</h5>");
    const replacement = ({ wrongBrand: footerRow.replace(source.venueName, "Other Golf Club"), wrongStreet: footerRow.replace("Competition", "Other"), extraDirection: footerRow.replace("565 ", "565 N "), missingUnit: footerRow.replace("Road Example", "Road Suite 2 Example"), wrongZip: footerRow.replace("27603", "27604"), wrongCountry: footerRow.replace("27603", "27603, Canada"), invalidPhone: footerRow.replace("212-555-1234", "Call 212-555-1234") } as Record<string, string>)[variant];
    if (replacement) { page.html = page.html.replace(footerRow, replacement); page.visibleEvidence.addressTexts = [replacement.toUpperCase()]; }
    if (variant === "renderedChanged") page.visibleEvidence.addressTexts = [footerRow.toUpperCase().replace("COMPETITION", "OTHER")];
    if (variant === "ambiguousFooter") { const other = footerRow.replace("212-555-1234", "212-555-1235"); page.html = page.html.replace("</footer>", `<p>${other}</p></footer>`); page.visibleEvidence.addressTexts.push(other); }
    if (variant === "otherRoute") { const other = official + "other-booking/"; page.html = page.html.replace("</body>", `<a href="${other}">Tee Times</a></body>`); page.visibleEvidence.linkUrls.push(other); }
    expect(() => readTeeItUpOfficialHome(source, page, true)).toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  });
  it("earns the native chain and independently re-reads the unchanged method for two dates from the printed home shape", async () => {
    const page = shapedHome(), seen = observed("text/html", undefined, page);
    expect(observedTeeItUpOfficialBookingChain(seen.token)).toMatchObject({ iframeEntryUrl: entry, bookingSourceUrl: source.bookingUrl, iframeRedirectStatus: 302 });
    const fetch = fixtureFetch({ home: page.html });
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch, officialBookingSourceToken: seen.token });
    expect(adapter).toMatchObject({ family: "TEEITUP", officialBookingSourceProof: { iframeEntryUrl: entry, bookingSourceUrl: source.bookingUrl, providerAddressVerified: false } });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "course-example" }, source: { ...source, providerFamily: "TEEITUP" }, adapter }) as ExistingAdapterRecipe;
    const saved = JSON.stringify(recipe);
    for (const request of [input, { ...input, date: "2030-10-24", players: 4 }]) {
      const read = fixtureFetch({ home: page.html });
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch: read });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(read.mock.calls.filter(([url]) => [source.officialUrl, official, bookingPage, entry, source.bookingUrl].includes(String(url)))).toHaveLength(5);
      expect(JSON.stringify(recipe)).toBe(saved);
    }
  });
  it("suspends old chain authority and re-earns only the same native request after a current-document URL change", () => {
    const current = source.bookingUrl + "?course=public&date=2030-10-23&max=4";
    const native = { request: undefined as object | undefined, admitted: true };
    const seen = observed("text/html", (actual, url, timeOrigin) => native.admitted && actual === native.request && url === current && timeOrigin === 3);
    native.request = seen.book;
    seen.scope.suspendCurrentDocument(current);
    expect(() => observedTeeItUpOfficialBookingChain(seen.token)).toThrow();
    expect(seen.scope.tokenFor(source.bookingUrl, current)).toBeUndefined();
    seen.scope.checkCurrentDocument(current, 3);
    seen.scope.observeRenderedSnapshot(seen.bookToken, { url: current, timeOrigin: 3, frames: [], blocked: false });
    const token = seen.scope.tokenFor(source.bookingUrl, current)!;
    expect(observedTeeItUpOfficialBookingChain(token).bookingSourceUrl).toBe(source.bookingUrl);
    expect(seen.scope.diagnostics(current).chainTokenCurrent).toBe(true);
    native.admitted = false; seen.scope.suspendCurrentDocument(current); seen.scope.checkCurrentDocument(current, 3);
    expect(seen.scope.tokenFor(source.bookingUrl, current)).toBeUndefined(); expect(() => observedTeeItUpOfficialBookingChain(token)).toThrow();
  });
  it.each(["otherRequest", "changedTimeOrigin", "newMainRead", "noNativeProof"] as const)("never re-earns pending native context from %s", change => {
    const current = source.bookingUrl + "?course=public", native = { request: undefined as object | undefined };
    const seen = observed("text/html", (actual, url, timeOrigin) => change !== "noNativeProof" && actual === native.request && url === current && timeOrigin === 3);
    native.request = change === "otherRequest" ? {} : seen.book;
    seen.scope.suspendCurrentDocument(current);
    if (change === "newMainRead") seen.scope.beginMainDocument({}, { url: source.bookingUrl, method: "GET" });
    seen.scope.checkCurrentDocument(current, change === "changedTimeOrigin" ? 4 : 3);
    expect(seen.scope.tokenFor(source.bookingUrl, current)).toBeUndefined(); expect(() => observedTeeItUpOfficialBookingChain(seen.token)).toThrow();
  });
  it("retires a query-context token when native history returns to the canonical original URL", () => {
    const current = source.bookingUrl + "?course=public", native = { request: undefined as object | undefined };
    const seen = observed("text/html", (request, url, timeOrigin) => request === native.request && [current, source.bookingUrl].includes(url) && timeOrigin === 3);
    native.request = seen.book;
    seen.scope.suspendCurrentDocument(current); seen.scope.checkCurrentDocument(current, 3);
    seen.scope.observeRenderedSnapshot(seen.bookToken, { url: current, timeOrigin: 3, frames: [], blocked: false });
    const queryToken = seen.scope.tokenFor(source.bookingUrl, current)!;
    expect(observedTeeItUpOfficialBookingChain(queryToken).bookingSourceUrl).toBe(source.bookingUrl);
    seen.scope.suspendCurrentDocument(source.bookingUrl);
    expect(() => observedTeeItUpOfficialBookingChain(queryToken)).toThrow(); expect(seen.scope.tokenFor(source.bookingUrl, source.bookingUrl)).toBeUndefined();
    seen.scope.checkCurrentDocument(source.bookingUrl, 3);
    seen.scope.observeRenderedSnapshot(seen.bookToken, { url: source.bookingUrl, timeOrigin: 3, frames: [], blocked: false });
    expect(seen.scope.tokenFor(source.bookingUrl, source.bookingUrl)).toBeDefined();
    expect(() => observedTeeItUpOfficialBookingChain(queryToken)).toThrow(); expect(() => observedTeeItUpOfficialBookingChain(seen.token)).toThrow();
  });
  it("normalizes only an explicitly written US state while retaining every other full postal component", () => {
    expect(teeItUpCompleteStreetAddress("565 Competition Road, Example, North Carolina 27603, USA")).toEqual(teeItUpCompleteStreetAddress(source.venueAddress));
    for (const region of ["DC", "PR", "ZZ"]) expect(teeItUpCompleteStreetAddress(`565 Competition Road, Example, ${region} 27603, USA`)).toMatchObject({ region });
    for (const changed of ["565 Competition Road, Example, California 27603, USA", "566 Competition Road, Example, North Carolina 27603, USA", "565 N Competition Road, Example, North Carolina 27603, USA", "565 Competition Road Ste 2, Example, North Carolina 27603, USA", "565 Competition Road, Other, North Carolina 27603, USA", "565 Competition Road, Example, North Carolina 27604, USA"]) expect(teeItUpCompleteStreetAddress(changed)).not.toEqual(teeItUpCompleteStreetAddress(source.venueAddress));
    for (const changed of ["565 Competition Road, Example, Other 27603, USA", "565 Competition Road, Example, NC, USA", "565 Competition Road, Example, 27603, USA"]) expect(teeItUpCompleteStreetAddress(changed)).toBeUndefined();
  });
  it("treats an existing comma followed by a printed line break as address formatting", () => {
    const html = homeHtml.replace(source.venueAddress, "565 Competition Road, Example,<br>\nNC 27603");
    expect(readTeeItUpOfficialHome(source, { ...home, html }, true).bookingPageUrl).toBe(bookingPage);
    expect(teeItUpCompleteStreetAddress("565 Competition Road,, NC 27603")).toBeUndefined();
    expect(teeItUpCompleteStreetAddress("565 Competition Road, Example, Other, NC 27603")).toBeUndefined();
    for (const changed of ["565 Other Road, Example,<br>NC 27603", "565 Competition Road Ste 2, Example,<br>NC 27603", "565 N Competition Road, Example,<br>NC 27603", "565 Competition Road, Example,<br>NC 27604"])
      expect(() => readTeeItUpOfficialHome(source, { ...home, html: homeHtml.replace(source.venueAddress, changed) }, true)).toThrow();
  });
  it("does not claim rendered matches on an inert read or let diagnostics alter validation", () => {
    const values: unknown[] = [];
    const result = readTeeItUpOfficialHome(source, { ...home, visibleEvidence: undefined }, false, value => values.push(value));
    expect(JSON.stringify(values)).not.toMatch(/rendered(?:Venue|Link|Address)Matches/u);
    expect(readTeeItUpOfficialHome(source, home, true, () => { throw new Error("PRIVATE_CALLBACK_FAILURE"); }).bookingPageUrl).toBe(result.bookingPageUrl);
    expect(() => readTeeItUpOfficialHome(source, { ...home, visibleEvidence: undefined }, true, () => { throw new Error("PRIVATE_CALLBACK_FAILURE"); })).toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  });
  it("retains both literal address claims and both immutable provider IDs", () => {
    const seen = observed(), chain = observedTeeItUpOfficialBookingChain(seen.token);
    expect(bindTeeItUpOfficialBookingFacility(source, chain, directory)).toMatchObject({ kind: "OFFICIAL_BOOKING_SOURCE", alias: "example-golf",
      canonicalAddress: source.venueAddress, providerAddress: directory[0].address, providerAddressVerified: false, facilityId: 31, courseId: "public-course-31",
      initialVisibility: "RENDERED_CONTROLLER_OBSERVATION", warmVisibility: "INERT_ANCESTRY_ONLY_EXTERNAL_CSS_NOT_REFRESHED" });
    expect(source.venueAddress).toContain("565");
  });
  it.each(["601 Other Road, Example, NC 27603, USA", "601 Competition Road, Other, NC 27603, USA", "601 Competition Road, Example, SC 27603, USA",
    "601 Competition Road, Example, NC 27604, USA", "601 Competition Road, Example, NC 27603-1234, USA", "601 Competition Road Suite 2, Example, NC 27603, USA",
    "601 N Competition Road, Example, NC 27603, USA", "Competition Road, Example, NC 27603, USA", "601 Competition Road, Example, NC 27603, Canada"])("permits no non-number difference: %s", address => {
    expect(teeItUpNumberOnlyAddressConflict(source.venueAddress, address)).toBe(false);
  });
  it("preserves directions, unit and full postal code instead of discarding them", () => {
    const a = "565 North Competition Road SW Suite 2, Example, NC 27603-1234, USA";
    expect(teeItUpNumberOnlyAddressConflict(a, "601 N Competition Rd SW Ste 2, Example, NC 27603-1234, US")).toBe(true);
    expect(teeItUpCompleteStreetAddress(a)).toMatchObject({ before: "n", after: "sw", unitType: "ste", unit: "2", postalCode: "27603-1234" });
    expect(teeItUpNumberOnlyAddressConflict(a, a)).toBe(false);
  });
  it.each([
    homeHtml.replace("<footer>", '<footer hidden>'), homeHtml.replace("<footer>", '<footer aria-label="Corporate headquarters">'),
    homeHtml.replace("<footer>", '<footer><h3>Mailing address</h3>'), homeHtml.replace("Welcome to ", "Visit "),
    homeHtml.replace(source.venueAddress, "99 Other Rd, Example, NC 27603, US"), homeHtml.replace("Tee Times", "Member login"),
    homeHtml.replace("<a ", '<a style="display:none" '), homeHtml.replace("</body>", '<a href="/other">Book</a></body>'),
  ])("requires unique raw visible semantic identity and anchor %#", html => {
    expect(() => readTeeItUpOfficialHome(source, { ...home, html }, true)).toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  });
  it.each([pageHtml.replace("<main>", "<main hidden>"), pageHtml.replace("<iframe", '<iframe srcdoc="unsafe"'), pageHtml.replace("</main>", `<iframe src="${entry}"></iframe></main>`), pageHtml.replace(entry, "https://foreign.example.org/")])("rejects hidden/ambiguous/foreign iframe %#", html => {
    expect(() => readTeeItUpOfficialEmbed({ url: bookingPage, html }, [entry])).toThrow();
  });
  it.each([{ name: "Example Ridge East Golf Club" }, { timeZone: "America/Chicago" }, { isSimulator: true }, { isSimulator: undefined }])("rejects a nonunique or mismatching provider claim %#", change => {
    const chain = observedTeeItUpOfficialBookingChain(observed().token);
    expect(() => bindTeeItUpOfficialBookingFacility(source, chain, [{ ...directory[0], ...change }])).toThrow();
    expect(() => bindTeeItUpOfficialBookingFacility(source, chain, [directory[0], { ...directory[0], id: 32, courseId: "other" }])).toThrow();
  });
  it.each(["invalidate", "close", "abort", "path", "same-url-refresh", "blocked"] as const)("retires the exact private capability on %s", action => {
    const seen = observed(); expect(seen.token).toBeDefined();
    if (action === "invalidate") seen.scope.invalidate();
    if (action === "close") seen.scope.close();
    if (action === "abort") seen.controller.abort();
    if (action === "path") { seen.scope.checkCurrentDocument(`${source.bookingUrl}other`); seen.scope.checkCurrentDocument(source.bookingUrl); }
    if (action === "same-url-refresh") seen.scope.beginMainDocument({}, { url: source.bookingUrl, method: "GET" });
    if (action === "blocked") seen.scope.observeRenderedSnapshot(seen.bookToken, { url: source.bookingUrl, timeOrigin: 3, frames: [], blocked: true });
    expect(() => observedTeeItUpOfficialBookingChain(seen.token)).toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
    expect(seen.scope.tokenFor(source.bookingUrl, source.bookingUrl)).toBeUndefined();
  });
  it("cannot mint an otherwise complete initial chain from a JSON200 final document", () => {
    expect(observed("application/json").token).toBeUndefined();
  });
  it("cannot rebuild an initial capability from JSON or a forged request object", () => {
    expect(() => observedTeeItUpOfficialBookingChain({} as TeeItUpOfficialBookingToken)).toThrow();
    expect(() => observedTeeItUpOfficialBookingChain(JSON.parse(JSON.stringify(observed().token)))).toThrow();
  });
  it("does not treat missing source/proof as matching official provenance", () => {
    const scope = createTeeItUpOfficialBookingScope({ ...source, officialUrl: undefined }, new AbortController().signal);
    const token = scope.beginMainDocument({}, { url: official, method: "GET" })!;
    scope.completeMainDocument(token, { status: 200, contentType: "text/html" });
    expect(() => scope.observeRenderedSnapshot(token, { url: official, timeOrigin: 1, officialPage: home, frames: [], blocked: false })).not.toThrow();
    expect(scope.tokenFor(source.bookingUrl, source.bookingUrl)).toBeUndefined();
  });
  it("refreshes five exact documents outside held data leases and replays changed inputs independently", async () => {
    const seen = observed(), fetch = fixtureFetch(); let active = 0, maxActive = 0;
    const requestLease = async <T>(_family: string, work: () => Promise<T>) => { expect(active).toBe(0); active++; maxActive = Math.max(active, maxActive); try { return { acquired: true as const, value: await work() }; } finally { active--; } };
    const { adapter } = await inspectExistingAdapter(source, { ...deps, fetch, requestLease, officialBookingSourceToken: seen.token });
    expect(adapter).toMatchObject({ family: "TEEITUP", facilityIds: [31], officialBookingSourceProof: { courseId: "public-course-31" } });
    expect(fetch).toHaveBeenCalledTimes(6);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "canonical-course" }, source: { ...source, providerFamily: "TEEITUP" }, adapter }) as ExistingAdapterRecipe;
    for (const request of [input, { ...input, date: "2030-10-24", players: 3 }]) {
      fetch.mockClear();
      const result = await executeExistingAdapterRecipe(recipe, request, { ...deps, fetch, requestLease });
      expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].bookingUrl).toContain(`date=${request.date}`);
      expect(fetch).toHaveBeenCalledTimes(7);
    }
    expect(maxActive).toBe(1); expect(active).toBe(0);
  });
  it.each(["course", "facility", "address", "redirect", "home", "embed", "access"] as const)("changed %s cannot become AVAILABLE or EMPTY", async action => {
    const seen = observed(), proof = bindTeeItUpOfficialBookingFacility(source, observedTeeItUpOfficialBookingChain(seen.token), directory);
    const adapter = { family: "TEEITUP" as const, alias: "example-golf", facilityIds: [31], officialBookingSourceProof: proof };
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "canonical-course" }, source: { ...source, providerFamily: "TEEITUP" }, adapter }) as ExistingAdapterRecipe;
    const fetch = fixtureFetch(action === "course" ? { directory: [{ ...directory[0], courseId: "changed-course" }] } : action === "facility" ? { directory: [{ ...directory[0], id: 32 }] } : action === "address" ? { directory: [{ ...directory[0], address: "603 Competition Rd, Example, NC 27603, US" }] } : action === "redirect" ? { entryLocation: "https://other.book.teeitup.com/" } : action === "home" ? { home: homeHtml.replace("<footer>", '<footer class="changed">') } : action === "embed" ? { page: pageHtml.replace("<main>", '<main class="changed">') } : { status: 403 });
    const result = await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch });
    expect(result.complete).toBe(false); expect(["INCOMPLETE", "ACCESS_REQUIRED"]).toContain(result.status); expect(result.slots).toEqual([]);
    expect(fetch.mock.calls.some(([value]) => String(value).includes("/v2/tee-times"))).toBe(false);
  });
  it("never publishes a copied initial token invalidated during source IO", async () => {
    const seen = observed(), transport = fixtureFetch();
    const fetch = vi.fn<typeof globalThis.fetch>(async (value, init) => { const response = await transport(value, init); if (String(value) === source.bookingUrl) seen.scope.invalidate(); return response; });
    await expect(inspectExistingAdapter(source, { ...deps, fetch, officialBookingSourceToken: seen.token })).rejects.toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
    expect(fetch.mock.calls.some(([value]) => String(value).endsWith("/facilities"))).toBe(false);
  });
  it("rejects missing or expanded source reads without following a new route", async () => {
    const seen = observed(), chain = observedTeeItUpOfficialBookingChain(seen.token), fetch = fixtureFetch({ entryLocation: "https://other.book.teeitup.com/" });
    await expect(readTeeItUpOfficialBookingChain(source, chain, { fetch, signal: new AbortController().signal, requestLease: deps.requestLease })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(4); expect(fetch.mock.calls.some(([value]) => String(value).includes("other.book"))).toBe(false);
  });
  it("rejects an actual fresh access challenge before directory or inventory", async () => {
    const seen = observed(), chain = observedTeeItUpOfficialBookingChain(seen.token), transport = fixtureFetch();
    const fetch = vi.fn<typeof globalThis.fetch>((value, init) => String(value) === source.bookingUrl ? Promise.resolve(new Response("<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>", { headers: { "content-type": "text/html" } })) : transport(value, init));
    await expect(readTeeItUpOfficialBookingChain(source, chain, { fetch, signal: new AbortController().signal, requestLease: deps.requestLease })).rejects.toThrow("ACCESS_REQUIRED");
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("does not turn a public page's incidental captcha script/instructions into access denial", async () => {
    const chain = observedTeeItUpOfficialBookingChain(observed().token), transport = fixtureFetch();
    const fetch = vi.fn<typeof globalThis.fetch>((value, init) => String(value) === source.bookingUrl ? Promise.resolve(new Response('<html><head><title>Public tee times</title><script src="https://www.google.com/recaptcha/api.js"></script></head><body><h1>Public tee times</h1><p>Complete captcha when booking.</p></body></html>', { headers: { "content-type": "text/html" } })) : transport(value, init));
    await expect(readTeeItUpOfficialBookingChain(source, chain, { fetch, signal: new AbortController().signal, requestLease: deps.requestLease })).resolves.toEqual(chain);
  });
  it("supports proven empty inventory but will not dispatch a third data read", async () => {
    const proof = bindTeeItUpOfficialBookingFacility(source, observedTeeItUpOfficialBookingChain(observed().token), directory);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "canonical-course" }, source: { ...source, providerFamily: "TEEITUP" }, adapter: { family: "TEEITUP", alias: "example-golf", facilityIds: [31], officialBookingSourceProof: proof } }) as ExistingAdapterRecipe;
    const fetch = fixtureFetch({ empty: true });
    expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch })).toMatchObject({ status: "EMPTY", complete: true });
    const spy = vi.spyOn(teeItUpAdapter, "fetchTeeItUpTeeSheet").mockImplementation(async (_args, read) => {
      const headers = { "x-be-alias": "example-golf", origin: source.bookingUrl.slice(0, -1), referer: source.bookingUrl };
      const url = "https://phx-api-be-east-1b.kenna.io/alias/example-golf/facilities";
      for (let index = 0; index < 3; index++) await read!(url, { headers });
      throw new Error("THIRD_READ_MUST_NOT_COMPLETE");
    });
    try { fetch.mockClear(); expect(await executeExistingAdapterRecipe(recipe, input, { ...deps, fetch })).toMatchObject({ status: "INCOMPLETE", complete: false, evidence: { reason: "ADAPTER_REQUEST_LIMIT" } }); expect(fetch).toHaveBeenCalledTimes(7); }
    finally { spy.mockRestore(); }
  });
});
