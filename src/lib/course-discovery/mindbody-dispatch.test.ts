// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { executeAccessRecipe, recipeTimeToInstant, venueProofMatches } from "./executor";
import { inspectMindbodyPublicRentalCatalog, type MindbodyGridEvidence } from "./mindbody-appointment-grid";
import { parseAccessRecipe } from "./recipe";
import type { MindbodyAppointmentReaderDeps } from "./mindbody-appointment-reader";
import { filterSimulatorSessionsForSearch } from "@/lib/tee-times/matching";

const source = { ...observed.source, providerFamily: "MINDBODY" };
const input = observed.input;
function catalog() {
  return { ...structuredClone(observed.catalogObserved), captureId: "owned-capture",
    category: { ...observed.catalogObserved.category, enabled: true as const, selected: true as const },
    service: { ...observed.catalogObserved.service, enabled: true as const, selected: true as const },
    resources: observed.catalogObserved.resources.map(row => ({ ...row, enabled: true as const })) };
}
function grid(): MindbodyGridEvidence {
  const value: MindbodyGridEvidence = { ...structuredClone(observed.gridObserved), captureId: "owned-capture" };
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  // Synthetic full document around retained public anchors, not live proof.
  const html = '<html><body><h1>Saturday 10/24/2026</h1><p>Instructors 1-6</p><table><tr>' +
    value.resourceHeaders.map(row => `<th><a class="instructorLink" href="${escape(row.href)}">${escape(row.label)}</a></th>`).join("") +
    '</tr><tr><td>5:00 am</td></tr>' + value.anchors.map(row => `<tr><td><a class="apptLink" href="${escape(row.href)}">${escape(row.label)}</a></td></tr>`).join("") +
    '<tr><td>10:00 pm</td></tr></table></body></html>';
  value.completion = { responseUrl: value.url, status: 200, contentType: "text/html", rawHtml: html, renderedHtml: html,
    bodyComplete: true, documentUnchanged: true, pendingRelevantRequests: 0, truncated: false, signedOut: true };
  return value;
}
function fixture(currentCatalog = catalog(), currentGrid = grid()) {
  const close = vi.fn(async () => {});
  const createMindbodySession = vi.fn(async () => ({
    execute: vi.fn(async () => ({ url: source.bookingUrl, navigationStatus: 200, loading: false, accessRequirementObserved: false })),
    readMindbodyPublicCatalog: vi.fn(async () => structuredClone(currentCatalog)),
    readMindbodyPublicGrid: vi.fn(async () => structuredClone(currentGrid)), close,
  })) as unknown as NonNullable<MindbodyAppointmentReaderDeps["createSession"]>;
  const fetch = vi.fn(async () => { throw new Error("GENERIC_FETCH_FORBIDDEN"); });
  const deps = { now: () => new Date("2026-10-23T12:00:00Z"), recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant,
    venueMatches: venueProofMatches, requestedInput: input, localCapabilities: ["LOCAL_CHROME"] as const, createMindbodySession, fetch };
  return { close, createMindbodySession, fetch, deps };
}
const recipe = () => parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source,
  target: { courseId: "owned-course", offeringId: "owned-offering", kind: "SIMULATOR" }, adapter: inspectMindbodyPublicRentalCatalog(source, catalog()).metadata });

describe("Mindbody fixed dispatch through actual catalog and grid interpretation", () => {
  it("inspects and replays fresh controller captures through central dispatch without a generic provider fetch", async () => {
    const f = fixture();
    const inspected = await inspectExistingAdapter(source, f.deps);
    expect(inspected.adapter).toEqual(recipe().adapter);
    const result = await executeAccessRecipe(recipe(), input, f.deps);
    expect(result).toMatchObject({ status: "AVAILABLE", complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, completeVerified: true } });
    expect(result.slots).toHaveLength(59);
    expect(result.slots.every(slot => slot.bookingUrl === source.bookingUrl && slot.capacity === 4 && slot.availableSpots === 1)).toBe(true);
    const sessions = result.slots.map(slot => ({ ...slot, offeringId: "owned-offering", resourceId: slot.resourceId ?? "", endsAt: slot.endsAt!, capacity: slot.capacity ?? null }));
    expect(filterSimulatorSessionsForSearch({ ...input, preferredOfferings: [{ offeringId: "owned-offering", rank: 1 }] }, sessions, input.timeZone)).toHaveLength(59);
    expect(f.close).toHaveBeenCalledTimes(2); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("requires the native local capability and canonical request context before any session or data read", async () => {
    const f = fixture();
    await expect(inspectExistingAdapter(source, { ...f.deps, localCapabilities: [] })).rejects.toThrow("LOCAL_CHROME_REQUIRED");
    await expect(inspectExistingAdapter(source, { ...f.deps, requestedInput: undefined })).rejects.toThrow("MINDBODY_REQUEST_CONTEXT_REQUIRED");
    expect(await executeAccessRecipe(recipe(), input, { ...f.deps, localCapabilities: [] })).toMatchObject({ complete: false, evidence: { reason: "LOCAL_CHROME_REQUIRED" } });
    expect(f.createMindbodySession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each([{ durationMinutes: 30 }, { players: 5 }, { timeZone: "America/Chicago" }])("rejects incompatible inputs before starting a browser: %j", async change => {
    const f = fixture();
    expect(await executeAccessRecipe(recipe(), { ...input, ...change }, f.deps)).toMatchObject({ complete: false, evidence: { reason: expect.stringMatching(/ADAPTER_TARGET_MISMATCH|INVALID_REQUEST_DATE_OR_ZONE/u) } });
    expect(f.createMindbodySession).not.toHaveBeenCalled();
  });
  it("freshly rejects a changed catalog before reading availability", async () => {
    const current = catalog(); current.service.description = "Bring 2 guests at no additional charge.";
    const f = fixture(current);
    expect(await executeAccessRecipe(recipe(), input, f.deps)).toMatchObject({ complete: false, slots: [] });
    expect(f.close).toHaveBeenCalledOnce(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("never reports EMPTY from a partial raw/current rendered document", async () => {
    const current = grid(); current.completion!.pendingRelevantRequests = 1;
    const f = fixture(catalog(), current);
    expect(await executeAccessRecipe(recipe(), input, f.deps)).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("does not reinterpret a different Mindbody path as a self-hosted adapter", async () => {
    const f = fixture();
    await expect(inspectExistingAdapter({ ...source, officialUrl: "https://clients.mindbodyonline.com/", bookingUrl: "https://clients.mindbodyonline.com/ASP/appt_req.asp" }, f.deps))
      .rejects.toThrow("UNSUPPORTED_ADAPTER_SOURCE");
    expect(f.createMindbodySession).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled();
  });
  it("keeps direct execution input binding even if the caller skips recipe parsing", async () => {
    const value = recipe(); if (value.engine !== "EXISTING_ADAPTER") throw new Error("WRONG_ENGINE");
    const f = fixture();
    expect(await executeExistingAdapterRecipe(value, { ...input, durationMinutes: 30 }, f.deps)).toMatchObject({ complete: false, evidence: { reason: "ADAPTER_TARGET_MISMATCH" } });
    expect(f.createMindbodySession).not.toHaveBeenCalled();
  });
});
