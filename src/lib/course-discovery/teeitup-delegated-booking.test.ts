import { afterEach, describe, expect, it, vi } from "vitest";
import { delegatedBookingHop, delegatedCanonicalVenueWitness, bindDelegatedFacility, safeDelegatedBookingUrl } from "./teeitup-delegated-booking-source";
import { authorizeDelegatedGet, consumeDelegatedGet, currentNativeDelegatedChain, createDelegatedReadBudget, chargeDelegatedReadBudget, delegatedProxyAllocation, type DelegatedGetGrant } from "./teeitup-delegated-booking-context";
import { registerFreshNativeOfficialIdentityPage, registerFreshNativeDelegatedDocument, isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
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
