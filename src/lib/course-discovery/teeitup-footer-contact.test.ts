import { describe, expect, it } from "vitest";
import { deriveNativePhysicalContactSource, bindTeeItUpPhysicalContactFacility, teeItUpPhysicalContactProofSchema } from "./teeitup-physical-contact-proof";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const source = { officialUrl: "https://course.example/", bookingUrl: "https://example.book.teeitup.com/",
  venueName: "Example Hollow Golf & Country Club", venueAddress: "18 Old Turnpike Rd, Example, MA 01068, USA", timeZone: "America/New_York" };
const publicName = "Example Hollow Country Club", phone = "+15085555516";
const printed = "Address : 18 Old Turnpike Rd, Example, MA, 01068";
function page(change: Partial<OfficialIdentityPage> = {}) {
  const p: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME",
    html: `<title>Home - ${publicName}</title><h1>${publicName}</h1><footer><p>${printed}</p><a href="tel:${phone}">508-555-5516</a></footer><a href="${source.bookingUrl}">Book Now</a>`,
    visibleEvidence: { title: `Home - ${publicName}`, headings: [publicName], addressTexts: [printed], phoneTexts: ["508-555-5516"], linkUrls: [source.bookingUrl] }, ...change };
  return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 30000));
}
const directory = [{ id: 71, courseId: "public-71", name: publicName, address: "18 Old Turnpike Rd, Example, MA 01068, US", country: "US", isSimulator: false, phone, timeZone: source.timeZone }];
const derive = (p = page()) => deriveNativePhysicalContactSource(source, p, phone);

describe("native country-club footer contact", () => {
  it("retains literal names and earns the explicit designation relation using exact physical contact", () => {
    const contact = derive(), bound = bindTeeItUpPhysicalContactFacility(source, contact, directory);
    expect(contact).toMatchObject({ canonicalName: source.venueName, officialBrandName: publicName,
      publicLocationName: publicName, canonicalNameRelation: "COUNTRY_CLUB_GOLF_DESIGNATION", publicCoursePhone: phone });
    expect(teeItUpPhysicalContactProofSchema.parse(JSON.parse(JSON.stringify(bound.physicalContactProof)))).toEqual(bound.physicalContactProof);
  });
  it.each(["Other Hollow Country Club", "Example Hollow Golf Club", "Example Hollow Private Country Club"])("rejects a different public name: %s", value => {
    const original = page();
    expect(() => derive(page({ html: original.html.replaceAll(publicName, value), visibleEvidence: { ...original.visibleEvidence!, title: `Home - ${value}`, headings: [value] } }))).toThrow();
  });
  it.each(["19 Old Turnpike Rd, Example, MA, 01068", "18 Old Turnpike Rd, Elsewhere, MA, 01068", "18 Old Turnpike Rd, Example, MA", "18 Old Turnpike Rd, Example, MA, 01069"])("rejects incomplete or conflicting physical address: %s", value => {
    const original = page();
    expect(() => derive(page({ html: original.html.replace(printed, value), visibleEvidence: { ...original.visibleEvidence!, addressTexts: [value] } }))).toThrow();
  });
  it("rejects hidden, rendered-only, conflicting and corporate contact blocks", () => {
    for (const html of [page().html.replace("<footer>", "<footer hidden>"), page().html.replace(printed, "No address"),
      page().html.replace("</footer>", "<p>Address : 19 Old Turnpike Rd, Example, MA, 01068</p></footer>"),
      page().html.replace("<footer>", "<footer><h2>Corporate Mailing Address</h2>")]) expect(() => derive(page({ html }))).toThrow();
  });
  it("requires current rendered heading, address, phone and booking edge", () => {
    for (const change of [{ headings: [] }, { addressTexts: [] }, { phoneTexts: [] }, { phoneTexts: ["508-555-5517"] }, { linkUrls: [] }]) {
      const original = page(); expect(() => derive(page({ visibleEvidence: { ...original.visibleEvidence!, ...change } }))).toThrow();
    }
    expect(() => derive(JSON.parse(JSON.stringify(page())))).toThrow();
  });
  it("requires exact unique provider contact and retains outdoor identity", () => {
    const contact = derive();
    for (const rows of [[...directory, ...directory], [{ ...directory[0], phone: "+15085555517" }], [{ ...directory[0], name: source.venueName }], [{ ...directory[0], isSimulator: true }]])
      expect(() => bindTeeItUpPhysicalContactFacility(source, contact, rows)).toThrow();
  });
  it("handles CMS footer widgets without treating their class as identity evidence", () => {
    const original = page(), html = original.html.replace("<footer>", '<div class="footer-widgets"><div>').replace("</footer>", "</div></div>");
    expect(derive(page({ html })).officialBrandName).toBe(publicName);
    expect(() => derive(page({ html: html.replace(publicName, "Other Country Club") }))).toThrow();
    expect(() => derive(page({ html: html.replace('class="footer-widgets"', 'class="generic-section"') }))).toThrow();
  });
  it("rejects conflicting or incomplete sibling fields, extra headings and phone mismatch", () => {
    for (const html of [page().html.replace("</footer>", "<p>Address : 19 Other Rd</p></footer>"),
      page().html.replace("</h1>", "</h1><h1>Another Country Club</h1>"),
      page().html.replace(`tel:${phone}`, "tel:+15085555517"),
      page().html.replace("508-555-5516</a>", "508-555-5517</a>")]) expect(() => derive(page({ html }))).toThrow();
  });
  it("cannot serialize an unproved different canonical name or modify contact fields", () => {
    const proof = bindTeeItUpPhysicalContactFacility(source, derive(), directory).physicalContactProof;
    for (const change of [{ canonicalName: "Other Golf & Country Club" }, { canonicalNameRelation: "EXACT_PUBLIC_LOCATION_NAME" }, { publicCoursePhone: "+15085555517" }])
      expect(() => teeItUpPhysicalContactProofSchema.parse({ ...proof, ...change })).toThrow();
  });
  it("reports the exact failed provider-contact predicate without exposing source data", () => {
    const gates: Record<string, boolean> = {};
    expect(() => bindTeeItUpPhysicalContactFacility(source, derive(), [{ ...directory[0], phone: "+15085555517" }],
      (key, value) => { gates[key] = value; })).toThrow();
    expect(gates).toMatchObject({ directoryPhysicalSchemaValid: true, directoryPhysicalIdsUnique: true,
      directoryPhysicalContactMatch: false, directoryPhysicalContactUnique: false });
    expect(JSON.stringify(gates)).not.toMatch(/example|https:|\+1508/iu);
  });
});
