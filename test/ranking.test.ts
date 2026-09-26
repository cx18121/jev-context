import assert from 'node:assert/strict';
import test from 'node:test';
import { rankJev, JEV_MODEL, type JevRequest, type JevScoreQuestion, type JevRankingResult } from '../src/jev.ts';
import { CALL_CONTEXT_BYTES, collectRanking, planRanking, PRIORITY_LEVELS, type RankingCandidate, type RankingLimits } from '../src/ranking.ts';
import { createJevFixture } from './jev-fixture.ts';

const limits: RankingLimits = { maxPairBytes: 6000, maxRequestBytes: 12000, maxRequests: 8, maxSegments: 64,
  maxInputBytes: 500_000, maxCostUsd: 1, requestTimeoutMs: 1000, maxDurationMs: 8000 };
const state = { taskSketch: 'Fix the outstanding bug without changing public behavior.', recentActivity: [] };
const candidate = (id: string, text = 'observation'): RankingCandidate => ({ id, text,
  toolCall: { id: `call-${id}`, name: 'read', arguments: { path: '/testbed/source.ts' } }, capturedAt: 1, isError: false });
const scoreAnswer = (probabilities = [0, 0, 0.6, 0.4, 0]) => ({ type: 'score',
  probabilities: Object.fromEntries(probabilities.map((p, i) => [String(i), p])),
  score: probabilities.reduce((sum, p, i) => sum + p * i, 0), confidence: 0.5,
  legend: Object.fromEntries(PRIORITY_LEVELS.map((text, i): [string, string] => [String(i), text])) });
const request: JevRequest<JevScoreQuestion> = { model: JEV_MODEL, state, questions: {
  item: { type: 'score', instructions: { question: 'Rate support for remaining work.', candidate: 'evidence' }, criteria: PRIORITY_LEVELS },
} };

function result(priorities: JevRankingResult['priorities']): JevRankingResult {
  return { outcome: 'ok', sent: true, httpStatus: 200, model: JEV_MODEL, latencyMs: 1,
    rawUsage: { input_tokens: 1000, output_tokens: 20 }, pricedCostUsd: 0.000042, priorities };
}

test('Score wire contract computes median priority and expected tie break from all five probabilities', async () => {
  const fixture = await createJevFixture();
  try {
    fixture.respond(() => ({ body: { model: JEV_MODEL, answers: { item: scoreAnswer() }, usage: { input_tokens: 1000, output_tokens: 20 } } }));
    const answer = await rankJev(request, fixture.config, new AbortController().signal);
    assert.equal(answer.outcome, 'ok');
    assert.deepEqual(answer.priorities, { item: { level: 2, score: 2.4000000000000004 } });
    assert.equal(answer.pricedCostUsd, 0.000042);
    assert.deepEqual(fixture.requests, [request]);
    assert.deepEqual(fixture.headers, ['Bearer local-fixture-only']);
  } finally { await fixture.close(); }
});

test('median ties at one half use the lower level despite floating-point roundoff', async () => {
  const fixture = await createJevFixture();
  try {
    for (const probabilities of [[0.03, 0.29, 0.18, 0.5, 0], [0.03, 0.29, 0.17999999, 0.50000001, 0]]) {
      fixture.respond(() => ({ body: { model: JEV_MODEL, answers: { item: scoreAnswer(probabilities) }, usage: { input_tokens: 1000, output_tokens: 20 } } }));
      const answer = await rankJev(request, fixture.config, new AbortController().signal);
      assert.equal(answer.outcome, 'ok');
      assert.equal(answer.priorities!.item!.level, probabilities[2] === 0.18 ? 2 : 3);
    }
  } finally { await fixture.close(); }
});

test('independently rounded live answers are accepted, while larger inconsistencies are not', async () => {
  // Recorded from jev-1.13.0 on 2026-09-25. Probabilities give 0.87 and 2.57; Jev reported 0.88 and 2.56.
  const live = [[[0.27, 0.62, 0.08, 0.03, 0], 0.88, 1], [[0, 0.13, 0.2, 0.64, 0.03], 2.56, 3]] as const;
  const fixture = await createJevFixture();
  try {
    for (const [probabilities, score, level] of live) {
      fixture.respond(() => ({ body: { model: JEV_MODEL, answers: { item: { ...scoreAnswer([...probabilities]), score } },
        usage: { input_tokens: 1000, output_tokens: 20 } } }));
      const answer = await rankJev(request, fixture.config, new AbortController().signal);
      assert.equal(answer.outcome, 'ok');
      assert.deepEqual(answer.priorities, { item: { level, score } });
    }
    for (const [probabilities, score] of [[[0.27, 0.62, 0.08, 0.03, 0], 0.95], [[0.3, 0.62, 0.08, 0.03, 0], 0.93]] as const) {
      fixture.respond(() => ({ body: { model: JEV_MODEL, answers: { item: { ...scoreAnswer([...probabilities]), score } },
        usage: { input_tokens: 1000, output_tokens: 20 } } }));
      assert.equal((await rankJev(request, fixture.config, new AbortController().signal)).outcome, 'invalid_response');
    }
  } finally { await fixture.close(); }
});

test('malformed Score answers never become usable rankings, while known spend survives rejection', async () => {
  const fixture = await createJevFixture();
  try {
    for (const mutation of ['missing-level', 'extra-level', 'negative', 'sum', 'score', 'legend', 'type', 'extra-answer', 'usage', 'model']) {
      fixture.respond(() => {
        const answer = scoreAnswer();
        const body = { model: JEV_MODEL, answers: { item: answer } as Record<string, unknown>, usage: { input_tokens: 1000, output_tokens: 20 } as unknown };
        if (mutation === 'missing-level') delete answer.probabilities['0'];
        if (mutation === 'extra-level') answer.probabilities['5'] = 0;
        if (mutation === 'negative') answer.probabilities['0'] = -0.1;
        if (mutation === 'sum') answer.probabilities['0'] = 0.1;
        if (mutation === 'score') answer.score = 4;
        if (mutation === 'legend') answer.legend['0'] = 'different rubric';
        if (mutation === 'type') answer.type = 'noul';
        if (mutation === 'extra-answer') body.answers.extra = answer;
        if (mutation === 'usage') body.usage = null;
        if (mutation === 'model') body.model = 'foreign';
        return { body };
      });
      const answer = await rankJev(request, fixture.config, new AbortController().signal);
      assert.equal(answer.outcome, 'invalid_response', mutation);
      assert.equal(answer.priorities, null, mutation);
      assert.equal(answer.pricedCostUsd, ['usage', 'model'].includes(mutation) ? null : 0.000042, mutation);
    }
    const controller = new AbortController();
    controller.abort();
    const before = fixture.requests.length;
    const cancelled = await rankJev(request, fixture.config, controller.signal);
    assert.equal(cancelled.sent, false);
    assert.equal(cancelled.pricedCostUsd, 0);
    assert.equal(fixture.requests.length, before);
  } finally { await fixture.close(); }
});

test('segmentation covers complete arguments and observation with exact Unicode-safe source ranges', () => {
  const item = candidate('large', ('alpha 😀 漢字 "quoted" \\ slash\r\n').repeat(1000));
  item.toolCall.arguments = { command: 'a'.repeat(9000) };
  const plan = planRanking(state, [item], [], { ...limits, maxRequests: 30, maxDurationMs: 30_000 });
  assert.equal(plan.outcome, 'ready');
  assert.ok(plan.segments.length > 3);
  const all = Object.assign({}, ...plan.batches.map((batch) => batch.request.questions)) as Record<string, JevScoreQuestion>;
  for (const source of ['arguments', 'observation'] as const) {
    const original = source === 'arguments' ? JSON.stringify(item.toolCall.arguments) : item.text;
    let reconstructed = '', offset = 0;
    for (const segment of plan.segments.filter((segment) => segment.source === source)) {
      assert.equal(segment.start, offset);
      const fragment = all[segment.questionId]!.instructions.candidate as { text: string; start: number; end: number };
      assert.equal(fragment.text, original.slice(segment.start, segment.end));
      assert.equal(fragment.text.isWellFormed(), true);
      assert.ok(!fragment.text.endsWith('\r'));
      reconstructed += fragment.text;
      offset = segment.end;
    }
    assert.equal(reconstructed, original);
    assert.equal(offset, original.length);
  }
  for (const batch of plan.batches) {
    assert.equal(batch.requestBytes, Buffer.byteLength(JSON.stringify(batch.request)));
    assert.equal(batch.inputByteReservation, batch.requestBytes);
    assert.ok(batch.requestBytes <= limits.maxRequestBytes);
    for (const question of Object.values(batch.request.questions)) {
      assert.ok(Buffer.byteLength(JSON.stringify({ state: batch.request.state, question })) <= limits.maxPairBytes);
    }
  }
  assert.deepEqual(planRanking(state, [item], [], { ...limits, maxRequests: 30, maxDurationMs: 30_000 }), plan);
});

test('observation questions carry call arguments, and only long arguments get their own ranges', () => {
  const questions = (plan: ReturnType<typeof planRanking>) => plan.batches.flatMap((batch) => Object.values(batch.request.questions))
    .map((question) => (question.instructions as { candidate: Record<string, unknown> }).candidate);
  const short = planRanking(state, [candidate('short', 'line\n'.repeat(3000))], [], { ...limits, maxRequests: 30, maxDurationMs: 30_000 });
  assert.ok(short.segments.length > 1);
  assert.ok(short.segments.every((segment) => segment.source === 'observation'));
  for (const fragment of questions(short)) {
    assert.deepEqual(fragment.callArguments, { text: '{"path":"/testbed/source.ts"}', complete: true, length: 29 });
  }

  const item = candidate('long');
  item.toolCall.arguments = { command: '漢'.repeat(1000) };
  const serialized = JSON.stringify(item.toolCall.arguments);
  const long = planRanking(state, [item], [], limits);
  assert.ok(long.segments.some((segment) => segment.source === 'arguments'));
  const observation = questions(long).find((fragment) => fragment.source === 'observation')!;
  const context = observation.callArguments as { text: string; complete: boolean; length: number };
  assert.equal(context.complete, false);
  assert.equal(context.length, serialized.length);
  assert.ok(serialized.startsWith(context.text) && context.text.isWellFormed());
  assert.ok(Buffer.byteLength(context.text) <= CALL_CONTEXT_BYTES && Buffer.byteLength(context.text) > CALL_CONTEXT_BYTES - 3);
  assert.ok(questions(long).filter((fragment) => fragment.source === 'arguments').every((fragment) => !('callArguments' in fragment)));
});

test('mandatory limits fail before dispatch planning and optional archives roll back whole without blocking later small items', () => {
  const large = candidate('large', 'x'.repeat(50_000));
  const tight = { ...limits, maxSegments: 4 };
  const failed = planRanking(state, [large], [candidate('optional')], tight);
  assert.equal(failed.outcome, 'selection-incomplete');
  assert.deepEqual(failed.batches, []);
  assert.deepEqual(failed.segments, []);
  const plan = planRanking(state, [candidate('resident')], [large, candidate('small')], tight);
  assert.equal(plan.outcome, 'ready');
  assert.deepEqual(plan.candidateIds, ['resident', 'small']);
  assert.deepEqual(plan.omittedArchiveIds, ['large']);
  assert.equal(plan.segments.length, 2);
  assert.deepEqual(plan.segments.map((segment) => segment.questionId), ['s0', 's1']);
});

test('the entire decision includes per-request state, request count, spend reservation and serial timeout envelope', () => {
  const items = [candidate('a', 'x'.repeat(12_000)), candidate('b', 'y'.repeat(12_000))];
  const ready = planRanking(state, items, [], limits);
  assert.equal(ready.outcome, 'ready');
  assert.ok(ready.batches.length > 1);
  assert.equal(ready.inputByteReservation, ready.batches.reduce((sum, batch) => sum + batch.requestBytes, 0));
  const boundary = { ...limits, maxRequests: ready.batches.length, maxSegments: ready.segments.length,
    maxInputBytes: ready.inputByteReservation, maxCostUsd: ready.costReservationUsd, maxDurationMs: ready.durationReservationMs };
  assert.equal(planRanking(state, items, [], boundary).outcome, 'ready');
  for (const lower of [{ maxRequests: ready.batches.length - 1 }, { maxSegments: ready.segments.length - 1 },
    { maxInputBytes: ready.inputByteReservation - 1 }, { maxCostUsd: ready.costReservationUsd / 2 }, { maxDurationMs: ready.durationReservationMs - 1 }]) {
    assert.equal(planRanking(state, items, [], { ...boundary, ...lower }).outcome, 'selection-incomplete');
  }
  assert.equal(planRanking({ ...state, taskSketch: 'x'.repeat(20_000) }, items, [], limits).outcome, 'selection-incomplete');
});

test('whole-item priority uses the maximum segment, and a missing or mismatched tail rejects the whole decision', () => {
  const plan = planRanking(state, [candidate('a', 'x'.repeat(25_000))], [], limits);
  assert.equal(plan.outcome, 'ready');
  const tail = plan.segments.at(-1)!.questionId;
  const completed = plan.batches.map((batch) => ({ requestHash: batch.requestHash,
    result: result(Object.fromEntries(Object.keys(batch.request.questions).map((id) => [id,
      id === tail ? { level: 4, score: 3.8 } : { level: 0, score: 0.1 }]))) }));
  assert.deepEqual(collectRanking(plan, completed), { a: { level: 4, score: 3.8 } });
  assert.equal(collectRanking(plan, completed.slice(0, -1)), null);
  assert.equal(collectRanking(plan, completed.map((entry) => ({ ...entry, requestHash: 'wrong' }))), null);
  const missing = structuredClone(completed);
  delete missing.at(-1)!.result.priorities![tail];
  assert.equal(collectRanking(plan, missing), null);
  const unpriced = structuredClone(completed);
  unpriced[0]!.result.pricedCostUsd = null;
  assert.equal(collectRanking(plan, unpriced), null);
});

test('unsupported optional arguments omit only that archive and leave exact packing intact', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const args of [undefined, 1n, cycle]) {
    const bad = candidate('bad'); bad.toolCall.arguments = args;
    const plan = planRanking(state, [candidate('required')], [bad, candidate('good')], limits);
    assert.deepEqual(plan.omittedArchiveIds, ['bad']);
    assert.deepEqual(plan.candidateIds, ['required', 'good']);
    assert.equal(planRanking(state, [bad], [], limits).outcome, 'selection-incomplete');
    for (const batch of plan.batches) assert.equal(batch.requestBytes, Buffer.byteLength(JSON.stringify(batch.request)));
  }
});

test('hundreds of segments retain exact reservations without repeated whole-plan packing', () => {
  const plan = planRanking({ ...state, taskSketch: 's'.repeat(8000) },
    Array.from({ length: 300 }, (_, i) => candidate(`item-${i}`, 'x'.repeat(3000))), [],
    { ...limits, maxPairBytes: 16_000, maxRequestBytes: 1_000_000, maxRequests: 1000, maxSegments: 1000,
      maxInputBytes: 100_000_000, maxCostUsd: 10, maxDurationMs: 1_000_000 });
  assert.equal(plan.outcome, 'ready');
  assert.equal(plan.candidateIds.length, 300);
  for (const batch of plan.batches) {
    assert.equal(batch.requestBytes, Buffer.byteLength(JSON.stringify(batch.request)));
    assert.equal(batch.inputByteReservation, batch.requestBytes);
  }
});

test('the paired runner limits plan a full resident set of many small results', () => {
  // Mirrors eval/swebench/run.mjs: about 100KB of residents at the high target, with a maximal sketch.
  const runner = { maxPairBytes: 30000, maxRequestBytes: 60000, maxRequests: 8, maxSegments: 256,
    maxInputBytes: 480000, maxCostUsd: 0.1, requestTimeoutMs: 15000, maxDurationMs: 120000 };
  const full = { taskSketch: 's'.repeat(6000), recentActivity: { text: 'r'.repeat(3800), truncated: true, originalBytes: 9000 } };
  const line = 'x'.repeat(79) + '\n';
  for (const [count, bytes] of [[4, 25_000], [25, 4_000], [60, 1_600]] as const) {
    const items = Array.from({ length: count }, (_, i) => candidate(`r${i}`, line.repeat(bytes / 80)));
    assert.equal(planRanking(full, items, [], runner).outcome, 'ready', `${count} residents of ${bytes} bytes`);
  }
});

test('empty and unusual IDs are handled without inherited scores or prototype mutation', () => {
  assert.deepEqual(planRanking(state, [], [], limits).batches, []);
  assert.throws(() => planRanking(state, [candidate('x'), candidate('x')], [], limits), /Invalid ranking/);
  assert.throws(() => planRanking(state, [candidate('x', '\ud800')], [], limits), /Invalid ranking/);
  const plan = planRanking(state, [candidate('__proto__')], [], limits);
  const completed = plan.batches.map((batch) => ({ requestHash: batch.requestHash,
    result: result(Object.fromEntries(Object.keys(batch.request.questions).map((id) => [id, { level: 2, score: 2 }]))) }));
  const ranking = collectRanking(plan, completed)!;
  assert.deepEqual(Object.keys(ranking), ['__proto__']);
  assert.deepEqual(ranking.__proto__, { level: 2, score: 2 });
});
