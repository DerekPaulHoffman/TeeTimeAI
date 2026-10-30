import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const id = z.string().regex(/^[1-9]\d{0,9}$/u);
const label = z.string().min(1).max(200).refine(value => value === value.normalize("NFKC").replace(/\s+/gu, " ").trim() && !/[<>\p{Cc}]/u.test(value) &&
  !/\b(?:members?|staff|prepaid|punch\s*card|credit|package|lesson|coaching)\b/iu.test(value));
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const catalog = z.object({ groupId: id, hasAnyChoice: z.boolean(), resources: z.array(z.object({ id, label }).strict()).min(1).max(4)
  .refine(values => values.every((value, index) => index === 0 || values[index - 1].id.localeCompare(value.id) < 0)) }).strict();
export const uschedulePublicResourcePoolProofSchema = catalog.extend({ kind: z.literal("PUBLIC_SIMULATOR_RESOURCE_POOL_V1"), catalogHash: z.string().regex(/^[a-f0-9]{64}$/u) })
  .refine(value => value.catalogHash === digest({ groupId: value.groupId, hasAnyChoice: value.hasAnyChoice, resources: value.resources }));
export type USchedulePublicResourcePoolProof = z.infer<typeof uschedulePublicResourcePoolProofSchema>;
export type USchedulePublicResourceSelection = { pool: USchedulePublicResourcePoolProof; resourceId: string };
function elements(node: Node): Element[] { return "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : elements(child)) : []; }
function attr(node: Element, key: string) { return node.attrs.find(value => value.name === key)?.value; }
function text(node: Node): string { return "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join(" ") : ""; }
function unsafe(node: Node) {
  for (let current: Node | undefined = node; current; current = "parentNode" in current ? current.parentNode ?? undefined : undefined) {
    if (!("tagName" in current)) continue;
    if (["script", "style", "iframe", "template", "noscript"].includes(current.tagName) ||
      current.attrs.some(a => ["hidden", "inert", "disabled", "onclick"].includes(a.name) || ["aria-hidden", "aria-disabled"].includes(a.name) && a.value === "true") ||
      /display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/iu.test(attr(current, "style") ?? "") ||
      /(?:^|\s)(?:d-none|hidden|invisible|sr-only|disabled)(?:\s|$)/u.test(attr(current, "class") ?? "") ||
      /\b(?:account|profile|checkout|payment|billing|login|members?|staff)\b/iu.test(["id", "class", "aria-label"].map(k => attr(current, k) ?? "").join(" "))) return true;
  }
  return false;
}
/** Public dropdown catalog only. It grants no selected start, booking, add-on,
 * quantity, account or payment operation. All public resources must be read. */
export function readUSchedulePublicResourcePool(html: string) {
  if (Buffer.byteLength(html) > 600_000) return;
  const nodes = elements(parse(html)); if (nodes.length > 20_000) return;
  const controls = nodes.filter(n => n.tagName === "select" && (attr(n, "class") ?? "").split(/\s/u).includes("resSelect"));
  if (controls.length !== 1 || unsafe(controls[0])) return;
  const control = controls[0], groupId = /^resource([1-9]\d{0,9})$/u.exec(attr(control, "id") ?? "")?.[1];
  const labels = nodes.filter(n => n.tagName === "label" && attr(n, "for") === attr(control, "id"));
  const sections = nodes.filter(n => attr(n, "id") === "res_section");
  let parent: Node | undefined = control;
  while (parent && parent !== sections[0]) parent = "parentNode" in parent ? parent.parentNode ?? undefined : undefined;
  if (!groupId || sections.length !== 1 || parent !== sections[0] || labels.length !== 1 || unsafe(labels[0]) || text(labels[0]).trim() !== "Simulators") return;
  const options = "childNodes" in control ? control.childNodes.filter((n): n is Element => "tagName" in n) : [];
  if (!options.length || options.length > 5 || options.some(n => n.tagName !== "option" || unsafe(n) || ("childNodes" in n && n.childNodes.some(child => "tagName" in child)))) return;
  const values = options.map(n => ({ id: attr(n, "value") ?? "", label: text(n).normalize("NFKC").replace(/\s+/gu, " ").trim(), selected: attr(n, "selected") !== undefined }));
  const selected = values.filter(n => n.selected), any = values.filter(n => n.id === "-1");
  if (selected.length !== 1 || new Set(values.map(n => n.id)).size !== values.length || any.length > 1 || any.some(n => n.label !== "Any Available")) return;
  const raw = { groupId, hasAnyChoice: any.length === 1, resources: values.filter(n => n.id !== "-1").map(({ id, label }) => ({ id, label })).sort((a, b) => a.id.localeCompare(b.id)) };
  const parsed = catalog.safeParse(raw); if (!parsed.success) return;
  const proof = uschedulePublicResourcePoolProofSchema.parse({ ...parsed.data, kind: "PUBLIC_SIMULATOR_RESOURCE_POOL_V1", catalogHash: digest(parsed.data) });
  return { proof, selectedResourceId: selected[0].id };
}
export function matchesUSchedulePublicResourceSelection(html: string, selection: USchedulePublicResourceSelection) {
  const pool = uschedulePublicResourcePoolProofSchema.safeParse(selection.pool), current = readUSchedulePublicResourcePool(html);
  return Boolean(pool.success && current && current.proof.catalogHash === pool.data.catalogHash &&
    pool.data.resources.some(resource => resource.id === selection.resourceId) && current.selectedResourceId === selection.resourceId);
}
/** Explicit visible provider result only. Mere absence of rows is never empty. */
export function hasUSchedulePublicEmptyResult(html: string) {
  if (Buffer.byteLength(html) > 600_000) return false;
  const nodes = elements(parse(html)); if (nodes.length > 20_000) return false;
  const cls = (node: Element, value: string) => (attr(node, "class") ?? "").split(/\s/u).includes(value);
  const choices = nodes.filter(node => cls(node, "choices"));
  if (choices.length !== 1 || !cls(choices[0], "no_times_avail") || unsafe(choices[0])) return false;
  const children = choices[0].childNodes.filter((node): node is Element => "tagName" in node);
  if (children.length !== 1 || children[0].tagName !== "p" || unsafe(children[0]) || elements(children[0]).length ||
      text(choices[0]).replace(/\s+/gu, " ").trim() !== "Sorry, there are no times available for the selected criteria.") return false;
  return !nodes.some(node => ["next_avail_results", "next_avail_item", "time_choices", "timeslot"].some(value => cls(node, value)) ||
    ["more_next_avail", "show-extra-row", "hide-extra-row"].includes(attr(node, "id") ?? ""));
}
