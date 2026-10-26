// @vitest-environment node
import { expect, it } from "vitest";
import { createStagehandFailureCheckpoint, readStagehandFailure, packStagehandCheckpoint } from "../../../scripts/automation/course-discovery-stagehand-failure.mjs";
import { createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandDataHash } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
import { sourceFailureDiagnostic } from "../../../scripts/automation/stagehand/source-diagnostic.mjs";
import { createDelegationDiagnostic } from "./teeitup-delegated-booking-diagnostic";

const first = Date.parse("2030-01-02T12:00:00.000Z");
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
it("records the digest and omission explicitly when trimming replay diagnostics", () => {
  const diagnostic = { code: "BOUNDED_DIAGNOSTIC", padding: "x".repeat(33000) };
  const saved = packStagehandCheckpoint({ progress: { phase: "INDEPENDENT_REPLAY", replay: { result: { complete: false, diagnostic } } } });
  expect(saved.stagehandProgress.replay.result).toEqual({ complete: false, diagnosticSha256: stagehandDataHash(diagnostic), diagnosticOmittedForBudget: true });
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(32000);
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
