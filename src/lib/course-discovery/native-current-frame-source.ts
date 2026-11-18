import { createHash } from "node:crypto";
import { parse, defaultTreeAdapter, type DefaultTreeAdapterMap, type TreeAdapter } from "parse5";
import type { Page } from "@playwright/test";
import { z } from "zod";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { isFreshNativeDelegatedDocument } from "./native-official-page-attestation";

const framesSchema = z.object({ rows: z.array(z.object({ src: z.string().max(2048), visible: z.boolean(),
  srcdoc: z.boolean(), inForm: z.boolean() }).strict()).max(24), omitted: z.literal(false) }).strict();
const observationSchema = z.object({ documentUrl: z.string().url().max(2048), timeOrigin: z.number().finite().nonnegative(),
  frames: framesSchema }).strict();
const records = new WeakMap<OfficialIdentityPage, { root: string; pageUrl: string; src: string; hash: string; expiresAt: number }>();
const hash = (value: OfficialIdentityPage) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Fixed native DOM read only. No navigation, form values, scripts or body. */
export function collectNativeCurrentFrameObservation() {
  const nodes = Array.from(document.querySelectorAll("iframe[src]"));
  const frames: { rows: Array<{ src: string; visible: boolean; srcdoc: boolean; inForm: boolean }>; omitted: boolean } = { rows: [], omitted: nodes.length > 24 };
  if (!frames.omitted) for (const node of nodes) {
    const src = node.getAttribute("src") ?? "";
    if (src.length > 2048) { frames.omitted = true; break; }
    const box = node.getBoundingClientRect(); let visible = box.width > 0 && box.height > 0, current: Element | null = node, depth = 0;
    while (current && depth++ < 64) {
      const style = getComputedStyle(current);
      if (current.hasAttribute("hidden") || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || style.opacity === "0") visible = false;
      current = current.parentElement;
    }
    frames.rows.push({ src, visible: visible && current === null, srcdoc: node.hasAttribute("srcdoc"), inForm: Boolean(node.closest("form")) });
  }
  return { documentUrl: document.URL, timeOrigin: performance.timeOrigin, frames };
}

/** Deliberately restricted to a response with no real iframe at all. Existing
 * hidden, conflicting, form or srcdoc markup cannot acquire a new exception. */
function noResponseFrame(html: string) {
  if (html.length > 600000) return false;
  const limit = new Error("CURRENT_FRAME_STRUCTURE_LIMIT"), depths = new WeakMap<DefaultTreeAdapterMap["node"], number>(); let allocated = 0;
  const attach = (parent: DefaultTreeAdapterMap["node"], child: DefaultTreeAdapterMap["node"]) => {
    const depth = (depths.get(parent) ?? 0) + 1; if (depth > 128) throw limit; depths.set(child, depth);
  };
  const adapter: TreeAdapter<DefaultTreeAdapterMap> = { ...defaultTreeAdapter,
    createElement(...args) { if (++allocated > 20000 || args[0] === "iframe") throw limit; return defaultTreeAdapter.createElement(...args); },
    appendChild(parent, child) { attach(parent, child); defaultTreeAdapter.appendChild(parent, child); },
    insertBefore(parent, child, reference) { attach(parent, child); defaultTreeAdapter.insertBefore(parent, child, reference); },
  };
  try { parse(html, { treeAdapter: adapter }); return true; }
  catch (error) { if (error !== limit) throw error; return false; }
}

/** Called only by the fixed native document reader after its existing status,
 * provenance, access, URL and freshness checks. A second native observation
 * corroborates the one visible current frame in the same main document. */
export async function captureNativeCurrentFrameSource(page: Pick<Page, "url" | "evaluate">, captured: OfficialIdentityPage,
  root: string, timeOrigin: number, deadlineAt: Date) {
  const metadata = framesSchema.safeParse(captured.visibleEvidence?.delegatedFrameSources);
  if (captured.browserTransport !== "NATIVE_CHROME" || !metadata.success || metadata.data.rows.length !== 1 ||
      !metadata.data.rows[0].visible || metadata.data.rows[0].srcdoc || metadata.data.rows[0].inForm || !noResponseFrame(captured.html)) return captured;
  if (page.url() !== captured.url || Date.now() >= deadlineAt.getTime()) throw Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  const observation = observationSchema.safeParse(await page.evaluate(collectNativeCurrentFrameObservation));
  const end = await page.evaluate(() => ({ documentUrl: document.URL, timeOrigin: performance.timeOrigin }));
  if (!observation.success || observation.data.documentUrl !== captured.url || observation.data.timeOrigin !== timeOrigin ||
      end.documentUrl !== captured.url || end.timeOrigin !== timeOrigin || page.url() !== captured.url || Date.now() >= deadlineAt.getTime() ||
      JSON.stringify(observation.data.frames) !== JSON.stringify(metadata.data)) throw Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  records.set(captured, { root, pageUrl: captured.url, src: metadata.data.rows[0].src, hash: hash(captured),
    expiresAt: Math.min(deadlineAt.getTime(), Date.now() + 30000) });
  return captured;
}

/** Original-object proof only, never a serialized recipe or diagnostic fact. */
export function hasNativeCurrentFrameSource(page: OfficialIdentityPage, root: string, next: string) {
  const proof = records.get(page);
  if (!proof || proof.root !== root || proof.pageUrl !== page.url || proof.expiresAt <= Date.now() ||
      proof.hash !== hash(page) || !isFreshNativeDelegatedDocument(page, root)) return false;
  try { return new URL(proof.src, page.url).href === next; } catch { return false; }
}
