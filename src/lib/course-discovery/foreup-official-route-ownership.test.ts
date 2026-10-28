import { describe, expect, it, vi } from "vitest";
import { deriveForeupOfficialRouteContact, bindForeupOfficialRouteConfiguration, foreupOfficialRouteOwnershipProofSchema, foreupOwnershipDigest, FOREUP_COMPACT_CONTACT_FACILITY_SCOPE } from "./foreup-official-route-ownership";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { venueProofMatches, recipeTimeToInstant } from "./executor";
import { hashAccessRecipe, parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { FOREUP_STANDARD_PUBLIC_SCOPE } from "@/lib/automation/foreup-public-configuration";

const source = { officialUrl: "https://official.example/", bookingUrl: "https://foreupsoftware.com/index.php/booking/12345/456#/teetimes",
  venueName: "Example Golf Course", venueAddress: "10 Example Road, Example, NY 12345, USA", timeZone: "America/New_York", providerFamily: "FOREUP" };
const phone = "+15555550123", display = "555-555-0123", aggregate = "Example, 555-555-0123, 10 Example Rd, Example, NY 12345";
const card = `<div><div>Example</div><div><div><p><a href="tel:${phone}">${display}</a></p><div><span>10 Example Rd</span></div><div>Example, NY 12345</div></div></div></div>`;
function page(): OfficialIdentityPage { return { url: source.officialUrl, browserTransport: "NATIVE_CHROME", html: `<html><head><title>Example | County</title></head><body><h3>Example Golf Course</h3><a href="${source.bookingUrl}">Book tee times</a>${card}</body></html>`,
  visibleEvidence: { title: "Example | County", headings: [], linkUrls: [source.bookingUrl], addressTexts: [aggregate], phoneTexts: [display] } }; }
const native = (p = page()) => registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 30000));
function provider() {
  const course = { course_id: "12345", name: "Example Park Golf Course", address: "10 Example Rd", city: "Example", state: "NY", zip: "12345", country: "US", phone: display, timezone: source.timeZone };
  const sheet = { course_id: "12345", course_name: course.name, course_timezone: source.timeZone, title: "Example East", teesheet_id: "456", booking_classes: [
    { teesheet_id: "456", booking_class_id: "12", name: "Public", active: "1", hidden: "0" },
    { teesheet_id: "456", booking_class_id: "13", name: "Members", active: "1", hidden: "0" } ] };
  return { course, courses: [course], schedules: [sheet, { ...sheet, title: "Example West", teesheet_id: "457", booking_classes: [
    { teesheet_id: "457", booking_class_id: "14", name: "Members", active: "1", hidden: "0" } ] }] };
}
const html = (value = provider()) => `<html><body><script>var COURSES=${JSON.stringify(value.courses)};var COURSE=${JSON.stringify(value.course)};var SCHEDULES=${JSON.stringify(value.schedules)};</script></body></html>`;
const input = { date: "2026-10-28", players: 2, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone };
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
function deps() { return { localCapabilities: ["LOCAL_CHROME"] as const, trustedContext: { canonicalCoursePhone: phone }, venueMatches: venueProofMatches,
  requestedInput: input, requestLease: lease, readNativeOfficialPage: vi.fn(async () => native()),
  fetch: vi.fn<typeof fetch>(async raw => String(raw).includes("/api/") ? Response.json([]) : new Response(html(), { headers: { "content-type": "text/html" } })) }; }
describe("native official ForeUP route physical ownership", () => {
  it.each(["same provider ID", "different provider ID", "same physical address"])("retains unresolved public sibling coverage despite selected-route ownership: %s", mode => {
    const value = provider(), other = { ...value.course, course_id: mode === "same provider ID" ? value.course.course_id : "12346", phone: "555-555-0199" };
    if (mode !== "same provider ID") value.courses.push(other);
    value.schedules[1] = { ...value.schedules[1], course_id: other.course_id, booking_classes: [
      { teesheet_id: "457", booking_class_id: "14", name: "Public", active: "1", hidden: "0" } ] };
    const contact = deriveForeupOfficialRouteContact(source, native(), phone);
    expect(() => bindForeupOfficialRouteConfiguration(contact, html(value))).toThrow("FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED");
  });
  it("excludes a separate physical course only after current native canonical identity and complete provider identity agree", () => {
    const value = provider(), other = { ...value.course, course_id: "12346", name: "Other Golf Course", address: "99 Other Street", city: "Elsewhere", zip: "54321", phone: "555-555-0199" };
    value.courses.push(other);
    value.schedules[1] = { ...value.schedules[1], course_id: other.course_id, course_name: other.name, booking_classes: [
      { teesheet_id: "457", booking_class_id: "14", name: "Public", active: "1", hidden: "0" } ] };
    const contact = deriveForeupOfficialRouteContact(source, native(), phone);
    expect(bindForeupOfficialRouteConfiguration(contact, html(value)).config.scheduleId).toBe(456);
    value.schedules[1].course_name = value.course.name;
    expect(() => bindForeupOfficialRouteConfiguration(contact, html(value))).toThrow("FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED");
  });
  it("preserves distinct canonical/owner/sheet labels with exact minimal raw+visible contact and route-owned IDs", () => {
    const contact = deriveForeupOfficialRouteContact(source, native(), phone), result = bindForeupOfficialRouteConfiguration(contact, html());
    expect(result.config).toMatchObject({ sourceBookingUrl: source.bookingUrl, bookingBaseUrl: source.bookingUrl, scheduleId: 456, bookingClassId: 12 });
    expect(result.proof).toMatchObject({ venueName: source.venueName, providerName: "Example Park Golf Course", sheetTitle: "Example East", publicLocationName: "Example", facilityId: 12345 });
    expect(foreupOfficialRouteOwnershipProofSchema.parse(result.proof)).toEqual(result.proof);
  });
  it.each([
    `<section>Example<br>10 Example Rd<br>Example, NY 12345<br>Phone: <a href="tel:${phone}">${display}</a></section>`,
    `<div><span>Example</span><div><address><span>10</span> <span>Example Rd</span><br><span>Example</span>, <span>NY</span> <span>12345</span></address></div><p><span>Phone:</span> <a href="tel:${phone}">${display}</a></p></div>`,
    `<footer><div><div>Example</div><p><a href="tel:${phone}">${display}</a></p><address>10 Example Rd<br>Example, NY 12345</address></div></footer>`,
  ])("binds the same complete physical contact across generic layout variants", markup => {
    const p = page(); p.html = p.html.replace(card, markup);
    p.visibleEvidence!.addressTexts = ["Example, 10 Example Rd, Example, NY 12345, Phone: 555-555-0123"];
    expect(bindForeupOfficialRouteConfiguration(deriveForeupOfficialRouteContact(source, native(p), phone), html()).proof)
      .toMatchObject({ publicLocationName: "Example", canonicalAddress: source.venueAddress, publicCoursePhone: phone });
  });
  it.each(["street", "town", "zip", "phone", "two-phones", "two-addresses", "wrong-name", "mailing", "private", "whole-page", "cross-sections", "long", "rendered-conflict"])(
    "rejects conflicting or borrowed %s contact evidence in flexible layouts", mode => {
      let markup = `<section>Example<br>10 Example Rd<br>Example, NY 12345<br>Phone: <a href="tel:${phone}">${display}</a></section>`;
      const p = page(); p.visibleEvidence!.addressTexts = ["Example, 10 Example Rd, Example, NY 12345, Phone: 555-555-0123"];
      if (mode === "street") markup = markup.replace("10 Example Rd", "11 Example Rd");
      if (mode === "town") markup = markup.replace("Example, NY", "Elsewhere, NY");
      if (mode === "zip") markup = markup.replace("12345", "12346");
      if (mode === "phone") markup = markup.replaceAll(display, "555-555-9999");
      if (mode === "two-phones") markup = markup.replace("</section>", `<a href="tel:${phone}">${display}</a></section>`);
      if (mode === "two-addresses") markup = markup.replace("</section>", "<address>11 Example Rd, Example, NY 12345</address></section>");
      if (mode === "wrong-name") markup = markup.replace("Example<br>", "Other Course<br>");
      if (mode === "mailing") markup = markup.replace("<section>", '<section class="mailing">');
      if (mode === "private") markup = markup.replace("<section>", '<section class="member">');
      if (mode === "whole-page") markup = `<div><h1>Example</h1><address>10 Example Rd, Example, NY 12345</address><p><a href="tel:${phone}">${display}</a></p></div>`;
      if (mode === "cross-sections") markup = `<div>Example<section><address>10 Example Rd, Example, NY 12345</address></section><section><a href="tel:${phone}">${display}</a></section></div>`;
      if (mode === "long") markup = markup.replace("Example<br>", `Example<br>${"extra ".repeat(130)}`);
      if (mode === "rendered-conflict") p.visibleEvidence!.addressTexts = ["Example, 11 Example Rd, Example, NY 12345, Phone: 555-555-0123"];
      p.html = p.html.replace(card, markup);
      expect(() => deriveForeupOfficialRouteContact(source, native(p), phone)).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
    });
  it.each(["raw", "visible", "both"])("rejects a second same-name conflicting %s physical card instead of filtering it out", mode => {
    const p = page(), other = card.replaceAll(phone,"+15555559999").replaceAll(display,"555-555-9999").replace("10 Example Rd","11 Example Rd");
    if (mode !== "visible") p.html = p.html.replace("</body>",other+"</body>");
    if (mode !== "raw") p.visibleEvidence!.addressTexts.push("Example, 555-555-9999, 11 Example Rd, Example, NY 12345");
    expect(()=>deriveForeupOfficialRouteContact(source,native(p),phone)).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  });
  it("permits differently named neighboring physical cards without borrowing their address or phone", () => {
    const p = page(), other = card.replace("<div>Example</div>","<div>Other Course</div>").replaceAll(phone,"+15555559999").replaceAll(display,"555-555-9999").replace("10 Example Rd","11 Example Rd");
    p.html=p.html.replace("</body>",other+"</body>");p.visibleEvidence!.addressTexts.push("Other Course, 555-555-9999, 11 Example Rd, Example, NY 12345", "Example, NY 12345");
    expect(bindForeupOfficialRouteConfiguration(deriveForeupOfficialRouteContact(source,native(p),phone),html()).proof.providerName).toBe("Example Park Golf Course");
  });
  it.each(["neighbor", "phone", "address", "duplicate", "hidden", "srcdoc", "title", "visible", "link", "copy", "context", "privatephone"])("rejects missing or conflicting %s official ownership", mode => {
    const p = page();
    if (mode === "neighbor") p.html = p.html.replace("<div>Example</div>", "<div>Other Course</div>");
    if (mode === "phone") p.html = p.html.replaceAll(display, "555-555-9999");
    if (mode === "address") p.html = p.html.replace("10 Example Rd", "11 Example Rd");
    if (mode === "duplicate") p.html = p.html.replace("</body>", card + "</body>");
    if (mode === "hidden") p.html = p.html.replace("<div><div>Example", "<div hidden><div>Example");
    if (mode === "srcdoc") p.html = p.html.replace(card, `<iframe srcdoc='${card}'></iframe>`);
    if (mode === "title") p.visibleEvidence!.title = "Example Annex | County";
    if (mode === "visible") p.visibleEvidence!.addressTexts = [];
    if (mode === "link") p.visibleEvidence!.linkUrls = [source.bookingUrl + "x"];
    if (mode === "context") p.url = "https://foreign.example/";
    const registered = mode === "copy" ? structuredClone(native(p)) : native(p);
    expect(() => deriveForeupOfficialRouteContact(source, registered, mode === "privatephone" ? "+15555559999" : phone)).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  });
  it.each(["facility", "sheet", "duplicate", "owner", "address", "phone", "timezone", "sheetTimezone", "current", "public", "classduplicate", "copy"])("rejects changed/foreign %s provider ownership", mode => {
    const contact = deriveForeupOfficialRouteContact(source, native(), phone), value = provider();
    if (mode === "facility") value.schedules[0].course_id = "99999";
    if (mode === "sheet") value.schedules[0].teesheet_id = "999";
    if (mode === "duplicate") value.schedules.push(structuredClone(value.schedules[0]));
    if (mode === "owner") value.schedules[0].course_name = "Other Park Golf Course";
    if (mode === "address") value.course.address = "11 Example Rd";
    if (mode === "phone") value.course.phone = "555-555-9999";
    if (mode === "timezone") value.course.timezone = "America/Chicago";
    if (mode === "sheetTimezone") value.schedules[0].course_timezone = "America/Chicago";
    if (mode === "current") value.courses = [{ ...value.course, phone: "555-555-9999" }];
    if (mode === "public") value.schedules[0].booking_classes[0].name = "Members";
    if (mode === "classduplicate") value.schedules[0].booking_classes.push({ ...value.schedules[0].booking_classes[0] });
    expect(() => bindForeupOfficialRouteConfiguration(mode === "copy" ? structuredClone(contact) : contact, html(value))).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  });
  it("cold inspector uses actual native ownership only after legacy name matching fails", async () => {
    const d = deps(), observed = await inspectExistingAdapter(source, d);
    expect(observed.adapter).toMatchObject({ family: "FOREUP", facilityId: 12345, scheduleId: 456, officialRouteOwnershipProof: { publicCoursePhone: phone } });
    expect(d.readNativeOfficialPage).toHaveBeenCalledOnce();expect(d.fetch).toHaveBeenCalledTimes(2);
    await expect(inspectExistingAdapter(source, { ...deps(), localCapabilities: [] })).rejects.toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
    await expect(inspectExistingAdapter(source, { ...deps(), trustedContext: {} })).rejects.toThrow("ADAPTER_CONFIGURATION_UNVERIFIED");
    await expect(inspectExistingAdapter(source, { ...deps(), readNativeOfficialPage: async () => page() })).rejects.toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  });
  it("binds a declared Standard Public native proof while keeping an unknown same-sheet program outside scope", async () => {
    const value = provider();
    value.schedules[0].booking_classes.push({ teesheet_id: "456", booking_class_id: "15", name: "PreferredPlayer", active: "1", hidden: "0" });
    const contact = deriveForeupOfficialRouteContact(source, native(), phone);
    expect(() => bindForeupOfficialRouteConfiguration(contact, html(value))).toThrow("FOREUP_PUBLIC_SCHEDULE_COVERAGE_UNVERIFIED");
    const bound = bindForeupOfficialRouteConfiguration(contact, html(value), FOREUP_STANDARD_PUBLIC_SCOPE);
    expect(bound.proof).toMatchObject({ inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE, bookingClassId: 12 });
    expect(bound.proof.publicCatalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    const d = deps();
    d.fetch.mockImplementation(async raw => String(raw).includes("/api/") ? Response.json([]) :
      new Response(html(value), { headers: { "content-type": "text/html" } }));
    const observed = await inspectExistingAdapter(source, d);
    expect(observed.adapter).toMatchObject({ inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE,
      publicCatalogSha256: bound.proof.publicCatalogSha256,
      officialRouteOwnershipProof: { inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE } });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source,
      target: { kind: "OUTDOOR", courseId: "owned" }, adapter: observed.adapter });
    const altered = provider();altered.schedules[0].booking_classes.push({ teesheet_id: "456", booking_class_id: "15",
      name: "Preferred Guest", active: "1", hidden: "0" });
    const warm = deps();warm.fetch.mockImplementation(async raw => String(raw).includes("/api/") ? Response.json([]) :
      new Response(html(altered), { headers: { "content-type": "text/html" } }));
    const result = await executeExistingAdapterRecipe(recipe, input, { ...warm, recipeHash: hashAccessRecipe(recipe),
      toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z") });
    expect(result).toMatchObject({ status: "INCOMPLETE", complete: false, slots: [] });
    expect(warm.fetch).toHaveBeenCalledOnce();
  });
  it("two changed-date executions rederive the same immutable proof before availability; reassignment fails", async () => {
    const observed = await inspectExistingAdapter(source, deps()), recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source, target: { kind: "OUTDOOR", courseId: "owned" }, adapter: observed.adapter });
    const saved = JSON.stringify(recipe), hash = hashAccessRecipe(recipe);
    for (const date of ["2026-10-28", "2026-10-29"]) {
      const d = deps(); d.fetch.mockImplementation(async raw => {
        const u = new URL(String(raw)); if (!u.pathname.includes("/api/")) return new Response(html(), { headers: { "content-type": "text/html" } });
        return Response.json(u.searchParams.get("date") === date.slice(5, 7) + "-" + date.slice(8, 10) + "-" + date.slice(0, 4)
          ? [{ time: date + " 10:00", available_spots: 3, schedule_id: 456, booking_class_id: 12, holes: 18 }] : []);
      });
      const result = await executeExistingAdapterRecipe(recipe, { ...input, date }, { ...d, recipeHash: hash, toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z") });
      expect(result.complete).toBe(true);expect(result.slots).toHaveLength(1);expect(result.slots[0].availableSpots).toBe(3);
      expect(Object.values(result.evidence).filter(v => typeof v === "boolean")).toEqual([true,true,true,true,true]);expect(d.readNativeOfficialPage).toHaveBeenCalledOnce();expect(JSON.stringify(recipe)).toBe(saved);
    }
    const d = deps(), changed = provider(); changed.course.name = "Reassigned Business"; changed.schedules[0].course_name = changed.course.name;
    d.fetch.mockImplementation(async () => new Response(html(changed), { headers: { "content-type": "text/html" } }));
    const failed = await executeExistingAdapterRecipe(recipe, input, { ...d, recipeHash: hash, toInstant: recipeTimeToInstant });
    expect(failed.complete).toBe(false);expect(failed.slots).toEqual([]);expect(d.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["chrome", "phone", "copy", "link"])("rejects missing or stale %s on warm ownership before availability", async mode => {
    const observed = await inspectExistingAdapter(source, deps()), recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source, target: { kind: "OUTDOOR", courseId: "owned" }, adapter: observed.adapter }), d = deps();
    const executeDeps = { ...d, recipeHash: hashAccessRecipe(recipe), toInstant: recipeTimeToInstant };
    if (mode === "chrome") executeDeps.localCapabilities = [] as unknown as typeof executeDeps.localCapabilities;
    if (mode === "phone") executeDeps.trustedContext = { canonicalCoursePhone: "+15555559999" };
    if (mode === "copy") executeDeps.readNativeOfficialPage = vi.fn(async () => page());
    if (mode === "link") executeDeps.readNativeOfficialPage = vi.fn(async () => { const p = page(); p.visibleEvidence!.linkUrls = []; return native(p); });
    const result = await executeExistingAdapterRecipe(recipe,input,executeDeps);
    expect(result.complete).toBe(false);expect(result.slots).toEqual([]);expect(Object.values(result.evidence).filter(value=>typeof value==="boolean")).toEqual([false,false,false,false,false]);
    expect(d.fetch.mock.calls.some(([value])=>String(value).includes("/api/"))).toBe(false);
    if (mode === "chrome" || mode === "phone") expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe("canonical-root compact contact and public facility ownership", () => {
  const facilitySource = { ...source, bookingUrl: "https://foreupsoftware.com/index.php/booking/12345#/teetimes" };
  const compact = `<p>Phone: <a href="tel:${phone}">${display}</a><br>10 Example Rd, Example, NY 12345</p>`;
  const compactPage = (): OfficialIdentityPage => { const p = page(); p.html = p.html.replace(card, compact).replaceAll(source.bookingUrl, facilitySource.bookingUrl);
    p.visibleEvidence!.linkUrls = [facilitySource.bookingUrl]; p.visibleEvidence!.addressTexts = [`Phone: ${display}, 10 Example Rd, Example, NY 12345`]; return p; };
  const contact = (p = compactPage()) => deriveForeupOfficialRouteContact(facilitySource, native(p), phone);
  const compactDeps = () => ({ ...deps(), readNativeOfficialPage: vi.fn(async () => native(compactPage())) });

  it("binds the published title and sole independently printed contact to the sole public schedule, not catalog order", () => {
    const value = provider(); value.schedules.reverse();
    const observed = contact(), bound = bindForeupOfficialRouteConfiguration(observed, html(value), FOREUP_STANDARD_PUBLIC_SCOPE);
    expect(observed).toMatchObject({ contactScope: FOREUP_COMPACT_CONTACT_FACILITY_SCOPE, publicLocationName: "Example" });
    expect(observed).not.toHaveProperty("rootDocumentProof");
    const { sourceWitnessSha256, ...witnessBody } = observed;
    expect(sourceWitnessSha256).toBe(foreupOwnershipDigest(witnessBody));
    const { contactScope: _scope, ...withoutScope } = witnessBody;
    expect(_scope).toBe(FOREUP_COMPACT_CONTACT_FACILITY_SCOPE);
    expect(sourceWitnessSha256).not.toBe(foreupOwnershipDigest(withoutScope));
    expect(bound.proof).toMatchObject({ contactScope: FOREUP_COMPACT_CONTACT_FACILITY_SCOPE, bookingUrl: facilitySource.bookingUrl,
      scheduleId: 456, bookingClassId: 12, inventoryScope: FOREUP_STANDARD_PUBLIC_SCOPE });
    expect(bound.proof.publicCatalogSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(foreupOfficialRouteOwnershipProofSchema.parse(bound.proof)).toEqual(bound.proof);
    expect(foreupOfficialRouteOwnershipProofSchema.safeParse({ ...bound.proof, contactScope: undefined }).success).toBe(false);
    const old = bindForeupOfficialRouteConfiguration(deriveForeupOfficialRouteContact(source, native(), phone), html());
    expect(bound.proof.providerWitnessSha256).toBe(old.proof.providerWitnessSha256);
    expect(() => bindForeupOfficialRouteConfiguration(observed, html(value))).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
    expect(foreupOfficialRouteOwnershipProofSchema.safeParse({ ...old.proof, contactScope: FOREUP_COMPACT_CONTACT_FACILITY_SCOPE }).success).toBe(false);
  });

  it("collapses rendered wrapper repetitions without accepting multiple raw contacts", () => {
    const p = compactPage(); p.visibleEvidence!.addressTexts.push(p.visibleEvidence!.addressTexts[0]);
    expect(contact(p).contactScope).toBe(FOREUP_COMPACT_CONTACT_FACILITY_SCOPE);
    p.html = p.html.replace("</body>", `${compact}</body>`);
    expect(() => contact(p)).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  });

  it.each(["partial", "street", "zip", "phone", "tel-target", "two-contacts", "hidden", "mailing", "private", "rendered", "omitted", "title", "facility", "selected-route", "subpage"])(
    "rejects %s root evidence without filling missing fields or changing the route scope", mode => {
      const p = compactPage();
      if (mode === "partial") p.html = p.html.replace("10 Example Rd, ", "");
      if (mode === "street") p.html = p.html.replace("10 Example Rd", "11 Example Rd");
      if (mode === "zip") p.html = p.html.replace("12345</p>", "12346</p>");
      if (mode === "phone") p.html = p.html.replaceAll(display, "555-555-9999");
      if (mode === "tel-target") p.html = p.html.replace(`tel:${phone}`, "tel:+15555559999");
      if (mode === "two-contacts") p.html = p.html.replace("</body>", `${compact.replaceAll(display, "555-555-9999").replaceAll(phone, "+15555559999")}</body>`);
      if (mode === "hidden") p.html = p.html.replace(compact, `<div hidden>${compact}</div>`);
      if (mode === "mailing") p.html = p.html.replace(compact, `<div class="mailing">${compact}</div>`);
      if (mode === "private") p.html = p.html.replace(compact, `<div class="member">${compact}</div>`);
      if (mode === "rendered") p.visibleEvidence!.addressTexts = [`Phone: ${display}, 11 Example Rd, Example, NY 12345`];
      if (mode === "omitted") p.visibleEvidence!.phoneTextsOmitted = true;
      if (mode === "title") { p.html = p.html.replace("Example | County", "Other Course | County"); p.visibleEvidence!.title = "Other Course | County"; }
      if (mode === "facility") p.html = p.html.replace(facilitySource.bookingUrl, facilitySource.bookingUrl.replace("12345", "54321"));
      if (mode === "selected-route") p.html = p.html.replace(facilitySource.bookingUrl, source.bookingUrl);
      if (mode === "subpage") p.url = `${source.officialUrl}contact/`;
      expect(() => contact(p)).toThrow("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
    });

  it.each(["address", "phone", "zone", "two-public", "unknown-sibling", "duplicate-course", "duplicate-sheet", "current"])(
    "rejects %s provider identity or whole-catalog ambiguity before accepting any schedule", mode => {
      const value = provider();
      if (mode === "address") value.course.address = "11 Example Rd";
      if (mode === "phone") value.course.phone = "555-555-9999";
      if (mode === "zone") value.course.timezone = "America/Chicago";
      if (mode === "two-public") value.schedules[1].booking_classes[0].name = "Public";
      if (mode === "unknown-sibling") value.schedules[1].booking_classes[0].name = "Unverified Audience";
      if (mode === "duplicate-course") value.courses.push({ ...value.course });
      if (mode === "duplicate-sheet") value.schedules.push(structuredClone(value.schedules[1]));
      if (mode === "current") value.courses = [{ ...value.course, phone: "555-555-9999" }];
      expect(() => bindForeupOfficialRouteConfiguration(contact(), html(value), FOREUP_STANDARD_PUBLIC_SCOPE)).toThrow();
    });

  it("rediscovers the scoped facility proof on each independent replay and rejects a changed public schedule", async () => {
    const observed = await inspectExistingAdapter(facilitySource, compactDeps());
    expect(observed.adapter).toMatchObject({ family: "FOREUP", scheduleId: 456, officialRouteOwnershipProof: { contactScope: FOREUP_COMPACT_CONTACT_FACILITY_SCOPE } });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", source: facilitySource,
      target: { kind: "OUTDOOR", courseId: "synthetic-compact-course" }, adapter: observed.adapter });
    const saved = JSON.stringify(recipe), hash = hashAccessRecipe(recipe);
    for (const date of ["2026-10-28", "2026-10-29"]) {
      const d = compactDeps(); d.fetch.mockImplementation(async raw => new URL(String(raw)).pathname.includes("/api/")
        ? Response.json([{ time: `${date} 10:00`, available_spots: 3, schedule_id: 456, booking_class_id: 12, holes: 18 }])
        : new Response(html(), { headers: { "content-type": "text/html" } }));
      const result = await executeExistingAdapterRecipe(parseAccessRecipe(JSON.parse(saved)), { ...input, date },
        { ...d, recipeHash: hash, toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z") });
      expect(result).toMatchObject({ complete: true, status: "AVAILABLE", slots: [{ availableSpots: 3, bookingUrl: facilitySource.bookingUrl }] });
      expect(d.readNativeOfficialPage).toHaveBeenCalledOnce();
    }
    const d = compactDeps(), changed = provider(); changed.schedules[1].booking_classes[0].name = "Public";
    d.fetch.mockImplementation(async () => new Response(html(changed), { headers: { "content-type": "text/html" } }));
    expect(await executeExistingAdapterRecipe(recipe, input, { ...d, recipeHash: hash, toInstant: recipeTimeToInstant })).toMatchObject({ complete: false, slots: [] });
    expect(d.fetch).toHaveBeenCalledOnce();
  });
});
