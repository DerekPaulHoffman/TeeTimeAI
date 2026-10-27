import { z } from "zod";
import { isSafeRecipeUrl } from "./recipe";

/** Trusted local fixed inspection input. Historical routing alone never admits a read. */
export const fixedInspectionFrameWitnessSchema = z.object({
  kind: z.literal("FIXED_INSPECTION_SOURCE_FRAME"),
  officialUrl: z.string().min(1).max(2048),
  parentUrl: z.string().min(1).max(2048),
  frameUrl: z.string().min(1).max(2048),
  sourceReportSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(value => [value.officialUrl, value.parentUrl, value.frameUrl].every(url => {
  try { return new URL(url).href === url && isSafeRecipeUrl(url); } catch { return false; }
}) && value.parentUrl !== value.frameUrl);
export type FixedInspectionFrameWitness = z.infer<typeof fixedInspectionFrameWitnessSchema>;

export type FixedInspectionDomFrame = { src: string; visible: boolean; srcdoc: boolean; inForm: boolean; handler: boolean };
export function tagFreshInspectionFrame(rows: Array<{ url: string; source?: "OFFICIAL_IFRAME_SRC" | "FIXED_INSPECTION_FRAME_SRC" }>,
  frameUrl: string): boolean {
  const existing = rows.find(row => row.url === frameUrl);
  if (existing) { existing.source = "FIXED_INSPECTION_FRAME_SRC"; return true; }
  if (rows.length >= 10) return false;
  rows.push({ url: frameUrl, source: "FIXED_INSPECTION_FRAME_SRC" });
  return true;
}
/** Self-contained page callback: production tsx serializes it into Playwright. */
export function visibleInspectionFrames(nodes: Element[]): FixedInspectionDomFrame[] {
  const rows: FixedInspectionDomFrame[] = [];
  for (const node of nodes.slice(0, 21)) {
    const frame = node as HTMLIFrameElement, rect = frame.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0, ancestor: Element | null = frame;
    for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) visible = false;
    }
    let handler = false;
    for (const name of frame.getAttributeNames()) if (name.toLowerCase().startsWith("on")) { handler = true; break; }
    rows.push({ src: (frame.getAttribute("src") ?? "").slice(0, 2049), visible: visible && !ancestor,
      srcdoc: frame.hasAttribute("srcdoc"), inForm: Boolean(frame.closest("form")), handler });
  }
  return rows;
}
/** Exactly one matching current DOM source is necessary; duplicates fail closed. */
export function exactFreshInspectionFrame(rows: readonly FixedInspectionDomFrame[], witness: FixedInspectionFrameWitness,
  currentUrl: string): boolean {
  if (currentUrl !== witness.parentUrl || rows.length > 20 || !isSafeRecipeUrl(currentUrl)) return false;
  const matches = rows.filter(row => {
    try { return new URL(row.src, currentUrl).href === witness.frameUrl; } catch { return false; }
  });
  return matches.length === 1 && matches[0].visible === true && matches[0].srcdoc === false &&
    matches[0].inForm === false && matches[0].handler === false;
}
