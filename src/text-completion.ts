import { calculateCost, type Api, type AssistantMessage, type Context, type Model, type ModelsSimpleStreamOptions, type Usage } from '@earendil-works/pi-ai';

export interface TextCompletionConfig {
  model: Model<Api>;
  timeoutMs: number;
  maxTokens: number;
  /** Harness seam for separately capped/accounted nested inference. No implicit coding-stream reuse. */
  complete?: (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
}

export interface TextCompletionResult {
  outcome: 'ok' | 'invalid' | 'error' | 'cancelled';
  completionInvoked: boolean;
  usage: Usage | null;
  pricedCostUsd: number | null;
  usageSource: 'pi-normalized';
  text?: string;
  error?: string;
}

export function validateTextCompletionConfig(config: TextCompletionConfig) {
  if (!config?.model?.id || !config.model.provider || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > config.model.maxTokens ||
      ![config.model.cost, ...(config.model.cost.tiers ?? [])].every((rates) =>
        [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every((price) => Number.isFinite(price) && price >= 0)) ||
      !(config.model.cost.tiers ?? []).every((tier) => Number.isSafeInteger(tier.inputTokensAbove) && tier.inputTokensAbove >= 0)) throw new Error('Automatic selection requires an explicit priced text model and request limits');
}

/** A missing/zero fallback usage is unknown cost, never a free request. */
function accountedUsage(message: AssistantMessage, model: Model<Api>): { usage: Usage; pricedCostUsd: number } | null {
  const u = message.usage;
  if (message.model !== model.id || message.provider !== model.provider || message.api !== model.api ||
      !u || ![u.input, u.output, u.cacheRead, u.cacheWrite, u.totalTokens].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      u.input + u.cacheRead + u.cacheWrite <= 0 || u.totalTokens !== u.input + u.output + u.cacheRead + u.cacheWrite) return null;
  if (u.cacheWrite1h !== undefined && (!Number.isSafeInteger(u.cacheWrite1h) || u.cacheWrite1h < 0 || u.cacheWrite1h > u.cacheWrite)) return null;
  const usage = structuredClone(u);
  const cost = calculateCost(model, usage).total;
  return Number.isFinite(cost) && cost >= 0 ? { usage, pricedCostUsd: cost } : null;
}

/** One no-tool, no-retry SSE completion. Parsing and derived-state validation belong to its caller. */
export async function completeText(context: Context, maxOutputBytes: number, config: TextCompletionConfig,
  complete: NonNullable<TextCompletionConfig['complete']>, parentSignal: AbortSignal): Promise<TextCompletionResult> {
  validateTextCompletionConfig(config);
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || context.tools?.length) throw new Error('Invalid text completion bounds or tools');
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(config.timeoutMs)]);
  const result: TextCompletionResult = { outcome: 'error', completionInvoked: false, usage: null, pricedCostUsd: null, usageSource: 'pi-normalized' };
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    result.completionInvoked = true;
    const completion = complete(config.model, context,
      { signal, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens, maxRetries: 0, transport: 'sse' });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    // Late completion is ignored; unknown spend still requires the caller to stop.
    const response = await Promise.race([completion, aborted]);
    const accounting = accountedUsage(response, config.model);
    if (accounting) Object.assign(result, accounting);
    signal.throwIfAborted();
    if (response.stopReason !== 'stop' || response.content.some((block) => block.type === 'toolCall')) {
      throw new Error(`Text generation did not complete (${response.stopReason})${response.errorMessage ? `: ${response.errorMessage}` : ''}`);
    }
    if (!accounting) throw new Error('Text generation usage unavailable');
    result.outcome = 'invalid';
    const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    if (Buffer.byteLength(text) > maxOutputBytes) throw new Error('Text generation output exceeds byte limit');
    result.text = text;
    result.outcome = 'ok';
  } catch (error) {
    if (!result.completionInvoked) result.pricedCostUsd = 0;
    if (signal.aborted) result.outcome = 'cancelled';
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return result;
}
