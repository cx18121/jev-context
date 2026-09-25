import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model, Usage } from '@earendil-works/pi-ai';
import { measureCapacity } from '../src/budget.ts';
import { createUsageAnchor } from '../src/working-context.ts';
import { assistant } from './history-fixture.ts';

const model: Model<'openai-codex-responses'> = {
  id: 'fixture', name: 'fixture', api: 'openai-codex-responses', provider: 'fixture', baseUrl: 'http://localhost',
  reasoning: true, input: ['text'], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const limits = { contextLimit: 180000, marginTokens: 1000, outputReserveTokens: 4000, maxRequestBytes: 250000 };
const usage: Usage = { input: 10000, cacheRead: 20000, cacheWrite: 7000, output: 200, totalTokens: 37200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const initial = { model: model.id, instructions: 'Task', store: false, input: [
  { type: 'function_call_output', call_id: 'read', output: 'source'.repeat(30000) },
] };
const reasoning = { type: 'reasoning', id: 'rs_reply', encrypted_content: 'opaque'.repeat(1000), summary: [] };
function followup() {
  return { ...initial, input: [...structuredClone(initial.input), reasoning, { role: 'assistant', content: 'Read another file.' },
    { role: 'user', content: 'Continue.' }] as Array<Record<string, unknown>> };
}
function owner(items = [reasoning], output = usage.output): AgentMessage {
  return { ...assistant([]), api: model.api, provider: model.provider, model: model.id,
    usage: { ...usage, output, totalTokens: 37000 + output },
    content: items.map((item) => ({ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(item) })) };
}

test('token admission does not compare a 180KB request against a 180K token allowance', () => {
  const payload = followup();
  const anchor = createUsageAnchor(initial, model, usage, 'previous')!;
  const result = measureCapacity(payload, model, limits, { anchor });
  assert.equal(result.input.method, 'provider-usage-plus-delta-v2');
  assert.equal(result.input.tokens, 37200 + Math.ceil(Buffer.byteLength(JSON.stringify(payload.input.at(-1))) / 3));
  assert.ok(result.wireBytes > 180000);
  assert.ok(result.totalTokens < 43000);
  assert.equal(result.admitted, true);
  assert.equal(result.outputReserveSource, 'configured-headroom');
  assert.equal(result.input.anchorRequestId, 'previous');
});

test('the transport byte cap and token allowance fail independently and include their exact boundaries', () => {
  const payload = followup(), anchor = createUsageAnchor(initial, model, usage, 'previous')!;
  const measured = measureCapacity(payload, model, limits, { anchor });
  const exact = { ...limits, contextLimit: measured.totalTokens, maxRequestBytes: measured.wireBytes };
  assert.equal(measureCapacity(payload, model, exact, { anchor }).admitted, true);
  const wire = measureCapacity(payload, model, { ...exact, maxRequestBytes: exact.maxRequestBytes - 1 }, { anchor });
  assert.equal(wire.wireFits, false);
  assert.equal(wire.tokenFits, true);
  assert.equal(wire.admitted, false);
  const tokens = measureCapacity(payload, model, { ...exact, contextLimit: exact.contextLimit - 1 }, { anchor });
  assert.equal(tokens.tokenFits, false);
  assert.equal(tokens.wireFits, true);
  assert.equal(tokens.admitted, false);
});

test('retirement credits fewer estimated tokens than the same byte restoration costs', () => {
  const anchor = createUsageAnchor(initial, model, usage, 'previous')!, payload = followup();
  const before = measureCapacity(payload, model, limits, { anchor }).input.tokens;
  payload.input[0]!.output = String(payload.input[0]!.output).slice(1500);
  assert.equal(measureCapacity(payload, model, limits, { anchor }).input.tokens, before - 300);
  payload.input[0]!.output = initial.input[0]!.output + 'x'.repeat(1500);
  assert.equal(measureCapacity(payload, model, limits, { anchor }).input.tokens, before + 500);
});

test('cold and incompatible requests get an explicit heuristic rather than unknown soft pressure', () => {
  const payload = { store: false, instructions: 'Task', input: [{ role: 'user', content: 'λ'.repeat(400) }] };
  const cold = measureCapacity(payload, model, limits);
  assert.equal(cold.input.tokens, Math.ceil(Buffer.byteLength(JSON.stringify(payload)) / 3));
  assert.equal(cold.input.method, 'cold-visible-bytes-plus-output-v1');
  assert.equal(cold.input.fallbackReason, 'no-anchor');
  const anchor = createUsageAnchor(initial, model, usage, 'previous')!;
  const changed = measureCapacity(payload, model, limits, { anchor });
  assert.equal(changed.input.tokens, cold.input.tokens);
  assert.equal(changed.input.fallbackReason, 'request-changed');
  assert.equal(changed.input.anchorRequestId, null);
});

test('cold opaque reasoning uses matching recorded output once per response, never ciphertext length', () => {
  const second = { ...reasoning, id: 'rs_second' };
  const payload = { store: false, instructions: 'Task', input: [reasoning, second] };
  const measured = measureCapacity(payload, model, limits, { messages: [owner([reasoning, second])] });
  assert.equal(measured.input.opaqueOutputTokens, usage.output);
  const longer = { ...reasoning, encrypted_content: 'opaque'.repeat(20000) };
  const changed = { ...payload, input: [longer, second] };
  const next = measureCapacity(changed, model, limits, { messages: [owner([longer, second])] });
  assert.equal(next.input.tokens, measured.input.tokens);
  assert.ok(next.wireBytes > measured.wireBytes);
  assert.throws(() => measureCapacity(payload, model, limits), /no matching recorded output usage/);
  assert.throws(() => measureCapacity(payload, model, limits, { messages: [owner([reasoning, second], 0)] }), /no valid recorded output usage/);
  assert.throws(() => measureCapacity(payload, { ...model, id: 'other' }, limits, { messages: [owner([reasoning, second])] }), /no matching/);
  assert.throws(() => measureCapacity(payload, model, limits, { messages: [owner(), owner()] }), /Ambiguous/);
});

test('completions encrypted reasoning and legacy tool signatures use recorded output on cold resume', () => {
  const chat = { ...model, api: 'openai-completions' as const };
  const detail = { type: 'reasoning.encrypted', id: 'encrypted', data: 'cipher'.repeat(10000) };
  const payload = { max_tokens: 100, messages: [{ role: 'assistant', content: 'Done', reasoning_details: [detail] }] };
  const signed: AgentMessage = { ...assistant([]), api: chat.api, provider: chat.provider, model: chat.id, usage,
    content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify([detail]) }] };
  const first = measureCapacity(payload, chat, limits, { messages: [signed] });
  assert.equal(first.input.opaqueOutputTokens, 200);
  assert.ok(first.input.tokens < 300);
  assert.ok(first.wireBytes > 60000);
  const shorter = { ...detail, data: 'small' };
  const next = measureCapacity({ ...payload, messages: [{ ...payload.messages[0]!, reasoning_details: [shorter] }] }, chat, limits,
    { messages: [{ ...signed, content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {}, thoughtSignature: JSON.stringify(shorter) }] }] });
  assert.equal(next.input.tokens, first.input.tokens);
  assert.throws(() => measureCapacity(payload, chat, limits), /no matching recorded output usage/);
});

test('capacity limits fail before inference and completions uses the real requested output cap', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => measureCapacity(initial, model, { ...limits, maxRequestBytes: invalid }), /Invalid capacity/);
    assert.throws(() => measureCapacity(initial, model, { ...limits, contextLimit: invalid }), /Invalid capacity/);
  }
  assert.throws(() => measureCapacity(initial, model, { ...limits, outputReserveTokens: undefined }), /planning headroom/);
  const measured = measureCapacity({ max_tokens: 100, messages: [{ role: 'user', content: 'Task' }] },
    { ...model, api: 'openai-completions', contextWindow: 1000 }, limits);
  assert.equal(measured.outputReserve, 100);
  assert.equal(measured.outputReserveSource, 'request-limit');
  assert.equal(measured.contextLimit, 1000);
});
