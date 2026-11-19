// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chromium } from "@playwright/test";
import { collectNativeOfficialPublicMetadata } from "./public-document-metadata";
import { freshNativeCanonicalRootDocument, registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { bindCpsOfficialCourseNames, getCpsOfficialCourseCatalogFailureStage, getCpsPrivateCourseNameComparison } from "./cps-official-course-catalog";
import { parseCpsCatalog, getCpsCatalogIdentityFailureStage, CPS_VENUE_PUBLIC_CATALOG_BUILD, type CpsOptions } from "./cps-source";
import { parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

const source = { officialUrl: "https://official.example/", bookingUrl: "https://harbor.cps.golf/",
  venueName: "Harbor Pointe Golf Course", venueAddress: "10 Harbor Dr, Example, NY 12345, USA", timeZone: "America/New_York" };
const phone = "+15083799886", build = "26.2.2.40425805601";
const labels = [{ href: "https://official.example/north", text: "North Golf Course" },
  { href: "https://official.example/south", text: "South Course" }];
function fixture() {
  const options: CpsOptions = { webSiteId: "public-site", reservationOptions: { terminalId: 1,
    clubName: source.venueName, clubAddress: source.venueAddress }, courseOptions: [
    { courseId: 7, courseName: "North", webSiteId: "public-site" },
    { courseId: 9, courseName: "South", webSiteId: "public-site" }] };
  const rows = options.courseOptions.map(row => ({ courseId: row.courseId, courseName: row.courseName,
    timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 18 as const }));
  const page: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME",
    html: `<html><body><h1>${source.venueName}</h1><section><h2>Contact Us</h2><a href="tel:5083799886">508-379-9886</a></section>` +
      `<a href="${source.bookingUrl}">Book A Tee Time</a>${labels.map(row => `<a href="${row.href}">${row.text}</a>`).join("")}</body></html>`,
    visibleEvidence: { title: source.venueName, headings: [source.venueName, "Contact Us"], linkUrls: [source.bookingUrl, ...labels.map(row => row.href)],
      addressTexts: [source.venueAddress], phoneTexts: ["508-379-9886"], contactPhoneLinks: [{ href: "tel:5083799886", text: "508-379-9886" }],
      publicLinkLabels: [{ href: source.bookingUrl, text: "Book A Tee Time" }], officialCourseLinkLabels: labels.map(row => ({ ...row })) } };
  registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30_000));
  return { options, rows, page, context: { page, canonicalCoursePhone: phone, phoneBooking: true as const, onSelectedLabel: () => {} } };
}
function redirectedFixture(canonicalUrl: string, documentUrl: string, linkOrigin: "CANONICAL" | "DOCUMENT" | "MIXED" = "DOCUMENT") {
  const f = fixture(), redirectedSource = { ...source, officialUrl: canonicalUrl };
  const links = labels.map((row, index) => ({ ...row, href: new URL(new URL(row.href).pathname,
    linkOrigin === "CANONICAL" || linkOrigin === "MIXED" && index === 0 ? canonicalUrl : documentUrl).href }));
  f.page.url = documentUrl;
  f.page.html = labels.reduce((html, row, index) => html.replaceAll(row.href, links[index].href), f.page.html);
  f.page.visibleEvidence!.officialCourseLinkLabels = links;
  f.page.visibleEvidence!.linkUrls = [source.bookingUrl, ...links.map(row => row.href)];
  const provenance = { requestedUrl: canonicalUrl,
    redirects: [{ fromUrl: canonicalUrl, toUrl: documentUrl, status: 301, completed: true }] };
  registerFreshNativeOfficialIdentityPage(f.page, canonicalUrl, new Date(Date.now() + 30_000), provenance);
  return { ...f, source: redirectedSource, provenance };
}

describe("native official named public course catalog", () => {
  it.each([9, 18] as const)("binds only a declared %s round-length suffix to the complete official names", holes => {
    const f = fixture();
    const rows = f.rows.map(row => ({ ...row, holes, courseName: `${row.courseName} ${holes}` }));
    const options = { ...f.options, courseOptions: rows.map(row => ({ courseId: row.courseId, courseName: row.courseName, webSiteId: row.websiteId })) };
    const metadata = parseCpsCatalog(rows, options, source, f.context, build);
    expect(metadata).toMatchObject({ courseIds: [7, 9], publicCatalogMode: "OFFICIAL_NAMED_ONLINE_COURSES" });
    expect(bindCpsOfficialCourseNames(source, f.page, rows).map(row => row.officialUrl)).toEqual(labels.map(row => row.href));
    expect(parseCpsCatalog([...rows].reverse(), options, source, f.context, build)).toEqual(metadata);
    expect(metadata).not.toHaveProperty("layoutHoleCounts");
  });
  it.each(["wrong-length", "missing-length", "other-number", "extra-word", "leading-number", "duplicate-base", "missing-official", "ambiguous-official"])(
    "does not use a round-length suffix to bypass %s", change => {
      const f = fixture();
      const rows: Array<{ courseId: number; courseName: string; holes?: 9 | 18 }> = f.rows.map(row => ({ ...row, courseName: row.courseName + " 18" }));
      if (change === "wrong-length") rows[0].holes = 9;
      if (change === "missing-length") delete rows[0].holes;
      if (change === "other-number") rows[0].courseName = "North 27";
      if (change === "extra-word") rows[0].courseName = "North Championship 18";
      if (change === "leading-number") rows[0].courseName = "18 North";
      if (change === "duplicate-base") rows[1].courseName = "North";
      if (change === "missing-official") f.page.visibleEvidence!.officialCourseLinkLabels = labels.slice(0, 1);
      if (change === "ambiguous-official") f.page.visibleEvidence!.officialCourseLinkLabels!.push({ href: "https://official.example/other", text: "North Course" });
      expect(() => bindCpsOfficialCourseNames(source, f.page, rows)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    });
  it("keeps actual rejected comparison keys out of browser diagnostics and clears them on the next inspection", async () => {
    const f = fixture();
    f.rows[0].courseName = f.options.courseOptions[0].courseName = "Harbor North";
    let primary: unknown;
    try { parseCpsCatalog(f.rows, f.options, source, f.context, build); } catch (error) { primary = error; }
    expect(getCpsPrivateCourseNameComparison(primary)).toBeDefined();
    let failure = primary;
    const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source.officialUrl], venueName: source.venueName,
      deadlineAt: new Date(Date.now() + 20_000) }, {
      inspectAdapter: async () => { throw failure; },
      fetch: async () => new Response("<html><body><h1>Public venue</h1></body></html>", { headers: { "content-type": "text/html" } }),
      launchBrowser: () => chromium.launch({ headless: true }),
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    try {
      await session.execute({ id: 1, action: "open", url: source.officialUrl });
      await expect(session.execute({ id: 2, action: "inspect_adapter", url: source.officialUrl })).rejects.toBe(primary);
      expect(session.privateCourseNameComparison()).toEqual(getCpsPrivateCourseNameComparison(primary));
      expect(JSON.stringify(session.diagnostics())).not.toMatch(/harbor north|officialNames|providerNames/u);
      failure = Error("ADAPTER_IDENTITY_MISMATCH");
      await expect(session.execute({ id: 3, action: "inspect_adapter", url: source.officialUrl })).rejects.toBe(failure);
      expect(session.privateCourseNameComparison()).toBeUndefined();
    } finally { await session.close(); }
  }, 30_000);
  it("keeps actual compared keys private through the unchanged catalog rejection", () => {
    const f = fixture();
    f.rows[0].courseName = f.options.courseOptions[0].courseName = "Harbor North";
    let failure: unknown;
    try { parseCpsCatalog(f.rows, f.options, source, f.context, build); } catch (error) { failure = error; }
    expect((failure as Error).message).toBe("ADAPTER_IDENTITY_MISMATCH");
    expect(getCpsCatalogIdentityFailureStage(failure)).toBe("NAMED_COURSE_NAMES");
    expect(getCpsPrivateCourseNameComparison(failure)).toMatchObject({ canonicalName: "harbor pointe",
      officialNames: ["north", "south"], providerNames: ["harbor north", "south"] });
    expect(JSON.stringify(failure)).not.toMatch(/harbor|north|south/u);
    expect(getCpsPrivateCourseNameComparison({ ...(failure as Error) })).toBeUndefined();
    const value = getCpsPrivateCourseNameComparison(failure)!;
    value.providerNames[0] = "changed";
    expect(getCpsPrivateCourseNameComparison(failure)!.providerNames[0]).toBe("harbor north");
  });
  it("preserves the same catalog hash for actual browser CSS case transforms on direct and attested roots", async () => {
    const browser = await chromium.launch({ headless: true });
    let externalRequests = 0, markup = "", documentUrl = source.officialUrl;
    try {
      const context = await browser.newContext({ serviceWorkers: "block", storageState: { cookies: [], origins: [] } });
      await context.route("**/*", async route => {
        if (route.request().url() !== documentUrl || route.request().method() !== "GET") { externalRequests++; await route.abort(); return; }
        await route.fulfill({ contentType: "text/html", body: markup });
      });
      const tab = await context.newPage();
      for (documentUrl of [source.officialUrl, "https://www.official.example/"]) {
        for (const linkOrigin of ["CANONICAL", "DOCUMENT"] as const) {
          let baseline: unknown;
          for (const transform of ["none", "uppercase", "lowercase"]) {
            const f = redirectedFixture(source.officialUrl, documentUrl, linkOrigin);
            markup = f.page.html.replace("<body>", `<head><style>a{text-transform:${transform}}</style></head><body>`);
            await tab.goto(documentUrl);
            const visibleEvidence = await tab.evaluate(collectNativeOfficialPublicMetadata, {
              venueName: source.venueName, venueAddress: source.venueAddress, canonicalCoursePhone: phone, officialUrl: source.officialUrl,
            });
            const page: OfficialIdentityPage = { url: documentUrl, html: markup, browserTransport: "NATIVE_CHROME", visibleEvidence };
            registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30_000),
              documentUrl === source.officialUrl ? undefined : f.provenance);
            expect(visibleEvidence.officialCourseLinkLabels).toHaveLength(2);
            if (transform === "uppercase") expect(visibleEvidence.officialCourseLinkLabels![0].text).toBe("NORTH GOLF COURSE");
            const metadata = parseCpsCatalog(f.rows, f.options, source, { ...f.context, page }, build);
            if (transform === "none") baseline = metadata;
            else expect(metadata).toEqual(baseline);
          }
        }
      }
      expect(externalRequests).toBe(0);
    } finally { await browser.close(); }
  }, 30_000);
  it.each([
    ["https://official.example/", "https://www.official.example/", "DOCUMENT"],
    ["https://official.example/", "https://www.official.example/", "CANONICAL"],
    ["https://official.example/", "https://www.official.example/", "MIXED"],
    ["https://www.official.example/", "https://official.example/", "DOCUMENT"],
    ["https://www.official.example/", "https://official.example/", "CANONICAL"],
    ["https://www.official.example/", "https://official.example/", "MIXED"],
  ] as const)("binds canonical %s to freshly attested document %s with %s course links", (canonicalUrl, documentUrl, linkOrigin) => {
    const f = redirectedFixture(canonicalUrl, documentUrl, linkOrigin);
    expect(freshNativeCanonicalRootDocument(f.page, canonicalUrl)?.documentUrl).toBe(documentUrl);
    expect(parseCpsCatalog(f.rows, f.options, f.source, f.context, build)).toMatchObject({
      courseIds: [7, 9], publicCatalogMode: "OFFICIAL_NAMED_ONLINE_COURSES" });
    expect(bindCpsOfficialCourseNames(f.source, f.page, f.rows).map(row => row.officialUrl))
      .toEqual(f.page.visibleEvidence!.officialCourseLinkLabels!.map(row => row.href));
  });
  it.each(["missing-witness", "expired", "copied", "foreign-link", "unobserved-www", "missing-raw", "wrong-phone", "wrong-address", "private-row"])(
    "does not let an attested redirect bypass %s", change => {
      const f = redirectedFixture("https://official.example/", "https://www.official.example/");
      if (change === "foreign-link") {
        f.page.html = f.page.html.replaceAll("https://www.official.example/north", "https://foreign.example/north");
        f.page.visibleEvidence!.officialCourseLinkLabels![0].href = "https://foreign.example/north";
      }
      if (change === "missing-raw") f.page.html = f.page.html.replace('<a href="https://www.official.example/north">North Golf Course</a>', "");
      if (change === "unobserved-www") f.page.url = f.source.officialUrl;
      if (change === "wrong-phone") f.context.canonicalCoursePhone = "+15085550123";
      if (change === "wrong-address") f.options.reservationOptions.clubAddress = "11 Harbor Dr, Example, NY 12345, USA";
      if (change === "private-row") Object.assign(f.rows[0], { membersOnly: true });
      registerFreshNativeOfficialIdentityPage(f.page, f.source.officialUrl, new Date(Date.now() + (change === "expired" ? -1 : 30_000)),
        ["missing-witness", "unobserved-www"].includes(change) ? undefined : f.provenance);
      if (change === "copied") f.context.page = structuredClone(f.page);
      expect(() => parseCpsCatalog(f.rows, f.options, f.source, f.context, build)).toThrow();
    });
  it.each(["North Course", "North-Golf Course", "North 2 Golf Course"])("does not erase substantive raw/rendered label disagreement: %s", shown => {
    const f = fixture();
    f.page.visibleEvidence!.officialCourseLinkLabels![0].text = shown;
    registerFreshNativeOfficialIdentityPage(f.page, source.officialUrl, new Date(Date.now() + 30_000));
    expect(() => parseCpsCatalog(f.rows, f.options, source, f.context, build)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("binds the complete two-course venue without guessing one canonical or default course", () => {
    const f = fixture();
    const metadata = parseCpsCatalog(f.rows, f.options, source, f.context, build);
    expect(metadata).toMatchObject({ family: "CPS", tenant: "harbor", courseIds: [7, 9], publicCatalogMode: "OFFICIAL_NAMED_ONLINE_COURSES" });
    expect(metadata).not.toHaveProperty("officialPhoneBookingProof");
    expect(parseCpsCatalog([...f.rows].reverse(), { ...f.options, courseOptions: [...f.options.courseOptions].reverse() }, source, f.context, build)).toEqual(metadata);
    expect(parseCpsCatalog(f.rows.map(row => ({ ...row, isDefaultSelected: true, order: 99 })), f.options, source, f.context, build)).toEqual(metadata);
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course-1", kind: "OUTDOOR" }, source: { ...source, providerFamily: "CPS" }, adapter: metadata };
    expect(parseAccessRecipe(recipe).engine).toBe("EXISTING_ADAPTER");
    expect(() => parseAccessRecipe({ ...recipe, target: { courseId: "course-1", offeringId: "offering-1", kind: "SIMULATOR" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, venueAddress: undefined } })).toThrow();
    expect(JSON.stringify(metadata)).not.toMatch(/public-site|508|official\.example|North|South/u);
  });
  it.each(["missing-labels", "omitted-labels", "foreign-link", "query-link", "ambiguous-path", "missing-raw", "hidden-raw", "renamed-raw", "extra-official-course", "extra-provider-course", "missing-provider-course", "duplicate-course", "wrong-site", "wrong-timezone", "wrong-address", "wrong-venue", "private-row", "private-option", "private-venue", "malformed-flag", "wrong-phone", "copied-native", "expired-native", "explicit-selection"].flatMap(change =>
    [false, true].map(numbered => ({ change, numbered }))))("rejects incomplete or conflicting named venue evidence: $change (numbered=$numbered)", ({ change, numbered }) => {
    const f = fixture();
    if (numbered) for (let i = 0; i < f.rows.length; i++) f.options.courseOptions[i].courseName = f.rows[i].courseName += " 18";
    if (change === "missing-labels") delete f.page.visibleEvidence!.officialCourseLinkLabels;
    if (change === "omitted-labels") f.page.visibleEvidence!.officialCourseLinkLabelsOmitted = true;
    if (change === "foreign-link" || change === "query-link") f.page.visibleEvidence!.officialCourseLinkLabels = labels.map((row, index) => index ? row :
      { ...row, href: change === "foreign-link" ? "https://other.example/north" : row.href + "?token=private" });
    if (change === "ambiguous-path") f.page.visibleEvidence!.officialCourseLinkLabels = [...labels, { href: "https://official.example/other", text: "North Course" }];
    if (change === "missing-raw") f.page.html = f.page.html.replace('<a href="https://official.example/north">North Golf Course</a>', "");
    if (change === "hidden-raw") f.page.html = f.page.html.replace('<a href="https://official.example/north">', '<a hidden href="https://official.example/north">');
    if (change === "renamed-raw") f.page.html = f.page.html.replace("North Golf Course", "Other Golf Course");
    if (change === "extra-official-course") f.page.visibleEvidence!.officialCourseLinkLabels = [...labels, { href: "https://official.example/east", text: "East Course" }];
    if (change === "extra-provider-course") { f.rows.push({ ...f.rows[0], courseId: 11, courseName: "East" }); f.options.courseOptions.push({ courseId: 11, courseName: "East", webSiteId: "public-site" }); }
    if (change === "missing-provider-course") f.rows.pop();
    if (change === "duplicate-course") f.rows.push(f.rows[0]);
    if (change === "wrong-site") f.rows[0].websiteId = "another-site";
    if (change === "wrong-timezone") f.rows[0].timezoneId = "America/Denver";
    if (change === "wrong-address") f.options.reservationOptions.clubAddress = "11 Harbor Dr, Example, NY 12345, USA";
    if (change === "wrong-venue") f.options.reservationOptions.clubName = "Harbor Other Golf Course";
    if (change === "private-row") Object.assign(f.rows[0], { membersOnly: true });
    if (change === "private-option") Object.assign(f.options.courseOptions[0], { private: true });
    if (change === "private-venue") f.options.reservationOptions.requiresLogin = true;
    if (change === "malformed-flag") f.options.reservationOptions.private = "unknown";
    if (change === "wrong-phone") f.context.canonicalCoursePhone = "+15085550123";
    if (change === "copied-native") f.context.page = structuredClone(f.page);
    if (change === "expired-native") registerFreshNativeOfficialIdentityPage(f.page, source.officialUrl, new Date(Date.now() - 1));
    if (change === "explicit-selection") { f.page.html = f.page.html.replace("Book A Tee Time", "North Course Tee Times"); f.page.visibleEvidence!.publicLinkLabels = [{ href: source.bookingUrl, text: "North Course Tee Times" }]; }
    expect(() => parseCpsCatalog(f.rows, f.options, source, f.context, build)).toThrow();
  });
  it.each([
    ["missing-labels", "NAMED_VISIBLE_LINKS"],
    ["foreign-link", "NAMED_LINK_SCOPE"],
    ["invalid-label", "NAMED_LINK_LABEL"],
    ["generic-name", "NAMED_LINK_NAME"],
    ["ambiguous-path", "NAMED_LINK_AMBIGUITY"],
    ["extra-official-course", "NAMED_COURSE_NAMES"],
    ["missing-raw", "NAMED_RAW_LINK_PAIR"],
  ])("retains the exact named-catalog rejection instead of collapsing %s into catalog binding", (change, stage) => {
    const f = fixture();
    const links = f.page.visibleEvidence!.officialCourseLinkLabels!;
    if (change === "missing-labels") delete f.page.visibleEvidence!.officialCourseLinkLabels;
    if (change === "foreign-link") links[0] = { ...links[0], href: "https://other.example/north" };
    if (change === "invalid-label") links[0] = { ...links[0], text: "North" };
    if (change === "generic-name") links[0] = { ...links[0], text: "Public Course" };
    if (change === "ambiguous-path") links.push({ href: "https://official.example/other", text: "North Course" });
    if (change === "extra-official-course") links.push({ href: "https://official.example/east", text: "East Course" });
    if (change === "missing-raw") f.page.html = f.page.html.replace('<a href="https://official.example/north">North Golf Course</a>', "");
    registerFreshNativeOfficialIdentityPage(f.page, source.officialUrl, new Date(Date.now() + 30_000));
    let failure: unknown;
    try { parseCpsCatalog(f.rows, f.options, source, f.context, build); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("ADAPTER_IDENTITY_MISMATCH");
    expect(getCpsCatalogIdentityFailureStage(failure)).toBe(stage);
    expect(getCpsCatalogIdentityFailureStage(new Error("ADAPTER_IDENTITY_MISMATCH"))).toBeUndefined();
    expect(getCpsCatalogIdentityFailureStage({ ...(failure as Error) })).toBeUndefined();
    expect(JSON.stringify(failure)).not.toMatch(/official\.example|other\.example|North|South|public-site|508/u);
  });
  it.each([
    ["copied-native", "NAMED_ROOT_PROVENANCE"],
    ["omitted-labels", "NAMED_VISIBLE_LINKS"],
    ["oversize-document", "NAMED_DOCUMENT_LIMIT"],
    ["oversize-tree", "NAMED_RAW_TREE_LIMIT"],
  ])("retains the bounded native-document gate for %s", (change, stage) => {
    const f = fixture();
    if (change === "omitted-labels") f.page.visibleEvidence!.officialCourseLinkLabelsOmitted = true;
    if (change === "oversize-document") f.page.html += " ".repeat(600_001);
    if (change === "oversize-tree") f.page.html = f.page.html.replace("</body>", "<b></b>".repeat(20_001) + "</body>");
    registerFreshNativeOfficialIdentityPage(f.page, source.officialUrl, new Date(Date.now() + 30_000));
    const page = change === "copied-native" ? structuredClone(f.page) : f.page;
    let failure: unknown;
    try { bindCpsOfficialCourseNames(source, page, f.rows); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("ADAPTER_IDENTITY_MISMATCH");
    expect(getCpsOfficialCourseCatalogFailureStage(failure)).toBe(stage);
    expect(getCpsOfficialCourseCatalogFailureStage(new Error("ADAPTER_IDENTITY_MISMATCH"))).toBeUndefined();
    expect(getCpsOfficialCourseCatalogFailureStage({ ...(failure as Error) })).toBeUndefined();
  });
  it.each([CPS_VENUE_PUBLIC_CATALOG_BUILD, "26.2.2.40425805600", "26.2.2.40425805602", "26.3.0.34794395074"])("does not broaden another exact build's public-catalog contract: %s", candidate => {
    const f = fixture();
    expect(() => parseCpsCatalog(f.rows, f.options, source, f.context, candidate)).toThrow();
  });
});
