import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createCourseDiscoveryClient } from '../course-discovery-client.mjs';

test('signs the committed runtime with recovery admission requests', async () => {
  const runtimeVersion = 'a'.repeat(40), deviceToken = 'fixture-device-secret-only';
  let observed;
  const client = createCourseDiscoveryClient({ baseUrl: 'https://example.test', deviceToken, runtimeVersion,
    now: () => 1_800_000_000_000, fetchImpl: async (url, options) => {
      observed = { url, ...options }; return new Response('{"job":null}');
    } });
  assert.deepEqual(await client.next('worker-fixture'), { job: null });
  assert.deepEqual(JSON.parse(observed.body), { workerId: 'worker-fixture', runtimeVersion });
  const path = '/api/course-discovery/jobs/next';
  assert.equal(observed.headers['x-local-reader-signature'], createHmac('sha256', deviceToken)
    .update(`POST\n${path}\n1800000000000\n${observed.body}`).digest('hex'));
});

test('keeps legacy requests unchanged and rejects non-commit runtime metadata', async () => {
  let body;
  const settings = { baseUrl: 'https://example.test', deviceToken: 'fixture-device-secret-only',
    fetchImpl: async (_url, options) => { body = options.body; return new Response('{"job":null}'); } };
  await createCourseDiscoveryClient(settings).next('worker-fixture');
  assert.deepEqual(JSON.parse(body), { workerId: 'worker-fixture' });
  for (const runtimeVersion of ['main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), 'a'.repeat(40) + '\n']) {
    assert.throws(() => createCourseDiscoveryClient({ ...settings, runtimeVersion }), /INVALID_DISCOVERY_RUNTIME_VERSION/);
  }
});
