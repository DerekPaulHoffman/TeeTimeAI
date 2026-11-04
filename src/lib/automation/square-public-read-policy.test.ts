import { describe, expect, it } from "vitest";
import { isAnonymousBrowserReadPost } from "./simulator-interactive-browser";
import { isSquarePublicAvailabilityPost, isSquarePublicServiceCatalogUrl, squarePublicAvailabilityCoversDate } from "./square-public-read-policy";

describe("public Square calendar entry destinations", () => {
  const catalog = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/services";
  it("accepts only an exact undated catalog with existing presentation query fields", () => {
    expect(isSquarePublicServiceCatalogUrl(catalog)).toBe(true);
    expect(isSquarePublicServiceCatalogUrl("https://app.squareup.com/appointments/book/LOC1234567890/start?color=ffffff&locale=en&referrer=so")).toBe(true);
    expect(isSquarePublicServiceCatalogUrl(catalog.replace("book.squareup.com", "app.squareup.com"))).toBe(false);
    expect(isSquarePublicServiceCatalogUrl("https://app.squareup.com/appointments/book/LOC1234567890/start?service_id=" + "A".repeat(24))).toBe(false);
    expect(isSquarePublicServiceCatalogUrl(catalog + "?color=ffffff&buttonTextColor=000000&locale=en-US&referrer=so")).toBe(true);
  });
  it.each(["?service_id=" + "A".repeat(24), "?slot_id=123", "?date=2030-01-04", "?locale=en&locale=en", "?color=javascript:bad", "?unknown=yes", "#calendar", "/../services", "/" + "A".repeat(24)])("rejects selected, ambiguous or nonliteral routes: %s", suffix => {
    expect(isSquarePublicServiceCatalogUrl(catalog + suffix)).toBe(false);
  });
  it("rejects foreign, credentialed and encoded paths", () => {
    for (const url of [catalog.replace("book.squareup.com", "book.squareup.com.example"), catalog.replace("https://", "https://user@"), catalog.replace("services", "%73ervices"), catalog.replace("services", "availability")])
      expect(isSquarePublicServiceCatalogUrl(url)).toBe(false);
  });
  it("does not give the legacy navigation gateway availability POST authority", () => {
    expect(isSquarePublicAvailabilityPost(new URL("https://app.squareup.com/appointments/api/buyer/availability"),
      new Headers({ "content-type": "application/json" }), JSON.stringify(payload()),
      "https://app.squareup.com/appointments/book/LOC1234567890/start")).toBe(false);
  });
});

const source = "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/availability";
const endpoint = "https://app.squareup.com/appointments/api/buyer/availability";
const headers = () => new Headers({ "content-type": "application/json" });
const payload = () => ({ search_availability_request: { query: { filter: { location_id: "LOC1234567890",
  start_at_range: { start_at: "2030-01-04T00:00:00.000-05:00", end_at: "2030-02-05T22:59:59.999-05:00" },
  segment_filters: [{ service_variation_id: "A".repeat(24), team_member_id_filter: { any: ["public-team-1234"] } }],
} } } });
const check = (value: unknown, url = endpoint, document: string | undefined = source, h = headers()) =>
  isSquarePublicAvailabilityPost(new URL(url), h, JSON.stringify(value), document);

describe("source-bound public Square availability", () => {
  it("requires the entire local day, including a DST transition, rather than one matching timestamp", () => {
    const value = payload();
    value.search_availability_request.query.filter.start_at_range = { start_at: "2030-11-03T00:00:00.000-04:00", end_at: "2030-11-03T23:59:59.999-05:00" };
    const covers = (date: string) => squarePublicAvailabilityCoversDate({ url: endpoint, method: "POST", body: JSON.stringify(value) }, source, { date, timeZone: "America/New_York" });
    expect(covers("2030-11-03")).toBe(true);
    expect(covers("2030-11-04")).toBe(false);
    expect(covers("2030-11-31")).toBe(false);
    value.search_availability_request.query.filter.start_at_range.end_at = "2030-11-03T23:59:59.999-04:00";
    expect(covers("2030-11-03")).toBe(false);
    value.search_availability_request.query.filter.start_at_range.end_at = "2030-11-03T23:59:59.999-05:00";
    value.search_availability_request.query.filter.start_at_range.start_at = "2030-11-03T00:00:00.001-04:00";
    expect(covers("2030-11-03")).toBe(false);
  });
  it("admits only the observed single-rental public month query for the current location", () => {
    expect(check(payload())).toBe(true);
    expect(isAnonymousBrowserReadPost(new URL(endpoint), headers(), JSON.stringify(payload()), source)).toBe(true);
    expect(isAnonymousBrowserReadPost(new URL(endpoint), headers(), JSON.stringify(payload()))).toBe(false);
    expect(check(payload(), endpoint, source.replace("/availability", "/services"))).toBe(true);
  });
  it.each([
    endpoint + "?action=book", endpoint + "#fragment", endpoint.replace("app.", "book."),
    endpoint.replace("/availability", "/bookings"), endpoint.replace("/availability", "/availability/create"),
    "https://app.squareup.com/appointments/api/buyer/create-booking",
  ])("does not give other endpoints REST or GraphQL permission: %s", url => {
    expect(check(payload(), url)).toBe(false);
    expect(isAnonymousBrowserReadPost(new URL(url), headers(), JSON.stringify({ query: "{ slots { start } }" }), source)).toBe(false);
  });
  it.each([
    "https://book.squareup.com/appointments/example12345678/location/OTH1234567890/availability",
    "https://book.squareup.com/appointments/example12345678/location/LOC1234567890/checkout",
    source + "?token=private", source + "?locale=en&locale=fr", source.replace("https:", "http:"),
    "https://merchant.example.com/", "about:blank",
  ])("rejects foreign, sensitive or unbound source documents: %s", document => {
    expect(check(payload(), endpoint, document)).toBe(false);
  });
  it.each(["authorization", "cookie", "x-api-key", "next-action"])("rejects credential/action header %s", name => {
    const h = headers(); h.set(name, "private"); expect(check(payload(), endpoint, source, h)).toBe(false);
  });
  it("rejects unknown fields, several rentals, duplicate teams and unbounded dates", () => {
    const base = payload();
    const cases = [
      { ...base, query: "{ slots { start } }" },
      { search_availability_request: { ...base.search_availability_request, customer_id: "private" } },
      { search_availability_request: { query: { filter: { ...base.search_availability_request.query.filter, email: "private@example.test" } } } },
    ];
    for (const value of cases) expect(check(value)).toBe(false);
    const multiple = payload(); multiple.search_availability_request.query.filter.segment_filters.push(structuredClone(base.search_availability_request.query.filter.segment_filters[0]));
    expect(check(multiple)).toBe(false);
    const duplicate = payload(); duplicate.search_availability_request.query.filter.segment_filters[0].team_member_id_filter.any.push("public-team-1234");
    expect(check(duplicate)).toBe(false);
    const tooLong = payload(); tooLong.search_availability_request.query.filter.start_at_range.end_at = "2030-03-05T00:00:00.000-05:00";
    expect(check(tooLong)).toBe(false);
    const reversed = payload(); reversed.search_availability_request.query.filter.start_at_range.end_at = "2030-01-03T00:00:00.000-05:00";
    expect(check(reversed)).toBe(false);
    expect(isSquarePublicAvailabilityPost(new URL(endpoint), headers(), " ".repeat(32_769), source)).toBe(false);
  });
});
