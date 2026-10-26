import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTeeItUpStreetTypeOmittedProof as bind, isTeeItUpStreetTypeOmissionCandidate, matchesTeeItUpStreetTypeOmittedDirectory, teeItUpStreetTypeOmittedProofSchema,
  getTeeItUpStreetTypeOmittedDiagnostic, observeTeeItUpStreetTypeOmittedFacts } from "./teeitup-street-type-omitted-proof";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { completeUSAddress, type OfficialIdentityPage } from "./teeitup-official-identity";
import { teeItUpCompleteStreetAddress } from "./teeitup-official-booking-source";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import { getFixedAdapterReadDiagnostic } from "./fixed-adapter-read-diagnostic";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://new-harbor.book.teeitup.com/", venueName: "Example Harbor Golf Course",
  venueAddress: "10 N Harbor View E Unit 2, Example, NY 12345-6789, USA", timeZone: "America/New_York", providerFamily: "TEEITUP" };
const phone = "+19165554653";
const configuration = { apiAlias: "prior-harbor", facilityIds: [31] };
const row = { id: 31, courseId: "provider-31", name: source.venueName, address: "10 North Harbor View Road East Unit 2, Example, NY 12345-6789, US",
  timeZone: source.timeZone, country: "US", isSimulator: false, phone };
const input = { date: "2030-10-27", players: 2, timeZone: source.timeZone, startTime: "08:00", endTime: "18:00" };
const deps = { now: () => new Date("2030-10-25T12:00:00Z"), recipeHash: "a".repeat(64), venueMatches: venueProofMatches, toInstant: recipeTimeToInstant,
  requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }),
  localCapabilities: ["LOCAL_CHROME"] as const, trustedContext: { canonicalCoursePhone: phone } };
const markup = () => `<title>${source.venueName}</title><h1>${source.venueName}</h1><address>${source.venueAddress}</address>` +
  `<a href="${source.bookingUrl}">Tee Times</a><a href="tel:${phone}">916-555-4653</a>`;
function locatedPage() {
  const contact = `<section><h3>${source.venueName}</h3><div><p>${source.venueAddress}</p><p>Directions</p></div><div><a href="tel:${phone}">Call Us</a><a href="mailto:public@example.org">Email Us</a></div></section>`;
  const html = `<title>Home - Example Harbor Golf</title><h2>Welcome to ${source.venueName}</h2><h1>“</h1><h1>Amazing Experiences</h1>${contact}` +
    `<a href="${source.bookingUrl}">Tee Times</a><footer><a href="tel:${phone}">(916) 555-4653 - Golf Course</a><a href="tel:9165554654">(916) 555-4654 - Restaurant</a></footer>`;
  return native({ html, visibleEvidence: { title: "Home - Example Harbor Golf", headings: [`Welcome to ${source.venueName}`, "Amazing Experiences"],
    addressTexts: [source.venueAddress, `${source.venueName}, ${source.venueAddress}, Directions, CALL US EMAIL US`],
    linkUrls: [source.bookingUrl, `tel:${phone}`, "tel:9165554654"], phoneTexts: ["CALL US", "(916) 555-4653 - Golf Course", "(916) 555-4654 - Restaurant"] } });
}
function native(change: Partial<OfficialIdentityPage> = {}, root = source.officialUrl) {
  const page: OfficialIdentityPage = { url: source.officialUrl, html: markup(), browserTransport: "NATIVE_CHROME", visibleEvidence: {
    title: source.venueName, headings: [source.venueName], addressTexts: [source.venueAddress], linkUrls: [source.bookingUrl], phoneTexts: ["916-555-4653"] }, ...change };
  return registerFreshNativeOfficialIdentityPage(page, root, new Date(Date.now() + 30_000));
}
const proof = () => bind(source, native(), [row], configuration, phone);
const configHtml = () => `<script>self.__next_f.push(${JSON.stringify([1, `0:${JSON.stringify({ alias: configuration.apiAlias, gnFacilityIds: [31], name: source.venueName })}\n`])})</script>`;
function reads(rows: unknown = [row], config = configHtml()) {
  return vi.fn<typeof fetch>(async value => {
    const url = new URL(String(value));
    if (url.href === source.bookingUrl) return new Response(config, { headers: { "content-type": "text/html" } });
    if (url.pathname === "/alias/new-harbor/facilities") return new Response("not found", { status: 404 });
    if (url.pathname.endsWith("/facilities")) return Response.json(rows);
    return Response.json([{ courseId: row.courseId, teetimes: [{ courseId: row.courseId, teetime: `${url.searchParams.get("date")}T15:00:00Z`, rates: [{ allowedPlayers: [2, 3, 4], holes: 18 }] }] }]);
  });
}
afterEach(() => vi.useRealTimers());

describe("explicit fresh-native canonical street type omission", () => {
  it("accepts a constrained branding title and decorative H1s only with exact full named physical contact and raw/visible course telephone", () => {
    const page = locatedPage();
    expect(bind(source, page, [row], configuration, phone)).toMatchObject({ canonicalStreetType: null, publicCoursePhone: phone });
    expect(observeTeeItUpStreetTypeOmittedFacts(source, page, [row], configuration, phone)).toMatchObject({ titleNameMatches: true, foreignH1Absent: true,
      namedVisibleContactBlockPresent: true, rawTelephoneAllMatch: true, visiblePhoneAllMatch: true });
  });
  it.each(["name", "address", "hidden", "foreignTitle", "foreignH1", "numericLabel", "callHref", "courseHref", "courseLabel", "unknownLabel", "restaurantMismatch", "visibleBlock", "visibleCourse", "visibleLink", "duplicateBlock"])
  ("does not borrow a named contact/department proof with %s", change => {
    const p = structuredClone(locatedPage());
    if (change === "name") p.html = p.html.replace(`<h3>${source.venueName}</h3>`, "<h3>Other Golf Course</h3>");
    if (change === "address") p.html = p.html.replace(`<p>${source.venueAddress}</p>`, `<p>${source.venueAddress.replace("10 N", "11 N")}</p>`);
    if (change === "hidden") p.html = p.html.replace("<section>", "<section hidden>");
    if (change === "foreignTitle") p.html = p.html.replace("Home - Example Harbor Golf", "Home - Other Harbor Golf");
    if (change === "foreignH1") p.html += "<h1>Other Harbor Golf Course</h1>";
    if (change === "numericLabel") p.html = p.html.replace(">Call Us<", ">916-555-4654<");
    if (change === "callHref") p.html = p.html.replace(`tel:${phone}`, "tel:9165554654");
    if (change === "courseHref") p.html = p.html.replace(`<footer><a href="tel:${phone}">`, '<footer><a href="tel:9165554654">');
    if (change === "courseLabel") p.html = p.html.replace("(916) 555-4653 - Golf Course", "(916) 555-4654 - Golf Course");
    if (change === "unknownLabel") p.html = p.html.replace("- Restaurant", "- Other Department");
    if (change === "restaurantMismatch") p.html = p.html.replace("(916) 555-4654 - Restaurant", "(916) 555-4655 - Restaurant");
    if (change === "visibleBlock") p.visibleEvidence!.addressTexts = [source.venueAddress];
    if (change === "visibleCourse") p.visibleEvidence!.phoneTexts = ["CALL US", "(916) 555-4654 - Restaurant"];
    if (change === "visibleLink") p.visibleEvidence!.linkUrls = [source.bookingUrl];
    if (change === "duplicateBlock") p.html += p.html.slice(p.html.indexOf("<section>"), p.html.indexOf("</section>") + 10);
    const current = native(p);
    expect(() => bind(source, current, [row], configuration, phone)).toThrow("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
  });
  it("a restaurant number can never substitute for current canonical/provider/course telephone", () => {
    expect(() => bind(source, locatedPage(), [{ ...row, phone: "9165554654" }], configuration, "9165554654")).toThrow();
  });
  it("keeps missing type null, both originals and full ZIP/directions/unit; legacy typed parsers stay strict", () => {
    expect(isTeeItUpStreetTypeOmissionCandidate(source.venueAddress)).toBe(true);
    expect(completeUSAddress(source.venueAddress)).toBeNull();
    expect(teeItUpCompleteStreetAddress(source.venueAddress)).toBeUndefined();
    const result = proof();
    expect(result).toMatchObject({ kind: "OFFICIAL_STREET_TYPE_OMITTED", canonicalStreetType: null, providerStreetType: "rd",
      canonicalAddress: source.venueAddress, providerAddress: row.address, officialUrl: source.officialUrl,
      officialDocumentUrl: source.officialUrl, publicCoursePhone: phone, requiredCapability: "LOCAL_CHROME" });
    expect(result.semanticDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(matchesTeeItUpStreetTypeOmittedDirectory(result, source, [row], configuration)).toBe(true);
  });
  it.each([
    { address: row.address.replace("10 North", "11 North") }, { address: row.address.replace("North", "South") },
    { address: row.address.replace("Harbor View", "Other View") }, { address: row.address.replace("East", "West") },
    { address: row.address.replace("Unit 2", "Unit 3") }, { address: row.address.replace("12345-6789", "12345-6790") },
    { address: row.address.replace("12345-6789", "12345") }, { address: row.address.replace("Example,", "Other,") },
    { address: row.address.replace("NY", "CA") }, { address: row.address.replace(", US", ", Canada") },
    { name: "Other Harbor Golf Course" }, { timeZone: "America/Chicago" }, { phone: "+19165554654" },
    { phone: "9165554653 ext 2" }, { country: "CA" }, { country: undefined }, { isSimulator: true }, { isSimulator: undefined },
  ])("rejects every additional provider conflict (%j)", change => {
    expect(() => bind(source, native(), [{ ...row, ...change }], configuration, phone)).toThrow("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
  });
  it("rejects ambiguous directory identities, config mismatch, absent or changed canonical telephone", () => {
    expect(() => bind(source, native(), [row, { ...row, id: 32, courseId: "provider-32" }], configuration, phone)).toThrow();
    expect(() => bind(source, native(), [row, row], configuration, phone)).toThrow();
    expect(() => bind(source, native(), [row], { ...configuration, facilityIds: [32] }, phone)).toThrow();
    for (const p of [undefined, "9165554654", "9165554653 extension 1"]) expect(() => bind(source, native(), [row], configuration, p)).toThrow();
    expect(() => bind({ ...source, venueAddress: source.venueAddress.replace("Harbor View E", "Harbor View Road E") }, native(), [row], configuration, phone)).toThrow();
  });
  it.each(["address", "link", "phone", "name"])("rejects hidden raw %s even with forged visible text", kind => {
    const tag = { address: "<address>", link: `<a href="${source.bookingUrl}"`, phone: `<a href="tel:${phone}"`, name: "<h1>" }[kind]!;
    const replacement = tag.endsWith(">") ? tag.slice(0, -1) + " hidden>" : tag + " hidden";
    expect(() => bind(source, native({ html: markup().replace(tag, replacement) }), [row], configuration, phone)).toThrow();
  });
  it("requires original attested page identity, unchanged object, unexpired native root and all rendered evidence", () => {
    const page = native(); expect(() => bind(source, structuredClone(page), [row], configuration, phone)).toThrow();
    page.html += " "; expect(() => bind(source, page, [row], configuration, phone)).toThrow();
    expect(() => bind(source, native({}, "https://foreign.example/"), [row], configuration, phone)).toThrow();
    expect(() => bind(source, native({ browserTransport: "PINNED_HTTP" }), [row], configuration, phone)).toThrow();
    for (const field of ["headings", "addressTexts", "linkUrls", "phoneTexts"] as const) {
      const visible = native().visibleEvidence!;
      expect(() => bind(source, native({ visibleEvidence: { ...visible, [field]: [] } }), [row], configuration, phone)).toThrow();
    }
    vi.useFakeTimers(); const expired = native(); vi.advanceTimersByTime(30_001);
    expect(() => bind(source, expired, [row], configuration, phone)).toThrow();
  });
  it("a known official street type must match provider; a changed type cannot be hidden in the unknown canonical field", () => {
    const html = markup().replace(source.venueAddress, row.address);
    expect(() => bind(source, native({ html }), [{ ...row, address: row.address.replace("Road", "Street") }], configuration, phone)).toThrow();
  });
  it.each(["Mailing Address", "Corporate Address", "Billing Address", "Headquarters"])("does not use %s as physical identity", label => {
    const html = markup().replace(`<address>${source.venueAddress}</address>`, `<section><h2>${label}</h2><p>${source.venueAddress}</p></section>`);
    expect(() => bind(source, native({ html }), [row], configuration, phone)).toThrow();
  });
  it("checks exact current source, configuration and semantic digest when resolving serialized metadata", () => {
    const p = proof();
    for (const changed of [{ ...p, semanticDigest: "a".repeat(64) }, { ...p, providerAddress: row.address.replace("Road", "Street") }])
      expect(matchesTeeItUpStreetTypeOmittedDirectory(changed, source, [row], configuration)).toBe(false);
    expect(matchesTeeItUpStreetTypeOmittedDirectory(p, { ...source, bookingUrl: "https://foreign.book.teeitup.com/" }, [row], configuration)).toBe(false);
    expect(matchesTeeItUpStreetTypeOmittedDirectory(p, source, [row], { ...configuration, apiAlias: "foreign" })).toBe(false);
    const recipe = { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" }, source,
      adapter: { family: "TEEITUP", alias: p.alias, facilityIds: [31], publicBookingConfiguration: configuration, officialStreetTypeOmittedProof: p } };
    expect(() => parseAccessRecipe({ ...recipe, source: { ...source, venueAddress: source.venueAddress.replace("Unit 2", "Unit 3") } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, offeringKind: "SIMULATOR" } })).toThrow();
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...recipe.adapter, publicBookingConfiguration: undefined } })).toThrow();
  });
  it("semantic digest survives JSON key ordering but rejects a valid-shape wrong digest or mutated known type", () => {
    const p = proof(), reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(teeItUpStreetTypeOmittedProofSchema.parse(reordered)).toEqual(p);
    expect(() => teeItUpStreetTypeOmittedProofSchema.parse({ ...p, semanticDigest: "a".repeat(64) })).toThrow();
    expect(() => teeItUpStreetTypeOmittedProofSchema.parse({ ...p, providerStreetType: "st" })).toThrow();
  });
  it("closed diagnostics retain the first unchanged failure and independently observe later gates without leaking source values", () => {
    const page = native({ html: markup().replace(`<title>${source.venueName}</title>`, "<title>Home - Example Harbor Golf</title>").replace("916-555-4653</a>", "CALL US</a>") });
    let error: unknown;
    try { bind(source, page, [row], configuration, phone); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toBe("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
    const d = getTeeItUpStreetTypeOmittedDiagnostic(error)!;
    expect(d).toMatchObject({ stage: "RAW_IDENTITY", gates: { titleNameMatches: false, rawBookingLinkPresent: true, rawBookingLinksAllExact: true,
      rawTelephoneHrefAllMatch: true, rawTelephoneTextAllMatch: false, rawTelephoneAllMatch: false, nonTypeComponentsEqual: true, nativeAttestationFreshAfter: true } });
    expect(Object.values(d.gates).every(v => typeof v === "boolean" || v === null)).toBe(true);
    expect(JSON.stringify(d)).not.toContain(source.venueName); expect(JSON.stringify(d)).not.toContain(phone); expect(JSON.stringify(d)).not.toContain("https:");
    d.gates.titleNameMatches = true; expect(getTeeItUpStreetTypeOmittedDiagnostic(error)!.gates.titleNameMatches).toBe(false);
    expect(getTeeItUpStreetTypeOmittedDiagnostic(new Error("FOREIGN"))).toBeUndefined();
    expect(observeTeeItUpStreetTypeOmittedFacts(source, structuredClone(page), [row], configuration, phone).nativeAttestationFresh).toBe(false);
  });
  it("initial inspection refreshes outside leases; one immutable recipe revalidates native proof on two changed dates", async () => {
    let held = false, nativeCalls = 0;
    const lease = async <T>(_family: string, work: () => Promise<T>) => { expect(held).toBe(false); held = true; try { return { acquired: true as const, value: await work() }; } finally { held = false; } };
    const readNativeOfficialPage = vi.fn(async () => { expect(held).toBe(false); nativeCalls++; return native(); });
    const common = { ...deps, requestLease: lease, readNativeOfficialPage };
    const observed = await inspectExistingAdapter(source, { ...common, fetch: reads() });
    expect(observed.adapter).toMatchObject({ family: "TEEITUP", publicBookingConfiguration: configuration, officialStreetTypeOmittedProof: { canonicalStreetType: null } });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" }, source, adapter: observed.adapter });
    if (recipe.engine !== "EXISTING_ADAPTER") throw Error("WRONG_ENGINE");
    const unchanged = JSON.stringify(recipe);
    for (const date of ["2030-10-27", "2030-10-28"]) {
      const result = await executeExistingAdapterRecipe(recipe, { ...input, date }, { ...common, fetch: reads() });
      expect(result).toMatchObject({ complete: true, evidence: { venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } });
      expect(result.slots).toHaveLength(1); expect(result.slots[0].startsAt.startsWith(date)).toBe(true);
      expect(JSON.stringify(recipe)).toBe(unchanged);
    }
    expect(nativeCalls).toBe(3);
  });
  it("warm missing capability, phone drift, copied page, stale page and provider type drift fail before availability", async () => {
    const adapter = (await inspectExistingAdapter(source, { ...deps, fetch: reads(), readNativeOfficialPage: async () => native() })).adapter;
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned-course", kind: "OUTDOOR" }, source, adapter });
    if (recipe.engine !== "EXISTING_ADAPTER") throw Error("WRONG_ENGINE");
    for (const change of [
      { localCapabilities: [] as readonly "LOCAL_CHROME"[] }, { trustedContext: {} },
      { trustedContext: { canonicalCoursePhone: "+19165554654" } }, { readNativeOfficialPage: async () => structuredClone(native()) },
      { fetch: reads([{ ...row, address: row.address.replace("Road", "Street") }]) },
    ]) {
      const fetch = reads();
      const result = await executeExistingAdapterRecipe(recipe, input, { ...deps, readNativeOfficialPage: async () => native(), fetch, ...change });
      expect(result.complete).toBe(false); expect(result.slots).toEqual([]);
      expect(fetch.mock.calls.some(([v]) => String(v).includes("/v2/tee-times"))).toBe(false);
    }
  });
  it("retains the original directory diagnostics when a later delegated failure remains primary", async () => {
    const typed = { ...source, venueAddress: source.venueAddress.replace("Harbor View E", "Harbor View Road E") };
    const original = new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{ ...row, address: row.address.replace("10 North", "12 North") }]));
    try { await inspectExistingAdapter(typed, { ...deps, fetch, readDelegatedRoot: async () => { throw original; } }); throw Error("EXPECTED"); }
    catch (error) { expect(error).toBe(original); expect(getFixedAdapterReadDiagnostic(error)).toMatchObject({ role: "TEEITUP_DIRECTORY", stage: "RESPONSE_BODY", httpStatus: 200, transportCode: "NONE" }); }
  });
  it("retains directory facts but not its authority when the fresh omission root capture fails", async () => {
    const original = new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    try { await inspectExistingAdapter(source, { ...deps, fetch: reads(), readNativeOfficialPage: async () => { throw original; } }); throw Error("EXPECTED"); }
    catch (error) { expect(error).toBe(original); expect(getFixedAdapterReadDiagnostic(error)).toMatchObject({ role: "TEEITUP_DIRECTORY", stage: "RESPONSE_BODY", httpStatus: 200 }); }
  });
  it("passes the caller's earlier absolute deadline to native refresh without renewing it", async () => {
    const deadlineAt = new Date(Date.now() + 1200);
    const reader = vi.fn(async (_source, _url, deadline: Date) => { expect(deadline.getTime()).toBeLessThanOrEqual(deadlineAt.getTime()); return native(); });
    await inspectExistingAdapter(source, { ...deps, now: () => new Date(), deadlineAt, fetch: reads(), readNativeOfficialPage: reader });
    expect(reader).toHaveBeenCalledOnce();
  });
  it("rejects a fresh-root capture that has expired before directory binding and an already-expired caller", async () => {
    vi.useFakeTimers();
    const expired = native(); vi.advanceTimersByTime(30_001);
    await expect(inspectExistingAdapter(source, { ...deps, fetch: reads(), readNativeOfficialPage: async () => expired })).rejects.toThrow("OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED");
    const fetch = reads();
    await expect(inspectExistingAdapter(source, { ...deps, now: () => new Date(), deadlineAt: new Date(Date.now() - 1), fetch })).rejects.toThrow("DEADLINE_EXCEEDED");
    expect(fetch).not.toHaveBeenCalled();
  });
});
