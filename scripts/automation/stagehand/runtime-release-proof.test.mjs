import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryRuntimeRelease } from '../course-discovery-runtime-release.mjs';
const sha = 'a'.repeat(40);
function fixture() { return { runtimeVersion: sha, runs: [{ headSha: sha, status: 'completed', conclusion: 'success', databaseId: 42,
  startedAt: '2026-11-18T12:00:00Z', attempt: 1 }],
  deployments: [{ url: 'fixture.vercel.app', state: 'READY', createdAt: 1800000000000,
    meta: { githubCommitSha: sha, githubCommitRef: 'main', githubDeployment: '1', branchAlias: 'fixture-git-main.vercel.app' } }],
  inspections: ['teetimespot.com', 'www.teetimespot.com'].map(alias => ({ alias,
    inspection: { id: 'dpl_fixture', readyState: 'READY', url: 'fixture.vercel.app' } })) }; }
test('requires exact successful CI, Git production provenance and both current aliases', () => {
  assert.equal(validateDiscoveryRuntimeRelease(fixture()).deployment.commitSha, sha);
  for (const mutate of [x => { x.runs[0].headSha = 'b'.repeat(40); }, x => { x.runs[0].conclusion = 'failure'; },
    x => { x.deployments[0].meta.githubCommitRef = 'feature'; }, x => { x.deployments[0].state = 'BUILDING'; },
    x => { x.inspections[0].inspection.url = 'stale.vercel.app'; }, x => { x.inspections[1].inspection.id = 'dpl_other'; },
    x => { x.inspections[1].alias = 'unrelated.example'; }]) {
    const value = fixture(); mutate(value); assert.throws(() => validateDiscoveryRuntimeRelease(value));
  }
});

test('a later exact-head failure cannot be masked by an older successful run in either input order', () => {
  for (const reversed of [false, true]) {
    const value = fixture();
    value.runs.push({ ...value.runs[0], databaseId: 43, startedAt: '2026-11-18T13:00:00Z', conclusion: 'failure' });
    if (reversed) value.runs.reverse();
    assert.throws(() => validateDiscoveryRuntimeRelease(value), { code: 'RUNTIME_CI_REQUIRED' });
  }
});

test('a successful later rerun can recover qualification, including an older run id', () => {
  const value = fixture();
  value.runs.push({ ...value.runs[0], databaseId: 43, startedAt: '2026-11-18T13:00:00Z', conclusion: 'failure' });
  value.runs[0] = { ...value.runs[0], attempt: 2, startedAt: '2026-11-18T14:00:00Z' };
  assert.equal(validateDiscoveryRuntimeRelease(value).ciRunId, 42);
});

test('pending later runs and malformed exact-head ordering evidence fail closed', () => {
  for (const override of [
    { status: 'in_progress', conclusion: '' }, { status: 'queued', conclusion: '' },
    { startedAt: undefined }, { startedAt: 'invalid' }, { startedAt: 42 }, { attempt: 0 }, { databaseId: undefined },
  ]) {
    const value = fixture();
    value.runs.push({ ...value.runs[0], databaseId: 43, startedAt: '2026-11-18T13:00:00Z', ...override });
    assert.throws(() => validateDiscoveryRuntimeRelease(value), { code: 'RUNTIME_CI_REQUIRED' });
  }
});

test('ignores unrelated heads and uses the newest run id to break equal start times', () => {
  const value = fixture();
  value.runs.push({ ...value.runs[0], headSha: 'b'.repeat(40), databaseId: 100, conclusion: 'failure' });
  assert.equal(validateDiscoveryRuntimeRelease(value).ciRunId, 42);
  value.runs.push({ ...value.runs[0], databaseId: 43, conclusion: 'failure' });
  assert.throws(() => validateDiscoveryRuntimeRelease(value), { code: 'RUNTIME_CI_REQUIRED' });
});
