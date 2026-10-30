import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Page } from "@playwright/test";
import { isSafeRecipeUrl } from "./recipe";
import type { PublicFrameParentProof } from "./public-booking-parent";

export type PublicBookingLinkRow = { href: string; text: string; label: string };
export type PublicBookingLinks = { rows: PublicBookingLinkRow[]; overflow: boolean };
export type NativeIntermediaryCapture = { pageUrl: string; documentHash: string; observedAt: number; settled: boolean; links: PublicBookingLinks };
export type NativeIntermediaryPreparationDiagnostic = {
  attempt: number; stage: "BEGIN" | "FIRST_CAPTURE" | "SECOND_CAPTURE" | "ORIGIN" | "SELECT" | "GRANT";
  reason: "ENTRY_LIMIT" | "PENDING_ENTRY" | "DOCUMENT_UNSETTLED" | "NATIVE_DOCUMENT_CHANGED" | "DOM_CHANGED" | "OFFICIAL_ORIGIN_UNVERIFIED" |
    "NO_UNIQUE_GATEWAY" | "ALREADY_ENTERED" | "URL_REJECTED" | "CLOCK_INVALID" | "READY" | "THREW" | null;
  firstRows: number | null; secondRows: number | null;
  firstOverflow: boolean | null; secondOverflow: boolean | null; firstSettled: boolean | null; secondSettled: boolean | null;
  firstCandidatePresent: boolean | null; secondCandidatePresent: boolean | null;
  samePage: boolean | null; sameNativeDocument: boolean | null; sameDocumentHash: boolean | null;
  sameReadinessState: boolean | null; sameRoutingInventory: boolean | null;
};
const caption = /^(?:tee[ -]?times?|(?:book|reserve) (?:a |your )?tee[ -]?times?|book online|check availability|availability)$/iu;
const denied = /\b(?:account|member|login|log[ -]?in|sign[ -]?in|register|checkout|payment|purchase|reserve|hold|confirm|cancel|password|private)\b/iu;
/** Literal same-origin document navigation only. Hidden menu markup is not a
 * visible-control claim, provider source, identity or availability proof. */
export function uniquePublicBookingIntermediary(value: PublicBookingLinks, pageUrl: string): string | null {
  try {
    const page = new URL(pageUrl);
    if (!isSafeRecipeUrl(pageUrl) || page.protocol !== "https:" || value.overflow || value.rows.length > 160) return null;
    const choices = new Set<string>();
    for (const row of value.rows) {
      if ([row.href, row.text, row.label].some(v => typeof v !== "string") || row.href.length > 2048) return null;
      const url = new URL(row.href, page);
      if (!isSafeRecipeUrl(url.href) || url.origin !== page.origin || url.href === page.href || url.search || url.hash ||
          denied.test(decodeURIComponent(url.pathname).replace(/[\/_-]+/gu, " ")) ||
          !/(?:^|\/)(?:(?:book-)?tee-times?|tee-time-reservations?|teetimes?|booking|book-online|availability)\/?$/iu.test(url.pathname)) continue;
      // A fragment menu icon can contain a long SVG/style label. Only an
      // eligible gateway's caption can make that gateway unverified.
      if (row.text.length > 160 || row.label.length > 160) return null;
      const labels = [row.text, row.label].map(v => v.replace(/\s+/gu, " ").trim()).filter(Boolean);
      // The entire caption must match the public availability grammar. A
      // literal Reserve-a-Tee-Time landing is routing, never a selected slot.
      if (!labels.length || labels.some(v => !caption.test(v))) continue;
      choices.add(url.href);
    }
    return choices.size === 1 ? [...choices][0] : null;
  } catch { return null; }
}
export function uniqueNativePublicBookingIntermediary(first: NativeIntermediaryCapture, second: NativeIntermediaryCapture,
  clock: { startedAt: number; now: number; deadline: number }) {
  if (![first.observedAt,second.observedAt,clock.startedAt,clock.now,clock.deadline].every(Number.isFinite) || !first.settled || !second.settled || first.pageUrl !== second.pageUrl || first.documentHash !== second.documentHash ||
      !/^[a-f0-9]{64}$/u.test(second.documentHash) || first.observedAt < clock.startedAt || second.observedAt < first.observedAt ||
      second.observedAt > clock.now || clock.now >= clock.deadline) return null;
  const url = uniquePublicBookingIntermediary(first.links, first.pageUrl);
  return url && uniquePublicBookingIntermediary(second.links, second.pageUrl) === url ? url : null;
}

/** Self-contained fixed native expression, also used by the fresh inspector.
 * No href execution, visibility mutation, control values or site callbacks. */
export function collectPublicBookingLinks(): PublicBookingLinks {
  const anchors = [...document.querySelectorAll("a[href]")];
  return { overflow: anchors.length > 160, rows: anchors.slice(0, 160).filter(e =>
    !e.closest("form,template,script,noscript") && !e.hasAttribute("download") && !e.hasAttribute("onclick"))
    .map(e => ({ href: (e.getAttribute("href") ?? "").slice(0, 2049), text: (e.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 161), label: (e.getAttribute("aria-label") ?? "").slice(0, 161) })) };
}

type Tree = DefaultTreeAdapterMap["node"];
export function rawPublicBookingLinks(html: string): PublicBookingLinks {
  if (Buffer.byteLength(html) > 600_000) return { rows: [], overflow: true };
  const rows: PublicBookingLinkRow[] = []; let count = 0, nodes = 0, overflow = false;
  const visit = (node: Tree, excluded = false, depth = 0) => {
    if (++nodes > 12_000 || depth > 64) { overflow = true; return; }
    const element = "tagName" in node ? node : undefined;
    const attrs = new Map(element?.attrs.map(a => [a.name, a.value]) ?? []);
    const blocked = excluded || Boolean(element && ["form", "template", "script", "noscript"].includes(element.tagName));
    if (element?.tagName === "a" && attrs.has("href")) {
      count++;
      if (!blocked && !attrs.has("download") && !attrs.has("onclick")) {
        let text = "", reads = 0; const pending = [node];
        while (pending.length && text.length < 2000) { const item = pending.pop()!;if (++reads > 12_000) { overflow = true; break; }
          if ("value" in item) text += item.value; else if ("childNodes" in item) pending.push(...[...item.childNodes].reverse()); }
        rows.push({ href: (attrs.get("href") ?? "").slice(0, 2049), text: text.replace(/\s+/gu, " ").trim().slice(0, 161), label: (attrs.get("aria-label") ?? "").slice(0, 161) });
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, blocked, depth + 1);
  };
  visit(parse(html));
  return { rows: rows.slice(0, 160), overflow: overflow || count > 160 };
}

/** Two current DOM reads plus the actual captured official response must agree.
 * The existing parent capability (not a recipe/model field) supplies authority. */
export async function observedPublicBookingIntermediary(page: Page, html: string, proof: PublicFrameParentProof | undefined) {
  const url = page.url();
  if (proof?.kind !== "VERIFIED_OFFICIAL_DOCUMENT" || proof.documentUrl !== url) return null;
  const origin = await page.evaluate(() => performance.timeOrigin);
  const first = await page.evaluate(collectPublicBookingLinks), second = await page.evaluate(collectPublicBookingLinks);
  const href = uniquePublicBookingIntermediary(first, url);
  if (!href || JSON.stringify(first) !== JSON.stringify(second) || uniquePublicBookingIntermediary(rawPublicBookingLinks(html), url) !== href ||
      page.url() !== url || origin !== await page.evaluate(() => performance.timeOrigin)) return null;
  return href;
}
