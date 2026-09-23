import { Buffer } from 'node:buffer';
import type { Api, Model } from '@earendil-works/pi-ai';
import { readProviderPayload } from './provider-view.ts';

export interface RequestBudget {
  contextLimit: number;
  marginTokens: number;
  /** Required for Codex. Planning headroom only, not a provider-enforced output cap. */
  outputReserveTokens?: number;
}

export interface BudgetMeasurement {
  method: 'utf8-json-plus-margin-v1';
  inputEstimate: number;
  outputReserve: number;
  outputReserveSource: 'request-limit' | 'configured-headroom';
  marginTokens: number;
  contextLimit: number;
  fits: boolean;
}

/** Conservative text-only estimate at the serialized provider boundary, not a tokenizer. */
export function measureRequest(payload: unknown, model: Model<Api>, budget: RequestBudget): BudgetMeasurement {
  if (!Number.isSafeInteger(budget.contextLimit) || budget.contextLimit <= 0 ||
      !Number.isSafeInteger(budget.marginTokens) || budget.marginTokens < 0) {
    throw new Error('Invalid request budget');
  }
  const { request } = readProviderPayload(payload, model.api);
  const codex = model.api === 'openai-codex-responses';
  const limit = codex ? budget.outputReserveTokens : request.max_completion_tokens ?? request.max_tokens;
  if (!Number.isSafeInteger(limit) || typeof limit !== 'number' || limit <= 0) {
    throw new Error(codex ? 'Codex requires explicit outputReserveTokens planning headroom' : 'Provider request must have an explicit output limit');
  }
  const contextLimit = Math.min(budget.contextLimit, model.contextWindow);
  const inputEstimate = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  return {
    method: 'utf8-json-plus-margin-v1', inputEstimate, outputReserve: limit,
    outputReserveSource: codex ? 'configured-headroom' : 'request-limit',
    marginTokens: budget.marginTokens, contextLimit,
    fits: inputEstimate + limit + budget.marginTokens <= contextLimit,
  };
}
