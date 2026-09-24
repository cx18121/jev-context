import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { createUsageAnchor, measureWorkingContext } from '../src/working-context.ts';
import { commitSelection, buildView, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { prepareJevRequest } from '../src/judge-state.ts';
import { providerText } from '../src/provider-view.ts';
import { applySelection, prepareSelection, selectionEvents, validateSelectionConfig } from '../src/selection.ts';
import { appendExchange, assistant, result } from './history-fixture.ts';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://127.0.0.1',
  reasoning: false, input: ['text'], contextWindow: 100_000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function record(manager: SessionManager, retiredIds: string[], policy = 'jev-select-v1') {
  return commitSelection(manager, retiredIds, policy);
}
function fixture() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: 'Return to the API contract.', timestamp: 1 });
  const [a] = appendExchange(manager, [result('a', 'API original\n"\\\ud800'.repeat(50), { isError: true, details: { truncation: { truncated: true } } })]);
  const [b] = appendExchange(manager, [result('b', 'Obsolete output.'.repeat(120))]);
  appendExchange(manager, [result('latest', 'Protected')]);
  record(manager, [a!]);
  const original = manager.buildSessionContext().messages;
  const history = readHistory(manager.getBranch(), original);
  const view = buildView(original, history, history.retiredIds);
  const payload = { messages: view.filter((message) => message.role === 'toolResult').flatMap((message) =>
    [{ role: 'assistant', content: 'Read file.' }, { role: 'tool', tool_call_id: message.toolCallId, content: providerText(message) }]), max_tokens: 100 };
  const size = Buffer.byteLength(JSON.stringify(payload)) + 100;
  const anchor = createUsageAnchor({ ...payload, messages: payload.messages.slice(0, -2) }, model,
    { ...assistant([]).usage, input: 1000, output: 10, totalTokens: 1010 }, 'previous')!;
  const measured = measureWorkingContext(payload, model, measureRequest(payload, model, { contextLimit: 100_000, marginTokens: 0 }), 100_000, anchor);
  const workingSize = measured.inputEstimate! + measured.outputReserve;
  return { manager, a: a!, b: b!, original, history, view, payload, size, anchor, workingSize,
    plan(contextLimit = 100_000) {
      const budget = { contextLimit, marginTokens: 0 };
      return { budget, plan: prepareSelection(payload, view, history, model, budget, [a!]) };
    } };
}

test('restoration judges and renders historical original text, not stubs; unchanged next view is identical', () => {
  const f = fixture();
  const { plan, budget } = f.plan();
  const before = structuredClone({ history: f.history, payload: f.payload });
  const request = prepareJevRequest(plan, f.view, model.api).request;
  const candidate = request.questions[f.a]!.instructions.candidate as { observation: string };
  assert.match(candidate.observation, /restored historical observation/);
  assert.ok(candidate.observation.endsWith(providerText(f.history.evidence[0]!.result)));
  assert.ok(!candidate.observation.includes('retired observation'));
  assert.ok(!JSON.stringify(request.state).includes('API original'));
  assert.deepEqual(plan.candidates.map((item) => item.evidence.id), [f.a]);
  const selected = applySelection(plan, { [f.a]: 0.8 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, [f.a]);
  assert.deepEqual(selected.retiredIds, []);
  assert.equal(selected.budget.fits, true);
  assert.deepEqual({ history: f.history, payload: f.payload }, before);
  record(f.manager, selected.retiredIds);
  const native = f.manager.buildSessionProjection().messages;
  readHistory(f.manager.getBranch(), native);
  const rendered = native.filter((message) => message.role === 'toolResult').map(providerText);
  assert.deepEqual((selected.payload as typeof f.payload).messages.filter((message) => message.role === 'tool').map((message) => message.content), rendered);
});

test('under pressure a set swap restores only with judged low-rated evidence making room', () => {
  const f = fixture();
  const { plan, budget } = f.plan(f.size - 1);
  assert.equal(plan.before.fits, false);
  const selected = applySelection(plan, { [f.a]: 0.9, [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, [f.a]);
  assert.deepEqual(selected.retiredIds, [f.b]);
  assert.equal(selected.budget.fits, true);
  assert.equal((selected.payload as typeof f.payload).messages.at(-1)!.content, 'Protected');
});

test('a fitting base does not rejudge visible evidence, and an oversized restoration stays archived', () => {
  const f = fixture();
  const { plan, budget } = f.plan(f.size);
  assert.deepEqual(plan.candidates.map((item) => item.evidence.id), [f.a]);
  const unchanged = applySelection(plan, { [f.a]: 0.799 }, 0.2, 0.8, model, budget);
  assert.deepEqual(unchanged.retiredIds, [f.a]);
  assert.deepEqual(unchanged.restoredIds, []);
  const cannotFit = applySelection(plan, { [f.a]: 0.8 }, 0.2, 0.8, model, budget);
  assert.equal(cannotFit.budget.fits, true);
  assert.deepEqual(cannotFit.restoredIds, []);
  assert.deepEqual(cannotFit.skippedRestoreIds, [f.a]);
  assert.deepEqual(cannotFit.retiredIds, [f.a]);
  assert.deepEqual(cannotFit.payload, f.payload);
});

test('partial scores never change unjudged evidence, even under hard pressure', () => {
  const f = fixture();
  const { plan, budget } = f.plan(f.size - 1);
  const noScores = applySelection(plan, {}, 0.2, 0.8, model, budget);
  assert.deepEqual(noScores.payload, f.payload);
  assert.equal(noScores.budget.fits, false);
  const selected = applySelection(plan, { [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(new Set(selected.retiredIds), new Set([f.a, f.b]));
  assert.deepEqual(selected.restoredIds, []);
  assert.equal(selected.budget.fits, true);
});

test('a failed restoration rolls back trial retirements and does not block a smaller restoration', () => {
  const manager = SessionManager.inMemory();
  const [large] = appendExchange(manager, [result('large', 'large'.repeat(2000))]);
  const [small] = appendExchange(manager, [result('small', 'small'.repeat(100))]);
  const [first] = appendExchange(manager, [result('first', 'first'.repeat(100))]);
  const [second] = appendExchange(manager, [result('second', 'second'.repeat(400))]);
  appendExchange(manager, [result('latest', 'Protected')]);
  record(manager, [large!, small!]);
  const messages = manager.buildSessionContext().messages;
  const history = readHistory(manager.getBranch(), messages);
  const payload = { messages: messages.filter((m) => m.role === 'toolResult').map((m) =>
    ({ role: 'tool', tool_call_id: m.toolCallId, content: providerText(m) })), max_tokens: 100 };
  const budget = { contextLimit: Buffer.byteLength(JSON.stringify(payload)) + 99, marginTokens: 0 };
  const plan = prepareSelection(payload, messages, history, model, budget, [large!, small!]);
  const base = applySelection(plan, { [first!]: 0.05 }, 0.2, 0.8, model, budget);
  const failed = applySelection(plan, { [large!]: 0.99, [first!]: 0.05, [second!]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(failed.payload, base.payload, 'failed trial restores the exact prior view');
  assert.deepEqual(failed.retiredIds, base.retiredIds);
  assert.deepEqual(failed.skippedRestoreIds, [large]);
  const selected = applySelection(plan, { [large!]: 0.99, [small!]: 0.9, [first!]: 0.05, [second!]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, [small]);
  assert.deepEqual(selected.skippedRestoreIds, [large]);
  assert.deepEqual(new Set(selected.retiredIds), new Set([large, first, second]));
  assert.equal(selected.budget.fits, true);
});

test('archive candidates must map to the existing unique stub at the provider boundary', () => {
  for (const kind of ['changed', 'missing', 'duplicate']) {
    const f = fixture();
    if (kind === 'changed') f.payload.messages[1]!.content = 'wrong stub';
    if (kind === 'missing') f.payload.messages[1]!.tool_call_id = 'normalized';
    if (kind === 'duplicate') f.payload.messages.push({ ...f.payload.messages[1]! });
    assert.throws(() => f.plan(), /unique provider tool result|differs from the selected view/);
  }
});

test('event checkpoints are branch-owned, skip resume, and foreign policies reset reconsideration', () => {
  const f = fixture();
  const events = () => selectionEvents(f.manager.getBranch(), readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages));
  assert.deepEqual(events(), { userIds: [], exchangeIds: [] });
  const checkpoint = f.manager.getLeafId()!;
  const user = f.manager.appendMessage({ role: 'user', content: 'Changed task', timestamp: 4 });
  assert.deepEqual(events(), { userIds: [user], exchangeIds: [] });
  record(f.manager, [f.a]);
  assert.deepEqual(events(), { userIds: [], exchangeIds: [] });
  f.manager.branch(checkpoint);
  assert.deepEqual(events(), { userIds: [], exchangeIds: [] });
  record(f.manager, [f.a], 'jev-v1');
  assert.ok(events().userIds.length > 0);
});

test('only complete exchanges trigger, including a complete non-text exchange', () => {
  const f = fixture();
  const [image] = appendExchange(f.manager, [result('image', '', { content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] })]);
  const original = f.manager.buildSessionContext().messages;
  const history = readHistory(f.manager.getBranch(), original);
  assert.equal(history.evidence.at(-1)!.protectedReason, 'non-text');
  assert.deepEqual(selectionEvents(f.manager.getBranch(), history).exchangeIds, [image]);
  record(f.manager, [f.a]);
  f.manager.appendMessage(assistant([
    { type: 'toolCall', id: 'unfinished', name: 'read', arguments: {} },
    { type: 'toolCall', id: 'missing', name: 'read', arguments: {} },
  ]));
  f.manager.appendMessage(result('unfinished', 'Partial exchange'));
  const incomplete = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  assert.deepEqual(selectionEvents(f.manager.getBranch(), incomplete), { userIds: [], exchangeIds: [] });
});

test('invalid limits, overlapping thresholds, archive identities and invalid scores fail explicitly', () => {
  for (const archiveLimit of [0, -1, 1.5, Infinity]) assert.throws(() => validateSelectionConfig({ archiveLimit, restoreAtOrAbove: 0.8 }, 0.2, { contextLimit: 100_000, marginTokens: 0 }), /archiveLimit/);
  for (const restoreAtOrAbove of [0.1, 0.2, 1.1, NaN]) assert.throws(() => validateSelectionConfig({ archiveLimit: 2, restoreAtOrAbove }, 0.2, { contextLimit: 100_000, marginTokens: 0 }), /restoreAtOrAbove/);
  const f = fixture();
  for (const ids of [[f.a, f.a], [f.b], ['missing']]) assert.throws(() => prepareSelection(f.payload, f.view, f.history, model, { contextLimit: 100000, marginTokens: 0 }, ids), /archive candidate/);
  const { plan, budget } = f.plan();
  for (const relevance of [{ missing: 0.9 }, { [f.a]: NaN }, { [f.a]: -1 }, { [f.a]: 1.1 }]) {
    assert.throws(() => applySelection(plan, relevance, 0.2, 0.8, model, budget), /scores/);
  }
  assert.deepEqual(applySelection(plan, {}, 0.2, 0.8, model, budget).payload, f.payload);
});

test('soft pressure builds candidates before the hard limit, with an inclusive target boundary', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  const prepare = (workingContextLimit: number) => prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit, anchor: f.anchor });
  const exact = prepare(f.workingSize);
  assert.equal(exact.workingBefore.fits, true);
  assert.equal(exact.candidates.length, 0);
  const plan = prepare(f.workingSize - 1);
  assert.equal(plan.before.fits, true);
  assert.equal(plan.workingBefore.fits, false);
  assert.deepEqual(plan.candidates.map((item) => item.evidence.id), [f.b]);
  const selected = applySelection(plan, { [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(new Set(selected.retiredIds), new Set([f.a, f.b]));
  assert.equal(selected.workingBudget.fits, true);
  assert.deepEqual(selected.budget, measureRequest(selected.payload, model, budget));
  assert.equal(selected.budget.fits, true);
  assert.equal(selected.budget.contextLimit, 100_000);
});

test('a missed soft target neither retires relevant evidence nor becomes a hard-budget failure', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit: 1, anchor: f.anchor });
  for (const score of [0.1, 0.2, 0.9]) {
    const selected = applySelection(plan, { [f.b]: score }, 0.2, 0.8, model, budget);
    assert.equal(selected.workingBudget.fits, false);
    assert.equal(selected.budget.fits, true);
    assert.deepEqual(new Set(selected.retiredIds), new Set(score < 0.2 ? [f.a, f.b] : [f.a]));
    assert.equal((selected.payload as typeof f.payload).messages.at(-1)!.content, 'Protected');
  }
});

test('restorations must fit the known soft allowance, even when the hard guard has room', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [f.a], { workingContextLimit: f.workingSize, anchor: f.anchor });
  const selected = applySelection(plan, { [f.a]: 0.9 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, []);
  assert.deepEqual(selected.skippedRestoreIds, [f.a]);
  assert.deepEqual(selected.retiredIds, [f.a]);
  assert.equal(selected.workingBudget.fits, true);
  assert.equal(selected.budget.fits, true);
  assert.deepEqual(selected.payload, f.payload);
  const unknown = prepareSelection(f.payload, f.view, f.history, model, budget, [f.a], { workingContextLimit: 1 });
  assert.deepEqual(applySelection(unknown, { [f.a]: 0.9 }, 0.2, 0.8, model, budget).restoredIds, [f.a]);
});

test('without a fresh event soft pressure waits, while hard pressure still selects', () => {
  const f = fixture();
  for (const contextLimit of [100_000, f.size - 1]) {
    const budget = { contextLimit, marginTokens: 0 };
    const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit: 1, reconsider: false, anchor: f.anchor });
    assert.equal(plan.candidates.length, contextLimit === 100_000 ? 0 : 1);
    const selected = applySelection(plan, contextLimit === 100_000 ? {} : { [f.b]: 0.1 }, 0.2, 0.8, model, budget);
    assert.equal(selected.budget.fits, true);
    assert.equal(selected.workingBudget.fits, false);
    if (contextLimit === 100_000) assert.deepEqual(selected.payload, f.payload);
  }
});

test('working target validates both the configured hard limit and the effective model window', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  for (const workingContextLimit of [0, -1, 1.5, Infinity, NaN, 100_001]) {
    assert.throws(() => validateSelectionConfig({ archiveLimit: 2, restoreAtOrAbove: 0.8, workingContextLimit }, 0.2, budget), /workingContextLimit/);
    assert.throws(() => prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit }), /workingContextLimit/);
  }
  assert.throws(() => prepareSelection(f.payload, f.view, f.history, { ...model, contextWindow: 10_000 }, budget, [], { workingContextLimit: 20_000 }), /effective hard/);
  const omitted = prepareSelection(f.payload, f.view, f.history, model, budget, []);
  assert.deepEqual(omitted.workingBefore, omitted.before);
  assert.equal(omitted.candidates.length, 0);
});
