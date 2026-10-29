import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixedInspectionFrameWitness, freshFixedInspectionFrameEdge, incompleteInspectionOfficial,
  inspectionLandingDiagnostic, safeInspectionLandingDiagnostic } from '../course-discovery-stagehand-inspection.mjs';

const witness = { parentUrl: 'https://course.example/golf', frameUrl: 'https://public.example/html/widget' };
const snapshot = { url: witness.parentUrl, officialSourceDiagnostic: { rawOfficialCaptured: true,
  currentOfficialDocument: false }, frames: [{ url: witness.frameUrl, source: 'FIXED_INSPECTION_FRAME_SRC' }] };

test('only an exact current privately tagged frame advances a fixed edge even while parent identity is incomplete', () => {
  assert.equal(freshFixedInspectionFrameEdge(snapshot, witness, witness.frameUrl), true);
  for (const changed of [
    { url: 'https://course.example/other' },
    { frames: [{ url: witness.frameUrl }] },
    { frames: [{ url: witness.frameUrl, source: 'OFFICIAL_IFRAME_SRC' }] },
    { frames: [{ url: `${witness.frameUrl}?changed=1`, source: 'FIXED_INSPECTION_FRAME_SRC' }] },
  ]) assert.equal(freshFixedInspectionFrameEdge({ ...snapshot, ...changed }, witness, witness.frameUrl), false);
  assert.equal(freshFixedInspectionFrameEdge(snapshot, witness, 'https://public.example/other'), false);
  assert.equal(freshFixedInspectionFrameEdge(snapshot, undefined, witness.frameUrl), false);
  assert.equal(incompleteInspectionOfficial(snapshot, false, false, true), true);
  assert.equal(incompleteInspectionOfficial(snapshot, false,
    freshFixedInspectionFrameEdge(snapshot, witness, witness.frameUrl), true), false);
});

const root = 'https://course.example/';
const sourceReport = () => ({ startedAt: '2030-01-02T12:00:00.000Z', finishedAt: '2030-01-02T12:00:02.000Z',
  visitedUrls: [root], nativeFrameNavigations: [], frameLedger: [{ kind: 'NATIVE_VISIBLE_FRAME', pageUrl: root,
    observedAt: '2030-01-02T12:00:01.000Z', documentHash: 'a'.repeat(64), frames: [{ src: witness.frameUrl, visible: true }] }] });

test('an unclicked private visible-frame route constrains the unchanged fresh helper capability', () => {
  const report = sourceReport(), path = [root, witness.frameUrl];
  const result = fixedInspectionFrameWitness(report, path, root);
  assert.deepEqual({ ...result, sourceReportSha256: undefined }, { kind: 'FIXED_INSPECTION_SOURCE_FRAME',
    officialUrl: root, parentUrl: root, frameUrl: witness.frameUrl, sourceReportSha256: undefined });
  assert.match(result.sourceReportSha256, /^[a-f0-9]{64}$/u);
  // Repeated observations of the same edge are not distinct routing choices.
  report.frameLedger.push(structuredClone(report.frameLedger[0]));
  assert.equal(fixedInspectionFrameWitness(report, path, root).frameUrl, witness.frameUrl);
  assert.notEqual(fixedInspectionFrameWitness(report, path, root).sourceReportSha256, result.sourceReportSha256);
});

test('proposal, ordinary ledger, stale, malformed or off-path frame facts cannot create the private witness', () => {
  const changes = [
    r => { r.frameLedger = []; r.adapterSourceProposal = { bookingUrl: witness.frameUrl }; },
    r => { delete r.frameLedger[0].kind; },
    r => { r.frameLedger[0].observedAt = '2030-01-02T11:59:59.000Z'; },
    r => { r.frameLedger[0].observedAt = '2030-01-02T12:00:03.000Z'; },
    r => { r.frameLedger[0].observedAt = '2030-01-02T12:00:01Z'; },
    r => { r.frameLedger[0].documentHash = 'bad'; },
    r => { r.frameLedger[0].pageUrl = 'https://other.example/'; },
    r => { r.visitedUrls = []; },
    r => { r.frameLedger[0].frames[0].visible = false; },
    r => { r.frameLedger[0].frames.push(structuredClone(r.frameLedger[0].frames[0])); },
    ...['srcdoc', 'inForm', 'handler'].map(key => r => { r.frameLedger[0].frames[0][key] = true; }),
    r => { r.frameLedger[0].frames[0].src = `${witness.frameUrl}?changed=1`; },
    r => { r.frameLedger[0].frames = Array.from({ length: 25 }, (_, i) => ({ src: `https://public.example/${i}`, visible: true })); },
  ];
  for (const change of changes) {
    const report = sourceReport(); change(report);
    assert.equal(fixedInspectionFrameWitness(report, [root, witness.frameUrl], root), undefined);
  }
});

test('two distinct privately witnessed frame edges on one path fail closed', () => {
  const report = sourceReport(), second = 'https://public.example/next';
  report.visitedUrls.push(witness.frameUrl);
  report.frameLedger.push({ ...structuredClone(report.frameLedger[0]), pageUrl: witness.frameUrl, frames: [{ src: second, visible: true }] });
  assert.throws(() => fixedInspectionFrameWitness(report, [root, witness.frameUrl, second], root), /FRAMEWORK_INSPECTION_SCOPE_INVALID/u);
});

test('landing diagnostics distinguish an observed root alias from an unbound final frame document without exposing URLs', () => {
  const alias = 'https://course.example/golf', frame = 'https://provider.example/widget', final = 'https://provider.example/public';
  const path = [root, alias, frame], frameWitness = { parentUrl: alias, frameUrl: frame };
  const first = inspectionLandingDiagnostic({ url: alias }, path, 0, undefined, frameWitness);
  assert.deepEqual([first.position, first.snapshotPathIndex, first.logicalPathIndex, first.remainingPathIndex], [0, 1, 1, 1]);
  const failed = inspectionLandingDiagnostic({ url: final }, path, 2, undefined, frameWitness);
  assert.deepEqual([failed.position, failed.pathLength, failed.snapshotPathIndex, failed.logicalPathIndex,
    failed.remainingPathIndex, failed.nativeContextPresent, failed.frameParentPosition, failed.frameChildPosition],
  [2, 3, -1, -1, -1, false, 1, 2]);
  assert.equal(failed.nativeOriginalUrlSha256, null);
  assert.equal(JSON.stringify(failed).includes('https:'), false);
  assert.deepEqual(safeInspectionLandingDiagnostic(failed), failed);
  const bound = inspectionLandingDiagnostic({ url: final }, path, 2, { originalUrl: frame }, frameWitness);
  assert.deepEqual([bound.snapshotPathIndex, bound.logicalPathIndex, bound.remainingPathIndex, bound.nativeContextPresent], [-1, 2, 2, true]);
});

test('landing diagnostic projection is finite, closed and cannot carry copied page content', () => {
  const value = inspectionLandingDiagnostic({ url: 'https://provider.example/other' }, [root, witness.frameUrl], 1);
  for (const change of [{ url: 'https://private.example/secret' }, { position: -1 }, { position: 2 },
    { pathLength: 7 }, { snapshotPathIndex: 6 }, { expectedUrlSha256: 'bad' }, { nativeContextPresent: 'true' }])
    assert.equal(safeInspectionLandingDiagnostic({ ...value, ...change }), undefined);
  assert.equal(inspectionLandingDiagnostic({ url: 'file:///private' }, [root], 0), undefined);
  assert.equal(inspectionLandingDiagnostic({ url: root }, [root], 1), undefined);
});
