import { describe, expect, it } from "vitest";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { simulatorCapabilityWakeupReceipt } from "./simulator-capability-wakeup";
import { readSimulatorResearchState, selectSimulatorResearchTarget, SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION } from "./simulator-support-research-policy";

const now = new Date("2026-10-09T18:00:00.000Z");
const fingerprint = "a".repeat(64);
const bookingUrl = "https://clients.uschedule.com/stingers-golf/booking";
const requestId = "f16bc626-102d-4cd3-8149-324c296b5f66";

function fixture() {
  const audit = {
    schemaVersion: 1, tickRef: "course-1", assignmentRef: "assignment", state: "CONSUMED",
    ownerThreadId: "parent", childThreadId: "worker", baseSha: "a".repeat(40),
    reservedAt: "2026-10-09T17:40:00.000Z", expiresAt: "2026-10-09T17:50:00.000Z",
    launchStartedAt: "2026-10-09T17:41:00.000Z", boundAt: "2026-10-09T17:42:00.000Z",
    consumedAt: "2026-10-09T17:43:00.000Z",
    target: { mode: "SIMULATOR", offeringId: "offering", offeringSourceFingerprint: fingerprint,
      incidentId: "incident", courseId: "course", cycle: 1, providerFamilyKey: "SIMULATOR_SOURCE_PENDING",
      failureFingerprint: fingerprint, updatedAt: "2026-10-09T17:30:00.000Z", trafficClass: "REAL",
      searchRefs: [{ id: "search", scheduleVersion: 1, alertGeneration: 1, intentDigest: "b".repeat(64) }] },
    simulatorClaim: { token: "token", revision: 1, phase: "CLAIMED", claimedAt: "2026-10-09T17:43:00.000Z",
      leaseExpiresAt: "2026-10-09T17:58:00.000Z", sourceFingerprint: fingerprint,
      originalSourceFingerprint: fingerprint, offeringRevision: 1, plannedPaths: [], releaseSha: null,
      branch: "feature/simulator-alerts", deployment: null, recheckQueuedAt: null, verificationCycle: 0 },
    simulatorResearch: { version: 1, sourceFingerprint: fingerprint, readCount: 1,
      history: [{ source: "booking", requestedUrl: bookingUrl, sourceUrl: bookingUrl,
        sourceFingerprint: fingerprint, observedAt: "2026-10-09T17:50:00.000Z", httpStatus: 200,
        rendered: false, outcome: "READ", requestId,
        researchImplementationVersion: "public-calendar-passive-method-shapes-v4",
        publicReadEvidence: { sourceFingerprint: fingerprint, accessControlsObserved: true,
          accessControls: [], method: "HTTP" } }],
      links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null },
  } as CourseDispatchAudit;
  return { audit, incidentId: "incident", courseId: "course", offeringId: "offering",
    sourceFingerprint: fingerprint, completedAt: new Date("2026-10-09T17:51:00.000Z"), now };
}

describe("simulator capability wakeup receipt", () => {
  const slottedCatalog = "https://book.squareup.com/appointments/publicvenue/location/AAAAAAAAAAAAA/services";
  function slottedFixture() {
    const f = fixture(), root = "https://official.example.test/", state = f.audit.simulatorResearch!;
    const receipt = state.history[0];
    state.history = [
      { ...receipt, source: "booking", requestedUrl: root, sourceUrl: root, observedAt: "2026-10-09T17:48:00.000Z",
        researchImplementationVersion: "public-calendar-document-scoped-evidence-v39" },
      { ...receipt, source: "link", requestedUrl: slottedCatalog, sourceUrl: slottedCatalog, observedAt: "2026-10-09T17:49:00.000Z",
        requestId: "22222222-2222-4222-8222-222222222222", researchImplementationVersion: "public-calendar-document-scoped-evidence-v39" },
      { ...receipt, source: "link", requestedUrl: slottedCatalog, sourceUrl: slottedCatalog, observedAt: "2026-10-09T17:50:00.000Z",
        requestId: "33333333-3333-4333-8333-333333333333", researchImplementationVersion: "public-calendar-document-scoped-evidence-v39",
        rendered: true, renderWarning: "SECONDARY_REQUESTS_BLOCKED", publicReadEvidence: { sourceFingerprint: fingerprint,
          accessControlsObserved: true, accessControls: [], method: "BROWSER", renderComplete: false } },
    ]; state.readCount = 3;
    Object.assign(f.audit, { simulatorResearchPriorFailures: { version: 1, sourceFingerprint: fingerprint, routes: [{
      url: root, rendered: true, httpStatus: 0, observedAt: "2026-10-09T17:30:00.000Z",
      requestId: "44444444-4444-4444-8444-444444444444", researchImplementationVersion: "public-calendar-document-scoped-evidence-v37",
      failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_REQUEST",
        sourceLocation: "src/lib/automation/simulator-interactive-browser.ts:263" } }] } });
    return f;
  }
  it("wakes one owned public catalog after the actual slotted-control collector repair without deleting its old failures", () => {
    const f = slottedFixture(), before = JSON.stringify(f);
    expect(simulatorCapabilityWakeupReceipt(f)).toEqual({ sourceUrl: slottedCatalog, requestId: "33333333-3333-4333-8333-333333333333" });
    expect(JSON.stringify(f)).toBe(before);
  });
  function callbackFixture() {
    const f = slottedFixture(), state = f.audit.simulatorResearch!;
    for (const entry of state.history) entry.researchImplementationVersion = "public-calendar-document-scoped-evidence-v40";
    const last = state.history[2];
    Object.assign(last, { outcome: "HARD_FAILED", httpStatus: 0, failure: { stage: "PUBLIC_READ", category: "UNKNOWN",
      code: "UNCLASSIFIED_FAILURE", researchPhase: "BROWSER_DOCUMENT", sourceLocation: "src/lib/automation/simulator-interactive-browser.ts:318" } });
    delete last.publicReadEvidence; delete last.renderWarning;
    return f;
  }
  function dateFixture() {
    const f = slottedFixture(), state = f.audit.simulatorResearch!;
    for (const entry of state.history) entry.researchImplementationVersion = "public-calendar-document-scoped-evidence-v41";
    state.history[2].sourceUrl = slottedCatalog.replace(/\/services$/u, "/availability");
    return f;
  }
  it("offers one new investigation of an old public calendar after the date-control bridge correction", () => {
    const f = dateFixture(), before = JSON.stringify(f);
    expect(simulatorCapabilityWakeupReceipt(f)).toEqual({ sourceUrl: slottedCatalog.replace(/\/services$/u, "/availability"),
      requestId: "33333333-3333-4333-8333-333333333333" });
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each(["current collector", "different location", "missing public proof", "denied access", "no fresh catalog", "unknown old failure"])("does not wake the repaired calendar with %s", scenario => {
    const f = dateFixture(), state = f.audit.simulatorResearch!, last = state.history[2];
    if (scenario === "current collector") last.researchImplementationVersion = SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION;
    if (scenario === "different location") last.sourceUrl = last.sourceUrl.replace("AAAAAAAAAAAAA", "CCCCCCCCCCCCC");
    if (scenario === "missing public proof") delete last.publicReadEvidence;
    if (scenario === "denied access") last.publicReadEvidence!.accessControls = ["ACCOUNT_REQUIRED"];
    if (scenario === "no fresh catalog") state.history[1].requestedUrl = "https://official.example.test/";
    if (scenario === "unknown old failure") (f.audit as unknown as {simulatorResearchPriorFailures: {routes: {failure: {code: string}}[]}}).simulatorResearchPriorFailures.routes[0].failure.code = "OTHER_UNKNOWN";
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
  });
  it("wakes the precisely reproduced old production-loader failure with all original evidence retained", () => {
    const f = callbackFixture(), before = JSON.stringify(f);
    expect(simulatorCapabilityWakeupReceipt(f)).toEqual({ sourceUrl: slottedCatalog, requestId: "33333333-3333-4333-8333-333333333333" });
    expect(JSON.stringify(f)).toBe(before);
  });
  it.each(["current collector", "different phase", "different line", "different catalog", "unknown public access", "denied HTTP", "unknown old failure"])("does not reclassify the production-loader receipt with %s", scenario => {
    const f = callbackFixture(), state = f.audit.simulatorResearch!, last = state.history[2];
    if (scenario === "current collector") last.researchImplementationVersion = SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION;
    if (scenario === "different phase") last.failure!.researchPhase = "BROWSER_REQUEST";
    if (scenario === "different line") last.failure!.sourceLocation = "src/lib/automation/simulator-interactive-browser.ts:319";
    if (scenario === "different catalog") last.requestedUrl = last.sourceUrl = slottedCatalog.replace("AAAAAAAAAAAAA", "CCCCCCCCCCCCC");
    if (scenario === "unknown public access") delete state.history[1].publicReadEvidence;
    if (scenario === "denied HTTP") state.history[1].httpStatus = 403;
    if (scenario === "unknown old failure") (f.audit as unknown as {simulatorResearchPriorFailures: {routes: {failure: {code: string}}[]}}).simulatorResearchPriorFailures.routes[0].failure.code = "OTHER_UNKNOWN";
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
  });
  it("keeps the failed callback fenced until the new owner has independently refreshed its public catalog", () => {
    const f = callbackFixture(), old = f.audit.simulatorResearch!, last = old.history[2];
    const priorFailedRoutes = [{ url: last.requestedUrl, rendered: last.rendered, httpStatus: last.httpStatus,
      requestId: last.requestId, observedAt: last.observedAt, researchImplementationVersion: last.researchImplementationVersion, failure: last.failure }];
    const input = { officialUrl: "https://official.example.test/", bookingUrl: slottedCatalog,
      source: "booking" as const, rendered: true, now, priorFailedRoutes };
    expect(() => selectSimulatorResearchTarget({ ...input, state: readSimulatorResearchState(undefined, fingerprint) })).toThrow("unchanged structural");
    const state = readSimulatorResearchState({ ...old, readCount: 2, history: old.history.slice(0, 2).map((entry, index) => ({ ...entry,
      researchImplementationVersion: SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION, observedAt: `2026-10-09T17:${58 + index}:00.000Z` })) }, fingerprint);
    expect(selectSimulatorResearchTarget({ ...input, state })).toMatchObject({ url: slottedCatalog, rendered: true });
    expect(last.outcome).toBe("HARD_FAILED");
  });
  it.each(["current collector", "changed source", "access", "unknown access", "different destination", "unknown failure", "future read", "already implementing"])("does not wake slotted-control research with %s", scenario => {
    const f = slottedFixture(), last = f.audit.simulatorResearch!.history[2];
    if (scenario === "current collector") last.researchImplementationVersion = SIMULATOR_RESEARCH_IMPLEMENTATION_VERSION;
    if (scenario === "changed source") last.sourceFingerprint = "b".repeat(64);
    if (scenario === "access") last.publicReadEvidence!.accessControls = ["ACCOUNT_REQUIRED"];
    if (scenario === "unknown access") delete last.publicReadEvidence;
    if (scenario === "different destination") last.sourceUrl = slottedCatalog.replace("AAAAAAAAAAAAA", "CCCCCCCCCCCCC");
    if (scenario === "unknown failure") Object.assign(f.audit, { simulatorResearchPriorFailures: { version: 1, sourceFingerprint: fingerprint,
      routes: [{ url: slottedCatalog, rendered: true, httpStatus: 0, failure: { stage: "PUBLIC_READ", category: "UNKNOWN", code: "OTHER_UNKNOWN" } }] } });
    if (scenario === "future read") last.observedAt = "2026-10-10T00:00:00.000Z";
    if (scenario === "already implementing") f.audit.simulatorClaim!.plannedPaths = ["src/lib/automation/simulator-interactive-browser.ts"];
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
  });
  it("admits a fresh original public HTTP receipt for a newly runnable structural family", () => {
    expect(simulatorCapabilityWakeupReceipt(fixture())).toEqual({ sourceUrl: bookingUrl, requestId });
  });

  it("keeps the original HTTP receipt valid after a later browser-mode read", () => {
    const f = fixture();
    const state = f.audit.simulatorResearch!;
    state.history.push({ ...state.history[0], rendered: true,
      observedAt: "2026-10-09T17:50:30.000Z", requestId: "6bded88f-6195-4cc0-bf87-30e87c45ed80",
      publicReadEvidence: { ...state.history[0].publicReadEvidence!, method: "BROWSER", renderComplete: true } });
    state.readCount = 2;
    expect(simulatorCapabilityWakeupReceipt(f)).toEqual({ sourceUrl: bookingUrl, requestId });
  });

  it("rejects a newer denial on the same source and mode", () => {
    const f = fixture();
    const state = f.audit.simulatorResearch!;
    state.history.push({ ...state.history[0], observedAt: "2026-10-09T17:50:30.000Z",
      httpStatus: 403, requestId: "6bded88f-6195-4cc0-bf87-30e87c45ed80" });
    state.readCount = 2;
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
  });

  it.each([
    ["stale receipt", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.history[0].observedAt = "2026-10-09T17:29:59.000Z"; }],
    ["current reader", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.history[0].researchImplementationVersion = "public-calendar-known-readers-official-venue-links-v4"; }],
    ["previous known reader", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.history[0].researchImplementationVersion = "public-calendar-known-readers-passive-method-shapes-v3"; }],
    ["unknown URL", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.history[0].sourceUrl = "https://unknown.example/booking"; }],
    ["source drift", (f: ReturnType<typeof fixture>) => { f.sourceFingerprint = "c".repeat(64); }],
    ["missing request", (f: ReturnType<typeof fixture>) => { delete f.audit.simulatorResearch!.history[0].requestId; }],
    ["protected denial", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearchPriorFailures = { version: 1, sourceFingerprint: fingerprint,
      routes: [{ url: bookingUrl, rendered: false, httpStatus: 403 }] }; }],
    ["exhausted reads", (f: ReturnType<typeof fixture>) => { const state = f.audit.simulatorResearch!; state.history = Array(6).fill(state.history[0]); state.readCount = 6; }],
    ["planned implementation", (f: ReturnType<typeof fixture>) => { f.audit.simulatorClaim!.plannedPaths = ["src/lib/simulators/providers/uschedule.ts"]; }],
    ["missing launch chronology", (f: ReturnType<typeof fixture>) => { delete f.audit.launchStartedAt; }],
    ["out of order launch chronology", (f: ReturnType<typeof fixture>) => { f.audit.boundAt = "2026-10-09T17:40:30.000Z"; }],
    ["history predates claim", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.history[0].observedAt = "2026-10-09T17:42:59.000Z"; }],
    ["non-read history", (f: ReturnType<typeof fixture>) => { const state = f.audit.simulatorResearch!;
      state.history.unshift({ ...state.history[0], outcome: "NETWORK_FAILED", httpStatus: 0,
        observedAt: "2026-10-09T17:49:00.000Z", requestId: "4f8aa20a-d094-4e54-bcfb-a79126cf2255",
        publicReadEvidence: undefined }); state.readCount = 2; }],
    ["in flight", (f: ReturnType<typeof fixture>) => { f.audit.simulatorResearch!.inFlight = { requestId,
      startedAt: "2026-10-09T17:52:00.000Z", expiresAt: "2026-10-09T17:53:00.000Z",
      source: "booking", url: bookingUrl, rendered: false }; }],
  ])("rejects %s", (_name, change) => {
    const f = fixture(); change(f);
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
  });

  it("requires the original positive official handoff for a source link", () => {
    const f = fixture();
    const state = f.audit.simulatorResearch!;
    state.history[0].source = "link";
    expect(simulatorCapabilityWakeupReceipt(f)).toBeNull();
    state.history.unshift({ ...state.history[0], source: "official", requestedUrl: "https://stingers.example/",
      sourceUrl: "https://stingers.example/", observedAt: "2026-10-09T17:48:00.000Z",
      requestId: "17cf8e53-a51e-4c93-9250-4dc450daf4c1" });
    state.readCount = 2;
    expect(simulatorCapabilityWakeupReceipt(f)).toEqual({ sourceUrl: bookingUrl, requestId });
  });
});
