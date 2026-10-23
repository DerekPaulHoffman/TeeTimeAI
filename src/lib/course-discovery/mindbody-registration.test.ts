// @vitest-environment node
import { describe, expect, it } from "vitest";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import { inspectMindbodyPublicRentalCatalog } from "./mindbody-appointment-grid";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl, parseAccessRecipe, recipeAllowsRequest } from "./recipe";
import { createDiscoveryAdapterObservation, inspectedAdapterSourceEvidence } from "../../../scripts/automation/course-discovery-worker.mjs";

function candidate() {
  const catalog = { ...structuredClone(observed.catalogObserved), captureId: "registration-fixture",
    category: { ...observed.catalogObserved.category, enabled: true as const, selected: true as const },
    service: { ...observed.catalogObserved.service, enabled: true as const, selected: true as const },
    resources: observed.catalogObserved.resources.map(row => ({ ...row, enabled: true as const })) };
  return { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", offeringId: "owned-offering", kind: "SIMULATOR" },
    source: { ...observed.source, providerFamily: "MINDBODY" }, adapter: inspectMindbodyPublicRentalCatalog(observed.source, catalog).metadata };
}
describe("fixed public appointment registration", () => {
  it("keeps appointment request attributes ineligible for browser navigation or asset reads", () => {
    expect(isSafeRecipeUrl(observed.source.bookingUrl)).toBe(true);
    for (const path of ["/ASP/appt_req.asp", "/asp/APPT_REQ.asp", "/ASP/%61ppt_req.asp"]) {
      const url = "https://clients.mindbodyonline.com" + path + "?loc=1&tgid=2";
      expect(isSafeRecipeUrl(url)).toBe(false);
      expect(isSafeBrowserAssetUrl(url, "document", "GET")).toBe(false);
    }
  });
  it("accepts typed independently interpreted metadata and leaves every provider route under the fixed reader", () => {
    const proposed = candidate(), recipe = parseAccessRecipe(proposed);
    expect(recipe).toMatchObject({ engine: "EXISTING_ADAPTER", target: { kind: "SIMULATOR" }, adapter: { family: "MINDBODY", catalogHash: proposed.adapter.catalogHash } });
    expect(recipe).toMatchObject({ adapter: { browserTransport: "NATIVE_CHROME", requiredCapability: "LOCAL_CHROME" } });
    expect(recipeAllowsRequest(recipe, observed.source.bookingUrl, "GET")).toBe(false);
    expect(recipeAllowsRequest(recipe, "https://clients.mindbodyonline.com/ASP/appt_req.asp", "GET")).toBe(false);
  });
  it.each(["outdoor", "missing offering", "missing address", "wrong studio", "wrong timezone", "wrong family"])(
    "rejects a mismatched reusable contract: %s", kind => {
      const value = candidate();
      if (kind === "outdoor") Object.assign(value.target, { kind: "OUTDOOR" });
      if (kind === "missing offering") Reflect.deleteProperty(value.target, "offeringId");
      if (kind === "missing address") Reflect.deleteProperty(value.source, "venueAddress");
      if (kind === "wrong studio") value.source.bookingUrl = value.source.bookingUrl.replace("685163", "12345");
      if (kind === "wrong timezone") value.source.timeZone = "America/Chicago";
      if (kind === "wrong family") value.source.providerFamily = "ACUITY";
      expect(() => parseAccessRecipe(value)).toThrow();
    });
  it.each(["request", "completion", "captureId", "rawHtml", "signedOut", "proof"])("rejects model-supplied native authority: %s", field => {
    const value = candidate();
    expect(() => parseAccessRecipe({ ...value, adapter: { ...value.adapter, [field]: true } })).toThrow();
  });
  it("requires explicit native capability metadata without adding defaults", () => {
    const value = candidate();
    expect(() => parseAccessRecipe({ ...value, adapter: { ...value.adapter, browserTransport: "PINNED_HTTP" } })).toThrow();
    const without = structuredClone(value); Reflect.deleteProperty(without.adapter, "requiredCapability");
    expect(() => parseAccessRecipe(without)).toThrow();
  });
  it("requires the same current owned inspection and rejects altered metadata, input and job identity", () => {
    const value = candidate(), job = { id: "owned-job", request: { identity: { name: observed.source.venueName, officialUrl: observed.source.officialUrl,
      address: observed.source.venueAddress, bookingUrl: observed.source.bookingUrl }, target: value.target, input: observed.input } };
    const observation = createDiscoveryAdapterObservation(job, value.source.bookingUrl, value.adapter, value.source.officialUrl);
    const expected = { officialUrl: value.source.officialUrl, observedBookingUrl: value.source.bookingUrl };
    expect(inspectedAdapterSourceEvidence(value, job, observation, true, value.source.officialUrl)).toEqual(expected);
    expect(inspectedAdapterSourceEvidence({ ...value, adapter: { ...value.adapter, catalogHash: "0".repeat(64) } }, job, observation, true, value.source.officialUrl)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(value, { ...job, id: "other-job" }, observation, true, value.source.officialUrl)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(value, { ...job, request: { ...job.request, input: { ...observed.input, players: 3 } } }, observation, true, value.source.officialUrl)).toBeUndefined();
    expect(inspectedAdapterSourceEvidence(value, job, observation, false, value.source.officialUrl)).toBeUndefined();
  });
});
