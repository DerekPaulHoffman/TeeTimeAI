// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CHRONOGOLF_READ_CLIENTS, chronogolfAvailabilityPageSchema, chronogolfMetadataSchema, chronogolfRecipeBookingUrl, isChronogolfRecipeSlotLink,
  normalizeChronogolfProfileUrl, parseChronogolfPagination, parseChronogolfProfile, parseChronogolfSource, parseChronogolfPublicWidget, verifyChronogolfReadClients, chronogolfOfficialHostMismatch } from "./chronogolf-source";

import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const reviewedBodies = vi.hoisted(() => ["reviewed-1710-fixture", "reviewed-1805-fixture"]);
vi.mock("node:crypto", async importOriginal => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const pins = ["3d7f020bc8c0a795d8132b1951cc2be2c50ada2983458c9aa98df02e5631b340", "78bb211875897af6f24bbec9f39600786543482678d32d7dedc0335ccacaae78"];
  return { ...actual, createHash: (algorithm: string) => { let content = ""; return {
    update(value: string) { content += value; return this; }, digest(encoding: "hex") { const index = reviewedBodies.indexOf(content); return index >= 0 ? pins[index] : actual.createHash(algorithm).update(content).digest(encoding); },
  }; } };
});
const source = { officialUrl: "https://www.example.org/", bookingUrl: "https://www.chronogolf.com/club/example-golf-club",
  venueName: "Example Golf Club", venueAddress: "100 Fairway Blvd, Example City, WA 98275, USA", timeZone: "America/Los_Angeles" };
function club() { return { id: 1234, uuid: "b7535637-0f08-4298-acd1-f2b0692dc48f", name: source.venueName, slug: "example-golf-club", active: true, state: "published",
  website: source.officialUrl, address: "100 Fairway Boulevard", city: "Example City", province: "Washington", postcode: "98275", country: "United States",
  timezone: source.timeZone, defaultAffiliationTypeId: 56, features: { onlineBookingEnabled: true },
  courses: [{ id: 5678, uuid: "0bae7da1-b55e-4203-ac78-92b750f9c2d0", name: "Example North", holes: 18, bookableHoles: [9, 18] }] }; }
function html(value: unknown = club()) { return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { club: value } } })}</script>` +
  CHRONOGOLF_READ_CLIENTS.map(client => `<script src="${client.url}"></script>`).join(""); }
function row() { return { id: 517122664, uuid: "fecd4d39-bb67-478f-91fc-a0523a864491", course: { id: 5678, uuid: club().courses[0].uuid,
  name: "Example North", holes: 18, bookable_holes: [9, 18] }, hole: 1, has_cart: false, min_player_size: 2, max_player_size: 4,
  starts_at: "2026-10-23T18:57:00Z", start_time: "11:57", date: "2026-10-23", event_id: null, has_deal: false,
  default_price: { green_fee: 43, half_cart: 15, one_person_cart: null, player_type_id: 56, subtotal: 43, bookable_holes: 9, affiliation_type: "Public*" },
  departure: null, format: "normal", frozen: false }; }

describe("canonical public profile sources", () => {
  const widget = "https://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile";
  it("normalizes www/trailing slash only and preserves proven numeric source identity", () => {
    expect(normalizeChronogolfProfileUrl("https://chronogolf.com/club/example-golf-club/")).toBe(source.bookingUrl);
    expect(parseChronogolfSource("https://www.chronogolf.com/club/1234")).toEqual({ profileUrl: "https://www.chronogolf.com/club/1234", slug: "1234", numericClubId: 1234 });
  });
  it.each(["http://www.chronogolf.com/club/example", "https://members.chronogolf.com/club/example", "https://www.chronogolf.com.evil.org/club/example",
    "https://www.chronogolf.com/club/example/widget", "https://user:pass@www.chronogolf.com/club/example", "https://www.chronogolf.com:8443/club/example",
    "https://www.chronogolf.com/club/example?date=2026-10-23", "https://www.chronogolf.com/club/example#login", "https://www.chronogolf.com/club/%65xample"])("rejects noncanonical %s", value =>
    expect(normalizeChronogolfProfileUrl(value)).toBeNull());
  it("derives only the same numeric public profile from an exact observed widget and retains provenance", () => {
    expect(parseChronogolfPublicWidget(widget)).toEqual({ widgetUrl: widget, profileUrl: "https://www.chronogolf.com/club/1234", numericClubId: 1234 });
    expect(parseChronogolfSource(widget)).toEqual({ widgetUrl: widget, profileUrl: "https://www.chronogolf.com/club/1234", slug: "1234", numericClubId: 1234 });
    expect(normalizeChronogolfProfileUrl(widget)).toBeNull();
    const observed = parseChronogolfProfile(html(), source.bookingUrl, { ...source, bookingUrl: widget });
    expect(observed.widgetSourceUrl).toBe(widget);
    expect(chronogolfRecipeBookingUrl(widget, observed, "2026-10-23")).toBe(`${source.bookingUrl}?date=2026-10-23&step=teetimes`);
    expect(() => chronogolfRecipeBookingUrl(source.bookingUrl, observed, "2026-10-23")).toThrow("ADAPTER_SLOT_LINK_UNVERIFIED");
    expect(() => parseChronogolfProfile(html(), widget, { ...source, bookingUrl: widget })).toThrow("ADAPTER_IDENTITY_MISSING");
  });
  it.each([
    "http://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile",
    "https://chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile",
    "https://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile&account=1",
    "https://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile&medium=profile",
    "https://www.chronogolf.com/club/1234/widget?source=chronogolf&medium=profile&target=_blank",
    "https://www.chronogolf.com/club/1234/widget?target=_self&source=chronogolf&medium=profile",
    "https://www.chronogolf.com/club/1234/widget?target=_blank&source=other&medium=profile",
    "https://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=booking",
    "https://www.chronogolf.com/club/example/widget?target=_blank&source=chronogolf&medium=profile",
    "https://www.chronogolf.com/club/2147483648/widget?target=_blank&source=chronogolf&medium=profile",
    "https://www.chronogolf.com/club/1234/widget?target=_blank&source=chronogolf&medium=profile#x",
  ])("rejects non-public or changed widget source %s", value => {
    expect(parseChronogolfPublicWidget(value)).toBeNull();
    expect(parseChronogolfSource(value)).toBeNull();
  });
});
describe("fresh exact profile identity and complete UUID catalog", () => {
  it("binds identity, timezone, every course UUID and distinct sale-round options", () => {
    const parsed = parseChronogolfProfile(html(), source.bookingUrl, source);
    expect(parsed).toMatchObject({ family: "CHRONOGOLF", clubId: 1234, profileUrl: source.bookingUrl, timeZone: source.timeZone,
      publicPlayerTypeId: 56, courses: [{ id: 5678, uuid: club().courses[0].uuid, layoutHoles: 18, bookableHoles: [9, 18] }] });
    expect(chronogolfMetadataSchema.safeParse({ ...parsed, cookie: "never" }).success).toBe(false);
  });
  it("matches a complete Way address and retains every physical identity component", () => {
    const identity = { ...source, venueAddress: "14330 SE Husky Way, Auburn, WA 98092, USA" };
    const value = { ...club(), address: "14330 Southeast Husky Way", city: "Auburn", postcode: "98092" };
    expect(parseChronogolfProfile(html(value), source.bookingUrl, identity).clubId).toBe(value.id);
    for (const changed of [{ address: "14331 Southeast Husky Way" }, { address: "14330 Southwest Husky Way" },
      { address: "14330 Southeast Other Way" }, { city: "Kent" }, { postcode: "98091" }, { province: "Oregon" }])
      expect(() => parseChronogolfProfile(html({ ...value, ...changed }), source.bookingUrl, identity)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["http://www.example.org", "http://example.org/", "https://example.org/"])
    ("normalizes provider website %s as exact host identity only", website => {
      const baseline = parseChronogolfProfile(html(), source.bookingUrl, source);
      const value = club(); value.website = website;
      expect(parseChronogolfProfile(html(value), source.bookingUrl, source)).toEqual(baseline);
      expect(source.officialUrl).toBe("https://www.example.org/");
    });
  it.each(["http://unrelated.example.org/", "http://example.org.evil.org/", "http://other.example.org/", "http://user:pass@www.example.org/",
    "http://www.example.org:80/", "http://www.example.org:8443/", "https://www.example.org:443/", "http://www.example.org/?token=1", "http://www.example.org/#login",
    "ftp://www.example.org/", "javascript:alert(1)", "http://localhost/", "http://127.0.0.1/", "http://www.exa\tmple.org/"])
    ("rejects unsafe or different provider website identity %s", website => {
      const value = club(); value.website = website;
      expect(() => parseChronogolfProfile(html(value), source.bookingUrl, source)).toThrow();
    });
  it("retains HTTPS canonical source and full venue identity requirements with a provider HTTP spelling", () => {
    const value = club(); value.website = "http://www.example.org";
    expect(() => parseChronogolfProfile(html(value), source.bookingUrl, { ...source, officialUrl: "http://www.example.org/" })).toThrow("ADAPTER_IDENTITY_MISSING");
    for (const changed of [{ ...value, name: "Other Example Golf Club" }, { ...value, address: "2100 Fairway Boulevard" }, { ...value, timezone: "America/New_York" }])
      expect(() => parseChronogolfProfile(html(changed), source.bookingUrl, source)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it("binds observed numeric-to-slug mapping without accepting another source alias", () => {
    expect(parseChronogolfProfile(html(), source.bookingUrl, { ...source, bookingUrl: "https://www.chronogolf.com/club/1234" }).clubId).toBe(1234);
    expect(parseChronogolfProfile(html(), "https://www.chronogolf.com/club/1234", { ...source, bookingUrl: "https://www.chronogolf.com/club/1234" }).profileUrl).toBe(source.bookingUrl);
    expect(() => parseChronogolfProfile(html(), source.bookingUrl, { ...source, bookingUrl: "https://www.chronogolf.com/club/1235" })).toThrow();
    expect(() => parseChronogolfProfile(html(), source.bookingUrl, { ...source, bookingUrl: "https://www.chronogolf.com/club/another-golf-club" })).toThrow();
  });
  it.each(["name", "number", "city", "postal", "region", "country", "website", "timezone", "inactive", "unpublished", "no public booking"])("rejects mismatched %s", field => {
    const value = club();
    if (field === "name") value.name = "Another Example Golf Club";
    if (field === "number") value.address = "2100 Fairway Boulevard";
    if (field === "city") value.city = "Another City";
    if (field === "postal") value.postcode = "98276";
    if (field === "region") value.province = "Oregon";
    if (field === "country") value.country = "Canada";
    if (field === "website") value.website = "https://unrelated.example.org/";
    if (field === "timezone") value.timezone = "America/New_York";
    if (field === "inactive") value.active = false;
    if (field === "unpublished") value.state = "draft";
    if (field === "no public booking") value.features.onlineBookingEnabled = false;
    expect(() => parseChronogolfProfile(html(value), source.bookingUrl, source)).toThrow();
  });
  it.each(["empty", "missing UUID", "duplicate numeric ID", "duplicate UUID", "bad round options"])("rejects incomplete catalog %s", field => {
    const value = club();
    if (field === "empty") value.courses = [];
    if (field === "missing UUID") Object.assign(value.courses[0], { uuid: undefined });
    if (field === "duplicate numeric ID") value.courses.push({ ...value.courses[0], uuid: "7657db51-4e0c-4bc7-8e98-bd0a705370af" });
    if (field === "duplicate UUID") value.courses.push({ ...value.courses[0], id: 5679 });
    if (field === "bad round options") value.courses[0].bookableHoles = [9, 9];
    expect(() => parseChronogolfProfile(html(value), source.bookingUrl, source)).toThrow();
  });
  it("sorts full catalog deterministically and changes metadata when a course changes", () => {
    const value = club(), baseline = parseChronogolfProfile(html(value), source.bookingUrl, source);
    value.courses.push({ ...value.courses[0], id: 5679, uuid: "7657db51-4e0c-4bc7-8e98-bd0a705370af", name: "Example South" });
    const expanded = parseChronogolfProfile(html(value), source.bookingUrl, source); expect(expanded.catalogHash).not.toBe(baseline.catalogHash);
    value.courses.reverse(); value.courses[0].bookableHoles.reverse(); expect(parseChronogolfProfile(html(value), source.bookingUrl, source)).toEqual(expanded);
  });
  it("requires one actual inert Next JSON bootstrap, not arbitrary executable source", () => {
    expect(() => parseChronogolfProfile(html().replace('type="application/json"', 'type="text/javascript"'), source.bookingUrl, source)).toThrow();
    expect(() => parseChronogolfProfile(html() + html(), source.bookingUrl, source)).toThrow();
    expect(() => parseChronogolfProfile('<script id="__NEXT_DATA__" type="application/json">sideEffect()</script>', source.bookingUrl, source)).toThrow();
  });
});
describe("canonical US postal serialization and exact public business suffix", () => {
  const identity = { ...source, venueName: "Exampleton", venueAddress: "100 Fairway Blvd, Example City, MA 01234, USA", timeZone: "America/New_York" };
  const trusted = { canonicalCoursePhone: "+14135550100" };
  function published() { return { ...club(), name: "Exampleton Golf Links", province: "Massachusetts", postcode: "1234", timezone: identity.timeZone,
    phone: "(413) 555-0100", courses: [{ ...club().courses[0], name: "Exampleton Golf Links" }] }; }
  const parsePublished = (value = published(), context: { canonicalCoursePhone?: string } | undefined = trusted, canonical = identity) =>
    parseChronogolfProfile(html(value), source.bookingUrl, canonical, undefined, context);

  it("corroborates both serializer differences without replacing the canonical source", () => {
    const actual = parsePublished();
    expect(actual.courses[0].name).toBe("Exampleton Golf Links");
    expect(identity.venueName).toBe("Exampleton");
    expect(parsePublished({ ...published(), postcode: "01234" })).toEqual(actual);
    expect(actual.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("retains exact-name legacy acceptance without a phone requirement", () => {
    const value = published();value.name = identity.venueName;Object.assign(value, { phone: undefined });
    expect(() => parsePublished(value, {})).not.toThrow();
  });
  it.each(["missing", "wrong", "noncanonical", "extension", "provider-missing"])("rejects %s phone corroboration", mode => {
    const value = published();
    let context: { canonicalCoursePhone?: string } = trusted;
    if (mode === "missing") context = {};
    if (mode === "wrong") context = { canonicalCoursePhone: "+14135550101" };
    if (mode === "noncanonical") context = { canonicalCoursePhone: "4135550100" };
    if (mode === "extension") value.phone = "(413) 555-0100 ext 1";
    if (mode === "provider-missing") Object.assign(value, { phone: undefined });
    expect(() => parsePublished(value, context)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["nearby-name", "longer-suffix", "short-brand", "generic-brand", "different-course", "multiple-courses", "foreign-host", "non-US", "wrong-street", "partial-address", "wrong-city", "wrong-state", "wrong-timezone"])
    ("keeps %s identity closed", mode => {
      const value = published(); let canonical = identity;
      if (mode === "nearby-name") value.name = "Other Exampleton Golf Links";
      if (mode === "longer-suffix") value.name = "Exampleton Golf Links Resort";
      if (mode === "short-brand") { canonical = { ...identity, venueName: "Short" }; value.name = "Short Golf Links"; value.courses[0].name = value.name; }
      if (mode === "generic-brand") { canonical = { ...identity, venueName: "The Golf Course" }; value.name = "The Golf Course Golf Links"; value.courses[0].name = value.name; }
      if (mode === "different-course") value.courses[0].name = "Exampleton South";
      if (mode === "multiple-courses") value.courses.push({ ...value.courses[0], id: 5679, uuid: "7657db51-4e0c-4bc7-8e98-bd0a705370af" });
      if (mode === "foreign-host") value.website = "https://other.example.org/";
      if (mode === "non-US") value.country = "Canada";
      if (mode === "wrong-street") value.address = "101 Fairway Boulevard";
      if (mode === "partial-address") value.address = "Fairway Boulevard";
      if (mode === "wrong-city") value.city = "Other City";
      if (mode === "wrong-state") value.province = "New York";
      if (mode === "wrong-timezone") value.timezone = "America/Chicago";
      expect(() => parsePublished(value, trusted, canonical)).toThrow();
    });
  it.each(["wrong-four-digits", "three-digits", "numeric", "zip-extension-missing", "canonical-no-leading-zero"])("does not guess %s postal identity", mode => {
    const value = published(); let canonical = identity;
    if (mode === "wrong-four-digits") value.postcode = "1235";
    if (mode === "three-digits") value.postcode = "234";
    if (mode === "numeric") Object.assign(value, { postcode: 1234 });
    if (mode === "zip-extension-missing") canonical = { ...identity, venueAddress: identity.venueAddress.replace("01234", "01234-5678") };
    if (mode === "canonical-no-leading-zero") canonical = { ...identity, venueAddress: identity.venueAddress.replace("01234", "11234") };
    expect(() => parsePublished(value, trusted, canonical)).toThrow();
  });
  it("binds the corroborating private phone semantically and keeps its value out of metadata", () => {
    const first = parsePublished(), changed = parsePublished({ ...published(), phone: "(413) 555-0101" }, { canonicalCoursePhone: "+14135550101" });
    expect(changed.catalogHash).not.toBe(first.catalogHash);
    expect(JSON.stringify(first)).not.toContain("4135550100");
    expect(JSON.stringify(first)).not.toContain("(413)");
  });
});

describe("reviewed full-hole-union client version witness", () => {
  it("requires both actual referenced URLs and exact reviewed bytes", () => {
    const parsed = parseChronogolfProfile(html(), source.bookingUrl, source), bodies = Object.fromEntries(CHRONOGOLF_READ_CLIENTS.map((client, index) => [client.url, reviewedBodies[index]]));
    expect(() => verifyChronogolfReadClients(parsed, bodies)).not.toThrow();
    expect(() => verifyChronogolfReadClients(parsed, { ...bodies, [parsed.clients[0].url]: `${reviewedBodies[0]} ` })).toThrow("ADAPTER_CLIENT_UNSUPPORTED");
    expect(() => verifyChronogolfReadClients(parsed, {})).toThrow();
  });
  it("rejects missing/duplicated/replaced script references", () => {
    expect(() => parseChronogolfProfile(html().replace(CHRONOGOLF_READ_CLIENTS[0].url, "https://evil.example.org/script.js"), source.bookingUrl, source)).toThrow();
    expect(() => parseChronogolfProfile(html() + `<script src="${CHRONOGOLF_READ_CLIENTS[0].url}"></script>`, source.bookingUrl, source)).toThrow();
    expect(() => parseChronogolfProfile(html().replace("1710-f188e4d712d51c74.js", "1710-newversion.js"), source.bookingUrl, source)).toThrow();
  });
});
describe("explicit current availability/page contract", () => {
  it.each([["8:30", "08:30"], ["9:33", "09:33"], ["0:00", "00:00"], ["08:30", "08:30"], ["23:59", "23:59"]])
    ("normalizes public clock %s before UTC/local and window checks", (start_time, expected) => {
      const parsed = chronogolfAvailabilityPageSchema.parse({ status: "open", teetimes: [{ ...row(), start_time }] });
      expect(parsed.teetimes[0].start_time).toBe(expected);
    });
  it.each(["24:00", "8:60", "8:3", "8:30:00", " 8:30", "8:30 ", "008:30", "-1:30", "8:30 AM"])
    ("rejects unsupported public clock %s", start_time => {
      expect(chronogolfAvailabilityPageSchema.safeParse({ status: "open", teetimes: [{ ...row(), start_time }] }).success).toBe(false);
    });
  it("preserves actual default9 and published9/18 as different fields", () => {
    const parsed = chronogolfAvailabilityPageSchema.parse({ status: "open", teetimes: [row()] });
    expect(parsed.teetimes[0].default_price.bookable_holes).toBe(9); expect(parsed.teetimes[0].course.bookable_holes).toEqual([9, 18]);
  });
  it.each(["missing rows", "partial row", "bad date", "bad time", "event", "special format", "invalid capacity", "unknown restriction"])("rejects %s", field => {
    const value: Record<string, unknown> = { status: "open", teetimes: [row()] }, slot = (value.teetimes as Record<string, unknown>[])[0];
    if (field === "missing rows") delete value.teetimes;
    if (field === "partial row") delete slot.course;
    if (field === "bad date") slot.date = "2026-02-30";
    if (field === "bad time") slot.start_time = "27:00";
    if (field === "event") slot.event_id = 1;
    if (field === "special format") slot.format = "event";
    if (field === "invalid capacity") slot.min_player_size = 5;
    if (field === "unknown restriction") slot.member_only = true;
    expect(chronogolfAvailabilityPageSchema.safeParse(value).success).toBe(false);
  });
  it("permits explicit sold_out only with no rows", () => {
    expect(chronogolfAvailabilityPageSchema.safeParse({ status: "sold_out", teetimes: [] }).success).toBe(true);
    expect(chronogolfAvailabilityPageSchema.safeParse({ status: "sold_out", teetimes: [row()] }).success).toBe(false);
  });
  it("requires real bounded pagination headers including empty responses", () => {
    expect(parseChronogolfPagination(new Headers({ total: "40", "per-page": "24" }))).toEqual({ total: 40, perPage: 24 });
    expect(parseChronogolfPagination(new Headers({ total: "0", "per-page": "24" }))).toEqual({ total: 0, perPage: 24 });
    const invalid: Record<string, string>[] = [{}, { total: "40" }, { total: "-1", "per-page": "24" }, { total: "1", "per-page": "0" }, { total: "10000", "per-page": "24" }, { total: "1", "per-page": "24, 24" }];
    for (const headers of invalid)
      expect(() => parseChronogolfPagination(new Headers(headers))).toThrow("ADAPTER_PAGINATION_UNVERIFIED");
  });
});

describe("typed canonical dated booking links", () => {
  const requestedDate = "2026-10-23", numeric = "https://chronogolf.com/club/1234";
  function metadata() { return parseChronogolfProfile(html(), source.bookingUrl, source); }
  function slot() { return { sourceId: `chronogolf-${row().uuid}`, resourceId: `chronogolf-course:${club().courses[0].uuid}`,
    bookingUrl: `${source.bookingUrl}?date=${requestedDate}&step=teetimes` }; }
  it("accepts the exact canonical date link from observed numeric/nonwww or matching slug source", () => {
    const saved = metadata();
    expect(chronogolfRecipeBookingUrl(numeric, saved, requestedDate)).toBe(slot().bookingUrl);
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, slot())).toBe(true);
    expect(isChronogolfRecipeSlotLink(source.bookingUrl, saved, requestedDate, slot())).toBe(true);
    expect(isChronogolfRecipeSlotLink(numeric, saved,requestedDate, { ...slot(), holes: 9 })).toBe(false);
  });
  it("builds a changed-date link from the same immutable metadata only", () => {
    const saved = metadata(), serialized = JSON.stringify(saved), changed = "2026-10-24";
    const url = chronogolfRecipeBookingUrl(numeric, saved, changed);
    expect(url).toBe(`${source.bookingUrl}?date=${changed}&step=teetimes`);
    expect(isChronogolfRecipeSlotLink(numeric, saved, changed, { ...slot(), bookingUrl: url })).toBe(true);
    expect(JSON.stringify(saved)).toBe(serialized);
  });
  it.each(["https://chronogolf.com/club/1235", "https://www.chronogolf.com/club/another-club", "https://evil.chronogolf.com/club/1234",
    "https://chronogolf.com/club/1234?date=2026-10-23", "https://user:pass@chronogolf.com/club/1234"])("rejects unmatched source %s", value =>
    expect(isChronogolfRecipeSlotLink(value, metadata(), requestedDate, slot())).toBe(false));
  it.each(["&slot_id=1", "&players=2", "&holes=18", "#login", "&date=2026-10-24"])("rejects extra link state %s", extra =>
    expect(isChronogolfRecipeSlotLink(numeric, metadata(), requestedDate, { ...slot(), bookingUrl: slot().bookingUrl + extra })).toBe(false));
  it("rejects other origins/aliases, wrong dates, and missing or malformed persisted metadata", () => {
    const saved = metadata();
    for (const bookingUrl of [slot().bookingUrl.replace("www.chronogolf.com", "chronogolf.com"), slot().bookingUrl.replace("example-golf-club", "another-club"),
      slot().bookingUrl.replace(requestedDate, "2026-10-24"), slot().bookingUrl.replace("https://", "http://")])
      expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), bookingUrl })).toBe(false);
    for (const invalid of [null, {}, { ...saved, family: "FOREUP" }, { ...saved, clients: [] }]) expect(isChronogolfRecipeSlotLink(numeric, invalid, requestedDate, slot())).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, saved, "2026-02-30", slot())).toBe(false);
  });
  it("requires legacy source UUID plus catalog resource UUID and never infers round length", () => {
    const saved = metadata();
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), sourceId: "chronogolf-not-a-uuid" })).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), sourceId: row().uuid })).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), resourceId: undefined })).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), resourceId: "chronogolf-course:7657db51-4e0c-4bc7-8e98-bd0a705370af" })).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, saved, requestedDate, { ...slot(), holes: 18 })).toBe(false);
    const onlyNine = { ...saved, courses: saved.courses.map(course => ({ ...course, bookableHoles: [9 as const] })) };
    expect(isChronogolfRecipeSlotLink(numeric, onlyNine, requestedDate, { ...slot(), holes: 18 })).toBe(false);
    expect(isChronogolfRecipeSlotLink(numeric, onlyNine, requestedDate, slot())).toBe(true);
  });
});

describe("fresh canonical root corroborates only a stale provider website host", () => {
  function official(mutate?: (page: OfficialIdentityPage) => void) {
    const page: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME",
      html: `<html><head><title>${source.venueName}</title></head><body><h1>${source.venueName}</h1><address>${source.venueAddress}</address><a href="${source.bookingUrl}">Book Tee Times</a></body></html>`,
      visibleEvidence: { title: source.venueName, headings: [source.venueName], addressTexts: [source.venueAddress], linkUrls: [source.bookingUrl] } };
    mutate?.(page);
    return registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30000));
  }
  const outdated = () => ({ ...club(), website: "http://old-public-club.example.net/" });
  it("requires a live native full-identity and exact profile edge, without rewriting either website", () => {
    const value = outdated(), page = official();
    expect(parseChronogolfProfile(html(value), source.bookingUrl, source, page)).toMatchObject({ family: "CHRONOGOLF", clubId: value.id, profileUrl: source.bookingUrl });
    expect(value.website).toBe("http://old-public-club.example.net/"); expect(source.officialUrl).toBe("https://www.example.org/");
    expect(parseChronogolfProfile(html(), source.bookingUrl, source)).toEqual(parseChronogolfProfile(html(), source.bookingUrl, source, page));
  });
  it("brands only an otherwise fully matching profile host mismatch, never error text or another failed predicate", () => {
    const error = (value: ReturnType<typeof club>) => { try { parseChronogolfProfile(html(value), source.bookingUrl, source); } catch (e) { return e; } };
    expect(chronogolfOfficialHostMismatch(error(outdated()))).toBe(true);
    expect(chronogolfOfficialHostMismatch(new Error("ADAPTER_IDENTITY_MISMATCH"))).toBe(false);
    for (const change of [{ name: "Another Golf Club" }, { address: "101 Fairway Boulevard" }, { city: "Another City" },
      { postcode: "98276" }, { province: "Oregon" }, { country: "Canada" }, { timezone: "America/New_York" }, { id: 99, slug: "other-club" }, { website: "http://user:pass@example.org/" }]) {
      const value = { ...outdated(), ...change };
      expect(() => parseChronogolfProfile(html(value), source.bookingUrl, source, official())).toThrow("ADAPTER_IDENTITY_MISMATCH");
      expect(chronogolfOfficialHostMismatch(error(value))).toBe(false);
    }
  });
  it.each(["copy", "stale", "mutated", "unattested", "wrong-root"])("rejects %s official-page authority", mode => {
    let page = official();
    if (mode === "copy") page = structuredClone(page);
    if (mode === "mutated") page.html += " ";
    if (mode === "unattested") page = { ...page };
    if (mode === "wrong-root") page = official(p => { p.url = "https://other.example.org/"; });
    if (mode === "stale") {
      const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31000);
      try { expect(() => parseChronogolfProfile(html(outdated()), source.bookingUrl, source, page)).toThrow("ADAPTER_IDENTITY_MISMATCH"); }
      finally { now.mockRestore(); }
    } else expect(() => parseChronogolfProfile(html(outdated()), source.bookingUrl, source, page)).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
  it.each(["hidden-link", "form-link", "missing-link", "other-club", "two-clubs", "wrong-raw-name", "wrong-rendered-name", "wrong-raw-address", "wrong-rendered-address", "conflicting-h1"])
    ("rejects %s instead of adopting a stale website host", mode => {
      const page = official(p => {
        if (mode === "hidden-link") p.html = p.html.replace("<a ", '<a hidden ');
        if (mode === "form-link") p.html = p.html.replace("<a ", "<form><a ").replace("</a>", "</a></form>");
        if (mode === "missing-link") p.visibleEvidence!.linkUrls = [];
        if (mode === "other-club") { p.html = p.html.replaceAll(source.bookingUrl, "https://www.chronogolf.com/club/another-club"); p.visibleEvidence!.linkUrls = ["https://www.chronogolf.com/club/another-club"]; }
        if (mode === "two-clubs") p.visibleEvidence!.linkUrls.push("https://www.chronogolf.com/club/another-club");
        if (mode === "wrong-raw-name") p.html = p.html.replaceAll(source.venueName, "Another Golf Club");
        if (mode === "wrong-rendered-name") p.visibleEvidence!.headings = ["Another Golf Club"];
        if (mode === "wrong-raw-address") p.html = p.html.replace(source.venueAddress, "101 Fairway Blvd, Example City, WA 98275, USA");
        if (mode === "wrong-rendered-address") p.visibleEvidence!.addressTexts = ["101 Fairway Blvd, Example City, WA 98275, USA"];
        if (mode === "conflicting-h1") p.html = p.html.replace("</body>", "<h1>Another Golf Club</h1></body>");
      });
      expect(() => parseChronogolfProfile(html(outdated()), source.bookingUrl, source, page)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    });
  it("accepts only an actually attested initial canonical-root redirect", () => {
    const page = official(), current = "https://example.org/home";
    page.url = current;
    const fresh = registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30000),
      { requestedUrl: source.officialUrl, redirects: [{ fromUrl: source.officialUrl, toUrl: current, status: 302, completed: true }] });
    expect(parseChronogolfProfile(html(outdated()), source.bookingUrl, source, fresh).clubId).toBe(club().id);
    expect(() => parseChronogolfProfile(html(outdated()), source.bookingUrl, source, structuredClone(fresh))).toThrow("ADAPTER_IDENTITY_MISMATCH");
  });
});

describe("heading-free named canonical footer corroboration", () => {
  function footer(mutate?: (page: OfficialIdentityPage) => void) {
    const page: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME",
      html: `<html><head><title>Welcome to ${source.venueName}</title></head><body><footer><address><span class="h5">${source.venueName}</span><span>${source.venueAddress}</span></address></footer><a href="${source.bookingUrl}">Book Tee Times</a></body></html>`,
      visibleEvidence: { title: `Welcome to ${source.venueName}`, headings: [], publicBusinessLabels: [source.venueName], addressTexts: [source.venueName + ", " + source.venueAddress], linkUrls: [source.bookingUrl] } };
    mutate?.(page);return registerFreshNativeOfficialIdentityPage(page, source.officialUrl, new Date(Date.now() + 30000));
  }
  const outdated = () => html({ ...club(), website: "http://outdated-public.example.net/" });
  it("uses the actual business label and one two-scalar semantic footer without inventing a heading", () => {
    const page = footer();expect(page.visibleEvidence!.headings).toEqual([]);
    expect(parseChronogolfProfile(outdated(), source.bookingUrl, source, page).clubId).toBe(club().id);
  });
  it.each(["missing-name", "wrong-name", "wrong-raw-name", "wrong-address", "hidden", "private", "form", "outside-footer", "extra-span", "nested-control", "two-addresses", "raw-heading", "rendered-heading", "rendered-address", "postal-extension"])
    ("rejects %s in a heading-free footer rather than dropping evidence", mode => {
      const page = footer(p => {
        if (mode === "missing-name") p.visibleEvidence!.publicBusinessLabels = [];
        if (mode === "wrong-name") p.visibleEvidence!.publicBusinessLabels = ["Another Golf Club"];
        if (mode === "wrong-raw-name") p.html = p.html.replace(`<span class="h5">${source.venueName}</span>`, '<span class="h5">Another Golf Club</span>');
        if (mode === "wrong-address") p.html = p.html.replace(source.venueAddress, "101 Fairway Blvd, Example City, WA 98275, USA");
        if (mode === "hidden") p.html = p.html.replace("<footer>", '<footer class="d-none">');
        if (mode === "private") p.html = p.html.replace("<footer>", '<footer aria-label="Mailing address">');
        if (mode === "form") p.html = p.html.replace("<address>", "<form><address>").replace("</address>", "</address></form>");
        if (mode === "outside-footer") p.html = p.html.replaceAll("footer", "div");
        if (mode === "extra-span") p.html = p.html.replace("</address>", "<span>Another field</span></address>");
        if (mode === "nested-control") p.html = p.html.replace(source.venueAddress, `<input value="${source.venueAddress}">`);
        if (mode === "two-addresses") p.html = p.html.replace("</footer>", `<address><span>${source.venueName}</span><span>${source.venueAddress}</span></address></footer>`);
        if (mode === "raw-heading") p.html = p.html.replace("<body>", "<body><h1>Another Golf Club</h1>");
        if (mode === "rendered-heading") p.visibleEvidence!.headings = ["Another Golf Club"];
        if (mode === "rendered-address") p.visibleEvidence!.addressTexts = [source.venueName + ", 101 Fairway Blvd, Example City, WA 98275, USA"];
        if (mode === "postal-extension") { p.html = p.html.replaceAll("98275", "98275-1234");p.visibleEvidence!.addressTexts = [source.venueName + ", " + source.venueAddress.replace("98275", "98275-1234")]; }
      });
      expect(() => parseChronogolfProfile(outdated(), source.bookingUrl, source, page)).toThrow("ADAPTER_IDENTITY_MISMATCH");
    });
});
