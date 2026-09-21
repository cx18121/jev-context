import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { measureRequest } from '../src/budget.ts';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1',
  reasoning: false, input: ['text'], contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test('budget includes serialized system, tools, Unicode, actual output limit, and margin', () => {
  const payload = {
    messages: [{ role: 'system', content: 'System' }, { role: 'user', content: '你好' }],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    max_tokens: 100,
  };
  const measured = measureRequest(payload, model, { contextLimit: 2000, marginTokens: 50 });
  assert.equal(measured.inputEstimate, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(measured.outputReserve, 100);
  assert.equal(measured.contextLimit, 1000);
  assert.equal(measured.fits, true);
  assert.equal(measureRequest(payload, model, {
    contextLimit: measured.inputEstimate + 100 + 50 - 1, marginTokens: 50,
  }).fits, false);
});

test('unsupported content and implicit output limits are not counted as zero', () => {
  assert.throws(() => measureRequest({ messages: [], max_tokens: undefined }, model, { contextLimit: 1000, marginTokens: 0 }), /explicit output/);
  assert.throws(() => measureRequest({ messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], max_tokens: 100 }, model, { contextLimit: 1000, marginTokens: 0 }), /Non-text/);
  assert.throws(() => measureRequest({ messages: [], max_tokens: 100 }, { ...model, api: 'anthropic-messages' }, { contextLimit: 1000, marginTokens: 0 }), /only openai-completions/);
});
