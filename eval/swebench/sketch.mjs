import assert from 'node:assert/strict';
import { zstdDecompressSync } from 'node:zlib';
import { SKETCH_INPUT_BYTES, SKETCH_INSTRUCTIONS } from '../../src/task-sketch.ts';
import { tapResponse } from './codex-accounting.mjs';

// The planned JSON is serialized again inside a Codex input-text field.
export const SKETCH_REQUEST_BYTES = 2 * SKETCH_INPUT_BYTES + Buffer.byteLength(SKETCH_INSTRUCTIONS) + 4096;

// Both arms use this shared ledger and cap; each call retains its phase and separate cache key.
export function guardedSketch({ runtime, model, sessionId, phase, bounds, deadline, records, guard, unknownCost, save, fetch }) {
  const cacheKey = `${sessionId}-sketch`;
  return {
    model, timeoutMs: bounds.sketchMs, maxTokens: bounds.sketchMaxTokens,
    async complete(requestModel, context, options) {
      const record = { phase, turn: records.length + 1, dispatched: false, httpStatus: null, rawUsage: null, usage: null };
      records.push(record);
      const controller = new AbortController();
      const signal = AbortSignal.any([deadline, controller.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(bounds.sketchMs)]);
      const started = performance.now();
      let inspected;
      try {
        guard();
        assert.equal(requestModel, model);
        assert.ok(records.filter((r) => r.dispatched).length < bounds.sketchRequests, 'Sketch request ceiling');
        const response = await runtime.streamSimple(model, context, { ...options, signal, sessionId: cacheKey,
          reasoning: 'low', transport: 'sse', timeoutMs: Math.min(options.timeoutMs ?? bounds.sketchMs, bounds.sketchMs), maxRetries: 0,
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
            assert.ok(Buffer.byteLength(JSON.stringify(body)) <= bounds.sketchRequestBytes, 'Sketch request size ceiling');
            inspected = structuredClone(body);
          },
          async fetch(url, init) {
            assert.equal(String(url), `${model.baseUrl}/codex/responses`);
            signal.throwIfAborted(); guard();
            assert.ok(!record.dispatched && records.filter((r) => r.dispatched).length < bounds.sketchRequests, 'Sketch request ceiling');
            assert.equal(init.method, 'POST');
            const headers = new Headers(init.headers);
            assert.equal(headers.get('session-id'), cacheKey);
            const bytes = Buffer.from(init.body);
            const wire = JSON.parse((headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes) : bytes).toString());
            assert.deepEqual(wire, inspected);
            await save(`sketch-${record.turn}-request.json`, wire);
            signal.throwIfAborted(); guard();
            record.dispatched = true;
            const response = await fetch(url, { ...init, signal, redirect: 'error' });
            record.httpStatus = response.status;
            return tapResponse(response, record, controller, model.cost, bounds.sketchResponseBytes);
          },
        }).result();
        record.stopReason = response.stopReason;
        record.piUsage = response.usage;
        // Bounded text only. Never persist private reasoning or response headers here.
        await save(`sketch-${record.turn}-response.json`, {
          stopReason: response.stopReason,
          text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
        });
        assert.ok(record.usage, response.errorMessage?.split('\n')[0].slice(0, 500) || 'Missing or invalid sketch usage');
        const u = response.usage, raw = record.usage;
        assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens],
          [raw.uncached, raw.output, raw.cached, raw.write, raw.input + raw.output], 'Sketch usage mismatch');
        record.accountingComplete = true;
        return response;
      } catch (error) {
        record.failure = error instanceof Error ? error.message.split('\n')[0] : String(error);
        throw error;
      } finally {
        record.elapsedMs = Math.round(performance.now() - started);
        if (!record.accountingComplete) {
          record.stopClass = record.dispatched ? 'provider-accounting' : 'dispatch-refused';
          // The extension cannot prove a thrown completion was unsent, so its branch still stops.
          unknownCost(record.dispatched ? 'Missing or invalid sketch usage' : `Sketch dispatch refused: ${record.failure ?? record.stopReason}`);
        }
      }
    },
  };
}
