import { parse, type DefaultTreeAdapterMap } from "parse5";
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attr = (n: Element, key: string) => n.attrs.find(a => a.name === key)?.value;
function hidden(n: Element) {
  let current: Node | undefined = n;
  for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current) && (["form", "script", "style", "template", "noscript", "iframe", "input", "button", "select", "textarea", "label"].includes(current.tagName) ||
      ["hidden", "inert", "contenteditable"].some(k => attr(current as Element, k) !== undefined) || attr(current, "aria-hidden") === "true" ||
      /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(current, "style") ?? "") ||
      /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only)(?:\s|$)/u.test(attr(current, "class") ?? ""))) return true;
  }
  return false;
}
function text(n: Node): string { return n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : element(n) && hidden(n) ? "" : "childNodes" in n ? n.childNodes.map(text).join(" ") : ""; }
/** Literal public display control only. It cannot admit a selected time,
 * transaction, resource, account field or any arbitrary JavaScript action. */
export function readUScheduleNextAvailableView(html: string, tenant: string): { present: boolean; selected: boolean } {
  const absent = { present: false, selected: false };
  if (!/^[a-z][a-z0-9-]{2,62}$/u.test(tenant) || Buffer.byteLength(html) > 2_000_000) return absent;
  const nodes: Element[] = [], stack: Array<[Node, number]> = [[parse(html), 0]];
  while (stack.length) { const [n, depth] = stack.pop()!; if (depth > 64 || nodes.length > 20_000) return absent;
    if (element(n)) nodes.push(n); if ("childNodes" in n) for (const child of n.childNodes) stack.push([child, depth + 1]); }
  if (!nodes.some(n => n.tagName === "body" && (attr(n, "class") ?? "").split(/\s+/u).includes(tenant))) return absent;
  const matches = nodes.filter(n => n.tagName === "li" && !hidden(n) && text(n).replace(/\s+/gu, " ").trim() === "Next Available" &&
    /^(?:return\s+)?saveBookingDetail\(\s*(['"])next_avail\1\s*\)\s*;?$/u.test((attr(n, "onclick") ?? "").trim()));
  return matches.length === 1 ? { present: true, selected: (attr(matches[0], "class") ?? "").split(/\s+/u).includes("selected") } : absent;
}
