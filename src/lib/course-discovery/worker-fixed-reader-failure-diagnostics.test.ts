// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDiscoveryProcess, discoveryBrowserFeedback, readDiscoveryControllerCheckpoint, safeBrowserFailureDiagnostics } from "../../../scripts/automation/course-discovery-worker.mjs";

const gateKeys = ["freshNativeOfficialPage", "canonicalAddressPresent", "canonicalAddressValid", "canonicalPhoneValid", "rawContactsPresent",
  "renderedContactsPresent", "contactCountBounded", "rawContactsNormalizable", "renderedContactsNormalizable", "uniqueNormalizedContact",
  "venueMatches", "phoneMatches", "postalDiscrepancy", "addressMatchesExceptPostal", "visibleBookingLink", "inertBookingLink"];
const nativeKeys = ["attestationPresent", "officialRootMatches", "expiresInFuture", "nativeTransport", "objectUnchanged", "cleanupStarted", "cleanupSettled", "cleanupSucceeded"];
const cps = () => ({ gates: Object.fromEntries(gateKeys.map((key, index) => [key, index === 2 ? false : index > 2 ? null : true])),
  native: { ...Object.fromEntries(nativeKeys.map(key => [key, true])), freshBeforeCleanup: true, freshAfterCleanup: null } });
const mindbody = () => ({ stage: "COMPARE_CATALOG", rawBytes: 150000, renderedBytes: 151000, nativeDocumentCurrent: true, readyState: "complete",
  catalogComparison: { fieldsEqual: { title: true, bodyText: false, locationId: true, studioId: true, venueAddress: true, categories: true, services: true, resources: true },
    rawCounts: { categories: 3, services: 0, resources: 0 }, renderedCounts: { categories: 3, services: 0, resources: 0 },
    rawTextLengths: { title: 9, bodyText: 400, locationId: 1, studioId: 6, venueAddress: 50 },
    renderedTextLengths: { title: 9, bodyText: 410, locationId: 1, studioId: 6, venueAddress: 50 } } });

describe("closed nested fixed-reader failure transport", () => {
  it("carries closed filter facts through the actual helper decoder and checkpoint without raw fields",async()=>{
    const filterSettlement={sourceControlBound:true,newDocumentObserved:true,currentDocument:true,controlIsCategory:false,
      categorySelected:true,serviceSelected:null,expectedControlPresent:true,expectedControlSelected:false,pendingReads:2,elapsedMs:12000};
    const mindbodyAppointment={stage:"FILTER_SETTLEMENT",filterSettlement};
    const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),exitCode:0});
    const channel=createDiscoveryProcess({executable:"unused",args:[],cwd:"unused",environment:{},spawnProcess:()=>child}),pending=channel.request({action:"inspect_adapter"});
    child.stdout.write(JSON.stringify({id:1,ok:false,error:"MINDBODY_PUBLIC_FILTER_UNSETTLED",diagnostics:{mindbodyAppointment:{...mindbodyAppointment,filterSettlement:{...filterSettlement,token:"PRIVATE"}}}})+"\n");
    await expect(pending).rejects.toMatchObject({code:"MINDBODY_PUBLIC_FILTER_UNSETTLED",details:{browserDiagnostics:{mindbodyAppointment}}});
    const feedback=discoveryBrowserFeedback({mindbodyAppointment},"inspect_adapter",{code:"MINDBODY_PUBLIC_FILTER_UNSETTLED"});
    const restored=readDiscoveryControllerCheckpoint({controller:{version:1,officialUrl:"https://official.example/",observedNavigationUrls:[],lastFailure:feedback}},"https://official.example/");
    expect(restored.lastFailure.details.mindbodyAppointment).toEqual(mindbodyAppointment);filterSettlement.pendingReads=0;
    expect(restored.lastFailure.details.mindbodyAppointment.filterSettlement.pendingReads).toBe(2);expect(JSON.stringify(restored)).not.toContain("PRIVATE");
    await channel.close();child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();
  });
  it.each(["missing", "string", "negative", "oversized", "fractional"])("drops malformed filter settlement as a unit: %s",mode=>{
    const filter:Record<string,unknown>={sourceControlBound:true,newDocumentObserved:true,currentDocument:true,controlIsCategory:true,
      categorySelected:null,serviceSelected:null,expectedControlPresent:null,expectedControlSelected:null,pendingReads:2,elapsedMs:12000};
    if(mode==="missing")delete filter.sourceControlBound;else if(mode==="string")filter.categorySelected="PRIVATE";
    else if(mode==="negative")filter.pendingReads=-1;else if(mode==="oversized")filter.elapsedMs=90001;else filter.pendingReads=1.5;
    const safe=safeBrowserFailureDiagnostics({mindbodyAppointment:{stage:"FILTER_SETTLEMENT",filterSettlement:filter}});
    expect(safe.mindbodyAppointment).toEqual({stage:"FILTER_SETTLEMENT"});expect(JSON.stringify(safe)).not.toContain("PRIVATE");
  });
  it("retains only the 16 contact gates and 10 native flags and returns isolated copies", () => {
    const value = cps(), safe = safeBrowserFailureDiagnostics({ cpsPostalContact: { ...value, html: "PRIVATE", token: "PRIVATE" }, text: "PRIVATE" });
    expect(safe.cpsPostalContact).toEqual(value); expect(Object.keys(safe.cpsPostalContact.gates)).toHaveLength(16);
    expect(Object.keys(safe.cpsPostalContact.native)).toHaveLength(10); expect(JSON.stringify(safe)).not.toContain("PRIVATE");
    value.gates.freshNativeOfficialPage = false; value.native.freshBeforeCleanup = false;
    expect(safe.cpsPostalContact.gates.freshNativeOfficialPage).toBe(true); expect(safe.cpsPostalContact.native.freshBeforeCleanup).toBe(true);
  });
  it("drops arbitrary keys and malformed scalar/nullable values without broad string copying", () => {
    const safe = safeBrowserFailureDiagnostics({ cpsPostalContact: {
      gates: { freshNativeOfficialPage: "PRIVATE", canonicalAddressPresent: null, private: true },
      native: { attestationPresent: null, cleanupStarted: true, freshAfterCleanup: null, private: "PRIVATE" } },
      mindbodyAppointment: { stage: "PRIVATE", readyState: "PRIVATE", rawBytes: 4_000_001, pendingReads: -1, nativeDocumentCurrent: "PRIVATE",
        url: "https://private.example", catalogComparison: { fieldsEqual: { title: true } } } });
    expect(safe.cpsPostalContact).toEqual({ gates: { canonicalAddressPresent: null }, native: { cleanupStarted: true, freshAfterCleanup: null } });
    expect(safe.mindbodyAppointment).toBeUndefined(); expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|https|private/u);
  });
  it("preserves catalog equality/count/length telemetry without text, URLs, identifiers or form fields", () => {
    const value = mindbody(), safe = safeBrowserFailureDiagnostics({ mindbodyAppointment: { ...value, text: "PRIVATE", html: "PRIVATE", CSRFToken: "PRIVATE",
      catalogComparison: { ...value.catalogComparison, private: "PRIVATE", rawCounts: { ...value.catalogComparison.rawCounts, private: "PRIVATE" } } } });
    expect(safe.mindbodyAppointment).toEqual(value); expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|CSRF|private|https/u);
    value.catalogComparison.fieldsEqual.bodyText = true; value.catalogComparison.rawCounts.categories = 99;
    expect(safe.mindbodyAppointment.catalogComparison).toMatchObject({ fieldsEqual: { bodyText: false }, rawCounts: { categories: 3 } });
  });
  it.each([null, [], "PRIVATE", { catalogComparison: { fieldsEqual: "PRIVATE" } }, { rawBytes: NaN }, { rawBytes: 1.5 }])(
    "omits malformed Mindbody subtree without changing other failure facts (%j)", mindbodyAppointment => {
      const safe = safeBrowserFailureDiagnostics({ mindbodyAppointment, loading: false }); expect(safe.loading).toBe(false);
      expect(safe.mindbodyAppointment).toBeUndefined();
    });
  it("rejects incomplete or oversized comparison groups as a unit", () => {
    const value = mindbody(); value.catalogComparison.rawTextLengths.bodyText = 2_000_001;
    const safe = safeBrowserFailureDiagnostics({ mindbodyAppointment: value });
    expect(safe.mindbodyAppointment).toMatchObject({ stage: "COMPARE_CATALOG", rawBytes: 150000 });
    expect(safe.mindbodyAppointment.catalogComparison).toBeUndefined();
  });
  it("retains only closed same-failure subtrees through browser feedback and checkpoint copying", () => {
    const snapshot = { mindbodyAppointment: { ...mindbody(), token: "PRIVATE" }, cpsPostalContact: { ...cps(), html: "PRIVATE" } };
    const feedback = discoveryBrowserFeedback(snapshot, "inspect_adapter", { code: "MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH" });
    const restored = readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://official.example/", observedNavigationUrls: [], lastFailure: feedback } }, "https://official.example/");
    expect(restored.lastFailure.details).toMatchObject({ failure: { code: "MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH" },
      mindbodyAppointment: mindbody(), cpsPostalContact: cps() });
    snapshot.mindbodyAppointment.catalogComparison.fieldsEqual.bodyText = true; snapshot.cpsPostalContact.gates.freshNativeOfficialPage = false;
    expect(restored.lastFailure.details.mindbodyAppointment.catalogComparison.fieldsEqual.bodyText).toBe(false);
    expect(restored.lastFailure.details.cpsPostalContact.gates.freshNativeOfficialPage).toBe(true); expect(JSON.stringify(restored)).not.toContain("PRIVATE");
  });
  it("carries the exact helper primary and closed subtrees through the real process response decoder", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
    const channel = createDiscoveryProcess({ executable: "unused", args: [], cwd: "unused", environment: {}, spawnProcess: () => child });
    const pending = channel.request({ action: "inspect_adapter" });
    child.stdout.write(JSON.stringify({ id: 1, ok: false, error: "MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH", diagnostics: {
      mindbodyAppointment: { ...mindbody(), rawHtml: "PRIVATE" }, cpsPostalContact: { ...cps(), header: "PRIVATE" } } }) + "\n");
    await expect(pending).rejects.toMatchObject({ code: "MINDBODY_CATALOG_RAW_VISIBLE_MISMATCH", details: { browserDiagnostics: {
      mindbodyAppointment: mindbody(), cpsPostalContact: cps() } } });
    await channel.close(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
});
