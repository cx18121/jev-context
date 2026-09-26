import type { Priority } from './working-set.ts';

export const JEV_MODEL = 'jev-1.13.0';
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_PRICE = {
  inputUsdPerMillion: 0.042, outputUsdPerMillion: 0,
  source: 'https://docs.typesafe.ai/models', checkedOn: '2026-09-21',
} as const;

export interface JevConnection {
  apiKey: string;
  timeoutMs: number;
  endpoint?: string;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: { question: string; candidate: unknown };
  criteria: readonly [string, string, string, string, string];
}

export interface JevRequest<Q = JevScoreQuestion> {
  model: typeof JEV_MODEL;
  state: unknown;
  questions: Record<string, Q>;
}

interface JevResponseMetadata {
  outcome: 'ok' | 'http_error' | 'invalid_response' | 'network_error' | 'timeout' | 'cancelled';
  sent: boolean;
  httpStatus: number | null;
  model: string | null;
  latencyMs: number;
  rawUsage: unknown;
  pricedCostUsd: number | null;
}

export interface JevRankingResult extends JevResponseMetadata {
  priorities: Record<string, Priority> | null;
}

export function validateJevConnection(config: JevConnection): void {
  if (!config.apiKey?.trim()) throw new Error('Jev requires an explicit API key');
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

/** Jev rounds each probability and the score to two decimals independently. Five probabilities can
 * each be off by 0.005, and the reported expected score by that sum plus its own rounding. */
const PROBABILITY_SUM_TOLERANCE = 0.03;
const SCORE_TOLERANCE = 0.06;

/** Five ordinal levels. Use the lower median, with the reported score only as a within-level tie break. */
export async function rankJev(
  request: JevRequest<JevScoreQuestion>, config: JevConnection, signal: AbortSignal,
): Promise<JevRankingResult> {
  const { values, ...metadata } = await evaluate(request, config, signal, (answer, question) => {
    const probabilities = object(answer.probabilities), legend = object(answer.legend);
    if (answer.type !== 'score' || !probabilities || !legend ||
        Object.keys(probabilities).length !== 5 || Object.keys(legend).length !== 5 ||
        typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 4 ||
        typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
    const values: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = probabilities[String(i)];
      if (!Object.hasOwn(probabilities, String(i)) || typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1 ||
          legend[String(i)] !== question.criteria[i]) return null;
      values.push(p);
    }
    const total = values.reduce((sum, p) => sum + p, 0);
    const expected = values.reduce((sum, p, i) => sum + i * p, 0);
    // Permit documented rounding, not malformed distributions or inconsistent scores.
    if (Math.abs(total - 1) > PROBABILITY_SUM_TOLERANCE || Math.abs(answer.score - expected) > SCORE_TOLERANCE) return null;
    let cumulative = 0, level = -1;
    for (let i = 0; i < 5 && level < 0; i++) {
      cumulative += values[i]!;
      if (cumulative >= total / 2 - Number.EPSILON * 5) level = i;
    }
    return { level, score: answer.score };
  });
  return { ...metadata, priorities: values };
}

/** One HTTP call. No retry, substitute judge, or raw provider error text. */
async function evaluate<Q, T>(
  request: JevRequest<Q>, config: JevConnection, signal: AbortSignal,
  parse: (answer: Record<string, unknown>, question: Q) => T | null,
): Promise<JevResponseMetadata & { values: Record<string, T> | null }> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  const result: JevResponseMetadata & { values: Record<string, T> | null } = {
    outcome: 'network_error', sent: false, httpStatus: null, model: null,
    latencyMs: 0, rawUsage: null, pricedCostUsd: null, values: null,
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
    const values: Record<string, T> = Object.create(null);
    for (const key of keys) {
      const answer = Object.hasOwn(answers, key) ? object(answers[key]) : null;
      if (!answer) return result;
      const value = parse(answer, request.questions[key]!);
      if (value === null) return result;
      values[key] = value;
    }
    combined.throwIfAborted();
    result.outcome = 'ok';
    result.values = { ...values };
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
