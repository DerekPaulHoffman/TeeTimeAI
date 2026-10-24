// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import { inspectMindbodyPublicRentalCatalog, type MindbodyCatalogEvidence, type MindbodyGridEvidence } from "./mindbody-appointment-grid";
import { executeMindbodyAppointments, getMindbodyAppointmentDiagnostic, inspectMindbodyAppointments, type MindbodyAppointmentReaderDeps } from "./mindbody-appointment-reader";

const source = observed.source, input = observed.input;
function catalog(): MindbodyCatalogEvidence { return { ...structuredClone(observed.catalogObserved), captureId: "fixed-capture",
  category: { ...observed.catalogObserved.category, enabled: true, selected: true },
  service: { ...observed.catalogObserved.service, enabled: true, selected: true },
  resources: observed.catalogObserved.resources.map(row => ({ ...row, enabled: true })) }; }
function grid(): MindbodyGridEvidence {
  const evidence: MindbodyGridEvidence = { ...structuredClone(observed.gridObserved), captureId: "fixed-capture" };
  const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  // Synthetic completion layout, never presented as real provider evidence.
  const html = '<html><body><p>Saturday 10/24/2026</p><p>Instructors 1-6</p><table><tr>' + evidence.resourceHeaders.map(row =>
    '<th><a class="instructorLink" href="' + escape(row.href) + '">' + row.label + '</a></th>').join("") +
    '</tr><tr><td>5:00 am</td></tr>' + evidence.anchors.map(row => '<tr><td><a class="apptLink" href="' + escape(row.href) + '">' + row.label + '</a></td></tr>').join("") +
    '<tr><td>10:00 pm</td></tr></table></body></html>';
  evidence.completion = { responseUrl: evidence.url, status: 200, contentType: "text/html", rawHtml: html, renderedHtml: html,
    bodyComplete: true, documentUnchanged: true, pendingRelevantRequests: 0, truncated: false, signedOut: true };
  return evidence;
}
function fake() {
  const close = vi.fn(async () => {}), readCatalog = vi.fn(async () => catalog()), readGrid = vi.fn(async () => grid());
  const execute = vi.fn(async () => ({ navigationStatus: 200 }));
  const createSession = vi.fn(async () => ({ execute, readMindbodyPublicCatalog: readCatalog, readMindbodyPublicGrid: readGrid, close }));
  const deps: MindbodyAppointmentReaderDeps = { createSession: createSession as unknown as MindbodyAppointmentReaderDeps["createSession"],
    localCapabilities: ["LOCAL_CHROME"], now: () => new Date("2026-10-23T00:00:00Z") };
  return { deps, createSession, close, execute, readCatalog, readGrid };
}
const metadata = () => inspectMindbodyPublicRentalCatalog(source, catalog()).metadata;
describe("fixed native Mindbody appointment reader", () => {
  it("binds only closed nested capture diagnostics to the exact original failure before cleanup", async () => {
    const f = fake(), primary = new Error("MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH"), session = await f.createSession();
    const comparison = { fieldsEqual: { title: true, bodyText: false, locationId: true, studioId: true, venueAddress: true, categories: true, services: true, resources: true },
      rawCounts: { categories: 3, services: 0, resources: 0 }, renderedCounts: { categories: 3, services: 0, resources: 0 },
      rawTextLengths: { title: 9, bodyText: 400, locationId: 1, studioId: 6, venueAddress: 50 },
      renderedTextLengths: { title: 9, bodyText: 410, locationId: 1, studioId: 6, venueAddress: 50 } };
    const capture = { stage: "COMPARE_CATALOG", readyState: "complete", nativeDocumentCurrent: true, rawBytes: 150000, catalogComparison: comparison,
      text: "PRIVATE_VALUE", url: "https://private.example/?token=PRIVATE", CSRFToken: "PRIVATE" };
    const diagnostics = vi.fn(() => ({ mindbodyCapture: capture }));
    f.deps.createSession = async () => ({ ...session, diagnostics }); f.readCatalog.mockRejectedValueOnce(primary);
    f.close.mockImplementationOnce(async () => { capture.stage = "PRIVATE_VALUE"; comparison.fieldsEqual.bodyText = true; throw Error("PRIVATE_CLEANUP"); });
    await expect(inspectMindbodyAppointments(source, input, f.deps)).rejects.toBe(primary);
    expect(diagnostics.mock.invocationCallOrder[0]).toBeLessThan(f.close.mock.invocationCallOrder[0]);
    const result = getMindbodyAppointmentDiagnostic(primary)!;
    expect(result).toMatchObject({ stage: "COMPARE_CATALOG", readyState: "complete", nativeDocumentCurrent: true, rawBytes: 150000,
      catalogComparison: { fieldsEqual: { bodyText: false }, rawCounts: { categories: 3 } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|https|token|CSRF|url|text"/u);
    result.catalogComparison!.fieldsEqual.bodyText = true; result.catalogComparison!.rawCounts.categories = 99;
    expect(getMindbodyAppointmentDiagnostic(primary)?.catalogComparison).toMatchObject({ fieldsEqual: { bodyText: false }, rawCounts: { categories: 3 } });
    expect(getMindbodyAppointmentDiagnostic(new Error(primary.message))).toBeUndefined(); expect(getMindbodyAppointmentDiagnostic({})).toBeUndefined();
  });
  it("preserves exact errors and cleanup when diagnostic collection throws or yields malformed values", async () => {
    for (const bad of ["throws", "malformed"] as const) {
      const f = fake(), primary = new Error("MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH"), session = await f.createSession();
      f.deps.createSession = async () => ({ ...session, diagnostics: () => {
        if (bad === "throws") throw Error("PRIVATE_TOKEN");
        return { mindbodyCapture: { stage: { toString: () => "COMPARE_CATALOG", private: "PRIVATE" }, rawBytes: "PRIVATE", catalogComparison: { fieldsEqual: "PRIVATE" } } };
      } });
      f.readCatalog.mockRejectedValueOnce(primary); await expect(inspectMindbodyAppointments(source, input, f.deps)).rejects.toBe(primary);
      expect(f.close).toHaveBeenCalledOnce(); expect(getMindbodyAppointmentDiagnostic(primary)).toBeUndefined();
    }
  });
  it("requires native capability and trusted duration before any browser factory", async () => {
    const f = fake(); f.deps.localCapabilities = [];
    await expect(inspectMindbodyAppointments(source, input, f.deps)).rejects.toThrow("LOCAL_CHROME_REQUIRED");
    await expect(executeMindbodyAppointments(source, metadata(), { courseId: "canonical", offeringId: "rental" }, input, f.deps)).rejects.toThrow("LOCAL_CHROME_REQUIRED");
    f.deps.localCapabilities = ["LOCAL_CHROME"];
    await expect(inspectMindbodyAppointments(source, undefined, f.deps)).rejects.toThrow("MINDBODY_REQUEST_CONTEXT_REQUIRED");
    await expect(inspectMindbodyAppointments(source, { ...input, durationMinutes: undefined }, f.deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it("inspects fresh public catalog with private input and closes before returning", async () => {
    const f = fake(), result = await inspectMindbodyAppointments(source, input, f.deps);
    expect(result).toEqual(metadata()); expect(f.readGrid).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
    const call = f.createSession.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(call[0]).toMatchObject({ requestedInput: input, initialUrls: [source.bookingUrl] });
    expect(call[1]).toEqual({ browserTransport: "NATIVE_CHROME", fixedReaderProfile: "MINDBODY_APPOINTMENTS", localCapabilities: ["LOCAL_CHROME"] });
    expect(JSON.stringify(result)).not.toMatch(/captureId|requestedInput|rawHtml/u);
  });
  it("reopens, revalidates and reads only actual explicit starts on each execution", async () => {
    const f = fake(), result = await executeMindbodyAppointments(source, metadata(), { courseId: "canonical", offeringId: "rental", kind: "SIMULATOR" }, input, f.deps);
    expect(result).toHaveLength(59); expect(f.readCatalog).toHaveBeenCalledOnce(); expect(f.readGrid).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce(); expect(result.every(row => row.bookingUrl === source.bookingUrl && row.availableSpots === 1 && row.capacity === 4)).toBe(true);
    expect(result.every(row => new Date(row.endsAt!).getTime() - new Date(row.startsAt).getTime() === 3_600_000)).toBe(true);
    expect(result.some(row => row.bookingUrl.includes("appt_req"))).toBe(false);
  });
  it("rejects changed explicit saved metadata before grid reads", async () => {
    const f = fake();
    await expect(executeMindbodyAppointments(source, { ...metadata(), catalogHash: "0".repeat(64) }, { courseId: "canonical", offeringId: "rental" }, input, f.deps))
      .rejects.toThrow("ADAPTER_CONFIGURATION_CHANGED");
    expect(f.readGrid).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
  it("requires a canonical simulator offering even when the reader is called directly", async () => {
    const f = fake();
    await expect(executeMindbodyAppointments(source, metadata(), { courseId: "canonical" }, input, f.deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
    expect(f.createSession).not.toHaveBeenCalled();
  });
  it("missing completion is incomplete, never EMPTY", async () => {
    const f = fake(); f.readGrid.mockImplementation(async () => { const result = grid(); delete result.completion; return result; });
    await expect(executeMindbodyAppointments(source, metadata(), { courseId: "canonical", offeringId: "rental" }, input, f.deps)).rejects.toThrow("MINDBODY_GRID_COMPLETION_WITNESS_MISSING");
    expect(f.close).toHaveBeenCalledOnce();
  });
  it("bounds the real lifetime to original deadline and preserves shared lease", async () => {
    const f = fake(), deadlineAt = new Date(Date.now() + 40_000), lease = vi.fn(async (_family, work) => ({ acquired: true as const, value: await work() }));
    f.deps.deadlineAt = deadlineAt; f.deps.requestLease = lease; await inspectMindbodyAppointments(source, input, f.deps);
    const args = f.createSession.mock.calls[0] as unknown as [Record<string, unknown>, DiscoveryDeps];
    expect(args[0].deadlineAt).toEqual(deadlineAt); expect(await args[1].requestLease!("MINDBODY", async () => 3)).toEqual({ acquired: true, value: 3 });
    const expired = fake(); expired.deps.deadlineAt = new Date(Date.now() - 1);
    await expect(inspectMindbodyAppointments(source, input, expired.deps)).rejects.toThrow("DEADLINE_EXCEEDED"); expect(expired.createSession).not.toHaveBeenCalled();
  });
  it.each(["ACCESS_REQUIRED", "MINDBODY_GRID_CONTEXT_MISMATCH", "MINDBODY_GRID_DOCUMENT_INCOMPLETE"])("preserves primary %s across cleanup failure", async code => {
    const f = fake(); f.readCatalog.mockRejectedValueOnce(new Error(code)); f.close.mockRejectedValueOnce(new Error("cleanup"));
    await expect(inspectMindbodyAppointments(source, input, f.deps)).rejects.toThrow(code); expect(f.close).toHaveBeenCalledOnce();
  });
});
type DiscoveryDeps = NonNullable<Parameters<NonNullable<MindbodyAppointmentReaderDeps["createSession"]>>[1]>;
