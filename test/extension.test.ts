import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createWorkingContextExtension, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/working-extension.ts';
import { SELECTION_ENTRY, readHistory } from '../src/history.ts';
import { appendExchange, assistant, result, seedHistory } from './history-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';
import { captureOptions } from './working-fixture.ts';

function toolMessage(request: FixtureRequest, callId: string) {
  const result = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === callId);
  assert.ok(result, `Missing tool result for ${callId}`);
  return result;
}
function records(manager: SessionManager, type: string) {
  return manager.getBranch().filter((entry) => entry.type === 'custom').filter((entry) => entry.customType === type);
}
function pressureSeed(manager: SessionManager) {
  manager.appendMessage({ role: 'user', content: 'Inspect the API contracts.', timestamp: 1 });
  const [oldId] = appendExchange(manager, [result('old', 'API contract\n'.repeat(2500))]);
  appendExchange(manager, [result('recent', 'Test environment ready.')]);
  manager.appendMessage(assistant());
  return oldId!;
}
function pressureOptions(model: Parameters<typeof captureOptions>[0]) {
  return { ...captureOptions(model), target: { lowTokens: 4000, highTokens: 6000 } };
}

test('automatic working-set edits preserve disk originals and unchanged wire prefixes', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const oldId = pressureSeed(manager);
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    const file = manager.getSessionFile()!;
    const originalLines = (await readFile(file, 'utf8')).trim().split('\n');
    const { session, errors } = await fixture.session((manager) => [createWorkingContextExtension(manager, pressureOptions(fixture.model))], manager);
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
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
    const checkpoint = records(manager, SELECTION_ENTRY)[0]!;
    assert.ok(!('retiredIds' in (checkpoint.data as object)));
    const nativeResult = manager.buildSessionProjection().messages.find((message) => message.role === 'toolResult' && message.toolCallId === 'old');
    assert.ok(nativeResult?.role === 'toolResult');
    assert.equal(nativeResult.content[0]?.type === 'text' && nativeResult.content[0].text, toolMessage(fixture.requests[1]!, 'old').content);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [oldId]);
    const usage = records(manager, USAGE_ENTRY);
    assert.equal(usage.length, 2);
    const data = usage[0]!.data as UsageRecord;
    assert.equal(data.usage.cacheRead, 20);
    assert.equal(data.usage.output, 4);
    assert.equal(data.usageSource, 'pi-normalized');
    assert.equal(data.usageAvailable, true);
    assert.equal(data.capacity?.admitted, true);
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('resume, tree navigation and fork keep working-set edits branch-owned', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    pressureSeed(manager);
    const forkPoint = manager.getLeafId()!;
    const first = await fixture.session((manager) => [createWorkingContextExtension(manager, pressureOptions(fixture.model))], manager);
    await first.session.prompt('Retire old evidence.');
    const hiddenLeaf = manager.getLeafId()!;
    first.session.dispose();
    const opened = SessionManager.open(manager.getSessionFile()!);
    const resumed = await fixture.session((manager) => [createWorkingContextExtension(manager, pressureOptions(fixture.model))], opened);
    await resumed.session.prompt('Resume.');
    assert.match(String(toolMessage(fixture.requests.at(-1)!, 'old').content), /retired observation/);
    assert.equal(opened.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);

    await resumed.session.navigateTree(forkPoint, { summarize: false });
    assert.deepEqual(readHistory(opened.getBranch(), opened.buildSessionProjection().messages).retiredIds, []);
    assert.equal(records(opened, SELECTION_ENTRY).length, 0);
    assert.equal(opened.buildSessionProjection().messages.filter((m) => m.role === 'toolResult')[0]!.content[0]!.type, 'text');

    const forkFile = opened.createBranchedSession(hiddenLeaf);
    assert.ok(forkFile);
    const fork = await fixture.session((manager) => [createWorkingContextExtension(manager, pressureOptions(fixture.model))], SessionManager.open(forkFile));
    await fork.session.prompt('Continue the fork.');
    assert.match(String(toolMessage(fixture.requests.at(-1)!, 'old').content), /retired observation/);
    assert.equal(fork.manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
    assert.deepEqual([...first.errors, ...resumed.errors, ...fork.errors], []);
  } finally { await fixture.close(); }
});

test('a factory cannot write through a different SDK manager', async () => {
  const fixture = await createPiFixture();
  try {
    const wrong = SessionManager.inMemory();
    seedHistory(wrong);
    const before = structuredClone(wrong.getBranch());
    const run = await fixture.session(() => [createWorkingContextExtension(wrong, captureOptions(fixture.model))]);
    await run.session.prompt('Do not write into another session.');
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(wrong.getBranch(), before);
    assert.equal(records(run.manager, SELECTION_ENTRY).length, 0);
    assert.deepEqual(run.errors, []);
  } finally { await fixture.close(); }
});

test('native edit or checkpoint persistence failure stops dispatch and suppresses further factory writes', async () => {
  const fixture = await createPiFixture();
  try {
    for (const failCheckpoint of [false, true]) {
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      pressureSeed(manager);
      const persist = manager._persist.bind(manager);
      let failed = false;
      const factoryWritesAfterFailure: string[] = [];
      manager._persist = (entry) => {
        if (failed && (entry.type === 'custom' || entry.type === 'context_edit')) factoryWritesAfterFailure.push(entry.type);
        if (!failed && (failCheckpoint ? entry.type === 'custom' && entry.customType === SELECTION_ENTRY : entry.type === 'context_edit')) {
          failed = true;
          throw new Error('Injected session write failure');
        }
        persist(entry);
      };
      const run = await fixture.session((manager) => [createWorkingContextExtension(manager, pressureOptions(fixture.model))], manager);
      await run.session.prompt('Retire then fail persistence.');
      assert.equal(failed, true);
      await run.session.prompt('Poisoned writer must not retry.');
      assert.equal(fixture.requests.length, 0);
      assert.deepEqual(factoryWritesAfterFailure, []);
      assert.deepEqual(run.errors, []);
      const reopened = SessionManager.open(manager.getSessionFile()!);
      assert.throws(() => readHistory(reopened.getBranch(), reopened.buildSessionProjection().messages), /complete ordered branch|Incomplete native selection edit group/);
    }
  } finally { await fixture.close(); }
});

test('real Pi tool-loop results are persisted before selection and the newest exchange stays visible', async () => {
  const fixture = await createPiFixture();
  try {
    await writeFile(join(fixture.directory, 'a.txt'), 'First observation.');
    await writeFile(join(fixture.directory, 'b.txt'), 'Second observation.');
    fixture.respondWithTools([
      { id: 'read_a', name: 'read', arguments: { path: 'a.txt' } },
      { id: 'read_b', name: 'read', arguments: { path: 'b.txt' } },
    ]);
    const observed: string[][] = [];
    const { session, manager, errors } = await fixture.session((manager) => [
      (pi) => { pi.on('context', (event) => {
        const history = readHistory(manager.getBranch(), event.messages);
        observed.push(history.evidence.map((item) => `${item.result.toolCallId}:${item.protectedReason}`));
      }); },
      createWorkingContextExtension(manager, captureOptions(fixture.model)),
    ], undefined, ['read']);
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

test('inadmissible floor sends no HTTP request and commits no edits', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const options = captureOptions(fixture.model);
    options.capacity.contextLimit = 1024;
    options.target = { lowTokens: 512, highTokens: 768 };
    const { session, errors } = await fixture.session((manager) => [createWorkingContextExtension(manager, options)], manager);
    await session.prompt('Protected request cannot fit.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 0);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
    assert.equal((records(manager, STOP_ENTRY)[0]!.data as { kind: string }).kind, 'capacity-stop');
    const data = records(manager, USAGE_ENTRY)[0]!.data as UsageRecord;
    assert.equal(data.managerStopped, true);
    assert.equal(data.usageAvailable, false);
    assert.equal(data.responseReceived, false);
    assert.equal(data.capacity?.admitted, false);
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
    const { session, manager, errors } = await fixture.session((manager) => [
      createWorkingContextExtension(manager, captureOptions(fixture.model)),
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
    for (const entry of records(manager, STOP_ENTRY)) assert.equal((entry.data as { kind: string }).kind, 'cancelled');
    assert.deepEqual(errors, []);
  } finally { await fixture.close(); }
});

test('aborted assistant tool-call fragments are left to Pi normalization on resume', async () => {
  const fixture = await createPiFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seedHistory(manager);
    const partial = { ...assistant([{ type: 'toolCall' as const, id: 'partial', name: 'read', arguments: {} }]), stopReason: 'aborted' as const };
    const partialId = manager.appendMessage(partial);
    const { session, errors } = await fixture.session((manager) => [createWorkingContextExtension(manager, captureOptions(fixture.model))], manager);
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
