import { describe, expect, it } from "vitest";
import { isSwiftAnonymousPlaceholderRead, isSwiftPublicSlotsUrl } from "./swift-public-read-policy";
const frame = "https://book.runswiftapp.com/facilities/example-labs/rentals";
const slots = "https://book.runswiftapp.com/api/booking/availableSlots?startTime=2026-10-31T04:00:00.000Z&endTime=2026-11-01T03:59:59.999Z&duration=60&serviceId=123";
const price = "https://book.runswiftapp.com/api/public/price?facilityId=123&serviceId=456&packageId=&membershipId=&userId=";
describe("signed-out Swift calendar reads", () => {
  it.each([slots, price])("admits the observed non-credential placeholder only: %s", url => {
    expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null" }, frame)).toBe(true);
    expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null", cookie: "" }, frame)).toBe(true);
    expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null", cookie: "__client_uat=0; __client_uat_a1b2C3D4=0" }, frame)).toBe(true);
    for (const cookie of ["__client_uat=123", "__client_uat=0; __session=private", "__client_uat=0; __client_uat=0", "__client_uat=0;__client_uat_a1b2C3D4=0", "__client_uat_wrong=0"])
      expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null", cookie }, frame)).toBe(false);
    for (const authorization of ["Bearer private-credential", "Bearer undefined", "Bearer ", "bearer null", "null", ""])
      expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization }, frame)).toBe(false);
    for (const key of ["cookie", "x-api-key", "proxy-authorization", "x-auth-token", "x-csrf", "next-action", "x-http-method-override"])
      expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null", [key]: "private" }, frame)).toBe(false);
    for (const source of [frame.replace("https:", "http:"), frame + "?userId=1", frame.replace("/rentals", "/create-account"), "https://foreign.example.org/rentals"])
      expect(isSwiftAnonymousPlaceholderRead(url, "GET", { authorization: "Bearer null" }, source)).toBe(false);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "HEAD"])
      expect(isSwiftAnonymousPlaceholderRead(url, method, { authorization: "Bearer null" }, frame)).toBe(false);
  });
  it.each([slots.replace("serviceId=123", "serviceId=2147483648"), slots + "&userId=1", slots.replace("duration=60", "duration=120"),
    slots.replace("2026-11-01T03:59", "2026-11-02T03:59"), slots.replace("10-31", "02-31"), slots.replace("https:", "http:"),
    slots.replace("/availableSlots", "/reserve"), slots.replace("startTime=2026", "startTime=%322026"), slots + "#fragment"])("rejects altered read contracts: %s", value => {
    expect(isSwiftPublicSlotsUrl(value)).toBe(false);
  });
});
