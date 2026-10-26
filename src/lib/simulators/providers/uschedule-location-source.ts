import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import type { OfficialIdentityPage } from "@/lib/course-discovery/teeitup-official-identity";
import type { OfficialSourceDiagnostic } from "@/lib/course-discovery/official-source-diagnostics";
import { isUSchedulePublicHost } from "./public-configuration";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const id = z.string().regex(/^[1-9]\d{0,9}$/u);
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const nameKey = (value: string) => clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(): never { throw new Error("USCHEDULE_PUBLIC_LOCATION_UNVERIFIED"); }
export const USCHEDULE_LOCATION_CLIENT = Object.freeze({ path: "/bundles/js/bookingBS5",
  sha256: "569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e" });

/** A public location filter is source context, never a selected appointment. */
export function parseUScheduleLocationSource(value: string) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) return;
  try {
    const url = new URL(value), tenant = /^\/([a-z](?:[a-z0-9-]{1,61}[a-z0-9]))\/booking$/u.exec(url.pathname)?.[1];
    if (!tenant || url.protocol !== "https:" || !isUSchedulePublicHost(url.hostname) || url.port || url.username || url.password || url.hash ||
        url.hostname === "iframe.uschedule.com" && url.search) return;
    const keys = [...url.searchParams.keys()];
    if (keys.length > 1 || keys.some(key => key !== "filter")) return;
    const filter = url.searchParams.get("filter");
    const locationId = filter === null ? undefined : /^loc\[([1-9]\d{0,9})\]$/u.exec(filter)?.[1];
    if (filter !== null && !locationId) return;
    return { tenant, url: url.href, canonicalUrl: `${url.origin}${url.pathname}`, locationId };
  } catch { return; }
}

export const uscheduleOfficialLocationProofSchema = z.object({
  kind: z.literal("OFFICIAL_PUBLIC_LOCATION_V1"), officialPageUrl: z.string().url().max(2048),
  entryUrl: z.string().max(2048).refine(value => Boolean(parseUScheduleLocationSource(value)?.locationId)),
  locationId: id, venueName: z.string().min(3).max(200), addressKey: z.string().min(15).max(1024), markupWitnessSha256: sha,
}).strict();
export type UScheduleOfficialLocationProof = z.infer<typeof uscheduleOfficialLocationProofSchema>;
export const uschedulePublicLocationProofSchema = z.object({
  kind: z.literal("PUBLIC_LOCATION_RENTAL_V1"), official: uscheduleOfficialLocationProofSchema,
  locationId: id, locationName: z.string().min(3).max(200), catalogHash: sha,
  includedPartySize: z.literal(2), maxPartySize: z.literal(4),
  resourceGroups: z.array(z.object({ id, resources: z.array(z.object({ id, name: z.string().min(3).max(200) }).strict()).min(1).max(20) }).strict()).length(1),
  client: z.object({ path: z.literal("/bundles/js/bookingBS5"),
    sha256: z.literal("569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e") }).strict(),
}).strict();
export type USchedulePublicLocationProof = z.infer<typeof uschedulePublicLocationProofSchema>;
export function isUScheduleNonMemberRental(value: string) { return /^non-member hourly rental$/u.test(clean(value).toLowerCase()); }

const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(value => value.name === key)?.value;
const children = (node: Node) => "childNodes" in node ? node.childNodes.filter(element) : [];
const classes = (node: Element) => (attr(node, "class") ?? "").split(/\s+/u);
function within(node: Node, ancestor: Element): boolean {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (current === ancestor) return true;
  return false;
}
function hidden(node: Element) {
  let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (element(current) && (["script", "style", "template", "noscript", "iframe"].includes(current.tagName) ||
      attr(current, "hidden") !== undefined || attr(current, "inert") !== undefined || attr(current, "aria-hidden") === "true" ||
      /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only)(?:\s|$)/iu.test(attr(current, "class") ?? "") ||
      /display\s*:\s*none|visibility\s*:\s*hidden|(?:^|;)\s*opacity\s*:\s*0(?:[.;]|$)/iu.test(attr(current, "style") ?? ""))) return true;
  }
  return false;
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && (["script", "style", "template", "noscript", "iframe", "input", "textarea"].includes(node.tagName) || hidden(node))) return "";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
function nodes(html: string) {
  if (Buffer.byteLength(html) > 600_000) return fail();
  const found: Element[] = [], stack: Array<{ node: Node; depth: number }> = [{ node: parse(html), depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (depth > 80 || found.length > 20_000) return fail();
    if (element(node)) found.push(node);
    if ("childNodes" in node) for (const child of [...node.childNodes].reverse()) stack.push({ node: child, depth: depth + 1 });
  }
  return found;
}
function addressKey(value: string) {
  return clean(value).toLowerCase().replace(/\b(?:united states of america|united states|usa)\b/gu, "us")
    .replace(/\b(?:suite|ste)\b|#/gu, " ste ")
    .replace(/\b(?:street|road|drive|avenue|boulevard)\b/gu, word => ({ street: "st", road: "rd", drive: "dr", avenue: "ave", boulevard: "blvd" })[word]!)
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/ us$/u, "");
}
function witness(node: Element) {
  const ancestry: unknown[] = []; let current: Node | undefined = node;
  for (let depth = 0; current && depth < 80; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined)
    if (element(current)) ancestry.push([current.tagName, current.attrs.filter(value => ["id", "class", "style", "hidden", "inert", "aria-hidden", "href"].includes(value.name))
      .map(value => [value.name, value.value]).sort()]);
  return [clean(text(node)), ancestry];
}
type Source = { officialUrl?: string; bookingUrl: string; venueName: string; venueAddress?: string; timeZone: string };
export function sameUScheduleOfficialSite(left: string, right: string) {
  try {
    const a = new URL(left), b = new URL(right);
    return [a, b].every(url => url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash) &&
      a.hostname.replace(/^www\./u, "") === b.hostname.replace(/^www\./u, "");
  } catch { return false; }
}
export type UScheduleOfficialIdentityPage = OfficialIdentityPage & { officialDocumentProof?: {
  kind: "VERIFIED_OFFICIAL_DOCUMENT"; officialUrl: string; documentUrl: string;
} };
export function deriveUScheduleOfficialLocation(source: Source, page: UScheduleOfficialIdentityPage, requireVisibleEvidence = true,
  onDiagnostic?: (value: OfficialSourceDiagnostic) => void): UScheduleOfficialLocationProof {
  const facts: OfficialSourceDiagnostic = { stage: "SOURCE_CONTEXT" };
  const emit = () => { try { onDiagnostic?.({ ...facts }); } catch { /* Diagnostics cannot change identity validation. */ } };
  const check = (condition: unknown, stage: OfficialSourceDiagnostic["stage"], key: Exclude<keyof OfficialSourceDiagnostic, "stage">) => {
    facts.stage = stage; facts[key] = Boolean(condition); emit(); if (!condition) return fail();
  };
  const booking = parseUScheduleLocationSource(source.bookingUrl);
  check(booking && source.officialUrl && source.venueAddress && /^\d/u.test(source.venueAddress) && /\b\d{5}(?:-\d{4})?\b/u.test(source.venueAddress), "SOURCE_CONTEXT", "sourceContextValid");
  if (!booking || !source.officialUrl || !source.venueAddress) return fail();
  const current = new URL(page.url), official = new URL(source.officialUrl);
  check(sameUScheduleOfficialSite(current.href, official.href), "OFFICIAL_SITE", "officialSiteMatches");
  // An alias is accepted initially only after the live controller verified the
  // actual official HTTP document. Warm reads use the exact saved URL and hash.
  if (requireVisibleEvidence) check(current.origin === official.origin || page.officialDocumentProof?.kind === "VERIFIED_OFFICIAL_DOCUMENT" &&
    page.officialDocumentProof.officialUrl === source.officialUrl && page.officialDocumentProof.documentUrl === current.href, "OFFICIAL_PROVENANCE", "officialProvenance");
  facts.stage = "RAW_DOCUMENT"; emit();
  const all = nodes(page.html), expected = nameKey(source.venueName), canonicalAddress = addressKey(source.venueAddress);
  const headings = all.filter(node => node.tagName === "h1" && !hidden(node));
  check(expected.length >= 8 && headings.length === 1 && nameKey(text(headings[0])) === expected, "RAW_VENUE", "rawVenueMatches");
  const links = all.filter(node => node.tagName === "a" && !hidden(node) && /\b(?:tee\s*time|book|rental|reservation)/iu.test(text(node))).flatMap(node => {
    try { const value = parseUScheduleLocationSource(new URL(attr(node, "href") ?? "", current).href);
      return value?.locationId && value.canonicalUrl === booking.canonicalUrl ? [{ node, value }] : []; } catch { return []; }
  });
  check(links.length && new Set(links.map(value => value.value.url)).size === 1, "RAW_LINK", "rawLinkMatches");
  const link = links[0].value;
  check(!booking.locationId || booking.locationId === link.locationId, "RAW_LINK", "rawLinkMatches");
  const addresses = all.filter(node => ["address", "p", "div", "li", "td"].includes(node.tagName) && !hidden(node))
    .filter(node => { const value = clean(text(node)); return value.length <= 500 && (` ${addressKey(value)} `).includes(` ${canonicalAddress} `); });
  check(addresses.length, "RAW_ADDRESS", "rawAddressMatches");
  const visible = page.visibleEvidence;
  if (requireVisibleEvidence) {
    check(visible?.headings.some(value => nameKey(value) === expected), "RENDERED_VENUE", "renderedVenueMatches");
    check(visible?.linkUrls.includes(link.url), "RENDERED_LINK", "renderedLinkMatches");
    check(visible?.addressTexts.some(value => (` ${addressKey(value)} `).includes(` ${canonicalAddress} `)), "RENDERED_ADDRESS", "renderedAddressMatches");
  }
  const markup = [...headings, ...links.map(value => value.node), ...addresses].map(witness);
  const proof = uscheduleOfficialLocationProofSchema.parse({ kind: "OFFICIAL_PUBLIC_LOCATION_V1", officialPageUrl: current.href, entryUrl: link.url,
    locationId: link.locationId, venueName: source.venueName, addressKey: canonicalAddress, markupWitnessSha256: digest(markup) });
  facts.stage = "LOCATION_VERIFIED"; emit();
  return proof;
}

export function readUScheduleLocationCatalog(html: string, sourceUrl: string, official: UScheduleOfficialLocationProof) {
  const source = parseUScheduleLocationSource(sourceUrl), entry = parseUScheduleLocationSource(official.entryUrl);
  if (!source || !entry || source.canonicalUrl !== entry.canonicalUrl || entry.locationId !== official.locationId) return fail();
  const all = nodes(html), body = all.filter(node => node.tagName === "body");
  if (body.length !== 1 || !(attr(body[0], "class") ?? "").split(/\s+/u).includes(source.tenant) ||
      all.some(node => node.tagName === "input" && attr(node, "type") === "password" && !hidden(node))) return fail();
  const visible = clean(text(body[0]));
  if (/checking your browser|verify (?:that )?you are human|captcha|authentication required|(?:sign|log) in to continue/iu.test(visible)) return fail();
  const options = (selector: string) => {
    const found = all.filter(node => node.tagName === "select" && attr(node, "id") === selector);
    if (found.length !== 1 || hidden(found[0])) return fail();
    if (children(found[0]).some(node => node.tagName !== "option" || children(node).length)) return fail();
    const values = found[0].childNodes.filter(element).filter(node => node.tagName === "option").map(node => ({ id: attr(node, "value") ?? "",
      name: clean(text(node)), selected: attr(node, "selected") !== undefined }));
    if (!values.length || values.length > 40 || new Set(values.map(value => value.id)).size !== values.length || values.filter(value => value.selected).length !== 1) return fail();
    return values;
  };
  const locations = options("select_location"), services = options("select_service"), lengths = options("select_length");
  if (locations.some(value => !id.safeParse(value.id).success) || services.some(value => !id.safeParse(value.id).success) ||
      lengths.some(value => !/^(?:[1-9]\d{0,2})$/u.test(value.id) || Number(value.id) < 15 || Number(value.id) > 480) ||
      all.some(node => node.tagName === "select" && attr(node, "id") === "select_group_size")) return fail();
  const location = locations.find(value => value.id === official.locationId), rentals = services.filter(value => isUScheduleNonMemberRental(value.name));
  if (!location || nameKey(location.name) !== nameKey(official.venueName) || locations.filter(value => nameKey(value.name) === nameKey(official.venueName)).length !== 1 || rentals.length !== 1) return fail();
  // Initial support covers this sole public rental. An unclassified additional
  // product cannot be silently omitted from venue-wide availability.
  if (services.some(value => !isUScheduleNonMemberRental(value.name) &&
      !/\blesson\b/iu.test(value.name) && !/^(?:member|members)[\s-]/iu.test(value.name))) return fail();
  if (!rentals[0].selected) return fail();
  const columns = all.filter(node => node.tagName === "div" && classes(node).includes("col-lg-4") && classes(node).includes("order-1"));
  const column = columns.find(node => all.some(select => attr(select, "id") === "select_service" && within(select, node)));
  if (!column || columns.filter(node => all.some(select => attr(select, "id") === "select_service" && within(select, node))).length !== 1) return fail();
  for (const [section, control] of [["location_section", "select_location"], ["service_section", "select_service"]]) {
    const sections = all.filter(node => attr(node, "id") === section && node.parentNode === column);
    if (sections.length !== 1 || !all.some(node => attr(node, "id") === control && within(node, sections[0]))) return fail();
  }
  const selectedLocation = locations.find(value => value.selected)!;
  const locationStem = nameKey(selectedLocation.name.replace(/\b(?:indoor|golf|club)\b/giu, ""));
  if (locationStem.length < 3) return fail();
  const groups = all.filter(node => node.tagName === "select" && (attr(node, "class") ?? "").split(/\s+/u).includes("resSelect"));
  if (groups.length !== 1) return fail();
  const resourceGroups = groups.map(node => {
    const groupId = /^resource([1-9]\d{0,9})$/u.exec(attr(node, "id") ?? "")?.[1];
    if (!groupId || hidden(node)) return fail();
    const sections = all.filter(value => attr(value, "id") === "res_section" && value.parentNode === column && within(node, value));
    const labels = sections.length === 1 ? children(sections[0]).filter(value => value.tagName === "label" && attr(value, "for") === `resource${groupId}` && classes(value).includes("choose_label") && !hidden(value)) : [];
    const label = labels.length === 1 ? /^Simulators\s*-\s*(.+)$/iu.exec(clean(text(labels[0])))?.[1] : undefined;
    if (!label || nameKey(label) !== locationStem) return fail();
    const values = options(`resource${groupId}`), any = values.filter(value => value.selected);
    const resources = values.filter(value => value.id !== "-1").map(({ id, name }) => ({ id, name }));
    if (any[0].id !== "-1" || !/^any available$/iu.test(any[0].name) || !resources.length || resources.length > 20 ||
        resources.some(value => { const match = /^(.+)\s+-\s+Bay\s+([1-9]\d?)$/iu.exec(value.name);
          return !id.safeParse(value.id).success || !match || nameKey(match[1]) !== locationStem; })) return fail();
    return { id: groupId, resources };
  });
  if (new Set(resourceGroups.map(value => value.id)).size !== resourceGroups.length) return fail();
  const addons = all.filter(node => node.tagName === "select" && (attr(node, "class") ?? "").split(/\s+/u).includes("addOnSelect")).map(node => {
    const addonId = /^addon([1-9]\d{0,9})$/u.exec(attr(node, "id") ?? "")?.[1];
    if (!addonId) return fail();
    const values = options(`addon${addonId}`); if (values.find(value => value.selected)?.id !== "0" || values.some(value => !/^(?:0|[1-9]\d{0,2})$/u.test(value.id))) return fail();
    return { id: addonId, options: values.map(({ id, name }) => ({ id, name })) };
  });
  const cards = children(column).filter(node => classes(node).includes("card") && classes(node).includes("my-3") && !hidden(node));
  const guestCards = cards.filter(node => children(node).some(body => classes(body).includes("card-body") && !hidden(body) &&
    children(body).some(item => item.tagName === "p" && clean(text(item)) === "Simulators:") &&
    children(body).some(item => item.tagName === "p" && clean(text(item)) === "Additional Guest(s):")));
  if (guestCards.length !== 1) return fail();
  const guestItems = all.filter(node => node.tagName === "li" && within(node, guestCards[0]) && !hidden(node)).map(node => clean(text(node)));
  const included = guestItems.filter(value => /^Non-members may bring 1 guest for free\.$/iu.test(value));
  const maximum = guestItems.filter(value => /^You may add 2 additional guests if you wish\. The charge is \$\d+(?:\.\d{2})? per person\/per hour\. Max of 4 people in the bay\.$/iu.test(value));
  const descriptions = all.filter(node => attr(node, "id") === "serv_desc_section" && !hidden(node) && node.parentNode && element(node.parentNode) &&
    classes(node.parentNode).includes("serv_only_desc") && node.parentNode.parentNode && element(node.parentNode.parentNode) && attr(node.parentNode.parentNode, "id") === "right_column");
  if (included.length !== 1 || maximum.length !== 1 || descriptions.length !== 1 ||
      children(descriptions[0])[0]?.tagName !== "p" || clean(text(children(descriptions[0])[0])) !== "Non-Member Tee Time Guidelines" ||
      all.filter(node => node.tagName === "li" && within(node, descriptions[0]) && !hidden(node) &&
        clean(text(node)) === "Non-members reservations include 1 guest, for free.").length !== 1) return fail();
  const scripts = all.filter(node => node.tagName === "script" && attr(node, "src")).flatMap(node => {
    try { const url = new URL(attr(node, "src")!, source.url);
      return url.origin === new URL(source.url).origin && url.pathname === USCHEDULE_LOCATION_CLIENT.path && !url.username && !url.password && !url.port && !url.hash &&
        (url.search === "" || url.searchParams.size === 1 && /^[A-Za-z0-9_-]{44}$/u.test(url.searchParams.get("v") ?? "")) ? [url.href] : []; } catch { return []; }
  });
  if (scripts.length !== 1) return fail();
  const facts = { tenant: source.tenant, locations: locations.map(({ id, name }) => ({ id, name })), services: services.map(({ id, name }) => ({ id, name })),
    durations: lengths.map(value => Number(value.id)), resourceGroups, addons, guestContext: [...included, ...maximum].sort(), includedPartySize: 2, maxPartySize: 4 };
  const proof = uschedulePublicLocationProofSchema.parse({ kind: "PUBLIC_LOCATION_RENTAL_V1", official, locationId: location.id,
    locationName: location.name, catalogHash: digest(facts), includedPartySize: 2, maxPartySize: 4, resourceGroups, client: USCHEDULE_LOCATION_CLIENT });
  return { proof, locationSelected: location.selected, selectedServiceId: services.find(value => value.selected)!.id,
    selectedDuration: Number(lengths.find(value => value.selected)!.id), service: { serviceId: rentals[0].id, serviceName: rentals[0].name },
    durations: facts.durations, clientUrl: scripts[0] };
}
