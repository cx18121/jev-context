import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { tapResponse } from './codex-accounting.mjs';

// Brief traffic has its own ledger and cache key, never coding evidence captures.
export function guardedBrief({ runtime, model, sessionId, bounds, deadline, records, guard, unknownCost, save, fetch }) {
  const cacheKey = `${sessionId}-brief`;
  return {
    model, timeoutMs: bounds.briefMs, maxTokens: bounds.briefMaxTokens,
    async complete(requestModel, context, options) {
      guard();
      assert.equal(requestModel, model);
      assert.ok(records.filter((r) => r.dispatched).length < bounds.briefRequests, 'Brief request ceiling');
      const record = { turn: records.length + 1, dispatched: false, httpStatus: null, rawUsage: null, usage: null };
      records.push(record);
      const controller = new AbortController();
      const signal = AbortSignal.any([deadline, controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(bounds.briefMs)]);
      const started = performance.now();
      let inspected;
      try {
        const response = await runtime.streamSimple(model, context, { ...options, signal, sessionId: cacheKey,
          reasoning: 'low', transport: 'sse', timeoutMs: bounds.briefMs, maxRetries: 0,
          onPayload(body) {
            assert.equal(body.model, model.id);
            assert.equal(body.store, false);
            assert.equal(body.previous_response_id, undefined);
            assert.equal(body.reasoning?.effort, 'low');
            assert.equal(body.tools, undefined);
            assert.equal(body.prompt_cache_key, cacheKey);
            assert.equal(body.instructions, context.systemPrompt);
            assert.equal(body.input.length, 1);
            assert.equal(body.input[0].role, 'user');
            assert.equal(body.input[0].content.length, 1);
            assert.equal(body.input[0].content[0].text, context.messages[0].content);
            assert.ok(Buffer.byteLength(JSON.stringify(body)) <= bounds.briefRequestBytes, 'Brief request size ceiling');
            inspected = structuredClone(body);
          },
          async fetch(url, init) {
            assert.equal(String(url), `${model.baseUrl}/codex/responses`);
            signal.throwIfAborted(); guard();
            assert.ok(!record.dispatched && records.filter((r) => r.dispatched).length < bounds.briefRequests, 'Brief request ceiling');
            assert.equal(init.method, 'POST');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('session-id'), cacheKey);
            const bytes = Buffer.from(init.body);
            const wire = JSON.parse((headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
            assert.deepEqual(wire, inspected);
            await save(`brief-${record.turn}-request.json`, wire);
            signal.throwIfAborted(); guard();
            record.dispatched = true;
            const response = await fetch(url, { ...init, signal, redirect: 'error' });
            record.httpStatus = response.status;
            return tapResponse(response, record, controller, model.cost, bounds.briefResponseBytes);
          },
        }).result();
        record.stopReason = response.stopReason;
        record.piUsage = response.usage;
        assert.ok(record.usage, 'Missing or invalid brief usage');
        // The provider tap owns spend; the extension must see the same accounting.
        const u = response.usage, raw = record.usage;
        assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens],
          [raw.uncached, raw.output, raw.cached, raw.write, raw.input + raw.output], 'Brief usage mismatch');
        record.accountingComplete = true;
        return response;
      } finally {
        record.elapsedMs = Math.round(performance.now() - started);
        if (!record.accountingComplete) unknownCost('Missing or invalid brief usage');
      }
    },
  };
}
