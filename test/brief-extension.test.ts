import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, STOP_ENTRY } from '../src/extension.ts';
import { BRIEF_ENTRY, BRIEF_RESULT_ENTRY, BRIEF_SOURCE_ENTRY, BRIEF_START_ENTRY, taskSources } from '../src/brief-session.ts';
import { applyBriefUpdate, planBriefUpdate } from '../src/task-brief.ts';
import { commitSelection, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { appendExchange, result, zeroUsage } from './history-fixture.ts';
import { scriptedBrief } from './brief-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const budget = { contextLimit: 200_000, marginTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8 };
function entries(manager: SessionManager, type: string) {
  return manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === type);
}
function seed(manager: SessionManager) {
  manager.appendMessage({ role: 'user', content: 'Finish the API contract.', timestamp: 1 });
  const [old] = appendExchange(manager, [result('old', 'API contract needed for implementation.')]);
  appendExchange(manager, [result('current', 'Current observation.')]);
  commitSelection(manager, [old!], 'scripted-v1');
  return old!;
}

test('fitting turns without an archive make no brief requests or instruction snapshots', async () => {
  for (let sample = 0; sample < 3; sample++) {
    const f = await createPiFixture(), judge = await createJevFixture();
    try {
      const brief = scriptedBrief(f.model);
      brief.complete = async () => { assert.fail('No selection demand'); };
      const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1',
        budget: { contextLimit: 30000, marginTokens: 1024 },
        selection: { ...selection, workingContextLimit: 20000 }, brief, jev: judge.config })]);
      for (const text of ['Fix the parser.', 'Keep the API stable.', 'Continue.']) await run.session.prompt(text);
      assert.equal(f.requests.length, 3);
      assert.equal(judge.requests.length, 0);
      for (const type of [BRIEF_SOURCE_ENTRY, BRIEF_START_ENTRY, BRIEF_RESULT_ENTRY, BRIEF_ENTRY, SELECTION_ENTRY]) {
        assert.equal(entries(run.manager, type).length, 0);
      }
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); await judge.close(); }
  }
});

test('repeated pressured tool turns reuse the brief without suppressing judgment or user corrections', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    await writeFile(join(f.directory, 'current.txt'), 'Current API contract.');
    const manager = SessionManager.inMemory(f.directory);
    seed(manager);
    f.reportInputTokens(5000);
    for (let i = 0; i < 3; i++) f.respondWithTools([{ id: `fresh${i}`, name: 'read', arguments: { path: 'current.txt' } }]);
    const brief = scriptedBrief(f.model), complete = brief.complete!;
    let calls = 0;
    brief.complete = (...args) => { calls++; return complete(...args); };
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget,
      selection: { ...selection, workingContextLimit: 3000 }, brief, jev: judge.config })], manager, ['read']);
    await run.session.prompt('Read current.txt and finish the API contract.');
    assert.equal(f.requests.length, 4);
    assert.equal(judge.requests.length, 4);
    assert.equal(calls, 1);
    assert.equal(entries(manager, BRIEF_ENTRY).length, 1);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 5); // Seed plus every fresh tool event.
    const state = JSON.stringify(judge.requests.at(-1)!.state);
    assert.match(state, /Current API contract/);
    assert.match(state, /fresh2/);
    await run.session.prompt('Correction: also preserve backward compatibility.');
    assert.equal(calls, 2);
    const latest = entries(manager, BRIEF_ENTRY).at(-1)!;
    assert.match(JSON.stringify(latest), /also preserve backward compatibility/);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); await judge.close(); }
});

test('soft pressure with no eligible observations checkpoints without a brief-pending deferral', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    f.reportInputTokens(2500);
    const brief = scriptedBrief(f.model);
    brief.complete = async () => { assert.fail('No eligible observations'); };
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget,
      selection: { ...selection, workingContextLimit: 3000 }, brief, jev: judge.config })]);
    await run.session.prompt('Fix the parser.');
    await run.session.prompt('Continue.');
    assert.equal(f.requests.length, 2);
    assert.equal(entries(run.manager, BRIEF_START_ENTRY).length, 0);
    assert.equal(entries(run.manager, SELECTION_ENTRY).length, 1);
    assert.equal(judge.requests.length, 0);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); await judge.close(); }
});

for (const state of ['unknown-cost', 'unmatched-start', 'hard-overflow'] as const) {
  test(`${state} still stops a turn with no brief demand`, async () => {
    const f = await createPiFixture(), judge = await createJevFixture();
    try {
      const manager = SessionManager.inMemory(f.directory);
      if (state !== 'hard-overflow') {
        manager.appendCustomEntry(BRIEF_START_ENTRY, { updateId: 'pending' });
        if (state === 'unknown-cost') manager.appendCustomEntry(BRIEF_RESULT_ENTRY,
          { updateId: 'pending', outcome: 'error', pricedCostUsd: null });
      }
      const brief = scriptedBrief(f.model);
      brief.complete = async () => { assert.fail('No brief demand'); };
      const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1',
        budget: state === 'hard-overflow' ? { ...budget, contextLimit: 1000 } : budget,
        selection, brief, jev: judge.config })], manager);
      await run.session.prompt('Continue.');
      assert.equal(f.requests.length, 0);
      assert.equal(judge.requests.length, 0);
      assert.equal(entries(manager, STOP_ENTRY).length, 1);
      assert.equal(entries(manager, BRIEF_SOURCE_ENTRY).length, 0);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); await judge.close(); }
  });
}

test('incomplete brief makes one bounded update, preserves evidence and events, then restores without rereading', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    const manager = SessionManager.inMemory(f.directory);
    const old = seed(manager);
    let calls = 0;
    const brief = scriptedBrief(f.model), complete = brief.complete!;
    brief.complete = (...args) => { calls++; return complete(...args); };
    judge.respond((request) => { const body = jevResponse(request); body.answers[old]!.noul = 0.95; return { body }; });
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget, selection, brief, jev: judge.config })], manager);
    await run.session.prompt('Continue the API task. ' + 'padding '.repeat(3200));
    assert.equal(calls, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(judge.requests.length, 0);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [old]);
    for (let i = 0; i < 5 && judge.requests.length === 0; i++) await run.session.prompt('Continue.');
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, []);
    assert.equal(entries(manager, BRIEF_SOURCE_ENTRY).length, 1);
    assert.equal(entries(manager, BRIEF_START_ENTRY).length, calls);
    assert.equal(entries(manager, BRIEF_RESULT_ENTRY).length, calls);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); await judge.close(); }
});

test('incompatible saved tool-derived briefs preserve evidence without a paid rescan', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    const manager = SessionManager.inMemory(f.directory);
    const old = seed(manager);
    const callEntry = manager.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'assistant')!;
    const legacySources = [...taskSources(manager.getBranch()),
      { id: callEntry.id, role: 'assistant' as const, text: '{"tool":"read","arguments":{"path":"old.txt"}}' }];
    manager.appendCustomEntry(BRIEF_ENTRY, applyBriefUpdate(planBriefUpdate(legacySources, null)!, {
      retain: [], add: [], supersede: [], activity: [],
    }, legacySources));
    const brief = scriptedBrief(f.model);
    brief.complete = async () => { assert.fail('Incompatible prefix must not silently restart scanning'); };
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget, selection, brief, jev: judge.config })], manager);
    await run.session.prompt('Continue the API task.');
    assert.equal(f.requests.length, 1);
    assert.equal(judge.requests.length, 0);
    assert.equal(entries(manager, BRIEF_START_ENTRY).length, 0);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionProjection().messages).retiredIds, [old]);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); await judge.close(); }
});

test('reopening the identical rejected update does not spend again or consume selection events', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    const manager = SessionManager.create(f.directory);
    seed(manager);
    const brief = scriptedBrief(f.model), complete = brief.complete!;
    let calls = 0;
    brief.complete = async (...args) => { calls++; return { ...await complete(...args), content: [{ type: 'text', text: '{}' }] }; };
    const factory = (m: SessionManager) => createContextExtension(m, { policy: 'jev-select-v1', budget, selection, brief, jev: judge.config });
    const first = await f.session((m) => [factory(m)], manager);
    await first.session.prompt('Continue the API task.');
    const failed = entries(manager, BRIEF_RESULT_ENTRY).at(-1)!;
    first.session.dispose();
    const branch = manager.createBranchedSession(failed.id)!;
    const resumed = await f.session((m) => [factory(m)], SessionManager.open(branch));
    await resumed.session.agent.continue();
    assert.equal(calls, 1);
    assert.equal(judge.requests.length, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(entries(resumed.manager, SELECTION_ENTRY).length, 1);
    assert.equal(entries(resumed.manager, BRIEF_ENTRY).length, 0);
    assert.deepEqual(resumed.errors, []);
  } finally { await f.close(); await judge.close(); }
});

for (const state of ['unknown-cost', 'unmatched-start', 'cancelled-before-completion'] as const) {
  test(`resuming ${state} preserves the updater accounting boundary`, async () => {
    const f = await createPiFixture(), judge = await createJevFixture();
    try {
      const manager = SessionManager.create(f.directory);
      seed(manager);
      const brief = scriptedBrief(f.model), complete = brief.complete!;
      let calls = 0;
      brief.complete = async (...args) => {
        calls++;
        const response = await complete(...args);
        return calls === 1 ? { ...response, usage: zeroUsage() } : response;
      };
      const factory = (m: SessionManager) => createContextExtension(m, { policy: 'jev-select-v1', budget, selection, brief, jev: judge.config });
      const first = await f.session((m) => [factory(m)], manager);
      await first.session.prompt('Continue the API task.');
      const start = entries(manager, BRIEF_START_ENTRY).at(-1)!;
      const result = entries(manager, BRIEF_RESULT_ENTRY).at(-1)!;
      assert.equal(result.type, 'custom');
      first.session.dispose();
      const branch = manager.createBranchedSession(state === 'unknown-cost' ? result.id : start.id)!;
      const reopened = SessionManager.open(branch);
      if (state === 'cancelled-before-completion' && result.type === 'custom') {
        reopened.appendCustomEntry(BRIEF_RESULT_ENTRY, { ...result.data as object,
          outcome: 'cancelled', completionInvoked: false, usage: null, pricedCostUsd: 0 });
      }
      const resumed = await f.session((m) => [factory(m)], reopened);
      await resumed.session.agent.continue();
      const retry = state === 'cancelled-before-completion';
      assert.equal(calls, retry ? 2 : 1);
      assert.equal(f.requests.length, retry ? 1 : 0);
      assert.equal(entries(reopened, BRIEF_ENTRY).length, retry ? 1 : 0);
      if (!retry) {
        assert.equal(judge.requests.length, 0);
        assert.equal(entries(reopened, SELECTION_ENTRY).length, 1);
        assert.equal(entries(reopened, STOP_ENTRY).length, 1);
      }
      assert.deepEqual(resumed.errors, []);
    } finally { await f.close(); await judge.close(); }
  });
}

for (const kind of ['unknown-cost', 'hard-overflow', 'branch-change'] as const) {
  test(`brief ${kind} cannot dispatch coding inference or install a selection`, async () => {
    const f = await createPiFixture(), judge = await createJevFixture();
    try {
      const manager = SessionManager.inMemory(f.directory);
      seed(manager);
      const originalLeaf = manager.getLeafId()!;
      const brief = scriptedBrief(f.model), complete = brief.complete!;
      brief.complete = async (...args) => {
        const response = await complete(...args);
        if (kind === 'branch-change') manager.branch(originalLeaf);
        return kind === 'unknown-cost' ? { ...response, usage: zeroUsage() }
          : { ...response, content: [{ type: 'text', text: '{}' }] };
      };
      const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1',
        budget: kind === 'hard-overflow' ? { ...budget, contextLimit: 1000 } : budget, selection, brief, jev: judge.config })], manager);
      await run.session.prompt('Continue the API task.');
      assert.equal(f.requests.length, 0);
      assert.equal(judge.requests.length, 0);
      assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
      assert.equal(entries(manager, BRIEF_ENTRY).length, 0);
      if (kind !== 'branch-change') assert.equal(entries(manager, STOP_ENTRY).length, 1);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); await judge.close(); }
  });
}
