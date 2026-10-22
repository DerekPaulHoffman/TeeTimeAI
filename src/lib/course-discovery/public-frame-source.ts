import type { Page } from "@playwright/test";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";
import { parseTeeItUpRecipeSource } from "./teeitup-recipe-source";
import { parseLightspeedSource } from "./lightspeed-source";
import { isSafeRecipeUrl } from "./recipe";
import { cpsPublicEntryUrl } from "./cps-public-navigation";
import type { PublicFrameParentProof } from "./public-booking-parent";

/** Promote a source attribute, never a child frame's current/redirected URL. */
export function publicFrameSource(input: { src: string; label: string; visible: boolean; srcdoc: boolean },
  documentUrl: string, officialUrl: string, verifiedDocumentUrl: string, parentProof?: PublicFrameParentProof): string | undefined {
  try {
    const current = new URL(documentUrl), official = new URL(officialUrl);
    const scopedParent = parentProof?.officialUrl === officialUrl && parentProof.documentUrl === documentUrl &&
      (parentProof.kind === "VERIFIED_OFFICIAL_DOCUMENT"
        ? current.hostname.replace(/^www\./u, "") === official.hostname.replace(/^www\./u, "")
        : parentProof.kind === "OBSERVED_PUBLIC_BOOKING_PARENT" && isSafeRecipeUrl(parentProof.officialDocumentUrl) && isSafeRecipeUrl(parentProof.observedBookingHref) &&
          new URL(parentProof.officialDocumentUrl).hostname.replace(/^www\./u, "") === official.hostname.replace(/^www\./u, "") &&
          new URL(parentProof.observedBookingHref).hostname.replace(/^www\./u, "") === current.hostname.replace(/^www\./u, ""));
    if (!input.visible || input.srcdoc || ![documentUrl, officialUrl, verifiedDocumentUrl].every(isSafeRecipeUrl) || current.origin !== official.origin && !scopedParent || current.protocol !== "https:" ||
        verifiedDocumentUrl.split("#", 1)[0] !== current.href.split("#", 1)[0] || !input.src.trim()) return;
    const raw = new URL(input.src, current).href;
    const url = cpsPublicEntryUrl(raw) ?? raw;
    if (!isSafeRecipeUrl(url)) return;
    // A visible, unlabeled v2 embed is still observed source markup. Exposing
    // it permits a separately guarded main-frame read, never iframe execution
    // or conversion into legacy provider metadata.
    const parsed = new URL(url);
    const teeItUpV2 = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.book-v2\.teeitup\.golf$/u.test(parsed.hostname) &&
      parsed.pathname === "/" && !parsed.search && !parsed.hash;
    // Legacy official embeds can omit a title on their public play entry.
    // Expose that exact source only; the later book destination still needs
    // independently observed navigation/redirect authority and fresh identity.
    const officialDocument = scopedParent && parentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT";
    const teeItUpPlay = officialDocument && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.play\.teeitup\.com$/u.test(parsed.hostname) &&
      parsed.pathname === "/" && !parsed.search && !parsed.hash;
    const knownEntry = Boolean(parseTeeItUpRecipeSource(url) || parseLightspeedSource(url) || teeItUpV2 || teeItUpPlay);
    const labelled = /\b(?:tee\s*times?|booking|availability|book\s+(?:a\s+)?bay|simulator\s+rentals?)\b/iu.test(input.label);
    if ((!knownEntry && !labelled) || !isPublicAvailabilityNavigation(url, input.label || "Public tee time availability")) return;
    return url;
  } catch { return; }
}

export async function observedPublicFrameSources(page: Page, officialUrl: string, verifiedDocumentUrl: string, parentProof?: PublicFrameParentProof) {
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
  return [...new Set(frames.map(frame => publicFrameSource(frame, documentUrl, officialUrl, verifiedDocumentUrl, parentProof)).filter((url): url is string => Boolean(url)))].slice(0, 10);
}
