import assert from 'node:assert/strict';
import test from 'node:test';
import { rankJev, JEV_MODEL, validateJevConnection, type JevRequest } from '../src/jev.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const request: JevRequest = {
  model: JEV_MODEL, state: { conversation: ['unfinished task'] },
  questions: {
    evidence: { type: 'score', instructions: { question: 'Prioritize this candidate.', candidate: 'data' }, criteria: ['Unrelated', 'Low', 'Medium', 'High', 'Essential'] },
  },
};

test('Jev uses the pinned HTTP contract and reports raw usage plus a priced estimate', async () => {
  const fixture = await createJevFixture();
  try {
    const result = await rankJev(request, fixture.config, new AbortController().signal);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(fixture.requests, [request]);
    assert.deepEqual(fixture.headers, ['Bearer local-fixture-only']);
    assert.equal(result.model, JEV_MODEL);
    assert.deepEqual(result.priorities, { evidence: { level: 1, score: 1 } });
    assert.deepEqual(result.rawUsage, { input_tokens: 1000, output_tokens: 20 });
    assert.equal(result.pricedCostUsd, 0.000042);
    assert.ok(result.latencyMs >= 0);
  } finally { await fixture.close(); }
});

test('invalid answers fail atomically while available usage remains recorded', async () => {
  const fixture = await createJevFixture();
  try {
    for (const change of ['missing', 'extra', 'wrong-type', 'out-of-range', 'wrong-model', 'missing-usage']) {
      fixture.respond((body) => {
        const response = jevResponse(body) as Record<string, unknown>;
        if (change === 'missing') response.answers = {};
        const answers = response.answers as Record<string, Record<string, unknown>>;
        if (change === 'extra') answers.extra = structuredClone(answers.evidence!);
        if (change === 'wrong-type') answers.evidence!.type = 'choice';
        if (change === 'out-of-range') answers.evidence!.score = 5;
        if (change === 'wrong-model') response.model = 'jev-latest';
        if (change === 'missing-usage') delete response.usage;
        return { body: response };
      });
      const result = await rankJev(request, fixture.config, new AbortController().signal);
      assert.equal(result.outcome, 'invalid_response', change);
      assert.equal(result.priorities, null, change);
      assert.equal(result.pricedCostUsd, ['wrong-model', 'missing-usage'].includes(change) ? null : 0.000042, change);
      if (change !== 'missing-usage') assert.deepEqual(result.rawUsage, { input_tokens: 1000, output_tokens: 20 });
    }
  } finally { await fixture.close(); }
});

test('HTTP failures do not retry or invent zero cost', async () => {
  const fixture = await createJevFixture();
  try {
    fixture.respond(() => ({ status: 429, body: { error: 'Rate limited' } }));
    const result = await rankJev(request, fixture.config, new AbortController().signal);
    assert.equal(result.outcome, 'http_error');
    assert.equal(result.httpStatus, 429);
    assert.equal(result.rawUsage, null);
    assert.equal(result.pricedCostUsd, null);
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test('timeout and user cancellation are distinct and preserve unknown incurred cost', async () => {
  const fixture = await createJevFixture();
  const held: Array<() => void> = [];
  try {
    let entered = Promise.withResolvers<void>();
    fixture.respond(async () => {
      entered.resolve();
      await new Promise<void>((resolve) => held.push(resolve));
      return { body: {} };
    });
    const timed = rankJev(request, { ...fixture.config, timeoutMs: 100 }, new AbortController().signal);
    await entered.promise;
    const timeout = await timed;
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.pricedCostUsd, null);
    entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const running = rankJev(request, fixture.config, abort.signal);
    await entered.promise;
    abort.abort();
    const cancelled = await running;
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.pricedCostUsd, null);
    const before = fixture.requests.length;
    const notSent = await rankJev(request, fixture.config, abort.signal);
    assert.equal(notSent.sent, false);
    assert.equal(notSent.pricedCostUsd, 0);
    assert.equal(fixture.requests.length, before);
  } finally {
    for (const release of held) release();
    await fixture.close();
  }
});

test('Jev configuration requires explicit experimental bounds and a secure endpoint', () => {
  const valid = { apiKey: 'fixture', timeoutMs: 1000 };
  assert.doesNotThrow(() => validateJevConnection(valid));
  assert.throws(() => validateJevConnection({ ...valid, apiKey: '' }), /API key/);
  assert.throws(() => validateJevConnection({ ...valid, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => validateJevConnection({ ...valid, endpoint: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateJevConnection({ ...valid, endpoint: 'https://api.typesafe.ai/v1/systemone?key=secret' }), /query/);
});
