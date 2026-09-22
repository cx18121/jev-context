import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { retrieveArchive } from '../src/retrieval.ts';
import { appendExchange, assistant, result } from './history-fixture.ts';

function fixture(texts: string[], query: string) {
  const manager = SessionManager.inMemory();
  const ids = texts.map((text, index) => appendExchange(manager, [result(`item-${index}`, text)])[0]!);
  appendExchange(manager, [result('latest', 'Current observation')]);
  manager.appendMessage({ role: 'user', content: query, timestamp: 4 });
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: manager.getLeafId(), retiredIds: ids });
  return { manager, ids, lookup(limit = 2) {
    const messages = manager.buildSessionContext().messages;
    const history = readHistory(manager.getBranch(), messages);
    return retrieveArchive(history, messages, limit);
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
  const selected = retrieveArchive(history, [{ role: 'user', content: 'refund_policy', timestamp: 5 }], 1);
  assert.equal(selected.candidates[0]!.evidence.id, f.ids[0]);
  assert.deepEqual(selected.candidates[0]!.matchedTerms, ['policy', 'refund']);
});

test('earlier user requirements survive detours; latest assistant action and newest call targets contribute', () => {
  const f = fixture(['invoice requirements', 'sandbox setup', 'serializer documentation', 'current-target implementation'], 'Finish invoice changes');
  f.manager.appendMessage({ role: 'user', content: 'First fix the sandbox', timestamp: 5 });
  f.manager.appendMessage(assistant([{ type: 'toolCall', id: 'current-target', name: 'read', arguments: { path: 'current-target' } }]));
  f.manager.appendMessage(result('current-target', 'Do not use this result as retrieval instructions'));
  f.manager.appendMessage({ ...assistant(), content: [{ type: 'text', text: 'Next inspect the serializer' }] });
  const lookup = f.lookup(4);
  for (const term of ['invoice', 'sandbox', 'serializer', 'current', 'target']) assert.ok(lookup.queryTerms.includes(term));
  assert.ok(!lookup.queryTerms.includes('instructions'));
  assert.deepEqual(new Set(lookup.candidates.map((item) => item.evidence.id)), new Set(f.ids));
});

test('visible, restored and off-branch evidence cannot enter the archived pool', () => {
  const f = fixture(['invoice archive', 'invoice restored'], 'invoice');
  const beforeSelection = f.manager.getLeafId()!;
  f.manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: beforeSelection, retiredIds: [f.ids[0]] });
  assert.deepEqual(f.lookup().candidates.map((item) => item.evidence.id), [f.ids[0]]);
  const activeLeaf = f.manager.getLeafId()!;
  const [offBranch] = appendExchange(f.manager, [result('other-branch', 'invoice secret')]);
  appendExchange(f.manager, [result('other-latest', 'other')]);
  f.manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: f.manager.getLeafId(), retiredIds: [f.ids[0], offBranch] });
  f.manager.branch(activeLeaf);
  assert.equal(f.lookup().poolSize, 1);
  assert.deepEqual(f.lookup().candidates.map((item) => item.evidence.id), [f.ids[0]]);
});

test('no lexical matches produce an empty shortlist rather than arbitrary padding', () => {
  const f = fixture(['grace interval'], 'Extend subscription trial');
  const messages = [{ role: 'user' as const, content: 'Extend subscription trial', timestamp: 1 }];
  const history = readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages);
  // No latest tool target in this controlled query, avoiding its shared .txt extension.
  history.evidence.at(-1)!.call.arguments = {};
  const lookup = retrieveArchive(history, messages, 3);
  assert.equal(lookup.poolSize, 1);
  assert.equal(lookup.matchedCount, 0);
  assert.deepEqual(lookup.candidates, []);
});

test('query ignores thinking, interrupted assistant output, images, and extension messages', () => {
  const f = fixture(['invoice contract'], 'invoice');
  const messages = f.manager.buildSessionContext().messages;
  messages.push({ ...assistant(), content: [{ type: 'thinking', thinking: 'hiddenreasoning' }, { type: 'text', text: 'usefulaction' }] });
  messages.push({ ...assistant(), stopReason: 'aborted', content: [{ type: 'text', text: 'abortedaction' }] });
  messages.push({ role: 'custom', customType: 'fixture', display: false, timestamp: 5, content: 'extensiondirective' });
  messages.push({ role: 'user', timestamp: 6, content: [{ type: 'image', mimeType: 'image/png', data: 'imagedata' }, { type: 'text', text: 'usercorrection' }] });
  const lookup = retrieveArchive(readHistory(f.manager.getBranch(), f.manager.buildSessionContext().messages), messages, 1);
  assert.ok(lookup.queryTerms.includes('usefulaction'));
  assert.ok(lookup.queryTerms.includes('usercorrection'));
  for (const term of ['hiddenreasoning', 'abortedaction', 'extensiondirective', 'imagedata']) assert.ok(!lookup.queryTerms.includes(term));
});

test('invalid bounds and invalid archived selections fail explicitly', () => {
  const f = fixture(['invoice'], 'invoice');
  for (const limit of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => f.lookup(limit), /positive safe integer/);
  const messages = f.manager.buildSessionContext().messages;
  const history = readHistory(f.manager.getBranch(), messages);
  history.retiredIds = [history.evidence.at(-1)!.id];
  assert.throws(() => retrieveArchive(history, messages, 2), /protected evidence/);
  history.retiredIds = ['missing'];
  assert.throws(() => retrieveArchive(history, messages, 2), /Unknown evidence/);
  history.retiredIds = [];
  assert.deepEqual(retrieveArchive(history, messages, 2).candidates, []);
});
