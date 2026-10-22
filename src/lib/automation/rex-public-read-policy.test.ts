import { describe, expect, it } from "vitest";
import { isRexAnonymousPlaceholderRead, isRexNamespace, isRexPublicBrowserReadPost, isRexPublicReadPost } from "./rex-public-read-policy";

const origin = "https://venue.reservewithrex.com";
const venueId = "507f1f77bcf86cd799439011", packageId = "507f1f77bcf86cd799439012";
const input = { venueId, date: "2026-10-23", guests: 2, duration: 2, lanes: 1, packagesTag: "" };
const headers = () => new Headers({ origin, "content-type": "application/json" });
const allows = (path: string, value: unknown, h = headers()) => isRexPublicReadPost(new URL(origin + path), h, JSON.stringify(value));

describe("published Rex anonymous availability reads", () => {
  it("permits the two typed reads without selecting or changing any reservation", () => {
    expect(allows("/api/venue/get", input)).toBe(true);
    expect(allows("/api/venue/get-venue-with-package", { ...input, packageId, singlePackage: false, resourceIds: [], guestsWithAgeGroups: [] })).toBe(true);
  });
  it.each(["/api/reservation", "/api/reservation/create", "/api/venue/get-package-activity", "/api/venue/get/", "/api/venue/get?product=3", "/api/venue/get#read"])("denies an unproved route %s", path => {
    expect(allows(path, input)).toBe(false);
  });
  it.each(["skipReservationId", "selectedPackageSlot", "selectedReservationActivities", "reservationId", "clientId", "email", "payment", "query"])("rejects extra %s even on a catalog endpoint", key => {
    expect(allows("/api/venue/get-venue-with-package", { ...input, [key]: "test" })).toBe(false);
  });
  it.each([{ date: "2026-02-30" }, { date: "2026-10-23T00:00:00Z" }, { guests: 0 }, { guests: 201 }, { guests: "2" }, { duration: -1 }, { duration: 1.5 }, { lanes: 0 }, { venueId: "secret-token" }, { resourceIds: [packageId] }, { guestsWithAgeGroups: [{ email: "person@example.com" }] }])("rejects invalid or stateful filters %j", delta => {
    expect(allows("/api/venue/get-venue-with-package", { ...input, ...delta })).toBe(false);
  });
  it.each(["authorization", "cookie", "proxy-authorization", "x-auth-token", "x-api-key", "x-csrf-token", "csrf", "next-action", "x-http-method-override"])("denies actual header %s", key => {
    const h = headers(); h.set(key, "value"); expect(allows("/api/venue/get", input, h)).toBe(false);
  });
  it("requires the exact public tenant and matching origin", () => {
    for (const base of ["http://venue.reservewithrex.com", "https://reservewithrex.com", "https://nested.venue.reservewithrex.com", "https://venue.reservewithrex.com.evil.example", "https://user:pass@venue.reservewithrex.com", "https://venue.reservewithrex.com:8443"])
      expect(isRexPublicReadPost(new URL(base + "/api/venue/get"), headers(), JSON.stringify(input))).toBe(false);
    const h = headers(); h.set("origin", "https://other.reservewithrex.com"); expect(allows("/api/venue/get", input, h)).toBe(false);
    expect(isRexNamespace(new URL(origin))).toBe(true);
    expect(isRexNamespace(new URL("https://venue.reservewithrex.com.evil.example"))).toBe(false);
  });
  it("admits only the literal non-credential placeholder in the same public package document", () => {
    const url = new URL(origin + "/api/venue/get-venue-with-package"), body = JSON.stringify({ ...input, packageId });
    const original = { authorization: "bearer null", origin, "content-type": "application/json" };
    expect(isRexAnonymousPlaceholderRead(url, "POST", original, body, origin + "/package?guests=2")).toBe(true);
    for (const authorization of ["Bearer null", "bearer undefined", "bearer null ", "bearer token", "bearer null,bearer token"])
      expect(isRexAnonymousPlaceholderRead(url, "POST", { ...original, authorization }, body, origin + "/package")).toBe(false);
    for (const key of ["cookie", "proxy-authorization", "x-api-key", "x-auth-token", "x-csrf-token", "csrf"])
      expect(isRexAnonymousPlaceholderRead(url, "POST", { ...original, [key]: "value" }, body, origin + "/package")).toBe(false);
    for (const frame of [origin + "/account", origin + "/package?reservationId=123", "https://other.reservewithrex.com/package"])
      expect(isRexAnonymousPlaceholderRead(url, "POST", original, body, frame)).toBe(false);
    expect(isRexAnonymousPlaceholderRead(new URL(origin + "/api/venue/get"), "POST", original, body, origin + "/package")).toBe(false);
  });

  it("checks original native headers even without an authorization header", () => {
    const url = new URL(origin + "/api/venue/get"), body = JSON.stringify(input);
    const original = { origin, "content-type": "application/json" };
    expect(isRexPublicBrowserReadPost(url, "POST", original, body, origin + "/")).toBe(true);
    for (const key of ["Cookie", "x-auth-token", "x-csrf-token", "authorization", "x-api-key"])
      expect(isRexPublicBrowserReadPost(url, "POST", { ...original, [key]: "value" }, body, origin + "/package")).toBe(false);
    expect(isRexPublicBrowserReadPost(url, "POST", original, body, "https://other.reservewithrex.com/package")).toBe(false);
  });
});
