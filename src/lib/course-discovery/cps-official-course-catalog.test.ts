// @vitest-environment node
import { describe, expect, it } from "vitest";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { bindCpsOfficialCourseNames, getCpsOfficialCourseCatalogFailureStage } from "./cps-official-course-catalog";
import { parseCpsCatalog, getCpsCatalogIdentityFailureStage, CPS_VENUE_PUBLIC_CATALOG_BUILD, type CpsOptions } from "./cps-source";
import { parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

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

describe("native official named public course catalog", () => {
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
  it.each(["missing-labels", "omitted-labels", "foreign-link", "query-link", "ambiguous-path", "missing-raw", "hidden-raw", "renamed-raw", "extra-official-course", "extra-provider-course", "missing-provider-course", "duplicate-course", "wrong-site", "wrong-timezone", "wrong-address", "wrong-venue", "private-row", "private-option", "private-venue", "malformed-flag", "wrong-phone", "copied-native", "expired-native", "explicit-selection"])("rejects incomplete or conflicting named venue evidence: %s", change => {
    const f = fixture();
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
