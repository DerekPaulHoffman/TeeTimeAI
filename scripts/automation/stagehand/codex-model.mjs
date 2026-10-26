import { createLocalCodexJsonClient } from './local-codex-json-client.mjs';
import { captureModelFailure } from './source-diagnostic.mjs';

export function normalizeStagehandMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('STAGEHAND_CODEX_MESSAGES_REQUIRED');
  return messages.map(message => {
    if (!['user', 'assistant'].includes(message.role)) throw new Error('STAGEHAND_CODEX_MESSAGE_ROLE_UNSUPPORTED');
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    const content = blocks.map(block => {
      if (block?.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
      if (block?.type === 'image' && typeof block.data === 'string' && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)) return { type: 'image', data: block.data, mimeType: block.mimeType };
      throw new Error('STAGEHAND_CODEX_CONTENT_BLOCK_UNSUPPORTED');
    });
    return { role: message.role, content };
  });
}

export function stagehandStructuredResult(result) {
  const usage = result.usage ?? {};
  return { role: 'assistant', content: { type: 'text', text: JSON.stringify(result.value) }, outputFormat: 'json_schema', structuredContent: result.value, usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, totalTokens: usage.totalTokens ?? 0, reasoningTokens: usage.reasoningOutputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0 } };
}

export async function createStagehandCodexModel({ deadline, cwd, signal, onMetrics, clientFactory = createLocalCodexJsonClient }) {
  const controller = new AbortController();
  const client = await clientFactory({ deadlineAt: new Date(deadline).toISOString(), cwd, signal, model: 'gpt-6.1-sol', effort: 'medium' });
  const calls = [];
  let attemptedCalls = 0;
  let lastFailure;
  return {
    model: {
      async generate(params) {
        lastFailure=undefined;
        if (params?.responseFormat?.type !== 'json_schema' || !params.responseFormat.schema) throw new Error('STAGEHAND_CODEX_STRUCTURED_SCHEMA_REQUIRED');
        const messages = normalizeStagehandMessages(params.messages);
        attemptedCalls++;
        try{
        const result = await client.generate({ messages, systemPrompt: params.systemPrompt, outputSchema: params.responseFormat.schema, signal: controller.signal });
        if (result.model !== 'gpt-6.1-sol' || result.effort !== 'medium') throw new Error('SOL_ONLY_MODEL_RESULT_REQUIRED');
        calls.push({ elapsedMs: result.elapsedMs, usage: result.usage, model: result.model, effort: result.effort });
        try { onMetrics?.({ completedModelCalls: calls.length, usage: structuredClone(result.usage ?? {}) }); } catch { /* Metrics cannot alter model authority. */ }
        return stagehandStructuredResult(result);
        }catch(error){lastFailure=captureModelFailure(error,attemptedCalls,calls.length);throw error;}
      },
    },
    get calls() { return calls; },
    get attemptedCalls() { return attemptedCalls; },
    get lastFailure() { return lastFailure?structuredClone(lastFailure):undefined; },
    async close() { controller.abort(new Error('STAGEHAND_CODEX_SESSION_CLOSED')); return client.close(); },
  };
}
