import { describe, expect, it } from "vitest";
import type { CourseDispatchAudit } from "./course-support-course-dispatch";
import { simulatorCapabilityWakeupReceipt } from "./simulator-capability-wakeup";

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
