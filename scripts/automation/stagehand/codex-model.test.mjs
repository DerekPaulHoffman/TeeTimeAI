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
  await model.close();
  assert.equal(closed, true);
  assert.equal(received.signal.aborted, true);
});
