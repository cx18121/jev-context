import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model, Usage } from '@earendil-works/pi-ai';
import { measureRequest } from '../src/budget.ts';
import { createUsageAnchor, measureWorkingContext } from '../src/working-context.ts';

const model: Model<'openai-codex-responses'> = {
  id: 'fixture', name: 'fixture', api: 'openai-codex-responses', provider: 'fixture', baseUrl: 'http://localhost',
  reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const budget = { contextLimit: 32768, marginTokens: 100, outputReserveTokens: 1000 };
const usage: Usage = { input: 100, cacheRead: 800, cacheWrite: 100, output: 50, totalTokens: 1050,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const original = { model: 'fixture', instructions: 'Task', store: false, tools: [], input: [
  { type: 'reasoning', id: 'old', encrypted_content: 'opaque'.repeat(2000) },
  { type: 'function_call_output', call_id: 'old-call', output: 'x'.repeat(4000) },
] };
function fixture() {
  const anchor = createUsageAnchor(original, model, usage, 'request-1')!;
  const payload = { ...structuredClone(original), input: [...structuredClone(original.input),
    { type: 'reasoning', id: 'new', encrypted_content: 'opaque'.repeat(1000) },
    { type: 'message', role: 'assistant', content: 'Done.' },
    { type: 'message', role: 'user', content: 'Continue.' },
  ] as Array<Record<string, unknown>> };
  const measure = (value = payload, limit = 10000) => measureWorkingContext(value, model, measureRequest(value, model, budget), limit, anchor);
  return { anchor, payload, measure };
}

test('reported input includes cache reads/writes; new reasoning is counted once through output usage, not ciphertext', () => {
  const { payload, measure } = fixture();
  const expected = 1050 + Math.ceil(Buffer.byteLength(JSON.stringify(payload.input.at(-1))) / 4);
  assert.equal(measure().inputEstimate, expected);
  const full = expected + budget.marginTokens + budget.outputReserveTokens;
  assert.equal(measure(payload, full).fits, true);
  assert.equal(measure(payload, full - 1).fits, false);
  payload.input[2]!.encrypted_content = 'different opaque ciphertext'.repeat(2000);
  assert.equal(measure().inputEstimate, expected);
});

test('removal and restoration use signed text deltas; each completed request rebases on measured usage', () => {
  const { anchor, payload, measure } = fixture();
  const baseline = measure().inputEstimate!;
  const saved = structuredClone(payload);
  payload.input[1]!.output = '';
  assert.equal(measure().inputEstimate, baseline - 1000);
  payload.input[1]!.output = 'x'.repeat(8000);
  assert.equal(measure().inputEstimate, baseline + 1000);
  payload.input[1]!.output = '';
  const nextAnchor = createUsageAnchor(payload, model, usage, 'request-2')!;
  const next = { ...payload, input: [...payload.input, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Next' }] };
  const result = measureWorkingContext(next, model, measureRequest(next, model, budget), 10000, nextAnchor);
  assert.equal(result.inputEstimate, 1050 + Math.ceil(Buffer.byteLength(JSON.stringify(next.input.at(-1))) / 4));
  assert.equal(result.anchorRequestId, 'request-2');
  assert.deepEqual(anchor, createUsageAnchor(original, model, usage, 'request-1'));
  assert.deepEqual(saved.input[1], original.input[1]);
});

test('unknown usage or incompatible history never manufactures a soft-pressure decision', () => {
  const { anchor, payload, measure } = fixture();
  const hard = measureRequest(payload, model, budget);
  assert.deepEqual(measureWorkingContext(payload, model, hard, 1), {
    method: 'provider-usage-plus-delta-v1', inputEstimate: null, outputReserve: 1000, marginTokens: 100,
    contextLimit: 1, fits: null, anchorRequestId: null, unknownReason: 'no-anchor',
  });
  for (const change of [
    (p: typeof payload) => { p.instructions = 'Changed'; },
    (p: typeof payload) => { p.input[0]!.encrypted_content = 'Changed'; },
    (p: typeof payload) => { p.input[1]!.call_id = 'Different'; },
    (p: typeof payload) => { p.input.splice(0, 1); },
    (p: typeof payload) => { p.input.push({ role: 'assistant', content: 'Unaccounted response' }); },
    (p: typeof payload) => { p.input.push({ role: 'developer', content: 'Changed instructions' }); },
  ]) {
    const changed = structuredClone(payload);
    change(changed);
    assert.equal(measure(changed).fits, null);
  }
  assert.equal(measureWorkingContext(payload, { ...model, id: 'another' }, hard, 1, anchor).fits, null);
  assert.equal(measureWorkingContext(payload, { ...model, baseUrl: 'http://elsewhere' }, hard, 1, anchor).fits, null);
  for (const invalid of [{ ...usage, input: -1 }, { ...usage, input: NaN }, { ...usage, totalTokens: 1 },
    { ...usage, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 }]) {
    assert.equal(createUsageAnchor(original, model, invalid, 'bad'), undefined);
  }
});

test('completions supports the same anchor and only tool content may change in the old prefix', () => {
  const chat = { ...model, api: 'openai-completions' as const };
  const previous = { max_tokens: 1000, messages: [{ role: 'user', content: 'Task' }, { role: 'tool', tool_call_id: 'a', content: 'old' }] };
  const anchor = createUsageAnchor(previous, chat, usage, 'chat')!;
  const payload = { ...previous, messages: [...previous.messages, { role: 'assistant', content: 'Done' }, { role: 'user', content: 'Next' }] };
  const hard = measureRequest(payload, chat, budget);
  assert.equal(measureWorkingContext(payload, chat, hard, 3000, anchor).fits, true);
  const changed = structuredClone(payload);
  changed.messages[0]!.content = 'Different task';
  assert.equal(measureWorkingContext(changed, chat, hard, 3000, anchor).fits, null);
});
