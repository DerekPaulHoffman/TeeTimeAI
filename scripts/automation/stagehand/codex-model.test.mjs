import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStagehandMessages, stagehandStructuredResult, createStagehandCodexModel } from './codex-model.mjs';

test('Stagehand text and inline images retain role and content without lossy flattening', () => {
  assert.deepEqual(normalizeStagehandMessages([{ role: 'user', content: [{ type: 'text', text: 'Exact DOM evidence' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] }, { role: 'assistant', content: { type: 'text', text: '{"prior":true}' } }]), [{ role: 'user', content: [{ type: 'text', text: 'Exact DOM evidence' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] }, { role: 'assistant', content: [{ type: 'text', text: '{"prior":true}' }] }]);
});
test('unsupported tool content or unapproved images reject instead of silently disappearing', () => {
  assert.throws(() => normalizeStagehandMessages([{ role: 'user', content: { type: 'tool_use', name: 'shell' } }]), /CONTENT_BLOCK_UNSUPPORTED/u);
  assert.throws(() => normalizeStagehandMessages([{ role: 'user', content: { type: 'image', data: 'AA==', mimeType: 'image/svg+xml' } }]), /CONTENT_BLOCK_UNSUPPORTED/u);
});
test('local usage maps exactly into the supported Stagehand structured result', () => {
  assert.deepEqual(stagehandStructuredResult({ value: { ok: true }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, reasoningOutputTokens: 1, cachedInputTokens: 2 } }), { role: 'assistant', content: { type: 'text', text: '{"ok":true}' }, outputFormat: 'json_schema', structuredContent: { ok: true }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, reasoningTokens: 1, cachedInputTokens: 2 } });
});
test('SDK callback forwards the exact schema and instructions and closes the local client', async () => {
  const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  let received;
  let closed = false;
  const model = await createStagehandCodexModel({ deadline: Date.now() + 20000, clientFactory: async options => { assert.equal(options.model, 'gpt-6.1-sol'); assert.equal(options.effort, 'medium'); return { generate: async input => { received = input; return { value: { ok: true }, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }, elapsedMs: 1, model: 'gpt-6.1-sol', effort: 'medium' }; }, close: async () => { closed = true; } }; } });
  const result = await model.model.generate({ systemPrompt: 'Exact system instructions', messages: [{ role: 'user', content: { type: 'text', text: 'Exact request' } }], responseFormat: { type: 'json_schema', name: 'test', schema: outputSchema } });
  assert.equal(received.outputSchema, outputSchema);
  assert.equal(received.systemPrompt, 'Exact system instructions');
  assert.deepEqual(result.structuredContent, { ok: true });
  assert.equal(model.calls.length, 1);
  assert.equal(model.attemptedCalls, 1);
  await model.close();
  assert.equal(closed, true);
  assert.equal(received.signal.aborted, true);
});
test('failed actual client invocation counts as attempted with no invented completed usage',async()=>{
 const model=await createStagehandCodexModel({deadline:Date.now()+10000,clientFactory:async()=>({generate:async()=>{throw Object.assign(Error('LOCAL_MODEL_RPC_FAILED'),{diagnostics:{rpcCode:-32600,usage:{inputTokens:20}}});},close:async()=>({})})});
 await assert.rejects(model.model.generate({systemPrompt:'Read only',messages:[{role:'user',content:{type:'text',text:'Public evidence'}}],responseFormat:{type:'json_schema',schema:{type:'object'}}}),/LOCAL_MODEL_RPC_FAILED/);
 assert.equal(model.attemptedCalls,1);assert.equal(model.calls.length,0);await model.close();
});

test('model failure is captured before SDK wrapping, privately projected, and cleared before a later callback',async()=>{
 let failing=true;
 const model=await createStagehandCodexModel({deadline:Date.now()+10000,clientFactory:async()=>({generate:async()=>{
  if(failing)throw Object.assign(Error('PRIVATE_MESSAGE https://private.example/?token=SECRET'),{code:'LOCAL_MODEL_RPC_FAILED',diagnostics:{phase:'turn/start',rpcCode:-32600,httpStatusCode:400,usage:{inputTokens:20,secret:'PRIVATE'},body:'PRIVATE'}});
  return{value:{ok:true},model:'gpt-6.1-sol',effort:'medium',usage:{inputTokens:10},elapsedMs:1};
 },close:async()=>({})})});
 const params={systemPrompt:'Read',messages:[{role:'user',content:{type:'text',text:'Public'}}],responseFormat:{type:'json_schema',schema:{type:'object'}}};
 await assert.rejects(model.model.generate(params));
 assert.deepEqual(model.lastFailure,{attempt:1,completedCalls:0,transportCode:'LOCAL_MODEL_RPC_FAILED',transportPhase:'turn/start',rpcCode:-32600,httpStatus:400,failedCallUsage:{inputTokens:20}});
 const cloned=model.lastFailure;cloned.transportCode='PRIVATE';assert.equal(model.lastFailure.transportCode,'LOCAL_MODEL_RPC_FAILED');
 assert.doesNotMatch(JSON.stringify(model.lastFailure),/PRIVATE|SECRET|https:|message|body/);
 failing=false;await model.model.generate(params);assert.equal(model.lastFailure,undefined);assert.equal(model.attemptedCalls,2);assert.equal(model.calls.length,1);
 await assert.rejects(model.model.generate({...params,responseFormat:{type:'text'}}));assert.equal(model.lastFailure,undefined);
 await model.close();
});
