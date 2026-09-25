import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import { completeText, validateTextCompletionConfig, type TextCompletionResult } from '../src/text-completion.ts';
import { assistant, zeroUsage } from './history-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';

const model: Model<'openai-completions'> = {
  api: 'openai-completions', provider: 'jev-fixture', id: 'fixture', name: 'Fixture', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const config = { model, timeoutMs: 1000, maxTokens: 1024 };
const context: Context = { systemPrompt: 'Summarize the task.', messages: [
  { role: 'user', content: 'Fix the parser without changing the API.', timestamp: 1 },
] };
function response(): AssistantMessage {
  return { ...assistant(), content: [{ type: 'text', text: 'Preserve the parser API.' }],
    usage: { ...zeroUsage(), input: 80, cacheRead: 20, output: 4, totalTokens: 104 } };
}
const signal = () => new AbortController().signal;

test('text completion forces bounded no-tool, no-retry SSE inference and records catalog cost', async () => {
  const result = await completeText(context, 16_000, config, async (m, sent, options) => {
    assert.equal(m, model);
    assert.equal(sent, context);
    assert.equal(sent.tools, undefined);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.toolChoice, undefined);
    assert.equal(options.transport, 'sse');
    assert.equal(options.reasoning, undefined);
    assert.equal(options.maxTokens, 1024);
    assert.ok(options.signal);
    return response();
  }, signal());
  assert.equal(result.outcome, 'ok');
  assert.equal(result.text, 'Preserve the parser API.');
  assert.equal(result.usageSource, 'pi-normalized');
  assert.ok(Math.abs(result.pricedCostUsd! - 0.00009) < 1e-12);
});

test('valid usage survives rejected output, while missing or inconsistent usage stays unknown', async () => {
  for (const patch of [
    { content: [{ type: 'text' as const, text: 'x'.repeat(20_000) }] },
    { stopReason: 'length' as const },
    { stopReason: 'toolUse' as const },
    { content: [{ type: 'toolCall' as const, id: 'bad', name: 'read', arguments: {} }] },
  ]) {
    const result = await completeText(context, 16_000, config, async () => ({ ...response(), ...patch }), signal());
    assert.notEqual(result.outcome, 'ok');
    assert.ok(result.pricedCostUsd! > 0);
    assert.equal(result.text, undefined);
  }
  for (const patch of [
    { usage: zeroUsage() },
    { usage: { ...response().usage, input: -1 } },
    { usage: { ...response().usage, totalTokens: 999 } },
    { model: 'different' },
    { provider: 'different' },
    { usage: { ...response().usage, cacheWrite1h: 10 } },
  ]) {
    const result = await completeText(context, 16_000, config, async () => ({ ...response(), ...patch }), signal());
    assert.equal(result.pricedCostUsd, null);
    assert.equal(result.text, undefined);
  }
});

test('cancellation retains known spend but never returns text; pre-dispatch cancellation is free', async () => {
  const controller = new AbortController();
  const result = await completeText(context, 16_000, config, async () => {
    controller.abort();
    return response();
  }, controller.signal);
  assert.equal(result.outcome, 'cancelled');
  assert.ok(result.pricedCostUsd! > 0);
  assert.equal(result.text, undefined);
  let calls = 0;
  const cancelled = await completeText(context, 16_000, config, async () => { calls++; return response(); }, controller.signal);
  assert.equal(calls, 0);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.completionInvoked, false);
  assert.equal(cancelled.pricedCostUsd, 0);
});

test('transport failures and timeouts preserve unknown spend and provider diagnostics', async () => {
  const failed = await completeText(context, 16_000, config, async () => { throw new Error('transport failed'); }, signal());
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.pricedCostUsd, null);
  assert.equal(failed.completionInvoked, true);
  const timed = await completeText(context, 16_000, { ...config, timeoutMs: 5 }, async (_m, _c, options) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    options.signal!.throwIfAborted();
    return response();
  }, signal());
  assert.equal(timed.outcome, 'cancelled');
  assert.equal(timed.pricedCostUsd, null);
  const diagnostic = await completeText(context, 16_000, config, async () => ({
    ...response(), stopReason: 'error', errorMessage: '400: unsupported request field', usage: zeroUsage(),
  }), signal());
  assert.equal(diagnostic.outcome, 'error');
  assert.match(diagnostic.error!, /400: unsupported request field/);
  assert.equal(diagnostic.pricedCostUsd, null);
});

test('uncooperative completion cannot outlive the deadline or mutate a timed-out result', async () => {
  let finish!: (message: AssistantMessage) => void;
  // AbortSignal.timeout is unref'ed, so retain a test-only watchdog handle.
  const watchdog = setTimeout(() => {}, 1000);
  try {
    const result = await completeText(context, 16_000, { ...config, timeoutMs: 5 },
      () => new Promise((resolve) => { finish = resolve; }), signal());
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.pricedCostUsd, null);
    const frozen = structuredClone(result);
    finish(response());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(result, frozen);
  } finally { clearTimeout(watchdog); }
});

test('pricing uses catalog tiers and invalid configuration fails before dispatch', async () => {
  assert.throws(() => validateTextCompletionConfig({ ...config, timeoutMs: 0 }));
  assert.throws(() => validateTextCompletionConfig({ ...config, maxTokens: 1025 }));
  assert.throws(() => validateTextCompletionConfig({ ...config, model: { ...model, cost: { ...model.cost, input: NaN } } }));
  let calls = 0;
  const complete = async () => { calls++; return response(); };
  await assert.rejects(completeText(context, 0, config, complete, signal()), /bounds or tools/);
  await assert.rejects(completeText({ ...context, tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] },
    16_000, config, complete, signal()), /bounds or tools/);
  assert.equal(calls, 0);
  const costly = { ...config, model: { ...model, cost: { ...model.cost,
    tiers: [{ inputTokensAbove: 50, input: 10, output: 20, cacheRead: 1, cacheWrite: 10 }] } } };
  const result = await completeText(context, 16_000, costly, complete, signal());
  assert.ok(Math.abs(result.pricedCostUsd! - 0.0009) < 1e-12);
});

test('nested completion uses the real Pi model-registry transport without entering coding history', async () => {
  const f = await createPiFixture();
  f.respondWithText('Preserve the parser API.');
  let result: TextCompletionResult | undefined;
  try {
    const run = await f.session(() => [(pi) => {
      pi.on('before_provider_request', async (_event, ctx) => {
        result = await completeText(context, 16_000, { ...config, model: f.model },
          (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options).result(), ctx.signal!);
      });
    }]);
    await run.session.prompt('Coding request stays separate.');
    assert.equal(result?.outcome, 'ok');
    assert.equal(f.requests.length, 2);
    assert.equal(Object.hasOwn(f.requests[0]!, 'tool_choice'), false);
    assert.equal(Object.hasOwn(f.requests[0]!, 'tools'), false);
    assert.match(JSON.stringify(f.requests[0]!.messages), /Fix the parser/);
    assert.doesNotMatch(JSON.stringify(f.requests[0]!.messages), /Coding request stays separate/);
    assert.match(JSON.stringify(f.requests[1]!.messages), /Coding request stays separate/);
    assert.doesNotMatch(JSON.stringify(f.requests[1]!.messages), /Summarize the task|Fix the parser/);
    assert.equal(run.manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length, 1);
  } finally { await f.close(); }
});
