import { describe, expect, it } from "vitest";
import { createPublicBookingParentScope } from "./public-booking-parent";
import { publicFrameSource } from "./public-frame-source";

describe("context-local verified public booking parents", () => {
  const official = "https://www.venue.example/", bare = "https://venue.example/", booking = "https://booking.example/club/12";
  const parent = "https://www.booking.example/club/public-golf";
  const identity = { officialUrl: official, venueName: "Harbour Pointe Golf Club", venueAddress: "11817 Harbour Pointe Blvd, Mukilteo, WA 98275, USA" };
  const visible = { headings: [identity.venueName], addressTexts: ["11817 Harbour Pointe Blvd, Mukilteo, Washington, 98275"] };
  const scope = () => createPublicBookingParentScope(identity);
  it("confines the private Contact handoff to one actual native 200 document", () => {
    const contact = "https://www.venue.example/contact/";
    const value = createPublicBookingParentScope(identity, contact);
    expect(value.authorizeParent(contact)).toBeUndefined();
    value.observeDocument({ url: contact, status: 200 });
    expect(value.authorizeParent(contact)).toEqual({ kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: official, documentUrl: contact });
    expect(value.authorizeParent("https://www.venue.example/other/")).toBeUndefined();
    value.beginDocument(contact);
    expect(value.authorizeParent(contact)).toBeUndefined();
    value.observeDocument({ url: contact, status: 403 });
    expect(value.authorizeParent(contact)).toBeUndefined();
    expect(() => createPublicBookingParentScope(identity, "https://other.example/contact/")).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  });
  const prepare = () => {
    const value = scope();
    value.observeDocument({ url: official, status: 301 });
    value.observeDocument({ url: bare, status: 200, redirectedFrom: official });
    value.observeOfficialLink(bare, booking, "Book a Tee-Time");
    value.observeDocument({ url: booking, status: 301 });
    value.observeDocument({ url: parent, status: 200, redirectedFrom: booking });
    return value;
  };
  it("accepts the exact captured full-state address only after the observed official link and verified redirect chain", () => {
    const value = prepare(), proof = value.authorizeParent(parent, visible);
    expect(value.authorizeParent(bare)).toEqual({ kind: "VERIFIED_OFFICIAL_DOCUMENT", officialUrl: official, documentUrl: bare });
    expect(proof).toEqual({ kind: "OBSERVED_PUBLIC_BOOKING_PARENT", officialUrl: official, documentUrl: parent,
      officialDocumentUrl: bare, observedBookingHref: booking });
    expect(publicFrameSource({ src: "https://www.booking.example/club/12/widget", label: "Profile Page Booking Widget", visible: true, srcdoc: false },
      parent, official, parent, proof)).toBe("https://www.booking.example/club/12/widget");
  });
  it("never borrows www authority from similar hosts without an actual redirect or from unvisited navigation", () => {
    const value = scope();
    value.observeDocument({ url: bare, status: 200 });
    expect(value.authorizeParent(bare)).toBeUndefined();
    value.observeOfficialLink(official, booking, "Book tee times");
    value.observeDocument({ url: booking, status: 200 });
    expect(value.authorizeParent(booking, visible)).toBeUndefined();
    expect(value.authorizeParent(official)).toBeUndefined();
    value.observeDocument({ url: "https://venue.example.evil.org/", status: 200, redirectedFrom: official });
    expect(value.authorizeParent("https://venue.example.evil.org/")).toBeUndefined();
  });
  it("does not confer cross-host official authority from redirect strings, pinned HTTP or forged native data", () => {
    for (const nativeRequest of [undefined, {}, { url: () => "https://new-municipal.example/golf", redirectedFrom: () => ({ url: () => official }) }]) {
      const value = scope(), destination = "https://new-municipal.example/golf";
      value.observeDocument({ url: official, status: 301 });
      value.observeDocument({ url: destination, status: 200, redirectedFrom: official, nativeRequest });
      expect(value.authorizeParent(destination, visible)).toBeUndefined();
    }
  });
  it("can follow an actual same-origin official booking page before its observed provider link", () => {
    const value = scope(), intermediary = "https://www.venue.example/tee-times";
    value.observeDocument({ url: official, status: 200 });
    value.observeOfficialLink(official, intermediary, "Book tee times");
    expect(value.authorizeParent(intermediary)).toBeUndefined();
    value.observeDocument({ url: intermediary, status: 200 });
    expect(value.authorizeParent(intermediary)).toMatchObject({ kind: "VERIFIED_OFFICIAL_DOCUMENT", documentUrl: intermediary });
    value.observeOfficialLink(intermediary, booking, "Book tee times"); value.observeDocument({ url: booking, status: 200 });
    expect(value.authorizeParent(booking, visible)).toMatchObject({ kind: "OBSERVED_PUBLIC_BOOKING_PARENT", officialDocumentUrl: intermediary });
  });
  it.each([401, 403, 202, 206, 500])("invalidates an earlier verified parent on a new HTTP %s response", status => {
    const value = prepare(); expect(value.authorizeParent(parent, visible)).toBeDefined();
    value.observeDocument({ url: parent, status }); expect(value.authorizeParent(parent, visible)).toBeUndefined();
  });
  it("invalidates an earlier verified document at the start of a real new navigation, including a failed read", () => {
    const value = prepare(); expect(value.authorizeParent(parent, visible)).toBeDefined();
    value.beginDocument(parent); expect(value.authorizeParent(parent, visible)).toBeUndefined();
    value.observeDocument({ url: parent, status: 200 }); expect(value.authorizeParent(parent, visible)).toBeDefined();
  });
  it.each([
    { ...visible, headings: ["Harbour Ridge Golf Club"] },
    { ...visible, headings: [identity.venueName, identity.venueName] },
    { ...visible, headings: [] },
    { ...visible, addressTexts: ["11819 Harbour Pointe Blvd, Mukilteo, Washington, 98275"] },
    { ...visible, addressTexts: ["11817 Harbour Pointe Blvd, Mukilteo, Washington, 98276"] },
    { ...visible, addressTexts: [...visible.addressTexts, "120 Main Rd, Mukilteo, WA 98275"] },
    { ...visible, addressTexts: ["Mukilteo, Washington, 98275"] },
    { ...visible, truncated: true },
  ])("rejects wrong, incomplete, ambiguous or truncated rendered identity: %j", evidence => {
    expect(prepare().authorizeParent(parent, evidence)).toBeUndefined();
  });
  it("does not make a new browser, another document/query, diagnostic or ordinary social link a parent", () => {
    expect(scope().authorizeParent(parent, visible)).toBeUndefined();
    const value = prepare();
    expect(value.authorizeParent(`${parent}?other=1`, visible)).toBeUndefined();
    expect(value.authorizeParent("https://booking.example/club/other", visible)).toBeUndefined();
    for (const [href, label] of [["https://facebook.com/public-golf", "Book tee times"], ["https://other.example/", "Visit us"], ["https://booking.example/checkout", "Book tee times"]]) {
      value.observeOfficialLink(bare, href, label); value.observeDocument({ url: href, status: 200 });
      expect(value.authorizeParent(href, visible)).toBeUndefined();
    }
    // A verified provider cannot turn unrelated links into another parent.
    value.observeOfficialLink(parent, "https://next.example/", "Book tee times"); value.observeDocument({ url: "https://next.example/", status: 200 });
    expect(value.authorizeParent("https://next.example/", visible)).toBeUndefined();
  });
  it("keeps original source and exact parent-document binding on the frame helper", () => {
    const proof = prepare().authorizeParent(parent, visible)!;
    const frame = { src: "https://booking.example/widget", label: "Booking", visible: true, srcdoc: false };
    expect(publicFrameSource(frame, parent, official, parent)).toBeUndefined();
    expect(publicFrameSource(frame, `${parent}?changed=1`, official, `${parent}?changed=1`, proof)).toBeUndefined();
    expect(publicFrameSource(frame, parent, "https://other.example/", parent, proof)).toBeUndefined();
    expect(publicFrameSource(frame, parent, official, "https://booking.example/old", proof)).toBeUndefined();
    expect(publicFrameSource({ ...frame, visible: false }, parent, official, parent, proof)).toBeUndefined();
    expect(publicFrameSource({ ...frame, srcdoc: true }, parent, official, parent, proof)).toBeUndefined();
    expect(publicFrameSource({ ...frame, src: "https://booking.example/checkout" }, parent, official, parent, proof)).toBeUndefined();
  });
  it("bounds candidate parent URLs without discarding original verified source authority", () => {
    const value = prepare();
    for (let index = 0; index < 100; index++) {
      const url = `https://provider${index}.example/`; value.observeOfficialLink(bare, url, "Book tee times"); value.observeDocument({ url, status: 200 });
    }
    expect(value.authorizeParent("https://provider99.example/", visible)).toBeUndefined();
    expect(value.authorizeParent(bare)).toBeDefined();
  });
});
