import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveNativePhysicalContactSource, bindTeeItUpPhysicalContactFacility, teeItUpPhysicalContactProofSchema, getTeeItUpPhysicalContactDiagnostic } from "./teeitup-physical-contact-proof";
import { registerFreshNativeOfficialIdentityPage, registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import { readTeeItUpDelegatedBookingChain } from "./teeitup-delegated-booking-reader";
import { consumeDelegatedGet, currentNativeDelegatedChain } from "./teeitup-delegated-booking-context";
import { bindDelegatedFacility } from "./teeitup-delegated-booking-source";
import { executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { recipeTimeToInstant, venueProofMatches } from "./executor";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
const source = { officialUrl: "https://public.example/", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Golf Club and Restaurant",
  venueAddress: "10 N Harbor Pkwy, Example, NY 12345-6789, USA", timeZone: "America/New_York", providerFamily: "TEEITUP" };
const current = "https://www.public.example/", publicName = "Harbor Golf Club", brand = publicName + " (XYZ)", phone = "+19165554653";
const directory = [{ id: 71, courseId: "provider-71", name: brand, address: "10 North Harbor Parkway, Other City, NY 12345-6789, US", locality: "Other City", region: "NY", country: "US", timeZone: source.timeZone, isSimulator: false, phone }];
function page(change: Partial<OfficialIdentityPage> = {}, originalSource = source.officialUrl) {
  const p: OfficialIdentityPage = { url: current, browserTransport: "NATIVE_CHROME", html: `<title>Home - ${brand}</title><p class="site-title"><a href="${current}">${brand}</a></p>` +
    `<nav><a href="#grille">Grille Restaurant</a></nav><footer><h2>Visit Us</h2><div>${publicName}<br>10 N Harbor<br>Parkway<br>Example, NY 12345-6789<br>USA</div>` +
    `<h2>Contact Us</h2><a href="tel:${phone}">916-555-4653</a></footer><a href="${source.bookingUrl}">Book Tee Times</a>`,
    visibleEvidence: { title: `Home - ${brand}`, headings: ["Footer"], addressTexts: [`${publicName}, 10 N Harbor, Parkway, Example, NY 12345-6789, USA`],
      linkUrls: [source.bookingUrl, current, `tel:${phone}`], phoneTexts: ["916-555-4653"], brandLinks: [{ href: current, text: brand }], publicBusinessLabels: ["Grille Restaurant"] }, ...change };
  return registerFreshNativeOfficialIdentityPage(p, originalSource, new Date(Date.now() + 30000), { requestedUrl: originalSource, redirects: [{ fromUrl: originalSource, toUrl: current, status: 301, completed: true }] });
}
const derive = (p = page(), s = source, pPhone: unknown = phone) => deriveNativePhysicalContactSource(s, p, pPhone);
afterEach(() => vi.useRealTimers());
describe("explicit native physical contact identity", () => {
  it("retains all literal names, observed service/location label and different provider locality without claiming string equivalence", () => {
    const contact = derive(), bound = bindTeeItUpPhysicalContactFacility(source, contact, directory);
    expect(bound).toMatchObject({ facilityId: 71, courseId: "provider-71", physicalContactProof: { kind: "OFFICIAL_PHYSICAL_CONTACT_BINDING_V1", canonicalName: source.venueName,
      officialBrandName: brand, publicLocationName: publicName, providerName: brand, brandLocationLabel: "XYZ", canonicalNameRelation: "PUBLIC_LOCATION_AND_OBSERVED_SERVICE",
      serviceRemainder: "Restaurant", observedServiceLabel: "Grille Restaurant", canonicalLocality: "example", officialLocality: "example", providerLocality: "other city", providerLocalityRelation: "DIFFERENT_RECORDED" } });
    expect(teeItUpPhysicalContactProofSchema.parse(JSON.parse(JSON.stringify(bound.physicalContactProof)))).toEqual(bound.physicalContactProof);
  });
  it.each([
    { address: directory[0].address.replace("10 North", "11 North") }, { address: directory[0].address.replace("North", "South") },
    { address: directory[0].address.replace("Harbor", "Other") }, { address: directory[0].address.replace("Parkway", "Road") },
    { address: directory[0].address.replace("Parkway,", "Parkway Unit 2,") }, { address: directory[0].address.replace("NY", "CA") },
    { address: directory[0].address.replace("12345-6789", "12345") }, { address: directory[0].address.replace("12345-6789", "12345-6790") },
    { address: directory[0].address.replace(", US", ", Canada") }, { country: "CA" }, { country: undefined }, { isSimulator: true }, { isSimulator: undefined },
    { phone: "+19165554654" }, { phone: undefined }, { phone: "9165554653 extension 1" }, { timeZone: "America/Chicago" }, { name: publicName },
    { name: "Other Golf Club (XYZ)" }, { locality: "Conflicting City" }, { region: "CA" }, { postalCode: "12345" },
  ])("rejects any additional provider mismatch (%j)", change => {
    expect(() => bindTeeItUpPhysicalContactFacility(source, derive(), [{ ...directory[0], ...change }])).toThrow("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED");
  });
  it("rejects duplicate/ambiguous physical candidates, including a differently named duplicate", () => {
    for (const rows of [[directory[0], directory[0]], [directory[0], { ...directory[0], id: 72, courseId: "provider-72" }],
      [directory[0], { ...directory[0], id: 72, courseId: "provider-72", name: "Another Name" }]])
      expect(() => bindTeeItUpPhysicalContactFacility(source, derive(), rows)).toThrow();
  });
  it("uses an independently complete named descendant rather than ancestor section-heading aggregation", () => {
    const original = page(), html = original.html.replace(`<div>${publicName}`, `<div><h4>VISIT US</h4><div><div>${publicName}`).replace("</div><h2>Contact", "</div></div></div><h2>Contact");
    expect(derive(page({ html })).publicLocationName).toBe(publicName);
    // A separate full physical contact remains a conflicting location.
    expect(() => derive(page({ html: html + '<div>Other Golf Club<br>20 Other Road<br>Other City, NY 12345-6789</div>' }))).toThrow();
  });
  it("retains only closed facts on the original failure with copied diagnostics and unknown later gates", () => {
    const original = page();let failure: unknown;
    try { derive(page({ visibleEvidence: { ...original.visibleEvidence!, publicBusinessLabels: [] } })); } catch (error) { failure = error; }
    const d = getTeeItUpPhysicalContactDiagnostic(failure)!;
    expect(d.stage).toBe("SERVICE");expect(d.gates.physicalBlockUnique).toBe(true);expect(d.gates.observedServiceBinding).toBe(false);expect(d.gates.visiblePhonesMatch).toBeNull();
    d.gates.observedServiceBinding = true;expect(getTeeItUpPhysicalContactDiagnostic(failure)?.gates.observedServiceBinding).toBe(false);
    expect(getTeeItUpPhysicalContactDiagnostic(new Error("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED"))).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain(source.bookingUrl);expect(JSON.stringify(d)).not.toContain(publicName);expect(JSON.stringify(d)).not.toContain(phone);
  });
  it.each(["brand", "physicalName", "street", "locality", "service", "serviceNegation", "hiddenBlock", "privateBlock", "form", "bookLink", "phoneHref", "phoneText", "extraPhone", "secondLocation"])
  ("rejects conflicting, hidden or unscoped public %s", change => {
    let html = page().html;
    if (change === "brand") html = html.replace(`<a href="${current}">${brand}`, `<a href="${current}">Other Golf Club (XYZ)`);
    if (change === "physicalName") html = html.replace(`${publicName}<br>`, "Other Golf Club<br>");
    if (change === "street") html = html.replace("10 N Harbor", "11 N Harbor");
    if (change === "locality") html = html.replace("Example, NY", "Other City, NY");
    if (change === "service") html = html.replace("Grille Restaurant", "Grille Dining");
    if (change === "serviceNegation") html = html.replace("Grille Restaurant", "No Restaurant");
    if (change === "hiddenBlock") html = html.replace("<div>", "<div hidden>");
    if (change === "privateBlock") html = html.replace("<div>", '<div class="billing">');
    if (change === "form") html = html.replace("<div>", "<form><div>").replace("</div>", "</div></form>");
    if (change === "bookLink") html = html.replace(source.bookingUrl, "https://foreign.book.teeitup.com/");
    if (change === "phoneHref") html = html.replace(`tel:${phone}`, "tel:9165554654");
    if (change === "phoneText") html = html.replace(">916-555-4653<", ">916-555-4654<");
    if (change === "extraPhone") html += '<a href="tel:9165554654">916-555-4654</a>';
    if (change === "secondLocation") html += `<div>Other Golf Club<br>20 Other Road<br>Elsewhere, NY 12345-6789</div>`;
    expect(() => derive(page({ html }))).toThrow("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED");
  });
  it.each(["title", "brand", "address", "phone", "service", "link"])("requires independently computed-visible %s", field => {
    const visible = { ...page().visibleEvidence! };
    if (field === "title") visible.title = "Other";
    if (field === "brand") visible.brandLinks = [];
    if (field === "address") visible.addressTexts = [];
    if (field === "phone") visible.phoneTexts = [];
    if (field === "service") visible.publicBusinessLabels = [];
    if (field === "link") visible.linkUrls = [];
    expect(() => derive(page({ visibleEvidence: visible }))).toThrow();
  });
  it.each(["Without Restaurant", "Restaurant isn't available", "Restaurant doesn’t operate"])("rejects an explicitly absent service in both current raw and visible labels: %s", label => {
    const original = page();
    expect(() => derive(page({ html: original.html.replace("Grille Restaurant", label), visibleEvidence: { ...original.visibleEvidence!, publicBusinessLabels: [label] } }))).toThrow("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED");
  });
  it("allows only literal canonical composition, not arbitrary prefixes, substrings or invented provider nicknames", () => {
    for (const name of ["Other Harbor Golf Club and Restaurant", "Harbor Golf Clubhouse and Restaurant", "Harbor Golf Club and Rest", "Harbor Golf Club and Bar"])
      expect(() => derive(page(), { ...source, venueName: name })).toThrow();
    expect(() => derive(page(), source, "+19165554654")).toThrow();
    const p = page(); expect(() => derive(structuredClone(p))).toThrow(); p.html += " "; expect(() => derive(p)).toThrow();
    vi.useFakeTimers(); const expired = page(); vi.advanceTimersByTime(30001); expect(() => derive(expired)).toThrow();
  });
  it("freshly rebuilds root contact and one direct native edge for each changed-date model-disabled execution", async () => {
    let rootCalls = 0, finalCalls = 0;
    const readDelegatedRoot = vi.fn(async () => { rootCalls++; return page(); });
    const deps = { localCapabilities: ["LOCAL_CHROME"] as const, trustedContext: { canonicalCoursePhone: phone }, readDelegatedRoot,
      readDelegatedDocument: async (_source: unknown, token: Parameters<typeof consumeDelegatedGet>[0]) => { const grant = consumeDelegatedGet(token); finalCalls++;
        return registerFreshNativeDelegatedDocument({ url: grant.url, html: "<html><body>Public Booking</body></html>", browserTransport: "NATIVE_CHROME", visibleEvidence: { title: "Public Booking", headings: [], addressTexts: [], linkUrls: [] } }, source.officialUrl, new Date(Date.now() + 30000)); } };
    const chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, deps)), proof = bindDelegatedFacility(source, chain, directory);
    expect(proof.physicalContactProof?.providerLocalityRelation).toBe("DIFFERENT_RECORDED");
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned", kind: "OUTDOOR" }, source,
      adapter: { family: "TEEITUP", alias: "harbor", facilityIds: [71], officialDelegatedBookingProof: proof } });
    if (recipe.engine !== "EXISTING_ADAPTER") throw Error("WRONG_ENGINE");
    const before = JSON.stringify(recipe);
    for (const date of ["2030-10-27", "2030-10-28"]) {
      const fetch = vi.fn<typeof globalThis.fetch>(async value => String(value).includes("/facilities") ? Response.json(directory) : Response.json([{ courseId: "provider-71", teetimes: [{ courseId: "provider-71", teetime: `${date}T15:00:00Z`, rates: [{ allowedPlayers: [2, 3, 4], holes: 18 }] }] }]));
      const result = await executeExistingAdapterRecipe(recipe, { date, players: 2, timeZone: source.timeZone, startTime: "08:00", endTime: "18:00" }, { ...deps, fetch,
        now: () => new Date("2030-10-25T12:00:00Z"), venueMatches: venueProofMatches, toInstant: recipeTimeToInstant, recipeHash: "a".repeat(64), requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) });
      expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1); expect(result.evidence).toMatchObject({ venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true });
      expect(JSON.stringify(recipe)).toBe(before);
    }
    expect(rootCalls).toBe(3); expect(finalCalls).toBe(3);
  });
});
