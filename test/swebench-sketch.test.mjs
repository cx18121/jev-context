import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { validatedUsage, tapResponse } from '../eval/swebench/codex-accounting.mjs';
import { guardedSketch, SKETCH_REQUEST_BYTES } from '../eval/swebench/sketch.mjs';
import { planSketchUpdate, SKETCH_INSTRUCTIONS } from '../src/task-sketch.ts';

const cost = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ inputTokensAbove: 272000 }] };
const raw = { input_tokens: 2000, output_tokens: 200, total_tokens: 2200, input_tokens_details: { cached_tokens: 1024 } };
const model = { id: 'gpt-6-luna', baseUrl: 'http://fixture', cost };
const normalized = { input: 976, output: 200, cacheRead: 1024, cacheWrite: 0, totalTokens: 2200 };
const context = { systemPrompt: 'Sketch instructions', messages: [{ role: 'user', content: '{"sources":[]}' }] };
const bounds = { sketchRequests: 1, sketchMs: 1000, sketchMaxTokens: 4096, sketchRequestBytes: SKETCH_REQUEST_BYTES, sketchResponseBytes: 128000 };
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

function fixture({ usage = raw, piUsage = normalized, text = '{}', responseBytes = 128000, wrongWire = false,
  records = [], phase = 'selector', requestContext = context, requestCap = 1 } = {}) {
  const saved = [];
  let dispatches = 0, unknown = false;
  const guard = () => assert.equal(unknown, false, 'Accounting stopped');
  const config = guardedSketch({ model, sessionId: `${phase}-session`, phase,
    bounds: { ...bounds, sketchRequests: requestCap, sketchResponseBytes: responseBytes },
    deadline: new AbortController().signal, records, guard,
    unknownCost() { unknown = true; }, save: async (name, body) => { saved.push({ name, body }); },
    fetch: async () => { dispatches++; return new Response(terminal(usage)); },
    runtime: { streamSimple(m, ctx, options) {
      assert.equal(m, model); assert.equal(ctx, requestContext);
      assert.equal(options.reasoning, 'low'); assert.equal(options.maxRetries, 0); assert.equal(options.transport, 'sse');
      assert.ok(options.timeoutMs <= bounds.sketchMs);
      return { result: async () => {
        const body = { model: m.id, store: false, reasoning: { effort: 'low' }, prompt_cache_key: options.sessionId,
          instructions: ctx.systemPrompt, input: [{ role: 'user', content: [{ type: 'input_text', text: ctx.messages[0].content }] }] };
        options.onPayload(body);
        if (wrongWire) body.input[0].content[0].text = 'different';
        const response = await options.fetch(`${m.baseUrl}/codex/responses`, { method: 'POST',
          headers: { 'session-id': options.sessionId }, body: JSON.stringify(body) });
        await response.text();
        return { stopReason: 'stop', usage: piUsage, content: [
          { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'OPAQUE_SIGNATURE' },
          { type: 'text', text },
        ] };
      } };
    } },
  });
  return { config, records, saved, dispatches: () => dispatches, unknown: () => unknown };
}

test('sketch requests use a separate cache key and ledger, preserving known-usage invalid text', async () => {
  const f = fixture({ text: 'invalid JSON' });
  const response = await f.config.complete(model, context, { timeoutMs: 500 });
  assert.equal(response.content.find((block) => block.type === 'text').text, 'invalid JSON');
  assert.equal(f.records[0].accountingComplete, true);
  assert.equal(f.records[0].phase, 'selector');
  assert.ok(Math.abs(f.records[0].usage.catalogCostUsd - 0.00020784) < 1e-12);
  assert.equal(f.saved[0].body.prompt_cache_key, 'selector-session-sketch');
  assert.deepEqual(f.saved[1], { name: 'sketch-1-response.json', body: { stopReason: 'stop', text: 'invalid JSON' } });
  assert.doesNotMatch(JSON.stringify(f.saved), /PRIVATE_REASONING|OPAQUE_SIGNATURE/);
  assert.equal(f.dispatches(), 1); assert.equal(f.unknown(), false);
  await assert.rejects(f.config.complete(model, context, {}), /Sketch request ceiling/);
  assert.equal(f.dispatches(), 1);
  assert.equal(f.records[1].dispatched, false);
  assert.equal(f.records[1].stopClass, 'dispatch-refused');
});

test('both arms share the cap while retaining separate attribution, including a refused selector call', async () => {
  const records = [];
  const control = fixture({ records, phase: 'control', requestCap: 2 });
  const selector = fixture({ records, phase: 'selector', requestCap: 2 });
  await control.config.complete(model, context, {});
  await selector.config.complete(model, context, {});
  for (const phase of ['control', 'selector']) {
    const calls = records.filter((record) => record.phase === phase);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dispatched, true);
    assert.equal(calls[0].usage.catalogCostUsd, records[0].usage.catalogCostUsd);
  }
  await assert.rejects(selector.config.complete(model, context, {}), /Sketch request ceiling/);
  assert.deepEqual(records.map((r) => [r.phase, r.dispatched, r.stopClass]),
    [['control', true, undefined], ['selector', true, undefined], ['selector', false, 'dispatch-refused']]);
  assert.equal(selector.dispatches(), 1);
});

test('the derived wire ceiling accommodates double-escaped maximal sketch input', async () => {
  const plan = planSketchUpdate([{ id: 'u1', role: 'user', text: '"\\'.repeat(24000) }], null);
  const requestContext = { systemPrompt: SKETCH_INSTRUCTIONS, messages: [{ role: 'user',
    content: JSON.stringify({ previous: plan.previous, sources: plan.sources }) }] };
  const f = fixture({ requestContext });
  await f.config.complete(model, requestContext, {});
  const bytes = Buffer.byteLength(JSON.stringify(f.saved[0].body));
  assert.ok(bytes > 40000);
  assert.ok(bytes <= SKETCH_REQUEST_BYTES);
});

test('real SDK error responses retain pre-dispatch refusals and provider accounting errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-sketch-sdk-'));
  try {
    const catalog = JSON.parse(await readFile(new URL('../node_modules/@earendil-works/pi-ai/dist/providers/data/openai-codex.json', import.meta.url)));
    const pinned = catalog['openai-codex-responses']['gpt-6-luna'];
    const runtime = await ModelRuntime.create({ modelsPath: null, modelsStorePath: join(directory, 'models.json'),
      allowModelNetwork: false, refreshOnCreate: false, credentials: new InMemoryCredentialStore() });
    const token = `fake.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64')}.fake`;
    runtime.registerProvider('sketch-fixture', { baseUrl: 'http://fixture', api: 'openai-codex-responses', apiKey: token,
      models: [{ ...pinned, id: 'gpt-6-luna', baseUrl: 'http://fixture' }] });
    const sdkModel = runtime.getModel('sketch-fixture', 'gpt-6-luna');
    for (const kind of ['size', 'guard', 'usage']) {
      const records = [], reasons = [];
      let sends = 0, guards = 0;
      const config = guardedSketch({ runtime, model: sdkModel, phase: 'selector', sessionId: 'sdk-errors', records,
        bounds: { ...bounds, sketchMs: 5000, sketchRequestBytes: kind === 'size' ? 100 : SKETCH_REQUEST_BYTES },
        deadline: new AbortController().signal, save: async () => {}, unknownCost: (reason) => reasons.push(reason),
        guard() { if (++guards === 2 && kind === 'guard') throw new Error('Fixture cost stop before dispatch'); },
        fetch: async () => {
          sends++;
          return new Response(terminal({ ...raw, input_tokens_details: { cached_tokens: raw.input_tokens + 1 } }),
            { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      const expected = kind === 'size' ? 'Sketch request size ceiling' : kind === 'guard'
        ? 'Fixture cost stop before dispatch' : 'Invalid provider cache counts';
      await assert.rejects(config.complete(sdkModel, context, {}), { message: expected });
      assert.equal(sends, kind === 'usage' ? 1 : 0);
      assert.equal(records[0].stopReason, 'error');
      assert.equal(records[0].failure, expected);
      assert.equal(records[0].stopClass, kind === 'usage' ? 'provider-accounting' : 'dispatch-refused');
      assert.equal(reasons[0], kind === 'usage' ? 'Missing or invalid sketch usage' : `Sketch dispatch refused: ${expected}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('missing, invalid or inconsistent accounting stops subsequent dispatch; wire/response bounds fail closed', async () => {
  for (const options of [{ usage: null }, { usage: { ...raw, total_tokens: 1 } },
    { piUsage: { ...normalized, input: 1 } }, { responseBytes: 1 }, { wrongWire: true }]) {
    const f = fixture(options);
    await assert.rejects(f.config.complete(model, context, {}));
    assert.equal(f.unknown(), true);
    assert.equal(f.records[0].stopClass, options.wrongWire ? 'dispatch-refused' : 'provider-accounting');
    const count = f.dispatches();
    await assert.rejects(f.config.complete(model, context, {}), /Accounting stopped/);
    assert.equal(f.dispatches(), count);
  }
});
