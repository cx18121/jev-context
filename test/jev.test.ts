import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateJev, JEV_MODEL, validateJevConfig, type JevRequest } from '../src/jev.ts';
import { createJevFixture, jevResponse } from './jev-fixture.ts';

const request: JevRequest = {
  model: JEV_MODEL, state: { conversation: ['unfinished task'] },
  questions: {
    evidence: { type: 'noul', instructions: { question: 'Is candidate relevant?', candidate: 'data' }, criteria: { true: 'Useful', false: 'Unrelated' } },
  },
};

test('Jev uses the pinned HTTP contract and reports raw usage plus a priced estimate', async () => {
  const fixture = await createJevFixture();
  try {
    const result = await evaluateJev(request, fixture.config, new AbortController().signal);
    assert.equal(result.outcome, 'ok');
    assert.deepEqual(fixture.requests, [request]);
    assert.deepEqual(fixture.headers, ['Bearer local-fixture-only']);
    assert.equal(result.model, JEV_MODEL);
    assert.deepEqual(result.relevance, { evidence: 0.1 });
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
        if (change === 'extra') response.answers = { evidence: { type: 'noul', noul: 0.1 }, extra: { type: 'noul', noul: 0.1 } };
        if (change === 'wrong-type') response.answers = { evidence: { type: 'choice', noul: 0.1 } };
        if (change === 'out-of-range') response.answers = { evidence: { type: 'noul', noul: 1.1 } };
        if (change === 'wrong-model') response.model = 'jev-latest';
        if (change === 'missing-usage') delete response.usage;
        return { body: response };
      });
      const result = await evaluateJev(request, fixture.config, new AbortController().signal);
      assert.equal(result.outcome, 'invalid_response', change);
      assert.equal(result.relevance, null, change);
      assert.equal(result.pricedCostUsd, ['wrong-model', 'missing-usage'].includes(change) ? null : 0.000042, change);
      if (change !== 'missing-usage') assert.deepEqual(result.rawUsage, { input_tokens: 1000, output_tokens: 20 });
    }
  } finally { await fixture.close(); }
});

test('HTTP failures do not retry or invent zero cost', async () => {
  const fixture = await createJevFixture();
  try {
    fixture.respond(() => ({ status: 429, body: { error: 'Rate limited' } }));
    const result = await evaluateJev(request, fixture.config, new AbortController().signal);
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
    const timed = evaluateJev(request, { ...fixture.config, timeoutMs: 100 }, new AbortController().signal);
    await entered.promise;
    const timeout = await timed;
    assert.equal(timeout.outcome, 'timeout');
    assert.equal(timeout.pricedCostUsd, null);
    entered = Promise.withResolvers<void>();
    const abort = new AbortController();
    const running = evaluateJev(request, fixture.config, abort.signal);
    await entered.promise;
    abort.abort();
    const cancelled = await running;
    assert.equal(cancelled.outcome, 'cancelled');
    assert.equal(cancelled.pricedCostUsd, null);
    const before = fixture.requests.length;
    const notSent = await evaluateJev(request, fixture.config, abort.signal);
    assert.equal(notSent.sent, false);
    assert.equal(notSent.pricedCostUsd, 0);
    assert.equal(fixture.requests.length, before);
  } finally {
    for (const release of held) release();
    await fixture.close();
  }
});

test('Jev configuration requires explicit experimental bounds and a secure endpoint', () => {
  const valid = { apiKey: 'fixture', retireBelow: 0.2, timeoutMs: 1000 };
  assert.doesNotThrow(() => validateJevConfig(valid));
  for (const retireBelow of [0, -1, 1.1, Number.NaN]) assert.throws(() => validateJevConfig({ ...valid, retireBelow }), /retireBelow/);
  assert.throws(() => validateJevConfig({ ...valid, apiKey: '' }), /API key/);
  assert.throws(() => validateJevConfig({ ...valid, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => validateJevConfig({ ...valid, endpoint: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateJevConfig({ ...valid, endpoint: 'https://api.typesafe.ai/v1/systemone?key=secret' }), /query/);
});
