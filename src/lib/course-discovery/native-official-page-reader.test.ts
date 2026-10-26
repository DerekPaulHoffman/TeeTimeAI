import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { readNativeOfficialIdentityPage } from "./native-official-page-reader";
import { createCourseDiscoveryBrowserSession, type DiscoveryBrowserSnapshot } from "./browser-session";
import { bindTeeItUpPostalConflictProof } from "./teeitup-postal-conflict-proof";
import * as nativeBrowser from "./native-public-browser";
import * as nativeRouting from "./native-redirect-routing";
import { getNativeOfficialIdentityPageDiagnostic, isFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Golf Course",
  venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: "America/New_York" };
function fixture(change: Partial<DiscoveryBrowserSnapshot> = {}) {
  const execute = vi.fn(async () => ({ url: source.officialUrl, navigationStatus: 200, loading: false, browserTransport: "NATIVE_CHROME",
    officialSourceDiagnostic: { stage: "CONTROLLER_CAPTURE", rawOfficialCaptured: true, currentOfficialDocument: true,
      officialProvenance: true, renderedAddressesPresent: true, renderedLinksPresent: true }, ...change } as DiscoveryBrowserSnapshot));
  const readOfficialIdentityPage = vi.fn(async () => ({ url: source.officialUrl, html: "<html></html>", browserTransport: "NATIVE_CHROME" as const,
    visibleEvidence: { title: source.venueName, headings: [], addressTexts: [], linkUrls: [] } }));
  const close = vi.fn(async () => {}), createSession = vi.fn(async () => ({ execute, readOfficialIdentityPage, close }));
  return { execute, readOfficialIdentityPage, close, createSession };
}
describe("fixed native official source reader", () => {
  it("passes only the caller's current private context into the warm native session and preserves absent legacy context",async()=>{
    const trustedContext={canonicalCoursePhone:"+19165554653"};
    for(const context of [undefined,trustedContext]){
      const session=fixture();await readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),{...session,...(context?{trustedContext:context}:{})});
      const input=(session.createSession.mock.calls[0] as unknown as [Record<string,unknown>])[0];
      if(context){expect(input.trustedContext).toEqual(context);expect(input.trustedContext).not.toBe(context);}
      else expect(input).not.toHaveProperty("trustedContext");
    }
  });
  it("records expiry during cleanup without renewing the attestation or replacing the returned object",async()=>{
    let now=Date.parse("2026-10-24T02:00:00Z");const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
    try{
      const session=fixture(),page=await session.readOfficialIdentityPage();session.readOfficialIdentityPage.mockResolvedValueOnce(page);
      session.close.mockImplementationOnce(async()=>{now+=30_001;});
      const result=await readNativeOfficialIdentityPage(source,source.officialUrl,new Date(now+120_000),session);
      expect(result).toBe(page);expect(isFreshNativeOfficialIdentityPage(result,source.officialUrl)).toBe(false);
      const d=getNativeOfficialIdentityPageDiagnostic(result,source.officialUrl);
      expect(d).toEqual({attestationPresent:true,officialRootMatches:true,expiresInFuture:false,nativeTransport:true,objectUnchanged:true,
        cleanupStarted:true,cleanupSettled:true,cleanupSucceeded:true,freshBeforeCleanup:true,freshAfterCleanup:false});
      d.cleanupSucceeded=false;expect(getNativeOfficialIdentityPageDiagnostic(result,source.officialUrl).cleanupSucceeded).toBe(true);
      expect(Object.values(d).every(value=>value===null||typeof value==="boolean")).toBe(true);
    }finally{clock.mockRestore();}
  });
  it("records a failed cleanup while rethrowing its exact original error and retaining object mutation rejection",async()=>{
    const session=fixture(),page=await session.readOfficialIdentityPage(),primary=new Error("PRIVATE_TOKEN_ABC123");
    session.readOfficialIdentityPage.mockResolvedValueOnce(page);session.close.mockImplementationOnce(async()=>{page.html+="changed";throw primary;});
    await expect(readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),session)).rejects.toBe(primary);
    const d=getNativeOfficialIdentityPageDiagnostic(page,source.officialUrl);
    expect(d).toMatchObject({objectUnchanged:false,cleanupStarted:true,cleanupSettled:true,cleanupSucceeded:false,freshBeforeCleanup:true,freshAfterCleanup:false});
    expect(JSON.stringify(d)).not.toMatch(/PRIVATE|example|html|https:/u);
    expect(getNativeOfficialIdentityPageDiagnostic(structuredClone(page),source.officialUrl)).toMatchObject({attestationPresent:false,freshBeforeCleanup:null,freshAfterCleanup:null});
  });
  it("preserves legacy capture defaults and enables physical contact capture only for the private fixed CPS caller",async()=>{
    for(const collect of [false,true]){
      const session=fixture();await readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),{...session,...(collect?{collectPublicCourseContacts:true as const}:{})});
      const options=(session.createSession.mock.calls[0] as unknown as [unknown,Record<string,unknown>])[1];
      if(collect)expect(options.collectPublicCourseContacts).toBe(true);else expect(options).not.toHaveProperty("collectPublicCourseContacts");
    }
  });
  it("admits only the official origin, owns a fresh native session and always closes it", async () => {
    const session = fixture();
    await readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 120_000), session);
    const [input, options] = session.createSession.mock.calls[0] as unknown as [{ deadlineAt: Date; initialUrls: string[] }, { browserTransport: string }];
    expect(input.initialUrls).toEqual([source.officialUrl]);
    expect(input.deadlineAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(options.browserTransport).toBe("NATIVE_CHROME");
    expect(session.execute).toHaveBeenCalledWith({ id: 1, action: "open", url: source.officialUrl });
    expect(session.close).toHaveBeenCalledOnce();
  });
  it.each([{ navigationStatus: 401 }, { navigationStatus: 403 }, { accessRequirementObserved: true }, { browserTransport: "PINNED_HTTP" },
    { officialSourceDiagnostic: { stage: "RAW_DOCUMENT" as const, rawOfficialCaptured: false } },
    { officialSourceDiagnostic: { stage: "RAW_DOCUMENT" as const, rawOfficialCaptured: true, currentOfficialDocument: false } },
    { url: "https://unrelated.example/" }])("rejects incomplete, challenged or changed documents and closes (%j)", async change => {
    const session = fixture(change);
    await expect(readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 30_000), session)).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    expect(session.readOfficialIdentityPage).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("captures the fresh official witness despite pending ancillary reads without waiting for network idle", async () => {
    const session=fixture({ loading: true, pendingRequestCount: 2 });
    await expect(readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),session)).resolves.toMatchObject({browserTransport:"NATIVE_CHROME"});
    expect(session.execute).toHaveBeenCalledOnce();expect(session.readOfficialIdentityPage).toHaveBeenCalledOnce();expect(session.close).toHaveBeenCalledOnce();
  });
  it("observes a missing rendered witness within the same deadline and rejects it when still missing", async () => {
    const session=fixture({ loading: false, officialSourceDiagnostic: {stage:"CONTROLLER_CAPTURE",rawOfficialCaptured:true,currentOfficialDocument:true,officialProvenance:true,renderedAddressesPresent:false,renderedLinksPresent:true} });
    await expect(readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),session)).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    expect(session.execute).toHaveBeenCalledTimes(5);expect(session.readOfficialIdentityPage).not.toHaveBeenCalled();expect(session.close).toHaveBeenCalledOnce();
  });
  it("closes the browser when trusted visibility capture fails", async () => {
    const session = fixture(); session.readOfficialIdentityPage.mockRejectedValueOnce(new Error("DOCUMENT_CHANGED"));
    await expect(readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 30_000), session)).rejects.toThrow("DOCUMENT_CHANGED");
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("rejects unrelated origins before browser creation", async () => {
    const session = fixture();
    await expect(readNativeOfficialIdentityPage(source, "https://unrelated.example/", new Date(Date.now() + 30_000), session)).rejects.toThrow();
    expect(session.createSession).not.toHaveBeenCalled();
  });
  it("retains the actual redirected current URL only with the fixed native exact-root completed lineage", async () => {
    const destination = "https://new-official.example/golf", nativeDocumentRedirects = [{ fromUrl: source.officialUrl, toUrl: destination, status: 301, completed: true as const }];
    const session = fixture({ url: destination, nativeDocumentRedirects });
    session.readOfficialIdentityPage.mockResolvedValueOnce({ ...(await fixture().readOfficialIdentityPage()), url: destination });
    await expect(readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now()+30_000), session)).resolves.toMatchObject({ url: destination });
    expect(session.close).toHaveBeenCalledOnce();
  });
  it.each(["missing", "wrong root", "wrong landing", "discontinuous", "uncompleted", "nonredirect", "unsafe", "pinned"])("rejects a %s native redirect witness without reading identity", async mode => {
    const destination = "https://new-official.example/golf";
    const hops = [{ fromUrl: source.officialUrl, toUrl: destination, status: 301, completed: true }];
    if (mode === "wrong root") hops[0].fromUrl = "https://unrelated.example/";
    if (mode === "wrong landing") hops[0].toUrl = "https://unrelated.example/";
    if (mode === "discontinuous") hops.push({ fromUrl: "https://unrelated.example/", toUrl: destination, status: 302, completed: true });
    if (mode === "uncompleted") hops[0].completed = false;
    if (mode === "nonredirect") hops[0].status = 200;
    if (mode === "unsafe") hops[0].fromUrl = "http://127.0.0.1/";
    const session = fixture({ url: destination, browserTransport: mode === "pinned" ? "PINNED_HTTP" : "NATIVE_CHROME",
      ...(mode === "missing" ? {} : { nativeDocumentRedirects: hops as DiscoveryBrowserSnapshot["nativeDocumentRedirects"] }) });
    await expect(readNativeOfficialIdentityPage(source,source.officialUrl,new Date(Date.now()+30_000),session)).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    expect(session.readOfficialIdentityPage).not.toHaveBeenCalled(); expect(session.close).toHaveBeenCalledOnce();
  });
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
describe.runIf(existsSync(executablePath))("fresh native official identity with pending ancillary fixtures", () => {
  it.each(["visible", "hidden address", "missing address", "changed document", "hidden phone"] as const)(
    "retains strict raw/rendered/phone proof while ancillary scripts remain pending: %s", async mode => {
      // Every browser read is fulfilled in memory. A dead loopback proxy and
      // an exact URL fence make an accidental external provider read fail.
      const assets = ["https://example.org/pending-one.js", "https://example.org/pending-two.js"];
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const address = mode === "missing address" ? "" : `<div${mode === "hidden address" ? ' style="opacity:0"' : ""}><address>10 Harbor Drive, Example, NY 12345, USA</address></div>`;
      const html = `<html><head><title>${source.venueName}</title><link rel="icon" href="data:,"></head><body><h1>${source.venueName}</h1>` +
        address + `<a href="${source.bookingUrl}">Tee Times</a><div${mode === "hidden phone" ? ' style="opacity:0"' : ""}>` +
        '<a class="course-contact" href="tel:+1-916-555-4653">916-555-4653</a></div>' +
        assets.map(url => `<script async src="${url}"></script>`).join("") + "</body></html>";
      const proxy = vi.spyOn(nativeBrowser, "createNativePublicBrowserProxy").mockResolvedValue({ server: "http://127.0.0.1:9",
        close: async () => {}, allowHostConnections: () => {}, cancelHostConnections: async () => {},
        stats: () => ({ connections: 0, activeSockets: 0, bytes: 0 }) });
      const routing = vi.spyOn(nativeRouting, "installNativeRedirectRouting").mockImplementation(async (_page, handler) => ({
        prepare: () => {}, beginDocumentNavigation: async () => {}, close: async () => {}, pendingReads: 0, lastFailure: undefined,
        releasePlaywrightRoute: route => handler(route),
      }));
      const native = vi.spyOn(nativeBrowser, "continueNativeBrowserRead").mockImplementation(async route => {
        const url = route.request().url(), asset = assets.includes(url);
        if (!asset && url !== source.officialUrl && url !== "https://example.org/changed") throw new Error("UNEXPECTED_LOCAL_FIXTURE_URL");
        if (asset) await pending;
        const headers = { "content-type": asset ? "application/javascript" : "text/html" }, body = Buffer.from(asset ? "/* ancillary asset */" : html);
        await route.fulfill({ status: 200, headers, body }); return { status: 200, url, headers, body };
      });
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      const snapshots: DiscoveryBrowserSnapshot[] = [], closed = vi.fn();
      const createSession = async (...args: Parameters<typeof createCourseDiscoveryBrowserSession>) => {
        const session = await createCourseDiscoveryBrowserSession(args[0], { ...args[1],
          launchBrowser: async () => browser = await chromium.launch({ executablePath, headless: true }),
        });
        return { ...session, execute: async (value: unknown) => {
          const snapshot = await session.execute(value); snapshots.push(snapshot);
          if (mode === "changed document" && snapshots.length === 1) {
            release(); await browser!.contexts()[0].pages()[0].goto("https://example.org/changed", { waitUntil: "commit" });
          }
          return snapshot;
        }, close: async () => { release(); await session.close(); closed(); } };
      };
      try {
        const reading = readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 30_000), {
          createSession, requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
        });
        if (["hidden address", "missing address", "changed document"].includes(mode))
          await expect(reading).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
        else {
          const page = await reading;
          const directory = [{ id: 31, courseId: "provider-course-31", name: source.venueName, address: "10 Harbor Dr., Example, NY 32801, US",
            timeZone: source.timeZone, country: "US", isSimulator: false, phone: "+1 (916) 555-4653" }];
          const proof = () => bindTeeItUpPostalConflictProof(source, page, directory, { requireVisibleEvidence: true });
          if (mode === "hidden phone") expect(proof).toThrow();
          else expect(proof()).toMatchObject({ kind: "OFFICIAL_POSTAL_CONFLICT", canonicalAddress: source.venueAddress,
            postalConflict: { canonical: "12345", provider: "32801" }, warmTransport: "NATIVE_CHROME", publicCoursePhone: "+19165554653" });
        }
        expect(snapshots[0].loading).toBe(true); expect(snapshots[0].pendingRequestCount).toBeGreaterThan(0);
        expect(closed).toHaveBeenCalledOnce(); expect(browser?.isConnected()).toBe(false);
      } finally { release(); await browser?.close(); native.mockRestore(); routing.mockRestore(); proxy.mockRestore(); }
    }, 30_000);
});
