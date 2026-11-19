import { describe, expect, it, vi } from "vitest";
import { deriveNativePhysicalContactSource } from "./teeitup-physical-contact-proof";
import { bindDelegatedFacility, delegatedBookingHop } from "./teeitup-delegated-booking-source";
import { consumeDelegatedGet, currentNativeDelegatedChain, registerNativeDelegatedChain } from "./teeitup-delegated-booking-context";
import { executeExistingAdapterRecipe, inspectExistingAdapter } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import { teeItUpIntentionalDelegationProofSchema } from "./teeitup-intentional-delegation-proof";
import { physicalContactDigest } from "./teeitup-physical-contact-proof";
import { registerFreshNativeDelegatedDocument, registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

vi.mock("./native-official-page-reader", () => ({
  readNativeOfficialIdentityPage: vi.fn(() => { throw Error("UNEXPECTED_UNMOCKED_NATIVE_TEST_READ"); }),
  readNativeDelegatedDocument: vi.fn(() => { throw Error("UNEXPECTED_UNMOCKED_NATIVE_TEST_READ"); }),
}));

const source = { officialUrl: "https://course.example/", bookingUrl: "https://dedicated.book.teeitup.com/",
  venueName: "Example Hollow Golf & Country Club", venueAddress: "18 Old Turnpike Rd, Example, MA 01068, USA", timeZone: "America/New_York" };
const brand = "Example Hollow Country Club", phone = "+15085555516";
const directory = [{ id: 71, courseId: "public-71", name: brand, address: "18 Turnpike Rd, Example, MA 01068, US",
  country: "US", isSimulator: false, phone, timeZone: source.timeZone }];
function observed(ids = [71], publicPhone = phone) {
  const deadline = new Date(Date.now() + 25_000), printed = "Address : 18 Old Turnpike Rd, Example, MA, 01068";
  const root: OfficialIdentityPage = registerFreshNativeOfficialIdentityPage({ url: source.officialUrl, browserTransport: "NATIVE_CHROME",
    html: `<title>Home - ${brand}</title><h1>${brand}</h1><footer><p>${printed}</p><a href="tel:${publicPhone}">508-555-5516</a></footer><a href="${source.bookingUrl}">Book Now</a>`,
    visibleEvidence: { title: `Home - ${brand}`, headings: [brand], addressTexts: [printed], phoneTexts: ["508-555-5516"], linkUrls: [source.bookingUrl] } }, source.officialUrl, deadline);
  const contact = deriveNativePhysicalContactSource(source, root, phone);
  const final = registerFreshNativeDelegatedDocument({ url: source.bookingUrl, browserTransport: "NATIVE_CHROME",
    html: `<script>self.__next_f.push(${JSON.stringify([1, `0:${JSON.stringify({ alias: "dedicated", name: brand, gnFacilityIds: ids })}\n`])})</script>`,
    visibleEvidence: { title: brand, headings: [brand], addressTexts: [], linkUrls: [] } }, source.officialUrl, deadline);
  const token = registerNativeDelegatedChain({ root, final, officialUrl: source.officialUrl, bookingUrl: source.bookingUrl,
    rootWitnessSha256: contact.sourceWitnessSha256, hops: [delegatedBookingHop(root, source.bookingUrl)],
    deadline: deadline.getTime(), physicalContactSource: contact, physicalContactRequired: true });
  return { token, root, final, contact, chain: currentNativeDelegatedChain(token) };
}

describe("independent exact public facility delegation", () => {
  it("rebuilds both native witnesses for independent agent-free inputs and rejects changed facility, destination and contact", async () => {
    let rows = structuredClone(directory), ids = [71], brokenContact = false;
    const leaseFailures: string[] = [];
    const readNativeOfficialPage = vi.fn(async () => {
      const root = observed().root;
      if (brokenContact) { root.html = root.html.replaceAll(phone, "+15085555517"); registerFreshNativeOfficialIdentityPage(root, source.officialUrl, new Date(Date.now() + 25_000)); }
      return root;
    });
    const readDelegatedDocument = vi.fn(async (_source, grant) => { expect(consumeDelegatedGet(grant).url).toBe(source.bookingUrl); return observed(ids).final; });
    const fetcher = vi.fn<typeof fetch>(async value => Response.json(new URL(String(value)).pathname.endsWith("facilities") ? rows : [{ courseId: "public-71", teetimes: [] }]));
    const dependencies = { fetch: fetcher, readNativeOfficialPage, readDelegatedRoot: readNativeOfficialPage, readDelegatedDocument, localCapabilities: ["LOCAL_CHROME" as const],
      trustedContext: { canonicalCoursePhone: phone }, venueMatches: (a, b) => a === b,
      requestLease: async <T>(_family: string, work: () => Promise<T>) => {
        try { return { acquired: true as const, value: await work() }; }
        catch (error) { leaseFailures.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
      } };
    const inspected = await inspectExistingAdapter(source, { ...dependencies, nativeDelegatedChainToken: observed().token });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" },
      source: { ...source, providerFamily: "TEEITUP" }, adapter: inspected.adapter });
    const execute = (date = "2030-10-24", players = 2) => executeExistingAdapterRecipe(recipe as never,
      { date, players, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone },
      { ...dependencies, recipeHash: "a".repeat(64), toInstant: value => new Date(String(value)) });
    const firstReplay = await execute();
    expect(firstReplay.complete, JSON.stringify({ firstReplay, leaseFailures, roots: readNativeOfficialPage.mock.calls.length,
      children: readDelegatedDocument.mock.calls.length, requests: fetcher.mock.calls.map(([url]) => String(url)) })).toBe(true);
    expect(await execute("2030-10-25", 3)).toMatchObject({ complete: true });
    expect(readNativeOfficialPage).toHaveBeenCalledTimes(2); expect(readDelegatedDocument).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/v2/tee-times")).map(([url]) => new URL(String(url)).searchParams.get("date"))).toEqual(["2030-10-24", "2030-10-25"]);
    for (const change of [{ courseId: "changed" }, { address: "18 Different Rd, Example, MA 01068, US" }, { phone: "+15085555517" }]) {
      rows = [{ ...directory[0], ...change }]; expect((await execute()).complete).toBe(false);
    }
    rows = structuredClone(directory); ids = [71, 72]; expect((await execute()).complete).toBe(false);
    ids = [71]; brokenContact = true; expect((await execute()).complete).toBe(false);
  });
  it("binds the destination's sole configured facility while preserving both different street names", () => {
    const f = observed();
    const proof = bindDelegatedFacility(source, f.chain, directory, "dedicated");
    expect(proof).toMatchObject({ facilityId: 71, courseId: "public-71", canonicalAddress: source.venueAddress,
      providerAddress: directory[0].address, intentionalDelegationProof: { kind: "OFFICIAL_INTENTIONAL_DELEGATION_V1",
        bookingConfiguration: { apiAlias: "dedicated", facilityIds: [71] }, providerAddressVerified: false } });
    expect(proof).not.toHaveProperty("physicalContactProof");
    // A separate fresh native capture must deterministically rebuild the same
    // semantic proof. JSON never reconstructs the private native capability.
    expect(bindDelegatedFacility(source, observed().chain, structuredClone(directory), "dedicated")).toEqual(proof);
    const intentional = proof.intentionalDelegationProof!;
    for (const change of [{ facilityId: 72 }, { country: "CA" }, { isSimulator: true }, { providerPhone: "+15085555517" },
      { providerName: "Other Club" }, { bookingConfiguration: { apiAlias: "dedicated", facilityIds: [71, 72] } }]) {
      const data = { ...intentional, ...change }; data.semanticDigest = physicalContactDigest(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "semanticDigest")));
      expect(teeItUpIntentionalDelegationProofSchema.safeParse(data).success).toBe(false);
    }
    expect(() => currentNativeDelegatedChain(structuredClone(f.token))).toThrow();
  });
  it.each([[71, 72], [72]])("rejects a shared or differently configured destination %j", ids => {
    expect(() => bindDelegatedFacility(source, observed(ids).chain, directory, "dedicated")).toThrow();
  });
  it("never replaces exact facility mapping with name, telephone or directory uniqueness alone", () => {
    const f = observed(), { intentionalDelegationConfiguration: _configuration, ...withoutConfiguration } = f.chain as typeof f.chain & { intentionalDelegationConfiguration?: unknown };
    void _configuration;
    expect(() => bindDelegatedFacility(source, f.chain, directory)).toThrow();
    expect(() => bindDelegatedFacility(source, f.chain, directory, "other-api-alias")).toThrow();
    expect(() => bindDelegatedFacility(source, withoutConfiguration, directory, "dedicated")).toThrow();
    for (const change of [{ id: 72 }, { courseId: "changed", phone: "+15085555517" }, { name: "Other Country Club" },
      { timeZone: "America/Chicago" }, { address: "19 Turnpike Rd, Example, MA 01068, US" }, { isSimulator: true }])
      expect(() => bindDelegatedFacility(source, f.chain, [{ ...directory[0], ...change }], "dedicated")).toThrow();
    expect(() => bindDelegatedFacility(source, f.chain, [...directory, { ...directory[0], id: 72, courseId: "shared-72" }], "dedicated")).toThrow();
    expect(() => bindDelegatedFacility({ ...source, bookingUrl: "https://changed.book.teeitup.com/" }, f.chain, directory, "dedicated")).toThrow();
    expect(() => bindDelegatedFacility(source, { ...f.chain, physicalContactSource: { ...f.contact, publicCoursePhone: "+15085555517" } }, directory, "dedicated")).toThrow();
    f.final.html += "changed";
    expect(() => currentNativeDelegatedChain(f.token)).toThrow();
  });
  it("cannot use changed official link/contact, a copied page or a foreign destination profile", () => {
    for (const change of ["official", "copied", "profile"] as const) {
      const f = observed();
      if (change === "official") f.root.html = f.root.html.replace(source.bookingUrl, "https://foreign.book.teeitup.com/");
      if (change === "copied") {
        const token = registerNativeDelegatedChain({ root: structuredClone(f.root), final: f.final, officialUrl: source.officialUrl, bookingUrl: source.bookingUrl,
          rootWitnessSha256: f.chain.rootWitnessSha256, hops: f.chain.hops, deadline: Date.now() + 25_000, physicalContactSource: f.contact, physicalContactRequired: true });
        expect(() => currentNativeDelegatedChain(token)).toThrow(); continue;
      }
      if (change === "profile") {
        f.final.html = f.final.html.replace(brand, "Foreign Golf Club");
        registerFreshNativeDelegatedDocument(f.final, source.officialUrl, new Date(Date.now() + 25_000));
        expect(() => bindDelegatedFacility(source, currentNativeDelegatedChain(f.token), directory, "dedicated")).toThrow(); continue;
      }
      expect(() => currentNativeDelegatedChain(f.token)).toThrow();
    }
  });
});
