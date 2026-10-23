import { describe, expect, it } from "vitest";
import { accessRecipeSchema, parseAccessRecipe, hashAccessRecipe } from "./recipe";

const source = { officialUrl: "https://example.org/golf", bookingUrl: "https://app.membersports.com/tee-times/123/456/0",
  venueName: "Canonical Golf Course", venueAddress: "100 Main Road, Example, NC 27603, USA", providerFamily: "MEMBERSPORTS", timeZone: "America/New_York" };
const recipe = () => ({ schemaVersion: 1, engine: "BROWSER_JSON", requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET", browserTransport: "NATIVE_CHROME",
  target: { kind: "OUTDOOR", courseId: "course" }, source: { ...source }, pageUrl: "https://example.org/rates",
  permittedRoutes: [{ origin: "https://example.org", path: "/rates", methods: ["GET"] },
    { origin: "https://app.membersports.com", path: "/tee-times/123/456/0", methods: ["GET"] },
    { origin: "https://api.membersports.com", path: "/api/v1/golfclubs/onlineBookingTeeTimes", methods: ["POST"] }],
  steps: [{ action: "waitFor", selector: "#address" }, { action: "openOfficialBooking", addressSelector: "#address", bookingLinkSelector: "#book" },
    { action: "waitFor", selector: ".dateFormat" }, { action: "clickFilter", selector: "#calendar", text: "Date", purpose: "OPEN_DATE_PICKER" },
    { action: "selectDateChoice", selector: "[role=grid] button" }],
  availabilityResponse: { url: "https://api.membersports.com/api/v1/golfclubs/onlineBookingTeeTimes", method: "POST", date: { source: "JSON_BODY", path: "date" } },
  proof: { venue: { officialBookingLink: true }, date: { availabilityRequestDate: true }, complete: { publicTeeSheet: true } } });

describe("closed public MemberSports JSON recipe", () => {
  it("round-trips the data-only native public binding without a fabricated success scalar or uploaded extraction paths", () => {
    const parsed = parseAccessRecipe(recipe());
    expect(hashAccessRecipe(JSON.parse(JSON.stringify(parsed)))).toBe(hashAccessRecipe(parsed));
    expect(parsed).toMatchObject({ engine: "BROWSER_JSON", requestBinding: "MEMBERSPORTS_PUBLIC_TEE_SHEET", browserTransport: "NATIVE_CHROME" });
  });
  it.each([
    { browserTransport: "PINNED_HTTP" }, { target: { kind: "SIMULATOR", courseId: "course", offeringId: "rental" } },
    { source: { ...source, venueAddress: undefined } }, { source: { ...source, providerFamily: "OTHER" } },
    { source: { ...source, bookingUrl: "https://app.membersports.com/tee-times/123/456/1" } },
    { source: { ...source, bookingUrl: "https://app.membersports.com/tee-times/123/456/0?profile=7" } },
    { source: { ...source, bookingUrl: "https://app.membersports.com/tee-times/2147483648/456/0" } },
    { pageUrl: "https://other.example.org/rates" }, { pageUrl: "https://example.org/rates?date={{date}}" },
    { availabilityResponse: { ...recipe().availabilityResponse, method: "GET" } },
    { availabilityResponse: { ...recipe().availabilityResponse, date: { source: "JSON_BODY", path: "date", format: "M/D/YYYY" } } },
    { availabilityResponse: { ...recipe().availabilityResponse, success: { path: "ok", equals: true } } },
    { availabilityResponse: { ...recipe().availabilityResponse, url: "https://api.membersports.com/api/v1/golfclubs/other" } },
    { proof: { ...recipe().proof, complete: { availabilityResponse: true } } },
    { proof: { ...recipe().proof, venue: { selector: "h1" } } },
    { slots: { collection: { selector: "body" } } }, { responseRows: { path: "arbitrary" } },
    { steps: [{ action: "openOfficialBooking", addressSelector: "input[type=password]", bookingLinkSelector: "#book" }] },
    { steps: [] }, { steps: [recipe().steps[1], recipe().steps[1]] },
    { steps: [recipe().steps[1], { action: "clickFilter", selector: "#voucher", text: "Golf voucher", purpose: "OPEN_FILTER" }] },
    { steps: [recipe().steps[1], { action: "followLink", selector: "#other", text: "Other" }] },
    { steps: [{ action: "clickFilter", selector: "#other", text: "Other", purpose: "RUN_SEARCH" }, recipe().steps[1]] },
  ])("rejects transport, source, rule or proof expansion: %j", change => {
    expect(accessRecipeSchema.safeParse({ ...recipe(), ...change }).success).toBe(false);
  });
});
