import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { commitSelection, readHistory } from '../src/history.ts';
import { exploreArchive } from '../src/retrieval.ts';
import { appendExchange, result } from './history-fixture.ts';

function fixture(texts: string[], query: string) {
  const manager = SessionManager.inMemory();
  const ids = texts.map((text, index) => appendExchange(manager, [result(`item-${index}`, text)])[0]!);
  appendExchange(manager, [result('latest', 'Current observation')]);
  manager.appendMessage({ role: 'user', content: query, timestamp: 4 });
  commitSelection(manager, ids, 'scripted-v1');
  return { manager, ids, lookup(limit = 2) {
    const messages = manager.buildSessionContext().messages;
    const history = readHistory(manager.getBranch(), messages);
    return exploreArchive(history, query, limit);
  } };
}

test('lookup ranks whole archived observations, including buried words, without mutating history', () => {
  const f = fixture(['Palette colors', 'padding '.repeat(500) + 'refundPolicy requires receipt\n' + 'padding '.repeat(500), 'Refund policy explanation'], 'Implement refund_policy');
  const before = structuredClone(f.manager.getBranch());
  const lookup = f.lookup(1);
  assert.equal(lookup.version, 'capture-page-overlap-v1');
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
  const selected = exploreArchive(history, 'refund_policy', 1);
  assert.equal(selected.candidates[0]!.evidence.id, f.ids[0]);
  assert.deepEqual(selected.candidates[0]!.matchedTerms, ['policy', 'refund']);
});

test('retrieval uses the supplied sketch query, not superseded user history', () => {
  const f = fixture(['invoice requirements', 'sandbox setup'], 'Finish invoice changes');
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const lookup = exploreArchive(history, 'Fix sandbox setup', 4);
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
  const lookup = exploreArchive(history, query, 3);
  assert.equal(lookup.poolSize, 1);
  assert.equal(lookup.matchedCount, 0);
  assert.deepEqual(lookup.candidates, []);
});

test('bounded exploration pages through matches across query changes and wraps on the next decision', () => {
  const f = fixture(['invoice policy', 'invoice policy', 'invoice', 'unrelated', 'invoice'], 'invoice policy');
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const first = exploreArchive(history, 'invoice policy', 2);
  const second = exploreArchive(history, 'INVOICE new correction', 2, first.nextCursor);
  const wrapped = exploreArchive(history, 'invoice policy', 2, second.nextCursor);
  assert.deepEqual([...first.candidates, ...second.candidates].map((item) => item.evidence.id),
    [f.ids[0], f.ids[1], f.ids[2], f.ids[4]]);
  assert.equal(wrapped.wrapped, true);
  assert.deepEqual(wrapped.candidates, first.candidates);
  assert.deepEqual(wrapped.pageIds, first.pageIds);
  assert.deepEqual(exploreArchive(history, 'unrelated', 2, second.nextCursor).pageIds, [f.ids[3]]);
});

test('restoring the frontier preserves progress and a missing off-branch frontier resets with a recorded reason', () => {
  const f = fixture(['invoice first', 'invoice second', 'invoice third'], 'invoice');
  const history = () => readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const first = exploreArchive(history(), 'invoice', 2);
  commitSelection(f.manager, [f.ids[0]!, f.ids[2]!], 'scripted-v1');
  const changed = exploreArchive(history(), 'invoice', 2, first.nextCursor);
  assert.equal(changed.resetReason, null);
  assert.deepEqual(changed.pageIds, [f.ids[2]]);
  const reset = exploreArchive(history(), 'invoice', 2, { version: 1, afterId: 'off-branch' });
  assert.equal(reset.resetReason, 'missing-frontier');
  assert.deepEqual(reset.pageIds, [f.ids[0], f.ids[2]]);
  assert.throws(() => exploreArchive(history(), 'invoice', 2, { version: 1, afterId: '' }), /Invalid archive/);
});

test('lexical order is local to a page and the frontier is capture order, not rank order', () => {
  const f = fixture(['invoice', 'invoice policy', 'invoice policy final'], 'invoice policy');
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const first = exploreArchive(history, 'invoice policy', 2);
  assert.deepEqual(first.pageIds, f.ids.slice(0, 2));
  assert.deepEqual(first.candidates.map((item) => item.evidence.id), [f.ids[1], f.ids[0]]);
  assert.equal(first.nextCursor.afterId, f.ids[1]);
  assert.deepEqual(exploreArchive(history, 'invoice policy', 2, first.nextCursor).pageIds, [f.ids[2]]);
});

test('empty exploration preserves a valid frontier without reporting a wrap', () => {
  const f = fixture(['invoice', 'invoice'], 'invoice');
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  const cursor = { version: 1 as const, afterId: f.ids[0]! };
  const empty = exploreArchive(history, 'unmatched', 2, cursor);
  assert.equal(empty.wrapped, false);
  assert.deepEqual(empty.nextCursor, cursor);
  assert.equal(exploreArchive(history, 'unmatched', 2).nextCursor.afterId, null);
  const missing = exploreArchive(history, 'unmatched', 2, { version: 1, afterId: 'missing' });
  assert.equal(missing.nextCursor.afterId, null);
  assert.equal(missing.resetReason, 'missing-frontier');
});

test('invalid bounds and invalid archived selections fail explicitly', () => {
  const f = fixture(['invoice'], 'invoice');
  for (const limit of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => f.lookup(limit), /positive safe integer/);
  const messages = f.manager.buildSessionContext().messages;
  const history = readHistory(f.manager.getBranch(), messages);
  history.retiredIds = [history.evidence.at(-1)!.id];
  assert.throws(() => exploreArchive(history, 'invoice', 2), /protected evidence/);
  history.retiredIds = ['missing'];
  assert.throws(() => exploreArchive(history, 'invoice', 2), /Unknown evidence/);
  history.retiredIds = [];
  assert.deepEqual(exploreArchive(history, 'invoice', 2).candidates, []);
});
