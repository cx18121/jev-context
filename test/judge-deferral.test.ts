import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, JUDGE_RESULT_ENTRY, JUDGE_START_ENTRY, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { commitSelection, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { appendExchange, result } from './history-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';

const budget = { contextLimit: 32768, marginTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8, workingContextLimit: 1 };
function records<T>(manager: SessionManager, kind: string): T[] {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === kind ? [entry.data as T] : []);
}
function seed(manager: SessionManager, huge = false) {
  manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
  const [old] = appendExchange(manager, [result('old', 'API contract. '.repeat(huge ? 3000 : 100))]);
  appendExchange(manager, [result('latest', 'Protected current output.')]);
  commitSelection(manager, [old!], 'scripted-v1');
  return old!;
}
interface Checkpoint {
  reconsideration: {
    retrieval: { candidateIds: string[] };
    deferral: { reason: string; unjudgedCandidateIds: string[]; input?: { maxPairBytes: number } };
  };
}

test('deferrals keep the wire view, record unjudged archive candidates, and consume only the current event', async () => {
  for (const failure of ['pair-cap', 'invalid_response', 'http_error'] as const) {
    const f = await createPiFixture();
    const judge = await createJevFixture();
    try {
      const manager = SessionManager.create(f.directory);
      const old = seed(manager, failure === 'pair-cap');
      judge.respond((request) => ({ status: failure === 'http_error' ? 529 : 200,
        body: { ...jevResponse(request), answers: {} } }));
      const factories = (m: SessionManager) => [createContextExtension(m, { policy: 'jev-select-v1', budget, selection, jev: judge.config })];
      const run = await f.session(factories, manager);
      const original = structuredClone(manager.buildSessionProjection().messages);
      await run.session.prompt('Continue.');
      assert.equal(f.requests.length, 1);
      assert.equal(judge.requests.length, failure === 'pair-cap' ? 0 : 1);
      assert.deepEqual(manager.buildSessionProjection().messages.slice(0, original.length), original);
      assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 1);
      assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [old]);
      const checkpoint = records<Checkpoint>(manager, SELECTION_ENTRY).at(-1)!;
      assert.deepEqual(checkpoint.reconsideration.retrieval.candidateIds, [old]);
      assert.deepEqual(checkpoint.reconsideration.deferral.unjudgedCandidateIds, [old]);
      assert.equal(checkpoint.reconsideration.deferral.reason, failure === 'pair-cap' ? failure : 'accounted-judge-failure');
      if (failure === 'pair-cap') assert.ok(checkpoint.reconsideration.deferral.input!.maxPairBytes > 30_000);
      else assert.ok(records<{ pricedCostUsd: number | null }>(manager, JUDGE_RESULT_ENTRY)[0]!.pricedCostUsd !== null);
      const usage = records<UsageRecord>(manager, USAGE_ENTRY)[0]!;
      assert.equal(usage.budget!.fits, true);
      assert.equal(usage.workingContext!.fits, false);
      assert.equal(usage.managerStopped, false);
      assert.equal(records(manager, STOP_ENTRY).length, 0);

      const entry = manager.getBranch().findLast((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY)!;
      run.session.dispose();
      const resumed = await f.session(factories, SessionManager.open(manager.createBranchedSession(entry.id)!));
      await resumed.session.agent.continue();
      assert.equal(f.requests.length, 2);
      assert.deepEqual(f.requests[1]!.messages, f.requests[0]!.messages);
      assert.equal(records(resumed.manager, SELECTION_ENTRY).length, 2);
      assert.equal(judge.requests.length, failure === 'pair-cap' ? 0 : 1);
      await resumed.session.prompt('Check the API contract again.');
      assert.equal(records(resumed.manager, SELECTION_ENTRY).length, 3);
      assert.equal(judge.requests.length, failure === 'pair-cap' ? 0 : 2);
      assert.equal(f.requests.length, 3);
      // Safe deferrals do not remove the hard stop as the unchanged history grows.
      await resumed.session.prompt('Mandatory new constraint. '.repeat(1500));
      assert.equal(f.requests.length, 3);
      assert.equal(records(resumed.manager, SELECTION_ENTRY).length, 3);
      assert.equal(records<{ budget: { fits: boolean } }>(resumed.manager, STOP_ENTRY).at(-1)!.budget.fits, false);
      assert.deepEqual([...run.errors, ...resumed.errors], []);
    } finally { await judge.close(); await f.close(); }
  }
});

test('an accounted failed judge under hard pressure still stops without checkpointing', async () => {
  const f = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(f.directory);
    seed(manager);
    judge.respond((request) => ({ body: { ...jevResponse(request), answers: {} } }));
    const run = await f.session((m) => [createContextExtension(m, {
      policy: 'jev-select-v1', budget: { ...budget, contextLimit: 1000 }, selection, jev: judge.config,
    })], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(f.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 1);
    assert.equal(records<{ budget: { fits: boolean } }>(manager, STOP_ENTRY)[0]!.budget.fits, false);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await f.close(); }
});

test('a deferral checkpoint write failure stops dispatch and poisons the writer', async () => {
  const f = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(f.directory);
    seed(manager, true);
    const append = manager.appendCustomEntry.bind(manager);
    manager.appendCustomEntry = (kind, value) => {
      if (kind === SELECTION_ENTRY) throw new Error('Injected checkpoint failure');
      return append(kind, value);
    };
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget, selection, jev: judge.config })], manager);
    await run.session.prompt('Continue.');
    await run.session.prompt('Try again.');
    assert.equal(f.requests.length, 0);
    assert.equal(judge.requests.length, 0);
    assert.equal(records(manager, SELECTION_ENTRY).length, 1);
    assert.equal(records(manager, STOP_ENTRY).length, 0);
    assert.equal(records(manager, USAGE_ENTRY).length, 0);
    assert.equal(records(manager, JUDGE_START_ENTRY).length, 0);
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await f.close(); }
});
