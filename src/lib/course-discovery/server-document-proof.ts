import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { CourseAccessRecipeData, RecipeField } from "./recipe";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Recipe = Extract<CourseAccessRecipeData, { engine: "BROWSER_DOM" }>;
export type ServerDocumentExtraction = { venue: unknown; date: unknown; complete: boolean; empty: unknown; players: unknown;
  duration: unknown; rows: Array<Record<string, unknown>> };
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
export function extractServerDocument(recipe: Recipe, html: string, format: (field: RecipeField, value: unknown) => unknown): ServerDocumentExtraction {
  if (Buffer.byteLength(html) > 2_000_000) throw new Error("SERVER_DOCUMENT_LIMIT");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const all = descendants(document), htmlNode = all.find(node => node.tagName === "html"), body = all.find(node => node.tagName === "body");
  if (!htmlNode?.sourceCodeLocation?.endTag || !body?.sourceCodeLocation?.endTag) throw new Error("SERVER_DOCUMENT_TRUNCATED");
  if (all.some(node => attr(node, "rel")?.split(/\s+/u).includes("next") || attr(node, "data-next-page") !== undefined ||
      /(?:^|\s)(?:pagination|infinite-scroll)(?:\s|$)/iu.test(attr(node, "class") ?? "") ||
      ["a", "button"].includes(node.tagName) && attr(node, "disabled") === undefined &&
      /^(?:next(?:\s+page)?|(?:load|show)\s+more(?:\s+(?:results|times|slots))?)[\s›»→]*$/iu.test((attr(node, "aria-label") ?? text(node)).trim())))
    throw new Error("SERVER_DOCUMENT_PAGINATION");
  if (!("selector" in recipe.slots.collection) || "kind" in recipe.proof.date || recipe.slots.scope) throw new Error("SERVER_DOCUMENT_SELECTOR_UNSUPPORTED");
  const rows = select(body, recipe.slots.collection.selector);
  if (rows.length > 500) throw new Error("INCOMPLETE_COLLECTION");
  const fields = Object.entries(recipe.slots).filter(([key]) => key !== "collection" && key !== "scope") as Array<[string, RecipeField]>;
  return { venue: read(body, recipe.proof.venue, format), date: read(body, recipe.proof.date, format), complete: true,
    empty: read(body, recipe.proof.empty, format), players: read(body, recipe.proof.players, format), duration: read(body, recipe.proof.durationMinutes, format),
    rows: rows.map(row => Object.fromEntries(fields.map(([key, field]) => [key, read(row, field, format)]))) };
}

export function sameServerDocumentEvidence(left: unknown, right: unknown): boolean {
  const normalized = (value: unknown): unknown => typeof value === "string" ? value.replace(/\s+/gu, " ").trim()
    : Array.isArray(value) ? value.map(normalized) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, normalized(item)])) : value;
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}
