import { describe, expect, it } from "vitest";
import { deriveUScheduleOfficialLocation, parseUScheduleLocationSource, readUScheduleLocationCatalog } from "./uschedule-location-source";

const booking = "https://clients.uschedule.com/examplegolf/booking", entry = `${booking}?filter=loc[82]`;
const source = { officialUrl: "https://example.org/", bookingUrl: booking, venueName: "Example Indoor Golf Club",
  venueAddress: "10 Main St #102, Example, WA 98000, USA", timeZone: "America/Los_Angeles" };
const address = "10 Main Street Suite 102, Example, WA 98000";
const page = () => ({ url: source.officialUrl, html: `<html><body><h1>${source.venueName}</h1><p>${address}</p><a href="${entry}">Book a tee time</a></body></html>`,
  visibleEvidence: { title: source.venueName, headings: [source.venueName], linkUrls: [entry], addressTexts: [address] } });
function html() { return `<html><body class="examplegolf"><div class="col-lg-4 order-1"><div id="location_section"><select id="select_location"><option value="81">Other Indoor Golf Club</option><option value="82" selected>Example Indoor Golf Club</option></select></div>
  <div id="service_section"><select id="select_service"><option value="73" selected>Non-Member Hourly Rental</option><option value="74">Example Lesson</option></select></div>
  <select id="select_length"><option value="60" selected>1 hour</option><option value="120">2 hours</option></select>
  <div id="res_section"><label class="choose_label" for="resource55">Simulators - Example</label><select id="resource55" class="resSelect"><option value="-1" selected>Any Available</option><option value="91">Example - Bay 1</option><option value="92">Example - Bay 2</option></select></div>
  <select id="addon77" class="addOnSelect"><option value="0" selected>0</option><option value="1">1</option></select>
  <div class="card my-3"><div class="card-body pt-3 pb-2"><p>Simulators:</p><p>Additional Guest(s):</p><ul><li>Non-members may bring 1 guest for free.</li><li>You may add 2 additional guests if you wish. The charge is $25 per person/per hour. Max of 4 people in the bay.</li></ul></div></div></div>
  <div id="right_column"><div class="serv_only_desc"><div id="serv_desc_section"><p>Non-Member Tee Time Guidelines</p><ul><li>Non-members reservations include 1 guest, for free.</li></ul></div></div></div>
  <script src="/bundles/js/bookingBS5?v=${"a".repeat(44)}"></script></body></html>`; }
const proof = () => deriveUScheduleOfficialLocation(source, page());

describe("official-location public USchedule rental proof", () => {
  it("recognizes only exact public roots or a sole bounded location filter", () => {
    expect(parseUScheduleLocationSource(entry)).toMatchObject({ tenant: "examplegolf", locationId: "82", canonicalUrl: booking });
    expect(parseUScheduleLocationSource(booking)?.locationId).toBeUndefined();
    for (const url of [`${entry}&filter=loc[83]`, `${entry}&token=secret`, `${booking}?filter=member[82]`, `${booking}?filter=loc[0]`,
      `${booking}/payment`, `${entry}#time`, booking.replace("https://", "http://"), booking.replace("https://", "https://user:secret@"),
      booking.replace("uschedule.com", "uschedule.com.example.org")]) expect(parseUScheduleLocationSource(url)).toBeUndefined();
  });
  it("binds the shared tenant location using whole official venue, address and actual visible location link", () => {
    const official = proof();
    expect(official).toMatchObject({ locationId: "82", entryUrl: entry, venueName: source.venueName });
    expect(official.addressKey).toContain("ste 102");
    for (const change of [(value: ReturnType<typeof page>) => { value.visibleEvidence.linkUrls = []; }, (value: ReturnType<typeof page>) => { value.html = value.html.replace("loc[82]", "loc[81]"); },
      (value: ReturnType<typeof page>) => { value.html = value.html.replace("<h1>", '<h1 hidden>'); }, (value: ReturnType<typeof page>) => { value.html = value.html.replace(address, "99 Other Road, Example, WA 98000"); }]) {
      const value = page(); change(value); expect(() => deriveUScheduleOfficialLocation(source, value)).toThrow();
    }
    expect(() => deriveUScheduleOfficialLocation({ ...source, venueName: `${source.venueName} North` }, page())).toThrow();
  });
  it("projects public catalog identity without retaining current date, window or anonymous state", () => {
    const catalog = readUScheduleLocationCatalog(html(), entry, proof());
    expect(catalog).toMatchObject({ locationSelected: true, selectedServiceId: "73", selectedDuration: 60,
      service: { serviceId: "73", serviceName: "Non-Member Hourly Rental" }, durations: [60, 120],
      proof: { kind: "PUBLIC_LOCATION_RENTAL_V1", includedPartySize: 2, maxPartySize: 4, locationId: "82",
        resourceGroups: [{ id: "55", resources: [{ id: "91", name: "Example - Bay 1" }, { id: "92", name: "Example - Bay 2" }] }] } });
    expect(JSON.stringify(catalog.proof)).not.toMatch(/cookie|session|start_date|chosenDate|2030-/u);
    const changed = html().replace('value="60" selected', 'value="60"').replace('value="120">', 'value="120" selected>');
    expect(readUScheduleLocationCatalog(changed, entry, proof()).proof.catalogHash).toBe(catalog.proof.catalogHash);
  });
  it("requires actual controller official-document provenance for a bare/www alias", () => {
    const value = { ...page(), url: "https://www.example.org/" };
    expect(() => deriveUScheduleOfficialLocation(source, value)).toThrow();
    const officialDocumentProof = { kind: "VERIFIED_OFFICIAL_DOCUMENT" as const, officialUrl: source.officialUrl, documentUrl: value.url };
    expect(deriveUScheduleOfficialLocation(source, { ...value, officialDocumentProof }).officialPageUrl).toBe(value.url);
    for (const proof of [{ ...officialDocumentProof, documentUrl: "https://www.example.org/other" },
      { ...officialDocumentProof, officialUrl: "https://foreign.example.org/" }])
      expect(() => deriveUScheduleOfficialLocation(source, { ...value, officialDocumentProof: proof })).toThrow();
    expect(() => deriveUScheduleOfficialLocation(source, { ...value, url: "https://branch.example.org/", officialDocumentProof })).toThrow();
  });
  it.each([
    ["other location identity", (value: string) => value.replace("Example Indoor Golf Club", "Other Indoor Golf Club")],
    ["member service", (value: string) => value.replace("Non-Member Hourly Rental", "Member Hourly Rental")],
    ["duplicate services", (value: string) => value.replace("Example Lesson", "Non-Member Hourly Rental")],
    ["unclassified public rental", (value: string) => value.replace("Example Lesson", "Public Hourly Bay Rental")],
    ["grouped extra public rental", (value: string) => value.replace('<option value="74">Example Lesson</option>', '<option value="74">Example Lesson</option><optgroup label="More"><option value="75">Public Hourly Bay Rental</option></optgroup>')],
    ["grouped duration", (value: string) => value.replace('<option value="120">2 hours</option>', '<optgroup label="Longer"><option value="120">2 hours</option></optgroup>')],
    ["paid addon selected", (value: string) => value.replace('value="0" selected', 'value="0"').replace('value="1">1', 'value="1" selected>1')],
    ["specific bay selected", (value: string) => value.replace('value="-1" selected', 'value="-1"').replace('value="91">', 'value="91" selected>')],
    ["group selector appeared", (value: string) => value.replace("</body>", '<select id="select_group_size"><option selected value="1">1</option></select></body>')],
    ["missing free guest proof", (value: string) => value.replace("1 guest for free", "0 guests for free")],
    ["wrong resource location", (value: string) => value.replace("Simulators - Example", "Simulators - Other")],
    ["unrelated resource category", (value: string) => value.replace("Simulators - Example", "Batting Bays - Example")],
    ["unrelated guest sidebar", (value: string) => value.replace('class="card my-3"', 'class="unrelated-sidebar"')],
    ["unbound service description", (value: string) => value.replace('id="serv_desc_section"', 'id="unrelated_description"')],
    ["other service description", (value: string) => value.replace("Non-Member Tee Time Guidelines", "Member Tee Time Guidelines")],
    ["missing client witness", (value: string) => value.replace("/bundles/js/bookingBS5", "/bundles/js/other")],
  ])("rejects unqualified catalog change: %s", (_name, change) => {
    expect(() => readUScheduleLocationCatalog(change(html()), entry, proof())).toThrow();
  });
});
