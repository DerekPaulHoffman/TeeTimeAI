import { parse, type DefaultTreeAdapterMap } from "parse5";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { normalizePublicUSState } from "./public-us-business-address";
export type NamedPublicContact = { name: string; addressText: string; phones: Array<{ href: string; text: string }> };
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attr = (n: Element, key: string) => n.attrs.find(v => v.name === key)?.value;
const clean = (v: string) => v.normalize("NFKC").replace(/\s+/gu, " ").trim();
const literal = (v: string) => clean(v).toLowerCase();
const reject = (): never => { throw Error("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED"); };
function excluded(n: Element) {
  return ["script","style","template","noscript","iframe","form","input","textarea","select","button","label"].includes(n.tagName) ||
    ["hidden","inert","contenteditable"].some(k => attr(n,k) !== undefined) || attr(n,"aria-hidden") === "true" ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(n,"style") ?? "") ||
    /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/u.test(attr(n,"class") ?? "") ||
    /\b(?:account|members?|profile|customer|checkout|payment|billing|mailing|corporate|headquarters|fax|login|sign-in)\b/iu.test(["id","class","title","aria-label"].map(k => attr(n,k) ?? "").join(" ")) ||
    n.childNodes.some(c => element(c) && /^h[1-6]$/u.test(c.tagName) && /\b(?:mailing|corporate|billing|headquarters|fax)\b/iu.test(text(c)));
}
function text(n: Node): string {
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  if (element(n) && excluded(n)) return "";
  if (element(n) && n.tagName === "br") return ", ";
  return "childNodes" in n ? n.childNodes.map(text).join(" ") : "";
}
/** A printed period may separate a fully written US state from an actual ZIP.
 * Every postal component remains observed; no canonical field fills a gap. */
export function parseNamedContactAddress(value: string) {
  const legacy = teeItUpCompleteStreetAddress(value);
  if (legacy) return legacy;
  const match = /^(.*,\s*)([A-Za-z ]{2,40})\.\s*(\d{5}(?:-\d{4})?)(\s*,\s*(?:US|USA|United States(?: of America)?))?$/iu.exec(clean(value));
  if (!match || !normalizePublicUSState(match[2])) return null;
  return teeItUpCompleteStreetAddress(match[1]+match[2]+" "+match[3]+(match[4] ?? "")) ?? null;
}
/** Ordinary parsed public data only, never an attestation or identity proof. */
export function readNamedPublicContacts(html: string, venueName: string): NamedPublicContact[] {
  if (Buffer.byteLength(html) > 600000) return reject();
  const all: Element[] = [], pending: Array<[Node,number]> = [[parse(html),0]]; let count = 0;
  while (pending.length) {
    const [n,depth] = pending.pop()!;
    if (++count > 20000 || depth > 64) return reject();
    if (element(n)) { if (excluded(n)) continue; all.push(n); }
    if ("childNodes" in n) for (const child of [...n.childNodes].reverse()) pending.push([child,depth+1]);
  }
  const eligible = new Set(all), addressNodes = all.filter(n => n.tagName === "address");
  const phoneNodes = all.filter(n => n.tagName === "a" && /^tel:/u.test(attr(n,"href") ?? ""));
  if (addressNodes.length > 80) return reject();
  const contains = (parent: Element, child: Element) => { let n: Node | undefined = child; while (n) { if (n === parent) return true; n = "parentNode" in n ? n.parentNode ?? undefined : undefined; } return false; };
  const candidates: Array<{ node: Element; data: NamedPublicContact }> = [];
  for (const node of all.filter(n => ["div","section","footer","p","li","td"].includes(n.tagName))) {
    if (clean(text(node)).length > 600) continue;
    const names = node.childNodes.filter((n): n is Element => element(n) && eligible.has(n) && ["p","span","strong","a","h1","h2","h3","h4","h5","h6"].includes(n.tagName) && literal(text(n)) === literal(venueName));
    const addresses = addressNodes.filter(n => contains(node,n));
    if (!names.length || !addresses.length) continue;
    if (names.length !== 1 || addresses.length !== 1) return reject();
    const nested: Node[] = [node]; let contaminated = false;
    while (nested.length) { const n=nested.pop()!; if (element(n) && ["form","input","textarea","select","button","label"].includes(n.tagName)) contaminated=true; if ("childNodes" in n) nested.push(...n.childNodes); }
    if (contaminated) return reject();
    const phones = phoneNodes.filter(n => contains(node,n));
    if (!phones.length || phones.length > 8) return reject();
    candidates.push({node,data:{name:clean(text(names[0])),addressText:clean(text(addresses[0])),phones:phones.map(n=>({href:attr(n,"href")!,text:clean(text(n))}))}});
    if (candidates.length > 40) return reject();
  }
  return candidates.filter(c => !candidates.some(other => c.node !== other.node && contains(c.node,other.node))).map(c=>c.data);
}
