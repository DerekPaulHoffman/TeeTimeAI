// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import selectedObserved from "./fixtures/mindbody-selected-rental-rows-observed.json";
import categoryObserved from "./fixtures/mindbody-public-category-form-observed.json";
import serviceObserved from "./fixtures/mindbody-public-service-form-observed.json";
import dayObserved from "./fixtures/mindbody-public-day-form-observed.json";
import { createMindbodyAppointmentNativeCapture, projectMindbodySearchCatalog } from "./mindbody-appointment-native-capture";
const source = observed.source, input = observed.input;
const url = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp?reSchedule=";
function searchHtml() { return '<html><head><title>OnPar Now</title></head><body><form name="frmApptSearch" method="post"><input type="hidden" name="optLoc" value="1">' +
  '<table><tr><td><input type="radio" name="optTG" value="2" checked><label>TrackMan Simulator</label></td></tr>' +
  '<tr><td><input type="radio" name="optVT" value="5" checked><span class="sessionTypeName">TrackMan Simulator - 1 hour session</span>' +
  '<span class="sessionTypeDescription">Bring 3 guests at no additional charge.</span></td></tr></table>' +
  '<select name="optTrnID"><option value="">All instructors</option><option value="100000001">1 Simulator</option><option value="100000002">2 Simulator</option></select>' +
  '<input type="button" name="apptSchedBut" value="Browse Appointment Schedule"></form>' +
  '<footer>OnPar Now - Site ID: 685163<br>1669 Smallman Street The Terminal Building, Pittsburgh PA 15222</footer></body></html>'; }
function load(html: string) { document.open(); document.write(html); document.close(); }
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
function dayHtml(date: string) {
  const display = Number(date.slice(5, 7)) + "/" + Number(date.slice(8)) + "/" + date.slice(0, 4);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(date + "T12:00:00Z"));
  const form = '<form name="search2" action="' + dayObserved.targetUrl + '" method="post">' + dayObserved.fields.map(row =>
    '<input type="' + (row.name === "txtDate" ? "text" : "hidden") + '" name="' + row.name + '" value="' + escape(row.name === "txtDate" ? display : row.value) + '">').join("") + '</form>';
  return '<html><head><title>OnPar Now</title></head><body>' + weekday + " " + display +
    '<table><tr><td id="day-arrow-r">&gt;</td><td id="day-arrow-l">&lt;</td></tr>' + observed.gridObserved.resourceHeaders.map(row =>
      '<tr><th><a class="instructorLink" href="' + escape(row.href) + '">' + row.label + '</a></th></tr>').join("") +
    '<tr><td><a class="apptLink" href="' + escape(observed.gridObserved.anchors[0].href) + '">TrackMan Simulator</a></td></tr></table>' + form + '</body></html>';
}
function fixture() {
  let currentUrl = url, pending = 0, active = true, click: ((selector: string) => void) | undefined;
  let readyState = "complete", timeOrigin = 1_700_000_000_000, renderedOverride: string | undefined, wait: (() => void) | undefined;
  const locator = (selector: string) => {
    const find = () => Array.from(document.querySelectorAll(selector));
    const api = { count: async () => find().length, isEnabled: async () => !(find()[0] as HTMLInputElement)?.disabled,
      isChecked: async () => (find()[0] as HTMLInputElement)?.checked, isVisible: async () => true,
      inputValue: async () => (find()[0] as HTMLInputElement)?.value,
      getAttribute: async (name: string) => find()[0]?.getAttribute(name), filter: () => api,
      locator: (xpath: string) => { const value = /@value="([^"]+)"/u.exec(xpath)?.[1]; return locator(selector + '[value="' + value + '"]'); },
      click: vi.fn(async () => { click?.(selector); }), evaluate: async (fn: (node: Element, arg: string) => unknown, arg: string) => fn(find()[0], arg) };
    return api;
  };
  const page = { url: () => currentUrl, content: async () => document.documentElement.outerHTML,
    // Playwright serializes controller functions into a separate browser realm;
    // execute the same function text in this test DOM, without module closures.
    evaluate: async (fn: () => unknown) => { const result = Function("return (" + fn.toString() + ")")()();
      // The fake realm controls navigation readiness independently from native
      // response publication, as Chrome does during a same-URL form navigation.
      return result && typeof result === "object" && "timeOrigin" in result ?
        { ...result, timeOrigin, ...("readyState" in result ? { readyState, html: renderedOverride ?? result.html } : {}) } : result;
    }, locator, waitForTimeout: async () => { if (wait) wait(); else throw new Error("FAKE_WAIT_NOT_READY"); } } as unknown as Page;
  const capture = createMindbodyAppointmentNativeCapture({ page, source, requestedInput: input, native: true, deadlineAt: Date.now() + 20_000,
    pendingReads: () => pending, assertActive: () => { if (!active) throw new Error("BROWSER_CLOSED"); } });
  const complete = (version = capture.beginDocument(), html = searchHtml(), status = 200) => {
    capture.completeDocument(version, currentUrl, status, "text/html", Buffer.from(html)); timeOrigin++; return version;
  };
  return { capture, complete, page, onClick: (fn: (selector: string) => void) => { click = fn; },
    ready: (value: string) => { readyState = value; }, origin: (value: number) => { timeOrigin = value; }, currentOrigin: () => timeOrigin,
    rendered: (value: string | undefined) => { renderedOverride = value; }, onWait: (fn: () => void) => { wait = fn; },
    currentUrl: (value: string) => { currentUrl = value; }, pending: (value: number) => { pending = value; }, close: () => { active = false; capture.close(); } };
}
let originalInnerText: PropertyDescriptor | undefined;
beforeEach(() => {
  load(searchHtml());
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ width: 1, height: 1 }] as unknown as DOMRectList);
  const original = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (node: Element) => { const value = original(node); return new Proxy(value, { get: (style, key) => key === "opacity" ? style.opacity || "1" : Reflect.get(style, key) }); });
  originalInnerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent; } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, "elementFromPoint");
  if (originalInnerText) Object.defineProperty(HTMLElement.prototype, "innerText", originalInnerText); else Reflect.deleteProperty(HTMLElement.prototype, "innerText"); });
describe("native Mindbody private capture currency and rendered proof", () => {
  it.each(["overlay", "button", "no hit"])("passively captures bounded public pointer identity: %s", async mode => {
    const f = fixture(); f.complete(); await f.capture.readCatalog();
    const overlay = document.createElement("div"); overlay.id = "loadingOverlay";
    overlay.className = "loading-mask CSRFToken SECRET_PRIVATE_VALUE_TOO_LONG_" + "x".repeat(80);
    overlay.textContent = "PRIVATE_TEXT"; overlay.setAttribute("data-token", "PRIVATE_TOKEN");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 10, top: 10, width: 40, height: 20 } as DOMRect);
    const button = document.querySelector('input[name="apptSchedBut"]');
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => mode === "overlay" ? overlay : mode === "button" ? button : null) });
    f.onClick(() => { document.body.append(overlay); throw new Error("Timeout overlay intercepts pointer events PRIVATE_PAYLOAD"); });
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_BROWSE_POINTER_INTERCEPTED");
    const d = f.capture.diagnostics(); expect(d).toMatchObject({ stage: "BROWSE_ACTION", actionFailure: "POINTER_INTERCEPTED", pointerProbe: "CAPTURED",
      pointerDocumentCurrent: true, pointerButtonCount: 1, pointerCenterInViewport: true, pointerHitInsideButton: mode === "button" });
    if (mode === "overlay") expect(d.pointerHit).toEqual({ tag: "div", id: "loadingOverlay", classes: ["loading-mask"], identifiersOmitted: true });
    if (mode === "no hit") expect(d.pointerHit).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE_TEXT|PRIVATE_TOKEN|PRIVATE_PAYLOAD|CSRFToken|SECRET_PRIVATE/u); f.close();
  });
  it.each(["changed", "probe failed", "deadline"])("preserves primary pointer failure when passive probe is %s", async mode => {
    const f = fixture(); f.complete(); await f.capture.readCatalog();
    const original = f.page.evaluate.bind(f.page), originalNow = Date.now();
    f.page.evaluate = (async (fn: () => unknown) => { if (fn.toString().includes("elementFromPoint")) throw new Error("PRIVATE_PROBE_ERROR"); return original(fn); }) as typeof f.page.evaluate;
    f.onClick(() => { if (mode === "changed") f.capture.beginDocument(); if (mode === "deadline") vi.spyOn(Date, "now").mockReturnValue(originalNow + 30_000);
      throw new Error("overlay intercepts pointer events PRIVATE_PAYLOAD"); });
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_BROWSE_POINTER_INTERCEPTED");
    expect(f.capture.diagnostics()).toMatchObject({ stage: "BROWSE_ACTION", actionFailure: "POINTER_INTERCEPTED",
      pointerProbe: mode === "changed" ? "DOCUMENT_CHANGED" : mode === "deadline" ? "DEADLINE" : "UNAVAILABLE" });
    expect(JSON.stringify(f.capture.diagnostics())).not.toContain("PRIVATE_"); f.close();
  });
  it.each([
    ["Timeout 10000ms exceeded: overlay intercepts pointer events PRIVATE_PAYLOAD", "POINTER_INTERCEPTED", true],
    ["Timeout 10000ms exceeded: element is not stable PRIVATE_PAYLOAD", "NOT_STABLE", true],
    ["Element is not attached to the DOM PRIVATE_PAYLOAD", "DETACHED", false],
    ["Execution context was destroyed PRIVATE_PAYLOAD", "DOCUMENT_CHANGED", false],
    ["Timeout 10000ms exceeded PRIVATE_PAYLOAD", "TIMEOUT", true],
    ["page.goto: net::ERR_ABORTED PRIVATE_PAYLOAD", "NAVIGATION_FAILED", false],
    ["unexpected browser payload PRIVATE_PAYLOAD", "OTHER", false],
  ])("reports closed Browse action failure without raw Playwright details: %s", async (message, failure, timedOut) => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); f.onClick(() => { throw new Error(message); });
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_BROWSE_" + (failure === "OTHER" ? "ACTION_FAILED" : failure));
    const diagnostic = f.capture.diagnostics(); expect(diagnostic).toMatchObject({ stage: "BROWSE_ACTION", actionStage: "BROWSE_ACTION", actionFailure: failure,
      actionTimedOut: timedOut, browseCount: 1, browseVisible: true, browseEnabled: true, browseLabelMatches: true, browseTypeButton: true });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_PAYLOAD"); f.close();
  });
  it.each(["duplicate", "validation timeout"])("distinguishes Browse locator/validation failure: %s", async mode => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); const original = f.page.locator.bind(f.page);
    f.page.locator = ((selector: string) => { const locator = original(selector);
      if (selector.includes("apptSchedBut")) { if (mode === "duplicate") locator.count = async () => 2;
        else locator.inputValue = async () => { throw new Error("Timeout PRIVATE_PAYLOAD"); }; } return locator; }) as typeof f.page.locator;
    await expect(f.capture.readGrid()).rejects.toThrow(mode === "duplicate" ? "MINDBODY_PUBLIC_BROWSE_UNPROVED" : "MINDBODY_BROWSE_TIMEOUT");
    expect(f.capture.diagnostics()).toMatchObject({ stage: mode === "duplicate" ? "BROWSE_LOCATE" : "BROWSE_VALIDATE", actionFailure: mode === "duplicate" ? "CONTRACT" : "TIMEOUT" }); f.close();
  });
  it("classifies DAY click failure and revokes its prepared private intent", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog();
    f.onClick(selector => { if (selector.includes("apptSchedBut")) { f.currentUrl(dayObserved.sourceUrl); const html = dayHtml("2026-10-23"); load(html); f.complete(undefined, html); }
      else throw new Error("element was detached PRIVATE_PAYLOAD"); });
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_DAY_DETACHED");
    expect(f.capture.diagnostics()).toMatchObject({ stage: "DAY_ACTION", actionFailure: "DETACHED" });
    expect(f.capture.formIntent(dayObserved.sourceUrl, dayObserved.targetUrl)).toBeUndefined(); f.close();
  });
  it.each([
    ["page.evaluate: ReferenceError: __name is not defined SYNTHETIC_PRIVATE_VALUE", "MINDBODY_BROWSER_SERIALIZATION_FAILED", "SERIALIZATION"],
    ["page.evaluate: Execution context was destroyed SYNTHETIC_PRIVATE_VALUE", "MINDBODY_BROWSER_DOCUMENT_CHANGED", "DOCUMENT_CHANGED"],
    ["page.evaluate: untrusted unexpected SYNTHETIC_PRIVATE_VALUE", "MINDBODY_BROWSER_EVALUATION_FAILED", "OTHER"],
  ])("classifies browser evaluation failure without returning error text: %s", async (message, code, failure) => {
    const f = fixture(); f.complete(); const original = f.page.evaluate.bind(f.page);
    f.page.evaluate = (async (fn: () => unknown) => { if (fn.toString().includes("sessionTypeDescription")) throw new Error(message); return original(fn); }) as typeof f.page.evaluate;
    await expect(f.capture.readCatalog()).rejects.toThrow(code);
    expect(f.capture.diagnostics()).toMatchObject({ evaluationStage: "CATALOG_VISIBILITY", evaluationFailure: failure });
    expect(JSON.stringify(f.capture.diagnostics())).not.toContain("SYNTHETIC_PRIVATE_VALUE"); f.close();
  });
  it("accepts actual hidden checked radios only through visible bound category/service rows", async () => {
    const html = searchHtml().replace(/<table>[\s\S]*?<\/table>/u, "<table>" + selectedObserved.rows.map(row => row.rowHtml).join("") + "</table>");
    load(html); const f = fixture(); f.complete(undefined, html); const value = await f.capture.readCatalog();
    expect(value.category.id).toBe("2"); expect(value.service.id).toBe("5"); expect(value.service.description).toContain("Bring 3 guests"); f.close();
  });
  it.each(["hidden category label", "hidden service description", "wrong label association", "unchecked selection"])("rejects observed selected-row %s", async mode => {
    const html = searchHtml().replace(/<table>[\s\S]*?<\/table>/u, "<table>" + selectedObserved.rows.map(row => row.rowHtml).join("") + "</table>"); load(html);
    if (mode === "hidden category label") (document.querySelector("label") as HTMLElement).style.opacity = "0";
    if (mode === "hidden service description") (document.querySelector(".sessionTypeDescription") as HTMLElement).style.display = "none";
    if (mode === "wrong label association") document.querySelector("label")!.setAttribute("for", "other-input");
    if (mode === "unchecked selection") (document.querySelector('[name="optVT"]') as HTMLInputElement).checked = false;
    const f = fixture(); f.complete(undefined, document.documentElement.outerHTML);
    if (mode === "unchecked selection") await expect(f.capture.readCatalog()).rejects.toThrow();
    else await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_NOT_VISIBLE"); f.close();
  });
  it.each([false, true])("exercises actual19-field category and30-field service transitions with unrelated body text delta: %s", async withTextDelta => {
    const footer = '<footer>OnPar Now - Site ID: 685163<br>1669 Smallman Street The Terminal Building, Pittsburgh PA 15222</footer>';
    const wrap = (body: string) => '<html><head><title>OnPar Now</title></head><body>' + body + footer + '</body></html>';
    const categoryHtml = wrap('<form name="frmApptSearch" action="' + url + '" method="post">' + categoryObserved.fields.filter(row => row.name !== "optTG").map(row =>
      '<input type="hidden" name="' + row.name + '" value="' + escape(row.value) + '">').join("") + '<table>' +
      [["2", "TrackMan Simulator"], ["4", "PuttView Putting Green"], ["5", "Sand Trap/Chipping Area"]].map(([id, label]) =>
        '<tr><td><input type="radio" name="optTG" value="' + id + '"><label>' + label + '</label></td></tr>').join("") + '</table></form>');
    const serviceHtml = (selected: boolean) => wrap('<form name="frmApptSearch" action="' + url + '" method="post">' + serviceObserved.fields.filter(row => !["optTG", "optVT", "optTrnID"].includes(row.name)).map(row =>
      '<input type="' + (/^optDay/u.test(row.name) ? "checkbox" : "hidden") + '" name="' + row.name + '" value="' + escape(row.value) + '"' + (/^optDay/u.test(row.name) ? " checked" : "") + '>').join("") +
      '<table>' + selectedObserved.rows[0].rowHtml + (selected ? selectedObserved.rows[1].rowHtml : '<tr><td><input type="radio" name="optVT" value="" checked></td></tr>' +
        selectedObserved.rows[1].rowHtml.replace(/checked=""/u, "").replace(/style="[^"]*"/u, "")) + '</table>' +
      '<select name="optTrnID"><option value="">All instructors</option><option value="100000001">1 Simulator</option><option value="100000002">2 Simulator</option></select></form>');
    const addUnrelatedText = () => { if (withTextDelta) { const span = document.createElement("span"); span.textContent = "Public display message update"; document.querySelector("footer")!.before(span); } };
    load(categoryHtml); addUnrelatedText(); const f = fixture(); f.currentUrl(categoryObserved.sourceUrl); f.complete(undefined, categoryHtml); const shapes: number[] = [];
    const comparisons: NonNullable<ReturnType<typeof f.capture.diagnostics>["catalogComparison"]>[] = [];
    f.onClick(selector => {
      comparisons.push(f.capture.diagnostics().catalogComparison!);
      const node = document.querySelector(selector) as HTMLInputElement; node.checked = true;
      const fields = new URLSearchParams(); for (const [key, value] of new FormData(node.form!)) fields.append(key, String(value));
      const intent = f.capture.formIntent(f.page.url(), url)!; expect(intent).toBeDefined(); expect(intent.matches(fields.toString(), "application/x-www-form-urlencoded")).toBe(true); expect(intent.consume()).toBe(true);
      shapes.push([...fields].length); const next = serviceHtml(node.name === "optVT"), prior = f.currentOrigin(); f.currentUrl(url); f.complete(undefined, next); const nextOrigin = f.currentOrigin();
      f.ready("loading"); f.origin(prior); f.onWait(() => { load(next); addUnrelatedText(); f.ready("complete"); f.origin(nextOrigin); });
    });
    const value = await f.capture.readCatalog(); expect(shapes).toEqual([19, 30]); expect(value.service.id).toBe("5"); expect(value.category.id).toBe("2");
    if (withTextDelta) {
      expect(comparisons[0]).toMatchObject({ fieldsEqual: { title: true, bodyText: false, locationId: true, studioId: true, venueAddress: true,
        categories: true, services: true, resources: true }, rawCounts: { categories: 3, services: 0, resources: 0 }, renderedCounts: { categories: 3, services: 0, resources: 0 } });
      expect(comparisons[0].renderedTextLengths.bodyText - comparisons[0].rawTextLengths.bodyText).toBe(30);
      // Cached reads must use the same semantic key while retaining the exact
      // native document, selected visibility and time-origin checks.
      expect(await f.capture.readCatalog()).toEqual(value);
      const nextNotice = document.createElement("span"); nextNotice.textContent = "Another public display notice"; document.querySelector("footer")!.before(nextNotice);
      expect(await f.capture.readCatalog()).toEqual(value);
    }
    f.close();
  });
  it("waits for loading/interactive render transitions before projecting the new native catalog", async () => {
    const f = fixture(); f.complete(); f.ready("loading"); f.rendered("<html><head></head>"); let waits = 0;
    f.onWait(() => { waits++; f.ready(waits === 1 ? "interactive" : "complete"); if (waits === 2) f.rendered(undefined); });
    expect((await f.capture.readCatalog()).service.id).toBe("5"); expect(waits).toBe(2);
    expect(f.capture.diagnostics()).toMatchObject({ stage: "CATALOG_READY", readyState: "complete", nativeDocumentCurrent: true, timeOriginFinite: true }); f.close();
  });
  it("waits for a new timeOrigin when same-URL native response precedes DOM commitment", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); const prior = f.currentOrigin(); f.complete(); f.origin(prior);
    let waits = 0; f.onWait(() => { waits++; expect(f.capture.diagnostics()).toMatchObject({ stage: "WAIT_RENDERED", timeOriginChangedFromPrior: false }); f.origin(prior + 1); });
    await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_CHANGED"); expect(waits).toBe(1);
    expect(f.capture.diagnostics()).toMatchObject({ stage: "CATALOG_READY", timeOriginChangedFromPrior: true }); f.close();
  });
  it("waits through transient rendered end tags but keeps missing native raw end tags a distinct failure", async () => {
    const f = fixture(); f.complete(); f.rendered("<html><body>transient"); let waits = 0;
    f.onWait(() => { waits++; expect(f.capture.diagnostics()).toMatchObject({ stage: "WAIT_RENDERED", rawHtmlClosed: true, renderedHtmlClosed: false }); f.rendered(undefined); });
    await f.capture.readCatalog(); expect(waits).toBe(1); f.close();
    const bad = fixture(); bad.complete(undefined, searchHtml().replace("</body></html>", ""));
    await expect(bad.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_RAW_DOCUMENT_INCOMPLETE");
    expect(bad.capture.diagnostics()).toMatchObject({ stage: "RAW_CATALOG", rawBodyClosed: false, rawHtmlClosed: false, renderedHtmlClosed: true, readyState: "complete" }); bad.close();
  });
  it("bounds a rendered settle timeout and emits only closed numeric/boolean/state facts", async () => {
    const f = fixture(); f.complete(); f.ready("interactive"); const start = Date.now(); let clock: ReturnType<typeof vi.spyOn> | undefined;
    f.onWait(() => { clock = vi.spyOn(Date, "now").mockReturnValue(start + 13_000); });
    try {
      await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_UNAVAILABLE");
      const diagnostic = f.capture.diagnostics(); expect(diagnostic).toMatchObject({ stage: "WAIT_RENDERED", readyState: "interactive", timeOriginFinite: true });
      expect(Object.values(diagnostic).every(value => typeof value === "boolean" || typeof value === "number" || ["WAIT_RENDERED", "interactive"].includes(value as string))).toBe(true);
      expect(JSON.stringify(diagnostic)).not.toMatch(/CSRF|OnPar|Smallman|"rawHtml"|"renderedHtml"|token|url|content/iu);
    } finally { clock?.mockRestore(); f.close(); }
  });
  it("projects actual protocol names with generic public labels, never provider tokens", () => {
    const value = projectMindbodySearchCatalog(searchHtml()); expect(value.services[0]).toMatchObject({ id: "5", selected: true, enabled: true });
    expect(value.categories).toHaveLength(1); expect(value.resources).toHaveLength(2); expect(value.studioId).toBe("685163");
    expect(JSON.stringify(value)).not.toMatch(/csrf|cookie|password/iu);
  });
  it("accepts a completed current native selected catalog and binds its ephemeral capture", async () => {
    const f = fixture(); f.complete(); const catalog = await f.capture.readCatalog();
    expect(catalog).toMatchObject({ studioId: "685163", category: { id: "2", selected: true }, service: { id: "5", selected: true } });
    expect(catalog.captureId).toMatch(/^[a-f0-9-]+$/u); f.close();
  });
  it("rejects stale same-URL document completion and pending reads", async () => {
    const f = fixture(), old = f.capture.beginDocument(); f.capture.beginDocument(); f.complete(old);
    await expect(f.capture.readCatalog()).rejects.toThrow("FAKE_WAIT_NOT_READY");
    f.complete(); f.pending(1); await expect(f.capture.readCatalog()).rejects.toThrow("FAKE_WAIT_NOT_READY"); f.close();
  });
  it("rejects raw/rendered divergence and failed native response", async () => {
    const f = fixture(); f.complete(undefined, searchHtml().replace('value="5" checked', 'value="6" checked'));
    await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH");
    const other = fixture(); other.complete(undefined, searchHtml(), 403);
    await expect(other.capture.readCatalog()).rejects.toThrow("FAKE_WAIT_NOT_READY"); f.close(); other.close();
  });
  it.each([
    ["title", "<title>OnPar Now</title>", "<title>PRIVATE_DIAGNOSTIC_SENTINEL</title>"],
    ["locationId", 'name="optLoc" value="1"', 'name="optLoc" value="99"'],
    ["studioId", "Site ID: 685163", "Site ID: 685164"],
    ["venueAddress", "Pittsburgh PA 15222", "PRIVATE_DIAGNOSTIC_SENTINEL"],
    ["categories", 'name="optTG" value="2"', 'name="optTG" value="3"'],
    ["services", 'name="optVT" value="5"', 'name="optVT" value="6"'],
    ["resources", 'value="100000001"', 'value="100000003"'],
  ] as const)("identifies %s divergence without retaining projection values", async (field, from, to) => {
    const f = fixture(); f.complete(undefined, searchHtml().replace(from, to));
    await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH");
    const diagnostic = f.capture.diagnostics();
    expect(diagnostic).toMatchObject({ stage: "COMPARE_CATALOG", catalogComparison: { fieldsEqual: { [field]: false },
      rawCounts: { categories: 1, services: 1, resources: 2 }, renderedCounts: { categories: 1, services: 1, resources: 2 } } });
    expect(Object.keys(diagnostic.catalogComparison!.fieldsEqual).sort()).toEqual(
      ["title", "bodyText", "locationId", "studioId", "venueAddress", "categories", "services", "resources"].sort());
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toMatch(/PRIVATE_DIAGNOSTIC_SENTINEL|685163|Pittsburgh|TrackMan|https?:|100000001/u);
    for (const lengths of [diagnostic.catalogComparison!.rawTextLengths, diagnostic.catalogComparison!.renderedTextLengths])
      for (const length of Object.values(lengths)) expect(Number.isSafeInteger(length) && length >= 0 && length <= 2_000_000).toBe(true);
    f.close();
  });
  it("records whole-text-only divergence without rejecting an otherwise identical catalog", async () => {
    const html = searchHtml().replace("<footer>", "<p>6:05:14 pm</p><footer>"); load(html);
    const f = fixture(); f.complete(undefined, html.replace("6:05:14 pm", "6:05:15 pm"));
    expect((await f.capture.readCatalog()).service.id).toBe("5");
    const comparison = f.capture.diagnostics().catalogComparison!;
    expect(Object.entries(comparison.fieldsEqual).filter(([, equal]) => !equal).map(([field]) => field)).toEqual(["bodyText"]);
    expect(comparison.rawTextLengths).toEqual(comparison.renderedTextLengths); f.close();
  });
  it("isolates diagnostic copies and clears old comparison facts before a new unsettled document", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog();
    const comparison = f.capture.diagnostics().catalogComparison!;
    comparison.fieldsEqual.services = false; comparison.rawCounts.services = 999; comparison.renderedCounts.categories = 999;
    comparison.rawTextLengths.title = 999; comparison.renderedTextLengths.title = 999;
    expect(f.capture.diagnostics().catalogComparison).toMatchObject({ fieldsEqual: { services: true }, rawCounts: { services: 1 }, renderedCounts: { categories: 1 },
      rawTextLengths: { title: 9 }, renderedTextLengths: { title: 9 } });
    f.complete(); f.pending(1); await expect(f.capture.readCatalog()).rejects.toThrow("FAKE_WAIT_NOT_READY");
    expect(f.capture.diagnostics().catalogComparison).toBeUndefined(); f.close();
  });
  it.each(["opacity", "visibility", "display", "hidden", "inert"])("refuses catalog evidence under an ancestor with %s", async kind => {
    const f = fixture(); const parent = document.createElement("div"); document.body.append(parent); parent.append(document.querySelector("form")!);
    if (kind === "opacity") parent.style.opacity = "0"; if (kind === "visibility") parent.style.visibility = "hidden";
    if (kind === "display") parent.style.display = "none"; if (kind === "hidden" || kind === "inert") parent.setAttribute(kind, "");
    f.complete(undefined, document.documentElement.outerHTML); await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_NOT_VISIBLE"); f.close();
  });
  it("rechecks exact catalog document before cached reads and before Browse", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); f.complete();
    await expect(f.capture.readCatalog()).rejects.toThrow("MINDBODY_CATALOG_CHANGED");
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_CATALOG_CHANGED"); f.close();
  });
  it("rejects changed selected service state and closed captures", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); (document.querySelector('[name="optVT"]') as HTMLInputElement).checked = false;
    await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_CATALOG_NOT_VISIBLE"); f.close();
    await expect(f.capture.readCatalog()).rejects.toThrow("BROWSER_CLOSED");
  });
  it.each(["visible", "opacity", "wrong day"])("reads native grid visibility and rejects missing observed day form: %s", async mode => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); const clicks: string[] = [];
    f.onClick(selector => {
      clicks.push(selector); const gridUrl = "https://clients.mindbodyonline.com/ASP/main_appts.asp?load=sched";
      f.capture.assertNavigation(gridUrl, "GET"); f.currentUrl(gridUrl);
      const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
      const html = '<html><head><title>OnPar Now</title></head><body>' + (mode === "wrong day" ? "Friday 10/23/2026 " : "Saturday 10/24/2026 ") +
        '<table><tr><td id="day-arrow-r" onclick="unreviewedHandler()">&gt;</td></tr></table><div' + (mode === "opacity" ? ' style="opacity:0"' : '') +
        '><table><tr>' + observed.gridObserved.resourceHeaders.map(row => '<th><a class="instructorLink" href="' + escape(row.href) + '">' + row.label + '</a></th>').join("") +
        '</tr><tr><td><a class="apptLink" href="' + escape(observed.gridObserved.anchors[0].href) + '">TrackMan Simulator</a></td></tr></table></div></body></html>';
      load(html); f.complete(undefined, html);
    });
    if (mode === "wrong day") await expect(f.capture.readGrid()).rejects.toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
    else { const grid = await f.capture.readGrid(); expect(grid.anchors[0].visible).toBe(mode === "visible"); expect(grid.resourceHeaders[0].visible).toBe(mode === "visible"); }
    expect(clicks).toHaveLength(1); expect(clicks[0]).toContain("apptSchedBut"); f.close();
  });
  it("reads only the exact adjacent DAY POST and waits for the new same-URL DOM before returning", async () => {
    const f = fixture(); f.complete(); await f.capture.readCatalog(); const clicks: string[] = [];
    f.onClick(selector => {
      clicks.push(selector);
      if (selector.includes("apptSchedBut")) { f.capture.assertNavigation(dayObserved.sourceUrl, "GET"); f.currentUrl(dayObserved.sourceUrl); const html = dayHtml("2026-10-23"); load(html); f.complete(undefined, html); }
      else {
        const intent = f.capture.formIntent(dayObserved.sourceUrl, dayObserved.targetUrl)!; expect(intent).toBeDefined();
        const fields = new URLSearchParams(dayObserved.fields.map(row => [row.name, row.value])); fields.set("txtDate", "10/24/2026");
        expect(intent.matches(fields.toString(), "application/x-www-form-urlencoded")).toBe(true); expect(intent.consume()).toBe(true);
        f.capture.assertNavigation(dayObserved.targetUrl, "POST"); const prior = f.currentOrigin(), next = dayHtml("2026-10-24"); f.currentUrl(dayObserved.targetUrl); f.complete(undefined, next);
        const committedOrigin = f.currentOrigin(); f.origin(prior); f.onWait(() => { expect(clicks).toHaveLength(2); load(next); f.origin(committedOrigin); });
      }
    });
    const grid = await f.capture.readGrid(); expect(grid.text).toContain("Saturday 10/24/2026"); expect(grid.completion?.documentUnchanged).toBe(true);
    expect(grid.url).toBe(dayObserved.targetUrl); expect(clicks).toHaveLength(2); f.close();
  });
});
