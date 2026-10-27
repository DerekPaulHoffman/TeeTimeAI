import { describe, expect, it } from "vitest";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { bindTeeItUpOfficialContactChain, observedTeeItUpContactUrl } from "./teeitup-official-contact-chain";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { resolveTeeItUpRecipeFacilities } from "./teeitup-recipe-source";
import { parseAccessRecipe } from "./recipe";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { recipeTimeToInstant, venueProofMatches } from "./executor";

const source = { officialUrl: "https://harbor.example/", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Country Club",
  venueAddress: "781 Shore Lane, Harbor, MA 01030", timeZone: "America/New_York" };
const contactUrl = "https://harbor.example/contact/";
const directory = [{ id: 31, courseId: "harbor-31", name: source.venueName,
  address: "Shore Lane, Harbor, MA 1030, US", country: "US", timeZone: source.timeZone, isSimulator: false }];
function page(url: string, html: string, evidence: NonNullable<OfficialIdentityPage["visibleEvidence"]>) {
  return registerFreshNativeOfficialIdentityPage({ url, html, browserTransport: "NATIVE_CHROME", visibleEvidence: evidence }, source.officialUrl, new Date(Date.now() + 25_000));
}
function pair(change: { rootHtml?: string; contactHtml?: string; contactAddress?: string; contactName?: string;
  contactLinks?: Array<{ href: string; text: string }> } = {}) {
  const rootHtml = change.rootHtml ?? `<html><h1>${source.venueName}</h1><a href="/contact/">Contact Us</a></html>`;
  const contactHtml = change.contactHtml ?? `<html><h1>Contact Us</h1><p>${change.contactName ?? source.venueName}</p><p>${source.venueAddress}</p><a href="${source.bookingUrl}">Book Tee Times</a></html>`;
  const root = page(source.officialUrl, rootHtml, { title: source.venueName, headings: [source.venueName], addressTexts: [],
    linkUrls: [contactUrl], officialContactLinkLabels: [{ href: contactUrl, text: "Contact Us" }] });
  const contact = page(contactUrl, contactHtml, { title: source.venueName, headings: ["Contact Us"],
    officialContactBusinessNames: [change.contactName ?? source.venueName],
    addressTexts: [change.contactAddress ?? source.venueAddress], linkUrls: [source.bookingUrl],
    officialContactLinkLabels: change.contactLinks ?? [{ href: source.bookingUrl, text: "Book Tee Times" }] });
  return { root, contact };
}
describe("TeeItUp official contact chain", () => {
  it("binds a current public contact address and selected booking tenant without claiming the malformed directory address", () => {
    const { root, contact } = pair();
    expect(observedTeeItUpContactUrl(source, root)).toBe(contactUrl);
    expect(bindTeeItUpOfficialContactChain(source, root, contact, directory)).toMatchObject({
      kind: "TEEITUP_OFFICIAL_CONTACT_CHAIN", facilityId: 31, providerAddressVerified: false,
      canonicalAddress: source.venueAddress, providerAddress: directory[0].address,
    });
    const proof = bindTeeItUpOfficialContactChain(source, root, contact, directory);
    expect(resolveTeeItUpRecipeFacilities(source, directory, undefined, "OUTDOOR", undefined, undefined, undefined, undefined, undefined, proof)).toHaveLength(1);
  });
  it.each([
    ["hidden contact", { rootHtml: `<h1>${source.venueName}</h1><div hidden><a href="/contact/">Contact Us</a></div>` }],
    ["form address", { contactHtml: `<h1>${source.venueName}</h1><form><p>${source.venueAddress}</p></form><a href="${source.bookingUrl}">Book Tee Times</a>` }],
    ["wrong visible address", { contactAddress: "99 Other Lane, Harbor, MA 01030" }],
    ["wrong venue", { contactName: "Other Country Club" }],
    ["changed booking link", { contactLinks: [{ href: "https://other.book.teeitup.com/", text: "Book Tee Times" }] }],
    ["uncorroborated visible booking link", { contactLinks: [
      { href: source.bookingUrl, text: "Book Tee Times" }, { href: "https://other.book.teeitup.com/", text: "Book Tee Times" },
    ] }],
  ])("rejects %s", (_label, change) => {
    const { root, contact } = pair(change);
    expect(() => bindTeeItUpOfficialContactChain(source, root, contact, directory)).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  });
  it("rejects conflicting complete provider addresses and ambiguous directory identities", () => {
    const { root, contact } = pair();
    expect(() => bindTeeItUpOfficialContactChain(source, root, contact,
      [{ ...directory[0], address: "99 Other Lane, Harbor, MA 01030" }])).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
    expect(() => bindTeeItUpOfficialContactChain(source, root, contact,
      [...directory, { ...directory[0], id: 32, courseId: "harbor-32" }])).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  });
  it("rejects unregistered or changed page objects", () => {
    const { root, contact } = pair();
    expect(() => bindTeeItUpOfficialContactChain(source, structuredClone(root), contact, directory)).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
    contact.visibleEvidence!.addressTexts = ["99 Other Lane, Harbor, MA 01030"];
    expect(() => bindTeeItUpOfficialContactChain(source, root, contact, directory)).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
  });
  it("requires the same exact fresh public chain and directory on warm replay", () => {
    const original = pair(), proof = bindTeeItUpOfficialContactChain(source, original.root, original.contact, directory);
    for (const [pages, rows] of [
      [pair({ contactAddress: "99 Other Lane, Harbor, MA 01030" }), directory],
      [pair({ contactLinks: [{ href: "https://other.book.teeitup.com/", text: "Book Tee Times" }] }), directory],
      [pair(), [{ ...directory[0], address: "99 Other Lane, Harbor, MA 01030" }]],
    ] as const) {
      expect(() => bindTeeItUpOfficialContactChain(source, pages.root, pages.contact, rows)).toThrow("OFFICIAL_CONTACT_CHAIN_UNVERIFIED");
    }
    const fresh = pair();
    expect(bindTeeItUpOfficialContactChain(source, fresh.root, fresh.contact, directory)).toEqual(proof);
  });
  it("persists only the inspected proof and rechecks a fresh contact chain before warm availability", async () => {
    let reads = 0, chains = 0, chainChange: Parameters<typeof pair>[0] = {};
    const readUrls: string[] = [];
    const fetch = async (value: RequestInfo | URL) => {
      const url = new URL(String(value)); reads++; readUrls.push(url.href);
      if (url.pathname.endsWith("/facilities")) return Response.json(directory);
      return Response.json([{ teetimes: [{ courseId: directory[0].courseId, teetime: `${url.searchParams.get("date")}T15:00:00Z`,
        rates: [{ allowedPlayers: [2, 3], holes: 18 }] }] }]);
    };
    const readOfficialContactChain = async () => { chains++; return pair(chainChange); };
    const observedRoot = pair().root;
    const deps = { fetch: fetch as typeof globalThis.fetch, venueMatches: venueProofMatches, localCapabilities: ["LOCAL_CHROME"] as const,
      officialIdentityPage: observedRoot,
      readDelegatedRoot: async () => { throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED"); }, readOfficialContactChain,
      requestLease: async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() }) };
    const observed = await inspectExistingAdapter(source, deps);
    expect(observed.adapter).toMatchObject({ family: "TEEITUP", officialContactChainProof: { providerAddressVerified: false, facilityId: 31 } });
    expect(chains).toBe(1);
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" },
      source: { ...source, providerFamily: "TEEITUP" }, adapter: observed.adapter });
    expect(() => parseAccessRecipe({ ...recipe, adapter: { ...observed.adapter, officialContactChainProof: undefined,
      offeringKind: "SIMULATOR" } })).toThrow();
    const result = await executeExistingAdapterRecipe(recipe as Extract<typeof recipe, { engine: "EXISTING_ADAPTER" }>,
      { date: "2030-10-29", timeZone: source.timeZone, players: 2, startTime: "09:00", endTime: "18:00" },
      { ...deps, recipeHash: "a".repeat(64), now: () => new Date("2030-10-20T12:00:00Z"), toInstant: recipeTimeToInstant });
    expect(result).toMatchObject({ complete: true, status: "AVAILABLE" });
    expect(chains).toBe(2); expect(reads).toBeGreaterThanOrEqual(3);
    chainChange = { contactAddress: "99 Other Lane, Harbor, MA 01030" };
    const availabilityReads = readUrls.filter(url => url.includes("/v2/tee-times")).length;
    const changed = await executeExistingAdapterRecipe(recipe as Extract<typeof recipe, { engine: "EXISTING_ADAPTER" }>,
      { date: "2030-10-30", timeZone: source.timeZone, players: 3, startTime: "09:00", endTime: "18:00" },
      { ...deps, recipeHash: "a".repeat(64), now: () => new Date("2030-10-20T12:00:00Z"), toInstant: recipeTimeToInstant });
    expect(changed).toMatchObject({ complete: false, slots: [] });
    expect(readUrls.filter(url => url.includes("/v2/tee-times"))).toHaveLength(availabilityReads);
  });
});
