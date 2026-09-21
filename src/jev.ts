export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_PROMPT_VERSION = 'unfinished-task-v1';
export const JEV_PRICE = {
  inputUsdPerMillion: 0.042, outputUsdPerMillion: 0,
  source: 'https://docs.typesafe.ai/models', checkedOn: '2026-09-21',
} as const;

export interface JevConfig {
  apiKey: string;
  retireBelow: number;
  timeoutMs: number;
  endpoint?: string;
}

export interface JevQuestion {
  type: 'noul';
  instructions: { question: string; candidate: unknown };
  criteria: { true: string; false: string };
}

export interface JevRequest {
  model: typeof JEV_MODEL;
  state: unknown;
  questions: Record<string, JevQuestion>;
}

export interface JevResult {
  outcome: 'ok' | 'http_error' | 'invalid_response' | 'network_error' | 'timeout' | 'cancelled';
  sent: boolean;
  httpStatus: number | null;
  model: string | null;
  latencyMs: number;
  rawUsage: unknown;
  pricedCostUsd: number | null;
  relevance: Record<string, number> | null;
}

export class JevError extends Error {}

export function validateJevConfig(config: JevConfig): void {
  if (!config.apiKey?.trim()) throw new Error('Jev requires an explicit API key');
  if (!Number.isFinite(config.retireBelow) || config.retireBelow <= 0 || config.retireBelow > 1) {
    throw new Error('Jev retireBelow must be greater than 0 and at most 1');
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 60_000) {
    throw new Error('Jev timeoutMs must be an integer from 1 to 60000');
  }
  const url = new URL(config.endpoint ?? JEV_ENDPOINT);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Jev endpoint must use HTTPS (or loopback HTTP) without credentials, query, or fragment');
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** One bounded HTTP call. No retry, substitute judge, or raw provider error text. */
export async function evaluateJev(request: JevRequest, config: JevConfig, signal: AbortSignal): Promise<JevResult> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const result: JevResult = {
    outcome: 'network_error', sent: false, httpStatus: null, model: null,
    latencyMs: 0, rawUsage: null, pricedCostUsd: null, relevance: null,
  };
  try {
    combined.throwIfAborted();
    result.sent = true;
    const response = await fetch(config.endpoint ?? JEV_ENDPOINT, {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request), signal: combined, redirect: 'error',
    });
    result.httpStatus = response.status;
    const body: unknown = await response.json();
    const data = object(body);
    result.rawUsage = data?.usage ?? null;
    result.model = typeof data?.model === 'string' ? data.model : null;
    const usage = object(result.rawUsage);
    const validUsage = usage !== null && tokens(usage.input_tokens) && tokens(usage.output_tokens);
    if (validUsage && result.model === JEV_MODEL) {
      result.pricedCostUsd = (usage.input_tokens as number) * JEV_PRICE.inputUsdPerMillion / 1_000_000;
    }
    if (!response.ok) { result.outcome = 'http_error'; return result; }
    result.outcome = 'invalid_response';
    if (result.model !== JEV_MODEL || !validUsage) return result;
    const answers = object(data?.answers);
    const keys = Object.keys(request.questions);
    if (!answers || Object.keys(answers).length !== keys.length) return result;
    const relevance: Record<string, number> = {};
    for (const key of keys) {
      const answer = object(answers[key]);
      if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' ||
          !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return result;
      relevance[key] = answer.noul;
    }
    combined.throwIfAborted();
    result.outcome = 'ok';
    result.relevance = relevance;
    return result;
  } catch {
    result.outcome = signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' :
      result.httpStatus === null ? 'network_error' :
        result.httpStatus >= 200 && result.httpStatus < 300 ? 'invalid_response' : 'http_error';
    return result;
  } finally {
    if (!result.sent) result.pricedCostUsd = 0;
    result.latencyMs = performance.now() - started;
  }
}
