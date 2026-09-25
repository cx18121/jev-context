import { Buffer } from 'node:buffer';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { readProviderPayload } from './provider-view.ts';
import { estimateContextInput, type InputEstimate, type UsageAnchor } from './working-context.ts';

export interface CapacityLimits {
  contextLimit: number;
  marginTokens: number;
  /** Required for Codex. Planning headroom only, not a provider-enforced output cap. */
  outputReserveTokens?: number;
  /** Serialized HTTP body ceiling. Bytes, independent of the provider token allowance. */
  maxRequestBytes: number;
}

export interface CapacityMeasurement {
  input: InputEstimate;
  outputReserve: number;
  outputReserveSource: 'request-limit' | 'configured-headroom';
  marginTokens: number;
  contextLimit: number;
  totalTokens: number;
  wireBytes: number;
  maxRequestBytes: number;
  tokenFits: boolean;
  wireFits: boolean;
  admitted: boolean;
}

/** Planning admission uses estimated tokens; transport admission uses actual serialized bytes. */
export function measureCapacity(
  payload: unknown, model: Model<Api>, limits: CapacityLimits,
  context: { anchor?: UsageAnchor; messages?: readonly AgentMessage[] } = {},
): CapacityMeasurement {
  if (!Number.isSafeInteger(limits.contextLimit) || limits.contextLimit <= 0 ||
      !Number.isSafeInteger(limits.marginTokens) || limits.marginTokens < 0 ||
      !Number.isSafeInteger(limits.maxRequestBytes) || limits.maxRequestBytes <= 0) throw new Error('Invalid capacity limits');
  const { request } = readProviderPayload(payload, model.api);
  const codex = model.api === 'openai-codex-responses';
  const outputReserve = codex ? limits.outputReserveTokens : request.max_completion_tokens ?? request.max_tokens;
  if (typeof outputReserve !== 'number' || !Number.isSafeInteger(outputReserve) || outputReserve <= 0) {
    throw new Error(codex ? 'Codex requires explicit outputReserveTokens planning headroom' : 'Provider request must have an explicit output limit');
  }
  const contextLimit = Math.min(limits.contextLimit, model.contextWindow);
  const input = estimateContextInput(payload, model, context);
  const totalTokens = input.tokens + outputReserve + limits.marginTokens;
  const wireBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  const tokenFits = totalTokens <= contextLimit;
  const wireFits = wireBytes <= limits.maxRequestBytes;
  return { input, outputReserve, outputReserveSource: codex ? 'configured-headroom' : 'request-limit',
    marginTokens: limits.marginTokens, contextLimit, totalTokens, wireBytes, maxRequestBytes: limits.maxRequestBytes,
    tokenFits, wireFits, admitted: tokenFits && wireFits };
}
