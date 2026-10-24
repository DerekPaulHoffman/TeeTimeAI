import { randomUUID } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { Page } from "@playwright/test";
import type { AccessExecutionInput } from "./recipe";
import { adjacentMindbodyDay, createMindbodyPublicDayFormIntent, createMindbodyPublicFormIntent, isMindbodyPublicCalendarDocument,
  isMindbodyPublicSearchDocument, mindbodyCivilToDisplayedDate, type MindbodyPublicFormIntent } from "./mindbody-public-form-read";
import { parseMindbodyAppointmentSource, type MindbodyAppointmentSource, type MindbodyCatalogEvidence, type MindbodyGridEvidence } from "./mindbody-appointment-grid";

type Node = DefaultTreeAdapterMap["node"];
type ParsedElement = DefaultTreeAdapterMap["element"];
const elem = (node: Node): node is ParsedElement => "tagName" in node;
const attr = (node: ParsedElement, key: string) => node.attrs.find(row => row.name === key)?.value;
const clean = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const text = (node: Node): string => node.nodeName === "#text" ? (node as DefaultTreeAdapterMap["textNode"]).value :
  elem(node) && ["script", "style", "template", "noscript"].includes(node.tagName) ? "" : "childNodes" in node ? node.childNodes.map(text).join(" ") : "";
function nodes(root: Node) { const all: ParsedElement[] = []; let count = 0;
  const visit = (node: Node) => { if (++count > 30_000) throw new Error("MINDBODY_DOCUMENT_NODE_LIMIT");
    if (elem(node)) all.push(node); if ("childNodes" in node) node.childNodes.forEach(visit); }; visit(root); return all; }
function ancestor(node: Node, tag: string): ParsedElement | undefined {
  for (let at: Node | null = node; at; at = "parentNode" in at ? at.parentNode : null) if (elem(at) && at.tagName === tag) return at;
}
function gridCaptionDate(value: string) {
  const dates = [...value.matchAll(/\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\b/gu)];
  if (dates.length !== 1) throw new Error("MINDBODY_GRID_DATE_UNPROVED");
  const date = dates[0][4] + "-" + dates[0][2].padStart(2, "0") + "-" + dates[0][3].padStart(2, "0");
  mindbodyCivilToDisplayedDate(date);
  if (new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(date + "T12:00:00Z")) !== dates[0][1])
    throw new Error("MINDBODY_GRID_DATE_UNPROVED");
  return date;
}
/** Controller-private raw form interpretation; returned token/body never
 * reaches models, recipes, diagnostics or another transport. */
export function projectMindbodyDayForm(html: string, sourceUrl: string) {
  if (!isMindbodyPublicCalendarDocument(sourceUrl) || Buffer.byteLength(html) > 2_000_000 || !/<\/body\s*>/iu.test(html) || !/<\/html\s*>/iu.test(html))
    throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
  const all = nodes(parse(html)), forms = all.filter(node => node.tagName === "form" && attr(node, "name") === "search2");
  if (forms.length !== 1 || attr(forms[0], "method")?.toLowerCase() !== "post" ||
      attr(forms[0], "enctype") && attr(forms[0], "enctype") !== "application/x-www-form-urlencoded") throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
  const fields = new URLSearchParams();
  for (const node of nodes(forms[0])) {
    const name = attr(node, "name"); if (!name || !["input", "select", "textarea"].includes(node.tagName)) continue;
    if (attr(node, "disabled") !== undefined || node.tagName === "textarea") throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
    if (node.tagName === "input") {
      if (!["hidden", "text"].includes(attr(node, "type") ?? "text")) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
      fields.append(name, attr(node, "value") ?? "");
    } else {
      if (attr(node, "multiple") !== undefined) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
      const options = nodes(node).filter(item => item.tagName === "option"), selected = options.filter(item => attr(item, "selected") !== undefined);
      const option = selected.length === 1 ? selected[0] : selected.length === 0 ? options[0] : undefined;
      if (!option || attr(option, "disabled") !== undefined) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
      fields.append(name, attr(option, "value") ?? clean(text(option)));
    }
  }
  return { targetUrl: new URL(attr(forms[0], "action") ?? sourceUrl, sourceUrl).href, body: fields.toString() };
}
const cls = (node: ParsedElement, name: string) => (attr(node, "class") ?? "").split(/\s+/u).includes(name);
type CatalogProjection = { title: string; bodyText: string; locationId: string; studioId: string; venueAddress: string;
  categories: Array<{ id: string; label: string; enabled: boolean; selected: boolean }>;
  services: Array<{ id: string; label: string; description: string; enabled: boolean; selected: boolean }>;
  resources: Array<{ id: string; label: string; enabled: boolean }> };
type CatalogComparisonDiagnostic = {
  fieldsEqual: Record<keyof CatalogProjection, boolean>;
  rawCounts: { categories: number; services: number; resources: number };
  renderedCounts: { categories: number; services: number; resources: number };
  rawTextLengths: { title: number; bodyText: number; locationId: number; studioId: number; venueAddress: number };
  renderedTextLengths: { title: number; bodyText: number; locationId: number; studioId: number; venueAddress: number };
};
function catalogComparisonDiagnostic(raw: CatalogProjection, rendered: CatalogProjection): CatalogComparisonDiagnostic {
  const counts = (value: CatalogProjection) => ({ categories: value.categories.length, services: value.services.length, resources: value.resources.length });
  const lengths = (value: CatalogProjection) => ({ title: value.title.length, bodyText: value.bodyText.length,
    locationId: value.locationId.length, studioId: value.studioId.length, venueAddress: value.venueAddress.length });
  return { fieldsEqual: { title: raw.title === rendered.title, bodyText: raw.bodyText === rendered.bodyText,
    locationId: raw.locationId === rendered.locationId, studioId: raw.studioId === rendered.studioId, venueAddress: raw.venueAddress === rendered.venueAddress,
    categories: JSON.stringify(raw.categories) === JSON.stringify(rendered.categories), services: JSON.stringify(raw.services) === JSON.stringify(rendered.services),
    resources: JSON.stringify(raw.resources) === JSON.stringify(rendered.resources) },
    rawCounts: counts(raw), renderedCounts: counts(rendered), rawTextLengths: lengths(raw), renderedTextLengths: lengths(rendered) };
}
function catalogSemanticKey(value: CatalogProjection) {
  // Whole-page text includes unrelated client-rendered notices. Keep it in
  // the raw parser and diagnostics; the bound catalog uses these exact fields.
  return JSON.stringify({ title: value.title, locationId: value.locationId, studioId: value.studioId, venueAddress: value.venueAddress,
    categories: value.categories, services: value.services, resources: value.resources });
}
/** Native bytes are interpreted outside the provider's JavaScript realm. */
export function projectMindbodySearchCatalog(html: string): CatalogProjection {
  if (Buffer.byteLength(html) > 2_000_000 || !/<\/body\s*>/iu.test(html) || !/<\/html\s*>/iu.test(html)) throw new Error("MINDBODY_CATALOG_DOCUMENT_INCOMPLETE");
  const root = parse(html), all = nodes(root), bodyText = clean(text(root));
  const inputs = all.filter(node => node.tagName === "input"), categoryInputs = inputs.filter(node => attr(node, "name") === "optTG");
  const form = all.filter(node => node.tagName === "form" && attr(node, "name") === "frmApptSearch");
  if (form.length !== 1 || categoryInputs.some(node => ancestor(node, "form") !== form[0])) throw new Error("MINDBODY_CATALOG_FORM_UNPROVED");
  const flags = (node: ParsedElement) => ({ enabled: attr(node, "disabled") === undefined, selected: attr(node, "checked") !== undefined });
  const categories = categoryInputs.map(node => { const row = ancestor(node, "tr"), labels = row ? nodes(row).filter(item => item.tagName === "label") : [];
    return { id: attr(node, "value") ?? "", label: clean(labels.map(text).join(" ")), ...flags(node) }; });
  const services = inputs.filter(node => attr(node, "name") === "optVT" && attr(node, "value")).map(node => {
    const row = ancestor(node, "tr"), parts = row ? nodes(row) : [];
    return { id: attr(node, "value") ?? "", label: clean(parts.filter(item => cls(item, "sessionTypeName")).map(text).join(" ")),
      description: clean(parts.filter(item => cls(item, "sessionTypeDescription")).map(text).join(" ")), ...flags(node) };
  });
  const selects = all.filter(node => node.tagName === "select" && attr(node, "name") === "optTrnID");
  const resources = selects.length === 1 ? nodes(selects[0]).filter(node => node.tagName === "option" && attr(node, "value")).map(node =>
    ({ id: attr(node, "value")!, label: clean(text(node)), enabled: attr(node, "disabled") === undefined && attr(selects[0], "disabled") === undefined })) : [];
  const sites = [...bodyText.matchAll(/\bSite ID:\s*([1-9]\d{0,9})\b/gu)], loc = inputs.filter(node => attr(node, "name") === "optLoc");
  if (sites.length !== 1 || loc.length !== 1 || attr(loc[0], "type") !== "hidden") throw new Error("MINDBODY_CATALOG_IDENTITY_UNPROVED");
  const addressAt = sites[0].index! + sites[0][0].length;
  return { title: clean(all.filter(node => node.tagName === "title").map(text).join(" ")), bodyText, locationId: attr(loc[0], "value") ?? "",
    studioId: sites[0][1], venueAddress: clean(bodyText.slice(addressAt)), categories, services, resources };
}
type NativeDocument = { version: number; url: string; status: number; contentType: string; html: string;
  startedAt: number; priorTimeOrigin?: number; readyTimeOrigin?: number };
type PointerElement = { tag: string; id?: string; classes: string[]; identifiersOmitted: boolean };
type CaptureDiagnostic = { stage: "IDLE" | "WAIT_DOCUMENT" | "WAIT_RENDERED" | "RAW_CATALOG" | "RENDERED_CATALOG" | "COMPARE_CATALOG" | "CATALOG_READY" | "WAIT_GRID" | "WAIT_GRID_RENDERED" | "RAW_GRID" | "GRID_READY" | "DAY_FORM" | "BROWSE_LOCATE" | "BROWSE_VALIDATE" | "BROWSE_ACTION" | "BROWSE_DONE" | "DAY_ACTION";
  elapsedMs: number; nativeDocumentCurrent: boolean; pendingReads: number; documentVersion?: number;
  rawBytes?: number; rawBodyClosed?: boolean; rawHtmlClosed?: boolean; renderedBytes?: number; renderedBodyClosed?: boolean; renderedHtmlClosed?: boolean;
  catalogComparison?: CatalogComparisonDiagnostic;
  readyState?: "loading" | "interactive" | "complete" | "UNKNOWN"; timeOriginFinite?: boolean; timeOriginChangedFromPrior?: boolean; timeOriginMatchesAccepted?: boolean;
  evaluationStage?: "READINESS" | "CATALOG_VISIBILITY" | "SEARCH_FORM" | "GRID" | "DAY_ARROW" | "DAY_FORM";
  evaluationFailure?: "SERIALIZATION" | "DOCUMENT_CHANGED" | "CLOSED_CONTRACT" | "OTHER";
  actionStage?: "BROWSE_LOCATE" | "BROWSE_VALIDATE" | "BROWSE_ACTION" | "DAY_ACTION";
  actionFailure?: "POINTER_INTERCEPTED" | "NOT_STABLE" | "DETACHED" | "DOCUMENT_CHANGED" | "TIMEOUT" | "NAVIGATION_FAILED" | "CONTRACT" | "OTHER";
  actionElapsedMs?: number; actionTimedOut?: boolean; actionPointerIntercepted?: boolean; actionNotStable?: boolean; actionDetached?: boolean; actionDocumentChanged?: boolean;
  browseCount?: number; browseVisible?: boolean; browseEnabled?: boolean; browseLabelMatches?: boolean; browseTypeButton?: boolean;
  pointerProbe?: "CAPTURED" | "UNAVAILABLE" | "DEADLINE" | "DOCUMENT_CHANGED";
  pointerDocumentCurrent?: boolean; pointerButtonCount?: number; pointerCenterInViewport?: boolean;
  pointerHitInsideButton?: boolean; pointerHit?: PointerElement; pointerAncestors?: PointerElement[] };
export function createMindbodyAppointmentNativeCapture(options: { page: Page; source?: MindbodyAppointmentSource; requestedInput?: AccessExecutionInput;
  native: boolean; deadlineAt: number; pendingReads(): number; assertActive(): void }) {
  const { page, source } = options, descriptor = source && parseMindbodyAppointmentSource(source.bookingUrl), captureId = randomUUID();
  let revision = 0, nativeDocument: NativeDocument | undefined, formIntent: MindbodyPublicFormIntent | undefined;
  let documentStartedAt = Date.now(), lastReadyTimeOrigin: number | undefined;
  let diagnostic: CaptureDiagnostic = { stage: "IDLE", elapsedMs: 0, nativeDocumentCurrent: false, pendingReads: 0 };
  let catalog: MindbodyCatalogEvidence | undefined, catalogDocument: NativeDocument | undefined, savedCatalogSemanticKey: string | undefined;
  let catalogBusy = false, gridBusy = false, navigationPhase: "BROWSE" | "DAY" | undefined;
  function active() { options.assertActive(); if (!options.native || !source || !descriptor || !options.requestedInput?.durationMinutes)
    throw new Error("MINDBODY_NATIVE_CONTEXT_REQUIRED"); }
  const current = (doc: NativeDocument) => nativeDocument === doc && doc.url === page.url() && doc.status === 200 && /^text\/html(?:;|$)/iu.test(doc.contentType);
  async function probeBrowsePointer() {
    const doc = catalogDocument, budget = Math.min(750, options.deadlineAt - Date.now());
    if (budget <= 0) { diagnostic.pointerProbe = "DEADLINE"; return; }
    if (!doc || !current(doc)) { diagnostic.pointerProbe = "DOCUMENT_CHANGED"; diagnostic.pointerDocumentCurrent = false; return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([page.evaluate(() => {
        // Self-contained object methods also serialize under tsx keepNames.
        // Deliberately omit text, HTML, URLs, form values and arbitrary attrs.
        const probe = { element(node: Element) {
          const classes: string[] = []; let identifiersOmitted = false;
          const id = node.id, safe = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u, privateName = /token|session|auth|csrf|email|password|credential/iu;
          for (const value of Array.from(node.classList).slice(0, 16)) {
            if (safe.test(value) && !privateName.test(value) && classes.length < 8) classes.push(value); else identifiersOmitted = true;
          }
          if (node.classList.length > 16) identifiersOmitted = true;
          const publicId = id && safe.test(id) && !privateName.test(id) ? id : undefined;
          if (id && !publicId) identifiersOmitted = true;
          return { tag: /^[a-z][a-z0-9-]{0,31}$/u.test(node.localName) ? node.localName : "other", ...(publicId ? { id: publicId } : {}), classes, identifiersOmitted };
        } };
        const buttons = document.querySelectorAll('form[name="frmApptSearch"] input[name="apptSchedBut"]');
        if (buttons.length !== 1) return { timeOrigin: performance.timeOrigin, count: Math.min(buttons.length, 2), inViewport: undefined, inside: undefined,
          hit: undefined, ancestors: undefined };
        const button = buttons[0], rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
        const hit = inViewport ? document.elementFromPoint(x, y) : null, ancestors: ReturnType<typeof probe.element>[] = [];
        for (let node = hit?.parentElement; node && ancestors.length < 3; node = node.parentElement) ancestors.push(probe.element(node));
        return { timeOrigin: performance.timeOrigin, count: 1, inViewport, inside: !!hit && button.contains(hit), ...(hit ? { hit: probe.element(hit), ancestors } : {}) };
      }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("POINTER_PROBE_TIMEOUT")), budget); })]);
      const documentCurrent = current(doc) && result.timeOrigin === doc.readyTimeOrigin;
      diagnostic = { ...diagnostic, pointerProbe: documentCurrent ? "CAPTURED" : "DOCUMENT_CHANGED", pointerDocumentCurrent: documentCurrent,
        ...(documentCurrent ? { pointerButtonCount: result.count, pointerCenterInViewport: result.inViewport,
          pointerHitInsideButton: result.inside, pointerHit: result.hit, pointerAncestors: result.ancestors } : {}) };
    } catch { diagnostic.pointerProbe = "UNAVAILABLE"; }
    finally { if (timer) clearTimeout(timer); }
  }
  async function evaluate<T>(stage: NonNullable<CaptureDiagnostic["evaluationStage"]>, work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const contract = ["MINDBODY_PUBLIC_FORM_REJECTED", "MINDBODY_DOCUMENT_NODE_LIMIT", "MINDBODY_PUBLIC_DAY_REJECTED"].find(code => message.includes(code));
      const failure = /__name is not defined/u.test(message) ? "SERIALIZATION" :
        /Execution context was destroyed|Cannot find context|Target page, context or browser has been closed/u.test(message) ? "DOCUMENT_CHANGED" : contract ? "CLOSED_CONTRACT" : "OTHER";
      diagnostic = { ...diagnostic, evaluationStage: stage, evaluationFailure: failure };
      throw new Error(contract ?? (failure === "SERIALIZATION" ? "MINDBODY_BROWSER_SERIALIZATION_FAILED" :
        failure === "DOCUMENT_CHANGED" ? "MINDBODY_BROWSER_DOCUMENT_CHANGED" : "MINDBODY_BROWSER_EVALUATION_FAILED"));
    }
  }
  async function action<T>(stage: NonNullable<CaptureDiagnostic["actionStage"]>, work: () => Promise<T>): Promise<T> {
    const started = Date.now(); diagnostic = { ...diagnostic, stage, actionStage: stage, actionElapsedMs: 0 };
    try { const value = await work(); diagnostic.actionElapsedMs = Math.max(0, Date.now() - started); return value; }
    catch (error) {
      const message = error instanceof Error ? error.message : "", name = error instanceof Error ? error.name : "";
      const timedOut = name === "TimeoutError" || /timeout|timed out/iu.test(message), intercepted = /intercepts? pointer events|pointer events intercepted/iu.test(message);
      const notStable = /element is not stable|element is moving/iu.test(message), detached = /not attached to the DOM|detached from|element was detached/iu.test(message);
      const changed = /Execution context was destroyed|Cannot find context|Target page, context or browser has been closed/iu.test(message);
      const contract = message === "MINDBODY_PUBLIC_BROWSE_UNPROVED" || message === "MINDBODY_PUBLIC_DAY_UNPROVED";
      const failure = intercepted ? "POINTER_INTERCEPTED" : notStable ? "NOT_STABLE" : detached ? "DETACHED" : changed ? "DOCUMENT_CHANGED" :
        timedOut ? "TIMEOUT" : /net::ERR_|Navigation interrupted|Failed to navigate|navigation failed/iu.test(message) ? "NAVIGATION_FAILED" : contract ? "CONTRACT" : "OTHER";
      diagnostic = { ...diagnostic, stage, actionStage: stage, actionFailure: failure, actionElapsedMs: Math.max(0, Date.now() - started),
        actionTimedOut: timedOut, actionPointerIntercepted: intercepted, actionNotStable: notStable, actionDetached: detached, actionDocumentChanged: changed };
      if (stage === "BROWSE_ACTION" && intercepted) await probeBrowsePointer();
      // Only closed program-owned codes leave this boundary. Playwright call
      // logs, selectors, page strings and provider error payloads stay private.
      throw new Error(contract ? message : "MINDBODY_" + (stage === "DAY_ACTION" ? "DAY_" : "BROWSE_") + (failure === "OTHER" ? "ACTION_FAILED" : failure));
    }
  }
  async function wait<T>(read: () => Promise<T | undefined>, code: string, maxMs = 12_000): Promise<T> {
    const until = Math.min(options.deadlineAt, Date.now() + maxMs);
    for (;;) { active(); const value = await read(); if (value !== undefined) return value;
      if (Date.now() >= until) throw new Error(code); await page.waitForTimeout(Math.min(50, until - Date.now())); }
  }
  async function settledSearch() {
    return wait(async () => {
      const doc = nativeDocument;
      diagnostic = { stage: "WAIT_DOCUMENT", elapsedMs: Math.max(0, Date.now() - documentStartedAt), nativeDocumentCurrent: !!doc && current(doc), pendingReads: options.pendingReads(),
        ...(doc ? { documentVersion: doc.version, rawBytes: Buffer.byteLength(doc.html), rawBodyClosed: /<\/body\s*>/iu.test(doc.html), rawHtmlClosed: /<\/html\s*>/iu.test(doc.html) } : {}) };
      if (!doc || !current(doc) || !isMindbodyPublicSearchDocument(doc.url, descriptor?.studioId) || diagnostic.pendingReads) return;
      // One browser-realm read binds readiness and serialized DOM together.
      // A paused native response can finish before Chrome parses/commits it;
      // URL equality and zero requests alone do not establish a new document.
      const rendered = await evaluate("READINESS", () => page.evaluate(() => ({ readyState: document.readyState, timeOrigin: performance.timeOrigin,
        html: document.documentElement?.outerHTML ?? "" })));
      const finiteOrigin = Number.isFinite(rendered.timeOrigin) && rendered.timeOrigin > 0;
      diagnostic = { ...diagnostic, stage: "WAIT_RENDERED", nativeDocumentCurrent: current(doc),
        readyState: ["loading", "interactive", "complete"].includes(rendered.readyState) ? rendered.readyState : "UNKNOWN",
        timeOriginFinite: finiteOrigin, ...(doc.priorTimeOrigin === undefined ? {} : { timeOriginChangedFromPrior: finiteOrigin && rendered.timeOrigin !== doc.priorTimeOrigin }),
        ...(doc.readyTimeOrigin === undefined ? {} : { timeOriginMatchesAccepted: finiteOrigin && rendered.timeOrigin === doc.readyTimeOrigin }),
        renderedBytes: Buffer.byteLength(rendered.html), renderedBodyClosed: /<\/body\s*>/iu.test(rendered.html), renderedHtmlClosed: /<\/html\s*>/iu.test(rendered.html) };
      if (!current(doc) || rendered.readyState !== "complete" || !finiteOrigin ||
          doc.priorTimeOrigin !== undefined && rendered.timeOrigin === doc.priorTimeOrigin ||
          doc.readyTimeOrigin !== undefined && rendered.timeOrigin !== doc.readyTimeOrigin) return;
      diagnostic.stage = "RAW_CATALOG";
      if (!diagnostic.rawBodyClosed || !diagnostic.rawHtmlClosed || diagnostic.rawBytes! > 2_000_000)
        throw new Error("MINDBODY_CATALOG_RAW_DOCUMENT_INCOMPLETE");
      if (!diagnostic.renderedBodyClosed || !diagnostic.renderedHtmlClosed) { diagnostic.stage = "WAIT_RENDERED"; return; }
      diagnostic.stage = "RAW_CATALOG";
      const raw = projectMindbodySearchCatalog(doc.html);
      diagnostic.stage = "RENDERED_CATALOG";
      const visible = projectMindbodySearchCatalog(rendered.html);
      diagnostic.stage = "COMPARE_CATALOG";
      // Closed scalar diagnostics identify divergence without retaining page
      // text, IDs, routing values, form values, URLs or provider credentials.
      diagnostic.catalogComparison = catalogComparisonDiagnostic(raw, visible);
      if (catalogSemanticKey(raw) !== catalogSemanticKey(visible)) throw new Error("MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH");
      if (!current(doc)) return;
      doc.readyTimeOrigin = rendered.timeOrigin; lastReadyTimeOrigin = rendered.timeOrigin;
      diagnostic.stage = "CATALOG_READY";
      return { doc, projection: raw };
    }, "MINDBODY_CATALOG_UNAVAILABLE");
  }
  async function assertRenderedCatalog(projection: CatalogProjection) {
    const rendered = await evaluate("CATALOG_VISIBILITY", () => page.evaluate(() => {
      // Object methods stay self-contained under tsx keepNames. Assigned
      // nested arrows capture its module-only __name helper in real Chrome.
      const rendering = { visible(node: Element, rectangles = true) {
        if (rectangles && !node.getClientRects().length) return false;
        for (let at: Element | null = node; at; at = at.parentElement) {
          const style = getComputedStyle(at);
          if (at.hasAttribute("hidden") || at.hasAttribute("inert") || at.getAttribute("aria-hidden") === "true" ||
              style.display === "none" || ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false;
        } return true;
      }, publicText(node: ChildNode): string {
        return node.nodeType === 3 ? node.textContent ?? "" :
          node instanceof Element && (!this.visible(node, false) || ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) ? "" :
            Array.from(node.childNodes).map(child => this.publicText(child)).join(" ");
      } };
      const categories = Array.from(document.querySelectorAll<HTMLInputElement>('form[name="frmApptSearch"] input[name="optTG"]:checked'));
      const services = Array.from(document.querySelectorAll<HTMLInputElement>('form[name="frmApptSearch"] input[name="optVT"]:checked'));
      const category = categories.length === 1 ? categories[0] : undefined, service = services.length === 1 ? services[0] : undefined;
      const categoryRow = category?.closest("tr"), serviceRow = service?.closest("tr");
      const labels = categoryRow ? Array.from(categoryRow.querySelectorAll("label")).filter(node => rendering.visible(node) &&
        (!node.getAttribute("for") || !!category?.id && node.getAttribute("for") === category.id)) : [];
      const names = serviceRow ? Array.from(serviceRow.querySelectorAll(".sessionTypeName")).filter(node => rendering.visible(node)) : [];
      const descriptions = serviceRow ? Array.from(serviceRow.querySelectorAll(".sessionTypeDescription")).filter(node => rendering.visible(node)) : [];
      const resourceSelect = document.querySelector<HTMLSelectElement>('form[name="frmApptSearch"] select[name="optTrnID"]');
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const parts: string[] = []; let count = 0;
      while (walker.nextNode()) { if (++count > 30_000) throw new Error("MINDBODY_DOCUMENT_NODE_LIMIT");
        const node = walker.currentNode, parent = node.parentElement; if (parent && !parent.closest("script,style,template,noscript") && rendering.visible(parent)) parts.push(node.textContent ?? ""); }
      // This publisher deliberately hides a selected radio. Its checked ID
      // remains binding; only the public label/service row proves visibility.
      return { text: parts.join(" "), categoryId: category?.value, serviceId: service?.value,
        categoryLabel: labels.map(node => rendering.publicText(node)).join(" "), serviceName: names.map(node => rendering.publicText(node)).join(" "),
        serviceDescription: descriptions.map(node => rendering.publicText(node)).join(" "),
        selectedVisible: !!category && !!service && !category.disabled && !service.disabled && !!categoryRow && !!serviceRow &&
          rendering.visible(categoryRow) && rendering.visible(serviceRow) && labels.length === 1 && names.length === 1 && descriptions.length === 1,
        resourcesVisible: !!resourceSelect && rendering.visible(resourceSelect) && Array.from(resourceSelect.options).filter(node => node.value).every(node => rendering.visible(node, false)) };
    }));
    const visibleText = clean(rendered.text), category = projection.categories.filter(row => row.selected), service = projection.services.filter(row => row.selected);
    if (!rendered.selectedVisible || !rendered.resourcesVisible || category.length !== 1 || service.length !== 1 ||
        rendered.categoryId !== category[0].id || rendered.serviceId !== service[0].id || clean(rendered.categoryLabel) !== category[0].label ||
        clean(rendered.serviceName) !== service[0].label || clean(rendered.serviceDescription) !== service[0].description ||
        !visibleText.includes(projection.venueAddress) || !visibleText.includes(category[0].label) || !visibleText.includes(service[0].label) ||
        !visibleText.includes(service[0].description)) throw new Error("MINDBODY_CATALOG_NOT_VISIBLE");
  }
  async function currentCatalog() {
    const selected = await settledSearch();
    if (!catalog || selected.doc !== catalogDocument || catalogSemanticKey(selected.projection) !== savedCatalogSemanticKey)
      throw new Error("MINDBODY_CATALOG_CHANGED");
    await assertRenderedCatalog(selected.projection);
    if (!current(selected.doc)) throw new Error("MINDBODY_CATALOG_CHANGED");
    return selected;
  }
  async function selectRadio(name: "optTG" | "optVT", value: string) {
    if (!/^[1-9]\d{0,9}$/u.test(value) || Number(value) > 2_147_483_647) throw new Error("MINDBODY_PUBLIC_CHOICE_AMBIGUOUS");
    const { doc } = await settledSearch();
    const control = page.locator('form[name="frmApptSearch"] input[type="radio"][name="' + name + '"]');
    const exact = control.locator('xpath=self::*[@value="' + value + '"]');
    if (await exact.count() !== 1 || !await exact.isEnabled()) throw new Error("MINDBODY_PUBLIC_CHOICE_AMBIGUOUS");
    if (await exact.isChecked()) return;
    if (!await exact.isVisible()) throw new Error("MINDBODY_PUBLIC_CHOICE_AMBIGUOUS");
    // FormData and token remain private in the controller. Only the exact
    // currently observed public form can mint this one-use read intent.
    const form = await evaluate("SEARCH_FORM", () => exact.evaluate((node, choice) => {
      const input = node as HTMLInputElement, form = input.form;
      if (!form || form.method.toLowerCase() !== "post" || form.enctype !== "application/x-www-form-urlencoded") throw new Error("MINDBODY_PUBLIC_FORM_REJECTED");
      const fields = new URLSearchParams(); for (const [key, value] of new FormData(form)) { if (typeof value !== "string") throw new Error("MINDBODY_PUBLIC_FORM_REJECTED"); fields.append(key, value); }
      fields.set(input.name, choice); return { targetUrl: form.action, body: fields.toString() };
    }, value));
    formIntent?.revoke();
    formIntent = createMindbodyPublicFormIntent({ sourceUrl: doc.url, ...form, studioId: descriptor!.studioId,
      deadlineAt: Math.min(options.deadlineAt, Date.now() + 15_000), sourceCurrent: () => current(doc) });
    try { await exact.click({ timeout: Math.max(1, Math.min(10_000, options.deadlineAt - Date.now())) });
      await wait(async () => nativeDocument && nativeDocument !== doc && current(nativeDocument) && !options.pendingReads() ? true : undefined, "MINDBODY_PUBLIC_FILTER_UNSETTLED");
    } finally { formIntent?.revoke(); formIntent = undefined; }
  }
  async function readCatalog(): Promise<MindbodyCatalogEvidence> {
    active(); if (catalogBusy || gridBusy) throw new Error("MINDBODY_CAPTURE_BUSY"); if (catalog) { await currentCatalog(); return structuredClone(catalog); }
    catalogBusy = true;
    try {
      const initial = await settledSearch(), categories = initial.projection.categories.filter(row => row.enabled &&
        /\b(?:simulator|bay)\b/iu.test(row.label) && !/lesson|coach|class|private|event|membership/iu.test(row.label));
      if (categories.length !== 1) throw new Error("MINDBODY_RENTAL_CATEGORY_AMBIGUOUS");
      await selectRadio("optTG", categories[0].id);
      const categoryPage = await settledSearch(), duration = options.requestedInput!.durationMinutes!;
      const services = categoryPage.projection.services.filter(row => {
        const match = /^.+?\s*-\s*(\d+(?:\/\d+)?)\s+(hour|minute)s?\s+session$/iu.exec(row.label);
        if (!row.enabled || !match) return false; const parts = match[1].split("/").map(Number);
        return (parts.length === 2 ? parts[0] / parts[1] : parts[0]) * (match[2].toLowerCase() === "hour" ? 60 : 1) === duration;
      });
      if (services.length !== 1) throw new Error("MINDBODY_RENTAL_SERVICE_AMBIGUOUS");
      await selectRadio("optVT", services[0].id);
      const completed = await settledSearch(), selected = completed.projection, category = selected.categories.filter(row => row.selected), service = selected.services.filter(row => row.selected);
      if (category.length !== 1 || service.length !== 1 || category[0].id !== categories[0].id || service[0].id !== services[0].id ||
          selected.studioId !== descriptor!.studioId) throw new Error("MINDBODY_CATALOG_SELECTION_UNPROVED");
      await assertRenderedCatalog(selected);
      if (!current(completed.doc)) throw new Error("MINDBODY_CATALOG_CHANGED");
      catalog = { captureId, url: page.url(), venueName: selected.title, venueAddress: selected.venueAddress, studioId: selected.studioId,
        locationId: selected.locationId, category: category[0] as MindbodyCatalogEvidence["category"], service: service[0] as MindbodyCatalogEvidence["service"],
        resources: selected.resources as MindbodyCatalogEvidence["resources"] };
      catalogDocument = completed.doc; savedCatalogSemanticKey = catalogSemanticKey(selected);
      return structuredClone(catalog);
    } finally { catalogBusy = false; }
  }
  return {
    beginDocument() { nativeDocument = undefined; documentStartedAt = Date.now(); return ++revision; },
    completeDocument(version: number, url: string, status: number, contentType: string, body: Buffer) {
      if (version !== revision || !options.native || !descriptor || new URL(url).origin !== "https://clients.mindbodyonline.com" ||
          status !== 200 || !/^text\/html(?:;|$)/iu.test(contentType) || body.length > 2_000_000) return;
      nativeDocument = { version, url, status, contentType, html: body.toString("utf8"), startedAt: documentStartedAt,
        ...(lastReadyTimeOrigin === undefined ? {} : { priorTimeOrigin: lastReadyTimeOrigin }) };
    },
    formIntent(sourceUrl: string, targetUrl: string) { return formIntent && formIntent.sourceUrl === sourceUrl && formIntent.targetUrl === targetUrl &&
      formIntent.sourceCurrent() ? formIntent : undefined; },
    assertNavigation(url: string, method: string) {
      if (!navigationPhase) return;
      const target = new URL(url);
      const browse = navigationPhase === "BROWSE" && method === "GET" && target.search === "?load=sched";
      const day = navigationPhase === "DAY" && method === "POST" && target.search === "" && formIntent?.active() && formIntent.targetUrl === url;
      if (target.origin !== "https://clients.mindbodyonline.com" || target.pathname !== "/ASP/main_appts.asp" || !browse && !day)
        throw new Error("MINDBODY_PUBLIC_NAVIGATION_REJECTED");
    },
    readCatalog,
    diagnostics(): CaptureDiagnostic { return { ...diagnostic, ...(diagnostic.catalogComparison ? {
      catalogComparison: { fieldsEqual: { ...diagnostic.catalogComparison.fieldsEqual }, rawCounts: { ...diagnostic.catalogComparison.rawCounts },
        renderedCounts: { ...diagnostic.catalogComparison.renderedCounts }, rawTextLengths: { ...diagnostic.catalogComparison.rawTextLengths },
        renderedTextLengths: { ...diagnostic.catalogComparison.renderedTextLengths } },
    } : {}) }; },
    async readGrid(): Promise<MindbodyGridEvidence> {
      active(); if (!catalog || catalogBusy || gridBusy) throw new Error("MINDBODY_CATALOG_REQUIRED"); gridBusy = true;
      try {
        await currentCatalog();
        const browse = await action("BROWSE_LOCATE", async () => {
          const locator = page.locator('form[name="frmApptSearch"] input[name="apptSchedBut"]'), count = await locator.count();
          diagnostic.browseCount = Math.min(count, 2); if (count !== 1) throw new Error("MINDBODY_PUBLIC_BROWSE_UNPROVED"); return locator;
        });
        await action("BROWSE_VALIDATE", async () => {
          diagnostic.browseVisible = await browse.isVisible(); diagnostic.browseEnabled = await browse.isEnabled();
          diagnostic.browseLabelMatches = /^Browse Appointment Schedule$/u.test(await browse.inputValue());
          diagnostic.browseTypeButton = await browse.getAttribute("type") === "button";
          if (!diagnostic.browseVisible || !diagnostic.browseEnabled || !diagnostic.browseLabelMatches || !diagnostic.browseTypeButton)
            throw new Error("MINDBODY_PUBLIC_BROWSE_UNPROVED");
        });
        // The observed enabled public Browse button is the action; only its
        // actual browser-issued fixed display GET is admitted at the boundary.
        navigationPhase = "BROWSE";
        await action("BROWSE_ACTION", () => browse.click({ timeout: Math.max(1, Math.min(10_000, options.deadlineAt - Date.now())) }));
        diagnostic.stage = "BROWSE_DONE";
        const read = async (expectedDate?: string) => {
          const doc = nativeDocument;
          diagnostic = { stage: "WAIT_GRID", elapsedMs: Math.max(0, Date.now() - documentStartedAt), nativeDocumentCurrent: !!doc && current(doc), pendingReads: options.pendingReads(),
            ...(doc ? { documentVersion: doc.version, rawBytes: Buffer.byteLength(doc.html), rawBodyClosed: /<\/body\s*>/iu.test(doc.html), rawHtmlClosed: /<\/html\s*>/iu.test(doc.html) } : {}) };
          if (!doc || !current(doc) || !isMindbodyPublicCalendarDocument(doc.url) || diagnostic.pendingReads) return;
          const state = await evaluate("GRID", () => page.evaluate(() => {
            const grid = { visible(node: Element) { if (!node.getClientRects().length) return false;
              for (let at: Element | null = node; at; at = at.parentElement) { const style = getComputedStyle(at);
                if (at.hasAttribute("hidden") || at.hasAttribute("inert") || at.getAttribute("aria-hidden") === "true" || style.display === "none" ||
                    ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false; } return true;
            }, rows(selector: string) { return Array.from(document.querySelectorAll<HTMLAnchorElement>(selector)).map(node => ({ href: node.getAttribute("href") ?? "", label: node.innerText, visible: this.visible(node) })); } };
            return { title: document.title, text: document.body?.innerText ?? "", anchors: grid.rows("a.apptLink"), resourceHeaders: grid.rows("a.instructorLink"),
              readyState: document.readyState, timeOrigin: performance.timeOrigin, html: document.documentElement?.outerHTML ?? "" };
          }));
          const finiteOrigin = Number.isFinite(state.timeOrigin) && state.timeOrigin > 0;
          diagnostic = { ...diagnostic, stage: "WAIT_GRID_RENDERED", nativeDocumentCurrent: current(doc), readyState: state.readyState,
            timeOriginFinite: finiteOrigin, ...(doc.priorTimeOrigin === undefined ? {} : { timeOriginChangedFromPrior: finiteOrigin && state.timeOrigin !== doc.priorTimeOrigin }),
            ...(doc.readyTimeOrigin === undefined ? {} : { timeOriginMatchesAccepted: finiteOrigin && state.timeOrigin === doc.readyTimeOrigin }),
            renderedBytes: Buffer.byteLength(state.html), renderedBodyClosed: /<\/body\s*>/iu.test(state.html), renderedHtmlClosed: /<\/html\s*>/iu.test(state.html) };
          if (!current(doc) || state.readyState !== "complete" || !finiteOrigin || doc.priorTimeOrigin !== undefined && state.timeOrigin === doc.priorTimeOrigin ||
              doc.readyTimeOrigin !== undefined && state.timeOrigin !== doc.readyTimeOrigin || !state.resourceHeaders.length || !diagnostic.renderedBodyClosed || !diagnostic.renderedHtmlClosed) return;
          diagnostic.stage = "RAW_GRID";
          if (!diagnostic.rawBodyClosed || !diagnostic.rawHtmlClosed) throw new Error("MINDBODY_GRID_DOCUMENT_INCOMPLETE");
          const date = gridCaptionDate(state.text), rawRoot = parse(doc.html); nodes(rawRoot);
          if (gridCaptionDate(clean(text(rawRoot))) !== date) throw new Error("MINDBODY_GRID_RAW_VISIBLE_MISMATCH");
          if (expectedDate && date !== expectedDate) return;
          doc.readyTimeOrigin = state.timeOrigin; lastReadyTimeOrigin = state.timeOrigin; diagnostic.stage = "GRID_READY";
          return { doc, state };
        };
        let value = await wait(() => read(), "MINDBODY_PUBLIC_GRID_UNAVAILABLE");
        navigationPhase = "DAY";
        const requestedDate = options.requestedInput!.date;
        for (let steps = 0; ; steps++) {
          const currentDate = gridCaptionDate(value.state.text);
          if (currentDate === requestedDate) break;
          if (steps >= 31) throw new Error("MINDBODY_GRID_DATE_LIMIT");
          const direction = currentDate < requestedDate ? "r" : "l", arrow = page.locator("td#day-arrow-" + direction);
          if (await arrow.count() !== 1 || !await arrow.isVisible() || !await evaluate("DAY_ARROW", () => arrow.evaluate(node => {
            if (node.tagName !== "TD" || !node.getClientRects().length) return false;
            for (let at: Element | null = node; at; at = at.parentElement) { const style = getComputedStyle(at);
              if (at.hasAttribute("hidden") || at.hasAttribute("inert") || at.getAttribute("aria-hidden") === "true" || style.display === "none" ||
                  ["hidden", "collapse"].includes(style.visibility) || Number(style.opacity) === 0) return false; } return true;
          }))) throw new Error("MINDBODY_PUBLIC_DAY_UNPROVED");
          const before = value.doc, step = direction === "r" ? 1 : -1, nextDate = adjacentMindbodyDay(currentDate, step);
          diagnostic.stage = "DAY_FORM";
          const rawForm = projectMindbodyDayForm(before.html, before.url);
          const renderedForm = await evaluate("DAY_FORM", () => page.evaluate(() => {
            const forms = document.querySelectorAll<HTMLFormElement>('form[name="search2"]');
            if (forms.length !== 1 || forms[0].method.toLowerCase() !== "post" || forms[0].enctype !== "application/x-www-form-urlencoded") throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
            const fields = new URLSearchParams(); for (const [key, value] of new FormData(forms[0])) { if (typeof value !== "string") throw new Error("MINDBODY_PUBLIC_DAY_REJECTED"); fields.append(key, value); }
            return { targetUrl: forms[0].action, body: fields.toString() };
          }));
          const canonicalBody = (body: string) => JSON.stringify([...new URLSearchParams(body)].sort(([a], [b]) => a.localeCompare(b)));
          if (!current(before) || rawForm.targetUrl !== renderedForm.targetUrl || canonicalBody(rawForm.body) !== canonicalBody(renderedForm.body) ||
              new URLSearchParams(renderedForm.body).get("txtDate") !== mindbodyCivilToDisplayedDate(currentDate)) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
          const fields = new URLSearchParams(renderedForm.body); fields.set("txtDate", mindbodyCivilToDisplayedDate(nextDate));
          formIntent?.revoke(); formIntent = createMindbodyPublicDayFormIntent({ sourceUrl: before.url, targetUrl: renderedForm.targetUrl, body: fields.toString(),
            currentDate, direction: step, deadlineAt: Math.min(options.deadlineAt, Date.now() + 15_000), sourceCurrent: () => current(before) });
          try { await action("DAY_ACTION", () => arrow.click({ timeout: Math.max(1, Math.min(10_000, options.deadlineAt - Date.now())) }));
            value = await wait(async () => { const next = await read(nextDate); return next && next.doc !== before ? next : undefined; }, "MINDBODY_GRID_DATE_UNSETTLED");
          } finally { formIntent?.revoke(); formIntent = undefined; }
        }
        const { doc, state } = value;
        return { captureId, url: doc.url, title: state.title, text: state.text, anchors: state.anchors, resourceHeaders: state.resourceHeaders,
          completion: { responseUrl: doc.url, status: doc.status, contentType: doc.contentType, rawHtml: doc.html, renderedHtml: state.html,
            bodyComplete: /<\/body\s*>/iu.test(doc.html) && /<\/html\s*>/iu.test(doc.html), documentUnchanged: current(doc),
            pendingRelevantRequests: options.pendingReads(), truncated: false, signedOut: true } };
      } finally { gridBusy = false; navigationPhase = undefined; }
    },
    close() { formIntent?.revoke(); formIntent = undefined; nativeDocument = undefined; catalog = undefined; catalogDocument = undefined;
      savedCatalogSemanticKey = undefined; navigationPhase = undefined; revision++; },
  };
}
