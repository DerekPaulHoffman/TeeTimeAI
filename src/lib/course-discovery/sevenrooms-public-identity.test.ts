// @vitest-environment node
import { describe, expect, it } from "vitest";
import { verifySevenRoomsPublicIdentity } from "./sevenrooms-public-identity";

const source = { bookingUrl: "https://www.sevenrooms.com/reservations/examplegolf?duration-picker=true", venueName: "Example Golf & Social",
  venueAddress: "10529 Fairway Drive, Tampa, FL 33626", timeZone: "America/New_York" };
const request = { url: "https://www.sevenrooms.com/api-yoa/dining/venue_info?venue_url_key=examplegolf&widget_type=RESERVATIONS&modify_upgrades=false", method: "GET", status: 200 };
const venue = () => ({ name: "Example Golf & Social", url_key: "examplegolf", timezone: "America/New_York",
  address: "10529 Fairway Dr", city: "Tampa", state: "FL", postal_code: "33626", country: "United States", country_code: "US" });
const body = (fields: Record<string, unknown> = venue()) => ({ status: 200, data: { venue_info: fields } });
const matches = (expected: string, actual: unknown) => expected === actual;
const verify = (fields: Record<string, unknown> = venue()) => verifySevenRoomsPublicIdentity(body(fields), source, request, matches);

describe("same-container current SevenRooms public identity", () => {
  it("proves only actual current name, tenant, IANA zone and complete composed postal parts", () => {
    const actual = verify();
    expect(actual).toMatchObject({ venueName: venue().name, timeZone: venue().timezone, tenant: "examplegolf",
      canonicalAddress: { street: "10529 fairway dr", locality: "tampa", region: "FL", postalCode: "33626", country: "US" } });
    expect(actual.witnessSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(actual)).toBe(true); expect(Object.isFrozen(actual.canonicalAddress)).toBe(true);
  });
  it("accepts an independently complete flat address and conservatively normalizes only postal spelling", () => {
    const actual = verify({ name: venue().name, url_key: venue().url_key, timezone: venue().timezone,
      address: "10529 Fairway Drive, Tampa, FL 33626-1234, United States" });
    expect(actual.canonicalAddress).toEqual(verify().canonicalAddress);
    expect(verify({ ...venue(), state: "fl", country: "usa", country_code: "us" }).canonicalAddress).toEqual(actual.canonicalAddress);
    expect(verify({ ...venue(), address: "10529 Fairway Dr, Tampa, FL 33626", postal_code: " 33626 ", zip_code: "33626-1234" }).canonicalAddress).toEqual(actual.canonicalAddress);
  });
  it("uses the supplied whole-venue matcher without replacing the actual observed name", () => {
    const actual = verifySevenRoomsPublicIdentity(body({ ...venue(), name: "Example Golf and Social" }), source, request,
      (expected, observed) => expected.replace("&", "and") === observed);
    expect(actual.venueName).toBe("Example Golf and Social");
    expect(() => verifySevenRoomsPublicIdentity(body(), source, request, () => false)).toThrow("NAME_MISMATCH");
  });
  it.each(["name", "url_key", "timezone", "address", "city", "state", "postal_code"])("never fills absent actual %s from the expected source", key => {
    const actual: Record<string, unknown> = venue(); delete actual[key];
    expect(() => verify(actual)).toThrow();
  });
  it("requires actual country for split parts, but does not infer it from expected country", () => {
    const actual: Record<string, unknown> = venue(); delete actual.country; delete actual.country_code;
    expect(() => verify(actual)).toThrow("ADDRESS_UNVERIFIED");
  });
  it.each([
    { name: "Other Golf & Social" }, { url_key: "other" }, { venue_url_key: "other" }, { timezone: "America/Chicago" },
    { address: "10530 Fairway Dr" }, { city: "Orlando" }, { state: "GA" }, { postal_code: "33627" }, { country: "CA" },
    { country_code: "CA" }, { country: "" }, { address2: "Suite 5" }, { address2: null }, { address1: "Another Road" },
    { zip_code: "33627" }, { state: "Florida" }, { postal_code: "33626 bad" }, { address: "PO Box 123" },
  ])("rejects changed, ambiguous or unsupported actual identity %j", extra => {
    expect(() => verify({ ...venue(), ...extra })).toThrow();
  });
  it("does not borrow missing identity from other public/private branches or inherited properties", () => {
    const actual: Record<string, unknown> = venue(); delete actual.city;
    expect(() => verifySevenRoomsPublicIdentity({ status: 200, city: "Tampa", data: { city: "Tampa", venue_info: actual } }, source, request, matches)).toThrow();
    const inherited = Object.assign(Object.create({ city: "Tampa" }), actual);
    expect(() => verify(inherited)).toThrow();
    const value = body(); Object.defineProperty(value, "account", { get() { throw new Error("PRIVATE_BRANCH_READ"); } });
    expect(verifySevenRoomsPublicIdentity(value, source, request, matches).venueName).toBe(venue().name);
  });
  it("requires own success and identity containers rather than aliases or inherited responses", () => {
    for (const value of [{ status: 200, venue_info: venue() }, { status: 200, data: { venue: venue() } },
      Object.assign(Object.create({ status: 200 }), { data: { venue_info: venue() } }),
      { status: 200, data: Object.create({ venue_info: venue() }) },
      { status: 200, data: { venue_info: [venue()] } }])
      expect(() => verifySevenRoomsPublicIdentity(value, source, request, matches)).toThrow();
  });
  it.each([199, 201, 400, "200", null])("requires actual application status200: %s", status => {
    expect(() => verifySevenRoomsPublicIdentity({ ...body(), status }, source, request, matches)).toThrow("APPLICATION_FAILURE");
  });
  it.each([
    { status: 201 }, { method: "POST" }, { url: request.url + "&debug=true" }, { url: request.url.replace("venue_url_key=examplegolf", "venue_url_key=other") },
    { url: request.url.replace("www.sevenrooms.com", "foreign.example") }, { url: request.url.replace("/venue_info?", "/%76enue_info?") },
    { url: request.url.replace("www.sevenrooms.com", "www.sevenrooms.com:443") }, { url: request.url + "#fragment" },
  ])("requires the exact current credentialless metadata request %j", extra => {
    expect(() => verifySevenRoomsPublicIdentity(body(), source, { ...request, ...extra }, matches)).toThrow("REQUEST_UNVERIFIED");
  });
  it.each([
    { bookingUrl: source.bookingUrl + "&date=2030-10-23" }, { bookingUrl: source.bookingUrl.replace("/reservations/", "/%72eservations/") },
    { bookingUrl: source.bookingUrl.replace("www.sevenrooms.com", "www.sevenrooms.com:443") }, { bookingUrl: source.bookingUrl.replace("examplegolf", "other") },
    { bookingUrl: source.bookingUrl.replace("examplegolf", "x".repeat(129)) },
    { timeZone: "Invalid/Zone" }, { venueAddress: undefined }, { venueAddress: "Another place" },
  ])("requires canonical fixed source identity %j", extra => {
    expect(() => verifySevenRoomsPublicIdentity(body(), { ...source, ...extra }, request, matches)).toThrow();
  });
  it("rejects contradictory fields even when address independently contains a complete address", () => {
    const address = "10529 Fairway Dr, Tampa, FL 33626";
    for (const extra of [{ city: "Orlando" }, { state: "GA" }, { postal_code: "33627" }])
      expect(() => verify({ ...venue(), address, ...extra })).toThrow("ADDRESS_UNVERIFIED");
  });
  it("binds witness only to verified identity, excluding dynamic inventory/date/prices", () => {
    const first = verify(), next = verify({ ...venue(), availability: ["dynamic"], price: 200, date: "2030-10-24" });
    expect(next.witnessSha256).toBe(first.witnessSha256);
    expect(verify({ ...venue(), address2: "", address1: venue().address, zip_code: "33626-1234" }).canonicalAddress).toEqual(first.canonicalAddress);
  });
});
