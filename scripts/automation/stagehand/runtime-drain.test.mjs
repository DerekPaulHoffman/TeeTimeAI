import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeDrainReader } from '../course-discovery-runtime-drain.mjs';
import { createCourseDiscoverySupervisor } from '../course-discovery-supervisor.mjs';

const nonce = '12345678-1234-4234-8234-123456789abc', oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40);
const clock = Date.parse('2026-11-18T12:00:00.000Z');
const request = { schemaVersion: 1, purpose: 'UPGRADE_READER_RUNTIME', nonce, fromRuntimeVersion: oldSha,
  targetRuntimeVersion: newSha, issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 180000).toISOString() };
function reader(value, runtimeVersion = oldSha, changes = {}) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return createRuntimeDrainReader({ path: 'private-fixture', runtimeVersion, now: () => clock,
    read: () => raw, stat: () => ({ isFile: () => true, isSymbolicLink: () => false, size: Buffer.byteLength(raw), ...changes }) });
}

test('honors only the exact expiring request on its old or target runtime', () => {
  assert.deepEqual(reader(request)(), { nonce });
  assert.deepEqual(reader(request, newSha)(), { nonce });
  assert.equal(reader(request, 'c'.repeat(40))(), null);
  assert.equal(reader({ ...request, expiresAt: new Date(clock).toISOString() })(), null);
  assert.equal(reader({ ...request, expiresAt: new Date(clock + 180001).toISOString() })(), null);
  assert.equal(reader({ ...request, nonce: 'unknown' })(), null);
  assert.equal(reader({ ...request, extra: 'not-permitted' })(), null);
  assert.equal(reader('invalid')(), null);
  assert.equal(reader(request, oldSha, { isSymbolicLink: () => true })(), null);
  assert.equal(reader(request, oldSha, { size: 4097 })(), null);
});

test('draining prevents both warm and cold admission and model preparation', async () => {
  let drain = { nonce }, cold = 0, warm = 0, prepared = 0;
  const events = [];
  const supervisor = createCourseDiscoverySupervisor({ runtimeVersion: oldSha, mode: 'STAGEHAND_SOL', readDrain: () => drain,
    client: { nextExecution: async () => { warm++; return { job: null }; }, next: async () => { cold++; return { job: null }; } },
    executeRecipe: async () => { throw Error('no execution'); }, prepareWorker: async () => { prepared++; },
    startWorker: async () => { throw Error('no worker'); }, onEvent: e => events.push(e) });
  await supervisor.tick();
  assert.equal(cold, 0); assert.equal(warm, 0); assert.equal(prepared, 0);
  assert.deepEqual(events.at(-1), { event: 'poll_completed', active: 0, observedAt: events.at(-1).observedAt,
    runtimeVersion: oldSha, workerMode: 'STAGEHAND_SOL', drainNonce: nonce, drained: true });
  drain = null;
  await supervisor.tick();
  assert.equal(cold, 1); assert.equal(warm, 1); assert.equal(prepared, 1);
  assert.equal(events.at(-1).drainNonce, undefined);
  await supervisor.stop();
});

test('draining waits for an existing operation without aborting or failing it', async () => {
  let drain = null, admitted = false, finish, signal, claims = 0, failures = 0, done;
  const pending = new Promise(resolve => { finish = resolve; });
  const finished = new Promise(resolve => { done = resolve; });
  const events = [], now = Date.now();
  const job = { id: 'fixture-job', leaseToken: 'fixture-lease-token-long', attempts: 1,
    firstPickedUpAt: new Date(now).toISOString(), deadlineAt: new Date(now + 900000).toISOString(),
    leaseExpiresAt: new Date(now + 90000).toISOString(), request: { identity: {}, target: {}, input: {} } };
  const supervisor = createCourseDiscoverySupervisor({ readDrain: () => drain,
    client: { next: async () => { claims++; if (admitted) return { job: null }; admitted = true; return { job }; },
      fail: async () => { failures++; } },
    startWorker: async options => { signal = options.signal; return pending; },
    onEvent: e => { events.push(e); if (e.event === 'activated') done(); } });
  await supervisor.tick();
  const originalClaims = claims;
  drain = { nonce };
  await supervisor.tick();
  assert.equal(claims, originalClaims); assert.equal(supervisor.activeCount, 1);
  assert.equal(events.at(-1).drained, false); assert.equal(signal.aborted, false);
  finish({ outcome: 'activated' });
  await finished;
  await supervisor.tick();
  assert.equal(supervisor.activeCount, 0); assert.equal(events.at(-1).drained, true);
  assert.equal(failures, 0);
  await supervisor.stop();
});
