import assert from 'node:assert/strict';
import test from 'node:test';
import { validatedUsage, tapResponse } from '../eval/swebench/codex-accounting.mjs';
import { guardedBrief } from '../eval/swebench/brief.mjs';

const cost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272000 }] };
const raw = { input_tokens: 2000, output_tokens: 200, total_tokens: 2200, input_tokens_details: { cached_tokens: 1024 } };
const model = { id: 'gpt-6-luna', baseUrl: 'http://fixture', cost };
const normalized = { input: 976, output: 200, cacheRead: 1024, cacheWrite: 0, totalTokens: 2200 };
const context = { systemPrompt: 'Brief instructions', messages: [{ role: 'user', content: '{"sources":[]}' }] };
const bounds = { briefRequests: 1, briefMs: 1000, briefMaxTokens: 4096, briefRequestBytes: 40000, briefResponseBytes: 128000 };
const terminal = (usage = raw, type = 'response.done') => JSON.stringify({ type, response: { status: 'completed', usage } }, null, 2)
  .split('\n').map((l) => `data: ${l}`).join('\r\n');

test('shared accounting prices cached input and rejects invalid counts and unsupported tiers', () => {
  assert.ok(Math.abs(validatedUsage(raw, cost).catalogCostUsd - 0.00020784) < 1e-12);
  for (const bad of [null, { ...raw, total_tokens: 1 }, { ...raw, input_tokens_details: { cached_tokens: 2001 } },
    { ...raw, input_tokens: 272000, total_tokens: 272200 }]) assert.throws(() => validatedUsage(bad, cost));
});

test('SSE accounting accepts multiline CRLF and EOF terminal aliases and bounds response bytes', async () => {
  for (const type of ['response.done', 'response.completed', 'response.incomplete']) {
    const record = {}, controller = new AbortController();
    await tapResponse(new Response(terminal(raw, type)), record, controller, cost, 4000).text();
    assert.deepEqual(record.usage, validatedUsage(raw, cost));
  }
  const controller = new AbortController();
  await assert.rejects(tapResponse(new Response('too big'), {}, controller, cost, 1).text(), /size ceiling/);
  assert.equal(controller.signal.aborted, true);
});

function fixture({ usage = raw, piUsage = normalized, text = '{}', responseBytes = 128000, wrongWire = false } = {}) {
  const records = [], saved = [];
  let dispatches = 0, unknown = false;
  const guard = () => assert.equal(unknown, false, 'Accounting stopped');
  const config = guardedBrief({ model, sessionId: 'coding-session', bounds: { ...bounds, briefResponseBytes: responseBytes },
    deadline: new AbortController().signal, records, guard,
    unknownCost() { unknown = true; }, save: async (name, body) => { saved.push({ name, body }); },
    fetch: async () => { dispatches++; return new Response(terminal(usage)); },
    runtime: { streamSimple(m, ctx, options) {
      assert.equal(m, model); assert.equal(ctx, context);
      assert.equal(options.reasoning, 'low'); assert.equal(options.maxRetries, 0); assert.equal(options.transport, 'sse');
      return { result: async () => {
        const body = { model: m.id, store: false, reasoning: { effort: 'low' }, prompt_cache_key: options.sessionId,
          instructions: ctx.systemPrompt, input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.messages[0].content }] }] };
        options.onPayload(body);
        if (wrongWire) body.input[0].content[0].text = 'different';
        const response = await options.fetch(`${m.baseUrl}/codex/responses`, { method: 'POST',
          headers: { 'session-id': options.sessionId }, body: JSON.stringify(body) });
        await response.text();
        return { stopReason: 'stop', usage: piUsage, content: [{ type: 'text', text }] };
      } };
    } },
  });
  return { config, records, saved, dispatches: () => dispatches, unknown: () => unknown };
}

test('brief requests use a separate cache key, ledger and cap, preserving known-usage invalid text', async () => {
  const f = fixture({ text: 'invalid JSON' });
  const response = await f.config.complete(model, context, {});
  assert.equal(response.content[0].text, 'invalid JSON'); // The extension, not transport, validates brief content.
  assert.equal(f.records[0].accountingComplete, true);
  assert.ok(Math.abs(f.records[0].usage.catalogCostUsd - 0.00020784) < 1e-12);
  assert.equal(f.saved[0].body.prompt_cache_key, 'coding-session-brief');
  assert.equal(f.dispatches(), 1); assert.equal(f.unknown(), false);
  await assert.rejects(f.config.complete(model, context, {}), /Brief request ceiling/);
  assert.equal(f.dispatches(), 1);
});

test('missing, invalid or inconsistent accounting stops subsequent dispatch; wire/response bounds fail closed', async () => {
  for (const options of [{ usage: null }, { usage: { ...raw, total_tokens: 1 } },
    { piUsage: { ...normalized, input: 1 } }, { responseBytes: 1 }, { wrongWire: true }]) {
    const f = fixture(options);
    await assert.rejects(f.config.complete(model, context, {}));
    assert.equal(f.unknown(), true);
    const count = f.dispatches();
    await assert.rejects(f.config.complete(model, context, {}), /Accounting stopped/);
    assert.equal(f.dispatches(), count);
  }
});
