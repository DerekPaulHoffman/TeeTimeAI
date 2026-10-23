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
  it("accepts the retained Emerald title and exact welcome heading with independently complete visible address evidence", () => {
    // Reconstructs the retained public text and links; this is not a raw HTML capture.
    const identity = { officialUrl: "https://www.golfemeraldlakes.com/", bookingUrl: "https://emerald-lakes-golf-course.book.teeitup.com/",
      venueName: "Emerald Lakes Golf Course", venueAddress: "10651 E. Stockton Blvd, Elk Grove, CA 95624, USA", timeZone: "America/Los_Angeles" };
    const document = { url: identity.officialUrl,
      html: `<html><head><title>Home - Emerald Lakes Golf Course</title></head><body><h1>WELCOME TO EMERALD LAKES GOLF COURSE</h1>
        <div>10651 E. Stockton Blvd.<br>Elk Grove, CA 95624</div>
        <a href="${identity.bookingUrl}">BOOK A TEE TIME</a><a href="${identity.bookingUrl}">TEE TIMES</a></body></html>`,
      visibleEvidence: { title: "Home - Emerald Lakes Golf Course", headings: ["WELCOME TO EMERALD LAKES GOLF COURSE"],
        linkUrls: [identity.bookingUrl], addressTexts: ["10651 E. Stockton Blvd., Elk Grove, CA 95624"] } };
    const proof = deriveTeeItUpOfficialIdentityProof(identity, document, { requireVisibleEvidence: true });
    expect(proof.venueName).toBe("emerald lakes golf course");
    expect(proof.alternateAddress).toEqual({ street: "10651 e stockton blvd", locality: "elk grove", region: "CA", postalCode: "95624", country: "US" });
    expect(proof.bookingUrl).toBe(identity.bookingUrl);
    expect(() => deriveTeeItUpOfficialIdentityProof(identity, { ...document, visibleEvidence: { ...document.visibleEvidence,
      headings: ["Welcome to another golf course"] } }, { requireVisibleEvidence: true })).toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
    expect(() => deriveTeeItUpOfficialIdentityProof(identity, { ...document, visibleEvidence: { ...document.visibleEvidence,
      addressTexts: ["10651 E. Stockton Blvd., Elk Grove, CA 95625"] } }, { requireVisibleEvidence: true })).toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
  });
  it.each(["Home - Mystery Valley Golf Club", "Mystery Valley Golf Club - Home"])("recognizes the exact spaced ASCII title segment %s", pageTitle => {
    expect(deriveTeeItUpOfficialIdentityProof(source, page(undefined, pageTitle)).venueName).toBe("mystery valley golf course");
  });
  it("keeps hyphens inside a full venue name rather than treating them as title delimiters", () => {
    const identity = { ...source, venueName: "Twin-Creek Golf Course" };
    expect(deriveTeeItUpOfficialIdentityProof(identity, page(undefined, "Home - Twin-Creek Golf Course - Official Site", "<h1>Welcome to Twin-Creek Golf Course</h1>"))
      .venueName).toBe("twin creek golf course");
  });
  it.each(["Cedar Valley - East Golf Course", "Cedar Valley - East Golf Course | Official Site"])
    ("preserves a previously accepted full venue title containing a spaced hyphen: %s", pageTitle => {
      expect(deriveTeeItUpOfficialIdentityProof({ ...source, venueName: "Cedar Valley - East Golf Course" },
        page(undefined, pageTitle, "<h1>Cedar Valley - East Golf Course</h1>")).venueName).toBe("cedar valley east golf course");
    });
  it.each(["<h1>Welcome to Mystery Valley Golf Club</h1>", "<h2>WELCOME TO MYSTERY VALLEY GOLF COURSE</h2>"])("recognizes only an exact welcome heading wrapper %s", headings => {
    const wrapped = deriveTeeItUpOfficialIdentityProof(source, page(undefined, undefined, headings));
    expect(wrapped.venueName).toBe("mystery valley golf course");
    expect(wrapped.markupWitnessSha256).not.toBe(deriveTeeItUpOfficialIdentityProof(source, page()).markupWitnessSha256);
  });
  it("preserves an exact full course name that itself begins with Welcome to", () => {
    expect(deriveTeeItUpOfficialIdentityProof({ ...source, venueName: "Welcome To Golf Club" },
      page(undefined, "Welcome To Golf Club", "<h1>Welcome To Golf Club</h1>")).venueName).toBe("welcome to golf course");
  });
  it.each([
    page(undefined, "Home-Mystery Valley Golf Club"),
    page(undefined, "Home - Visit Mystery Valley Golf Club"),
    page(undefined, "A - B - Mystery Valley Golf Club - D"),
    page(undefined, undefined, "<h1>Welcome to the Mystery Valley Golf Club</h1>"),
    page(undefined, undefined, "<h1>Welcome back to Mystery Valley Golf Club</h1>"),
    page(undefined, undefined, "<h1>Welcome to Mystery Valley Golf Clubhouse</h1>"),
    page(undefined, undefined, "<h1>Welcome to Mystery Valley Golf Club</h1><h1>Other Resort</h1>"),
    page(undefined, undefined, "<h1>Welcome to Another Golf Course</h1><h2>Mystery Valley Golf Club</h2>"),
    page(undefined, undefined, "<h1>Welcome to Mystery Valley Golf Club</h1><h2>Welcome to Another Golf Course</h2>"),
  ])("rejects broader promotional, contradictory or missing exact title/heading evidence %#", document => {
    expect(() => deriveTeeItUpOfficialIdentityProof(source, document)).toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
  });
  it.each(["", "?course=5319", "?course=5319,5320&date=2030-10-23"])("accepts only the same legacy tenant and exact public URL descriptor across com/golf aliases %s", query => {
    const bookingUrl = `https://mystery-valley.book.teeitup.com/${query}`, aliasUrl = `https://mystery-valley.book.teeitup.golf/${query}`;
    const identity = { ...source, bookingUrl };
    const document = page(address + `<a href="${bookingUrl}">Tee Times</a><a href="${aliasUrl}">Book</a>`);
    const proof = deriveTeeItUpOfficialIdentityProof(identity, document);
    expect(proof.bookingUrl).toBe(bookingUrl);
    expect(proof.markupWitnessSha256).not.toBe(deriveTeeItUpOfficialIdentityProof(identity, page(address + `<a href="${bookingUrl}">Tee Times</a>`)).markupWitnessSha256);
    expect(() => deriveTeeItUpOfficialIdentityProof(identity, page(address + `<a href="${aliasUrl}">Tee Times</a>`))).toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
    expect(deriveTeeItUpOfficialIdentityProof({ ...identity, bookingUrl: aliasUrl }, document).bookingUrl).toBe(aliasUrl);
  });
  it.each([
    "https://another.book.teeitup.com/?course=5319",
    "https://mystery-valley.book.teeitup.golf/?course=5320",
    "https://mystery-valley.book.teeitup.golf/",
    "https://mystery-valley.book.teeitup.golf/?course=5319&date=2030-10-23",
    "https://mystery-valley.book.teeitup.golf/other?course=5319",
    "http://mystery-valley.book.teeitup.golf/?course=5319",
    "https://u:p@mystery-valley.book.teeitup.golf/?course=5319",
    "https://mystery-valley.book.teeitup.golf:8443/?course=5319",
    "https://mystery-valley.book.teeitup.golf/?course=5319#other",
    "https://mystery-valley.book-v2.teeitup.golf/?course=5319",
  ])("rejects a second conflicting or noncanonical booking descriptor %s", other => {
    const bookingUrl = "https://mystery-valley.book.teeitup.com/?course=5319";
    expect(() => deriveTeeItUpOfficialIdentityProof({ ...source, bookingUrl }, page(address + `<a href="${bookingUrl}">Tee Times</a><a href="${other}">Book</a>`)))
      .toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
  });
  it.each(["?course=5319&course=5319", "?course=5319,5319", "?course=2147483648", "?course=0", "?date=2030-02-30", "?token=opaque"])
    ("does not equate matching malformed or nonpublic legacy alias descriptors %s", query => {
      const bookingUrl = `https://mystery-valley.book.teeitup.com/${query}`, aliasUrl = `https://mystery-valley.book.teeitup.golf/${query}`;
      expect(() => deriveTeeItUpOfficialIdentityProof({ ...source, bookingUrl }, page(address + `<a href="${bookingUrl}">Tee Times</a><a href="${aliasUrl}">Book</a>`)))
        .toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
    });
  it("does not infer alias equivalence from reordered or differently encoded queries", () => {
    const bookingUrl = "https://mystery-valley.book.teeitup.com/?course=5319,5320&date=2030-10-23";
    for (const aliasUrl of ["https://mystery-valley.book.teeitup.golf/?date=2030-10-23&course=5319,5320",
      "https://mystery-valley.book.teeitup.golf/?course=5319%2C5320&date=2030-10-23"])
      expect(() => deriveTeeItUpOfficialIdentityProof({ ...source, bookingUrl }, page(address + `<a href="${bookingUrl}">Tee Times</a><a href="${aliasUrl}">Book</a>`)))
        .toThrow("OFFICIAL_IDENTITY_UNVERIFIED");
  });
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
