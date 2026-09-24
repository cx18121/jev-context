import { createHash } from 'node:crypto';
import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import type { BudgetMeasurement } from './budget.ts';
import { readProviderPayload } from './provider-view.ts';

export interface WorkingMeasurement {
  method: 'provider-usage-plus-delta-v1';
  inputEstimate: number | null;
  outputReserve: number;
  marginTokens: number;
  contextLimit: number;
  fits: boolean | null;
  anchorRequestId: string | null;
  unknownReason?: 'no-anchor' | 'request-changed';
}

interface ItemShape { hash: string; textBytes?: number }
export interface UsageAnchor {
  requestId: string;
  model: string;
  header: string;
  items: ItemShape[];
  inputTokens: number;
  outputTokens: number;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const modelKey = (model: Model<Api>) => JSON.stringify([model.provider, model.api, model.id, model.baseUrl]);

function toolField(item: Record<string, unknown>, api: Api) {
  if (api === 'openai-completions') return item.role === 'tool' ? 'content' : undefined;
  return item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? 'output' : undefined;
}

function shape(item: Record<string, unknown>, api: Api): ItemShape {
  const field = toolField(item, api);
  if (!field) return { hash: hash(item) };
  const { [field]: text, ...metadata } = item;
  return { hash: hash(metadata), textBytes: bytes(text) };
}

function requestParts(payload: unknown, api: Api) {
  const { request, items } = readProviderPayload(payload, api);
  const { [api === 'openai-completions' ? 'messages' : 'input']: _, ...header } = request;
  return { header: hash(header), items };
}

/** Memory-only fingerprints bind reported usage to the selected outgoing request, not stored originals. */
export function createUsageAnchor(payload: unknown, model: Model<Api>, usage: Usage, requestId: string): UsageAnchor | undefined {
  const counts = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) return;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const total = inputTokens + usage.output;
  if (inputTokens <= 0 || !Number.isSafeInteger(total) || total !== usage.totalTokens) return;
  const { header, items } = requestParts(payload, model.api);
  return { requestId, model: modelKey(model), header, items: items.map((item) => shape(item, model.api)),
    inputTokens, outputTokens: usage.output };
}

/** A soft heuristic, never a tokenizer or a replacement for the hard request guard. */
export function measureWorkingContext(
  payload: unknown, model: Model<Api>, hard: BudgetMeasurement, contextLimit: number, anchor?: UsageAnchor,
): WorkingMeasurement {
  const base = { method: 'provider-usage-plus-delta-v1' as const, outputReserve: hard.outputReserve,
    marginTokens: hard.marginTokens, contextLimit, anchorRequestId: anchor?.requestId ?? null };
  const unknown = (unknownReason: WorkingMeasurement['unknownReason']): WorkingMeasurement =>
    ({ ...base, inputEstimate: null, fits: null, unknownReason });
  if (!anchor) return unknown('no-anchor');
  const { header, items } = requestParts(payload, model.api);
  if (anchor.model !== modelKey(model) || anchor.header !== header || items.length <= anchor.items.length) {
    return unknown('request-changed');
  }
  let deltaBytes = 0;
  for (const [i, previous] of anchor.items.entries()) {
    const current = shape(items[i]!, model.api);
    if (current.hash !== previous.hash) return unknown('request-changed');
    if (previous.textBytes !== undefined) deltaBytes += current.textBytes! - previous.textBytes;
  }
  // The previous response is counted once via reported output, including reasoning.
  // Only its following user/tool input is estimated from bytes. Never count ciphertext as tokens.
  let sawAssistant = false;
  let sawInput = false;
  for (const item of items.slice(anchor.items.length)) {
    const assistant = item.role === 'assistant' || (model.api === 'openai-codex-responses' &&
      ['reasoning', 'function_call', 'custom_tool_call'].includes(String(item.type)));
    if (assistant) {
      if (sawInput) return unknown('request-changed');
      sawAssistant = true;
    } else {
      if (!sawAssistant || (item.role !== 'user' && !toolField(item, model.api))) return unknown('request-changed');
      sawInput = true;
      deltaBytes += bytes(item);
    }
  }
  if (!sawAssistant) return unknown('request-changed');
  const inputEstimate = Math.max(0, Math.ceil(anchor.inputTokens + anchor.outputTokens + deltaBytes / 4));
  return { ...base, inputEstimate, fits: inputEstimate + hard.outputReserve + hard.marginTokens <= contextLimit };
}
