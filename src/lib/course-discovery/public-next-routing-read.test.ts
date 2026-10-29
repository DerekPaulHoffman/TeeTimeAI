import { describe, expect, it } from "vitest";
import { isSafeBrowserAvailabilityReadUrl, isSafeBrowserBootstrapReadUrl, isSafeRecipeUrl } from "./recipe";
import { isSafePublicSwiftBootstrapReadUrl, isSafePublicSwiftCatalogRedirect } from "./public-bootstrap-read-url";

const build = "AbCdEf0123456789_-abcd", origin = "https://book.runswiftapp.com";
const manifest = `${origin}/_next/static/${build}/_buildManifest.js`;
const page = `${origin}/_next/data/${build}/facilities/example-labs.json`;
const facility = `${origin}/api/facility/getFacilityBySubdomain?subdomain=example-labs`;
const eligibility = `${origin}/api/facility/123/isEligibleForBooking`;
const visibility = `${origin}/api/public/service/visibility?facilityId=123&userId=`;
const catalog = `${origin}/api/public/rental/?facilityId=123&duration=0%2C480&price=0%2C500&startTime=4%2C23&dayOfWeek=0`;
const collections = `${origin}/api/public/facility/123/service-collections?type=RENTAL`;
const price = `${origin}/api/public/price?facilityId=123&serviceId=456&packageId=&membershipId=&userId=`;
const rentalPage = `${origin}/_next/data/${build}/book/facilities/example-labs/rentals.json?subdomain=example-labs&serviceType=rentals`;
describe("published public Next booking metadata", () => {
  it("admits only the observed trailing-slash catalogue 308, retaining all anonymous query bytes", () => {
    const destination = catalog.replace("rental/?", "rental?");
    expect(isSafePublicSwiftCatalogRedirect(catalog, destination, 308, "xhr", "GET", isSafeRecipeUrl)).toBe(true);
    for (const status of [200, 301, 302, 303, 307]) expect(isSafePublicSwiftCatalogRedirect(catalog, destination, status, "xhr", "GET", isSafeRecipeUrl)).toBe(false);
    for (const url of [destination.replace("123", "456"), destination + "&userId=1", destination.replace("https:", "http:"),
      destination.replace("book.runswiftapp.com", "foreign.example.org"), destination.replace("/rental?", "/checkout?"), destination + "#fragment"])
      expect(isSafePublicSwiftCatalogRedirect(catalog, url, 308, "xhr", "GET", isSafeRecipeUrl)).toBe(false);
    expect(isSafePublicSwiftCatalogRedirect(destination, catalog, 308, "xhr", "GET", isSafeRecipeUrl)).toBe(false);
    expect(isSafePublicSwiftCatalogRedirect(catalog, destination, 308, "document", "GET", isSafeRecipeUrl)).toBe(false);
    expect(isSafePublicSwiftCatalogRedirect(catalog, destination, 308, "xhr", "POST", isSafeRecipeUrl)).toBe(false);
    expect(isSafePublicSwiftCatalogRedirect(catalog, destination, 308, "xhr", "GET", () => false)).toBe(false);
  });
  it.each([manifest, page, page.replace(".json", "/rentals.json"), facility, eligibility, visibility, catalog, catalog.replace("rental/?", "rental?"), collections, price, rentalPage])("admits only the observed metadata role: %s", url => {
    expect(isSafeBrowserBootstrapReadUrl(url, "xhr", "GET")).toBe(true);
    expect(isSafeBrowserBootstrapReadUrl(url, "fetch", "GET")).toBe(true);
    expect(isSafeBrowserAvailabilityReadUrl(url, "fetch", "GET")).toBe(false);
  });
  it("permits the public page HEAD while preserving the GET-only manifest", () => {
    expect(isSafeBrowserBootstrapReadUrl(page, "xhr", "HEAD")).toBe(true);
    expect(isSafePublicSwiftBootstrapReadUrl(manifest, "xhr", "HEAD", isSafeRecipeUrl)).toBe(false);
    expect(isSafePublicSwiftBootstrapReadUrl(facility, "xhr", "HEAD", isSafeRecipeUrl)).toBe(false);
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("rejects %s", method => {
    expect(isSafeBrowserBootstrapReadUrl(page, "xhr", method)).toBe(false);
  });
  it.each(["document", "iframe", "script", "stylesheet", "image"])("does not grant a %s route", type => {
    expect(isSafePublicSwiftBootstrapReadUrl(page, type, "GET", isSafeRecipeUrl)).toBe(false);
  });
  it.each([
    page.replace("https:", "http:"), page.replace(origin, "https://book.runswiftapp.com.evil.example"),
    page.replace(origin, "https://user:password@book.runswiftapp.com"), page.replace(origin, origin + ":444"),
    page + "?token=private", page + "?x=1", page + "#fragment", " " + page,
    page.replace(build, "short"), page.replace(build, "a".repeat(129)), page.replace(build, "%41" + build),
    page.replace("/facilities/", "/facilities/../facilities/"), page.replace("example-labs", "example%2Dlabs"),
    page.replace(".json", "/create-account/get-started.json"), page.replace(".json", "/bookings.json"),
    page.replace("/facilities/", "/customers/"), manifest.replace("_buildManifest.js", "private.js"),
    facility + "&userId=123", facility + "&subdomain=other", facility.replace("subdomain=", "subdomain=%65"),
    facility.replace("getFacilityBySubdomain", "setFacilityBySubdomain"),
    eligibility.replace("123", "0"), eligibility.replace("123", "2147483648"), eligibility + "?userId=123",
    visibility + "123", visibility + "null", visibility + "undefined", visibility + "&extra=1",
    visibility.replace("123", "2147483648"), visibility.replace("userId=", "userId=%20"),
    catalog.replace("0%2C480", "60%2C60"), catalog.replace("4%2C23", "10%2C11"), catalog.replace("dayOfWeek=0", "dayOfWeek=1"),
    catalog + "&userId=123", catalog.replace("facilityId=123", "facilityId=2147483648"),
    collections.replace("type=RENTAL", "type=MEMBERSHIP"), price + "123", price.replace("packageId=", "packageId=123"),
    price.replace("membershipId=", "membershipId=123"), price.replace("serviceId=456", "serviceId=2147483648"),
    rentalPage.replace("subdomain=example-labs", "subdomain=other-labs"), rentalPage.replace("serviceType=rentals", "serviceType=memberships"),
  ])("rejects aliases, customer paths and extra authority: %s", url => {
    expect(isSafePublicSwiftBootstrapReadUrl(url, "xhr", "GET", isSafeRecipeUrl)).toBe(false);
  });
  it("keeps the unchanged host and public facility name under the strict guard", () => {
    let checked = "";
    expect(isSafePublicSwiftBootstrapReadUrl(page, "xhr", "GET", url => { checked = url; return false; })).toBe(false);
    expect(checked).toBe(`${origin}/public-facility/example-labs`);
  });
});
