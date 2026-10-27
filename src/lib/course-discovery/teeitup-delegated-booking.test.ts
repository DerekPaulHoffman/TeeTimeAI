import { afterEach, describe, expect, it, vi } from "vitest";
import { delegatedBookingHop, delegatedCanonicalVenueWitness, bindDelegatedFacility, safeDelegatedBookingUrl } from "./teeitup-delegated-booking-source";
import { authorizeDelegatedGet, consumeDelegatedGet, currentNativeDelegatedChain, createDelegatedReadBudget, chargeDelegatedReadBudget, delegatedProxyAllocation, type DelegatedGetGrant } from "./teeitup-delegated-booking-context";
import { registerFreshNativeOfficialIdentityPage, registerFreshNativeDelegatedDocument, isFreshNativeOfficialIdentityPage, freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import { readTeeItUpDelegatedBookingChain } from "./teeitup-delegated-booking-reader";
import { readNativeDelegatedDocument } from "./native-official-page-reader";
import { inspectExistingAdapter, executeExistingAdapterRecipe } from "./existing-adapter-executor";
import { parseAccessRecipe } from "./recipe";
import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { createCourseDiscoveryBrowserSession, discoveryBrowserActionSchema } from "./browser-session";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";
import { getTeeItUpDelegationDiagnostic, createDelegationDiagnostic, rememberTeeItUpDelegationFailure, delegatedDiagnosticGates } from "./teeitup-delegated-booking-diagnostic";

const source = { officialUrl: "https://public.example/venue", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Golf Course",
  venueAddress: "10 Harbor Drive, Example, NY 12345", timeZone: "America/New_York" };
const operator = "https://operator.example/";
const directory = [{ id: 71, courseId: "provider-71", name: source.venueName, address: "10 Harbor Dr., Example, NY 12345, US", timeZone: source.timeZone, isSimulator: false }];
function page(url: string, next?: string, canonical = false): OfficialIdentityPage {
  return { url, browserTransport: "NATIVE_CHROME", html: `<html><head><title>${canonical ? source.venueName : "Public Booking"}</title></head><body>${canonical ? `<h1>${source.venueName}</h1><address>${source.venueAddress}</address>` : ""}${next ? `<a href="${next}">Reserve Tee Times</a>` : "Public availability"}</body></html>`,
    visibleEvidence: { title: canonical ? source.venueName : "Public Booking", headings: canonical ? [source.venueName] : [], addressTexts: canonical ? [source.venueAddress] : [], linkUrls: next ? [next] : [] } };
}
function root() { return registerFreshNativeOfficialIdentityPage(page(source.officialUrl, operator, true), source.officialUrl, new Date(Date.now() + 120000)); }
function delegated(url: string, next?: string) { return registerFreshNativeDelegatedDocument(page(url, next), source.officialUrl, new Date(Date.now() + 120000)); }
function readers() {
  const readNativeOfficialPage = vi.fn(async () => root());
  const readDelegatedDocument = vi.fn(async (_source: OfficialIdentitySource, grant: DelegatedGetGrant) => { const next = consumeDelegatedGet(grant); return delegated(next.url, next.url === operator ? source.bookingUrl : undefined); });
  return { localCapabilities: ["LOCAL_CHROME"] as const, readDelegatedRoot: readNativeOfficialPage, readNativeOfficialPage, readDelegatedDocument, deadlineAt: new Date(Date.now() + 120000) };
}
afterEach(() => vi.restoreAllMocks());

describe("fresh native delegated TeeItUp source", () => {
  it("keeps a pipe footer with another physical street incomplete after sharing the exact field parser", () => {
    const p = page(source.officialUrl, operator, true);
    const row = `${source.venueName} | 11 Harbor Drive Example, NY 12345 | 212-555-1234`;
    p.html = p.html.replace(`<address>${source.venueAddress}</address>`, `<footer><p>${row}</p></footer>`);
    p.visibleEvidence!.addressTexts = [row.toUpperCase()];
    expect(() => delegatedCanonicalVenueWitness(source, registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000)))).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  const pipeFooter = (address = "10 Harbor Drive Example, NY 12345", phone = "212-555-1234") => `${source.venueName} | ${address} | ${phone}`;
  function pipePage(value = pipeFooter()) {
    const p = page(source.officialUrl, operator, true);
    p.html = p.html.replace(`<address>${source.venueAddress}</address>`, `<footer><p class="address">${value}</p></footer>`);
    p.visibleEvidence!.addressTexts = [value]; return p;
  }
  it.each(["10 Harbor Drive Example, NY 12345", "10 Harbor Dr., Example, NY 12345, USA"])
  ("binds an exact branded pipe footer without guessing street/locality components: %s", async address => {
    const deps = readers();
    deps.readDelegatedRoot.mockImplementation(async () => registerFreshNativeOfficialIdentityPage(pipePage(pipeFooter(address)), source.officialUrl, new Date(Date.now() + 120000)));
    const chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, deps));
    expect(bindDelegatedFacility(source, chain, directory)).toMatchObject({ facilityId: 71, canonicalAddress: source.venueAddress });
  });
  it("allows CSS uppercase rendering of the complete pipe row but never a changed token", async () => {
    for (const changed of [false, true]) {
      const deps = readers();
      deps.readDelegatedRoot.mockImplementation(async () => {
        const p = pipePage();
        p.visibleEvidence!.addressTexts = [pipeFooter().toUpperCase().replace("HARBOR DRIVE", changed ? "OTHER DRIVE" : "HARBOR DRIVE")];
        return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000));
      });
      if (changed) { await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED"); expect(deps.readDelegatedDocument).not.toHaveBeenCalled(); }
      else expect(currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, deps)).hops).toHaveLength(2);
    }
  });
  it("preserves the complete canonical direction, unit and ZIP+4 in a printed pipe address", () => {
    const scoped = { ...source, venueAddress: "10 N Harbor Drive Suite 2, Example, NY 12345-6789, USA" };
    const make = (address: string) => registerFreshNativeOfficialIdentityPage(pipePage(pipeFooter(address)), source.officialUrl, new Date(Date.now() + 120000));
    const printed = "10 N Harbor Dr. Suite 2 Example, NY 12345-6789, US";
    expect(delegatedCanonicalVenueWitness(scoped, make(printed))).toMatch(/^[a-f0-9]{64}$/u);
    for (const wrong of [printed.replace("N Harbor", "Harbor"), printed.replace("Suite 2", "Suite 3"), printed.replace("12345-6789", "12345")])
      expect(() => delegatedCanonicalVenueWitness(scoped, make(wrong))).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it.each(["otherBrand", "extraField", "extraAddressText", "invalidPhone", "number", "street", "direction", "unit", "locality", "region", "postal", "zip4", "country",
    "hidden", "form", "inert", "mailing", "corporate", "ambiguous", "differentPhone", "renderedMissing", "renderedChanged"])
  ("rejects a branded pipe footer with %s before delegated GET", async variant => {
    const deps = readers();
    deps.readDelegatedRoot.mockImplementation(async () => {
      let value = pipeFooter();
      if (variant === "otherBrand") value = value.replace(source.venueName, "Other Golf Course");
      if (variant === "extraField") value += " | Other business";
      if (variant === "extraAddressText") value = pipeFooter("10 Harbor Drive Example, NY 12345 directions here");
      if (variant === "invalidPhone") value = pipeFooter(undefined, "Call for details 212-555-1234");
      if (variant === "number") value = pipeFooter("11 Harbor Drive Example, NY 12345");
      if (variant === "street") value = pipeFooter("10 Other Drive Example, NY 12345");
      if (variant === "direction") value = pipeFooter("10 N Harbor Drive Example, NY 12345");
      if (variant === "unit") value = pipeFooter("10 Harbor Drive Suite 2 Example, NY 12345");
      if (variant === "locality") value = pipeFooter("10 Harbor Drive New Example, NY 12345");
      if (variant === "region") value = pipeFooter("10 Harbor Drive Example, NJ 12345");
      if (variant === "postal") value = pipeFooter("10 Harbor Drive Example, NY 12346");
      if (variant === "zip4") value = pipeFooter("10 Harbor Drive Example, NY 12345-6789");
      if (variant === "country") value = pipeFooter("10 Harbor Drive Example, NY 12345, Canada");
      const p = pipePage(value);
      if (variant === "hidden") p.html = p.html.replace('class="address"', 'class="address" hidden');
      if (variant === "form") p.html = p.html.replace("<footer>", "<footer><form>").replace("</footer>", "</form></footer>");
      if (variant === "inert") p.html = p.html.replace("<footer>", "<footer inert>");
      if (["mailing", "corporate"].includes(variant)) p.html = p.html.replace("<footer>", `<footer><h5>${variant} address</h5>`);
      if (["ambiguous", "differentPhone"].includes(variant)) {
        const other = variant === "ambiguous" ? value.replace(source.venueName, "Other Golf Course") : pipeFooter(undefined, "212-555-1235");
        p.html = p.html.replace("</footer>", `<p>${other}</p></footer>`); p.visibleEvidence!.addressTexts.push(other);
      }
      if (variant === "renderedMissing") p.visibleEvidence!.addressTexts = [];
      if (variant === "renderedChanged") p.visibleEvidence!.addressTexts = [pipeFooter(undefined, "212-555-1235")];
      return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000));
    });
    await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    expect(deps.readDelegatedDocument).not.toHaveBeenCalled();
  });
  it.each([3, 4, 5, 6])("accepts an exact public H%s venue heading through the fresh delegated chain", async level => {
    const deps = readers();
    deps.readDelegatedRoot.mockImplementation(async () => {
      const p = page(source.officialUrl, operator, true), heading = `Welcome to ${source.venueName}!`;
      p.html = p.html.replace(`<h1>${source.venueName}</h1>`, `<h${level}>${heading}</h${level}>`);
      p.visibleEvidence!.headings = [heading];
      return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000));
    });
    const chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, deps));
    expect(bindDelegatedFacility(source, chain, directory)).toMatchObject({ facilityId: 71, bookingUrl: source.bookingUrl });
  });
  it.each(["wrong", "hidden", "form", "inert", "conflictingH1", "rawAddress", "renderedAddress", "renderedName"])
  ("does not admit an H4 venue witness with %s evidence", async variant => {
    const deps = readers(), heading = `Welcome to ${source.venueName}!`;
    deps.readDelegatedRoot.mockImplementation(async () => {
      const p = page(source.officialUrl, operator, true);
      let markup = `<h4>${heading}</h4>`;
      if (variant === "wrong") markup = "<h4>Welcome to Other Golf Course!</h4>";
      if (variant === "hidden") markup = `<h4 hidden>${heading}</h4>`;
      if (variant === "form") markup = `<form>${markup}</form>`;
      if (variant === "inert") markup = `<section inert>${markup}</section>`;
      if (variant === "conflictingH1") markup += "<h1>Other Golf Course</h1>";
      p.html = p.html.replace(`<h1>${source.venueName}</h1>`, markup);
      p.visibleEvidence!.headings = variant === "renderedName" ? ["Other Golf Course"] : [heading];
      if (variant === "rawAddress") p.html = p.html.replace(source.venueAddress, "11 Harbor Drive, Example, NY 12345");
      if (variant === "renderedAddress") p.visibleEvidence!.addressTexts = ["11 Harbor Drive, Example, NY 12345"];
      return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000));
    });
    await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    expect(deps.readDelegatedDocument).not.toHaveBeenCalled();
  });
  it.each(["Tee Time Waitlist", "Tee Time Waitlist Don’t see the tee time you wanted? Sign up to be notified when your desired dates become available. Sign Up",
    "Book Your Tournament", "Book Tee Time Alerts", "Reserve tee times: Notify me", "Book Your Group Outing", "Reserve Group Events"])
  ("excludes explicit nonavailability link %s without selecting it via a requested URL", label => {
    const good="https://public.example/tee-times/", bad="https://public.example/another/";
    const p=page(source.officialUrl,good,true);
    p.html += '<a href="'+bad+'">'+label+'</a>'; p.visibleEvidence!.linkUrls.push(bad);
    expect(delegatedBookingHop(p).nextUrl).toBe(good);
    expect(()=>delegatedBookingHop(p,bad)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    const only=page(source.officialUrl,undefined,true);only.html+='<a href="'+bad+'">'+label+'</a>';only.visibleEvidence!.linkUrls=[bad];
    expect(()=>delegatedBookingHop(only)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it("collapses ordinary booking captions for the same edge but preserves ambiguity between genuine different booking entries",()=>{
    const p=page(source.officialUrl,operator,true);
    for(const label of ["Book Today Book Your Tee Time","Book Your Tee Time","Book Tee Times"])p.html+='<a href="'+operator+'">'+label+'</a>';
    expect(delegatedBookingHop(p).nextUrl).toBe(operator);
    p.html+='<a href="https://public.example/other-tee-times/">Reserve Tee Times</a>';p.visibleEvidence!.linkUrls.push("https://public.example/other-tee-times/");
    expect(()=>delegatedBookingHop(p)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it.each(["#", source.officialUrl + "#", "#section"])("excludes a same-document %s anchor while retaining the exact real route", fragment => {
    const p = page(source.officialUrl, operator, true), self = new URL(fragment, p.url).href;
    p.html += `<a href="${fragment}">Tee Times</a>`; p.visibleEvidence!.linkUrls.push(self);
    expect(delegatedBookingHop(p).nextUrl).toBe(operator);
    expect(() => delegatedBookingHop(p, self)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    const only = page(source.officialUrl, undefined, true); only.html += `<a href="${fragment}">Tee Times</a>`; only.visibleEvidence!.linkUrls = [self];
    expect(() => delegatedBookingHop(only)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it.each([source.officialUrl + "?view=public", "https://public.example/other-path/", "https://other.example/public/"])
  ("does not collapse a different public query, path or origin: %s", next => {
    const p = page(source.officialUrl, next, true);
    expect(delegatedBookingHop(p).nextUrl).toBe(next);
    p.html += `<a href="${operator}">Book A Tee Time</a>`; p.visibleEvidence!.linkUrls.push(operator);
    expect(() => delegatedBookingHop(p)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it("keeps canonical source distinct from the exact fresh native redirect document through the earned booking chain", async () => {
    const current = "https://www.public.example/venue", deps = readers();
    deps.readDelegatedRoot.mockImplementation(async () => registerFreshNativeOfficialIdentityPage(page(current, operator, true), source.officialUrl, new Date(Date.now() + 30000),
      { requestedUrl: source.officialUrl, redirects: [{ fromUrl: source.officialUrl, toUrl: current, status: 301, completed: true }] }));
    const token = await readTeeItUpDelegatedBookingChain(source, deps), chain = currentNativeDelegatedChain(token), proof = bindDelegatedFacility(source, chain, directory);
    expect(proof.officialUrl).toBe(source.officialUrl); expect(proof.hops[0].pageUrl).toBe(current);
    expect(proof.rootDocumentProof).toMatchObject({ kind: "NATIVE_CANONICAL_ROOT_REDIRECT", canonicalUrl: source.officialUrl, documentUrl: current });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "owned", kind: "OUTDOOR" },
      source: { ...source, providerFamily: "TEEITUP" }, adapter: { family: "TEEITUP", alias: "harbor", facilityIds: [71], officialDelegatedBookingProof: proof } });
    expect(recipe.source.officialUrl).toBe(source.officialUrl);
    const raw = await deps.readDelegatedRoot(source, source.officialUrl, new Date(Date.now() + 30000));
    expect(freshNativeCanonicalRootDocument(structuredClone(raw), source.officialUrl)).toBeUndefined();
    raw.html += " "; expect(freshNativeCanonicalRootDocument(raw, source.officialUrl)).toBeUndefined();
  });
  it.each(["absent", "wrongRequest", "crossHost", "uncompleted", "wrongStatus", "cyclic", "discontinuous"])("does not substitute same-host membership or malformed %s redirect data for native provenance", async variant => {
    const current = variant === "crossHost" ? "https://foreign.example/venue" : "https://www.public.example/venue";
    const redirects = [{ fromUrl: source.officialUrl, toUrl: current, status: variant === "wrongStatus" ? 200 : 301, completed: variant !== "uncompleted" }];
    if (variant === "cyclic") redirects.push({ fromUrl: current, toUrl: source.officialUrl, status: 301, completed: true }, { fromUrl: source.officialUrl, toUrl: current, status: 301, completed: true });
    if (variant === "discontinuous") redirects.unshift({ fromUrl: source.officialUrl, toUrl: "https://public.example/other", status: 301, completed: true });
    const p = registerFreshNativeOfficialIdentityPage(page(current, operator, true), source.officialUrl, new Date(Date.now() + 30000), variant === "absent" ? undefined :
      { requestedUrl: variant === "wrongRequest" ? current : source.officialUrl, redirects });
    expect(freshNativeCanonicalRootDocument(p, source.officialUrl)).toBeUndefined();
    const deps = readers(); deps.readDelegatedRoot.mockResolvedValue(p);
    await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it("retains the exact failing root predicate as copied closed facts without replacing the primary error", async () => {
    const deps = readers();
    deps.readDelegatedRoot.mockImplementation(async () => {
      const p = page(source.officialUrl, operator, true); p.html = p.html.replaceAll(source.venueName, "Other Golf Course");
      return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000));
    });
    let primary: unknown;
    try { await readTeeItUpDelegatedBookingChain(source, deps); } catch (error) { primary = error; }
    const diagnostic = getTeeItUpDelegationDiagnostic(primary)!;
    expect(diagnostic).toMatchObject({ stage: "ROOT_IDENTITY", gates: { capabilityAvailable: true, rootReadReturned: true, rootFresh: true,
      rootUrlExact: true, canonicalAddressValid: true, rootRawVenue: false, rootRenderedVenue: null } });
    expect(Object.keys(diagnostic.gates)).toEqual([...delegatedDiagnosticGates]);
    diagnostic.gates.rootRawVenue = true; expect(getTeeItUpDelegationDiagnostic(primary)?.gates.rootRawVenue).toBe(false);
    expect(getTeeItUpDelegationDiagnostic(structuredClone(primary))).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toMatch(/Harbor|Other Golf|https:|"(?:phone|address|url|html)"\s*:/i);
  });
  it("merges native read gate observations into the exact outer hop without leaking error text", async () => {
    const deps = readers(), primary = Error("PRIVATE_TOKEN_ABC123 https://private.example/");
    const native = createDelegationDiagnostic("NATIVE_DOCUMENT_READ"); native.gates.hopStatus200 = false; native.gates.hopNoAccess = false;
    rememberTeeItUpDelegationFailure(primary, native);
    deps.readDelegatedDocument.mockRejectedValueOnce(primary);
    await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toBe(primary);
    const d = getTeeItUpDelegationDiagnostic(primary)!;
    expect(d).toMatchObject({ stage: "HOP_ONE_READ", gates: { rootFresh: true, rootLinkVerified: true, hopStatus200: false, hopNoAccess: false, firstReadReturned: null } });
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE|https:|message|stack|token/i);
  });
  it("distinguishes an absent delegated edge from a provider physical identity mismatch", async () => {
    const deps = readers(); deps.readDelegatedDocument.mockImplementation(async (_s, grant) => { const next = consumeDelegatedGet(grant); return delegated(next.url); });
    let edgeError: unknown;
    try { await readTeeItUpDelegatedBookingChain(source, deps); } catch (error) { edgeError = error; }
    expect(getTeeItUpDelegationDiagnostic(edgeError)).toMatchObject({ stage: "HOP_TWO_LINK", gates: { firstReadReturned: true, firstFresh: true,
      hopRawLinkPresent: false, hopRenderedLinkPresent: false, hopUnique: false } });
    const chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, readers()));
    let providerError: unknown;
    try { bindDelegatedFacility(source, chain, [{ ...directory[0], address: "11 Harbor Dr., Example, NY 12345, US" }]); } catch (error) { providerError = error; }
    expect(getTeeItUpDelegationDiagnostic(providerError)).toMatchObject({ stage: "PROVIDER_BIND", gates: { directoryValid: true,
      directoryIdsUnique: true, providerUniqueMatch: false } });
  });
  it.each([false, true])("deadline abort awaits the same drain and accounts final native usage after expiry; cleanup failure=%s", async failCleanup => {
    const end = new Date(Date.now() + 100), budget = createDelegatedReadBudget(end);
    let release!: () => void;
    const draining = new Promise<void>(resolve => { release = resolve; }), unhandled: unknown[] = [];
    const listener = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", listener);
    const routerClose = vi.fn(async () => { await draining; });
    const contextClose = vi.fn(async () => { if (failCleanup) throw Error("PRIVATE_CLOSE_ERROR"); });
    const browserClose = vi.fn(async () => {}), proxyClose = vi.fn(async () => {});
    const context = { on: vi.fn(), routeWebSocket: vi.fn(async () => {}), route: vi.fn(async () => {}), newPage: vi.fn(async () => ({ on: vi.fn(), url: () => source.officialUrl, setDefaultTimeout: vi.fn() })), close: contextClose };
    vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9", close: proxyClose,
      allowHostConnections: vi.fn(), cancelHostConnections: vi.fn(async () => {}), stats: () => ({ connections: 3, activeSockets: 0, bytes: 1000 }) });
    vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockResolvedValue({ close: routerClose } as never);
    try {
      const session = await createCourseDiscoveryBrowserSession({ initialUrls: [source.officialUrl], venueOfficialUrl: source.officialUrl, deadlineAt: end },
        { browserTransport: "NATIVE_CHROME", delegatedReadBudget: budget, launchBrowser: async () => ({ newContext: async () => context, close: browserClose }) as never });
      expect(discoveryBrowserActionSchema.safeParse({ id: 1, action: "readDelegatedSourceDocument" }).success).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 150));
      let settled = false;
      const closing = session.close().finally(() => { settled = true; });
      const asserted = failCleanup ? expect(closing).rejects.toThrow("DISCOVERY_BROWSER_CLEANUP_FAILED") : expect(closing).resolves.toBeUndefined();
      await Promise.resolve(); expect(settled).toBe(false); expect(contextClose).not.toHaveBeenCalled();
      release(); await asserted;
      expect(routerClose).toHaveBeenCalledOnce(); expect(contextClose).toHaveBeenCalledOnce(); expect(browserClose).toHaveBeenCalledOnce(); expect(proxyClose).toHaveBeenCalledOnce();
      expect(session.diagnostics().cleanupFailed).toBe(failCleanup); expect(unhandled).toEqual([]);
      expect(() => delegatedProxyAllocation(budget)).toThrow();
    } finally { release?.(); process.removeListener("unhandledRejection", listener); }
  });
  it("retains one original request, decoded-byte, intercept and tunnel budget across documents", () => {
    const budget = createDelegatedReadBudget(new Date(Date.now() + 120000));
    chargeDelegatedReadBudget(budget, "requests", 100); chargeDelegatedReadBudget(budget, "requests", 92);
    expect(() => chargeDelegatedReadBudget(budget, "requests")).toThrow("PUBLIC_READ_REQUEST_LIMIT");
    chargeDelegatedReadBudget(budget, "tunnelBytes", 12000000); chargeDelegatedReadBudget(budget, "connections", 50);
    expect(delegatedProxyAllocation(budget)).toEqual({ maxBytes: 12000000, maxConnections: 142 });
    chargeDelegatedReadBudget(budget, "bytes", 48000000); expect(() => chargeDelegatedReadBudget(budget, "bytes")).toThrow("PUBLIC_READ_BYTE_LIMIT");
    chargeDelegatedReadBudget(budget, "intercepts", 1024); expect(() => chargeDelegatedReadBudget(budget, "intercepts")).toThrow("PUBLIC_READ_REQUEST_LIMIT");
    expect(() => delegatedProxyAllocation(structuredClone(budget))).toThrow();
  });
  it("keeps venue identity on the canonical home and records two exact native edges separately", async () => {
    const deps = readers(), token = await readTeeItUpDelegatedBookingChain(source, deps), chain = currentNativeDelegatedChain(token);
    expect(chain.hops.map(hop => [hop.pageUrl, hop.nextUrl])).toEqual([[source.officialUrl, operator], [operator, source.bookingUrl]]);
    const proof = bindDelegatedFacility(source, chain, directory);
    expect(proof).toMatchObject({ kind: "OFFICIAL_DELEGATED_BOOKING_SOURCE", officialUrl: source.officialUrl, bookingUrl: source.bookingUrl,
      facilityId: 71, courseId: "provider-71", requiredCapability: "LOCAL_CHROME", warmTransport: "NATIVE_CHROME" });
    expect(deps.readNativeOfficialPage).toHaveBeenCalledTimes(1); expect(deps.readDelegatedDocument).toHaveBeenCalledTimes(2);
    expect(() => currentNativeDelegatedChain(structuredClone(token))).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it.each(["name", "street", "postal", "hidden", "mailing"])("rejects invalid canonical home identity: %s", change => {
    const p = root();
    if (change === "name") p.html = p.html.replaceAll(source.venueName, "Unrelated Golf Course");
    if (change === "street") p.html = p.html.replaceAll("10 Harbor Drive", "11 Harbor Drive");
    if (change === "postal") p.html = p.html.replaceAll("12345", "54321");
    if (change === "hidden") p.html = p.html.replace("<address>", "<address hidden>");
    if (change === "mailing") p.html = p.html.replace("<address>", "<section><h2>Mailing Address</h2><address>").replace("</address>", "</address></section>");
    expect(() => delegatedCanonicalVenueWitness(source, p)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it.each(["hidden", "inert", "rendered-missing", "raw-missing", "wrong-link"])("requires the exact visible and inert source edge: %s", change => {
    const p = delegated(operator, source.bookingUrl);
    if (change === "hidden" || change === "inert") p.html = p.html.replace("<a ", `<div ${change}><a `).replace("</a>", "</a></div>");
    if (change === "rendered-missing") p.visibleEvidence!.linkUrls = [];
    if (change === "raw-missing") p.html = "<html><body>Blank</body></html>";
    if (change === "wrong-link") p.html = p.html.replace(source.bookingUrl, "https://unrelated.book.teeitup.com/");
    expect(() => delegatedBookingHop(p, source.bookingUrl)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it("consumes an exact GET once and rejects clones, mutations, foreign roots and expiry", () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const p = root(), first = authorizeDelegatedGet(p, source.officialUrl, new Date(now + 120000));
    expect(() => consumeDelegatedGet(structuredClone(first.token))).toThrow();
    expect(consumeDelegatedGet(first.token).url).toBe(operator); expect(() => consumeDelegatedGet(first.token)).toThrow();
    expect(() => authorizeDelegatedGet(p, "https://foreign.example/", new Date(now + 120000))).toThrow();
    const changed = authorizeDelegatedGet(p, source.officialUrl, new Date(now + 120000)); p.html += "changed";
    expect(() => consumeDelegatedGet(changed.token)).toThrow();
    const expired = authorizeDelegatedGet(root(), source.officialUrl, new Date(now + 120000)); now += 30001;
    expect(() => consumeDelegatedGet(expired.token)).toThrow();
  });
  it("actually recaptures an expired root without renewing an old object or final document", async () => {
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const deps = readers(), roots: OfficialIdentityPage[] = [];
    deps.readNativeOfficialPage.mockImplementation(async () => { const p = root(); roots.push(p); return p; });
    deps.readDelegatedDocument.mockImplementation(async (_s, grant) => { const next = consumeDelegatedGet(grant); now += 20000; return delegated(next.url, next.url === operator ? source.bookingUrl : undefined); });
    const token = await readTeeItUpDelegatedBookingChain(source, deps);
    expect(roots).toHaveLength(2); expect(roots[0]).not.toBe(roots[1]); expect(isFreshNativeOfficialIdentityPage(roots[0], source.officialUrl)).toBe(false);
    expect(currentNativeDelegatedChain(token).hops).toHaveLength(2);
  });
  it("fails before transport without LOCAL_CHROME and rejects a third delegation or copied final page", async () => {
    const deps = readers(); await expect(readTeeItUpDelegatedBookingChain(source, { ...deps, localCapabilities: [] })).rejects.toThrow("LOCAL_CHROME_REQUIRED");
    expect(deps.readNativeOfficialPage).not.toHaveBeenCalled();
    deps.readDelegatedDocument.mockImplementation(async (_s, grant) => { const next = consumeDelegatedGet(grant); return delegated(next.url, "https://third.example/"); });
    await expect(readTeeItUpDelegatedBookingChain(source, deps)).rejects.toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    const copied = readers(); copied.readDelegatedDocument.mockImplementation(async (_s, grant) => { const next = consumeDelegatedGet(grant); return structuredClone(delegated(next.url, source.bookingUrl)); });
    await expect(readTeeItUpDelegatedBookingChain(source, copied)).rejects.toThrow();
  });
  it.each(["street", "postal", "name", "timezone", "duplicate"])("delegation never excuses a provider identity discrepancy: %s", async change => {
    const chain = currentNativeDelegatedChain(await readTeeItUpDelegatedBookingChain(source, readers())), rows = structuredClone(directory);
    if (change === "street") rows[0].address = rows[0].address.replace("10 Harbor", "11 Harbor");
    if (change === "postal") rows[0].address = rows[0].address.replace("12345", "54321");
    if (change === "name") rows[0].name = "Unrelated Golf Course";
    if (change === "timezone") rows[0].timeZone = "America/Chicago";
    if (change === "duplicate") rows.push({ ...rows[0], id: 72, courseId: "provider-72" });
    expect(() => bindDelegatedFacility(source, chain, rows)).toThrow("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  });
  it("keeps warm witnesses semantic across unrelated nonce changes, while rebuilding both native hops for two independent inputs", async () => {
    const deps = readers();
    const calls: string[] = [], fetcher = vi.fn<typeof fetch>(async value => {
      const u = new URL(String(value)); calls.push(u.href);
      return Response.json(u.pathname.endsWith("facilities") ? directory : [{ courseId: "provider-71", teetimes: [] }]);
    });
    const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
    // The legacy string-address predicate rejects the otherwise identical
    // country suffix. The native fallback must earn the complete chain and
    // use the existing parsed official-facility predicate, not inject a proof.
    const inspected = await inspectExistingAdapter(source, { ...deps, fetch: fetcher, venueMatches: (a, b) => a === b, requestLease: lease });
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { courseId: "course", kind: "OUTDOOR" },
      source: { ...source, providerFamily: "TEEITUP" }, adapter: inspected.adapter });
    deps.readNativeOfficialPage.mockImplementation(async () => { const p = root(); p.html = p.html.replace("</body>", "<script>nonce=123</script></body>"); return registerFreshNativeOfficialIdentityPage(p, source.officialUrl, new Date(Date.now() + 120000)); });
    for (const [date, players] of [["2030-10-24", 2], ["2030-10-25", 3]] as const) {
      const result = await executeExistingAdapterRecipe(recipe as never, { date, players, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone },
        { ...deps, recipeHash: "a".repeat(64), fetch: fetcher, requestLease: lease, venueMatches: (a, b) => a === b, toInstant: value => new Date(String(value)) });
      expect(result.complete).toBe(true);
    }
    expect(deps.readNativeOfficialPage).toHaveBeenCalledTimes(3); expect(deps.readDelegatedDocument).toHaveBeenCalledTimes(6);
    expect(calls.filter(value => value.includes("/v2/tee-times"))).toHaveLength(2);
    expect(calls.filter(value => value.includes("/v2/tee-times")).map(value => new URL(value).searchParams.get("date"))).toEqual(["2030-10-24", "2030-10-25"]);
    const changed = structuredClone(recipe); if (changed.engine === "EXISTING_ADAPTER" && changed.adapter.family === "TEEITUP") changed.adapter.officialDelegatedBookingProof!.officialUrl = operator;
    expect(() => parseAccessRecipe(changed)).toThrow();
  });
  it("isolated delegated read keeps canonical home unchanged, requires a grant and always closes its owned session", async () => {
    const admitted = authorizeDelegatedGet(root(), source.officialUrl, new Date(Date.now() + 120000));
    const close = vi.fn(async () => {}), execute = vi.fn(async () => ({ url: operator, navigationStatus: 200, browserTransport: "NATIVE_CHROME" }));
    const createSession = vi.fn(async (_input: unknown, _deps: unknown) => { void _input; void _deps; return { execute, close, readOfficialIdentityPage: vi.fn(), readDelegatedSourceDocument: async () => page(operator, source.bookingUrl) }; });
    const result = await readNativeDelegatedDocument(source, admitted.token, { createSession: createSession as never });
    expect(result.url).toBe(operator); expect(createSession.mock.calls[0][0]).toMatchObject({ venueOfficialUrl: source.officialUrl, initialUrls: [operator] });
    expect(createSession.mock.calls[0][1]).toMatchObject({ browserTransport: "NATIVE_CHROME", captureDelegatedDocument: true }); expect(close).toHaveBeenCalledOnce();
    await expect(readNativeDelegatedDocument(source, {} as never, { createSession: createSession as never })).rejects.toThrow(); expect(createSession).toHaveBeenCalledOnce();
  });
  it.each(["https://127.0.0.1/", "https://private.local/", "https://public.example/login", "https://public.example/ASP/appt_req.asp", "https://public.example/?token=secret", "https://user@public.example/"])("never authorizes private or transaction URLs: %s", value => {
    expect(safeDelegatedBookingUrl(value)).toBe(false);
  });
});
