import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDiscoveryRuntimeRelease } from '../course-discovery-runtime-release.mjs';
const sha = 'a'.repeat(40);
function fixture() { return { runtimeVersion: sha, runs: [{ headSha: sha, status: 'completed', conclusion: 'success', databaseId: 42 }],
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
