import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import { BRIEF_SOURCE_ENTRY, taskSources, updateBrief, validateBriefConfig, type BriefResult } from '../src/brief-session.ts';
import { planBriefUpdate } from '../src/task-brief.ts';
import { assistant, result, zeroUsage } from './history-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';

const model: Model<'openai-completions'> = {
  api: 'openai-completions', provider: 'jev-fixture', id: 'fixture', name: 'Fixture', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const config = { model, timeoutMs: 1000, maxTokens: 1024 };
const sources = [{ id: 'u1', role: 'user' as const, text: 'Fix the parser without changing the API.' }];
const output = { retain: [], add: [{ kind: 'requirement', text: sources[0]!.text,
  references: [{ sourceId: 'u1', quote: sources[0]!.text }] }], supersede: [], activity: [] };
function response(): AssistantMessage {
  return { ...assistant(), content: [{ type: 'text', text: JSON.stringify(output) }],
    usage: { ...zeroUsage(), input: 80, cacheRead: 20, output: 4, totalTokens: 104 } };
}

test('session sources retain identities and authority but exclude reasoning and observations', () => {
  const manager = SessionManager.inMemory();
  const userId = manager.appendMessage({ role: 'user', content: sources[0]!.text, timestamp: 1 });
  const systemId = manager.appendCustomEntry(BRIEF_SOURCE_ENTRY, { version: 1, text: 'Rendered system instructions.' });
  manager.appendMessage({ ...assistant(), content: [
    { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'OPAQUE_SIGNATURE' },
    { type: 'text', text: 'I will inspect the parser.' },
    { type: 'toolCall', id: 'read1', name: 'read', arguments: { path: 'parser.ts' } },
  ] });
  manager.appendMessage(result('read1', 'TOOL_BODY_EXCLUDED'));
  manager.appendCustomEntry('unrelated', { data: 'PRIVATE_METADATA' });
  const extracted = taskSources(manager.getBranch());
  assert.equal(extracted.length, 3);
  assert.deepEqual(extracted[0], { ...sources[0], id: userId });
  assert.deepEqual(extracted[1], { id: systemId, role: 'system', text: 'Rendered system instructions.' });
  assert.equal(extracted[2]!.role, 'assistant');
  assert.match(extracted[2]!.text, /parser.ts/);
  assert.doesNotMatch(JSON.stringify(extracted), /PRIVATE_|OPAQUE_|TOOL_BODY_/);
});

test('brief requests force bounded no-tool, no-retry SSE inference and record normalized catalog cost', async () => {
  const plan = planBriefUpdate(sources, null)!;
  const updated = await updateBrief(plan, sources, config, async (m, context, options) => {
    assert.equal(m, model);
    assert.equal(context.messages.length, 1);
    assert.equal(options.maxRetries, 0);
    assert.equal(options.toolChoice, undefined);
    assert.equal(context.tools, undefined);
    assert.equal(options.transport, 'sse');
    assert.equal(options.reasoning, undefined);
    assert.equal(options.maxTokens, 1024);
    assert.ok(options.signal);
    return response();
  }, new AbortController().signal);
  assert.equal(updated.outcome, 'ok');
  assert.equal(updated.brief!.items[0]!.text, sources[0]!.text);
  assert.equal(updated.usageSource, 'pi-normalized');
  assert.ok(Math.abs(updated.pricedCostUsd! - 0.00009) < 1e-12);
});

test('valid usage survives invalid generation, while missing or inconsistent usage stays unknown', async () => {
  const plan = planBriefUpdate(sources, null)!;
  for (const patch of [
    { content: [{ type: 'text' as const, text: '{}' }] },
    { content: [{ type: 'text' as const, text: 'not JSON' }] },
    { content: [{ type: 'text' as const, text: 'x'.repeat(20_000) }] },
    { stopReason: 'length' as const },
    { stopReason: 'toolUse' as const },
  ]) {
    const updated = await updateBrief(plan, sources, config, async () => ({ ...response(), ...patch }), new AbortController().signal);
    assert.notEqual(updated.outcome, 'ok');
    assert.ok(updated.pricedCostUsd! > 0);
    assert.equal(updated.brief, undefined);
  }
  for (const patch of [
    { usage: zeroUsage() },
    { usage: { ...response().usage, input: -1 } },
    { usage: { ...response().usage, totalTokens: 999 } },
    { model: 'different' },
    { usage: { ...response().usage, cacheWrite1h: 10 } },
  ]) {
    const updated = await updateBrief(plan, sources, config, async () => ({ ...response(), ...patch }), new AbortController().signal);
    assert.equal(updated.pricedCostUsd, null);
    assert.equal(updated.brief, undefined);
  }
});

test('cancellation retains known spend but never installs an update', async () => {
  const controller = new AbortController();
  const updated = await updateBrief(planBriefUpdate(sources, null)!, sources, config, async () => {
    controller.abort();
    return response();
  }, controller.signal);
  assert.equal(updated.outcome, 'cancelled');
  assert.ok(updated.pricedCostUsd! > 0);
  assert.equal(updated.brief, undefined);
  let calls = 0;
  const cancelled = await updateBrief(planBriefUpdate(sources, null)!, sources, config, async () => { calls++; return response(); }, controller.signal);
  assert.equal(calls, 0);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.completionInvoked, false);
  assert.equal(cancelled.pricedCostUsd, 0);
});

test('request timeout and transport failures remain unknown-cost failures', async () => {
  const plan = planBriefUpdate(sources, null)!;
  const failed = await updateBrief(plan, sources, config, async () => { throw new Error('transport failed'); }, new AbortController().signal);
  assert.equal(failed.outcome, 'error');
  assert.equal(failed.pricedCostUsd, null);
  assert.equal(failed.completionInvoked, true);
  const timed = await updateBrief(plan, sources, { ...config, timeoutMs: 5 }, async (_m, _c, options) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    options.signal!.throwIfAborted();
    return response();
  }, new AbortController().signal);
  assert.equal(timed.outcome, 'cancelled');
  assert.equal(timed.pricedCostUsd, null);
});

test('provider diagnostics survive unknown accounting', async () => {
  const updated = await updateBrief(planBriefUpdate(sources, null)!, sources, config, async () => ({
    ...response(), stopReason: 'error', errorMessage: '400: unsupported request field', usage: zeroUsage(),
  }), new AbortController().signal);
  assert.equal(updated.outcome, 'error');
  assert.match(updated.error!, /400: unsupported request field/);
  assert.equal(updated.pricedCostUsd, null);
});

test('uncooperative completion cannot outlive the deadline or mutate a timed-out result', async () => {
  let finish!: (message: AssistantMessage) => void;
  // AbortSignal.timeout is unref'ed, so retain a test-only watchdog handle.
  const watchdog = setTimeout(() => {}, 1000);
  try {
    const updated = await updateBrief(planBriefUpdate(sources, null)!, sources, { ...config, timeoutMs: 5 },
      () => new Promise((resolve) => { finish = resolve; }), new AbortController().signal);
    assert.equal(updated.outcome, 'cancelled');
    assert.equal(updated.pricedCostUsd, null);
    const frozen = structuredClone(updated);
    finish(response());
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(updated, frozen);
  } finally { clearTimeout(watchdog); }
});

test('pricing uses request-wide catalog tiers and rejects invalid configuration before dispatch', async () => {
  assert.throws(() => validateBriefConfig({ ...config, timeoutMs: 0 }));
  assert.throws(() => validateBriefConfig({ ...config, maxTokens: 1025 }));
  assert.throws(() => validateBriefConfig({ ...config, model: { ...model, cost: { ...model.cost, input: NaN } } }));
  const costly = { ...config, model: { ...model, cost: { ...model.cost,
    tiers: [{ inputTokensAbove: 50, input: 10, output: 20, cacheRead: 1, cacheWrite: 10 }] } } };
  const updated = await updateBrief(planBriefUpdate(sources, null)!, sources, costly, async () => response(), new AbortController().signal);
  assert.ok(Math.abs(updated.pricedCostUsd! - 0.0009) < 1e-12);
});

test('automatic update reaches a real Pi model-registry transport, separate from coding history', async () => {
  const f = await createPiFixture();
  f.respondWithText(JSON.stringify(output));
  let updated: BriefResult | undefined;
  try {
    const run = await f.session(() => [(pi) => {
      pi.on('before_provider_request', async (_event, ctx) => {
        updated = await updateBrief(planBriefUpdate(sources, null)!, sources, { ...config, model: f.model },
          (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options).result(), ctx.signal!);
      });
    }]);
    await run.session.prompt('Coding request stays separate.');
    assert.equal(updated?.outcome, 'ok');
    assert.equal(f.requests.length, 2);
    assert.equal(Object.hasOwn(f.requests[0]!, 'tool_choice'), false);
    assert.equal(Object.hasOwn(f.requests[0]!, 'tools'), false);
    assert.match(JSON.stringify(f.requests[0]!.messages), /Fix the parser/);
    assert.doesNotMatch(JSON.stringify(f.requests[0]!.messages), /Coding request stays separate/);
    assert.match(JSON.stringify(f.requests[1]!.messages), /Coding request stays separate/);
    assert.doesNotMatch(JSON.stringify(f.requests[1]!.messages), /Maintain a compact|Fix the parser/);
    assert.equal(run.manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'assistant').length, 1);
  } finally { await f.close(); }
});
