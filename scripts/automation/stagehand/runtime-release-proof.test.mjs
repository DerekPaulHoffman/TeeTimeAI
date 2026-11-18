import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDiscoveryRuntimeRelease, waitForDiscoveryRuntimeRelease } from '../course-discovery-runtime-release.mjs';
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

function waitingFixture() {
  const value = fixture(); let time = 0, reads = 0, inspections = 0;
  const pending = { ...value.runs[0], databaseId: 43, startedAt: '2026-11-18T13:00:00Z', status: 'in_progress', conclusion: '' };
  return { value, pending, dependencies: { now: () => time, sleep: async ms => { time += ms; }, waitMs: 30000 },
    input: { runtimeVersion: sha, readRuns: async () => { reads++; return reads < 3 ? [...value.runs, pending] : [...value.runs, { ...pending, status: 'completed', conclusion: 'success' }]; },
      readDeploymentEvidence: async () => { inspections++; return { deployments: value.deployments, inspections: value.inspections }; } },
    counts: () => ({ reads, inspections, time }) };
}

test('waits for newer main CI without inspecting deployment or performing any mutation until it passes', async () => {
  const f = waitingFixture();
  assert.equal((await waitForDiscoveryRuntimeRelease(f.input, f.dependencies)).ciRunId, 43);
  assert.deepEqual(f.counts(), { reads: 4, inspections: 1, time: 30000 });
});

test('a newer failed run stops instead of replaying qualification or using an older branch pass', async () => {
  const f = waitingFixture(); f.pending.status = 'completed'; f.pending.conclusion = 'failure';
  await assert.rejects(waitForDiscoveryRuntimeRelease(f.input, f.dependencies), { code: 'RUNTIME_CI_REQUIRED' });
  assert.deepEqual(f.counts(), { reads: 1, inspections: 0, time: 0 });
});

test('pending CI has a finite diagnostic timeout and never grants release readiness', async () => {
  const f = waitingFixture(); f.input.readRuns = async () => [f.pending];
  await assert.rejects(waitForDiscoveryRuntimeRelease(f.input, f.dependencies), { code: 'RUNTIME_CI_PENDING_TIMEOUT' });
  assert.deepEqual(f.counts(), { reads: 0, inspections: 0, time: 30000 });
});

test('a newly started rerun during alias inspection is observed before accepting the proof', async () => {
  const f = waitingFixture(); let reads = 0;
  f.input.readRuns = async () => {
    reads++; return reads === 1 ? f.value.runs : reads < 4 ? [f.pending] : [{ ...f.pending, status: 'completed', conclusion: 'success' }];
  };
  assert.equal((await waitForDiscoveryRuntimeRelease(f.input, f.dependencies)).ciRunId, 43);
  assert.equal(f.counts().inspections, 2);
  assert.equal(f.counts().time, 30000);
});

test('malformed CI, command errors and alias drift are not retried as pending readiness', async () => {
  for (const scenario of ['malformed', 'command', 'alias']) {
    const f = waitingFixture();
    f.input.readRuns = async () => {
      if (scenario === 'command') throw Object.assign(new Error('private child detail'), { code: 'EUNKNOWN' });
      return scenario === 'malformed' ? [{ ...f.pending, attempt: 0 }] : f.value.runs;
    };
    if (scenario === 'alias') f.value.inspections[0].inspection.url = 'wrong.vercel.app';
    await assert.rejects(waitForDiscoveryRuntimeRelease(f.input, f.dependencies));
    assert.equal(f.counts().time, 0);
  }
});

test('the real proof CLI emits only a closed diagnostic for an invalid request without invoking services', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../course-discovery-runtime-release.mjs', import.meta.url)), '--runtime-sha', 'invalid'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, outcome: 'blocked', reasonCode: 'INVALID_RUNTIME_VERSION' });
  assert.equal(result.stderr.trim(), 'INVALID_RUNTIME_VERSION');
});
