import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshFixedInspectionFrameEdge, incompleteInspectionOfficial } from '../course-discovery-stagehand-inspection.mjs';

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
