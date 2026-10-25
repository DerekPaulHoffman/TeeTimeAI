import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeModelMessages, createLocalCodexJsonClient, boundedCleanupRequest, createOwnedModelProcess as makeOwnedModelProcess,
  cleanupOwnedTemporary, sanitizedError } from './local-codex-json-client.mjs';
// Every Windows termination fixture is platform-independent and never signals an OS process.
const createOwnedModelProcess = options => makeOwnedModelProcess({ platform: 'win32', ...options });

function fakeProcess() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.pid = 2147483000;
  let launched = false;
  return { child, spawnProcess(executable) {
    if (!launched) { launched = true; return child; }
    assert.equal(executable, 'taskkill');
    const killer = new EventEmitter(); killer.kill = () => {};
    setTimeout(() => { child.emit('close', 0, null); killer.emit('close', 0); }, 35);
    return killer;
  } };
}

test('role-labelled framework instructions and inert tools survive normalization', () => {
  const normalized = normalizeModelMessages([{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'browser', input: { action: 'observe' } }] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Observed 10:00 AM' }] }], 'Framework instructions');
  assert.equal(normalized.length, 1); assert.match(normalized[0].text, /Observed 10:00 AM/u); assert.match(normalized[0].text, /Framework instructions/u);
});

test('inline image indexes and actual app-server image inputs remain exact', () => {
  const normalized = normalizeModelMessages([{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }, { type: 'image', mimeType: 'image/jpeg', data: 'ZGVm' },
  ] }]);
  assert.deepEqual(normalized.slice(1), [{ type: 'image', url: 'data:image/png;base64,YWJj' }, { type: 'image', url: 'data:image/jpeg;base64,ZGVm' }]);
  assert.match(normalized[0].text, /"imageIndex":0/u); assert.match(normalized[0].text, /"imageIndex":1/u);
  assert.doesNotMatch(normalized[0].text, /YWJj/u);
});

test('remote URLs, local images, unknown roles and unsupported parts fail closed', () => {
  for (const content of [[{ type: 'image_url', image_url: 'https://example.com/screenshot.png' }],
    [{ type: 'localImage', path: 'C:/private.png' }], [{ type: 'new_tool', data: {} }]])
    assert.throws(() => normalizeModelMessages([{ role: 'user', content }]), /LOCAL_MODEL_/u);
  assert.throws(() => normalizeModelMessages([{ role: 'unknown', content: 'x' }]), /ROLE_UNSUPPORTED/u);
});

test('Sol-only model and bounded effort/deadline validated before auth/process work', async () => {
  for (const options of [{ model: 'gpt-6-astra' }, { model: 'other' }, { effort: 'high' }, { effort: 'ultra' },
    { deadlineAt: new Date(Date.now() - 1000).toISOString() }, { deadlineAt: new Date(Date.now() + 16 * 60000).toISOString() }])
    await assert.rejects(createLocalCodexJsonClient({ deadlineAt: new Date(Date.now() + 1000).toISOString(), ...options }), /CONFIGURATION_INVALID/u);
});

test('expired cleanup starts no request and an unresponsive request has a bounded grace', async () => {
  let invoked = false;
  assert.equal(await boundedCleanupRequest(() => { invoked = true; }, Date.now() - 1), false); assert.equal(invoked, false);
  const started = Date.now();
  assert.equal(await boundedCleanupRequest(() => new Promise(() => {}), Date.now() + 10000, 20), false);
  assert.ok(Date.now() - started < 1000);
});

test('JSON-RPC failure keeps upstream code/message/phase, not generic cleanup error', async () => {
  const fixture = fakeProcess();
  const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const pending = channel.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'fixture' }] });
  fixture.child.stdout.write(JSON.stringify({ id: 1, error: { code: -32602, message: 'Invalid output schema: required must list every property.' } }) + '\n');
  await assert.rejects(pending, error => error.code === 'LOCAL_MODEL_RPC_FAILED' && error.diagnostics.rpcCode === -32602 &&
    error.diagnostics.phase === 'turn/start' && /Invalid output schema/u.test(error.diagnostics.message));
  assert.equal((await channel.close()).processExited, true);
});

test('owned process close waits for actual exit and is idempotent', async () => {
  const fixture = fakeProcess();
  const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const started = Date.now(); const closing = channel.close();
  assert.equal(channel.close(), closing);
  const receipt = await closing; assert.ok(Date.now() - started >= 25); assert.equal(receipt.processExited, true);
});
test('POSIX termination signals only the owned process group through an injected primitive',async()=>{
 const f=fakeProcess(),signals=[];
 const channel=makeOwnedModelProcess({executable:'fixture',args:[],cwd:tmpdir(),environment:{},spawnProcess:f.spawnProcess,platform:'linux',killProcess:(pid,signal)=>{signals.push({pid,signal});queueMicrotask(()=>f.child.emit('close',0,null));}});
 const result=await channel.close();assert.equal(result.processExited,true);assert.deepEqual(signals,[{pid:-f.child.pid,signal:'SIGKILL'}]);
});

test('input stream errors reject pending calls with diagnostic phase', async () => {
  const fixture = fakeProcess();
  const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const pending = channel.request('initialize', {});
  fixture.child.stdin.emit('error', Object.assign(new Error('fixture pipe closed'), { code: 'EPIPE' }));
  await assert.rejects(pending, error => error.code === 'LOCAL_MODEL_INPUT_FAILED' && error.diagnostics.phase === 'stdin');
  await channel.close();
});

test('failed Windows tree termination falls back to the exact owned child and awaits exit', async () => {
  const fixture = fakeProcess(); let directKill = false, launched = false;
  fixture.child.kill = () => { directKill = true; setImmediate(() => fixture.child.emit('close', 1, null)); };
  const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess() {
    if (!launched) { launched = true; return fixture.child; }
    const killer = new EventEmitter(); killer.kill = () => {};
    setImmediate(() => killer.emit('close', 1)); return killer;
  } });
  assert.equal((await channel.close()).processExited, true); assert.equal(directKill, true);
});

test('Windows locked cleanup retries, strips auth first, and reports residual rather than throwing', async () => {
  const temporary = join(tmpdir(), 'tts-stagehand-model-test');
  const calls = []; let attempts = 0;
  const receipt = await cleanupOwnedTemporary(temporary, true, { pause: async () => {}, remove(path) {
    calls.push(path); if (!path.endsWith('auth.json') && ++attempts < 3) throw Object.assign(new Error('fixture lock'), { code: 'EBUSY' });
  } });
  assert.equal(receipt.removed, true); assert.equal(attempts, 3); assert.ok(calls[0].endsWith('auth.json'));
  const residual = await cleanupOwnedTemporary(temporary, true, { pause: async () => {}, remove(path) {
    if (!path.endsWith('auth.json')) throw Object.assign(new Error('fixture lock'), { code: 'EBUSY' });
  } });
  assert.equal(residual.removed, false); assert.equal(residual.credentialsRemoved, true); assert.equal(residual.code, 'EBUSY');
});

test('unconfirmed process exit preserves tree and only removes owned credential', async () => {
  const calls = [];
  const receipt = await cleanupOwnedTemporary(join(tmpdir(), 'tts-stagehand-model-test'), false,
    { remove(path) { calls.push(path); }, pause: async () => {} });
  assert.equal(receipt.code, 'LOCAL_MODEL_PROCESS_EXIT_UNCONFIRMED'); assert.equal(calls.length, 1); assert.ok(calls[0].endsWith('auth.json'));
});

test('cleanup rejects paths outside exact owned temp prefix without any deletion', async () => {
  let calls = 0;
  for (const path of [tmpdir(), join(tmpdir(), 'unowned'), 'C:/dev/TeeTimeAI']) {
    const receipt = await cleanupOwnedTemporary(path, true, { remove() { calls++; } });
    assert.equal(receipt.code, 'LOCAL_MODEL_TEMP_PATH_INVALID');
  }
  assert.equal(calls, 0);
});

test('diagnostics redact tokens, URLs, Windows paths, emails, and bound upstream text', () => {
  const diagnostics = sanitizedError({ code: -123, message: 'Bad request Bearer exampletoken https://x.invalid/token C:/Users/private/auth.json me@example.com api_key=hidden ' + 'x'.repeat(900) }, 'turn/start');
  assert.ok(diagnostics.message.length <= 600); assert.equal(diagnostics.rpcCode, -123);
  for (const secret of ['exampletoken', 'https://', 'C:/Users', 'me@example.com', 'hidden']) assert.ok(!diagnostics.message.includes(secret));
});

const image = 'data:image/png;base64,' + randomBytes(2400000).toString('base64');
function echo(fixture, input, threadId, method = 'item/started') {
  fixture.child.stdout.write(JSON.stringify({ method, params: { threadId, item: { id: 'user', type: 'userMessage', content: input } } }) + '\n');
}
test('validated noncompressible synthetic inline-image echo over three MB is accepted and payload is discarded', async () => {
  const fixture = fakeProcess(), seen = [];
  const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess, onMessage: message => seen.push(message) });
  const input = [{ type: 'text', text: 'fixture' }, { type: 'image', url: image }];
  const pending = channel.request('turn/start', { threadId: 'thread', input });
  echo(fixture, input, 'thread');
  fixture.child.stdout.write(JSON.stringify({ id: 1, result: { turn: { id: 'turn' } } }) + '\n');
  await pending; await new Promise(done => setImmediate(done));
  assert.equal(seen[0].params.item.inputEchoValidated, true); assert.deepEqual(seen[0].params.item.content, []);
  assert.equal(channel.metrics().lineCount, 2); assert.equal(channel.metrics().echoCount, 1);
  assert.ok(channel.metrics().largestLineBytes > 3000000); assert.ok(channel.metrics().controlBytes < 1000);
  assert.ok(JSON.stringify(channel.metrics()).length < 300);
  assert.ok(JSON.stringify(seen).length < 1000); assert.equal((await channel.close()).processExited, true);
});
test('multiple valid image turns may exceed twelve MB lifetime traffic while each turn stays bounded', async () => {
  const fixture = fakeProcess(); const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const input = [{ type: 'text', text: 'fixture' }, { type: 'image', url: image }];
  for (let index = 1; index <= 3; index++) {
    const threadId = 'thread' + index;
    const pending = channel.request('turn/start', { threadId, input });
    echo(fixture, input, threadId); echo(fixture, input, threadId, 'item/completed');
    fixture.child.stdout.write(JSON.stringify({ id: index, result: { turn: { id: 'turn' + index } } }) + '\n');
    await pending;
    assert.equal(channel.metrics().lineCount, 3); assert.equal(channel.metrics().echoCount, 2);
  }
  assert.equal((await channel.close()).processExited, true);
});
test('unvalidated large echo fails closed with counts and method, never its payload', async () => {
  const fixture = fakeProcess(); const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const input = [{ type: 'text', text: 'fixture' }, { type: 'image', url: image }];
  const pending = channel.request('turn/start', { threadId: 'thread', input });
  echo(fixture, [{ type: 'text', text: 'private-prompt-sentinel' }, { type: 'image', url: image }], 'thread');
  await assert.rejects(pending, error => {
    assert.equal(error.code, 'LOCAL_MODEL_CHANNEL_OUTPUT_LIMIT'); assert.equal(error.diagnostics.limitScope, 'unvalidated_input_echo');
    assert.equal(error.diagnostics.method, 'item/started'); assert.ok(error.diagnostics.lineBytes > 3000000);
    assert.ok(!JSON.stringify(error.diagnostics).includes('private-prompt-sentinel')); return true;
  });
  assert.equal((await channel.close()).processExited, true);
});
test('genuinely oversized structured model output remains rejected and its primary error survives cleanup', async () => {
  const fixture = fakeProcess(); const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const pending = channel.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'fixture' }] });
  fixture.child.stdout.write(JSON.stringify({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', text: 'x'.repeat(1000001) } } }) + '\n');
  let primary;
  await assert.rejects(pending, error => { primary = error; return error.code === 'LOCAL_MODEL_OUTPUT_LIMIT' && error.diagnostics.limitScope === 'model_output'; });
  assert.equal((await channel.close()).processExited, true); assert.equal(primary.code, 'LOCAL_MODEL_OUTPUT_LIMIT');
  assert.ok(!JSON.stringify(primary.diagnostics).includes('x'.repeat(100)));
});
test('echo and ordinary control traffic retain finite independent per-turn bounds', async () => {
  const fixture = fakeProcess(); const channel = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: fixture.spawnProcess });
  const input = [{ type: 'text', text: 'fixture' }, { type: 'image', url: image }];
  const pending = channel.request('turn/start', { threadId: 'thread', input });
  for (let i = 0; i < 7; i++) echo(fixture, input, 'thread');
  await assert.rejects(pending, error => error.diagnostics.limitScope === 'input_echo_count' && error.diagnostics.validatedEchoCount === 7);
  assert.equal((await channel.close()).processExited, true);
  const nextFixture = fakeProcess(); const next = createOwnedModelProcess({ executable: 'fixture', args: [], spawnProcess: nextFixture.spawnProcess });
  const nextPending = next.request('turn/start', { threadId: 'thread', input: [{ type: 'text', text: 'fixture' }] });
  for (let i = 0; i < 5; i++) nextFixture.child.stdout.write(JSON.stringify({ method: 'fixture/status', params: { text: 'x'.repeat(2500000) } }) + '\n');
  await assert.rejects(nextPending, error => error.diagnostics.limitScope === 'control_turn' && error.diagnostics.turnControlBytes > 12000000);
  assert.equal((await next.close()).processExited, true);
});
