import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, STOP_ENTRY } from '../src/extension.ts';
import { SELECTION_ENTRY, type HistoryView } from '../src/history.ts';
import { seedHistory } from './history-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';

const budget = { contextLimit: 32768, marginTokens: 1024 };

test('native SDK projections replace, restore, resume, and branch without changing raw evidence', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    const forkPoint = manager.getLeafId()!;
    const original = structuredClone(manager.getEntry(oldId));
    assert.ok(original?.type === 'message' && original.message.role === 'toolResult');
    const file = manager.getSessionFile()!;
    const originalLine = (await readFile(file, 'utf8')).split('\n').find((line) => line && JSON.parse(line).id === oldId);
    assert.ok(originalLine);
    const run = await fixture.session((manager) => [], manager);
    manager.appendContextEdit(oldId, { content: 'Native replacement' });
    run.session.refreshContext();
    const projected = manager.buildSessionProjection().entries.find((entry) => entry.sourceEntry.id === oldId);
    assert.deepEqual(projected?.sourceEntry, original);
    assert.deepEqual(projected?.messages[0], { ...original.message, content: [{ type: 'text', text: 'Native replacement' }] });
    await run.session.prompt('Use the native view.');
    const wireText = () => fixture.requests.at(-1)!.messages.find((message) => message.tool_call_id === 'old')?.content;
    assert.equal(wireText(), 'Native replacement');
    const editedLeaf = manager.getLeafId()!;
    run.session.dispose();

    const reopened = SessionManager.open(file);
    const resumed = await fixture.session((manager) => [], reopened);
    await resumed.session.prompt('Resume the native view.');
    assert.equal(wireText(), 'Native replacement');
    reopened.appendContextEdit(oldId, { content: original.message.content });
    resumed.session.refreshContext();
    await resumed.session.prompt('Use restored content.');
    assert.equal(wireText(), 'API contract\n'.repeat(150));
    await resumed.session.navigateTree(editedLeaf, { summarize: false });
    await resumed.session.prompt('Use the edited branch.');
    assert.equal(wireText(), 'Native replacement');
    await resumed.session.navigateTree(forkPoint, { summarize: false });
    await resumed.session.prompt('Use the original branch.');
    assert.equal(wireText(), 'API contract\n'.repeat(150));
    assert.deepEqual(reopened.getEntry(oldId), original);
    assert.ok((await readFile(file, 'utf8')).split('\n').includes(originalLine));
    assert.equal(fixture.requests.length, 5);
    assert.deepEqual([...run.errors, ...resumed.errors], []);
  } finally { await fixture.close(); }
});

test('selection stops explicitly on unsupported native edits without dispatch or committing a selection', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const user = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
    manager.appendContextEdit(user.id, { content: 'Changed user instructions' });
    const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'scripted-v1', budget, select: () => [] })], manager);
    await run.session.prompt('Do not mix projection owners.');
    assert.equal(fixture.requests.length, 0);
    const records = manager.getBranch().filter((entry) => entry.type === 'custom');
    assert.equal(records.filter((entry) => entry.customType === SELECTION_ENTRY).length, 0);
    const stopped = records.find((entry) => entry.customType === STOP_ENTRY);
    assert.match((stopped?.data as { reason: string }).reason, /Unsupported native context edit/);
    assert.deepEqual(run.errors, []);
  } finally { await fixture.close(); }
});

test('system and tool changes stay on the wire without changing evidence protection', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const observed: HistoryView[] = [];
    let prompt = 'First system instructions.';
    const run = await fixture.session((manager) => [
      (pi) => { pi.on('before_agent_start', () => ({ systemPrompt: prompt })); },
      createContextExtension(manager, { policy: 'scripted-v1', budget, select: (history) => { observed.push(history); return null; } }),
    ], manager, ['read', 'bash']);
    await run.session.prompt('Continue.');
    prompt = 'Second system instructions.';
    run.session.setActiveToolsByName(['read']);
    await run.session.prompt('Continue with the read tool.');
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(observed[1], observed[0]);
    assert.match(JSON.stringify(fixture.requests[1]!.messages.filter((message) => message.role === 'system')), /Second system instructions/);
    assert.ok(Array.isArray(fixture.requests[1]!.tools) && fixture.requests[1]!.tools.length === 1);
    assert.ok(manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'system').length >= 2);
    assert.equal(run.settings.getCacheWarmingMode(), 'off');
    assert.ok(!manager.getBranch().some((entry) => entry.type === 'usage' && entry.kind === 'cache_warm'));
    assert.deepEqual(run.errors, []);
  } finally { await fixture.close(); }
});
