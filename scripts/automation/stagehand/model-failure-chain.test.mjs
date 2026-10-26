import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalCodexJsonClient, createOwnedModelProcess } from './local-codex-json-client.mjs';
import { createStagehandCodexModel } from './codex-model.mjs';
import { sourceFailureDiagnostic, projectSourceDiagnostic } from './source-diagnostic.mjs';
import { createStagehandFailureCheckpoint, readStagehandFailure } from '../course-discovery-stagehand-failure.mjs';
import { readStagehandSourceCheckpoint, stagehandDataHash } from '../course-discovery-stagehand-source.mjs';

// Real owned channel/parser and client lifecycle, with inert fake stdio only.
// It never reads a user's auth, spawns a process, or performs inference/network.
async function fixture({ terminalInfo, notificationInfo, usage, rpcFailure = false, notificationOnly = false } = {}) {
  const sourceHome = mkdtempSync(join(tmpdir(), 'tts-model-fixture-'));
  writeFileSync(join(sourceHome, 'auth.json'), JSON.stringify({ fixture: 'NO_REAL_CREDENTIAL' }));
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 2147483000 });
  const packets = [], homes = [], schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  let firstSpawn = true, call = 0, mode = 'fail', text = '';
  const send = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.stdin.on('data', data => {
    text += data.toString();
    let end;
    while ((end = text.indexOf('\n')) >= 0) {
      const packet = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); packets.push(packet);
      if (!packet.id) continue;
      const reply = result => send({ id: packet.id, result });
      if (packet.method === 'initialize') reply({});
      else if (packet.method === 'account/read') reply({ account: { type: 'chatgpt' } });
      else if (packet.method === 'thread/start') {
        call++;
        assert.equal(packet.params.model, 'gpt-6.1-sol');
        assert.equal(packet.params.ephemeral, true); assert.deepEqual(packet.params.dynamicTools, []);
        assert.equal(packet.params.sandbox, 'read-only'); assert.equal(packet.params.approvalPolicy, 'never');
        reply({ thread: { id: `thread-${call}` }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never', model: 'gpt-6.1-sol' });
      } else if (packet.method === 'turn/start') {
        assert.deepEqual(packet.params.outputSchema, schema); assert.equal(packet.params.effort, 'medium');
        if (rpcFailure && mode === 'fail') { send({ id: packet.id, error: { code: -32602, message: 'PRIVATE_SCHEMA https://private.example/', httpStatusCode: 400 } }); continue; }
        reply({ turn: { id: `turn-${call}` } });
        setImmediate(() => {
          const event = (method, params) => send({ method, params: { threadId: `thread-${call}`, ...params } });
          // Foreign thread/turn events must not contaminate the active failure.
          send({ method: 'error', params: { threadId: 'foreign', error: { codexErrorInfo: 'unauthorized' }, willRetry: true } });
          event('error', { turnId: 'foreign-turn', error: { codexErrorInfo: 'unauthorized' }, willRetry: true });
          if (mode === 'success') {
            event('item/completed', { item: { type: 'agentMessage', text: '{"ok":true}' } });
            event('turn/completed', { turn: { id: `turn-${call}`, status: 'completed' } }); return;
          }
          if (usage) event('thread/tokenUsage/updated', { tokenUsage: { total: { ...usage, private: 'PRIVATE_USAGE' } } });
          if (notificationInfo !== undefined) event('error', { turnId: `turn-${call}`, willRetry: false,
            error: { codexErrorInfo: notificationInfo, code: -32001, message: 'PRIVATE_PROMPT https://private.example/?token=SECRET', additionalDetails: 'PRIVATE_DETAIL' } });
          event('turn/completed', { turn: { id: `turn-${call}`, status: 'failed', error: {
            ...(notificationOnly ? {} : { codexErrorInfo: terminalInfo }), message: 'PRIVATE_TERMINAL', additionalDetails: 'PRIVATE_DETAIL' } } });
        });
      } else if (['thread/unsubscribe', 'turn/interrupt'].includes(packet.method)) reply({});
      else assert.fail(`Unexpected method ${packet.method}`);
    }
  });
  const now = Date.now(), job = { id: 'owned-model-job', attempts: 1, sourceFingerprint: 'a'.repeat(64),
    firstPickedUpAt: new Date(now - 500).toISOString(), deadlineAt: new Date(now - 500 + 900000).toISOString(),
    request: { target: { courseId: 'owned-course', kind: 'OUTDOOR' }, input: { players: 2 } } };
  let model, closeReceipt;
  try {
    model = await createStagehandCodexModel({ deadline: now + 30000, clientFactory: options => createLocalCodexJsonClient(options, {
      sourceHome, loadWorkerHelpers: async () => ({ DISCOVERY_CONFIG: {}, prepareDiscoveryModelCatalog: () => '{}',
        discoveryProcessEnvironment: () => ({}), resolveDiscoveryCli: () => 'FAKE_OWNED_ONLY' }),
      createProcess: options => createOwnedModelProcess({ ...options, platform: 'win32', spawnProcess(executable, _args, spawnOptions) {
        if (firstSpawn) { firstSpawn = false; assert.equal(executable, 'FAKE_OWNED_ONLY'); homes.push(spawnOptions.env.CODEX_HOME); return child; }
        assert.equal(executable, 'taskkill');
        const killer = new EventEmitter(); killer.kill = () => {};
        setImmediate(() => { child.emit('close', 0, null); killer.emit('close', 0); }); return killer;
      } }),
    }) });
    const params = { messages: [{ role: 'user', content: { type: 'text', text: 'PRIVATE_PROMPT' } }],
      systemPrompt: 'PRIVATE_SYSTEM', responseFormat: { type: 'json_schema', schema } };
    let primary;
    try { await model.model.generate(params); } catch (error) { primary = error; }
    assert.ok(primary); const captured = model.lastFailure;
    const wrapped = Object.assign(Error('PRIVATE_SDK_WRAPPER'), { cause: { code: -32603, message: 'PRIVATE_SDK_DETAIL' } });
    const report = { jobId: job.id, firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt,
      metrics: { localCodexCalls: model.calls }, browserClosed: true, modelClosed: true,
      officialLinkLedger: [], frameLedger: [], actions: [] };
    const diagnostic = sourceFailureDiagnostic({ error: wrapped, phase: 'OBSERVE', report, startedAt: now,
      cleanup: { browserClosed: true, modelClosed: true }, modelAttempts: model.attemptedCalls, modelFailure: captured });
    report.sourceDiagnostic = diagnostic;
    const checkpoint = createStagehandFailureCheckpoint({ job, report, error: primary, phase: 'SOURCE_DISCOVERY',
      metrics: { modelCalls: 0 }, startedAt: now, now: Date.now() });
    const saved = readStagehandFailure({ ...job, checkpoint });
    assert.ok(saved); assert.deepEqual(saved.entries[0].diagnostic, diagnostic);
    assert.equal(saved.entries[0].diagnosticSha256, stagehandDataHash(diagnostic));
    assert.equal(readStagehandSourceCheckpoint({ ...job, checkpoint }), undefined);
    assert.equal(diagnostic.sdkRpcCode, -32603); assert.equal(diagnostic.counts.attemptedModelCalls, 1);
    const direct = sourceFailureDiagnostic({ error: primary, phase: 'OBSERVE', report,
      modelAttempts: model.attemptedCalls, modelFailure: captured });
    assert.equal(direct.sdkRpcCode, undefined);
    assert.equal(diagnostic.counts.completedModelCalls, 0); assert.equal(diagnostic.completedUsageIsLowerBound, true);
    assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE|SECRET|https:|message|additionalDetails|prompt|thread-/u);
    // A later success cannot retain this failure or its usage/category.
    mode = 'success'; await model.model.generate(params); assert.equal(model.lastFailure, undefined);
    const stale = sourceFailureDiagnostic({ error: wrapped, report: { ...report, metrics: { localCodexCalls: model.calls } }, modelAttempts: model.attemptedCalls, modelFailure: captured });
    assert.equal(stale.modelTurnFailure, undefined); assert.equal(stale.modelRpcCode, undefined); assert.equal(stale.sdkRpcCode, undefined);
    closeReceipt = await model.close();
    assert.equal(closeReceipt.processExited, true); assert.equal(closeReceipt.cleanup.credentialsRemoved, true);
    assert.equal(closeReceipt.cleanup.removed, true); assert.ok(homes.every(home => !existsSync(home)));
    assert.equal(packets.filter(packet => packet.method === 'turn/start').length, 2);
    return diagnostic;
  } finally {
    if (model && !closeReceipt) await model.close();
    rmSync(sourceHome, { recursive: true, force: true });
  }
}

test('owned terminal/notification errors reach checkpoint with distinct provenance and actual partial usage', async () => {
  const diagnostic = await fixture({ terminalInfo: { responseStreamDisconnected: { httpStatusCode: 503, additionalDetails: 'PRIVATE' } },
    notificationInfo: 'serverOverloaded', usage: { inputTokens: 17, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 19 } });
  assert.deepEqual(diagnostic.modelTurnFailure, { turnStatus: 'failed', errorCategory: 'responseStreamDisconnected', httpStatusCode: 503 });
  assert.deepEqual(diagnostic.modelErrorNotification, { errorCategory: 'serverOverloaded', rpcCode: -32001, willRetry: false });
  assert.equal(diagnostic.modelRpcCode, undefined); assert.equal(diagnostic.rpcCode, -32603);
  assert.deepEqual(diagnostic.failedCallUsage, { inputTokens: 17, cachedInputTokens: 4, outputTokens: 2, reasoningOutputTokens: 1, totalTokens: 19 });
  for (const value of [{ ...diagnostic, modelTurnFailure: { ...diagnostic.modelTurnFailure, errorCategory: 'PRIVATE' } },
    { ...diagnostic, modelErrorNotification: { ...diagnostic.modelErrorNotification, message: 'PRIVATE' } },
    { ...diagnostic, modelTurnFailure: { ...diagnostic.modelTurnFailure, httpStatusCode: 999 } }]) assert.equal(projectSourceDiagnostic(value), undefined);
});
test('explicit quota category remains separate from unknown failed-call usage', async () => {
  const diagnostic = await fixture({ terminalInfo: 'usageLimitExceeded' });
  assert.deepEqual(diagnostic.modelTurnFailure, { turnStatus: 'failed', errorCategory: 'usageLimitExceeded' });
  assert.equal(diagnostic.failedCallUsage, undefined); assert.equal(diagnostic.modelErrorNotification, undefined);
});
test('unknown terminal info cannot borrow the notification category or invent HTTP/usage', async () => {
  const diagnostic = await fixture({ terminalInfo: { privateCategory: { httpStatusCode: 429 } }, notificationInfo: 'serverOverloaded' });
  assert.deepEqual(diagnostic.modelTurnFailure, { turnStatus: 'failed' });
  assert.equal(diagnostic.modelErrorNotification.errorCategory, 'serverOverloaded');
  assert.equal(diagnostic.failedCallUsage, undefined); assert.equal(diagnostic.httpStatus, undefined);
});
test('actual RPC rejection preserves inner numeric code independently from SDK wrapper', async () => {
  const diagnostic = await fixture({ rpcFailure: true });
  assert.equal(diagnostic.modelRpcCode, -32602); assert.equal(diagnostic.sdkRpcCode, -32603);
  assert.equal(diagnostic.httpStatus, 400); assert.equal(diagnostic.modelTurnFailure, undefined);
  assert.equal(diagnostic.failedCallUsage, undefined);
});
