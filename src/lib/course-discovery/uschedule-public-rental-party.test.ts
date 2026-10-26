import { describe, expect, it, vi } from "vitest";
import { deriveUSchedulePublicRentalParty, isUSchedulePublicRentalPartyAbsent, publicRentalPartySize } from "./uschedule-public-rental-party";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { existingAdapterMetadataSchema } from "./existing-adapter-schema";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { venueProofMatches, recipeTimeToInstant } from "./executor";
import type { OfficialIdentityPage } from "./teeitup-official-identity";
const source = { officialUrl: "https://example.org/", bookingUrl: "https://clients.uschedule.com/examplegolfstudio/booking",
  venueName: "Example Golf Studio", venueAddress: "10 Example Road, Example, NY 12345, USA", timeZone: "America/New_York", providerFamily: "USCHEDULE" };
const rental = "Public Simulator Rental — $45/hour per bay Up to 3 golfers";
const page = (): OfficialIdentityPage => ({ url: source.officialUrl, browserTransport: "NATIVE_CHROME", html: `<html><head><title>Example Golf Studio | Public Golf</title></head><body>
 <h2>Example Golf Studio</h2><a href="${source.bookingUrl}">Book your session</a><address>10 Example Road<br>Example, New York 12345, USA</address>
 <div><p>Public Simulator Rental — $45/hour per bay</p><p>Up to 3 golfers</p></div></body></html>`,
 visibleEvidence: { title: "Example Golf Studio | Public Golf", headings: ["Example Golf Studio"], linkUrls: [source.bookingUrl],
  addressTexts: ["10 Example Road, Example, New York 12345, USA"], publicRentalTexts: [rental] } });
const input = { date: "2026-10-27", players: 2, startTime: "08:00", endTime: "18:00", durationMinutes: 60, timeZone: source.timeZone };
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
const catalog = `<body class="examplegolfstudio"><select id="select_service"><option value="73" selected>Simulator Rental</option></select>
 <select id="select_length"><option value="60" selected>1 hour</option></select></body>`;
const response = () => new Response(catalog, { headers: { "content-type": "text/html", "set-cookie": "ASP.NET_SessionId=OwnedAnonymous123; Secure" } });
describe("USchedule independently published public bay party size", () => {
 it("reads an exact public H2 and static rental paragraphs inside the unique document CMS form", () => {
  const p=page();p.html=p.html.replace("<body>",'<body><form method="post" action="/"><input type="hidden" value="PRIVATE">').replace("</body>","<footer>Public contact</footer></form></body>");
  expect(deriveUSchedulePublicRentalParty(source,p)).toEqual(deriveUSchedulePublicRentalParty(source,page()));
 });
 it.each(["foreign","hidden","login","nested","nofooter","get","foreignaction","multiple","control","label"])("rejects %s public document form witness",mode=>{
  const p=page();p.html=p.html.replace("<body>",'<body><form method="post" action="/">').replace("</body>","<footer>Public contact</footer></form></body>");
  if(mode==="foreign")p.html=p.html.replace("<h2>Example","<h2>Foreign");if(mode==="hidden")p.html=p.html.replace("<h2>","<h2 hidden>");if(mode==="login")p.html=p.html.replace('<form ', '<form class="login" ');if(mode==="nested")p.html=p.html.replace("<body>","<body><section>").replace("</body>","</section></body>");if(mode==="nofooter")p.html=p.html.replaceAll("footer","section");if(mode==="get")p.html=p.html.replace('method="post"','method="get"');if(mode==="foreignaction")p.html=p.html.replace('action="/"','action="https://foreign.example/"');if(mode==="multiple")p.html=p.html.replace("</body>","<form></form></body>");if(mode==="control")p.html=p.html.replace("Up to 3 golfers",'<input value="Up to 3 golfers">');if(mode==="label")p.html=p.html.replace("Up to 3 golfers","<label>Up to 3 golfers</label>");
  expect(()=>deriveUSchedulePublicRentalParty(source,p)).toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
 });
 it("derives a non-four capacity from exact native raw/rendered venue, full address and direct public link", () => {
  expect(deriveUSchedulePublicRentalParty(source, page())).toMatchObject({ maxPartySize: 3, venueName: source.venueName, bookingUrl: source.bookingUrl });
  expect(publicRentalPartySize(rental.replace("3 golfers", "2 people"))).toBe(2);
 });
 it("semantic proof excludes document nonces, unrelated dates and fresh attestation timestamps", () => {
  const old = page(), current = page(); current.html = current.html.replace("<body>", '<body data-nonce="new"><p>Current date 2026-10-28</p>');
  expect(deriveUSchedulePublicRentalParty(source, current)).toEqual(deriveUSchedulePublicRentalParty(source, old));
 });
 it("retains exact identity when a public welcome heading/address label surrounds the complete same address", () => {
  const p = page(); p.html = p.html.replace("<h2>Example", "<h2>Welcome to Example").replace("<address>", "<address>Address: ");
  p.visibleEvidence!.headings = ["Welcome to Example Golf Studio"]; p.visibleEvidence!.addressTexts = ["Address, 10 Example Road, Example, New York 12345, USA"];
  expect(deriveUSchedulePublicRentalParty(source, p)).toEqual(deriveUSchedulePublicRentalParty(source, page()));
 });
 it("rejects a consistently raw/rendered denial rather than extracting a positive capacity from it", () => {
  const p = page(), negative = "Not a public simulator rental. Up to 3 golfers per bay is not offered.";
  p.html = p.html.replace('<div><p>Public Simulator Rental — $45/hour per bay</p><p>Up to 3 golfers</p></div>', `<div>${negative}</div>`);
  p.visibleEvidence!.publicRentalTexts = [negative]; expect(() => deriveUSchedulePublicRentalParty(source, p)).toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
 });
 it.each(["Private simulator rental per bay Up to 3 golfers", "Public simulator rental Up to 3 golfers", "Public simulator rental per bay Up to 6 golfers",
  "Public simulator rental per bay Up to 3 golfers Additional guest", "Public simulator rental per bay Up to 3 golfers Up to 2 players"])("does not infer or weaken capacity from %s", value => {
  expect(publicRentalPartySize(value)).toBeUndefined();
 });
 it.each(["raw", "rendered", "hidden", "name", "address", "link", "native", "foreign", "conflict"])("rejects missing/changed %s evidence", change => {
  const p = page();
  if (change === "raw") p.html = p.html.replace("Up to 3 golfers", "Capacity unknown");
  if (change === "rendered") p.visibleEvidence!.publicRentalTexts = [];
  if (change === "hidden") p.html = p.html.replace('<div><p>Public', '<div hidden><p>Public');
  if (change === "name") p.html = p.html.replaceAll("Example Golf Studio", "Foreign Golf Studio");
  if (change === "address") p.html = p.html.replace("12345", "99999");
  if (change === "link") p.visibleEvidence!.linkUrls = [source.bookingUrl + "?other=1"];
  if (change === "native") p.browserTransport = "PINNED_HTTP";
  if (change === "foreign") p.url = "https://foreign.example/";
  if (change === "conflict") p.visibleEvidence!.publicRentalTexts!.push(rental.replace("3 golfers", "2 golfers"));
  expect(() => deriveUSchedulePublicRentalParty(source, p)).toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
 });
 it("retains a verified published golfer limit while allowing public bay rentals with an unknown limit", async () => {
  const deps = { venueMatches: venueProofMatches, officialIdentityPage: page(), requestedInput: input, requestLease: lease, fetch: vi.fn().mockImplementation(async () => response()) };
  const observed = await inspectExistingAdapter(source, deps);
  expect(observed.adapter).toMatchObject({ family: "USCHEDULE", publicRentalPartyProof: { maxPartySize: 3 } });
  await expect(inspectExistingAdapter(source, { ...deps, requestedInput: { ...input, players: 4 } })).rejects.toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
  const absent = page(); absent.html = absent.html.replace("Up to 3 golfers", "Golfer limit not stated"); absent.visibleEvidence!.publicRentalTexts = [];
  const unknown = await inspectExistingAdapter(source, { ...deps, officialIdentityPage: absent });
  expect(unknown.adapter).toMatchObject({ family: "USCHEDULE", serviceId: "73" });
  expect(unknown.adapter).not.toHaveProperty("publicRentalPartyProof");
 });
 it("permits only actual absence and never treats hidden, account or unrelated department limits as public bay capacity", async () => {
  const p = page(); p.html = p.html.replace("Up to 3 golfers", "Golfer limit not stated").replace("</body>",
   '<section hidden>Public simulator rental per bay Up to 2 golfers</section><section class="account">Public simulator rental per bay Up to 2 golfers</section><p>Restaurant maximum 20 guests</p></body>');
  p.visibleEvidence!.publicRentalTexts = ["Public Simulator Rental — $45/hour per bay"];
  let absent: unknown; try { deriveUSchedulePublicRentalParty(source, p); } catch (error) { absent = error; }
  expect(isUSchedulePublicRentalPartyAbsent(absent)).toBe(true);
  expect(isUSchedulePublicRentalPartyAbsent(Object.assign(new Error("USCHEDULE_PUBLIC_PARTY_UNVERIFIED"), { statement: "ABSENT" }))).toBe(false);
  const observed = await inspectExistingAdapter(source, { venueMatches: venueProofMatches, officialIdentityPage: p,
   requestedInput: { ...input, players: 4 }, requestLease: lease, fetch: vi.fn().mockImplementation(async () => response()) });
  expect(observed.adapter).not.toHaveProperty("publicRentalPartyProof");
 });
 it("leaves a current redirected official document's absent limit unknown without granting its present unbound maximum", async () => {
  const redirectedSource = { ...source, officialUrl: "https://www.example.org/" }, p = page();
  p.html = p.html.replace("Up to 3 golfers", "Golfer limit not stated"); p.visibleEvidence!.publicRentalTexts = [];
  const deps = { venueMatches: venueProofMatches, requestedInput: input, requestLease: lease,
   fetch: vi.fn().mockImplementation(async () => response()) };
  const unknown = await inspectExistingAdapter(redirectedSource, { ...deps, officialIdentityPage: p });
  expect(unknown.adapter).not.toHaveProperty("publicRentalPartyProof");
  await expect(inspectExistingAdapter(redirectedSource, { ...deps, officialIdentityPage: page() })).rejects.toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
 });
 it.each(["Up to 0 golfers", "Maximum of two people", "Up to 3 golfers Up to 2 players", "Up to 6 golfers", "Up to 2 golfers; not including guests"])("rejects a malformed public people maximum rather than omitting %s", async statement => {
  const p = page(); p.html = p.html.replace("Up to 3 golfers", statement);
  p.visibleEvidence!.publicRentalTexts = [rental.replace("Up to 3 golfers", statement)];
  await expect(inspectExistingAdapter(source, { venueMatches: venueProofMatches, officialIdentityPage: p,
   requestedInput: input, requestLease: lease, fetch: vi.fn().mockImplementation(async () => response()) })).rejects.toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
 });
 it.each(["rendered", "raw", "conflicting", "malformed", "native", "identity", "link"])("never downgrades a present but %s public maximum to an unknown limit during real inspection", async mode => {
  const p = page();
  if (mode === "rendered") p.visibleEvidence!.publicRentalTexts = [];
  if (mode === "raw") p.html = p.html.replace("Up to 3 golfers", "Golfer limit not stated");
  if (mode === "conflicting") p.html = p.html.replace("</body>", "<p>Public simulator rental per bay Up to 2 golfers</p></body>");
  if (mode === "malformed") { p.html = p.html.replace("Up to 3 golfers", "Up to 6 golfers"); p.visibleEvidence!.publicRentalTexts = [rental.replace("3 golfers", "6 golfers")]; }
  if (mode === "native") p.browserTransport = "PINNED_HTTP";
  if (mode === "identity") p.html = p.html.replaceAll("Example Golf Studio", "Foreign Golf Studio");
  if (mode === "link") p.visibleEvidence!.linkUrls = [];
  const fetch = vi.fn().mockImplementation(async () => response());
  await expect(inspectExistingAdapter(source, { venueMatches: venueProofMatches, officialIdentityPage: p,
   requestedInput: { ...input, players: 4 }, requestLease: lease, fetch })).rejects.toThrow("USCHEDULE_PUBLIC_PARTY_UNVERIFIED");
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("rejects a party above a freshly verified explicit golfer limit before availability reads", async () => {
  const fetch = vi.fn(), proof = deriveUSchedulePublicRentalParty(source, page()), recipe = { schemaVersion: 1 as const, engine: "EXISTING_ADAPTER" as const, source, target: { courseId: "c", offeringId: "o", kind: "SIMULATOR" as const },
   adapter: existingAdapterMetadataSchema.parse({ family: "USCHEDULE", tenant: "examplegolfstudio", serviceId: "73", serviceName: "Simulator Rental", publicRentalPartyProof: proof }) };
  const result = await executeExistingAdapterRecipe(recipe, { ...input, players: 4 }, { fetch, requestLease: lease, venueMatches: venueProofMatches,
   localCapabilities: ["LOCAL_CHROME"], readNativeOfficialPage: async () => registerFreshNativeOfficialIdentityPage(page(), source.officialUrl, new Date(Date.now() + 30000)),
   recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z") });
  expect(result.complete).toBe(false); expect(result.evidence.reason).toBe("USCHEDULE_PUBLIC_PARTY_UNVERIFIED"); expect(fetch).not.toHaveBeenCalled();
 });
 it("fresh native warm revalidation rejects copied page, modified capacity and missing local capability before provider reads", async () => {
  const proof = deriveUSchedulePublicRentalParty(source, page()), recipe = { schemaVersion: 1 as const, engine: "EXISTING_ADAPTER" as const, source,
   target: { courseId: "c", offeringId: "o", kind: "SIMULATOR" as const }, adapter: existingAdapterMetadataSchema.parse({ family: "USCHEDULE", tenant: "examplegolfstudio", serviceId: "73", serviceName: "Simulator Rental", publicRentalPartyProof: proof }) };
  for (const mode of ["missing", "copy", "changed"]) {
   const fetch = vi.fn(), readNativeOfficialPage = vi.fn(async () => {
    const p = page(); if (mode === "changed") { p.html = p.html.replace("Up to 3", "Up to 2"); p.visibleEvidence!.publicRentalTexts = [rental.replace("3 golfers", "2 golfers")]; }
    return mode === "copy" ? p : registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 30000));
   });
   const result = await executeExistingAdapterRecipe(recipe, input, { fetch, requestLease: lease, venueMatches: venueProofMatches,
    recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z"),
    localCapabilities: mode === "missing" ? [] : ["LOCAL_CHROME"], readNativeOfficialPage });
   expect(result.complete).toBe(false); expect(result.evidence.reason).toBe("USCHEDULE_PUBLIC_PARTY_UNVERIFIED"); expect(fetch).not.toHaveBeenCalled();
  }
 });
 it("one immutable method independently revalidates official party proof and complete dated reads for two dates", async () => {
  const proof = deriveUSchedulePublicRentalParty(source, page()), recipe = { schemaVersion: 1 as const, engine: "EXISTING_ADAPTER" as const, source,
   target: { courseId: "c", offeringId: "o", kind: "SIMULATOR" as const }, adapter: existingAdapterMetadataSchema.parse({ family: "USCHEDULE", tenant: "examplegolfstudio", serviceId: "73", serviceName: "Simulator Rental", publicRentalPartyProof: proof }) };
  const saved = JSON.stringify(recipe);
  for (const date of ["2026-10-27", "2026-10-28"]) {
   let gets = 0; const next = new Date(date + "T12:00:00Z"); next.setUTCDate(next.getUTCDate() + 1);
   const dates = [date, next.toISOString().slice(0, 10)], stamp = (d: string) => d.slice(5, 7) + d.slice(8, 10) + d.slice(0, 4) + "1000";
   const rows = dates.map(d => `<div class="next_avail_results"><div class="next_avail_item" data-time="${stamp(d)}" data-empid="0"><span>Simulator Rental</span></div></div>`).join("") +
    `<script>var chosenDate=new Date(${date.slice(0, 4)},${Number(date.slice(5, 7)) - 1},${Number(date.slice(8, 10))});var lastAvailTime='${stamp(dates[1])}';</script>`;
   const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => init?.method === "POST" ? Response.json({ code: "refresh" }) :
    new Response(catalog.replace("</body>", ++gets === 3 ? rows + "</body>" : "</body>"), { headers: { "content-type": "text/html", ...(gets === 1 ? { "set-cookie": "ASP.NET_SessionId=OwnedAnonymous123; Secure" } : {}) } }));
   const reader = vi.fn(async () => registerFreshNativeOfficialIdentityPage(page(), source.officialUrl, new Date(Date.now() + 30000)));
   const result = await executeExistingAdapterRecipe(recipe, { ...input, date }, { fetch, requestLease: lease, venueMatches: venueProofMatches,
    recipeHash: "a".repeat(64), toInstant: recipeTimeToInstant, now: () => new Date("2026-10-26T00:00:00Z"), localCapabilities: ["LOCAL_CHROME"], readNativeOfficialPage: reader });
   expect(result.complete).toBe(true); expect(result.slots).toHaveLength(1); expect(result.slots[0]).toMatchObject({ capacity: 3, availableSpots: 1 });
   expect(Object.values(result.evidence).filter(v => typeof v === "boolean")).toEqual([true, true, true, true, true]);
   expect(reader).toHaveBeenCalledTimes(1); expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => init?.body)).toEqual([
    '[{"Name":"length","Value":"60"}]', JSON.stringify([{ Name: "start_date", Value: `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}` }])]);
   expect(JSON.stringify(recipe)).toBe(saved);
  }
 });
});
