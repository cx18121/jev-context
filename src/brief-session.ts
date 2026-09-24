import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { calculateCost, type Api, type AssistantMessage, type Context, type Model, type ModelsSimpleStreamOptions, type Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { applyBriefUpdate, BRIEF_INSTRUCTIONS, BRIEF_UPDATE_BYTES, type BriefSource, type BriefUpdatePlan, type TaskBrief } from './task-brief.ts';

export const BRIEF_ENTRY = 'jev-context/task-brief';
export const BRIEF_SOURCE_ENTRY = 'jev-context/instruction-source';
export const BRIEF_START_ENTRY = 'jev-context/brief-start';
export const BRIEF_RESULT_ENTRY = 'jev-context/brief-result';

export interface BriefConfig {
  model: Model<Api>;
  timeoutMs: number;
  maxTokens: number;
  /** Harness seam for separately capped/accounted nested inference. No implicit coding-stream reuse. */
  complete?: (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => Promise<AssistantMessage>;
}

export function validateBriefConfig(config: BriefConfig) {
  if (!config?.model?.id || !config.model.provider || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1 || config.maxTokens > config.model.maxTokens ||
      ![config.model.cost, ...(config.model.cost.tiers ?? [])].every((rates) =>
        [rates.input, rates.output, rates.cacheRead, rates.cacheWrite].every((price) => Number.isFinite(price) && price >= 0)) ||
      !(config.model.cost.tiers ?? []).every((tier) => Number.isSafeInteger(tier.inputTokensAbove) && tier.inputTokensAbove >= 0)) throw new Error('Automatic selection requires an explicit priced task-brief model and request limits');
}

function contentText(content: string | { type: string; text?: string }[]): string {
  return typeof content === 'string' ? content : content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

/** Sources preserve authority and branch identities; opaque reasoning and tool bodies never enter the updater. */
export function taskSources(branch: SessionEntry[]): BriefSource[] {
  const sources: BriefSource[] = [];
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === BRIEF_SOURCE_ENTRY) {
      const data = entry.data as { version?: unknown; text?: unknown } | undefined;
      if (data?.version !== 1 || typeof data.text !== 'string') throw new Error('Invalid instruction source');
      sources.push({ id: entry.id, role: 'system', text: data.text });
      continue;
    }
    if (entry.type !== 'message' && entry.type !== 'custom_message') continue;
    const message: AgentMessage = entry.type === 'message' ? entry.message : {
      role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp),
    };
    if (message.role === 'user' || message.role === 'custom') {
      sources.push({ id: entry.id, role: message.role === 'user' ? 'user' : 'extension', text: contentText(message.content) });
    } else if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      const text = message.content.flatMap((block) => block.type === 'text' ? [block.text]
        : block.type === 'toolCall' ? [JSON.stringify({ tool: block.name, arguments: block.arguments })] : []).join('\n');
      sources.push({ id: entry.id, role: 'assistant', text });
    } else if (message.role === 'bashExecution' && !message.excludeFromContext) {
      sources.push({ id: entry.id, role: 'extension', text: JSON.stringify({ command: message.command, output: 'omitted', exitCode: message.exitCode }) });
    }
    // System messages are deltas. The provider-rendered instruction snapshot above owns their current meaning.
  }
  return sources;
}

export interface BriefResult {
  outcome: 'ok' | 'invalid' | 'error' | 'cancelled';
  usage: Usage | null;
  pricedCostUsd: number | null;
  usageSource: 'pi-normalized';
  brief?: TaskBrief;
  error?: string;
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

export async function updateBrief(plan: BriefUpdatePlan, sources: BriefSource[], config: BriefConfig,
  complete: NonNullable<BriefConfig['complete']>, parentSignal: AbortSignal): Promise<BriefResult> {
  validateBriefConfig(config);
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(config.timeoutMs)]);
  const result: BriefResult = { outcome: 'error', usage: null, pricedCostUsd: null, usageSource: 'pi-normalized' };
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const completion = complete(config.model, {
      systemPrompt: BRIEF_INSTRUCTIONS,
      messages: [{ role: 'user', content: JSON.stringify({ previous: plan.previous, sources: plan.sources }), timestamp: 0 }],
    }, { signal, timeoutMs: config.timeoutMs, maxTokens: config.maxTokens, maxRetries: 0, transport: 'sse' });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    // A misbehaving injected transport must not hold the coding hook indefinitely.
    // Late completion is ignored; unknown spend still requires the caller to stop.
    const response = await Promise.race([completion, aborted]);
    const accounting = accountedUsage(response, config.model);
    if (accounting) Object.assign(result, accounting);
    signal.throwIfAborted();
    if (response.stopReason !== 'stop' || response.content.some((block) => block.type === 'toolCall')) {
      throw new Error(`Task brief generation did not complete (${response.stopReason})${response.errorMessage ? `: ${response.errorMessage}` : ''}`);
    }
    if (!accounting) throw new Error('Task brief usage unavailable');
    result.outcome = 'invalid';
    const output = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    if (Buffer.byteLength(output) > BRIEF_UPDATE_BYTES) throw new Error('Task brief output exceeds byte limit');
    result.brief = applyBriefUpdate(plan, JSON.parse(output), sources);
    result.outcome = 'ok';
  } catch (error) {
    if (signal.aborted) result.outcome = 'cancelled';
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return result;
}
