import { describe, expect, it } from "vitest";
import { isRexAnonymousPlaceholderRead, isRexNamespace, isRexPublicBrowserReadPost, isRexPublicReadPost, rexProjectedPublicReadRejection, rexPublicBrowserReadRejection } from "./rex-public-read-policy";

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

describe("closed Rex rejection diagnostics without request values", () => {
  const url = new URL(origin + "/api/venue/get");
  const original = () => ({ origin, "content-type": "application/json" });
  const reason = (value: unknown, headers = original(), frame = origin + "/package") =>
    rexPublicBrowserReadRejection(url, "POST", headers, JSON.stringify(value), frame);

  it("does not change allowed or denied policy outcomes or mutate their inputs", () => {
    for (const value of [input, { ...input, targetPackage: "" }, { ...input, privateSecretName: "private-value" }]) {
      const h = original(), body = JSON.stringify(value), before = isRexPublicBrowserReadPost(url, "POST", h, body, origin + "/package");
      const snapshot = JSON.stringify({ h, value });
      const code = reason(value, h);
      expect(isRexPublicBrowserReadPost(url, "POST", h, body, origin + "/package")).toBe(before);
      expect(JSON.stringify({ h, value })).toBe(snapshot);
      expect(code).toMatch(/^[A-Z_]{1,80}$/u);
      expect(code === "REX_READ_NOT_REJECTED").toBe(before);
    }
  });
  it.each([
    [{ ...input, targetPackage: "" }, "REX_READ_BODY_TARGET_PACKAGE_EMPTY_STRING_FORMAT"],
    [{ ...input, guests: "2" }, "REX_READ_BODY_GUESTS_STRING_TYPE"],
    [{ ...input, guests: 0 }, "REX_READ_BODY_GUESTS_NUMBER_RANGE"],
    [{ ...input, date: "2026-02-30" }, "REX_READ_BODY_DATE_STRING_VALUE"],
    [{ ...input, venueId: null }, "REX_READ_BODY_VENUE_ID_NULL_TYPE"],
    [{ ...input, unknownPrivateKey: "secret-input-value" }, "REX_READ_BODY_OTHER_OBJECT_EXTRA_FIELDS"],
    [null, "REX_READ_BODY_ROOT_NULL_TYPE"],
  ])("projects only a known field/type/issue for %j", (value, expected) => {
    expect(reason(value)).toBe(expected);
    expect(reason(value)).not.toMatch(/secret-input-value|unknownPrivateKey|507f|2026|\b0\b/u);
  });
  it.each([
    ["authorization", "Bearer private-value", "AUTHORIZATION"], ["Cookie", "private-value", "COOKIE"],
    ["x-csrf-token", "private-value", "CSRF"], ["x-api-key", "private-value", "API_KEY"],
    ["x-private-token", "private-value", "TOKEN"], ["x-http-method-override", "POST", "METHOD_OVERRIDE"],
    ["x-secret-private-header", "private-value", "OTHER_CREDENTIAL"],
  ])("reports only the credential kind for %s", (key, value, kind) => {
    const code = reason(input, { ...original(), [key]: value });
    expect(code).toBe(`REX_READ_HEADER_${kind}`);
    expect(code).not.toContain(value);
    expect(code).not.toContain(key);
  });
  it("distinguishes frame, origin, type, JSON and byte-bound failures", () => {
    expect(reason(input, original(), "not-a-url/private-value")).toBe("REX_READ_FRAME_URL");
    expect(reason(input, original(), "https://other.reservewithrex.com/package")).toBe("REX_READ_FRAME_ORIGIN");
    expect(reason(input, { ...original(), origin: "https://other.reservewithrex.com" })).toBe("REX_READ_ORIGIN");
    expect(reason(input, { ...original(), "content-type": "text/plain" })).toBe("REX_READ_CONTENT_TYPE");
    expect(rexPublicBrowserReadRejection(url, "POST", original(), "secret-invalid-json", origin)).toBe("REX_READ_BODY_JSON");
    expect(rexPublicBrowserReadRejection(url, "POST", original(), "x".repeat(16_385), origin)).toBe("REX_READ_BODY_LIMIT");
    expect(rexPublicBrowserReadRejection(new URL(origin + "/api/reservation"), "POST", original(), JSON.stringify(input), origin)).toBe("REX_READ_PATH");
    expect(rexPublicBrowserReadRejection(new URL(url.href + "?secret=private-value"), "POST", original(), JSON.stringify(input), origin)).toBe("REX_READ_URL_STATE");
  });
  it("keeps the exact placeholder exception scoped and never prints a bearer", () => {
    const endpoint = new URL(origin + "/api/venue/get-venue-with-package"), h = { ...original(), authorization: "bearer null" };
    expect(rexPublicBrowserReadRejection(endpoint, "POST", h, JSON.stringify(input), origin + "/package")).toBe("REX_READ_NOT_REJECTED");
    expect(rexPublicBrowserReadRejection(endpoint, "POST", h, JSON.stringify(input), origin + "/account")).toBe("REX_READ_PLACEHOLDER_FRAME");
    expect(rexPublicBrowserReadRejection(endpoint, "POST", { ...h, cookie: "private-cookie" }, JSON.stringify(input), origin + "/package")).toBe("REX_READ_HEADER_COOKIE");
    expect(rexPublicBrowserReadRejection(endpoint, "POST", h, JSON.stringify({ ...input, resourceIds: ["private-id"] }), origin + "/package")).toBe("REX_READ_BODY_RESOURCE_IDS_ARRAY_RANGE");
  });
  it("describes only projected public headers and body for a pinned transport denial", () => {
    const h = headers(); h.set("cookie", "private-cookie"); h.set("authorization", "private-bearer");
    const body = JSON.stringify({ ...input, targetPackage: "" });
    expect(rexPublicBrowserReadRejection(url, "POST", Object.fromEntries(h), body, origin)).toBe("REX_READ_HEADER_AUTHORIZATION");
    expect(rexProjectedPublicReadRejection(url, h, body, origin)).toBe("REX_READ_BODY_TARGET_PACKAGE_EMPTY_STRING_FORMAT");
    expect(isRexPublicReadPost(url, h, body)).toBe(false);
    expect(h.get("cookie")).toBe("private-cookie"); expect(h.get("authorization")).toBe("private-bearer");
    expect(rexProjectedPublicReadRejection(url, h, JSON.stringify(input), origin)).toBe("REX_READ_PROJECTED_POLICY");
  });
});
