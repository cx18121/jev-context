import type { Api, Model } from '@earendil-works/pi-ai';
import type { WorkingContextOptions } from '../src/working-extension.ts';
import { assistant, zeroUsage } from './history-fixture.ts';

/** Capture-order integration config. Sketch completions are local fakes, never network requests. */
export function captureOptions(model: Model<Api>): WorkingContextOptions {
  return {
    capacity: { contextLimit: 32768, marginTokens: 1024, outputReserveTokens: 1024, maxRequestBytes: 500000 },
    target: { lowTokens: 16000, highTokens: 24000 },
    order: { kind: 'capture-order' }, archiveLimit: 4, decisionTimeoutMs: 30000,
    ranking: { maxPairBytes: 16000, maxRequestBytes: 40000, maxRequests: 8, maxSegments: 100,
      maxInputBytes: 500000, maxCostUsd: 1, requestTimeoutMs: 2000, maxDurationMs: 20000 },
    sketch: { model, timeoutMs: 2000, maxTokens: 1000, maxUpdates: 4,
      complete: async () => ({ ...assistant(), api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Inspect the API contracts and finish the requested change.' }) }],
        usage: { ...zeroUsage(), input: 80, cacheRead: 20, output: 4, totalTokens: 104 } }) },
  };
}
