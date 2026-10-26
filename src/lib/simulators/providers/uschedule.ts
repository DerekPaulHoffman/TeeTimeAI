import { parse as parseScript } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { createHash } from "node:crypto";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { isUSchedulePublicRentalLabel, readUSchedulePublicUnitsControl, readUSchedulePublicPeopleControl, readUSchedulePublicRentalNotes } from "@/lib/automation/uschedule-public-read-policy";
import { readUScheduleNextAvailableView } from "@/lib/automation/uschedule-public-view-control";
import { simulatorPublicConfigurationSchema, uschedulePublicTenant, type USchedulePublicConfiguration } from "./public-configuration";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult,
  type SimulatorAvailabilitySlot } from "./types";
import type { UScheduleConfigurationGate } from "@/lib/course-discovery/official-source-diagnostics";
import { parseUScheduleLocationSource, readUScheduleLocationCatalog, USCHEDULE_LOCATION_CLIENT,
  type UScheduleOfficialLocationProof, type USchedulePublicLocationProof } from "./uschedule-location-source";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const MAX_HTML_BYTES = 600_000, MAX_JSON_BYTES = 8_000, MAX_PAGES = 8;
// One current public Next Available page has 25 directly owned rows. Keep a
// fixed page ceiling; learned execution still has 16 pages, 40 session reads,
// 8 MB aggregate and the existing later-day completeness requirement.
const MAX_PUBLIC_ROWS_PER_PAGE = 25;
// Separate complete dated-grid profile: 44 starts were observed, including
// all 32 locally expandable extras. This never changes the legacy list cap.
const MAX_PUBLIC_GRID_STARTS = 64;
// One observed public catalog publishes twenty distinct 15..300 minute choices.
// Only catalog cardinality changes; requested duration and read budgets do not.
const MAX_PUBLIC_DURATION_CHOICES = 20;
const PUBLIC_ID = /^[1-9]\d{0,9}$/u;
const metadataSchema = z.object({ tenant: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  serviceId: z.string().regex(PUBLIC_ID) }).strict();

const sourceError = (message: string) => new SimulatorAvailabilityError("INVALID_SOURCE", message);
const schemaError = (message: string) => new SimulatorAvailabilityError("SCHEMA_CHANGED", message);
function elements(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : elements(child)) : [];
}
function children(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.filter((child): child is Element => "tagName" in child) : [];
}
function attr(node: Element, key: string) { return node.attrs.find(item => item.name === key)?.value; }
function visibleText(node: Node): string {
  if ("value" in node) return node.value;
  if ("tagName" in node && ["script", "style", "textarea", "input"].includes(node.tagName)) return "";
  return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : "";
}
function accessChanged(html: string) {
  const document = parse(html);
  const visible = visibleText(document).replace(/\s+/gu, " ");
  return /verify (?:that )?you are human|checking your browser|complete the captcha|(?:sign|log) in (?:is required|to continue)|authentication required|you are (?:now )?in (?:a|the) queue/iu.test(visible) ||
    elements(document).some(node => node.attrs.some(item => ["id", "class"].includes(item.name) &&
      /(?:cf-chl|challenge-form|g-recaptcha|h-captcha|cf-turnstile)/iu.test(item.value)) ||
      node.tagName === "input" && attr(node, "type") === "password" ||
      node.tagName === "iframe" && /recaptcha|hcaptcha|challenges\.cloudflare/iu.test(attr(node, "src") ?? ""));
}
type LearnedRental = { serviceId: string; serviceName: string; durationMinutes: number; date?: string; tenant?: string; requestedPlayers?: number;
  publicLocationProof?: USchedulePublicLocationProof };
function selectedRental(html: string, learned?: LearnedRental) {
  if (accessChanged(html)) throw sourceError("The public simulator scheduler now requires interactive access");
  if (learned?.publicLocationProof) {
    const proof = learned.publicLocationProof, catalog = readUScheduleLocationCatalog(html, proof.official.entryUrl, proof.official);
    if (!catalog.locationSelected || catalog.proof.catalogHash !== proof.catalogHash || catalog.selectedServiceId !== learned.serviceId ||
        catalog.service.serviceName !== learned.serviceName || catalog.selectedDuration !== learned.durationMinutes)
      throw sourceError("The public location rental changed");
    return { serviceId: learned.serviceId, durationMinutes: learned.durationMinutes };
  }
  const all = elements(parse(html));
  const options = (id: string) => {
    const selects = all.filter(node => node.tagName === "select" && attr(node, "id") === id);
    if (selects.length !== 1) throw sourceError("The public simulator rental selectors are missing or ambiguous");
    return elements(selects[0]).filter(node => node.tagName === "option");
  };
  const services = options("select_service"), lengths = options("select_length");
  const selected = (node: Element) => node.attrs.some(item => item.name === "selected");
  if (learned) {
    const units = readUSchedulePublicUnitsControl(html);
    if (units.present && (!units.valid || !units.selectedOne)) throw sourceError("The selected public rental changed");
    const people = readUSchedulePublicPeopleControl(html);
    if (people.roleClaimed && (!people.valid || !Number.isInteger(learned.requestedPlayers) || learned.requestedPlayers! < 1 || learned.requestedPlayers! > 4 || people.selectedPeople !== learned.requestedPlayers))
      throw sourceError("The selected public rental changed");
    const service = services.filter(selected), length = lengths.filter(selected);
    const groupSize = all.filter(node => node.tagName === "select" && attr(node, "id") === "select_group_size");
    const selectedGroup = groupSize.length === 1 ? elements(groupSize[0]).filter(node => node.tagName === "option" && selected(node)) : [];
    const resources = all.filter(node => node.tagName === "select" && (attr(node, "class") ?? "").split(/\s/u).includes("resSelect"));
    if (service.length !== 1 || attr(service[0], "value") !== learned.serviceId || visibleText(service[0]).replace(/\s+/gu, " ").trim() !== learned.serviceName ||
        length.length !== 1 || Number(attr(length[0], "value")) !== learned.durationMinutes ||
        groupSize.length > 1 || !people.roleClaimed && groupSize.length === 1 && (selectedGroup.length !== 1 || (attr(selectedGroup[0], "value") ?? visibleText(selectedGroup[0]).trim()) !== "1") ||
        resources.some(node => { const values = elements(node).filter(option => option.tagName === "option" && selected(option));
          return values.length !== 1 || attr(values[0], "value") !== "-1"; })) throw sourceError("The selected public rental changed");
    return { serviceId: learned.serviceId, durationMinutes: learned.durationMinutes };
  }
  if (services.length !== 1 || !selected(services[0]) || visibleText(services[0]).replace(/\s+/gu, " ").trim() !== "Simulator Rental" ||
      !PUBLIC_ID.test(attr(services[0], "value") ?? "") || lengths.length < 1 || lengths.length > 7 ||
      lengths.filter(selected).length !== 1 || attr(lengths.find(selected)!, "value") !== "60" ||
      lengths.some(node => !/^(?:60|90|120|150|180|210|240)$/u.test(attr(node, "value") ?? "")) ||
      new Set(lengths.map(node => attr(node, "value"))).size !== lengths.length) {
    throw sourceError("The reviewed default one-hour Simulator Rental is no longer unambiguous");
  }
  return { serviceId: attr(services[0], "value")!, durationMinutes: 60 as const };
}
function pooledRows(html: string) {
  const all = elements(parse(html));
  const containers = all.filter(node => (attr(node, "class") ?? "").split(/\s+/u).includes("next_avail_results"));
  if (!containers.length || containers.length > MAX_PUBLIC_ROWS_PER_PAGE) throw schemaError("The public availability list is missing or ambiguous");
  // The public page renders one result container per start, with one direct
  // row inside each. An orphan or nested row would leave the page incomplete.
  const rows = containers.map(container => {
    const direct = children(container);
    if (direct.length !== 1 || !(attr(direct[0], "class") ?? "").split(/\s+/u).includes("next_avail_item"))
      throw schemaError("The public availability list changed structure");
    return direct[0];
  });
  if (all.filter(node => (attr(node, "class") ?? "").split(/\s+/u).includes("next_avail_item")).length !== rows.length)
    throw schemaError("The public availability list has unowned rows");
  return rows.map(row => {
    if (attr(row, "data-empid") !== "0") throw schemaError("The public pooled resource identity changed");
    return decodeWall(attr(row, "data-time") ?? "");
  });
}

/** A complete single-date simulator grid, not an interval grid or chosen bay.
 * The selected duration was independently refreshed and checked by listing(). */
function publicTimeGrid(all: Element[], learned: LearnedRental | undefined, html: string) {
  const cls = (node: Element, value: string) => (attr(node, "class") ?? "").split(/\s+/u).includes(value);
  const grids = all.filter(node => cls(node, "time_choices")), allRows = all.filter(node => cls(node, "timeslot"));
  if (!grids.length && !allRows.length) return;
  const invalid = (): never => { throw schemaError("The public simulator time grid is unverified"); };
  const clean = (node: Node) => visibleText(node).replace(/\s+/gu, " ").trim();
  const unsafe = (node: Element, expandable = false) => {
    let current: Node | undefined = node;
    for (let depth = 0; current && depth < 64; depth++, current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
      if (!("tagName" in current)) continue;
      if (["form", "script", "style", "template", "noscript", "iframe"].includes(current.tagName) ||
          ["hidden", "inert", "disabled", "onclick"].some(key => attr(current as Element, key) !== undefined) ||
          ["aria-hidden", "aria-disabled"].some(key => attr(current as Element, key) === "true") ||
          /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$)/iu.test(attr(current, "style") ?? "") ||
          /(?:^|\s)(?:hidden|invisible|visually-hidden|sr-only|disabled|booked|no_time)(?:\s|$)/u.test(attr(current, "class") ?? "") ||
          cls(current, "d-none") && !(current === node && expandable) ||
          /\b(?:account|profile|checkout|payment|billing|login|private|members?)\b/iu.test(["id", "class", "aria-label", "title"].map(key => attr(current as Element, key) ?? "").join(" "))) return true;
    }
    return current !== undefined;
  };
  const units = readUSchedulePublicUnitsControl(html), unitsProfile = units.present && units.valid && units.selectedOne;
  const people = readUSchedulePublicPeopleControl(html), peopleProfile = people.roleClaimed && people.valid;
  if (!learned || learned.publicLocationProof || !(learned.serviceName === "Public Tee Times" && !units.present && !people.roleClaimed || unitsProfile || peopleProfile) || grids.length !== 1 ||
      all.some(node => cls(node, "next_avail_results") || cls(node, "next_avail_item") || attr(node, "id") === "more_next_avail")) return invalid();
  const grid = grids[0], parent = "parentNode" in grid ? grid.parentNode : undefined;
  if (grid.tagName !== "div" || !parent || !("tagName" in parent) || !cls(parent, "choices") || !peopleProfile && !cls(parent, "full") || unsafe(grid) ||
      all.filter(node => cls(node, "choices") && (peopleProfile || cls(node, "full"))).length !== 1) return invalid();
  const rows = children(grid).filter(node => cls(node, "timeslot"));
  if (!rows.length || rows.length > MAX_PUBLIC_GRID_STARTS || rows.length !== allRows.length || rows.filter(node => cls(node, "selected")).length > 1 ||
      children(grid).some(node => !rows.includes(node) && !["show-extra-row", "hide-extra-row"].includes(attr(node, "id") ?? ""))) return invalid();
  const lengthLabels = all.filter(node => node.tagName === "label" && attr(node, "for") === "select_length");
  if (lengthLabels.length !== 1 || clean(lengthLabels[0]) !== (unitsProfile || peopleProfile ? "Choose Time" : "Choose Simulator Time") || unsafe(lengthLabels[0])) return invalid();
  const pools = all.filter(node => node.tagName === "select" && cls(node, "resSelect"));
  let resourceId: string;
  if (unitsProfile || peopleProfile) {
    if (pools.length) return invalid();
    resourceId = `uschedule-service:${learned.serviceId}:pooled`;
  } else {
  if (pools.length !== 1 || unsafe(pools[0])) return invalid();
  const pool = pools[0], groupId = /^resource([1-9]\d{0,9})$/u.exec(attr(pool, "id") ?? "")?.[1];
  const poolLabels = all.filter(node => node.tagName === "label" && attr(node, "for") === attr(pool, "id"));
  const sections = all.filter(node => attr(node, "id") === "res_section");
  let poolAncestor: Node | undefined = pool;
  while (poolAncestor && poolAncestor !== sections[0]) poolAncestor = "parentNode" in poolAncestor ? poolAncestor.parentNode ?? undefined : undefined;
  const options = children(pool), ids = options.map(node => attr(node, "value") ?? ""), selected = options.filter(node => node.attrs.some(value => value.name === "selected"));
  if (!groupId || sections.length !== 1 || poolAncestor !== sections[0] || poolLabels.length !== 1 || clean(poolLabels[0]) !== "Simulators" || unsafe(poolLabels[0]) ||
      options.length < 2 || options.length > 21 || options.some(node => node.tagName !== "option" || children(node).length || unsafe(node) || !clean(node) || clean(node).length > 200) ||
      new Set(ids).size !== ids.length || ids.filter(id => id === "-1").length !== 1 || ids.some(id => id !== "-1" && !PUBLIC_ID.test(id)) ||
      selected.length !== 1 || attr(selected[0], "value") !== "-1" || clean(selected[0]) !== "Any Available") return invalid();
  resourceId = `uschedule-resource-group:${groupId}:pooled`;
  }
  // These notes limit the public party, not the physical capacity of a suite.
  // Only visible, control-free notes beside this current grid are considered.
  let publicPartyLimit: number | null = null;
  if (unitsProfile || peopleProfile) {
    const notes = readUSchedulePublicRentalNotes(html).filter(value => /\b(?:maximum|max|up to|only)\b/iu.test(value) && /\b(?:people|players?|golfers?|persons?)\b/iu.test(value) && /\b(?:simulators?|suites?|bays?)\b/iu.test(value));
    const limits = notes.map(value => {
      const match = /^(?:A )?maximum of ([1-9]\d?) (?:people|players?|golfers?|persons?) can compete on simulators at one time(?: \(additional space for guests at (?:suite|bay|simulator) bars and main bar\))?\.?$/iu.exec(value) ??
        /^(?:A )?maximum of ([1-9]\d?) (?:people|players?|golfers?|persons?) per (?:suite|bay|simulator)\.?$/iu.exec(value) ??
        /^Each (?:bay|suite|simulator) can accommodate up to ([1-9]\d?) (?:people|players?|golfers?|persons?) max(?: \(strictly enforced regardless of # of people golfing\))?\.?$/iu.exec(value);
      return match ? Number(match[1]) : undefined;
    });
    if (limits.some(value => value === undefined) || new Set(limits).size > 1) return invalid();
    publicPartyLimit = limits[0] ?? null;
  }
  const extras = rows.filter(node => cls(node, "extra"));
  const show = all.filter(node => attr(node, "id") === "show-extra-row"), hide = all.filter(node => attr(node, "id") === "hide-extra-row");
  if (extras.length || peopleProfile && (show.length || hide.length)) {
    const shownLabel = show.length === 1 ? children(show[0]) : [], hiddenLabel = hide.length === 1 ? children(hide[0]) : [];
    if (show.length !== 1 || hide.length !== 1 || show[0].parentNode !== grid || hide[0].parentNode !== grid || unsafe(show[0]) ||
        show[0].attrs.some(value => !["id", "class"].includes(value.name)) || hide[0].attrs.some(value => !["id", "class", "style"].includes(value.name)) ||
        shownLabel.length !== 1 || hiddenLabel.length !== 1 || [shownLabel[0], hiddenLabel[0]].some(node => node.tagName !== "span" || attr(node, "class") !== "no_time" || node.attrs.length !== 1) ||
        children(shownLabel[0]).length !== 1 || children(shownLabel[0])[0].tagName !== "text" || children(shownLabel[0])[0].attrs.length !== 0 || children(children(shownLabel[0])[0]).length !== 0 || children(hiddenLabel[0]).length !== 0 ||
        Number(/^Show Additional Times\s*\(\s*(0|[1-9]\d{0,2})\s+more\s*\)$/u.exec(clean(show[0]))?.[1]) !== extras.length || clean(hide[0]) !== "Hide Additional Times" ||
        (attr(hide[0], "style") ?? "").replace(/\s|;/gu, "").toLowerCase() !== "display:none" || rows.length === extras.length) return invalid();
  } else if (show.length || hide.length) return invalid();
  let extraStarted = false;
  const times = rows.map(node => {
    const extra = cls(node, "extra"), classes = (attr(node, "class") ?? "").split(/\s+/u).filter(Boolean), labels = children(node);
    if (node.tagName !== "div" || !cls(node, "col") || cls(node, "d-none") !== extra || unsafe(node, extra) ||
        classes.some(value => !["col", "timeslot", "selected", "d-none", "extra"].includes(value)) ||
        node.attrs.some(value => !["class", "data-time"].includes(value.name)) || labels.length !== 1 || labels[0].tagName !== "span" || labels[0].attrs.length || children(labels[0]).length ||
        extraStarted && !extra) return invalid();
    extraStarted ||= extra;
    const time = decodeWall(attr(node, "data-time") ?? ""), hour = Number(time.wall.slice(11, 13));
    if (time.date !== learned.date || clean(labels[0]) !== `${hour % 12 || 12}:${time.wall.slice(14, 16)} ${hour < 12 ? "AM" : "PM"}`) return invalid();
    return time;
  });
  if (times.some((time, index) => index > 0 && time.order <= times[index - 1].order)) return invalid();
  return { times, cursor: times.at(-1)!.value, morePresent: false, completeDate: true, resourceId, publicPartyLimit };
}

/** Inert projection of the selected public rental only. No session or list data survives. */
export function projectUSchedulePublicConfiguration(html: string, sourceUrl: string): USchedulePublicConfiguration | undefined {
  const tenant = uschedulePublicTenant(sourceUrl);
  if (!tenant || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return;
  try {
    const rental = selectedRental(html);
    pooledRows(html);
    const result = simulatorPublicConfigurationSchema.safeParse({ family: "USCHEDULE", tenant,
      serviceId: rental.serviceId, durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    return result.success && result.data.family === "USCHEDULE" ? result.data : undefined;
  } catch { return undefined; }
}

function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}
function decodeWall(value: string) {
  const match = /^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (!match) throw schemaError("The public simulator start encoding changed");
  const [, month, day, year, hour, minute] = match;
  const date = `${year}-${month}-${day}`;
  if (!validDate(date) || Number(hour) > 23 || Number(minute) > 59) throw schemaError("The public simulator start is invalid");
  const wall = `${date}T${hour}:${minute}:00`;
  return { value, date, wall, order: Date.parse(`${wall}Z`) };
}
function venueInstant(wall: string, zone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const local = (candidate: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const wallUtc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(wallUtc)) throw schemaError("The simulator start is invalid");
  const offsets = new Set<number>();
  // Sample a bounded window around the wall clock to include both sides of
  // ordinary and half-hour transitions without trusting one guessed offset.
  for (let minutes = -36 * 60; minutes <= 36 * 60; minutes += 30) {
    const probe = new Date(wallUtc + minutes * 60_000);
    offsets.add(Date.parse(`${local(probe)}Z`) - probe.getTime());
  }
  const matches = [...offsets].map(offset => new Date(wallUtc - offset))
    .filter(candidate => local(candidate) === wall);
  if (matches.length !== 1)
    throw schemaError("The simulator start is ambiguous in the venue timezone");
  return matches[0];
}
function listing(html: string, expectedServiceId: string, learned?: LearnedRental) {
  const rental = selectedRental(html, learned);
  if (rental.serviceId !== expectedServiceId) throw sourceError("The public simulator rental changed identity");
  const all = elements(parse(html));
  if (learned) {
    const tenant = learned.tenant;
    if (!learned.date || !tenant || !all.some(node => node.tagName === "body" && (attr(node, "class") ?? "").split(/\s/u).includes(tenant)))
      throw sourceError("The public rental tenant changed");
    const dates: string[] = [];
    for (const script of all.filter(node => node.tagName === "script")) {
      const body = "childNodes" in script ? script.childNodes.map(node => "value" in node ? node.value : "").join("") : "";
      if (!body.includes("chosenDate")) continue;
      if (Buffer.byteLength(body) > 20_000) throw schemaError("The public date declaration is unbounded");
      const program = parseScript(body, { ecmaVersion: "latest", sourceType: "script" });
      for (const statement of program.body) if (statement.type === "VariableDeclaration") for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.id.name !== "chosenDate") continue;
        const value = declaration.init;
        if (value?.type !== "NewExpression" || value.callee.type !== "Identifier" || value.callee.name !== "Date" || value.arguments.length !== 3 ||
            value.arguments.some(argument => argument.type !== "Literal" || typeof argument.value !== "number" || !Number.isInteger(argument.value)))
          throw schemaError("The public selected date changed");
        const args = value.arguments.map(argument => (argument as { value: number }).value);
        const date = `${String(args[0]).padStart(4, "0")}-${String(args[1] + 1).padStart(2, "0")}-${String(args[2]).padStart(2, "0")}`;
        if (!validDate(date)) throw schemaError("The public selected date is invalid");
        dates.push(date);
      }
    }
    if (dates.length !== 1 || dates[0] !== learned.date) throw schemaError("The public selected date is not the requested date");
    const rows = all.filter(node => (attr(node, "class") ?? "").split(/\s/u).includes("next_avail_item"));
    if (rows.some(node => {
      if (!learned.publicLocationProof) return !visibleText(node).replace(/\s+/gu, " ").includes(learned.serviceName);
      const label = children(node)[1];
      const escaped = learned.serviceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return !label || !new RegExp(`^${escaped} - \\$\\d+(?:\\.\\d{2})?$`, "u").test(visibleText(label).replace(/\s+/gu, " ").trim());
    })) throw schemaError("The public row rental identity changed");
  }
  const grid = publicTimeGrid(all, learned, html);
  if (grid) return grid;
  const times = pooledRows(html);
  if (times.some((time, index) => index > 0 && time.order <= times[index - 1].order))
    throw schemaError("The public availability list is not strictly ordered");
  const more = all.filter(node => attr(node, "id") === "more_next_avail");
  if (more.length > 1) throw schemaError("The public continuation control is ambiguous");
  const cursors: string[] = [];
  for (const script of all.filter(node => node.tagName === "script")) {
    const body = "childNodes" in script ? script.childNodes.map(node => "value" in node ? node.value : "").join("") : "";
    if (!body.includes("lastAvailTime")) continue;
    if (Buffer.byteLength(body, "utf8") > 20_000) throw schemaError("The public continuation declaration is unbounded");
    let program: ReturnType<typeof parseScript>;
    try { program = parseScript(body, { ecmaVersion: "latest", sourceType: "script" }); }
    catch { throw schemaError("The public continuation declaration changed"); }
    for (const statement of program.body) {
      if (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression" &&
          statement.expression.operator === "=" && statement.expression.left.type === "Identifier" &&
          statement.expression.left.name === "lastAvailTime") {
        const value = statement.expression.right;
        if (value.type !== "Literal" || typeof value.value !== "string" || !/^\d{12}$/u.test(value.value))
          throw schemaError("The public continuation cursor is invalid");
        cursors.push(value.value);
      }
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.id.name !== "lastAvailTime") continue;
        if (declaration.init?.type !== "Literal" || typeof declaration.init.value !== "string" ||
            !/^\d{12}$/u.test(declaration.init.value)) throw schemaError("The public continuation cursor is invalid");
        cursors.push(declaration.init.value);
      }
    }
  }
  if (cursors.length !== 1 || cursors[0] !== times.at(-1)!.value) throw schemaError("The public continuation cursor changed");
  return { times, cursor: cursors[0], morePresent: more.length === 1, completeDate: false, resourceId: undefined };
}
async function bounded(response: Response, ceiling: number) {
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared > ceiling || !response.body) throw schemaError("The public simulator response exceeds its size limit");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > ceiling) throw schemaError("The public simulator response exceeds its size limit"); chunks.push(next.value); }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw schemaError("The public simulator response encoding changed"); }
}
async function publicResponse(url: URL, init: RequestInit, expectedType: string | string[], ceiling: number,
  fetchImpl: typeof fetch, signal: AbortSignal, bootstrapTarget?: string) {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { ...init, signal, redirect: "manual", cache: "no-store", credentials: "omit" }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator scheduler could not be reached", true); }
  const bootstrap = response.status === 302 && bootstrapTarget !== undefined && response.headers.get("location") &&
    new URL(response.headers.get("location")!, url).href === bootstrapTarget;
  if (response.status !== 200 && !bootstrap || response.headers.has("location") && !bootstrap) throw new SimulatorAvailabilityError("HTTP_ERROR",
    "The public simulator scheduler did not return a direct public response", response.status === 429 || response.status >= 500,
    response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.href) throw sourceError("The public simulator scheduler changed destination");
  const sentCookie = new Headers(init.headers).get("cookie");
  if (sentCookie && response.headers.getSetCookie().some(row => row.split(";", 1)[0] !== sentCookie))
    throw sourceError("The anonymous public scheduler session changed");
  if (!(Array.isArray(expectedType) ? expectedType : [expectedType]).includes(response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? ""))
    throw schemaError("The public simulator scheduler returned an unexpected response type");
  return { response, body: await bounded(response, ceiling) };
}
async function refresh(url: URL, cookie: string, name: "start_date" | "more_next_avail" | "length" | "service_id" | "group_size" | "units_to_book" | "location_id" | "next_avail", value: string | undefined,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  const endpoint = new URL(`${url.pathname}/changefield`, url.origin);
  const { body } = await publicResponse(endpoint, { method: "POST", headers: { Accept: "application/json",
    "Content-Type": "application/json", Cookie: cookie, Origin: url.origin, Referer: url.href,
    "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify([{ Name: name, Value: value }]) },
  "application/json", MAX_JSON_BYTES, fetchImpl, signal);
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw schemaError("The public simulator refresh response is invalid"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || (payload as { code?: unknown }).code !== "refresh")
    throw schemaError("The public simulator query did not return a safe refresh");
}

/** Inert public rental choices for the fixed learned adapter. The tenant alias
 * is independently present in the rendered document and must match its URL. */
export function inspectUScheduleRecipeConfiguration(html: string, sourceUrl: string, onFailure?: (gate: UScheduleConfigurationGate) => void) {
  const reject = (gate: UScheduleConfigurationGate) => { try { onFailure?.(gate); } catch { /* Diagnostics cannot change parser behavior. */ } return undefined; };
  const tenant = uschedulePublicTenant(sourceUrl);
  if (!tenant) return reject("SOURCE_CONTEXT");
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) return reject("BODY_LIMIT");
  if (accessChanged(html)) return reject("ACCESS_REQUIRED");
  const all = elements(parse(html));
  const bodies = all.filter(node => node.tagName === "body");
  if (bodies.length !== 1 || !(attr(bodies[0], "class") ?? "").split(/\s/u).includes(tenant)) return reject("TENANT_DOCUMENT");
  const select = (id: string) => all.filter(node => node.tagName === "select" && attr(node, "id") === id);
  const services = select("select_service"), lengths = select("select_length");
  if (services.length !== 1 || lengths.length !== 1) return reject("SELECTORS");
  const rentals = elements(services[0]).filter(node => node.tagName === "option").map(node => ({ serviceId: attr(node, "value") ?? "",
    serviceName: visibleText(node).replace(/\s+/gu, " ").trim(), selected: node.attrs.some(value => value.name === "selected") }))
    .filter(row => PUBLIC_ID.test(row.serviceId) && isUSchedulePublicRentalLabel(row.serviceName));
  const durations = elements(lengths[0]).filter(node => node.tagName === "option").map(node => Number(attr(node, "value")))
    .filter(value => Number.isInteger(value) && value >= 15 && value <= 480);
  const current = rentals.filter(row => row.selected);
  if (!rentals.length || rentals.length > 20) return reject("RENTAL_CATALOG");
  if (current.length !== 1) return reject("SELECTED_RENTAL");
  if (!durations.length || durations.length > MAX_PUBLIC_DURATION_CHOICES || new Set(durations).size !== durations.length) return reject("DURATION_CATALOG");
  const units = readUSchedulePublicUnitsControl(html);
  const people = readUSchedulePublicPeopleControl(html);
  if (units.present && (!units.valid || !units.selectedOne) || /^suite rentals?$/iu.test(current[0].serviceName) && !units.present && !people.valid) return reject("SELECTORS");
  if (people.roleClaimed && !people.valid) return reject("SELECTORS");
  return { tenant, rentals, durations, selected: current[0] };
}

/** A missing public resource-quantity control is not an instruction to create
 * one. Existing controls must still explicitly offer the single-bay value. */
export function readUScheduleGroupSizeControl(html: string) {
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw sourceError("The public group selector is unbounded");
  const groups = elements(parse(html)).filter(node => node.tagName === "select" && attr(node, "id") === "select_group_size");
  if (groups.length > 1) throw sourceError("The public group selector is ambiguous");
  if (!groups.length) return { present: false, oneAvailable: false };
  let ancestor: Node | undefined = groups[0];
  while (ancestor) {
    if ("tagName" in ancestor && (ancestor.attrs.some(a => ["hidden", "inert"].includes(a.name) || a.name === "aria-hidden" && a.value === "true") ||
        /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attr(ancestor, "style") ?? ""))) throw sourceError("The public group selector is hidden");
    ancestor = "parentNode" in ancestor ? ancestor.parentNode ?? undefined : undefined;
  }
  const options = elements(groups[0]).filter(node => node.tagName === "option");
  if (!options.length || options.length > 40) throw sourceError("The public group selector changed");
  return { present: true, oneAvailable: options.filter(node => (attr(node, "value") ?? visibleText(node).trim()) === "1" &&
    !node.attrs.some(a => ["hidden", "disabled", "inert"].includes(a.name))).length === 1 };
}

/** A separate fixed contract for an official location's included public rental.
 * The caller supplies freshly verified official markup, never proposed IDs. */
export async function prepareUScheduleLocationCatalog(official: UScheduleOfficialLocationProof, fetchImpl: typeof fetch, signal: AbortSignal) {
  let url = new URL(official.entryUrl);
  const source = parseUScheduleLocationSource(url.href);
  if (!source?.locationId) throw sourceError("The official public location source changed");
  let page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html" } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal, source.canonicalUrl);
  let bootstrapCookie: string | undefined;
  if (page.response.status === 302) {
    const cookies = page.response.headers.getSetCookie();
    if (cookies.length > 1) throw sourceError("Anonymous public session changed");
    bootstrapCookie = cookies[0]?.split(";", 1)[0];
    if (bootstrapCookie && !/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}$/u.test(bootstrapCookie)) throw sourceError("Anonymous public session changed");
    url = new URL(source.canonicalUrl);
    page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", ...(bootstrapCookie ? { Cookie: bootstrapCookie } : {}) } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  }
  let config = readUScheduleLocationCatalog(page.body, url.href, official);
  const cookies = page.response.headers.getSetCookie(), cookie = cookies.length === 1 ? cookies[0].split(";", 1)[0] : bootstrapCookie ?? "";
  if (!/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}$/u.test(cookie)) throw sourceError("Anonymous public session missing");
  const client = await publicResponse(new URL(config.clientUrl), { method: "GET", headers: { Accept: "application/javascript" } },
    ["application/javascript", "text/javascript"], MAX_HTML_BYTES, fetchImpl, signal);
  if (createHash("sha256").update(client.body).digest("hex") !== USCHEDULE_LOCATION_CLIENT.sha256)
    throw sourceError("The public location filter contract changed");
  const filter = async (name: "location_id" | "service_id", value: string) => {
    await refresh(url, cookie, name, value, fetchImpl, signal);
    page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
    config = readUScheduleLocationCatalog(page.body, url.href, official);
  };
  if (!config.locationSelected) await filter("location_id", official.locationId);
  if (!config.locationSelected) throw sourceError("The public location did not select the requested venue");
  if (config.selectedServiceId !== config.service.serviceId) await filter("service_id", config.service.serviceId);
  if (!config.locationSelected || config.selectedServiceId !== config.service.serviceId) throw sourceError("The public rental did not select");
  return { url, page, cookie, config };
}

/** Fixed read-only learned path; every page proves selected product, one bay,
 * duration, chronological cursor progress and a later-day completeness witness. */
export async function fetchUScheduleRecipeAvailability(input: SimulatorAvailabilityInput & { requestedPlayers?: number }, service: { serviceId: string; serviceName: string; publicLocationProof?: USchedulePublicLocationProof },
  fetchImpl: typeof fetch, diagnostics?: { onListingPage?: (html: string) => void }): Promise<SimulatorAvailabilityResult & { publicPartyLimit?: number | null }> {
  let url = new URL(service.publicLocationProof?.official.entryUrl ?? input.offering.bookingUrl);
  const signal = AbortSignal.timeout(90_000);
  if (!(service.publicLocationProof ? parseUScheduleLocationSource(url.href) : uschedulePublicTenant(url.href)) ||
      !validDate(input.date) || input.partySize !== 1 || !PUBLIC_ID.test(service.serviceId)) throw sourceError("Invalid learned public rental");
  const location = service.publicLocationProof ? await prepareUScheduleLocationCatalog(service.publicLocationProof.official, fetchImpl, signal) : undefined;
  if (location) url = location.url;
  let page = location?.page ?? await publicResponse(url, { method: "GET", headers: { Accept: "text/html" } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  if (location) {
    if (location.config.proof.catalogHash !== service.publicLocationProof!.catalogHash || location.config.service.serviceId !== service.serviceId ||
        location.config.service.serviceName !== service.serviceName || !location.config.durations.includes(input.durationMinutes))
      throw sourceError("The public location catalog changed");
  } else {
    const config = inspectUScheduleRecipeConfiguration(page.body, url.href);
    if (!config || !config.rentals.some(row => row.serviceId === service.serviceId && row.serviceName === service.serviceName) || !config.durations.includes(input.durationMinutes))
      throw sourceError("The learned public rental is no longer available");
  }
  const cookies = page.response.headers.getSetCookie();
  const cookie = location?.cookie ?? (cookies.length === 1 ? cookies[0].split(";", 1)[0] : "");
  if (!/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}$/u.test(cookie)) throw sourceError("Anonymous public session missing");
  const filter = async (name: "service_id" | "length" | "group_size" | "units_to_book" | "start_date", value: string) => {
    await refresh(url, cookie, name, value, fetchImpl, signal);
    page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  };
  if (!location && inspectUScheduleRecipeConfiguration(page.body, url.href)!.selected.serviceId !== service.serviceId) await filter("service_id", service.serviceId);
  await filter("length", String(input.durationMinutes));
  if (!location) {
    const units = readUSchedulePublicUnitsControl(page.body);
    if (units.present) {
      if (!units.valid || !units.selectedOne) throw sourceError("The public single-unit selector is unavailable");
      await filter("units_to_book", "1");
      const selectedUnits = readUSchedulePublicUnitsControl(page.body);
      if (!selectedUnits.valid || !selectedUnits.selectedOne) throw sourceError("The public single-unit selector changed");
    }
    const people = readUSchedulePublicPeopleControl(page.body);
    if (people.roleClaimed) {
      if (!people.valid || !Number.isInteger(input.requestedPlayers) || input.requestedPlayers! < 1 || input.requestedPlayers! > 4 || !people.values.includes(String(input.requestedPlayers)))
        throw sourceError("The public people selector is unavailable");
      await filter("group_size", String(input.requestedPlayers));
      const selectedPeople = readUSchedulePublicPeopleControl(page.body);
      if (!selectedPeople.valid || selectedPeople.selectedPeople !== input.requestedPlayers) throw sourceError("The public people selector changed");
    } else {
    const group = readUScheduleGroupSizeControl(page.body);
    if (group.present) {
      if (!group.oneAvailable) throw sourceError("The public single-bay selector is unavailable");
      await filter("group_size", "1");
    }
    }
  }
  await filter("start_date", `${input.date.slice(5, 7)}/${input.date.slice(8, 10)}/${input.date.slice(0, 4)}`);
  const tenant = location ? parseUScheduleLocationSource(url.href)!.tenant : uschedulePublicTenant(url.href)!;
  // An explicit PEOPLE dated grid already has complete date-bound starts.
  // Retain Date Chosen instead of changing it to the legacy list view.
  if (!location && !readUSchedulePublicPeopleControl(page.body).valid) {
    const view = readUScheduleNextAvailableView(page.body, tenant);
    if (view.present && !view.selected) {
      await refresh(url, cookie, "next_avail", undefined, fetchImpl, signal);
      page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
    }
  }
  const learned = { ...service, durationMinutes: input.durationMinutes, date: input.date, tenant, requestedPlayers: input.requestedPlayers }, slots: SimulatorAvailabilitySlot[] = [], seen = new Set<string>();
  let previousOrder = -Infinity;
  for (let index = 0; index < 16; index++) {
    // This is the already-consumed bounded body. Optional diagnostic capture
    // never consumes a transport stream, changes requests or masks the guard.
    try { diagnostics?.onListingPage?.(page.body); } catch { /* Diagnostic only. */ }
    const current = listing(page.body, service.serviceId, learned);
    if (current.times.at(-1)!.order <= previousOrder) throw schemaError("The public continuation did not advance");
    let crossedDate = false;
    for (const time of current.times) {
      if (time.date < input.date || time.order > Date.parse(`${input.date}T00:00:00Z`) + 60 * 86_400_000) throw schemaError("The public date list left its bounds");
      if (time.order <= previousOrder) { if (!seen.has(time.value)) throw schemaError("The public continuation regressed"); continue; }
      if (seen.has(time.value)) throw schemaError("The public continuation repeated a start");
      if (time.date > input.date) { crossedDate = true; continue; }
      if (crossedDate) throw schemaError("The public date list reordered dates");
      const startsAt = venueInstant(time.wall, input.timeZone);
      const endsAt = venueInstant(new Date(time.order + input.durationMinutes * 60_000).toISOString().slice(0, 19), input.timeZone);
      if (endsAt.getTime() - startsAt.getTime() !== input.durationMinutes * 60_000) throw schemaError("The public rental crosses a timezone transition");
      slots.push({ sourceId: `uschedule:${input.offering.id}:${service.serviceId}:${startsAt.toISOString()}`, offeringId: input.offering.id,
        resourceId: current.resourceId ?? (service.publicLocationProof ? `uschedule-location:${service.publicLocationProof.locationId}:pooled` : "ANY"),
        productId: service.serviceId, startsAt, endsAt, maxPartySize: service.publicLocationProof?.maxPartySize ?? null, bookingUrl: url.href }); seen.add(time.value);
    }
    previousOrder = current.times.at(-1)!.order;
    if (current.completeDate) return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.href,
      ...("publicPartyLimit" in current ? { publicPartyLimit: current.publicPartyLimit } : {}) };
    if (crossedDate) return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.href };
    if (!current.morePresent || index === 15) throw schemaError("The public date list was not completely observed");
    await refresh(url, cookie, "more_next_avail", current.cursor, fetchImpl, signal);
    page = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } }, "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  }
  throw schemaError("The public date list was not completely observed");
}

/** Reads only the selected default 60-minute public rental in a new anonymous session. */
export async function fetchUScheduleAvailability(input: SimulatorAvailabilityInput,
  fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  const tenant = uschedulePublicTenant(input.offering.bookingUrl);
  const metadata = metadataSchema.safeParse(input.offering.providerMetadata);
  if (!tenant || !metadata.success || metadata.data.tenant !== tenant || input.offering.providerFamilyKey !== "USCHEDULE" ||
      input.offering.active !== true || input.offering.publicAccessStatus !== "PUBLIC" ||
      input.offering.maxPartySize !== null || input.offering.supportedDurationsMinutes.length !== 1 ||
      input.offering.supportedDurationsMinutes[0] !== 60) throw sourceError("The reviewed USchedule rental source is not bound");
  if (!validDate(input.date) || !Number.isInteger(input.partySize) || input.partySize !== 1 || !input.offering.id ||
      input.offering.id.length > 200) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator request is invalid");
  if (input.durationMinutes !== 60) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "Only the selected public one-hour rental is verified");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The venue timezone is invalid"); }
  const url = new URL(input.offering.bookingUrl), signal = AbortSignal.timeout(25_000);
  const first = await publicResponse(url, { method: "GET", headers: { Accept: "text/html" } },
    "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  if (selectedRental(first.body).serviceId !== metadata.data.serviceId) throw sourceError("The public simulator service changed identity");
  const cookies = first.response.headers.getSetCookie();
  if (cookies.length !== 1) throw sourceError("The anonymous public scheduler session changed");
  const cookie = cookies[0].split(";", 1)[0];
  if (!/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}$/u.test(cookie)) throw sourceError("The anonymous public scheduler session changed");
  const dateValue = `${input.date.slice(5, 7)}/${input.date.slice(8, 10)}/${input.date.slice(0, 4)}`;
  await refresh(url, cookie, "start_date", dateValue, fetchImpl, signal);
  const slots: SimulatorAvailabilitySlot[] = [];
  const seen = new Set<string>();
  let previousOrder = -Infinity;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const dated = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } },
      "text/html", MAX_HTML_BYTES, fetchImpl, signal);
    const current = listing(dated.body, metadata.data.serviceId);
    if (current.times.at(-1)!.order <= previousOrder) throw schemaError("The public continuation did not advance");
    let crossedDate = false;
    for (const time of current.times) {
      if (time.date < input.date) throw schemaError("The public continuation regressed");
      if (time.order > Date.parse(`${input.date}T00:00:00Z`) + 60 * 86_400_000)
        throw schemaError("The public continuation left its bounded calendar horizon");
      if (time.order <= previousOrder) {
        if (!seen.has(time.value)) throw schemaError("The public continuation introduced an older start");
        continue;
      }
      if (seen.has(time.value)) throw schemaError("The public continuation repeated a new start");
      if (time.date > input.date) { crossedDate = true; continue; }
      if (crossedDate) throw schemaError("The public availability page reordered dates");
      const startsAt = venueInstant(time.wall, input.timeZone);
      const nextWall = new Date(time.order + 60 * 60_000).toISOString().slice(0, 19);
      const endsAt = venueInstant(nextWall, input.timeZone);
      if (endsAt.getTime() - startsAt.getTime() !== 60 * 60_000) throw schemaError("The public rental crosses an ambiguous timezone transition");
      slots.push({ sourceId: `uschedule:${input.offering.id}:${metadata.data.serviceId}:${startsAt.toISOString()}`,
        offeringId: input.offering.id, resourceId: "ANY", productId: metadata.data.serviceId,
        startsAt, endsAt, maxPartySize: null, bookingUrl: input.offering.bookingUrl });
      seen.add(time.value);
    }
    previousOrder = current.times.at(-1)!.order;
    if (crossedDate) return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.href };
    if (!current.morePresent || page === MAX_PAGES - 1) throw schemaError("The public date list was not completely observed");
    await refresh(url, cookie, "more_next_avail", current.cursor, fetchImpl, signal);
  }
  throw schemaError("The public date list was not completely observed");
}
