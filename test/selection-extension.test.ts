import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { createContextExtension, JUDGE_RESULT_ENTRY, JUDGE_START_ENTRY, STOP_ENTRY } from '../src/extension.ts';
import { SELECTION_ENTRY, type SelectionRecord } from '../src/history.ts';
import { appendExchange, assistant, result } from './history-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';

const roomy = { contextLimit: 32768, marginTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8 };
function data<T>(manager: SessionManager, kind: string): T[] {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === kind ? [entry.data as T] : []);
}
function seed(manager: SessionManager, repeat = 100) {
  manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
  const [a] = appendExchange(manager, [result('a', 'Important API contract.\n'.repeat(repeat))]);
  const [b] = appendExchange(manager, [result('b', 'Obsolete environment output.\n'.repeat(120))]);
  appendExchange(manager, [result('latest', 'Environment ready.')]);
  manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: manager.getLeafId(), retiredIds: [a] });
  return { a: a!, b: b! };
}
function tool(request: FixtureRequest, id: string) {
  const message = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(message);
  return String(message.content);
}

test('new user work restores original history before pressure, persists pure restores, and preserves the next prefix', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const ids = seed(manager);
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    judge.respond((request) => {
      const body = jevResponse(request);
      body.answers[ids.a]!.noul = 0.8;
      return { body };
    });
    const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
    const events: string[] = [];
    run.session.subscribe((event) => events.push(event.type));
    await run.session.prompt('Return to the API contract.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 1);
    const selected = fixture.requests[0]!;
    assert.match(tool(selected, 'a'), /restored historical observation/);
    assert.ok(tool(selected, 'a').endsWith('Important API contract.\n'.repeat(100)));
    assert.equal(tool(selected, 'latest'), 'Environment ready.');
    assert.deepEqual(data<SelectionRecord>(manager, SELECTION_ENTRY).at(-1)!.retiredIds, []);
    const start = data<{ reconsideration: { restoredIds?: string[] } }>(manager, JUDGE_START_ENTRY)[0]!;
    assert.equal(start.reconsideration.restoredIds, undefined);
    assert.deepEqual(data(SessionManager.open(manager.getSessionFile()!), JUDGE_START_ENTRY), data(manager, JUDGE_START_ENTRY));
    assert.ok(!events.includes('tool_execution_start'));
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    assert.ok(!JSON.stringify(manager.getBranch()).includes(judge.config.apiKey));
    run.session.dispose();
    const resumed = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], SessionManager.open(manager.getSessionFile()!));
    await resumed.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1); // No archived evidence remains.
    assert.deepEqual(fixture.requests[1]!.messages.slice(0, selected.messages.length), selected.messages);
    assert.deepEqual([...run.errors, ...resumed.errors], []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a no-op checkpoint suppresses duplicate judging on an extracted resume without a fresh event', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const ids = seed(manager);
    const factory = () => createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection });
    const run = await fixture.session([factory()], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(data<SelectionRecord>(manager, SELECTION_ENTRY).at(-1)!.retiredIds, [ids.a]);
    const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
    run.session.dispose();
    const forkFile = manager.createBranchedSession(checkpoint.id)!;
    const resumed = await fixture.session([factory()], SessionManager.open(forkFile));
    await resumed.session.agent.continue();
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 2);
    assert.deepEqual(fixture.requests[1]!.messages, fixture.requests[0]!.messages);
    assert.equal(data(resumed.manager, SELECTION_ENTRY).length, 2);
    await resumed.session.prompt('New user correction.');
    assert.equal(judge.requests.length, 2);
    assert.equal(data(resumed.manager, SELECTION_ENTRY).length, 3);
    assert.deepEqual([...run.errors, ...resumed.errors], []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a completed real tool exchange creates another restoration opportunity while the newest results stay protected', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    await writeFile(join(fixture.directory, 'fresh.txt'), 'Current API state after edits.');
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const ids = seed(manager);
    judge.respond((request) => {
      const body = jevResponse(request);
      body.answers[ids.a]!.noul = judge.requests.length === 1 ? 0.1 : 0.9;
      return { body };
    });
    fixture.respondWithTools([{ id: 'fresh', name: 'read', arguments: { path: 'fresh.txt' } }]);
    const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager, ['read']);
    await run.session.prompt('Read fresh.txt, then finish the API change.');
    assert.equal(judge.requests.length, 2);
    assert.equal(fixture.requests.length, 2);
    assert.match(tool(fixture.requests[0]!, 'a'), /retired observation/);
    assert.match(tool(fixture.requests[1]!, 'a'), /restored historical observation/);
    assert.equal(tool(fixture.requests[1]!, 'fresh'), 'Current API state after edits.');
    const freshEntry = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'fresh')!;
    assert.ok(!Object.keys(judge.requests[1]!.questions).includes(freshEntry.id));
    const starts = data<{ reconsideration: { events: { exchangeIds: string[] } } }>(manager, JUDGE_START_ENTRY);
    assert.deepEqual(starts[1]!.reconsideration.events.exchangeIds, [freshEntry.id]);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a same-size swap is committed, while a selected restoration that cannot fit stops without changing the recorded view', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const controlManager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(controlManager);
    const control = await fixture.session([createContextExtension({ policy: 'scripted-v1', budget: roomy })], controlManager);
    await control.session.prompt('Continue.');
    const measured = measureRequest(fixture.requests[0]!, fixture.model, roomy);
    const budget = { ...roomy, contextLimit: measured.inputEstimate + measured.outputReserve + measured.marginTokens };
    for (const canRetire of [true, false]) {
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      const ids = seed(manager);
      judge.respond((request) => {
        const body = jevResponse(request);
        body.answers[ids.a]!.noul = 0.9;
        body.answers[ids.b]!.noul = canRetire ? 0.1 : judge.config.retireBelow;
        return { body };
      });
      const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget, jev: judge.config, selection })], manager);
      await run.session.prompt('Continue.');
      const records = data<SelectionRecord>(manager, SELECTION_ENTRY);
      if (canRetire) {
        assert.equal(records.length, 2);
        assert.deepEqual(records[1]!.retiredIds, [ids.b]);
        assert.match(tool(fixture.requests.at(-1)!, 'a'), /restored historical observation/);
        assert.match(tool(fixture.requests.at(-1)!, 'b'), /retired observation/);
        assert.equal(measureRequest(fixture.requests.at(-1)!, fixture.model, budget).fits, true);
      } else {
        assert.equal(records.length, 1);
        assert.deepEqual(records[0]!.retiredIds, [ids.a]);
        const stopped = data<{ kind: string; budget: { fits: boolean }; reconsideration: { restoredIds: string[]; proposedRetiredIds: string[] } }>(manager, STOP_ENTRY)[0]!;
        assert.equal(stopped.kind, 'budget');
        assert.equal(stopped.budget.fits, false);
        assert.deepEqual(stopped.reconsideration.restoredIds, [ids.a]);
        assert.deepEqual(stopped.reconsideration.proposedRetiredIds, []);
        assert.equal(data(manager, JUDGE_RESULT_ENTRY).length, 1);
      }
      assert.deepEqual(run.errors, []);
    }
    assert.equal(fixture.requests.length, 2); // Control and successful swap only.
    assert.equal(judge.requests.length, 2);
  } finally { await judge.close(); await fixture.close(); }
});

test('oversized archived evidence and failed judges explicitly stop fitting requests without a checkpoint', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    for (const oversized of [true, false]) {
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      seed(manager, oversized ? 2000 : 100);
      judge.respond(() => ({ status: 529, body: { error: 'Unavailable' } }));
      const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
      await run.session.prompt('Continue.');
      assert.equal(data(manager, SELECTION_ENTRY).length, 1);
      assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'judge');
      assert.equal(data(manager, JUDGE_START_ENTRY).length, oversized ? 0 : 1);
      assert.deepEqual(run.errors, []);
    }
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 0);
  } finally { await judge.close(); await fixture.close(); }
});

test('a zero-match event is checkpointed without a judge call or silent archive padding', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    manager.appendMessage({ role: 'user', content: 'Subscription trial', timestamp: 1 });
    manager.appendMessage(assistant([{ type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'billing' } }]));
    const old = manager.appendMessage(result('old', 'Grace interval'));
    manager.appendMessage(assistant([{ type: 'toolCall', id: 'new', name: 'read', arguments: { path: 'workspace' } }]));
    manager.appendMessage(result('new', 'Ready'));
    manager.appendCustomEntry(SELECTION_ENTRY, { version: 1, policy: 'scripted-v1', sourceLeafId: manager.getLeafId(), retiredIds: [old] });
    const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 0);
    assert.equal(fixture.requests.length, 1);
    const records = data<SelectionRecord & { reconsideration: { retrieval: { matchedCount: number; candidateIds: string[] } } }>(manager, SELECTION_ENTRY);
    assert.equal(records.length, 2);
    assert.deepEqual(records[1]!.retiredIds, [old]);
    assert.equal(records[1]!.reconsideration.retrieval.matchedCount, 0);
    assert.deepEqual(records[1]!.reconsideration.retrieval.candidateIds, []);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('cancellation and late results after a branch switch cannot partially restore or checkpoint', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    for (const moveBranch of [false, true]) {
      const release = Promise.withResolvers<void>();
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      const ids = seed(manager);
      const previous = manager.getLeafId()!;
      const entered = Promise.withResolvers<void>();
      judge.respond(async (request) => { entered.resolve(); await release.promise; return { body: jevResponse(request, 0.9) }; });
      const run = await fixture.session([createContextExtension({ policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
      const pending = run.session.prompt('Return to the API.');
      await entered.promise;
      if (moveBranch) {
        manager.branch(previous);
        release.resolve(); // A successful late HTTP response must not write onto this branch.
      } else {
        await run.session.abort();
        release.resolve();
      }
      await pending;
      assert.deepEqual(data<SelectionRecord>(manager, SELECTION_ENTRY).map((item) => item.retiredIds), [[ids.a]]);
      assert.equal(data(manager, JUDGE_START_ENTRY).length, moveBranch ? 0 : 1);
      if (!moveBranch) assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'cancelled');
      assert.deepEqual(run.errors, []);
    }
    assert.equal(fixture.requests.length, 0);
  } finally { await judge.close(); await fixture.close(); }
});
