import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
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
  const payload = { messages: view.filter((message) => message.role === 'toolResult').map((message) =>
    ({ role: 'tool', tool_call_id: message.toolCallId, content: providerText(message) })), max_tokens: 100 };
  const size = Buffer.byteLength(JSON.stringify(payload)) + 100;
  return { manager, a: a!, b: b!, original, history, view, payload, size,
    plan(contextLimit = 100_000) {
      const budget = { contextLimit, marginTokens: 0 };
      return { budget, plan: prepareSelection(payload, view, history, model, budget, [a!]) };
    } };
}

test('restoration judges and renders historical original text, not stubs; unchanged next view is identical', () => {
  const f = fixture();
  const { plan, budget } = f.plan();
  const before = structuredClone({ history: f.history, payload: f.payload });
  const request = prepareJevRequest(plan, f.view).request;
  const candidate = request.questions[f.a]!.instructions.candidate as { observation: string };
  assert.match(candidate.observation, /restored historical observation/);
  assert.ok(candidate.observation.endsWith(providerText(f.history.evidence[0]!.result)));
  assert.ok(!candidate.observation.includes('retired observation'));
  assert.ok(!JSON.stringify(request.state).includes('API original'));
  const selected = applySelection(plan, { [f.a]: 0.8, [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, [f.a]);
  assert.deepEqual(selected.retiredIds, []);
  assert.equal(selected.budget.fits, true);
  assert.deepEqual({ history: f.history, payload: f.payload }, before);
  record(f.manager, selected.retiredIds);
  const native = f.manager.buildSessionProjection().messages;
  readHistory(f.manager.getBranch(), native);
  const rendered = native.filter((message) => message.role === 'toolResult').map(providerText);
  assert.deepEqual((selected.payload as typeof f.payload).messages.map((message) => message.content), rendered);
});

test('a same-size set swap restores first and retires only low-rated visible evidence needed for room', () => {
  const f = fixture();
  const { plan, budget } = f.plan(f.size);
  assert.equal(plan.before.fits, true);
  const selected = applySelection(plan, { [f.a]: 0.9, [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(selected.restoredIds, [f.a]);
  assert.deepEqual(selected.retiredIds, [f.b]);
  assert.equal(selected.budget.fits, true);
  assert.equal((selected.payload as typeof f.payload).messages.at(-1)!.content, 'Protected');
});

test('threshold gap preserves uncertain archive and visible evidence; cannot-fit does not re-retire selected restorations', () => {
  const f = fixture();
  const { plan, budget } = f.plan(f.size);
  const unchanged = applySelection(plan, { [f.a]: 0.799, [f.b]: 0.1 }, 0.2, 0.8, model, budget);
  assert.deepEqual(unchanged.retiredIds, [f.a]);
  assert.deepEqual(unchanged.restoredIds, []);
  const cannotFit = applySelection(plan, { [f.a]: 0.8, [f.b]: 0.2 }, 0.2, 0.8, model, budget);
  assert.equal(cannotFit.budget.fits, false);
  assert.deepEqual(cannotFit.restoredIds, [f.a]);
  assert.deepEqual(cannotFit.retiredIds, []);
});

test('archive candidates must map to the existing unique stub at the provider boundary', () => {
  for (const kind of ['changed', 'missing', 'duplicate']) {
    const f = fixture();
    if (kind === 'changed') f.payload.messages[0]!.content = 'wrong stub';
    if (kind === 'missing') f.payload.messages[0]!.tool_call_id = 'normalized';
    if (kind === 'duplicate') f.payload.messages.push({ ...f.payload.messages[0]! });
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

test('invalid limits, overlapping thresholds, archive identities and partial scores fail explicitly', () => {
  for (const archiveLimit of [0, -1, 1.5, Infinity]) assert.throws(() => validateSelectionConfig({ archiveLimit, restoreAtOrAbove: 0.8 }, 0.2, { contextLimit: 100_000, marginTokens: 0 }), /archiveLimit/);
  for (const restoreAtOrAbove of [0.1, 0.2, 1.1, NaN]) assert.throws(() => validateSelectionConfig({ archiveLimit: 2, restoreAtOrAbove }, 0.2, { contextLimit: 100_000, marginTokens: 0 }), /restoreAtOrAbove/);
  const f = fixture();
  for (const ids of [[f.a, f.a], [f.b], ['missing']]) assert.throws(() => prepareSelection(f.payload, f.view, f.history, model, { contextLimit: 100000, marginTokens: 0 }, ids), /archive candidate/);
  const { plan, budget } = f.plan();
  assert.throws(() => applySelection(plan, { [f.a]: 0.9 }, 0.2, 0.8, model, budget), /scores/);
});

test('soft pressure builds candidates before the hard limit, with an inclusive target boundary', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  const prepare = (workingContextLimit: number) => prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit });
  const exact = prepare(f.size);
  assert.equal(exact.workingBefore.fits, true);
  assert.equal(exact.candidates.length, 0);
  const plan = prepare(f.size - 1);
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
  const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit: 1 });
  for (const score of [0.1, 0.2, 0.9]) {
    const selected = applySelection(plan, { [f.b]: score }, 0.2, 0.8, model, budget);
    assert.equal(selected.workingBudget.fits, false);
    assert.equal(selected.budget.fits, true);
    assert.deepEqual(new Set(selected.retiredIds), new Set(score < 0.2 ? [f.a, f.b] : [f.a]));
    assert.equal((selected.payload as typeof f.payload).messages.at(-1)!.content, 'Protected');
  }
});

test('restorations consume the soft allowance but are never re-retired to satisfy it', () => {
  const f = fixture();
  const budget = { contextLimit: 100_000, marginTokens: 0 };
  const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [f.a], { workingContextLimit: f.size });
  for (const score of [0.1, 0.9]) {
    const selected = applySelection(plan, { [f.a]: 0.9, [f.b]: score }, 0.2, 0.8, model, budget);
    assert.deepEqual(selected.restoredIds, [f.a]);
    assert.deepEqual(selected.retiredIds, score < 0.2 ? [f.b] : []);
    assert.equal(selected.workingBudget.fits, score < 0.2);
    assert.equal(selected.budget.fits, true);
  }
});

test('without a fresh event soft pressure waits, while hard pressure still selects', () => {
  const f = fixture();
  for (const contextLimit of [100_000, f.size - 1]) {
    const budget = { contextLimit, marginTokens: 0 };
    const plan = prepareSelection(f.payload, f.view, f.history, model, budget, [], { workingContextLimit: 1, reconsider: false });
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
