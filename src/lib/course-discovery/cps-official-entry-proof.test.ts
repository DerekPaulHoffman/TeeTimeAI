import { describe, expect, it } from "vitest";
import { bindCpsOfficialEntryProof, deriveCpsRootEntry, registerCpsOfficialEntryContext, verifyCpsOfficialEntryContext } from "./cps-official-entry-proof";
import { registerFreshNativeDelegatedDocument, registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { parseCpsCatalog, type CpsOptions } from "./cps-source";
import { parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { readCpsOfficialEntry } from "./cps-official-entry-reader";
import { executeCps, inspectCps, type CpsDependencies } from "./cps-executor";
import { CPS_API_PATH, CPS_PUBLIC_BUILD } from "./cps-source";

const source = { officialUrl: "https://official.example/", bookingUrl: "https://harbor.cps.golf/onlineresweb/search-teetime",
  venueName: "Harbor Pointe Country Club", venueAddress: "10 Harbor Rd, Example, MA 01234, USA", timeZone: "America/New_York" };
const documentUrl = source.officialUrl + "tee-times", phone = "+12125550123", title = "Golf Course | Harbor Pointe Country Club | Example, MA";
const contact = '<section><h2>Contact Us</h2><p>10 Harbor Road, Example, Massachusetts 01234, United States</p><a href="tel:2125550123">212-555-0123</a></section>';
const fields = [{ name: "course-id", tag: "SELECT", type: "" }, { name: "date", tag: "INPUT", type: "date" },
  { name: "time", tag: "SELECT", type: "" }, { name: "players", tag: "SELECT", type: "" }, { name: "submit", tag: "BUTTON", type: "submit" }];
const config = { baseURL: source.bookingUrl, newBookingEngine: true, locations: [{ name: "Harbor Pointe", courseId: "0" }], showPlayersField: true };
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
const widget = (value = encoded(config)) => `<div data-widget-config="${value}"><form class="tee-time-form"><select name="course-id"></select><input type="date" name="date"><select name="time"></select><select name="players"></select><button name="submit" type="submit">Search</button></form></div>`;
function fixture(changeRoot: Partial<OfficialIdentityPage> = {}, changeEntry: Partial<OfficialIdentityPage> = {}) {
  const root = registerFreshNativeOfficialIdentityPage({ url: source.officialUrl, browserTransport: "NATIVE_CHROME",
    html: `<html><head><title>${title}</title></head><body><h1>Public Golf</h1>${contact}<a href="${documentUrl}">Book A Tee Time</a></body></html>`,
    visibleEvidence: { title, headings: ["Public Golf", "Contact Us"], addressTexts: ["10 Harbor Road, Example, Massachusetts 01234, United States"],
      phoneTexts: ["212-555-0123"], contactPhoneLinks: [{ href: "tel:2125550123", text: "212-555-0123" }], linkUrls: [documentUrl],
      publicBookingEntryLinks: [{ href: documentUrl, text: "Book A Tee Time" }] }, ...changeRoot }, source.officialUrl, new Date(Date.now() + 30000));
  const entry = registerFreshNativeDelegatedDocument({ url: documentUrl, browserTransport: "NATIVE_CHROME", html: `<html><body>${widget()}</body></html>`,
    visibleEvidence: { title: "Book Tee Times", headings: [], addressTexts: [], linkUrls: [], cpsBookingWidgets: [{ configuration: encoded(config), fields }] }, ...changeEntry }, source.officialUrl, new Date(Date.now() + 30000));
  return { root, entry, context: () => registerCpsOfficialEntryContext(source, root, entry, phone) };
}
const options: CpsOptions = { webSiteId: "public-site", reservationOptions: { terminalId: 1, clubName: source.venueName,
  clubAddress: source.venueAddress }, courseOptions: [{ courseId: 7, courseName: "Harbor Pointe", webSiteId: "public-site" }] };
const rows = [{ courseId: 7, courseName: "Harbor Pointe", timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 18 as const }];
describe("CPS title, physical contact and current public entry", () => {
  it("requires a fresh two-document chain and binds exact published source plus full provider physical identity", () => {
    const f = fixture(), context = f.context();
    expect(deriveCpsRootEntry(source, f.root, phone).bookingDocumentUrl).toBe(documentUrl);
    const metadata = parseCpsCatalog(rows, options, source, { page: f.root, canonicalCoursePhone: phone, officialEntry: context, onSelectedLabel: () => {} }, "fixture-reviewed-build");
    expect(metadata.officialEntryProof).toMatchObject({ kind: "OFFICIAL_TITLE_PHYSICAL_ENTRY", bookingUrl: source.bookingUrl, providerVenueName: "Harbor Pointe", courseIds: [7] });
    expect(parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { kind: "OUTDOOR", courseId: "fixture-course" }, source: { ...source, providerFamily: "CPS" }, adapter: metadata }).engine).toBe("EXISTING_ADAPTER");
    expect(() => verifyCpsOfficialEntryContext({ ...context }, source, phone)).toThrow();
    context.publishedTitle = "Other Club"; expect(() => verifyCpsOfficialEntryContext(context, source, phone)).toThrow();
  });
  it("does not promote a model proposal, hidden direct provider href or wrong root identity", () => {
    for (const change of [
      (r: OfficialIdentityPage) => { r.visibleEvidence!.publicBookingEntryLinks = []; },
      (r: OfficialIdentityPage) => { r.visibleEvidence!.publicBookingEntryLinks = [{ href: source.bookingUrl, text: "Book A Tee Time" }]; },
      (r: OfficialIdentityPage) => { r.visibleEvidence!.title = "Golf Course | Other Club | Example, MA"; },
      (r: OfficialIdentityPage) => { r.html = r.html.replace("<title>", "<title>Other Club | "); },
      (r: OfficialIdentityPage) => { r.visibleEvidence!.addressTexts = ["11 Harbor Rd, Example, MA 01234, USA"]; },
      (r: OfficialIdentityPage) => { r.visibleEvidence!.phoneTexts = ["212-555-0124"]; },
      (r: OfficialIdentityPage) => { r.html = r.html.replace("<section>", "<section hidden>"); },
      (r: OfficialIdentityPage) => { r.html = r.html.replace("Contact Us", "Mailing Office"); },
    ]) { const f = fixture(); change(f.root); registerFreshNativeOfficialIdentityPage(f.root, source.officialUrl, new Date(Date.now() + 30000)); expect(() => f.context()).toThrow("CPS_OFFICIAL_ENTRY_UNVERIFIED"); }
  });
  it("rejects competing physical addresses, ambiguous branches, credentials, POSTs, malformed or copied entry captures", () => {
    const f = fixture(); f.root.visibleEvidence!.addressTexts.push("12 Other Road, Elsewhere, MA 01235, USA");
    registerFreshNativeOfficialIdentityPage(f.root, source.officialUrl, new Date(Date.now() + 30000)); expect(() => f.context()).toThrow();
    for (const change of [
      (p: OfficialIdentityPage) => { p.html = p.html.replace('class="tee-time-form"', 'class="tee-time-form" method="post"'); },
      (p: OfficialIdentityPage) => { p.visibleEvidence!.cpsBookingWidgets![0].fields = [...fields, { name: "email", tag: "INPUT", type: "email" }]; },
      (p: OfficialIdentityPage) => { p.visibleEvidence!.cpsBookingWidgetsOmitted = true; },
      (p: OfficialIdentityPage) => { const other = encoded({ ...config, baseURL: "https://foreign.cps.golf/onlineresweb/search-teetime" }); p.html += widget(other); p.visibleEvidence!.cpsBookingWidgets!.push({ configuration: other, fields }); },
      (p: OfficialIdentityPage) => { p.html = p.html.replace("<div ", '<div hidden '); },
      (p: OfficialIdentityPage) => { p.html = p.html.replace(encoded(config), encoded({ ...config, customerToken: "not-public" })); },
    ]) { const p = fixture(); change(p.entry); registerFreshNativeDelegatedDocument(p.entry, source.officialUrl, new Date(Date.now() + 30000)); expect(() => p.context()).toThrow("CPS_OFFICIAL_ENTRY_UNVERIFIED"); }
    const copied = fixture(); expect(() => registerCpsOfficialEntryContext(source, copied.root, structuredClone(copied.entry), phone)).toThrow();
  });
  it("retains complete catalog flags, physical address, timezone and unique sheet fences", () => {
    const f = fixture(), context = f.context(), native = { page: f.root, canonicalCoursePhone: phone, officialEntry: context, onSelectedLabel: () => {} };
    for (const modified of [
      { ...options, reservationOptions: { ...options.reservationOptions, clubAddress: "11 Harbor Rd, Example, MA 01234, USA" } },
      { ...options, reservationOptions: { ...options.reservationOptions, private: true } },
      { ...options, reservationOptions: { ...options.reservationOptions, clubName: "Foreign Campus" } },
    ]) expect(() => parseCpsCatalog(rows, modified, source, native)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parseCpsCatalog([...rows, { ...rows[0], courseId: 8 }], options, source, native)).toThrow();
    expect(() => parseCpsCatalog([{ ...rows[0], timezoneId: "America/Denver" }], options, source, native)).toThrow();
    expect(() => parseCpsCatalog([{ ...rows[0], courseName: "Foreign Campus" }], options, source, native)).toThrow();
    expect(() => bindCpsOfficialEntryProof(context, source, phone, { tenant: "harbor", courseIds: [7], catalogHash: "a".repeat(64) }, "Harbor Pointe", null)).toThrow();
  });
  it("accepts a complete printed two-line provider address without filling or dropping physical facts", () => {
    const f = fixture(), native = { page: f.root, canonicalCoursePhone: phone, officialEntry: f.context(), onSelectedLabel: () => {} };
    for (const address of ["10 Harbor Road\nExample, MA 01234", "10 Harbor Road \r\nExample, MA 01234"]) {
      expect(parseCpsCatalog(rows, { ...options, reservationOptions: { ...options.reservationOptions, clubAddress: address } }, source, native).officialEntryProof).toBeDefined();
    }
    for (const address of ["11 Harbor Road\nExample, MA 01234", "10 Harbor Road\nExample, MA", "10 Harbor Road\nExample, MA 01234\nUS",
      "10 Harbor Road\nOther City, MA 01234", "10 Harbor Road\nExample, MA 01235", "10 Harbor Road\t\nExample, MA 01234", "Mailing: 10 Harbor Road\nExample, MA 01234"]) {
      expect(() => parseCpsCatalog(rows, { ...options, reservationOptions: { ...options.reservationOptions, clubAddress: address } }, source, native)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    }
  });
  it("serializes the inspected actual entry and independently refreshes the complete chain for two changed inputs", async () => {
    let rootReads = 0, entryReads = 0, closed = 0, transaction = "", active = 0;
    const apiReads: Array<{ path: string; date: string | null }> = [];
    const deps: CpsDependencies = { now: () => new Date("2026-10-29T12:00:00Z"),
      trustedContext: { canonicalCoursePhone: phone }, localCapabilities: ["LOCAL_CHROME"],
      requestLease: async (_family, work) => { active++; try { return { acquired: true as const, value: await work() }; } finally { active--; } },
      readNativeOfficialPage: async () => { rootReads++; return fixture().root; },
      readOfficialEntry: async (identity, canonicalPhone, deadline, supplied, root) => readCpsOfficialEntry(identity, canonicalPhone, deadline, {
        ...supplied, createSession: async input => { expect(input.initialUrls).toEqual([documentUrl]); entryReads++; const entry = fixture().entry;
          return { execute: async () => ({ url: documentUrl, navigationStatus: 200, browserTransport: "NATIVE_CHROME", accessRequirementObserved: false } as never),
            readDelegatedSourceDocument: async () => entry, close: async () => { closed++; } }; },
      }, root),
      fetch: (async (value, init) => {
        expect(active).toBe(1); const url = new URL(String(value));
        if (url.origin === new URL(source.officialUrl).origin) return new Response("public HTTP denied", { status: 403 });
        apiReads.push({ path: url.pathname, date: url.searchParams.get("searchDate") });
        const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        if (url.pathname.endsWith("/Configuration")) return json({ siteName: "harbor", onlineApi: url.origin + CPS_API_PATH,
          authorityBaseUrl: url.origin + "/identityapi", clientId: "public-client", websiteId: "00000000-0000-0000-0000-000000000000", apiKey: "synthetic-published-key", buildNumber: CPS_PUBLIC_BUILD });
        if (url.pathname.includes("/GetAllOptions/")) return json(options);
        if (url.pathname.endsWith("/OnlineCourses")) return json(rows);
        if (url.pathname.endsWith("/RegisterTransactionId")) { transaction = JSON.parse(String(init?.body)).transactionId; return json(true); }
        if (url.pathname.endsWith("/TeeTimes")) return json({ isSuccess: true, transactionId: transaction, content: [{ teeSheetId: 17, courseId: 7,
          startTime: new Date(url.searchParams.get("searchDate")!).toISOString().slice(0, 10) + "T10:30:00", availableParticipantNo: [1, 2, 3, 4], holes: 18 }] });
        throw Error("UNEXPECTED_FIXTURE_READ");
      }) as typeof fetch };
    const proposal = { ...source, bookingUrl: "https://harbor.cps.golf/" };
    const inspected = await inspectCps(proposal, deps), serialized = JSON.stringify(inspected);
    expect(inspected.officialEntryProof?.bookingUrl).toBe(source.bookingUrl);
    for (const [date, players] of [["2026-10-30", 2], ["2026-10-31", 3]] as const) {
      const slots = await executeCps(source, JSON.parse(serialized), { courseId: "fixture-course" }, { date, players,
        startTime: "06:00", endTime: "18:00", timeZone: source.timeZone }, deps);
      expect(slots).toHaveLength(1); expect(slots[0].startsAt.startsWith(date)).toBe(true); expect(slots[0].bookingUrl).toBe(source.bookingUrl);
    }
    expect(rootReads).toBe(3); expect(entryReads).toBe(3); expect(closed).toBe(3); expect(active).toBe(0);
    expect(apiReads.filter(r=>r.path.endsWith("/TeeTimes")).map(r=>new Date(r.date!).toISOString().slice(0,10))).toEqual(["2026-10-30","2026-10-31"]);
    expect(JSON.stringify(inspected)).toBe(serialized);
  });
});
