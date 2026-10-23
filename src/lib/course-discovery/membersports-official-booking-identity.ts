import type { Page } from "@playwright/test";
import { isSafeRecipeUrl } from "./recipe";
import { completeUSAddress } from "./teeitup-official-identity";

export type MemberSportsOfficialBookingIdentity = Readonly<{
  officialDocumentUrl: string; bookingUrl: string; clubId: number; courseId: number;
}>;
type Source = { officialUrl: string; bookingUrl: string; venueAddress: string };
type Selectors = { addressSelector: string; bookingLinkSelector: string };

// Playwright serializes this callback. Nested helpers must remain object methods.
function readOfficialDocument(root: Element, selectors: Selectors & { bookingUrl: string }) {
  const check = {
    text(node: HTMLElement) {
      return node.innerText.replace(/\r?\n+/gu, ", ").replace(/(?:,\s*){2,}/gu, ", ").replace(/\s+/gu, " ").trim();
    },
    privateContext(text: string) {
      return /\b(?:password|secret|credential|account|profile|members?|membership|login|logon|sign[ -]?(?:in|up)|auth(?:entication|orization)?|checkout|payment|purchase|confirm|customer|guest details|contact details|birth|birthday|dob|mailing|corporate|billing|headquarters)\b/iu
        .test(text.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[_-]/gu, " "));
    },
    safe(node: Element) {
      if (!(node instanceof HTMLElement) || !node.isConnected || node.isContentEditable ||
          node.matches("html,body,form,input,select,textarea,button,iframe,script,style,template,noscript") ||
          node.hasAttribute("form") || node.querySelector("form,input,select,textarea,button,iframe,script,style,template,noscript,[contenteditable]")) return false;
      let ancestor: Element | null = node;
      for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (ancestor.tagName === "FORM" || ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") ||
            ancestor.getAttribute("aria-hidden") === "true" || ancestor.getAttribute("aria-disabled") === "true" || ancestor.hasAttribute("disabled") ||
            ancestor.hasAttribute("contenteditable") && ancestor.getAttribute("contenteditable")?.toLowerCase() !== "false" ||
            style.display === "none" || style.visibility === "hidden" || style.opacity === "0" ||
            check.privateContext(`${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""} ${ancestor.getAttribute("name") ?? ""}`)) return false;
        if (!["HTML", "BODY"].includes(ancestor.tagName)) {
          const headings = Array.from(ancestor.children).filter(child => /^H[1-6]$/u.test(child.tagName));
          if (headings.length > 10 || headings.some(heading => check.privateContext(heading.textContent ?? ""))) return false;
        }
      }
      const box = node.getBoundingClientRect();
      return !ancestor && box.width > 0 && box.height > 0;
    },
  };
  if (root !== document.documentElement || root.ownerDocument !== document || !root.isConnected || document.querySelectorAll("*").length > 6000) return null;
  const selectedAddresses = document.querySelectorAll(selectors.addressSelector), selectedLinks = document.querySelectorAll(selectors.bookingLinkSelector);
  if (selectedAddresses.length !== 1 || selectedLinks.length !== 1) return null;
  const address = selectedAddresses[0], link = selectedLinks[0];
  if (!(address instanceof HTMLElement) || address.closest("a[href]") || !check.safe(address) ||
      !(link instanceof HTMLAnchorElement) || !check.safe(link) || link.href !== selectors.bookingUrl ||
      link.hasAttribute("download") || !["", "_self", "_blank", "_top", "_parent"].includes((link.getAttribute("target") ?? "").toLowerCase())) return null;
  const label = (link.innerText || link.getAttribute("aria-label") || "").replace(/\s+/gu, " ").trim();
  if (label.length > 120 || !/^(?:(?:book|view|find|check|search)(?: a)?\s+tee[ -]?times?|tee[ -]?times?)$/iu.test(label)) return null;
  const candidates = Array.from(document.querySelectorAll("address,p,li,div,span,td"));
  if (candidates.length > 3000) return null;
  const addresses: Array<{ node: HTMLElement; text: string }> = [];
  for (const node of candidates) {
    if (!(node instanceof HTMLElement) || node.closest("a[href]") || !check.safe(node)) continue;
    const text = check.text(node);
    if (text.length > 500) continue;
    if (/^(?:Address\s*:\s*)?\d{1,7}[A-Za-z]?\s+.+,\s*[A-Za-z .'-]{2,80},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,|$)/iu.test(text)) addresses.push({ node, text });
    if (addresses.length > 160) return null;
  }
  const leaves = addresses.filter(candidate => !addresses.some(other => candidate !== other && candidate.node.contains(other.node)));
  const links = document.querySelectorAll("a[href]");
  if (links.length > 1000) return null;
  let bookingLinks = 0;
  for (const candidate of links) {
    if (!check.safe(candidate)) continue;
    const url = new URL((candidate as HTMLAnchorElement).href);
    if (url.hostname === "app.membersports.com" && /^\/tee-times(?:\/|$)/u.test(url.pathname)) {
      if (candidate !== link || url.href !== selectors.bookingUrl) return null;
      bookingLinks++;
    }
  }
  return { documentUrl: document.URL, addressText: check.text(address),
    addresses: leaves.map(candidate => ({ text: candidate.text, selected: candidate.node === address || address.contains(candidate.node) })),
    bookingLinks, href: link.href, label };
}

/** Fresh DOM address and the exact public anchor attest only this replay's next
 * navigation. The caller owns the main-document token and all later liveness. */
export async function attestMemberSportsOfficialBookingIdentity(page: Page, source: Source, selectors: Selectors): Promise<MemberSportsOfficialBookingIdentity> {
  const fail = (): never => { throw new Error("OFFICIAL_BOOKING_IDENTITY_UNVERIFIED"); };
  const address = completeUSAddress(source.venueAddress);
  const ids = /^https:\/\/app\.membersports\.com\/tee-times\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/0$/u.exec(source.bookingUrl);
  if (!address || !ids || ids.slice(1).some(value => Number(value) > 2_147_483_647) || !isSafeRecipeUrl(source.officialUrl) ||
      !isSafeRecipeUrl(source.bookingUrl) || Object.values(selectors).some(value => !value || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value))) return fail();
  const official = new URL(source.officialUrl), current = page.url();
  if (!isSafeRecipeUrl(current) || new URL(current).origin !== official.origin || new URL(current).hash) return fail();
  const documentRoot = await page.locator("html").elementHandle();
  if (!documentRoot) return fail();
  try {
    const evidence = await documentRoot.evaluate(readOfficialDocument, { ...selectors, bookingUrl: source.bookingUrl });
    if (!evidence || evidence.documentUrl !== current || evidence.bookingLinks !== 1 || evidence.addresses.length !== 1 || !evidence.addresses[0].selected ||
        JSON.stringify(completeUSAddress(evidence.addressText)) !== JSON.stringify(address) ||
        JSON.stringify(completeUSAddress(evidence.addresses[0].text)) !== JSON.stringify(address) || page.url() !== current ||
        JSON.stringify(await documentRoot.evaluate(readOfficialDocument, { ...selectors, bookingUrl: source.bookingUrl })) !== JSON.stringify(evidence)) return fail();
    return Object.freeze({ officialDocumentUrl: current, bookingUrl: evidence.href, clubId: Number(ids[1]), courseId: Number(ids[2]) });
  } catch { return fail(); }
  finally { await documentRoot.dispose().catch(() => {}); }
}
