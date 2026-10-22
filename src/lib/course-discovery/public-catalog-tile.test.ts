import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicCatalogTileScope, inspectPublicCatalogTileElement } from "./public-catalog-tile";

const entry = "https://example.reservewithrex.com/package?venue=Example&date=2026-10-23&guests=1";
const api = "https://example.reservewithrex.com/api/venue/get";
const venueId = "11111111-2222-3333-4444-555555555555", packageId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const item = () => ({ id: packageId, name: "Golf Simulator", contactOnly: false, isMemberOnlyPackage: false, status: true, isHidden: false, numberOfLanes: 1 });
const data = () => ({ id: venueId, name: "Example", packages: [item()] });
const request = () => ({ venueId, date: "2026-10-23", guests: 1 });
const html = () => '<div class="package-list-v2-gap"><article id="rental" class="package-card-v2 package-card-v2--package"><div class="package-card-v2-inside" data-testid="package-cards"><p class="package-card__title-v2">Golf Simulator</p><p>1–8 Guests</p><p>1–5 Hours</p><div class="package-card__actions-right"><button><svg></svg></button></div></div></article></div>';
function setup(value: unknown = data(), body: unknown = request()) {
  const scope = createPublicCatalogTileScope();
  const doc = scope.beginDocument(entry); scope.completeDocument(doc, 200, "text/html; charset=utf-8");
  const read = scope.beginRead(api, "POST", JSON.stringify(body), entry);
  scope.completeRead(read, 200, "application/json", Buffer.from(JSON.stringify(value)));
  return scope;
}
function inspect(markup = html(), scope = setup()) {
  // jsdom has no layout-derived innerText paragraph separators.
  document.body.innerHTML = markup.replace(/></gu, "> <");
  return inspectPublicCatalogTileElement(document.querySelector("#rental")!, scope.context(entry));
}

describe("fresh private public catalog facts", () => {
  it("projects only a fresh successful document and matching exact anonymous catalog", () => {
    const scope = setup({ ...data(), paymentKey: "private-sentinel", session: "private-sentinel" });
    expect(scope.context(entry)?.items).toEqual([{ id: packageId, name: "Golf Simulator", eligible: true }]);
    expect(JSON.stringify(scope.context(entry))).not.toContain("private-sentinel");
    expect(scope.context(entry.replace("2026-10-23", "2026-10-24"))).toBeUndefined();
    expect(scope.context(entry.replace("venue=Example", "venue=Foreign"))).toBeUndefined();
  });
  it.each(["contactOnly", "isMemberOnlyPackage", "isHidden"] as const)("never treats missing/redacted/true %s as a public tile", field => {
    for (const value of [undefined, "[redacted]", true]) {
      const row: Record<string, unknown> = { ...item(), [field]: value };
      expect(setup({ ...data(), packages: [row] }).context(entry)?.items[0].eligible).toBe(false);
    }
  });
  it.each(["Golf Lessons", "Members Golf Simulator", "Golf Party", "Golf Tournament", "Bowling", "Whole Venue Rental"])("does not admit other catalog product %s", name => {
    expect(setup({ ...data(), packages: [{ ...item(), name }] }).context(entry)?.items[0].eligible).toBe(false);
  });
  it("rejects duplicate names/IDs, wrong venue binding and malformed catalogs", () => {
    for (const value of [{ ...data(), id: "999" }, { ...data(), packages: [item(), item()] },
      { ...data(), packages: [{ ...item(), id: "invalid" }] }, { ...data(), packages: [] }, { ...data(), packages: "not-array" }])
      expect(setup(value).context(entry)).toBeUndefined();
  });
  it("retires stale document/read completions and failed or partial refreshes", () => {
    const scope = setup();
    const old = scope.beginRead(api, "POST", JSON.stringify(request()), entry);
    expect(scope.context(entry)).toBeUndefined();
    const next = scope.beginDocument(entry); scope.completeDocument(next, 200, "text/html");
    scope.completeRead(old, 200, "application/json", Buffer.from(JSON.stringify(data())));
    expect(scope.context(entry)).toBeUndefined();
    for (const [status, type] of [[403, "application/json"], [200, "text/html"]] as const) {
      const read = scope.beginRead(api, "POST", JSON.stringify(request()), entry);
      scope.completeRead(read, status, type, Buffer.from(JSON.stringify(data())));
      expect(scope.context(entry)).toBeUndefined();
    }
    scope.checkDocument("https://example.reservewithrex.com/account");
    scope.checkDocument(entry);
    expect(scope.context(entry)).toBeUndefined();
  });
  it("does not let a late successful old response replace a newer failed refresh", () => {
    const scope = setup();
    const old = scope.beginRead(api, "POST", JSON.stringify(request()), entry);
    const next = scope.beginRead(api, "POST", JSON.stringify(request()), entry);
    scope.completeRead(next, 500, "application/json", Buffer.from(JSON.stringify(data())));
    scope.completeRead(old, 200, "application/json", Buffer.from(JSON.stringify(data())));
    expect(scope.context(entry)).toBeUndefined();
  });
  it("requires actual HTML200 document completion rather than a request URL alone", () => {
    for (const [status, contentType] of [[403, "text/html"], [200, "application/json"]] as const) {
      const scope = createPublicCatalogTileScope();
      const token = scope.beginDocument(entry); scope.completeDocument(token, status, contentType);
      const read = scope.beginRead(api, "POST", JSON.stringify(request()), entry);
      scope.completeRead(read, 200, "application/json", Buffer.from(JSON.stringify(data())));
      expect(scope.context(entry)).toBeUndefined();
    }
  });
  it.each(["https://foreign.reservewithrex.com/api/venue/get", "https://user:private@example.reservewithrex.com/api/venue/get",
    "https://example.reservewithrex.com/api/reservation", `${api}?private=1`])("never treats another endpoint as a catalog (%s)", url => {
    const scope = createPublicCatalogTileScope();
    const token = scope.beginDocument(entry); scope.completeDocument(token, 200, "text/html");
    expect(scope.beginRead(url, "POST", JSON.stringify(request()), entry)).toBeUndefined();
    expect(scope.context(entry)).toBeUndefined();
  });
  it.each(["http://example.reservewithrex.com/package", "https://reservewithrex.com/package", "https://sub.example.reservewithrex.com/package",
    "https://example.reservewithrex.com/package?token=private", "https://example.reservewithrex.com/package#private", "https://user:private@example.reservewithrex.com/package"])
  ("does not mint a document for %s", url => { const scope = createPublicCatalogTileScope(); expect(scope.beginDocument(url)).toBeUndefined(); });
  it("requires fresh selected package-ID response and actual URL readback, rather than a changed title alone", () => {
    const scope = setup(), proof = { name: "Golf Simulator", packageId, revision: scope.context(entry)!.revision };
    const selectedUrl = `${entry}&currentPackage=Golf%20Simulator`;
    expect(scope.selected(selectedUrl, proof)).toBe(false);
    let read = scope.beginRead(api.replace("/get", "/get-venue-with-package"), "POST", JSON.stringify(request()), entry);
    scope.completeRead(read, 200, "application/json", Buffer.from(JSON.stringify(data())));
    expect(scope.selected(selectedUrl, proof)).toBe(false);
    read = scope.beginRead(api.replace("/get", "/get-venue-with-package"), "POST", JSON.stringify({ ...request(), packageId }), entry);
    scope.completeRead(read, 200, "application/json", Buffer.from(JSON.stringify(data())));
    expect(scope.selected(selectedUrl, proof)).toBe(true);
    expect(scope.selected(`${entry}&currentPackage=Foreign`, proof)).toBe(false);
  });
});

describe("bounded visible whole-rental catalog tile", () => {
  beforeEach(() => vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 200, height: 120,
    top: 0, left: 0, right: 200, bottom: 120, toJSON: () => ({}) }));
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  it("recognizes the actual nonsemantic article while retaining only title/ID/revision internally", () => {
    expect(inspect()).toMatchObject({ name: "Golf Simulator", packageId });
  });
  it("requires the actual fresh catalog rather than page-supplied claims", () => {
    const scope = createPublicCatalogTileScope();
    expect(inspect(html().replace('<article ', '<article data-public="true" '), scope)).toBeUndefined();
  });
  it.each([
    (text: string) => `<form>${text}<input type="email"></form>`,
    (text: string) => text.replace('id="rental"', 'id="rental" hidden'),
    (text: string) => text.replace('package-list-v2-gap', 'unrelated-cards'),
    (text: string) => text.replace('data-testid="package-cards"', 'data-testid="other"'),
    (text: string) => text.replace('</article>', '<button>Continue</button></article>'),
    (text: string) => text.replace('</article>', '<button>10:30 AM</button></article>'),
    (text: string) => text.replace('</article>', '<select><option>60 minutes</option></select></article>'),
    (text: string) => text.replace('</article>', '<a href="/checkout">Select</a></article>'),
    (text: string) => text.replace('1–5 Hours', 'Golf Lessons'),
    (text: string) => `<section aria-label="Checkout">${text}</section>`,
    (text: string) => text.replace('<article ', '<div ').replace('</article>', '</div>'),
    (text: string) => text.replace('</article>', '</article><article><p class="package-card__title-v2">Golf Simulator</p></article>'),
  ])("denies malformed, mixed, hidden or transactional tile (%#)", change => { expect(inspect(change(html()))).toBeUndefined(); });
});
