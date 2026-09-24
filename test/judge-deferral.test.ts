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
    deferral?: { reason: string; unjudgedCandidateIds: string[] };
    unjudged: Array<{ evidenceId: string; reason: string; pairBytes: number }>;
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
      if (failure === 'pair-cap') {
        assert.equal(checkpoint.reconsideration.deferral, undefined);
        assert.deepEqual(checkpoint.reconsideration.unjudged.map(({ evidenceId, reason }) => ({ evidenceId, reason })),
          [{ evidenceId: old, reason: 'pair-cap' }]);
        assert.ok(checkpoint.reconsideration.unjudged[0]!.pairBytes > 30_000);
      } else {
        assert.deepEqual(checkpoint.reconsideration.deferral!.unjudgedCandidateIds, [old]);
        assert.equal(checkpoint.reconsideration.deferral!.reason, 'accounted-judge-failure');
        assert.ok(records<{ pricedCostUsd: number | null }>(manager, JUDGE_RESULT_ENTRY)[0]!.pricedCostUsd !== null);
      }
      const usage = records<UsageRecord>(manager, USAGE_ENTRY)[0]!;
      assert.equal(usage.budget!.fits, true);
      assert.equal(usage.workingContext!.fits, null);
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

test('mixed-size hard-pressure decisions change only judged wire evidence, or stop if that cannot make room', async () => {
  for (const canRetire of [true, false]) {
    const f = await createPiFixture();
    const judge = await createJevFixture();
    try {
      const manager = SessionManager.create(f.directory);
      manager.appendMessage({ role: 'user', content: 'Implement the API contract.', timestamp: 1 });
      const largeText = 'L'.repeat(28_500);
      const [large] = appendExchange(manager, [result('large', largeText)]);
      const [small] = appendExchange(manager, [result('small', 'small'.repeat(1000))]);
      appendExchange(manager, [result('latest', 'Protected current output.')]);
      const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
      judge.respond((request) => {
        assert.deepEqual(Object.keys(request.questions), [small]);
        const body = jevResponse(request);
        body.answers[small!]!.noul = canRetire ? 0.1 : 0.9;
        return { body };
      });
      const run = await f.session((m) => [createContextExtension(m, {
        policy: 'jev-select-v1', budget: { contextLimit: 31_000, marginTokens: 0 },
        selection: { archiveLimit: 2, restoreAtOrAbove: 0.8 }, jev: judge.config,
      })], manager);
      await run.session.prompt('Continue.');
      assert.equal(judge.requests.length, 1);
      assert.equal(f.requests.length, canRetire ? 1 : 0);
      assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
      if (canRetire) {
        const wire = f.requests[0]!.messages;
        assert.equal(wire.find((item) => item.tool_call_id === 'large')!.content, largeText);
        assert.match(String(wire.find((item) => item.tool_call_id === 'small')!.content), /retired observation/);
        const checkpoint = records<Checkpoint>(manager, SELECTION_ENTRY)[0]!;
        assert.deepEqual(checkpoint.reconsideration.unjudged.map((item) => item.evidenceId), [large]);
        assert.equal(checkpoint.reconsideration.deferral, undefined);
      } else {
        assert.equal(records(manager, SELECTION_ENTRY).length, 0);
        assert.equal(manager.getBranch().filter((entry) => entry.type === 'context_edit').length, 0);
        assert.equal(records<{ budget: { fits: boolean } }>(manager, STOP_ENTRY)[0]!.budget.fits, false);
      }
      assert.deepEqual(run.errors, []);
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
