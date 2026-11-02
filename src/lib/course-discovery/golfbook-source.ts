import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
type Node = DefaultTreeAdapterMap["node"]; type Element = DefaultTreeAdapterMap["element"];
export type GolfBookSource = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
const id = z.string().regex(/^[1-9]\d{0,9}$/u);
export const golfBookMetadataSchema = z.object({ family: z.literal("GOLFBOOK"), templateId: id,
  resourceIds: z.array(id).min(1).max(40).refine(v => new Set(v).size === v.length),
  incrementMinutes: z.union([z.literal(15), z.literal(30)]), minDurationMinutes: z.number().int().min(15).max(240),
  maxDurationMinutes: z.number().int().min(60).max(1440), identitySha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().refine(v => v.maxDurationMinutes >= v.minDurationMinutes && v.minDurationMinutes % v.incrementMinutes === 0);
export type GolfBookMetadata = z.infer<typeof golfBookMetadataSchema>;
export function parseGolfBookSource(value: string) {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash &&
    /^[a-z][a-z0-9-]{0,62}\.(?:golfbook\.in|golfbooking\.us)$/u.test(u.hostname) && u.pathname === "/calendar.php" ? u : null; } catch { return null; }
}
export const attr = (e: Element, key: string) => e.attrs.find(a => a.name === key)?.value ?? "";
export function elements(node: Node): Element[] {
  if ("tagName" in node && (["script", "style", "template", "noscript"].includes(node.tagName) ||
    node.attrs.some(a => a.name === "hidden" || a.name === "aria-hidden" && a.value === "true" ||
      a.name === "style" && /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(a.value)))) return [];
  return [...("tagName" in node ? [node] : []), ...("childNodes" in node ? node.childNodes.flatMap(elements) : [])];
}
export function text(node: Node): string {
  if ("tagName" in node && ["script", "style", "template", "noscript"].includes(node.tagName)) return "";
  return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ").replace(/\s+/gu, " ").trim() : "";
}
const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
const addressKey = (s: string) => key(s.replace(/,?\s*(?:USA|US|United States(?: of America)?)\s*$/iu, "").replace(/(\d{5})-\d{4}\b/gu, "$1")
  .replace(/\b(?:road|street|avenue|drive|boulevard|lane|court|east|west|north|south)\b/giu,
    v => ({road:"rd",street:"st",avenue:"ave",drive:"dr",boulevard:"blvd",lane:"ln",court:"ct",east:"e",west:"w",north:"n",south:"s"})[v.toLowerCase()]!));
function officialKey(value: string) { const u = new URL(value); if (!getSafeCustomerBookingUrl(value)) throw Error("ADAPTER_IDENTITY_MISMATCH"); return u.hostname.replace(/^www\./u, "") + u.pathname.replace(/\/$/u, ""); }
export function verifyGolfBookIdentity(source: GolfBookSource, document: Element[]) {
  if (!source.officialUrl || !source.venueAddress || !/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,\s*(?:USA|US|United States))?$/iu.test(source.venueAddress) ||
    !parseGolfBookSource(source.bookingUrl)) throw Error("ADAPTER_IDENTITY_MISSING");
  const anchors = document.filter(e => e.tagName === "a");
  const name = anchors.some(e => { try { return key(text(e) || elements(e).find(n => n.tagName === "img")?.attrs.find(a => a.name === "alt")?.value || "") === key(source.venueName) &&
    officialKey(attr(e,"href")) === officialKey(source.officialUrl!); } catch { return false; } });
  const address = anchors.some(e => { try { const u = new URL(attr(e,"href")); return u.protocol === "https:" &&
    ["maps.google.com","www.google.com"].includes(u.hostname) && addressKey(text(e)) === addressKey(source.venueAddress!) &&
    addressKey(u.searchParams.get("q") ?? u.searchParams.get("query") ?? "") === addressKey(source.venueAddress!); } catch { return false; } });
  if (!name || !address) throw Error("ADAPTER_IDENTITY_MISMATCH");
  return createHash("sha256").update(JSON.stringify({official:officialKey(source.officialUrl),name:key(source.venueName),address:addressKey(source.venueAddress),timeZone:source.timeZone})).digest("hex");
}
export function golfBookDocument(html: string) {
  if (Buffer.byteLength(html) > 1_000_000) throw Error("ADAPTER_RESPONSE_LIMIT");
  return elements(parse(html));
}
export function golfBookTemplate(document: Element[], date: string) {
  const choices = document.filter(e => e.tagName === "button" && attr(e,"id") === "btn_tee_sheet" && /^(?:golf\s+)?simulators?$/iu.test(text(e)));
  if (choices.length !== 1) throw Error("ADAPTER_RENTAL_SCOPE_UNVERIFIED");
  const action = /^redirect\('bookingsheet',\s*'date=(\d{4}-\d{2}-\d{2})&templateId=([1-9]\d{0,9})'\);?$/u.exec(attr(choices[0],"onclick"));
  if (!action || action[1] !== date) throw Error("ADAPTER_RENTAL_SCOPE_UNVERIFIED"); return action[2];
}
export function golfBookSettings(document: Element[], date: string, templateId: string, identitySha256: string): GolfBookMetadata {
  const hidden = (name: string) => { const rows = document.filter(e => e.tagName === "input" && attr(e,"id") === name);
    if (rows.length !== 1) throw Error("ADAPTER_CONFIGURATION_CHANGED"); return attr(rows[0],"value"); };
  if (hidden("waitlist_date") !== date || hidden("waitlist_template") !== templateId) throw Error("ADAPTER_TARGET_MISMATCH");
  const tables = document.filter(e => e.tagName === "table" && attr(e,"id") === "bookingsheet");
  if (tables.length !== 1) throw Error("ADAPTER_CONFIGURATION_CHANGED");
  const heads = elements(tables[0]).filter(e => e.tagName === "th" && attr(e,"id").startsWith("th_"));
  if (heads.some(e => !/^(?:(?:golf\s+)?(?:simulator\s+)?bay|simulator)\s*#?\s*\d+\b/iu.test(text(e)) || /\bdarts?|karaoke|rooftop|dining\b/iu.test(text(e)))) throw Error("ADAPTER_RENTAL_SCOPE_UNVERIFIED");
  return golfBookMetadataSchema.parse({ family:"GOLFBOOK",templateId,resourceIds:heads.map(e=>attr(e,"id").slice(3)),
    incrementMinutes:Number(hidden("template_booking_increment_mins")),minDurationMinutes:Number(hidden("template_min_booking_mins")),
    maxDurationMinutes:Number(hidden("template_max_booking_mins")),identitySha256 });
}
