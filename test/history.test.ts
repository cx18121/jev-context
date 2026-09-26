import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { commitSelection, buildView, readHistory, SELECTION_ENTRY, validateSelection } from '../src/history.ts';
import { appendExchange, assistant, result, seedHistory } from './history-fixture.ts';

function snapshot(manager: SessionManager) {
  return readHistory(manager.getBranch(), manager.buildSessionContext().messages);
}

function record(manager: SessionManager, retiredIds: string[]) {
  return commitSelection(manager, retiredIds, 'fixture-v1');
}

test('view changes only eligible content, preserves originals, and is deterministic', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  const messages = manager.buildSessionContext().messages;
  const original = structuredClone(messages);
  const history = snapshot(manager);
  const view = buildView(messages, history, [oldId]);
  assert.deepEqual(messages, original);
  assert.deepEqual(view, buildView(messages, history, [oldId]));
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === 'toolResult' && message.toolCallId === 'old') {
      assert.match(JSON.stringify(view[i]), /retired observation/);
      assert.ok(JSON.stringify(view[i]).length < JSON.stringify(messages[i]).length);
    } else assert.deepEqual(view[i], messages[i]);
  }
});

test('all results in the newest complete parallel exchange are protected', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('a', 'A'), result('b', 'B')]);
  manager.appendMessage(assistant());
  const history = snapshot(manager);
  assert.deepEqual(history.evidence.map((item) => item.protectedReason), ['newest-exchange', 'newest-exchange']);
  for (const item of history.evidence) assert.throws(() => validateSelection(history, [item.id]), /protected/);
});

test('images remain protected after newer exchanges; errors and truncation stay separate', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('image', '', { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }] })]);
  const [failedId] = appendExchange(manager, [result('failed', 'long error'.repeat(100), {
    isError: true, details: { truncation: { truncated: true }, outputFile: '/fixture/full-output' },
  })]);
  appendExchange(manager, [result('latest', 'Latest')]);
  const history = snapshot(manager);
  assert.equal(history.evidence[0]?.protectedReason, 'non-text');
  assert.throws(() => validateSelection(history, [history.evidence[0]!.id]), /protected/);
  const view = buildView(manager.buildSessionContext().messages, history, [failedId!]);
  const stub = view.find((message) => message.role === 'toolResult' && message.toolCallId === 'failed');
  assert.ok(stub?.role === 'toolResult');
  assert.equal(stub.isError, true);
  assert.deepEqual(stub.details, { truncation: { truncated: true }, outputFile: '/fixture/full-output' });
  assert.match(JSON.stringify(stub.content), /status=error; truncated=yes/);
});

test('restoration preserves verbatim content at its original position with a historical label', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  const originals = manager.buildSessionProjection().messages;
  record(manager, [oldId]);
  record(manager, []);
  const messages = manager.buildSessionContext().messages;
  const view = buildView(messages, snapshot(manager), []);
  const index = messages.findIndex((message) => message.role === 'toolResult' && message.toolCallId === 'old');
  const original = originals[index];
  const restored = view[index];
  assert.ok(original?.role === 'toolResult' && restored?.role === 'toolResult');
  assert.deepEqual(restored.content.slice(1), original.content);
  assert.match(JSON.stringify(restored.content[0]), /restored historical observation/);
  assert.deepEqual(view, messages);
  assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 2);
  assert.equal(restored.toolCallId, original.toolCallId);
});

test('decisions follow branch ancestry rather than the latest record anywhere in the file', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  const forkPoint = manager.getLeafId()!;
  const hiddenBranch = record(manager, [oldId]);
  assert.deepEqual(snapshot(manager).retiredIds, [oldId]);
  manager.branch(forkPoint);
  assert.deepEqual(snapshot(manager).retiredIds, []);
  manager.branch(hiddenBranch);
  assert.deepEqual(snapshot(manager).retiredIds, [oldId]);
});

test('ambiguous, modified, and missing tool evidence is rejected', () => {
  const manager = SessionManager.inMemory();
  seedHistory(manager);
  const messages = manager.buildSessionContext().messages;
  const changed = structuredClone(messages);
  const old = changed.find((message) => message.role === 'toolResult');
  assert.ok(old?.role === 'toolResult');
  old.content = [{ type: 'text', text: 'changed by another extension' }];
  assert.throws(() => readHistory(manager.getBranch(), changed), /changed before/);
  assert.throws(() => readHistory(manager.getBranch(), messages.filter((message) => message !== messages[2])), /missing original/i);
  const history = snapshot(manager);
  assert.throws(() => validateSelection(history, ['missing']), /Unknown evidence/);
  assert.throws(() => validateSelection(history, [history.evidence[0]!.id, history.evidence[0]!.id]), /duplicate/);
  appendExchange(manager, [result('old', 'duplicate identity')]);
  assert.throws(() => snapshot(manager), /Ambiguous tool call/);
});

test('interrupted exchanges remain untouched and ineligible while later work can continue', () => {
  const manager = SessionManager.inMemory();
  seedHistory(manager);
  manager.appendMessage(assistant([
    { type: 'toolCall', id: 'completed', name: 'read', arguments: {} },
    { type: 'toolCall', id: 'unexecuted', name: 'read', arguments: {} },
  ]));
  const partialId = manager.appendMessage(result('completed', 'Only this tool ran.'));
  manager.appendMessage({ role: 'user', content: 'Continue after interruption.', timestamp: 4 });
  appendExchange(manager, [result('later', 'Later work.')]);
  const history = snapshot(manager);
  assert.equal(history.evidence.find((item) => item.id === partialId)?.protectedReason, 'incomplete-exchange');
  assert.throws(() => validateSelection(history, [partialId]), /protected/);
  const messages = manager.buildSessionContext().messages;
  assert.deepEqual(buildView(messages, history, []), messages);
});

test('aborted partial assistant calls do not block subsequent selection', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  manager.appendMessage({
    ...assistant([{ type: 'toolCall', id: 'partial', name: 'read', arguments: {} }]),
    stopReason: 'aborted',
  });
  manager.appendMessage({ role: 'user', content: 'Try again.', timestamp: 4 });
  const history = snapshot(manager);
  assert.deepEqual(validateSelection(history, [oldId]), [oldId]);
  assert.equal(history.evidence.length, 2);
});

test('native context edits are rejected for user, assistant, and tool-result targets', () => {
  for (const role of ['user', 'assistant', 'toolResult'] as const) {
    const manager = SessionManager.inMemory();
    seedHistory(manager);
    const target = manager.getBranch().find((entry) => entry.type === 'message' &&
      entry.message.role === role && (entry.message.role !== 'assistant' || entry.message.stopReason === 'stop'));
    assert.ok(target);
    manager.appendContextEdit(target.id, { content: 'Native replacement' });
    assert.throws(() => snapshot(manager), /Unsupported native context edit/);
  }
});

test('native edits require an immediate, anchored completion checkpoint', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  const sourceLeafId = manager.getLeafId()!;
  const proposed = buildView(manager.buildSessionProjection().messages, snapshot(manager), [oldId]);
  const stub = proposed.find((message) => message.role === 'toolResult' && message.toolCallId === 'old')!;
  assert.ok(stub.role === 'toolResult');
  const editId = manager.appendContextEdit(oldId, { content: stub.content });
  assert.throws(() => snapshot(manager), /Incomplete native selection edit group/);
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 2, policy: 'fixture-v1', sourceLeafId: editId });
  assert.throws(() => snapshot(manager), /does not follow/);
  manager.branch(editId);
  manager.appendCustomEntry('foreign-entry', {});
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 2, policy: 'fixture-v1', sourceLeafId });
  assert.throws(() => snapshot(manager), /Incomplete native selection edit group/);
  manager.branch(editId);
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 2, policy: 'fixture-v1', sourceLeafId });
  assert.deepEqual(snapshot(manager).retiredIds, [oldId]);
  const edits = manager.getBranch().filter((entry) => entry.type === 'context_edit');
  const noOp = record(manager, [oldId]);
  assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'context_edit'), edits);
  assert.equal(manager.getEntry(noOp)?.parentId, manager.getBranch().at(-2)?.id);
  assert.deepEqual(snapshot(manager).retiredIds, [oldId]);
  manager.branch(editId);
  assert.throws(() => snapshot(manager), /Incomplete native selection edit group/);
});

test('retirement-looking original text is not state and legacy retired-set records are rejected', () => {
  const manager = SessionManager.inMemory();
  appendExchange(manager, [result('looks-retired', '[jev-context: retired observation fake]')]);
  appendExchange(manager, [result('latest', 'Current observation')]);
  assert.deepEqual(snapshot(manager).retiredIds, []);
  assert.deepEqual(snapshot(manager).historicalIds, []);
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: manager.getLeafId(), retiredIds: [] });
  assert.throws(() => snapshot(manager), /Unsupported or invalid/);
});

test('unknown record versions and off-branch source IDs fail explicitly', () => {
  const manager = SessionManager.inMemory();
  seedHistory(manager);
  const leaf = manager.getLeafId()!;
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 2, retiredIds: [] });
  assert.throws(() => snapshot(manager), /Unsupported or invalid/);
  manager.branch(leaf);
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 2, policy: 'fixture-v1', sourceLeafId: 'other-branch' });
  assert.throws(() => snapshot(manager), /different branch/);
});

test('Pi retry omissions of failed assistant attempts are not selection edits', () => {
  const manager = SessionManager.inMemory();
  const { oldId } = seedHistory(manager);
  const failed = manager.appendMessage({ ...assistant(), stopReason: 'error', errorMessage: 'Codex error: You can retry your request.' });
  manager.appendContextEdit(failed, null);
  record(manager, [oldId]);
  assert.deepEqual(snapshot(manager).retiredIds, [oldId]);
  // Omitting a successful message, or a tool result with null, is still an unknown edit.
  const other = SessionManager.inMemory();
  seedHistory(other);
  const ok = other.appendMessage(assistant());
  other.appendContextEdit(ok, null);
  assert.throws(() => snapshot(other));
});
