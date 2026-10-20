import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { completeUSAddress, fullCourseName } from "./teeitup-official-identity";

const id = z.string().uuid();
const duration = z.number().int().min(15).max(480);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const variationSchema = z.object({ id, companyId: id, parentId: id, duration, acceptsOnlineBooking: z.boolean(),
  employmentId: id.nullable(), locationId: id.nullable() });
const serviceSchema = z.object({ id, companyId: id, name: z.string().min(2).max(200), acceptsOnlineBooking: z.boolean(), bookable: z.boolean(),
  employmentIds: z.array(id).max(40), locationIds: z.array(id).max(40), availableDurations: z.array(duration).max(32), variations: z.array(variationSchema).max(100) });
export const lightspeedCatalogSchema = z.object({ companyId: id, facilityId: id, services: z.array(serviceSchema).min(1).max(40) });
const metadataService = z.object({ id, name: z.string().min(2).max(200), locationIds: z.array(id).min(1).max(10).refine(unique),
  durations: z.array(z.object({ minutes: duration, variationId: id }).strict()).min(1).max(32)
    .refine(values => unique(values.map(value => value.minutes)) && unique(values.map(value => value.variationId))) }).strict();
export const lightspeedMetadataSchema = z.object({ family: z.literal("LIGHTSPEED"), companyId: id, facilityId: id,
  services: z.array(metadataService).min(1).max(20).refine(values => unique(values.map(value => value.id))) }).strict();
export type LightspeedMetadata = z.infer<typeof lightspeedMetadataSchema>;
export type LightspeedCatalog = z.infer<typeof lightspeedCatalogSchema>;

export function parseLightspeedSource(value: string) {
  try { const url = new URL(value); const match = /^\/([a-f0-9-]{36})\/?$/u.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "booking.lightspeed.app" || url.port || url.username || url.password || url.search || url.hash || !match || !id.safeParse(match[1]).success) return null;
    return { companyId: match[1], url: `https://booking.lightspeed.app/${match[1]}` };
  } catch { return null; }
}

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const isElement = (node: Node): node is Element => "tagName" in node;
const attribute = (node: Element, name: string) => node.attrs.find(value => value.name === name)?.value;
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form"].includes(node.tagName) ||
  node.attrs.some(value => ["hidden", "inert"].includes(value.name)) || attribute(node, "aria-hidden") === "true" ||
  /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attribute(node, "style") ?? "") ||
  /(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attribute(node, "style") ?? "") ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only|screen-reader-text|hide)(?:\s|$)/iu.test(attribute(node, "class") ?? "");
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (isElement(node) && excluded(node)) return "";
  return "childNodes" in node ? node.childNodes.map(text).join(" ").replace(/\s+/gu, " ").trim() : "";
}
function elements(root: Node) {
  const result: Element[] = [];
  const visit = (node: Node, depth: number) => {
    if (depth > 80 || result.length > 20_000) throw new Error("ADAPTER_DOCUMENT_LIMIT");
    if (isElement(node)) result.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
  };
  visit(root, 0); return result;
}

/** Decode literal Flight JSON only. Never evaluate public script or React references. */
export function lightspeedFlightObjects(html: string): Record<string, unknown>[] {
  if (Buffer.byteLength(html) > 2_000_000) throw new Error("ADAPTER_RESPONSE_LIMIT");
  const chunks: string[] = [];
  for (const node of elements(parse(html)).filter(node => node.tagName === "script" && !attribute(node, "src"))) {
    const script = node.childNodes.filter(child => child.nodeName === "#text").map(child => (child as DefaultTreeAdapterMap["textNode"]).value).join("").trim();
    const match = /^self\.__next_f\.push\((\[[\s\S]*\])\);?$/u.exec(script);
    if (!match) continue;
    let value: unknown; try { value = JSON.parse(match[1]); } catch { throw new Error("ADAPTER_FLIGHT_INVALID"); }
    if (Array.isArray(value) && value[0] === 1 && typeof value[1] === "string") chunks.push(value[1]);
    if (chunks.length > 400) throw new Error("ADAPTER_DOCUMENT_LIMIT");
  }
  const found: Record<string, unknown>[] = []; let visits = 0;
  const walk = (value: unknown, depth: number) => {
    if (++visits > 60_000 || depth > 50) throw new Error("ADAPTER_DOCUMENT_LIMIT");
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) found.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const line of chunks.join("").split("\n")) {
    const match = /^[a-z0-9]+:([\[{][\s\S]*)$/iu.exec(line); if (!match) continue;
    let value: unknown; try { value = JSON.parse(match[1]); } catch { continue; }
    walk(value, 0);
  }
  if (!found.length) throw new Error("ADAPTER_FLIGHT_MISSING");
  return found;
}
export function lightspeedProps(html: string, keys: string[]) {
  const matches = lightspeedFlightObjects(html).filter(value => keys.every(key => Object.hasOwn(value, key)));
  if (matches.length !== 1) throw new Error("ADAPTER_PROPS_AMBIGUOUS");
  return matches[0];
}
export function verifyLightspeedDocumentUrl(html: string, expectedUrl: string) {
  const matches = lightspeedFlightObjects(html).filter(value => Array.isArray(value.c) && value.c.every(part => typeof part === "string"));
  if (matches.length !== 1 || new URL((matches[0].c as string[]).join("/"), "https://booking.lightspeed.app").href !== expectedUrl)
    throw new Error("ADAPTER_DOCUMENT_URL_MISMATCH");
}
export function lightspeedDocumentText(html: string) { return text(parse(html)); }

export function lightspeedMetadata(catalog: LightspeedCatalog): LightspeedMetadata {
  if (!unique(catalog.services.map(service => service.id))) throw new Error("ADAPTER_CATALOG_AMBIGUOUS");
  const services: LightspeedMetadata["services"] = [];
  for (const service of catalog.services) {
    if (/\b(?:lessons?|fittings?|members?|membership|leagues?|coaching|classes?|parties|events?|gift|retail)\b/iu.test(service.name)) continue;
    if (!service.acceptsOnlineBooking || !service.bookable || !/\b(?:bays?|simulators?|rental|golf time)\b/iu.test(service.name) || service.companyId !== catalog.companyId ||
        service.employmentIds.length || service.locationIds.length !== 1 || !unique(service.availableDurations)) throw new Error("ADAPTER_RENTAL_UNVERIFIED");
    const durations = service.availableDurations.map(minutes => {
      const choices = service.variations.filter(value => value.duration === minutes);
      if (choices.length !== 1 || choices[0].companyId !== catalog.companyId || choices[0].parentId !== service.id ||
          !choices[0].acceptsOnlineBooking || choices[0].employmentId !== null || choices[0].locationId !== null) throw new Error("ADAPTER_VARIATION_UNVERIFIED");
      return { minutes, variationId: choices[0].id };
    }).sort((a, b) => a.minutes - b.minutes);
    services.push({ id: service.id, name: service.name, locationIds: [...service.locationIds].sort(), durations });
  }
  return lightspeedMetadataSchema.parse({ family: "LIGHTSPEED", companyId: catalog.companyId, facilityId: catalog.facilityId,
    services: services.sort((a, b) => a.id < b.id ? -1 : 1) });
}

/** Fresh official identity, address and sole Lightspeed company link bind the catalog. */
export function verifyLightspeedOfficialPage(source: { officialUrl: string; bookingUrl: string; venueName: string; venueAddress?: string }, html: string) {
  if (!source.venueAddress) throw new Error("ADAPTER_IDENTITY_MISSING");
  const address = completeUSAddress(source.venueAddress), expected = fullCourseName(source.venueName), booking = parseLightspeedSource(source.bookingUrl);
  if (!address || !booking || expected.length < 5) throw new Error("ADAPTER_IDENTITY_MISSING");
  const all = elements(parse(html)), visible = all.filter(node => {
    let current: Node | null | undefined = node;
    while (current && isElement(current)) { if (excluded(current)) return false; current = current.parentNode; }
    return true;
  });
  const title = visible.filter(node => node.tagName === "title");
  if (title.length !== 1 || !text(title[0]).split(/[|–—]/u).some(value => fullCourseName(value) === expected)) throw new Error("ADAPTER_IDENTITY_MISMATCH");
  const links = visible.filter(node => node.tagName === "a").flatMap(node => {
    try { const value = new URL(attribute(node, "href") ?? "", source.officialUrl).href; return parseLightspeedSource(value) ? [value.replace(/\/$/u, "")] : []; } catch { return []; }
  });
  if (!links.includes(booking.url) || new Set(links).size !== 1) throw new Error("ADAPTER_IDENTITY_MISMATCH");
  const normalized = (value: string) => value.toLowerCase().replace(/\b(?:avenue|street|drive|road|boulevard|lane|court|parkway|highway|circle|trail|terrace)\b/gu,
    word => ({ avenue: "ave", street: "st", drive: "dr", road: "rd", boulevard: "blvd", lane: "ln", court: "ct", parkway: "pkwy", highway: "hwy", circle: "cir", trail: "trl", terrace: "ter" })[word]!)
    .replace(/[^a-z0-9]+/gu, " ").trim();
  const needle = normalized(`${address.street} ${address.locality} ${address.region} ${address.postalCode}`);
  if (!visible.some(node => {
    const value = text(node);
    if (value.length >= 800 || !` ${normalized(value)} `.includes(` ${needle} `)) return false;
    let current: Node | null | undefined = node;
    for (let depth = 0; current && isElement(current) && depth < 4; depth++, current = current.parentNode) {
      const context = `${attribute(current, "aria-label") ?? ""} ${attribute(current, "title") ?? ""} ${text(current)}`;
      if (/\b(?:mailing|corporate|billing|headquarters|p\.?\s*o\.?\s*box)\b/iu.test(context)) return false;
    }
    return true;
  })) throw new Error("ADAPTER_IDENTITY_MISMATCH");
}
