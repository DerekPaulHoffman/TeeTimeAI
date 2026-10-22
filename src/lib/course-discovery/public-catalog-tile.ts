import type { Locator } from "@playwright/test";

/** Source: published public Rex client app-UmUWLyNF.js, SHA256
 * 6a9da5d4031dea74d3eff8c0ecb42419aa45e2fbeebfe7d61d966948969504c6.
 * ARTICLE1469207 -> Os1449342 -> ln1482098 -> IC1076830 -> gA1070360
 * changes the selected catalog package via its anonymous read. Continue/lt is
 * a different transaction action and is never part of this interpreter.
 */
type CatalogItem = { id: string; name: string; eligible: boolean };
type CatalogContext = { revision: number; origin: string; items: CatalogItem[] };
export type PublicCatalogTileProof = { name: string; packageId: string; revision: number };
type DocumentWitness = { url: URL; ready: boolean; sequence: number; read?: {
  context: CatalogContext; date: string; venueName: string; packageId?: string; path: string;
} };
type ReadWitness = { document: DocumentWitness; sequence: number; url: URL; body: Record<string, unknown> };
const publicId = /^(?:[1-9]\d{0,9}|[a-fA-F0-9]{24}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/u;
const clean = (value: string) => value.replace(/\s+/gu, " ").trim();
function publicPackage(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && value.length <= 2048 &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.reservewithrex\.com$/u.test(url.hostname) && url.pathname === "/package" &&
      [...url.searchParams.keys()].every(key => ["venue", "date", "guests", "currentPackage"].includes(key)) ? url : undefined;
  } catch { return undefined; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/** Private transport observations only. Neither recipe nor model JSON can
 * initialize this scope. A new main document retires all prior catalog facts. */
export function createPublicCatalogTileScope() {
  let current: DocumentWitness | undefined, revision = 0;
  return {
    beginDocument(value: string) {
      const url = publicPackage(value);
      current = url ? { url, ready: false, sequence: 0 } : undefined;
      return current;
    },
    completeDocument(token: DocumentWitness | undefined, status: number, contentType: string) {
      if (!token || token !== current) return;
      token.ready = status === 200 && /^text\/html(?:;|$)/iu.test(contentType);
      if (!token.ready) token.read = undefined;
    },
    checkDocument(value: string) {
      const url = publicPackage(value);
      if (!url || url.origin !== current?.url.origin) current = undefined;
    },
    beginRead(value: string, method: string, body: string | null, frameUrl: string): ReadWitness | undefined {
      const frame = publicPackage(frameUrl);
      let url: URL;
      try { url = new URL(value); } catch { return undefined; }
      if (!current || !frame || frame.origin !== current.url.origin || url.origin !== frame.origin || method !== "POST" ||
          url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
          !["/api/venue/get", "/api/venue/get-venue-with-package"].includes(url.pathname)) return;
      current.read = undefined;
      const sequence = ++current.sequence;
      try {
        const input: unknown = JSON.parse(body ?? "");
        if (!record(input)) return;
        return { document: current, sequence, url, body: input };
      } catch { return undefined; }
    },
    completeRead(token: ReadWitness | undefined, status: number, contentType: string, bytes: Uint8Array) {
      if (!token || token.document !== current || !current.ready || token.sequence !== current.sequence || status !== 200 ||
          !/^application\/json(?:;|$)/iu.test(contentType) || bytes.byteLength > 600_000) return;
      try {
        const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
        if (!record(value) || typeof value.id !== "string" || value.id !== token.body.venueId || !publicId.test(value.id) ||
            typeof value.name !== "string" || !clean(value.name) || value.name.length > 160 ||
            typeof token.body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(token.body.date) ||
            !Array.isArray(value.packages) || !value.packages.length || value.packages.length > 100) return;
        const items: CatalogItem[] = [];
        for (const item of value.packages) {
          if (!record(item) || typeof item.id !== "string" || !publicId.test(item.id) || typeof item.name !== "string" ||
              !clean(item.name) || item.name.length > 160) return;
          items.push({ id: item.id, name: clean(item.name), eligible: item.contactOnly === false && item.isMemberOnlyPackage === false &&
            item.status === true && item.isHidden === false && item.numberOfLanes === 1 &&
            /\bgolf\b/iu.test(item.name) && /\b(?:simulator|bay)\b/iu.test(item.name) &&
            !/\b(?:lessons?|classes?|clinic|coaching|training|members?|membership|party|parties|tournament|events?|bowling|darts|tennis|baseball|batting|karaoke|venue|contact)\b/iu.test(item.name) });
        }
        if (new Set(items.map(item => item.name.toLowerCase())).size !== items.length || new Set(items.map(item => item.id)).size !== items.length) return;
        const packageId = token.body.packageId ?? token.body.targetPackage;
        if (packageId !== undefined && (typeof packageId !== "string" || !items.some(item => item.id === packageId))) return;
        current.read = { context: { revision: ++revision, origin: token.url.origin, items }, date: token.body.date,
          venueName: clean(value.name), ...(typeof packageId === "string" ? { packageId } : {}), path: token.url.pathname };
      } catch { /* Malformed or truncated public data grants no tile capability. */ }
    },
    context(value: string): CatalogContext | undefined {
      const url = publicPackage(value), read = current?.read;
      if (!url || !current?.ready || !read || url.origin !== current.url.origin ||
          url.searchParams.has("venue") && clean(url.searchParams.get("venue")!) !== read.venueName ||
          url.searchParams.has("date") && url.searchParams.get("date") !== read.date) return;
      return { ...read.context, items: read.context.items.map(item => ({ ...item })) };
    },
    selected(value: string, proof: PublicCatalogTileProof) {
      const url = publicPackage(value), context = this.context(value), read = current?.read;
      return !!url && !!context && !!read && context.revision > proof.revision &&
        read.path === "/api/venue/get-venue-with-package" && read.packageId === proof.packageId &&
        url.searchParams.get("currentPackage") === proof.name && context.items.some(item => item.eligible && item.id === proof.packageId && item.name === proof.name);
    },
  };
}
export type PublicCatalogTileScope = ReturnType<typeof createPublicCatalogTileScope>;

/** Self-contained DOM predicate, shared by discovery and deterministic replay.
 * An ARTICLE is not generically clickable: this exact public catalog shape and
 * fresh controller facts are both required, before every action. */
export function inspectPublicCatalogTileElement(element: Element, context: CatalogContext | undefined): PublicCatalogTileProof | undefined {
  if (!context || !(element instanceof HTMLElement) || element.tagName !== "ARTICLE" ||
      !element.classList.contains("package-card-v2") || !element.classList.contains("package-card-v2--package") ||
      !element.parentElement?.classList.contains("package-list-v2-gap") || element.closest("form,[hidden],[inert],[aria-hidden=true]") ||
      element.querySelector('input,select,textarea,[contenteditable],[role=combobox],article') || element.getAttribute("aria-disabled") === "true") return;
  let ancestor: HTMLElement | null = element;
  for (let depth = 0; ancestor && depth < 40; depth++, ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (ancestor.hasAttribute("hidden") || ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
    const label = `${ancestor.getAttribute("aria-label") ?? ""} ${ancestor.getAttribute("title") ?? ""}`;
    if (/\b(?:checkout|payment|purchase|contact|login|account|membership)\b/iu.test(label)) return;
  }
  const rect = element.getBoundingClientRect();
  if (ancestor || rect.width <= 0 || rect.height <= 0) return;
  const inside = element.querySelectorAll(':scope > .package-card-v2-inside[data-testid="package-cards"]');
  if (inside.length !== 1) return;
  const titles = inside[0].querySelectorAll(".package-card__title-v2");
  if (titles.length !== 1) return;
  const name = (titles[0].textContent ?? "").replace(/\s+/gu, " ").trim();
  const item = context.items.find(candidate => candidate.name === name && candidate.eligible);
  if (!item || Array.from(element.parentElement.querySelectorAll(".package-card__title-v2"))
    .filter(title => (title.textContent ?? "").replace(/\s+/gu, " ").trim() === name).length !== 1) return;
  const text = ((element as HTMLElement).innerText ?? element.textContent ?? "").replace(/\s+/gu, " ").trim();
  if (text.length > 2000 || !/\b(?:guests?|people)\b/iu.test(text) || !/\b(?:hours?|minutes?)\b/iu.test(text) ||
      /\b(?:lessons?|classes?|members?|membership|party|tournament|events?|checkout|purchase|payment|contact|continue|confirm|reserve)\b|\b\d{1,2}:\d{2}\b/iu.test(text)) return;
  for (const control of element.querySelectorAll("button,a,[role=button]")) {
    // The evidenced collapsed card has only an unlabeled SVG disclosure arrow.
    if (control.tagName !== "BUTTON" || control.getAttribute("aria-label") || control.getAttribute("title") ||
        (control.textContent ?? "").trim() || control.querySelectorAll("svg").length !== 1 || control.querySelector("input,select,textarea")) return;
  }
  return { name, packageId: item.id, revision: context.revision };
}

export async function inspectPublicCatalogTile(node: Locator, scope: PublicCatalogTileScope) {
  if (await node.count() !== 1) return;
  const context = scope.context(node.page().url());
  return node.evaluate(inspectPublicCatalogTileElement, context);
}

export async function openPublicCatalogTile(node: Locator, scope: PublicCatalogTileScope, expectedName?: string) {
  const proof = await inspectPublicCatalogTile(node, scope);
  if (!proof || scope.context(node.page().url())?.revision !== proof.revision || expectedName !== undefined && expectedName !== proof.name)
    throw new Error("UNVERIFIED_PUBLIC_CATALOG_TILE");
  await node.click();
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (scope.selected(node.page().url(), proof)) return proof;
    await node.page().waitForTimeout(50);
  }
  throw new Error("PUBLIC_CATALOG_SELECTION_UNCONFIRMED");
}
