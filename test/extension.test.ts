import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { SELECTION_ENTRY } from '../src/history.ts';
import { assistant, seedHistory } from './history-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';

const budget = { contextLimit: 32768, marginTokens: 1024 };
function toolMessage(request: FixtureRequest, callId: string) {
  const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === callId);
  assert.ok(result, `Missing tool result for ${callId}`);
  return result;
}
function records(manager: SessionManager, type: string) {
  return manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === type);
}

test('actual Pi requests use selected views while disk originals and unchanged prefixes survive', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    const file = manager.getSessionFile()!;
    const originalLines = (await readFile(file, 'utf8')).trim().split('\n');
    let select = true;
    const { session, errors } = await fixture.session([createContextExtension({
      policy: 'scripted-v1', budget,
      select: () => { if (!select) return null; select = false; return [oldId]; },
    })], manager);
    await session.prompt('Continue.');
    assert.equal(fixture.requests.length, 1);
    assert.match(String(toolMessage(fixture.requests[0]!, 'old').content), /retired observation/);
    assert.equal(toolMessage(fixture.requests[0]!, 'recent').content, 'Test environment ready.');
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    const newLines = (await readFile(file, 'utf8')).trim().split('\n');
    for (const line of originalLines) assert.ok(newLines.includes(line), 'Original JSONL entry changed');
    const firstMessages = structuredClone(fixture.requests[0]!.messages);
    await session.prompt('Continue again.');
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[1]!.messages.slice(0, firstMessages.length), firstMessages);
    assert.equal(records(manager, SELECTION_ENTRY).length, 1);
    const usage = records(manager, USAGE_ENTRY);
    assert.equal(usage.length, 2);
    assert.equal(usage[0]?.type, 'custom');
    if (usage[0]?.type === 'custom') {
      const data = usage[0].data as UsageRecord;
      assert.equal(data.usage.cacheRead, 20);
      assert.equal(data.usage.output, 4);
      assert.equal(data.usageSource, 'pi-normalized');
      assert.equal(data.usageAvailable, true);
      assert.ok(data.budget?.fits);
    }
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('resume, tree navigation, and fork reuse only branch-owned decisions without a selector', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    const forkPoint = manager.getLeafId()!;
    const first = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget, select: () => [oldId] })], manager);
    await first.session.prompt('Retire old evidence.');
    const hiddenLeaf = manager.getLeafId()!;
    first.session.dispose();
    const opened = SessionManager.open(manager.getSessionFile()!);
    const resumed = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget })], opened);
    await resumed.session.prompt('Resume without judging again.');
    assert.match(String(toolMessage(fixture.requests.at(-1)!, 'old').content), /retired observation/);
    assert.equal(records(opened, SELECTION_ENTRY).length, 1);

    await resumed.session.navigateTree(forkPoint, { summarize: false });
    await resumed.session.prompt('Use the other branch.');
    assert.equal(toolMessage(fixture.requests.at(-1)!, 'old').content, 'API contract\n'.repeat(150));
    assert.equal(records(opened, SELECTION_ENTRY).length, 0);

    const forkFile = opened.createBranchedSession(hiddenLeaf);
    assert.ok(forkFile);
    const fork = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget })], SessionManager.open(forkFile));
    await fork.session.prompt('Continue the fork.');
    assert.match(String(toolMessage(fixture.requests.at(-1)!, 'old').content), /retired observation/);
    assert.equal(records(fork.manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual([...first.errors, ...resumed.errors, ...fork.errors], []);
  } finally { await fixture.close(); }
});

test('scripted restoration reintroduces verbatim historical evidence without executing tools', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    let selection = [oldId];
    const { session, errors } = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget, select: () => selection })], manager);
    const events: string[] = [];
    session.subscribe((event) => { events.push(event.type); });
    await session.prompt('Take a detour.');
    selection = [];
    await session.prompt('Return to the API.');
    const restored = String(toolMessage(fixture.requests.at(-1)!, 'old').content);
    assert.match(restored, /restored historical observation/);
    assert.ok(restored.endsWith('API contract\n'.repeat(150)));
    assert.ok(!events.includes('tool_execution_start'));
    assert.equal(records(manager, SELECTION_ENTRY).length, 2);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('real Pi tool-loop results are persisted before selection and the entire newest exchange stays visible', async () => {
  const fixture = await createPiFixture();
  try {
    await writeFile(join(fixture.directory, 'a.txt'), 'First observation.');
    await writeFile(join(fixture.directory, 'b.txt'), 'Second observation.');
    fixture.respondWithTools([
      { id: 'read_a', name: 'read', arguments: { path: 'a.txt' } },
      { id: 'read_b', name: 'read', arguments: { path: 'b.txt' } },
    ]);
    const observed: string[][] = [];
    const { session, manager, errors } = await fixture.session([createContextExtension({
      policy: 'scripted-v1', budget,
      select: (history) => {
        observed.push(history.evidence.map((item) => `${item.result.toolCallId}:${item.protectedReason}`));
        return null;
      },
    })], undefined, ['read']);
    await session.prompt('Read a.txt and b.txt.');
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(observed, [[], ['read_a:newest-exchange', 'read_b:newest-exchange']]);
    assert.equal(toolMessage(fixture.requests[1]!, 'read_a').content, 'First observation.');
    assert.equal(toolMessage(fixture.requests[1]!, 'read_b').content, 'Second observation.');
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult').length, 2);
    assert.equal(records(manager, USAGE_ENTRY).length, 2);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('final-payload budget stop sends no HTTP request and does not commit a proposed selection', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { oldId } = seedHistory(manager);
    const { session, errors } = await fixture.session([createContextExtension({
      policy: 'scripted-v1', budget: { contextLimit: 100, marginTokens: 0 }, select: () => [oldId],
    })], manager);
    await session.prompt('Protected request cannot fit.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 0);
    assert.equal(records(manager, STOP_ENTRY).length, 1);
    const usage = records(manager, USAGE_ENTRY)[0];
    assert.ok(usage?.type === 'custom');
    const data = usage.data as UsageRecord;
    assert.equal(data.managerStopped, true);
    assert.equal(data.usageAvailable, false);
    assert.equal(data.responseReceived, false);
    assert.equal(data.budget?.fits, false);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('a real interrupted tool batch can continue without modifying or synthesizing stored evidence', { timeout: 10_000 }, async () => {
  const fixture = await createPiFixture();
  try {
    fixture.respondWithTools([
      { id: 'slow', name: 'bash', arguments: { command: 'sleep 5' } },
      { id: 'never', name: 'bash', arguments: { command: 'echo second' } },
    ]);
    const { session, manager, errors } = await fixture.session([
      createContextExtension({ policy: 'scripted-v1', budget }),
    ], undefined, ['bash']);
    const started = Promise.withResolvers<void>();
    session.subscribe((event) => {
      if (event.type === 'tool_execution_start' && event.toolCallId === 'slow') started.resolve();
    });
    const run = session.prompt('Run the two commands.');
    await started.promise;
    await session.abort();
    await run;
    const persistedResults = () => manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'toolResult');
    const originals = structuredClone(persistedResults());
    assert.equal(originals.length, 1);
    const before = fixture.requests.length;
    await session.prompt('Continue after the interruption.');
    assert.equal(fixture.requests.length, before + 1);
    assert.equal(toolMessage(fixture.requests.at(-1)!, 'never').content, 'No result provided');
    assert.deepEqual(persistedResults(), originals);
    for (const entry of records(manager, STOP_ENTRY)) {
      assert.ok(entry.type === 'custom');
      assert.equal((entry.data as { kind: string }).kind, 'cancelled');
    }
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('aborted assistant tool-call fragments are left to Pi provider normalization on resume', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const partial = {
      ...assistant([{ type: 'toolCall' as const, id: 'partial', name: 'read', arguments: {} }]),
      stopReason: 'aborted' as const,
    };
    const partialId = manager.appendMessage(partial);
    const { session, errors } = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget })], manager);
    await session.prompt('Continue after a streamed call was interrupted.');
    assert.equal(fixture.requests.length, 1);
    assert.ok(!JSON.stringify(fixture.requests[0]!.messages).includes('partial'));
    const stored = manager.getEntry(partialId);
    assert.ok(stored?.type === 'message');
    assert.deepEqual(stored.message, partial);
    assert.equal(records(manager, STOP_ENTRY).length, 0);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('invalid selection and cancelled judging leave no partial selection', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const { recentId } = seedHistory(manager);
    const invalid = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget, select: () => [recentId] })], manager);
    await invalid.session.prompt('Invalid selection.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 0);
    assert.equal(records(manager, STOP_ENTRY).length, 1);

    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string[]>();
    const cancelled = await fixture.session([createContextExtension({
      policy: 'scripted-v1', budget,
      select: () => { waiting.resolve(); return release.promise; },
    })]);
    const run = cancelled.session.prompt('Cancel during selection.');
    await waiting.promise;
    const abort = cancelled.session.abort();
    release.resolve([]);
    await Promise.all([run, abort]);
    assert.equal(records(cancelled.manager, SELECTION_ENTRY).length, 0);
    const cancellation = records(cancelled.manager, STOP_ENTRY)[0];
    assert.ok(cancellation?.type === 'custom');
    assert.equal((cancellation.data as { kind: string }).kind, 'cancelled');
    const usage = records(cancelled.manager, USAGE_ENTRY)[0];
    assert.ok(usage?.type === 'custom');
    assert.equal((usage.data as UsageRecord).managerStopped, false);
    assert.equal((usage.data as UsageRecord).cancelled, true);
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual([...invalid.errors, ...cancelled.errors], []);
  } finally { await fixture.close(); }
});
