import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension } from '../src/extension.ts';
import { readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { appendExchange, result } from './history-fixture.ts';
import { scriptedBrief } from './brief-fixture.ts';
import { createPiFixture } from './pi-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const budget = { contextLimit: 200_000, marginTokens: 1024 };
const selection = { archiveLimit: 2, restoreAtOrAbove: 0.8, workingContextLimit: 3000 };

for (const growth of [false, true]) {
  test(`tool turns skip earlier keeps without stale retirement; growth=${growth}`, async () => {
    let coding = 0;
    const f = await createPiFixture(() => {
      coding++;
      if (growth && coding === 4) f.reportInputTokens(7000);
    });
    const judge = await createJevFixture();
    try {
      await writeFile(join(f.directory, 'current.txt'), 'Current API contract. '.repeat(30));
      const manager = SessionManager.inMemory(f.directory);
      manager.appendMessage({ role: 'user', content: 'Finish the API contract.', timestamp: 1 });
      const [old] = appendExchange(manager, [result('old', 'Original API contract. '.repeat(100))]);
      appendExchange(manager, [result('protected', 'Protected observation.')]);
      f.reportInputTokens(5000);
      for (let i = 0; i < 4; i++) f.respondWithTools([{ id: `fresh${i}`, name: 'read', arguments: { path: 'current.txt' } }]);
      let oldJudgments = 0;
      judge.respond((request) => {
        const body = jevResponse(request, 0.9);
        if (old! in request.questions) {
          oldJudgments++;
          if (oldJudgments > 1) body.answers[old!]!.noul = 0.1;
        }
        return { body };
      });
      const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget,
        selection, brief: scriptedBrief(f.model), jev: judge.config })], manager, ['read']);
      await run.session.prompt('Read current.txt and finish the API contract.');
      assert.equal(f.requests.length, 5);
      assert.equal(oldJudgments, growth ? 2 : 1);
      assert.equal(readHistory(manager.getBranch(), manager.buildSessionContext().messages).retiredIds.includes(old!), growth);
      const checkpoints = manager.getBranch().filter((entry) => entry.type === 'custom' && entry.customType === SELECTION_ENTRY);
      assert.ok(checkpoints.some((entry) => JSON.stringify(entry).includes(`"skippedKeepIds":["${old}"`)));
      // New eligible reads are judged despite suppressing repeated questions about older evidence.
      const questions = judge.requests.flatMap((request) => Object.values(request.questions));
      assert.match(JSON.stringify(questions), /fresh0/);
      assert.match(JSON.stringify(questions), /fresh2/);
      assert.deepEqual(run.errors, []);
      if (!growth) {
        await run.session.prompt('Correction: the original API contract is now obsolete.');
        assert.equal(oldJudgments, 2, 'A new user source changes the brief and bypasses the schedule');
        assert.equal(readHistory(manager.getBranch(), manager.buildSessionContext().messages).retiredIds.includes(old!), true);
      }
    } finally { await f.close(); await judge.close(); }
  });
}

test('an unchanged pool of kept evidence causes no further judge dispatches', async () => {
  const f = await createPiFixture(), judge = await createJevFixture();
  try {
    const manager = SessionManager.inMemory(f.directory);
    const [old] = appendExchange(manager, [result('old', 'Original API contract. '.repeat(100))]);
    appendExchange(manager, [result('protected', 'Tiny')]);
    await writeFile(join(f.directory, 'tiny.txt'), 'Tiny');
    f.reportInputTokens(5000);
    // These outputs are smaller than their retirement stubs, so never become new candidates.
    for (let i = 0; i < 4; i++) f.respondWithTools([{ id: `tiny${i}`, name: 'read', arguments: { path: 'tiny.txt' } }]);
    judge.respond((request) => ({ body: jevResponse(request, 0.9) }));
    const run = await f.session((m) => [createContextExtension(m, { policy: 'jev-select-v1', budget,
      selection, brief: scriptedBrief(f.model), jev: judge.config })], manager, ['read']);
    await run.session.prompt('Finish the API contract.');
    assert.equal(f.requests.length, 5);
    assert.equal(judge.requests.length, 1);
    assert.deepEqual(Object.keys(judge.requests[0]!.questions), [old]);
    assert.deepEqual(readHistory(manager.getBranch(), manager.buildSessionContext().messages).retiredIds, []);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); await judge.close(); }
});
