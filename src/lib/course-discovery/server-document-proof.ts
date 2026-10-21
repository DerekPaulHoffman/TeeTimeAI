import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { AccessExecutionInput, CourseAccessRecipeData, RecipeField } from "./recipe";
import { expandRecipeTemplate } from "./recipe-template";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Recipe = Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>;
export type ServerDocumentExtraction = { venue: unknown; date: unknown; complete: boolean; empty: unknown; players: unknown;
  duration: unknown; rows: Array<Record<string, unknown>> };
export type ServerDocumentContext = { responseUrl: string; requestedDate: string; input?: AccessExecutionInput };
const simple = /^(?:[A-Za-z][A-Za-z0-9-]*)?(?:[.#][A-Za-z_][A-Za-z0-9_-]*)*$/u;
export function isServerDocumentSelector(value: string) {
  if (!value || value.length > 240 || /[\[\]:*+~,]/u.test(value)) return false;
  const tokens = value.trim().replace(/\s*>\s*/gu, " > ").split(/\s+/u);
  return tokens.length <= 15 && tokens.every((token, index) => token === ">"
    ? index > 0 && index < tokens.length - 1 && tokens[index - 1] !== ">" : simple.test(token) && token !== "");
}
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, name: string) => node.attrs.find(item => item.name === name)?.value;
const hidden = (node: Element) => ["script", "style", "template", "noscript"].includes(node.tagName) ||
  attr(node, "hidden") !== undefined || attr(node, "aria-hidden") === "true" || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(attr(node, "style") ?? "") ||
  node.tagName === "input" && attr(node, "type") === "hidden";
function descendants(root: Node) {
  const found: Element[] = [];
  const visit = (node: Node) => {
    if (element(node) && hidden(node)) return;
    if (element(node)) found.push(node);
    if (found.length > 20_000) throw new Error("SERVER_DOCUMENT_NODE_LIMIT");
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  if ("childNodes" in root) for (const child of root.childNodes) visit(child);
  return found;
}
function matches(node: Element, token: string) {
  const tag = /^[A-Za-z][A-Za-z0-9-]*/u.exec(token)?.[0];
  if (tag && node.tagName !== tag.toLowerCase()) return false;
  return [...token.matchAll(/([.#])([A-Za-z_][A-Za-z0-9_-]*)/gu)].every(([, type, value]) => type === "#"
    ? attr(node, "id") === value : (attr(node, "class") ?? "").split(/\s+/u).includes(value));
}
function select(root: Node, selector: string) {
  if (!isServerDocumentSelector(selector)) throw new Error("SERVER_DOCUMENT_SELECTOR_UNSUPPORTED");
  const tokens = selector.trim().replace(/\s*>\s*/gu, " > ").split(/\s+/u);
  return descendants(root).filter(node => {
    let cursor: Node | null = node, index = tokens.length - 1;
    if (!matches(node, tokens[index--])) return false;
    while (index >= 0) {
      if (tokens[index] === ">") {
        index--; cursor = "parentNode" in cursor! ? cursor.parentNode : null;
        if (!cursor || !element(cursor) || !matches(cursor, tokens[index--])) return false;
      } else {
        let parent: Node | null = "parentNode" in cursor! ? cursor.parentNode : null;
        while (parent && parent !== root && (!element(parent) || !matches(parent, tokens[index]))) parent = "parentNode" in parent ? parent.parentNode : null;
        if (!parent || !element(parent) || !matches(parent, tokens[index--])) return false;
        cursor = parent;
      }
      if (cursor === root && index >= 0) return false;
    }
    return true;
  });
}
function text(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if (element(node) && hidden(node)) return "";
  return "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
}
const dateOnly = (value: string) => {
  const iso = /^\d{8}$/u.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : value;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/u.test(iso) && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : undefined;
};
function contains(parent: Node, node: Node) {
  for (let cursor: Node | null = node; cursor; cursor = "parentNode" in cursor ? cursor.parentNode : null) if (cursor === parent) return true;
  return false;
}
function concealedCalendarNode(node: Element) {
  for (let cursor: Node | null = node; cursor; cursor = "parentNode" in cursor ? cursor.parentNode : null) if (element(cursor) &&
    (hidden(cursor) || attr(cursor, "inert") !== undefined || /^true$/iu.test(attr(cursor, "aria-hidden") ?? "") ||
      /(?:^|\s)(?:hidden|d-none|is-hidden|invisible|u-hidden|sr-only|visually-hidden|screen-reader-only)(?:\s|$)/iu.test(attr(cursor, "class") ?? "") ||
      /(?:visibility\s*:\s*collapse|opacity\s*:\s*0(?:\s*[;!]|\s*$))/iu.test(attr(cursor, "style") ?? ""))) return true;
  return false;
}
function calendarLabelMatches(card: Element, day: string) {
  const date = new Date(`${day}T00:00:00Z`), parts = text(card).trim().replace(/\s+/gu, " ").toLowerCase().split(" ");
  const month = ["short", "long"].map(month => new Intl.DateTimeFormat("en-US", { month: month as "short" | "long", timeZone: "UTC" }).format(date).toLowerCase());
  const weekday = ["short", "long"].map(weekday => new Intl.DateTimeFormat("en-US", { weekday: weekday as "short" | "long", timeZone: "UTC" }).format(date).toLowerCase());
  return [3, 4].includes(parts.length) && month.includes(parts[0]) && /^\d{1,2}$/u.test(parts[1]) && Number(parts[1]) === date.getUTCDate() &&
    (parts.length === 3 || parts[2] === String(date.getUTCFullYear())) && weekday.includes(parts.at(-1)!);
}
/** A plain Next link in a proved calendar strip changes days, not result pages.
 * This classifier never navigates or supplies availability/date evidence. */
function isCalendarNext(node: Element, recipe: Recipe, rows: Element[], context?: ServerDocumentContext) {
  if (!context || node.tagName !== "a" || text(node).trim().toLowerCase() !== "next" || concealedCalendarNode(node) ||
      attr(node, "aria-label") !== undefined && attr(node, "aria-label")!.trim().toLowerCase() !== "next" ||
      ["onclick", "target", "download", "disabled"].some(name => attr(node, name) !== undefined) ||
      recipe.availabilityResponse.kind !== "SERVER_DOCUMENT" || recipe.availabilityResponse.date.source !== "QUERY" || !dateOnly(context.requestedDate) ||
      context.input !== undefined && context.input.date !== context.requestedDate) return false;
  const key = recipe.availabilityResponse.date.path;
  let base: URL;
  try {
    base = new URL(context.responseUrl);
    // Bind actual execution inputs when available; never infer party/window
    // values from links. Date-only contexts reject other missing bindings.
    const bound = expandRecipeTemplate(recipe.availabilityResponse.url, context.input ?? { date: context.requestedDate }, true);
    if (base.href !== bound ||
        base.protocol !== "https:" || base.username || base.password || base.port || base.hash || base.searchParams.size > 10 ||
        [...base.searchParams.keys()].some(name => base.searchParams.getAll(name).length !== 1 || name !== key &&
          /^(?:page|pageindex|pagenumber|cursor|offset|skip|take|limit|perpage|start|next|continuation|after|before)$/iu.test(name)) ||
        base.searchParams.getAll(key).length !== 1 || dateOnly(base.searchParams.get(key)!) !== context.requestedDate) return false;
  } catch { return false; }
  const linkDate = (link: Element) => {
    try {
      if (["onclick", "target", "download", "disabled"].some(name => attr(link, name) !== undefined) || concealedCalendarNode(link)) return undefined;
      const href = attr(link, "href"); if (!href || href.length > 2048) return undefined;
      const url = new URL(href, base);
      return url.origin === base.origin && url.pathname === base.pathname && !url.username && !url.password && !url.port && !url.hash &&
        url.searchParams.size === base.searchParams.size && [...base.searchParams].every(([name, value]) =>
          url.searchParams.getAll(name).length === 1 && (name === key || url.searchParams.get(name) === value)) ? dateOnly(url.searchParams.get(key)!) : undefined;
    } catch { return undefined; }
  };
  let card: Element | undefined, list: Element | undefined;
  for (let cursor: Node | null = node.parentNode, depth = 0; cursor && depth < 6; cursor = "parentNode" in cursor ? cursor.parentNode : null, depth++) {
    if (!element(cursor)) continue;
    if (cursor.tagName === "li" && !card) card = cursor;
    if (["ol", "ul"].includes(cursor.tagName)) { list = cursor; break; }
  }
  if (!card || !list || card.parentNode !== list || concealedCalendarNode(list) ||
      rows.some(row => contains(row, list!) || contains(list!, row))) return false;
  const cards = list.childNodes.filter(element);
  if (cards.length < 3 || cards.length > 16 || cards.some(item => item.tagName !== "li") || cards.at(-1) !== card) return false;
  const next = linkDate(node), days: string[] = [];
  if (!next) return false;
  for (const sibling of cards) {
    const links = descendants(sibling).filter(item => item.tagName === "a");
    if (sibling === card) { if (links.length !== 1 || links[0] !== node) return false; continue; }
    if (!links.length) continue; // Expired non-link dates provide no proof.
    if (links.length > 4 || concealedCalendarNode(sibling)) return false;
    const dates = links.map(linkDate);
    if (dates.some(day => !day) || new Set(dates).size !== 1 || !calendarLabelMatches(sibling, dates[0]!)) return false;
    days.push(dates[0]!);
  }
  return days.length >= 2 && days.includes(context.requestedDate) && new Set(days).size === days.length &&
    [...days, next].every(day => Math.abs(Date.parse(day) - Date.parse(context.requestedDate)) <= 14 * 86_400_000) &&
    days.every((day, index) => index === 0 || Date.parse(day) - Date.parse(days[index - 1]) === 86_400_000) &&
    Date.parse(next) - Date.parse(days.at(-1)!) === 86_400_000;
}
function read(root: Node, field: RecipeField | undefined, format: (field: RecipeField, value: unknown) => unknown) {
  if (!field) return undefined;
  if (!("selector" in field)) throw new Error("SERVER_DOCUMENT_SELECTOR_UNSUPPORTED");
  const nodes = select(root, field.selector);
  if (nodes.length > 1) throw new Error("AMBIGUOUS_PROOF_FIELD");
  if (!nodes.length) return undefined;
  const node = nodes[0];
  let value: unknown;
  if (field.attribute === "selected-label") {
    const options = descendants(node).filter(child => child.tagName === "option");
    const selected = options.filter(child => attr(child, "selected") !== undefined);
    value = text(selected[0] ?? options[0] ?? node);
  } else value = field.attribute ? attr(node, field.attribute) : text(node);
  return format(field, value);
}

/** Parse inert source bytes; scripts cannot supply or replace this evidence. */
export function extractServerDocument(recipe: Recipe, html: string, format: (field: RecipeField, value: unknown) => unknown, context?: ServerDocumentContext): ServerDocumentExtraction {
  if (Buffer.byteLength(html) > 2_000_000) throw new Error("SERVER_DOCUMENT_LIMIT");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const all = descendants(document), htmlNode = all.find(node => node.tagName === "html"), body = all.find(node => node.tagName === "body");
  if (!htmlNode?.sourceCodeLocation?.endTag || !body?.sourceCodeLocation?.endTag) throw new Error("SERVER_DOCUMENT_TRUNCATED");
  if (!("selector" in recipe.slots.collection) || "kind" in recipe.proof.date || recipe.slots.scope) throw new Error("SERVER_DOCUMENT_SELECTOR_UNSUPPORTED");
  const rows = select(body, recipe.slots.collection.selector);
  if (all.some(node => attr(node, "rel")?.split(/\s+/u).some(value => value.toLowerCase() === "next") || attr(node, "data-next-page") !== undefined ||
      /(?:^|\s)(?:pagination|infinite-scroll)(?:\s|$)/iu.test(attr(node, "class") ?? "") ||
      ["a", "button"].includes(node.tagName) && attr(node, "disabled") === undefined &&
      /^(?:next(?:\s+page)?|(?:load|show)\s+more(?:\s+(?:results|times|slots))?)[\s›»→]*$/iu.test((attr(node, "aria-label") ?? text(node)).trim()) &&
      !isCalendarNext(node, recipe, rows, context)))
    throw new Error("SERVER_DOCUMENT_PAGINATION");
  if (rows.length > 500) throw new Error("INCOMPLETE_COLLECTION");
  const fields = Object.entries(recipe.slots).filter(([key]) => key !== "collection" && key !== "scope") as Array<[string, RecipeField]>;
  return { venue: read(body, recipe.proof.venue, format), date: read(body, recipe.proof.date, format), complete: true,
    empty: read(body, recipe.proof.empty, format), players: read(body, recipe.proof.players, format), duration: read(body, recipe.proof.durationMinutes, format),
    rows: rows.map(row => Object.fromEntries(fields.map(([key, field]) => [key, read(row, field, format)]))) };
}

export function sameServerDocumentEvidence(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown, path: string[] = []): unknown => {
    if (typeof value === "string") {
      const text = value.replace(/\s+/gu, " ").trim();
      // Inert child-node text can insert a space before an inline AM/PM.
      // Only slot clock fields may normalize that presentation difference.
      return path.length === 3 && path[0] === "rows" && /^\d+$/u.test(path[1]) && ["startsAt", "endsAt"].includes(path[2])
        ? boundedMeridiemClock(text) ?? text : text;
    }
    return Array.isArray(value) ? value.map((item, index) => normalized(item, [...path, String(index)])) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, normalized(item, [...path, key])])) : value;
  };
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

type DocumentVersion = { generation: number; documentSequence: number; dataSequence: number };
function boundedMeridiemClock(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return /^(?:0?[1-9]|1[0-2]):[0-5]\d(?::[0-5]\d)?\s*[AP]M$/iu.test(text) ? text.replace(/\s+(?=[AP]M$)/iu, "") : undefined;
}
/** Diagnostic only: never supplies proof, changes equality, or exposes values. */
export function serverDocumentMismatchDiagnostic(source: DocumentVersion & { extracted: unknown } | undefined, current: DocumentVersion, live: unknown): string {
  if (!source) return "SERVER_DOCUMENT_SOURCE_MISSING";
  if (source.generation !== current.generation) return "SERVER_DOCUMENT_GENERATION_MISMATCH";
  if (source.documentSequence !== current.documentSequence) return "SERVER_DOCUMENT_SEQUENCE_MISMATCH";
  if (source.dataSequence !== current.dataSequence) return "SERVER_DOCUMENT_DATA_SEQUENCE_MISMATCH";
  if (sameServerDocumentEvidence(source.extracted, live)) return "SERVER_DOCUMENT_NO_MISMATCH";
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!record(source.extracted) || !record(live)) return "SERVER_DOCUMENT_SHAPE_MISMATCH";
  const fieldCode = (left: unknown, right: unknown, field: string) => {
    if (sameServerDocumentEvidence(left, right)) return undefined;
    const clock = ["ROW_STARTS_AT", "ROW_ENDS_AT"].includes(field) ? boundedMeridiemClock(left) : undefined;
    const kind = clock !== undefined && clock === boundedMeridiemClock(right) ? "MERIDIEM_SPACING" : typeof left !== typeof right ? "TYPE" : typeof left === "string" && typeof right === "string" &&
      left.replace(/\s+/gu, "") === right.replace(/\s+/gu, "") ? "SPACING" : "VALUE";
    return `SERVER_DOCUMENT_${field}_${kind}_MISMATCH`;
  };
  for (const key of ["venue", "date", "complete", "empty", "players", "duration"] as const) {
    const code = fieldCode(source.extracted[key], live[key], `FIELD_${key.toUpperCase()}`);
    if (code) return code;
  }
  const leftRows = source.extracted.rows, rightRows = live.rows;
  if (!Array.isArray(leftRows) || !Array.isArray(rightRows)) return "SERVER_DOCUMENT_ROWS_SHAPE_MISMATCH";
  if (leftRows.length !== rightRows.length) return "SERVER_DOCUMENT_ROW_COUNT_MISMATCH";
  const fields = [["startsAt", "STARTS_AT"], ["endsAt", "ENDS_AT"], ["availableSpots", "AVAILABLE_SPOTS"], ["minimumPlayers", "MINIMUM_PLAYERS"],
    ["capacity", "CAPACITY"], ["holes", "HOLES"], ["resourceId", "RESOURCE_ID"], ["productId", "PRODUCT_ID"]] as const;
  for (let index = 0; index < leftRows.length; index++) {
    const left = leftRows[index], right = rightRows[index];
    if (!record(left) || !record(right)) return "SERVER_DOCUMENT_ROW_SHAPE_MISMATCH";
    for (const [key, name] of fields) {
      const code = fieldCode(left[key], right[key], `ROW_${name}`);
      if (code) return code;
    }
  }
  return "SERVER_DOCUMENT_OTHER_MISMATCH";
}
