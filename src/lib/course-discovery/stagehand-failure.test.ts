// @vitest-environment node
import { expect, it } from "vitest";
import { createStagehandFailureCheckpoint, readStagehandFailure, packStagehandCheckpoint } from "../../../scripts/automation/course-discovery-stagehand-failure.mjs";
import { createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandDataHash, stagehandSourceFailureCode } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
import { sourceFailureDiagnostic } from "../../../scripts/automation/stagehand/source-diagnostic.mjs";
import { createDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";
import { deriveNativePhysicalContactSource } from "./teeitup-physical-contact-proof";
import { deriveForeupOfficialRouteContact } from "./foreup-official-route-ownership";
import { createStagehandNativeRouterFailureCapture } from "./stagehand-native-router-diagnostic";

const first = Date.parse("2030-01-02T12:00:00.000Z");
it("round-trips the original source host navigation rejection through the bound failure checkpoint only", () => {
  const f = fixture(), capture = createStagehandNativeRouterFailureCapture();
  capture.record("STAGEHAND_GUARDED_SOURCE_REJECTED", { phase: "SOURCE_HOST_REQUEST", sourceRequestGuard: "TRANSACTION_URL", method: "GET", resourceType: "document", rootFrame: true,
    url: "https://private.example/?token=SECRET", message: "PRIVATE_HTML" });
  f.report.sourceDiagnostic = sourceFailureDiagnostic({ phase: "OPEN", report: f.report, nativeRouterFailure: capture.snapshot(), cleanup: { browserClosed: true, modelClosed: true } });
  const saved = createStagehandFailureCheckpoint({ ...f, phase: "SOURCE_VALIDATION", sourceReport: f.report, error: Error("STAGEHAND_SOURCE_DISCOVERY_FAILED") });
  expect(saved.stagehandFailure.entries[0].diagnostic.nativeRouterFailure).toEqual(capture.snapshot());
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_HTML|SECRET|private.example/u);
  expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
});
it("retains the real ForeUP ownership rejection without granting source or resume authority", () => {
  let error: unknown;
  try { deriveForeupOfficialRouteContact({ venueName: "Public Golf Course", venueAddress: "12 Public Road, Denver, CO 80001, US", officialUrl: "https://public.example/", bookingUrl: "https://foreupsoftware.com/index.php/booking/12345/456#/teetimes", timeZone: "America/Denver" },
    { url: "https://public.example/", html: "PRIVATE_HTML", browserTransport: "NATIVE_CHROME" }, "+13035551234"); } catch (failure) { error = failure; }
  expect((error as Error).message).toBe("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");
  const f = fixture(), saved = createStagehandFailureCheckpoint({ ...f, phase: "FIXED_INSPECTION", error });
  expect(saved.stagehandFailure.entries[0].code).toBe("FOREUP_OFFICIAL_ROUTE_UNVERIFIED");expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_HTML");expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
  expect(stagehandSourceFailureCode({ ...f.report, outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "FOREUP_OFFICIAL_ROUTE_UNVERIFIED" }, f.job)).toBeUndefined();
});
it("retains the actual native physical rejection without admitting it as a source report or proof", () => {
  let error: unknown;
  try { deriveNativePhysicalContactSource({ venueName: "Public Club", venueAddress: "12 Public Road, Denver, CO 80001, US", officialUrl: "https://public.example/", bookingUrl: "https://public.book.teeitup.com/", timeZone: "America/Denver" },
    { url: "https://public.example/", html: "PRIVATE_HTML", browserTransport: "NATIVE_CHROME" }, "+13035551234"); } catch (failure) { error = failure; }
  expect(error).toBeInstanceOf(Error);expect((error as Error).message).toBe("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED");
  const f = fixture(), saved = createStagehandFailureCheckpoint({ ...f, phase: "FIXED_INSPECTION", error });
  expect(saved.stagehandFailure.entries[0].code).toBe("OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED");expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(saved.stagehandFailure.entries[0]).not.toHaveProperty("fixedInspectionDiagnostic");expect(JSON.stringify(saved)).not.toContain("PRIVATE_HTML");
  const forged = { ...f.report, outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "OFFICIAL_PHYSICAL_CONTACT_UNVERIFIED" };
  expect(stagehandSourceFailureCode(forged, f.job)).toBeUndefined();expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
});
it("retains current closed source stopping and native request lifecycle facts through the exact checkpoint hash", () => {
  const f = fixture();
  f.report.sourceDiagnostic = sourceFailureDiagnostic({ phase: "EXTRACT", report: f.report,
    sourceStop: { finalDecision: "UNRESOLVED", condition: "EXPLICIT_UNRESOLVED", lastActionKind: "openObservedFrameSource" },
    documentReadiness: { readyState: "loading", bodyPresent: true, mainDocumentCurrent: true, mainDocumentComplete: true, mainReadPending: false, pendingReads: 1, mainDocumentStatus: 200 },
    nativeRouterFailure: { code: "OWNED_STAGEHAND_CDP_UNAVAILABLE", phase: "CONTINUE_REQUEST_ACK", method: "GET", resourceType: "document",
      rootFrame: true, recordGenerationCurrent: true, recordGenerationRetired: false, recordAdmitted: true, recordPaused: false, recordFailed: false, recordComplete: false } });
  const saved = createStagehandFailureCheckpoint(f), entry = saved.stagehandFailure.entries[0];
  expect(entry.diagnostic.sourceStop.condition).toBe("EXPLICIT_UNRESOLVED");
  expect(entry.diagnostic.nativeRouterFailure.recordGenerationCurrent).toBe(true);
  expect(entry.diagnostic.sourceDocumentReadiness.readyState).toBe("loading");
  expect(entry.diagnosticSha256).toBe(stagehandDataHash(entry.diagnostic));
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  const forged = structuredClone(saved); forged.stagehandFailure.entries[0].diagnostic.sourceStop.reason = "PRIVATE";
  expect(readStagehandFailure({ ...f.job, checkpoint: forged }, f.now)).toBeUndefined();
});
it.each(["OFFICIAL_STREET_TYPE_OMITTED_UNVERIFIED", "OFFICIAL_STREET_TYPE_OMITTED_CHANGED"])("retains the closed physical-identity failure %s without copied proof facts", code => {
  const f = fixture(), error = Object.assign(Error(code), { privateHtml: "PRIVATE_HTML" });
  const saved = createStagehandFailureCheckpoint({ ...f, phase: "FIXED_INSPECTION", error });
  expect(saved.stagehandFailure.entries[0].code).toBe(code);
  expect(JSON.stringify(saved)).not.toContain("PRIVATE_HTML");
  expect(saved.stagehandFailure.entries[0]).not.toHaveProperty("fixedInspectionDiagnostic");
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
});
it.each(["INVALID_ADAPTER_SOURCE", "USCHEDULE_PUBLIC_LOCATION_UNVERIFIED"])("persists the actual public-source rejection %s without turning it into discovery authority", code => {
  const f = fixture(), error = Object.assign(Error(code), { privateHtml: "PRIVATE_HTML", cause: Error("PRIVATE_PROVIDER_BODY") });
  const saved = createStagehandFailureCheckpoint({ ...f, phase: "FIXED_INSPECTION", error });
  expect(saved.stagehandFailure.entries[0].code).toBe(code);
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_HTML|PRIVATE_PROVIDER_BODY/u);
  expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
  expect(stagehandSourceFailureCode({ ...f.report, outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code }, f.job)).toBeUndefined();
});
it("ignores forged error receipts and prior metrics rather than manufacturing current inspection facts", () => {
  const f = fixture(), diagnostic = { teeItUpDelegation: createDelegationDiagnostic("PROVIDER_BIND") };
  Object.assign(f.error, { fixedInspectionDiagnostic: diagnostic, inspectionReceipt: { actions: [{ teeItUpDelegation: diagnostic.teeItUpDelegation }] },
    details: { browserDiagnostics: diagnostic } });
  Object.assign(f.metrics.inspection, { fixedInspectionDiagnostic: diagnostic });
  const saved = createStagehandFailureCheckpoint({ ...f, phase: "FIXED_INSPECTION" });
  expect(saved.stagehandFailure.entries[0]).not.toHaveProperty("fixedInspectionDiagnostic");
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
});
it("reads optional closed inspection diagnostics without changing old checkpoint compatibility or source authority", () => {
  const f = fixture(), saved = createStagehandFailureCheckpoint(f);
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  const entry = saved.stagehandFailure.entries[0], diagnostic = { teeItUpDelegation: createDelegationDiagnostic("PROVIDER_BIND") };
  Object.assign(entry, { phase: "FIXED_INSPECTION", fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
  for (const mutate of [v => { v.fixedInspectionDiagnostic.teeItUpDelegation.gates.token = "PRIVATE"; },
    v => { v.fixedInspectionDiagnostic.teeItUpDelegation.gates.hopNoAccess = "PRIVATE"; },
    v => { delete v.fixedInspectionDiagnostic.teeItUpDelegation.gates.rootFresh; },
    v => { v.fixedInspectionDiagnostic.teeItUpDelegation.stage = "PRIVATE"; },
    v => { v.fixedInspectionDiagnosticSha256 = "b".repeat(64); }, v => { v.fixedInspectionDiagnosticOmittedForBudget = true; },
    v => { v.phase = "REPLAY"; }, v => { v.attempt = 2; }]) {
    const changed = structuredClone(saved); mutate(changed.stagehandFailure.entries[0]);
    expect(readStagehandFailure({ ...f.job, checkpoint: changed }, f.now)).toBeUndefined();
  }
  delete entry.fixedInspectionDiagnostic; entry.fixedInspectionDiagnosticOmittedForBudget = true;
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  delete entry.fixedInspectionDiagnosticSha256;
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toBeUndefined();
});
it("requires exact closed native fixed-inspection fields, current binding and digest without source authority", () => {
  const f = fixture(), saved = createStagehandFailureCheckpoint(f);
  const diagnostic = { nativeRouterFailure: { code: "NATIVE_REDIRECT_ROUTING_FAILED", operation: "RESPONSE_BODY", errorName: "Error", errorCategory: "BODY_UNAVAILABLE",
    requestUrlSha256: "a".repeat(64), method: "GET", resourceType: "stylesheet", networkIdPresent: true, identityPresent: false } };
  Object.assign(saved.stagehandFailure.entries[0], { phase: "FIXED_INSPECTION", fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
  for (const key of ["operation", "errorName", "errorCategory", "requestUrlSha256", "headers"] as const) {
    const changed = structuredClone(saved), entry = changed.stagehandFailure.entries[0];
    entry.fixedInspectionDiagnostic.nativeRouterFailure[key] = "PRIVATE";
    entry.fixedInspectionDiagnosticSha256 = stagehandDataHash(entry.fixedInspectionDiagnostic);
    expect(readStagehandFailure({ ...f.job, checkpoint: changed }, f.now)).toBeUndefined();
  }
  for (const delta of [{ phase: "REPLAY" }, { fixedInspectionDiagnosticSha256: "b".repeat(64) }]) {
    const changed = structuredClone(saved); Object.assign(changed.stagehandFailure.entries[0], delta);
    expect(readStagehandFailure({ ...f.job, checkpoint: changed }, f.now)).toBeUndefined();
  }
});
it("records the digest and omission explicitly when trimming replay diagnostics", () => {
  const diagnostic = { code: "BOUNDED_DIAGNOSTIC", padding: "x".repeat(33000) };
  const saved = packStagehandCheckpoint({ progress: { phase: "INDEPENDENT_REPLAY", replay: { result: { complete: false, diagnostic } } } });
  expect(saved.stagehandProgress.replay.result).toEqual({ complete: false, diagnosticSha256: stagehandDataHash(diagnostic), diagnosticOmittedForBudget: true });
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(32000);
});
it("rejects malformed or injected durable adapter read facts and preserves exact phase and hash binding", () => {
  const f = fixture(), saved = createStagehandFailureCheckpoint(f);
  const diagnostic = { adapterRead: { stage: "RESPONSE_HEADERS", role: "TEEITUP_DIRECTORY", httpStatus: 404,
    responseRedirected: false, responseUrlMatches: true, elapsedMs: 170, responseBytes: null, transportCode: "NONE" } };
  Object.assign(saved.stagehandFailure.entries[0], { phase: "FIXED_INSPECTION", fixedInspectionDiagnostic: diagnostic,
    fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) });
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: saved }, undefined, f.now)).toBeUndefined();
  for (const mutate of [v => { v.fixedInspectionDiagnostic.adapterRead.body = "PRIVATE"; },
    v => { v.fixedInspectionDiagnostic.adapterRead.httpStatus = 999; },
    v => { v.fixedInspectionDiagnostic.adapterRead.stage = "PRIVATE"; },
    v => { v.fixedInspectionDiagnostic.adapterRead.responseUrlMatches = "PRIVATE"; },
    v => { v.fixedInspectionDiagnostic.adapterRead.elapsedMs = 120001; },
    v => { delete v.fixedInspectionDiagnostic.adapterRead.role; },
    v => { v.fixedInspectionDiagnosticSha256 = "b".repeat(64); }, v => { v.phase = "REPLAY"; }]) {
    const changed = structuredClone(saved); mutate(changed.stagehandFailure.entries[0]);
    expect(readStagehandFailure({ ...f.job, checkpoint: changed }, f.now)).toBeUndefined();
  }
});
function fixture() {
  const official = "https://public-course.example/", booking = "https://public-booking.example/start?venue=public";
  const job = { id: "owned-job", attempts: 1, sourceFingerprint: "a".repeat(64), firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900000).toISOString(),
    request: { target: { courseId: "public-course", kind: "OUTDOOR" }, identity: { officialUrl: official }, input: { players: 2 }, trustedContext: { canonicalCoursePhone: "PRIVATE_PHONE" } } };
  const report = { jobId: job.id, firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt, startedAt: new Date(first + 100).toISOString(), finishedAt: new Date(first + 1000).toISOString(), workDeadlineAt: new Date(first + 120000).toISOString(),
    framework: { name: "Stagehand", version: "4.3.0" }, frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY", frameworkExtractedTimes: false,
    outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
    adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking },
    visitedUrls: [official, booking], officialLinkLedger: [{ pageUrl: official, links: [{ href: booking }] }], frameLedger: [],
    actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: booking }, afterUrl: booking }],
    initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 }, metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium", localCodexCalls: [] } };
  report.sourceDiagnostic = sourceFailureDiagnostic({ error: { code: "LOCAL_MODEL_RPC_FAILED", diagnostics: { phase: "account/read", message: "PRIVATE_MESSAGE" } }, phase: "MODEL_CLIENT", report,
    startedAt: Date.now(), cleanup: { browserClosed: true, modelClosed: true } });
  const metrics = { modelCalls: 2, tokenUsage: { totalTokens: 20 }, sourceElapsedMs: 1000, sourceResumed: false, replayDurationsMs: [100], inspection: { browserClosed: true } };
  return { job, report, metrics, now: first + 3000, startedAt: first + 2000, phase: "REPLAY", error: Object.assign(Error("DISCOVERY_REPLAY_INCOMPLETE"), { code: "DISCOVERY_REPLAY_INCOMPLETE" }) };
}

it("keeps exact valid routing under32KB while explicitly hashing omitted failure/progress diagnostics", () => {
  const f = fixture(); let reference = createStagehandSourceCheckpoint(f.job, f.report), index = 0;
  while (Buffer.byteLength(JSON.stringify(reference)) < 28000) {
    f.report.officialLinkLedger[0].links.push({ href: "https://bounded-public.example/" + index++ + "x".repeat(1700) });
    reference = createStagehandSourceCheckpoint(f.job, f.report);
  }
  const one = createStagehandFailureCheckpoint({ ...f, reference });
  const fixed = { teeItUpDelegation: createDelegationDiagnostic("ROOT_FRESH") };
  Object.assign(one.stagehandFailure.entries[0], { phase: "FIXED_INSPECTION", fixedInspectionDiagnostic: fixed, fixedInspectionDiagnosticSha256: stagehandDataHash(fixed) });
  f.job.attempts = 2;
  const saved = createStagehandFailureCheckpoint({ ...f, reference, previous: one.stagehandFailure,
    progress: { phase: "INDEPENDENT_REPLAY", replay: { result: { padding: "bounded-public-result".repeat(3000) } } } });
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(32000);
  expect(saved.stagehandSource).toEqual(reference);
  expect(saved.stagehandProgress).toMatchObject({ phase: "INDEPENDENT_REPLAY", replayOmittedForBudget: true });
  expect(saved.stagehandFailure.entries).toHaveLength(2);
  expect(saved.stagehandFailure.entries.every(entry => entry.diagnosticOmittedForBudget && !entry.diagnostic && /^[a-f0-9]{64}$/u.test(entry.diagnosticSha256))).toBe(true);
  expect(saved.stagehandFailure.entries[0]).toMatchObject({ fixedInspectionDiagnosticOmittedForBudget: true, fixedInspectionDiagnosticSha256: stagehandDataHash(fixed) });
  expect(saved.stagehandFailure.entries[0]).not.toHaveProperty("fixedInspectionDiagnostic");
  expect(readStagehandFailure({ ...f.job, checkpoint: saved }, f.now)).toEqual(saved.stagehandFailure);
  expect(readStagehandSourceCheckpoint({ ...f.job, checkpoint: saved }, undefined, f.now)).toEqual(reference);
});

it("rejects foreign, changed-input, malformed, and private diagnostic histories without retaining unknown fields", () => {
  const f = fixture(), saved = createStagehandFailureCheckpoint(f);
  expect(JSON.stringify(saved)).not.toMatch(/https:|PRIVATE|canonicalCoursePhone|selector|prompt|message/);
  for (const mutate of [value => { value.jobId = "foreign"; }, value => { value.sourceFingerprint = "b".repeat(64); },
    value => { value.entries[0].code = "PRIVATE_TOKEN_ABC"; }, value => { value.entries[0].private = "PRIVATE"; }, value => { value.entries[0].diagnostic.graph.sha256 = "b".repeat(64); }]) {
    const changed = structuredClone(saved.stagehandFailure); mutate(changed);
    expect(readStagehandFailure({ ...f.job, checkpoint: { stagehandFailure: changed } }, f.now)).toBeUndefined();
  }
  expect(readStagehandFailure({ ...f.job, request: { ...f.job.request, input: { players: 3 } }, checkpoint: saved }, f.now)).toBeUndefined();
  const malformed = fixture(); malformed.report.sourceDiagnostic.private = "PRIVATE";
  const projected = createStagehandFailureCheckpoint({ ...malformed, error: Error("PRIVATE_TOKEN_AND_URL https://private.example/") });
  expect(projected.stagehandFailure.entries[0]).toMatchObject({ code: "STAGEHAND_WORKER_FAILED" });
  expect(projected.stagehandFailure.entries[0]).not.toHaveProperty("diagnostic"); expect(JSON.stringify(projected)).not.toContain("PRIVATE");
});
