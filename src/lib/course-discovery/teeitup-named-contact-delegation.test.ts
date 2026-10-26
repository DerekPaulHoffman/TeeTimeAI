import { afterEach, describe, expect, it, vi } from "vitest";
import { readTeeItUpDelegatedBookingChain } from "./teeitup-delegated-booking-reader";
import { consumeDelegatedGet, currentNativeDelegatedChain, type DelegatedGetGrant } from "./teeitup-delegated-booking-context";
import { bindDelegatedFacility, teeItUpDelegatedBookingProofSchema } from "./teeitup-delegated-booking-source";
import { physicalContactDigest, deriveNativePhysicalContactSource } from "./teeitup-physical-contact-proof";
import { readNamedPublicContacts } from "./public-named-contact";
import { registerFreshNativeOfficialIdentityPage, registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";

const source = { officialUrl: "https://ordinary.example/", bookingUrl: "https://ordinary.book.teeitup.com/", venueName: "Example Golf",
  venueAddress: "10 N Example Road, Example, FL 12345, USA", timeZone: "America/New_York" };
const entry = "https://ordinary.example/tee-times/", phone = "+19165554653";
const directory = [{ id: 11, courseId: "11", name: source.venueName, address: source.venueAddress, timeZone: source.timeZone, country: "US", isSimulator: false, phone }];
function root(next = entry) {
  const html = '<title>Example Golf | Regional Marketing</title><h1>Championship experience</h1><div><p>Example Golf</p><address>10 N Example Road, Example, Florida.12345</address><p><a href="tel:'+phone+'">916-555-4653</a></p></div><a href="'+next+'">Tee Times</a>';
  const p: OfficialIdentityPage = { url: source.officialUrl, browserTransport: "NATIVE_CHROME", html, visibleEvidence: {
    title: "Example Golf | Regional Marketing", headings: ["Championship experience"], addressTexts: [], phoneTexts: [], brandLinks: [], linkUrls: [next],
    namedContactBlocks: readNamedPublicContacts(html, source.venueName), namedContactBlocksOmitted: false } };
  return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now()+120000));
}
function deps() {
  return { localCapabilities: ["LOCAL_CHROME"] as const, trustedContext: { canonicalCoursePhone: phone }, deadlineAt: new Date(Date.now()+120000),
    readDelegatedRoot: vi.fn(async () => root()),
    readDelegatedDocument: vi.fn(async (_s: OfficialIdentitySource, grant: DelegatedGetGrant) => {
      const next = consumeDelegatedGet(grant), link = next.url === entry ? source.bookingUrl : undefined;
      return registerFreshNativeDelegatedDocument({ url: next.url, browserTransport: "NATIVE_CHROME", html: link ? '<a href="'+link+'">Book Tee Times</a>' : "Public booking",
        visibleEvidence: { title: "Public Booking", headings: [], addressTexts: [], linkUrls: link ? [link] : [] } }, source.officialUrl, new Date(Date.now()+120000));
    }) };
}
afterEach(() => vi.restoreAllMocks());
describe("named canonical contact with independently native delegated booking edges", () => {
  it("retains the observed root entry separately from the final provider and binds exactly two fresh native edges", async () => {
    const d = deps(), chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, d));
    const proof = bindDelegatedFacility(source, chain, directory);
    expect(proof.physicalContactProof).toMatchObject({ bookingUrl: source.bookingUrl, bookingEntryUrl: entry, canonicalName: source.venueName });
    expect(proof.hops.map(v => [v.pageUrl,v.nextUrl])).toEqual([[source.officialUrl,entry],[entry,source.bookingUrl]]);
    expect(teeItUpDelegatedBookingProofSchema.parse(JSON.parse(JSON.stringify(proof)))).toEqual(proof);
    expect(d.readDelegatedDocument).toHaveBeenCalledTimes(2);
    expect(() => deriveNativePhysicalContactSource(source, root(), phone)).toThrow();
    expect(() => deriveNativePhysicalContactSource(source, root(), phone, "https://foreign.example/tee-times/")).toThrow();
  });
  it.each(["missing", "foreign", "final", "differentHop", "discontinuous", "extraHop"])("rejects %s serialized entry/chain substitution even with recomputed digests", async which => {
    const d = deps(), proof = bindDelegatedFacility(source, currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source,d)), directory);
    const changed = structuredClone(proof), contact = changed.physicalContactProof!;
    if (which === "missing") delete contact.bookingEntryUrl;
    if (which === "foreign") contact.bookingEntryUrl = "https://foreign.example/tee-times/";
    if (which === "final") contact.bookingEntryUrl = source.bookingUrl;
    if (which === "differentHop") changed.hops[0].nextUrl = "https://ordinary.example/other/";
    if (which === "discontinuous") changed.hops[1].pageUrl = "https://ordinary.example/other/";
    if (which === "extraHop") changed.hops.push(changed.hops[1]);
    const { semanticDigest: _digest, kind: _kind, providerName: _providerName, providerAddress: _providerAddress, providerLocality: _locality,
      providerLocalityRelation: _relation, sourceWitnessSha256: _witness, ...fields } = contact;
    void _digest; void _kind; void _providerName; void _providerAddress; void _locality; void _relation; void _witness;
    contact.sourceWitnessSha256 = physicalContactDigest(fields);
    const { semanticDigest: _old, ...data } = contact; void _old;
    contact.semanticDigest = physicalContactDigest(data);
    expect(teeItUpDelegatedBookingProofSchema.safeParse(changed).success).toBe(false);
  });
  it.each(["copied", "stale", "missingEdge"])("rejects %s current root before delegated reads", async which => {
    let now = Date.now(); vi.spyOn(Date,"now").mockImplementation(() => now);
    const d = deps(), p = root();
    if (which === "stale") now += 31000;
    if (which === "missingEdge") { p.html=p.html.replace('href="'+entry+'"','href="https://ordinary.example/other/"'); }
    d.readDelegatedRoot.mockResolvedValue(which === "copied" ? structuredClone(p) : p);
    await expect(readTeeItUpDelegatedBookingChain(source,d)).rejects.toThrow();
    expect(d.readDelegatedDocument).not.toHaveBeenCalled();
  });
  it("genuinely recaptures the root and rejects a changed first booking edge after expiry", async () => {
    let now=Date.now(); vi.spyOn(Date,"now").mockImplementation(() => now);
    const d=deps(), original=d.readDelegatedDocument.getMockImplementation()!;
    d.readDelegatedRoot.mockResolvedValueOnce(root()).mockImplementation(async () => root("https://ordinary.example/other/"));
    d.readDelegatedDocument.mockImplementation(async (...args) => { const p=await original(...args); now+=16000; return p; });
    await expect(readTeeItUpDelegatedBookingChain(source,d)).rejects.toThrow();
    expect(d.readDelegatedRoot).toHaveBeenCalledTimes(2);
  });
  it("rebuilds contact and both edges for two independent warm inputs, before requesting dated availability", async () => {
    const d=deps(), native=vi.fn(async () => root()), events:string[]=[];
    const originalRoot=d.readDelegatedRoot.getMockImplementation()!, originalHop=d.readDelegatedDocument.getMockImplementation()!;
    d.readDelegatedRoot.mockImplementation(async () => { events.push("root"); return originalRoot(); });
    d.readDelegatedDocument.mockImplementation(async (...args) => { events.push("hop"); return originalHop(...args); });
    const fetcher=vi.fn<typeof fetch>(async value => { const u=new URL(String(value)); events.push(u.pathname.endsWith("facilities")?"directory":"availability");
      return Response.json(u.pathname.endsWith("facilities")?directory.map(v=>({...v,address:v.address.replace("Road","Rd.").replace("USA","US")})):[{courseId:"11",teetimes:[]}]); });
    const requestLease=async <T>(_family:string, work:()=>Promise<T>) => ({acquired:true as const,value:await work()});
    const options={...d,readNativeOfficialPage:native,fetch:fetcher,requestLease,venueMatches:(a:string,b:string)=>a===b};
    const token=await readTeeItUpDelegatedBookingChain(source,d);
    const inspected=await inspectExistingAdapter(source,{...options,nativeDelegatedChainToken:token});
    const recipe=parseAccessRecipe({schemaVersion:1,engine:"EXISTING_ADAPTER",target:{courseId:"ordinary",kind:"OUTDOOR"},source:{...source,providerFamily:"TEEITUP"},adapter:inspected.adapter});
    expect(recipe.engine==="EXISTING_ADAPTER"&&recipe.adapter.family==="TEEITUP"&&recipe.adapter.officialDelegatedBookingProof?.physicalContactProof?.bookingEntryUrl).toBe(entry);
    for(const [date,players] of [["2030-10-24",2],["2030-10-25",3]] as const) {
      events.length=0;
      const result=await executeExistingAdapterRecipe(recipe as never,{date,players,startTime:"08:00",endTime:"18:00",timeZone:source.timeZone},
        {...options,recipeHash:"a".repeat(64),toInstant:value=>new Date(String(value))});
      expect(result.complete).toBe(true);expect(events.slice(0,3)).toEqual(["root","hop","hop"]);
      expect(events.indexOf("availability")).toBeGreaterThan(2);
    }
    const calls=fetcher.mock.calls.map(([v])=>new URL(String(v))).filter(u=>u.pathname.endsWith("tee-times"));
    expect(calls.map(u=>u.searchParams.get("date"))).toEqual(["2030-10-24","2030-10-25"]);
    d.readDelegatedRoot.mockImplementation(async () => root("https://ordinary.example/other/"));
    const prior=fetcher.mock.calls.length;
    const failed=await executeExistingAdapterRecipe(recipe as never,{date:"2030-10-26",players:2,startTime:"08:00",endTime:"18:00",timeZone:source.timeZone},
      {...options,recipeHash:"a".repeat(64),toInstant:value=>new Date(String(value))});
    expect(failed.complete).toBe(false);expect(fetcher.mock.calls.length).toBe(prior);
  });
});
