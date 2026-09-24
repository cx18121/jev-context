import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { commitSelection, readHistory } from '../src/history.ts';
import { retrieveArchive } from '../src/retrieval.ts';
import { appendExchange, result } from './history-fixture.ts';
import { briefQueryText } from '../src/task-brief.ts';
import { taskBrief } from './brief-fixture.ts';

function fixture(texts: string[], query: string) {
  const manager = SessionManager.inMemory();
  const ids = texts.map((text, index) => appendExchange(manager, [result(`item-${index}`, text)])[0]!);
  appendExchange(manager, [result('latest', 'Current observation')]);
  manager.appendMessage({ role: 'user', content: query, timestamp: 4 });
  commitSelection(manager, ids, 'scripted-v1');
  return { manager, ids, lookup(limit = 2) {
    const messages = manager.buildSessionContext().messages;
    const history = readHistory(manager.getBranch(), messages);
    return retrieveArchive(history, query, limit);
  } };
}

test('lookup ranks whole archived observations, including buried words, without mutating history', () => {
  const f = fixture(['Palette colors', 'padding '.repeat(500) + 'refundPolicy requires receipt\n' + 'padding '.repeat(500), 'Refund policy explanation'], 'Implement refund_policy');
  const before = structuredClone(f.manager.getBranch());
  const lookup = f.lookup(1);
  assert.equal(lookup.version, 'token-overlap-v1');
  assert.equal(lookup.poolSize, 3);
  assert.equal(lookup.candidates.length, 1);
  assert.equal(lookup.candidates[0]!.evidence.id, f.ids[1]);
  assert.ok(lookup.candidates[0]!.matchedTerms.includes('refund'));
  assert.ok(lookup.candidates[0]!.matchedTerms.includes('policy'));
  assert.deepEqual(f.manager.getBranch(), before);
  assert.deepEqual(f.lookup(1), lookup);
});

test('repeated terms do not improve rank, and ties preserve capture order', () => {
  const f = fixture(['invoice', 'invoice '.repeat(1000)], 'invoice');
  const lookup = f.lookup(2);
  assert.equal(lookup.candidates[0]!.score, lookup.candidates[1]!.score);
  assert.deepEqual(lookup.candidates.map((item) => item.evidence.id), f.ids);
});

test('tool argument values can retrieve evidence without a body match', () => {
  const f = fixture(['Opaque value: 42', 'Unrelated value'], 'refund_policy');
  const messages = f.manager.buildSessionContext().messages;
  const history = readHistory(f.manager.getBranch(), messages);
  history.evidence[0]!.call.arguments = { path: 'src/RefundPolicy.ts' };
  const selected = retrieveArchive(history, 'refund_policy', 1);
  assert.equal(selected.candidates[0]!.evidence.id, f.ids[0]);
  assert.deepEqual(selected.candidates[0]!.matchedTerms, ['policy', 'refund']);
});

test('retrieval uses the supplied current brief, not superseded user history', () => {
  const f = fixture(['invoice requirements', 'sandbox setup'], 'Finish invoice changes');
  const brief = taskBrief('Fix sandbox setup');
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const lookup = retrieveArchive(history, briefQueryText(brief), 4);
  assert.ok(!lookup.queryTerms.includes('invoice'));
  assert.deepEqual(lookup.candidates.map((item) => item.evidence.id), [f.ids[1]]);
});

test('visible, restored and off-branch evidence cannot enter the archived pool', () => {
  const f = fixture(['invoice archive', 'invoice restored'], 'invoice');
  commitSelection(f.manager, [f.ids[0]!], 'scripted-v1');
  assert.deepEqual(f.lookup().candidates.map((item) => item.evidence.id), [f.ids[0]]);
  const activeLeaf = f.manager.getLeafId()!;
  const [offBranch] = appendExchange(f.manager, [result('other-branch', 'invoice secret')]);
  appendExchange(f.manager, [result('other-latest', 'other')]);
  commitSelection(f.manager, [f.ids[0]!, offBranch!], 'scripted-v1');
  f.manager.branch(activeLeaf);
  assert.equal(f.lookup().poolSize, 1);
  assert.deepEqual(f.lookup().candidates.map((item) => item.evidence.id), [f.ids[0]]);
});

test('no lexical matches produce an empty shortlist rather than arbitrary padding', () => {
  const f = fixture(['grace interval'], 'Extend subscription trial');
  const query = 'Extend subscription trial';
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  // No latest tool target in this controlled query, avoiding its shared .txt extension.
  history.evidence.at(-1)!.call.arguments = {};
  const lookup = retrieveArchive(history, query, 3);
  assert.equal(lookup.poolSize, 1);
  assert.equal(lookup.matchedCount, 0);
  assert.deepEqual(lookup.candidates, []);
});

test('invalid bounds and invalid archived selections fail explicitly', () => {
  const f = fixture(['invoice'], 'invoice');
  for (const limit of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => f.lookup(limit), /positive safe integer/);
  const messages = f.manager.buildSessionContext().messages;
  const history = readHistory(f.manager.getBranch(), messages);
  history.retiredIds = [history.evidence.at(-1)!.id];
  assert.throws(() => retrieveArchive(history, 'invoice', 2), /protected evidence/);
  history.retiredIds = ['missing'];
  assert.throws(() => retrieveArchive(history, 'invoice', 2), /Unknown evidence/);
  history.retiredIds = [];
  assert.deepEqual(retrieveArchive(history, 'invoice', 2).candidates, []);
});
