import { describe, expect, it } from "vitest";
import { completeUSAddress, deriveTeeItUpOfficialIdentityProof, matchesOfficialFacility } from "./teeitup-official-identity";
import { resolveTeeItUpRecipeFacilities } from "./teeitup-recipe-source";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://mystery-valley.book.teeitup.golf/",
  venueName: "Mystery Valley Golf Course", venueAddress: "6191 Nell Yates Dr, Lithonia, GA 30058, USA", timeZone: "America/New_York" };
const title = "Mystery Valley Golf Club &#8211; Golf at Its Best";
const address = "<div><strong>Address: </strong>6094 Shadow Rock Drive<br>Lithonia, GA 30058, US</div>";
const link = `<a href="${source.bookingUrl}">Tee Times</a>`;
const html = (body = address + link, pageTitle = title, headings = "<h2>Mystery Valley Golf Club</h2>") =>
  `<html><head><title>${pageTitle}</title></head><body>${headings}${body}</body></html>`;
const page = (body?: string, pageTitle?: string, headings?: string) => ({ url: source.officialUrl, html: html(body, pageTitle, headings) });
const facility = { id: 5319, courseId: "public-course", name: "Mystery Valley Golf Club",
  address: "6094 Shadow Rock Drive, Lithonia, GA 30058, GA 30058, US", timeZone: source.timeZone, isSimulator: false };

describe("official source/address identity attestation", () => {
  it("accepts the entire title segment plus standalone heading and a unique printed alternate address", () => {
    const proof = deriveTeeItUpOfficialIdentityProof(source, page());
    expect(proof).toEqual({ kind: "OFFICIAL_SOURCE_ADDRESS", officialPageUrl: source.officialUrl, bookingUrl: source.bookingUrl, markupWitnessSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      venueName: "mystery valley golf course", alternateAddress: { street: "6094 shadow rock dr", locality: "lithonia", region: "GA", postalCode: "30058", country: "US" } });
    expect(matchesOfficialFacility(proof, source, facility)).toBe(true);
    expect(resolveTeeItUpRecipeFacilities(source, [facility], proof)).toEqual([facility]);
    expect(source.venueAddress).toBe("6191 Nell Yates Dr, Lithonia, GA 30058, USA");
    expect(() => resolveTeeItUpRecipeFacilities(source, [facility])).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["/", "/teetimes"])("attests only the exact observed V2 public booking link %s", path => {
    const bookingUrl = `https://public.book-v2.teeitup.golf${path}`, identity = { ...source, bookingUrl };
    const document = page(address + `<a href="${bookingUrl}">Tee Times</a>`);
    const proof = deriveTeeItUpOfficialIdentityProof(identity, document);
    expect(proof.bookingUrl).toBe(bookingUrl);
    expect(resolveTeeItUpRecipeFacilities(identity, [facility], proof)).toEqual([facility]);
    expect(() => deriveTeeItUpOfficialIdentityProof(identity, page(address + `<a href="https://other.book-v2.teeitup.golf/">Tee Times</a>`))).toThrow();
    expect(() => deriveTeeItUpOfficialIdentityProof({ ...identity, bookingUrl: `${bookingUrl}?timeId=123` }, document)).toThrow();
  });
  it.each([
    page(undefined, "Mystery Valley Golf Clubhouse – Golf at Its Best"),
    page(undefined, "Visit Mystery Valley Golf Club – Golf at Its Best"),
    page(undefined, "Parent Resort", "<h2>Mystery Valley Golf Club</h2>"),
    page(undefined, undefined, "<h2>Mystery Valley East Golf Club</h2>"),
    page(undefined, undefined, "<h1>Parent Resort</h1><h2>Mystery Valley Golf Club</h2>"),
    page(undefined, undefined, "<h2>Mystery Valley Golf Club</h2><h2>Neighbor Golf Course</h2>"),
    page(address + link + "<p>99 Other Road, Lithonia, GA 30058, US</p>"),
    page(address.replace("30058", "30059") + link),
    page(address.replace("Lithonia", "Atlanta") + link),
    page(address.replace("GA", "FL") + link),
    page(address.replace("Address:", "Mailing Address:") + link),
    page(`<section aria-label="Mailing address">${address}</section>${link}`),
    page(`<section><h3>Corporate headquarters</h3>${address}</section>${link}`),
    page(address.replace("6094 Shadow Rock Drive", "PO Box 123") + link),
    page(`<script>${address}</script>${link}`),
    page(`<iframe>${address}</iframe>${link}`),
    page(`<div hidden>${address}</div>${link}`),
    page(`<div aria-hidden="true">${address}</div>${link}`),
    page(`<div style="display:none">${address}</div>${link}`),
    page(`<div class="d-none">${address}</div>${link}`),
    page(`<div class="screen-reader-text">${address}</div>${link}`),
    page(`<div style="opacity:0">${address}</div>${link}`),
    page(`<div inert>${address}</div>${link}`),
    page(address + `<a href="https://another.book.teeitup.golf/">Tee Times</a>`),
    page(address + link + `<a href="https://another.book.teeitup.golf/">Book</a>`),
    { ...page(), url: "https://another.example.org/" },
  ])("rejects missing, ambiguous or mismatched public evidence %#", value => {
    expect(() => deriveTeeItUpOfficialIdentityProof(source, value)).toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
  });
  it.each([
    { ...facility, name: "Mystery Valley East Golf Club" }, { ...facility, isSimulator: true },
    { ...facility, timeZone: "America/Chicago" }, { ...facility, address: "1 Other Road, Lithonia, GA 30058, US" },
  ])("rejects a nonmatching provider facility %#", value => {
    expect(matchesOfficialFacility(deriveTeeItUpOfficialIdentityProof(source, page()), source, value)).toBe(false);
  });
  it("rejects duplicate matching facilities even with a selected facility identifier", () => {
    const scoped = { ...source, bookingUrl: `${source.bookingUrl}?course=5319` };
    const proof = deriveTeeItUpOfficialIdentityProof(scoped, page(address + `<a href="${scoped.bookingUrl}">Tee Times</a>`));
    expect(() => resolveTeeItUpRecipeFacilities(scoped, [facility, { ...facility, id: 5320, courseId: "another" }], proof)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("requires all address components and does not drop substantive street tokens", () => {
    expect(completeUSAddress("6094 Shadow Rock Drive, Lithonia, GA 30058, US")?.street).toBe("6094 shadow rock dr");
    expect(completeUSAddress("Shadow Rock Drive, Lithonia, GA 30058, US")).toBeNull();
    expect(completeUSAddress("6094 Shadow Rock Drive, GA 30058, US")).toBeNull();
  });
  it("recognizes a complete Way address without discarding the street or direction", () => {
    expect(completeUSAddress("14330 SE Husky Way, Auburn, WA 98092, USA")).toEqual({
      street: "14330 se husky way", locality: "auburn", region: "WA", postalCode: "98092", country: "US",
    });
    for (const address of ["SE Husky Way, Auburn, WA 98092, USA", "14330 SE Husky Way, WA 98092, USA",
      "14330 SE Husky, Auburn, WA 98092, USA", "PO Box 14330, Auburn, WA 98092, USA"])
      expect(completeUSAddress(address)).toBeNull();
  });
  it("requires browser visibility at discovery and changes its witness on concealment-related markup changes", () => {
    const captured = { ...page(), visibleEvidence: { title: "Mystery Valley Golf Club – Golf at Its Best", headings: ["Mystery Valley Golf Club"],
      linkUrls: [source.bookingUrl], addressTexts: ["Address: 6094 Shadow Rock Drive, Lithonia, GA 30058, US"] } };
    const proof = deriveTeeItUpOfficialIdentityProof(source, captured, { requireVisibleEvidence: true });
    expect(() => deriveTeeItUpOfficialIdentityProof(source, page(), { requireVisibleEvidence: true })).toThrow();
    expect(() => deriveTeeItUpOfficialIdentityProof(source, { ...captured, visibleEvidence: { ...captured.visibleEvidence, addressTexts: [] } }, { requireVisibleEvidence: true })).toThrow();
    expect(deriveTeeItUpOfficialIdentityProof(source, { ...captured, html: captured.html.replace("<div>", '<div class="new-class">') }).markupWitnessSha256).not.toBe(proof.markupWitnessSha256);
  });
});
