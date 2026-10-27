import { parse, type DefaultTreeAdapterMap } from "parse5";
import { readUScheduleNextAvailableView } from "./uschedule-public-view-control";
import { createHash } from "node:crypto";
import { isUSchedulePublicHost } from "@/lib/simulators/providers/public-configuration";
import { parseUScheduleLocationSource, readUScheduleLocationCatalog, USCHEDULE_LOCATION_CLIENT,
  type UScheduleOfficialLocationProof } from "@/lib/simulators/providers/uschedule-location-source";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const publicId = /^(?:0|[1-9]\d{0,9})$/u;
const rental = /\b(?:simulators?|bays?)\b.*\brentals?\b/iu;
const excluded = /\b(?:lessons?|coaching|fitting|leagues?|classes?|members?|membership|package)\b/iu;
const simBooking = /^sim booking$/iu;
const standardSimulatorBooking = /^simulator booking$/iu;
const disallowedDescription = /\b(?:lessons?|coaching|fitting|leagues?|classes?|members?|membership|packages?|events?|parties?|birthdays?|clinics?|camps?|private|account|checkout|payment|purchase|gift)\b/iu;
const normalizedLabel = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
export function isUScheduleSimBookingLabel(value: string) { return simBooking.test(normalizedLabel(value)); }
export function isUScheduleStandardSimulatorBookingLabel(value: string) { return standardSimulatorBooking.test(normalizedLabel(value)); }
/** USCHEDULE simulator adapter only; recipe validation rejects OUTDOOR targets. */
export function isUSchedulePublicRentalLabel(value: string) {
  const label = normalizedLabel(value), publicTeeTimes = /^public tee times$/iu.test(label);
  return (rental.test(label) || /^suite rentals?$/iu.test(label) || publicTeeTimes || simBooking.test(label) || standardSimulatorBooking.test(label)) && !excluded.test(label);
}
function elements(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : elements(child)) : [];
}
function attr(node: Element, name: string) { return node.attrs.find(value => value.name === name)?.value; }
function text(node: Node): string {
  return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
/** One visible public service description corroborates the otherwise terse
 * `Sim Booking` option. The option alone never establishes a rental method. */
export function hasUScheduleSimBookingDescription(html: string) {
  if (Buffer.byteLength(html) > 600_000) return false;
  const nodes = elements(parse(html)); if (nodes.length > 20_000) return false;
  const descriptions = nodes.filter(node => node.tagName === "div" && attr(node, "id") === "serviceDescription");
  if (descriptions.length !== 1) return false;
  const hidden = (node: Element) => node.attrs.some(a => ["hidden", "inert"].includes(a.name) ||
    ["aria-hidden", "aria-disabled"].includes(a.name) && a.value === "true") ||
    /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(node, "style") ?? "");
  for (let node: Node | undefined = descriptions[0]; node; node = "parentNode" in node ? node.parentNode ?? undefined : undefined)
    if ("tagName" in node && hidden(node)) return false;
  const visible = (node: Node): string => "value" in node ? node.value : "tagName" in node &&
    (["script", "style", "template", "noscript", "textarea", "input"].includes(node.tagName) || hidden(node)) ? "" :
    "childNodes" in node ? node.childNodes.map(visible).join(" ") : "";
  const description = normalizedLabel(visible(descriptions[0]));
  return description.length > 0 && description.length <= 500 && /\b(?:play|practice)\b/iu.test(description) &&
    /\bsimulators?\b/iu.test(description) && !disallowedDescription.test(description);
}
function publicControlUnsafe(n: Node) {
  let current: Node | undefined = n;
  for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!("tagName" in current)) continue;
    if (["form", "template", "script", "style", "noscript", "iframe"].includes(current.tagName) ||
        current.attrs.some(a => ["hidden", "inert", "disabled", "onclick"].includes(a.name) || ["aria-hidden", "aria-disabled"].includes(a.name) && a.value === "true") ||
        /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(current, "style") ?? "") ||
        /\b(?:hidden|d-none|invisible|visually-hidden|sr-only|private|members?|account|profile|checkout|payment|billing|login)\b/iu.test(["id", "class", "aria-label", "title"].map(k => attr(current as Element, k) ?? "").join(" "))) return true;
  }
  return current !== undefined;
}
function rentalNotes(nodes: Element[]) {
  const cls = (n: Element, name: string) => (attr(n, "class") ?? "").split(/\s/u).includes(name);
  const grids = nodes.filter(n => cls(n, "time_choices")), lists = nodes.filter(n => cls(n, "next_avail_results"));
  const parent = grids.length === 1 ? grids[0].parentNode : !grids.length && lists.length && lists.every(n => n.parentNode === lists[0].parentNode) ? lists[0].parentNode : undefined;
  if (!parent || !("tagName" in parent) || !cls(parent, "choices") || !parent.parentNode) return [];
  const siblings = "childNodes" in parent.parentNode ? parent.parentNode.childNodes.filter((n): n is Element => "tagName" in n) : [];
  // Inline spans may split a word in the source. DOM textContent concatenates
  // those text nodes; insert no invented space inside an inline word.
  const inline = (n: Node): string => "value" in n ? n.value : "tagName" in n && n.tagName === "br" ? " " : "childNodes" in n ? n.childNodes.map(inline).join("") : "";
  const notes = siblings.slice(siblings.indexOf(parent) + 1).filter(n => cls(n, "card"))
    .flatMap(card => elements(card).filter(n => n.tagName === "li" && !publicControlUnsafe(n) && !elements(n).some(c => publicControlUnsafe(c) || ["li", "input", "select", "button", "textarea"].includes(c.tagName))))
    .map(n => inline(n).normalize("NFKC").replace(/\s+/gu, " ").trim());
  const descriptions = nodes.filter(n => attr(n, "id") === "serv_desc_section");
  if (descriptions.length > 1) throw new Error("USCHEDULE_PUBLIC_DESCRIPTION_AMBIGUOUS");
  const description = descriptions[0];
  if (description && !publicControlUnsafe(description)) {
    const descendants = elements(description);
    if (descendants.length > 1000 || Buffer.byteLength(inline(description)) > 20_000) throw new Error("USCHEDULE_PUBLIC_DESCRIPTION_UNBOUNDED");
    const block = (n: Element) => ["div", "p", "li", "h1", "h2", "h3", "h4", "h5", "h6"].includes(n.tagName);
    // A block may mix its own restriction with child paragraphs. Never drop
    // that restriction and downgrade it to unknown while reading only leaves.
    const outsideBlocks = (n: Node): string => "value" in n ? n.value : "tagName" in n && block(n) ? " " : "childNodes" in n ? n.childNodes.map(outsideBlocks).join("") : "";
    for (const node of [description, ...descendants].filter(n => block(n) && !publicControlUnsafe(n) && elements(n).some(block))) {
      const own = node.childNodes.map(outsideBlocks).join("").normalize("NFKC");
      if (/\b(?:maximum|max|up to|only)\b/iu.test(own) && /\b(?:people|players?|golfers?|persons?)\b/iu.test(own) && /\b(?:simulators?|suites?|bays?)\b/iu.test(own) &&
          (!/\b(?:events?|venue|site|building|total capacity)\b/iu.test(own) || /\b(?:per|each) (?:bay|suite|simulator)\b/iu.test(own))) throw new Error("USCHEDULE_PUBLIC_DESCRIPTION_UNVERIFIED");
    }
    for (const node of [description, ...descendants].filter(n => block(n) && !elements(n).some(block))) {
      if (publicControlUnsafe(node)) continue;
      const value = inline(node).normalize("NFKC").replace(/\s+/gu, " ").trim();
      // Site/event totals cannot establish a simulator rental's party limit.
      if (/\b(?:events?|venue|site|building|total capacity)\b/iu.test(value) && !/\b(?:per|each) (?:bay|suite|simulator)\b/iu.test(value)) continue;
      if (elements(node).some(n => publicControlUnsafe(n) || ["a", "input", "select", "button", "textarea", "label"].includes(n.tagName))) {
        if (/\b(?:maximum|max|up to|only)\b/iu.test(value) && /\b(?:people|players?|golfers?|persons?)\b/iu.test(value)) throw new Error("USCHEDULE_PUBLIC_DESCRIPTION_UNVERIFIED");
        continue;
      }
      notes.push(value);
    }
  }
  return notes;
}
/** Some public booking layouts put the selected service, party control and
 * hourly simulator note together in a sidebar before the separate dated grid.
 * Require the note's card itself to contain no controls. */
function standardSidebarNotes(nodes: Element[]) {
  const cls = (n: Element, value: string) => (attr(n, "class") ?? "").split(/\s+/u).includes(value);
  const services = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_service");
  const groups = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_group_size");
  const grids = nodes.filter(n => cls(n, "time_choices"));
  if (services.length !== 1 || groups.length !== 1 || grids.length !== 1) return [];
  const selected = elements(services[0]).filter(n => n.tagName === "option" && attr(n, "selected") !== undefined);
  if (selected.length !== 1 || !isUScheduleStandardSimulatorBookingLabel(text(selected[0]))) return [];
  const contains = (parent: Element, child: Element) => {
    for (let node: Node | undefined = child; node; node = "parentNode" in node ? node.parentNode ?? undefined : undefined)
      if (node === parent) return true;
    return false;
  };
  const containers = nodes.filter(n => n.tagName === "div" && cls(n, "container") &&
    contains(n, services[0]) && contains(n, groups[0]) && contains(n, grids[0]));
  if (containers.length !== 1) return [];
  const sidebars = elements(containers[0]).filter(n => n.tagName === "div" && cls(n, "col-lg-4") && cls(n, "order-1") &&
    n.parentNode && "tagName" in n.parentNode && cls(n.parentNode, "row"));
  if (sidebars.length !== 1 || !contains(sidebars[0], services[0]) || !contains(sidebars[0], groups[0]) || contains(sidebars[0], grids[0])) return [];
  const cards = elements(sidebars[0]).filter(n => n.tagName === "div" && cls(n, "card") && cls(n, "my-3"));
  const values: string[] = [];
  for (const card of cards) {
    if (publicControlUnsafe(card) || elements(card).some(n => ["a", "button", "input", "select", "textarea", "form"].includes(n.tagName))) continue;
    const bodies = elements(card).filter(n => n.tagName === "div" && cls(n, "card-body"));
    if (bodies.length !== 1) continue;
    for (const heading of elements(bodies[0]).filter(n => n.tagName === "h3" && !publicControlUnsafe(n) && !elements(n).some(publicControlUnsafe))) {
      const value = normalizedLabel(text(heading));
      if (value.length > 0 && value.length <= 500 && /\b(?:rates?|prices?|pricing|costs?)\b/iu.test(value)) values.push(value);
    }
  }
  return values;
}
export function readUSchedulePublicRentalNotes(html: string) {
  if (Buffer.byteLength(html) > 600_000) return [];
  const nodes = elements(parse(html)); return nodes.length <= 20_000 ? [...rentalNotes(nodes), ...standardSidebarNotes(nodes)] : [];
}
/** A selected standard bay rental needs an independent public pricing witness.
 * The general service description can mention lessons and grants no authority. */
export function hasUScheduleStandardSimulatorBookingWitness(html: string) {
  if (Buffer.byteLength(html) > 600_000) return false;
  const nodes = elements(parse(html)); if (nodes.length > 20_000) return false;
  const services = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_service");
  const options = services.length === 1 ? elements(services[0]).filter(n => n.tagName === "option") : [];
  const selected = options.filter(n => attr(n, "selected") !== undefined);
  if (selected.length !== 1 || !isUScheduleStandardSimulatorBookingLabel(text(selected[0])) ||
      !publicId.test(attr(selected[0], "value") ?? "") || attr(selected[0], "value") === "0" ||
      options.filter(n => attr(n, "value") === attr(selected[0], "value")).length !== 1 || publicControlUnsafe(selected[0])) return false;
  const labels = nodes.filter(n => n.tagName === "label" && attr(n, "for") === "select_group_size");
  if (labels.length !== 1 || normalizedLabel(text(labels[0])) !== "Choose Party Size (doesn't affect pricing)" ||
      publicControlUnsafe(labels[0]) || elements(labels[0]).some(publicControlUnsafe)) return false;
  let notes: string[];
  try { notes = [...rentalNotes(nodes), ...standardSidebarNotes(nodes)]; } catch { return false; }
  const pricing = notes.filter(v => /\b(?:rates?|prices?|pricing|costs?)\b/iu.test(v) && /\bper\s+(?:hour|hr)\b/iu.test(v) &&
    /\bper\s+(?:simulator|bay)\b/iu.test(v));
  const contradictory = notes.some(v => /\b(?:rates?|prices?|pricing|costs?)\b/iu.test(v) &&
    /\bper\s+(?:person|player|golfer)\b/iu.test(v) && !/\bnot\s+per\s+(?:person|player|golfer)\b/iu.test(v));
  return pricing.length === 1 && !contradictory && /\bnot\s+per\s+(?:person|player|golfer)\b/iu.test(pricing[0]) &&
    !/\b(?:members?|membership|private|vip|lessons?|coaching|events?|parties?|packages?)\b/iu.test(pricing[0]);
}
/** Participant selection and dated-grid eligibility are distinct. Only the
 * existing # of People grid also requires the explicit per-bay pricing note. */
export function readUSchedulePublicPeopleControl(html: string) {
  const absent = { roleClaimed: false, valid: false, datedGridEligible: false, selectedPeople: undefined as number | undefined, values: [] as string[] };
  if (Buffer.byteLength(html) > 600_000) return { ...absent, roleClaimed: true };
  const nodes = elements(parse(html)); if (nodes.length > 20_000) return { ...absent, roleClaimed: true };
  const groups = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_group_size");
  const clean = (n: Node) => text(n).normalize("NFKC").replace(/\s+/gu, " ").trim();
  const labels = nodes.filter(n => n.tagName === "label" && attr(n, "for") === "select_group_size");
  const standardPartyLabel = "Choose Party Size (doesn't affect pricing)";
  if (!groups.length) return labels.some(n => ["Choose # of People", "Choose Party Size", standardPartyLabel].includes(clean(n))) ? { ...absent, roleClaimed: true } : absent;
  const roleClaimed = labels.some(n => ["Choose # of People", "Choose Party Size", standardPartyLabel].includes(clean(n))) ||
    nodes.some(n => attr(n, "id") === "group_size_section") && labels.length > 0;
  if (!roleClaimed) return absent;
  const invalid = { ...absent, roleClaimed: true };
  const sections = nodes.filter(n => attr(n, "id") === "group_size_section"), services = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_service");
  const selected = services.length === 1 ? elements(services[0]).filter(n => n.tagName === "option" && attr(n, "selected") !== undefined) : [];
  if (groups.length !== 1 || sections.length !== 1 || !elements(sections[0]).includes(groups[0]) || labels.length !== 1 ||
      !elements(sections[0]).includes(labels[0]) || !["Choose # of People", "Choose Party Size", standardPartyLabel].includes(clean(labels[0])) || publicControlUnsafe(labels[0]) || elements(labels[0]).some(publicControlUnsafe) || publicControlUnsafe(groups[0]) ||
      selected.length !== 1 || !isUSchedulePublicRentalLabel(clean(selected[0])) || /\b(?:private|members?|account|events?)\b/iu.test(clean(selected[0])) || publicControlUnsafe(selected[0]) || !/^[1-9]\d{0,9}$/u.test(attr(selected[0], "value") ?? "") ||
      (attr(groups[0], "onchange") ?? "").replace(/\s/gu, "") !== "groupSizeChanged();" ||
      nodes.some(n => n.tagName === "select" && (attr(n, "id") === "select_units_to_book" || (attr(n, "class") ?? "").split(/\s/u).includes("resSelect")))) return invalid;
  const notes = rentalNotes(nodes), costs = notes.filter(v => /\b(?:costs?|pricing|prices?|charged)\b.*\bper (?:bay|player)\b/iu.test(v));
  const gridLabel = clean(labels[0]) === "Choose # of People";
  const standardGridLabel = clean(labels[0]) === standardPartyLabel;
  if (standardGridLabel && !hasUScheduleStandardSimulatorBookingWitness(html)) return invalid;
  if (gridLabel && (costs.length !== 1 || costs[0] !== "Playing costs are per bay, not per player.")) return invalid;
  const options = elements(groups[0]).filter(n => n.tagName === "option"), values = options.map(n => attr(n, "value") ?? clean(n));
  const chosen = options.filter(n => attr(n, "selected") !== undefined);
  if (!options.length || options.length > 20 || options.some((n, i) => publicControlUnsafe(n) || !/^[1-9]\d?$/u.test(values[i]) || clean(n) !== values[i]) || new Set(values).size !== values.length || chosen.length !== 1) return invalid;
  return { roleClaimed: true, valid: true, datedGridEligible: (gridLabel || standardGridLabel) && nodes.filter(n => (attr(n, "class") ?? "").split(/\s/u).includes("time_choices")).length === 1,
    selectedPeople: Number(attr(chosen[0], "value") ?? clean(chosen[0])), values };
}
/** The pinned bookingBS5 unitsToBookChanged handler sends units_to_book,
 * not group_size. Its public unit quantity is never a golfer count. */
export function readUSchedulePublicUnitsControl(html: string) {
  const absent = { present: false, valid: false, selectedOne: false };
  if (Buffer.byteLength(html) > 600_000) return { ...absent, present: true };
  const nodes = elements(parse(html));
  if (nodes.length > 20_000) return { ...absent, present: true };
  const units = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_units_to_book");
  if (!units.length) return absent;
  const invalid = { ...absent, present: true };
  const clean = (n: Node) => text(n).normalize("NFKC").replace(/\s+/gu, " ").trim();
  const unsafe = publicControlUnsafe;
  const services = nodes.filter(n => n.tagName === "select" && attr(n, "id") === "select_service");
  const selected = services.length === 1 ? elements(services[0]).filter(n => n.tagName === "option" && attr(n, "selected") !== undefined) : [];
  const unit = selected.length === 1 ? /^(suite|bay|simulator) rentals?$/iu.exec(clean(selected[0]))?.[1].toLowerCase() : undefined;
  const sections = nodes.filter(n => attr(n, "id") === "units_to_book_size_section");
  if (units.length !== 1 || !unit || !publicId.test(attr(selected[0], "value") ?? "") || attr(selected[0], "value") === "0" || sections.length !== 1 || unsafe(units[0]) || unsafe(selected[0]) ||
      nodes.some(n => n.tagName === "select" && (attr(n, "id") === "select_group_size" || (attr(n, "class") ?? "").split(/\s/u).includes("resSelect")))) return invalid;
  const sectionNodes = elements(sections[0]);
  const labels = sectionNodes.filter(n => n.tagName === "label");
  // Some public templates point this label at select_group_size. Require the
  // sole real units selector inside the exact same section instead of guessing.
  if (!sectionNodes.includes(units[0]) || labels.length !== 1 || unsafe(labels[0]) || elements(labels[0]).some(publicControlUnsafe) ||
      !["select_group_size", "select_units_to_book"].includes(attr(labels[0], "for") ?? "") ||
      clean(labels[0]).toLowerCase() !== `number of ${unit}s to book` ||
      (attr(units[0], "onchange") ?? "").replace(/\s/gu, "") !== "unitsToBookChanged();") return invalid;
  const options = elements(units[0]).filter(n => n.tagName === "option"), values = options.map(n => attr(n, "value") ?? clean(n));
  const chosen = options.filter(n => attr(n, "selected") !== undefined);
  if (!options.length || options.length > 20 || options.some((n, i) => unsafe(n) || !/^[1-9]\d?$/u.test(values[i]) || clean(n) !== values[i]) ||
      new Set(values).size !== values.length || !values.includes("1") || chosen.length !== 1) return invalid;
  return { present: true, valid: true, selectedOne: (attr(chosen[0], "value") ?? clean(chosen[0])) === "1", unit };
}
function bookingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && isUSchedulePublicHost(url.hostname) && !url.port && !url.username && !url.password &&
      !url.search && !url.hash && /^\/[a-z][a-z0-9-]{2,62}\/booking$/u.test(url.pathname) ? url : undefined;
  } catch { return undefined; }
}
function validDate(value: string, format: "US" | "ISO") {
  const match = format === "US" ? /^(\d{2})\/(\d{2})\/(20\d{2})$/u.exec(value) : /^(20\d{2})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const iso = format === "US" ? `${match[3]}-${match[1]}-${match[2]}` : value;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso;
}

/** Public bookingBS5 client observed 2026-10-20:
 * https://clients.uschedule.com/bundles/js/bookingBS5
 * SHA256 569c4665e02740090f39df0a016d0f6087edafce318836e62f876db5f9865a0e.
 * Its explicit filter handlers call changefield and reload the public listing.
 * The same endpoint also accepts time/payment/addon transaction fields: those
 * are never authorized. Each instance is bound to successfully read public HTML
 * and its current rental options; it does not store or forward session cookies.
 */
export function createUSchedulePublicReadPolicy(context: { officialLocation?: UScheduleOfficialLocationProof; requestedPlayers?: number } = {}) {
  const sources = new Map<string, Map<string, Set<string>>>();
  const nextAvailableSources = new Set<string>();
  const locationSources = new Map<string, { filters: Map<string, Set<string>>; clientUrl: string }>();
  const verifiedClients = new Set<string>();
  const scopedBooking = (value: string) => {
    const legacy = bookingUrl(value);
    if (legacy) return legacy;
    const parsed = parseUScheduleLocationSource(value), expected = context.officialLocation && parseUScheduleLocationSource(context.officialLocation.entryUrl);
    return parsed && expected && parsed.canonicalUrl === expected.canonicalUrl && parsed.locationId === expected.locationId ? new URL(value) : undefined;
  };
  const locationReady = (url: string) => {
    const value = locationSources.get(url); return value && verifiedClients.has(value.clientUrl) ? value : undefined;
  };
  return {
    publicClientUrl(value: string) { return locationSources.get(value)?.clientUrl; },
    locationReadReady(value: string) { return Boolean(locationReady(value)); },
    observeResponse(value: string, method: string, status: number, contentType: string, body: string) {
      if ([...locationSources.values()].some(source => source.clientUrl === value)) {
        verifiedClients.delete(value);
        if (method === "GET" && status === 200 && /^(?:application|text)\/javascript(?:;|$)/iu.test(contentType) && Buffer.byteLength(body) <= 600_000 &&
            createHash("sha256").update(body).digest("hex") === USCHEDULE_LOCATION_CLIENT.sha256) { verifiedClients.add(value); return true; }
        return false;
      }
      const url = scopedBooking(value);
      if (url && method === "GET") { locationSources.delete(url.href); nextAvailableSources.delete(url.href); }
      if (!url || method !== "GET" || status !== 200 || !/^text\/html(?:;|$)/iu.test(contentType) || Buffer.byteLength(body) > 2_000_000) return false;
      sources.delete(url.href);
      if (context.officialLocation) {
        try {
          const catalog = readUScheduleLocationCatalog(body, url.href, context.officialLocation);
          locationSources.set(url.href, { clientUrl: catalog.clientUrl, filters: new Map([
            ["location_id", new Set([context.officialLocation.locationId])], ["service_id", new Set([catalog.service.serviceId])],
            ["length", new Set(catalog.durations.map(String))],
          ]) });
          return true;
        } catch { return false; } // Location mode cannot fall back to broader legacy filters.
      }
      const nodes = elements(parse(body));
      if (nodes.length > 20_000) return false;
      const options = (id: string) => {
        const selects = nodes.filter(node => node.tagName === "select" && attr(node, "id") === id);
        return selects.length === 1 ? elements(selects[0]).filter(node => node.tagName === "option") : [];
      };
      const units = readUSchedulePublicUnitsControl(body);
      const people = readUSchedulePublicPeopleControl(body), requested = context.requestedPlayers;
      const services = options("select_service").filter(node => isUSchedulePublicRentalLabel(text(node)) &&
        (!isUScheduleSimBookingLabel(text(node)) || hasUScheduleSimBookingDescription(body)) &&
        (!isUScheduleStandardSimulatorBookingLabel(text(node)) || hasUScheduleStandardSimulatorBookingWitness(body) && people.valid) &&
        (!/^suite rentals?$/iu.test(text(node).trim()) || units.valid && units.selectedOne || people.valid) && publicId.test(attr(node, "value") ?? "") && attr(node, "value") !== "0");
      const lengths = options("select_length").filter(node => /^(?:[1-9]\d{0,2})$/u.test(attr(node, "value") ?? "") && Number(attr(node, "value")) >= 15 && Number(attr(node, "value")) <= 480);
      if (!services.length || !lengths.length) return false;
      const filters = new Map<string, Set<string>>([
        ["service_id", new Set(services.map(node => attr(node, "value")!))],
        ["length", new Set(lengths.map(node => attr(node, "value")!))],
        ["group_size", new Set(people.roleClaimed ? people.valid && Number.isInteger(requested) && requested! >= 1 && requested! <= 4 && people.values.includes(String(requested)) ? [String(requested)] : [] :
          options("select_group_size").some(node => (attr(node, "value") ?? text(node).trim()) === "1") ? ["1"] : [])],
      ]);
      filters.set("units_to_book", new Set(units.valid && units.selectedOne ? ["1"] : []));
      // The public service-type handler is a catalog filter, never a booking.
      filters.set("service_type_id", new Set(options("select_service_type").filter(node => publicId.test(attr(node, "value") ?? "") &&
        (attr(node, "value") === "0" || isUSchedulePublicRentalLabel(text(node)) &&
          (!isUScheduleStandardSimulatorBookingLabel(text(node)) || hasUScheduleStandardSimulatorBookingWitness(body) && people.valid))).map(node => attr(node, "value")!)));
      sources.set(url.href, filters);
      const tenant = parseUScheduleLocationSource(url.href)?.tenant;
      if (tenant && readUScheduleNextAvailableView(body, tenant).present) nextAvailableSources.add(url.href);
      return true;
    },
    allows(url: URL, headers: Headers, body: string) {
      if (Buffer.byteLength(body) > 2048 || !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(headers.get("content-type") ?? "") ||
          headers.get("origin") !== url.origin || headers.has("next-action") ||
          [...headers.keys()].some(key => /^(?:authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/iu.test(key))) return false;
      const source = scopedBooking(headers.get("referer") ?? "");
      if (!source || !sources.has(source.href) && !locationReady(source.href) || url.origin !== source.origin || url.search || url.hash || url.port || url.username || url.password) return false;
      let value: unknown;
      try { value = JSON.parse(body); } catch { return false; }
      if (url.pathname === `${source.pathname}/getavailabledates`) {
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 1 &&
          "date" in value && typeof value.date === "string" && validDate(value.date, "ISO") && value.date.endsWith("-01"));
      }
      if (url.pathname !== `${source.pathname}/changefield` || !Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") return false;
      const item = value[0] as Record<string, unknown>;
      // A one-argument saveBookingDetail('next_avail') omits Value when
      // serialized by the pinned public client. No aliases or extra fields.
      if (Object.keys(item).length === 1 && item.Name === "next_avail") return nextAvailableSources.has(source.href);
      if (Object.keys(item).length !== 2 || typeof item.Name !== "string" || typeof item.Value !== "string") return false;
      return item.Name === "start_date" ? validDate(item.Value, "US") :
        (sources.get(source.href)?.get(item.Name) ?? locationReady(source.href)?.filters.get(item.Name))?.has(item.Value) === true;
    },
    addReadHeaders(url: URL, method: string, original: Record<string, string>, headers: Headers, body: string) {
      if (!isUSchedulePublicHost(url.hostname) || method !== "POST") return true;
      const proposed = new Headers(headers);
      proposed.set("referer", original.referer ?? "");
      if (!this.allows(url, proposed, body)) return false;
      headers.set("referer", proposed.get("referer")!);
      if (original["x-requested-with"] === "XMLHttpRequest") headers.set("x-requested-with", "XMLHttpRequest");
      return true;
    },
  };
}
