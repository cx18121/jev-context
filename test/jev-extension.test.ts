import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { measureRequest } from '../src/budget.ts';
import { createContextExtension, JUDGE_RESULT_ENTRY, JUDGE_START_ENTRY, STOP_ENTRY, USAGE_ENTRY, type UsageRecord } from '../src/extension.ts';
import { SELECTION_ENTRY, readHistory } from '../src/history.ts';
import type { JevResult } from '../src/jev.ts';
import { appendExchange, result } from './history-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { createPiFixture, type FixtureRequest } from './pi-fixture.ts';

const roomy = { contextLimit: 32768, marginTokens: 1024 };
function data<T>(manager: SessionManager, kind: string): T[] {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === kind ? [entry.data as T] : []);
}
function seed(manager: SessionManager, large = false) {
  manager.appendMessage({ role: 'user', content: 'Implement the API and preserve its compatibility contract.', timestamp: 1 });
  const [a] = appendExchange(manager, [result('a', 'Important API contract.\n'.repeat(large ? 1500 : 100))]);
  const [b] = appendExchange(manager, [result('b', 'Obsolete environment output.\n'.repeat(100))]);
  appendExchange(manager, [result('latest', 'Current environment ready.')]);
  return { a: a!, b: b! };
}
function tool(request: FixtureRequest, id: string) {
  const message = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === id);
  assert.ok(message);
  return message;
}

test('Jev retires lower relevance rather than older evidence, and resume reuses the view without judging', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const controlManager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(controlManager);
    const control = await fixture.session((manager) => [createContextExtension(manager, { policy: 'scripted-v1', budget: roomy })], controlManager);
    await control.session.prompt('Continue.');
    const full = fixture.requests[0]!;
    const measured = measureRequest(full, fixture.model, roomy);
    const budget = { ...roomy, contextLimit: measured.inputEstimate + measured.outputReserve + measured.marginTokens - 1 };
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    const ids = seed(manager);
    const originals = structuredClone(manager.getBranch().filter((entry) => entry.type === 'message'));
    judge.respond((request) => {
      const response = jevResponse(request);
      response.answers[ids.a]!.noul = 0.9;
      return { body: response };
    });
    const selected = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget, jev: judge.config })], manager);
    await selected.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(Object.keys(judge.requests[0]!.questions), [ids.a, ids.b]);
    assert.equal(fixture.requests.length, 2);
    const request = fixture.requests[1]!;
    assert.equal(tool(request, 'a').content, tool(full, 'a').content);
    assert.match(String(tool(request, 'b').content), /retired observation/);
    assert.equal(tool(request, 'latest').content, tool(full, 'latest').content);
    assert.equal(measureRequest(request, fixture.model, budget).fits, true);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [ids.b]);
    assert.deepEqual(manager.getBranch().filter((entry) => entry.type === 'message').slice(0, originals.length), originals);
    const start = data<{ requestId: string; requestHash: string }>(manager, JUDGE_START_ENTRY)[0]!;
    const judged = data<JevResult & { requestId: string }>(manager, JUDGE_RESULT_ENTRY)[0]!;
    const usage = data<UsageRecord>(manager, USAGE_ENTRY)[0]!;
    assert.equal(judged.requestId, start.requestId);
    assert.equal(usage.requestId, start.requestId);
    assert.equal(judged.pricedCostUsd, 0.000042);
    assert.match(start.requestHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(manager.getBranch()).includes(judge.config.apiKey));
    selected.session.dispose();
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const resumed = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget, jev: judge.config })], reopened);
    await resumed.session.prompt('Continue again.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 3);
    assert.deepEqual(fixture.requests[2]!.messages.slice(0, request.messages.length), request.messages);
    assert.deepEqual([...control.errors, ...selected.errors, ...resumed.errors], []);
  } finally { await judge.close(); await fixture.close(); }
});

test('scores at the cutoff cannot trigger forced retirement; judge cost survives the budget stop', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager);
    judge.respond((request) => ({ body: jevResponse(request, judge.config.retireBelow) }));
    const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: { ...roomy, contextLimit: 2000 }, jev: judge.config })], manager);
    await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.equal(fixture.requests.length, 0);
    assert.equal(data(manager, SELECTION_ENTRY).length, 0);
    assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'budget');
    assert.equal(data<JevResult>(manager, JUDGE_RESULT_ENTRY)[0]!.pricedCostUsd, 0.000042);
    assert.equal(data<JevResult>(manager, JUDGE_RESULT_ENTRY)[0]!.outcome, 'ok');
    assert.deepEqual(run.errors, []);
  } finally { await judge.close(); await fixture.close(); }
});

test('judge service and response failures are not misclassified as budget failures', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    for (const failure of ['http', 'model']) {
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      seed(manager);
      judge.respond((request) => failure === 'http'
        ? { status: 529, body: { error: 'Overloaded' } }
        : { body: { ...jevResponse(request), model: 'different-model' } });
      const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: { ...roomy, contextLimit: 2000 }, jev: judge.config })], manager);
      await run.session.prompt('Continue.');
      assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'judge');
      assert.equal(data(manager, SELECTION_ENTRY).length, 0);
      const judged = data<JevResult>(manager, JUDGE_RESULT_ENTRY)[0]!;
      assert.equal(judged.pricedCostUsd, null);
      if (failure === 'model') assert.deepEqual(judged.rawUsage, { input_tokens: 1000, output_tokens: 20 });
      assert.deepEqual(run.errors, []);
    }
    assert.equal(judge.requests.length, 2);
    assert.equal(fixture.requests.length, 0);
  } finally { await judge.close(); await fixture.close(); }
});

test('no pressure, no candidates, and oversized judge input never call Jev', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  try {
    const small = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: roomy, jev: judge.config })]);
    await small.session.prompt('Small task.');
    assert.equal(fixture.requests.length, 1);
    const protectedOnly = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: { ...roomy, contextLimit: 100 }, jev: judge.config })]);
    await protectedOnly.session.prompt('Protected task.');
    assert.equal(data<{ kind: string }>(protectedOnly.manager, STOP_ENTRY)[0]!.kind, 'budget');
    const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
    seed(manager, true);
    const large = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: { ...roomy, contextLimit: 2000 }, jev: judge.config })], manager);
    await large.session.prompt('Cannot fit the whole candidate.');
    assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'judge');
    assert.equal(data(manager, JUDGE_START_ENTRY).length, 0);
    assert.equal(data(manager, SELECTION_ENTRY).length, 0);
    assert.equal(judge.requests.length, 0);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual([...small.errors, ...protectedOnly.errors, ...large.errors], []);
  } finally { await judge.close(); await fixture.close(); }
});

test('cancellation and a branch move during judging cannot install a late decision', async () => {
  const fixture = await createPiFixture();
  const judge = await createJevFixture();
  const release = Promise.withResolvers<void>();
  try {
    for (const moveBranch of [false, true]) {
      const entered = Promise.withResolvers<void>();
      judge.respond(async (request) => { entered.resolve(); await release.promise; return { body: jevResponse(request) }; });
      const manager = SessionManager.create(fixture.directory, join(fixture.directory, 'sessions'));
      seed(manager);
      const previousLeaf = manager.getLeafId()!;
      const run = await fixture.session((manager) => [createContextExtension(manager, { policy: 'jev-v1', budget: { ...roomy, contextLimit: 2000 }, jev: judge.config })], manager);
      const pending = run.session.prompt('Continue.');
      await entered.promise;
      assert.equal(data(manager, JUDGE_START_ENTRY).length, 1);
      if (moveBranch) manager.branch(previousLeaf);
      await run.session.abort();
      await pending;
      assert.equal(data(manager, SELECTION_ENTRY).length, 0);
      if (moveBranch) {
        assert.equal(data(manager, JUDGE_START_ENTRY).length, 0);
        assert.equal(data(manager, JUDGE_RESULT_ENTRY).length, 0);
        assert.equal(manager.getEntries().filter((entry) => entry.type === 'custom' && entry.customType === JUDGE_START_ENTRY).length, 1);
      } else {
        assert.equal(data<JevResult>(manager, JUDGE_RESULT_ENTRY)[0]!.outcome, 'cancelled');
        assert.equal(data<JevResult>(manager, JUDGE_RESULT_ENTRY)[0]!.pricedCostUsd, null);
        assert.equal(data<{ kind: string }>(manager, STOP_ENTRY)[0]!.kind, 'cancelled');
        assert.equal(data<UsageRecord>(manager, USAGE_ENTRY)[0]!.managerStopped, false);
      }
      assert.deepEqual(run.errors, []);
    }
    assert.equal(fixture.requests.length, 0);
  } finally { release.resolve(); await judge.close(); await fixture.close(); }
});
