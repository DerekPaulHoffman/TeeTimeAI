import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as worker from '../course-discovery-worker.mjs';
import { inspectStagehandAdapter, currentStagehandPrivateCourseNameComparison, currentStagehandInspectionDiagnostic } from '../course-discovery-stagehand-inspection.mjs';
import { createStagehandFailureCheckpoint, readStagehandFailure, packStagehandCheckpoint } from '../course-discovery-stagehand-failure.mjs';
import { stagehandDataHash } from '../course-discovery-stagehand-source.mjs';

const first = Date.parse('2030-01-02T12:00:00.000Z'), clock = first + 2000;
const official = 'https://unseen-course.example/', booking = 'https://unseen-public-booking.example/public';
const comparison = () => ({ schemaVersion: 1, kind: 'CPS_NAMED_COURSE_COMPARISON', observedAt: new Date(clock).toISOString(),
  canonicalName: 'harbor pointe', officialNames: ['north', 'south'], providerNames: ['harbor north', 'harbor south'] });
async function failedInspection() {
  const job = { id: 'owned-job', leaseToken: 'owned-token', sourceFingerprint: 'a'.repeat(64), attempts: 1,
    firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900000).toISOString(),
    request: { target: { courseId: 'course1', kind: 'OUTDOOR' }, demand: { searchId: 'search1', alertGeneration: 1 },
      identity: { name: 'Harbor Pointe', officialUrl: official, bookingUrl: booking, timeZone: 'UTC', address: '10 Public Road, Test City, CA 90001' },
      input: { date: '2030-01-03', timeZone: 'UTC', players: 2, startTime: '08:00', endTime: '18:00' } } };
  const report = { framework: { name: 'Stagehand', version: '4.3.0' }, jobId: job.id, firstPickedUpAt: job.firstPickedUpAt,
    deadlineAt: job.deadlineAt, workDeadlineAt: new Date(first + 120000).toISOString(), startedAt: new Date(first + 100).toISOString(),
    finishedAt: new Date(first + 1500).toISOString(), frameworkMode: 'HYBRID_SOURCE_DISCOVERY', frameworkRole: 'SOURCE_DISCOVERY_ONLY',
    frameworkExtractedTimes: false, outcome: 'SOURCE_PROPOSED_UNVERIFIED', browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
    adapterSourceProposal: { schemaVersion: 1, kind: 'EXISTING_ADAPTER_SOURCE', bookingUrl: booking },
    visitedUrls: [official, booking], officialLinkLedger: [{ pageUrl: official, links: [{ href: booking }] }], frameLedger: [],
    actions: [{ sourceUrl: official, action: { method: 'click' }, observedTarget: { tag: 'A', href: booking }, afterUrl: booking }],
    initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 },
    metrics: { model: 'gpt-6.1-sol', reasoningEffort: 'medium', localCodexCalls: [
      { model: 'gpt-6.1-sol', usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } }] } };
  const primary = Object.assign(Error('ADAPTER_IDENTITY_MISMATCH'), { code: 'ADAPTER_IDENTITY_MISMATCH', details: {
    browserDiagnostics: { cpsCatalogIdentityFailureStage: 'NAMED_COURSE_NAMES' }, privateCourseNameComparison: comparison() } });
  let current = official, closed = 0;
  const browser = worker.createDiscoveryBrowser({ cwd: process.cwd(), deadlineAt: job.deadlineAt, initialUrls: [official],
    processFactory: () => ({ request: async action => {
      if (action.action === 'inspect_adapter') throw primary;
      if (action.action === 'open') current = action.url;
      return { url: current, browserTransport: 'NATIVE_CHROME', navigationStatus: 200, accessRequirementObserved: false,
        loading: false, pendingRequestCount: 0, controls: [{ kind: 'link', href: booking }], frames: [],
        nativeMainDocumentContinuity: { kind: 'NATIVE_MAIN_DOCUMENT_CONTINUITY_V1', originalUrlSha256: stagehandDataHash(current),
          currentUrlSha256: stagehandDataHash(current), documentBindingSha256: 'c'.repeat(64), observedAt: clock, status: 200 } };
    }, close: async () => { closed++; } }) });
  await assert.rejects(inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal, job, cwd: process.cwd(),
    workDeadlineAt: new Date(first + 720000).toISOString(), now: () => clock, client: { helperEnvironment: () => ({
      COURSE_DISCOVERY_BROWSER_TRANSPORT: 'NATIVE_CHROME', COURSE_DISCOVERY_JOB_ID: job.id,
      COURSE_DISCOVERY_JOB_KIND: 'discovery', COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken }) },
    worker: { ...worker, createDiscoveryBrowser: () => browser } }), error => error === primary);
  assert.equal(closed, 1);
  const checkpoint = createStagehandFailureCheckpoint({ job, report, error: primary, phase: 'FIXED_INSPECTION', metrics: {}, now: clock, startedAt: clock });
  return { job, primary, checkpoint };
}

test('carries private inputs through the actual inspection and bound failure checkpoint without receipt disclosure', async () => {
  const { job, primary, checkpoint } = await failedInspection();
  assert.deepEqual(currentStagehandPrivateCourseNameComparison(primary, job, clock, clock), comparison());
  for (const [error, scope, start, end] of [[{ ...primary }, job, clock, clock], [primary, { ...job }, clock, clock],
    [primary, job, clock + 1, clock + 1], [primary, job, clock, clock - 1]])
    assert.equal(currentStagehandPrivateCourseNameComparison(error, scope, start, end), undefined);
  assert.ok(!JSON.stringify(primary.inspectionReceipt).includes('harbor north'));
  assert.ok(!JSON.stringify(currentStagehandInspectionDiagnostic(primary, job, clock, clock)).includes('harbor north'));
  const saved = readStagehandFailure({ ...job, checkpoint }, clock);
  assert.deepEqual(saved, checkpoint.stagehandFailure);
  assert.deepEqual(saved.entries[0].privateCourseNameComparison, comparison());
  for (const change of [v => v.entries[0].privateCourseNameComparison.providerNames[0] = 'changed',
    v => v.jobId = 'foreign', v => v.sourceFingerprint = 'b'.repeat(64), v => v.requestSha256 = 'b'.repeat(64),
    v => v.entries[0].privateCourseNameComparison.observedAt = new Date(first - 1).toISOString()]) {
    const malformed = structuredClone(saved); change(malformed);
    assert.equal(readStagehandFailure({ ...job, checkpoint: { stagehandFailure: malformed } }, clock), undefined);
  }
  const overhead = Buffer.byteLength(JSON.stringify({ stagehandFailure: saved, stagehandProgress: { padding: '' } }));
  const packed = packStagehandCheckpoint({ failure: saved, progress: { padding: 'x'.repeat(32001 - overhead) } });
  assert.equal(packed.stagehandFailure.entries[0].privateCourseNameComparison, undefined);
  assert.equal(packed.stagehandFailure.entries[0].privateCourseNameComparisonOmittedForBudget, true);
  assert.deepEqual(readStagehandFailure({ ...job, checkpoint: packed }, clock), packed.stagehandFailure);
});

test('separates bounded private NDJSON from the closed browser transport diagnostics', async () => {
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: 0 });
  child.stdin.on('data', data => {
    const { id } = JSON.parse(String(data));
    child.stdout.write(JSON.stringify({ id, ok: false, error: 'ADAPTER_IDENTITY_MISMATCH', privateCourseNameComparison: comparison(),
      diagnostics: { cpsCatalogIdentityFailureStage: 'NAMED_COURSE_NAMES', privateCourseNameComparison: comparison() } }) + '\n');
  });
  const process = worker.createDiscoveryProcess({ executable: 'fixture', args: [], environment: {}, spawnProcess: () => child });
  try {
    await assert.rejects(process.request({ action: 'inspect_adapter' }), error => {
      assert.deepEqual(error.details.privateCourseNameComparison, comparison());
      assert.equal(error.details.browserDiagnostics.cpsCatalogIdentityFailureStage, 'NAMED_COURSE_NAMES');
      assert.ok(!JSON.stringify(error.details.browserDiagnostics).includes('harbor north'));
      return error.code === 'ADAPTER_IDENTITY_MISMATCH';
    });
  } finally { await process.close(); }
});
