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
function observed(finalContentType = "text/html") {
  const controller = new AbortController(), scope = createTeeItUpOfficialBookingScope(source, controller.signal);
  const root = {}, normal = {}, page = {}, play = {}, book = {};
  const begin = (object: object, url: string, parent?: object) => scope.beginMainDocument(object, { url, method: "GET", parent })!;
  scope.completeMainDocument(begin(root, source.officialUrl), { status: 302, location: official });
  const homeToken = begin(normal, official, root);
  scope.completeMainDocument(homeToken, { status: 200, contentType: "text/html" });
  scope.observeRenderedSnapshot(homeToken, { url: official, timeOrigin: 1, officialPage: home, verifiedOfficial: { kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: source.officialUrl, documentUrl: official }, frames: [], blocked: false });
  const pageToken = begin(page, bookingPage);
  scope.completeMainDocument(pageToken, { status: 200, contentType: "text/html" });
  scope.observeRenderedSnapshot(pageToken, { url: bookingPage, timeOrigin: 2, officialPage: { url: bookingPage, html: pageHtml }, verifiedOfficial: { kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: source.officialUrl, documentUrl: bookingPage }, frames: [entry], blocked: false });
  scope.completeMainDocument(begin(play, entry), { status: 302, location: source.bookingUrl });
  const bookToken = begin(book, source.bookingUrl, play);
  scope.completeMainDocument(bookToken, { status: 200, contentType: finalContentType });
  scope.observeRenderedSnapshot(bookToken, { url: source.bookingUrl, timeOrigin: 3, frames: [], blocked: false });
  return { scope, controller, token: scope.tokenFor(source.bookingUrl, source.bookingUrl)!, bookToken };
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
