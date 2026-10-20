import type { Page } from "@playwright/test";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";
import { parseTeeItUpRecipeSource } from "./teeitup-recipe-source";
import { parseLightspeedSource } from "./lightspeed-source";
import { isSafeRecipeUrl } from "./recipe";

/** Promote a source attribute, never a child frame's current/redirected URL. */
export function publicFrameSource(input: { src: string; label: string; visible: boolean; srcdoc: boolean },
  documentUrl: string, officialUrl: string, verifiedDocumentUrl: string): string | undefined {
  try {
    const current = new URL(documentUrl), official = new URL(officialUrl);
    if (!input.visible || input.srcdoc || ![documentUrl, officialUrl, verifiedDocumentUrl].every(isSafeRecipeUrl) || current.origin !== official.origin || current.protocol !== "https:" ||
        verifiedDocumentUrl.split("#", 1)[0] !== current.href.split("#", 1)[0] || !input.src.trim()) return;
    const url = new URL(input.src, current).href;
    const knownEntry = Boolean(parseTeeItUpRecipeSource(url) || parseLightspeedSource(url));
    const labelled = /\b(?:tee\s*times?|booking|availability|book\s+(?:a\s+)?bay|simulator\s+rentals?)\b/iu.test(input.label);
    if ((!knownEntry && !labelled) || !isPublicAvailabilityNavigation(url, input.label || "Public tee time availability")) return;
    return url;
  } catch { return; }
}

export async function observedPublicFrameSources(page: Page, officialUrl: string, verifiedDocumentUrl: string) {
  const documentUrl = page.url();
  const frames = await page.locator("iframe[src]").evaluateAll(nodes => nodes.slice(0, 20).map(node => {
    const rect = node.getBoundingClientRect();
    let current: Element | null = node, visible = rect.width > 0 && rect.height > 0;
    for (let depth = 0; current && depth < 40; depth++, current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hasAttribute("hidden") || current.hasAttribute("inert") || current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" || style.opacity === "0") visible = false;
    }
    return { src: (node.getAttribute("src") ?? "").slice(0, 2049),
      label: `${node.getAttribute("title") ?? ""} ${node.getAttribute("aria-label") ?? ""}`.trim().slice(0, 161),
      visible: visible && !current && !node.closest("form"), srcdoc: node.hasAttribute("srcdoc") };
  }));
  return [...new Set(frames.map(frame => publicFrameSource(frame, documentUrl, officialUrl, verifiedDocumentUrl)).filter((url): url is string => Boolean(url)))].slice(0, 10);
}
