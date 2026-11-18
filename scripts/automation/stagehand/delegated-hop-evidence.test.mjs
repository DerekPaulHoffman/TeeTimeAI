import test from 'node:test';
import assert from 'node:assert/strict';
import { safeTeeItUpDelegationDiagnostic } from '../course-discovery-worker.mjs';
import { readStagehandFailure } from '../course-discovery-stagehand-failure.mjs';
import { stagehandDataHash } from '../course-discovery-stagehand-source.mjs';

const keys = ['capabilityAvailable','sourceValid','deadlineCurrent','rootReadReturned','rootFresh','rootUrlExact','rootDocumentProvenance',
  'canonicalAddressValid','rootRawVenue','rootRenderedVenue','rootRawAddress','rootRenderedAddress','physicalRaw','physicalRendered','physicalNameRelation','physicalPhone','rootLinkVerified','hopNative',
  'hopRawBounded','hopRawLinkPresent','hopRenderedLinkPresent','hopUnique','firstReadReturned','firstFresh','secondLinkVerified',
  'secondReadReturned','rootRefreshRequired','rootRefreshReturned','rootRefreshIdentityMatches','rootRefreshLinkMatches','finalFresh','finalUrlMatches',
  'directoryValid','directoryIdsUnique','providerUniqueMatch','hopSessionOpen','hopNoAccess','hopNoFatal','hopStatus200','hopCaptured',
  'hopUrlMatches','hopCaptureFresh','hopTimeOriginMatches','hopRawClosed','hopNativeTransport'];
function fixture() {
  return { stage: 'HOP_TWO_LINK', gates: Object.fromEntries(keys.map(key => [key, null])), hopEvidence: {
    schemaVersion: 1, observedAt: '2030-01-01T12:00:01.000Z', attestedAt: '2030-01-01T12:00:00.000Z',
    provenance: 'NATIVE_DELEGATED', freshNativeCapture: true,
    raw: { bounded: true, omitted: false, anchorCount: 0, requestedAnchorCount: 0, unrenderedAnchorCount: 0,
      frameCount: 1, requestedFrameCount: 1, hiddenFrameCount: 0, formFrameCount: 0, srcdocFrameCount: 0 },
    rendered: { linkCount: 0, linkListAtLimit: false, requestedLinkPresent: false, framesState: 'OMITTED', frameCount: null,
      visibleFrameCount: null, requestedFrameCount: null, hiddenFrameCount: null, formFrameCount: null, srcdocFrameCount: null, matchingRawSourceCount: null }
  } };
}
test('retains bounded structural hop evidence through the failed-learner diagnostic handoff', () => {
  const value = fixture();
  assert.deepEqual(safeTeeItUpDelegationDiagnostic(value), value);
  assert.ok(!JSON.stringify(value).match(/https:|cookie|token|<html|PRIVATE/iu));
});

test('retains only optional boolean facility-binding gates without changing historical checkpoint shape', () => {
  const old = fixture();
  assert.deepEqual(safeTeeItUpDelegationDiagnostic(old), old);
  const value = { ...old, stage: 'PROVIDER_BIND', gates: { ...old.gates, directoryNameMatch: true,
    directoryNameTimeZoneMatch: true, directoryIdentityMatch: true, directoryIdentityUnique: true,
    directoryIdentityOutdoor: false, directoryIdentitySimulator: false, directoryIdentityKindMissing: true,
    directoryPhysicalFallbackAvailable: false, directoryPhysicalFallbackRequired: false, directoryPostalRepresentationMatch: false } };
  assert.deepEqual(safeTeeItUpDelegationDiagnostic(value), value);
  value.gates.directoryIdentityKindMissing = 'PRIVATE';
  const safe = safeTeeItUpDelegationDiagnostic(value);
  assert.equal(safe.gates.directoryIdentityKindMissing, undefined);
  assert.equal(safe.gates.directoryIdentityMatch, true);
  assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
});
test('preserves historical gates but drops malformed or content-bearing new evidence', () => {
  for (const change of [v => v.raw.frameCount = 20001, v => v.raw.html = 'PRIVATE', v => v.observedAt = 'PRIVATE',
    v => v.rendered.framesState = 'PRIVATE', v => v.cookie = 'PRIVATE', v => v.freshNativeCapture = 'PRIVATE']) {
    const value = fixture(); change(value.hopEvidence);
    const result = safeTeeItUpDelegationDiagnostic(value);
    assert.equal(result.hopEvidence, undefined);
    assert.deepEqual(result.gates, value.gates);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  const old = fixture(); delete old.hopEvidence;
  assert.deepEqual(safeTeeItUpDelegationDiagnostic(old), old);
});
test('round-trips evidence in the original job-bound failure checkpoint and rejects digest or source drift', () => {
  for (const withBinding of [false, true]) {
  const diagnostic = { teeItUpDelegation: fixture() };
  if (withBinding) {
    delete diagnostic.teeItUpDelegation.hopEvidence;
    diagnostic.teeItUpDelegation.stage = 'PROVIDER_BIND';
    Object.assign(diagnostic.teeItUpDelegation.gates, { directoryNameMatch: true, directoryNameTimeZoneMatch: true,
      directoryIdentityMatch: false, directoryIdentityUnique: false, directoryIdentityOutdoor: false,
      directoryIdentitySimulator: false, directoryIdentityKindMissing: false, directoryPhysicalFallbackAvailable: false,
      directoryPhysicalFallbackRequired: false, directoryPostalRepresentationMatch: false });
  }
  const job = { id: 'job1', sourceFingerprint: 'a'.repeat(64), request: { target: { courseId: 'course1' } }, attempts: 1,
    firstPickedUpAt: '2030-01-01T12:00:00.000Z', deadlineAt: '2030-01-01T12:15:00.000Z' };
  const failure = { schemaVersion: 1, kind: 'OWN_STAGEHAND_FAILURE_DIAGNOSTIC', jobId: job.id, sourceFingerprint: job.sourceFingerprint,
    requestSha256: stagehandDataHash(job.request), firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt, entries: [{
      attempt: 1, observedAt: '2030-01-01T12:00:02.000Z', phase: 'FIXED_INSPECTION', code: 'OFFICIAL_DELEGATED_SOURCE_UNVERIFIED',
      counts: { completedModelCalls: 0, sourceElapsedMs: 0, workerElapsedMs: 2000, completedReplays: 0 },
      tokenUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 },
      cleanup: { sourceBrowserClosed: true, sourceModelClosed: true, inspectionBrowserClosed: true }, sourceResumed: false,
      fixedInspectionDiagnostic: diagnostic, fixedInspectionDiagnosticSha256: stagehandDataHash(diagnostic) }] };
  const now = Date.parse('2030-01-01T12:00:03.000Z');
  assert.deepEqual(readStagehandFailure({ ...job, checkpoint: { stagehandFailure: failure } }, now), failure);
  assert.ok(Buffer.byteLength(JSON.stringify(failure)) < 4000);
  assert.equal(readStagehandFailure({ ...job, sourceFingerprint: 'b'.repeat(64), checkpoint: { stagehandFailure: failure } }, now), undefined);
  if (withBinding) failure.entries[0].fixedInspectionDiagnostic.teeItUpDelegation.gates.directoryIdentityMatch = true;
  else failure.entries[0].fixedInspectionDiagnostic.teeItUpDelegation.hopEvidence.raw.frameCount++;
  assert.equal(readStagehandFailure({ ...job, checkpoint: { stagehandFailure: failure } }, now), undefined);
  }
});
