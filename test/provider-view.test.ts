import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { readHistory } from '../src/history.ts';
import { prepareJevRequest } from '../src/judge-state.ts';
import { mapProviderEvidence, providerInstructions, replaceProviderText } from '../src/provider-view.ts';
import { assistant, result } from './history-fixture.ts';

const model: Model<'openai-codex-responses'> = {
  id: 'fixture', name: 'fixture', api: 'openai-codex-responses', provider: 'fixture', baseUrl: 'http://127.0.0.1',
  reasoning: true, input: ['text'], contextWindow: 100_000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const budget = { contextLimit: 100_000, marginTokens: 10, outputReserveTokens: 300 };
const reasoning = { type: 'reasoning', id: 'rs_original', encrypted_content: 'opaque-123', summary: [] };
function fixture() {
  const manager = SessionManager.inMemory();
  const call = { type: 'toolCall' as const, id: 'call_a|fc_a', name: 'read', arguments: { path: 'a' } };
  manager.appendMessage({ ...assistant([call]), api: model.api, provider: model.provider, model: model.id });
  manager.appendMessage(result(call.id, 'exact text'));
  const messages = manager.buildSessionContext().messages;
  const history = readHistory(manager.getBranch(), messages);
  const payload = { store: false, instructions: 'Initial instructions', input: [
    reasoning,
    { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'call_a', output: 'exact text' },
    { role: 'developer', content: 'Updated constraints' },
  ] };
  return { messages, history, payload };
}

test('Codex measurement counts the entire body and distinguishes headroom from an output limit', () => {
  const { payload } = fixture();
  const measurement = measureRequest(payload, model, budget);
  assert.equal(measurement.inputEstimate, Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(measurement.outputReserve, 300);
  assert.equal(measurement.outputReserveSource, 'configured-headroom');
  assert.equal(measurement.fits, true);
  assert.equal(measureRequest(payload, model, { ...budget, contextLimit: measurement.inputEstimate + 309 }).fits, false);
  for (const reserve of [undefined, 0, -1, NaN, 1.1]) {
    assert.throws(() => measureRequest(payload, model, { ...budget, outputReserveTokens: reserve }), /planning headroom/);
  }
  assert.throws(() => measureRequest({ ...payload, max_output_tokens: 100 }, model,
    { contextLimit: 100_000, marginTokens: 0 }), /planning headroom/, 'an unexpected body limit is not our configured reserve');
});

test('Codex mapping replaces only the exact output, not reasoning, call IDs or instructions', () => {
  const { payload, messages, history } = fixture();
  const original = structuredClone(payload);
  const [mapped] = mapProviderEvidence(payload, messages, history.evidence, model);
  assert.equal(mapped!.messageIndex, 2);
  replaceProviderText(payload, model.api, mapped!.messageIndex, 'stub');
  const expected = structuredClone(original);
  (expected.input[2] as { output: string }).output = 'stub';
  assert.deepEqual(payload, expected);
  assert.throws(() => replaceProviderText(payload, model.api, 0, 'bad'), /does not target/);
});

test('Codex instructions include initial and updated authority, not opaque reasoning', () => {
  const { payload, messages, history } = fixture();
  assert.deepEqual(providerInstructions(payload, model.api), [
    { role: 'system', content: 'Initial instructions' }, { role: 'developer', content: 'Updated constraints' },
  ]);
  const request = prepareJevRequest({ payload, history, candidates: [{ evidence: history.evidence[0]!, text: 'exact text' }] },
    [...messages, { role: 'system', content: [{ type: 'text', text: 'Updated constraints' }], timestamp: 5 }], model.api);
  const state = JSON.stringify(request.request.state);
  assert.match(state, /Updated constraints/);
  assert.doesNotMatch(state, /opaque-123/);
});

test('Codex rejects ambiguous call parts instead of guessing a result after ID splitting', () => {
  const { payload, messages, history } = fixture();
  messages.push(result('call_a|fc_other', 'another result'));
  assert.throws(() => mapProviderEvidence(payload, messages, history.evidence, model), /Ambiguous Codex/);
});

test('Codex estimator rejects unsupported payload shapes, tool additions and media', () => {
  const { payload } = fixture();
  for (const input of [
    [{ type: 'additional_tools', role: 'developer', tools: [] }],
    [{ type: 'tool_search_call', arguments: '{}' }],
    [{ role: 'user', content: [{ type: 'input_image', image_url: 'image' }] }],
    [{ type: 'function_call_output', call_id: 'a', output: [{ type: 'input_text', text: 'not supported' }] }],
    [{ type: 'unknown' }],
  ]) assert.throws(() => measureRequest({ ...payload, input }, model, budget), /Unsupported or non-text/);
  assert.throws(() => measureRequest({ ...payload, store: true }, model, budget), /full, stateless/);
});
