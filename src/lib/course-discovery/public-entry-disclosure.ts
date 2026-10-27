import { isSafeRecipeUrl } from "./recipe";

/** Caller-private native facts. A model selector or stored report is not a
 * control capability; the browser must independently bind its opaque target. */
export type PublicEntryDisclosureEvidence = {
  pageUrl: string; documentStartedAt: number; observedAt: number;
  tag: string; href: string; rawHref: string; text: string; label: string; rowText: string;
  visible: boolean; inForm: boolean; inlineHandler: boolean; download: boolean; disabled: boolean; role: string;
};
export type PublicEntryDisclosureContext = {
  officialUrl: string; currentUrl: string; documentStartedAt: number; now: number; deadline: number;
};
export type PublicEntryDisclosure = Readonly<{
  kind: "PUBLIC_ENTRY_DISCLOSURE_V1"; pageUrl: string; documentStartedAt: number;
  href: string; rawHref: string; text: string; label: string; rowText: string; observedAt: number;
}>;
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const textTime = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}\s*[ap]\.?m\.?\b/iu;
const transactionContext = /\b(?:checkout|pay|payment|purchase|confirm|hold|reservation|appointment|selected|submit|account|member|sign in|log in|login|password|email|phone|contact)\b/iu;
const transactionPath = /checkout|payment|purchase|reserve|reservation|confirm|hold|cart|order|submit|appointment|account|login|logout|signin|register|password|oauth|auth|token|credential|member|profile|slot|selected|cancel/iu;
const caption = /^reserve (?:your |a )?(?:bay|simulator|tee times?)$/iu;
const exactKeys = (value: unknown, keys: string[]) => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(","));
const evidenceKeys = ["pageUrl", "documentStartedAt", "observedAt", "tag", "href", "rawHref", "text", "label", "rowText", "visible", "inForm", "inlineHandler", "download", "disabled", "role"];
const contextKeys = ["officialUrl", "currentUrl", "documentStartedAt", "now", "deadline"];
const proofKeys = ["kind", "pageUrl", "documentStartedAt", "href", "rawHref", "text", "label", "rowText", "observedAt"];

/** Classifies one fresh plain public-navigation anchor, never an appointment,
 * identity, availability result or permission to contact its destination.
 * The caller still needs a current HTTP-verified official parent, exact unique
 * rendered opaque control and a GET-only guarded native click. */
export function classifyPublicEntryDisclosure(evidence: PublicEntryDisclosureEvidence,
  context: PublicEntryDisclosureContext): PublicEntryDisclosure | null {
  try {
    if (!exactKeys(evidence, evidenceKeys) || !exactKeys(context, contextKeys) ||
        ![evidence.documentStartedAt, evidence.observedAt, context.documentStartedAt, context.now, context.deadline].every(Number.isFinite) ||
        evidence.documentStartedAt <= 0 || evidence.documentStartedAt !== context.documentStartedAt ||
        evidence.observedAt < evidence.documentStartedAt || evidence.observedAt > context.now || context.now - evidence.observedAt > 5000 ||
        context.now >= context.deadline || evidence.pageUrl !== context.currentUrl || evidence.tag.toUpperCase() !== "A" ||
        evidence.visible !== true || evidence.inForm !== false || evidence.inlineHandler !== false || evidence.download !== false ||
        evidence.disabled !== false || !["", "link"].includes(evidence.role.toLowerCase())) return null;
    if (![evidence.text, evidence.label, evidence.rowText].every(value => typeof value === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) ||
        evidence.text.length > 160 || evidence.label.length > 160 || evidence.rowText.length > 700 ||
        typeof evidence.rawHref !== "string" || !evidence.rawHref || /[\u0000-\u001f\u007f]/u.test(evidence.rawHref) ||
        evidence.rawHref.length > 2048 || evidence.rawHref !== evidence.rawHref.trim() || evidence.rawHref.startsWith("//")) return null;
    const text = normalize(evidence.text), label = normalize(evidence.label), rowText = normalize(evidence.rowText);
    if (!caption.test(text) || label && label.toLowerCase() !== "reserve" && !caption.test(label) ||
        transactionContext.test(`${text} ${label} ${rowText}`) || textTime.test(`${text} ${label} ${rowText}`) ||
        ![context.officialUrl, context.currentUrl, evidence.href].every(isSafeRecipeUrl)) return null;
    const official = new URL(context.officialUrl), page = new URL(context.currentUrl), target = new URL(evidence.href);
    if (page.origin !== official.origin || target.origin !== page.origin || target.href !== evidence.href ||
        new URL(evidence.rawHref, page).href !== target.href || target.search || target.hash || target.pathname.length > 200 ||
        !/^\/[a-z]+(?:[/-][a-z]+)*\/?$/iu.test(target.pathname) || transactionPath.test(target.pathname)) return null;
    return Object.freeze({ kind: "PUBLIC_ENTRY_DISCLOSURE_V1", pageUrl: context.currentUrl, documentStartedAt: context.documentStartedAt,
      href: target.href, rawHref: evidence.rawHref, text, label, rowText, observedAt: evidence.observedAt });
  } catch { return null; }
}

/** Re-derive from a new native read immediately before acting; matching old
 * selectors, model text, public URLs or a prior proof alone is insufficient. */
export function revalidatePublicEntryDisclosure(proof: PublicEntryDisclosure, evidence: PublicEntryDisclosureEvidence,
  context: PublicEntryDisclosureContext): boolean {
  const current = classifyPublicEntryDisclosure(evidence, context);
  return Boolean(current && exactKeys(proof, proofKeys) && proof.kind === "PUBLIC_ENTRY_DISCLOSURE_V1" &&
    Number.isFinite(proof.observedAt) && proof.observedAt >= proof.documentStartedAt && proof.observedAt <= current.observedAt &&
    context.now - proof.observedAt <= 5000 && ["pageUrl", "documentStartedAt", "href", "rawHref", "text", "label", "rowText"]
      .every(key => proof[key as keyof PublicEntryDisclosure] === current[key as keyof PublicEntryDisclosure]));
}
