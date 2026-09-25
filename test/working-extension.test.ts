import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createWorkingContextExtension, INFERENCE_START_ENTRY, INFERENCE_RESULT_ENTRY, SKETCH_ENTRY, WORKING_POLICY, type WorkingContextOptions } from '../src/working-extension.ts';
import { commitSelection, readHistory, SELECTION_ENTRY } from '../src/history.ts';
import { JEV_MODEL, type JevRequest, type JevScoreQuestion } from '../src/jev.ts';
import { INSTRUCTION_SOURCE_ENTRY } from '../src/task-sources.ts';
import { createPiFixture } from './pi-fixture.ts';
import { createJevFixture } from './jev-fixture.ts';
import { appendExchange, result, assistant, zeroUsage } from './history-fixture.ts';

function entries(manager: SessionManager, type: string) {
  return manager.getBranch().flatMap((entry) => entry.type === 'custom' && entry.customType === type ? [entry] : []);
}
function history(manager: SessionManager) { return readHistory(manager.getBranch(), manager.buildSessionProjection().messages); }
function scoreResponse(request: JevRequest, level: (id: string) => number = () => 3) {
  const questions = (request as unknown as JevRequest<JevScoreQuestion>).questions;
  return { model: JEV_MODEL, usage: { input_tokens: 1000, output_tokens: 20 },
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      const candidate = (question.instructions as { candidate: { evidenceId: string } }).candidate;
      const score = level(candidate.evidenceId);
      return [id, { type: 'score', score, confidence: 1,
        legend: Object.fromEntries(question.criteria.map((text, index) => [index, text])),
        probabilities: Object.fromEntries(question.criteria.map((_, index) => [index, Number(index === score)])) }];
    })) };
}
async function fixture() {
  const pi = await createPiFixture(), judge = await createJevFixture();
  let sketches = 0;
  const options: WorkingContextOptions = {
    capacity: { contextLimit: 30000, marginTokens: 100, maxRequestBytes: 300000 },
    target: { lowTokens: 7000, highTokens: 9000 }, archiveLimit: 2, decisionTimeoutMs: 30000,
    jev: judge.config,
    ranking: { maxPairBytes: 16000, maxRequestBytes: 40000, maxRequests: 8, maxSegments: 100,
      maxInputBytes: 500000, maxCostUsd: 1, requestTimeoutMs: judge.config.timeoutMs, maxDurationMs: 20000 },
    sketch: { model: pi.model, timeoutMs: 2000, maxTokens: 1000, maxUpdates: 4,
      complete: async () => { sketches++; return { ...assistant(),
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Fix invoice API contract and preserve the public API.' }) }],
        usage: { ...zeroUsage(), input: 80, cacheRead: 20, output: 4, totalTokens: 104 } }; } },
  };
  judge.respond((request) => ({ body: scoreResponse(request) }));
  return { pi, judge, options, sketches: () => sketches, async close() { await pi.close(); await judge.close(); } };
}
function seed(manager: SessionManager, archived = false, bytes = 6000) {
  manager.appendMessage({ role: 'user', content: 'Fix invoice API contract.', timestamp: 1 });
  const [old] = appendExchange(manager, [result('old', 'invoice '.repeat(Math.ceil(bytes / 8)))]);
  const [other] = appendExchange(manager, [result('other', 'API '.repeat(Math.ceil(bytes / 4)))]);
  appendExchange(manager, [result('newest', 'NEWEST OBSERVATION')]);
  if (archived) commitSelection(manager, [old!], 'scripted-v1');
  return { old: old!, other: other! };
}

test('fitting ordinary requests skip all decision inference and anchor subsequent token measurements', async () => {
  const f = await fixture();
  try {
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)]);
    await run.session.prompt('Fix the API.');
    await run.session.prompt('Continue.');
    assert.equal(f.pi.requests.length, 2);
    assert.equal(f.sketches(), 0);
    assert.equal(f.judge.requests.length, 0);
    assert.equal(entries(run.manager, INSTRUCTION_SOURCE_ENTRY).length, 0);
    assert.equal(entries(run.manager, SELECTION_ENTRY).length, 0);
    const usage = entries(run.manager, 'jev-context/usage').at(-1)!;
    assert.equal((usage.data as { capacity: { input: { method: string } } }).capacity.input.method, 'provider-usage-plus-delta-v2');
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

test('pressure ranks all eligible residents and commits whole edits to the actual SDK wire', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.pi.directory);
    const { old, other } = seed(manager, false, 14000);
    const originals = structuredClone(manager.getBranch().filter((item) => item.type === 'message'));
    f.judge.respond((request) => ({ body: scoreResponse(request, (id) => id === old ? 4 : 1) }));
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Finish invoice API contract.');
    assert.equal(f.pi.requests.length, 1);
    assert.equal(f.sketches(), 1);
    assert.ok(f.judge.requests.length > 0);
    assert.deepEqual(history(manager).retiredIds, [other]);
    const wire = f.pi.requests[0]!.messages;
    assert.match(String(wire.find((item) => item.tool_call_id === 'other')!.content), /retired observation/);
    assert.equal(String(wire.find((item) => item.tool_call_id === 'old')!.content), 'invoice '.repeat(1750));
    assert.match(JSON.stringify(wire), /NEWEST OBSERVATION/);
    assert.deepEqual(manager.getBranch().filter((item) => item.type === 'message').slice(0, originals.length), originals);
    const selection = entries(manager, SELECTION_ENTRY).at(-1)!;
    assert.match(JSON.stringify(selection), /working-set-v1/);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

test('a correction restores archived evidence in place and persists exploration across reopen', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.create(f.pi.directory);
    const { old } = seed(manager, true, 2500);
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Use the invoice API contract.');
    assert.equal(f.pi.requests.length, 1);
    assert.deepEqual(history(manager).retiredIds, []);
    assert.match(String(f.pi.requests[0]!.messages.find((item) => item.tool_call_id === 'old')!.content), /restored historical observation/);
    const entry = entries(manager, SELECTION_ENTRY).at(-1)!;
    assert.match(JSON.stringify(entry), new RegExp(`"afterId":"${old}"`));
    const reopened = SessionManager.open(manager.getSessionFile()!);
    const again = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], reopened);
    await again.session.prompt('Continue.');
    assert.deepEqual(history(reopened).retiredIds, []);
    assert.deepEqual(run.errors, []);
    assert.deepEqual(again.errors, []);
  } finally { await f.close(); }
});

for (const failure of ['pending-sketch', 'ranking-limit', 'known-judge-failure'] as const) {
  test(`${failure} preserves original wire and does not consume events or archive progress`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      const { old } = seed(manager, true, 2500);
      if (failure === 'pending-sketch') f.options.sketch.complete = async () => ({ ...assistant(), content: [{ type: 'text', text: '{}' }],
        usage: { ...zeroUsage(), input: 80, output: 4, totalTokens: 84 } });
      if (failure === 'ranking-limit') f.options.ranking.maxSegments = 1;
      if (failure === 'known-judge-failure') f.judge.respond((request) => ({ body: { ...scoreResponse(request), answers: {} } }));
      const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
      await run.session.prompt('Finish the invoice API.');
      assert.equal(f.pi.requests.length, 1);
      assert.deepEqual(history(manager).retiredIds, [old]);
      assert.equal(entries(manager, SELECTION_ENTRY).length, 1, 'only seed checkpoint');
      assert.equal(entries(manager, 'jev-context/deferral').length, 1);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

for (const state of ['unmatched-sketch', 'unmatched-judge', 'null-cost', 'legacy-judge'] as const) {
  test(`${state} stops even ordinary no-demand requests`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      if (state === 'legacy-judge') manager.appendCustomEntry('jev-context/judge-start', { requestId: 'old', batchIndex: 0 });
      else manager.appendCustomEntry(INFERENCE_START_ENTRY, { operationId: 'pending', kind: state === 'unmatched-judge' ? 'ranking' : 'sketch' });
      if (state === 'null-cost') manager.appendCustomEntry(INFERENCE_RESULT_ENTRY, { operationId: 'pending', pricedCostUsd: null });
      const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
      await run.session.prompt('Continue.');
      assert.equal(f.pi.requests.length, 0);
      assert.equal(f.sketches(), 0);
      assert.equal(f.judge.requests.length, 0);
      assert.match(JSON.stringify(entries(manager, 'jev-context/stop')), /unknown cost/);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

test('a real sketch usage failure persists unknown cost and prevents later coding and judging', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.pi.directory);
    seed(manager, true);
    let calls = 0;
    f.options.sketch.complete = async () => { calls++; return assistant(); };
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Finish invoice API.');
    await run.session.prompt('Continue.');
    assert.equal(calls, 1);
    assert.equal(f.pi.requests.length, 0);
    assert.equal(f.judge.requests.length, 0);
    assert.equal(entries(manager, SKETCH_ENTRY).length, 0);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

for (const kind of ['capacity-stop', 'transport-stop', 'selection-incomplete'] as const) {
  test(`${kind} has a distinct stop reason and never writes a partial selection`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      seed(manager, false, 20000);
      if (kind === 'capacity-stop') {
        f.options.capacity.contextLimit = 1500;
        f.options.target = { lowTokens: 800, highTokens: 1200 };
      } else if (kind === 'transport-stop') f.options.capacity.maxRequestBytes = 1;
      else { f.options.capacity.maxRequestBytes = 15000; f.options.ranking.maxSegments = 1; }
      const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
      await run.session.prompt('Finish the invoice API.');
      assert.equal(f.pi.requests.length, 0);
      assert.equal(entries(manager, SELECTION_ENTRY).length, 0);
      assert.match(JSON.stringify(entries(manager, 'jev-context/stop')), new RegExp(`"kind":"${kind}"`));
      assert.equal(f.judge.requests.length, 0);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

test('branch changes during inference cannot publish a sketch or native edits to the new branch', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.pi.directory);
    seed(manager, true);
    const leaf = manager.getLeafId()!;
    const complete = f.options.sketch.complete!;
    f.options.sketch.complete = async (...args) => { manager.branch(leaf); return complete(...args); };
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Finish invoice API.');
    assert.equal(f.pi.requests.length, 0);
    assert.equal(f.judge.requests.length, 0);
    assert.equal(entries(manager, SKETCH_ENTRY).length, 0);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

for (const mode of ['no-room', 'no-whole-fit', 'restore'] as const) {
  test(`tool-only ${mode} preflight runs before inference and never evicts a resident`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      const { old } = seed(manager, true, mode === 'no-whole-fit' ? 20000 : 6000);
      const userId = manager.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')!.id;
      commitSelection(manager, [old], WORKING_POLICY, { events: { userId, focusHash: 'previous' } });
      if (mode === 'no-room') f.options.target = { lowTokens: 2000, highTokens: 15000 };
      if (mode === 'no-whole-fit') f.options.target = { lowTokens: 10000, highTokens: 20000 };
      const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
      await run.session.agent.continue();
      assert.equal(f.pi.requests.length, 1);
      const last = entries(manager, SELECTION_ENTRY).at(-1)!;
      if (mode === 'restore') {
        assert.equal(f.sketches(), 1);
        assert.deepEqual(history(manager).retiredIds, []);
        assert.match(JSON.stringify(last), /restore-only/);
        for (const request of f.judge.requests) {
          for (const question of Object.values(request.questions)) {
            assert.equal((question.instructions as { candidate: { evidenceId: string } }).candidate.evidenceId, old);
          }
        }
      } else {
        assert.equal(f.sketches(), 0);
        assert.equal(f.judge.requests.length, 0);
        assert.deepEqual(history(manager).retiredIds, [old]);
        assert.match(JSON.stringify(last), mode === 'no-room' ? /no-restoration-room/ : /no-fitting-archive/);
      }
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

test('pressure with only pinned content above the low mark records target miss without inference', async () => {
  const f = await fixture();
  try {
    f.options.target = { lowTokens: 1000, highTokens: 1100 };
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)]);
    await run.session.prompt('Fix the API.');
    assert.equal(f.pi.requests.length, 1);
    assert.equal(f.sketches(), 0);
    assert.equal(f.judge.requests.length, 0);
    assert.match(JSON.stringify(entries(run.manager, SELECTION_ENTRY)), /"targetMiss":true/);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

test('a known-cost transient sketch error can retry the identical bounded plan', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.pi.directory);
    seed(manager, true);
    manager.appendMessage({ role: 'user', content: 'invoice '.repeat(5000), timestamp: 5 });
    const complete = f.options.sketch.complete!;
    let calls = 0;
    f.options.sketch.complete = async (...args) => {
      const response = await complete(...args);
      return ++calls === 1 ? { ...response, stopReason: 'error', errorMessage: 'temporary failure' } : response;
    };
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Continue.');
    await run.session.prompt('Continue.');
    const results = entries(manager, INFERENCE_RESULT_ENTRY).map((entry) => entry.data as { kind: string; inputHash: string; outcome: string });
    const sketches = results.filter((entry) => entry.kind === 'sketch');
    assert.equal(sketches[0]!.outcome, 'error');
    assert.equal(sketches[1]!.inputHash, sketches[0]!.inputHash);
    assert.equal(sketches[1]!.outcome, 'ok');
    assert.ok(f.judge.requests.length > 0);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

test('a rejected later ranking batch is detected before paying for earlier batches again', async () => {
  const f = await fixture();
  try {
    const manager = SessionManager.inMemory(f.pi.directory);
    seed(manager, true, 14000);
    f.options.ranking.maxRequestBytes = 16000;
    let calls = 0;
    f.judge.respond((request) => ({ body: ++calls === 2 ? { ...scoreResponse(request), answers: {} } : scoreResponse(request) }));
    const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
    await run.session.prompt('Continue.');
    assert.equal(calls, 2);
    await run.session.prompt('Continue.');
    assert.equal(calls, 2);
    assert.match(JSON.stringify(entries(manager, 'jev-context/deferral').at(-1)), /Identical ranking request/);
    assert.equal(entries(manager, SELECTION_ENTRY).length, 1);
    assert.deepEqual(run.errors, []);
  } finally { await f.close(); }
});

for (const mode of ['rebalance', 'restore-only'] as const) {
  test(`corrupt persisted sketch stops ${mode} instead of deferring or paying`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      const { old } = seed(manager, true, 2500);
      if (mode === 'restore-only') {
        const userId = manager.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')!.id;
        commitSelection(manager, [old], WORKING_POLICY, { events: { userId, focusHash: 'previous' } });
      }
      manager.appendCustomEntry(SKETCH_ENTRY, { summary: 'invoice', cursor: { entryId: 'missing' } });
      const run = await f.pi.session((m) => [createWorkingContextExtension(m, f.options)], manager);
      if (mode === 'restore-only') await run.session.agent.continue();
      else await run.session.prompt('Continue.');
      assert.equal(f.pi.requests.length, 0);
      assert.equal(f.sketches(), 0);
      assert.equal(f.judge.requests.length, 0);
      assert.equal(entries(manager, 'jev-context/deferral').length, 0);
      assert.match(JSON.stringify(entries(manager, 'jev-context/stop')), /"kind":"invalid"/);
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

for (const timing of ['before-send', 'after-send'] as const) {
  test(`user cancellation ${timing} preserves cancellation and accounting semantics`, async () => {
    const f = await fixture();
    try {
      const manager = SessionManager.inMemory(f.pi.directory);
      seed(manager, true, 2500);
      let first = true;
      const run = await f.pi.session((m) => [
        (pi) => { pi.on('context', (_event, ctx) => { if (timing === 'before-send' && first) { first = false; ctx.abort(); } }); },
        createWorkingContextExtension(m, f.options),
      ], manager);
      if (timing === 'after-send') f.options.sketch.complete = async () => {
        void run.session.abort();
        return new Promise(() => {});
      };
      await run.session.prompt('Continue.');
      assert.equal(f.pi.requests.length, 0);
      assert.match(JSON.stringify(entries(manager, 'jev-context/stop')), /"kind":"cancelled"/);
      const usage = entries(manager, 'jev-context/usage').at(-1)!.data as { cancelled: boolean; managerStopped: boolean; usageAvailable: boolean };
      assert.equal(usage.cancelled, true);
      assert.equal(usage.managerStopped, false);
      assert.equal(usage.usageAvailable, false);
      await run.session.prompt('Continue.');
      if (timing === 'before-send') assert.equal(f.pi.requests.length, 1);
      else {
        assert.equal(f.pi.requests.length, 0);
        assert.match(JSON.stringify(entries(manager, 'jev-context/stop').at(-1)), /unknown cost/);
      }
      assert.deepEqual(run.errors, []);
    } finally { await f.close(); }
  });
}

test('configuration rejects a timeout reservation different from the dispatched timeout', async () => {
  const f = await fixture();
  try {
    f.options.ranking.requestTimeoutMs--;
    assert.throws(() => createWorkingContextExtension(SessionManager.inMemory(), f.options), /actual Jev timeout/);
  } finally { await f.close(); }
});
