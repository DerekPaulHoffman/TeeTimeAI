// @vitest-environment node
import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { collectPublicRootWidget, pairedNativeRootWidget, type NativeRootWidgetCapture } from "./public-root-widget";

const days = '<div role="row">' + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => '<span role="columnheader">' + day + '</span>').join("") + '</div>' +
  Array.from({ length: 14 }, (_, i) => '<button type="button" role="gridcell">' + (i + 1) + '</button>').join("");
const calendar = '<main><h1>Public golf availability</h1><div role="grid">' + days + '</div></main>';
const filters = '<main><h1>Public rentals</h1><label>Date<input type="date"></label><label>Duration<select><option>One hour</option></select></label></main>';
const serviceCard = (hours: number) => `<div><div><h4>${hours} Hour Public Golf</h4></div><p>${hours} hr</p><div><button type="button">BOOK</button></div></div>`;
const services = '<div><h3>Regular Booking</h3>' + [1, 2, 3].map(serviceCard).join("") + '</div>';
const compoundServices = '<div><h3>Public golf booking</h3>' + [1, 2, 3].map(hours =>
  `<div><h4>${hours} Hour Public Practice</h4><p>${hours === 1 ? '1 hr' : `${hours - 1} hr 55 mins`}</p><p>Bring people in your party. Five minutes allows sanitation and reset.</p><span role="button" aria-haspopup="menu"><span role="button" aria-haspopup="menu">More</span></span><div><button type="button">BOOK</button></div></div>`).join('') + '</div>';
const responsiveDisclosures = '<span role="button" aria-haspopup="menu">More</span><span role="button" aria-haspopup="menu" style="display:none">More</span>';
const responsiveServices = compoundServices.replaceAll('<span role="button" aria-haspopup="menu"><span role="button" aria-haspopup="menu">More</span></span>', responsiveDisclosures);
function collect(html: string) {
  const dom = new JSDOM('<style>* { opacity: 1 }</style>' + html, { url: "https://ordinary.example.org/", runScripts: "outside-only" });
  try {
    Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { value: () => ({ width: 100, height: 20 }) });
    for (const prototype of [dom.window.HTMLInputElement.prototype, dom.window.HTMLSelectElement.prototype])
      Object.defineProperty(prototype, "value", { get() { throw Error("INPUT_VALUE_MUST_NOT_BE_READ"); } });
    Object.defineProperty(dom.window.HTMLSelectElement.prototype, "selectedOptions", { get() { throw Error("SELECTION_MUST_NOT_BE_READ"); } });
    return dom.window.eval('(' + collectPublicRootWidget.toString() + ')()') as ReturnType<typeof collectPublicRootWidget>;
  } finally { dom.window.close(); }
}
describe("public root widget routing presence", () => {
  it("recognizes one visible passive disclosure with a computed-hidden responsive sibling without an action grant", () => {
    for (const attribute of ['style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"', 'hidden', 'inert'])
      expect(collect(responsiveServices.replaceAll('style="display:none"', attribute))).toEqual({ overflow: false, calendarCount: 0, filterGroupCount: 0, serviceCatalogCount: 1 });
  });
  it.each([
    responsiveServices.replace('style="display:none">More', 'style="display:none">Unknown'),
    responsiveServices.replace('style="display:none"', 'style="display:none" href="/private/"'),
    responsiveServices.replace('role="button" aria-haspopup="menu">More', 'role="button" aria-haspopup="menu" href="/public/">More'),
    responsiveServices.replace('aria-haspopup="menu" style="display:none"', 'aria-haspopup="dialog" style="display:none"'),
    responsiveServices.replace('style="display:none"', 'style="display:none" aria-label="Pay now"'),
    responsiveServices.replace('style="display:none"', 'style="display:none" form="private-form"'),
    responsiveServices.replace('<p>Bring people', '<input hidden type="email"><p>Bring people'),
    responsiveServices.replace('<p>Bring people', '<textarea hidden></textarea><p>Bring people'),
    responsiveServices.replace('1 hr 55 mins', '1 hr 55 mins 10:30 AM'),
    responsiveServices.replace('<p>Bring people', '<button type="button">Options</button><p>Bring people'),
    responsiveServices.replace('style="display:none"', ''),
    responsiveServices.replace('<span role="button" aria-haspopup="menu">More</span>', ''),
  ])("keeps unknown, active, private, time or unmatched responsive controls closed %#", html => {
    expect(collect(html).serviceCatalogCount).toBe(0);
  });
  it("recognizes public compound-duration cards and nested passive menu disclosures without asserting marketed duration", () => {
    expect(collect(compoundServices)).toMatchObject({ overflow: false, serviceCatalogCount: 1 });
    expect(collect(services.replace('1 hr', '2 hr'))).toMatchObject({ serviceCatalogCount: 1 });
    expect(collect(services.replace('1 hr', '1 hr 2 players'))).toMatchObject({ serviceCatalogCount: 0 }); // Not an explicit duration scalar.
  });
  it("recognizes generic public DIV duration cards without provider selectors or reading private values", () => {
    expect(collect(services)).toMatchObject({ overflow: false, serviceCatalogCount: 1 });
    expect(collect(services.replaceAll("Public Golf", "T Time"))).toMatchObject({ overflow: false, serviceCatalogCount: 1 });
    expect(collect(services.replaceAll("Public Golf", "T Time").replaceAll("h3>", "h6>").replaceAll("h4>", "h5>"))).toMatchObject({ overflow: false, serviceCatalogCount: 1 });
    expect(JSON.stringify(collect(services))).not.toMatch(/hour|golf|BOOK|selector|href|value|serviceId/iu);
  });
  it.each(["CALENDAR", "SERVICE_CATALOG"])("survives the actual installed tsx transform and a separate browser-like serialization realm (%s)", kind => {
    const script = `const {collectPublicRootWidget}=require('./src/lib/course-discovery/public-root-widget.ts');
      const {JSDOM}=require('jsdom');const dom=new JSDOM(${JSON.stringify('<style>* {opacity:1}</style>' + (kind === "CALENDAR" ? calendar : responsiveServices))},{runScripts:'outside-only'});
      Object.defineProperty(dom.window.HTMLElement.prototype,'getBoundingClientRect',{value:()=>({width:100,height:20})});
      try{process.stdout.write(JSON.stringify(dom.window.eval('('+collectPublicRootWidget.toString()+')()')));}finally{dom.window.close();}`;
    const result = execFileSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "--eval", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(JSON.parse(result)).toEqual({ overflow: false, calendarCount: kind === "CALENDAR" ? 1 : 0, filterGroupCount: 0, serviceCatalogCount: kind === "SERVICE_CATALOG" ? 1 : 0 });
  });
  it("reads only calendar/filter presence through a separately serialized fixed collector", () => {
    expect(collect(calendar)).toEqual({ overflow: false, calendarCount: 1, filterGroupCount: 0, serviceCatalogCount: 0 });
    expect(collect(filters)).toEqual({ overflow: false, calendarCount: 0, filterGroupCount: 1, serviceCatalogCount: 0 });
    for (const label of ["Players", "Resources", "Bays", "Suites"]) expect(collect(filters.replace("Duration", label)).filterGroupCount).toBe(1);
  });
  it("never reads input values or selected options into the presence result", () => {
    expect(collect(filters.replace('<input type="date">', '<input type="date" value="PRIVATE_DATE">').replace('<option>', '<option selected value="PRIVATE_SELECTION">')))
      .toEqual(collect(filters));
    expect(JSON.stringify(collect(filters))).not.toMatch(/PRIVATE|date|hour|selector|href|value/iu);
  });
  it.each([
    '<main><h1>Site search</h1><input aria-label="Search"><input type="date" aria-label="Date"></main>',
    filters.replace(/<label>Duration[\s\S]*?<\/label>/u, ""),
    filters.replace("Public rentals", "Contact us"),
    '<form>' + filters + '</form>',
    '<form>' + calendar + '</form>',
    '<div hidden>' + calendar + '</div>',
    '<div inert>' + calendar + '</div>',
    '<div style="opacity:0">' + calendar + '</div>',
    calendar.replace('<div role="grid">', '<div role="grid" aria-hidden="true">'),
    calendar.replace(/role="gridcell"/gu, 'role="gridcell" disabled'),
    calendar.replace(/role="columnheader"/gu, 'role="columnheader" hidden'),
    calendar.replace('<h1>', '<input type="password"><h1>'),
    filters.replace("Duration", "Contact phone"),
    filters.replace('<select>', '<select disabled>'),
  ])("rejects nonavailability, private, hidden or incomplete widget scope %#", html => {
    const facts = collect(html); expect(facts.calendarCount).toBe(0); expect(facts.filterGroupCount).toBe(0);
  });
  it("fails closed on complete DOM/control bounds, not a truncated subset", () => {
    expect(collect(calendar + '<i></i>'.repeat(10_001)).overflow).toBe(true);
    expect(collect(filters.replace('</main>', '<select></select>'.repeat(130) + '</main>')).overflow).toBe(true);
  });
  it.each([
    '<div hidden>' + services + '</div>', '<div inert>' + services + '</div>', '<div style="visibility:collapse">' + services + '</div>',
    '<form>' + services + '</form>', services.replace('>BOOK<', '>PAY<'), services.replace('>BOOK<', '>Unknown<'),
    '<div role="form">' + services + '</div>', services.replace('<button type="button">', '<button type="button" hidden>'),
    services.replace('<button type="button">', '<button type="button" aria-label="Pay now">'),
    services.replace('<button type="button">', '<button type="button" role="tab">'), services.replace('<button type="button">', '<button type="button" form="private-form">'),
    services.replace('<button type="button">', '<button type="button" disabled>'), services.replace('<h3>', '<input type="email"><h3>'),
    services.replace('1 hr', '10:30 AM'), services.replace('1 hr', '1 hr selected slot'), services.replace('1 hr', '1 hr 2 players'),
    services.replace('1 hr', '1 hr 60 mins'), services.replace(/<p>\d hr<\/p>/gu, ''), services.replace(/<h4>[\s\S]*?<\/h4>/gu, ''),
    '<div><h3>Public golf rentals</h3>' + serviceCard(1) + serviceCard(1) + '</div>',
    '<div><h3>Public golf rentals</h3>' + serviceCard(1) + '</div>',
  ])("does not classify hidden, transactional, slot, conflicting or partial service cards %#", html => {
    expect(collect(html).serviceCatalogCount).toBe(0);
  });
  it.each([
    compoundServices.replace('aria-haspopup="menu"', 'aria-haspopup="dialog"'),
    compoundServices.replace('>More<', '>Pay now<'),
    compoundServices.replace('role="button" aria-haspopup="menu"', 'role="button" aria-haspopup="menu" href="/private/"'),
    compoundServices.replace('<span role="button"', '<span hidden role="button"'),
    compoundServices.replace('<p>Bring people', '<input aria-label="Party size"><p>Bring people'),
    compoundServices.replace('<p>Bring people', '<select aria-label="Players"></select><p>Bring people'),
    compoundServices.replace('1 hr 55 mins', '1 hr 55 mins 10:30 AM'),
    compoundServices.replace('1 hr 55 mins', '1 hr 55 mins selected reservation'),
    compoundServices.replace('<span role="button" aria-haspopup="menu"><span role="button" aria-haspopup="menu">More</span></span>', '<span role="button" aria-haspopup="menu">More</span><span role="button" aria-haspopup="menu">More</span>'),
  ])("never treats unknown/active/independent disclosures or party controls as passive catalog presence %#", html => {
    expect(collect(html).serviceCatalogCount).toBe(0);
  });
  it("requires one complete bounded catalog rather than choosing an ambiguous subset", () => {
    const ambiguous = collect('<main>' + services + services.replace('Regular Booking', 'Public golf rentals') + '</main>');
    expect(ambiguous.serviceCatalogCount).toBe(2);
    expect(pairedNativeRootWidget({ pageUrl: "https://ordinary.example.org/", observedAt: 1, documentHash: "a".repeat(64), documentIdentityHash: "b".repeat(64), settled: true, widget: ambiguous },
      { pageUrl: "https://ordinary.example.org/", observedAt: 1, documentHash: "a".repeat(64), documentIdentityHash: "b".repeat(64), settled: true, widget: ambiguous }, { startedAt: 1, now: 2, deadline: 3 })).toBeNull();
    expect(collect('<div><h3>Public golf rentals</h3>' + Array.from({ length: 17 }, (_, i) => serviceCard(i % 8 + 1)).join('') + '</div>').overflow).toBe(true);
  });
});
describe("paired native root widget witness", () => {
  const capture = (): NativeRootWidgetCapture => ({ pageUrl: "https://ordinary.example.org/#calendar", observedAt: 1000,
    documentHash: "a".repeat(64), documentIdentityHash: "b".repeat(64), settled: true, widget: { overflow: false, calendarCount: 1, filterGroupCount: 0 } });
  const clock = { startedAt: 1000, now: 1001, deadline: 5000 };
  it("produces routing-only facts from two identical settled current native captures", () => {
    expect(pairedNativeRootWidget(capture(), capture(), clock)).toEqual({ kind: "NATIVE_ROOT_PUBLIC_WIDGET", pageUrl: capture().pageUrl,
      observedAt: new Date(1000).toISOString(), documentHash: "a".repeat(64), widgetKind: "CALENDAR" });
    const filter = { ...capture(), widget: { overflow: false, calendarCount: 0, filterGroupCount: 1 } };
    expect(pairedNativeRootWidget(filter, filter, clock)?.widgetKind).toBe("PUBLIC_FILTERS");
    const catalog = { ...capture(), widget: { overflow: false, calendarCount: 0, filterGroupCount: 0, serviceCatalogCount: 1 } };
    expect(pairedNativeRootWidget(catalog, catalog, clock)?.widgetKind).toBe("SERVICE_CATALOG");
    expect(pairedNativeRootWidget(catalog, { ...catalog, documentIdentityHash: "c".repeat(64) }, clock)).toBeNull();
  });
  it("rejects stale, changed, unready, ambiguous, overflowing or expired pairs", () => {
    for (const change of [{ settled: false }, { documentHash: "c".repeat(64) }, { documentIdentityHash: "c".repeat(64) },
      { pageUrl: "https://ordinary.example.org/other" }, { observedAt: 999 }, { observedAt: Number.NaN },
      { widget: { overflow: true, calendarCount: 1, filterGroupCount: 0 } }, { widget: { overflow: false, calendarCount: 2, filterGroupCount: 0 } }])
      expect(pairedNativeRootWidget(capture(), { ...capture(), ...change }, clock)).toBeNull();
    expect(pairedNativeRootWidget(capture(), capture(), { ...clock, now: 6001, deadline: 9000 })).toBeNull();
    expect(pairedNativeRootWidget(capture(), capture(), { ...clock, deadline: 1001 })).toBeNull();
  });
});
