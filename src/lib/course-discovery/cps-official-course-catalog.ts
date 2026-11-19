import { parse, type DefaultTreeAdapterMap } from "parse5";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import { fullCourseName, type OfficialIdentityPage } from "./teeitup-official-identity";
import { parseCpsCourseNameComparisonEvidence, type CpsCourseNameComparisonEvidence } from "./cps-course-name-comparison-evidence";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (node: Node): node is Element => "tagName" in node;
const attr = (node: Element, key: string) => node.attrs.find(row => row.name === key)?.value ?? "";
const excluded = (node: Element) => ["script", "style", "template", "noscript", "iframe", "form", "input", "textarea", "select", "button"].includes(node.tagName) ||
  node.attrs.some(row => ["hidden", "inert"].includes(row.name) || row.name === "aria-hidden" && row.value === "true") ||
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/iu.test(attr(node, "style")) ||
  /(?:^|\s)(?:hidden|d-none|invisible|visually-hidden|sr-only|screen-reader-only)(?:\s|$)/iu.test(attr(node, "class"));
const text = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value :
  element(node) && excluded(node) ? "" : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
// CSS text-transform changes presentation case, not the public course label.
// Keep every word and punctuation mark in the raw/rendered pair and its hash.
const pairLabel = (value: string) => clean(value).toLowerCase();
const restricted = /\b(?:private|members?|login|account|checkout|payment|simulator|practice|range|lessons?|events?|gifts?|store|shop|banquet)\b/iu;
const key = (value: string) => fullCourseName(value).replace(/\s+(?:golf course|course)$/u, "");
export const cpsOfficialCourseCatalogFailureStages = ["NAMED_ROOT_PROVENANCE", "NAMED_VISIBLE_LINKS", "NAMED_DOCUMENT_LIMIT",
  "NAMED_LINK_SCOPE", "NAMED_LINK_LABEL", "NAMED_LINK_NAME", "NAMED_LINK_AMBIGUITY", "NAMED_COURSE_NAMES",
  "NAMED_RAW_TREE_LIMIT", "NAMED_RAW_LINK_PAIR"] as const;
type FailureStage = typeof cpsOfficialCourseCatalogFailureStages[number];
const failures = new WeakMap<object, FailureStage>();
const privateComparisons = new WeakMap<object, CpsCourseNameComparisonEvidence>();
/** Controller-owned failure vocabulary only; contains no source text or URLs. */
export function getCpsOfficialCourseCatalogFailureStage(error: unknown) {
  return error && typeof error === "object" ? failures.get(error) : undefined;
}
export function getCpsPrivateCourseNameComparison(error: unknown) {
  const value = error && typeof error === "object" ? privateComparisons.get(error) : undefined;
  return value ? structuredClone(value) : undefined;
}
const fail = (stage: FailureStage, comparison?: unknown): never => {
  const error = Error("ADAPTER_IDENTITY_MISMATCH");
  failures.set(error, stage);
  const privateValue = stage === "NAMED_COURSE_NAMES" ? parseCpsCourseNameComparisonEvidence(comparison) : undefined;
  if (privateValue) privateComparisons.set(error, privateValue);
  throw error;
};

/** Complete named sheets at a single venue, not a default/first-course choice.
 * These current raw/rendered witnesses only participate in a rederived catalog
 * hash. They never override access, provider, phone or physical identity gates. */
export function bindCpsOfficialCourseNames(source: { officialUrl: string; venueName: string }, page: OfficialIdentityPage,
  courses: ReadonlyArray<{ courseId: number; courseName: string }>) {
  const shown = page.visibleEvidence?.officialCourseLinkLabels;
  const root = freshNativeCanonicalRootDocument(page, source.officialUrl);
  if (!root || page.browserTransport !== "NATIVE_CHROME") return fail("NAMED_ROOT_PROVENANCE");
  if (page.visibleEvidence?.officialCourseLinkLabelsOmitted === true || !Array.isArray(shown) || shown.length < 2 || shown.length > 120)
    return fail("NAMED_VISIBLE_LINKS");
  if (courses.length < 2 || courses.length > 40 || Buffer.byteLength(page.html, "utf8") > 600_000) return fail("NAMED_DOCUMENT_LIMIT");
  // The native proof supplies the current document origin. Never infer a www
  // variant or another sibling host from the canonical URL or a copied page.
  const origins = new Set([new URL(source.officialUrl).origin, new URL(root.documentUrl).origin]);
  const publicLink = (href: string) => {
    try { const url = new URL(href); return href.length <= 2048 && url.href === href && url.protocol === "https:" && origins.has(url.origin) &&
      url.pathname !== "/" && !url.search && !url.hash && !url.username && !url.password && !url.port && !restricted.test(url.pathname.replace(/[_/-]/gu, " ")); }
    catch { return false; }
  };
  const named = new Map<string, { href: string; labels: Set<string> }>();
  for (const row of shown) {
    if (typeof row?.href !== "string" || !publicLink(row.href)) return fail("NAMED_LINK_SCOPE");
    if (typeof row.text !== "string" || row.text.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.text) ||
        !/\b(?:golf\s+)?course$/iu.test(clean(row.text)) || restricted.test(row.text)) return fail("NAMED_LINK_LABEL");
    const name = key(row.text);
    if (name.length < 3 || name === key(source.venueName) || /^(?:the|our|public|golf|course|courses)$/u.test(name)) return fail("NAMED_LINK_NAME");
    const prior = named.get(name);
    if (prior && prior.href !== row.href) return fail("NAMED_LINK_AMBIGUITY");
    if (prior) prior.labels.add(pairLabel(row.text));
    else named.set(name, { href: row.href, labels: new Set([pairLabel(row.text)]) });
  }
  if (named.size !== courses.length || new Set(courses.map(row => key(row.courseName))).size !== courses.length ||
      courses.some(row => !named.has(key(row.courseName)) || restricted.test(row.courseName))) return fail("NAMED_COURSE_NAMES", {
        schemaVersion: 1, kind: "CPS_NAMED_COURSE_COMPARISON", observedAt: new Date().toISOString(), canonicalName: key(source.venueName),
        officialNames: [...named.keys()].sort(), providerNames: courses.map(row => key(row.courseName)),
      });
  const rawPairs = new Set<string>(); let visited = 0;
  const walk = (node: Node, depth = 0) => {
    if (++visited > 20_000 || depth > 64) return fail("NAMED_RAW_TREE_LIMIT");
    if (element(node)) {
      if (excluded(node)) return;
      if (node.tagName === "a" && !node.attrs.some(row => ["onclick", "download"].includes(row.name))) {
        let href: string; try { href = new URL(attr(node, "href"), page.url).href; } catch { href = ""; }
        const label = pairLabel(text(node)), observed = named.get(key(label));
        if (observed?.href === href && observed.labels.has(label)) rawPairs.add(JSON.stringify([href, label]));
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(child => walk(child, depth + 1));
  };
  walk(parse(page.html));
  for (const row of named.values()) for (const label of row.labels)
    if (!rawPairs.has(JSON.stringify([row.href, label]))) return fail("NAMED_RAW_LINK_PAIR");
  return [...courses].sort((a, b) => a.courseId - b.courseId).map(row => ({ courseId: row.courseId, courseName: row.courseName,
    officialUrl: named.get(key(row.courseName))!.href, officialLabels: [...named.get(key(row.courseName))!.labels].sort() }));
}
