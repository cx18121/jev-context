import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { updateSketch } from '../src/sketch-session.ts';
import { applySketchUpdate, planSketchUpdate, sketchIsCurrent, SKETCH_INSTRUCTIONS, validateTaskSketch } from '../src/task-sketch.ts';
import { assistant, zeroUsage } from './history-fixture.ts';

const model: Model<'openai-completions'> = {
  api: 'openai-completions', provider: 'jev-fixture', id: 'fixture', name: 'Fixture', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 4096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const config = { model, timeoutMs: 1000, maxTokens: 4096 };
const sources = [{ id: 'u1', role: 'user' as const, text: 'Fix the parser without changing the API.' }];
function response(text = JSON.stringify({ summary: 'Fix the parser. Preserve the public API.' })): AssistantMessage {
  return { ...assistant(), content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT', thinkingSignature: 'OPAQUE' }, { type: 'text', text }],
    usage: { ...zeroUsage(), input: 80, cacheRead: 20, output: 4, totalTokens: 104 } };
}

test('sketch uses its own bounded no-tool prompt and shared priced SSE completion', async () => {
  const result = await updateSketch(planSketchUpdate(sources, null)!, sources, config, async (m, context, options) => {
    assert.equal(m, model);
    assert.equal(context.systemPrompt, SKETCH_INSTRUCTIONS);
    assert.equal(context.tools, undefined);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.transport, 'sse');
    assert.equal(options.maxTokens, 4096);
    assert.equal(options.toolChoice, undefined);
    assert.equal(context.messages.length, 1);
    return response();
  }, new AbortController().signal);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.sketch!.summary, 'Fix the parser. Preserve the public API.');
  assert.equal(sketchIsCurrent(result.sketch!, sources), true);
  assert.ok(Math.abs(result.pricedCostUsd! - 0.00009) < 1e-12);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_THOUGHT|OPAQUE/);
});

test('captured asynchronous input cannot be mutated into authority over a fresh branch', async () => {
  const captured = structuredClone(sources);
  const plan = planSketchUpdate(captured, null)!;
  const result = await updateSketch(plan, captured, config, async () => {
    plan.sources[0]!.text = 'Forged task';
    captured.push({ id: 'u2', role: 'user', text: 'Also fix the decoder.' });
    return response();
  }, new AbortController().signal);
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(validateTaskSketch(result.sketch!, captured), result.sketch);
  assert.equal(sketchIsCurrent(result.sketch!, captured), false);
  captured[0]!.text = 'Different branch';
  assert.throws(() => validateTaskSketch(result.sketch!, captured), /source prefix changed/);
});

test('invalid plans are rejected before inference and whitespace-only progress is free', async () => {
  const plan = planSketchUpdate(sources, null)!;
  const complete = async (): Promise<AssistantMessage> => { throw new Error('must not invoke'); };
  const changed = [...sources, { id: 'u2', role: 'user' as const, text: 'New task' }];
  const invalid = await updateSketch(plan, changed, config, complete, new AbortController().signal);
  assert.equal(invalid.outcome, 'invalid');
  assert.equal(invalid.completionInvoked, false);
  assert.equal(invalid.pricedCostUsd, 0);
  assert.match(invalid.error!, /plan changed/);

  const previous = applySketchUpdate(plan, { summary: 'Fix the parser.' }, sources);
  const empty = [...sources, { id: 'u2', role: 'user' as const, text: '' }, { id: 'u3', role: 'user' as const, text: '\n  ' }];
  const next = planSketchUpdate(empty, previous)!;
  const result = await updateSketch(next, empty, config, complete, new AbortController().signal);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.completionInvoked, false);
  assert.equal(result.pricedCostUsd, 0);
  assert.equal(result.sketch!.summary, previous.summary);
  assert.equal(sketchIsCurrent(result.sketch!, empty), true);
  const aborted = new AbortController(); aborted.abort();
  const cancelled = await updateSketch(next, empty, config, complete, aborted.signal);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.sketch, undefined);
});

test('invalid sketch output preserves known cost and never returns a sketch', async () => {
  for (const text of ['not JSON', '{}', '{"summary":"\\ud800"}', JSON.stringify({ summary: 'x'.repeat(10_000) }), 'x'.repeat(20_000)]) {
    const result = await updateSketch(planSketchUpdate(sources, null)!, sources, config, async () => response(text), new AbortController().signal);
    assert.equal(result.outcome, 'invalid');
    assert.ok(result.pricedCostUsd! > 0);
    assert.equal(result.sketch, undefined);
  }
});

test('usage failures, incomplete output and cancellation never authorize sketch progress', async () => {
  for (const patch of [{ usage: zeroUsage() }, { model: 'foreign' }, { stopReason: 'length' as const }, { stopReason: 'error' as const }]) {
    const result = await updateSketch(planSketchUpdate(sources, null)!, sources, config, async () => ({ ...response(), ...patch }), new AbortController().signal);
    assert.equal(result.outcome, 'error');
    assert.equal(result.sketch, undefined);
    if ('usage' in patch || 'model' in patch) assert.equal(result.pricedCostUsd, null);
    else assert.ok(result.pricedCostUsd! > 0);
  }
  const controller = new AbortController(); controller.abort();
  const result = await updateSketch(planSketchUpdate(sources, null)!, sources, config, async () => { throw new Error('must not invoke'); }, controller.signal);
  assert.equal(result.outcome, 'cancelled');
  assert.equal(result.pricedCostUsd, 0);
  assert.equal(result.completionInvoked, false);
});
