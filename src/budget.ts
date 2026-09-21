import { Buffer } from 'node:buffer';
import type { Api, Model } from '@earendil-works/pi-ai';

export interface RequestBudget {
  contextLimit: number;
  marginTokens: number;
}

export interface BudgetMeasurement {
  method: 'utf8-json-plus-margin-v1';
  inputEstimate: number;
  outputReserve: number;
  marginTokens: number;
  contextLimit: number;
  fits: boolean;
}

/** Conservative text-only estimate at the serialized provider boundary, not a tokenizer. */
export function measureRequest(payload: unknown, model: Model<Api>, budget: RequestBudget): BudgetMeasurement {
  if (model.api !== 'openai-completions') throw new Error('Budget measurement currently supports only openai-completions');
  if (!Number.isSafeInteger(budget.contextLimit) || budget.contextLimit <= 0 ||
      !Number.isSafeInteger(budget.marginTokens) || budget.marginTokens < 0) {
    throw new Error('Invalid request budget');
  }
  if (typeof payload !== 'object' || payload === null || !('messages' in payload)) {
    throw new Error('Unrecognized provider payload');
  }
  const request = payload as Record<string, unknown>;
  if (!Array.isArray(request.messages)) throw new Error('Unrecognized provider messages');
  for (const message of request.messages) {
    if (typeof message !== 'object' || message === null) throw new Error('Unrecognized provider message');
    const content: unknown = message.content;
    if (content === null || content === undefined || typeof content === 'string') continue;
    if (!Array.isArray(content) || !content.every((block: unknown) =>
      typeof block === 'object' && block !== null && 'type' in block && block.type === 'text' &&
      'text' in block && typeof block.text === 'string')) {
      throw new Error('Non-text provider content needs a supported budget estimator');
    }
  }
  const limit = request.max_completion_tokens ?? request.max_tokens;
  if (!Number.isSafeInteger(limit) || typeof limit !== 'number' || limit <= 0) {
    throw new Error('Provider request must have an explicit output limit');
  }
  const contextLimit = Math.min(budget.contextLimit, model.contextWindow);
  const inputEstimate = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  return {
    method: 'utf8-json-plus-margin-v1', inputEstimate, outputReserve: limit,
    marginTokens: budget.marginTokens, contextLimit,
    fits: inputEstimate + limit + budget.marginTokens <= contextLimit,
  };
}
