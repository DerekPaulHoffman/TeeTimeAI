import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { runInContext } from "node:vm";
import { captureNativeCurrentFrameSource, collectNativeCurrentFrameObservation, hasNativeCurrentFrameSource } from "./native-current-frame-source";
import { authorizeDelegatedGet, consumeDelegatedGet } from "./teeitup-delegated-booking-context";
import { registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

const root = "https://official.example/", entry = root + "tee-times/", next = "https://public.book.teeitup.com/";
function fixture() {
  const frames = { rows: [{ src: next, visible: true, srcdoc: false, inForm: false }], omitted: false };
  const captured: OfficialIdentityPage = { url: entry, html: "<html><body>Public booking</body></html>", browserTransport: "NATIVE_CHROME",
    visibleEvidence: { title: "Public", headings: [], addressTexts: [], linkUrls: [], delegatedFrameSources: frames } };
  const observation = { documentUrl: entry, timeOrigin: 123, frames: structuredClone(frames) };
  const end = { documentUrl: entry, timeOrigin: 123 };
  const evaluate = vi.fn().mockResolvedValueOnce(observation).mockResolvedValueOnce(end);
  return { captured, observation, end, evaluate, page: { url: () => entry, evaluate } };
}
afterEach(() => vi.restoreAllMocks());
describe("native JavaScript-created exact public frame", () => {
  it("earns one final GET only after independent current native evidence matches the exact visible source", async () => {
    const f = fixture(), deadline = new Date(Date.now() + 60000);
    registerFreshNativeDelegatedDocument(f.captured, root, deadline);
    expect(() => authorizeDelegatedGet(f.captured, root, deadline, next)).toThrow();
    await captureNativeCurrentFrameSource(f.page as never, f.captured, root, 123, deadline);
    expect(hasNativeCurrentFrameSource(f.captured, root, next)).toBe(true);
    const grant = authorizeDelegatedGet(f.captured, root, deadline, next);
    expect(consumeDelegatedGet(grant.token).url).toBe(next);
    expect(() => consumeDelegatedGet(grant.token)).toThrow();
    expect(f.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(["copied", "mutated", "expired", "foreignRoot", "otherTarget", "noNativeAttestation"])("does not accept %s proof", async variant => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture(), deadline = new Date(now + 60000);
    await captureNativeCurrentFrameSource(f.page as never, f.captured, root, 123, deadline);
    if (variant !== "noNativeAttestation") registerFreshNativeDelegatedDocument(f.captured, root, deadline);
    const captured = variant === "copied" ? structuredClone(f.captured) : f.captured;
    if (variant === "mutated") captured.html += "changed";
    if (variant === "expired") now += 30001;
    expect(hasNativeCurrentFrameSource(captured, variant === "foreignRoot" ? "https://other.example/" : root,
      variant === "otherTarget" ? "https://other.book.teeitup.com/" : next)).toBe(false);
    expect(() => authorizeDelegatedGet(captured, variant === "foreignRoot" ? "https://other.example/" : root,
      new Date(now + 30000), variant === "otherTarget" ? "https://other.book.teeitup.com/" : next)).toThrow();
  });

  it.each(["documentUrl", "timeOrigin", "endDocumentUrl", "endTimeOrigin", "pageUrl", "deadline", "src",
    "visible", "srcdoc", "inForm", "multiple", "omitted", "malformed"])("rejects native capture drift: %s", async variant => {
    const f = fixture(), deadline = new Date(Date.now() + 60000);
    if (variant === "documentUrl") f.observation.documentUrl = root;
    if (variant === "timeOrigin") f.observation.timeOrigin++;
    if (variant === "endDocumentUrl") f.end.documentUrl = root;
    if (variant === "endTimeOrigin") f.end.timeOrigin++;
    if (variant === "pageUrl") f.page.url = () => root;
    if (variant === "deadline") deadline.setTime(Date.now() - 1);
    if (variant === "src") f.observation.frames.rows[0].src = "https://other.book.teeitup.com/";
    if (variant === "visible") f.observation.frames.rows[0].visible = false;
    if (variant === "srcdoc") f.observation.frames.rows[0].srcdoc = true;
    if (variant === "inForm") f.observation.frames.rows[0].inForm = true;
    if (variant === "multiple") f.observation.frames.rows.push({ ...f.observation.frames.rows[0] });
    if (variant === "omitted") f.observation.frames.omitted = true;
    if (variant === "malformed") Object.assign(f.observation, { body: "untrusted" });
    await expect(captureNativeCurrentFrameSource(f.page as never, f.captured, root, 123, deadline)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    registerFreshNativeDelegatedDocument(f.captured, root, new Date(Date.now() + 60000));
    expect(hasNativeCurrentFrameSource(f.captured, root, next)).toBe(false);
  });

  it.each(["rawFrame", "rawHidden", "rawForm", "rawSrcdoc", "rawNoSrc", "tooLarge", "tooDeep", "tooMany",
    "nonNative", "missing", "hidden", "form", "srcdoc", "multiple", "omitted", "overlong", "malformed"])
  ("does not even capture a new witness for disallowed input: %s", async variant => {
    const f = fixture(), rows = f.captured.visibleEvidence!.delegatedFrameSources!.rows;
    if (variant === "rawFrame") f.captured.html = '<iframe src="' + next + '"></iframe>';
    if (variant === "rawHidden") f.captured.html = '<div hidden><iframe src="' + next + '"></iframe></div>';
    if (variant === "rawForm") f.captured.html = '<form><iframe src="' + next + '"></iframe></form>';
    if (variant === "rawSrcdoc") f.captured.html = '<iframe srcdoc="" src="' + next + '"></iframe>';
    if (variant === "rawNoSrc") f.captured.html = '<iframe></iframe>';
    if (variant === "tooLarge") f.captured.html = " ".repeat(600001);
    if (variant === "tooDeep") f.captured.html = "<div>".repeat(150) + "</div>".repeat(150);
    if (variant === "tooMany") f.captured.html = "<br>".repeat(20001);
    if (variant === "nonNative") f.captured.browserTransport = undefined;
    if (variant === "missing") rows.length = 0;
    if (variant === "hidden") rows[0].visible = false;
    if (variant === "form") rows[0].inForm = true;
    if (variant === "srcdoc") rows[0].srcdoc = true;
    if (variant === "multiple") rows.push({ ...rows[0] });
    if (variant === "omitted") f.captured.visibleEvidence!.delegatedFrameSources!.omitted = true;
    if (variant === "overlong") rows[0].src = "x".repeat(2049);
    if (variant === "malformed") Object.assign(rows[0], { body: "untrusted" });
    expect(await captureNativeCurrentFrameSource(f.page as never, f.captured, root, 123, new Date(Date.now() + 60000))).toBe(f.captured);
    expect(f.evaluate).not.toHaveBeenCalled();
    registerFreshNativeDelegatedDocument(f.captured, root, new Date(Date.now() + 60000));
    expect(hasNativeCurrentFrameSource(f.captured, root, next)).toBe(false);
  });

  it("retains conflicting genuine anchor ambiguity after current-frame capture", async () => {
    const f = fixture(), other = root + "other/", deadline = new Date(Date.now() + 60000);
    f.captured.html = '<html><body><a href="' + other + '">Book Tee Times</a></body></html>';
    f.captured.visibleEvidence!.linkUrls.push(other);
    await captureNativeCurrentFrameSource(f.page as never, f.captured, root, 123, deadline);
    registerFreshNativeDelegatedDocument(f.captured, root, deadline);
    expect(hasNativeCurrentFrameSource(f.captured, root, next)).toBe(true);
    expect(() => authorizeDelegatedGet(f.captured, root, deadline, next)).toThrow();
  });

  it("serializes the fixed DOM read without a closure and sees JavaScript-created frames and forbidden ancestors", () => {
    const dom = new JSDOM('<style>*{opacity:1}</style><body><div id="host"></div></body>', { url: entry, runScripts: "outside-only" });
    try {
      dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 }) as DOMRect;
      const host = dom.window.document.getElementById("host")!;
      host.innerHTML = '<iframe src="' + next + '"></iframe><div hidden><iframe src="' + next + '"></iframe></div>' +
        '<form><iframe src="' + next + '"></iframe></form><iframe srcdoc="" src="' + next + '"></iframe>';
      const observed = runInContext('(' + collectNativeCurrentFrameObservation.toString() + ')()', dom.getInternalVMContext());
      expect(observed).toMatchObject({ documentUrl: entry, frames: { omitted: false, rows: [
        { src: next, visible: true, srcdoc: false, inForm: false }, { src: next, visible: false, srcdoc: false, inForm: false },
        { src: next, visible: true, srcdoc: false, inForm: true }, { src: next, visible: true, srcdoc: true, inForm: false },
      ] } });
      host.innerHTML = ('<iframe src="' + next + '"></iframe>').repeat(25);
      expect(runInContext('(' + collectNativeCurrentFrameObservation.toString() + ')()', dom.getInternalVMContext()).frames)
        .toEqual({ rows: [], omitted: true });
    } finally { dom.window.close(); }
  });
});
