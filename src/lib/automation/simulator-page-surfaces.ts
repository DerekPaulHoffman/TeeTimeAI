import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

export const simulatorPageSurfacesSchema = z.object({
  entries: z.array(z.object({
    kind: z.enum(["IFRAME", "BOOKING_LINK", "BOOKING_ACTION", "FORM", "INLINE_SCRIPT", "EXTERNAL_SCRIPT"]),
    target: z.enum(["PUBLIC_URL", "LAZY_URL", "FRAGMENT", "INLINE_CODE", "SRCDOC", "MISSING", "UNSAFE"]),
    hidden: z.boolean(), bookingLabel: z.boolean(), count: z.number().int().min(1).max(64),
  }).strict()).max(16),
  truncated: z.boolean(),
}).strict().refine(value => value.entries.reduce((sum, entry) => sum + entry.count, 0) <= 64 &&
  new Set(value.entries.map(({ kind, target, hidden, bookingLabel }) => `${kind}:${target}:${hidden}:${bookingLabel}`)).size === value.entries.length);
export type SimulatorPageSurfaces = z.infer<typeof simulatorPageSurfacesSchema>;
type Node = DefaultTreeAdapterMap["node"];

/** Closed structural counts only: no URLs, labels, code, field names or values. */
export function summarizeSimulatorPageSurfaces(html: string, sourceUrl: string): SimulatorPageSurfaces {
  const entries: SimulatorPageSurfaces["entries"] = [];
  let sampled = 0, truncated = false;
  const text = (node: Node): string => "value" in node ? node.value.slice(0, 200) : "childNodes" in node
    ? node.childNodes.map(text).join(" ").slice(0, 200) : "";
  const visit = (node: Node, inheritedHidden = false) => {
    if (!("tagName" in node)) { if ("childNodes" in node) node.childNodes.forEach(child => visit(child, inheritedHidden)); return; }
    const attrs = new Map(node.attrs.map(attr => [attr.name, attr.value]));
    const hidden = inheritedHidden || attrs.has("hidden") || attrs.get("aria-hidden") === "true" ||
      /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attrs.get("style") ?? "");
    const labelled = ["a", "button", "input", "iframe"].includes(node.tagName);
    const label = labelled ? `${attrs.get("title") ?? ""} ${attrs.get("aria-label") ?? ""} ${node.tagName === "input" ? attrs.get("value") ?? "" : text(node)}` : "";
    const bookingLabel = /\b(?:book(?:ing)?|reserv(?:e|ation)s?|appointments?|calendar|schedul(?:e|ing))\b/iu.test(label);
    let kind: SimulatorPageSurfaces["entries"][number]["kind"] | undefined;
    if (node.tagName === "iframe") kind = "IFRAME";
    else if (node.tagName === "a" && bookingLabel) kind = "BOOKING_LINK";
    else if ((node.tagName === "button" || node.tagName === "input" && ["button", "submit"].includes(attrs.get("type") ?? "")) && bookingLabel) kind = "BOOKING_ACTION";
    else if (node.tagName === "form") kind = "FORM";
    else if (node.tagName === "script") kind = attrs.has("src") ? "EXTERNAL_SCRIPT" : "INLINE_SCRIPT";
    if (kind) {
      const direct = attrs.get(node.tagName === "a" ? "href" : node.tagName === "form" ? "action" : "src");
      const lazy = attrs.get("data-src") ?? attrs.get("data-url") ?? attrs.get("data-href");
      const value = direct && !/^about:blank(?:#.*)?$/iu.test(direct.trim()) ? direct.trim() : lazy?.trim();
      let target: SimulatorPageSurfaces["entries"][number]["target"] = "MISSING";
      if (attrs.has("srcdoc")) target = "SRCDOC";
      else if (value?.startsWith("#")) target = "FRAGMENT";
      else if (kind === "INLINE_SCRIPT" || /^javascript:/iu.test(value ?? "")) target = "INLINE_CODE";
      else if (value) {
        try { target = getSafeCustomerBookingUrl(new URL(value, sourceUrl).href) ? (value === lazy?.trim() ? "LAZY_URL" : "PUBLIC_URL") : "UNSAFE"; }
        catch { target = "UNSAFE"; }
      }
      else if ([...attrs.keys()].some(key => key.startsWith("on"))) target = "INLINE_CODE";
      const existing = entries.find(entry => entry.kind === kind && entry.target === target && entry.hidden === hidden && entry.bookingLabel === bookingLabel);
      if (sampled >= 64 || !existing && entries.length >= 16) truncated = true;
      else { sampled += 1; if (existing) existing.count += 1; else entries.push({ kind, target, hidden, bookingLabel, count: 1 }); }
    }
    // Form controls and scripts can carry private input; neither is needed to
    // enumerate this document's outer booking/navigation structure.
    if (!["script", "form", "input", "textarea", "select", "template"].includes(node.tagName) && "childNodes" in node) {
      node.childNodes.forEach(child => visit(child, hidden));
    }
  };
  visit(parse(html));
  return { entries, truncated };
}
