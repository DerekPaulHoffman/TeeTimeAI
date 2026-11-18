import { parse, defaultTreeAdapter, type DefaultTreeAdapterMap, type TreeAdapter } from "parse5";
import { z } from "zod";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { getNativePageObservationDiagnostic } from "./native-official-page-attestation";

const count = z.number().int().min(0).max(20000);
export const bookingEdgeEvidenceSchema = z.object({
  schemaVersion: z.literal(1), observedAt: z.string().datetime(), attestedAt: z.string().datetime().nullable(),
  provenance: z.enum(["NATIVE_ROOT", "NATIVE_DELEGATED", "UNATTESTED"]), freshNativeCapture: z.boolean(),
  raw: z.object({ bounded: z.boolean(), omitted: z.boolean(), anchorCount: count, requestedAnchorCount: count,
    unrenderedAnchorCount: count, frameCount: count, requestedFrameCount: count, hiddenFrameCount: count,
    formFrameCount: count, srcdocFrameCount: count }).strict(),
  rendered: z.object({ linkCount: count, linkListAtLimit: z.boolean(), requestedLinkPresent: z.boolean(),
    framesState: z.enum(["ABSENT", "MALFORMED", "OMITTED", "COMPLETE"]), frameCount: count.nullable(),
    visibleFrameCount: count.nullable(), requestedFrameCount: count.nullable(), hiddenFrameCount: count.nullable(),
    formFrameCount: count.nullable(), srcdocFrameCount: count.nullable(), matchingRawSourceCount: count.nullable() }).strict(),
}).strict().refine(value => {
  const frameCounts = [value.rendered.frameCount, value.rendered.visibleFrameCount, value.rendered.requestedFrameCount,
    value.rendered.hiddenFrameCount, value.rendered.formFrameCount, value.rendered.srcdocFrameCount, value.rendered.matchingRawSourceCount];
  return (value.attestedAt === null || Date.parse(value.attestedAt) <= Date.parse(value.observedAt)) &&
    (value.provenance === "UNATTESTED" ? value.attestedAt === null && !value.freshNativeCapture : value.attestedAt !== null) &&
    frameCounts.every(count => value.rendered.framesState === "COMPLETE" ? count !== null && count <= 24 : count === null);
});
export type BookingEdgeEvidence = z.infer<typeof bookingEdgeEvidenceSchema>;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(value => value.name === key)?.value;
const frameSchema = z.object({ rows: z.array(z.object({ src: z.string().max(2048), visible: z.boolean(),
  srcdoc: z.boolean(), inForm: z.boolean() }).strict()).max(24), omitted: z.boolean() }).strict();

/** Failure evidence only. Parses the already-read inert document, never stores
 * its strings or grants a URL, request, source projection or replay authority. */
export function collectBookingEdgeEvidence(page: OfficialIdentityPage, requestedNext?: string, canonicalRoot?: string): BookingEdgeEvidence {
  const provenance = getNativePageObservationDiagnostic(page, canonicalRoot);
  const raw = { bounded: page.html.length <= 600000, omitted: false, anchorCount: 0, requestedAnchorCount: 0,
    unrenderedAnchorCount: 0, frameCount: 0, requestedFrameCount: 0, hiddenFrameCount: 0, formFrameCount: 0, srcdocFrameCount: 0 };
  const renderedLinks = page.visibleEvidence?.linkUrls ?? [];
  const resolve = (value: string | undefined) => { try { return value && value.length <= 2048 ? new URL(value, page.url).href : null; } catch { return null; } };
  const target = (value: string | undefined) => Boolean(requestedNext && resolve(value) === requestedNext);
  const rawFrameSources: string[] = [];
  let visited = 0;
  const text = (node: Node): string => {
    const pending = [node], parts: string[] = []; let count = 0, length = 0;
    while (pending.length) {
      if (++count > 1000 || length > 4000) { raw.omitted = true; break; }
      const current = pending.pop()!;
      if (current.nodeName === "#text") { const value = (current as DefaultTreeAdapterMap["textNode"]).value.slice(0, 4001); parts.push(value); length += value.length; }
      else if (!(element(current) && ["script", "style", "template", "noscript", "iframe"].includes(current.tagName)) && "childNodes" in current)
        pending.push(...current.childNodes.slice(0, 1001).reverse());
    }
    return parts.join(" ");
  };
  const visit = (node: Node, inheritedHidden = false, inForm = false, depth = 0) => {
    if (++visited > 20000 || depth > 128) { raw.omitted = true; return; }
    let hidden = inheritedHidden;
    if (element(node)) {
      hidden ||= ["hidden", "inert"].some(key => attr(node, key) !== undefined) || attr(node, "aria-hidden") === "true" ||
        /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "") ||
        /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-text|hide)(?:\s|$)/iu.test(attr(node, "class") ?? "");
      inForm ||= node.tagName === "form";
      if (["script", "style", "template", "noscript"].includes(node.tagName)) return;
      if (node.tagName === "iframe") {
        raw.frameCount++;
        raw.requestedFrameCount += Number(target(attr(node, "src")));
        raw.hiddenFrameCount += Number(hidden);
        raw.formFrameCount += Number(inForm);
        raw.srcdocFrameCount += Number(attr(node, "srcdoc") !== undefined);
        if (attr(node, "src") !== undefined) rawFrameSources.push(attr(node, "src")!);
        return;
      }
      if (node.tagName === "a" && !hidden && !inForm && /\b(?:tee\s*times?|book(?:ings?)?|reservations?|reserve)\b/iu.test(text(node))) {
        raw.anchorCount++;
        raw.requestedAnchorCount += Number(target(attr(node, "href")));
        raw.unrenderedAnchorCount += Number(!renderedLinks.includes(resolve(attr(node, "href")) ?? ""));
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) { if (raw.omitted) break; visit(child, hidden, inForm, depth + 1); }
  };
  if (raw.bounded) {
    const limit = new Error("DIAGNOSTIC_STRUCTURE_LIMIT"), depths = new WeakMap<Node, number>(); let allocated = 0;
    const beforeAttach = (parent: Node, child: Node) => {
      const depth = (depths.get(parent) ?? 0) + 1;
      if (depth > 128) throw limit;
      depths.set(child, depth);
    };
    const adapter: TreeAdapter<DefaultTreeAdapterMap> = { ...defaultTreeAdapter,
      createElement(...args) { if (++allocated > 20000) throw limit; return defaultTreeAdapter.createElement(...args); },
      appendChild(parent, child) { beforeAttach(parent, child); defaultTreeAdapter.appendChild(parent, child); },
      insertBefore(parent, child, reference) { beforeAttach(parent, child); defaultTreeAdapter.insertBefore(parent, child, reference); },
    };
    try { visit(parse(page.html, { treeAdapter: adapter })); }
    catch (error) { if (error !== limit) throw error; raw.omitted = true; }
  } else raw.omitted = true;
  const input = page.visibleEvidence?.delegatedFrameSources;
  const frames = frameSchema.safeParse(input);
  const framesState = input === undefined ? "ABSENT" : !frames.success ? "MALFORMED" : frames.data.omitted ? "OMITTED" : "COMPLETE";
  const rows = frames.success && !frames.data.omitted ? frames.data.rows : null;
  return bookingEdgeEvidenceSchema.parse({ schemaVersion: 1, observedAt: new Date(Date.now()).toISOString(), ...provenance, raw,
    rendered: { linkCount: Math.min(renderedLinks.length, 20000), linkListAtLimit: renderedLinks.length >= 120,
      requestedLinkPresent: Boolean(requestedNext && renderedLinks.includes(requestedNext)), framesState,
      frameCount: rows?.length ?? null, visibleFrameCount: rows?.filter(row => row.visible && !row.inForm && !row.srcdoc).length ?? null,
      requestedFrameCount: rows?.filter(row => target(row.src)).length ?? null,
      hiddenFrameCount: rows?.filter(row => !row.visible).length ?? null, formFrameCount: rows?.filter(row => row.inForm).length ?? null,
      srcdocFrameCount: rows?.filter(row => row.srcdoc).length ?? null,
      matchingRawSourceCount: rows?.filter(row => rawFrameSources.includes(row.src)).length ?? null } });
}
