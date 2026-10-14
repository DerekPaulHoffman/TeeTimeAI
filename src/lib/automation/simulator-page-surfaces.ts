import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

export const simulatorPageSurfacesSchema = z.object({
  entries: z.array(z.object({
    kind: z.enum(["IFRAME", "BOOKING_LINK", "BOOKING_ACTION", "FORM", "INLINE_SCRIPT", "EXTERNAL_SCRIPT"]),
    target: z.enum(["PUBLIC_URL", "LAZY_URL", "FRAGMENT", "INLINE_CODE", "SRCDOC", "MISSING", "UNSAFE"]),
    hidden: z.boolean(), bookingLabel: z.boolean(), count: z.number().int().min(1).max(64),
    scriptType: z.enum(["JAVASCRIPT", "MODULE", "OTHER", "MISSING"]).optional(),
  }).strict()).max(16),
  truncated: z.boolean(),
}).strict().refine(value => value.entries.reduce((sum, entry) => sum + entry.count, 0) <= 64 &&
  new Set(value.entries.map(({ kind, target, hidden, bookingLabel, scriptType }) => `${kind}:${target}:${hidden}:${bookingLabel}:${scriptType}`)).size === value.entries.length &&
  value.entries.every(entry => !entry.scriptType || ["INLINE_SCRIPT", "EXTERNAL_SCRIPT"].includes(entry.kind)));
export type SimulatorPageSurfaces = z.infer<typeof simulatorPageSurfacesSchema>;
type Node = DefaultTreeAdapterMap["node"];

/** Inspect a published declaration; this neither evaluates code nor loads it. */
export function declaredSimulatorScriptSource(attrs: ReadonlyMap<string, string>) {
  const src = attrs.get("src")?.trim();
  if (src && !/^about:blank(?:#.*)?$/iu.test(src)) return { value: src, deferred: false, ambiguous: false };
  const deferred = [...new Set([...attrs].filter(([name, value]) => /^data-(?:[a-z0-9]+-)*src$/u.test(name) && value.trim())
    .map(([, value]) => value.trim()))];
  return { value: deferred.length === 1 ? deferred[0] : undefined, deferred: deferred.length > 0, ambiguous: deferred.length > 1 };
}

function scriptType(attrs: ReadonlyMap<string, string>): NonNullable<SimulatorPageSurfaces["entries"][number]["scriptType"]> {
  const type = attrs.get("type")?.trim().toLowerCase().split(";")[0];
  return !type ? "MISSING" : type === "module" ? "MODULE" :
    /^(?:text|application)\/(?:java|ecma)script$/u.test(type) ? "JAVASCRIPT" : "OTHER";
}

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
    const script = node.tagName === "script" ? declaredSimulatorScriptSource(attrs) : null;
    let kind: SimulatorPageSurfaces["entries"][number]["kind"] | undefined;
    if (node.tagName === "iframe") kind = "IFRAME";
    else if (node.tagName === "a" && bookingLabel) kind = "BOOKING_LINK";
    else if ((node.tagName === "button" || node.tagName === "input" && ["button", "submit"].includes(attrs.get("type") ?? "")) && bookingLabel) kind = "BOOKING_ACTION";
    else if (node.tagName === "form") kind = "FORM";
    else if (script) kind = script.value || script.ambiguous ? "EXTERNAL_SCRIPT" : "INLINE_SCRIPT";
    if (kind) {
      const direct = attrs.get(node.tagName === "a" ? "href" : node.tagName === "form" ? "action" : "src");
      const lazy = attrs.get("data-src") ?? attrs.get("data-url") ?? attrs.get("data-href");
      const value = script ? script.value : direct && !/^about:blank(?:#.*)?$/iu.test(direct.trim()) ? direct.trim() : lazy?.trim();
      let target: SimulatorPageSurfaces["entries"][number]["target"] = "MISSING";
      if (script?.ambiguous) target = "UNSAFE";
      else if (attrs.has("srcdoc")) target = "SRCDOC";
      else if (value?.startsWith("#")) target = "FRAGMENT";
      else if (kind === "INLINE_SCRIPT" || /^javascript:/iu.test(value ?? "")) target = "INLINE_CODE";
      else if (value) {
        try { target = getSafeCustomerBookingUrl(new URL(value, sourceUrl).href) ? (script?.deferred || value === lazy?.trim() ? "LAZY_URL" : "PUBLIC_URL") : "UNSAFE"; }
        catch { target = "UNSAFE"; }
      }
      else if ([...attrs.keys()].some(key => key.startsWith("on"))) target = "INLINE_CODE";
      const type = script ? scriptType(attrs) : undefined;
      const existing = entries.find(entry => entry.kind === kind && entry.target === target && entry.hidden === hidden && entry.bookingLabel === bookingLabel && entry.scriptType === type);
      if (sampled >= 64 || !existing && entries.length >= 16) truncated = true;
      else { sampled += 1; if (existing) existing.count += 1; else entries.push({ kind, target, hidden, bookingLabel, count: 1, ...(type ? { scriptType: type } : {}) }); }
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
