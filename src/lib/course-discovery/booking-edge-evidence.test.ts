import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBookingEdgeEvidence, bookingEdgeEvidenceSchema } from "./booking-edge-evidence";
import { registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
const root = "https://official.example/", target = "https://public.book.teeitup.com/";
function page(markup = `<iframe src="${target}"></iframe>`): OfficialIdentityPage {
  return { url: root + "tee-times/", html: `<html><body>${markup}</body></html>`, browserTransport: "NATIVE_CHROME",
    visibleEvidence: { title: "Public", headings: [], addressTexts: [], linkUrls: [],
      delegatedFrameSources: { rows: [{ src: target, visible: true, srcdoc: false, inForm: false }], omitted: false } } };
}
afterEach(() => vi.restoreAllMocks());
describe("failure-only booking edge structure", () => {
  it("distinguishes absence, conflict, hidden frames, omitted metadata and capture disagreement without retaining content", () => {
    const absent = page(""); absent.visibleEvidence!.delegatedFrameSources!.rows = [];
    expect(collectBookingEdgeEvidence(absent, target, root)).toMatchObject({ raw: { frameCount: 0 }, rendered: { frameCount: 0 } });
    const conflict = page(`<iframe src="${target}"></iframe><iframe src="https://other.example/"></iframe>`);
    conflict.visibleEvidence!.delegatedFrameSources!.rows.push({ src: "https://other.example/", visible: true, srcdoc: false, inForm: false });
    expect(collectBookingEdgeEvidence(conflict, target, root)).toMatchObject({ raw: { frameCount: 2, requestedFrameCount: 1 },
      rendered: { frameCount: 2, visibleFrameCount: 2, requestedFrameCount: 1 } });
    const hidden = page(`<div hidden><iframe src="${target}"></iframe></div>`);
    hidden.visibleEvidence!.delegatedFrameSources!.rows[0].visible = false;
    expect(collectBookingEdgeEvidence(hidden, target, root)).toMatchObject({ raw: { hiddenFrameCount: 1 }, rendered: { hiddenFrameCount: 1, visibleFrameCount: 0 } });
    const omitted = page(); omitted.visibleEvidence!.delegatedFrameSources!.omitted = true;
    expect(collectBookingEdgeEvidence(omitted, target, root)).toMatchObject({ rendered: { framesState: "OMITTED", frameCount: null } });
    const mismatch = page(); mismatch.visibleEvidence!.delegatedFrameSources!.rows[0].src = "https://different.example/?token=PRIVATE";
    expect(collectBookingEdgeEvidence(mismatch, target, root)).toMatchObject({ raw: { requestedFrameCount: 1 }, rendered: { requestedFrameCount: 0, matchingRawSourceCount: 0 } });
    expect(JSON.stringify(collectBookingEdgeEvidence(mismatch, target, root))).not.toMatch(/https:|PRIVATE|iframe|token/u);
  });
  it("retains real capture time and distinguishes fresh native objects from copied, changed or expired captures", () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const capturedAt = new Date(now).toISOString(), p = registerFreshNativeDelegatedDocument(page(), root, new Date(now + 60000));
    expect(collectBookingEdgeEvidence(p, target, root)).toMatchObject({ attestedAt: capturedAt, provenance: "NATIVE_DELEGATED", freshNativeCapture: true });
    expect(collectBookingEdgeEvidence(structuredClone(p), target, root)).toMatchObject({ attestedAt: null, provenance: "UNATTESTED", freshNativeCapture: false });
    now += 30001;
    expect(collectBookingEdgeEvidence(p, target, root)).toMatchObject({ attestedAt: capturedAt, freshNativeCapture: false });
    p.html += " changed";
    expect(collectBookingEdgeEvidence(p, target, root).freshNativeCapture).toBe(false);
  });
  it("bounds documents and traversal while excluding all text, scripts, form values and URLs", () => {
    const p = page('<script>PRIVATE_COOKIE</script><form><input value="SECRET"><iframe src="https://private.example/?session=TOKEN" srcdoc="PRIVATE_BODY"></iframe></form>');
    const evidence = collectBookingEdgeEvidence(p, target, root);
    expect(evidence.raw).toMatchObject({ formFrameCount: 1, srcdocFrameCount: 1 });
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|SECRET|TOKEN|https:|session|script/u);
    p.html = "x".repeat(600001);
    expect(collectBookingEdgeEvidence(p, target, root).raw).toMatchObject({ bounded: false, omitted: true });
    p.html = "<div>".repeat(20001) + "</div>".repeat(20001);
    expect(collectBookingEdgeEvidence(p, target, root).raw.omitted).toBe(true);
    // A broad document separately exercises the total-node bound.
    p.html = "<p>x</p>".repeat(11000);
    expect(collectBookingEdgeEvidence(p, target, root).raw.omitted).toBe(true);
  });
  it("keeps unavailable and malformed observations distinct from a complete empty result", () => {
    const p = page(); delete p.visibleEvidence!.delegatedFrameSources;
    expect(collectBookingEdgeEvidence(p, target, root).rendered.framesState).toBe("ABSENT");
    p.visibleEvidence!.delegatedFrameSources = { rows: [], omitted: false };
    expect(collectBookingEdgeEvidence(p, target, root).rendered).toMatchObject({ framesState: "COMPLETE", frameCount: 0 });
    (p.visibleEvidence!.delegatedFrameSources as unknown as Record<string, unknown>).secret = "PRIVATE";
    expect(collectBookingEdgeEvidence(p, target, root).rendered).toMatchObject({ framesState: "MALFORMED", frameCount: null });
    expect(bookingEdgeEvidenceSchema.safeParse({ ...collectBookingEdgeEvidence(p, target, root), html: "PRIVATE" }).success).toBe(false);
  });
});
