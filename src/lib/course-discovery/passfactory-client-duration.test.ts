import { describe, expect, it } from "vitest";
import type { CourseAccessRecipeData } from "./recipe";
import { hasInspectedPassfactoryDurationClients, isInspectedPassfactoryDurationClient, isPassfactoryAvailabilityRequest, isPassfactoryDurationContext,
  isPassfactoryDurationRequestBound, PASSFACTORY_DURATION_CLIENTS } from "./passfactory-client-duration";

const source = "https://passfactory.com/ftbb/facility1/?sc=hall1";
const api = "https://api.passfactory.io/api/v1/availability-widget/hall-widget";
const recipe = {
  target: { kind: "SIMULATOR" }, source: { bookingUrl: source }, proof: { durationMinutes: { selector: "#duration" } },
  availabilityResponse: { url: api, method: "POST", date: { source: "JSON_BODY", path: "start_date" }, endDatePath: "end_date", success: { path: "code", equals: 200 } },
} as Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>;
const request = { url: api, method: "POST", body: JSON.stringify({ start_date: "2026-10-22", end_date: "2026-10-22", hall_code: "hall1", type: 2 }) };

describe("fixed inspected PassFactory local duration capability", () => {
  it("requires the actual inspected script URL and SHA256", () => {
    for (const client of PASSFACTORY_DURATION_CLIENTS) {
      const url = `https://passfactory.com${client.path}`;
      expect(isInspectedPassfactoryDurationClient(url, client.sha256)).toBe(true);
      expect(isInspectedPassfactoryDurationClient(url, "0".repeat(64))).toBe(false);
      expect(isInspectedPassfactoryDurationClient(url.replace("passfactory.com", "other.example.org"), client.sha256)).toBe(false);
      expect(isInspectedPassfactoryDurationClient(url + "?variant=1", client.sha256)).toBe(false);
    }
    expect(hasInspectedPassfactoryDurationClients(new Set([PASSFACTORY_DURATION_CLIENTS[0].path]))).toBe(false);
    expect(hasInspectedPassfactoryDurationClients(new Set(PASSFACTORY_DURATION_CLIENTS.map(client => client.path)))).toBe(true);
  });
  it("requires simulator source, exact date-bound API and application success guard", () => {
    expect(isPassfactoryDurationContext(recipe, source)).toBe(true);
    expect(isPassfactoryDurationContext({ ...recipe, target: { ...recipe.target, kind: "OUTDOOR" } }, source)).toBe(false);
    expect(isPassfactoryDurationContext(recipe, source.replace("passfactory.com", "other.example.org"))).toBe(false);
    expect(isPassfactoryDurationContext(recipe, "https://passfactory.com/ftbb/facility1/")).toBe(false);
    expect(isPassfactoryDurationContext(recipe, source.replace("hall1", "hall2"))).toBe(false);
    expect(isPassfactoryDurationContext(recipe, source.replace("facility1", "facility2"))).toBe(false);
    expect(isPassfactoryDurationContext({ ...recipe, availabilityResponse: { ...recipe.availabilityResponse, success: { path: "code", equals: 400 } } }, source)).toBe(false);
  });
  it("binds the prior success to the same requested day and observed hall", () => {
    expect(isPassfactoryDurationRequestBound(recipe, source, "2026-10-22", request)).toBe(true);
    expect(isPassfactoryDurationRequestBound(recipe, source, "2026-10-23", request)).toBe(false);
    expect(isPassfactoryDurationRequestBound(recipe, source.replace("hall1", "hall2"), "2026-10-22", request)).toBe(false);
    expect(isPassfactoryDurationRequestBound(recipe, source, "2026-10-22", { ...request, body: request.body.replace("hall1", "facility1") })).toBe(false);
    expect(isPassfactoryDurationRequestBound(recipe, source, "2026-10-22", { ...request, body: request.body.replace('"type":2', '"type":1') })).toBe(false);
  });
  it("counts all known availability reads, including requests for another day", () => {
    expect(isPassfactoryAvailabilityRequest(request)).toBe(true);
    expect(isPassfactoryAvailabilityRequest({ ...request, url: api.replace("hall-widget", "facility-widget") })).toBe(true);
    expect(isPassfactoryAvailabilityRequest({ ...request, url: api.replace("availability-widget/hall-widget", "availability/get-month-tickets") })).toBe(true);
    expect(isPassfactoryAvailabilityRequest({ ...request, method: "GET" })).toBe(false);
    expect(isPassfactoryAvailabilityRequest({ ...request, url: api.replace("api.passfactory.io", "foreign.example.org") })).toBe(false);
  });
});
