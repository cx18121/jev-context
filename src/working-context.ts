import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Api, Model, Usage } from '@earendil-works/pi-ai';
import { readProviderPayload } from './provider-view.ts';

interface ItemShape { hash: string; textBytes?: number }
export interface UsageAnchor {
  requestId: string;
  model: string;
  header: string;
  items: ItemShape[];
  inputTokens: number;
  outputTokens: number;
}

export interface InputEstimate {
  method: 'provider-usage-plus-delta-v2' | 'cold-visible-bytes-plus-output-v1';
  tokens: number;
  anchorRequestId: string | null;
  fallbackReason?: 'no-anchor' | 'request-changed';
  /** Whole recorded response outputs used as a proxy for opaque reasoning on cold reconstruction. */
  opaqueOutputTokens: number;
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

function validUsage(usage: Usage) {
  const counts = [usage.input, usage.cacheRead, usage.cacheWrite, usage.output];
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    Number.isSafeInteger(total) && total === usage.totalTokens;
}

/** Memory-only fingerprints bind reported usage to the selected outgoing request, not stored originals. */
export function createUsageAnchor(payload: unknown, model: Model<Api>, usage: Usage, requestId: string): UsageAnchor | undefined {
  if (!validUsage(usage)) return;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (inputTokens <= 0) return;
  const { header, items } = requestParts(payload, model.api);
  return { requestId, model: modelKey(model), header, items: items.map((item) => shape(item, model.api)),
    inputTokens, outputTokens: usage.output };
}

function anchoredInput(
  payload: unknown, model: Model<Api>, anchor: UsageAnchor,
): number | undefined {
  const { header, items } = requestParts(payload, model.api);
  if (anchor.model !== modelKey(model) || anchor.header !== header || items.length <= anchor.items.length) return;
  let deltaTokens = 0;
  for (const [i, previous] of anchor.items.entries()) {
    const current = shape(items[i]!, model.api);
    if (current.hash !== previous.hash) return;
    if (previous.textBytes !== undefined) {
      const delta = current.textBytes! - previous.textBytes;
      deltaTokens += delta / (delta >= 0 ? 3 : 5);
    }
  }
  // Count the previous response once via reported output, including reasoning, never ciphertext bytes.
  let sawAssistant = false;
  let sawInput = false;
  for (const item of items.slice(anchor.items.length)) {
    const assistant = item.role === 'assistant' || (model.api === 'openai-codex-responses' &&
      ['reasoning', 'function_call', 'custom_tool_call'].includes(String(item.type)));
    if (assistant) {
      if (sawInput) return;
      sawAssistant = true;
    } else {
      if (!sawAssistant || (item.role !== 'user' && !toolField(item, model.api))) return;
      sawInput = true;
      deltaTokens += bytes(item) / 3;
    }
  }
  if (!sawAssistant) return;
  return Math.max(0, Math.ceil(anchor.inputTokens + anchor.outputTokens + deltaTokens));
}

function reasoningKey(item: Record<string, unknown>) {
  return JSON.stringify([item.type, item.id ?? null, item.type === 'reasoning' ? item.encrypted_content : item.data]);
}

function reasoningDetails(value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' ||
      (item.type !== 'reasoning.encrypted' && item.type !== 'reasoning.text' && item.type !== 'reasoning.summary'))) {
    throw new Error('Unsupported reasoning details in capacity estimate');
  }
  return value;
}

/**
 * Planning estimate, not an admission proof or universal bytes/token bound. Additions use bytes/3;
 * removals credit only bytes/5. Cold reconstruction uses visible JSON bytes/3 plus recorded response
 * output for opaque reasoning. That intentionally overcounts visible parts of those responses.
 */
export function estimateContextInput(
  payload: unknown, model: Model<Api>, options: { anchor?: UsageAnchor; messages?: readonly AgentMessage[] } = {},
): InputEstimate {
  const anchored = options.anchor && anchoredInput(payload, model, options.anchor);
  if (anchored !== undefined) return { method: 'provider-usage-plus-delta-v2', tokens: anchored,
    anchorRequestId: options.anchor!.requestId, opaqueOutputTokens: 0 };

  const { request, items } = readProviderPayload(payload, model.api);
  const opaque = model.api === 'openai-codex-responses'
    ? items.filter((item) => item.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0)
    : items.flatMap((item) => reasoningDetails(item.reasoning_details).filter((detail) => detail.type === 'reasoning.encrypted'));
  const opaqueKeys = new Set(opaque.map(reasoningKey));
  const owners = new Map<string, { index: number; output: number }>();
  for (const [index, message] of (options.messages ?? []).entries()) {
    if (message.role !== 'assistant' || message.api !== model.api || message.provider !== model.provider || message.model !== model.id ||
        message.stopReason === 'error' || message.stopReason === 'aborted') continue;
    for (const block of message.content) {
      const signature = block.type === 'thinking' ? block.thinkingSignature : block.type === 'toolCall' ? block.thoughtSignature : undefined;
      if (!signature) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(signature); } catch { continue; }
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!item || typeof item !== 'object' || (item.type !== 'reasoning' && item.type !== 'reasoning.encrypted')) continue;
        const key = reasoningKey(item);
        if (!opaqueKeys.has(key)) continue;
        if (!validUsage(message.usage) || message.usage.output <= 0) throw new Error('Opaque reasoning has no valid recorded output usage');
        if (owners.has(key) && owners.get(key)!.index !== index) throw new Error('Ambiguous opaque reasoning usage owner');
        owners.set(key, { index, output: message.usage.output });
      }
    }
  }
  const outputs = new Map<number, number>();
  for (const item of opaque) {
    const owner = owners.get(reasoningKey(item));
    if (!owner) throw new Error('Opaque reasoning has no matching recorded output usage');
    outputs.set(owner.index, owner.output);
  }
  const field = model.api === 'openai-completions' ? 'messages' : 'input';
  const visible = { ...request, [field]: items.map((item) => {
    if (model.api === 'openai-codex-responses' && item.type === 'reasoning') {
      const { encrypted_content: _, ...rest } = item;
      return rest;
    }
    if (model.api === 'openai-completions' && item.reasoning_details !== undefined) {
      return { ...item, reasoning_details: reasoningDetails(item.reasoning_details).map((detail) => {
        const { data: _, signature: __, ...rest } = detail;
        return rest;
      }) };
    }
    return item;
  }) };
  const opaqueOutputTokens = [...outputs.values()].reduce((sum, output) => sum + output, 0);
  return { method: 'cold-visible-bytes-plus-output-v1', tokens: Math.ceil(bytes(visible) / 3) + opaqueOutputTokens,
    anchorRequestId: null, opaqueOutputTokens, fallbackReason: options.anchor ? 'request-changed' : 'no-anchor' };
}
