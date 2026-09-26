import assert from 'node:assert/strict';
import test from 'node:test';
import type { Model } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { buildView, commitSelection, readHistory } from '../src/history.ts';
import { providerText } from '../src/provider-view.ts';
import { prepareWorkingSetView } from '../src/working-set-view.ts';
import { appendExchange, assistant, result } from './history-fixture.ts';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'fixture', baseUrl: 'http://localhost',
  reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const limits = { contextLimit: 10000, marginTokens: 100, maxRequestBytes: 40000 };
interface WireMessage { role: string; content: string; tool_call_id?: string }
function fixture() {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: 'user', content: 'Fix the contract without changing the public API.', timestamp: 1 });
  const [a] = appendExchange(manager, [result('a', 'Old API contract. '.repeat(150))]);
  const [b] = appendExchange(manager, [result('b', 'Environment detour. '.repeat(150))]);
  const [short] = appendExchange(manager, [result('short', 'ok')]);
  const [latest] = appendExchange(manager, [result('latest', 'NEWEST RESULT MUST SURVIVE')]);
  function prepare(archive: string[] = []) {
    const projected = manager.buildSessionContext().messages;
    const history = readHistory(manager.getBranch(), projected);
    const messages = buildView(projected, history, history.retiredIds);
    const wireMessages: WireMessage[] = [{ role: 'system', content: 'Protected system instructions.' },
      ...messages.map((message): WireMessage => {
        if (message.role === 'toolResult') return { role: 'tool', tool_call_id: message.toolCallId, content: providerText(message) };
        assert.ok(message.role === 'user' || message.role === 'assistant');
        return { role: message.role, content: JSON.stringify(message.content) };
      })];
    const payload = { max_tokens: 100, tools: [{ type: 'function', function: { name: 'read', description: 'Read a file' } }], messages: wireMessages };
    const plan = prepareWorkingSetView(payload, messages, history, model, limits, archive);
    return { plan, payload, messages, history };
  }
  return { manager, a: a!, b: b!, short: short!, latest: latest!, prepare };
}

test('the complete replacement edits only selected tool bodies and round-trips through native history', () => {
  const f = fixture(), first = f.prepare();
  const original = structuredClone(first.payload), branch = structuredClone(f.manager.getBranch());
  assert.deepEqual(first.plan.candidates.map((item) => item.id), [f.a, f.b]);
  const lowTokens = first.plan.floor.totalTokens + 1100;
  const target = { lowTokens, highTokens: lowTokens + 500, restoreHeadroomTokens: 0 };
  const selected = first.plan.select(target, 'rebalance', { kind: 'jev', priorities: { [f.a]: { level: 4, score: 4 }, [f.b]: { level: 1, score: 1 } } });
  assert.equal(selected.selection.outcome, 'selected');
  assert.deepEqual(selected.retiredIds, [f.b]);
  assert.equal(selected.selection.after.admitted, true);
  assert.deepEqual(first.payload, original);
  assert.deepEqual(f.manager.getBranch(), branch, 'planning alone never writes history');
  const proposed = selected.payload as typeof first.payload;
  const differences = original.messages.flatMap((item, index) => JSON.stringify(item) === JSON.stringify(proposed.messages[index]) ? [] : [index]);
  assert.equal(differences.length, 1);
  assert.equal(proposed.messages[differences[0]!]!.tool_call_id, 'b');
  assert.match(proposed.messages[differences[0]!]!.content, /retired observation/);
  assert.deepEqual(proposed.tools, original.tools);
  commitSelection(f.manager, selected.retiredIds, 'working-set-v1');
  assert.deepEqual(f.prepare().payload, proposed);
  assert.deepEqual(f.manager.getBranch().filter((entry) => entry.type === 'message'), branch.filter((entry) => entry.type === 'message'));

  const next = f.prepare([f.b]);
  const restored = next.plan.select(target, 'rebalance', { kind: 'jev', priorities: { [f.a]: { level: 1, score: 1 }, [f.b]: { level: 4, score: 4 } } });
  assert.deepEqual(restored.retiredIds, [f.a]);
  assert.deepEqual(restored.selection.restoredIds, [f.b]);
  commitSelection(f.manager, restored.retiredIds, 'working-set-v1');
  assert.deepEqual(f.prepare().payload, restored.payload);
  assert.match(JSON.stringify(restored.payload), /restored historical observation/);
  assert.match(JSON.stringify(restored.payload), /NEWEST RESULT MUST SURVIVE/);
});

test('capture-order uses the same native view and preserves pins when newer archives swap in', () => {
  const f = fixture();
  commitSelection(f.manager, [f.b], 'working-set-v1');
  const { plan, payload } = f.prepare([f.b]);
  const target = { lowTokens: plan.floor.totalTokens + 1100, highTokens: plan.floor.totalTokens + 1600, restoreHeadroomTokens: 0 };
  assert.deepEqual(plan.candidates.map((item) => item.id), [f.a, f.b]);
  const selected = plan.select(target, 'rebalance', { kind: 'capture-order' });
  assert.deepEqual(selected.selection.restoredIds, [f.b]);
  assert.deepEqual(selected.selection.displacedIds, [f.a]);
  assert.match(JSON.stringify(selected.payload), /NEWEST RESULT MUST SURVIVE/);
  assert.deepEqual((selected.payload as typeof payload).tools, payload.tools);
  commitSelection(f.manager, selected.retiredIds, 'working-set-v1');
  assert.deepEqual(f.prepare().payload, selected.payload);
});

test('unshortlisted archives remain stubbed, while tool-only restoration does not require resident scores', () => {
  const f = fixture();
  commitSelection(f.manager, [f.a, f.b], 'working-set-v1');
  const { plan } = f.prepare([f.a]);
  assert.deepEqual(plan.candidates.map((item) => item.id), [f.a]);
  const selected = plan.select({ lowTokens: 8000, highTokens: 9000, restoreHeadroomTokens: 0 }, 'restore-only', { kind: 'jev', priorities: { [f.a]: { level: 3, score: 3 } } });
  assert.deepEqual(selected.retiredIds, [f.b]);
  assert.deepEqual(selected.selection.displacedIds, []);
});

test('a pinned floor stop returns the original request and cannot install partial retirements', () => {
  const f = fixture(), { payload, messages, history } = f.prepare();
  const plan = prepareWorkingSetView(payload, messages, history, model, { ...limits, maxRequestBytes: 1 }, []);
  const result = plan.select({ lowTokens: 8000, highTokens: 9000, restoreHeadroomTokens: 0 }, 'rebalance', { kind: 'jev', priorities: { [f.a]: { level: 0, score: 0 }, [f.b]: { level: 0, score: 0 } } });
  assert.equal(result.selection.outcome, 'capacity-stop');
  assert.deepEqual(result.payload, payload);
  assert.deepEqual(result.retiredIds, []);
});

test('restore-only preflight rejects whole archives that cannot fit without evicting residents', () => {
  const f = fixture();
  commitSelection(f.manager, [f.b], 'working-set-v1');
  const { plan } = f.prepare([f.b]);
  const lowTokens = plan.before.totalTokens + 1;
  assert.deepEqual(plan.restorableIds({ lowTokens, highTokens: lowTokens + 100, restoreHeadroomTokens: 0 }), []);
  assert.deepEqual(plan.restorableIds({ lowTokens: 8000, highTokens: 9000, restoreHeadroomTokens: 0 }), [f.b]);
});

test('local planning checks its cancellation/deadline guard between trial measurements', () => {
  const f = fixture(), { payload, messages, history } = f.prepare();
  let checks = 0;
  const plan = prepareWorkingSetView(payload, messages, history, model, limits, [], undefined, () => {
    if (++checks === 9) throw new Error('local deadline');
  });
  assert.throws(() => plan.select({ lowTokens: 1500, highTokens: 2000, restoreHeadroomTokens: 0 }, 'rebalance', { kind: 'jev', priorities: {
    [f.a]: { level: 2, score: 2 }, [f.b]: { level: 1, score: 1 },
  } }), /local deadline/);
  assert.equal(checks, 9);
  assert.equal(f.manager.getBranch().some((entry) => entry.type === 'context_edit'), false);
});

test('interrupted-call placeholders stay in the floor without becoming stored evidence', () => {
  for (const api of ['openai-completions', 'openai-codex-responses'] as const) {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ ...assistant([
      { type: 'toolCall', id: 'done', name: 'read', arguments: {} },
      { type: 'toolCall', id: 'pending', name: 'read', arguments: {} },
    ]), api, provider: model.provider, model: model.id });
    manager.appendMessage(result('done', 'Completed result'));
    const messages = manager.buildSessionProjection().messages;
    const history = readHistory(manager.getBranch(), messages);
    const codex = api === 'openai-codex-responses';
    const output = (id: string, text: string) => codex
      ? { type: 'function_call_output', call_id: id, output: text }
      : { role: 'tool', tool_call_id: id, content: text };
    const items = [output('done', 'Completed result'), output('pending', 'No result provided')];
    const payload = (entries: typeof items) => codex
      ? { store: false, instructions: '', input: entries }
      : { max_tokens: 100, messages: entries };
    const prepare = (entries: typeof items) => prepareWorkingSetView(payload(entries), messages, history,
      { ...model, api }, { ...limits, outputReserveTokens: 100 }, []);
    const view = prepare(items);
    assert.equal(view.candidates.length, 0);
    assert.deepEqual(view.floor, view.before);
    assert.deepEqual(view.select({ lowTokens: 1000, highTokens: 2000, restoreHeadroomTokens: 0 }, 'rebalance', { kind: 'capture-order' }).payload, payload(items));
    assert.equal(history.evidence.length, 1);
    for (const invalid of [items.slice(0, 1), [...items, items[1]!], [items[0]!, output('pending', 'changed')]]) {
      assert.throws(() => prepare(invalid), /Invalid provider placeholder/);
    }
    assert.throws(() => prepare([...items, output('foreign', 'No result provided')]), /unaccounted/);
  }
});

test('foreign, changed, duplicate outputs and invalid shortlists fail rather than becoming invisible capacity', () => {
  const f = fixture(), { payload, messages, history } = f.prepare();
  for (const id of [f.latest, 'foreign']) {
    assert.throws(() => prepareWorkingSetView(payload, messages, history, model, limits, [id]), /Invalid working-set archive/);
  }
  const foreign = structuredClone(payload);
  foreign.messages.push({ role: 'tool', tool_call_id: 'foreign', content: 'unaccounted' });
  assert.throws(() => prepareWorkingSetView(foreign, messages, history, model, limits, []), /unaccounted/);
  const changed = structuredClone(payload);
  changed.messages.find((item) => item.tool_call_id === 'a')!.content = 'different';
  assert.throws(() => prepareWorkingSetView(changed, messages, history, model, limits, []), /differs/);
  const duplicate = structuredClone(payload);
  duplicate.messages.push(duplicate.messages.find((item) => item.tool_call_id === 'a')!);
  assert.throws(() => prepareWorkingSetView(duplicate, messages, history, model, limits, []), /unique/);
});
