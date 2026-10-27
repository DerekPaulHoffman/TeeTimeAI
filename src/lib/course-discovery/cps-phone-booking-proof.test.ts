// @vitest-environment node
import { describe, expect, it } from "vitest";
import { bindCpsPhoneBookingProof, selectedCpsOfficialBookingAnchor } from "./cps-phone-booking-proof";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { parseAccessRecipe } from "./recipe";
import { cpsMetadataSchema, parseCpsCatalog, type CpsOptions } from "./cps-source";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const source = { officialUrl: "https://official.example/", bookingUrl: "https://harbor.cps.golf/", venueName: "Harbor Pointe Golf Course",
  venueAddress: "10 Harbor Dr, Example, NY 12345, USA", timeZone: "America/New_York" };
const phone = "+15083799886", catalog = { tenant: "harbor", courseIds: [7], catalogHash: "a".repeat(64) };
const tel = '<a href="tel:508-379-9886">508-379-9886</a>';
const markup = (contact = tel) => `<html><body><h1>Harbor Pointe Golf Course</h1><section><h2>CONTACT US</h2>${contact}</section>
  <a href="${source.bookingUrl}">Book a Tee Time</a></body></html>`;
function page(html = markup(), change: Partial<OfficialIdentityPage["visibleEvidence"]> = {}) {
  const current: OfficialIdentityPage = { url: source.officialUrl, html, browserTransport: "NATIVE_CHROME",
    visibleEvidence: { title: "Harbor Pointe", headings: [source.venueName, "CONTACT US"], linkUrls: [source.bookingUrl],
      addressTexts: [], phoneTexts: ["508-379-9886"], contactPhoneLinks: [{ href: "tel:508-379-9886", text: "508-379-9886" }], ...change } };
  return registerFreshNativeOfficialIdentityPage(current, source.officialUrl, new Date(Date.now() + 30_000));
}
const bind = (current: OfficialIdentityPage, number: unknown = phone) =>
  bindCpsPhoneBookingProof(source, current, number, catalog, source.venueName);

describe("CPS fresh official phone and booking link", () => {
  it("selects one named active course from a larger options response using the fresh official descriptor", () => {
    const selected=`<a href="${source.bookingUrl}">Championship Course Tee Times</a>`;
    const alternate='<a href="https://harbor-par3.cps.golf/">Par 3 Course Tee Times</a>';
    const current=page(markup().replace(`<a href="${source.bookingUrl}">Book a Tee Time</a>`,selected+alternate),{
      linkUrls:[source.bookingUrl,"https://harbor-par3.cps.golf/"],publicLinkLabels:[
        {href:source.bookingUrl,text:"Championship Course Tee Times"},
        {href:"https://harbor-par3.cps.golf/",text:"Par 3 Course Tee Times"}] });
    const options:CpsOptions={webSiteId:"public-site",reservationOptions:{terminalId:1},courseOptions:[
      {courseId:1,courseName:"Harbor Pointe Front",webSiteId:"public-site"},
      {courseId:2,courseName:"Harbor Pointe Back",webSiteId:"public-site"},
      {courseId:3,courseName:"Harbor Pointe Championship Course",webSiteId:"public-site"},
      {courseId:4,courseName:"Harbor Pointe Par 3 Course",webSiteId:"public-site"}]};
    const rows=[{courseId:3,courseName:"Harbor Pointe Championship Course",timezoneId:source.timeZone,websiteId:"public-site",active:true as const,holes:18 as const},
      {courseId:4,courseName:"Harbor Pointe Par 3 Course",timezoneId:source.timeZone,websiteId:"public-site",active:true as const,holes:9 as const}];
    let selectedName="";
    const context={page:current,canonicalCoursePhone:phone,phoneBooking:true as const,onSelectedLabel:(value:string)=>{selectedName=value;}};
    const metadata=parseCpsCatalog(rows,options,source,context);
    expect(metadata.courseIds).toEqual([3]);expect(selectedName).toBe("Harbor Pointe Championship Course");
    expect(parseCpsCatalog([...rows].reverse(),options,source,context).catalogHash).not.toBe(metadata.catalogHash);
    expect(parseCpsCatalog(rows,{...options,courseOptions:[...options.courseOptions].reverse()},source,context).catalogHash)
      .not.toBe(metadata.catalogHash);
    expect(parseCpsCatalog(rows,{...options,courseOptions:options.courseOptions.map(row=>row.courseId===1?
      {...row,courseName:"Harbor Pointe Front Nine"}:row)},source,context).catalogHash).not.toBe(metadata.catalogHash);
    const proof=bindCpsPhoneBookingProof(source,current,phone,metadata,selectedName);
    expect(proof.selectedAnchorLabel).toBe("Championship Course Tee Times");
    const collapsedRaw=page(current.html.replace(selected,
      `<ul style="overflow:hidden;height:0"><a href="${source.bookingUrl}">Champion Course Tee Times</a></ul>${selected}`),
      {...current.visibleEvidence});
    expect(parseCpsCatalog(rows,options,source,{...context,page:collapsedRaw}).courseIds).toEqual([3]);
    expect(bindCpsPhoneBookingProof(source,collapsedRaw,phone,metadata,selectedName)).toEqual(proof);
    expect(cpsMetadataSchema.parse({...metadata,officialPhoneBookingProof:proof}).courseIds).toEqual([3]);
    expect(() => cpsMetadataSchema.parse({...metadata,officialPhoneBookingProof:{...proof,selectedAnchorLabel:"Par 3 Course Tee Times"}})).toThrow();
    const changedOptions={...options,courseOptions:options.courseOptions.map(row=>row.courseId===4?{...row,courseName:"Wrong Par 3"}:row)};
    expect(() => parseCpsCatalog(rows,changedOptions,source,context)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parseCpsCatalog(rows.map(row=>row.courseId===3?{...row,websiteId:"foreign"}:row),options,source,context))
      .toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parseCpsCatalog(rows.map(row=>row.courseId===3?{...row,timezoneId:"America/Denver"}:row),options,source,context))
      .toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parseCpsCatalog(rows.map(row=>row.courseId===4?{...row,timezoneId:"America/Denver"}:row),options,source,context))
      .toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => parseCpsCatalog([...rows,rows[0]],options,source,context)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    const wrongLabel=page(current.html,{...current.visibleEvidence,publicLinkLabels:[{href:source.bookingUrl,text:"Par 3 Course Tee Times"}]});
    expect(() => parseCpsCatalog(rows,options,source,{...context,page:wrongLabel})).toThrow("ADAPTER_IDENTITY_MISMATCH");
    const ambiguousSource=page(current.html.replace("Championship Course Tee Times","Par 3 Course Tee Times"),{
      ...current.visibleEvidence,publicLinkLabels:[
        {href:source.bookingUrl,text:"Par 3 Course Tee Times"},
        {href:"https://harbor-par3.cps.golf/",text:"Par 3 Course Tee Times"}]});
    expect(() => parseCpsCatalog(rows,options,source,{...context,page:ambiguousSource})).toThrow("ADAPTER_IDENTITY_MISMATCH");
    const conflictingRaw=page(current.html.replace(selected,selected+`<a href="${source.bookingUrl}">Another Course Tee Times</a>`),{
      ...current.visibleEvidence,publicLinkLabels:[...current.visibleEvidence.publicLinkLabels!,
        {href:source.bookingUrl,text:"Another Course Tee Times"}]});
    expect(() => parseCpsCatalog(rows,options,source,{...context,page:conflictingRaw})).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("binds a public phone and booking link without claiming a provider street address", () => {
    const proof = bind(page());
    expect(proof).toMatchObject({ kind: "OFFICIAL_PHONE_BOOKING_LINK", canonicalAddressInput: source.venueAddress,
      canonicalCoursePhone: phone, bookingUrl: source.bookingUrl, courseIds: [7], warmTransport: "NATIVE_CHROME" });
    expect(proof).not.toHaveProperty("officialAddress");
    expect(bind(page(markup().replace("<section>", `<section>${tel}`)))).toEqual(proof);
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course-1", kind: "OUTDOOR" },
      source: { ...source, providerFamily: "CPS" }, adapter: { family: "CPS", ...catalog, officialPhoneBookingProof: proof } };
    expect(parseAccessRecipe(recipe).engine).toBe("EXISTING_ADAPTER");
    for (const changed of [{ officialUrl: "https://other.example/" }, { bookingUrl: "https://other.cps.golf/" },
      { venueAddress: "11 Harbor Dr, Example, NY 12345, USA" }, { venueName: "Other Golf Course" }, { timeZone: "America/Denver" }])
      expect(() => parseAccessRecipe({ ...recipe, source: { ...recipe.source, ...changed } })).toThrow();
  });
  it("rejects a conflicting explicit course label even when the catalog has one canonical course", () => {
    const options:CpsOptions={webSiteId:"public-site",reservationOptions:{terminalId:1},courseOptions:[
      {courseId:7,courseName:source.venueName,webSiteId:"public-site"}]};
    const rows=[{courseId:7,courseName:source.venueName,timezoneId:source.timeZone,websiteId:"public-site",active:true as const,holes:18 as const}];
    const context=(current:OfficialIdentityPage)=>({page:current,canonicalCoursePhone:phone,phoneBooking:true as const,onSelectedLabel:()=>{}});
    expect(parseCpsCatalog(rows,options,source,context(page())).courseIds).toEqual([7]);
    const explicit=(label:string)=>page(markup().replace("Book a Tee Time",label),
      {publicLinkLabels:[{href:source.bookingUrl,text:label}]});
    const correct=explicit("Harbor Pointe Golf Course Tee Times");
    const metadata=parseCpsCatalog(rows,options,source,context(correct));
    const proof=bindCpsPhoneBookingProof(source,correct,phone,metadata,source.venueName);
    expect(proof.selectedAnchorLabel).toBe("Harbor Pointe Golf Course Tee Times");
    expect(cpsMetadataSchema.parse({...metadata,officialPhoneBookingProof:proof}).courseIds).toEqual([7]);
    const wrong=explicit("Par 3 Course Tee Times");
    expect(() => parseCpsCatalog(rows,options,source,context(wrong))).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => bindCpsPhoneBookingProof(source,wrong,phone,metadata,source.venueName))
      .toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    const mismatched=page(correct.html,{publicLinkLabels:[{href:source.bookingUrl,text:"Par 3 Course Tee Times"}]});
    expect(() => parseCpsCatalog(rows,options,source,context(mismatched))).toThrow("ADAPTER_IDENTITY_MISMATCH");
    expect(() => bindCpsPhoneBookingProof(source,mismatched,phone,metadata,source.venueName))
      .toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    expect(bindCpsPhoneBookingProof(source,page(),phone,metadata,source.venueName).selectedAnchorLabel).toBeUndefined();
  });
  it("matches the exact selected CPS course link while allowing a distinct public course choice", () => {
    const alternate = '<a href="https://harbor-par3.cps.golf/">Par 3 Course Tee Times</a>';
    const selected = `<a href="${source.bookingUrl}">Championship Course Tee Times</a>`;
    const current = page(markup().replace(`<a href="${source.bookingUrl}">Book a Tee Time</a>`, `${selected}${alternate}`),
      { linkUrls: [source.bookingUrl, "https://harbor-par3.cps.golf/"], publicLinkLabels: [
        {href:source.bookingUrl,text:"Championship Course Tee Times"},
        {href:"https://harbor-par3.cps.golf/",text:"Par 3 Course Tee Times"}] });
    expect(() => bind(current)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    const proof=bindCpsPhoneBookingProof(source,current,phone,catalog,"Harbor Pointe Championship Course");
    expect(proof.selectedAnchorLabel).toBe("Championship Course Tee Times");
    expect(proof.selectedAnchorRawWitnessSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(proof.selectedAnchorRenderedWitnessSha256).toMatch(/^[a-f0-9]{64}$/u);
    const replay=page(current.html,{...current.visibleEvidence});
    expect(bindCpsPhoneBookingProof(source,replay,phone,catalog,"Harbor Pointe Championship Course")).toEqual(proof);
    const changedReplay=page(current.html.replace("Championship Course Tee Times","Championship Links Tee Times"),{
      ...current.visibleEvidence,publicLinkLabels:[{href:source.bookingUrl,text:"Championship Links Tee Times"}]});
    expect(() => bindCpsPhoneBookingProof(source,changedReplay,phone,catalog,"Harbor Pointe Championship Course"))
      .toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    expect(selectedCpsOfficialBookingAnchor(source,current)?.descriptor).toBe("championship course");
    const duplicateSameLabel=page(current.html.replace(selected,selected+selected),{...current.visibleEvidence});
    expect(selectedCpsOfficialBookingAnchor(source,duplicateSameLabel)?.descriptor).toBe("championship course");
    expect(() => bindCpsPhoneBookingProof(source,current,phone,catalog,"Harbor Pointe Par 3 Course"))
      .toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    const wrong = page(markup().replace(`<a href="${source.bookingUrl}">Book a Tee Time</a>`, alternate),
      { linkUrls: ["https://harbor-par3.cps.golf/"] });
    expect(() => bind(wrong)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    for(const changed of [
      {publicLinkLabels:[{href:source.bookingUrl,text:"Par 3 Course Tee Times"}]},
      {publicLinkLabels:[{href:source.bookingUrl,text:"Championship Course Tee Times"},{href:source.bookingUrl,text:"Par 3 Course Tee Times"}]},
      {publicLinkLabels:[{href:source.bookingUrl,text:"Book a Tee Time"}]},
      {publicLinkLabelsOmitted:true},
    ]) expect(() => bindCpsPhoneBookingProof(source,page(current.html,changed),phone,catalog,"Harbor Pointe Championship Course"))
      .toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
  });
  it("does not mistake an unobserved responsive blank tel placeholder for a visible competing phone", () => {
    const responsive = '<div class="mobile-contact-placeholder"><a href="tel:5555555555"></a></div>';
    const current = page(markup().replace("</body>", `${responsive}</body>`));
    expect(bind(current)).toEqual(bind(page()));
    const shown = page(markup().replace("</body>", `${responsive}</body>`),
      { phoneTexts: ["508-379-9886", "555-555-5555"], contactPhoneLinks: [
        { href: "tel:508-379-9886", text: "508-379-9886" }, { href: "tel:5555555555", text: "555-555-5555" }] });
    expect(() => bind(shown)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
  });
  it("rejects wrong, ambiguous, hidden-only, form, missing and mismatched public phone evidence", () => {
    expect(() => bind(page(), "+15083799887")).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    for (const current of [page(markup(tel + '<a href="tel:508-379-9887">508-379-9887</a>'),
      { phoneTexts: ["508-379-9886", "508-379-9887"], contactPhoneLinks: [
        { href: "tel:508-379-9886", text: "508-379-9886" }, { href: "tel:508-379-9887", text: "508-379-9887" }] }),
      page(markup(`<div hidden>${tel}</div>`)), page(markup(`<form>${tel}</form>`)),
      page(markup(tel.replace("tel:508-379-9886", "tel:508-379-9887"))),
      page(markup(), { phoneTexts: ["508-379-9887"] }), page(markup(), { contactPhoneLinks: [] }),
      page(markup(), { contactPhoneLinksOmitted: true }), page(markup(), { phoneTextsOmitted: true })]) {
      expect(() => bind(current)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    }
  });
  it("rejects stale, copied, wrong venue, and wrong or hidden booking links", () => {
    const original = page();
    expect(() => bind(structuredClone(original))).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    for (const current of [page(markup().replace("Harbor Pointe Golf Course", "Other Golf Course")),
      page(markup().replace(`href="${source.bookingUrl}"`, 'href="https://other.cps.golf/"')),
      page(markup().replace(`<a href="${source.bookingUrl}"`, `<a hidden href="${source.bookingUrl}"`)),
      page(markup(), { linkUrls: [] })]) expect(() => bind(current)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
    original.html = markup().replace("508-379-9886", "508-379-9887");
    expect(() => bind(original)).toThrow("CPS_PHONE_BOOKING_SOURCE_UNVERIFIED");
  });
});
