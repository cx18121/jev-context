import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { createContextExtension, JUDGE_RESULT_ENTRY, JUDGE_START_ENTRY, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { commitSelection, readHistory, SELECTION_ENTRY, type SelectionRecord } from '../src/history.ts';
import { appendExchange, assistant, result } from './history-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';

const roomy = { contextLimit: 32768, marginTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8 };
function data<T>(manager: SessionManager, kind: string): T[] {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === kind ? [entry.data as T] : []);
}
function seed(manager: SessionManager, repeat = 100, retire = true) {
  manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
  const [a] = appendExchange(manager, [result('a', 'Important API contract.\n'.repeat(repeat))]);
  const [b] = appendExchange(manager, [result('b', 'Obsolete environment output.\n'.repeat(120))]);
  appendExchange(manager, [result('latest', 'Environment ready.')]);
  if (retire) commitSelection(manager, [a!], 'scripted-v1');
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
    const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
    const events: string[] = [];
    run.session.subscribe((event) => events.push(event.type));
    await run.session.prompt('Return to the API contract.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 1);
    const selected = fixture.requests[0]!;
    assert.match(tool(selected, 'a'), /restored historical observation/);
    assert.ok(tool(selected, 'a').endsWith('Important API contract.\n'.repeat(100)));
    assert.equal(tool(selected, 'latest'), 'Environment ready.');
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, []);
    const start = data<{ reconsideration: { restoredIds?: string[] } }>(manager, JUDGE_START_ENTRY)[0]!;
    assert.equal(start.reconsideration.restoredIds, undefined);
    assert.deepEqual(data(SessionManager.open(manager.getSessionFile()!), JUDGE_START_ENTRY), data(manager, JUDGE_START_ENTRY));
    assert.ok(!events.includes('tool_execution_start'));
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    assert.ok(!JSON.stringify(manager.getBranch()).includes(judge.config.apiKey));
    run.session.dispose();
    const resumed = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], SessionManager.open(manager.getSessionFile()!));
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
    const factory = (manager: SessionManager) => createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection });
    const run = await fixture.session((manager) => [factory(manager)], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [ids.a]);
    const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
    run.session.dispose();
    const forkFile = manager.createBranchedSession(checkpoint.id)!;
    const resumed = await fixture.session((manager) => [factory(manager)], SessionManager.open(forkFile));
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
    const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager, ['read']);
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
    const control = await fixture.session((manager) => [createContextExtension(manager, { policy: 'scripted-v1', budget: roomy })], controlManager);
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
      const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget, jev: judge.config, selection })], manager);
      await run.session.prompt('Continue.');
      const records = data<SelectionRecord>(manager, SELECTION_ENTRY);
      if (canRetire) {
        assert.equal(records.length, 2);
        assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [ids.b]);
        assert.match(tool(fixture.requests.at(-1)!, 'a'), /restored historical observation/);
        assert.match(tool(fixture.requests.at(-1)!, 'b'), /retired observation/);
        assert.equal(measureRequest(fixture.requests.at(-1)!, fixture.model, budget).fits, true);
      } else {
        assert.equal(records.length, 1);
        assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [ids.a]);
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

test('oversized archived evidence defers, but unknown judge cost still stops a fitting request', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    for (const oversized of [true, false]) {
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      seed(manager, oversized ? 2000 : 100);
      judge.respond(() => ({ status: 529, body: { error: 'Unavailable' } }));
      const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
      await run.session.prompt('Continue.');
      assert.equal(data(manager, SELECTION_ENTRY).length, oversized ? 2 : 1);
      if (oversized) {
        assert.equal(data(manager, STOP_ENTRY).length, 0);
        assert.match(tool(fixture.requests[0]!, 'a'), /retired observation/);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
      } else assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'judge');
      assert.equal(data(manager, JUDGE_START_ENTRY).length, oversized ? 0 : 1);
      assert.deepEqual(run.errors, []);
    }
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 1);
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
    commitSelection(manager, [old], 'scripted-v1');
    const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 0);
    assert.equal(fixture.requests.length, 1);
    const records = data<SelectionRecord & { reconsideration: { retrieval: { matchedCount: number; candidateIds: string[] } } }>(manager, SELECTION_ENTRY);
    assert.equal(records.length, 2);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [old]);
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
      const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection })], manager);
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
      assert.equal(data(manager, SELECTION_ENTRY).length, 1);
      assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [ids.a]);
      assert.equal(data(manager, JUDGE_START_ENTRY).length, moveBranch ? 0 : 1);
      if (!moveBranch) assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'cancelled');
      assert.deepEqual(run.errors, []);
    }
    assert.equal(fixture.requests.length, 0);
  } finally { await judge.close(); await fixture.close(); }
});


test('soft pressure retires before the hard limit and later restores against the same working target', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    fixture.reportInputTokens(3000);
    const workingContextLimit = 5000;
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const ids = seed(manager, 100, false);
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection: { ...selection, workingContextLimit },
    })], manager);
    await run.session.prompt('Establish usage.');
    assert.equal(judge.requests.length, 0);
    assert.equal(data<UsageRecord>(manager, USAGE_ENTRY)[0]!.workingContext!.fits, null);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 2);
    assert.match(tool(fixture.requests[1]!, 'a'), /retired observation/);
    assert.equal(tool(fixture.requests[1]!, 'b'), tool(fixture.requests[0]!, 'b'));
    assert.equal(tool(fixture.requests[1]!, 'latest'), 'Environment ready.');
    assert.equal(data<UsageRecord>(manager, USAGE_ENTRY)[1]!.workingContext!.fits, true);
    judge.respond((request) => {
      const body = jevResponse(request);
      body.answers[ids.a]!.noul = 0.9;
      return { body };
    });
    await run.session.prompt('Return to the API contract.');
    assert.equal(judge.requests.length, 2);
    assert.match(tool(fixture.requests[2]!, 'a'), /restored historical observation/);
    assert.match(tool(fixture.requests[2]!, 'b'), /retired observation/);
    for (const [i, record] of data<UsageRecord>(manager, USAGE_ENTRY).entries()) {
      assert.deepEqual(record.budget, measureRequest(fixture.requests[i]!, fixture.model, roomy));
      assert.equal(record.budget!.fits, true);
      assert.equal(record.workingContext!.method, 'provider-usage-plus-delta-v1');
      assert.equal(record.workingContext!.configuredLimit, workingContextLimit);
      assert.equal(record.workingContext!.fits, i === 0 ? null : true);
    }
    const checkpoints = data<{ reconsideration: { workingContext: UsageRecord['workingContext'] } }>(manager, SELECTION_ENTRY);
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[1]!.reconsideration.workingContext!.contextLimit, workingContextLimit);
    assert.equal(data(manager, STOP_ENTRY).length, 0);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a soft miss dispatches relevant evidence, checkpoints the event, and does not rejudge unchanged resume', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, 100, false);
    judge.respond((request) => ({ body: jevResponse(request, 0.9) }));
    const factory = (manager: SessionManager) => createContextExtension(manager, {
      policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection: { ...selection, workingContextLimit: 1 },
    });
    const run = await fixture.session((manager) => [factory(manager)], manager);
    await run.session.prompt('Establish usage.');
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 2);
    assert.ok(!tool(fixture.requests[1]!, 'a').includes('retired observation'));
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
    const usage = data<UsageRecord>(manager, USAGE_ENTRY)[1]!;
    assert.equal(usage.budget!.fits, true);
    assert.equal(usage.workingContext!.fits, false);
    assert.equal(usage.managerStopped, false);
    const checkpoint = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
    run.session.dispose();
    const fork = manager.createBranchedSession(checkpoint.id)!;
    const resumed = await fixture.session((manager) => [factory(manager)], SessionManager.open(fork));
    await resumed.session.agent.continue();
    assert.equal(judge.requests.length, 1);
    assert.equal(data(resumed.manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(fixture.requests[2]!.messages, fixture.requests[1]!.messages);
    assert.equal(data<UsageRecord>(resumed.manager, USAGE_ENTRY).at(-1)!.workingContext!.fits, null);
    await resumed.session.prompt('Check the API contract again.');
    assert.equal(judge.requests.length, 2);
    assert.equal(data(resumed.manager, SELECTION_ENTRY).length, 2);
    assert.equal(data(resumed.manager, STOP_ENTRY).length, 0);
    assert.deepEqual([...run.errors, ...resumed.errors], []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a protected-only soft miss dispatches without calling the judge', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection: { ...selection, workingContextLimit: 1 },
    })]);
    await run.session.prompt('Keep this user instruction.');
    assert.equal(data(run.manager, SELECTION_ENTRY).length, 0);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 0);
    assert.equal(fixture.requests.length, 2);
    assert.equal(data(run.manager, SELECTION_ENTRY).length, 1);
    const usage = data<UsageRecord>(run.manager, USAGE_ENTRY)[1]!;
    assert.equal(usage.budget!.fits, true);
    assert.equal(usage.workingContext!.fits, false);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('hard overflow with a soft target still stops before dispatch or native edits', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, 100, false);
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: { ...roomy, contextLimit: 1000 }, jev: judge.config,
      selection: { ...selection, workingContextLimit: 1 },
    })], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 0);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
    assert.equal(data(manager, SELECTION_ENTRY).length, 0);
    const stopped = data<{ kind: string; budget: { fits: boolean }; workingContext: { fits: boolean } }>(manager, STOP_ENTRY)[0]!;
    assert.equal(stopped.kind, 'budget');
    assert.equal(stopped.budget.fits, false);
    assert.equal(stopped.workingContext.fits, null);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('judge failure under soft pressure stops a hard-fitting request without consuming its event', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, 100, false);
    judge.respond(() => ({ status: 529, body: { error: 'Unavailable' } }));
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection: { ...selection, workingContextLimit: 1 },
    })], manager);
    await run.session.prompt('Establish usage.');
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 1);
    assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
    assert.equal(data(manager, SELECTION_ENTRY).length, 0);
    const stopped = data<{ kind: string; budget: { fits: boolean }; workingContext: { fits: boolean } }>(manager, STOP_ENTRY)[0]!;
    assert.equal(stopped.kind, 'judge');
    assert.equal(stopped.budget.fits, true);
    assert.equal(stopped.workingContext.fits, false);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('unknown usage and changed request settings recover only after a new successful response', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, 100, false);
    judge.respond((request) => ({ body: jevResponse(request, 0.9) }));
    let instruction = 'First settings';
    const run = await fixture.session((manager) => [
      (pi) => { pi.on('before_provider_request', (event) => {
        const payload = structuredClone(event.payload) as FixtureRequest;
        payload.messages.unshift({ role: 'system', content: instruction });
        return payload;
      }); },
      createContextExtension(manager, { policy: 'jev-select-v1', budget: roomy, jev: judge.config,
        selection: { ...selection, workingContextLimit: 1 } }),
    ], manager);
    fixture.reportInputTokens(0);
    await run.session.prompt('No usable input usage.');
    fixture.reportInputTokens(80);
    await run.session.prompt('Establish valid usage.');
    assert.equal(judge.requests.length, 0);
    instruction = 'Changed settings';
    await run.session.prompt('Changed request cannot reuse the anchor.');
    assert.equal(judge.requests.length, 0);
    await run.session.prompt('Stable settings reuse the new anchor.');
    assert.equal(judge.requests.length, 1);
    const working = data<UsageRecord>(manager, USAGE_ENTRY).map((entry) => entry.workingContext!);
    assert.deepEqual(working.map((entry) => entry.fits), [null, null, null, false]);
    assert.deepEqual(working.map((entry) => 'unknownReason' in entry ? entry.unknownReason : undefined),
      ['no-anchor', 'no-anchor', 'request-changed', undefined]);
    assert.equal(fixture.requests.length, 4);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('soft pressure reuses a tool-call response anchor but not an abandoned branch response', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    await writeFile(join(fixture.directory, 'fresh.txt'), 'New observation');
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, 100, false);
    const previousLeaf = manager.getLeafId()!;
    judge.respond((request) => ({ body: jevResponse(request, 0.9) }));
    fixture.respondWithTools([{ id: 'fresh', name: 'read', arguments: { path: 'fresh.txt' } }]);
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: roomy, jev: judge.config, selection: { ...selection, workingContextLimit: 1 },
    })], manager, ['read']);
    await run.session.prompt('Read fresh.txt.');
    assert.equal(fixture.requests.length, 2);
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(data<UsageRecord>(manager, USAGE_ENTRY).map((entry) => entry.workingContext!.fits), [null, false]);
    assert.equal(tool(fixture.requests[1]!, 'fresh'), 'New observation');
    await run.session.navigateTree(previousLeaf, { summarize: false });
    await run.session.prompt('Continue on the other branch.');
    assert.equal(judge.requests.length, 1);
    assert.equal(data<UsageRecord>(manager, USAGE_ENTRY).at(-1)!.workingContext!.fits, null);
    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('a target above the effective model window stops as invalid before judging or dispatch', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const run = await fixture.session((manager) => [createContextExtension(manager, {
      policy: 'jev-select-v1', budget: { ...roomy, contextLimit: 100_000 }, jev: judge.config,
      selection: { ...selection, workingContextLimit: 40_000 },
    })]);
    await run.session.prompt('Continue.');
    assert.equal(fixture.requests.length, 0);
    assert.equal(judge.requests.length, 0);
    const stopped = data<{ kind: string; reason: string }>(run.manager, STOP_ENTRY)[0]!;
    assert.equal(stopped.kind, 'invalid');
    assert.match(stopped.reason, /effective hard context limit/);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});
