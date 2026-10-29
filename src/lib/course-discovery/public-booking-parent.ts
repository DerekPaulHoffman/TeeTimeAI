import type { Locator, Page } from "@playwright/test";
import { isSafeRecipeUrl } from "./recipe";
import { isPublicAvailabilityNavigation } from "./public-navigation-control";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";
import { attestedNativeDocumentRedirects } from "./native-redirect-routing";

export type PublicFrameParentProof = { officialUrl: string; documentUrl: string } & (
  { kind: "VERIFIED_OFFICIAL_DOCUMENT" } |
  { kind: "OBSERVED_PUBLIC_BOOKING_PARENT"; officialDocumentUrl: string; observedBookingHref: string } |
  { kind: "PUBLIC_BOOKING_ROUTING_ONLY" });
export type PublicBookingParentIdentity = { headings: string[]; addressTexts: string[]; truncated?: boolean };
const currentOfficialParentProofs = new WeakMap<object, { officialUrl: string; documentUrl: string; current: () => boolean }>();
const currentRoutingParentProofs = new WeakMap<object, { officialUrl: string; documentUrl: string; current: () => boolean }>();

/** A private current public link chain authorizes only reading its iframe source.
 * It is neither an official document nor proof of the requested venue. */
export function isCurrentRoutingFrameParent(proof: PublicFrameParentProof | undefined, officialUrl: string, documentUrl: string) {
  if (!proof || proof.kind !== "PUBLIC_BOOKING_ROUTING_ONLY" || proof.officialUrl !== officialUrl || proof.documentUrl !== documentUrl) return false;
  const bound = currentRoutingParentProofs.get(proof);
  return Boolean(bound && bound.officialUrl === officialUrl && bound.documentUrl === documentUrl && bound.current());
}

/** Only this live scope can carry an official document across an attested
 * host migration. Copied JSON and a historical redirect never mint it. */
export function isCurrentOfficialFrameParent(proof: PublicFrameParentProof | undefined, officialUrl: string, documentUrl: string) {
  if (!proof || proof.kind !== "VERIFIED_OFFICIAL_DOCUMENT" || proof.officialUrl !== officialUrl || proof.documentUrl !== documentUrl) return false;
  const bound = currentOfficialParentProofs.get(proof);
  return Boolean(bound && bound.officialUrl === officialUrl && bound.documentUrl === documentUrl && bound.current());
}
type Candidate = { kind: "OFFICIAL"; nativeRedirectRequired?: true } | { kind: "BOOKING"; officialDocumentUrl: string; observedBookingHref: string;
  routingSource?: { documentUrl: string; generation: object; binding: string } };
const stateNames: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",DC:"District of Columbia",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",NH:"New Hampshire",NJ:"New Jersey",
  NM:"New Mexico",NY:"New York",NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",
  SC:"South Carolina",SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",WI:"Wisconsin",WY:"Wyoming",
};
function address(value: string) {
  if (value.length > 500) return null;
  const normalized = value.replace(/,\s*([A-Za-z ]+?)\s*,?\s+(\d{5}(?:-\d{4})?)(?=,|$)/u, (all, region: string, postal: string) => {
    const code = stateNames[region.trim().toUpperCase()] ? region.trim().toUpperCase() :
      Object.entries(stateNames).find(([, name]) => name.toLowerCase() === region.trim().toLowerCase())?.[0];
    return code ? `, ${code} ${postal}` : all;
  });
  return completeUSAddress(normalized);
}
function documentKey(value: string) {
  if (!isSafeRecipeUrl(value)) return undefined;
  const url = new URL(value); url.hash = ""; return url.href;
}
const sameHost = (left: string, right: string) => new URL(left).hostname.replace(/^www\./u, "") === new URL(right).hostname.replace(/^www\./u, "");
function matchesIdentity(venueName: string, venueAddress: string | undefined, evidence?: PublicBookingParentIdentity) {
  if (!evidence || evidence.truncated || evidence.headings.length !== 1 || evidence.addressTexts.length > 160 || !venueAddress) return false;
  const name = fullCourseName(venueName), canonical = address(venueAddress);
  if (!canonical || name.replace(/\bgolf course\b/u, "").trim().length < 3 || fullCourseName(evidence.headings[0]) !== name) return false;
  const addresses = new Set(evidence.addressTexts.map(address).filter(Boolean).map(value => JSON.stringify(value)));
  return addresses.size === 1 && addresses.has(JSON.stringify(canonical));
}

/** Context-local source provenance only. Neither a checkpoint nor a proposed
 * recipe can populate it. This permits standalone inspection of visible iframe
 * source markup; it never proves availability or permits iframe execution. */
export function createPublicBookingParentScope(identity: { officialUrl?: string; venueName?: string; venueAddress?: string }, privateOfficialContactUrl?: string,
  currentNativeDocument?: (request: object, url: string) => string | undefined) {
  const official = identity.officialUrl && documentKey(identity.officialUrl);
  const candidates = new Map<string, Candidate>(official ? [[official, { kind: "OFFICIAL" }]] : []);
  // Only the browser session's private, independently attested Contact handoff
  // supplies this exact URL. A same-origin URL alone is never admitted here.
  if (official && privateOfficialContactUrl) {
    const contact = documentKey(privateOfficialContactUrl);
    if (!contact || contact === official || new URL(contact).origin !== new URL(official).origin ||
        new URL(contact).protocol !== "https:") throw new Error("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
    candidates.set(contact, { kind: "OFFICIAL" });
  }
  const verified = new Map<string, Candidate>();
  const documentGenerations = new Map<string, object>();
  const documentNativeChecks = new Map<string, () => boolean>();
  const nativeRequests = new Map<string, object>();
  const remember = (url: string, candidate: Candidate) => {
    if (!candidates.has(url) && candidates.size >= 32) return false;
    candidates.set(url, candidate); return true;
  };
  return {
    beginDocument(value: string) { const key = documentKey(value); if (key) { verified.delete(key); documentGenerations.delete(key); documentNativeChecks.delete(key); nativeRequests.delete(key); } },
    observeDocument(input: { url: string; status: number; redirectedFrom?: string; nativeRequest?: object }) {
      const url = documentKey(input.url), from = input.redirectedFrom && documentKey(input.redirectedFrom);
      if (!url) return;
      documentGenerations.delete(url);
      documentNativeChecks.delete(url);
      nativeRequests.delete(url);
      let candidate = candidates.get(url);
      const nativeLineage = official && input.nativeRequest ? attestedNativeDocumentRedirects(input.nativeRequest, new Set([official])) : undefined;
      if (candidate?.kind === "OFFICIAL" && candidate.nativeRedirectRequired && nativeLineage?.at(-1)?.toUrl !== url) {
        verified.delete(url); return;
      }
      // Cross-host official migrations require the native router's completed
      // exact-root lineage. Ordinary URLs/diagnostics cannot populate it.
      if (!candidate && input.status === 200 && nativeLineage && nativeLineage.at(-1)?.toUrl === url) {
        candidate = { kind: "OFFICIAL", nativeRedirectRequired: true };
        if (!remember(url, candidate)) return;
      }
      // redirectedFrom is actual browser HTTP redirect provenance. A similar
      // hostname, an observed diagnostic or a model URL alone is insufficient.
      if (!candidate && from && candidates.has(from) && sameHost(url, from)) {
        candidate = candidates.get(from)!;
        if (!remember(url, candidate)) return;
      }
      verified.delete(url);
      if (candidate && input.status === 200) {
        verified.set(url, candidate); documentGenerations.set(url, {});
        if (input.nativeRequest) nativeRequests.set(url, input.nativeRequest);
        if (candidate.kind === "OFFICIAL" && candidate.nativeRedirectRequired && input.nativeRequest && official) {
          const request = input.nativeRequest;
          documentNativeChecks.set(url, () => attestedNativeDocumentRedirects(request, new Set([official]))?.at(-1)?.toUrl === url);
        }
      }
    },
    observeOfficialLink(documentUrl: string, href: string, label: string) {
      const parent = documentKey(documentUrl), target = documentKey(href);
      if (!parent || !target || verified.get(parent)?.kind !== "OFFICIAL" ||
          !/\b(?:book|tee[\s-]*times?|availability|reservations?)\b/iu.test(label) || !isPublicAvailabilityNavigation(href, label) ||
          /(?:^|\.)(?:facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|linkedin\.com|google\.com)$/iu.test(new URL(target).hostname)) return;
      // Do not replace official-document provenance with a same-site link.
      if (candidates.get(target)?.kind === "OFFICIAL") return;
      if (new URL(target).origin === new URL(parent).origin) { remember(target, { kind: "OFFICIAL" }); return; }
      const sourceRequest = nativeRequests.get(parent), generation = documentGenerations.get(parent);
      const binding = sourceRequest && currentNativeDocument?.(sourceRequest, documentUrl);
      remember(target, { kind: "BOOKING", officialDocumentUrl: documentUrl, observedBookingHref: href,
        ...(generation && binding ? { routingSource: { documentUrl: parent, generation, binding } } : {}) });
    },
    needsIdentity(documentUrl: string) { const key = documentKey(documentUrl); return key !== undefined && verified.get(key)?.kind === "BOOKING"; },
    authorizeParent(documentUrl: string, evidence?: PublicBookingParentIdentity): PublicFrameParentProof | undefined {
      const key = documentKey(documentUrl), candidate = key && verified.get(key);
      if (!official || !key || !candidate) return;
      if (candidate.kind === "OFFICIAL") {
        const proof: PublicFrameParentProof = { officialUrl: identity.officialUrl!, documentUrl, kind: "VERIFIED_OFFICIAL_DOCUMENT" };
        const generation = documentGenerations.get(key);
        const nativeCurrent = documentNativeChecks.get(key);
        if (!generation) return;
        currentOfficialParentProofs.set(proof, { officialUrl: identity.officialUrl!, documentUrl,
          current: () => verified.get(key) === candidate && documentGenerations.get(key) === generation && (!nativeCurrent || nativeCurrent()) });
        return proof;
      }
      if (!identity.venueName || !matchesIdentity(identity.venueName, identity.venueAddress, evidence)) {
        const source = candidate.routingSource, request = nativeRequests.get(key), generation = documentGenerations.get(key);
        const binding = request && currentNativeDocument?.(request, documentUrl);
        if (!source || !generation || !binding || !/^[a-f0-9]{64}$/u.test(binding) || !/^[a-f0-9]{64}$/u.test(source.binding) ||
            documentGenerations.get(source.documentUrl) !== source.generation) return;
        const proof: PublicFrameParentProof = { kind: "PUBLIC_BOOKING_ROUTING_ONLY", officialUrl: identity.officialUrl!, documentUrl };
        currentRoutingParentProofs.set(proof, { officialUrl: identity.officialUrl!, documentUrl,
          current: () => verified.get(key) === candidate && documentGenerations.get(key) === generation &&
            documentGenerations.get(source.documentUrl) === source.generation && nativeRequests.get(key) === request &&
            currentNativeDocument?.(request!, documentUrl) === binding });
        return proof;
      }
      return { officialUrl: identity.officialUrl!, documentUrl, kind: "OBSERVED_PUBLIC_BOOKING_PARENT",
        officialDocumentUrl: candidate.officialDocumentUrl, observedBookingHref: candidate.observedBookingHref };
    },
  };
}

/** A current submenu link can inherit its own visible public-booking caption.
 * This reads literal menu markup only, after the controller rechecks the clicked
 * opaque control. It neither clicks the menu nor supplies venue identity. */
export async function readPublicBookingMenuLabel(link: Locator): Promise<string | undefined> {
  const observed = await link.evaluate(element => {
    if (!(element instanceof HTMLAnchorElement) || element.closest("form,template,script,noscript,iframe")) return null;
    const list = element.closest("ul"), group = list?.parentElement;
    if (!list || !group || group.tagName !== "LI" || group.getAttribute("aria-haspopup") !== "true") return null;
    const captions = [...group.children].filter(node => node instanceof HTMLAnchorElement);
    if (captions.length !== 1) return null;
    const caption = captions[0] as HTMLAnchorElement;
    if (caption.getAttribute("href") !== "#" || caption.hasAttribute("onclick") || caption.hasAttribute("download") ||
        caption.getAttribute("aria-disabled") === "true") return null;
    for (const target of [element, caption]) {
      const bounds = target.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return null;
      let node: Element | null = target;
      for (let depth = 0; node && depth < 40; depth++, node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return null;
      }
      if (node) return null;
    }
    return { href: caption.href, label: caption.innerText.replace(/\s+/gu, " ").trim() };
  }, undefined, { timeout: 1000 });
  return observed && /\b(?:book|tee[\s-]*times?|availability|reservations?)\b/iu.test(observed.label) &&
    isPublicAvailabilityNavigation(observed.href, observed.label) ? observed.label : undefined;
}

/** Fixed bounded DOM read, including computed ancestor visibility. It reads no
 * child-frame document, form, script, account data or arbitrary selector. */
export async function readPublicBookingParentIdentity(page: Page): Promise<PublicBookingParentIdentity> {
  return page.locator("h1,address,p,a,div,li,td").evaluateAll(nodes => {
    if (nodes.length > 3000) return { headings: [], addressTexts: [], truncated: true };
    const headings: string[] = [], addressTexts: string[] = [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || node.closest('form,script,template,noscript,iframe,[hidden],[inert],[aria-hidden="true"]')) continue;
      const rect = node.getBoundingClientRect();
      let current: Element | null = node, visible = rect.width > 0 && rect.height > 0, depth = 0;
      while (current && visible && depth++ < 40) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") visible = false;
        current = current.parentElement;
      }
      if (!visible || current) continue;
      const text = node.innerText.replace(/\n+/gu, ", ").replace(/\s+/gu, " ").trim();
      if (node.tagName === "H1") { if (text.length > 300 || headings.length >= 10) return { headings, addressTexts, truncated: true }; headings.push(text); }
      if (text.length >= 15 && text.length <= 500 && /\b\d{5}(?:-\d{4})?\b/u.test(text)) {
        if (addressTexts.length >= 160) return { headings, addressTexts, truncated: true };
        addressTexts.push(text);
      }
    }
    return { headings, addressTexts };
  });
}
