// @vitest-environment node
import { describe, expect, it } from "vitest";
import observed from "./fixtures/mindbody-appointment-grid-observed.json";
import relativeObserved from "./fixtures/mindbody-relative-cell-query-projection-observed.json";
import { inspectMindbodyPublicRentalCatalog, mindbodyAppointmentMetadataSchema, parseMindbodyAppointmentCellHref,
  parseMindbodyAppointmentSource, parseMindbodyResourceHeaderHref, readMindbodyPublicAppointmentGrid,
  type MindbodyCatalogEvidence, type MindbodyGridEvidence } from "./mindbody-appointment-grid";

const clone = <T>(value: T): T => structuredClone(value);
const source = observed.source, input = observed.input;
const catalog = (): MindbodyCatalogEvidence => ({ ...clone(observed.catalogObserved), captureId: "synthetic-capture",
  category: { ...observed.catalogObserved.category, enabled: true, selected: true },
  service: { ...observed.catalogObserved.service, enabled: true, selected: true },
  resources: observed.catalogObserved.resources.map(resource => ({ ...resource, enabled: true })) });
const grid = (): MindbodyGridEvidence => ({ ...clone(observed.gridObserved), captureId: "synthetic-capture" });
const observation = () => inspectMindbodyPublicRentalCatalog(source, catalog());
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
/** Synthetic document layout around exact saved public anchor data. It is not
 * the missing real provider HTML and cannot qualify a live acceptance run. */
function syntheticHtml(evidence = grid()) {
  return '<html><body><h1>Saturday 10/24/2026</h1><p>Instructors 1-6</p><table><tr>' +
    evidence.resourceHeaders.map(row => '<th><a class="instructorLink" href="' + escape(row.href) + '">' + escape(row.label) + '</a></th>').join("") +
    '</tr><tr><td>5:00 am</td></tr>' + evidence.anchors.map(row =>
      '<tr><td><a class="apptLink" href="' + escape(row.href) + '">' + escape(row.label) + '</a></td></tr>').join("") +
    '<tr><td>10:00 pm</td></tr></table></body></html>';
}
function completedGrid() {
  const evidence = grid(), html = syntheticHtml(evidence);
  evidence.completion = { responseUrl: evidence.url, status: 200, contentType: "text/html; charset=utf-8",
    rawHtml: html, renderedHtml: html, bodyComplete: true, documentUnchanged: true, pendingRelevantRequests: 0, truncated: false, signedOut: true };
  return evidence;
}

describe("Mindbody observed public appointment cells", () => {
  it("reads all126 actual saved anchors without generating starts or requesting the href", () => {
    const cells = observed.gridObserved.anchors.map(row => parseMindbodyAppointmentCellHref(row.href, input.date));
    expect(cells).toHaveLength(126);
    expect(cells.filter(row => row.categoryId === "2")).toHaveLength(78);
    expect(new Set(cells.filter(row => row.categoryId === "2").map(row => row.resourceId))).toEqual(new Set(["100000001", "100000002", "100000003", "100000004"]));
    expect(cells.some(row => row.startMinutes % 30 !== 0)).toBe(false);
    expect(parseMindbodyResourceHeaderHref(observed.gridObserved.resourceHeaders[0].href)).toBe("100000001");
    expect(parseMindbodyResourceHeaderHref("javascript:autoSubmitToDayTrn('1');alert(1)")).toBeUndefined();
  });
  it("recognizes only the public observed classic descriptor, with no private or guessed routes", () => {
    expect(parseMindbodyAppointmentSource(source.bookingUrl)?.studioId).toBe("685163");
    for (const url of [source.bookingUrl + "&token=private", source.bookingUrl + "&studioid=1", source.bookingUrl.replace("https:", "http:"),
      source.bookingUrl.replace("/classic/ws", "/ASP/appt_req.asp"), source.bookingUrl.replace("clients.", "other."),
      source.bookingUrl.replace("studioid", "%73tudioid")]) expect(parseMindbodyAppointmentSource(url)).toBeUndefined();
  });
  it.each([
    ["duplicate", (url: URL) => url.searchParams.append("Stime", "10:00:00 AM"), "QUERY"],
    ["unknown key", (url: URL) => url.searchParams.set("route", "invented"), "QUERY"],
    ["private field", (url: URL) => url.searchParams.set("token", "private"), "URL"],
    ["wrong local date", (url: URL) => url.searchParams.set("localDate", "10/25/2026"), "LOCAL_DATE"],
    ["invalid local date", (url: URL) => url.searchParams.set("localDate", "2/30/2026"), "LOCAL_DATE"],
    ["wrong requested date", (url: URL) => url.searchParams.set("date", "10/25/2026"), "DATE"],
    ["invalid date", (url: URL) => url.searchParams.set("date", "2/30/2026"), "DATE"],
    ["masked", (url: URL) => url.searchParams.set("mask", "True"), "QUERY"],
    ["missing resource", (url: URL) => url.searchParams.delete("trnid"), "QUERY"],
    ["invalid resource", (url: URL) => url.searchParams.set("trnid", "0"), "QUERY"],
    ["nonzero seconds", (url: URL) => url.searchParams.set("Stime", "9:00:15 AM"), "CLOCK"],
    ["invalid clock", (url: URL) => url.searchParams.set("Stime", "13:00:00 AM"), "CLOCK"],
    ["invalid end clock", (url: URL) => url.searchParams.set("Etime", "13:00:00 AM"), "CLOCK"],
    ["reversed free interval", (url: URL) => url.searchParams.set("Etime", "8:00:00 AM"), "INTERVAL"],
    ["zero interval", (url: URL) => url.searchParams.set("Etime", url.searchParams.get("Stime")!), "INTERVAL"],
    ["foreign origin", (url: URL) => { url.hostname = "foreign.example"; }, "URL"],
    ["transaction alternative", (url: URL) => { url.pathname = "/ASP/checkout.asp"; }, "URL"],
  ])("rejects %s with a closed stage code", (_label, change, code) => {
    const url = new URL(observed.gridObserved.anchors[0].href); change(url);
    expect(() => parseMindbodyAppointmentCellHref(url.href, input.date)).toThrow("MINDBODY_GRID_CELL_" + code + "_INVALID");
  });
  it("normalizes all126 actual relative query projections identically to absolute inert hrefs", () => {
    expect(relativeObserved.source.sha256).toBe("d5ee0d45890559b9d9e9e4cb964728b010003ee7bd098518e382b7f1eaf681bd");
    expect(relativeObserved.anchors).toHaveLength(126);
    for (const anchor of relativeObserved.anchors) {
      expect(anchor).toMatchObject({ attributeForm: "RELATIVE", expectedHost: true, expectedPath: true, visible: true });
      const query = new URLSearchParams(anchor.queryKeyNames.map(key => [key, anchor.values[key as keyof typeof anchor.values]])).toString();
      // Saved evidence records query fields, not original relative path bytes.
      const absolute = parseMindbodyAppointmentCellHref("https://clients.mindbodyonline.com/ASP/appt_req.asp?" + query, input.date);
      for (const path of ["appt_req.asp", "./appt_req.asp", "/ASP/appt_req.asp"])
        expect(parseMindbodyAppointmentCellHref(path + "?" + query, input.date)).toEqual(absolute);
      expect(absolute.date).toBe("2026-10-24");
    }
  });
  it("rejects foreign/scheme/path escape/malformed relative hrefs without requesting them", () => {
    const query = new URL(observed.gridObserved.anchors[0].href).search;
    for (const path of ["https://foreign.example/ASP/appt_req.asp", "http://clients.mindbodyonline.com/ASP/appt_req.asp", "//foreign.example/ASP/appt_req.asp",
      "//clients.mindbodyonline.com/ASP/appt_req.asp", "../ASP/appt_req.asp", "%2e%2e/ASP/appt_req.asp", "../appt_req.asp", "/elsewhere/appt_req.asp",
      "javascript:appt_req.asp", "data:text/plain,appt_req.asp", "appt_req.asp%ZZ", "\\ASP\\appt_req.asp", " appt_req.asp", "appt_req.asp\n"])
      expect(() => parseMindbodyAppointmentCellHref(path + query, input.date)).toThrow("MINDBODY_GRID_CELL_URL_INVALID");
    for (const value of ["not a URL", "PRIVATE_PAYLOAD"])
      expect(() => parseMindbodyAppointmentCellHref(value, input.date)).toThrow("MINDBODY_GRID_CELL_URL_INVALID");
    expect(() => parseMindbodyAppointmentCellHref("appt_req.asp" + query + "&trnid=1", input.date)).toThrow("MINDBODY_GRID_CELL_QUERY_INVALID");
    const wrongLocalDate = new URLSearchParams(query); wrongLocalDate.set("localDate", "10/23/2026");
    expect(() => parseMindbodyAppointmentCellHref("appt_req.asp?" + wrongLocalDate.toString(), input.date))
      .toThrow("MINDBODY_GRID_CELL_LOCAL_DATE_INVALID");
  });
  it("keeps native raw/rendered completion requirements for relative attributes", () => {
    const evidence = completedGrid(); evidence.anchors = evidence.anchors.map(anchor => ({ ...anchor, href: new URL(anchor.href).pathname + new URL(anchor.href).search }));
    const html = syntheticHtml(evidence); evidence.completion!.rawHtml = html; evidence.completion!.renderedHtml = html;
    const result = readMindbodyPublicAppointmentGrid(source, observation(), input, evidence);
    expect(result.complete).toBe(true); expect(result.slots).toHaveLength(59);
    delete evidence.completion;
    expect(readMindbodyPublicAppointmentGrid(source, observation(), input, evidence)).toMatchObject({ complete: false, slots: [], reason: "MINDBODY_GRID_COMPLETION_WITNESS_MISSING" });
  });
});

describe("Mindbody typed catalog and canonical binding", () => {
  it("requires fresh enabled/selected scope and hashes public known metadata only", () => {
    expect(() => inspectMindbodyPublicRentalCatalog(source, observed.catalogObserved)).toThrow();
    const value = observation();
    expect(value.metadata).toMatchObject({ family: "MINDBODY", protocol: "CLASSIC_APPOINTMENT_GRID", studioId: "685163",
      categoryId: "2", serviceId: "5", durationMinutes: 60, capacity: 4, timeZone: "America/New_York" });
    expect(value.metadata.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(value.metadata)).not.toMatch(/captureId|cookie|token|description/iu);
    expect(() => mindbodyAppointmentMetadataSchema.parse({ ...value.metadata, proof: {} })).toThrow();
    expect(() => mindbodyAppointmentMetadataSchema.parse({ ...value.metadata, apiKey: "private" })).toThrow();
  });
  it.each(["name", "address", "ZIP", "tenant", "disabled", "unselected", "duration", "capacity", "duplicate resource", "private service"])("rejects changed catalog %s", kind => {
    const value = catalog();
    if (kind === "name") value.venueName = "Another Public Venue";
    if (kind === "address") value.venueAddress = value.venueAddress.replace("1669", "1668");
    if (kind === "ZIP") value.venueAddress = value.venueAddress.replace("15222", "15223");
    if (kind === "tenant") value.studioId = "123";
    if (kind === "disabled") Object.assign(value.service, { enabled: false });
    if (kind === "unselected") Object.assign(value.category, { selected: false });
    if (kind === "duration") value.service.label = "TrackMan Simulator - unknown session";
    if (kind === "capacity") value.service.description = "Bring guests.";
    if (kind === "duplicate resource") value.resources.push(value.resources[0]);
    if (kind === "private service") value.service.label = "Private lesson - 1 hour session";
    expect(() => inspectMindbodyPublicRentalCatalog(source, value)).toThrow();
  });
});

describe("Mindbody whole-date completion", () => {
  it("keeps actual saved rows incomplete without the missing real raw/rendered witness", () => {
    const result = readMindbodyPublicAppointmentGrid(source, observation(), input, grid());
    expect(result).toEqual({ complete: false, reason: "MINDBODY_GRID_COMPLETION_WITNESS_MISSING",
      observedStartCount: 78, requestedDurationStartCount: 72, slots: [] });
  });
  it("a synthetic full witness proves only explicit starts and uses freeUntil as a bound, never as appointment end", () => {
    const result = readMindbodyPublicAppointmentGrid(source, observation(), input, completedGrid());
    expect(result.complete).toBe(true);
    expect(result.slots).toHaveLength(59);
    for (const slot of result.slots) {
      expect(Date.parse(slot.endsAt) - Date.parse(slot.startsAt)).toBe(60 * 60_000);
      expect(slot.officialBookingUrl).toBe(source.bookingUrl);
      expect(slot.officialBookingUrl).not.toContain("appt_req");
    }
    expect(result.slots.some(slot => slot.startsAt.includes("T14:15:"))).toBe(false);
  });
  it.each(["capture", "timezone", "duration", "capacity", "date", "title", "resource", "category", "location", "duplicate", "hidden"])("rejects changed runtime %s", kind => {
    const evidence = completedGrid(), request = { ...input };
    if (kind === "capture") evidence.captureId = "another-browser";
    if (kind === "timezone") request.timeZone = "America/Chicago";
    if (kind === "duration") request.durationMinutes = 30;
    if (kind === "capacity") request.players = 5;
    if (kind === "date") evidence.text = evidence.text.replace("10/24/2026", "10/25/2026");
    if (kind === "title") evidence.title = "Another Public Venue";
    if (kind === "resource") evidence.resourceHeaders.pop();
    if (kind === "category") evidence.anchors[0].href = evidence.anchors[0].href.replace("tgid=2", "tgid=99");
    if (kind === "location") evidence.anchors[0].href = evidence.anchors[0].href.replace("loc=1", "loc=2");
    if (kind === "duplicate") evidence.anchors.push(evidence.anchors[0]);
    if (kind === "hidden") evidence.anchors[0].visible = false;
    expect(() => readMindbodyPublicAppointmentGrid(source, observation(), request, evidence)).toThrow();
  });
  it.each(["truncated", "pending", "unsigned", "changed document", "status", "content type", "missing end", "hidden raw row", "pagination", "no table", "raw mismatch", "resource range", "time axis"])("rejects incomplete %s", kind => {
    const evidence = completedGrid(), witness = evidence.completion!;
    if (kind === "truncated") witness.truncated = true;
    if (kind === "pending") witness.pendingRelevantRequests = 1;
    if (kind === "unsigned") witness.signedOut = false;
    if (kind === "changed document") witness.documentUnchanged = false;
    if (kind === "status") witness.status = 403;
    if (kind === "content type") witness.contentType = "application/json";
    if (kind === "missing end") witness.rawHtml = witness.rawHtml.replace("</html>", "");
    if (kind === "hidden raw row") witness.rawHtml = witness.rawHtml.replace('class="apptLink"', 'class="apptLink" hidden');
    if (kind === "pagination") witness.rawHtml = witness.rawHtml.replace("</body>", "<button>Load more</button></body>");
    if (kind === "no table") witness.rawHtml = witness.rawHtml.replaceAll("table", "section");
    if (kind === "raw mismatch") witness.rawHtml = witness.rawHtml.replace("Stime=9:00", "Stime=9:01");
    if (kind === "resource range") witness.rawHtml = witness.rawHtml.replace("Instructors 1-6", "Instructors 7-12");
    if (kind === "time axis") witness.rawHtml = witness.rawHtml.replace("10:00 pm", "5:00 pm");
    expect(() => readMindbodyPublicAppointmentGrid(source, observation(), input, evidence)).toThrow();
  });
});

