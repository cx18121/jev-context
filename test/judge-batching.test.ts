import { scriptedBrief } from './brief-fixture.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createContextExtension, JUDGE_START_ENTRY, JUDGE_RESULT_ENTRY, STOP_ENTRY } from '../src/extension.ts';
import { SELECTION_ENTRY } from '../src/history.ts';
import { JEV_PAIR_BYTES, JEV_REQUEST_BYTES } from '../src/judge-state.ts';
import type { JevResult } from '../src/jev.ts';
import { createCodexFixture, type CodexRequest } from './codex-fixture.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';
import { assistant, result } from './history-fixture.ts';

function records<T>(manager: SessionManager, kind: string): T[] {
  return manager.getBranch().flatMap((e) => e.type === 'custom' && e.customType === kind ? [e.data as T] : []);
}
function stable(request: CodexRequest) {
  return request.input.filter((item) => !String(item.type).endsWith('_output'));
}

for (const mode of ['success', 'accounted-failure', 'unknown-cost', 'cancel', 'branch', 'deadline'] as const) {
  test(`multi-batch Codex decision is atomic: ${mode}`, async () => {
    const f = await createCodexFixture();
    const judge = await createJevFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const manager = SessionManager.create(f.directory);
      manager.appendMessage({ role: 'user', content: 'Preserve the public API. Do not edit schema.sql.', timestamp: 1 });
      const ids: string[] = [];
      for (let i = 0; i < 33; i++) {
        const call = { type: 'toolCall' as const, id: `call${i}|fc_call${i}`, name: 'read', arguments: { path: `file${i}.txt` } };
        manager.appendMessage({ ...assistant([call]), api: f.model.api, provider: f.model.provider, model: f.model.id,
          content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({
            type: 'reasoning', id: `rs_${i}`, encrypted_content: `reasoning_${i}`, summary: [],
          }) }, call] });
        const id = manager.appendMessage(result(call.id, i === 32 ? 'Protected current observation.' : 'evidence '.repeat(40)));
        if (i < 32) ids.push(id);
      }
      let count = 0;
      judge.respond(async (request) => {
        count++;
        assert.equal(manager.getBranch().filter((e) => e.type === 'context_edit').length, 0);
        if (count === 2) {
          if (mode === 'accounted-failure') return { body: { ...jevResponse(request), answers: {} } };
          if (mode === 'unknown-cost') return { status: 503, body: { error: 'unavailable' } };
          if (mode === 'cancel' || mode === 'branch' || mode === 'deadline') {
            entered.resolve();
            await release.promise;
          }
        }
        return { body: jevResponse(request) };
      });
      let before: CodexRequest | undefined;
      const run = await f.session((m) => [
        (pi) => { pi.on('before_provider_request', (e) => { before = structuredClone(e.payload) as CodexRequest; }); },
        createContextExtension(m, {
          policy: 'jev-select-v1', brief: scriptedBrief(f.model), budget: { contextLimit: 32768, marginTokens: 256, outputReserveTokens: 1024 },
          selection: { archiveLimit: 2, restoreAtOrAbove: 0.8, workingContextLimit: 8000 },
          jev: { ...judge.config, timeoutMs: mode === 'deadline' ? 500 : judge.config.timeoutMs },
        }),
      ], manager);
      f.reportInputTokens(8000);
      await run.session.prompt('Establish usage.');
      assert.equal(f.requests.length, 1, JSON.stringify(records(manager, STOP_ENTRY)));
      assert.equal(judge.requests.length, 0);
      const previousLeaf = manager.getLeafId()!;
      const pending = run.session.prompt('Continue.');
      if (mode === 'cancel' || mode === 'branch' || mode === 'deadline') {
        await entered.promise;
        if (mode === 'branch') manager.branch(previousLeaf);
        if (mode !== 'deadline') await run.session.abort();
      }
      await pending;
      assert.ok(judge.requests.length >= 2);
      const firstState = judge.requests[0]!.state;
      for (const request of judge.requests) {
        assert.deepEqual(request.state, firstState);
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= JEV_REQUEST_BYTES);
        for (const question of Object.values(request.questions)) {
          assert.ok(Buffer.byteLength(JSON.stringify({ state: request.state, question })) <= JEV_PAIR_BYTES);
        }
      }
      assert.match(JSON.stringify(firstState), /Do not edit schema.sql/);
      assert.doesNotMatch(JSON.stringify(firstState), /encrypted_content|reasoning_0/);
      if (mode === 'success') {
        assert.deepEqual(judge.requests.flatMap((r) => Object.keys(r.questions)).sort(), [...ids].sort());
        assert.equal(f.requests.length, 2);
        assert.deepEqual(stable(f.requests[1]!), stable(before!));
        assert.ok(f.requests[1]!.input.some((item) => String(item.output).includes('retired observation')));
        assert.ok(manager.getBranch().filter((e) => e.type === 'context_edit').length > 0);
        assert.equal(records(manager, SELECTION_ENTRY).length, 1);
      } else {
        assert.equal(manager.getBranch().filter((e) => e.type === 'context_edit').length, 0);
        assert.equal(judge.requests.length, 2, 'failure stops the remaining batches');
        if (mode === 'accounted-failure') {
          assert.deepEqual(f.requests[1], before);
          const checkpoint = records<{ reconsideration: { deferral: { unjudgedCandidateIds: string[] } } }>(manager, SELECTION_ENTRY)[0]!;
          assert.deepEqual(checkpoint.reconsideration.deferral.unjudgedCandidateIds,
            ids.filter((id) => !(id in judge.requests[0]!.questions)));
        } else {
          assert.equal(f.requests.length, 1);
          assert.equal(records(manager, SELECTION_ENTRY).length, 0);
        }
      }
      if (mode !== 'branch') {
        const starts = records<{ requestId: string; batchIndex: number; batchCount: number; candidateIds: string[]; timeoutMs: number }>(manager, JUDGE_START_ENTRY);
        const results = records<JevResult & { requestId: string; batchIndex: number; batchCount: number }>(manager, JUDGE_RESULT_ENTRY);
        assert.equal(starts.length, judge.requests.length);
        assert.equal(results.length, starts.length);
        for (const [i, start] of starts.entries()) {
          assert.equal(start.batchIndex, i);
          assert.equal(start.requestId, starts[0]!.requestId);
          assert.deepEqual(start.candidateIds, Object.keys(judge.requests[i]!.questions));
          assert.equal(results[i]!.batchIndex, i);
          assert.equal(results[i]!.batchCount, start.batchCount);
        }
        assert.ok(starts[1]!.timeoutMs <= starts[0]!.timeoutMs);
        assert.equal(results[0]!.outcome, 'ok');
        assert.ok(results[0]!.pricedCostUsd! > 0);
        if (mode === 'deadline') assert.equal(results[1]!.outcome, 'timeout');
      }
      assert.deepEqual(run.errors, []);
    } finally { release.resolve(); await judge.close(); await f.close(); }
  });
}
